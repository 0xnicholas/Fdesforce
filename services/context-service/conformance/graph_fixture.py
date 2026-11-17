"""Graph volumes for tests and the conformance runner, built by the real store.

Retrieval has to be asserted over HTTP (the ticket's seam: `GraphStore` is an
internal port, not something a test doubles), so a test needs a *volume* — the same
artifact `fde context ingest` puts on `/data/graph` in a deployment. This module
builds one with the shipped embedded implementation rather than hand-writing the
snapshot JSON: a fixture that serialized its own format could keep passing after
the store's format changed, and it would prove nothing about the writes ingest will
make.

The envelope is created by `app.graph.snapshot.establish`, exactly as the migrate
job creates it, so a seeded volume is also a volume migrate accepts and leaves
alone.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

from app.graph import snapshot
from app.graph.embedded import EmbeddedGraphStore
from app.graph.port import Entity, Relationship
from app.ingest_ledger import IngestLedger, IngestLedgerStore, PackageRef, SourceState


def seed_ledger(
    graph_path: Path,
    *,
    package: PackageRef | None = None,
    sources: tuple[str, ...] = ("claims-db", "sharepoint-claims"),
) -> None:
    """Record a completed ingest for the reference package revision."""
    from conformance.harness import (
        REFERENCE_PACKAGE_DIGEST,
        REFERENCE_PACKAGE_NAME,
        REFERENCE_PACKAGE_VERSION,
    )

    ref = package or PackageRef(
        name=REFERENCE_PACKAGE_NAME,
        version=REFERENCE_PACKAGE_VERSION,
        digest=REFERENCE_PACKAGE_DIGEST,
    )
    IngestLedgerStore.for_graph(graph_path).record(
        IngestLedger(
            package=ref,
            status="succeeded",
            completed_at="2026-01-06T00:00:00Z",
            job_id="job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            sources=tuple(
                SourceState(source=source, status="ok", watermark="2026-01-05T08:00:00Z") for source in sources
            ),
        )
    )


def entity(
    entity_id: str,
    type: str,
    content: str,
    *,
    source_ref: str,
    version: str,
    **attributes: Any,
) -> Entity:
    return Entity(
        entity_id=entity_id,
        type=type,
        content=content,
        source_ref=source_ref,
        version=version,
        attributes=attributes,
    )


def relationship(
    source_id: str,
    target_id: str,
    predicate: str,
    *,
    weight: float = 1.0,
) -> Relationship:
    return Relationship(source_id=source_id, target_id=target_id, predicate=predicate, weight=weight)


def seed_volume(
    path: Path,
    *,
    tenant_id: str,
    entities: Iterable[Entity],
    relationships: Iterable[Relationship] = (),
    extra_tenants: Mapping[str, tuple[Iterable[Entity], Iterable[Relationship]]] | None = None,
    ingested: bool = True,
    package: PackageRef | None = None,
) -> dict[str, Any]:
    """Write a migrated graph volume containing these entities and relationships.

    `extra_tenants` exists for the isolation tests: one volume, more than one
    tenant's facts, so "the token's tenant decides what is returned" can be
    asserted against data that would leak if the filter were missing.

    `ingested=True` writes the ingest ledger beside the snapshot, saying this package
    revision was materialized — which is what a real ingest does (§9.2). Without it the
    service correctly reports `partial`, so a test that wants to assert on a *complete*
    graph has to say that the graph is complete.
    """
    if ingested:
        seed_ledger(path, package=package)
    snapshot.establish(path)
    store = EmbeddedGraphStore(path).open()
    try:
        entities = list(entities)
        relationships = list(relationships)
        if entities or relationships:
            store.upsert_entities(tenant_id, entities)
            store.upsert_relationships(tenant_id, relationships)
        for other_tenant, (other_entities, other_relationships) in (extra_tenants or {}).items():
            other_entities = list(other_entities)
            other_relationships = list(other_relationships)
            if other_entities or other_relationships:
                store.upsert_entities(other_tenant, other_entities)
                store.upsert_relationships(other_tenant, other_relationships)
    finally:
        store.close()
    return snapshot.read(path)
