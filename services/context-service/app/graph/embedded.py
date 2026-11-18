"""The v0 `GraphStore`: Semantica's in-process graph over a JSON snapshot (§4.3).

One implementation, one volume, one writer. `docs/runtime-contract.md` §4.3 fixes
the shape and its limits: the graph is a snapshot on `/data/graph`, rebuilt from
Context Sources, never the system of record for anything an auditor needs (that is
the audit store), and not multi-writer — which is why the topology pins one replica.

The invariants this module adds on top of the engine, each because the port says so
and the engine does not:

- **An entity is attributable or it is not stored.** It must have a parseable
  `entity_id` whose tenant segment is the write's tenant, a type matching the id,
  and non-empty `source_ref` and `version`. Everything else — a missing source, a
  node under another tenant, an edge to an entity nobody wrote — is refused, because
  it could only ever be returned as a citation with no provenance, or leaked into
  another tenant's retrieval.
- **An edge never invents its endpoints.** Semantica's `add_edge` silently creates
  a placeholder node for an unknown id ("b", type `entity`). That is a graph that
  grows facts nobody asserted, so both ends are checked here first.
- **Writes are durable when they return.** The snapshot is rewritten (atomically)
  after each accepted batch. The volume is the ingest job's output; a crash between
  accepting a batch and saving it would hand the next retrieval a graph that never
  existed. `docs/runtime-contract.md` §4.3 accepts the cost: ingest is a batch job
  at 10k nodes, not a write-heavy request path.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any

from app.clock import isoformat_z, utc_now
from app.generated.versions import GRAPH_SCHEMA_VERSION
from app.graph import snapshot
from app.graph.entity_id import InvalidEntityId, parse, tenant_of
from app.graph.port import (
    PORT_VERSION,
    Entity,
    Expansion,
    GraphStats,
    GraphStoreClosed,
    Health,
    InvalidEntity,
    InvalidRelationship,
    Match,
    Relationship,
)
from app.graph.semantica_graph import EngineGraph

logger = logging.getLogger("fde.context_service.graph.embedded")

#: The wire's own maxima for a `RetrievalItem` (`contracts/schemas/retrieval.schema.json`).
#: The store refuses an entity the response could not carry: an over-long `content`
#: or `source_ref` would otherwise fail model validation inside the handler, turning a
#: mapping bug into a `500` on a caller's retrieval.
WIRE_MAX = {
    "type": 100,
    "content": 20_000,
    "source_ref": 500,
    "version": 100,
}

#: How many engine candidates one lexical search asks for per requested result. The
#: engine scores and truncates before the store can filter by tenant, so a graph
#: holding more than one tenant's facts could otherwise under-return. v0 deployments
#: hold one tenant (§4.3), which makes this a hedge rather than a policy; the
#: production backend filters in its own query.
_CANDIDATE_OVERSCAN = 4


class EmbeddedGraphStore:
    """`GRAPH_PATH` → the port. Semantica `ContextGraph`, loaded from the snapshot."""

    def __init__(self, path: str | Path, *, now: Callable[[], datetime] | None = None) -> None:
        self.path = Path(path)
        self._now = now if now is not None else utc_now
        self._engine: EngineGraph | None = None
        self._graph_id: str | None = None

    @property
    def port_version(self) -> int:
        return PORT_VERSION

    # -- lifecycle --------------------------------------------------------

    def open(self) -> EmbeddedGraphStore:
        """Load the volume, or fail closed on a snapshot this build cannot serve."""
        document = snapshot.read(self.path)
        engine = EngineGraph()
        engine.load(document)
        self._engine = engine
        self._graph_id = str(document.get("graph_id") or engine.graph_id)
        return self

    def close(self) -> None:
        self._engine = None
        self._graph_id = None

    def __enter__(self) -> EmbeddedGraphStore:
        return self.open()

    def __exit__(self, *exc: object) -> None:
        self.close()

    def _open_engine(self) -> EngineGraph:
        if self._engine is None:
            raise GraphStoreClosed(f"the graph store at {self.path} is not open; call open() first")
        return self._engine

    # -- write ------------------------------------------------------------

    def upsert_entities(self, tenant_id: str, entities: Sequence[Entity]) -> int:
        """Store these entities. Idempotent by `entity_id`: a repeat replaces the entity."""
        engine = self._open_engine()
        checked = [self._checked_entity(tenant_id, entity) for entity in entities]
        if not checked:
            return 0
        for entity in checked:
            engine.upsert_node(
                entity.entity_id,
                type=entity.type,
                content=entity.content,
                attributes={"source_ref": entity.source_ref, "version": entity.version, **entity.attributes},
            )
        self._save()
        return len(checked)

    def delete_source_ref(self, tenant_id: str, source_ref: str) -> int:
        """Remove one tenant's entities of `source_ref`, and every edge that touched them.

        This is ingest's rebuild path: a source that disappeared or was re-read must
        not leave its old facts behind, and an edge to a removed entity has to go
        with it or the graph would answer with a neighbour nothing supports. The
        rebuild replaces the payload and keeps `graph_id`, then saves once.
        """
        if not source_ref:
            raise InvalidEntity("delete_source_ref needs a source_ref; an empty one would match everything")
        engine = self._open_engine()
        nodes, edges = engine.payload()
        doomed = {
            str(node.get("id"))
            for node in nodes
            if tenant_of(str(node.get("id"))) == tenant_id
            and str((node.get("properties") or {}).get("source_ref") or node.get("source_ref") or "") == source_ref
        }
        if not doomed:
            return 0
        kept_nodes = [node for node in nodes if str(node.get("id")) not in doomed]
        kept_edges = [
            edge
            for edge in edges
            if str(edge.get("source")) not in doomed and str(edge.get("target")) not in doomed
        ]
        engine.replace(kept_nodes, kept_edges)
        self._save()
        return len(doomed)

    def delete_source(self, tenant_id: str, source_id: str) -> int:
        """Remove everything ingest attributed to one Context Source — the `rebuild` path.

        A rebuild must not leave behind a fact the source no longer asserts: an entity
        dropped upstream would otherwise stay in the graph and keep being cited. The
        attribution is the `source` attribute ingest records on every entity it writes
        (the Context Source id, not the per-row `source_ref`), and the edges touching a
        removed entity go with it — an edge to nothing is not evidence.
        """
        if not source_id:
            raise InvalidEntity("delete_source needs a source id; an empty one would match a source nobody wrote")
        engine = self._open_engine()
        nodes, edges = engine.payload()
        doomed = {
            str(node.get("id"))
            for node in nodes
            if tenant_of(str(node.get("id"))) == tenant_id
            and str((node.get("properties") or {}).get("source") or "") == source_id
        }
        if not doomed:
            return 0
        kept_nodes = [node for node in nodes if str(node.get("id")) not in doomed]
        kept_edges = [
            edge
            for edge in edges
            if str(edge.get("source")) not in doomed and str(edge.get("target")) not in doomed
        ]
        engine.replace(kept_nodes, kept_edges)
        self._save()
        return len(doomed)

    def upsert_relationships(self, tenant_id: str, relationships: Sequence[Relationship]) -> int:
        """Store these edges. Idempotent by `(source, predicate, target)`.

        Both ends must already be entities of the same tenant: a relationship is an
        assertion about two things the graph holds, not a way to introduce them.
        """
        engine = self._open_engine()
        for relationship in relationships:
            self._checked_relationship(tenant_id, relationship, engine)
        added = 0
        for relationship in relationships:
            if engine.link(
                relationship.source_id,
                relationship.target_id,
                predicate=relationship.predicate,
                weight=relationship.weight,
            ):
                added += 1
        if relationships:
            self._save()
        return added

    def _checked_entity(self, tenant_id: str, entity: Entity) -> Entity:
        try:
            parsed = parse(entity.entity_id)
        except InvalidEntityId as error:
            raise InvalidEntity(str(error)) from error
        if parsed.tenant != tenant_id:
            raise InvalidEntity(
                f"{entity.entity_id} belongs to tenant {parsed.tenant!r}, not {tenant_id!r}; "
                "an entity is stored under the tenant its id names"
            )
        if parsed.type.casefold() != entity.type.casefold():
            raise InvalidEntity(
                f"{entity.entity_id} names type {parsed.type!r} but the entity declares {entity.type!r}; "
                "the id's type segment is the entity's type in an id-safe spelling, so the two cannot "
                "disagree (§3.3's own example is `fde:acme:policy:refund` for a `Policy`)"
            )
        if not entity.source_ref:
            raise InvalidEntity(f"{entity.entity_id} has no source_ref; an entity nothing can cite is not evidence")
        if not entity.version:
            raise InvalidEntity(f"{entity.entity_id} has no version; a citation without a version is not checkable")
        for attribute, maximum in WIRE_MAX.items():
            length = len(getattr(entity, attribute))
            if length > maximum:
                raise InvalidEntity(
                    f"{entity.entity_id}: {attribute} is {length} characters and the retrieval item's "
                    f"maximum is {maximum}; an entity the Context API cannot return is not stored"
                )
        return entity

    def _checked_relationship(self, tenant_id: str, relationship: Relationship, engine: EngineGraph) -> None:
        for role, entity_id in (("source", relationship.source_id), ("target", relationship.target_id)):
            if tenant_of(entity_id) != tenant_id:
                raise InvalidRelationship(
                    f"{relationship.predicate!r}: the {role} {entity_id!r} is not an entity of tenant "
                    f"{tenant_id!r}; an edge may not cross tenants (§5.3)"
                )
            if not engine.has_node(entity_id):
                raise InvalidRelationship(
                    f"{relationship.predicate!r}: the {role} {entity_id!r} is not in the graph; "
                    "a relationship may not introduce an entity nobody wrote"
                )
        if not relationship.predicate:
            raise InvalidRelationship(f"{relationship.source_id} → {relationship.target_id}: the predicate is empty")
        if not 0.0 < relationship.weight <= 1.0:
            raise InvalidRelationship(
                f"{relationship.source_id} → {relationship.target_id}: weight {relationship.weight} "
                "is outside (0, 1]"
            )

    def _save(self) -> None:
        engine = self._open_engine()
        snapshot.write(
            self.path,
            engine.document(
                written_at=isoformat_z(self._now()),
                schema={"kind": snapshot.SCHEMA_KIND, "version": GRAPH_SCHEMA_VERSION},
            ),
        )

    # -- read -------------------------------------------------------------

    def get_entity(self, tenant_id: str, entity_id: str) -> Entity | None:
        """One entity in `tenant_id`, or `None` — another tenant's id is not found, not forbidden."""
        engine = self._open_engine()
        if tenant_of(entity_id) != tenant_id:
            return None
        node = engine.node(entity_id)
        return None if node is None else self._entity_of(node)

    def lexical_search(
        self,
        tenant_id: str,
        query: str,
        *,
        limit: int,
        source: str | None = None,
        entity_type: str | None = None,
    ) -> list[Match]:
        """Scored candidates the caller may see, best first.

        A candidate is dropped when it belongs to another tenant or carries no
        `source_ref`/`version`: it could not become a `RetrievalItem` a caller is
        allowed to cite, so returning it would only move the problem downstream.

        `source`/`entity_type` are filters, not a caller-side post-pass: they apply
        before `limit` counts. The engine still scores every node, so a filtered
        search asks it for the whole matching set rather than its unfiltered head —
        otherwise 20 claims could starve the one document a recipe's lexical stage
        declared.
        """
        if limit <= 0 or not query.strip():
            return []
        engine = self._open_engine()
        narrowed = source is not None or entity_type is not None
        scan = max(limit, self.stats().nodes) if narrowed else limit * _CANDIDATE_OVERSCAN
        matches: list[Match] = []
        for entity_id, score in engine.search(query, limit=scan):
            entity = self._usable(tenant_id, entity_id)
            if entity is None:
                continue
            if source is not None and entity.attributes.get("source") != source:
                continue
            if entity_type is not None and entity.type.casefold() != entity_type.casefold():
                continue
            matches.append(Match(entity_id=entity.entity_id, score=score))
            if len(matches) >= limit:
                break
        return matches

    def expand(
        self,
        tenant_id: str,
        anchors: Sequence[str],
        *,
        hops: int,
        limit: int,
        predicates: Sequence[str] | None = None,
    ) -> list[Expansion]:
        """Everything within `hops` of the anchors over `predicates`, nearest first.

        Deduplicated by `entity_id` keeping the smallest hop, anchors excluded (they
        are already the resolved/lexical candidates), and filtered like a search
        result. `predicates` is the recipe's declared relations: a walk that could
        follow every edge would return a neighbourhood no recipe asked for.
        """
        if hops <= 0 or limit <= 0 or not anchors:
            return []
        engine = self._open_engine()
        seen: set[str] = set(anchors)
        reached: list[Expansion] = []
        for anchor in anchors:
            if tenant_of(anchor) != tenant_id:
                continue
            for entity_id, hop, weight, predicate in engine.neighbours(
                anchor, hops=hops, limit=limit, relationships=predicates
            ):
                if entity_id in seen:
                    continue
                seen.add(entity_id)
                entity = self._usable(tenant_id, entity_id)
                if entity is None:
                    continue
                reached.append(
                    Expansion(
                        entity_id=entity.entity_id,
                        hop=hop,
                        weight=weight,
                        anchor=anchor,
                        predicate=predicate,
                    )
                )
                if len(reached) >= limit:
                    return reached
        return reached

    def _usable(self, tenant_id: str, entity_id: str) -> Entity | None:
        """The entity, if it is one a caller of `tenant_id` may be shown.

        The same rules the write side enforces, applied on the way out: a snapshot
        written by an older build (or by hand) can hold an entity this port would now
        refuse, and serving it would either fail the response's schema or cite a
        source that cannot be checked.
        """
        entity = self.get_entity(tenant_id, entity_id)
        if entity is None:
            return None
        if not entity.source_ref or not entity.version:
            logger.warning("graph entity %s has no source; it is not retrievable", entity_id)
            return None
        if any(len(getattr(entity, attribute)) > maximum for attribute, maximum in WIRE_MAX.items()):
            logger.warning(
                "graph entity %s exceeds the retrieval item's field limits; it is not retrievable",
                entity_id,
            )
            return None
        return entity

    def _entity_of(self, node: Any) -> Entity:
        attributes = dict(node.attributes)
        source_ref = str(attributes.pop("source_ref", "") or "")
        version = str(attributes.pop("version", "") or "")
        return Entity(
            entity_id=node.entity_id,
            type=node.type,
            content=node.content,
            source_ref=source_ref,
            version=version,
            attributes=attributes,
        )

    def stats(self) -> GraphStats:
        nodes, edges, node_types, edge_types = self._open_engine().stats()
        return GraphStats(nodes=nodes, edges=edges, node_types=node_types, edge_types=edge_types)

    def health(self) -> Health:
        """Whether this store can answer: the snapshot is loaded, and how big it is."""
        if self._engine is None:
            return Health(ok=False, reason="graph_not_loaded")
        return Health(ok=True)
