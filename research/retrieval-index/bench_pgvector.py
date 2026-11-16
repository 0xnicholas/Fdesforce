#!/usr/bin/env python3
"""PostgreSQL 17 + pgvector benchmark: HNSW vector, GIN full-text, recursive CTE.

Tables are per-dataset inside one database; this keeps the 10k, 100k and 500k
runs comparable without resetting the container between them.
"""

from __future__ import annotations

import argparse
import itertools
import logging
import random
import re
import sys
import time
from pathlib import Path

import numpy as np
import orjson
import psycopg
from fastembed import TextEmbedding

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

DSN = "postgresql://postgres:testpass@localhost:5433/fde"
EMBED_MODEL = "minishlab/potion-retrieval-32M"
NODE_CHUNK = 50_000
EDGE_CHUNK = 500_000
CHUNK_TIMEOUT_MS = 180_000
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "if", "in",
    "into", "is", "it", "no", "not", "of", "on", "or", "such", "that", "the",
    "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
}


def vec_literal(vec: np.ndarray) -> str:
    return "[" + ",".join(f"{float(x):.6f}" for x in vec) + "]"


class PgBench:
    def __init__(self, dataset: str):
        self.dataset = dataset
        self.root = data_dir(dataset)
        self.suffix = re.sub(r"[^A-Za-z0-9_]", "_", dataset)
        self.entities = f"entities_{self.suffix}"
        self.edges = f"edges_{self.suffix}"
        self.conn = psycopg.connect(DSN, autocommit=True)
        self.cur = self.conn.cursor()
        self.embedder = TextEmbedding(model_name=EMBED_MODEL, threads=4)
        self.queries = load_queries(dataset)

    def q(self, sql: str, params=None):
        self.cur.execute(sql, params or ())
        if self.cur.description is None:
            return []
        return self.cur.fetchall()

    def configure(self) -> None:
        self.q("SET maintenance_work_mem = '1GB'")
        self.q("SET work_mem = '64MB'")

    def create(self) -> None:
        self.configure()
        self.q("CREATE EXTENSION IF NOT EXISTS vector")
        self.q(f"DROP TABLE IF EXISTS {self.entities}")
        self.q(f"DROP TABLE IF EXISTS {self.edges}")
        self.q(
            f"""
            CREATE TABLE {self.entities} (
                id bigint PRIMARY KEY,
                entity_id text NOT NULL UNIQUE,
                type text NOT NULL,
                name text NOT NULL,
                text text NOT NULL,
                topic text NOT NULL,
                tenant_id text NOT NULL,
                version text NOT NULL,
                embedding vector(512) NOT NULL,
                tsv tsvector GENERATED ALWAYS AS (
                    to_tsvector('english', coalesce(name, '') || ' ' || coalesce(text, ''))
                ) STORED
            )
            """
        )
        self.q(
            f"CREATE TABLE {self.edges} (src bigint NOT NULL, dst bigint NOT NULL, "
            f"rel_type text NOT NULL, tenant_id text NOT NULL)"
        )

    def table_exists(self, name: str) -> bool:
        return bool(self.q("SELECT to_regclass(%s) IS NOT NULL", (name,))[0][0])

    def _chunk_conn(self):
        return psycopg.connect(
            DSN, options=f"-c statement_timeout={CHUNK_TIMEOUT_MS}"
        )

    def _copy_with_retry(self, label: str, fn) -> None:
        for attempt in range(1, 4):
            try:
                fn()
                return
            except psycopg.Error as exc:
                print(
                    f"{label}: attempt {attempt}/3 failed: {exc}",
                    file=sys.stderr,
                    flush=True,
                )
                if attempt == 3:
                    raise
                time.sleep(2 * attempt)

    def _copy_node_chunk(self, rows: list[dict], embeddings) -> None:
        with self._chunk_conn() as conn, conn.cursor() as cur:
            with cur.copy(
                f"COPY {self.entities} "
                "(id, entity_id, type, name, text, topic, tenant_id, version, embedding) "
                "FROM STDIN"
            ) as copy:
                for row in rows:
                    i = row["id"]
                    copy.write_row(
                        (
                            i,
                            row["entity_id"],
                            row["type"],
                            row["name"],
                            row["text"],
                            row["topic"],
                            row["tenant_id"],
                            row["version"],
                            vec_literal(np.asarray(embeddings[i], dtype=np.float32)),
                        )
                    )

    def _copy_edge_chunk(self, rows: list[tuple]) -> None:
        with self._chunk_conn() as conn, conn.cursor() as cur:
            with cur.copy(
                f"COPY {self.edges} (src, dst, rel_type, tenant_id) FROM STDIN"
            ) as copy:
                for row in rows:
                    copy.write_row(row)

    def _node_rows(self, path: Path, skip: int):
        with path.open("rb") as fh:
            for idx, line in enumerate(fh):
                if idx < skip:
                    continue
                yield orjson.loads(line)

    def _edge_rows(self, path: Path):
        with path.open("rb") as fh:
            for line in fh:
                row = orjson.loads(line)
                yield (row["src"], row["dst"], row["type"], row["tenant_id"])

    def load(self, resume: bool = False) -> dict:
        embeddings = np.load(self.root / "embeddings.npy", mmap_mode="r")
        resume_from = 0
        if resume:
            if not self.table_exists(self.entities):
                raise SystemExit("--resume: table does not exist; run with --reset first")
            resume_from = int(self.q(f"SELECT count(*) FROM {self.entities}")[0][0])
            self.q(f"TRUNCATE {self.edges}")
            for index in (
                f"{self.entities}_tenant",
                f"{self.entities}_hnsw",
                f"{self.entities}_gin",
                f"{self.edges}_src",
                f"{self.edges}_dst",
            ):
                self.q(f"DROP INDEX IF EXISTS {index}")
            if resume_from:
                print(
                    f"resuming node load at {resume_from}",
                    file=sys.stderr,
                    flush=True,
                )

        started = time.perf_counter()
        nodes_iter = self._node_rows(self.root / "nodes.jsonl", resume_from)
        loaded = resume_from
        while True:
            chunk = list(itertools.islice(nodes_iter, NODE_CHUNK))
            if not chunk:
                break
            self._copy_with_retry(
                f"nodes {loaded}-{loaded + len(chunk)}",
                lambda chunk=chunk: self._copy_node_chunk(chunk, embeddings),
            )
            loaded += len(chunk)
            print(f"nodes {loaded}", file=sys.stderr, flush=True)
        nodes_s = time.perf_counter() - started

        started = time.perf_counter()
        edges_iter = self._edge_rows(self.root / "edges.jsonl")
        loaded_edges = 0
        while True:
            chunk = list(itertools.islice(edges_iter, EDGE_CHUNK))
            if not chunk:
                break
            self._copy_with_retry(
                f"edges {loaded_edges}-{loaded_edges + len(chunk)}",
                lambda chunk=chunk: self._copy_edge_chunk(chunk),
            )
            loaded_edges += len(chunk)
            print(f"edges {loaded_edges}", file=sys.stderr, flush=True)
        edges_s = time.perf_counter() - started

        started = time.perf_counter()
        self.q(f"CREATE INDEX {self.entities}_tenant ON {self.entities} (tenant_id)")
        tenant_s = time.perf_counter() - started
        started = time.perf_counter()
        self.q(
            f"CREATE INDEX {self.entities}_hnsw ON {self.entities} "
            "USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)"
        )
        hnsw_s = time.perf_counter() - started
        started = time.perf_counter()
        self.q(f"CREATE INDEX {self.entities}_gin ON {self.entities} USING gin (tsv)")
        gin_s = time.perf_counter() - started
        started = time.perf_counter()
        self.q(f"CREATE INDEX {self.edges}_src ON {self.edges} (src)")
        self.q(f"CREATE INDEX {self.edges}_dst ON {self.edges} (dst)")
        edge_idx_s = time.perf_counter() - started
        self.q(f"ANALYZE {self.entities}")
        self.q(f"ANALYZE {self.edges}")
        return {
            "nodes": int(self.q(f"SELECT count(*) FROM {self.entities}")[0][0]),
            "edges": int(self.q(f"SELECT count(*) FROM {self.edges}")[0][0]),
            "ingest_nodes_s": round(nodes_s, 3),
            "ingest_edges_s": round(edges_s, 3),
            "index_tenant_s": round(tenant_s, 3),
            "index_hnsw_s": round(hnsw_s, 3),
            "index_gin_s": round(gin_s, 3),
            "index_edges_s": round(edge_idx_s, 3),
        }

    def set_ef(self, ef: int) -> None:
        self.q(f"SET hnsw.ef_search = {int(ef)}")

    def lexical(self, text: str, limit: int = 50) -> list[str]:
        rows = self.q(
            f"""
            WITH q AS (SELECT websearch_to_tsquery('english', %s) AS tsq)
            SELECT entity_id
            FROM {self.entities}, q
            WHERE tenant_id = 'acme' AND tsv @@ q.tsq
            ORDER BY ts_rank_cd(tsv, q.tsq) DESC
            LIMIT %s
            """,
            (text, limit),
        )
        return [r[0] for r in rows]

    def vector(self, vec: np.ndarray, limit: int = 50) -> list[str]:
        literal = vec_literal(vec)
        rows = self.q(
            f"""
            SELECT entity_id
            FROM {self.entities}
            WHERE tenant_id = 'acme'
            ORDER BY embedding <=> %s::vector
            LIMIT %s
            """,
            (literal, limit),
        )
        return [r[0] for r in rows]

    def hybrid(self, keyword: str, vec: np.ndarray, limit: int = 50) -> list[str]:
        literal = vec_literal(vec)
        rows = self.q(
            f"""
            WITH q AS (SELECT websearch_to_tsquery('english', %s) AS tsq),
            lex AS (
                SELECT entity_id, row_number() OVER (ORDER BY score DESC) AS rnk
                FROM (
                    SELECT entity_id, ts_rank_cd(tsv, q.tsq) AS score
                    FROM {self.entities}, q
                    WHERE tenant_id = 'acme' AND tsv @@ q.tsq
                    ORDER BY score DESC
                    LIMIT 50
                ) l
            ),
            vec AS (
                SELECT entity_id, row_number() OVER (ORDER BY distance) AS rnk
                FROM (
                    SELECT entity_id, embedding <=> %s::vector AS distance
                    FROM {self.entities}
                    WHERE tenant_id = 'acme'
                    ORDER BY distance
                    LIMIT 50
                ) v
            ),
            merged AS (
                SELECT entity_id, sum(1.0 / (60 + rnk)) AS score
                FROM (SELECT entity_id, rnk FROM lex UNION ALL SELECT entity_id, rnk FROM vec) u
                GROUP BY entity_id
            )
            SELECT entity_id FROM merged ORDER BY score DESC LIMIT %s
            """,
            (keyword, literal, limit),
        )
        return [r[0] for r in rows]

    def expand(self, anchors: list[str], limit: int = 40) -> list[str]:
        if not anchors:
            return []
        rows = self.q(
            f"""
            WITH RECURSIVE seeds AS (
                SELECT id FROM {self.entities} WHERE entity_id = ANY(%s)
            ),
            hop1 AS (
                SELECT e.dst AS id FROM {self.edges} e JOIN seeds s ON e.src = s.id
                UNION
                SELECT e.src AS id FROM {self.edges} e JOIN seeds s ON e.dst = s.id
            ),
            hop2 AS (
                SELECT e.dst AS id FROM {self.edges} e JOIN hop1 h ON e.src = h.id
                UNION
                SELECT e.src AS id FROM {self.edges} e JOIN hop1 h ON e.dst = h.id
            ),
            ids AS (SELECT id FROM hop1 UNION SELECT id FROM hop2)
            SELECT DISTINCT e.entity_id
            FROM {self.entities} e JOIN ids ON e.id = ids.id
            WHERE e.tenant_id = 'acme'
            LIMIT %s
            """,
            (anchors, limit),
        )
        return [r[0] for r in rows]

    def embed(self, text: str) -> tuple[np.ndarray, float]:
        started = time.perf_counter()
        arr = np.asarray(next(self.embedder.embed([text], batch_size=1)), dtype=np.float32)
        arr = arr / max(float(np.linalg.norm(arr)), 1e-9)
        return arr, (time.perf_counter() - started) * 1000


