"""`POST /v1/context/retrieve` over the served surface (§3.3, §4.1, §4.3).

The seam is HTTP against a spawned process with a real graph volume. `GraphStore` is an
internal port and *not* a test seam, so nothing here reaches into the store: fixtures build
volumes with the shipped implementation (or run the real ingest job), the process loads
them, and every assertion is about what a caller receives.

What a caller must be able to rely on, and what these tests pin:

- an item says where it came from (`entity_id`, `source_ref`, `version`) and how far it is
  trusted, or it is not evidence (§3.3);
- `retrieval_id` and `snapshot_digest` describe an immutable Retrieval Snapshot (§4.1), so
  a Decision can cite what the model actually saw — and two identical calls share a digest;
- the token's tenant decides what comes back, not the query (§5.3, C3);
- an empty answer, an unmaterialized graph and a graph past the ceiling are three
  different answers (§6.4, §9.2), and each says which it is.

The stage-by-stage behaviour of the recipe itself — weights, relation filtering, masks —
is `tests/test_recipe_pipeline.py`; this file is the contract's own promises.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from typing import Any

import pytest

from app.limits import EMBEDDED_MAX_NODES
from conformance.documents import ContractDocuments
from conformance.graph_fixture import entity, relationship, seed_volume
from conformance.harness import ServiceProcess

RETRIEVE_RESPONSE = "retrieval.schema.json#/$defs/RetrieveResponse"

RETRIEVAL_ID = re.compile(r"^ret_[0-9A-HJKMNP-TV-Z]{26}$")
DIGEST = re.compile(r"^sha256:[a-f0-9]{64}$")

#: The Acme claims-triage facts a seeded volume holds: a claim, the policy that governs
#: it, and the approval rule one hop further out. `term`/`source` are what ingest writes,
#: and the stages read exactly those — a fixture without them is a graph no ingest makes.
ACME_ENTITIES = (
    entity(
        "fde:acme:claim:C-1001",
        "Claim",
        "Claim C-1001: refund request from a premium customer.",
        source_ref="claims-db://public.claims/C-1001",
        version="17",
        term="ic:Claim",
        source="claims-db",
        classification="confidential",
        source_kind="structured",
        properties={"ic:claimId": "C-1001"},
    ),
    entity(
        "fde:acme:policy:refund",
        "Policy",
        "Premium customers may receive a refund within 30 days.",
        source_ref="sharepoint://claims/policies/refund.md",
        version="3",
        term="ic:Policy",
        source="sharepoint-claims",
        source_kind="document",
    ),
    entity(
        "fde:acme:policy:approval",
        "Policy",
        "Refund requests over 100000 require manual approval.",
        source_ref="sharepoint://claims/policies/approval.md",
        version="2",
        term="ic:Policy",
        source="sharepoint-claims",
        source_kind="document",
    ),
    entity(
        "fde:acme:document:faq",
        "Document",
        "Refunds are processed by the claims team within five business days.",
        source_ref="sharepoint://claims/faq.md",
        version="9",
        term="ic:ClaimDocument",
        source="sharepoint-claims",
        source_kind="document",
    ),
    # A pair for the budget test: the same query term, one document far too large for a
    # small `max_tokens` and one that fits. Both score the same on the term, so what is
    # kept is the packing rule, not a lucky order.
    entity(
        "fde:acme:document:budget-heavy",
        "Document",
        "budgetprobe " * 60,
        source_ref="sharepoint://claims/budget/heavy.md",
        version="1",
        term="ic:ClaimDocument",
        source="sharepoint-claims",
    ),
    entity(
        "fde:acme:document:budget-light",
        "Document",
        "budgetprobe note.",
        source_ref="sharepoint://claims/budget/light.md",
        version="1",
        term="ic:ClaimDocument",
        source="sharepoint-claims",
    ),
)

ACME_RELATIONSHIPS = (
    relationship("fde:acme:claim:C-1001", "fde:acme:policy:refund", "ic:hasPolicy", weight=0.9),
    relationship("fde:acme:policy:refund", "fde:acme:policy:approval", "ic:documentsPolicy", weight=0.8),
    relationship("fde:acme:policy:refund", "fde:acme:document:faq", "ic:documentsPolicy", weight=0.5),
)

#: Another tenant's facts on the same volume. A retrieval that ignored the token's tenant
#: would return these, which is what makes the isolation test able to fail.
BETA_ENTITIES = (
    entity(
        "fde:beta:policy:refund",
        "Policy",
        "Premium customers may receive a refund within 30 days.",
        source_ref="sharepoint://beta/policies/refund.md",
        version="1",
        term="ic:Policy",
        source="sharepoint-claims",
    ),
)

#: The scopes the Acme baseline's classes need (`permissions.yaml`).
CLAIMS = ("context:retrieve", "claims:read", "claims:documents:read", "customer:pii:read")


@pytest.fixture(scope="session")
def seeded_service(tmp_path_factory: pytest.TempPathFactory) -> Iterator[ServiceProcess]:
    """One process over one seeded volume: the deployment's graph, served."""
    data = tmp_path_factory.mktemp("retrieval")
    seed_volume(
        data / "graph" / "graph.json",
        tenant_id="acme",
        entities=ACME_ENTITIES,
        relationships=ACME_RELATIONSHIPS,
        extra_tenants={"beta": (BETA_ENTITIES, ())},
    )
    with ServiceProcess.start(data_dir=data) as process:
        yield process


