"""The migrate job (`python -m app.migrate`): schema first, then everything else.

The deployment's startup order is `migrate` → `context-service` → `ingest`, and
the topology makes the service wait on the job's exit (`dependsOn: [migrate]`,
`platform/context-service/1.1.0/topology.yaml`). The job's contract is therefore
its **process**: exit 0 means both volumes are at the schema this release writes,
and anything else means the service must not start. These tests run it the way
the topology does — `GRAPH_PATH`/`AUDIT_PATH` in, no issuer keys, one exit code
out — rather than calling `main()` in-process, because the thing being promised
is what a job container observes.

The volumes it establishes are then read back directly: the job's whole product
*is* the schema, so asserting on `PRAGMA user_version` and the snapshot envelope
is reading its output, not reaching past an interface.
"""

from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

from app.generated.versions import AUDIT_SCHEMA_VERSION, GRAPH_SCHEMA_VERSION

SERVICE_ROOT = Path(__file__).resolve().parents[1]

#: What the job must not need: it holds no identity surface (§5.4), so a job that
#: only migrated because a key happened to be in the environment would not be the
#: job the topology runs.
IDENTITY_VARS = ("EXECUTION_CONTEXT_PUBLIC_KEY", "FDE_JOBS_PUBLIC_KEY")


def run_migrate(
    graph: Path, audit: Path, *, extra_env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """`python -m app.migrate` with the environment the topology gives the job."""
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in ("GRAPH_PATH", "AUDIT_PATH", *IDENTITY_VARS)
    }
    env.update({"PYTHONPATH": str(SERVICE_ROOT), "GRAPH_PATH": str(graph), "AUDIT_PATH": str(audit)})
    env.update(extra_env or {})
    return subprocess.run(
        [sys.executable, "-m", "app.migrate"],
        cwd=str(SERVICE_ROOT),
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
        check=False,
    )


def tables(audit: Path) -> set[str]:
    with sqlite3.connect(audit) as connection:
        rows = connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()
    return {str(row[0]) for row in rows}


def test_the_job_establishes_both_volumes_and_exits_zero(tmp_path: Path) -> None:
    graph = tmp_path / "graph" / "graph.json"
    audit = tmp_path / "audit" / "audit.sqlite"

    result = run_migrate(graph, audit)

    assert result.returncode == 0, f"migrate failed:\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}"
    assert str(graph) in result.stdout and str(audit) in result.stdout, (
        "the job's output must name both volumes it brought to schema, so an operator reads what happened"
    )

    with sqlite3.connect(audit) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == int(AUDIT_SCHEMA_VERSION)
    assert {"audit_entry", "chain_verification"} <= tables(audit)

    snapshot = json.loads(graph.read_text(encoding="utf-8"))
    assert snapshot["fde_schema"]["version"] == GRAPH_SCHEMA_VERSION
    assert snapshot["nodes"] == [] and snapshot["edges"] == [], "a fresh graph volume is an empty graph, not a guess"


def test_running_it_twice_is_a_no_op_not_a_reset(tmp_path: Path) -> None:
    """The job runs on every `docker compose up`, so it must converge, never reset."""
    graph = tmp_path / "graph" / "graph.json"
    audit = tmp_path / "audit" / "audit.sqlite"

    assert run_migrate(graph, audit).returncode == 0
    first = json.loads(graph.read_text(encoding="utf-8"))
    assert run_migrate(graph, audit).returncode == 0
    second = json.loads(graph.read_text(encoding="utf-8"))

    assert second == first, "the second pass rewrote the snapshot instead of leaving it alone"


def test_it_resumes_a_migration_interrupted_before_the_version_stamp(tmp_path: Path) -> None:
    """The job is idempotent DDL: a crash between the id and the version resumes on the next run."""
    from app.audit import APPLICATION_ID

    audit = tmp_path / "audit" / "audit.sqlite"
    audit.parent.mkdir(parents=True)
    with sqlite3.connect(audit) as connection:
        connection.execute(f"PRAGMA application_id = {APPLICATION_ID}")

    result = run_migrate(tmp_path / "graph" / "graph.json", audit)

    assert result.returncode == 0, result.stdout + result.stderr
    with sqlite3.connect(audit) as connection:
        assert connection.execute("PRAGMA user_version").fetchone()[0] == int(AUDIT_SCHEMA_VERSION)


def test_it_refuses_a_graph_snapshot_it_did_not_write(tmp_path: Path) -> None:
    """A snapshot from another graph schema is a data-loss decision, not a migration."""
    graph = tmp_path / "graph" / "graph.json"
    graph.parent.mkdir(parents=True)
    graph.write_text(
        json.dumps({"fde_schema": {"kind": "fde.context_graph", "version": "99"}, "nodes": [], "edges": []}),
        encoding="utf-8",
    )

    result = run_migrate(graph, tmp_path / "audit" / "audit.sqlite")

    assert result.returncode != 0, "migrate overwrote a snapshot it does not understand"
    assert "graph" in (result.stdout + result.stderr).lower()
    assert json.loads(graph.read_text(encoding="utf-8"))["nodes"] == [], "the refused snapshot was rewritten anyway"


def test_it_refuses_an_audit_volume_from_another_store(tmp_path: Path) -> None:
    audit = tmp_path / "audit" / "audit.sqlite"
    audit.parent.mkdir(parents=True)
    with sqlite3.connect(audit) as connection:
        connection.execute("PRAGMA user_version = 1")

    result = run_migrate(tmp_path / "graph" / "graph.json", audit)

    assert result.returncode != 0
    assert "audit" in (result.stdout + result.stderr).lower()


def test_it_refuses_a_snapshot_whose_payload_is_not_a_graph(tmp_path: Path) -> None:
    """The stamp says which schema wrote it; the payload has to be one too."""
    graph = tmp_path / "graph" / "graph.json"
    graph.parent.mkdir(parents=True)
    graph.write_text(
        json.dumps({"fde_schema": {"kind": "fde.context_graph", "version": "1"}, "nodes": {"n": 1}, "edges": []}),
        encoding="utf-8",
    )

    result = run_migrate(graph, tmp_path / "audit" / "audit.sqlite")

    assert result.returncode != 0
    assert "nodes" in (result.stdout + result.stderr)
