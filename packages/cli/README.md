# `@fde/cli` — the `fde` command

Slice 1's authoring chain: materialize a Solution from a versioned Template,
validate it in one pass, generate the lock that pins every build input, and
compile the Customer Context Package into a frozen, content-addressed artifact.

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
| `context_eval_missing` | warning: no Context Eval question, so a freeze would ship semantics nothing measured |

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
`aud = context-service`, `actor.type = service`, `iss`-matching `sub`, and the
maintenance scopes only (`context:ingest` — no `context:retrieve`, no
`approval:decide`). The key is mounted, never generated here; the `kid` is its
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
- `toolchain`: generator version and image digest.

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
- `context-ingest.test.ts` — a loopback context-service asserts the internal path,
  the ES256 `fde-jobs` token (signature, issuer, scope, trace), the job body, and
  the refusals that must not reach the runtime;
- `cli.test.ts` — usage, exit codes, text/JSON output.
