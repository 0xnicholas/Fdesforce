"""The audit store: an append-only hash chain, read as evidence (§6.4, C13/C14).

The seam is the store's own interface, because the invariants it has to keep —
`hash = SHA-256(prev_hash || canonical_json(payload))`, one entry per
`decision_id`, `verify_chain` after a restart — are about *storage and time*, not
about HTTP. `tests/test_decisions_http.py` proves the same store through the
served surface.

The tamper tests deliberately disable the append-only triggers first: the point
is that verification still detects a rewrite when the trigger is gone, which is
the difference between "we asked SQLite not to" and "the evidence disagrees".
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from app.audit import GENESIS_HASH, AuditSchemaMismatch, AuditStore, DecisionConflict
from app.canonical import canonical_json, sha256_digest


def decision(decision_id: str = "dec_01ARZ3NDEKTSV4RRFFQ69G5FAV", tenant_id: str = "acme") -> dict[str, Any]:
    return {
        "decision_id": decision_id,
        "run_id": "run_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        "tenant_id": tenant_id,
        "capability_id": "document-triage",
        "decision_type": "runtime",
        "phase": "run",
        "status": "succeeded",
        "actor": {"type": "user", "id": "u-42"},
        "rationale": "Triage completed from the claims context.",
        "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
        "timestamp": "2026-11-15T08:00:00Z",
    }


@pytest.fixture
def path(tmp_path: Path) -> Path:
    return tmp_path / "audit" / "audit.sqlite"


@pytest.fixture
def store(path: Path) -> Iterator[AuditStore]:
    with AuditStore(path) as opened:
        yield opened


@contextmanager
def raw(path: Path) -> Iterator[sqlite3.Connection]:
    """A second connection for the tamper tests: the store's own API is append-only."""
    connection = sqlite3.connect(path)
    try:
        yield connection
        connection.commit()
    finally:
        connection.close()


def test_the_first_write_is_the_first_link(store: AuditStore) -> None:
    result = store.append_decision(decision())

    assert result.created is True
    entry = result.entry
    document = entry.document
    assert entry.seq == 1
    assert entry.prev_hash == GENESIS_HASH
    assert entry.provenance_id.startswith("prov_")
    assert entry.payload_digest == sha256_digest(canonical_json(document))
    assert entry.hash == sha256_digest(GENESIS_HASH, canonical_json(document))


def test_each_write_links_to_the_one_before_it(store: AuditStore) -> None:
    first = store.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FAV")).entry
    second = store.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FB0")).entry

    assert (first.seq, second.seq) == (1, 2)
    assert second.prev_hash == first.hash
    assert second.hash != first.hash


def test_a_decision_reads_back_as_it_was_written(store: AuditStore) -> None:
    written = decision()
    store.append_decision(written)

    entry = store.decision(written["decision_id"], tenant_id=written["tenant_id"])

    assert entry is not None
    assert entry.decision == written
    assert entry.decision_id == written["decision_id"]
    assert entry.tenant_id == written["tenant_id"]
    assert entry.created_at.endswith("Z")


def test_another_tenant_cannot_read_the_decision(store: AuditStore) -> None:
    """A decision is found in the tenant that wrote it, and nowhere else (C3/C14)."""
    written = decision()
    store.append_decision(written)

    assert store.decision(written["decision_id"], tenant_id="globex") is None


def test_an_unknown_decision_is_absent(store: AuditStore) -> None:
    assert store.decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FAV", tenant_id="acme") is None


def test_a_repeated_decision_is_a_replay_not_a_second_entry(store: AuditStore) -> None:
    """C13: replaying a Decision write never creates a second audit entry."""
    written = decision()
    first = store.append_decision(written)
    replay = store.append_decision(written)

    assert replay.created is False
    assert replay.entry.seq == first.entry.seq
    assert replay.entry.provenance_id == first.entry.provenance_id
    assert replay.entry.hash == first.entry.hash
    assert len(store) == 1


def test_the_same_decision_id_with_a_different_payload_is_a_conflict(store: AuditStore) -> None:
    store.append_decision(decision())

    with pytest.raises(DecisionConflict):
        store.append_decision({**decision(), "rationale": "A different decision under a used id."})

    assert len(store) == 1


def test_one_decision_id_cannot_cross_a_tenant_boundary(store: AuditStore) -> None:
    """A replay is a replay only inside the tenant that wrote it; no payload may leak."""
    store.append_decision(decision(tenant_id="acme"))

    with pytest.raises(DecisionConflict):
        store.append_decision(decision(tenant_id="globex"))

    assert store.decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FAV", tenant_id="globex") is None


