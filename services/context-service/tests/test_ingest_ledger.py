"""The ingest ledger, and the one answer `/readyz` and `retrieve` share (§9.2).

The ledger is what makes "ingest does not block readiness" survivable: without it, a
restart cannot tell a materialized graph from an empty one, and every deploy would report
`partial` forever. So these tests are about the four states an operator reads, and about
the refusal a ledger this build cannot read must produce — "not started" and "written by a
newer build" look identical to a caller and mean opposite things.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.context_package import ContextPackage
from app.ingest_ledger import (
    LEDGER_KIND,
    IngestLedger,
    IngestLedgerError,
    IngestLedgerStore,
    IngestStatus,
    PackageRef,
    SourceState,
)
from conformance.harness import REFERENCE_PACKAGE, REFERENCE_PACKAGE_DIGEST

REF = PackageRef(name="acme-claims-context", version="1.0.0", digest=REFERENCE_PACKAGE_DIGEST)


@pytest.fixture
def store(tmp_path: Path) -> IngestLedgerStore:
    return IngestLedgerStore(tmp_path / "graph" / "ingest.json")


@pytest.fixture
def package() -> ContextPackage:
    return ContextPackage.load(REFERENCE_PACKAGE)


def completed(**overrides) -> IngestLedger:
    fields = {
        "package": REF,
        "status": "succeeded",
        "completed_at": "2026-01-06T00:00:00Z",
        "job_id": "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "sources": (
            SourceState(source="claims-db", status="ok", entities=9, edges=9, watermark="2026-01-04T09:30:00Z"),
            SourceState(source="sharepoint-claims", status="ok", entities=4, watermark="2026-01-05T08:00:00Z"),
        ),
    }
    fields.update(overrides)
    return IngestLedger(**fields)  # type: ignore[arg-type]


def test_the_ledger_round_trips_through_the_volume(store: IngestLedgerStore) -> None:
    store.record(completed())

    state = store.load()

    assert state is not None
    assert state.package == REF
    assert state.complete is True
    assert state.watermark_of("claims-db") == "2026-01-04T09:30:00Z"
    assert state.reasons == ()


def test_a_volume_nothing_has_ingested_has_no_ledger(store: IngestLedgerStore) -> None:
    assert store.load() is None


def test_a_ledger_from_another_package_revision_is_not_this_packages(store: IngestLedgerStore) -> None:
    """The graph answers the *old* semantics; the probe says so rather than serving them."""
    store.record(completed(package=PackageRef(name=REF.name, version="0.9.0", digest=REF.digest)))

    assert store.for_package(REF) is None
    assert store.load() is not None


def test_a_ledger_of_another_kind_is_refused_not_read_as_empty(store: IngestLedgerStore) -> None:
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text(json.dumps({"fde_schema": {"kind": "something-else", "version": 1}}), encoding="utf-8")

    with pytest.raises(IngestLedgerError) as caught:
        store.load()
    assert LEDGER_KIND in str(caught.value)


def test_a_ledger_from_a_newer_build_is_refused(store: IngestLedgerStore) -> None:
    document = completed().as_dict()
    document["fde_schema"]["version"] = 99
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text(json.dumps(document), encoding="utf-8")

    with pytest.raises(IngestLedgerError) as caught:
        store.load()
    assert "newer build" in str(caught.value)


def test_the_probe_says_not_started_before_the_job_ever_ran(
    store: IngestLedgerStore, package: ContextPackage
) -> None:
    result = IngestStatus.for_package(store, package).probe()

    assert result.status == "degraded"
    assert "not_started" in (result.reason or "")
    assert IngestStatus.for_package(store, package).complete() is False


def test_the_probe_is_ok_on_a_completed_run_of_this_package(
    store: IngestLedgerStore, package: ContextPackage
) -> None:
    store.record(completed())

    assert IngestStatus.for_package(store, package).probe().status == "ok"
    assert IngestStatus.for_package(store, package).complete() is True


def test_the_probe_says_stale_when_the_graph_came_from_another_revision(
    store: IngestLedgerStore, package: ContextPackage
) -> None:
    store.record(completed(package=PackageRef(name=REF.name, version="0.9.0", digest=REF.digest)))

    result = IngestStatus.for_package(store, package).probe()

    assert result.status == "degraded"
    assert "stale" in (result.reason or "")


def test_the_probe_says_partial_when_a_source_of_this_run_failed(
    store: IngestLedgerStore, package: ContextPackage
) -> None:
    store.record(
        completed(
            status="failed",
            sources=(
                SourceState(source="claims-db", status="ok", entities=9),
                SourceState(source="sharepoint-claims", status="failed", reason="connector_unavailable"),
            ),
        )
    )

    result = IngestStatus.for_package(store, package).probe()

    assert result.status == "degraded"
    assert "partial" in (result.reason or "")
    assert "sharepoint-claims: failed (connector_unavailable)" in (result.reason or "")


def test_the_probe_says_partial_when_a_declared_source_was_never_ingested(
    store: IngestLedgerStore, package: ContextPackage
) -> None:
    """A successful subset run is not the whole package: the source it skipped is missing.

    `IngestJobRequest.sources` may name a subset, but "this package, all sources ok" is
    what makes `/readyz` ready (§9.2). A ledger that simply omits `sharepoint-claims`
    must not be read as "it was fine".
    """
    store.record(completed(sources=(SourceState(source="claims-db", status="ok", entities=9),)))

    result = IngestStatus.for_package(store, package).probe()

    assert result.status == "degraded"
    assert "partial" in (result.reason or "")
    assert "sharepoint-claims: not_ingested" in (result.reason or "")
    assert IngestStatus.for_package(store, package).complete() is False


def test_an_unreadable_ledger_fails_the_probe_rather_than_guessing(
    store: IngestLedgerStore, package: ContextPackage
) -> None:
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text("{not json", encoding="utf-8")

    result = IngestStatus.for_package(store, package).probe()

    assert result.status == "failed", "a ledger this build cannot read is not 'not started'"
