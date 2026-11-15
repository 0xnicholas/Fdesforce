# Prototype findings: abstraction gaps

Five gaps exposed by writing the sample Spec and the generated skeleton.
Each is a **proposed** finding for the FDE to confirm before the ticket closes.
They are deliberately phrased as decisions, not implementation slices.

## GAP-1 — Connector-backed Tools have no runtime seam

**Evidence**

- `acme/solutions/claims-triage/solution.yaml` binds `claims-lookup` and
  `claim-decision` with `connectorRef` + `operation`.
- `generated/claims-triage/mastra-app/src/tools/claims-lookup.ts` has nowhere to
  call: `fde.runtime/v1` exposes retrieve/decision/approval endpoints, not
  connector operations. The prototype invents
  `POST /v1/connectors/{connector_id}/operations/{operation}` in
  `context-client.ts`; `context-service/app/main.py` returns `501`.
- `acme/customer/connectors/claims-db.yaml` only lists `allowedOperations` and
  points at a free-form `dataContract` Markdown file. There are no typed
  operation signatures, scope requirements, or idempotency rules.
- The same Connector is needed by Python ingestion
  (`context-service/app/ingest.py`) and by TS Tools, but no language-neutral
  implementation contract exists.

**Why it breaks**

The generator cannot emit a runnable Tool from the Spec, and cannot validate
that `operation` exists with compatible input/output. The "one customer-level
Connector asset reused by ingestion and Tools" claim is not backed by a seam.
Write Tools also need `Idempotency-Key` and record-before-act, which are not
part of the connector contract.

**Proposed change**

Define a typed Connector operation manifest (input/output JSON Schema,
`sideEffects`, required scopes, idempotency) and one runtime path for invoking
it. The cleanest option is a context-service endpoint (it already owns customer
data access, auth and audit), with the generated TS client calling it. The
alternative — TS-side connector packages for Tools plus a separate Python
ingestion connector — splits one asset into two and should be rejected unless
the cross-language seam is deliberately moved.

Lands in: **#17** (runtime-neutral Tool/Connector protocol, extension packaging)
with **#8** (wire contract) and **#12** (scopes/secret refs).

## GAP-2 — Workflow/HITL step grammar is missing

**Evidence**

- `docs/domain-model.md` gives Workflow `steps`, `branches`, `parallel`,
  `human_approval`, `durable` but no step schema. `human_approval: true` cannot
  carry approver roles, expiry, proposed action or evidence.
- The prototype had to invent an `approval` step with `when`, `approverRoles`,
  `expiresAt` and `proposedAction` in `solution.yaml`.
- `generated/claims-triage/mastra-app/src/workflows/document-triage-flow.ts`
  suspends the workflow, but nothing connects that suspend to
  `POST /v1/approvals`, the `approval.required` SSE event, or `consume`.
- The approval threshold is a free-form `when` string pointing at an opaque
  policy (`$.triage.output.amount > policy.claims-approval-threshold.amount`);
  neither the expression grammar nor the policy parameter schema exists.
- `capabilities.document-triage` is implemented by a workflow, but there is no
  declared mapping from the Run API's `capability_id` to the workflow entry.

**Why it breaks**

The reference scenario's central behaviour — claims above 100k require human
approval — cannot be generated or validated from the Spec. The generator cannot
tell whether `approverRoles` are legal, when the approval expires, or what
payload the approver sees.

**Proposed change**

Add a discriminated `WorkflowStep` schema to the Solution Spec:
`context | agent | tool | approval | branch | parallel`. The `approval` variant
must match the runtime contract (`proposed_action`, `approver_roles`,
`expires_at`, evidence refs) and map to `POST /v1/approvals`, SSE
`approval.required`, resume and `consume`. Replace free-form `when` with either
a restricted expression over typed step outputs/policy parameters or a named
branch predicate. Give Policy a typed parameter schema for
`claims-approval-threshold`. Add a generator conformance case for the full
approval round trip.

Lands in: **#7** (Spec schema), **#12** (approver roles/identity), **#13**
(end-to-end slice).

## GAP-3 — `solution.lock` does not pin every build input

**Evidence**

- `triage-agent` uses `modelProfile: standard`, but the lock has no
  `modelProfiles` block; the provider/model/params come from
  `acme/environments/acme-prod.yaml` at build time.
  `build-provenance.yaml` records `pinned: false`.
- The domain model says the lock pins Extensions, but the lock example in
  `docs/domain-model.md` §3.3 has no `extensions` block. The prototype had to
  add one.
- `instructions: files/prompts/triage.md` and the tool JSON Schemas are Spec
  author content, but the lock does not say whether `specDigest` covers those
  files or only `solution.yaml`.
- The Eval Suite pins a dataset version + digest, but the Spec/Environment has
  no binding for where `fde eval` resolves that dataset or which service account
  reads it. This is currently an implicit customer-side convention.
- The lock's `templates` block can cover policy/eval suite templates, but it
  does not explicitly distinguish capability templates from eval/policy
  templates.

**Why it breaks**