def test_the_table_refuses_updates_and_deletes(store: AuditStore, path: Path) -> None:
    """Append-only is enforced by the schema, not only by this module's API."""
    store.append_decision(decision())

    with raw(path) as connection:
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            connection.execute("UPDATE audit_entry SET payload = '{}' WHERE seq = 1")
        with pytest.raises(sqlite3.IntegrityError, match="append-only"):
            connection.execute("DELETE FROM audit_entry WHERE seq = 1")


def test_verify_chain_passes_on_a_valid_chain(store: AuditStore) -> None:
    store.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FAV"))
    last = store.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FB0")).entry

    report = store.verify_chain()

    assert report.status == "valid"
    assert report.verified_through_seq == 2
    assert report.chain_head == last.hash
    assert report.detail is None


def test_verify_chain_passes_after_a_reopen(path: Path) -> None:
    """C13: the chain is on the audit volume, so a restart verifies the same bytes."""
    with AuditStore(path) as first:
        first.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FAV"))
        first.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FB0"))

    with AuditStore(path) as reopened:
        report = reopened.verify_chain()

    assert report.status == "valid"
    assert report.verified_through_seq == 2


def test_verify_chain_detects_a_rewritten_payload(store: AuditStore, path: Path) -> None:
    store.append_decision(decision())
    written = store.append_decision(decision())  # replay: same entry, so the document is the stored one
    rewritten = {**written.entry.document, "decision": {**decision(), "rationale": "rewritten"}}
    with raw(path) as connection:
        connection.execute("DROP TRIGGER audit_entry_append_only_update")
        connection.execute("UPDATE audit_entry SET payload = ? WHERE seq = 1", (canonical_json(rewritten),))

    report = store.verify_chain()

    assert report.status == "invalid"
    assert report.detail is not None and "seq 1" in report.detail


def test_verify_chain_detects_a_broken_link(store: AuditStore, path: Path) -> None:
    store.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FAV"))
    store.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FB0"))
    with raw(path) as connection:
        connection.execute("DROP TRIGGER audit_entry_append_only_update")
        connection.execute("UPDATE audit_entry SET prev_hash = ? WHERE seq = 2", (GENESIS_HASH,))

    report = store.verify_chain()

    assert report.status == "invalid"
    assert report.verified_through_seq == 1
    assert report.detail is not None and "seq 2" in report.detail


def test_verify_chain_detects_a_missing_entry(store: AuditStore, path: Path) -> None:
    for suffix in ("A", "B", "C"):
        store.append_decision(decision(f"dec_01ARZ3NDEKTSV4RRFFQ69G5F{suffix}0"))
    with raw(path) as connection:
        connection.execute("DROP TRIGGER audit_entry_append_only_delete")
        connection.execute("DELETE FROM audit_entry WHERE seq = 2")

    report = store.verify_chain()

    assert report.status == "invalid"
    assert report.verified_through_seq == 1
    assert report.detail is not None and "seq 3" in report.detail


def test_the_read_path_reports_the_last_verification_and_does_not_verify(store: AuditStore) -> None:
    """§6.4: verification is a background job; a read reports what it last found."""
    store.append_decision(decision())

    assert store.verification().status == "pending"

    store.verify_chain()
    verified = store.verification()
    assert verified.status == "valid"
    assert verified.checked_at is not None
    assert verified.chain_head is not None

    # The chain grew past what was verified. If the read path ran verify_chain,
    # this would already say `valid`; it must say `stale`.
    store.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FB0"))
    assert store.verification().status == "stale"


def test_a_truncated_chain_reads_as_invalid_before_any_reverification(store: AuditStore, path: Path) -> None:
    """The recorded head anchors the tail: a shrink is visible without walking the chain."""
    store.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FAV"))
    store.append_decision(decision("dec_01ARZ3NDEKTSV4RRFFQ69G5FB0"))
    store.verify_chain()

    with raw(path) as connection:
        connection.execute("DROP TRIGGER audit_entry_append_only_delete")
        connection.execute("DELETE FROM audit_entry WHERE seq = 2")

    assert store.verification().status == "invalid"


def test_a_database_from_another_schema_version_is_refused(path: Path) -> None:
    path.parent.mkdir(parents=True)
    with raw(path) as connection:
        connection.execute("PRAGMA user_version = 99")

    with pytest.raises(AuditSchemaMismatch):
        AuditStore(path).open()


def test_the_document_is_the_hashed_payload(store: AuditStore) -> None:
    result = store.append_decision(decision())

    document = result.entry.document

    assert document["seq"] == 1
    assert document["provenance_id"] == result.entry.provenance_id
    assert document["decision"] == decision()
    assert result.entry.payload_digest == sha256_digest(canonical_json(document))
