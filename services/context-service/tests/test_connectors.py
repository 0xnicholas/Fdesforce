"""The reference Connectors: `claims-db`'s typed operations and the document source.

Both are *synthetic* Context Sources — a stand-in for a customer system, so the
platform can be deployed, ingested and retrieved against before a real Connector
exists (`docs/semantic-modeling.md` §5.1). What they prove is the seam, not the
dataset:

- `read()` is the ingest half. `since` is the source's watermark, so an
  `incremental` run resumes where the last one stopped instead of re-reading
  everything (`IngestSourceResult.watermark` is what it returns);
- `invoke()` is the Tool half: the typed operation `claims-lookup` pins an input
  and an output schema for, and the only way a Tool reaches a customer data source
  (`docs/runtime-adapter.md` D6).

The seed data is the contract's own example (`docs/runtime-contract.md` §3.3) and
the Acme golden questions (`examples/semantic/acme/evals`), so a retrieval test can
assert the facts the package was written against instead of inventing its own.
"""

from __future__ import annotations

import pytest

from app.connectors.claims_db import ClaimsDbConnector
from app.connectors.documents import DocumentConnector
from app.connectors.port import (
    ConnectorUnavailable,
    InvalidArguments,
    OperationNotFound,
    RecordNotFound,
)


@pytest.fixture(scope="module")
def claims() -> ClaimsDbConnector:
    return ClaimsDbConnector.from_seed()


@pytest.fixture(scope="module")
def documents() -> DocumentConnector:
    return DocumentConnector.from_seed()


def test_the_reference_source_serves_every_dataset_the_package_maps(claims: ClaimsDbConnector) -> None:
    assert sorted(claims.datasets) == [
        "public.claims",
        "public.coverages",
        "public.customers",
        "public.fraud_flags",
        "public.policies",
    ]
    page = claims.read("public.claims")
    assert [record.key for record in page.records] == ["C-1001", "C-1002"]


def test_an_incremental_read_resumes_from_the_watermark(claims: ClaimsDbConnector) -> None:
    full = claims.read("public.claims")

    resumed = claims.read("public.claims", since="2026-01-03T00:00:00Z")

    assert [record.key for record in resumed.records] == ["C-1002"]
    assert resumed.watermark == "2026-01-04T09:30:00Z"
    assert max(record.updated_at or "" for record in full.records) == full.watermark


def test_a_record_carries_the_columns_its_mapping_promises(claims: ClaimsDbConnector) -> None:
    claim = claims.read("public.claims").records[0]

    assert claim.values["policy_number"] == "P-2001"
    assert claim.values["coverage_id"] == "COV-1"
    assert claim.values["customer_id"] == "CU-42"
    assert claim.values["ic:hasPolicy"] == ["P-2001"]
    assert claim.values["ic:hasFraudFlag"] == ["FF-7"]
    assert claim.updated_at == "2026-01-02T10:00:00Z"


def test_lookup_claim_returns_what_the_tool_pinned(claims: ClaimsDbConnector) -> None:
    result = claims.invoke("lookupClaim", {"claimId": "C-1001"})

    assert result.result == {
        "claimId": "C-1001",
        "policyNumber": "P-2001",
        "customerId": "CU-42",
        "amount": 12000,
        "status": "review",
    }
    assert result.classification == "confidential"


def test_an_operation_the_connector_does_not_declare_is_refused(claims: ClaimsDbConnector) -> None:
    with pytest.raises(OperationNotFound) as caught:
        claims.invoke("dropTable", {})

    assert "lookupClaim" in str(caught.value)


def test_an_identifer_no_record_carries_is_not_found(claims: ClaimsDbConnector) -> None:
    with pytest.raises(RecordNotFound) as caught:
        claims.invoke("lookupClaim", {"claimId": "C-9999"})

    assert "C-9999" in str(caught.value)


def test_an_operation_argument_that_is_missing_is_refused(claims: ClaimsDbConnector) -> None:
    with pytest.raises(InvalidArguments) as caught:
        claims.invoke("lookupClaim", {"claimID": "C-1001"})

    assert "claimId" in str(caught.value)


def test_an_unreadable_seed_is_unavailable_not_empty(tmp_path) -> None:
    with pytest.raises(ConnectorUnavailable):
        ClaimsDbConnector.from_path(tmp_path / "no-such-seed.json")


def test_the_document_source_chunks_by_heading(documents: DocumentConnector) -> None:
    page = documents.read("sites/claims")

    paths = {chunk.values["path"] for chunk in page.records}
    assert paths == {"claims/policies/refund.md", "claims/policies/approval.md"}
    refund = [chunk for chunk in page.records if chunk.values["path"] == "claims/policies/refund.md"]
    assert [chunk.values["heading"] for chunk in refund] == ["Refund policy", "Premium customers"]
    assert refund[0].values["etag"] == "e-7781"
    assert "within 30 days" in refund[1].values["text"]
    assert page.watermark == "2026-01-05T08:00:00Z"
