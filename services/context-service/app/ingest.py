"""The ingest job: compile a frozen Context Package into the Context Graph (§9.2, §5.5).

Two façades, one implementation. `POST /internal/v1/jobs/ingest` is the endpoint the
`fde-jobs` issuer reaches, and `python -m app.ingest` is the container the topology runs
after the service is up. Neither blocks readiness: the job comes *after*
`context-service` in `platform/context-service/1.1.0/topology.yaml`, and until it
finishes `/readyz` says `degraded` and `retrieve` says `reason=partial` (§9.2).

What the job does, per declared Context Source:

```text
read      → the source's records, resumed from the watermark for `incremental`
map       → the package's mapping: entity id, type, content, source_ref, version
rebuild   → (only for `rebuild`) drop what this source previously contributed
upsert    → one batch of entities, then the edges whose both ends now exist
ledger    → per-source outcome and watermarks, on the graph volume
```

Three rules the job keeps rather than optimizes away:

- **Only frozen semantics.** The request names a package revision; the package's
  `revisions/<version>.yaml` is `fde context freeze`'s attestation, and a digest that is
  not that one is `409 package_not_frozen`. Materializing an unfrozen package would mean
  serving semantics nobody signed off.
- **A missing source is `degraded`, never silent.** A Connector that raises is one
  source's failure: the others still materialize, the job reports which one and why, and
  the ledger keeps the graph `partial` so a retrieval cannot mistake it for whole.
- **An edge never invents an entity.** A relation whose target the package did not
  produce is dropped and counted; the source is `degraded` with the count, because a
  dangling reference is a package or a data problem an operator should see, not a fact to
  make up (`app/graph/port.py`).

The mapping's `join` is how a SQL Connector would produce a relation's target keys. A
synthetic source carries them pre-joined under the relation's predicate
(`app/connectors/claims_db.py`), which is why the job reads `relation.property` out of
the record instead of parsing SQL — the model never generates a query, and neither does
this.
"""

from __future__ import annotations

import json
import os
import secrets
import sys
import urllib.error
import urllib.request
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO

from app.clock import isoformat_z, utc_now
from app.connectors import ConnectorRegistry
from app.connectors.port import ConnectorError, Record
from app.content import render
from app.context_package import (
    ContextPackage,
    ContextSource,
    DocumentMapping,
    EntityMapping,
    PackageError,
    segment_of,
    type_of,
)
from app.graph.entity_id import render as render_entity_id
from app.graph.port import Entity, GraphStore, Relationship
from app.ids import new_ulid
from app.ingest_ledger import (
    IngestLedger,
    IngestLedgerStore,
    JobStatus,
    PackageRef,
    SourceState,
)

#: The `extraction.entityTypes` word that marks the class a document *chunk* is, since
#: v0 has no extractor: a chunk is a document fragment, not the facts inside one.
DOCUMENT_TERM_HINT = "document"

#: The modes `contracts/schemas/ingest-job.schema.json` declares.
INGEST_MODES = ("incremental", "backfill", "rebuild")


class IngestError(RuntimeError):
    """The job cannot run at all: bad configuration, not a bad source."""


class PackageNotFrozen(IngestError):
    """The request names a package revision this deployment does not hold frozen."""


class UnknownSource(IngestError):
    """The request names a Context Source the package does not declare."""


@dataclass(frozen=True)
class IngestRequest:
    """The job's request (`contracts/schemas/ingest-job.schema.json`)."""

    package: PackageRef
    mode: str
    sources: tuple[str, ...] | None = None

    @classmethod
    def from_wire(cls, body: Mapping[str, Any]) -> IngestRequest:
        package = body.get("package") or {}
        sources = body.get("sources")
        return cls(
            package=PackageRef(
                name=str(package.get("name") or ""),
                version=str(package.get("version") or ""),
                digest=str(package.get("digest") or ""),
            ),
            mode=str(body.get("mode") or ""),
            sources=tuple(str(source) for source in sources) if isinstance(sources, list) else None,
        )


