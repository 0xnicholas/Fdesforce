# PROTOTYPE — generated skeleton.
# Source: docs/runtime-contract.md §4.3 (GraphStore port)
# GAP: `GraphStore` is described but never defined as an interface. This class
# is the prototype's attempted port; it must not leak Semantica/backend IDs.
import json
from pathlib import Path
from typing import Any

from .. import settings


class GraphStore:
    def __init__(self, path: Path | None = None) -> None:
        self.path = path or settings.GRAPH_PATH
        self.nodes: dict[str, dict[str, Any]] = {}
        self.edges: list[dict[str, Any]] = []

    def load(self) -> None:
        if self.path.exists():
            payload = json.loads(self.path.read_text())
            self.nodes = payload.get("nodes", {})
            self.edges = payload.get("edges", [])

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"nodes": self.nodes, "edges": self.edges}, indent=2))

    def track_entity(self, entity_id: str, type_name: str, properties: dict[str, Any]) -> None:
        self.nodes[entity_id] = {"type": type_name, "properties": properties}

    def track_relationship(self, source: str, predicate: str, target: str, provenance: dict[str, Any]) -> None:
        self.edges.append(
            {"source": source, "predicate": predicate, "target": target, "provenance": provenance}
        )

    def size(self) -> dict[str, int]:
        return {"nodes": len(self.nodes), "edges": len(self.edges)}
