"""The Recipe pipeline, and the Retrieval Snapshot it mints (§3.3, §4.1, §6).

`docs/semantic-modeling.md` §6.2–6.4 describes one pipeline and one owner: the FDE
writes the recipe, the model may choose *which* recipe and fill the query, and the
service executes the stages the package declares, in the package's order. So this
module is a stage runner, not a retrieval strategy — every stage is read from the
`ContextRecipe` (`app.context_package`), and a recipe that omits one gets a pipeline
that omits it.

```text
resolve     → the business object: filters[key] first, then a key-shaped query token
structured  → that object's exact facts from the recipe's declared source (the graph)
graph       → 1..maxHops out over the recipe's relations, scored anchor × decay × edge
lexical     → the query's lexical matches inside the recipe's declared source
merge       → one candidate per entity, and one per content hash, when declared
rank        → the recipe's weights + the freshness boost ingest recorded
mask        → the permission baseline: class scope, property masks (§7)
budget      → the recipe's ceilings, tightened by the caller's, packed deterministically
```

Three decisions worth naming:

- **`structured` reads the graph.** Ingest has already applied the package's mappings,
  so the graph *is* the materialized structured facts; the Connector typed operation
  is the Tool seam (`/v1/connectors/...`), not a second data path inside a retrieval.
  When ingest has not finished, retrieval says `partial` (§9.2) rather than pretending
  the graph is the source's current state.
- **Every score is the stage's weight times the stage's own score**, so §6.3's
  priority (exact structured fact > graph neighbourhood > lexical match) is arithmetic
  rather than an ordering rule bolted on afterwards. `budget_used.hops` still reports
  the deepest hop that survived.
- **Determinism outranks sophistication.** Every step sorts on a total order
  (weighted score, then `entity_id`) and takes no wall-clock decisions: freshness is
  computed by ingest, not read from the clock here, because a digest that changed with
  the time could not answer "did these two retrievals return the same evidence?".

**The snapshot** (§4.1) is a manifest, not a copy: `retrieval_id`, the request's
digest, per-item references (`entity_id`, `type`, `version`, `source_ref`, `score`,
`content_digest`), the budget, the degradation and any policy denial. The content stays
in the graph; the audit store keeps what was cited and what it hashed to, which is what
an auditor needs and what §6.5 forbids it to keep twice.

**Degradation** (§6.4) is reported, never silent, in this order of specificity: a graph
past the embedded ceiling is `scale_limit` (and the walk is skipped), an ingest that has
not finished is `partial` (§9.2 — the graph is not the source's current state yet), a
retrieval whose matches all exceeded the caller's budget is `partial`, and a graph with
no answer is `empty`.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from app import mask
from app.canonical import canonical_json, sha256_digest
from app.clock import isoformat_z, utc_now
from app.context_package import ContextPackage, Recipe, segment_of
from app.generated.models import BudgetUsed, PolicyEvaluation, RetrievalItem
from app.graph.entity_id import InvalidEntityId
from app.graph.entity_id import parse as parse_entity_id
from app.graph.entity_id import render as render_entity_id
from app.graph.port import Entity, GraphStore
from app.ids import new_ulid
from app.limits import CHARS_PER_TOKEN, MAX_ANCHORS, MAX_SUPPORTED_HOPS, over_ceiling

#: `RetrieveResponse.reason` (`contracts/schemas/retrieval.schema.json`).
DegradedReason = Literal["scale_limit", "index_unavailable", "timeout", "partial", "empty"]

#: How much of an anchor's relevance survives one hop (§6.3's "exact > graph >
#: lexical" needs a 2-hop neighbour to be visibly weaker than a direct hit).
HOP_DECAY = 0.5

#: The attribute names a graph entity can promote into typed `RetrievalItem` fields.
_CLASSIFICATIONS = frozenset({"public", "internal", "confidential", "restricted"})
_SOURCE_KINDS = frozenset({"structured", "document", "web", "derived", "other"})
_PROVENANCE_ID = re.compile(r"^prov_[0-9A-HJKMNP-TV-Z]{26}$")

#: The shape of a value a query may spell: an id, a number, a code. Used by `resolve`
#: when the caller sent a query instead of a `filters` key.
_KEY_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{1,63}")

#: How much more than the budget an expand may gather. The stages produce candidates and
#: the budget decides; the headroom keeps one masked or oversized candidate from hiding
#: the next one. It is not an answer size — `_pack` still cuts at `max_nodes`.
_EXPANSION_HEADROOM = 2

StageKind = Literal["structured", "graph", "lexical"]


@dataclass(frozen=True)
class Snapshot:
    """One Retrieval Snapshot: the wire body's parts, and the manifest that was hashed."""

    retrieval_id: str
    tenant_id: str
    trace_id: str
    recipe_id: str
    created_at: str
    items: tuple[RetrievalItem, ...]
    degraded: bool
    reason: DegradedReason | None
    index: Literal["lexical", "graph"]
    budget_used: BudgetUsed
    policy_evaluations: tuple[PolicyEvaluation, ...]
    manifest: Mapping[str, Any]
    digest: str


