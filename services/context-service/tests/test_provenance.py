"""Decision → PROV-O and lineage (§6.3, C14).

The projection is a pure function over the original Decision, which is what makes
it testable without a store: the response must carry stable IDs (`decision_id`,
`run_id`, `entity_id`, `retrieval_id`, …) and PROV-O relationships, and nothing
that says how the audit store keeps them (no `seq`, `rowid`, `sqlite`,
`payload`, `prev_hash`, `hash`).

The two seams are `prov_o()` (the JSON-LD document) and `lineage()` (the
human-sized summary); the route assembles them into the contract's
`ProvenanceResponse`.
"""

from __future__ import annotations

import json
from typing import Any

from app.provenance import lineage, prov_o

PROV = "http://www.w3.org/ns/prov#"


def decision(**overrides: Any) -> dict[str, Any]:
    """The contract's intent example, trimmed to the fields the projection reads."""
    return {
        "decision_id": "dec_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "parent_decision_id": "dec_01ARZ3NDEKTSV4RRFFQ69G5FB0",
        "invocation_id": "inv_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "run_id": "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "tenant_id": "acme",
        "capability_id": "document-triage",
        "decision_type": "runtime",
        "phase": "intent",
        "action": {"tool_id": "claim-decision", "side_effects": "write"},
        "status": "proposed",
        "actor": {"type": "user", "id": "u-42"},
        "rationale": "Record the claim decision after triage.",
        "evidence": [
            {
                "type": "graph_entity",
                "entity_id": "fde:acme:policy:refund",
                "retrieval_id": "ret_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "source_ref": "sharepoint://claims/policies/refund.md",
            },
            {
                "type": "retrieval",
                "retrieval_id": "ret_01ARZ3NDEKTSV4RRFFQ69G5FAV",
                "snapshot_digest": "sha256:" + "9f2c" + "a" * 60,
            },
        ],
        "policy_evaluations": [
            {
                "policy_id": "tool-allowlist",
                "version": "1.0.0",
                "enforcement_point": "tool.pre_invoke",
                "evaluated_by": "mastra-app",
                "outcome": "allow",
            }
        ],
        "model": {"provider": "azure-openai", "model": "gpt-5.1", "version": "2026-11"},
        "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
        "timestamp": "2026-11-15T08:00:00Z",
        **overrides,
    }


def test_prov_o_is_a_json_ld_entity_for_the_decision() -> None:
    document = prov_o(decision())

    assert document["@context"]["prov"] == PROV
    assert document["@id"] == "fde:decision/dec_01ARZ3NDEKTSV4RRFFQ69G5FAV"
    assert document["@type"] == "prov:Entity"
    assert document["prov:generatedAtTime"] == "2026-11-15T08:00:00Z"


def test_prov_o_maps_the_run_actor_model_and_evidence() -> None:
    document = prov_o(decision())

    assert document["prov:wasGeneratedBy"] == {
        "@id": "fde:run/run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "@type": "prov:Activity",
    }
    assert {"@id": "fde:agent/user/u-42", "@type": "prov:Agent"} in document["prov:wasAttributedTo"]
    assert {"@id": "fde:model/azure-openai/gpt-5.1@2026-11", "@type": "prov:SoftwareAgent"} in document[
        "prov:wasAttributedTo"
    ]
    used = {node["@id"] for node in document["prov:used"]}
    assert "fde:entity/fde%3Aacme%3Apolicy%3Arefund" in used
    assert "fde:retrieval/ret_01ARZ3NDEKTSV4RRFFQ69G5FAV" in used
    assert "fde:policy/tool-allowlist@1.0.0" in used
    assert document["prov:wasDerivedFrom"] == [
        {"@id": "fde:decision/dec_01ARZ3NDEKTSV4RRFFQ69G5FB0", "@type": "prov:Entity"}
    ]


def test_prov_o_omits_links_the_decision_does_not_have() -> None:
    """A run Decision has no parent and no model; absent is absent, not an empty node."""
    document = prov_o(
        decision(
            phase="run",
            status="succeeded",
            **{key: None for key in ("parent_decision_id", "invocation_id", "action", "evidence", "model")},
            policy_evaluations=None,
        )
    )

    assert "prov:wasDerivedFrom" not in document
    assert "prov:used" not in document
    assert document["prov:wasAttributedTo"] == [{"@id": "fde:agent/user/u-42", "@type": "prov:Agent"}]


def test_lineage_names_every_link_once_in_a_stable_order() -> None:
    duplicate = decision()
    duplicate["evidence"] = duplicate["evidence"] + [duplicate["evidence"][0]]
    duplicate["policy_evaluations"] = duplicate["policy_evaluations"] * 2

    links = lineage(duplicate)

    assert [link["relationship"] for link in links] == [
        "wasGeneratedBy",
        "wasAttributedTo",
        "wasAttributedTo",
        "used",
        "used",
        "used",
        "wasDerivedFrom",
    ]
    assert [(link["type"], link["id"]) for link in links] == [
        ("run", "run_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        ("actor", "u-42"),
        ("model", "azure-openai/gpt-5.1@2026-11"),
        ("graph_entity", "fde:acme:policy:refund"),
        ("retrieval", "ret_01ARZ3NDEKTSV4RRFFQ69G5FAV"),
        ("policy", "tool-allowlist@1.0.0"),
        ("decision", "dec_01ARZ3NDEKTSV4RRFFQ69G5FB0"),
    ]


def test_a_run_artifact_is_named_by_its_digest() -> None:
    artifact = {
        "type": "run_artifact",
        "run_id": "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "path": "output.citedSources",
        "digest": "sha256:" + "7d1e" + "b" * 60,
    }
    links = lineage(decision(phase="run", status="succeeded", evidence=[artifact], policy_evaluations=None))

    assert {"type": "run_artifact", "id": artifact["digest"], "relationship": "used"} in links


def test_the_projection_carries_no_storage_internals() -> None:
    """C14: the document must not say how the audit store keeps the Decision."""
    serialized = json.dumps({"prov_o": prov_o(decision()), "lineage": lineage(decision())})

    for internal in ("prev_hash", "payload_digest", "rowid", "sqlite", "chain_verification", '"seq"', '"hash"'):
        assert internal not in serialized


def test_the_projection_is_deterministic() -> None:
    assert prov_o(decision()) == prov_o(decision())
    assert lineage(decision()) == lineage(decision())
