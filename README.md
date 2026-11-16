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
| `examples/` | Reference artifacts: Acme Solution Spec + lock, eval and semantic assets, and the workspace manifest the CLI resolves them through. |
| `platform/` | Vendored platform artifacts: Templates, Overlays, Extensions, Model/Runtime Profiles and the pinned toolchain. The offline stand-in for the template registry. |
| `prototype/` | Throwaway prototype kept as a consistency checkbed (not a deliverable). |
| `packages/spec` | `@fde/spec` — Solution Spec / lock / Runtime Profile / Capabilities / Bundle Topology / Model Profile schemas (Zod), the exported JSON Schema, cross-document validation and topology invariants. |
| `packages/cli` | `@fde/cli` — the `fde` command: `spec init`, `spec validate`, `spec lock`, `spec lock --check`. |
| `packages/contracts-client` | `@fde/contracts-client` — TypeScript wire types and clients generated from `contracts/`. Nothing in `src/generated/` is hand-written. |

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
```

`pnpm verify` is what CI runs. Command and diagnostic details are in
[`packages/cli/README.md`](packages/cli/README.md); the offline platform store is
described in [`platform/README.md`](platform/README.md). `packages/contracts-client/src/generated/**` is
generated: change `contracts/`, then run `pnpm generate`.

## Implementation status

Slice 1「配置 → 部署 → 只读闭环」is in progress (`docs/architecture-synthesis.md`
§5). Landed so far: the monorepo scaffold, the schema/validation layer (#24), the
contract-derived client, and the `fde spec init/validate/lock` command chain
(#25). The Mastra generator, the Compose renderer and context-service are
separate tickets.