@dataclass(frozen=True)
class _Anchor:
    """What `resolve` decided the call is about: a class, its key, and the entity if any."""

    term: str
    key: str
    entity_id: str
    entity: Entity | None


@dataclass(frozen=True)
class _Candidate:
    """One candidate on its way to the wire, before masking and the budget."""

    entity: Entity
    score: float
    hop: int
    stage: StageKind
    attributes: Mapping[str, Any] = field(default_factory=dict)


def retrieve(
    package: ContextPackage,
    store: GraphStore,
    *,
    tenant_id: str,
    trace_id: str,
    request: Mapping[str, Any],
    scopes: Sequence[str] = (),
    ingest_complete: bool = True,
    now: datetime | None = None,
) -> Snapshot:
    """Run the recipe `request["recipe_id"]` names, and mint its Retrieval Snapshot."""
    recipe = package.recipe(str(request["recipe_id"]))
    budget = recipe.budget
    if budget is None:  # pragma: no cover - the package loader refuses a recipe without one
        raise ValueError(f"recipe {recipe.name} has no budget stage")

    caller = request.get("budget") or {}
    # The recipe's stage is the ceiling; a caller may ask for less, never for more, and a
    # caller that names nothing gets the recipe's number (not a service-wide one — the
    # package is where a capability's budget is written down, §6.2).
    max_nodes = _tightened(caller, "max_nodes", budget.max_nodes)
    max_tokens = _tightened(caller, "max_tokens", budget.max_tokens)
    recipe_hops = recipe.graph.max_hops if recipe.graph is not None else 0
    max_hops = min(_tightened(caller, "max_hops", budget.max_hops), recipe_hops, MAX_SUPPORTED_HOPS)

    stats = store.stats()
    past_ceiling = over_ceiling(stats.nodes, stats.edges)

    anchor = _resolve(store, tenant_id=tenant_id, recipe=recipe, request=request)
    candidates = _gather(
        store,
        tenant_id=tenant_id,
        anchor=anchor,
        recipe=recipe,
        query=str(request["query"]),
        max_nodes=max_nodes,
        max_hops=max_hops,
        expand=not past_ceiling,
    )
    ranked = _rank(_merge(candidates, recipe), recipe)

    visible, denials = mask.apply(
        ((candidate.entity, candidate.attributes) for candidate in ranked),
        profile=package.permissions,
        scopes=scopes,
        policy_version=package.version,
    )
    kept, budget_used = _pack(visible, ranked, max_nodes=max_nodes, max_tokens=max_tokens)

    degraded, reason = _degradation(
        past_ceiling=past_ceiling,
        ingest_complete=ingest_complete,
        ranked=len(ranked),
        kept=len(kept),
    )

    # `graph` when the answer contains something a walk found: the structured stage's
    # joins and the graph stage's expansion are both walks, and the contract's enum has no
    # value for "exact facts only".
    walked = any(candidate.hop > 0 for candidate, _masked in kept)
    index: Literal["lexical", "graph"] = "graph" if walked else "lexical"
    items = tuple(_item(candidate, masked) for candidate, masked in kept)
    retrieval_id = new_ulid("ret_")
    created_at = isoformat_z(now or utc_now())
    policy_evaluations = tuple(PolicyEvaluation(**denial) for denial in denials)

    manifest = _manifest(
        tenant_id=tenant_id,
        recipe=recipe,
        request=request,
        items=items,
        degraded=degraded,
        reason=reason,
        index=index,
        budget_used=budget_used,
        policy_evaluations=policy_evaluations,
    )
    return Snapshot(
        retrieval_id=retrieval_id,
        tenant_id=tenant_id,
        trace_id=trace_id,
        recipe_id=recipe.name,
        created_at=created_at,
        items=items,
        degraded=degraded,
        reason=reason,
        index=index,
        budget_used=budget_used,
        policy_evaluations=policy_evaluations,
        manifest=manifest,
        digest=sha256_digest(canonical_json(manifest)),
    )