@dataclass(frozen=True)
class JobResult:
    """The finished job (`IngestJobResult`): what it materialized, per source."""

    job_id: str
    status: JobStatus
    package: PackageRef
    mode: str
    started_at: str
    finished_at: str
    sources: tuple[SourceState, ...]
    message: str | None = None

    def as_dict(self) -> dict[str, Any]:
        document: dict[str, Any] = {
            "job_id": self.job_id,
            "status": self.status,
            "package": self.package.as_dict(),
            "mode": self.mode,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "sources": [source.as_dict() for source in self.sources],
        }
        if self.message:
            document["message"] = self.message
        return document


@dataclass(frozen=True)
class _Materialized:
    """One source's contribution, before it is written: the clump the job passes around."""

    source: ContextSource
    outcome: SourceState
    entities: list[Entity]
    relationships: list[Relationship]


def run(
    package: ContextPackage,
    registry: ConnectorRegistry,
    graph: GraphStore,
    state_store: IngestLedgerStore,
    *,
    tenant_id: str,
    request: IngestRequest,
    now: datetime | None = None,
) -> JobResult:
    """Materialize the package's sources into the graph, and record what happened."""
    started_at = isoformat_z(now or utc_now())
    _require_frozen(package, request.package)
    job_id = new_ulid("job_")
    previous = state_store.load()
    sources = _selected(package, request)

    materialized = [
        _materialize(
            package,
            registry,
            source,
            tenant_id=tenant_id,
            incremental=request.mode == "incremental",
            since=previous.watermark_of(source.id) if previous is not None else None,
            now=now,
        )
        for source in sources
    ]

    if request.mode == "rebuild":
        # After the read, never before: a rebuild whose source turned out to be
        # unreachable must not leave the graph emptier than it found it.
        for piece in materialized:
            if piece.outcome.status != "failed":
                graph.delete_source(tenant_id, piece.source.id)

    for piece in materialized:
        if piece.entities:
            graph.upsert_entities(tenant_id, sorted(piece.entities, key=lambda entity: entity.entity_id))

    outcomes = [
        _attach_edges(graph, tenant_id, piece.source.id, piece.outcome, piece.relationships)
        for piece in materialized
    ]

    # Two verdicts, deliberately different. The job's result is about the sources *this
    # run* read; the ledger is about the graph, so it also carries the outcomes a previous
    # run recorded for sources this one did not cover. Reusing the job's verdict for the
    # ledger would let a successful one-source run turn `/readyz` green while a source
    # known to be broken is still missing (§9.2).
    status = _job_status(outcomes)
    finished_at = isoformat_z(now or utc_now())
    covered = {source.id for source in sources}
    carried = tuple(
        entry
        for entry in (previous.sources if previous is not None else ())
        if entry.source not in covered and entry.source in package.sources
    )
    state_store.record(
        IngestLedger(
            package=PackageRef(name=package.name, version=package.version, digest=request.package.digest),
            status=_job_status(tuple(outcomes) + carried),
            completed_at=finished_at,
            job_id=job_id,
            sources=tuple(outcomes) + carried,
        )
    )
    kept_edges = sum(outcome.edges for outcome in outcomes)
    return JobResult(
        job_id=job_id,
        status=status,
        package=request.package,
        mode=request.mode,
        started_at=started_at,
        finished_at=finished_at,
        sources=tuple(outcomes),
        message=_message(outcomes, kept_edges),
    )


# ---------------------------------------------------------------------------
# one source
# ---------------------------------------------------------------------------


