# Production retrieval index — research assets

Ticket: [#15](https://github.com/0xnicholas/Fdesforce/issues/15) · Decision memo: [`docs/research/retrieval-index-selection.md`](../../docs/research/retrieval-index-selection.md)

Status: 10k and 100k benchmarks completed for Neo4j, PostgreSQL+pgvector and Qdrant+Neo4j (100k nodes / 500k edges); 500k completed for all three backends (500k nodes / 2.5M edges). The 500k Neo4j node load was resumed with `finish_neo4j_500k.py` after a tool timeout; the PostgreSQL 500k load uses 50k-row chunks and can be resumed with `--resume`. See `results/` and the memo §2.6/§9 for the exact numbers. Benchmark embeddings use 512d `minishlab/potion-retrieval-32M`; bge-small was not run at 100k/500k because of CPU throughput (caveat in memo §2.5).

## Layout

| Path | Purpose |
|---|---|
| `concepts.py` | Deterministic concept catalogue: 10 gold nodes per concept, keyword anchor + paraphrase |
| `generate_dataset.py` | Synthetic corpus + query ground truth (`nodes.jsonl`, `edges.jsonl`, `queries.json`) |
| `embed_dataset.py` | FastEmbed `minishlab/potion-retrieval-32M` (512-d) embeddings |
| `bench_embedded.py` | Semantica 0.7.0 `ContextGraph` baseline (O(n) lexical scan) |
| `bench_neo4j.py` | Neo4j 5.26 full-text + native vector index + 2-hop Cypher |
| `bench_qdrant.py` | Qdrant 1.12.5 vector index, optionally fused with Neo4j lexical/graph |
| `bench_pgvector.py` | PostgreSQL 17 + pgvector HNSW + GIN full-text + recursive CTE |
| `probes/semantica_neo4j_adapter_probe.py` | `Neo4jStore` ID/write semantics vs bulk `UNWIND` |
| `results/` | Small JSON results actually collected |

## Prerequisites

- macOS/Linux, Python 3.12, `uv`
- Docker with ~8 GB memory available for containers
- No cloud embedding key: the harness uses a local FastEmbed model

```bash
export FDE_RET_ROOT="$HOME/fdesforce-retrieval"
uv venv --python 3.12 "$FDE_RET_ROOT/venv"
uv pip install --python "$FDE_RET_ROOT/venv/bin/python" \
  'semantica==0.7.0' 'fastembed>=0.6' 'neo4j>=5.26,<6' \
  'qdrant-client>=1.12,<2' 'psycopg[binary]>=3.2,<4' \
  'numpy>=2,<3' 'orjson>=3.10,<4' 'httpx>=0.27,<1'
source "$FDE_RET_ROOT/venv/bin/activate"
export FDE_RET_DATA="$FDE_RET_ROOT/data"
mkdir -p "$FDE_RET_DATA/datasets"
```

Do not put the venv or data under `/tmp`; on a long 500k run they can be cleaned up mid-run.

## Datasets

```bash
cd research/retrieval-index
python generate_dataset.py --nodes 10000  --edges-per-node 5 --out "$FDE_RET_DATA/datasets/10k"
python generate_dataset.py --nodes 100000 --edges-per-node 5 --out "$FDE_RET_DATA/datasets/100k"
python embed_dataset.py --data "$FDE_RET_DATA/datasets/100k"
```

`100k` produces 100k nodes / 500k edges, 70 concepts, 210 queries, 700 gold nodes. The generator is deterministic (`--seed 42`).

## Backends

Neo4j (ports 7474/7687, password `testpass123`):

```bash
docker run -d --name fde-ret-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/testpass123 \
  -e NEO4J_server_memory_heap_initial__size=1G \
  -e NEO4J_server_memory_heap_max__size=2G \
  -e NEO4J_server_memory_pagecache_size=512M \
  --memory=6g neo4j:5.26.0-community
```

For 500k/2.5M, 2 GB heap is not enough for the bulk load (`MemoryPoolOutOfMemoryError`); use
`-e NEO4J_server_memory_heap_max__size=3G -e NEO4J_server_memory_pagecache_size=1G --memory=7g`.

PostgreSQL 17 + pgvector (host port 5433, DB `fde`, password `testpass`):

```bash
docker run -d --name fde-ret-pg -p 5433:5432 \
  -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=fde \
  --memory=6g --shm-size=2g pgvector/pgvector:pg17
```

`--shm-size=2g` is required for the 500k HNSW build; the Docker default (64 MB) fails with
`DiskFull: could not resize shared memory segment`. The benchmark also sets
`maintenance_work_mem=1GB` and `work_mem=64MB` per session.

Qdrant (port 6333):

```bash
docker run -d --name fde-ret-qdrant -p 6333:6333 \
  --memory=5g qdrant/qdrant:v1.12.5
```

## Run

```bash
cd research/retrieval-index

# If the machine uses an HTTP proxy, localhost calls to Qdrant/Neo4j must bypass it.
export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1

# 10k embedded baseline (no Docker)
python bench_embedded.py --dataset 10k --save-load --out embedded-10k.json

# 100k Neo4j (reset + bulk load + indexes + queries)
python bench_neo4j.py --dataset 100k --reset --out neo4j-100k.json

# 100k PostgreSQL + pgvector
python bench_pgvector.py --dataset 100k --reset --out pgvector-100k.json

# If a long PostgreSQL load is interrupted, keep the committed 50k-row chunks:
python bench_pgvector.py --dataset 500k --resume --out pgvector-500k.json

# 100k Qdrant; Neo4j must be up with the same dataset for lexical/hybrid
python bench_qdrant.py --dataset 100k --reset --graph-hybrid --out qdrant-100k.json
```

The scripts write JSON to `results/` by default (or take `--out`). Query latency includes query embedding for vector/hybrid modes. Warmup is 100, measured 500 per mode, plus 200 end-to-end expansion runs. The 500k runs in this memo used `--warmup 30 --measured 100 --expand-n 50` to keep the run inside the machine budget; pass `--cold-start-s` with the measured container start time.

## Results collected

| File | What it proves |
|---|---|
| `results/embedded-10k.json` | 10k/50k embedded baseline: keyword p95 46.7 ms / recall 1.0; paraphrase p95 287.3 ms / recall 0.037; 2-hop p95 0.86 ms; RSS 368 MB; snapshot 18.85 MB |
| `results/semantica_neo4j_adapter_probe.json` | `Neo4jStore` is not a serving adapter: 44.8 nodes/s, 64.8 rels/s; internal integer IDs; no vector index helper. Bulk `UNWIND` is 4,869 nodes/s and 4,130 edges/s, peak 1.5 GB |
| `results/neo4j-10k.json`, `neo4j-100k.json` | full-text + native vector + Cypher 2-hop; 100k hybrid e2e p95 37.6 ms |
| `results/pgvector-10k.json`, `pgvector-100k.json` | pgvector HNSW + GIN + recursive CTE; 100k hybrid e2e p95 56.9 ms |
| `results/qdrant-10k.json`, `qdrant-100k.json` | Qdrant vector + Neo4j lexical/graph; 100k hybrid e2e p95 31.8 ms |
| `results/neo4j-500k.json` | 500k/2.5M Neo4j: hybrid p95 72.8 ms, e2e p95 92.6 ms; needs 3 GB heap |
| `results/neo4j-500k-load.json` | resumed 190k-node load, 2.5M edges, full-text + vector index timings |
| `results/qdrant-500k.json` | 500k Qdrant + Neo4j: hybrid p95 24.0 ms, e2e p95 47.8 ms; 1.49 GB Qdrant storage |
| `results/pgvector-500k.json` | 500k PostgreSQL: HNSW build 975.4 s, DB 4.03 GB; hybrid p95 23.9 ms, e2e p95 35.6 ms |
| `results/summary.json`, `results/summary.md` | all measured rows collapsed into one table |

**Not collected:** bge-small 100k/500k recall/latency (CPU throughput); concurrency; Apache AGE; 1M scale. See memo §9 for the gate these leave open.

## Caveats

- Synthetic corpus, not customer data; relevance is 10 gold nodes per concept.
- Single host, localhost, Docker VM (8 GB / 8 CPU on the test machine); numbers are not capacity planning.
- Embedding model for the harness is `minishlab/potion-retrieval-32M` (512-d), chosen because bge-small throughput on this CPU made 100k/500k impractical. This is a benchmark convenience, **not** a production embedding-model decision.
- No LLM rerank, no multi-tenant isolation test, no concurrent writers.
- The 500k Neo4j node load was resumed after a tool timeout: the first 310k nodes came from the interrupted run and only the remaining 190k are in `ingest_nodes_s`; total node load was roughly 15–20 min.