def run_modes(bench: PgBench, n_warmup: int, n_measured: int, n_e2e: int) -> dict:
    rng = random.Random(17)
    result = {}
    for mode in ("keyword", "vector", "hybrid"):
        pool = queries_for_mode(bench.queries, mode)
        lat = []
        rec = []
        fails = 0

        def one(q: dict) -> list[str]:
            nonlocal fails
            started = time.perf_counter()
            try:
                if mode == "keyword":
                    ids = bench.lexical(q["keyword"])
                elif mode == "vector":
                    vec, _ = bench.embed(q["paraphrase"])
                    ids = bench.vector(vec)
                else:
                    vec, _ = bench.embed(q["paraphrase"])
                    ids = bench.hybrid(q["keyword"], vec)
                return ids
            except Exception:
                fails += 1
                return []
            finally:
                lat.append((time.perf_counter() - started) * 1000)

        for _ in range(n_warmup):
            one(rng.choice(pool))
        lat.clear()
        for _ in range(n_measured):
            q = rng.choice(pool)
            ids = one(q)
            rec.append(recall_at_k(ids, q["relevant"], k=10))
        result[mode] = {
            "latency_ms": latency_stats(lat),
            "recall_at_10": round(float(np.mean(rec)), 4),
            "failures": fails,
        }
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
                    ids = bench.hybrid(q["keyword"], vec)
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
    parser.add_argument("--reset", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--skip-load", action="store_true")
    parser.add_argument("--warmup", type=int, default=100)
    parser.add_argument("--measured", type=int, default=500)
    parser.add_argument("--expand-n", type=int, default=200)
    parser.add_argument("--cold-start-s", type=float, default=None)
    parser.add_argument("--degradation", action="store_true")
    args = parser.parse_args()

    bench = PgBench(args.dataset)
    result = {
        "backend": "postgres+pgvector",
        "dataset": args.dataset,
        "versions": {"postgres": "17", "pgvector": "image pgvector/pgvector:pg17"},
        "index_params": {
            "hnsw": {"m": 16, "ef_construction": 64, "ef_search": 100},
            "gin": "tsvector('english')",
        },
        "query_params": {"candidate_k": 50, "rrf_k": 60, "expand_anchors": 5,
                         "expand_limit": 40},
        "cold_start_s": args.cold_start_s,
        "warmup": args.warmup,
        "measured": args.measured,
    }
    if args.reset and args.resume:
        raise SystemExit("--reset and --resume are mutually exclusive")
    if args.reset:
        bench.create()
    else:
        bench.configure()
    if not args.skip_load:
        result["load"] = bench.load(resume=args.resume)
    else:
        result["load"] = {"skipped": True}

    with MemorySampler("fde-ret-pg", 1.0) as sampler:
        bench.set_ef(100)
        result["modes"] = run_modes(bench, args.warmup, args.measured, args.expand_n)
        time.sleep(3)
        result["memory_mb"] = {"peak": sampler.peak_mb, "idle": sampler.idle_mb}

    result["disk_mb"] = container_disk_mb("fde-ret-pg", ["/var/lib/postgresql/data"])
    result["db_size_mb"] = round(
        int(bench.q("SELECT pg_database_size('fde')")[0][0]) / 1024 / 1024, 1
    )

    if args.degradation:
        deg = {}
        bench.q(f"DROP INDEX {bench.entities}_hnsw")
        bench.q("SET enable_indexscan = on")
        lat = []
        for q in queries_for_mode(bench.queries, "vector")[:50]:
            vec, _ = bench.embed(q["paraphrase"])
            started = time.perf_counter()
            bench.vector(vec)
            lat.append((time.perf_counter() - started) * 1000)
        deg["hnsw_dropped_exact_scan"] = latency_stats(lat)
        bench.q(f"DROP INDEX {bench.entities}_gin")
        lat = []
        for q in queries_for_mode(bench.queries, "keyword")[:50]:
            started = time.perf_counter()
            bench.lexical(q["keyword"])
            lat.append((time.perf_counter() - started) * 1000)
        deg["gin_dropped_seq_scan"] = latency_stats(lat)
        result["degradation"] = deg

    bench.conn.close()
    out = args.out or f"pgvector-{args.dataset}.json"
    write_result(out, result)


if __name__ == "__main__":
    main()