# ---------------------------------------------------------------------------
# resolve
# ---------------------------------------------------------------------------


def _resolve(
    store: GraphStore, *, tenant_id: str, recipe: Recipe, request: Mapping[str, Any]
) -> _Anchor | None:
    """The business object this call is about (§6.3), in three decreasingly certain steps.

    1. **The declared key**, from `filters` — the deterministic path a capability fills.
    2. **A query token that names an entity** of the resolved class, which is what makes
       "claim C-1001 …" work without inventing a parser.
    3. **A lexical match inside that class** — §6.3's "解析不到 → 进入图/词法实体匹配".
       The fallback still yields *an entity of the recipe's class*, which is what keeps
       the graph stage's `from: resolved` true: what the stage refuses to do is expand
       from an arbitrary hit that is not the object the call is about.
    """
    stage = recipe.resolve
    if stage is None:
        return None
    filters = request.get("filters")
    declared = filters.get(stage.key) if isinstance(filters, Mapping) else None
    term = stage.entity
    segment = segment_of(term)

    if isinstance(declared, str) and declared:
        entity_id = _entity_id_for(tenant_id, segment, declared)
        if entity_id is not None:
            return _Anchor(
                term=term, key=declared, entity_id=entity_id, entity=store.get_entity(tenant_id, entity_id)
            )

    query = str(request.get("query") or "")
    for token in _KEY_TOKEN.findall(query):
        entity_id = render_entity_id(tenant_id, segment, token)
        entity = store.get_entity(tenant_id, entity_id)
        if entity is not None:
            return _Anchor(term=term, key=token, entity_id=entity_id, entity=entity)

    for match in store.lexical_search(tenant_id, query, limit=MAX_ANCHORS, entity_type=segment):
        entity = store.get_entity(tenant_id, match.entity_id)
        if entity is None:
            continue
        return _Anchor(
            term=term, key=parse_entity_id(entity.entity_id).key, entity_id=entity.entity_id, entity=entity
        )
    return None


# ---------------------------------------------------------------------------
# the three retrieval stages
# ---------------------------------------------------------------------------


def _gather(
    store: GraphStore,
    *,
    tenant_id: str,
    anchor: _Anchor | None,
    recipe: Recipe,
    query: str,
    max_nodes: int,
    max_hops: int,
    expand: bool,
) -> list[_Candidate]:
    found: list[_Candidate] = []
    if anchor is not None and anchor.entity is not None:
        found.extend(_structured(store, tenant_id=tenant_id, anchor=anchor, recipe=recipe, max_nodes=max_nodes))
    if anchor is not None and anchor.entity is not None and expand and max_hops > 0:
        found.extend(
            _graph(store, tenant_id=tenant_id, anchor=anchor, recipe=recipe, max_nodes=max_nodes, max_hops=max_hops)
        )
    found.extend(_lexical(store, tenant_id=tenant_id, recipe=recipe, query=query))
    return found


