# `@fde/runtime-generator`

The build-time `RuntimeGenerator` port, the versioned Runtime Profile artifact and
the fail-closed capability gate (`docs/runtime-adapter.md` §4, §5, §7).

This package is what every generator shares. It is **not** a generator: the v0
Mastra implementation (`generateApp`, `generateTopology`, `generateMigrations`,
`generateContractTests`) lives in
[`@fde/runtime-generator-mastra`](../runtime-generator-mastra/README.md) (#27,
#28), and the CLI that orchestrates a build around it is
[#33](https://github.com/0xnicholas/Fdesforce/issues/33).

```text
src/
  port.ts          the six-method port and every input/output that crosses it
  files.ts         the A11 helpers: canonical JSON files, sorted paths, sourceDigest
  codes.ts         the validation-class diagnostic codes, as a closed union
  capabilities.ts  normalization, one-path lookup, group/member consistency, handshake map
  profile.ts       profileRef / profileDigest / resolveRuntimeProfile and lock-pin reading
  requirements.ts  must/should derivation from the Solution Spec
  identity.ts      the identity half of the gate (#29): role vocabulary, role collisions, scope escalation
  validate.ts      the gate: profile, capabilities, state store, topology, extensions, license, connectors, identity
```

## The port

| Method | Input | Output | Answers |
| --- | --- | --- | --- |
| `capabilities` | `RuntimeProfile` | `RuntimeCapabilities` | what can the generated app do? |
| `validate` | Spec + Profile + Environment + lock + Extensions (+ Connectors + the Environment's `IdentityProfile`) | `RuntimeValidationResult` | may this be built? |
| `generateApp` | validation input + build context + resolved `files` / `modelProfiles` | `GeneratedApp` | the source tree, Dockerfile and entrypoint |
| `generateTopology` | same | `RuntimeTopology` | the runtime-owned fragment of the deployment topology |
| `generateMigrations` | same | `RuntimeMigrationPlan` | the runtime-owned state store migrations |
| `generateContractTests` | same | `TestPlan` | A-case → command/fixture mapping |

Not provided, on purpose: `build`, `deploy`, `run`, `resume`, `checkpoint`,
`snapshot`. A port that grows one of those has become the universal runtime
abstraction ADR-0010 rejected — every adapter would have to reimplement
checkpoint replay, SSE transport and approval state for a shape that cannot hold
them. `test/port.test.ts` fails to compile if one appears.

A generator also cannot read the disk, so anything a Spec references — a prompt,
a JSON Schema, a Model Profile — arrives resolved in the generate input:

| Input field | What it is | Who resolves it |
| --- | --- | --- |
| `files` | `solution.lock.spec.files`, path → content | the CLI, from the same bytes the lock digested |
| `modelProfiles` | the parsed `ModelProfile` documents agents reference, keyed by name | the CLI, digest-verified against the lock |
| `connectors` | Connector typed operations (D6) | the CLI |

A generator that needs one of them and was not given it throws: a build that
cannot read a pinned prompt is a different build, not a smaller one.

Everything crossing the port is JSON-serializable plain data, because a second
generator may be Python behind a JSON/CLI shim (`docs/runtime-adapter.md` §4.1).
`test/port.test.ts` proves it two ways: a compile-time check that no declared
field is a `Date`, `Map`, function or other non-JSON leaf, and a runtime
round-trip of a real validation input, result and generation output.

A generator is a pure function of its input. Generation must not read a clock,
randomness, environment values, the network or the filesystem, or the same
inputs would stop producing the same `sourceDigest` (A11). `test/boundary.test.ts`
scans `src/` for those APIs, and `package.json` lists `@fde/spec` as the only
runtime dependency.

### Build order

`docs/runtime-adapter.md` §4.4 fixes seven steps. This package owns the middle of
the chain; the ends belong to the CLI.

| Step | Where |
| --- | --- |
| 1. read Spec + lock, verify digests and freshness | `@fde/cli` (#25/#33) |
| 2. resolve `build.runtimeProfile`, verify the profile digest | `profile.ts` + `checkProfile` here; resolution is the CLI's |
| 3. `capabilities()` → normalized declaration | `resolveRuntimeProfile` here |
| 4. `validate()` → derive requirements, fail on errors, keep warnings | `validate.ts` here |
| 5. generate app / topology / migrations / contract tests | `@fde/runtime-generator-mastra` (#27, #28) |
| 6. compose `BundleTopology` and the full migration plan | `@fde/cli` + platform (#32) |
| 7. static conformance (A1, A9 static, A11) | `@fde/cli` (#33) |

## Runtime Profile

A Profile is platform-owned, versioned and content-addressed. Identity is
`name@version`; address is `sha256` over the parsed document's canonical JSON
(`platform/README.md`), and `solution.lock.runtime` pins both — folded into the
reference (`name@version@sha256:…`) or beside it (`profileDigest`). Both shapes
are accepted and a pin with neither, or with two that disagree, is a schema
error in `@fde/spec`.

`resolveRuntimeProfile(profile)` returns the identity, the digest, the normalized
declaration and the flat `capability_details` map the `runtime-info` handshake
reports. The digest is computed **before** normalization, so canonicalizing a
declaration can never move a pin. A generator's `capabilities(profile)` is
`resolveRuntimeProfile(profile).capabilities`.

## Capability levels

Ten groups, each with `native / adapter / degraded / none` members
(`docs/runtime-adapter.md` §5.2). Only three classes are visible to a build:

| Level | Meaning | A `must` requirement |
| --- | --- | --- |
| `native` | the runtime primitive provides it; the generator configures it | satisfied |
| `adapter` | the generator emits glue; the capability works end to end | satisfied |
| `degraded` | it works with a declared loss (a `limitations` entry) | fails |
| `none` | the generator cannot emit it | fails |

Because `native` and `adapter` are both *satisfied*, the group-versus-member
consistency check does not order them against each other — the reference profile
legitimately declares `durableWorkflow: native` with `autoResume: adapter`. What
it does enforce is that a group can never hide a loss:

- a group declared `native` or `adapter` must have no `degraded`/`none` member;
- a group declared `degraded` must have no `none` member and must list what is
  lost;
- a group declared `none` may still have usable members (conservative, never
  masking).

Violations are `runtime_capability_inconsistent` errors, not silent
interpretations: `hitl.consume: degraded` behind `hitl.support: native` is exactly
the case the doc says must fail the build.

## Requirement derivation

`deriveRequirements({ spec, environment })` applies `docs/runtime-adapter.md`
§7.1 to the Spec:

| Construct | Required capability | Level |
| --- | --- | --- |
| any Workflow `durable: true` | `durableWorkflow`, `stateStore` | must |
| any `approval` step | `hitl.interrupt`, `hitl.resume`, `hitl.approvalResource`, `hitl.expiry`, `hitl.consume` | must |
| an Agent declaring `memory.thread` | `memory.thread`, `stateStore` | must |
| an Agent declaring `memory.longTerm` | `memory.longTerm` | must |
| a Connector-backed Tool | `tools.connectorOperations` | must |
| any other Tool | `tools.native` | must |
| any Extension | `extensions` | must |
| `build.delivery: offline-bundle`, an `airgap` target, `build.requirements.offline: true`, or a `restricted` network class | `offline` | must |
| the Run API (always) | `streaming` | must |
| v0 topology (always) | `topology` | must |
| `build.requirements.observability.otel: required` | `observability.otel` | must |
| otherwise | `offline`, `observability` | should |

Every requirement records its `capability`, its `level` and its `source`, because
`fde build` writes the list into build provenance — a requirement nobody can
trace back to a construct is a requirement nobody can fix. Sources use three
shapes:

| Source | Means |
| --- | --- |
| `spec.<path>` | the construct that needs it, e.g. `spec.workflows.document-triage-flow.steps[1]` |
| `contract:fde.runtime/v1#<anchor>` | the wire contract implies it (`run-api-sse`, `split-topology`) |
| `build:<key>` | a platform default, promotable through `spec.build.requirements` |

`should` exists only for platform defaults, and a `must` from any source retires
the `should` for the same capability. Promotion is one-way (§7.2): nothing can
turn a `must` into a `should`. An `approval` step also requires `hitl.expiry`
even though §7.1's row names four paths — the step declares `expiresAfter`, so
the expiry job the generated app must schedule is part of the same construct.

## Diagnostics

`validate` returns `{ requirements, errors, warnings }`. It never throws for an
expected validation failure: the only exceptions are programmer errors, e.g. a
missing `lock` that the CLI should have resolved first. There is no `--force` and
no waiver (v0): the way past the gate is to change the Spec, the Profile, the
Environment or the Extension.

| Code | Fails when | Severity |
| --- | --- | --- |
| `runtime_profile_missing` | no Profile was resolved, or it does not hash to the pinned digest | error |
| `runtime_profile_mismatch` | the pinned name/version, `spec.build.runtimeProfile`, the generator identity, a lock-owned package pin, or the contract minor disagree | error |
| `runtime_contract_mismatch` | the contract major is not `fde.runtime/v1` | error |
| `runtime_capability_missing` | a requirement's path is not declared, or is `none` | `must` error / `should` warning |
| `runtime_capability_degraded` | a requirement is provided with a declared loss | `must` error / `should` warning |
| `runtime_capability_inconsistent` | a group level is stronger than its members, or a degraded group lists no limitations | error |
| `runtime_state_store_unsupported` | the selected store's kind is not in `stateStore.kinds`, the schema version disagrees with the profile, or the Environment and the lock select different stores | error |
| `runtime_topology_unsupported` | the profile cannot build the split topology, or needs multiple writers | error |
| `runtime_topology_unused_mode` | the profile declares a topology mode v0 does not render | warning |
| `runtime_extension_unsupported` | an Extension's artifact kind or runtime compatibility does not fit the profile | error |
| `runtime_license_blocked` | an air-gapped target would need a license key or egress | error |
| `runtime_connector_contract_missing` | a Connector-backed Tool's Connector or typed operation is not resolved | error |
| `runtime_connector_operation_untyped` | neither the Connector operation nor the Tool declares input/output schemas (GAPS.md GAP-1) | warning |
| `runtime_grammar_unsupported` | a construct the Spec's grammar allows but this generator version cannot emit: an `approval` step, a side-effecting Tool, a `memory` declaration, a reference it cannot resolve | error |
| `runtime_identity_role_unknown` | a subject of the Environment's `IdentityProfile` asserts a role outside the fixed platform vocabulary | error |
| `runtime_identity_role_collision` | a business role reuses a platform role name, which would let a Customer IdP group pose as platform authority | error |
| `runtime_identity_scope_escalation` | a subject claims a scope its platform roles do not grant — including any scope a business role would confer | error |
| `runtime_identity_invalid` | the profile is not the one this deployment needs: another Customer or Environment, a `defaultSubject` that is not declared, a subject declared twice | error |

A business role that only *looks* like a platform role (`Customer_Admin`) collides
too: IdP group names are not normalised by the customer, and a name that reads as
authority in an audit trail is the footgun the rule exists to close.

`runtime_grammar_unsupported` is the generator-side member of the closed union:
each generator's `validate` adds the grammar it alone understands, so "this slice
does not generate that yet" is a build failure with a code, never a silently
dropped construct. The first implementer is
[`@fde/runtime-generator-mastra`](../runtime-generator-mastra/README.md).

### The identity gate (#29)

An `IdentityProfile` is an authorization document: it says which subject a Run runs
as and which roles that subject asserts, and the generated app turns those roles
into a signed `ExecutionContext`. So the three refusals above are escalations, not
typos — a role the vocabulary does not have grants nothing, a business role that
poses as `customer_admin` grants everything, and a scope no platform role grants is
privilege a credential asked for and nobody gave.

Scopes are derived from platform roles only (`scopesForRoles`), which is what makes
"a business role never receives a platform scope" a property of the code rather
than a promise in a document. The profile is mounted at deploy time, so the
generated app re-checks the same three rules when it loads it; the build check is
still worth having, because it reports them next to the Spec that will be built.

`identity` is optional in the validation input: a build that was not given the
Environment's profile mounts it later, and then the app's load-time check is the
only gate. A profile the build *can* see is judged, and nothing about it is baked
into the tree — it names people.

`runtime_schema_mismatch` (graph/audit schema) and the generation codes
(`runtime_generation_nondeterministic`, `runtime_manifest_invalid`) are decided by
`fde build` (#33) — the port has no platform schema pin to compare against. The
runtime-side handshake codes belong to the generated app (#30).

An Environment that selects no state store is left to the platform default
(libsql/SQLite, user story 38); only an explicit selection is checked against the
profile.

## Determinism helpers

`canonicalJsonFile`, `sortedFiles` and `sourceDigest` live here rather than in each
generator, because "deterministic" is a property the whole build has or does not
have: a second generator that sorted differently would make the bundle digest
depend on which component happened to be generated last. `canonicalJsonFile` is
canonical JSON (`@fde/spec`'s serializer, sorted keys) written out indented with
one trailing newline — byte-stable and still reviewable in a diff.

## Test seams

| File | Seam |
| --- | --- |
| `test/capabilities.test.ts` | normalization, one-path lookup, group/member consistency, handshake map |
| `test/requirements.test.ts` | `must`/`should` derivation, promotion, source provenance, determinism |
| `test/profile.test.ts` | the artifact's content address and both lock-pin shapes |
| `test/validate.test.ts` | the gate, one diagnostic at a time |
| `test/identity.test.ts` | the identity half of the gate: the three escalations, each with its own code |
| `test/port.test.ts` | port surface, JSON round-trip, no lifecycle method |
| `test/boundary.test.ts` | dependency, network, disk, clock and randomness rules |
| `test/fixtures.test.ts` | the checked-in Profile + Acme Spec as one reference path |
| `test/files.test.ts` | the A11 helpers: canonical JSON, ordered paths, duplicate refusal, digest shape |
