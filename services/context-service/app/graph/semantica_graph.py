"""The Semantica adapter: the one module in this service that imports the engine.

`docs/research/semantic-layer-selection.md` §5.4 asks for exactly this — all calls
into Semantica behind one adapter, no engine types in the Context API — and
`scripts/semantica_surface.py` enforces it: every other module is checked to have
no `semantica` import, and every name imported here is checked against the pinned
0.7.x wheel's export surface before CI goes green. Upgrading the engine therefore
shows up as a diff in one file plus a manifest, instead of as a runtime surprise in
a request path.

What the adapter deliberately does **not** use:

- `ContextGraph.save_to_file` / `load_from_file` — the volume file carries the
  platform's schema envelope (`app.graph.snapshot`), which the engine's own
  serializer would overwrite. The payload half is still the engine's own `to_dict()`
  shape, so `ContextGraph.load_from_file` can read it.
- The decision/PROV-O machinery. `docs/research/semantic-layer-selection.md` §3.6
  records that `DecisionRecorder`'s provenance wiring is broken in 0.7.0
  (`track_entity(source_documents=...)`, a nonexistent `track_activity`, both
  swallowed by `except Exception`). Decisions and their provenance are this
  service's own audit store (#37); the engine is a graph here and nothing else.
- `advanced_analytics` — it initialises Node2Vec/KG components that warn about
  optional dependencies (`gensim`) on every construction and are never used by a
  retrieval. Off keeps construction cheap and the service log honest.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from semantica.context import ContextGraph

logger = logging.getLogger("fde.context_service.graph.semantica")


@dataclass(frozen=True)
class EngineNode:
    """One node, as the engine holds it."""

    entity_id: str
    type: str
    content: str
    attributes: Mapping[str, Any]


class EngineGraph:
    """A thin, id-only wrapper over `ContextGraph`.

    Every method speaks the stable `entity_id`; the engine's own node objects do
    not leave this module. The wrapper is intentionally boring: it exists to be
    the one place where a Semantica upgrade is read, and to keep the engine's
    optional machinery out of the request path.
    """

    def __init__(self) -> None:
        self._graph = ContextGraph(advanced_analytics=False)

    # -- lifecycle --------------------------------------------------------

    @property
    def graph_id(self) -> str:
        return str(self._graph.graph_id)

    def load(self, document: Mapping[str, Any]) -> None:
        """Replace this graph with the snapshot's payload.

        A fresh `ContextGraph` rather than `clear()`: the snapshot is the volume's
        whole truth, and a load that started from the previous contents could keep
        an entity the snapshot no longer has.
        """
        self._graph = ContextGraph(advanced_analytics=False)
        if isinstance(document.get("graph_id"), str):
            self._graph.graph_id = str(document["graph_id"])
        self._graph.add_nodes(list(document.get("nodes") or []))
        self._graph.add_edges(list(document.get("edges") or []))

    def payload(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
        """`(nodes, edges)` in the engine's own serialized shape."""
        raw = self._graph.to_dict()
        return list(raw.get("nodes") or []), list(raw.get("edges") or [])

    def replace(self, nodes: Sequence[Mapping[str, Any]], edges: Sequence[Mapping[str, Any]]) -> None:
        """Replace the graph's contents, keeping its `graph_id`.

        Used by a rebuild (`delete_by_source`): the volume's identity survives a
        change to what it holds, so a backup and a log line can still name it.
        """
        graph_id = self.graph_id
        self._graph = ContextGraph(advanced_analytics=False)
        self._graph.graph_id = graph_id
        self._graph.add_nodes([dict(node) for node in nodes])
        self._graph.add_edges([dict(edge) for edge in edges])

    def document(self, *, written_at: str, schema: Mapping[str, str]) -> dict[str, Any]:
        """The snapshot envelope: the platform's stamp plus the engine's payload."""
        nodes, edges = self.payload()
        return {
            "fde_schema": dict(schema),
            "graph_id": self.graph_id,
            "written_at": written_at,
            "nodes": nodes,
            "edges": edges,
        }

    # -- write ------------------------------------------------------------

    def upsert_node(
        self,
        entity_id: str,
        *,
        type: str,
        content: str,
        attributes: Mapping[str, Any],
    ) -> None:
        """Add the node, or replace it: `add_node` on an existing id rewrites it."""
        self._graph.add_node(entity_id, type, content, **dict(attributes))

    def has_node(self, entity_id: str) -> bool:
        return bool(self._graph.has_node(entity_id))

    def link(self, source_id: str, target_id: str, *, predicate: str, weight: float) -> bool:
        """Add the edge; `False` when this `(source, predicate, target)` already exists.

        The engine refuses to invent an endpoint, but it does *not*: an edge to an
        unknown id creates a placeholder node. `EmbeddedGraphStore` therefore
        checks both ends before calling this, and the port's contract says so.
        """
        return bool(self._graph.add_edge(source_id, target_id, predicate, weight))

    # -- read -------------------------------------------------------------

    def node(self, entity_id: str) -> EngineNode | None:
        node = self._graph.nodes.get(entity_id)
        if node is None or not getattr(node, "is_active", True):
            return None
        attributes = dict(node.properties or {})
        content = str(node.content or attributes.pop("content", "") or "")
        return EngineNode(
            entity_id=str(node.node_id),
            type=str(node.node_type),
            content=content,
            attributes=attributes,
        )

    def search(self, text: str, *, limit: int) -> list[tuple[str, float]]:
        """Lexical candidates, best first. The engine scans; 10k nodes is the v0 ceiling."""
        results = self._graph.query(text, limit=limit)
        candidates: list[tuple[str, float]] = []
        for result in results:
            node = result.get("node") or {}
            entity_id = node.get("id")
            if not isinstance(entity_id, str):
                continue
            score = result.get("score")
            candidates.append((entity_id, _clamp(float(score) if isinstance(score, (int, float)) else 0.0)))
        return candidates

    def neighbours(self, entity_id: str, *, hops: int, limit: int) -> list[tuple[str, int, float]]:
        """Everything reachable within `hops`, with the hop it was first reached at."""
        results = self._graph.get_neighbors(entity_id, hops=hops, limit=limit)
        reached: list[tuple[str, int, float]] = []
        for result in results:
            reached_id = result.get("id")
            if not isinstance(reached_id, str) or reached_id == entity_id:
                continue
            hop = result.get("hop")
            weight = result.get("weight")
            reached.append(
                (
                    reached_id,
                    int(hop) if isinstance(hop, int) else 1,
                    _clamp(float(weight) if isinstance(weight, (int, float)) else 1.0, floor=0.0),
                )
            )
        return reached

    def stats(self) -> tuple[int, int, Mapping[str, int], Mapping[str, int]]:
        raw = self._graph.stats()
        return (
            int(raw.get("node_count", 0)),
            int(raw.get("edge_count", 0)),
            {str(key): int(value) for key, value in (raw.get("node_types") or {}).items()},
            {str(key): int(value) for key, value in (raw.get("edge_types") or {}).items()},
        )


def _clamp(value: float, *, floor: float = 0.0) -> float:
    """Keep engine scores inside the wire's `[0, 1]` — a score outside it is not a number to trust."""
    return max(floor, min(1.0, value))
