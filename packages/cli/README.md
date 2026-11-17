# `@fde/cli` — the `fde` command

Slice 1's authoring chain: materialize a Solution from a versioned Template,
validate it in one pass, generate the lock that pins every build input, compile
the Customer Context Package into a frozen, content-addressed artifact, and turn
the locked inputs into an addressed Bundle (`fde build`). The other side of the
delivery is the customer's: `fde install verify` decides whether a signed bundle
may be deployed and `fde install keys` generates the deployment's issuer keys.

```bash
pnpm build
node packages/cli/dist/main.js spec validate --spec examples/spec/acme/claims-triage
node packages/cli/dist/main.js context validate --package examples/semantic/acme --workspace examples/spec/acme
```

The package is private and not published; `main.ts` is the bin entry once built.

## Commands

| Command | Exit 0 when | Exit 1 when | Exit 2 when |
| --- | --- | --- | --- |
| `fde spec init --template <ref> --out <dir>` | the Template was materialized, the lock was written | the Template is not vendored, the output is not empty, the tree cannot be locked | flags are malformed |
| `fde spec validate --spec <dir>` | the Spec, lock and every artifact agree (warnings do not fail) | any schema/reference/grammar/artifact error, including a stale lock | flags are malformed |
| `fde spec lock --spec <dir>` | `solution.lock` was regenerated | the inputs cannot be resolved, so there is nothing honest to write | flags are malformed |
| `fde spec lock --check --spec <dir>` | the checked-in lock is exactly what the inputs produce | any drift, or a missing/invalid lock | flags are malformed |
| `fde context init --customer <id> --name <pkg> --out <dir>` | the draft package was scaffolded | the output is not empty | flags are malformed |
| `fde context validate --package <dir>` | schema, references, recipe pipeline, permission baseline and the frozen record agree | any error in those, including content that moved after a freeze | flags are malformed |
| `fde context freeze --package <dir> --actor <id>` | `revisions/<version>.yaml` was written, or already matched | the package does not validate, measured nothing, or is still a draft | flags are malformed |
| `fde context ingest --package <dir> --context-service <url> ...` | the ingest job finished (`succeeded`, or `degraded` with a warning) | the package is not frozen, the endpoint refused the job, the job failed, the key is unusable | flags are malformed |
| `fde build --spec <dir> --out <dir> [--deployment <dep_id>] [--target compose] [--environment <name>]` | the locked inputs generated, composed, passed the static gates and were written as a Bundle | a digest, capability, grammar, license or manifest gate failed; or the output is not empty | flags are malformed |
| `fde install verify --bundle <dir> --signature … --release … --license-catalog …` | the bundle is the content its address names, the pinned keys signed it and its Release, the license boundary holds and no secret travelled inside it | any of those disagrees, or the delivery is incomplete | flags are malformed |
| `fde install keys --bundle <dir> --out <dir> [--deployment <dep_id>]` | two ES256 issuer key pairs are present (generated or kept) and `keys.json` describes them | a half pair, a wrong curve, another deployment's directory, or a secret the bundle does not bind | flags are malformed |

`--json` prints one machine-readable object:

```json
{ "command": "spec validate", "ok": false, "errors": [{ "code": "...", "path": "...", "message": "...", "remediation": "..." }], "warnings": [] }
```

Diagnostics always carry a stable `code`, the document `path`, and (where the
fix is knowable) a `remediation`. They are printed to stderr; the one-line
summary goes to stdout.

## The context chain: `fde context *`

A **Customer Context Package (CCP)** is the Customer-level, versioned, immutable
set of declarative semantic assets (ADR-0004, [`docs/semantic-modeling.md`](../../docs/semantic-modeling.md)).
The CLI treats it as a *package directory*: `manifest.yaml` names the documents it
is made of and nothing else is compiled, so the manifest is the package.

```text
acme/
├── manifest.yaml                 # CustomerContextPackage: names every part
├── semantic-model.yaml           # ontology modules, sources, mappings, resolution
├── permissions.yaml              # the Customer baseline (defaults to restricted)
├── ontology/*.ttl                # Customer Ontology Extension + SHACL
├── context-sources/*.yaml        # where facts come from
├── mappings/*.yaml               # EntityMapping | DocumentMapping
├── recipes/*.yaml                # the deterministic retrieval plan
├── evals/*.yaml                  # the L1 Context Eval suite
└── revisions/<version>.yaml      # written by `freeze`; the content address
```

