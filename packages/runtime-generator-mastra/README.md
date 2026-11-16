# `@fde/runtime-generator-mastra`

The v0 `RuntimeGenerator` implementation (`docs/runtime-adapter.md` §12): it turns
the read-only Acme Solution Spec into a mastra-app source tree with a working Run
API, the runtime-owned topology fragment, the state store migration and the
A-case plan — and refuses to build anything this slice cannot generate honestly.

Landed by ticket: the app skeleton and grammar gate
([#27](https://github.com/0xnicholas/Fdesforce/issues/27)), the Run API, SSE
transport, state store and the three remaining port methods
([#28](https://github.com/0xnicholas/Fdesforce/issues/28)). Identity issuance is
[#29](https://github.com/0xnicholas/Fdesforce/issues/29); `/readyz` and the
startup handshake are [#30](https://github.com/0xnicholas/Fdesforce/issues/30).

```text
src/
  generator.ts      the port: capabilities / validate / the four generate methods
  grammar.ts        what this generator refuses, and why
  app.ts            the Spec-derived emitters: agents, workflows, tools, schemas, entrypoint
  run-runtime.ts    the Run API runtime emitters: wire, errors, ids, sse, store, registry, router, client
  run-api.ts        the Run API contract as data: operations, statuses, event types, error table
  topology.ts       the RuntimeTopology fragment and the state migration plan
  contract-tests.ts the A2/A5/A11 plan and the assets those cases read
  deployment.ts     the deployment constants the app and the topology must agree on
  builtins.ts       the platform built-in Tools and the retrieval contract
  naming.ts         the one place a Spec id becomes a TypeScript identifier
```

## The generated tree

```text
mastra-app/
  Dockerfile                       node:<locked>, npm install, runs src/index.ts
  package.json                     every dependency from the Runtime Profile, node from the lock
  tsconfig.json                    typecheck-only (`erasableSyntaxOnly`, `allowImportingTsExtensions`)
  src/index.ts                     opens the store, verifies the schema, serves the Run API
  src/migrate.ts                   the runtime-migrate job: apply the state store schema
  src/mastra.ts                    the Mastra instance: agents + workflows
  src/agents/<agent>.ts            instructions baked verbatim from the pinned prompt file
  src/workflows/<flow>.ts          one `createStep` per Spec step, chained in declared order
  src/tools/<tool>.ts              one `createTool` per reachable Tool, emitting tool.call/tool.result
  src/schemas/<file>.ts            each referenced JSON Schema, verbatim
  src/runtime/wire.ts              the Run API contract: types, tables, request validation
  src/runtime/errors.ts            `ApiError` and the unified error envelope
  src/runtime/ids.ts               ULIDs, trace ids, `traceparent`, the only clock/randomness
  src/runtime/canonical.ts         stable JSON and the sha256 digest idempotency is scoped by
  src/runtime/sse.ts               the SSE frame, the event fan-out, the heartbeat cadence
  src/runtime/state-store.ts       libsql/SQLite: runs, events, idempotency — via `node:sqlite`
  src/runtime/run-registry.ts      the Run lifecycle: transitions, cancel, deadline, heartbeats
  src/runtime/router.ts            the HTTP surface: routes, SSE responses, error envelopes
  src/runtime/run-service.ts       capability → workflow, RequestContext, abort propagation
  src/runtime/context-client.ts    the single seam to context-service, with the retry policy
  src/runtime/config.ts            deployment configuration from environment variables
  src/runtime/execution-context.ts the per-call token, trace, deadline and event sink
  src/runtime/identity.ts          the ExecutionContext issuance seam (#29)
  src/runtime/retrieval.ts         the platform retrieval contract (types + JSON Schema)
contract-tests/
  run-api-smoke.mjs                A2 / A5 against a running bundle
  fixtures/run-api-parity.json     the operations, event types and error table the cases assert
```

Paths are bundle-root-relative and sorted; every file carries an explicit mode;
`sourceDigest` is `digestFiles()` over the returned set, the same rule
`solution.lock.spec.digest` uses.

### Where every version comes from

| Version | Source |
| --- | --- |
| `@mastra/core` and any other app dependency | `RuntimeProfile.spec.packages` — the Profile describes the generated app, so its package set *is* the app's dependency set |
| Node | `solution.lock.runtime.node` |
| provider / model / model version / params | the pinned `ModelProfile` document |
| state store schema | `RuntimeProfile.spec.capabilities.stateStore.schemaVersion` |
| contract version | `solution.lock.runtime.contractVersion` (`FDE_CONTRACT_VERSION` build arg) |

Nothing in the generated tree is a constant in this package, and generation reads
no clock, randomness, environment value, network or disk. The *generated* app
does read a clock and randomness — it has to, Run ids are ULIDs and heartbeats
have timestamps — but only in four named modules (`ids.ts`, `config.ts`,
`run-registry.ts`, `context-client.ts`); `test/determinism.test.ts` fails if a
timestamp or an environment read appears anywhere else.

### Why the app runs TypeScript directly

`package.json`'s dependency set is exactly the Runtime Profile's package set, and
the Profile pins no compiler — so there is no build step, and the image runs
`node --experimental-strip-types src/index.ts`. The compile check is
`tsc --noEmit` over the same sources with the workbench toolchain
(`test/compile.test.ts` runs it against this package's pinned `@mastra/core`);
`tsconfig.json` sets `erasableSyntaxOnly`, which makes the compiler prove the
sources can be stripped. Import specifiers therefore carry the `.ts` extension,
which is what Node's type stripping resolves.

The same rule is why the state store is `node:sqlite` and the HTTP surface is
`node:http`: the Profile pins no SQL driver, no libsql client and no web
framework, so the generated app uses what Node ships.

## The Run API (#28)

| Method | Path | Behaviour |
| --- | --- | --- |
| `POST` | `/v1/runs` | requires `Idempotency-Key` (16–128 chars); `201` with `run_id`/`trace_id`/`status`/`stream_url` |
| `GET` | `/v1/runs/{run_id}` | `200` contract `RunStatus`; `404 not_found` |
| `GET` | `/v1/runs/{run_id}/stream` | `text/event-stream`; replays from `Last-Event-ID`, then live |
| `POST` | `/v1/runs/{run_id}/cancel` | `202` with the cancelled `RunStatus`; `409 conflict` if it already finished |
| `GET` | `/healthz` | liveness only (`/readyz` is #30) |

The port is 4111, which is the container port the topology exposes. `FDE_PORT`
overrides it for a local run or a smoke test on a shared box (`0` asks the OS); it
is not a deployment knob — the renderer maps container port to host port.

Every non-2xx response is the contract error envelope — code, message,
`retryable`, `details`, `trace_id` — including request-body validation, which is
normalised by hand into `422 validation_failed` with field paths (C10) rather
than a framework's default shape. `test/run-api-http.test.ts` drives the emitted
router over a loopback socket, and the emitted A2 smoke (`contract-tests/run-api-smoke.mjs`)
is run against it, so the contract-test mapping is verified rather than assumed.

**Idempotency.** A key is scoped by `tenant_id + endpoint + key` (§3.5). The first
request records the Run and its response in one SQLite transaction; the same key
with the same canonical payload returns the stored response untouched; a different
payload is `409 idempotency_conflict`. The replay returns `201`, not the generic
`200` of §3.5, because `POST /v1/runs` declares only `201` and `RunCreateResponse`
forbids extra fields — an `idempotent_replay` flag would be a contract violation
to report a contract behaviour. §3.5 records that exception, so the contract and
this section do not disagree; a client recognises a replay by the `run_id`, never
by the status code.

**Status.** A Run is `queued` until the executor picks it up, `running` while the
workflow executes, then one of `succeeded`/`failed`/`cancelled`. A client that
polls instead of streaming therefore sees a real transition, not `queued` forever.

**SSE.** `seq` starts at 1 and is monotonic per Run, assigned by the state store in
the same transaction that writes the event. Every event carries `run_id`,
`trace_id`, `timestamp` and a `payload`. Only the nine event types this slice
produces are accepted by `runtime/sse.ts`; `approval.*` is defined by the contract
and refused by the emitter until HITL lands. A heartbeat runs every 10s (the
contract ceiling is 15s), only while a client is attached. The Agent step calls
`Agent.generate()`, so the answer arrives in `run.finished`: this slice emits
`run.started`, `tool.call`/`tool.result`, the terminal events and `heartbeat`, but
not `text.delta`/`text.done`. Token streaming is inside the allowed envelope and
needs the Agent `stream()` + Mastra `writer` mapping, which is an additive
follow-up rather than a change to the contract. `Last-Event-ID` replays
from the persisted log; a Run that already finished ends its stream immediately
after the replay instead of leaving a client attached to a Run that will never
speak again. A client that disconnects cancels its Run (§7.5 default) unless the
Run had already finished.

**Cancel.** `202`, then the run-scoped `AbortController` aborts. That signal is
handed to the workflow executor, which calls `Run.cancel()`, and to every Tool
through the Mastra request context, where the context client passes it to `fetch`
and checks it before every retry. A cancelled Run writes `run.cancelled` and keeps
the evidence already recorded.

**Deadline.** Five minutes by default (`FDE_RUN_DEADLINE_MS`). The same abort path
fails the Run with `504 timeout`, which is retryable by the client application.

## The state store

`mastra-state` is a libsql/SQLite database on its own volume (§9.2), holding the
Run registry, the SSE event log and the idempotency index — and nothing else:
Decisions live in context-service, append-only (C4/C13).

| Table | Rows |
| --- | --- |
| `schema_migrations` | one row per applied migration, with the Profile's schema version |
| `runs` | the contract `RunStatus` per Run |
| `run_events` | the SSE log, `PRIMARY KEY (run_id, seq)` |
| `idempotency` | `tenant_id + endpoint + key`, request digest, original response |

`generateMigrations` emits one forward-only step, and the topology runs it as the
`runtime-migrate` job before the app starts. `src/index.ts` verifies the store's
schema version and exits non-zero if the migration has not run: an app on an
unmigrated store cannot keep the Run registry it promises (A6). The app never
creates the volume directory; a missing mount fails the migration instead of being
papered over inside the image.

## The context client

One class, one bundle-internal address, one retry policy (`docs/runtime-contract.md`
§7.1):

- retries only `retryable=true` (the envelope's flag, or the §3.4 status mapping
  when a response is not the envelope);
- at most two retries (three attempts), exponential backoff (200ms, 400ms) with up
  to 50% jitter and the 2s cap applied after the jitter, floored by `Retry-After`
  (seconds or HTTP date — a server that names a longer wait is obeyed, and only the
  Run deadline bounds it);
- refuses to start an attempt — or to wait for a retry — past the Run deadline, and
  fails with `timeout` when the budget is gone;
- passes the Run's abort signal to `fetch` and never retries a cancellation;
- computes the `Idempotency-Key` and the request body once, before the retry loop,
  so a retried write is the same write: same key, same `decision_id`.

`test/context-client.test.ts` executes the emitted client against a recording
transport, so each rule is asserted on the requests that were actually made.

## The contract copy

A generated bundle cannot import `@fde/contracts-client` — it is a private
workspace package, and the bundle's dependency set is the Runtime Profile's. So
`src/run-api.ts` carries the Run API contract as data: the four operations with
their declared statuses, the event-type enum, the slice's event subset, the
status enum, the identifier patterns and the full error table. It feeds the
emitted `runtime/wire.ts`, the router, and the A2/A5 parity fixture.

`test/contract-drift.test.ts` compares that copy against three independent sources:
`contracts/runtime-api-v1.openapi.yaml`, `contracts/schemas/{run,common}.schema.json`,
and the error table in `docs/runtime-contract.md` §3.4. A contract change that
leaves the copy behind fails the build, and a copy that invents an operation,
event or error code fails it too.

## The topology fragment

`generateTopology` declares only what the generator owns (§8.1, §8.2):

- the `mastra-app` component — build context `mastra-app`, port 4111 exposed, the
  `mastra-state` volume at `/app/state`, `NODE_ENV` and `FDE_STATE_STORE_PATH` plus
  every non-secret Environment value (sorted), `dependsOn: [context-service]`,
  1 CPU / 1 GiB;
- the `mastra-state` volume (`backup: true`);
- the `runtime-migrate` job, running before `mastra-app`;
- the startup order, empty secret bindings (secrets are the platform's) and the
  `{{deployment_id}}` naming templates.

context-service, the graph and audit volumes and the ingest job are the platform's
fragment (#32). The fragment is a `RuntimeTopology`, validated against the schema;
`checkTopology` on it reports exactly two findings — context-service is missing and
`dependsOn` points at it — which is the composition's job to answer, and anything
else would be a fragment bug. The health check is `/healthz` until #30 generates
`/readyz` and the startup handshake, because a container must be checked against a
route that exists.

The deployment constants both artifacts share — port, volume name, mount path,
database path, migrate entrypoint, probe path — live in `src/deployment.ts`, so the
app cannot listen on a port the topology does not expose.

## The A-case plan

`generateContractTests` maps only the cases this slice's app can satisfy:

| Case | Tier | Command | Fixtures |
| --- | --- | --- | --- |
| A2 Run API parity | smoke | `node contract-tests/run-api-smoke.mjs --case A2` | `contract-tests/fixtures/run-api-parity.json` |
| A5 SSE envelope | smoke | `node contract-tests/run-api-smoke.mjs --case A5` | `contract-tests/fixtures/run-api-parity.json` |
| A11 Deterministic generation | static | `fde verify --case A11` | — |

The parity fixture carries the Solution's own capability ids, so the smoke starts
one of *this* Spec's capabilities rather than a hardcoded Acme id, and A2 accepts
`202` or the contract's `409` for a cancel that races the Run's end.

The generator maps cases to commands; it does not implement a runner
(`contracts/conformance/adapter-cases.md`). A3/A4/A6/A7/A9/A10/A12 belong to HITL,
record-before-act, restart resume, extension loading, offline install and memory;
A1's runtime half and A8 belong to #30 and #29. The plan says so by omission, and
the smoke script is executed twice in this package's tests — against the emitted
router with a stub executor (`test/run-api-http.test.ts`) and against the booted
bundle (`test/boot.test.ts`) — so the mapping cannot rot into a command that
proves nothing.

## The grammar gate

`validate` is the shared capability gate (`@fde/runtime-generator`) plus this
generator's grammar gate. Every `generate*` method re-checks and throws, so a
caller that skipped `validate` cannot get a tree with a construct silently dropped
out of it.

| Construct | Diagnostic | Why |
| --- | --- | --- |
| `approval` step | `runtime_grammar_unsupported` | HITL request/wait/commit and `approval.required` SSE are C16–C25 |
| Tool with `sideEffects: write \| external` | `runtime_grammar_unsupported` | record-before-act, intent/outcome Decisions and evidence selectors are C26–C32 |
| a `tool` step calling a side-effecting Tool | `runtime_grammar_unsupported` | same, reported at the step as well as the Tool |
| Agent `memory` declaration | `runtime_grammar_unsupported` | thread memory needs the runtime state store, long-term memory is `fde_memory` (C41–C48) |
| an agent-implemented Capability | `runtime_grammar_unsupported` | the Run service starts workflows; there is no agent Run path in this slice |
| a Capability pointing at an undeclared Workflow | `runtime_grammar_unsupported` | the generated `run-service.ts` would import a module that does not exist |
| Extension with `interface: tool` | `runtime_extension_unsupported` | the app would have to load the artifact itself (A9); v0 emits no loader |
| capability-level `extensionRefs` | `runtime_extension_unsupported` | same |
| a workflow step referencing an undeclared Tool, Agent or recipe binding | `runtime_grammar_unsupported` | there is nothing to generate |
| an Agent listing a Tool the Spec does not declare | `runtime_grammar_unsupported` | same |
| two Spec ids that map to one TypeScript identifier | `runtime_grammar_unsupported` | the tree would not compile |
| a Tool that is neither `builtin` nor `connectorRef` + `operation` | `runtime_grammar_unsupported` | no implementation to generate |
| a builtin this generator does not publish | `runtime_grammar_unsupported` | the builtin has no body and no schema |
| an Environment selecting a non-SQLite state store | `runtime_state_store_unsupported` | the emitted schema is libsql/SQLite (`node:sqlite`); a Postgres store has no emitted schema, even though the Profile may list one for a future generator |

A `connector` Extension is accepted: context-service executes it through a typed
operation, so the generated app never sees the artifact.

### What the tree deliberately does not do

These are not silent drops: each belongs to another component or slice, and each
is recorded here so an FDE engineer reading the tree knows where it went.

| Spec construct / contract behaviour | Where it lands |
| --- | --- |
| ExecutionContext issuance (ES256, static identity config, role mapping) | `runtime/identity.ts` is the seam and throws `unavailable`; the body is #29. A Run therefore fails with `run.failed` + `unavailable` in a bundle built before #29 — a built bundle serves the Run API, but cannot call context-service yet |
| `/readyz`, `/v1/runtime-info`, the startup handshake | #30 |
| capability `audit.runOutcomeDecision`, the run-level Decision write | `ContextClient.recordDecision` carries the write path and its retry semantics; the call lands with identity and audit (#29/#37/#42) |
| `text.delta` / `text.done` (token streaming) | the envelope already allows them; emitting them needs the Agent `stream()` path and the Mastra `writer` mapping, an additive follow-up after this slice |
| `approval.*` events, approval proxy routes | #29/#40, C16–C25 |
| `workflow.durable` resume, reconciler | C26–C32/A6 |
| capability `budget` (tool calls / steps per Run) | #29 |
| `build.toolchain.image` | build provenance (#33) |
| Model Profile `params.responseFormat` / `params.extra` | neither is baked: structured output comes from the step's `outputSchema` |

## Test seams

| File | Seam |
| --- | --- |
| `test/grammar.test.ts` | the gate, one refused construct at a time |
| `test/app.test.ts` | the generated tree: paths, modes, pins, agent/workflow/tools content |
| `test/run-api-runtime.test.ts` | the emitted ids, canonical digest, wire validation, error envelope and SSE envelope, executed |
| `test/state-store.test.ts` | the emitted state store on a real database file: migration, restart, event log, idempotency |
| `test/context-client.test.ts` | the emitted client against a recording transport: the whole §7.1 retry policy |
| `test/run-api-http.test.ts` | the emitted router over a socket: create/replay/conflict, cancel, SSE, error envelopes, and the A2/A5 smoke |
| `test/boot.test.ts` | the generated entrypoint as a process: migrate, boot, liveness, a Run failing closed without identity, refusing an unmigrated store, and the A2/A5 smoke against the real bundle |
| `test/topology.test.ts` | the RuntimeTopology fragment: schema, pins, ports, volumes, job, startup order |
| `test/migrations.test.ts` | the migration plan and its agreement with the topology job |
| `test/contract-tests.test.ts` | the A-case mapping, the parity fixture and the smoke script's syntax |
| `test/contract-drift.test.ts` | the retrieval and Run API copies against `contracts/` and the contract doc |
| `test/determinism.test.ts` | A11: same input → same bytes and digest; entropy only where it is allowed |
| `test/compile.test.ts` | the tree typechecks against the pinned `@mastra/core`, plus the package boundary |
| `test/port.test.ts` | port identity, `capabilities`, and every `generate*` re-checking the gate |

`test/compile.test.ts` materialises the tree inside this package's
`node_modules/.cache`, so `@mastra/core`, `@types/node` and `typescript` resolve
from the versions this package pins — `devDependencies['@mastra/core']` is asserted
to equal the Profile's pin, so the check cannot silently drift from the artifact it
is checking.
