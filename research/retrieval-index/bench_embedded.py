#!/usr/bin/env python3
"""Semantica 0.7.0 embedded ContextGraph baseline.

This is the v0 backend: an in-process Python graph with a lexical O(n) scan.
It is measured at 10k/50k and, if memory permits, 100k/500k.
"""

from __future__ import annotations

import argparse
import json
import random
import resource
import sys
import time
from pathlib import Path

import orjson

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import data_dir, latency_stats, load_queries, queries_for_mode, recall_at_k, write_result  # noqa: E402

from semantica.context import ContextGraph  # noqa: E402


def rss_mb() -> float:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS reports bytes, Linux kilobytes.
    return round(value / (1024 * 1024) if sys.platform == "darwin" else value / 1024, 1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", default=None)
    parser.add_argument("--measured", type=int, default=300)
    parser.add_argument("--warmup", type=int, default=20)
    parser.add_argument("--save-load", action="store_true")
    parser.add_argument("--max-seconds", type=float, default=1800)
    args = parser.parse_args()

    root = data_dir(args.dataset)
    queries = load_queries(args.dataset)
    graph = ContextGraph(advanced_analytics=False, extract_entities=False, extract_relationships=False)
    result = {
        "backend": "semantica-embedded",
        "dataset": args.dataset,
        "versions": {"semantica": "0.7.0", "python": sys.version.split()[0]},
        "backend_notes": {
            "query": "ContextGraph.query: full scan over nodes, substring match on content",
            "expansion": "get_neighbors: BFS over outgoing adjacency only",
        },
        "warmup": args.warmup,
        "measured": args.measured,
    }

    entity_ids: list[str] = []
    started = time.perf_counter()
    with (root / "nodes.jsonl").open("rb") as fh:
        for line in fh:
            row = orjson.loads(line)
            entity_ids.append(row["entity_id"])
            graph.add_node(
                row["entity_id"],
                row["type"],
                content=row["text"],
                name=row["name"],
                tenant_id=row["tenant_id"],
                topic=row["topic"],
                version=row["version"],
                cluster=row["cluster"],
                gold=row["gold"],
            )
    nodes_s = time.perf_counter() - started

    started = time.perf_counter()
    with (root / "edges.jsonl").open("rb") as fh:
        for line in fh:
            row = orjson.loads(line)
            graph.add_edge(
                entity_ids[row["src"]],
                entity_ids[row["dst"]],
                row["type"],
                weight=0.8,
            )
    edges_s = time.perf_counter() - started
    result["ingest"] = {
        "nodes_s": round(nodes_s, 3),
        "edges_s": round(edges_s, 3),
        "rss_mb": rss_mb(),
    }
    result["counts"] = graph.get_graph_summary()

    def filtered(results: list[dict], tenant: str = "acme", limit: int = 10) -> list[str]:
        out = []
        for item in results:
            node = item["node"]
            props = node.get("properties", {})
            if props.get("tenant_id", tenant) == tenant:
                out.append(node["id"])
                if len(out) >= limit:
                    break
        return out

    modes = {}
    for mode in ("keyword", "paraphrase"):
        pool = queries_for_mode(queries, "keyword" if mode == "keyword" else "vector")
        rng = random.Random(23)
        lat = []
        rec = []
        for _ in range(args.warmup):
            graph.query(rng.choice(pool)[mode], limit=100)
        for _ in range(args.measured):
            q = rng.choice(pool)
            started = time.perf_counter()
            raw = graph.query(q[mode], limit=100)
            lat.append((time.perf_counter() - started) * 1000)
            rec.append(recall_at_k(filtered(raw), q["relevant"], k=10))
        modes[mode] = {
            "latency_ms": latency_stats(lat),
            "recall_at_10": round(sum(rec) / len(rec), 4),
        }

    # Two-hop expansion from the top candidates of a keyword query.
    expansion = []
    rng = random.Random(29)
    keyword_pool = queries_for_mode(queries, "keyword")
    for _ in range(min(200, args.measured)):
        q = rng.choice(keyword_pool)
        raw = graph.query(q["keyword"], limit=100)
        anchors = filtered(raw, limit=5)
        started = time.perf_counter()
        for anchor in anchors:
            graph.get_neighbors(anchor, hops=2, limit=40)
        expansion.append((time.perf_counter() - started) * 1000)
    modes["expand_2hop_from_5"] = {"latency_ms": latency_stats(expansion)}
    result["modes"] = modes

    if args.save_load:
        path = root / "embedded-snapshot.json"
        started = time.perf_counter()
        graph.save_to_file(str(path))
        save_s = time.perf_counter() - started
        size_mb = round(path.stat().st_size / 1024 / 1024, 2)
        started = time.perf_counter()
        graph2 = ContextGraph(advanced_analytics=False)
        graph2.load_from_file(str(path))
        load_s = time.perf_counter() - started
        result["snapshot"] = {
            "save_s": round(save_s, 3),
            "load_s": round(load_s, 3),
            "size_mb": size_mb,
            "reloaded": graph2.get_graph_summary(),
        }
        del graph2

    result["memory_mb"] = {"peak_rss": rss_mb()}
    out = args.out or f"embedded-{args.dataset}.json"
    write_result(out, result)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
