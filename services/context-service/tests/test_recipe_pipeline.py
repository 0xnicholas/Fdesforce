"""The Recipe pipeline, stage by stage, over the served surface (`docs/semantic-modeling.md` §6).

Every assertion here is about what the *package* declares, not about a retrieval strategy
this service invented: the recipe weights, the relation list, the class scopes and the
budget come from the Acme package (`examples/semantic/acme`), and the expected numbers are
computed from those declarations — `structured: 0.5` for an exact fact, `0.3 × 0.5^hop`
for a walk, `0.2 × score` for a lexical match. That is what makes the test able to
disagree with the code: the arithmetic is the recipe's, written down here by hand.

The fixture is a graph volume as ingest would write it — `term` and `source` attributes,
`ic:*` predicates, mapped `properties` — because the stages read exactly those. The ledger
says the package was materialized, so a test about ranking is not also a test about ingest.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from typing import Any

import pytest
import yaml

from app.ingest_ledger import PackageRef
from conformance.documents import ContractDocuments
from conformance.graph_fixture import entity, relationship, seed_volume
from conformance.harness import REFERENCE_PACKAGE, REFERENCE_PACKAGE_DIGEST, REFERENCE_PACKAGE_NAME, ServiceProcess

RETRIEVE_RESPONSE = "retrieval.schema.json#/$defs/RetrieveResponse"

#: The business scopes the Acme baseline gates classes with (`permissions.yaml`).
CLAIMS = ("context:retrieve", "claims:read", "claims:documents:read", "customer:pii:read")

#: A claim, the policy that governs it, the customer behind that policy, and one document
#: chunk. The customer is *two* hops away on purpose: nothing connects it to the claim
#: directly, so its score can only come from the walk.
CLAIM = entity(
    "fde:acme:claim:C-1001",
    "Claim",
    "Claim C-1001: amount 12000, status review",
    source_ref="claims-db://public.claims/C-1001",
    version="2026-01-02T10:00:00Z",
    term="ic:Claim",
    source="claims-db",
    source_kind="structured",
    freshness="fresh",
    properties={"ic:claimId": "C-1001", "ic:status": "review", "ic:amount": 12000},
)
POLICY = entity(
    "fde:acme:policy:P-2001",
    "Policy",
    "Policy P-2001: status active",
    source_ref="claims-db://public.policies/P-2001",
    version="2025-11-30T12:00:00Z",
    term="ic:Policy",
    source="claims-db",
    source_kind="structured",
    freshness="stale",
    properties={"ic:policyNumber": "P-2001", "ic:status": "active"},
)
CUSTOMER = entity(
    "fde:acme:customer:CU-42",
    "Customer",
    "Customer CU-42: email ada.byron@example.com, name Ada Byron",
    source_ref="claims-db://public.customers/CU-42",
    version="2025-10-01T08:00:00Z",
    term="ic:Customer",
    source="claims-db",
    source_kind="structured",
    freshness="stale",
    properties={"ic:customerName": "Ada Byron", "ic:customerEmail": "ada.byron@example.com"},
)
DOCUMENT = entity(
    "fde:acme:claimdocument:refund.md:premium-customers",
    "ClaimDocument",
    "Premium customers\nPremium customers may receive a refund within 30 days.",
    source_ref="sharepoint://claims/policies/refund.md",
    version="e-7781",
    term="ic:ClaimDocument",
    source="sharepoint-claims",
    source_kind="document",
    freshness="fresh",
)

#: A document chunk two hops out (claim → policy → `ic:documentsPolicy`), and from a
#: *different* source than the claim's, so it can only arrive through the graph stage.
GOVERNED = entity(
    "fde:acme:claimdocument:approval.md:large-refunds",
    "ClaimDocument",
    "Large refunds\nRefund requests over 100000 require manual approval.",
    source_ref="sharepoint://claims/policies/approval.md",
    version="e-7804",
    term="ic:ClaimDocument",
    source="sharepoint-claims",
    source_kind="document",
    freshness="stale",
)

#: `ic:referencedBy` is a relation the ACME recipe does not declare, so the walk must not
#: follow it — the whole point of `relations` in the graph stage.
OFF_RECIPE = entity(
    "fde:acme:filing:F-9",
    "Filing",
    "Filing F-9: an unrelated regulatory filing.",
    source_ref="claims-db://public.filings/F-9",
    version="2025-09-09T00:00:00Z",
    term="ic:Filing",
    source="claims-db",
)

ENTITIES = (CLAIM, POLICY, CUSTOMER, DOCUMENT, GOVERNED, OFF_RECIPE)
RELATIONSHIPS = (
    relationship(CLAIM.entity_id, POLICY.entity_id, "ic:hasPolicy", weight=1.0),
    relationship(POLICY.entity_id, CUSTOMER.entity_id, "ic:forCustomer", weight=1.0),
    relationship(POLICY.entity_id, GOVERNED.entity_id, "ic:documentsPolicy", weight=1.0),
    relationship(POLICY.entity_id, "fde:acme:filing:F-9", "ic:referencedBy", weight=1.0),
)


@pytest.fixture(scope="module")
def pipeline(tmp_path_factory: pytest.TempPathFactory) -> Iterator[ServiceProcess]:
    data = tmp_path_factory.mktemp("pipeline")
    seed_volume(
        data / "graph" / "graph.json",
        tenant_id="acme",
        entities=ENTITIES,
        relationships=RELATIONSHIPS,
    )
    with ServiceProcess.start(data_dir=data) as process:
        yield process


def retrieve(
    service: ServiceProcess,
    *,
    query: str = "refund for premium customers",
    recipe_id: str = "claims-context",
    filters: dict[str, Any] | None = None,
    budget: dict[str, int] | None = None,
    scopes: tuple[str, ...] = CLAIMS,
) -> dict[str, Any]:
    body: dict[str, Any] = {"recipe_id": recipe_id, "query": query}
    if filters is not None:
        body["filters"] = filters
    if budget is not None:
        body["budget"] = budget
    response = service.post("/v1/context/retrieve", json=body, headers=service.authorized(scopes=scopes))
    assert response.status_code == 200, response.text
    return response.json()


def by_id(body: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {item["entity_id"]: item for item in body["items"]}


def test_the_recipes_weights_rank_exact_facts_above_the_walk_and_the_walk_above_lexical(
    pipeline: ServiceProcess, contract: ContractDocuments
) -> None:
    """§6.3's priority, as arithmetic: `structured` 0.5, `graph` 0.3, `lexical` 0.2.

    The recipe's `structured` stage names `claims-db` and four classes, so the claim and
    the policy — the resolved object and one hop of its source's own joins — score
    `0.5 × 1.0`; the claim adds the recipe's `0.1` freshness boost because ingest recorded
    it fresh, and the policy does not because it was recorded stale.

    The customer is two hops out at `0.3 × 0.5²` and the approval document likewise, both
    from the *walk*: neither is a one-hop fact of `claims-db`, so nothing but the graph
    stage can produce them. The refund document is lexical, so it is scaled by `0.2` and
    stays below every structured fact.
    """
    body = retrieve(pipeline, filters={"claim_id": "C-1001"})
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")

    items = by_id(body)
    assert items[CLAIM.entity_id]["score"] == 0.6, "0.5 structured + 0.1 fresh"
    assert items[POLICY.entity_id]["score"] == 0.5, "a one-hop fact of the declared source"
    assert items[CUSTOMER.entity_id]["score"] == 0.075, "0.3 graph × 0.5², nothing links it to the claim"
    assert items[GOVERNED.entity_id]["score"] == 0.075
    assert items[DOCUMENT.entity_id]["score"] <= 0.3, "0.2 lexical weight + at most 0.1 fresh"
    assert {entity_id: item["metadata"]["stage"] for entity_id, item in items.items()} == {
        CLAIM.entity_id: "structured",
        POLICY.entity_id: "structured",
        CUSTOMER.entity_id: "graph",
        GOVERNED.entity_id: "graph",
        DOCUMENT.entity_id: "lexical",
    }
    assert items[CUSTOMER.entity_id]["metadata"]["hop"] == 2
    assert items[POLICY.entity_id]["metadata"]["hop"] == 1
    assert body["budget_used"]["hops"] == 2


def test_a_class_the_structured_stage_does_not_name_is_not_an_exact_fact(
    pipeline: ServiceProcess, contract: ContractDocuments
) -> None:
    """The stage's `entities` list is what a source is trusted for, not everything it holds.

    `ic:ClaimDocument` is not in the recipe's `structured` list, so a document one hop
    away is not a structured fact — it can only be reached by the walk or the index.
    """
    body = retrieve(pipeline, filters={"claim_id": "C-1001"})
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")

    documents = [item for item in body["items"] if item["type"] == "ClaimDocument"]

    assert documents, "the fixture's documents are reachable; a retrieval that drops them proves nothing"
    assert {item["metadata"]["stage"] for item in documents} <= {"graph", "lexical"}


def test_a_duplicate_is_merged_into_the_survivor_with_its_provenance_intact(
    tmp_path_factory: pytest.TempPathFactory, contract: ContractDocuments
) -> None:
    """§6.3: `merge` dedupes on a content hash and *merges provenance*, never drops a citation.

    Two entities with the same text but different sources are two citations of one fact.
    Deduping on the hash keeps one item — and the other's `entity_id`, `source_ref` and
    `version` travel with it, so an auditor can still reach both.
    """
    data = tmp_path_factory.mktemp("duplicate-content")
    shared = "Premium customers may receive a refund within 30 days."
    duplicate = entity(
        "fde:acme:policy:refund-mirror",
        "Policy",
        shared,
        source_ref="sharepoint://claims/policies/refund-mirror.md",
        version="4",
        term="ic:Policy",
        source="sharepoint-claims",
    )
    seed_volume(
        data / "graph" / "graph.json",
        tenant_id="acme",
        entities=(entity(
            "fde:acme:policy:refund",
            "Policy",
            shared,
            source_ref="sharepoint://claims/policies/refund.md",
            version="3",
            term="ic:Policy",
            source="sharepoint-claims",
        ), duplicate),
    )
    with ServiceProcess.start(data_dir=data) as process:
        body = process.post(
            "/v1/context/retrieve",
            json={"recipe_id": "claims-context", "query": "refund premium customers"},
            headers=process.authorized(scopes=CLAIMS),
        ).json()
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")

    assert len(body["items"]) == 1, "the content hash is the dedupe key the recipe declares"
    survivor = body["items"][0]
    merged = survivor["metadata"]["merged"]
    assert [entry["entity_id"] for entry in merged] == [duplicate.entity_id]
    assert merged[0]["source_ref"] == duplicate.source_ref
    assert merged[0]["version"] == duplicate.version


def test_a_query_with_no_deterministic_key_still_resolves_by_matching_the_class(
    pipeline: ServiceProcess, contract: ContractDocuments
) -> None:
    """§6.3's fallback: "解析不到 → 进入图/词法实体匹配".

    No `filters`, and the query spells the claim's key — so `resolve` matches the query
    against entities of the class the recipe resolves, and the walk still starts from a
    resolved object rather than from an arbitrary lexical hit.
    """
    body = retrieve(pipeline, query="status of C-1001")
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")

    items = by_id(body)
    assert CLAIM.entity_id in items, "the claim was resolved from the query, not from a filter"
    assert items[CLAIM.entity_id]["metadata"]["stage"] == "structured"
    assert items[POLICY.entity_id]["metadata"]["stage"] == "structured", "the walk started at the claim"


def test_the_graph_stage_follows_only_the_relations_the_recipe_declares(pipeline: ServiceProcess) -> None:
    """`ic:referencedBy` is in the graph and not in the recipe: no walk may reach it."""
    body = retrieve(pipeline, filters={"claim_id": "C-1001"})

    assert "fde:acme:filing:F-9" not in by_id(body)


def test_a_class_the_caller_holds_no_scope_for_is_withheld_and_recorded(
    pipeline: ServiceProcess, contract: ContractDocuments
) -> None:
    """§7: `ic:Claim` names `claims:read`, so a caller without it is served the rest only.

    The denial is part of the evidence: a Decision that cites this snapshot can say which
    class was withheld instead of silently receiving less context.
    """
    body = retrieve(
        pipeline,
        filters={"claim_id": "C-1001"},
        scopes=("context:retrieve", "claims:documents:read", "customer:pii:read"),
    )
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")

    assert CLAIM.entity_id not in by_id(body)
    assert POLICY.entity_id in by_id(body), "an unscoped class is still served"
    denials = body["policy_evaluations"]
    assert [denial["policy_id"] for denial in denials] == ["permissions.yaml#ic:Claim"]
    assert denials[0]["outcome"] == "deny"
    assert denials[0]["enforcement_point"] == "context.retrieve"
    assert denials[0]["evaluated_by"] == "context-service"


def test_a_masked_property_is_replaced_before_the_content_is_rendered(pipeline: ServiceProcess) -> None:
    """The baseline says `ic:customerEmail` is `hash`: masking the field only would mask nothing."""
    body = retrieve(pipeline, filters={"claim_id": "C-1001"})
    customer = by_id(body)[CUSTOMER.entity_id]

    assert "ada.byron@example.com" not in customer["content"]
    assert customer["content"].startswith("Customer CU-42: ic:customerEmail sha256:")
    assert customer["content"].find("ic:customerName [redacted]") > 0
    assert customer["classification"] == "restricted"
    assert customer["metadata"]["masked"] == ["ic:customerEmail", "ic:customerName"]


def test_the_item_carries_a_classification_even_when_the_baseline_does_not_classify_it(
    pipeline: ServiceProcess,
) -> None:
    """§7.1's fixed default: an unclassified class is `restricted`, never absent."""
    body = retrieve(pipeline, filters={"claim_id": "C-1001"})

    for item in body["items"]:
        assert item["classification"] in {"public", "internal", "confidential", "restricted"}
        assert item["trust"] == "untrusted"


