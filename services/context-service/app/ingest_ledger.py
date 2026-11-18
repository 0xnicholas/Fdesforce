"""The ingest ledger: what materialized the graph, and from which package (§9.2).

`docs/runtime-contract.md` §9.2 says ingest does not block readiness, and that until it
finishes `retrieve` answers `degraded=true, reason=partial`. Something therefore has to
answer "has it finished?" across a restart, and that answer has to be as durable as the
graph it describes: a ledger that lived only in memory would report a fully materialized
graph as `partial` after every deploy, and would forget which package the graph came
from.

So the ledger is a file on the graph volume, next to the snapshot
(`<GRAPH_PATH>/../ingest.json`), because the snapshot and the record of what produced it
must be backed up, restored and replaced together. It carries:

- the **package** the graph was materialized from (name, version, digest). A graph built
  from `acme-claims-context@1.0.0` cannot answer a `2.0.0` recipe, and the probe says so
  rather than serving the old facts under the new semantics;
- the **per-source outcome** of the last run — status, counts, watermark, reason — which
  is what an operator reads when `/readyz` says `partial`;
- the **watermarks**, so the next `incremental` run resumes instead of re-reading.

The file is written atomically and stamped with its own schema version. A ledger this
build cannot read is an error, never "not started": the two look the same to a caller
and mean opposite things.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from app.context_package import ContextPackage
from app.readiness import ProbeResult

#: The envelope's kind and version, checked on read like every other volume this
#: service opens (§9.2: a foreign schema is a refusal, not a best effort).
LEDGER_KIND = "fde.context-service.ingest-state"
LEDGER_VERSION = 1

#: The file name inside the graph volume's directory.
LEDGER_FILE = "ingest.json"

SourceStatus = Literal["ok", "degraded", "failed"]
JobStatus = Literal["succeeded", "degraded", "failed"]


class IngestLedgerError(RuntimeError):
    """The ledger cannot be read: the volume is wrong, or a newer build wrote it."""


@dataclass(frozen=True)
class PackageRef:
    """The frozen package revision a job materialized, as the wire names it."""

    name: str
    version: str
    digest: str

    def as_dict(self) -> dict[str, str]:
        return {"name": self.name, "version": self.version, "digest": self.digest}


@dataclass(frozen=True)
class SourceState:
    """One source's outcome: what the graph got, and where the next run resumes."""

    source: str
    status: SourceStatus
    entities: int = 0
    edges: int = 0
    watermark: str | None = None
    reason: str | None = None

    def as_dict(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "source": self.source,
            "status": self.status,
            "entities": self.entities,
            "edges": self.edges,
        }
        if self.watermark is not None:
            document["watermark"] = self.watermark
        if self.reason is not None:
            document["reason"] = self.reason
        return document


@dataclass(frozen=True)
class IngestLedger:
    """The ledger: one package, one finished run, one outcome per source."""

    package: PackageRef
    status: JobStatus
    completed_at: str
    job_id: str
    sources: tuple[SourceState, ...] = ()

    @property
    def complete(self) -> bool:
        """Whether the graph is the package's *current* materialization.

        A run that finished `degraded` or `failed` is not: some declared source's facts
        are missing or stale, so a retrieval is a partial answer (§6.4).
        """
        return self.status == "succeeded"

    @property
    def reasons(self) -> tuple[str, ...]:
        """`<source>: <status> (<reason>)` for every source that is not ok."""
        return tuple(
            f"{source.source}: {source.status}" + (f" ({source.reason})" if source.reason else "")
            for source in self.sources
            if source.status != "ok"
        )

    def watermark_of(self, source: str) -> str | None:
        found = next((entry for entry in self.sources if entry.source == source), None)
        return found.watermark if found is not None else None

    def as_dict(self) -> dict[str, Any]:
        return {
            "fde_schema": {"kind": LEDGER_KIND, "version": LEDGER_VERSION},
            "package": self.package.as_dict(),
            "status": self.status,
            "completed_at": self.completed_at,
            "job_id": self.job_id,
            "sources": [source.as_dict() for source in self.sources],
        }


class IngestLedgerStore:
    """Read and write the ledger on the graph volume."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    @classmethod
    def for_graph(cls, graph_path: str | Path) -> IngestLedgerStore:
        """The ledger lives beside the snapshot it describes."""
        return cls(Path(graph_path).parent / LEDGER_FILE)

    def load(self) -> IngestLedger | None:
        """The last run, or `None` when this volume has never been ingested."""
        if not self.path.exists():
            return None
        try:
            document = json.loads(self.path.read_text(encoding="utf-8"))
        except OSError as error:
            raise IngestLedgerError(f"the ingest ledger at {self.path} cannot be read: {error.strerror}") from error
        except json.JSONDecodeError as error:
            raise IngestLedgerError(f"the ingest ledger at {self.path} is not valid JSON: {error}") from error
        return _parse(document, self.path)

    def record(self, state: IngestLedger) -> None:
        """Write the ledger atomically: a crash leaves the previous run, not half a run."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(state.as_dict(), indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(temporary, self.path)

    def for_package(self, ref: PackageRef) -> IngestLedger | None:
        """The last run *of this package revision*, or `None` if the graph came from another."""
        state = self.load()
        if state is None or state.package != ref:
            return None
        return state


