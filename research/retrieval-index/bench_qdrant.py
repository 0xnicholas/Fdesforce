#!/usr/bin/env python3
"""Qdrant 1.12.5 vector-index benchmark, optionally fused with Neo4j graph.

The Qdrant collection stores 512-d cosine vectors and a small payload
(entity_id/type/tenant_id).  Graph traversal and lexical recall stay in Neo4j.
"""

from __future__ import annotations

import argparse
import logging
import random
import re
import sys
import time
from pathlib import Path

import numpy as np
import orjson
from fastembed import TextEmbedding
from neo4j import GraphDatabase
from qdrant_client import QdrantClient, models

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (  # noqa: E402
    MemorySampler,
    container_disk_mb,
    data_dir,
    latency_stats,
    load_queries,
    queries_for_mode,
    recall_at_k,
    rrf,
    write_result,
)

logging.disable(logging.CRITICAL)
logging.getLogger("neo4j").disabled = True
logging.getLogger("qdrant_client").disabled = True

QDRANT_URL = "http://localhost:6333"
NEO4J_URI = "bolt://localhost:7687"
EMBED_MODEL = "minishlab/potion-retrieval-32M"
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
    "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
    "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
}


def lucene_all_terms(text: str) -> str:
    terms = [t for t in re.findall(r"[A-Za-z0-9]+", text.lower()) if t not in STOPWORDS]
    return " ".join(f"+{t}" for t in terms) or "*"


class QdrantBench:
    def __init__(self, dataset: str, graph: bool):
        self.dataset = dataset
        self.root = data_dir(dataset)
        self.collection = f"fde_entities_{dataset}"
        self.client = QdrantClient(url=QDRANT_URL, timeout=600)
        self.embedder = TextEmbedding(model_name=EMBED_MODEL, threads=4)
        self.queries = load_queries(dataset)
        self.graph = graph
        self.driver = GraphDatabase.driver(NEO4J_URI, auth=("neo4j", "testpass123")) if graph else None

    def q(self, cypher: str, **params):
        with self.driver.session() as session:
            return session.run(cypher, **params).data()

    def create(self) -> None:
        try:
            self.client.delete_collection(self.collection)
        except Exception:
            pass
        self.client.create_collection(
            collection_name=self.collection,
            vectors_config=models.VectorParams(
                size=512, distance=models.Distance.COSINE
            ),
            hnsw_config=models.HnswConfigDiff(m=16, ef_construct=100),
        )
        for field in ("tenant_id", "type"):
            self.client.create_payload_index(
                collection_name=self.collection,
                field_name=field,
                field_schema=models.PayloadSchemaType.KEYWORD,
                wait=True,
            )

    def settle(self, timeout: float = 600) -> dict:
        started = time.perf_counter()
        status = None
        optimizer = None
        while time.perf_counter() - started < timeout:
            info = self.client.get_collection(self.collection)
            status = str(info.status)
            optimizer = str(info.optimizer_status)
            if "green" in status.lower() and ("ok" in optimizer.lower() or "done" in optimizer.lower()):
                break
            time.sleep(1.0)
        return {
            "settle_s": round(time.perf_counter() - started, 3),
            "status": status,
            "optimizer_status": optimizer,
            "points": self.client.count(self.collection, exact=True).count,
        }

    def load(self) -> dict:
        embeddings = np.load(self.root / "embeddings.npy", mmap_mode="r")
        points = []
        count = 0
        started = time.perf_counter()
        with (self.root / "nodes.jsonl").open("rb") as fh:
            for line in fh:
                row = orjson.loads(line)
                i = row["id"]
                points.append(
                    models.PointStruct(
                        id=i,
                        vector=np.asarray(embeddings[i], dtype=np.float32).tolist(),
                        payload={
                            "entity_id": row["entity_id"],
                            "type": row["type"],
                            "tenant_id": row["tenant_id"],
                        },
                    )
                )
                if len(points) >= 500:
                    self.client.upsert(self.collection, points=points, wait=True)
                    count += len(points)
                    points = []
        if points:
            self.client.upsert(self.collection, points=points, wait=True)
            count += len(points)
        upsert_s = time.perf_counter() - started
        settled = self.settle()
        return {"points": count, "upsert_s": round(upsert_s, 3), **settled}

    def vector(self, vec: np.ndarray, limit: int = 50, hnsw_ef: int = 128) -> list[str]:
        response = self.client.query_points(
            collection_name=self.collection,
            query=np.asarray(vec, dtype=np.float32).tolist(),
            query_filter=models.Filter(
                must=[
                    models.FieldCondition(
                        key="tenant_id", match=models.MatchValue(value="acme")
                    )
                ]
            ),
            limit=limit,
            with_payload=True,
            with_vectors=False,
            search_params=models.SearchParams(hnsw_ef=hnsw_ef, exact=False),
        )
        return [p.payload["entity_id"] for p in response.points]

    def lexical(self, text: str, limit: int = 50) -> list[str]:
        rows = self.q(
            """
            CALL db.index.fulltext.queryNodes('entity_fulltext', $lucene, {limit: 100})
            YIELD node, score
            WHERE node.tenant_id = $tenant
            RETURN node.entity_id AS entity_id
            LIMIT $limit
            """,
            lucene=lucene_all_terms(text),
            tenant="acme",
            limit=limit,
        )
        return [r["entity_id"] for r in rows]

    def expand(self, anchors: list[str], limit: int = 40) -> list[str]:
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
            tenant="acme",
            limit=limit,
        )
        return [r["entity_id"] for r in rows]

    def embed(self, text: str) -> tuple[np.ndarray, float]:
        started = time.perf_counter()
        arr = np.asarray(next(self.embedder.embed([text], batch_size=1)), dtype=np.float32)
        arr = arr / max(float(np.linalg.norm(arr)), 1e-9)
        return arr, (time.perf_counter() - started) * 1000