def _materialize(
    package: ContextPackage,
    registry: ConnectorRegistry,
    source: ContextSource,
    *,
    tenant_id: str,
    incremental: bool,
    since: str | None,
    now: datetime | None,
) -> _Materialized:
    """Read one source and map it; a broken source is an outcome, not an exception."""
    connector = registry.get(source.connector)
    if connector is None:
        return _Materialized(
            source=source,
            outcome=SourceState(
                source=source.id,
                status="failed",
                reason=f"no Connector is registered as {source.connector!r}; this deployment serves "
                f"{', '.join(registry.ids())}",
            ),
            entities=[],
            relationships=[],
        )

    # `incremental` resumes from the watermark; `backfill` and `rebuild` read everything.
    # §5.5 says a backfill "replays a window", and this contract has no field to name one
    # (`IngestJobRequest` carries the package, the mode and the sources), so v0's backfill
    # is a full re-read. A window is a contract change, not a flag this job invents.
    window = since if incremental else None
    entities: list[Entity] = []
    relationships: list[Relationship] = []
    skipped = 0
    watermark = since
    try:
        for mapping in [entry for entry in package.entities if entry.source == source.id]:
            page = connector.read(mapping.dataset, since=window)
            watermark = _newest(watermark, page.watermark)
            mapped, edges, missed = _map_records(
                mapping, page.records, tenant_id=tenant_id, source=source, now=now
            )
            entities.extend(mapped)
            relationships.extend(edges)
            skipped += missed
        # The *source* names the dataset a document mapping reads (`sites/claims`); the
        # mapping names the paths inside it. One read, however many mappings describe it.
        document_mappings = [entry for entry in package.documents if entry.source == source.id]
        if document_mappings:
            page = connector.read(source.dataset, since=window)
            watermark = _newest(watermark, page.watermark)
            for document in document_mappings:
                entities.extend(_map_chunks(document, page.records, tenant_id=tenant_id, source=source, now=now))
    except ConnectorError as error:
        return _Materialized(
            source=source,
            outcome=SourceState(source=source.id, status="failed", watermark=watermark, reason=str(error)),
            entities=[],
            relationships=[],
        )

    reason = f"{skipped} records carry no key or no watermark, so they cannot be cited" if skipped else None
    return _Materialized(
        source=source,
        outcome=SourceState(
            source=source.id,
            status="degraded" if reason else "ok",
            entities=len(entities),
            edges=len(relationships),
            watermark=watermark,
            reason=reason,
        ),
        entities=entities,
        relationships=relationships,
    )


def _map_records(
    mapping: EntityMapping,
    records: Sequence[Record],
    *,
    tenant_id: str,
    source: ContextSource,
    now: datetime | None,
) -> tuple[list[Entity], list[Relationship], int]:
    """One `EntityMapping` over its records: entities, and the edges it asserts."""
    entities: list[Entity] = []
    relationships: list[Relationship] = []
    skipped = 0
    term = mapping.entity
    type_name = type_of(term)
    segment = segment_of(term)
    for record in records:
        key = record.values.get(mapping.key[0])
        key_text = str(key) if isinstance(key, (str, int)) and str(key) else ""
        if not key_text or (mapping.watermark is not None and record.updated_at is None):
            skipped += 1
            continue
        properties = {
            mapping.properties[field]: record.values[field]
            for field in mapping.properties
            if field in record.values
        }
        entity_id = render_entity_id(tenant_id, segment, key_text)
        entities.append(
            Entity(
                entity_id=entity_id,
                type=type_name,
                content=render(type_name, key_text, properties),
                # The citation names the row, not only the dataset: an auditor has to be
                # able to check *this* fact against *this* row (§3.3's `source_ref`).
                source_ref=f"{source.id}://{mapping.dataset}/{key_text}",
                version=record.updated_at or "1",
                attributes={
                    "term": term,
                    "source": source.id,
                    "source_kind": "structured",
                    "classification": source.classification,
                    "properties": properties,
                    "freshness": _freshness(record, source, now),
                    **({"updated_at": record.updated_at} if record.updated_at else {}),
                },
            )
        )
        relationships.extend(_edges_of(mapping, record, entity_id, tenant_id))
    return entities, relationships, skipped


