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
context-service/<version>/topology.yaml   ContextServiceTopology — the platform's half of a bundle
licenses.yaml                             license facts + redistribution denylist for `fde build`
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
| context-service | `topology.yaml` | `ContextServiceTopology` |

Every directory here is content-addressed by its files; `context-service/<version>`
is the platform's half of `BundleTopology` (`docs/runtime-adapter.md` §8.1), and the
loader refuses a fragment whose `metadata.version` disagrees with its directory.

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
| ContextServiceTopology | the same: `digestOf()` the parsed document |
| Toolchain image | `sha256` of `toolchain/Dockerfile` until the published image digest replaces it (#33) |
| License catalog | `sha256` of the LF-normalized `licenses.yaml`; `fde spec lock` pins it in `toolchain.licenseCatalog` |

## The Acme reference path

`context-service/1.0.0` is the v0 platform fragment: context-service on the internal
bundle network, the graph and audit volumes, the migrate and ingest jobs, and the
secret bindings they resolve — both issuers' public keys as environment variables
for `context-service` itself (`EXECUTION_CONTEXT_PUBLIC_KEY`, `FDE_JOBS_PUBLIC_KEY`)
and the `fde-jobs` private key as a mount for the ingest job. `kid` is not a binding:
the service derives the RFC 7638 thumbprint from each key (`docs/runtime-contract.md`
§5.4). The `mastra-app` private key is the runtime fragment's single binding, so it
lands in the app container and nowhere else; `fde install keys` (#34) generates the
pairs and `fde install verify` checks that the composed bundle still binds them.

`context-service/1.1.0` is additive on top of it: the frozen Context Package as a
read-only fourth volume (the service executes a recipe from it and the ingest job
mounts the same files — `CONTEXT_PACKAGE_PATH`), and the two deployment facts a
maintenance token must claim, `FDE_DEPLOYMENT_ID` and `FDE_SOLUTION_ID`, as
install-time variables. It is a separate directory rather than an edit because a
published fragment is immutable once a lock has pinned its digest.

`@fde/bundle` composes it with the generator's
`RuntimeTopology` into the single `BundleTopology` a renderer consumes.
`toolchain.yaml` names the fragment version (`spec.contextServiceTopology`), and
`fde spec lock` pins its version **and** parsed-document digest in
`toolchain.contextServiceTopology`, so `fde build` never picks "the newest
directory" for an address a lock is supposed to fix. A comment edit does not
move that digest; a field edit does.

`licenses.yaml` is the redistribution boundary `fde build` reads: every component
the bundle may carry needs a declared SPDX license, and the `denied` list names
GPL/AGPL/LGPL, SSPL, Elastic License and BUSL. Mastra is core-only — a profile
that adds `@mastra/ee` fails `license_blocked` even if a catalog entry exists.
The same document renders the SBOM and `NOTICE`, so evidence and gate cannot
diverge. `fde install verify` reads this file again on the customer side, from the
copy the customer pins: the boundary is a policy, so the installer never takes it
from the bundle it is judging.

`templates/solution/fde-solution/1.2.0` is the only Solution Template in this
slice and it materializes the Acme claims-triage read-only Spec, byte for byte.
`packages/cli/test` asserts that equality, so the checked-in example and the
template cannot drift.

Concrete Customer assets keep their derivation explicitly
(`examples/eval/acme/eval-suite.yaml` declares
`materializedFrom: eval/triage-quality@1.0.0`). `fde spec lock` verifies that
the named Template is vendored and pins both the asset and its source.
