# `platform/` — the offline platform artifact store

Everything a build or a lock may reference, vendored so `fde` never needs the
network. This is the Slice 1 stand-in for the OCI template registry that
ADR-0002 describes: `fde spec lock` resolves `name@range` here and pins the
exact version plus a content digest. `fde spec lock --refresh` (the only
network path, ADR-0007) is not implemented in this slice; an unvendored range is
a hard error.

## Layout

```text
templates/<type>/<name>/<version>/**      cross-customer, immutable Template
overlays/<name>/<version>/**              Overlay (derivation provenance)
extensions/<name>/<version>/**            Extension artifact
model-profiles/<name>.yaml                platform-owned ModelProfile
runtime-profiles/<name>.yaml              platform-owned RuntimeProfile
toolchain.yaml                            toolchain identity + pinned cross-runtime versions
toolchain/Dockerfile                      the toolchain image contents
```

`<type>` is one of `solution | capability | policy | eval | ontology |
deployment-profile`. Each version directory is the artifact: every file in it is
part of the digest, so adding a prompt or a TTL file to a published version is a
drift the lock check catches. Template versions are immutable — bump the
directory instead of editing a published one.

The descriptor file and expected `kind`:

| Type | File | `kind` |
| --- | --- | --- |
| `solution` | `solution.yaml` (+ `files/**`) | `SolutionSpec` |
| `capability` | `capability.yaml` | `CapabilityTemplate` |
| `policy` | `policy.yaml` | `PolicyTemplate` |
| `eval` | `eval-suite.yaml` | `EvalSuiteTemplate` |
| `ontology` | `ontology.yaml` | `OntologyTemplate` |
| `deployment-profile` | `deployment-profile.yaml` | `DeploymentProfileTemplate` |
| overlay | `overlay.yaml` | `Overlay` |
| extension | `extension.yaml` | `Extension` |

Only identity fields (`apiVersion`, `kind`, `metadata.name`,
`metadata.version`) are enforced today; the document bodies are platform assets
whose schemas land with the owning tickets. The solution template is the one
exception: its `solution.yaml` must parse as a `SolutionSpec`, because
`fde spec init` materializes it.

## Digest rules

| Artifact | Digest |
| --- | --- |
| Template / overlay / extension directory | `digestFiles()` over every file, path-relative to the version directory |
| Model Profile | `sha256` of the LF-normalized file |
| Runtime Profile | `digestOf()` the parsed document (canonical JSON), so comments and formatting are not identity |
| Toolchain image | `sha256` of `toolchain/Dockerfile` until the published image digest replaces it (#33) |

## The Acme reference path

`templates/solution/fde-solution/1.2.0` is the only Solution Template in this
slice and it materializes the Acme claims-triage read-only Spec, byte for byte.
`packages/cli/test` asserts that equality, so the checked-in example and the
template cannot drift.

Concrete Customer assets keep their derivation explicitly
(`examples/eval/acme/eval-suite.yaml` declares
`materializedFrom: eval/triage-quality@1.0.0`). `fde spec lock` verifies that
the named Template is vendored and pins both the asset and its source.
