"""The Retrieval Snapshot on the audit volume: one manifest, hashed, never rewritten.

`docs/runtime-contract.md` §4.1 puts the Retrieval Snapshot in the audit store — it
is the "what the model saw" half of a Decision's evidence — and calls it immutable.
This file holds the storage half of that claim: a manifest is appended once, its
`digest` covers it, the append-only triggers refuse an edit, and a second tenant
cannot read it. The wire-visible half (`retrieval_id`, `snapshot_digest`, and the
same digest for the same request) is asserted in `tests/test_retrieval_http.py`.

The store's API is the seam here, as in `test_audit_store.py`: the invariants are
about bytes on a volume over time, and a test that reached through HTTP could not
see them. The tamper tests drop the trigger first, on purpose — the point is that
the schema, not the module, says no.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

import pytest

from app.audit import AuditStore, RetrievalSnapshotConflict, StoredSnapshot
from app.canonical import canonical_json, sha256_digest

RETRIEVAL_ID = "ret_01ARZ3NDEKTSV4RRFFQ69G5FAV"
TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
CREATED_AT = "2026-11-15T08:00:00Z"


def manifest(**overrides: Any) -> dict[str, Any]:
    """A small, contract-shaped snapshot manifest (what the pipeline produces, by hand)."""
    document: dict[str, Any] = {
        "tenant_id": "acme",
        "recipe_id": "claims-context",
        "request_digest": sha256_digest("query"),
        "items": [
            {
                "entity_id": "fde:acme:policy:refund",
                "type": "Policy",
                "version": "3",
                "source_ref": "sharepoint://claims/policies/refund.md",
                "score": 1.0,
                "content_digest": sha256_digest("Premium customers may receive a refund within 30 days."),
            }
        ],
        "degraded": False,
        "reason": None,
        "index": "lexical",
        "budget_used": {"nodes": 1, "tokens": 15, "hops": 0},
    }
    document.update(overrides)
    return document


def digest_of(document: dict[str, Any]) -> str:
    return sha256_digest(canonical_json(document))


def append(store: AuditStore, document: dict[str, Any], **overrides: Any) -> bool:
    return store.append_retrieval_snapshot(
        StoredSnapshot(
            retrieval_id=overrides.get("retrieval_id", RETRIEVAL_ID),
            tenant_id=overrides.get("tenant_id", "acme"),
            trace_id=overrides.get("trace_id", TRACE_ID),
            created_at=overrides.get("created_at", CREATED_AT),
            digest=overrides.get("digest", digest_of(document)),
            manifest=document,
        )
    )


@pytest.fixture
def path(tmp_path: Path) -> Path:
    return tmp_path / "audit" / "audit.sqlite"


@pytest.fixture
def store(path: Path) -> Iterator[AuditStore]:
    with AuditStore(path).migrate() as opened:
        yield opened


@contextmanager
def raw(path: Path) -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(path)
    try:
        yield connection
    finally:
        connection.close()


def test_a_snapshot_is_stored_once_and_read_back_byte_for_byte(store: AuditStore) -> None:
    document = manifest()

    assert append(store, document) is True
    stored = store.retrieval_snapshot(RETRIEVAL_ID, tenant_id="acme")
    assert stored is not None
    assert stored.manifest == document
    assert stored.digest == digest_of(document)
    assert stored.trace_id == TRACE_ID
    assert stored.created_at == CREATED_AT


def test_re_appending_the_same_snapshot_is_a_no_op(store: AuditStore) -> None:
    """A retry of the same retrieval is the same evidence, not a second row."""
    document = manifest()

    append(store, document)

    assert append(store, document) is False


def test_the_same_retrieval_id_with_a_different_manifest_is_a_conflict(store: AuditStore) -> None:
    """`retrieval_id` names one snapshot; a second, different one is a bug, not a variant."""
    document = manifest()
    append(store, document)

    changed = manifest(items=[])
    with pytest.raises(RetrievalSnapshotConflict):
        append(store, changed)


def test_a_digest_that_does_not_cover_the_manifest_is_refused(store: AuditStore) -> None:
    """A Decision citing the snapshot must be able to re-verify it, so the digest has to be over it."""
    document = manifest()

    with pytest.raises(ValueError, match="digest"):
        append(store, document, digest=sha256_digest("not this manifest"))


def test_a_snapshot_is_not_visible_to_another_tenant(store: AuditStore) -> None:
    document = manifest()
    append(store, document)

    assert store.retrieval_snapshot(RETRIEVAL_ID, tenant_id="beta") is None


def test_a_stored_snapshot_cannot_be_updated_or_deleted(store: AuditStore, path: Path) -> None:
    """Append-only, enforced by the schema (§6.4) — the module is not the only guard."""
    document = manifest()
    append(store, document)

    with raw(path) as connection:
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("UPDATE retrieval_snapshot SET manifest = '{}'")
        with pytest.raises(sqlite3.IntegrityError):
            connection.execute("DELETE FROM retrieval_snapshot")

    stored = store.retrieval_snapshot(RETRIEVAL_ID, tenant_id="acme")
    assert stored is not None and stored.manifest == document


def test_an_unmigrated_volume_has_no_snapshot_table(store: AuditStore, path: Path) -> None:
    """Sanity for the migration test: the table is the job's, and it is there."""
    with raw(path) as connection:
        names = {str(row[0]) for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "retrieval_snapshot" in names
