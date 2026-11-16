#!/usr/bin/env python3
"""Neo4j 5.26 benchmark: full-text + native vector index on one graph store.

Schema
------
(:Entity {entity_id, id, type, name, text, topic, tenant_id, version, embedding})
[:REL_TYPE {tenant_id}]  (typed relationship per source type vocabulary)

Queries are measured in three modes (keyword/full-text, vector, hybrid RRF),
then optionally expanded two hops from the top five candidate anchors.

Usage:
    python bench_neo4j.py --dataset 100k --reset --out neo4j-100k.json
"""

from __future__ import annotations

import argparse
import logging
import random
import re
import time
from pathlib import Path

import numpy as np
import orjson
from fastembed import TextEmbedding
from neo4j import GraphDatabase

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    MemorySampler,
    container_disk_mb,
    data_dir,
    latency_stats,
    load_queries,
    pct,
    queries_for_mode,
    recall_at_k,
    rrf,
    write_result,
)

logging.getLogger("neo4j").setLevel(logging.ERROR)

URI = "bolt://localhost:7687"
USER = "neo4j"
PASSWORD = "testpass123"
EMBED_MODEL = "minishlab/potion-retrieval-32M"
DIM = 512
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
    "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
    "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
}


def lucene_all_terms(text: str) -> str:
    terms = [t for t in re.findall(r"[A-Za-z0-9]+", text.lower()) if t not in STOPWORDS]
    return " ".join(f"+{t}" for t in terms) or "*"


class Neo4jBench:
    def __init__(self, dataset: str):
        self.dataset = dataset
        self.root = data_dir(dataset)
        self.driver = GraphDatabase.driver(URI, auth=(USER, PASSWORD))
        self.embedder = TextEmbedding(model_name=EMBED_MODEL, threads=4)
        self.queries = load_queries(dataset)
        self.query_vectors = self._embed_queries()

    def _embed_queries(self) -> dict[str, np.ndarray]:
        texts = []
        keys = []
        for q in self.queries:
            if q["paraphrase"]:
                keys.append(q["qid"] + ":pp")
                texts.append(q["paraphrase"])
            if q["keyword"]:
                keys.append(q["qid"] + ":kw")
                texts.append(q["keyword"])
        vectors = {}
        for key, vec in zip(keys, self.embedder.embed(texts, batch_size=64)):
            arr = np.asarray(vec, dtype=np.float32)
            vectors[key] = arr / max(float(np.linalg.norm(arr)), 1e-9)
        return vectors

    def q(self, cypher: str, **params):
        with self.driver.session() as session:
            return session.run(cypher, **params).data()

    def reset(self) -> None:
        self.q("CALL { MATCH (n) DETACH DELETE n } IN TRANSACTIONS OF 10000 ROWS")
        for name in ("entity_fulltext", "entity_vector"):
            try:
                self.q(f"DROP INDEX {name} IF EXISTS")
            except Exception:
                pass

    def wait_index(self, name: str, timeout: float = 900) -> float:
        started = time.perf_counter()
        while time.perf_counter() - started < timeout:
            rows = self.q("SHOW INDEXES YIELD name, state, populationPercent")
            for row in rows:
                if row["name"] == name and row["state"] == "ONLINE":
                    return time.perf_counter() - started
            time.sleep(1.0)
        raise TimeoutError(f"index {name} not online")

    def load(self) -> dict:
        self.q(
            "CREATE CONSTRAINT entity_id_unique IF NOT EXISTS "
            "FOR (n:Entity) REQUIRE n.entity_id IS UNIQUE"
        )
        embeddings = np.load(self.root / "embeddings.npy", mmap_mode="r")
        batch = []
        node_rows = 0
        entity_ids: list[str] = []
        started = time.perf_counter()
        with (self.root / "nodes.jsonl").open("rb") as fh:
            for line in fh:
                row = orjson.loads(line)
                i = row["id"]
                entity_ids.append(row["entity_id"])
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
                if len(batch) >= 1000:
                    self.q("UNWIND $rows AS row CREATE (n:Entity) SET n = row", rows=batch)
                    node_rows += len(batch)
                    batch = []
        if batch:
            self.q("UNWIND $rows AS row CREATE (n:Entity) SET n = row", rows=batch)
            node_rows += len(batch)
        nodes_s = time.perf_counter() - started

        edges_by_type: dict[str, list[dict]] = {}
        edge_rows = 0
        started = time.perf_counter()
        with (self.root / "edges.jsonl").open("rb") as fh:
            for line in fh:
                row = orjson.loads(line)
                edges_by_type.setdefault(row["type"], []).append(row)
                edge_rows += 1
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
                self.q(
                    f"""
                    UNWIND $rows AS row
                    MATCH (a:Entity {{entity_id: row.src}}), (b:Entity {{entity_id: row.dst}})
                    CREATE (a)-[r:{safe}]->(b)
                    SET r.tenant_id = row.tenant_id
                    """,
                    rows=chunk,
                )
        edges_s = time.perf_counter() - started

        started = time.perf_counter()
        self.q("CREATE FULLTEXT INDEX entity_fulltext IF NOT EXISTS FOR (n:Entity) ON EACH [n.name, n.text]")
        fulltext_s = self.wait_index("entity_fulltext")
        self.q(
            "CREATE VECTOR INDEX entity_vector IF NOT EXISTS FOR (n:Entity) ON (n.embedding) "
            "OPTIONS {indexConfig: {`vector.dimensions`: 512, `vector.similarity_function`: 'cosine'}}"
        )
        vector_s = self.wait_index("entity_vector")
        index_total = time.perf_counter() - started

        return {
            "nodes": node_rows,
            "edges": edge_rows,
            "ingest_nodes_s": round(nodes_s, 3),
            "ingest_edges_s": round(edges_s, 3),
            "index_fulltext_s": round(fulltext_s, 3),
            "index_vector_s": round(vector_s, 3),
            "index_total_s": round(index_total, 3),
        }

    # ------------------------------------------------------------------
    def lexical(self, text: str, tenant: str = "acme", limit: int = 50) -> list[str]:
        rows = self.q(
            """
            CALL db.index.fulltext.queryNodes('entity_fulltext', $lucene, {limit: 100})
            YIELD node, score
            WHERE node.tenant_id = $tenant
            RETURN node.entity_id AS entity_id
            LIMIT $limit
            """,
            lucene=lucene_all_terms(text),
            tenant=tenant,
            limit=limit,
        )
        return [r["entity_id"] for r in rows]

    def vector(self, vec: np.ndarray, tenant: str = "acme", limit: int = 50, k: int = 100) -> list[str]:
        rows = self.q(
            """
            CALL db.index.vector.queryNodes('entity_vector', $k, $vec)
            YIELD node, score
            WHERE node.tenant_id = $tenant
            RETURN node.entity_id AS entity_id
            LIMIT $limit
            """,
            k=k,
            vec=vec.tolist(),
            tenant=tenant,
            limit=limit,
        )
        return [r["entity_id"] for r in rows]

    def expand(self, anchors: list[str], tenant: str = "acme", limit: int = 40) -> list[str]:
        if not anchors:
            return []
        rows = self.q(
            """
            UNWIND $anchors AS anchor
            MATCH (n:Entity {entity_id: anchor})-[*1..2]-(m:Entity)
            WHERE m.tenant_id = $tenant
            RETURN DISTINCT m.entity_id AS entity_id
            LIMIT $limit
            """,
            anchors=anchors,
            tenant=tenant,
            limit=limit,
        )
        return [r["entity_id"] for r in rows]

    def query_embedding(self, q: dict, field: str) -> tuple[np.ndarray, float]:
        text = q["paraphrase"] if field == "paraphrase" else q["keyword"]
        started = time.perf_counter()
        arr = np.asarray(next(self.embedder.embed([text], batch_size=1)), dtype=np.float32)
        arr = arr / max(float(np.linalg.norm(arr)), 1e-9)
        return arr, (time.perf_counter() - started) * 1000


