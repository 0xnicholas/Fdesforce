"""The provenance projection: the original Decision as PROV-O (§6.3, C14).

`GET /v1/provenance/{decision_id}` returns the Decision itself, a JSON-LD view of
it, and a flat `lineage` summary. Everything here is a pure function of the
Decision, so a response cannot depend on how the audit store keeps its rows —
which is exactly what C14 asks for: stable IDs only, never a backend-internal one.

The mapping follows §6.3:

| PROV-O | Runtime object |
| --- | --- |
| `prov:Activity` | the Run (and, later, a retrieval or approval) |
| `prov:Entity` | the Decision, evidence items, Policies |
| `prov:Agent` | the actor, and the model/agent version as a `prov:SoftwareAgent` |
| `prov:used` | evidence references and evaluated Policies |
| `prov:wasGeneratedBy` | Decision ← Run activity |
| `prov:wasAttributedTo` | Decision ← actor and model |
| `prov:wasDerivedFrom` | Decision ← upstream Decision |

Node identifiers are compact IRIs under the `fde` prefix, built only from the
Decision's own stable IDs. Ids that are not IRI-safe (an `entity_id` carries
colons by design) are percent-encoded, so the same entity always maps to the same
node without the projection inventing an id of its own.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from typing import Any, NamedTuple
from urllib.parse import quote

PROV_CONTEXT: Mapping[str, str] = {
    "prov": "http://www.w3.org/ns/prov#",
    "fde": "https://fde.dev/ns#",
}

JSONLDNode = dict[str, str]
LineageItem = dict[str, str]


def _node(kind: str, *parts: str) -> str:
    """`fde:<kind>/<part>/<part>` with each part escaped as a single path segment."""
    return f"fde:{kind}/" + "/".join(quote(part, safe="@") for part in parts)


def _link(node: str, node_type: str) -> JSONLDNode:
    return {"@id": node, "@type": node_type}


def _model_parts(model: Mapping[str, Any]) -> list[str]:
    """`[provider, model[@version]]` — the one spelling both the ref and the node use."""
    parts = [str(model["provider"]), str(model["model"])]
    if model.get("version"):
        parts[-1] += f"@{model['version']}"
    return parts


def _model_ref(model: Mapping[str, Any]) -> str:
    """`provider/model[@version]` — the stable name of the model that proposed the Decision."""
    return "/".join(_model_parts(model))


def _model_node(model: Mapping[str, Any]) -> str:
    return _node("model", *_model_parts(model))


def _policy_ref(policy: Mapping[str, Any]) -> str:
    policy_id = str(policy["policy_id"])
    return f"{policy_id}@{policy['version']}" if policy.get("version") else policy_id


def _unique(items: Iterable[Any], key: Callable[[Any], Any]) -> list[Any]:
    seen: set[Any] = set()
    unique: list[Any] = []
    for item in items:
        marker = key(item)
        if marker in seen:
            continue
        seen.add(marker)
        unique.append(item)
    return unique


def _evidence_items(decision: Mapping[str, Any]) -> Iterable[Mapping[str, Any]]:
    return decision.get("evidence") or ()


def _policy_items(decision: Mapping[str, Any]) -> Iterable[Mapping[str, Any]]:
    return decision.get("policy_evaluations") or ()


#: Evidence `type` → (PROV-O node kind, the field that names it). One table so the
#: JSON-LD node and the lineage summary cannot disagree about a new evidence kind.
EVIDENCE_KINDS: Mapping[str, tuple[str, str]] = {
    "graph_entity": ("entity", "entity_id"),
    "retrieval": ("retrieval", "retrieval_id"),
    "run_artifact": ("artifact", "digest"),
    "approval": ("approval", "approval_id"),
}


class EvidenceIdentity(NamedTuple):
    """The stable name of one evidence item: its kind, its id, and its PROV-O node."""

    kind: str
    value: str
    node: str


def _evidence_identity(item: Mapping[str, Any]) -> EvidenceIdentity | None:
    kind = str(item.get("type", "graph_entity"))
    spec = EVIDENCE_KINDS.get(kind)
    if spec is None:
        # The contract's discriminator admits exactly the four above, and the
        # request was validated before it was stored; an unknown kind contributes
        # no node rather than inventing one.
        return None
    node_kind, field = spec
    value = str(item[field])
    return EvidenceIdentity(kind=kind, value=value, node=_node(node_kind, value))


def prov_o(decision: Mapping[str, Any]) -> dict[str, Any]:
    """The Decision as a JSON-LD PROV-O entity."""
    actor = decision["actor"]
    document: dict[str, Any] = {
        "@context": PROV_CONTEXT,
        "@id": _node("decision", str(decision["decision_id"])),
        "@type": "prov:Entity",
        "prov:generatedAtTime": decision["timestamp"],
        "prov:wasGeneratedBy": _link(_node("run", str(decision["run_id"])), "prov:Activity"),
    }

    attributed = [_link(_node("agent", str(actor["type"]), str(actor["id"])), "prov:Agent")]
    model = decision.get("model")
    if model:
        attributed.append(_link(_model_node(model), "prov:SoftwareAgent"))
    document["prov:wasAttributedTo"] = attributed

    used = [
        _link(identity.node, "prov:Entity")
        for item in _evidence_items(decision)
        if (identity := _evidence_identity(item)) is not None
    ]
    used.extend(_link(_node("policy", _policy_ref(policy)), "prov:Entity") for policy in _policy_items(decision))
    if used:
        document["prov:used"] = _unique(used, key=lambda link: (link["@id"], link["@type"]))

    parent = decision.get("parent_decision_id")
    if parent:
        document["prov:wasDerivedFrom"] = [_link(_node("decision", str(parent)), "prov:Entity")]
    return document


def lineage(decision: Mapping[str, Any]) -> list[LineageItem]:
    """The summary: what the Decision came from, whose it is, and what it used."""
    actor = decision["actor"]
    items: list[LineageItem] = [
        {"type": "run", "id": str(decision["run_id"]), "relationship": "wasGeneratedBy"},
        {"type": "actor", "id": str(actor["id"]), "relationship": "wasAttributedTo"},
    ]
    model = decision.get("model")
    if model:
        items.append({"type": "model", "id": _model_ref(model), "relationship": "wasAttributedTo"})
    items.extend(
        {"type": identity.kind, "id": identity.value, "relationship": "used"}
        for evidence in _evidence_items(decision)
        if (identity := _evidence_identity(evidence)) is not None
    )
    items.extend(
        {"type": "policy", "id": _policy_ref(policy), "relationship": "used"} for policy in _policy_items(decision)
    )
    parent = decision.get("parent_decision_id")
    if parent:
        items.append({"type": "decision", "id": str(parent), "relationship": "wasDerivedFrom"})
    return _unique(items, key=lambda item: (item["type"], item["id"], item["relationship"]))
