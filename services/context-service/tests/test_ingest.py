"""The ingest job's rules, at the seam it has: the Connector port and the graph volume.

`tests/test_ingest_job.py` drives the job over HTTP; these tests drive it against a
*mutable* source, because three of its rules can only be observed by changing what a
source asserts between runs:

- `incremental` resumes from the last run's watermark, and a source that has not changed
  contributes nothing (rather than re-reading everything and calling it a day);
- `rebuild` removes what the source no longer asserts — an entity dropped upstream must
  not keep being cited;
- a relation whose target nobody produced is dropped and counted, and a source that
  cannot be read is one source's failure rather than the job's.

The package is the real Acme one, and the connector is a fake that speaks the port, so
the test proves the job's logic rather than a second copy of the seed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import pytest

from app.connectors import ConnectorRegistry
from app.connectors.port import OperationNotFound, Page, Record
from app.context_package import ContextPackage
from app.graph import snapshot
from app.graph.embedded import EmbeddedGraphStore
from app.ingest import IngestRequest, run
from app.ingest_ledger import IngestLedgerStore, PackageRef
from conformance.harness import REFERENCE_PACKAGE

TENANT = "acme"


class MutableConnector:
    """A source whose rows a test can change between runs — the `claims-db` port shape."""

    id = "claims-db"
    operations = ("lookupClaim",)

    def __init__(self, rows: Mapping[str, Sequence[Mapping[str, Any]]]) -> None:
        self.rows = {dataset: [dict(row) for row in entries] for dataset, entries in rows.items()}

    @property
    def datasets(self) -> Sequence[str]:
        return tuple(sorted(self.rows))

    def read(self, dataset: str, *, since: str | None = None) -> Page:
        records = [
            Record(
                dataset=dataset,
                key=str(row["key"]),
                values={key: value for key, value in row.items() if key not in ("key", "updated_at")},
                updated_at=row.get("updated_at"),
            )
            for row in self.rows[dataset]
        ]
        if since is None:
            return Page(records=tuple(records), watermark=_watermark(records))
        newer = tuple(record for record in records if record.updated_at and record.updated_at > since)
        return Page(records=newer, watermark=_watermark(records) if newer else since)

    def invoke(self, operation: str, arguments: Mapping[str, Any]) -> Any:
        raise OperationNotFound(operation)


def claim_row(key: str, *, updated_at: str, policy: str | None = "P-2001") -> dict[str, Any]:
    return {
        "key": key,
        "updated_at": updated_at,
        "claim_id": key,
        "policy_number": policy,
        "coverage_id": "COV-1",
        "customer_id": "CU-42",
        "status": "review",
        "amount": 100,
        "ic:hasPolicy": [policy] if policy else [],
    }


def default_rows() -> dict[str, list[dict[str, Any]]]:
    """The five datasets the Acme mappings declare, with one row each where it matters."""
    return {
        "public.claims": [claim_row("C-1001", updated_at="2026-01-02T10:00:00Z")],
        "public.policies": [
            {
                "key": "P-2001",
                "updated_at": "2025-11-30T12:00:00Z",
                "policy_number": "P-2001",
                "status": "active",
            }
        ],
        "public.coverages": [
            {
                "key": "COV-1",
                "updated_at": "2025-11-30T12:00:00Z",
                "coverage_id": "COV-1",
                "coverage_type": "contents",
                "coverage_limit": 1000,
            }
        ],
        "public.customers": [
            {
                "key": "CU-42",
                "updated_at": "2025-10-01T08:00:00Z",
                "customer_id": "CU-42",
                "name": "Ada Byron",
                "email": "ada.byron@example.com",
            }
        ],
        "public.fraud_flags": [],
    }


def _watermark(records: Sequence[Record]) -> str | None:
    stamps = [record.updated_at for record in records if record.updated_at]
    return max(stamps) if stamps else None


@pytest.fixture
def package() -> ContextPackage:
    return ContextPackage.load(REFERENCE_PACKAGE)


@pytest.fixture
def graph(tmp_path: Path) -> EmbeddedGraphStore:
    path = tmp_path / "graph" / "graph.json"
    snapshot.establish(path)
    store = EmbeddedGraphStore(path).open()
    yield store
    store.close()


@pytest.fixture
def ledger(tmp_path: Path) -> IngestLedgerStore:
    return IngestLedgerStore.for_graph(tmp_path / "graph" / "graph.json")


def request(
    package: ContextPackage, *, mode: str = "incremental", sources: tuple[str, ...] | None = None
) -> IngestRequest:
    revision = package.revision(package.version)
    assert revision is not None
    return IngestRequest(
        package=PackageRef(name=package.name, version=package.version, digest=revision.digest),
        mode=mode,
        sources=sources,
    )


def test_a_rebuild_removes_what_the_source_no_longer_asserts(
    package: ContextPackage, graph: EmbeddedGraphStore, ledger: IngestLedgerStore
) -> None:
    """An entity the source dropped must stop being citable: upsert-only would keep it forever."""
    connector = MutableConnector(default_rows())
    registry = ConnectorRegistry([connector])

    first = run(
        package,
        registry,
        graph,
        ledger,
        tenant_id=TENANT,
        request=request(package, mode="rebuild", sources=("claims-db",)),
    )
    claim = "fde:acme:claim:C-1001"
    assert first.status == "succeeded", first.message
    assert graph.get_entity(TENANT, claim) is not None

    connector.rows["public.claims"] = []
    second = run(
        package,
        registry,
        graph,
        ledger,
        tenant_id=TENANT,
        request=request(package, mode="rebuild", sources=("claims-db",)),
    )

    assert second.status == "succeeded", second.message
    assert graph.get_entity(TENANT, claim) is None, "a rebuild that only upserts is not a rebuild"


def test_an_incremental_run_resumes_from_the_last_watermark(
    package: ContextPackage, graph: EmbeddedGraphStore, ledger: IngestLedgerStore
) -> None:
    connector = MutableConnector(default_rows())
    registry = ConnectorRegistry([connector])
    sources = ("claims-db",)

    first = run(package, registry, graph, ledger, tenant_id=TENANT, request=request(package, sources=sources))
    assert first.sources[0].entities == 4, first.sources[0]

    unchanged = run(package, registry, graph, ledger, tenant_id=TENANT, request=request(package, sources=sources))
    assert unchanged.sources[0].entities == 0, "nothing changed upstream, so nothing is re-read"
    assert unchanged.sources[0].watermark == first.sources[0].watermark

    connector.rows["public.claims"].append(claim_row("C-1002", updated_at="2026-02-01T00:00:00Z", policy=None))
    resumed = run(package, registry, graph, ledger, tenant_id=TENANT, request=request(package, sources=sources))

    assert resumed.sources[0].entities == 1
    assert resumed.sources[0].watermark == "2026-02-01T00:00:00Z"
    assert graph.get_entity(TENANT, "fde:acme:claim:C-1002") is not None


def test_a_relation_to_something_the_package_does_not_produce_is_dropped_and_counted(
    package: ContextPackage, graph: EmbeddedGraphStore, ledger: IngestLedgerStore
) -> None:
    """`ic:hasPolicy` → a policy nobody wrote: the edge goes, the source says so."""
    rows = default_rows()
    rows["public.claims"] = [claim_row("C-1001", updated_at="2026-01-02T10:00:00Z", policy="P-9999")]
    registry = ConnectorRegistry([MutableConnector(rows)])

    result = run(
        package, registry, graph, ledger, tenant_id=TENANT, request=request(package, sources=("claims-db",))
    )

    assert result.status == "degraded"
    assert result.sources[0].edges == 0
    assert "point at entities the package does not produce" in (result.sources[0].reason or "")


def test_a_source_with_no_connector_fails_alone(
    package: ContextPackage, graph: EmbeddedGraphStore, ledger: IngestLedgerStore
) -> None:
    """A deployment that forgot a Connector must still materialize what it can (§6.3)."""
    registry = ConnectorRegistry([])

    result = run(package, registry, graph, ledger, tenant_id=TENANT, request=request(package))

    assert result.status == "failed"
    assert {source.status for source in result.sources} == {"failed"}
    assert "no Connector is registered" in (result.sources[0].reason or "")
    state = ledger.load()
    assert state is not None and not state.complete
    assert any("no Connector is registered" in reason for reason in state.reasons)


def test_the_ledger_carries_every_source_this_run_did_not_cover(
    package: ContextPackage, graph: EmbeddedGraphStore, ledger: IngestLedgerStore
) -> None:
    """A partial run must not erase the other source's watermark: the next one resumes from it."""
    registry = ConnectorRegistry([MutableConnector(default_rows())])

    run(package, registry, graph, ledger, tenant_id=TENANT, request=request(package, sources=("claims-db",)))
    after = ledger.load()

    assert after is not None
    assert [source.source for source in after.sources] == ["claims-db"]
    carried = run(
        package,
        ConnectorRegistry([]),
        graph,
        ledger,
        tenant_id=TENANT,
        request=request(package, sources=("sharepoint-claims",)),
    )
    state = ledger.load()

    assert carried.status == "failed"
    assert state is not None
    assert sorted(source.source for source in state.sources) == ["claims-db", "sharepoint-claims"]
    assert state.watermark_of("claims-db") == "2026-01-02T10:00:00Z"