`--workspace`/`--platform` work exactly as they do for `spec`: the workspace
supplies the Connector assets and the vendored Domain Ontology modules, so a
package that names an unvendored module or connector fails instead of resolving
lazily. The reference workspace is `examples/spec/acme/fde.workspace.yaml`, which
is why the Acme commands above pass `--workspace examples/spec/acme`.

### `fde context init`

Scaffolds a **draft**: the manifest, an empty Semantic Model, a fail-closed
permission baseline (`unknownClassification: restricted`), a recipe with the two
mandatory stages (`mask` → `budget`) and an eval suite with no questions. It
deliberately models nothing — no ontology module, source or mapping — because a
scaffold that looks modelled is how a Customer ends up with semantics nobody
chose. `fde context validate` accepts it; `fde context freeze` refuses it.

### `fde context validate`

One pass, every error reported with a stable `code`, the document `path` and a
`remediation`. The rules live in `@fde/spec`'s `checkContextPackage` (pure) on top
of the document parsers, so the same check serves this command and `fde build`.

| Code | Means |
| --- | --- |
| `context_package_invalid`, `semantic_model_invalid`, `context_source_invalid`, `context_mapping_invalid`, `context_recipe_invalid`, `permission_profile_invalid`, `context_eval_suite_invalid` | the document is not shaped correctly (strict schemas: an unknown field is an error) |
| `context_file_missing` | a declared document is not in the package |
| `context_reference_unknown` | a named ontology module, source, mapping, recipe, connector, term or recipe input does not resolve |
| `context_digest_mismatch` | an ontology module or extension digest is not the content it claims |
| `context_recipe_invalid` | the stage pipeline: order, duplicates, a missing `mask`/`budget`, a mask bound to another baseline |
| `context_compatibility_mismatch` | the package's graph/audit schema claim is not what the pinned toolchain compiles to |
| `context_package_modified` | the frozen revision and the content on disk disagree |
| `context_package_not_frozen` | `status: frozen` with no revision, or an ingest of an unfrozen package |
| `context_package_not_validated` | `freeze` on a manifest still marked `draft` |
| `context_package_missing` | `--package` is not a directory |
| `context_package_revision_invalid` | the freeze record itself is malformed |
| `context_file_invalid` | a symlink inside the package: content may not depend on a path outside it |
| `context_eval_missing` | warning: no Context Eval question, so a freeze would ship semantics nothing measured |
| `context_permissions_unclassified` | warning: a mapped class has no classification and falls back to `restricted` |
| `context_file_unused` | warning: a file under `mappings/`/`recipes/`/`evals/`/`context-sources/` that no document declares — digested, not compiled |
| `context_ingest_failed` | the job endpoint refused the job, the job failed, or context-service was unreachable |
| `context_ingest_degraded` | warning: the job finished with at least one degraded source |
| `context_jobs_key_invalid` / `context_jobs_key_missing` | the `--jobs-key` PEM is unreadable, not ES256, or has no usable id |

Two rules are worth spelling out because they are about *exposure*, not tidiness:

- **Terminology is anchored on the mappings.** A recipe may only name classes,
  relations and sources the mappings produce. A permission annotation may only
  name terms that exist — a typo'd `columnMask` or `rowFilter` is a rule that
  never applies, which fails **open**, so it is an error rather than a warning.
  The one warning is a mapped class with no classification: the fail-closed
  default (`restricted`) already covers it.
- **`permissions.yaml` may not relax the default.** `unknownClassification` is a
  literal `restricted`; a baseline that defaulted anything else would be an opt-out
  of D11, so the schema refuses it.

### `fde context freeze`

Writes `revisions/<version>.yaml` — and nothing else except the manifest's
`metadata.status: frozen`, edited in place so the author's comments survive.

- **Content-addressed.** `spec.digest` is `digestFiles()` over every package file
  **except `revisions/**`**, i.e. the freeze record is provenance about the
  content, not content. The same value appears in three places that must agree:
  the revision, `solution.lock.assets.customerContextPackage` and the ingest job
  request. `fde spec validate` refuses a Spec that references an unfrozen package
  (`context_package_unfrozen`).
- **Immutable.** Re-freezing unchanged content is a no-op, not a re-stamp: the
  digest is the identity, `frozenAt`/`frozenBy` are provenance. Changing content
  at a frozen version is refused (`context_package_modified`); the fix is a new
  `metadata.version`, whose revision lands beside the old one.
