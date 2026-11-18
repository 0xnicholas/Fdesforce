"""The `mask` stage: the Customer's permission baseline, applied to what is returned (§7).

`docs/semantic-modeling.md` §6.3 lists `mask` as a mandatory stage and §7.2 fixes why:
it is the stage that cannot be dropped or reordered, because everything after it —
ranking, budget, the prompt — would otherwise carry data the caller may not see. So
the baseline (`permissions.yaml`) is applied to candidates *after* ranking and
*before* the budget, and a class the caller may not see is gone from the answer
rather than ranked lower.

Four rules, and one refusal:

1. **Class scope.** A class that names scopes (`ic:Claim: [claims:read]`) is served
   only to a caller whose `ExecutionContext` holds them. A missing scope drops the
   item and records a `deny` policy evaluation, so a Decision can say that context
   was withheld instead of silently receiving less.
2. **Property mask.** A property whose baseline declares a `columnMask` (`redact`,
   `hash`, `tokenize`, `null`) is replaced before rendering, and the content is
   re-rendered from the masked facts — masking the field but leaving the original
   string in `content` would mask nothing. A property that only declares PII takes
   the baseline's default mask.
3. **Property scope.** A property whose baseline names `requiredScopes` is masked
   for a caller without them: the field is narrowed, the entity is still served.
4. **Classification.** The item's `classification` is the baseline's for its class —
   never the source's own opinion, and never absent: an unclassified class is
   `restricted` (§7.1's fixed default).

The one refusal is a package one and lives in `app.context_package`: a `rowFilter`
that binds a parameter this backend cannot push down (`:allowed_customer_ids`) needs
a class scope to fall back on. `tenant_id` is not such a parameter — the graph
filters on the id's tenant segment already (§5.3), which is why a baseline that
mentions it is enforceable here.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from app.content import render
from app.context_package import PermissionProfile, type_of
from app.graph.entity_id import parse as parse_entity_id
from app.graph.port import Entity

#: What a masked value becomes. Deliberately not the original: a redaction that can
#: be reversed by a client is not a redaction (§7.3).
REDACTED = "[redacted]"


@dataclass(frozen=True)
class Masked:
    """One candidate the caller may see, with the baseline's classification applied."""

    entity: Entity
    classification: str
    replaced_properties: tuple[str, ...]


def apply(
    entities: Iterable[tuple[Entity, Mapping[str, Any]]],
    *,
    profile: PermissionProfile,
    scopes: Sequence[str],
    policy_version: str,
) -> tuple[list[Masked], list[dict[str, Any]]]:
    """Mask or withhold each entity; return what survives and the denials recorded.

    `entities` yields `(entity, attributes)` rather than reading the entity's own bag
    so a caller can hand in a candidate whose content it has already decided to keep.
    The returned denials are the contract's `PolicyEvaluation` documents
    (`enforcement_point: context.retrieve`, `evaluated_by: context-service`), and
    `policy_version` is the frozen package version they cite — the baseline is part of
    the package, so the evaluation is attributable to a revision rather than to a file
    name.
    """
    held: list[str] = set(scopes)
    kept: list[Masked] = []
    denials: dict[str, dict[str, Any]] = {}

    for entity, attributes in entities:
        term = _term(entity, attributes)
        missing = missing_scopes(profile, term, held)
        if missing:
            denials.setdefault(
                f"permissions.yaml#{term}",
                {
                    "policy_id": f"permissions.yaml#{term}",
                    "version": policy_version,
                    "outcome": "deny",
                    "reason": f"{term} requires {', '.join(missing)}",
                    "enforcement_point": "context.retrieve",
                    "evaluated_by": "context-service",
                },
            )
            continue

        # The baseline is the only authority on a class's classification. A source's
        # declared classification is the source boundary's default, not a per-class
        # baseline; falling back to it would let a source under-classify its own facts
        # (a class with no baseline entry is `restricted` — §7.1, and `packages/spec`
        # warns exactly that).
        classification = profile.classifications.get(term) or profile.unknown_classification
        properties = attributes.get("properties")
        masked_here: tuple[str, ...] = ()
        if isinstance(properties, Mapping) and properties:
            properties, masked_here = _mask_properties(properties, profile, held)
            entity = Entity(
                entity_id=entity.entity_id,
                type=entity.type,
                content=render(type_of(term), parse_entity_id(entity.entity_id).key, properties),
                source_ref=entity.source_ref,
                version=entity.version,
                attributes={**attributes, "properties": properties},
            )
        kept.append(Masked(entity=entity, classification=classification, replaced_properties=masked_here))

    return kept, [denials[key] for key in sorted(denials)]


def missing_scopes(profile: PermissionProfile, term: str | None, scopes: Iterable[str]) -> tuple[str, ...]:
    """The class scopes this caller lacks — the one predicate the two readers share.

    The mask stage and the Connector operation endpoint both decide "may this caller see
    this class of data", and §7.2's baseline is the only source for the answer. Two copies
    of the comparison would let a Tool and a retrieval disagree, which is exactly what a
    permission baseline exists to prevent.
    """
    if term is None:
        return ()
    held = set(scopes)
    return tuple(scope for scope in profile.scopes.get(term, ()) if scope not in held)


def _term(entity: Entity, attributes: Mapping[str, Any]) -> str:
    """The ontology class a candidate belongs to: the term ingest recorded, else the type.

    A graph written before this stage existed (or by a test) carries no `term`; its
    `type` is the best available answer, and an unclassified class is `restricted`.
    """
    term = attributes.get("term")
    return term if isinstance(term, str) and term else entity.type


def _mask_properties(
    properties: Mapping[str, Any], profile: PermissionProfile, held: set[str]
) -> tuple[dict[str, Any], tuple[str, ...]]:
    masked: dict[str, Any] = {}
    applied: list[str] = []
    for term, value in properties.items():
        annotation = profile.properties.get(term)
        action = _action(annotation, profile, held)
        if action is None:
            masked[term] = value
            continue
        masked[term] = _apply_mask(action, value)
        applied.append(term)
    return masked, tuple(sorted(applied))


def _action(annotation: Any, profile: PermissionProfile, held: set[str]) -> str | None:
    if annotation is None:
        return None
    if annotation.required_scopes and any(scope not in held for scope in annotation.required_scopes):
        return annotation.mask or profile.default_pii_mask
    if annotation.mask is not None:
        return str(annotation.mask)
    if annotation.pii is not None and annotation.pii != "none":
        return profile.default_pii_mask
    return None


def _apply_mask(action: str, value: Any) -> Any:
    """One mask, deterministically. `hash`/`tokenize` are stable so a digest is too."""
    if value is None:
        return None
    if action == "null":
        return None
    if action == "redact":
        return REDACTED
    digest = hashlib.sha256(str(value).encode("utf-8")).hexdigest()
    if action == "tokenize":
        return f"tok_{digest[:16]}"
    return f"sha256:{digest}"
