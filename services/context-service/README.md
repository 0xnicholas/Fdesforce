# `services/context-service`

The platform-owned Python service that serves the internal Context API
(`contracts/context-service-v1.openapi.yaml`). One service, not generated per
Solution: Customer and Solution differences arrive as the compiled Customer
Context Package and environment configuration, never as source
(`docs/runtime-contract.md` §2).

This directory holds the wire surface, the error envelope, the probes, the
contract-derived models, the C1–C15 runner — and, since #36, the **identity
boundary**: ES256 `ExecutionContext` verification, server-side tenant/scope
enforcement and write idempotency. Retrieval, the audit store and approvals land
in #37–#40; the table below says exactly which handler is whose.

## Layout

```text
app/
  main.py            create_app: the one place the service is assembled
  settings.py        environment → Settings; missing configuration fails at startup
  readiness.py       the probe registry /readyz evaluates (ready | degraded | not_ready)
  runtime_info.py    GET /v1/runtime-info, built through the generated RuntimeInfo model
  errors.py          FdeError + handlers: every non-2xx is the unified envelope (§3.4)
  identity.py        ES256 ExecutionContext verification, issuer keys, jti replay (§5.1, §5.4)
  identity_edge.py   the middleware that requires a token and enforces tenant/scope (§5.3)
  idempotency.py     Idempotency-Key: scope, payload fingerprint, replay, conflict (§3.5)
  contract.py        the request seam: JSON Schema validation + body↔token identity binding
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
| `api.py` | the operation table: method, path, auth, required scope, issuer, header requirements, request/response schemas, replay status |
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
python -m conformance        # C1–C15 runner (C1–C3, C5, C6, C10 implemented in this slice)
python -m conformance --list # what runs, what is pending, and which ticket owns it
python scripts/generate.py --check
ruff check app conformance scripts tests
```

To serve it by hand:

```bash
GRAPH_BACKEND=embedded \
GRAPH_PATH=./data/graph/graph.json \
AUDIT_PATH=./data/audit/audit.sqlite \
EXECUTION_CONTEXT_PUBLIC_KEY="$(cat execution-context.pub.pem)" \
FDE_JOBS_PUBLIC_KEY="$(cat jobs.pub.pem)" \
python -m uvicorn --factory app.main:create_app --host 127.0.0.1 --port 8011
```

`--factory` is deliberate: the module has no import-time `app`, so configuration
is read when the process starts (and a missing issuer key stops it there, which
is what fail-closed means), and a test can import `app.main` without a
deployment's environment.

`/healthz` is liveness; `/readyz` is serviceability and may answer `degraded`
with reasons. Neither needs a token.

## The conformance runner

`conformance/harness.py` spawns the **real** service
(`uvicorn --factory app.main:create_app`, a free port, a temp data volume) and
talks to it over HTTP. Nothing imports the app to assert on it: a case that called
a handler directly could pass while the served surface was wrong.

`conformance/identity.py` mints `ExecutionContext` JWTs with **real ES256 keys**,
one pair per issuer (`mastra-app` → `fde://<deployment_id>`, `fde-jobs` →
`fde://<deployment_id>/jobs`). `kid` is the RFC 7638 thumbprint, the same id the
service derives from the public keys the topology binds. `ServiceProcess.authorized()`
mints one per call — `jti` is single use, so two requests cannot share a token —
and the identity cases read each operation's `x-fde-issuer` and
`x-fde-required-scope` from the contract instead of assuming which endpoint wants
which token.

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
on an example that does not validate. Examples embedded in the machine-readable
contract — a schema's `example`/`examples` keyword, an OpenAPI media-type or
parameter `example`/`examples` — are validated against the schema around them.
C1 also checks that every schema document is valid JSON Schema 2020-12, that every
`$ref` in both OpenAPI documents resolves, and that `contracts/README.md` and
`docs/runtime-contract.md` state the same contract minor.

`tests/test_c1.py` plants each failure in a temporary copy of the contract, so the
checks are known to be able to fail: an unmarked example, an invalid doc example,
an invalid schema-embedded example, an invalid OpenAPI-embedded example, a moved
contract minor and a dangling `$ref`.

C10 makes the same demand of the service's status codes: an enveloped `422` is not
enough if the operation never declared it.

### C2, C3, C6: identity is the token, not the request

C2 asks every authenticated operation for an answer without a token and requires
`401 unauthenticated` with the caller's trace in the envelope; it also proves a
token signed by a key this deployment does not hold is not an identity, and that
`/healthz`, `/readyz` and `/v1/runtime-info` stay public.

C3 checks that a client can only *agree* with its token: a plaintext `X-Tenant-Id`
or `X-Actor` that disagrees is a `403`, a `DecisionRequest.tenant_id` or `.actor`
from another identity is a `403`, an operation whose scope the token lacks is a
`403 missing_scope`, and neither issuer can reach the other's surface. The control
request in the same case — a body that agrees — must *not* be refused, so a
service that refused everything would fail.

C6 pins the trace: the JWT `trace_id` must equal the `traceparent` trace-id
(`403` otherwise), `traceparent` is required on authenticated operations (`400`
when absent), and the retrieve, decision and provenance responses carry the
caller's trace.

### C5: one key, one payload

`Idempotency-Key` is scoped by `tenant_id + endpoint + key` and retained for 24
hours. The same key with the same payload is not a conflict; the same key with a
different payload is `409 idempotency_conflict`; a different key is a different
write; a write without a key is `400`. The fingerprint is over the *payload* (key
order and whitespace do not matter), and it is recorded from the first request, so
a key reused after a failed attempt with a different body conflicts too.

A successful response is recorded and replayed as `200` with `idempotent_replay:
true` where the response schema declares that field (`DecisionResponse`); a failed
attempt records nothing to replay, so a retry of the same payload runs again.

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
| Identity: ES256 verification, scope/issuer/tenant, trace binding | served (`app/identity.py`, `app/identity_edge.py`); C2/C3/C6 green |
| Write idempotency: key scope, fingerprint, conflict, replay | served (`app/idempotency.py`); C5 green, replay end-to-end with #37 |
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
| `EXECUTION_CONTEXT_PUBLIC_KEY` | PEM public key of the `mastra-app` issuer; **required** |
| `FDE_JOBS_PUBLIC_KEY` | PEM public key of the `fde-jobs` issuer; **required** |

Both keys are required and are checked at startup: an EC P-256 public key, not a
private one, and not the same key twice — one key pair per issuer is the whole
reason the maintenance surface is separate (§5.1, §5.4). `kid` is not configured;
the service derives the RFC 7638 thumbprint of each key and selects by it.

Two things are in memory, by design in this slice:

- the `jti` replay records, kept until the token would have expired anyway (the
  service is a single writer by contract, §4.3);
- the idempotency records, kept for 24 hours behind the `IdempotencyStore` seam
  that #37 replaces with the audit store's table when the Decision write lands.

A restart therefore forgets both. That is a retry-window problem, not a
correctness one for the audit chain: the Decision write itself stays idempotent on
`decision_id`, which the caller owns (§4.2).
