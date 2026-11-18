# `@fde/runtime-generator-mastra`

The v0 `RuntimeGenerator` implementation (`docs/runtime-adapter.md` §12): it turns
the read-only Acme Solution Spec into a mastra-app source tree with a working Run
API, the runtime-owned topology fragment, the state store migration and the
A-case plan — and refuses to build anything this slice cannot generate honestly.

Landed by ticket: the app skeleton and grammar gate
([#27](https://github.com/0xnicholas/Fdesforce/issues/27)), the Run API, SSE
transport, state store and the three remaining port methods
([#28](https://github.com/0xnicholas/Fdesforce/issues/28)), the identity chain
([#29](https://github.com/0xnicholas/Fdesforce/issues/29)), and the startup
handshake with `/readyz` and `/v1/runtime-info`
([#30](https://github.com/0xnicholas/Fdesforce/issues/30)).

```text
src/
  generator.ts      the port: capabilities / validate / the four generate methods
  grammar.ts        what this generator refuses, and why
  app.ts            the Spec-derived emitters: agents, workflows, tools, schemas, entrypoint
  run-runtime.ts    the Run API runtime emitters: wire, errors, ids, sse, store, registry, router, client
  identity.ts       the identity chain emitters: the role matrix, the loader and the ES256 issuer (#29)
  runtime-info.ts   the handshake emitters: the runtime descriptor, the build checks and the peer checks (#30)
  run-api.ts        the Run API contract as data: operations, statuses, event types, error table
  topology.ts       the RuntimeTopology fragment and the state migration plan
  contract-tests.ts the A1/A2/A5/A8/A11 plan and the assets those cases read
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
  src/index.ts                     opens the store, verifies the schema, handshakes, serves the Run API
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
  src/runtime/config.ts            deployment + identity settings from environment variables
  src/runtime/execution-context.ts the per-call token, trace, deadline and event sink
  src/runtime/roles.ts             the platform role vocabulary and the scope matrix, baked
  src/runtime/identity.ts          the mounted identity source, the issuer key and the ES256 issuer
  src/runtime/runtime-info.ts      the startup handshake: build identity, peer checks, the aggregate
  src/runtime/retrieval.ts         the platform retrieval contract (types + JSON Schema)
contract-tests/
  run-api-smoke.mjs                A2 / A5 against a running bundle
  runtime-info-smoke.mjs           A1: the handshake, matched and mismatched
  identity-smoke.mjs               A8: the issued ExecutionContext, verified
  fixtures/run-api-parity.json     the operations, event types and error table the cases assert
  fixtures/runtime-info.json       what context-service of this release answers
  fixtures/runtime-info-mismatch.json  every mismatch, and the code it must produce
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

Two values are baked from the Spec rather than configured: the Customer
(`TENANT_ID`, the `ExecutionContext` tenant) and the Solution (`SOLUTION_ID`,
`ExecutionContext.solution_id`). One bundle is one Customer, so the tenant is not
a deployment knob (ADR-0006 §4.5) — an install that sets `FDE_TENANT_ID` gets the
baked value.

Nothing in the generated tree is a constant in this package, and generation reads
no clock, randomness, environment value, network or disk. The *generated* app
does read a clock, randomness and the environment — it has to, Run ids are ULIDs,
heartbeats have timestamps and a deployment injects its key — but only in the
named modules (`ids.ts`, `config.ts`, `run-registry.ts`, `context-client.ts`);
`test/determinism.test.ts` fails if a timestamp, a random source or an environment
read appears anywhere else. A module that needs one of the three calls those
modules rather than reaching for the world itself: `runtime-info.ts` stamps the
handshake document with `nowIso()` from `ids.ts` and resolves the context-service
address through `loadConfig()` in `config.ts`, so the single clock and the single
environment read stay single.

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
| `GET` | `/healthz` | liveness only: alive even when the handshake failed |
| `GET` | `/readyz` | readiness: the handshake outcome, as `{status, reasons}` |
| `GET` | `/v1/runtime-info` | the aggregate this app reports and what it learned from context-service |

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

## The identity chain (#29)

A Run cannot call context-service until the app can prove who it is. The chain has
four links, and every one of them is an artifact in the tree:

| Link | Where | What it decides |
| --- | --- | --- |
| platform role vocabulary + scope matrix | `src/runtime/roles.ts` | who may do what; baked from the bundle, never configured |
| static identity source | mounted at deploy: `FDE_IDENTITY_CONFIG` (JSON file) or `FDE_IDENTITY_CONFIG_JSON` | which subject a Run runs as, and the platform/business roles it asserts |
| role mapping | `scopesForRoles` in `roles.ts` | platform roles grant scopes; business roles are data permissions and grant nothing |
| ES256 signature | `src/runtime/identity.ts` | `iss = fde://<deployment_id>`, `aud = context-service`, five minutes, `kid` + `jti` |

The shape is the future OIDC resource server's (`docs/runtime-contract.md` §5.1):
claims in, mapping, signed assertion out. Real JWKS/introspection/JIT replace the
second link in Slice 2.4; nothing else moves.

**The `ExecutionContext`.** `test/contract-drift.test.ts` mints a real token and
compares its claim set with `contracts/schemas/execution-context.schema.json`, so
the emitted assertion cannot drift from the shape context-service validates
against. The claims are: `iss` `fde://<deployment_id>`, `aud` `context-service`,
`sub`/`actor` from the configured subject, `tenant_id` = the Customer,
`deployment_id`, `solution_id`, `run_id`, `trace_id` (the Run's, so `traceparent`
and the token agree), `roles` = platform ∪ business, `scopes` = the union the
platform roles grant, `iat`/`exp`, `jti` (a ULID, so two tokens for one Run never
match) and `kid`.

`exp - iat` is five minutes, and never past the Run's deadline: the token is
minted for one Run before the workflow starts, and a token that outlived its Run
would be a replayable credential for a Run that is over.

**`kid` is derived, not configured.** It is the RFC 7638 JWK thumbprint of the
public key, so context-service computes the same id from the public key it is
given: a `kid` cannot name the wrong key, and a rotated key automatically gets a
new id instead of inheriting a stale one.

**Nothing secret is in the tree.** The `mastra-app` issuer key is injected
(`FDE_SIGNING_KEY` as a PEM, or `FDE_SIGNING_KEY_FILE` pointing at a mounted one,
which wins when both are set) and §5.4 is explicit that it never appears in the
bundle — so the emitter has no key, the loader never serializes one, and an error
message names the setting rather than echoing a value. The token is not logged
either: it is a bearer credential. `test/identity.test.ts` asserts all three.

The topology delivers it as a mount, not a literal: the `mastra-app` component
claims `customer:fde/execution-context-signing-key`, the fragment binds it at
`/run/secrets/execution-context-signing-key`, and the app is told the path through
`FDE_SIGNING_KEY_FILE`. `fde install keys` (#34) is what puts a key at that path and
`fde install verify` is what refuses a bundle carrying one.

**The app refuses to serve without it.** `src/index.ts` resolves the deployment id,
the key and the profile *after* the state-store schema check and before it listens;
a failure exits non-zero with one line naming the missing setting. A Run API that
can never call context-service is not a degraded deployment, it is a broken one.

**The same refusals as the build, plus the one the build cannot make.** The profile
is mounted at deploy time and can differ from the one the build saw, so
`loadIdentity` re-asserts what `runtime-generator`'s gate asserts: an unknown
platform role, a business role that reuses (or, ignoring case and space, only looks
like) a platform role name, a scope no platform role grants, more roles than an
`ExecutionContext` carries, and a profile for another Customer. It also refuses a
profile for another **Environment** (`ENVIRONMENT_NAME` is baked from the build) —
a check the build cannot be the only owner of, because the mount happens after the
build and §4.3 scopes a profile's roles to one Environment.
`test/identity.test.ts` drives both gates with the same documents, in both
directions.

| Setting | Meaning |
| --- | --- |
| `FDE_DEPLOYMENT_ID` | `dep_<ulid>`; `iss` is `fde://<deployment_id>`, and the contract schema pins the shape |
| `FDE_IDENTITY_CONFIG` | path to the mounted `IdentityProfile` (JSON — the app carries no YAML parser) |
| `FDE_IDENTITY_CONFIG_JSON` | the same document inline, for a run with no mount |
| `FDE_SIGNING_KEY` | the issuer key, PKCS#8 PEM, EC P-256 |
| `FDE_SIGNING_KEY_FILE` | a mounted PEM; wins over `FDE_SIGNING_KEY` |

None of them may arrive through `Environment.values`: `generateTopology` refuses a
build that puts an identity setting there, because `values` is rendered into the
topology artifact — a signing key in a signed, shipped bundle is exactly what §5.4
forbids, and a subject list there is deploy data in a build artifact.

```yaml
# examples/identity/acme/acme-prod.yaml, mounted as JSON
apiVersion: fde.dev/v0
kind: IdentityProfile
metadata: { customer: acme, environment: acme-prod }
spec:
  source: static            # OIDC is Slice 2.4
  defaultSubject: adjuster-1
  subjects:
    - subject: adjuster-1
      display: Ada Adjuster
      platformRoles: [end_user]          # grant scopes
      businessRoles: [claims-adjuster]   # data permissions only
```

That profile names people, so it is mounted beside the key rather than baked: the
bundle carries the matrix, never the subjects (`test/identity.test.ts` asserts a
subject the build saw does not appear in the tree). Rendering those mounts and
injecting `FDE_DEPLOYMENT_ID` is the deployment's: the fragment's one
`secretBindings` entry is the app's own signing key, and every other secret —
context-service's public keys, the jobs key — belongs to the platform fragment
(#32).

## The startup handshake (#30)

An image tag that moved, a `mastra-app` deployed beside a `context-service` from
another release, a Profile edited between build and deploy: the build's verdict is
only as good as the artifact that boots. `runtime/runtime-info.ts` is the second
check (§9.3), and its rule is fail closed.

**Seven blocks, one per source document**, so every check compares two of them
rather than a constant with itself:

| Block | Comes from | Proves |
| --- | --- | --- |
| `LOCK_PINS` | `solution.lock#/runtime` | what the build promised |
| `PROFILE_IDENTITY` | the Runtime Profile artifact | what the Profile declared |
| `GENERATOR_IDENTITY` | this generator | who emitted the tree |
| `ENVIRONMENT` | the build Environment | which store, and the delivery target |
| `RUNTIME` | derived from the above | what the app reports |
| `CAPABILITY_DETAILS`, `REQUIREMENTS` | Profile + Spec (`§7.1`) | what the app can do, `must` and `should` |
| `STATE_STORE_KIND` | `state-store.ts` | what the app actually opens |

`handshake()` runs them in order: this build against its own blocks, then
`GET /v1/runtime-info` on context-service, then the peer against the lock, then the
aggregate. Failures are reported, never thrown — the process has to stay up for
`/readyz` to say what is wrong.

| Check | Code | `details.reason` |
| --- | --- | --- |
| contract major (Profile vs lock, peer vs lock) | `contract_mismatch` | `contract_major_mismatch` |
| context-service's graph / audit schema ≠ the lock | `contract_mismatch` | `graph_schema_mismatch`, `audit_schema_mismatch` |
| the peer is not context-service, or is not `RuntimeInfo` | `contract_mismatch` | `context_service_identity`, `runtime_info_invalid` |
| Profile digest ≠ the lock's, or ≠ the artifact's | `runtime_capability_mismatch` | `runtime_profile_mismatch` |
| family / language / runtime version / generator version | `runtime_capability_mismatch` | `runtime_*_mismatch` |
| state store kind or schema ≠ the Environment's | `runtime_capability_mismatch` | `runtime_state_store_mismatch` |
| a `must` path missing, `none` or `degraded` | `runtime_capability_mismatch` | `runtime_capability_missing`, `runtime_capability_degraded` |
| offline target with egress or a license key | `runtime_capability_mismatch` | `runtime_license_blocked` |
| the peer answers 4xx: it does not serve `/v1/runtime-info` | `contract_mismatch` | `runtime_info_missing` |
| context-service unreachable, 5xx or timed out | `unavailable` (retryable) | `context_service_unreachable` |

The v1.0 `capabilities` array is the Profile's ten groups minus the ones declared
`none`, derived in `aggregate` from the same block as `capability_details`. §9.2's
example spells feature words (`runs`, `approvals`) rather than group names; the
contract fixes no vocabulary there, so the choice is the one that cannot drift from
the structured map. What a Run may start is a different list — the Solution's
`capability_id`s — and the Run API answers for it (a 422 from `POST /v1/runs` names
them).

A `should` the Profile cannot fully provide is not a failure: the deployment serves
and `/readyz` says `degraded` with the reason (§7.3). §9.3's bullet 3 said a
profile-digest mismatch is a `contract_mismatch`; the ticket's acceptance criterion
says capability/Profile mismatches are `runtime_capability_mismatch`, and the
reason detail carries the same token, so an operator greps for the same string
either way. The doc now says so.

A 4xx is a mismatch, not an outage: a peer that answers 404 is up and refusing the
route, so the two sides disagree about what `runtime-info` is — the same class as a
contract major that moved. Only a 5xx, a timeout or a transport failure is
`unavailable`, which is the one retryable outcome and the one a restart can fix.

**Serving.** `/healthz` stays 200 whatever the outcome. `/readyz` answers the
contract's `{status, reasons}` with 200 (`ready`, `degraded`) or 503 (`not_ready`,
each reason prefixed with its code). `/v1/runtime-info` serves the aggregate at
200, or the error envelope at 503. Every Run route — create, read, stream, cancel,
and a read of an unknown id — answers 503 with the failure's code while the
handshake has not passed: a `404` there would read as "no such Run" when the truth
is "not this deployment". The aggregate is this app's descriptor and capability map
plus what the peer reported: `components[]` names `runtime-app`, `runtime-state`,
context-service's own entry and every store it owns, once each.

The handshake runs **once, before `listen`**, so a Run can never arrive in the
window between "the process started" and "the runtime proved it is the build the
lock describes". Recovery is a restart or a fixed deployment, not a slow heal:
that is what "fail closed" costs, and the alternative — a `/readyz` that re-runs
the handshake — would make the readiness surface a second, clock-driven state
machine inside the tree.

**Identity stays a startup failure.** A missing key or a profile for another
Environment exits non-zero before the handshake runs (#29); it is deliberately not
reported as a readiness reason, because a Run API that cannot mint an
`ExecutionContext` has no degraded mode — every Run would fail at the first
context-service call. Readiness answers "is this the build the lock describes and
can it talk to context-service", not "is every injected secret correct".

`FDE_CONTEXT_SERVICE_URL` overrides the bundle-internal address for a local run or
a smoke test, like `FDE_PORT`. It is not a deployment knob, and it moves both the
handshake and the Run data plane: the address lives in `runtime/config.ts` and the
context client resolves its default from the same place, so the two cannot end up
talking to different services.

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
- the startup order, one secret binding (the app's own ES256 signing key, mounted
  at `/run/secrets/execution-context-signing-key`) and the `{{deployment_id}}` naming templates.

context-service, the graph and audit volumes and the ingest job are the platform's
fragment (#32). The fragment is a `RuntimeTopology`, validated against the schema;
`checkTopology` on it reports exactly two findings — context-service is missing and
`dependsOn` points at it — which is the composition's job to answer, and anything
else would be a fragment bug. The health check is `/readyz`, not `/healthz`: a
container that is alive but failed the startup handshake must not be sent traffic,
and both paths are the ones the emitted router serves (`src/deployment.ts` is the
single source for them).

The deployment constants both artifacts share — port, volume name, mount path,
database path, migrate entrypoint, probe path — live in `src/deployment.ts`, so the
app cannot listen on a port the topology does not expose.

## The A-case plan

`generateContractTests` maps only the cases this slice's app can satisfy:

| Case | Tier | Command | Fixtures |
| --- | --- | --- | --- |
| A1 Runtime capability handshake | smoke | `node --experimental-strip-types contract-tests/runtime-info-smoke.mjs` | `contract-tests/fixtures/runtime-info.json`, `contract-tests/fixtures/runtime-info-mismatch.json` |
| A2 Run API parity | smoke | `node contract-tests/run-api-smoke.mjs --case A2` | `contract-tests/fixtures/run-api-parity.json` |
| A5 SSE envelope | smoke | `node contract-tests/run-api-smoke.mjs --case A5` | `contract-tests/fixtures/run-api-parity.json` |
| A8 Tenant / trace propagation | smoke | `node --experimental-strip-types contract-tests/identity-smoke.mjs` | — |
| A11 Deterministic generation | static | `fde verify --case A11` | — |

A1 is claimed for the runtime half. The two fixtures are the two sides of the
handshake: the peer document a deployment should get, and eleven mutations of the
peer or of the build — contract major, graph and audit schema, peer identity, a
malformed document, profile digest, runtime version, state store, a `must` that is
degraded, a `must` the Profile does not declare, offline egress — each paired with
the code and reason it must produce. The smoke drives the app's own
`handshake()` with them, so a check that stops firing fails the case; with
`--base-url` it also asserts the deployed bundle's `/readyz` and
`/v1/runtime-info`. That context-service *enforces* its own handshake and schema
versions is the platform fragment's (#32), and the case's notes say so.

The parity fixture carries the Solution's own capability ids, so the smoke starts
one of *this* Spec's capabilities rather than a hardcoded Acme id, and A2 accepts
`202` or the contract's `409` for a cancel that races the Run's end.

A8 is claimed for the half this app owns. The token's tenant, trace, role union and
signature are one half; the other is propagation — so the smoke drives the app's own
`ContextClient` against a recording transport and asserts the bearer token it sends
is the Run's token and that `traceparent`'s trace-id equals the claim's. That
context-service *enforces* them is the platform fragment's (#32), and the plan says
so in the case's notes instead of claiming the whole case. The identity smoke has no fixture because it mints with a
key it generates: a committed signing key is the one thing §5.4 forbids in a
bundle.

Because the app now refuses to serve without an identity (#29), whatever boots a
bundle for A2/A5 has to inject a deployment id, a key and a profile — a dev profile
is fine, and generating one is the CLI's job (#33), not the runner's.

The generator maps cases to commands; it does not implement a runner
(`contracts/conformance/adapter-cases.md`). A3/A4/A6/A7/A9/A10/A12 belong to HITL,
record-before-act, restart resume, extension loading, offline install and memory.
The plan says so by omission, and the smoke scripts are executed in this package's
tests — A1 and A8 against the materialised bundle, A2/A5 against the emitted router
with a stub executor (`test/run-api-http.test.ts`) and against the booted bundle
(`test/boot.test.ts`), all of them in `test/contract-tests.test.ts` — so the mapping
cannot rot into a command that proves nothing.

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
| real OIDC: JWKS/introspection, JIT provisioning, claim mapping | Slice 2.4 replaces the *source* of the role mapping (`loadIdentity`) and nothing else; the ES256 chain behind it is #29 and does not move |
| per-call token reissuance, `on_behalf_of`, approval-proxy tokens | the whole Run shares the ExecutionContext minted for it, with `exp` capped at the Run deadline; `on_behalf_of` stays unimplemented because v0 does not let a service impersonate a user (§5.1) |
| capability `audit.runOutcomeDecision`, the run-level Decision write | `ContextClient.recordDecision` carries the write path and its retry semantics; the call lands with audit (#37/#42) |
| `text.delta` / `text.done` (token streaming) | the envelope already allows them; emitting them needs the Agent `stream()` path and the Mastra `writer` mapping, an additive follow-up after this slice |
| `approval.*` events, approval proxy routes | Slice 2 HITL (C16–C25): the approval resource is served by context-service (#40), but a workflow that suspends on it — and the app route that proxies to it — is not generated in this slice |
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
| `test/runtime-info.test.ts` | the emitted handshake: the document against `runtime-info.schema.json`, the aggregate, and every build-side and peer-side refusal, driven through `handshake()` with a stub peer |
| `test/run-api-http.test.ts` | the emitted router over a socket: create/replay/conflict, cancel, SSE, error envelopes, readiness, the aggregate, the fail-closed Run gate, and the A2/A5 smoke |
| `test/boot.test.ts` | the generated entrypoint as a process: migrate, boot, liveness and readiness, the aggregate, a Run reaching context-service with a minted token, refusing to start without a key or identity source, refusing an unmigrated store, refusing to serve a mismatched or unreachable context-service, and the A2/A5 smoke against the real bundle |
| `test/topology.test.ts` | the RuntimeTopology fragment: schema, pins, ports, volumes, job, startup order |
| `test/migrations.test.ts` | the migration plan and its agreement with the topology job |
| `test/contract-tests.test.ts` | the A-case mapping, the parity and handshake fixtures, and the smoke scripts executed against the materialised bundle |
| `test/identity.test.ts` | the identity chain, executed: a real ES256 token verified with its public key, the role mapping, both injection mechanisms, every load refusal, and no key or token in an emitted file or a message |
| `test/contract-drift.test.ts` | the retrieval and Run API copies, and the issued `ExecutionContext` claims, against `contracts/` and the contract doc |
| `test/determinism.test.ts` | A11: same input → same bytes and digest; entropy only where it is allowed |
| `test/compile.test.ts` | the tree typechecks against the pinned `@mastra/core`, plus the package boundary |
| `test/port.test.ts` | port identity, `capabilities`, and every `generate*` re-checking the gate |

`test/compile.test.ts` materialises the tree inside this package's
`node_modules/.cache`, so `@mastra/core`, `@types/node` and `typescript` resolve
from the versions this package pins — `devDependencies['@mastra/core']` is asserted
to equal the Profile's pin, so the check cannot silently drift from the artifact it
is checking.