def test_a_recipe_the_package_never_declared_is_a_404(pipeline: ServiceProcess) -> None:
    """§6.1: the model selects a recipe; it never writes one."""
    response = pipeline.post(
        "/v1/context/retrieve",
        json={"recipe_id": "claims-context-deep", "query": "refund"},
        headers=pipeline.authorized(scopes=CLAIMS),
    )

    assert response.status_code == 404
    error = response.json()["error"]
    assert error["code"] == "not_found"
    assert error["details"]["reason"] == "recipe_not_found"
    assert "claims-context" in error["message"], "the refusal lists the recipes that do exist"


def test_the_recipe_budget_is_a_ceiling_the_caller_cannot_raise(pipeline: ServiceProcess) -> None:
    """§6.1: a caller may ask for less, never for more than the recipe allows."""
    body = retrieve(pipeline, budget={"max_nodes": 1000, "max_tokens": 100000})

    assert body["budget_used"]["nodes"] <= 50
    assert body["budget_used"]["tokens"] <= 4000


def test_the_recipes_budget_is_the_ceiling_and_the_default_for_a_caller_that_names_none(
    tmp_path_factory: pytest.TempPathFactory, contract: ContractDocuments
) -> None:
    """A recipe may declare more than the service's old defaults; a caller who names no
    budget gets the *recipe's* number, and a caller who names a bigger one is capped by it.

    Asserted against a package whose recipe says 200, because a ceiling that only ever
    equals the default cannot show whether the default or the recipe won.
    """
    package = tmp_path_factory.mktemp("generous") / "package"
    shutil.copytree(REFERENCE_PACKAGE, package)
    recipe_path = package / "recipes" / "claims-context.yaml"
    recipe = yaml.safe_load(recipe_path.read_text(encoding="utf-8"))
    budget = next(stage for stage in recipe["spec"]["stages"] if stage["type"] == "budget")
    budget.update({"maxNodes": 200, "maxTokens": 100000})
    lexical = next(stage for stage in recipe["spec"]["stages"] if stage["type"] == "lexical")
    lexical["topK"] = 200
    recipe_path.write_text(yaml.safe_dump(recipe, sort_keys=False), encoding="utf-8")

    data = tmp_path_factory.mktemp("generous-graph")
    policies = tuple(
        entity(
            f"fde:acme:policy:refund-{index}",
            "Policy",
            f"Refund policy {index}: premium customers may receive a refund.",
            source_ref=f"sharepoint://claims/policies/refund-{index}.md",
            version="1",
            term="ic:Policy",
            source="sharepoint-claims",
            source_kind="document",
        )
        for index in range(60)
    )
    seed_volume(
        data / "graph" / "graph.json",
        tenant_id="acme",
        entities=policies,
        package=_reference_ref(),
    )
    with ServiceProcess.start(data_dir=data, context_package=package) as process:
        body = retrieve(process, query="refund policy premium")
        capped = retrieve(process, query="refund policy premium", budget={"max_nodes": 5})
    contract.require(body, RETRIEVE_RESPONSE, "retrieve response")

    assert body["budget_used"]["nodes"] == 60, "the recipe's 200 is the ceiling, not the service's 50"
    assert capped["budget_used"]["nodes"] == 5, "a caller may ask for less"


def _reference_ref() -> PackageRef:
    """The ledger's package ref: the reference revision, which a mutated copy keeps."""
    return PackageRef(name=REFERENCE_PACKAGE_NAME, version="1.0.0", digest=REFERENCE_PACKAGE_DIGEST)


def test_a_query_with_no_match_is_empty_but_an_unmaterialized_package_is_partial(
    pipeline: ServiceProcess, tmp_path_factory: pytest.TempPathFactory
) -> None:
    """§6.4 vs §9.2: "nothing matched" and "the graph is not complete" are different answers."""
    empty = retrieve(pipeline, query="quantum flux capacitor")
    assert empty["items"] == []
    assert empty["reason"] == "empty"

    data = tmp_path_factory.mktemp("not-ingested")
    seed_volume(
        data / "graph" / "graph.json",
        tenant_id="acme",
        entities=(CLAIM,),
        ingested=False,
    )
    with ServiceProcess.start(data_dir=data) as process:
        partial = retrieve(process, query="quantum flux capacitor")

    assert partial["items"] == []
    assert partial["degraded"] is True
    assert partial["reason"] == "partial", "an unmaterialized package cannot answer `empty` and mean it"
