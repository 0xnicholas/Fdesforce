# Fdesforce

## Build and test

```bash
pnpm install
pnpm verify     # typecheck + generated-code freshness + tests; this is what CI runs
pnpm test       # vitest
pnpm generate   # regenerate packages/contracts-client/src/generated from contracts/
```

The Python service (`services/context-service`, ticket #35 onward) has its own
commands; CI runs both jobs.

```bash
cd services/context-service
uv venv --python 3.12 .venv && uv pip install --python .venv/bin/python -e '.[dev]'
python -m pytest                 # unit + real-process HTTP tests
python -m conformance            # C1–C15 runner
python scripts/generate.py --check            # contracts/ → app/generated/**
python scripts/semantica_surface.py           # imports vs the pinned 0.7.x wheel
python -m app.migrate                         # establish the graph/audit schema
ruff check app conformance scripts tests
```

- `packages/contracts-client/src/generated/**` is generated from `contracts/`. Never
  hand-edit it: change the contract, then run `pnpm generate`.
- `services/context-service/app/generated/**` is generated from `contracts/` and
  `platform/toolchain.yaml` by `services/context-service/scripts/generate.py`. Never
  hand-edit it: change the contract, then run the generator.
- `services/context-service/semantica-surface.json` is the reviewed Semantica export
  surface. Change it with `python scripts/semantica_surface.py --write` and read the
  diff: that diff is the engine-upgrade decision.
- `contracts/` is the wire source of truth; `packages/spec` is the definition source
  for Solution Spec, lock, Runtime Profile, Capabilities, Bundle Topology, Model
  Profile and Identity Profile. `contract-drift.test.ts` fails when the two disagree.
- Package layout and seams: `packages/spec/README.md`, `services/context-service/README.md`,
  `README.md`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default triage vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
