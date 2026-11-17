"""The `GraphStore` port: the smallest method set retrieval and ingest need, and the
rules a second implementation has to keep (`docs/runtime-contract.md` §4.3).

The port exists so v0's embedded graph can be replaced by Postgres/Neo4j without
touching the Context API (the production decision is Postgres + pgvector; see
`docs/research/retrieval-index-selection.md` §5.1). What that costs is decided
here, once, and every implementation — today one — is held to it:

**Methods.** Reads are what retrieval needs and nothing more; writes are what a
rebuild needs. Each method takes `tenant_id` except `stats()`, because there is one
graph and its size is the deployment's, not a tenant's.

| Method | Contract |
| --- | --- |
| `open` / `close` | load the volume, or fail closed; never serve a half-opened store |
| `upsert_entities` | idempotent by `entity_id`; a repeat replaces the entity's content and attributes |
| `upsert_relationships` | idempotent by `(source, predicate, target)`; both ends must already exist |
| `delete_by_source` | remove one tenant's entities of one `source_ref` and the edges touching them |
| `get_entity` | one entity in the caller's tenant, or `None` (never another tenant's) |
| `lexical_search` | scored candidates, tenant-filtered, best first |
| `expand` | 1–`hops`-hop reachability from anchors, with the hop each entity was found at |
| `stats` | node and edge counts, for the scale limit and `/readyz` |
| `health` | whether the store can answer at all |

**Stable IDs.** Every method speaks `entity_id` (§4.2) and nothing else. Internal
identifiers — a Neo4j integer, a SQLite rowid, a Semantica node key that happens to
look like one — are not part of any signature, and no implementation may return
one in place of an `entity_id`. `app.graph.entity_id` owns the parse/render rules,
including the tenant segment a read filters on.

**Errors.** Three failure classes, because callers act on them differently:

- `InvalidEntity` / `InvalidRelationship` — the *caller* is wrong (a malformed id,
  a missing `source_ref` or `version`, a relationship with an unknown end, a
  cross-tenant edge). Ingest sees these as a bad batch and must not retry blindly.
- `GraphStoreClosed` — the store was used before `open()` or after `close()`.
- `GraphSnapshotError` / `GraphSchemaMismatch` (`app.graph.snapshot`) — the *volume*
  is wrong. Startup stops; the fix is a migration or a rebuild, never a retry.

Nothing in the port raises on "not found": a missing entity is `None`, a missing
expansion is an empty list. Only a wrong request or a broken volume is an error.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

#: Bumped when the port's method set or semantics change incompatibly. A second
#: implementation states which version it satisfies, so a backend written against
#: v1 cannot silently be wired into a service that expects v2.
PORT_VERSION = 1


class GraphStoreError(RuntimeError):
    """A refusal that comes from the store rather than from the data."""


class GraphStoreClosed(GraphStoreError):
    """The store is not open; nothing may be read or written through it."""


class InvalidEntity(GraphStoreError):
    """The entity cannot be kept: it would be unattributable or unanswerable."""


class InvalidRelationship(GraphStoreError):
    """The relationship cannot be kept: an end is unknown, foreign, or unreachable."""


@dataclass(frozen=True)
class Entity:
    """One node as the port sees it.

    `source_ref` and `version` are **required**: `RetrievalItem` requires both
    (§3.3), and an entity that cannot say where it came from at which version is
    not evidence a citation may point at. `attributes` is the open bag a mapping
    fills — `classification`, `source_kind`, `provenance_id` are read back into the
    wire item when present; anything else rides along in `metadata`.
    """

    entity_id: str
    type: str
    content: str
    source_ref: str
    version: str
    attributes: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class Relationship:
    """One edge. `weight` is the confidence the rank stage multiplies in, in `(0, 1]`."""

    source_id: str
    target_id: str
    predicate: str
    weight: float = 1.0


@dataclass(frozen=True)
class Match:
    """A lexical hit: the entity and the engine's own relevance score in `[0, 1]`."""

    entity_id: str
    score: float


@dataclass(frozen=True)
class Expansion:
    """An entity reached from a lexical anchor, and how far away it was.

    `anchor` is the lexical hit the walk started from, so a ranker can weight the
    reach by the anchor's own score instead of flattening every neighbourhood into
    one number. `weight` is the edge the engine reports along the way.
    """

    entity_id: str
    hop: int
    weight: float
    anchor: str


@dataclass(frozen=True)
class GraphStats:
    """What the volume holds. `node_types`/`edge_types` are for `/readyz` and operators."""

    nodes: int
    edges: int
    node_types: Mapping[str, int] = field(default_factory=dict)
    edge_types: Mapping[str, int] = field(default_factory=dict)


@dataclass(frozen=True)
class Health:
    """Whether the store can answer, and if not, why — the shape a probe reads."""

    ok: bool
    reason: str | None = None


class GraphStore(Protocol):
    """The port. `app.graph.embedded.EmbeddedGraphStore` is v0's only implementation."""

    @property
    def port_version(self) -> int: ...

    def open(self) -> None: ...

    def close(self) -> None: ...

    def upsert_entities(self, tenant_id: str, entities: Sequence[Entity]) -> int: ...

    def upsert_relationships(self, tenant_id: str, relationships: Sequence[Relationship]) -> int: ...

    def delete_by_source(self, tenant_id: str, source_ref: str) -> int: ...

    def get_entity(self, tenant_id: str, entity_id: str) -> Entity | None: ...

    def lexical_search(self, tenant_id: str, query: str, *, limit: int) -> list[Match]: ...

    def expand(
        self,
        tenant_id: str,
        anchors: Sequence[str],
        *,
        hops: int,
        limit: int,
    ) -> list[Expansion]: ...

    def stats(self) -> GraphStats: ...

    def health(self) -> Health: ...

