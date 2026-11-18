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
| `delete_source_ref` | remove one tenant's entities of one `source_ref` and the edges touching them |
| `delete_source` | remove one tenant's entities of one Context Source id — the `rebuild` path |
| `get_entity` | one entity in the caller's tenant, or `None` (never another tenant's) |
| `lexical_search` | tenant-filtered hits, optionally narrowed to one source/type, best first |
| `expand` | 1–`hops`-hop reachability from anchors, optionally limited to a relation whitelist |
| `stats` | node and edge counts, for the scale limit and `/readyz` |
| `health` | whether the store can answer at all |

**`expand` and the recipe's relations.** The graph stage traverses only the relations
its recipe declares (`docs/semantic-modeling.md` §6.2), so `predicates` is a whitelist
applied at every hop, and each `Expansion` reports the relation that reached it. A
port that could not narrow the walk would make the recipe's `relations` a comment.

**`lexical_search` narrows before it counts.** `source` and `entity_type` are filters
applied *before* `limit` is counted, not predicates a caller re-applies afterwards.
The lexical stage's `topK` is "the query's matches inside the recipe's declared
source", and the resolve fallback searches "inside the recipe's class": a port that
let another source's or class's higher-ranked head consume the limit would make both
stages' declarations decorative.

**Stable IDs.** Every method speaks `entity_id` (§4.2) and nothing else. Internal
identifiers — a Neo4j integer, a SQLite rowid, a Semantica node key that happens to
look like one — are not part of any signature, and no implementation may return
one in place of an `entity_id`. `app.graph.entity_id` owns the parse/render rules,
including the tenant segment a read filters on.

**What a read returns.** Only entities that can become a `RetrievalItem`: a stable
attributable id, a `source_ref` and `version` that can be cited, and fields inside the
wire's maxima. An implementation that kept an entity this port would refuse on write
must not serve it either — which is why the embedded store filters on the way out
(`_usable`), not only on the way in.

**Errors.** Three failure classes, because callers act on them differently:

- `InvalidEntity` / `InvalidRelationship` — the *caller* is wrong (a malformed id,
  a missing `source_ref` or `version`, a field the wire cannot carry, a relationship
  with an unknown end, a cross-tenant edge). Ingest sees these as a bad batch and
  must not retry blindly.
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
#: v2 cannot silently be wired into a service that expects v3.
PORT_VERSION = 3


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

    `anchor` is the entity the walk started from — the recipe's resolved entity, so a
    ranker can weight the reach by the anchor's own score instead of flattening every
    neighbourhood into one number. `weight` is the edge the engine reports along the
    way, and `predicate` the relation it was reached by, which is how a retrieval can
    say *why* a fact is in the answer.
    """

    entity_id: str
    hop: int
    weight: float
    anchor: str
    predicate: str = ""


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

    def delete_source_ref(self, tenant_id: str, source_ref: str) -> int: ...

    def delete_source(self, tenant_id: str, source_id: str) -> int: ...

    def get_entity(self, tenant_id: str, entity_id: str) -> Entity | None: ...

    def lexical_search(
        self,
        tenant_id: str,
        query: str,
        *,
        limit: int,
        source: str | None = None,
        entity_type: str | None = None,
    ) -> list[Match]: ...

    def expand(
        self,
        tenant_id: str,
        anchors: Sequence[str],
        *,
        hops: int,
        limit: int,
        predicates: Sequence[str] | None = None,
    ) -> list[Expansion]: ...

    def stats(self) -> GraphStats: ...

    def health(self) -> Health: ...