def measured_loop(
    bench: Neo4jBench,
    mode: str,
    n_warmup: int,
    n_measured: int,
    seed: int = 7,
) -> dict:
    rng = random.Random(seed)
    pool = queries_for_mode(bench.queries, mode)
    latencies: list[float] = []
    recalls: list[float] = []
    embed_ms: list[float] = []
    failures = 0

    def one(q: dict) -> tuple[list[str], float]:
        nonlocal failures
        started = time.perf_counter()
        try:
            if mode == "keyword":
                ids = bench.lexical(q["keyword"])
                emb = 0.0
            elif mode == "vector":
                vec, emb = bench.query_embedding(q, "paraphrase")
                ids = bench.vector(vec)
            else:
                vec, emb = bench.query_embedding(q, "paraphrase")
                lex = bench.lexical(q["keyword"])
                vc = bench.vector(vec)
                ids = rrf([lex, vc], k=60, limit=50)
            return ids, emb
        except Exception:
            failures += 1
            return [], 0.0
        finally:
            latencies.append((time.perf_counter() - started) * 1000)

    for _ in range(n_warmup):
        q = rng.choice(pool)
        one(q)
    latencies.clear()
    for _ in range(n_measured):
        q = rng.choice(pool)
        ids, emb = one(q)
        embed_ms.append(emb)
        recalls.append(recall_at_k(ids, q["relevant"], k=10))

    return {
        "latency_ms": latency_stats(latencies),
        "recall_at_10": round(float(np.mean(recalls)) if recalls else 0.0, 4),
        "embed_ms": latency_stats(embed_ms),
        "failures": failures,
    }