"Same Spec + lock + pinned Extensions + toolchain image → same Bundle digest"
is not true if the model profile, prompt files and connector artifacts are not
pinned. Release evaluation also cannot prove it used the dataset the suite
pins. This is a supply-chain and reproducibility gap, not just a missing field.

**Proposed change**

Extend the lock schema with `modelProfiles` (versioned artifact: provider,
model, params, fallback), an explicit `extensions` map, and a defined
`specDigest` scope that includes all referenced files (or per-file digests).
Add an `evalDatasets` customer-side reference block plus an Environment-level
resolution binding (store, path/secret ref, service account). Validation must
fail when a Spec reference has no lock entry, when a model profile is unpinned,
or when a prompt/schema file is outside the digest.

Lands in: **#7** (Spec/lock schema), **#10** (eval dataset resolution).

## GAP-4 — Bundle topology is not one abstraction across targets

**Evidence**

- `spec.build.targets: [compose, helm, airgap]` conflates a platform (compose,
  Helm) with a delivery mode (air-gapped). The air-gap runbook still uses
  Compose.
- Compose renders `migrate` as a one-shot service; Helm cannot share PVCs with a
  hook job cleanly, so the prototype makes `migrate` an initContainer. The same
  bundle therefore has two different startup graphs.
- Ports (4111, 8011) and volume names are fixed. The domain model allows one
  Environment to host multiple Solutions' Deployments, but there is no
  deployment instance namespace or port/volume allocation. Two Solutions in one
  Environment would collide.
- `secretRef → env var` mapping is not part of the Environment or Bundle
  contract. Compose uses environment interpolation; Helm uses a single
  `existingSecret` with unspecified keys. The proto had to invent a
  `secretRefs` map in the Environment.
- `GENERATED.yaml` (a proposed source map and component manifest) is not a
  required artifact today, so there is no single place where the generated
  topology is declared and then rendered to Compose/Helm.

**Why it breaks**

The customer install/upgrade runbook cannot be generated once and rendered
faithfully. A multi-Solution Environment is likely to collide on names/ports.
Secret wiring is install-time lore rather than a contract.

**Proposed change**

Split `build.platform: compose | helm` from `build.delivery: registry |
offline-bundle`, and introduce a `BundleTopology` manifest (components, ports,
volumes, jobs, startup dependencies, health checks, secretRef bindings) as the
single source that Compose/Helm renderers consume. Add deployment instance
naming derived from `deployment_id` and an Environment port/volume allocation
contract — or explicitly restrict v0 to one Solution per Environment and say so.
Add a `secretRef → env var` binding map to Environment or BundleTopology.

Lands in: **#17** (topology declaration), **#12** (secrets/deployment),
**#13** (packaging slice).

## GAP-5 — record-before-act evidence cannot be generated

**Evidence**

- `claim-decision` declares `sideEffects: write`; that is the only audit-related
  field on the Tool. The prototype had to invent `evidence.from` and
  `decision.classification/retentionClass`.
- `generated/.../record-before-act.ts` writes `evidence: []` and
  `policy_evaluations: []`. The runtime contract requires evidence refs,
  policy evaluations, input/output digests, model and prompt version.
- `capabilities.document-triage` has policy/eval refs and
  `governance_requirements`, but no binding from those to a specific Tool
  decision or evidence set.
- The generated wrapper cannot know whether the Capability requires an outcome
  Decision for read-only runs, nor which retrieved items count as evidence.

**Why it breaks**

The `decision_coverage` blocking gate would fail by construction for any
side-effecting Tool. The audit record would be structurally incomplete even
though the runtime contract says record-before-act is the most important
invariant.

**Proposed change**

Add a decision/audit binding to Tool (or Capability) covering evidence
selection, classification, retention class, and whether an outcome Decision is
required. Derive `policy_evaluations` from the bound Policy enforcement points
and emit them in the generated wrapper. Add a conformance case asserting that
an intent Decision contains non-empty evidence, policy evaluations, input digest
and model/prompt version, and that the outcome links to the intent.

Lands in: **#8** (runtime contract), **#7** (Spec schema), **#12**
(classification/retention vocabulary).

---

## Minor observations (not counted as gaps)

- **Ingest has no Runtime API endpoint.** `docs/runtime-contract.md` says the
  ingest job calls context-service, but the Context API table has no ingest
  endpoint. The generated job currently prints and exits. This should be
  resolved with GAP-1/GAP-5 or explicitly documented as an internal-only
  endpoint.
- **`GraphStore` is named but not defined.** The port's methods, ID rules and
  error semantics are not specified. The prototype's `GraphStore` class is an
  attempt, not a contract.
- **Semantica 0.7.0 API is asserted, not pinned.** `OntologyIngestor`,
  `SHACLGenerator` and `ContextGraph` are named in docs; the generated import is
  not verified against the pinned wheel.
- **"Semantica 服务" wording** in ticket #11 predates map decision #8
  (embedded Semantica inside context-service). Docs and tickets should use
  "context-service with embedded Semantica".