- **Gated.** `freeze` runs the full validation plus the eval gate: a package with
  no Context Eval question cannot be frozen. Running that suite needs a
  context-service, so `fde context eval` is out of this slice; what freeze checks
  is that the L1 gate has something to measure and that the package is marked
  `validated`.
- `--actor` is required (a freeze is a sign-off) and `--source-commit` records the
  commit the content came from. The dirty-tree check belongs to the CI that has a
  repository, not to a deterministic artifact writer.

### `fde context ingest`

Posts the frozen package to **`POST /internal/v1/jobs/ingest`** on context-service
([`contracts/context-service-v1.openapi.yaml`](../../contracts/context-service-v1.openapi.yaml)).
That is the internal maintenance surface, not the customer Runtime API: the
generated `mastra-app` never calls it, it is not routed through the ingress, and
the customer application surface stays `mastra-app` alone.

The credential is the second issuer: `iss = fde://<deployment_id>/jobs`,
`aud = context-service`, `actor.type = service`, `iss`-matching `sub`, the
platform role `service` (as §3.1's participant table names it), and a scope set
narrowed to the maintenance vocabulary — `scopes: [context:ingest]`, which is
*not* `scopesForRoles(['service'])`: the maintenance scopes are disjoint from the
platform scopes on purpose, so a verifier that enforces the `scopes` claim (as
§5.1 requires) cannot retrieve context or decide an approval with this token.
The key is mounted, never generated here; the `kid` is its
RFC 7638 thumbprint unless `--kid` names the id context-service was configured
with, so a `kid` that disagrees with its key cannot be written by hand.
`--deployment` and `--solution` supply what a job token asserts; the tenant is the
package's own Customer.

Only a frozen package with a matching revision is sent; the request carries that
digest, so the runtime can refuse anything that is not the frozen artifact
(`409 conflict`, `error.details.reason = package_not_frozen`). The job is
synchronous in this slice — the response is the finished job — and `degraded` is a
reported outcome (exit 0, warning) because `retrieve` then answers with
`degraded=true` until it is re-run.

The command makes one attempt and does not retry, so it does not mint an
`Idempotency-Key`: replay safety lives in the job itself (`mode` + watermark for
`incremental`, stable `entity_id` upserts for `backfill`/`rebuild`), which is what
§5.5 asks of ingest. A retry is an operator decision with a visible second job.

## `fde build`

`build` is the only command that consumes the lock and nothing else. It never
resolves a floating range, re-reads a Template it did not pin, or reaches the
network: every reference is an exact `name@version` from `solution.lock`, and
every digest is checked against the bytes on disk before anything is generated.
A newer vendored artifact that also satisfies the Spec's range is invisible to a
build; `solution.lock` is the input. `fde spec validate` remains the freshness
gate; a build of a stale lock fails on the digest check instead of quietly
re-locking.

```bash
fde build --spec examples/spec/acme/claims-triage --out /tmp/bundle \
  --deployment dep_01ARZ3NDEKTSV4RRFFQ69G5FAV --environment acme-prod \
  --workspace examples/spec/acme
```

A bundle is normally built before its Deployment exists. `--deployment` is
therefore optional: without it the Compose target renders the reserved all-zero
placeholder instance and `bundle.json` records `deploymentBound: false`, so the
names in `deploy/compose.yaml` are never mistaken for a deployed identity. Pass
the id when the bundle is being assembled for a known deployment; the names and
ingress host port are then derived from it.

The order is fixed (`docs/runtime-adapter.md` §4.4):

1. read the Spec + lock, verify `spec.digest`, every file digest and every
   Template/Asset/Extension/Model Profile pin;
2. resolve `build.runtimeProfile` by its exact pin and verify the Profile digest;
3. `capabilities()` normalizes the ten capability groups;
4. `validate()` derives `must`/`should`; errors stop the build, warnings are
   written into build provenance;
5. `generateApp` / `generateTopology` / `generateMigrations` /
   `generateContractTests` — twice, because **A11** is checked, not assumed;
6. the platform composes `BundleTopology` from the runtime fragment and the
   vendored `ContextServiceTopology`, renders the `compose` target and composes
   the full migration plan (platform `migrate`, then the runtime state store;
   `ingest` is not a migration);
7. static conformance (A1 build side, A9 static, A11) and the license gate.

### What lands in the Bundle

```text
<out>/
├── bundle.json                 # digest, payload manifest, license gate, conformance
├── build-provenance.json       # Profile digest, generator, requirements, warnings, clock
├── sbom/spdx.json              # SPDX 2.3, one package per bundled component
├── NOTICE                      # human-readable license notice
├── deploy/
│   ├── bundle-topology.json    # the one composed deployment topology
│   ├── compose.yaml            # rendered v0 Compose file
│   ├── migration-plan.json     # platform migrate + runtime state migration
│   └── smoke.mjs               # the post-deploy acceptance script (`fde install verify`'s sibling)
├── contract-tests/**           # the A-case plan's assets
├── context/<ccp>/**            # the frozen Context Package, revision included
└── mastra-app/**               # the generated runtime app, bundle-root-relative
```

`bundle.json.digest` addresses the **payload** — the app, contract tests, the
topology, the Compose file, the migration plan, the frozen CCP and `NOTICE`.
`bundle.json`, `sbom/spdx.json` and `build-provenance.json` are evidence
*about* that payload: they carry the build clock (SPDX `created`, `builtAt`), so
including them would make the address move between two builds of the same
inputs. The same rule `fde context freeze` applies to `revisions/**`.

A11 is enforced on every build: the generator runs twice and a different byte is
`runtime_generation_nondeterministic`; a tree whose reported `sourceDigest` does
not describe it, an unsorted/duplicate file set, a topology that fails its
schema, or a component the topology does not carry is `runtime_manifest_invalid`.

### License gate

`platform/licenses.yaml` declares the license of every component a bundle may
carry. `fde build` fails closed when a component is undeclared
(`license_undeclared`), when its license is on the denylist (`license_blocked`:
GPL/AGPL/LGPL, SSPL, Elastic License, BUSL), or when Mastra is anything other
than `@mastra/core` — the `ee/` packages are not Apache-2.0. Semantica must be
the MIT distribution. The same verdict renders the SPDX document and `NOTICE`,
so the evidence cannot disagree with the gate.

### Build refusals

| Code | Means |
| --- | --- |
| `spec_missing`, `solution_lock_missing`, `solution_lock_invalid`, `lock_incomplete`, `spec_digest_mismatch`, `spec_file_missing`, `spec_file_invalid` | the Spec, the lock shape, or the file set the lock pins is not what is on disk; `lock_incomplete` means the lock predates #33 and pins no platform fragment/catalog |
| `artifact_digest_mismatch`, `artifact_missing`, `template_missing` | a pinned artifact moved, disappeared, or is not vendored |
| `platform_fragment_missing`, `platform_fragment_invalid`, `platform_fragment_mismatch`, `license_catalog_mismatch` | the lock's platform fragment or license catalog is missing or moved after the lock |
| `runtime_profile_missing`, `runtime_profile_mismatch` | the Profile is absent, its digest moved, or it disagrees with the lock/Spec |
| `runtime_schema_mismatch`, `toolchain_mismatch`, `toolchain_missing` | the lock and the vendored toolchain compile different graph/audit schemas or versions, or the toolchain is absent |
| `context_package_not_frozen`, `context_package_modified` | the bundle would carry semantics no freeze recorded, or a revision that does not match the content |
| `license_catalog_missing`, `license_catalog_invalid`, `license_undeclared`, `license_blocked` | the redistribution boundary cannot be established |
| `environment_missing`, `environment_required`, `environment_unknown`, `deployment_invalid` | the build has no unambiguous target, or the deployment id cannot name one |
| `runtime_generation_nondeterministic`, `runtime_manifest_invalid` | generation is not a pure function of the inputs, or returned an artifact the contract does not describe |
| `runtime_capability_*`, `runtime_grammar_unsupported`, `runtime_extension_unsupported`, `runtime_connector_*`, `runtime_identity_*` | the generator's own gate — the same codes `fde spec validate` reports |
| `runtime_generator_missing` | the Runtime Profile names a family no generator implements |
| `output_not_empty` | `--out` is not an empty directory; a build never overwrites a bundle |
| `build_target_unsupported` | v0 renders `compose`; Helm and airgap are Slice 2.6 |

## `fde install *`

The customer side of a delivery (#34). `fde build` produces a bundle and the release
chain signs it; what reaches the customer is a delivery directory:

```text
delivery/
├── bundle/                 # the directory `fde build --out` wrote
├── bundle.sig              # the Bundle signature (CI KMS key)
├── bundle.pub              # the pinned key that signs bundles
├── release.json            # the Release that approves this bundle
├── release.sig             # the Release signature (FDE release-manager key)
├── release.pub             # the pinned release-manager key
└── licenses.yaml           # the customer's pinned redistribution boundary
```

All seven paths are flags, never inferred from the directory layout: "the file next
to the bundle" is precisely the shape a substituted artifact takes.

```bash
fde install verify --bundle delivery/bundle \
  --signature delivery/bundle.sig --public-key delivery/bundle.pub \
  --release delivery/release.json --release-signature delivery/release.sig \
  --release-public-key delivery/release.pub \
  --license-catalog delivery/licenses.yaml
fde install keys --bundle delivery/bundle --out keys
```

### The signature envelope

A detached ES256 signature over one canonical subject string — the one format the
release chain produces and the installer consumes:

```json
{ "signatureVersion": 1, "alg": "ES256", "kid": "<rfc7638 thumbprint>", "subject": "sha256:…", "signature": "<base64url>" }
```

- the **Bundle** signature's `subject` is `bundle.json.digest`, the payload address;
- the **Release** signature's `subject` is `canonicalJson(release.json)`'s digest, so
  the `bundleDigest` the Release approves is covered by the signature that approves it;
- `kid` is the RFC 7638 thumbprint of the signing key (§5.4), so a signature cannot
  name a key it was not made by, and a customer's pinned key either matches or the
  delivery is refused.

`signSubject()` (`packages/cli/src/install.ts`) is the producing half; verification
is the same module, so the two halves cannot drift.

### Two keys, two questions

The Bundle key answers *did the platform build this?*; the Release key answers *did
the FDE release manager approve it?* They are separate keys on purpose
(`docs/security-and-deployment.md` §8) and `install verify` requires both, so a
validly built bundle that was never approved is not installable.

### What `install verify` re-derives

Nothing is taken on the delivery's word:

| Check | Refusal |
| --- | --- |
| the bundle directory, `bundle.json` and `deploy/bundle-topology.json` are present and shaped | `bundle_missing`, `bundle_manifest_missing`, `bundle_manifest_invalid`, `bundle_topology_missing`, `bundle_topology_invalid` |
| every file the manifest lists is there, digests to what it pins, and nothing else is in the tree | `bundle_file_missing`, `bundle_file_modified`, `bundle_file_unlisted` |
| the payload digests to `bundle.json.digest` | `bundle_digest_mismatch` |
| the manifest's Runtime Profile digest is the topology's | `bundle_profile_mismatch` |
| the bundle is bound to a Deployment | `bundle_unbound` |
| the bundled topology still satisfies its invariants, and `deploy/compose.yaml` is exactly `renderCompose(topology, deploymentInstance(id))` | `bundle_topology_invalid`, `deployment_invalid`, `compose_missing`, `compose_mismatch` |
| the pinned bundle key signed the payload address | `bundle_key_invalid`, `bundle_key_mismatch`, `bundle_signature_missing`, `bundle_signature_mismatch`, `bundle_signature_invalid` |
| the Release is `approved`, describes this bundle (digest, Spec, lock, customer, solution) and is signed by the pinned release key | `release_missing`, `release_invalid`, `release_not_approved`, `release_mismatch`, `release_key_invalid`, `release_key_mismatch`, `release_signature_missing`, `release_signature_mismatch`, `release_signature_invalid` |
| the SBOM, `bundle.json`'s license verdict and `NOTICE` are one answer, under the pinned catalog | `evidence_missing`, `evidence_invalid`, `license_evidence_mismatch`, `license_gate_failed`, `license_catalog_missing`, `license_catalog_invalid`, `license_catalog_mismatch`, `license_blocked`, `license_undeclared` |
| every file in the bundle is readable, so the key-material scan clears all of them | `bundle_file_unreadable` |
| no file in the bundle carries a private key | `bundle_secret_leak` |

The license boundary is recomputed, not read: the SBOM is re-gated against
`--license-catalog`, so a bundle whose own verdict said `ok` still fails if the
catalog the customer pinned denies a component — and a catalog whose digest is not
the one the build was gated on is `license_catalog_mismatch`, because a verdict under
another boundary is not the build's verdict. The anchor is `NOTICE`: it ships in the
payload (so the Bundle signature covers it), it records the catalog digest the build
was gated on, and it must agree with the SBOM. Tampering the SBOM alone, or the
provenance alone, is `license_evidence_mismatch`.

The Compose check is what makes "Bundle 只含 `secretRef`" mechanical in two ways: the
renderer only ever emits `${NAME:?}` for a secret, so a hand-edited `compose.yaml`
with a literal in it is refused; and the fragment is re-composed, so a topology whose
secret bindings were edited is refused as well. The secret *values* are never in the
bundle for the same reason — `install keys` writes them outside it, and
`bundle_secret_leak` catches a delivery that tried.

### `fde install keys`

Generates the deployment's two issuer key pairs, or keeps the ones already present
(`docs/runtime-contract.md` §5.4):

```text
keys/
├── execution-context-signing-key.pem   0600   → mastra-app (iss = fde://<dep>)
│                                                mounted at /run/secrets/execution-context-signing-key
├── execution-context-public-key.pem    0644   → context-service (EXECUTION_CONTEXT_PUBLIC_KEY)
├── fde-jobs-signing-key.pem            0600   → the ingest job (iss = fde://<dep>/jobs)
├── fde-jobs-public-key.pem             0644   → context-service (FDE_JOBS_PUBLIC_KEY)
└── keys.json                           0644   the manifest: secretRef → file → injectInto[], plus each kid
```

`keys.json` is derived from the bundle, not from this command's opinion of it: each
entry names the binding's `secretRef` (store included) and the `injectInto`
components or jobs that actually claim that secret in the composed topology. A
destination this command invented would be a claim about a container it does not own.

The mount paths are the composed topology's, not this command's: a `file` binding
renders a Compose secret whose host path comes from `${<name>_FILE:?}`, so the
operator exports `EXECUTION_CONTEXT_SIGNING_KEY_FILE` and `FDE_JOBS_SIGNING_KEY_FILE`
and the containers see the file at the target path while the bundle carries neither.

- **Generated only when missing.** Re-running an install must not rotate a key —
  rotation is `fde keys rotate` (Slice 2) and a key that moves takes every token with
  it. A half pair is refused (`install_key_incomplete`) rather than completed, because
  the missing half cannot be derived from the present one; a public key that is not
  the private key's other half is `install_key_mismatch`; another curve is
  `install_key_invalid` (ES256 is a decision, not a detail).
- **Driven by the bundle.** The four secret names come from the composed topology's
  `secretBindings`; a secret the bundle does not bind is `install_key_unbound`, because
  a key the topology never mounts is a key the deployment cannot read. A keys
  directory belongs to one deployment (`install_key_deployment_mismatch`), an
  unbound bundle needs `--deployment` (`bundle_unbound`), and `--deployment` may not
  contradict the deployment a bound bundle names (`deployment_mismatch`).
- **Private up, public in.** The private halves stay in the files above until the
  operator moves them into the customer secret store under the `secretRef` the
  manifest names; only the public halves and their `kid` go to context-service, which
  derives the same `kid` from the key itself. The command prints file names, kids and
  counts — never a key, and a test asserts nothing `BEGIN`s in its output or errors.

The keys are the identity seam's, not the delivery's: `install verify`'s pinned keys
sign bundles and releases, these two sign `ExecutionContext`s at runtime.

### The smoke script

`deploy/smoke.mjs` ships in the payload (`chmod 755`, no dependencies, Node 22) and
is the post-deploy acceptance action:

```bash
node deploy/smoke.mjs --base-url http://127.0.0.1:<published port> \
  --context-service-url http://context-service:8011 \
  --token "$FDE_SMOKE_TOKEN" --audit-token "$FDE_SMOKE_AUDIT_TOKEN"
```

Flags fall back to `FDE_SMOKE_BASE_URL`, `FDE_SMOKE_CONTEXT_SERVICE_URL`,
`FDE_SMOKE_TOKEN`, `FDE_SMOKE_AUDIT_TOKEN`, `FDE_SMOKE_CAPABILITY` and
`FDE_SMOKE_TIMEOUT`; exit 0 means every step held, 1 means one failed (the reason
names the step), 2 means the invocation is unusable.

`--token` is the caller credential the Run API accepts; `--audit-token` is the
`ExecutionContext` that reads the audit trail and falls back to `--token` when a
deployment accepts one for both. They are separate because they are: the Run API
carries a customer credential, `GET /v1/provenance` an `ExecutionContext` with
`provenance:read` (`docs/runtime-contract.md` §5.1).

| Step | Asserts |
| --- | --- |
| `healthz` | the process is alive |
| `readyz` | the startup handshake passed; `degraded` serves and is reported as a warning, `503` stops the run |
| `runtime-info` | `contract_version` is on the `fde.runtime/v1` line, `service` is `runtime-app`, and the aggregate lists a `context-service` component |
| `run` | `POST /v1/runs` under a fresh `Idempotency-Key` returns a `run_id`, the same key and payload replay it, the Run reaches `succeeded`, and it wrote a Decision |
| `provenance` | `GET /v1/provenance/{decision_id}` returns that Decision with its PROV-O lineage, carrying the caller's bearer token and no backend-internal name (C14) |

The script carries no address, no token and no key: endpoints and the credentials
arrive by flag or environment, so one artifact is deployable to every customer and
the same file is a pure function of the Spec (its default capability). The
provenance step needs a URL it can reach — run it from the bundle network, or pass
the address the operator reached context-service on.

Two steps depend on components that are still landing: the Run's `phase=run`
Decision is the audit write path (#37/#42), and context-service itself is #35–#40.
Against a Slice-1 bundle the smoke therefore fails at `run` with "no Decision was
written" — deliberately, because a deployment that cannot account for its Run is
not a passing deployment. It turns green with those tickets, and #41 is what runs it
against a real Compose bundle.

## Why `validate` and `lock --check` are separate

`validate` is the documented `validated` gate (`docs/domain-model.md` §3.3):
schema, reference integrity, grammar, artifact resolution **and lock freshness**
all pass. `lock --check` is the stricter generated-artifact check: it also
rejects pins the inputs do not produce (an extra pin, a deleted provenance
entry, a hand-edited digest). Both fail on a stale lock; CI runs both because
only `lock --check` sees the whole manifest.

The authoring loop is therefore: edit → `fde spec lock` → `fde spec validate`.
That is the strict-lock friction ADR-0007 accepted in exchange for a lock that
is never stale in a build. `lock` itself pins what the Spec references; it does
not substitute for `validate` as the grammar gate.

## Workspace: `fde.workspace.yaml`

A Customer repo declares where its assets and the vendored platform store live.
Paths are relative to this file. The CLI discovers the file by walking up from
`--spec` (or the current directory); `--workspace <dir>` points at it directly.

```yaml
platform: ../../../platform
assets:
  connectors: customer/connectors
  contextPackages: ../../semantic
  evalSuites: ../../eval
  datasets: ../../eval
  policies: customer/policies      # optional
```

`fde.workspace.yaml` is tooling configuration, not a domain document: it is not
produced by a Customer's Solution and never enters a Bundle. The reference
workspace is [`examples/spec/acme/fde.workspace.yaml`](../../examples/spec/acme/fde.workspace.yaml).

Asset categories are indexed by document identity, not by file path. Any depth
is fine: the connector `metadata.name`, the Context Package manifest, the
`EvalSuite`/`EvalDataset`/`ModelProfile` names are what resolve.

## The platform store

`--platform <dir>` defaults to the workspace manifest's `platform`. It is the
offline stand-in for the OCI template registry (ADR-0002) and holds Templates,
Overlays, Extensions, Model Profiles, Runtime Profiles and the toolchain.
Layout and digest rules are in [`platform/README.md`](../../platform/README.md).

Resolution is deliberately offline: a range picks the highest vendored version
that satisfies it, and an unvendored range fails with `template_missing`.
`fde spec lock --refresh` (ADR-0007's only network path) is not part of Slice 1.

## What the lock covers

`fde spec lock` resolves the Spec and writes a `solution.lock` that pins:

- `spec.digest`/`spec.files`: `solution.yaml`, every file the Spec references,
  and every file under `files/`;
- `templates`: solution provenance, capability, policy, eval, ontology and
  deployment-profile Templates;
- `assets`: concrete Customer assets (Eval Suite, Connector, Context Package,
  asset Policies) with their file manifests;
- `overlays`, `extensions`, `modelProfiles`, `evalDatasets`;
- `runtime`: the Runtime Profile digest, contract/schema versions and every
  cross-runtime version;
- `toolchain`: generator version, image digest, the composed
  `ContextServiceTopology` version + digest, and the license catalog digest.

Every pin is an exact version plus a content digest — no ranges. The lock is
generated and deterministic: object keys and file paths are sorted and the file
set does not depend on the Spec's location. Two runs over the same inputs write
byte-identical files.

Materialization provenance (`templates.solution`) is an **input**, not something
inferred from the lock: pass `--template <name@version>`, as `fde spec init` did.
If a lock records provenance and the flag is omitted, `lock` fails with
`solution_template_unresolved` instead of silently dropping the pin — a
self-referential expected value could never detect a deleted provenance entry.
Concrete Customer assets keep their own link in `materializedFrom`; the named
Template is verified as vendored and pinned next to the asset.

Digest conventions:

| Input | Digest |
| --- | --- |
| Spec file set | `digestFiles()` over the sorted manifest |
| Template / Overlay / Extension | `digestFiles()` over every file in the version directory |
| Context Package | `digestFiles()` over every file in the package directory |
| Connector | `digestFiles()` over the connector document + its `dataContract` files |
| Eval Suite / asset Policy | the document file digest, mirrored in its one-file manifest |
| Model Profile | the LF-normalized file digest |
| Runtime Profile | canonical JSON of the parsed document (`digestOf`) |
| Eval Dataset | the `datasetRef` digest declared by the Eval Suite (the dataset stays customer-side) |
| Toolchain image | the toolchain Dockerfile digest until the published image digest replaces it (#33) |

## `fde spec init`

`init` materializes the Template directory into `--out` and writes the lock in a
staging directory first. A failure leaves no partial Solution behind; an
existing non-empty `--out` is never overwritten. The generated lock records
`templates.solution` provenance; keep it fresh with
`fde spec lock --template fde-solution@1.2.0`.

In Slice 1 the only Solution Template is `fde-solution@1.2.0`, which
materializes the Acme claims-triage read-only Spec byte for byte. Tests assert
that equality, so the checked-in example and the Template cannot drift.

## Spec file set rules

`spec.digest` covers `solution.yaml`, every referenced prompt/schema and every
file under `files/`. Paths are POSIX-relative, sorted, LF-normalized; absolute
paths, `..`, symlinked files and symlinked directories are rejected
(`spec_file_invalid`). A file outside the digest is outside the build.

## Not in this slice

- `--refresh` / network resolution.
- `fde spec update`, `fde spec migrate`, Overlay re-application (ADR-0007's
  future migration path).
- `fde context eval`, `fde context backfill`, `fde context rebuild`,
  `fde context verify`: the ingest job exists here, the rest need a
  context-service and land with it (#35–#40).
- `fde keys rotate` (Slice 2): `install keys` generates a missing pair and refuses to
  replace a present one.
- `fde install upgrade/rollback/backup/restore` (Slice 2): the bundle and the keys
  are here, the lifecycle is not.
- `--force` or waivers: every gate fails closed.
- Template body schemas beyond identity fields (`apiVersion`, `kind`,
  `metadata.name`, `metadata.version`) — those land with the owning tickets;
  only the Solution Template's `solution.yaml` is parsed as a `SolutionSpec`.

## Tests

`packages/cli/test` drives the public `runCli(argv, io)` seam in disposable
copies of `examples/` and `platform/`, so a failed test cannot leave the
checked-in reference artifacts drifted. The seams are:

- `spec-init.test.ts` — materialization, provenance, no partial output;
- `spec-validate.test.ts` — aggregate diagnostics, remediations, missing lock,
  freshness-is-a-warning;
- `spec-lock.test.ts` — pin completeness, idempotence, and one drift case per
  input category;
- `context-init.test.ts` — the scaffold validates and refuses to freeze;
- `context-validate.test.ts` — one diagnostic per rule, through the CLI, with the
  remediation an author reads;
- `context-freeze.test.ts` — the revision digest is the lock pin, re-freezing is a
  no-op, a moved frozen file is refused, the status flip keeps the author's
  comments;
- `build.test.ts` — the bundle's contents and `--json` output;
- `build-determinism.test.ts` — A11 through the CLI and through an injected clock
  and random source, plus the two generation-class refusals;
- `build-refusals.test.ts` — lock-only resolution (a newer range match is
  ignored), no network, the license gate, schema/target/environment refusals;
- `context-ingest.test.ts` — a loopback context-service asserts the internal path,
  the ES256 `fde-jobs` token (signature, issuer, scope, trace), the job body, and
  the refusals that must not reach the runtime;
- `install-verify.test.ts` — a real bundle signed with two pinned keys, then one
  thing broken per case: the payload, the address, an extra file, the signature, the
  key, the Release, the SBOM, the catalog, a leaked key, the Compose file;
- `install-keys.test.ts` — the key pairs, their modes and kids, the secretRef
  manifest, idempotence, every refusal, and no key material in the output;
- `smoke.test.ts` — the bundle's `deploy/smoke.mjs` executed against stub runtime and
  context-service servers: the five steps, the requests each one makes, the degraded
  warning, and the failures that must stop it;
- `cli.test.ts` — usage, exit codes, text/JSON output.