def _structured(
    store: GraphStore, *, tenant_id: str, anchor: _Anchor, recipe: Recipe, max_nodes: int
) -> list[_Candidate]:
    """The resolved object and its source's joins, for the classes the recipe trusts.

    §6.3's `structured` is the exact business fact — the stage whose whole point is that
    it outranks a graph neighbour and a lexical hit. A SQL source would answer it with one
    query joining the mapped tables (§6.2's `entities` list is exactly that join's
    projection), so the equivalent here is the resolved entity plus its one-hop neighbours
    **of the declared classes, from the declared source**. Everything further, or from
    another source, is the graph stage's business and carries its decay.
    """
    stage = recipe.structured
    if stage is None or anchor.entity is None or anchor.term not in stage.entities:
        return []
    found: list[_Candidate] = []
    attributes = dict(anchor.entity.attributes)
    if _source_of(attributes) == stage.source:
        found.append(_Candidate(entity=anchor.entity, score=1.0, hop=0, stage="structured", attributes=attributes))

    for expansion in store.expand(
        tenant_id, [anchor.entity_id], hops=1, limit=max_nodes * _EXPANSION_HEADROOM
    ):
        entity = store.get_entity(tenant_id, expansion.entity_id)
        if entity is None:
            continue
        neighbour = dict(entity.attributes)
        if _source_of(neighbour) != stage.source or neighbour.get("term") not in stage.entities:
            continue
        found.append(
            _Candidate(entity=entity, score=1.0, hop=expansion.hop, stage="structured", attributes=neighbour)
        )
    return found


def _graph(
    store: GraphStore, *, tenant_id: str, anchor: _Anchor, recipe: Recipe, max_nodes: int, max_hops: int
) -> list[_Candidate]:
    """1..maxHops out from the resolved entity, over the recipe's relations only."""
    stage = recipe.graph
    if stage is None or anchor.entity is None:
        return []
    found: list[_Candidate] = []
    for expansion in store.expand(
        tenant_id,
        [anchor.entity_id],
        hops=min(max_hops, stage.max_hops),
        limit=max_nodes * _EXPANSION_HEADROOM,
        predicates=stage.relations,
    ):
        entity = store.get_entity(tenant_id, expansion.entity_id)
        if entity is None:
            continue
        score = HOP_DECAY**expansion.hop * expansion.weight
        attributes = {**dict(entity.attributes), "relation": expansion.predicate}
        found.append(
            _Candidate(entity=entity, score=_floor(score), hop=expansion.hop, stage="graph", attributes=attributes)
        )
    return found


def _lexical(store: GraphStore, *, tenant_id: str, recipe: Recipe, query: str) -> list[_Candidate]:
    """The query's lexical matches in the recipe's declared source."""
    stage = recipe.lexical
    if stage is None or not query.strip():
        return []
    text = query if stage.query == "$query" else stage.query.replace("$query", query)
    found: list[_Candidate] = []
    for match in store.lexical_search(tenant_id, text, limit=stage.top_k, source=stage.source):
        entity = store.get_entity(tenant_id, match.entity_id)
        if entity is None:
            continue
        attributes = dict(entity.attributes)
        found.append(_Candidate(entity=entity, score=match.score, hop=0, stage="lexical", attributes=attributes))
    return found


def _entity_id_for(tenant_id: str, segment: str, key: str) -> str | None:
    """`fde:<tenant>:<segment>:<key>`, or `None` when the key cannot be one.

    A key from `filters` is caller-supplied and the request schema leaves the object
    open; a key outside the id's character class names no entity, which is the same
    answer as a key the graph does not hold. `resolve` therefore falls through to
    matching (§6.3) instead of failing a contract-valid call.
    """
    try:
        return render_entity_id(tenant_id, segment, key)
    except InvalidEntityId:
        return None


def _source_of(attributes: Mapping[str, Any]) -> str | None:
    source = attributes.get("source")
    return source if isinstance(source, str) and source else None


# ---------------------------------------------------------------------------
# merge, rank, mask, budget
# ---------------------------------------------------------------------------


