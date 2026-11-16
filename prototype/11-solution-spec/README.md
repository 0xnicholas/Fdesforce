# Sample Solution Spec and generated bundle skeleton

**Status: throwaway prototype for [ticket #11](https://github.com/0xnicholas/Fdesforce/issues/11).**
Not production code, not a reference implementation, not merged to `main`.
Branch: `prototype/11-solution-spec-skeleton`.

Scenario: **Acme Claims / `claims-triage` / `document-triage`** (synthetic, same
reference scenario as `docs/domain-model.md` §8.1). The semantic assets are the
existing `examples/semantic/acme/` Customer Context Package, reached through a
symlink so this prototype does not fork them.

## What this prototypes

- A full sample **Solution Spec** (`acme/solutions/claims-triage/solution.yaml`)
  with capabilities, agent, workflow, tools, semantic bindings, governance,
  environments, extensions, build and deployment settings.
- A runtime-neutral **workflow/HITL grammar** (#18): ordered
  `context | agent | tool | approval` steps, an approval gate over a named
  side-effecting Tool, and a typed Policy predicate instead of a free-form
  `when`.
- A **Decision Binding** (#20): Tool `audit` facts + Capability evidence
  selectors, the evidence union, `tool.pre_invoke` Policy coverage, and the
  generated record-before-act skeleton.
- A sample `solution.lock` with `spec.files`, typed `templates`/`assets`,
  `modelProfiles` and `evalDatasets`.
- A generated **Mastra app** skeleton (agent, workflow, tools, Run API, generated
  context client, record-before-act wrapper).
- A generated **context-service** skeleton with Semantica ontology loading,
  embedded graph store, audit schema, compiled CCP recipe/permissions/sources,
  and an ingestion job.
- **Eval assets**: L1/L2 suites and Metric Catalog in the bundle; the dataset
  stays customer-side.
- **Deployment artifacts**: Compose, Helm, air-gapped runbook, SBOM/notices,
  build provenance, and a `GENERATED.yaml` source map.
- **Gaps** with evidence and proposed fixes: [`GAPS.md`](GAPS.md).

## Layout

```text
acme/                         mini customer repo (the build input)
  customer/connectors/        customer-level Connector assets
  customer/context-packages/  symlink to examples/semantic/acme
  environments/               environment profile values and secret refs
  policies/                   local fixture for the sample Policy Template (#18)
  solutions/claims-triage/    Solution Spec, lock, prompt and schemas
  eval/                       customer-side Eval Dataset (not in the bundle)
generated/claims-triage/      what `fde build` would emit
  mastra-app/                 TS agent/workflow/tool/Run API skeleton
  context-service/            Python service + embedded Semantica skeleton
  eval/                       suite definitions + metric catalog
  deploy/                     compose, helm, airgap runbook
  sbom/                       notices + SPDX stub
  GENERATED.yaml              generated file -> source pointer map
inspect.rb                    throwaway cross-reference checker
```

## Inspect it

```sh
ruby prototype/11-solution-spec/inspect.rb
```

Expected result: **147 ok, 2 warnings, 0 failures**. The remaining warnings are
the `builtin` tool implementation marker and missing Helm, not broken
references. The checker parses all YAML/JSON, walks the Spec
references into the generated tree, validates the #18 workflow/approval grammar,
checks the #20 Decision Binding/evidence/Policy coverage, checks eval/dataset
digests, and runs `docker compose config` when Docker is present. Helm rendering
is skipped here because `helm` is not installed on this machine.

To inspect the packaging manually:

```sh
cd prototype/11-solution-spec/generated/claims-triage/deploy
docker compose config
```

## Clean-environment startup (intended path, not verified end-to-end)

This prototype does **not** claim the bundle starts. The images are placeholder
digests and the generated services are skeletons; the point is to expose
abstraction gaps, not to prove a run. The intended customer-side sequence is:

1. `fde build --target compose` produces the bundle from the Spec + lock + CCP.
2. Verify the bundle signature and license gate (`fde install verify`).
3. Resolve the secret refs in `acme/environments/acme-prod.yaml` into the
   customer secret store.
4. `docker compose up -d` from `generated/claims-triage/deploy/`.
5. Observe order: `migrate` exits 0 → `context-service` ready → `ingest` exits
   0 → `mastra-app` ready.
6. Smoke test `/healthz`, `/readyz`, `/v1/runtime-info`, `POST /v1/runs`,
   `/v1/provenance/{decision_id}`.
7. Upgrade stop-the-world; keep the audit volume; roll back by re-deploying the
   previous bundle.

The air-gapped variant is in `deploy/airgap/README.md`.

## Notes and deliberate omissions

- `context-service` embeds Semantica; there is no separate Semantica service.
  The older ticket text says "Semantica 服务", but map decision #8 wins.
- No real LLM calls, no real Postgres/SharePoint connector, no real graph
  database, no auth/SSO implementation, no HA, no UI.
- The Compose and Helm manifests intentionally diverge on `migrate` (Compose
  service vs Helm initContainer). That divergence is a finding (GAP-4), not an
  accident.
- `GENERATED.yaml` is a proposed artifact: it maps generated files to Spec
  pointers so a stack trace can be traced back to the Spec. The current docs do
  not require it.