def _edges_of(
    mapping: EntityMapping, record: Record, entity_id: str, tenant_id: str
) -> list[Relationship]:
    """The relations this record asserts, from the pre-joined keys under each predicate."""
    edges: list[Relationship] = []
    for relation in mapping.relations:
        targets = record.values.get(relation.property) or ()
        if isinstance(targets, str):
            targets = (targets,)
        for target in targets:
            edges.append(
                Relationship(
                    source_id=entity_id,
                    target_id=render_entity_id(tenant_id, segment_of(relation.target_entity), str(target)),
                    predicate=relation.property,
                    weight=1.0,
                )
            )
    return edges


def _map_chunks(
    mapping: DocumentMapping,
    records: Sequence[Record],
    *,
    tenant_id: str,
    source: ContextSource,
    now: datetime | None,
) -> list[Entity]:
    """One `DocumentMapping` over its chunks: each section is an attributable entity.

    v0 has no extractor, so a chunk is a document fragment of the class the mapping's
    `extraction.entityTypes` names as a document (`ic:ClaimDocument`). The mapping's
    `provenance` templates are the citation — `sharepoint://{path}` at `{etag}`, which is
    what a golden question's `requiredCitations` checks.
    """
    term = document_term(mapping)
    entities: list[Entity] = []
    for record in records:
        heading = str(record.values.get("heading") or "")
        text = str(record.values.get("text") or "")
        content = f"{heading}\n{text}".strip() if heading else text.strip()
        if not content:
            continue
        path = str(record.values.get("path") or record.key)
        etag = str(record.values.get("etag") or "1")
        entities.append(
            Entity(
                entity_id=render_entity_id(tenant_id, segment_of(term), record.key),
                type=type_of(term),
                content=content,
                source_ref=mapping.source_ref.replace("{path}", path),
                version=mapping.version.replace("{etag}", etag),
                attributes={
                    "term": term,
                    "source": source.id,
                    "source_kind": "document",
                    "classification": source.classification,
                    "freshness": _freshness(record, source, now),
                    **({"updated_at": record.updated_at} if record.updated_at else {}),
                },
            )
        )
    return entities


def document_term(mapping: DocumentMapping) -> str:
    """The entity class a chunk is: the `extraction.entityTypes` entry naming a document."""
    candidates = [entry for entry in mapping.entity_types if DOCUMENT_TERM_HINT in entry.casefold()]
    if not candidates:
        raise PackageError(
            f"{mapping.source}: the document mapping extracts {', '.join(mapping.entity_types) or 'nothing'} and "
            "none of them is a document class; v0 materializes chunks as a document, not as the facts inside one"
        )
    return candidates[0]


# ---------------------------------------------------------------------------
# edges, status, ledger
# ---------------------------------------------------------------------------


def _attach_edges(
    graph: GraphStore, tenant_id: str, source_id: str, outcome: SourceState, relationships: Sequence[Relationship]
) -> SourceState:
    """Keep the edges whose target exists, and say how many the source lost.

    The store refuses an edge to an entity nobody wrote (an edge is an assertion about
    two things the graph holds), so the job checks first and turns the refusal into an
    outcome an operator can read instead of a failed job.
    """
    kept = [edge for edge in relationships if graph.get_entity(tenant_id, edge.target_id) is not None]
    lost = len(relationships) - len(kept)
    if kept:
        graph.upsert_relationships(tenant_id, kept)
    if not lost:
        return replace(outcome, edges=len(kept))
    dangling = f"{lost} relations point at entities the package does not produce"
    return replace(
        outcome,
        status="degraded" if outcome.status == "ok" else outcome.status,
        edges=len(kept),
        reason=f"{outcome.reason}; {dangling}" if outcome.reason else dangling,
    )


def _job_status(outcomes: Sequence[SourceState]) -> JobStatus:
    """Any failure fails the job; one degraded source degrades it; otherwise it succeeded."""
    if any(outcome.status == "failed" for outcome in outcomes):
        return "failed"
    if any(outcome.status == "degraded" for outcome in outcomes):
        return "degraded"
    return "succeeded"


def _message(outcomes: Sequence[SourceState], edges: int) -> str:
    entities = sum(outcome.entities for outcome in outcomes)
    sources = ", ".join(f"{outcome.source}={outcome.status}" for outcome in outcomes)
    return f"materialized {entities} entities and {edges} edges ({sources})"