def end_to_end(
    bench: Neo4jBench,
    mode: str,
    n_warmup: int,
    n_measured: int,
    seed: int = 11,
) -> dict:
    rng = random.Random(seed)
    pool = queries_for_mode(bench.queries, mode)
    samples: list[float] = []
    failures = 0

    def one(q: dict) -> None:
        nonlocal failures
        started = time.perf_counter()
        try:
            if mode == "keyword":
                ids = bench.lexical(q["keyword"])
            elif mode == "vector":
                vec, _ = bench.query_embedding(q, "paraphrase")
                ids = bench.vector(vec)
            else:
                vec, _ = bench.query_embedding(q, "paraphrase")
                ids = rrf([bench.lexical(q["keyword"]), bench.vector(vec)], k=60, limit=50)
            bench.expand(ids[:5])
        except Exception:
            failures += 1
        finally:
            samples.append((time.perf_counter() - started) * 1000)

    for _ in range(n_warmup):
        one(rng.choice(pool))
    samples.clear()
    for _ in range(n_measured):
        one(rng.choice(pool))
    return {"latency_ms": latency_stats(samples), "failures": failures}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", default=None)
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--skip-load", action="store_true")
    parser.add_argument("--warmup", type=int, default=100)
    parser.add_argument("--measured", type=int, default=500)
    parser.add_argument("--expand-n", type=int, default=200)
    parser.add_argument("--cold-start-s", type=float, default=None)
    parser.add_argument("--degradation", action="store_true")
    args = parser.parse_args()

    bench = Neo4jBench(args.dataset)
    result = {
        "backend": "neo4j",
        "dataset": args.dataset,
        "versions": {"neo4j": "5.26.0-community"},
        "container": {
            "memory_limit": "6g",
            "heap": "2g",
            "pagecache": "512m",
        },
        "cold_start_s": args.cold_start_s,
        "index_params": {
            "fulltext_analyzer": "standard (default)",
            "vector": {"dimensions": 512, "similarity": "cosine", "hnsw": "defaults"},
        },
        "query_params": {"candidate_k": 50, "vector_ann_k": 100, "rrf_k": 60,
                         "expand_anchors": 5, "expand_limit": 40},
        "warmup": args.warmup,
        "measured": args.measured,
    }
    if args.reset:
        bench.reset()

    with MemorySampler("fde-ret-neo4j", 1.0) as sampler:
        if not args.skip_load:
            result["load"] = bench.load()
        else:
            result["load"] = {"skipped": True}

        for mode in ("keyword", "vector", "hybrid"):
            logging.info("measuring %s", mode)
            result.setdefault("modes", {})[mode] = measured_loop(
                bench, mode, args.warmup, args.measured
            )
            result["modes"][mode]["end_to_end"] = end_to_end(
                bench, mode, 20, args.expand_n
            )

        time.sleep(3)
        result["memory_mb"] = {"peak": sampler.peak_mb, "idle": sampler.idle_mb}

    result["disk_mb"] = container_disk_mb(
        "fde-ret-neo4j", ["/data/databases", "/data/transactions"]
    )
    result["counts"] = {
        "nodes": bench.q("MATCH (n:Entity) RETURN count(n) AS n")[0]["n"],
        "edges": bench.q("MATCH ()-[r]->() RETURN count(r) AS n")[0]["n"],
    }

    if args.degradation:
        deg = {}
        # Vector index unavailable: lexical fallback.
        try:
            bench.q("DROP INDEX entity_vector IF EXISTS")
        except Exception as exc:
            deg["drop_vector_error"] = str(exc)
        lat = []
        fails = 0
        for q in queries_for_mode(bench.queries, "vector")[:100]:
            started = time.perf_counter()
            try:
                bench.vector(bench.query_embedding(q, "paraphrase")[0])
            except Exception:
                fails += 1
            lat.append((time.perf_counter() - started) * 1000)
        deg["vector_index_dropped"] = {"failures": fails, "latency_ms": latency_stats(lat)}
        deg["lexical_fallback"] = measured_loop(bench, "keyword", 20, 200)
        # Full-text index unavailable too.
        try:
            bench.q("DROP INDEX entity_fulltext IF EXISTS")
        except Exception as exc:
            deg["drop_fulltext_error"] = str(exc)
        lat = []
        fails = 0
        for q in queries_for_mode(bench.queries, "keyword")[:50]:
            started = time.perf_counter()
            try:
                bench.lexical(q["keyword"])
            except Exception:
                fails += 1
            lat.append((time.perf_counter() - started) * 1000)
        deg["all_indexes_dropped"] = {"failures": fails, "latency_ms": latency_stats(lat)}
        result["degradation"] = deg

    bench.driver.close()
    out = args.out or f"neo4j-{args.dataset}.json"
    write_result(out, result)


if __name__ == "__main__":
    main()
