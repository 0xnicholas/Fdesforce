# `@fde/cli` — the `fde` command

Slice 1's authoring chain: materialize a Solution from a versioned Template,
validate it in one pass, and generate the lock that pins every build input.

```bash
pnpm build
node packages/cli/dist/main.js spec validate --spec examples/spec/acme/claims-triage
```

The package is private and not published; `main.ts` is the bin entry once built.

## Commands

| Command | Exit 0 when | Exit 1 when | Exit 2 when |
| --- | --- | --- | --- |
| `fde spec init --template <ref> --out <dir>` | the Template was materialized, the lock was written | the Template is not vendored, the output is not empty, the tree cannot be locked | flags are malformed |
| `fde spec validate --spec <dir>` | the Spec, lock and every artifact agree (warnings do not fail) | any schema/reference/grammar/artifact error | flags are malformed |
| `fde spec lock --spec <dir>` | `solution.lock` was regenerated | the inputs cannot be resolved, so there is nothing honest to write | flags are malformed |
| `fde spec lock --check --spec <dir>` | the checked-in lock is exactly what the inputs produce | any drift, or a missing/invalid lock | flags are malformed |

`--json` prints one machine-readable object:

```json
{ "command": "spec validate", "ok": false, "errors": [{ "code": "...", "path": "...", "message": "...", "remediation": "..." }], "warnings": [] }
```

Diagnostics always carry a stable `code`, the document `path`, and (where the
fix is knowable) a `remediation`. They are printed to stderr; the one-line
summary goes to stdout.

## Why `validate` and `lock --check` are separate

`validate` answers "is this Spec well-formed and do its references resolve?".
It reports a stale lock digest as a **warning**, because a Spec under authoring
changes on every save. `lock --check` answers "is this lock the exact lock these
inputs produce?" and treats any difference — including a stale `spec.digest` —
as a failure. CI runs both.

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
existing non-empty `--out` is never overwritten.

In Slice 1 the only Solution Template is `fde-solution@1.2.0`, which
materializes the Acme claims-triage read-only Spec byte for byte. Tests assert
that equality, so the checked-in example and the Template cannot drift.

## Not in this slice

- `--refresh` / network resolution.
- `fde spec update`, `fde spec migrate`, Overlay re-application (ADR-0007's
  future migration path).
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
- `cli.test.ts` — usage, exit codes, text/JSON output.
