"""The graph volume's one file: an envelope around the engine's own payload.

`GRAPH_PATH` holds a JSON snapshot (`docs/runtime-contract.md` §4.3). Semantica can
read and write that format itself, but the platform needs two things Semantica does
not put in it: which graph schema the file was written for, and whether it was
written at all (an empty volume and a snapshot that lost its contents must not look
alike). So the file is an *envelope*:

```json
{
  "fde_schema": {"kind": "fde.context_graph", "version": "1"},
  "graph_id": "…",
  "written_at": "2026-11-15T08:00:00Z",
  "nodes": [...],
  "edges": [...]
}
```

Semantica's loader ignores the keys it does not know, so the payload half stays
loadable by the engine (`ContextGraph.load_from_file`) and by anyone with `jq`;
the envelope half is the migration contract. `graph_id` is written once by
`python -m app.migrate` and preserved on every later save, so the volume has a
stable identity for logs and backups rather than a new random one per write.

Writing is atomic — serialize to a sibling temp file, `fsync`, `os.replace` — for
the same reason the engine does it: the snapshot is the only copy of the graph, and
a crash mid-write must leave the previous snapshot, not half of a new one.
"""

from __future__ import annotations

import contextlib
import json
import os
import tempfile
import uuid
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

from app.clock import isoformat_z, utc_now
from app.generated.versions import GRAPH_SCHEMA_VERSION

#: The `fde_schema.kind` this service reads and writes.
SCHEMA_KIND = "fde.context_graph"


class GraphSnapshotError(RuntimeError):
    """The graph volume is not a snapshot this build can serve."""


class GraphSchemaMismatch(GraphSnapshotError):
    """The snapshot was written for a graph schema this build does not speak."""


def empty_document(*, graph_id: str, written_at: str) -> dict[str, Any]:
    """A fresh graph volume: the schema stamp plus an empty graph."""
    return {
        "fde_schema": {"kind": SCHEMA_KIND, "version": GRAPH_SCHEMA_VERSION},
        "graph_id": graph_id,
        "written_at": written_at,
        "nodes": [],
        "edges": [],
    }


def new_graph_id() -> str:
    """A `graph_id` in the shape the engine uses (a UUID), so its own tooling reads it."""
    return str(uuid.uuid4())


def read(path: str | Path) -> dict[str, Any]:
    """The snapshot at `path`, or why it is not one."""
    location = Path(path)
    try:
        raw = location.read_text(encoding="utf-8")
    except FileNotFoundError as error:
        raise GraphSnapshotError(
            f"there is no graph snapshot at {location}; the graph volume is not migrated "
            "(`python -m app.migrate` establishes it, §9.2)"
        ) from error
    except OSError as error:
        raise GraphSnapshotError(f"cannot read the graph snapshot at {location}: {error}") from error

    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise GraphSnapshotError(
            f"the graph snapshot at {location} is not JSON ({error.msg} at line {error.lineno}); "
            "the volume is corrupt and needs a rebuild from the Context Package, not a migration"
        ) from error

    if not isinstance(document, dict):
        raise GraphSnapshotError(f"the graph snapshot at {location} is not a JSON object")
    _require_schema(document, location)
    return document


def _require_schema(document: Mapping[str, Any], location: Path) -> None:
    stamp = document.get("fde_schema")
    if not isinstance(stamp, Mapping) or stamp.get("kind") != SCHEMA_KIND:
        raise GraphSchemaMismatch(
            f"{location} carries no `fde_schema.kind = {SCHEMA_KIND}` stamp; "
            "it was not written by this service's migration"
        )
    version = stamp.get("version")
    if str(version) != GRAPH_SCHEMA_VERSION:
        raise GraphSchemaMismatch(
            f"the graph snapshot at {location} is schema version {version!r}, and this build "
            f"serves {GRAPH_SCHEMA_VERSION!r}; the graph volume is not migrated by the service"
        )


def establish(path: str | Path, *, now: datetime | None = None) -> bool:
    """Make sure a snapshot exists. `True` when this call created it.

    Existing snapshots are read (so a corrupt or foreign file is a failure here
    rather than at first request) and otherwise left byte-for-byte alone: the job
    runs on every `docker compose up`, and a job that rewrote the graph on every
    boot would be a job that can lose it.
    """
    location = Path(path)
    if location.exists():
        read(location)
        return False
    write(location, empty_document(graph_id=new_graph_id(), written_at=isoformat_z(now or utc_now())))
    return True


def write(path: str | Path, document: Mapping[str, Any]) -> None:
    """Write `document` atomically: a reader sees the old snapshot or the new one."""
    location = Path(path)
    location.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=location.parent, prefix=".graph_tmp_", suffix=".json")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, ensure_ascii=False)
            # `mkstemp` creates 0600; the snapshot is a deployment artifact beside the
            # audit store (which SQLite writes 0644), so backups and a host-side `jq`
            # can read it. It is volume-local either way — never served raw.
            os.fchmod(handle.fileno(), 0o644)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, location)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temporary)
        raise
