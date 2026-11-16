#!/usr/bin/env python3
"""Runtime probe for semantica.graph_store.Neo4jStore (0.7.0).

Reproduces the ticket-#5 adapter measurements (500 nodes / 1000 relationships)
and contrasts them with a bulk UNWIND load, which is what a serving adapter
must use.  Also records the ID semantics and the index-type surface.

    python probes/semantica_neo4j_adapter_probe.py --out results/...
"""

from __future__ import annotations

import argparse
import json
import logging
import random
import sys
import time
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from common import MemorySampler, docker_running, write_result  # noqa: E402
from neo4j import GraphDatabase  # noqa: E402
from semantica.graph_store import Neo4jStore  # noqa: E402

warnings.filterwarnings("ignore")
logging.disable(logging.CRITICAL)
logging.getLogger("neo4j").disabled = True

URI = "bolt://localhost:7687"
USER = "neo4j"
PASSWORD = "testpass123"


def pct(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    return round(xs[min(len(xs) - 1, int(len(xs) * p))], 3) if xs else 0.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="results/semantica_neo4j_adapter_probe.json")
    parser.add_argument("--bulk-nodes", type=int, default=100_000)
    parser.add_argument("--bulk-edges", type=int, default=500_000)
    args = parser.parse_args()

    if not docker_running("fde-ret-neo4j"):
        raise SystemExit("fde-ret-neo4j is not running")

    driver = GraphDatabase.driver(URI, auth=(USER, PASSWORD))
    with driver.session() as session:
        session.run("MATCH (n) DETACH DELETE n").consume()

    store = Neo4jStore(uri=URI, user=USER, password=PASSWORD, database="neo4j")
    result: dict = {"backend": "semantica_neo4j_store", "semantica_version": "0.7.0"}
    rng = random.Random(7)

    with MemorySampler("fde-ret-neo4j", 1.0) as sampler:
        # Ticket #5 reproduction: one CREATE + one transaction per node.
        started = time.perf_counter()
        ids: list[int] = []
        for i in range(500):
            node = store.create_node(
                labels=["Entity"],
                properties={
                    "entity_id": f"probe:n:{i}",
                    "tenant_id": "probe",
                    "name": f"entity {i}",
                    "text": f"probe entity {i} refund policy region {i % 17}",
                },
            )
            ids.append(node["id"])
        result["sequential_create_nodes_s"] = round(time.perf_counter() - started, 3)
        result["sequential_create_nodes_per_s"] = round(500 / result["sequential_create_nodes_s"], 1)

        started = time.perf_counter()
        created = 0
        for i in range(1000):
            a = rng.choice(ids)
            b = rng.choice(ids)
            if a == b:
                continue
            try:
                store.create_relationship(a, b, "RELATED", {"tenant_id": "probe"})
                created += 1
            except Exception:
                pass
        result["sequential_create_relationships_s"] = round(time.perf_counter() - started, 3)
        result["sequential_create_relationships_count"] = created
        result["sequential_create_relationships_per_s"] = round(
            created / result["sequential_create_relationships_s"], 1
        )

        samples = []
        for _ in range(100):
            t = time.perf_counter()
            store.get_neighbors(rng.choice(ids), depth=1)
            samples.append((time.perf_counter() - t) * 1000)
        result["get_neighbors_1hop_ms"] = {"p50": pct(samples, 0.5), "p95": pct(samples, 0.95)}

        # Batch helper: still one CREATE per node inside a single session.
        started = time.perf_counter()
        store.create_nodes(
            [
                {
                    "labels": ["Entity"],
                    "properties": {
                        "entity_id": f"probe:batch:{i}",
                        "tenant_id": "probe",
                        "name": f"batch entity {i}",
                    },
                }
                for i in range(500)
            ]
        )
        result["create_nodes_batch_500_s"] = round(time.perf_counter() - started, 3)

        sample = store.get_node(ids[0])
        result["id_semantics"] = {
            "returned_id_type": type(sample["id"]).__name__,
            "returned_id": sample["id"],
            "entity_id_property": sample["properties"].get("entity_id"),
            "relationship_lookup_by_entity_id": None,
        }
        try:
            store.create_relationship("probe:n:0", "probe:n:1", "RELATED")
            result["id_semantics"]["relationship_lookup_by_entity_id"] = "unexpected success"
        except Exception as exc:  # expected
            result["id_semantics"]["relationship_lookup_by_entity_id"] = f"{type(exc).__name__}: {exc}"

        result["id_semantics"]["get_neighbors_argument"] = "internal integer id"
        try:
            store.get_neighbors("probe:n:0", depth=1)
            result["id_semantics"]["get_neighbors_by_entity_id"] = "unexpected success"
        except Exception as exc:
            result["id_semantics"]["get_neighbors_by_entity_id"] = f"{type(exc).__name__}: {exc}"

        # Index helper: only btree/fulltext branches exist; no vector branch.
        try:
            store.create_index("Entity", "embedding", "vector")
            result["create_index_vector"] = "created a non-vector index (unexpected semantic)"
        except Exception as exc:
            result["create_index_vector"] = f"{type(exc).__name__}: {exc}"

        # Bulk path a serving adapter must use.  The stable-ID constraint is
        # mandatory: without it the edge MATCH below is a 100k x 500k scan.
        with driver.session() as session:
            session.run("MATCH (n:Bulk) DETACH DELETE n").consume()
            session.run(
                "CREATE CONSTRAINT bulk_entity_id IF NOT EXISTS "
                "FOR (n:Bulk) REQUIRE n.entity_id IS UNIQUE"
            ).consume()
        rows = [
            {
                "entity_id": f"bulk:n:{i}",
                "tenant_id": "probe",
                "name": f"bulk {i}",
                "text": f"bulk entity {i}",
            }
            for i in range(args.bulk_nodes)
        ]
        started = time.perf_counter()
        with driver.session() as session:
            for start in range(0, len(rows), 5000):
                session.run(
                    "UNWIND $rows AS row CREATE (n:Bulk) SET n = row",
                    {"rows": rows[start:start + 5000]},
                ).consume()
        result["bulk_unwind_nodes_s"] = round(time.perf_counter() - started, 3)
        result["bulk_unwind_nodes"] = len(rows)
        result["bulk_unwind_nodes_per_s"] = round(len(rows) / result["bulk_unwind_nodes_s"], 1)

        edges = []
        for i in range(args.bulk_edges):
            a = rng.randrange(args.bulk_nodes)
            b = rng.randrange(args.bulk_nodes)
            if a == b:
                b = (b + 1) % args.bulk_nodes
            edges.append({"src": f"bulk:n:{a}", "dst": f"bulk:n:{b}", "type": "RELATED"})
        started = time.perf_counter()
        with driver.session() as session:
            for start in range(0, len(edges), 5000):
                session.run(
                    """
                    UNWIND $rows AS row
                    MATCH (a:Bulk {entity_id: row.src}), (b:Bulk {entity_id: row.dst})
                    CREATE (a)-[r:RELATED]->(b)
                    SET r.tenant_id = 'probe'
                    """,
                    {"rows": edges[start:start + 5000]},
                ).consume()
        result["bulk_unwind_edges_s"] = round(time.perf_counter() - started, 3)
        result["bulk_unwind_edges"] = len(edges)
        result["bulk_unwind_edges_per_s"] = round(len(edges) / result["bulk_unwind_edges_s"], 1)
        result["memory_peak_mb"] = sampler.peak_mb

    result["extrapolation"] = {
        "adapter_100k_nodes_minutes": round(result["sequential_create_nodes_s"] / 500 * 100_000 / 60, 1),
        "adapter_500k_edges_minutes": round(
            result["sequential_create_relationships_s"] / created * 500_000 / 60, 1
        ),
        "bulk_100k_nodes_minutes": round(result["bulk_unwind_nodes_s"] / args.bulk_nodes * 100_000 / 60, 2),
        "bulk_500k_edges_minutes": round(result["bulk_unwind_edges_s"] / args.bulk_edges * 500_000 / 60, 2),
    }
    driver.close()
    store.close()
    write_result(args.out, result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
