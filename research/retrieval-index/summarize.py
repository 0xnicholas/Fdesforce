#!/usr/bin/env python3
"""Collapse the per-backend result JSONs into the tables used in the memo."""

from __future__ import annotations

import json
from pathlib import Path

RESULTS = Path(__file__).resolve().parent / "results"
DATASETS = ["10k", "100k", "500k"]
BACKENDS = ["embedded", "neo4j", "qdrant", "pgvector"]


def load(name: str) -> dict | None:
    path = RESULTS / name
    if not path.exists():
        return None
    return json.loads(path.read_text())


def row(backend: str, dataset: str, result: dict) -> list[dict]:
    out = []
    modes = result.get("modes", {})
    for mode in ("keyword", "vector", "hybrid", "paraphrase"):
        if mode not in modes:
            continue
        m = modes[mode]
        lat = m.get("latency_ms", {})
        e2e = m.get("end_to_end", {}).get("latency_ms", {})
        out.append(
            {
                "backend": backend,
                "dataset": dataset,
                "mode": mode,
                "p50_ms": lat.get("p50"),
                "p95_ms": lat.get("p95"),
                "p99_ms": lat.get("p99"),
                "recall_at_10": m.get("recall_at_10"),
                "failures": m.get("failures"),
                "e2e_p50_ms": e2e.get("p50"),
                "e2e_p95_ms": e2e.get("p95"),
            }
        )
    return out


def main() -> None:
    summary = {"rows": [], "load": [], "resources": []}
    for dataset in DATASETS:
        for backend in BACKENDS:
            result = load(f"{backend}-{dataset}.json")
            if not result:
                continue
            summary["rows"].extend(row(backend, dataset, result))
            summary["load"].append(
                {
                    "backend": backend,
                    "dataset": dataset,
                    "load": result.get("load"),
                    "cold_start_s": result.get("cold_start_s"),
                }
            )
            summary["resources"].append(
                {
                    "backend": backend,
                    "dataset": dataset,
                    "memory_mb": result.get("memory_mb"),
                    "disk_mb": result.get("disk_mb"),
                    "db_size_mb": result.get("db_size_mb"),
                }
            )

    (RESULTS / "summary.json").write_text(json.dumps(summary, indent=2))

    lines = [
        "| backend | dataset | mode | p50 ms | p95 ms | p99 ms | recall@10 | e2e p95 ms |",
        "|---|---|---|---:|---:|---:|---:|---:|",
    ]
    for r in summary["rows"]:
        lines.append(
            f"| {r['backend']} | {r['dataset']} | {r['mode']} | "
            f"{r['p50_ms']} | {r['p95_ms']} | {r['p99_ms']} | "
            f"{r['recall_at_10']} | {r['e2e_p95_ms']} |"
        )
    (RESULTS / "summary.md").write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    print(f"\nwrote {RESULTS / 'summary.json'} and summary.md")


if __name__ == "__main__":
    main()