def retrieve(
    service: ServiceProcess,
    query: str,
    *,
    tenant_id: str = "acme",
    budget: dict[str, int] | None = None,
    scopes: tuple[str, ...] = CLAIMS,
) -> Any:
    """One authenticated retrieval; the token's trace is the one the body must carry."""
    headers = service.authorized(tenant_id=tenant_id, scopes=scopes)
    body: dict[str, Any] = {"recipe_id": "claims-context", "query": query}
    if budget is not None:
        body["budget"] = budget
    return service.post("/v1/context/retrieve", json=body, headers=headers)


def retrieved(service: ServiceProcess, contract: ContractDocuments, query: str, **kwargs: Any) -> dict[str, Any]:
    response = retrieve(service, query, **kwargs)
    assert response.status_code == 200, response.text
    body = response.json()
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")
    return body


def test_an_item_says_which_entity_version_and_source_it_came_from(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    body = retrieved(seeded_service, contract, "refund premium")

    assert body["items"], "the seeded facts mention 'refund'; a retrieval that finds none is not a retrieval"
    by_id = {item["entity_id"]: item for item in body["items"]}
    assert "fde:acme:policy:refund" in by_id
    item = by_id["fde:acme:policy:refund"]
    assert item["type"] == "Policy"
    assert item["content"].startswith("Premium customers may receive a refund")
    assert item["source_ref"] == "sharepoint://claims/policies/refund.md"
    assert item["version"] == "3"
    assert 0.0 < item["score"] <= 1.0
    assert item["trust"] == "untrusted", "C33: retrieved content is data, never instructions"
    assert item["classification"] == "internal", "the baseline classifies ic:Policy"

    assert RETRIEVAL_ID.match(body["retrieval_id"]), f"{body['retrieval_id']!r} is not a retrieval id"
    assert DIGEST.match(body["snapshot_digest"]), f"{body['snapshot_digest']!r} is not a digest"
    assert body["degraded"] is False
    assert "reason" not in body


def test_a_lexical_stage_counts_top_k_inside_the_declared_source(
    tmp_path_factory: pytest.TempPathFactory, contract: ContractDocuments
) -> None:
    """§6.2: the lexical stage searches the source the recipe names, not the tenant.

    Twenty-five claims from `claims-db` outrank (or tie with) one `sharepoint-claims`
    document, and the recipe's `topK` is 20. Counting the top-K before the source filter
    would leave the declared source with no candidates at all — an `empty` answer for a
    source that did match.
    """
    data = tmp_path_factory.mktemp("lexical-source")
    claims = tuple(
        entity(
            f"fde:acme:claim:C-{index:04d}",
            "Claim",
            "refund refund refund",
            source_ref=f"claims-db://public.claims/C-{index:04d}",
            version="1",
            term="ic:Claim",
            source="claims-db",
            source_kind="structured",
        )
        for index in range(25)
    )
    document = entity(
        "fde:acme:claimdocument:refund.md:premium-customers",
        "ClaimDocument",
        "Premium customers may receive a refund within 30 days.",
        source_ref="sharepoint://claims/policies/refund.md",
        version="3",
        term="ic:ClaimDocument",
        source="sharepoint-claims",
        source_kind="document",
    )
    seed_volume(
        data / "graph" / "graph.json",
        tenant_id="acme",
        entities=(*claims, document),
    )
    with ServiceProcess.start(data_dir=data) as process:
        body = retrieved(process, contract, "refund")

    assert document.entity_id in {item["entity_id"] for item in body["items"]}, (
        "the declared source's match must survive the other source's higher-ranked head"
    )


def test_the_response_carries_the_callers_trace(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    """C6: the retrieval is one call in one trace, like every other response."""
    headers = seeded_service.authorized(scopes=CLAIMS)
    trace_id = headers["traceparent"].split("-")[1]

    response = seeded_service.post(
        "/v1/context/retrieve",
        json={"recipe_id": "claims-context", "query": "refund"},
        headers=headers,
    )

    assert response.status_code == 200, response.text
    contract.require(response.json(), RETRIEVE_RESPONSE, "retrieve response")
    assert response.json()["trace_id"] == trace_id


def test_the_tokens_tenant_decides_what_comes_back(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    """C3: the filter is the identity's tenant, and another tenant's fact is invisible."""
    acme = retrieved(seeded_service, contract, "refund premium")
    assert all(item["entity_id"].startswith("fde:acme:") for item in acme["items"])

    beta = retrieved(seeded_service, contract, "refund premium", tenant_id="beta")
    assert [item["entity_id"] for item in beta["items"]] == ["fde:beta:policy:refund"]
    assert all(item["source_ref"].startswith("sharepoint://beta/") for item in beta["items"])


def test_a_query_that_matches_nothing_is_degraded_and_says_why(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    """An empty answer is a degradation the caller can see, not an empty list (§6.4)."""
    body = retrieved(seeded_service, contract, "quantum flux capacitor")

    assert body["items"] == []
    assert body["degraded"] is True
    assert body["reason"] == "empty"


def test_a_resolved_entity_pulls_in_its_neighbourhood_through_the_recipes_relations(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    """§6.2's `graph` stage: the walk starts at the resolved entity, not at every match.

    The claim is resolved deterministically (`filters.claim_id`), and the policy, the
    approval rule and the FAQ come back along `ic:hasPolicy` / `ic:documentsPolicy` — the
    relations the recipe declares. `budget_used.hops` reports how deep the walk went.
    """
    headers = seeded_service.authorized(scopes=CLAIMS)
    body = seeded_service.post(
        "/v1/context/retrieve",
        json={"recipe_id": "claims-context", "query": "claim C-1001", "filters": {"claim_id": "C-1001"}},
        headers=headers,
    ).json()
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")

    by_id = {item["entity_id"]: item for item in body["items"]}
    assert body["index"] == "graph", "the answer used the graph, so it must say so"
    assert {"fde:acme:claim:C-1001", "fde:acme:policy:refund", "fde:acme:policy:approval"} <= set(by_id)
    assert by_id["fde:acme:claim:C-1001"]["metadata"]["hop"] == 0
    assert by_id["fde:acme:policy:refund"]["metadata"]["hop"] == 1
    assert by_id["fde:acme:policy:approval"]["metadata"]["hop"] == 2
    assert body["budget_used"]["hops"] == 2

    scores = [item["score"] for item in body["items"]]
    assert scores == sorted(scores, reverse=True), "items are ranked, not whichever order the walk produced"


def test_the_budget_truncates_from_the_weakest_end(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    """A budget bounds the answer; it must not change which evidence is strongest."""
    full = retrieved(seeded_service, contract, "refund premium")
    limited = retrieved(seeded_service, contract, "refund premium", budget={"max_nodes": 2})

    assert len(limited["items"]) == 2
    assert limited["budget_used"]["nodes"] == 2
    assert [item["entity_id"] for item in limited["items"]] == [
        item["entity_id"] for item in full["items"][:2]
    ], "truncation must drop the weakest items, not reorder the rest"


def test_a_smaller_max_hops_stops_the_walk_sooner(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    headers = seeded_service.authorized(scopes=CLAIMS)
    body = seeded_service.post(
        "/v1/context/retrieve",
        json={
            "recipe_id": "claims-context",
            "query": "claim C-1001",
            "filters": {"claim_id": "C-1001"},
            "budget": {"max_hops": 1},
        },
        headers=headers,
    ).json()
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")

    assert body["budget_used"]["hops"] == 1
    assert "fde:acme:policy:approval" not in {item["entity_id"] for item in body["items"]}


def test_a_deeper_max_hops_than_the_recipe_or_v0_supports_is_capped_and_says_so(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    """The contract allows 4 hops; the recipe declares 2 and §4.3's backend walks 2."""
    headers = seeded_service.authorized(scopes=CLAIMS)
    body = seeded_service.post(
        "/v1/context/retrieve",
        json={
            "recipe_id": "claims-context",
            "query": "claim C-1001",
            "filters": {"claim_id": "C-1001"},
            "budget": {"max_hops": 4},
        },
        headers=headers,
    ).json()
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")

    assert body["budget_used"]["hops"] == 2
    assert "fde:acme:policy:approval" in {item["entity_id"] for item in body["items"]}


def test_an_item_too_large_for_the_budget_does_not_starve_the_smaller_ones(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    """One long document must not end the answer: the budget packs what fits, by rank."""
    body = retrieved(seeded_service, contract, "budgetprobe", budget={"max_tokens": 10})

    assert [item["entity_id"] for item in body["items"]] == ["fde:acme:document:budget-light"]
    assert body["degraded"] is False
    assert body["budget_used"]["tokens"] <= 10


def test_a_budget_too_small_for_any_item_is_partial_not_empty(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    """`empty` would claim the graph had no answer; it had one the budget excluded."""
    body = retrieved(seeded_service, contract, "refund premium", budget={"max_tokens": 1})

    assert body["items"] == []
    assert body["degraded"] is True
    assert body["reason"] == "partial"


# ---------------------------------------------------------------------------
# The embedded ceiling: degrade, do not slow down (§4.3)
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def over_ceiling_service(tmp_path_factory: pytest.TempPathFactory) -> Iterator[ServiceProcess]:
    """One node past the published ceiling, each with one word of content.

    The count comes from `app.limits` rather than a literal: a test that hardcoded
    10 001 would quietly stop testing the ceiling the day the ceiling moved.
    """
    data = tmp_path_factory.mktemp("over-ceiling")
    facts = (
        entity(
            f"fde:acme:policy:pad-{index}",
            "Policy",
            f"Padding policy {index}.",
            source_ref=f"sharepoint://claims/policies/pad-{index}.md",
            version="1",
            term="ic:Policy",
            source="sharepoint-claims",
        )
        for index in range(EMBEDDED_MAX_NODES + 1)
    )
    seed_volume(data / "graph" / "graph.json", tenant_id="acme", entities=facts)
    with ServiceProcess.start(data_dir=data) as process:
        yield process


def test_a_graph_over_the_ceiling_degrades_instead_of_slowing(
    over_ceiling_service: ServiceProcess, contract: ContractDocuments
) -> None:
    """§4.3: 10k/50k is the interactive ceiling, and crossing it is visible to the caller."""
    body = retrieved(over_ceiling_service, contract, "padding policy 7")

    assert body["degraded"] is True
    assert body["reason"] == "scale_limit"
    assert body["index"] == "lexical", "past the ceiling the graph walk is skipped, not silently attempted"
    assert body["budget_used"]["hops"] == 0


def test_readyz_reports_the_ceiling_before_a_caller_meets_it(over_ceiling_service: ServiceProcess) -> None:
    """`/readyz` is serviceability: degraded with a reason, 200 because it can still serve (§9.2)."""
    response = over_ceiling_service.get("/readyz")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "degraded"
    assert any("scale_limit" in reason for reason in body["reasons"]), body["reasons"]


def test_the_same_retrieval_twice_is_one_digest_and_two_snapshots(
    seeded_service: ServiceProcess, contract: ContractDocuments
) -> None:
    """§4.1: the snapshot is content-addressed, so an auditor can prove what was served.

    Two identical calls are two snapshots — each has its own `retrieval_id`, because each
    was a distinct retrieval a Decision may cite — but they must carry the same
    `snapshot_digest`, or "the same question got the same answer" would be unprovable.
    """
    first = retrieved(seeded_service, contract, "refund premium")
    second = retrieved(seeded_service, contract, "refund premium")

    assert first["retrieval_id"] != second["retrieval_id"]
    assert first["snapshot_digest"] == second["snapshot_digest"]
    assert [item["entity_id"] for item in first["items"]] == [item["entity_id"] for item in second["items"]]