def run_modes(
    bench: QdrantBench, n_warmup: int, n_measured: int, n_e2e: int
) -> dict:
    rng = random.Random(13)
    modes = ["vector"]
    if bench.graph:
        modes += ["keyword", "hybrid"]
    result = {}
    for mode in modes:
        pool = queries_for_mode(bench.queries, mode)
        latencies = []
        recalls = []
        fails = 0

        def one(q: dict) -> list[str]:
            nonlocal fails
            started = time.perf_counter()
            try:
                if mode == "keyword":
                    ids = bench.lexical(q["keyword"])
                    emb = 0.0
                elif mode == "vector":
                    vec, emb = bench.embed(q["paraphrase"])
                    ids = bench.vector(vec)
                else:
                    vec, emb = bench.embed(q["paraphrase"])
                    ids = rrf(
                        [bench.lexical(q["keyword"]), bench.vector(vec)],
                        k=60,
                        limit=50,
                    )
                return ids
            except Exception:
                fails += 1
                return []
            finally:
                latencies.append((time.perf_counter() - started) * 1000)

        for _ in range(n_warmup):
            one(rng.choice(pool))
        latencies.clear()
        for _ in range(n_measured):
            q = rng.choice(pool)
            ids = one(q)
            recalls.append(recall_at_k(ids, q["relevant"], k=10))
        stats = latency_stats(latencies)
        # Independent embed cost sample
        if mode != "keyword":
            emb_samples = [bench.embed(q["paraphrase"])[1] for q in queries_for_mode(bench.queries, "vector")[:50]]
            emb_stats = latency_stats(emb_samples)
        else:
            emb_stats = {}
        result[mode] = {
            "latency_ms": stats,
            "recall_at_10": round(float(np.mean(recalls)), 4),
            "embed_ms": emb_stats,
            "failures": fails,
        }
        if bench.graph:
            e2e = []
            for _ in range(n_e2e):
                q = rng.choice(pool)
                started = time.perf_counter()
                try:
                    if mode == "keyword":
                        ids = bench.lexical(q["keyword"])
                    elif mode == "vector":
                        vec, _ = bench.embed(q["paraphrase"])
                        ids = bench.vector(vec)
                    else:
                        vec, _ = bench.embed(q["paraphrase"])
                        ids = rrf(
                            [bench.lexical(q["keyword"]), bench.vector(vec)],
                            k=60,
                            limit=50,
                        )
                    bench.expand(ids[:5])
                except Exception:
                    pass
                e2e.append((time.perf_counter() - started) * 1000)
            result[mode]["end_to_end"] = {"latency_ms": latency_stats(e2e)}
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", default=None)
    parser.add_argument("--graph-hybrid", action="store_true")
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--skip-load", action="store_true")
    parser.add_argument("--warmup", type=int, default=100)
    parser.add_argument("--measured", type=int, default=500)
    parser.add_argument("--expand-n", type=int, default=200)
    parser.add_argument("--cold-start-s", type=float, default=None)
    parser.add_argument("--degradation", action="store_true")
    args = parser.parse_args()

    bench = QdrantBench(args.dataset, graph=args.graph_hybrid)
    result = {
        "backend": "qdrant" + ("+neo4j" if args.graph_hybrid else ""),
        "dataset": args.dataset,
        "versions": {"qdrant": "1.12.5", "qdrant-client": "1.20.0"},
        "collection": bench.collection,
        "index_params": {
            "dimension": 512,
            "distance": "cosine",
            "hnsw": {"m": 16, "ef_construct": 100, "ef_search": 128},
            "payload_indexes": ["tenant_id", "type"],
        },
        "query_params": {"candidate_k": 50, "rrf_k": 60, "expand_anchors": 5,
                         "expand_limit": 40},
        "cold_start_s": args.cold_start_s,
        "warmup": args.warmup,
        "measured": args.measured,
    }
    if args.reset:
        bench.create()
    if not args.skip_load:
        result["load"] = bench.load()
    else:
        result["load"] = {"skipped": True}

    with MemorySampler("fde-ret-qdrant", 1.0) as sampler:
        result["modes"] = run_modes(bench, args.warmup, args.measured, args.expand_n)
        time.sleep(3)
        result["memory_mb"] = {"peak": sampler.peak_mb, "idle": sampler.idle_mb}

    result["disk_mb"] = container_disk_mb("fde-ret-qdrant", ["/qdrant/storage"])

    if args.degradation:
        deg = {}
        # Point the client at a dead port to simulate a stopped Qdrant.
        dead = QdrantClient(url="http://localhost:6399", timeout=1)
        dead_bench = bench
        old = dead_bench.client
        dead_bench.client = dead
        lat = []
        fails = 0
        for q in queries_for_mode(bench.queries, "vector")[:20]:
            started = time.perf_counter()
            try:
                vec, _ = bench.embed(q["paraphrase"])
                dead_bench.vector(vec)
            except Exception:
                fails += 1
            lat.append((time.perf_counter() - started) * 1000)
        deg["vector_backend_down"] = {
            "failures": fails,
            "latency_ms": latency_stats(lat),
            "fallback_reason": "index_unavailable",
        }
        dead_bench.client = old
        if bench.graph:
            deg["lexical_fallback"] = run_modes(bench, 10, 100, 0).get("keyword")
        result["degradation"] = deg

    if bench.driver:
        bench.driver.close()
    out = args.out or f"qdrant-{args.dataset}.json"
    write_result(out, result)


if __name__ == "__main__":
    main()
