#!/usr/bin/env python3
"""Resume the 500k Neo4j load after a tool-level timeout.

The first process loaded the nodes sequentially and was killed before edges and
indexes.  This script appends the remaining nodes (id >= current count), loads
all edges, builds the two indexes, and records the remaining timings.
"""

from __future__ import annotations

import argparse
import logging
import re
import sys
import time
from pathlib import Path

import numpy as np
import orjson
from neo4j import GraphDatabase

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import data_dir, write_result  # noqa: E402

logging.disable(logging.CRITICAL)
logging.getLogger("neo4j").disabled = True
URI = "bolt://localhost:7687"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="500k")
    parser.add_argument("--out", default="neo4j-500k-load.json")
    args = parser.parse_args()
    root = data_dir(args.dataset)
    driver = GraphDatabase.driver(URI, auth=("neo4j", "testpass123"))

    def q(cypher, **params):
        with driver.session() as session:
            return session.run(cypher, **params).data()

    existing = q("MATCH (n:Entity) RETURN count(n) AS n")[0]["n"]
    print("existing nodes", existing, flush=True)
    entity_ids: list[str] = []
    embeddings = np.load(root / "embeddings_bge.npy", mmap_mode="r") if (root / "embeddings_bge.npy").exists() else np.load(root / "embeddings.npy", mmap_mode="r")

    started = time.perf_counter()
    batch = []
    loaded = 0
    with (root / "nodes.jsonl").open("rb") as fh:
        for line in fh:
            row = orjson.loads(line)
            i = row["id"]
            entity_ids.append(row["entity_id"])
            if i < existing:
                continue
            batch.append(
                {
                    "entity_id": row["entity_id"],
                    "id": i,
                    "type": row["type"],
                    "name": row["name"],
                    "text": row["text"],
                    "topic": row["topic"],
                    "tenant_id": row["tenant_id"],
                    "version": row["version"],
                    "embedding": np.asarray(embeddings[i], dtype=np.float32).tolist(),
                }
            )
            if len(batch) >= 2000:
                q("UNWIND $rows AS row CREATE (n:Entity) SET n = row", rows=batch)
                loaded += len(batch)
                batch = []
                print("loaded", loaded, flush=True)
    if batch:
        q("UNWIND $rows AS row CREATE (n:Entity) SET n = row", rows=batch)
        loaded += len(batch)
    nodes_s = time.perf_counter() - started
    print("nodes done", loaded, nodes_s, flush=True)

    edges_by_type: dict[str, list[dict]] = {}
    edge_count = 0
    with (root / "edges.jsonl").open("rb") as fh:
        for line in fh:
            row = orjson.loads(line)
            edges_by_type.setdefault(row["type"], []).append(row)
            edge_count += 1
    started = time.perf_counter()
    for rel_type, rows in edges_by_type.items():
        safe = re.sub(r"[^A-Za-z0-9_]", "_", rel_type)
        for start in range(0, len(rows), 5000):
            chunk = [
                {
                    "src": entity_ids[row["src"]],
                    "dst": entity_ids[row["dst"]],
                    "tenant_id": row["tenant_id"],
                }
                for row in rows[start:start + 5000]
            ]
            q(
                f"""
                UNWIND $rows AS row
                MATCH (a:Entity {{entity_id: row.src}}), (b:Entity {{entity_id: row.dst}})
                CREATE (a)-[r:{safe}]->(b)
                SET r.tenant_id = row.tenant_id
                """,
                rows=chunk,
            )
        print("edges type done", rel_type, len(rows), flush=True)
    edges_s = time.perf_counter() - started

    started = time.perf_counter()
    q("CREATE FULLTEXT INDEX entity_fulltext IF NOT EXISTS FOR (n:Entity) ON EACH [n.name, n.text]")
    while True:
        rows = q("SHOW INDEXES YIELD name, state WHERE name = 'entity_fulltext'")
        if rows and rows[0]["state"] == "ONLINE":
            break
        time.sleep(1)
    fulltext_s = time.perf_counter() - started
    started = time.perf_counter()
    q(
        "CREATE VECTOR INDEX entity_vector IF NOT EXISTS FOR (n:Entity) ON (n.embedding) "
        "OPTIONS {indexConfig: {`vector.dimensions`: 512, `vector.similarity_function`: 'cosine'}}"
    )
    while True:
        rows = q("SHOW INDEXES YIELD name, state WHERE name = 'entity_vector'")
        if rows and rows[0]["state"] == "ONLINE":
            break
        time.sleep(2)
    vector_s = time.perf_counter() - started

    result = {
        "backend": "neo4j",
        "dataset": args.dataset,
        "resumed_from_nodes": existing,
        "nodes_added": loaded,
        "nodes_total": existing + loaded,
        "edges": edge_count,
        "nodes_s": round(nodes_s, 3),
        "edges_s": round(edges_s, 3),
        "index_fulltext_s": round(fulltext_s, 3),
        "index_vector_s": round(vector_s, 3),
    }
    write_result(args.out, result)
    print(result, flush=True)


if __name__ == "__main__":
    main()
