"""The migrate job (`python -m app.migrate`): schema first, then anything else.

`platform/context-service/1.1.0/topology.yaml` runs this before the service and
makes the service wait on its exit (`dependsOn: [migrate]`), and
`docs/runtime-contract.md` §9.2 fixes what each side owns:

| Who | Does |
| --- | --- |
| this job | creates or converges the audit schema and the graph snapshot |
| `context-service` | **verifies** both, and refuses to serve a volume this job has not prepared |

That split is why the job exists at all. A service that migrated its own volumes
would make `docker compose up` order a decoration: the process could serve on a
volume nothing had prepared, and the exit code the topology waits for would gate
nothing. Here the gate is real in both directions — the job's non-zero exit stops
the deployment order, and the service's startup check stops a process that somehow
ran on an unprepared volume.

The job takes the stores' configuration only (`Settings.storage_from_env`): it is
the maintenance surface, holds no `ExecutionContext`, and the topology gives it no
issuer keys (§5.4). It prints one line per store — an operator watching
`docker compose up` sees which volume was created, converged or already current.
"""

from __future__ import annotations

import sqlite3
import sys
from collections.abc import Sequence
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path
from typing import TextIO

from app.audit import AuditStore, AuditStoreError, read_only_connection
from app.generated.versions import AUDIT_SCHEMA_VERSION, GRAPH_SCHEMA_VERSION
from app.graph import snapshot
from app.settings import ConfigurationError, Settings


@dataclass(frozen=True)
class Step:
    """One volume's outcome, as the job reports it."""

    volume: str
    path: str
    changed: bool
    detail: str

    def line(self) -> str:
        state = "created or converged" if self.changed else "already current"
        return f"{self.volume}: {state} at {self.path} ({self.detail})"


def _audit_state(path: Path) -> tuple[int, frozenset[str]] | None:
    """`(user_version, schema object names)`, or `None` when there is no file yet.

    The store's DDL is idempotent, so "did this pass change anything?" cannot be
    read off a return value; it is the difference between the file before and
    after, which is also exactly what an operator cares about on the second
    `docker compose up`.
    """
    if not path.exists():
        return None
    try:
        with closing(read_only_connection(path)) as connection:
            version = int(connection.execute("PRAGMA user_version").fetchone()[0])
            names = connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger')"
            ).fetchall()
    except sqlite3.DatabaseError:
        # Unreadable is not the job's to diagnose here: opening the store will
        # report it with the file's actual problem.
        return None
    return version, frozenset(str(row[0]) for row in names)


def migrate_audit(settings: Settings) -> Step:
    """Establish or converge the audit schema."""
    path = Path(settings.audit_path)
    before = _audit_state(path)
    store = AuditStore(path)
    try:
        store.migrate()
    finally:
        store.close()
    return Step(
        volume="audit",
        path=str(path),
        changed=_audit_state(path) != before,
        detail=f"schema {AUDIT_SCHEMA_VERSION} (sqlite, append-only)",
    )


def migrate_graph(settings: Settings) -> Step:
    """Create the snapshot when the volume is empty; verify and leave it alone otherwise."""
    graph = Path(settings.graph_path)
    created = snapshot.establish(graph)
    return Step(
        volume="graph",
        path=str(graph),
        changed=created,
        detail=f"schema {GRAPH_SCHEMA_VERSION} (embedded)",
    )


def migrate(settings: Settings, *, out: TextIO = sys.stdout) -> int:
    """Run both migrations; `0` means every volume is at this release's schema."""
    try:
        steps = [migrate_audit(settings), migrate_graph(settings)]
    except (AuditStoreError, snapshot.GraphSnapshotError, ConfigurationError) as error:
        print(f"migrate: failed: {error}", file=sys.stderr)
        return 1

    for step in steps:
        print(step.line(), file=out)
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    """`python -m app.migrate` — the entry point the topology's job calls."""
    arguments = list(sys.argv[1:] if argv is None else argv)
    if arguments:
        print("usage: python -m app.migrate", file=sys.stderr)
        return 2
    try:
        settings = Settings.storage_from_env()
    except ConfigurationError as error:
        print(f"migrate: failed: {error}", file=sys.stderr)
        return 1
    return migrate(settings)


if __name__ == "__main__":
    raise SystemExit(main())
