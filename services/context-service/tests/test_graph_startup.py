"""The graph volume is a startup requirement, like the audit store (§4.3, §9.2).

The graph can be rebuilt from the Context Package, but a service that booted without
one would answer every retrieval with "nothing matched" — indistinguishable, to a
caller, from a graph that is genuinely empty. So the snapshot is verified before the
first request: a missing, unreadable or foreign-schema volume stops the process, and
the message names the job that prepares it.

These cases migrate the audit volume first and then start with `migrate=False`, so
the *graph* is the only thing left to refuse; otherwise the audit refusal would
answer first and the test would prove nothing about the graph.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app.audit import AuditStore
from app.graph import snapshot
from conformance.harness import ServiceProcess


def prepared(tmp_path: Path) -> Path:
    """A data directory with the audit volume migrated and no graph snapshot."""
    data = tmp_path / "data"
    store = AuditStore(data / "audit" / "audit.sqlite")
    try:
        store.migrate()
    finally:
        store.close()
    (data / "graph").mkdir(parents=True, exist_ok=True)
    return data


def test_a_process_with_no_graph_snapshot_refuses_to_start(tmp_path: Path) -> None:
    data = prepared(tmp_path)

    with pytest.raises(RuntimeError, match="exited") as refused:
        ServiceProcess.start(data_dir=data, migrate=False)

    log = str(refused.value)
    assert "graph" in log.lower()
    assert "app.migrate" in log, "the refusal must name the job that establishes the volume"


def test_a_process_with_a_snapshot_from_another_schema_refuses_to_start(tmp_path: Path) -> None:
    data = prepared(tmp_path)
    snapshot.write(
        data / "graph" / "graph.json",
        {"fde_schema": {"kind": snapshot.SCHEMA_KIND, "version": "99"}, "nodes": [], "edges": []},
    )

    with pytest.raises(RuntimeError, match="exited") as refused:
        ServiceProcess.start(data_dir=data, migrate=False)

    log = str(refused.value)
    assert "schema version" in log and "99" in log


def test_a_process_with_an_unreadable_snapshot_refuses_to_start(tmp_path: Path) -> None:
    """Half a JSON file is a corrupt volume, not an empty graph."""
    data = prepared(tmp_path)
    (data / "graph" / "graph.json").write_text('{"nodes": [', encoding="utf-8")

    with pytest.raises(RuntimeError, match="exited") as refused:
        ServiceProcess.start(data_dir=data, migrate=False)

    assert "not JSON" in str(refused.value)


def test_a_seeded_snapshot_survives_the_migration(tmp_path: Path) -> None:
    """Migrate converges the schema; it does not reset a graph the deployment already has."""
    data = prepared(tmp_path)
    document = snapshot.empty_document(graph_id="graph-under-test", written_at="2026-11-15T08:00:00Z")
    document["nodes"] = [{"id": "fde:acme:policy:refund", "type": "Policy", "content": "kept"}]
    snapshot.write(data / "graph" / "graph.json", document)

    # `migrate=True`: the harness runs the job, which must accept and leave this volume.
    with ServiceProcess.start(data_dir=data) as service:
        assert service.get("/healthz").status_code == 200

    after = json.loads((data / "graph" / "graph.json").read_text(encoding="utf-8"))
    assert [node["id"] for node in after["nodes"]] == ["fde:acme:policy:refund"]