def _selected(package: ContextPackage, request: IngestRequest) -> tuple[ContextSource, ...]:
    """The sources this run covers: the request's subset, or every declared source."""
    if request.sources is None:
        return tuple(package.sources[name] for name in sorted(package.sources))
    unknown = [source for source in request.sources if source not in package.sources]
    if unknown:
        raise UnknownSource(
            f"the ingest request names {', '.join(unknown)}, which {package.name}@{package.version} "
            f"does not declare; it declares {', '.join(sorted(package.sources))}"
        )
    return tuple(package.sources[name] for name in sorted(set(request.sources)))


def _require_frozen(package: ContextPackage, requested: PackageRef) -> None:
    """Refuse a revision this deployment does not hold frozen (§5.5: only frozen semantics)."""
    if requested.name != package.name or requested.version != package.version:
        raise PackageNotFrozen(
            f"this deployment materializes {package.name}@{package.version}, not "
            f"{requested.name}@{requested.version}"
        )
    revision = package.revision(requested.version)
    if revision is None:
        raise PackageNotFrozen(
            f"{package.name}@{requested.version} has no frozen revision in this deployment; "
            f"`fde context freeze` wrote {', '.join(sorted(package.revisions)) or 'nothing'}"
        )
    if requested.digest != revision.digest:
        raise PackageNotFrozen(
            f"{package.name}@{requested.version} is frozen at {revision.digest} and the request names "
            f"{requested.digest}; a job may only materialize the revision the lock pinned"
        )


def _freshness(record: Record, source: ContextSource, now: datetime | None) -> str:
    """`fresh`/`stale` against the source's `staleAfter`, decided at ingest, not at read.

    A freshness that moved on the wall clock would change a retrieval's score between two
    identical calls, and with it the snapshot digest. Recording it at ingest makes the
    boost a property of the graph revision — which is what a Decision cites.
    """
    if record.updated_at is None:
        return "stale"
    if source.stale_after is None:
        return "fresh"
    try:
        updated = datetime.fromisoformat(record.updated_at.replace("Z", "+00:00"))
    except ValueError:
        return "stale"
    if updated.tzinfo is None:
        updated = updated.replace(tzinfo=UTC)
    return "fresh" if (now or utc_now()) - updated <= source.stale_after else "stale"


def _newest(current: str | None, candidate: str | None) -> str | None:
    if candidate is None:
        return current
    return candidate if current is None else max(current, candidate)


# ---------------------------------------------------------------------------
# `python -m app.ingest`: the topology's ingest job
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _JobConfiguration:
    """Everything the job container is told: where, who, and which revision."""

    url: str
    package: PackageRef
    mode: str
    sources: tuple[str, ...] | None
    tenant: str
    deployment_id: str
    solution_id: str
    signing_key_path: Path


def main(
    argv: Sequence[str] | None = None, *, environ: Mapping[str, str] | None = None, stream: TextIO | None = None
) -> int:
    """Ask a running context-service to ingest this package; print the job, exit on status.

    The job holds the maintenance identity: the signing half of the `fde-jobs` key the
    topology mounts only into this container (`/run/secrets/fde-jobs-signing-key`), the
    deployment and solution it acts for, and nothing of the runtime app's. The service is
    the one that decides — a job that wrote the graph directly would need the volume and
    would bypass the tenant, the ledger and the record of who asked.
    """
    arguments = list(sys.argv[1:] if argv is None else argv)
    source = os.environ if environ is None else environ
    output = stream if stream is not None else sys.stdout

    # Two failure classes, two exit codes: a job that cannot be configured (2) never
    # reached the service, and one that was refused or came back degraded (1) did.
    try:
        configuration = _job_configuration(source, arguments)
        # The token and the request carry the same trace (§5.1): the service refuses a
        # token minted for another call, so one trace is decided here and used twice.
        trace_id = secrets.token_hex(16)
        token = _mint_job_token(
            key_path=configuration.signing_key_path,
            deployment_id=configuration.deployment_id,
            tenant_id=configuration.tenant,
            solution_id=configuration.solution_id,
            trace_id=trace_id,
        )
    except (IngestError, PackageError, ValueError) as error:
        print(f"ingest: {error}", file=output)
        return 2

    body = {
        "package": configuration.package.as_dict(),
        "mode": configuration.mode,
        **({"sources": list(configuration.sources)} if configuration.sources else {}),
    }
    try:
        response = _post(
            f"{configuration.url}/internal/v1/jobs/ingest", body=body, token=token, trace_id=trace_id
        )
    except IngestError as error:
        print(f"ingest: {error}", file=output)
        return 1
    print(json.dumps(response, indent=2, sort_keys=True), file=output)
    return 0 if response.get("status") == "succeeded" else 1