def _merge(candidates: Sequence[_Candidate], recipe: Recipe) -> list[_Candidate]:
    """One candidate per entity — and one per content hash when the recipe dedupes on it.

    A content-hash duplicate is *merged*, not dropped (§6.3: "冲突保留，不丢弃候选"): the
    survivor carries the loser's `entity_id`, `source_ref` and `version` in its metadata,
    so deduping a rendering coincidence never loses a citation.
    """
    dedupe = recipe.merge.dedupe if recipe.merge is not None else ("entity_id",)
    best: dict[str, _Candidate] = {}
    for candidate in candidates:
        current = best.get(candidate.entity.entity_id)
        if current is None or _better(candidate, current):
            best[candidate.entity.entity_id] = candidate

    merged = sorted(best.values(), key=lambda candidate: (-candidate.score, candidate.entity.entity_id))
    if "content_hash" not in dedupe:
        return merged
    survivors: dict[str, _Candidate] = {}
    for candidate in merged:
        digest = sha256_digest(candidate.entity.content)
        survivor = survivors.get(digest)
        if survivor is None:
            survivors[digest] = candidate
            continue
        merged_provenance = list(survivor.attributes.get("merged") or ())
        merged_provenance.append(
            {
                "entity_id": candidate.entity.entity_id,
                "source_ref": candidate.entity.source_ref,
                "version": candidate.entity.version,
            }
        )
        survivors[digest] = _Candidate(
            entity=survivor.entity,
            score=survivor.score,
            hop=survivor.hop,
            stage=survivor.stage,
            attributes={**survivor.attributes, "merged": merged_provenance},
        )
    return sorted(survivors.values(), key=lambda candidate: (-candidate.score, candidate.entity.entity_id))


def _better(candidate: _Candidate, current: _Candidate) -> bool:
    """Which of two paths to the same entity wins: the higher score, then the priority."""
    if candidate.score != current.score:
        return candidate.score > current.score
    return _STAGE_PRIORITY[candidate.stage] < _STAGE_PRIORITY[current.stage]


#: §6.3's priority, used only to break a score tie between two paths to one entity.
_STAGE_PRIORITY: Mapping[str, int] = {"structured": 0, "graph": 1, "lexical": 2}


def _rank(candidates: Sequence[_Candidate], recipe: Recipe) -> list[_Candidate]:
    """§6.3: the recipe's weight per stage, plus the freshness boost ingest recorded."""
    weights = recipe.rank.weights if recipe.rank is not None else {}
    boost = recipe.rank.freshness_boost if recipe.rank is not None else 0.0
    ranked: list[_Candidate] = []
    for candidate in candidates:
        # A stage the recipe does not weight contributes nothing. The recipe schema makes
        # every weight optional, and a default of 1.0 would let a lexical hit outrank the
        # exact fact §6.3 puts above it.
        weight = float(weights.get(candidate.stage, 0.0))
        fresh = candidate.attributes.get("freshness") == "fresh"
        score = weight * candidate.score + (boost if fresh else 0.0)
        ranked.append(
            _Candidate(
                entity=candidate.entity,
                score=_floor(score),
                hop=candidate.hop,
                stage=candidate.stage,
                attributes=candidate.attributes,
            )
        )
    return sorted(ranked, key=lambda candidate: (-candidate.score, candidate.entity.entity_id))


def _pack(
    visible: Sequence[mask.Masked],
    ranked: Sequence[_Candidate],
    *,
    max_nodes: int,
    max_tokens: int,
) -> tuple[list[tuple[_Candidate, mask.Masked]], BudgetUsed]:
    """Pack the masked candidates into the budget, in rank order.

    Masking has already dropped what the caller may not see, so the budget counts what
    could actually be returned. An item that would overflow `max_tokens` is *skipped*,
    not the end of the list: one long document must not starve the smaller facts ranked
    below it, and `budget_used` says what the answer cost.
    """
    by_id = {candidate.entity.entity_id: candidate for candidate in ranked}
    kept: list[tuple[_Candidate, mask.Masked]] = []
    tokens = 0
    for masked in visible:
        candidate = by_id.get(masked.entity.entity_id)
        if candidate is None:  # pragma: no cover - mask preserves the candidates it keeps
            continue
        if len(kept) >= max_nodes:
            break
        estimated = _tokens(masked.entity.content)
        if tokens + estimated > max_tokens:
            continue
        kept.append((candidate, masked))
        tokens += estimated
    hops = max((candidate.hop for candidate, _ in kept), default=0)
    return kept, BudgetUsed(nodes=len(kept), tokens=tokens, hops=hops)


