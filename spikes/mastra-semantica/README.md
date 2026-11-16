# Mastra ↔ Semantica integration spike

Reproduction assets for ticket [#5](https://github.com/0xnicholas/Fdesforce/issues/5). The experiment record is [`docs/spikes/mastra-semantica-spike.md`](../../docs/spikes/mastra-semantica-spike.md).

## Layout

| Path | Purpose |
|---|---|
| `service/app.py` | Thin FastAPI context service over Semantica's Python API (`retrieve`, `decisions`, `provenance`) |
| `mastra-app/rest-path.mjs` | Mastra agent with a deterministic AI SDK model; calls the context service over REST |
| `mastra-app/mcp-path.mjs` | Control path: Mastra `MCPClient` → Semantica stdio MCP server |
| `bench/` | HTTP, graph-scale, Neo4j and failure-mode probes |
| `bundle/manifest.json` | Candidate single-customer bundle manifest; gaps listed in `missing_from_candidate` |
| `artifacts/` | Raw outputs captured during the spike |

## Prerequisites

- macOS/Linux, Python 3.12, `uv`, Node 22+
- Docker only if you want the Neo4j adapter probe
- No LLM API key: the agent uses `MockLanguageModelV4` from `ai/test`. The Mastra agent loop and tool execution are real; the model's tool choices are scripted.

## Run

```bash
export SPIKE_ROOT=/tmp/fdesforce-spike-5
mkdir -p "$SPIKE_ROOT"
cd "$SPIKE_ROOT"

uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r /path/to/repo/spikes/mastra-semantica/service/requirements.txt

cd /path/to/repo/spikes/mastra-semantica/service
SPIKE_DATA_DIR="$SPIKE_ROOT/data" "$SPIKE_ROOT/.venv/bin/python" -m uvicorn app:app --host 127.0.0.1 --port 8011

# in another shell
cd /path/to/repo/spikes/mastra-semantica/mastra-app
npm install
SPIKE_ROOT="$SPIKE_ROOT" node rest-path.mjs
SPIKE_ROOT="$SPIKE_ROOT" node mcp-path.mjs
```

The REST script writes `artifacts/rest-run.json` and `artifacts/rest-verified.json`; the MCP script writes `artifacts/mcp-run.json`.

For the Neo4j probe:

```bash
docker run -d --name fde-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/testpass neo4j:5-community

cd /path/to/repo/spikes/mastra-semantica
"$SPIKE_ROOT/.venv/bin/python" bench/bench_neo4j.py
```

`bench_graph.py` writes a 10k-node/50k-edge graph to `$SPIKE_DATA_DIR/bench-graph.json` and prints its measurements as JSON. `bench_http.py` expects the context service on `127.0.0.1:8011` with the seeded `acme` data.

## Notes

- The service uses Semantica's in-process `ContextGraph` and a full JSON snapshot per decision. That is a spike convenience, not a production persistence design.
- `GET /v1/provenance/{id}` verifies the whole SQLite chain by default. Set `PROVENANCE_VERIFY_ON_READ=false` to skip it; production should move verification to a background job.
- The context service has no authentication. Tenant/actor headers are passed through, but a real bundle needs a service token or mTLS and per-user authorization.
