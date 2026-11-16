#!/usr/bin/env python3
"""Embed a generated corpus with FastEmbed minishlab/potion-retrieval-32M (512d).

Vectors are L2-normalised and written as float32 ``embeddings.npy`` in node-id
order.  The same model is used at query time by every backend benchmark, so
query-embedding cost is included in the measured latency.

Usage:
    python embed_dataset.py --data /tmp/fdesforce-retrieval-data/datasets/100k
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import orjson
from fastembed import TextEmbedding

MODEL_NAME = "minishlab/potion-retrieval-32M"
DIM = 512


def load_texts(path: Path) -> list[str]:
    texts = []
    with path.open("rb") as fh:
        for line in fh:
            texts.append(orjson.loads(line)["text"])
    return texts


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--chunk", type=int, default=5000)
    parser.add_argument("--threads", type=int, default=1)
    args = parser.parse_args()

    data = Path(args.data)
    out = data / "embeddings.npy"
    if out.exists():
        print(json.dumps({"skipped": True, "path": str(out)}))
        return

    texts = load_texts(data / "nodes.jsonl")
    n = len(texts)
    model = TextEmbedding(model_name=MODEL_NAME, threads=args.threads)
    vectors = np.lib.format.open_memmap(
        out, mode="w+", dtype=np.float32, shape=(n, DIM)
    )
    started = time.perf_counter()
    done = 0
    for start in range(0, n, args.chunk):
        chunk = texts[start:start + args.chunk]
        for vec in model.embed(chunk, batch_size=args.batch_size):
            arr = np.asarray(vec, dtype=np.float32)
            norm = float(np.linalg.norm(arr))
            if norm > 0:
                arr = arr / norm
            vectors[done] = arr
            done += 1
        vectors.flush()
        elapsed = time.perf_counter() - started
        print(
            f"embedded {done}/{n} in {elapsed:.1f}s "
            f"({done / max(elapsed, 1e-9):.0f} texts/s)",
            flush=True,
        )
    vectors.flush()
    del vectors
    elapsed = time.perf_counter() - started
    meta = {
        "model": MODEL_NAME,
        "dim": DIM,
        "nodes": n,
        "embed_s": round(elapsed, 3),
        "texts_per_s": round(n / elapsed, 1),
        "threads": args.threads,
        "file_mb": round(out.stat().st_size / 1024 / 1024, 2),
        "normalized": True,
    }
    with (data / "embeddings_meta.json").open("wb") as fh:
        fh.write(orjson.dumps(meta, option=orjson.OPT_INDENT_2))
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
