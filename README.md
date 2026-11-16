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
| `examples/` | Reference artifacts: Acme Solution Spec + lock, Runtime Profile, Model Profile, eval and semantic assets. |
| `prototype/` | Throwaway prototype kept as a consistency checkbed (not a deliverable). |
| `packages/spec` | `@fde/spec` — Solution Spec / lock / Runtime Profile / Capabilities / Bundle Topology / Model Profile schemas (Zod), the exported JSON Schema, cross-document validation and topology invariants. |
| `packages/contracts-client` | `@fde/contracts-client` — TypeScript wire types and clients generated from `contracts/`. Nothing in `src/generated/` is hand-written. |

## Commands

```bash
pnpm install
pnpm verify            # typecheck + generated-code freshness + tests
pnpm test              # vitest
pnpm typecheck         # tsc -b, then typecheck the tests
pnpm generate          # regenerate packages/contracts-client/src/generated from contracts/
pnpm generate:check    # fail if the committed generated code is stale
```

`pnpm verify` is what CI runs. `packages/contracts-client/src/generated/**` is
generated: change `contracts/`, then run `pnpm generate`.

## Implementation status

Slice 1「配置 → 部署 → 只读闭环」is in progress (`docs/architecture-synthesis.md`
§5). Landed so far: the monorepo scaffold, the schema/validation layer (#24), and
the contract-derived client. The `fde` CLI, the Mastra generator, the Compose
renderer and context-service are separate tickets.