def _job_configuration(environ: Mapping[str, str], arguments: Sequence[str]) -> _JobConfiguration:
    missing = [
        name
        for name in ("CONTEXT_SERVICE_URL", "CONTEXT_PACKAGE_PATH", "FDE_DEPLOYMENT_ID", "FDE_SOLUTION_ID")
        if not environ.get(name)
    ]
    if missing:
        raise IngestError(
            f"missing {', '.join(missing)}; the topology binds the service URL and the package mount, and "
            "`fde install` binds the deployment's two ids — a job acts for one Deployment and one Solution, "
            "neither of which is a value a bundle can bake in"
        )
    package = ContextPackage.load(environ["CONTEXT_PACKAGE_PATH"])
    revision = package.revision(package.version)
    if revision is None:
        raise IngestError(
            f"{package.name}@{package.version} has no frozen revision; "
            "`fde context freeze` writes revisions/<version>.yaml"
        )
    key_path = Path(environ.get("FDE_JOBS_SIGNING_KEY") or "/run/secrets/fde-jobs-signing-key")
    if not key_path.is_file():
        raise IngestError(f"the fde-jobs signing key at {key_path} is missing; the topology mounts it into this job")

    mode = _argument(arguments, "--mode") or "incremental"
    if mode not in INGEST_MODES:
        raise IngestError(f"--mode={mode} is not one of {', '.join(INGEST_MODES)}")
    sources = _argument(arguments, "--sources")
    return _JobConfiguration(
        url=str(environ["CONTEXT_SERVICE_URL"]).rstrip("/"),
        package=PackageRef(name=package.name, version=package.version, digest=revision.digest),
        mode=mode,
        sources=tuple(sources.split(",")) if sources else None,
        tenant=package.tenant,
        deployment_id=str(environ["FDE_DEPLOYMENT_ID"]),
        solution_id=str(environ["FDE_SOLUTION_ID"]),
        signing_key_path=key_path,
    )


def _argument(arguments: Sequence[str], name: str) -> str | None:
    for argument in arguments:
        if argument.startswith(f"{name}="):
            return argument.split("=", 1)[1]
    return None


def _mint_job_token(
    *, key_path: Path, deployment_id: str, tenant_id: str, solution_id: str, trace_id: str
) -> str:
    """A `fde-jobs` `ExecutionContext`: one scope, one issuer, one call (§5.1, §5.4)."""
    from app.jobs_identity import mint_jobs_token

    return mint_jobs_token(
        private_key_pem=key_path.read_text(encoding="utf-8"),
        deployment_id=deployment_id,
        tenant_id=tenant_id,
        solution_id=solution_id,
        trace_id=trace_id,
    )


def _post(url: str, *, body: Mapping[str, Any], token: str, trace_id: str) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {token}",
            "traceparent": f"00-{trace_id}-{secrets.token_hex(8)}-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            return dict(json.loads(response.read().decode("utf-8")))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise IngestError(f"{url} answered {error.code}: {detail[:500]}") from error
    except urllib.error.URLError as error:
        raise IngestError(f"{url} is unreachable: {error.reason}") from error


if __name__ == "__main__":
    raise SystemExit(main())
