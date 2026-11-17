# Fdesforce

The FDE workbench: turn a Customer's Solution Spec into a deployable bundle, and
keep the build honest (pinned inputs, fail-closed gates, reproducible digests).

Design lives in [`docs/`](docs/) with decisions in [`docs/adr/`](docs/adr/) and
domain language in [`GLOSSARY.md`](GLOSSARY.md). The wire contract lives in
[`contracts/`](contracts/) and is the single source of truth for anything that
crosses a process boundary.

## Repository layout

| Path | What it is |
| --- | --- |
| `contracts/` | `fde.runtime/v1` OpenAPI + JSON Schema. Source of truth for the wire surface. |
| `docs/` | Design documents, ADRs, agent guidance. |
| `examples/` | Reference artifacts: Acme Solution Spec + lock, eval and semantic assets, the `acme-prod` Identity Profile, and the workspace manifest the CLI resolves them through. |
| `platform/` | Vendored platform artifacts: Templates, Overlays, Extensions, Model/Runtime Profiles and the pinned toolchain. The offline stand-in for the template registry. |
| `prototype/` | Throwaway prototype kept as a consistency checkbed (not a deliverable). |
| `packages/spec` | `@fde/spec` — Solution Spec / lock / Runtime Profile / Capabilities / Bundle Topology / Model Profile / Identity Profile schemas (Zod), the platform role vocabulary and its scope matrix, the exported JSON Schema, cross-document validation and topology invariants. |
| `packages/runtime-generator` | `@fde/runtime-generator` — the build-time `RuntimeGenerator` port, Runtime Profile content addressing, `must/should` derivation and the fail-closed capability and identity gate. |
| `packages/runtime-generator-mastra` | `@fde/runtime-generator-mastra` — the v0 Mastra generator: the mastra-app source tree with its Run API and SSE transport, the libsql/SQLite state store, the context client's retry policy, the ES256 `ExecutionContext` issuer, the topology fragment, the state migration and the A-case plan. |
| `packages/bundle` | `@fde/bundle` — the platform side of a bundle: the `ContextServiceTopology` fragment, `composeTopology` (fragment + fragment → the single `BundleTopology`), deployment-instance naming/ports and the v0 Compose renderer. |
| `packages/cli` | `@fde/cli` — the `fde` command: `spec init`, `spec validate`, `spec lock`, `spec lock --check`, the `context init / validate / freeze / ingest` chain over a Customer Context Package, `build`, and the customer side of a delivery: `install verify` and `install keys`. |
| `packages/contracts-client` | `@fde/contracts-client` — TypeScript wire types and clients generated from `contracts/`. Nothing in `src/generated/` is hand-written. |
| `services/context-service` | The platform-owned Python 3.12 Context API service (`contracts/context-service-v1.openapi.yaml`). Wire models, embedded schemas, the operation table and platform pins are generated from `contracts/`; the C1–C15 conformance runner lives here. Nothing in `app/generated/` is hand-written. |

## Commands

```bash
pnpm install
pnpm verify            # typecheck + generated-code freshness + tests
pnpm test              # vitest
pnpm typecheck         # tsc -b, then typecheck the tests
pnpm generate          # regenerate packages/contracts-client/src/generated from contracts/
pnpm generate:check    # fail if the committed generated code is stale

# the authoring chain (build first: the bin is dist/)
pnpm build
node packages/cli/dist/main.js spec validate --spec examples/spec/acme/claims-triage
node packages/cli/dist/main.js spec lock --check --spec examples/spec/acme/claims-triage --template fde-solution@1.2.0

# the context chain: validate and freeze the Acme Customer Context Package
node packages/cli/dist/main.js context validate --package examples/semantic/acme --workspace examples/spec/acme
node packages/cli/dist/main.js context freeze --package examples/semantic/acme --workspace examples/spec/acme --actor fde://acme/fde-lead
```

`pnpm verify` is what CI runs. Command and diagnostic details are in
[`packages/cli/README.md`](packages/cli/README.md); the offline platform store is
described in [`platform/README.md`](platform/README.md), and the Customer Context
Package — including its frozen `revisions/<version>.yaml` — in
[`examples/semantic/README.md`](examples/semantic/README.md). `packages/contracts-client/src/generated/**` is
generated: change `contracts/`, then run `pnpm generate`.

The context-service has its own toolchain and CI job:

```bash
cd services/context-service
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e '.[dev]'
python -m pytest                 # unit + real-process HTTP tests
python -m conformance            # C1–C15 conformance runner
python scripts/generate.py --check   # contracts/ → app/generated/**
```

See [`services/context-service/README.md`](services/context-service/README.md).

## Implementation status

Slice 1「配置 → 部署 → 只读闭环」is in progress (`docs/architecture-synthesis.md`
§5). Landed so far: the monorepo scaffold, the schema/validation layer (#24), the
contract-derived client, the `fde spec init/validate/lock` command chain (#25), the
`RuntimeGenerator` port with the Runtime Profile artifact and its fail-closed
capability gate (#26), the v0 Mastra generator: the app skeleton and grammar gate
(#27), then the Run API (`POST /v1/runs` under an `Idempotency-Key`, SSE, cancel),
the context client's retry policy, the libsql/SQLite state store and the three
remaining port methods (#28), identity issuance (#29), the startup handshake:
`runtime/runtime-info.ts`, `/readyz` and the aggregated `/v1/runtime-info` (#30),
the `fde context` toolchain with the Acme Customer Context Package: the CCP
document schemas, `checkContextPackage`, `context init / validate / freeze`, and
`context ingest` over the internal job endpoint (#31), the bundle side of the
deployment: the two topology halves, `checkTopology`'s invariants (single writer,
secret bindings, name and port conflicts, networks), `composeTopology`,
deployment-derived naming and the v0 Compose renderer (#32), `fde build` with the
license gate, the SBOM and build provenance (#33), and the customer side of a
delivery: `fde install verify` (pinned Bundle/Release signatures, the re-rendered
Compose file, the license boundary and secret hygiene), `fde install keys` (the two
ES256 issuer key pairs) and the bundle's `deploy/smoke.mjs` (#34), and the
context-service skeleton: the FastAPI app, contract-derived Python models, the
unified error envelope with 422 normalization, `/healthz` vs `/readyz`,
`/v1/runtime-info`, and the C1–C15 runner with C1/C10 green (#35). The remaining
context-service behaviour is #36–#40; the deployment smoke is #41–#43.
