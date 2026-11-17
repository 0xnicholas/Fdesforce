"""The v0 retrieval pipeline, and the Retrieval Snapshot it mints (§3.3, §4.1, §4.3).

`docs/semantic-modeling.md` §6.2–6.4 describes the full Recipe: `resolve →
structured → graph → lexical → merge → rank → mask → budget`. v0 implements the part
the embedded backend can honour, in that order (the `structured`, `mask` and
recipe-defined `filters` stages arrive with the Recipe pipeline, #39):

```text
lexical_search(query)        → anchors with the engine's scores
expand(anchors, max_hops)    → neighbours, 1..max_hops out, scored by anchor × decay × edge
merge                        → one entry per entity, the best score wins
rank                         → score desc, then entity_id asc (a stable order, not a lucky one)
budget                       → max_nodes / max_tokens / max_hops, deterministic truncation
```

Determinism matters more than sophistication here: the same graph and the same
request must produce the same items in the same order, or `snapshot_digest` would be
noise and a Decision could not cite "what the model saw". So every step sorts on a
total order (`score`, then `entity_id`) and takes no wall-clock decisions.

**The snapshot** (§4.1) is a manifest, not a copy: `retrieval_id`, the request's
digest, and per-item *references* (`entity_id`, `type`, `version`, `source_ref`,
`score`, `content_digest`). The content stays in the graph, where it can be rebuilt;
the audit store keeps what was cited and what it hashed to, which is what an auditor
needs and what §6.5 forbids it to keep twice. `snapshot_digest` is the SHA-256 of the
canonical manifest — the same digest the caller sees, the same one the store appends,
so "what the model saw" is checkable rather than asserted.

**Degradation** (§6.4) is reported, never silent: an empty answer is
`reason=empty`; a graph over the embedded ceiling is `reason=scale_limit` (and the
expansion is skipped, because the ceiling is a latency promise, not a suggestion);
a retrieval whose matches all exceeded the caller's token budget is `reason=partial`
— the graph had an answer, the budget excluded it, and the caller has a knob to fix.
`reason=partial` is also what #39 will report while ingest is still running (§9.2).
A caller that cannot tell an empty answer from a complete one will trust the wrong
one.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Literal

from app.canonical import canonical_json, sha256_digest
from app.clock import isoformat_z, utc_now
from app.generated.models import BudgetUsed, RetrievalItem
from app.graph.port import Entity, GraphStore
from app.ids import new_ulid
from app.limits import (
    CHARS_PER_TOKEN,
    DEFAULT_MAX_HOPS,
    DEFAULT_MAX_NODES,
    DEFAULT_MAX_TOKENS,
    MAX_ANCHORS,
    MAX_SUPPORTED_HOPS,
    over_ceiling,
)

#: `RetrieveResponse.reason` (`contracts/schemas/retrieval.schema.json`).
DegradedReason = Literal["scale_limit", "index_unavailable", "timeout", "partial", "empty"]

#: How much of an anchor's relevance survives one hop. Half is a judgement, not a
#: measurement: it keeps a 2-hop neighbour visibly weaker than a direct hit, which is
#: what §6.3's "exact > graph > lexical" priority needs from the score.
HOP_DECAY = 0.5

#: The attribute names a graph entity can promote into typed `RetrievalItem` fields.
#: Each is checked rather than trusted: an out-of-enum value would fail model
#: validation inside the handler (a `500` for a caller's graph), and an id-shaped
#: string that is not a `ProvenanceId` would be a citation to nothing.
_CLASSIFICATIONS = frozenset({"public", "internal", "confidential", "restricted"})
_SOURCE_KINDS = frozenset({"structured", "document", "web", "derived", "other"})
_PROVENANCE_ID = re.compile(r"^prov_[0-9A-HJKMNP-TV-Z]{26}$")


@dataclass(frozen=True)
class Snapshot:
    """One Retrieval Snapshot: the wire body's parts, and the manifest that was hashed.

    `manifest` is the **evidence** — tenant, request digest, item references, budget,
    degradation — and `digest` covers exactly that. The identity of the call
    (`retrieval_id`, `trace_id`, `created_at`) is deliberately outside the hash: it
    differs on every call, and a digest that changed with the clock could not answer
    the one question it exists for — "did these two retrievals return the same
    evidence?".
    """

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
    manifest: Mapping[str, Any]
    digest: str


@dataclass(frozen=True)
class _Candidate:
    """One item on its way to the wire: the entity, its score, and how it was found."""

    entity: Entity
    score: float
    hop: int


def retrieve(
    store: GraphStore,
    *,
    tenant_id: str,
    trace_id: str,
    request: Mapping[str, Any],
    now: datetime | None = None,
) -> Snapshot:
    """Run the v0 pipeline for one validated `RetrieveRequest`."""
    query = str(request["query"])
    budget = request.get("budget") or {}
    max_nodes = int(budget.get("max_nodes") or DEFAULT_MAX_NODES)
    max_tokens = int(budget.get("max_tokens") or DEFAULT_MAX_TOKENS)
    # The contract lets a caller ask for up to four hops; v0 supports two (§4.3), so a
    # larger request is capped here rather than honoured slowly or refused.
    max_hops = min(int(budget.get("max_hops") or DEFAULT_MAX_HOPS), MAX_SUPPORTED_HOPS)

    stats = store.stats()
    past_ceiling = over_ceiling(stats.nodes, stats.edges)

    ranked = _candidates(
        store,
        tenant_id=tenant_id,
        query=query,
        max_nodes=max_nodes,
        max_hops=max_hops,
        expand=not past_ceiling,
    )
    kept, budget_used = _within_budget(ranked, max_nodes=max_nodes, max_tokens=max_tokens)

    if past_ceiling:
        degraded, reason = True, "scale_limit"
    elif ranked and not kept:
        # Something matched, but nothing fit the budget the caller set. That is a
        # partial context, not an empty one: reporting `empty` would tell the caller
        # the graph had no answer when the answer was only too large to include.
        degraded, reason = True, "partial"
    elif not kept:
        degraded, reason = True, "empty"
    else:
        degraded, reason = False, None

    index: Literal["lexical", "graph"] = "graph" if any(candidate.hop > 0 for candidate in kept) else "lexical"
    items = tuple(_item(candidate) for candidate in kept)
    retrieval_id = new_ulid("ret_")
    created_at = isoformat_z(now or utc_now())
    recipe_id = str(request["recipe_id"])

    manifest = _manifest(
        tenant_id=tenant_id,
        recipe_id=recipe_id,
        request=request,
        items=items,
        degraded=degraded,
        reason=reason,
        index=index,
        budget_used=budget_used,
    )
    return Snapshot(
        retrieval_id=retrieval_id,
        tenant_id=tenant_id,
        trace_id=trace_id,
        recipe_id=recipe_id,
        created_at=created_at,
        items=items,
        degraded=degraded,
        reason=reason,
        index=index,
        budget_used=budget_used,
        manifest=manifest,
        digest=sha256_digest(canonical_json(manifest)),
    )


def _candidates(
    store: GraphStore,
    *,
    tenant_id: str,
    query: str,
    max_nodes: int,
    max_hops: int,
    expand: bool,
) -> list[_Candidate]:
    """Lexical anchors plus everything within `max_hops` of them, merged and ranked."""
    matches = store.lexical_search(tenant_id, query, limit=max_nodes)
    best: dict[str, _Candidate] = {}
    for match in matches:
        entity = store.get_entity(tenant_id, match.entity_id)
        if entity is None:
            continue
        best[match.entity_id] = _Candidate(entity=entity, score=_score(match.score), hop=0)

    anchors = [match for match in matches if match.entity_id in best][:MAX_ANCHORS]
    if expand and anchors and max_hops > 0:
        # The anchors go in rank order and the port reports which one reached each
        # neighbour, so a two-hop fact is weighted by the best anchor that found it
        # rather than by whichever anchor happened to be walked first.
        anchor_scores = {match.entity_id: best[match.entity_id].score for match in matches[:MAX_ANCHORS]}
        reach = store.expand(
            tenant_id,
            [match.entity_id for match in anchors],
            hops=max_hops,
            limit=max_nodes * 2,
        )
        for expansion in reach:
            if expansion.entity_id in best:
                continue  # a lexical hit outranks a walk to the same entity
            anchor_score = anchor_scores.get(expansion.anchor)
            if anchor_score is None:
                continue
            entity = store.get_entity(tenant_id, expansion.entity_id)
            if entity is None:
                continue
            score = _score(anchor_score * (HOP_DECAY**expansion.hop) * expansion.weight)
            best[expansion.entity_id] = _Candidate(entity=entity, score=score, hop=expansion.hop)

    return sorted(best.values(), key=lambda candidate: (-candidate.score, candidate.entity.entity_id))


def _within_budget(
    ranked: Sequence[_Candidate],
    *,
    max_nodes: int,
    max_tokens: int,
) -> tuple[list[_Candidate], BudgetUsed]:
    """Truncate to the budget, deterministically, and report what was used.

    Truncation is by rank order, so the weakest evidence goes first. An item that
    would overflow `max_tokens` is *skipped*, not the end of the list: one long
    document must not starve the smaller facts below it, and a half-included item
    would be worse than either — the caller sees a smaller, complete answer and
    `budget_used` says what it cost.
    """
    kept: list[_Candidate] = []
    tokens = 0
    for candidate in ranked:
        if len(kept) >= max_nodes:
            break
        estimated = _tokens(candidate.entity.content)
        if tokens + estimated > max_tokens:
            continue
        kept.append(candidate)
        tokens += estimated
    hops = max((candidate.hop for candidate in kept), default=0)
    return kept, BudgetUsed(nodes=len(kept), tokens=tokens, hops=hops)


def _item(candidate: _Candidate) -> RetrievalItem:
    """One entity as the contract's `RetrievalItem`.

    Optional fields are *omitted* when absent rather than sent as `null`: the
    generated models refuse an explicit null for them, which is the contract's way of
    saying that "no classification" and "classification: null" are not both answers.
    """
    attributes = dict(candidate.entity.attributes)
    classification = attributes.pop("classification", None)
    source_kind = attributes.pop("source_kind", None)
    provenance_id = attributes.pop("provenance_id", None)
    fields: dict[str, Any] = {
        "entity_id": candidate.entity.entity_id,
        "type": candidate.entity.type,
        "content": candidate.entity.content,
        "score": candidate.score,
        "source_ref": candidate.entity.source_ref,
        "version": candidate.entity.version,
        # C33: retrieved content is data, never instructions. The contract's enum has
        # exactly one value, so this is a statement of the stance, not a per-item knob.
        "trust": "untrusted",
        "metadata": {**attributes, "hop": candidate.hop},
    }
    if classification in _CLASSIFICATIONS:
        fields["classification"] = classification
    if source_kind in _SOURCE_KINDS:
        fields["source_kind"] = source_kind
    if isinstance(provenance_id, str) and _PROVENANCE_ID.match(provenance_id):
        fields["provenance_id"] = provenance_id
    return RetrievalItem(**fields)


def _manifest(
    *,
    tenant_id: str,
    recipe_id: str,
    request: Mapping[str, Any],
    items: Sequence[RetrievalItem],
    degraded: bool,
    reason: DegradedReason | None,
    index: str,
    budget_used: BudgetUsed,
) -> dict[str, Any]:
    """The immutable record of one retrieval: references and digests, no content (§4.1).

    The query is represented by its digest. A retrieval query can carry customer text
    — a claim id, a customer's question — and the audit store is not the place to keep
    a second copy of it (§6.5); the digest is enough to prove two retrievals asked the
    same thing.

    The tenant is inside the manifest (and therefore inside the hash) as well as in
    the row's filter column: the evidence is *this tenant's* evidence, and a row
    whose tenant was edited would not re-verify.
    """
    return {
        "tenant_id": tenant_id,
        "recipe_id": recipe_id,
        "request_digest": sha256_digest(
            canonical_json(
                {
                    "recipe_id": recipe_id,
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
            }
            for item in items
        ],
        "degraded": degraded,
        "reason": reason,
        "index": index,
        "budget_used": budget_used.model_dump(mode="json"),
    }


def _score(value: float) -> float:
    """Keep every score inside the wire's `[0, 1]`, rounded so the digest is stable."""
    return round(max(0.0, min(1.0, value)), 6)


def _tokens(content: str) -> int:
    """The deterministic prompt-cost estimate the `max_tokens` budget counts in."""
    return (len(content) + CHARS_PER_TOKEN - 1) // CHARS_PER_TOKEN
