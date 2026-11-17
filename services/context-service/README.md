# `services/context-service`

The platform-owned Python service that serves the internal Context API
(`contracts/context-service-v1.openapi.yaml`). One service, not generated per
Solution: Customer and Solution differences arrive as the compiled Customer
Context Package and environment configuration, never as source
(`docs/runtime-contract.md` §2).

This directory is the **#35 skeleton**: the wire surface, the error envelope, the
probes, the contract-derived models and the C1–C15 runner. Retrieval, the audit
store, identity and approvals land in #36–#40; the table at the bottom says
exactly which handler is whose.

## Layout

```text
app/
  main.py            create_app: the one place the service is assembled
  settings.py        environment → Settings; missing configuration fails at startup
  readiness.py       the probe registry /readyz evaluates (ready | degraded | not_ready)
  runtime_info.py    GET /v1/runtime-info, built through the generated RuntimeInfo model
  errors.py          FdeError + handlers: every non-2xx is the unified envelope (§3.4)
  contract.py        the request seam: JSON Schema validation against contracts/
  schema_registry.py JSON Schema registry + validation helpers
  tracing.py         traceparent → trace_id for every envelope (C6)
  wire.py            the generated models' base class and the Operation table types
  routes/            one module per OpenAPI tag: ops, context, decisions, approvals, jobs
  generated/         GENERATED from contracts/ — never hand-edited
conformance/         the C1–C15 runner and its real-process, ES256 key harness
scripts/generate.py  contracts/ → app/generated/**; `--check` runs in CI
tests/               pytest, against a spawned process for the HTTP surface
```

### Generated, not written

`app/generated/**` comes from `contracts/` via `scripts/generate.py`:

| Module | Contents |
| --- | --- |
| `models.py` | Pydantic models for the OpenAPI document's schema closure |
| `schemas.py` | the JSON Schema documents the runtime validates against |
| `api.py` | the operation table: method, path, auth, header requirements, request/response schemas |
| `versions.py` | the runtime contract minor, the service pin, graph/audit schema versions |

Pydantic is the **shape**; JSON Schema is the **validator**. `app.contract`
validates every request body against the schema the operation declares, so rules
Pydantic cannot express (`if/then`, `propertyNames`, `uniqueItems`) are enforced
exactly once — by the contract. The models make the same data typed for the code
that serves it.

`app/generated/**` is fresh or CI fails (`python scripts/generate.py --check`),
and `tests/test_generated.py` also asserts it byte-for-byte.

## Running it

```bash
cd services/context-service
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -e '.[dev]'

python -m pytest             # unit + real-process HTTP tests
python -m conformance        # C1–C15 runner (C1/C10 implemented in this slice)
python -m conformance --list # what runs, what is pending, and which ticket owns it
python scripts/generate.py --check
ruff check app conformance scripts tests
```

To serve it by hand:

```bash
GRAPH_BACKEND=embedded \
GRAPH_PATH=./data/graph/graph.json \
AUDIT_PATH=./data/audit/audit.sqlite \
python -m uvicorn app.main:app --host 127.0.0.1 --port 8011
```

`/healthz` is liveness; `/readyz` is serviceability and may answer `degraded`
with reasons. Neither needs a token.

## The conformance runner

`conformance/harness.py` spawns the **real** service (`uvicorn app.main:app`, a
free port, a temp data volume) and talks to it over HTTP. Nothing imports the app
to assert on it: a case that called a handler directly could pass while the
served surface was wrong.

`conformance/identity.py` mints `ExecutionContext` JWTs with **real ES256 keys**,
one pair per issuer (`mastra-app` → `fde://<deployment_id>`, `fde-jobs` →
`fde://<deployment_id>/jobs`). `kid` is the RFC 7638 thumbprint, the same id the
service derives from the public keys the topology binds. #36 makes the service
verify them; the material is already the deployment's.

Cases return the checks they proved, so a pass reads as
`C10 422 normalization: 5 body operations normalized, 404 and 405 are envelopes,
a contract-valid body gets past the validator`. Pending cases are printed with
their owner, and the summary counts them: a green run is never mistaken for full
conformance.

### C1: examples carry their schema

Every ```json fence in `docs/runtime-contract.md` and `contracts/**/*.md` must be
preceded by a marker naming the schema it satisfies:

```markdown
<!-- schema: contracts/schemas/retrieval.schema.json#/$defs/RetrieveRequest -->
```

C1 fails on a JSON fence without a marker, on a marker that does not resolve, and
on an example that does not validate. C1 also checks that every schema document
is valid JSON Schema 2020-12, that every `$ref` in both OpenAPI documents
resolves, and that `contracts/README.md` and `docs/runtime-contract.md` state the
same contract minor.

## What is real in this slice

| Surface | Status |
| --- | --- |
| `GET /healthz`, `GET /readyz` | served (`app/routes/ops.py`) |
| `GET /v1/runtime-info` | served, reports only context-service |
| Error envelope, 422 normalization | served; C10 green |
| Request-body validation against `contracts/` | served |
| `POST /v1/context/retrieve` | route + validation; handler is #39 |
| `POST /internal/v1/jobs/ingest` | route + validation; handler is #39 |
| `POST /v1/decisions`, `GET /v1/provenance/{decision_id}` | routes + validation; handlers are #37 |
| `POST/GET /v1/approvals`, `…/decisions`, `…/consume` | routes + validation; handlers are #40 |
| Identity enforcement, idempotency | #36 |
| Graph store, migrations, lexical retrieval | #38 |

An unimplemented handler answers `500 internal` with
`details.reason = "not_implemented"` and `details.ticket` naming the owner. The
response is contract-valid (every operation declares 500) and the route-parity
test proves every operation in the contract is registered, so the skeleton
cannot quietly shrink the surface it claims.

`/readyz`'s 503 is the one non-envelope response: the contract defines it as
`{status: not_ready, reasons: []}`. Every other non-2xx is the envelope.

## Configuration

The topology binds these (`platform/context-service/1.0.0/topology.yaml`); the
service reads nothing else.

| Variable | Meaning |
| --- | --- |
| `GRAPH_BACKEND` | `embedded` in v0; another declared backend fails startup |
| `GRAPH_PATH` | embedded graph snapshot path (`/data/graph` volume) |
| `AUDIT_PATH` | SQLite audit store path (`/data/audit` volume) |
| `AUDIT_BACKEND` | `sqlite` in v0 |
| `EXECUTION_CONTEXT_PUBLIC_KEY` | PEM public key of the `mastra-app` issuer (#36) |
| `FDE_JOBS_PUBLIC_KEY` | PEM public key of the `fde-jobs` issuer (#36) |