def _degradation(
    *, past_ceiling: bool, ingest_complete: bool, ranked: int, kept: int
) -> tuple[bool, DegradedReason | None]:
    if past_ceiling:
        return True, "scale_limit"
    if not ingest_complete:
        # §9.2: before ingest finishes, the graph is not the source's current state.
        # `partial` says so; `empty` would claim the answer is complete and empty.
        return True, "partial"
    if ranked and not kept:
        return True, "partial"
    if not kept:
        return True, "empty"
    return False, None


def _item(candidate: _Candidate, masked: mask.Masked) -> RetrievalItem:
    """One entity as the contract's `RetrievalItem`.

    Optional fields are *omitted* when absent rather than sent as `null`: the
    generated models refuse an explicit null for them, which is the contract's way of
    saying that "no classification" and "classification: null" are not both answers.
    """
    entity = masked.entity
    attributes = dict(candidate.attributes)
    source_kind = attributes.get("source_kind")
    provenance_id = attributes.get("provenance_id")
    fields: dict[str, Any] = {
        "entity_id": entity.entity_id,
        "type": entity.type,
        "content": entity.content,
        "score": candidate.score,
        "source_ref": entity.source_ref,
        "version": entity.version,
        # C33: retrieved content is data, never instructions.
        "trust": "untrusted",
        "classification": masked.classification,
        "metadata": {
            **attributes,
            "hop": candidate.hop,
            "stage": candidate.stage,
            # Which properties the baseline replaced, so an auditor can tell a hashed
            # field from one the source never had.
            **({"masked": list(masked.replaced_properties)} if masked.replaced_properties else {}),
        },
    }
    if source_kind in _SOURCE_KINDS:
        fields["source_kind"] = source_kind
    if isinstance(provenance_id, str) and _PROVENANCE_ID.match(provenance_id):
        fields["provenance_id"] = provenance_id
    return RetrievalItem(**fields)


def _manifest(
    *,
    tenant_id: str,
    recipe: Recipe,
    request: Mapping[str, Any],
    items: Sequence[RetrievalItem],
    degraded: bool,
    reason: DegradedReason | None,
    index: str,
    budget_used: BudgetUsed,
    policy_evaluations: Sequence[PolicyEvaluation],
) -> dict[str, Any]:
    """The immutable record of one retrieval: references and digests, no content (§4.1).

    The query is represented by its digest. A retrieval query can carry customer text —
    a claim id, a customer's question — and the audit store is not the place to keep a
    second copy of it (§6.5); the digest is enough to prove two retrievals asked the
    same thing. The policy denials are *inside* the evidence: "this retrieval withheld a
    restricted class" is part of what the model saw, not a footnote to it.
    """
    manifest: dict[str, Any] = {
        "tenant_id": tenant_id,
        "recipe_id": recipe.name,
        "request_digest": sha256_digest(
            canonical_json(
                {
                    "recipe_id": recipe.name,
                    "query": request.get("query"),
                    "filters": request.get("filters"),
                    "budget": request.get("budget"),
                }
            )
        ),
        "items": [
            {
                "entity_id": item.entity_id,
                "type": item.type,
                "version": item.version,
                "source_ref": item.source_ref,
                "score": item.score,
                "content_digest": sha256_digest(item.content),
                "classification": item.classification,
            }
            for item in items
        ],
        "degraded": degraded,
        "reason": reason,
        "index": index,
        "budget_used": budget_used.model_dump(mode="json"),
    }
    if policy_evaluations:
        manifest["policy_evaluations"] = [
            evaluation.model_dump(mode="json") for evaluation in policy_evaluations
        ]
    return manifest


def _tightened(caller: Mapping[str, Any], key: str, ceiling: int) -> int:
    """The recipe's ceiling, or the caller's smaller one — never the caller's larger one."""
    asked = caller.get(key)
    return ceiling if asked is None else min(int(asked), ceiling)


def _floor(value: float) -> float:
    """Keep every score inside the wire's `[0, 1]`, rounded so the digest is stable."""
    return round(max(0.0, min(1.0, value)), 6)


def _tokens(content: str) -> int:
    """The deterministic prompt-cost estimate the `max_tokens` budget counts in."""
    return (len(content) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN


__all__ = ["Snapshot", "retrieve", "HOP_DECAY", "DegradedReason"]