def _parse(document: Any, path: Path) -> IngestLedger:
    if not isinstance(document, Mapping):
        raise IngestLedgerError(f"the ingest ledger at {path} is not a JSON object")
    stamp = document.get("fde_schema")
    if not isinstance(stamp, Mapping) or stamp.get("kind") != LEDGER_KIND:
        raise IngestLedgerError(
            f"the ingest ledger at {path} is not an {LEDGER_KIND} document; "
            "delete the volume's ledger and re-run the ingest job"
        )
    if stamp.get("version") != LEDGER_VERSION:
        raise IngestLedgerError(
            f"the ingest ledger at {path} is schema {stamp.get('version')!r} and this build reads "
            f"{LEDGER_VERSION}; a newer build wrote this volume"
        )
    package = document.get("package")
    if not isinstance(package, Mapping) or not all(
        isinstance(package.get(key), str) for key in ("name", "version", "digest")
    ):
        raise IngestLedgerError(f"the ingest ledger at {path} names no package revision")
    status = document.get("status")
    if status not in ("succeeded", "degraded", "failed"):
        raise IngestLedgerError(f"the ingest ledger at {path} has status {status!r}")
    sources = document.get("sources")
    if not isinstance(sources, list):
        raise IngestLedgerError(f"the ingest ledger at {path} has no `sources` list")
    return IngestLedger(
        package=PackageRef(
            name=str(package["name"]),
            version=str(package["version"]),
            digest=str(package["digest"]),
        ),
        status=status,
        completed_at=str(document.get("completed_at") or ""),
        job_id=str(document.get("job_id") or ""),
        sources=tuple(_source_state(entry, path) for entry in sources),
    )


def _source_state(entry: Any, path: Path) -> SourceState:
    if not isinstance(entry, Mapping) or not isinstance(entry.get("source"), str):
        raise IngestLedgerError(f"the ingest ledger at {path} has a source entry without a name")
    status = entry.get("status")
    if status not in ("ok", "degraded", "failed"):
        raise IngestLedgerError(f"the ingest ledger at {path}: source {entry['source']!r} has status {status!r}")
    return SourceState(
        source=str(entry["source"]),
        status=status,
        entities=int(entry.get("entities") or 0),
        edges=int(entry.get("edges") or 0),
        watermark=entry.get("watermark") if isinstance(entry.get("watermark"), str) else None,
        reason=entry.get("reason") if isinstance(entry.get("reason"), str) else None,
    )


class IngestStatus:
    """The one reader of the ledger: `/readyz` and `retrieve` get the same answer.

    Two readers, one decision, for the reason `app.limits.over_ceiling` has one
    predicate: if the probe and the retrieval each decided for themselves, a deployment
    could be `degraded` to its operator and fine to its callers — exactly the pair of
    answers §9.2 says must agree.

    The states, in the order an operator should read them:

    | Ledger | Answer | Why |
    | --- | --- | --- |
    | unreadable | `failed` | the volume is wrong; the service must not claim a graph it cannot describe |
    | absent | `degraded` `not_started` | a fresh volume: retries help, and the job is the next step |
    | another package | `degraded` `stale` | the graph answers the *old* semantics — re-run the job |
    | this package, degraded | `degraded` `partial` | some source's facts are missing (§6.4) |
    | this package, a source never ingested | `degraded` `partial` | a subset run is not the whole package |
    | this package, all sources ok | `ok` | the graph is the package's current materialization |
    """

    name = "ingest"

    def __init__(
        self, store: IngestLedgerStore, ref: PackageRef, sources: Sequence[str] = ()
    ) -> None:
        self.store = store
        self._ref = ref
        #: Every source the package declares. The ledger says "this package, all sources
        #: ok" only when each of these has an outcome and none of them is degraded.
        self._sources = tuple(sources)

    @classmethod
    def for_package(cls, store: IngestLedgerStore, package: ContextPackage) -> IngestStatus:
        revision = package.revision(package.version)
        if revision is None:
            raise IngestLedgerError(
                f"{package.name}@{package.version} has no frozen revision; a package this service cannot "
                "attest is not a package it can report on — `fde context freeze` writes revisions/<version>.yaml"
            )
        return cls(
            store,
            PackageRef(name=package.name, version=package.version, digest=revision.digest),
            tuple(sorted(package.sources)),
        )

    def probe(self) -> ProbeResult:
        try:
            state = self.store.load()
        except IngestLedgerError as error:
            return ProbeResult(status="failed", reason=str(error))
        if state is None:
            return ProbeResult(
                status="degraded",
                reason=f"not_started ({self._ref.name}@{self._ref.version} has not been materialized; "
                "the ingest job fills the graph and retrying is the wrong fix)",
            )
        if state.package != self._ref:
            return ProbeResult(
                status="degraded",
                reason=(
                    f"stale (the graph was materialized from {state.package.name}@{state.package.version} "
                    f"{state.package.digest}, and this deployment serves "
                    f"{self._ref.name}@{self._ref.version} {self._ref.digest})"
                ),
            )
        # "This package, all sources ok" is the condition, not "the last run said
        # succeeded": a subset run can omit a declared source, and a carried outcome can
        # still be degraded while the run that just finished was fine.
        recorded = {source.source for source in state.sources}
        missing = tuple(f"{name}: not_ingested" for name in self._sources if name not in recorded)
        problems = missing + state.reasons
        if not state.complete or problems:
            return ProbeResult(
                status="degraded",
                reason=f"partial ({'; '.join(problems) or state.status})",
            )
        return ProbeResult(status="ok")

    def complete(self) -> bool:
        """Whether a retrieval may call its answer whole (`reason=partial` otherwise, §9.2)."""
        return self.probe().status == "ok"


__all__ = [
    "IngestLedger",
    "IngestLedgerError",
    "IngestLedgerStore",
    "IngestStatus",
    "JobStatus",
    "LEDGER_FILE",
    "LEDGER_KIND",
    "LEDGER_VERSION",
    "PackageRef",
    "SourceState",
    "SourceStatus",
]