def test_the_ingest_entity_is_what_the_retrieval_needs_to_cite_it(
    package: ContextPackage, graph: EmbeddedGraphStore, ledger: IngestLedgerStore
) -> None:
    """The mapping's fields, the citation, the class — one entity as the port sees it."""
    registry = ConnectorRegistry([MutableConnector(default_rows())])
    run(package, registry, graph, ledger, tenant_id=TENANT, request=request(package, sources=("claims-db",)))

    entity = graph.get_entity(TENANT, "fde:acme:claim:C-1001")

    assert entity is not None
    assert (entity.type, entity.version) == ("Claim", "2026-01-02T10:00:00Z")
    assert entity.source_ref == "claims-db://public.claims/C-1001"
    assert entity.content == "Claim C-1001: ic:amount 100, ic:claimId C-1001, ic:policyNumber P-2001, ic:status review"
    assert entity.attributes["term"] == "ic:Claim"
    assert entity.attributes["source"] == "claims-db"
    assert entity.attributes["source_kind"] == "structured"
    assert entity.attributes["properties"]["ic:claimId"] == "C-1001"


def test_an_entity_is_attributable_or_it_is_not_ingested(
    package: ContextPackage, graph: EmbeddedGraphStore, ledger: IngestLedgerStore
) -> None:
    """A row with no watermark column cannot be cited, so it is counted instead of guessed at."""
    rows = default_rows()
    rows["public.claims"].append({"key": "C-1003", "claim_id": "C-1003", "ic:hasPolicy": []})
    registry = ConnectorRegistry([MutableConnector(rows)])

    result = run(
        package, registry, graph, ledger, tenant_id=TENANT, request=request(package, sources=("claims-db",))
    )

    assert result.status == "degraded"
    assert "cannot be cited" in (result.sources[0].reason or "")
    assert graph.get_entity(TENANT, "fde:acme:claim:C-1003") is None
