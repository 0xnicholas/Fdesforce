# Fdesforce

## Build and test

```bash
pnpm install
pnpm verify     # typecheck + generated-code freshness + tests; this is what CI runs
pnpm test       # vitest
pnpm generate   # regenerate packages/contracts-client/src/generated from contracts/
```

- `packages/contracts-client/src/generated/**` is generated from `contracts/`. Never
  hand-edit it: change the contract, then run `pnpm generate`.
- `contracts/` is the wire source of truth; `packages/spec` is the definition source
  for Solution Spec, lock, Runtime Profile, Capabilities, Bundle Topology, Model
  Profile and Identity Profile. `contract-drift.test.ts` fails when the two disagree.
- Package layout and seams: `packages/spec/README.md`, `README.md`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default triage vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
