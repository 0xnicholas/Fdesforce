# `@fde/spec`

The single definition source for the workbench's documents. Everything here is
derived from `docs/` and `contracts/`; nothing is a second copy of a decision.

```text
src/
  schema/                     Zod definitions, one module per document (incl. identity-profile.ts)
  schema/platform-roles.ts    the platform role vocabulary and the scope matrix behind it
  parse.ts                    document seams: parse → typed value | diagnostics
  crossref.ts                 cross-document validation (references, pins, freshness, gates)
  topology.ts                 topology invariants the renderers rely on (exposure, order, volumes)
  canonical.ts                canonical JSON + content digests (`spec.files`, `spec.digest`)
  documents.ts                exported JSON Schema, one artifact per document kind
  contract-drift.ts           structural comparison against contracts/
```

## Document seams

| Function | Answers |
| --- | --- |
| `parseSolutionSpec` / `parseSolutionLock` | is this document shaped correctly? |
| `parseRuntimeProfile` / `parseRuntimeCapabilities` | does the profile declare the ten capability groups consistently? |
| `parseRuntimeTopology` / `parseBundleTopology` | is this one of the two topology documents? |
| `parseModelProfile` | is the model pinned, and is an embedding profile internally consistent? |
| `parseIdentityProfile` | is this the Environment's identity source, and does it have the subjects it needs? |
| `checkSolution` | do the documents agree: references resolve, inputs are pinned, the lock is fresh, gates are safe? |
| `checkTopology` | can a renderer build this: one exposed runtime app, no dangling references, distinct graph/audit volumes, deployment-derived names? |
| `digestFiles` / `canonicalJson` | is a rebuild byte-identical? |
| `diffContractShape` | do `@fde/spec` and `contracts/` still describe the same document? |

`parse*` never throws for expected validation failure; it returns
`{ ok: false, errors }` with a `code`, a document `path`, a `message` and — for
the failures authors actually hit (platform role reuse, unknown fields, the
pre-#17 build shape) — a `remediation`. `checkSolution` is a pure function;
filesystem loading and artifact resolution belong to the CLI (`packages/cli`).

## Test seams

Tests live at the same public seams, nowhere else:

1. `test/schema.test.ts` — document grammar (unknown fields, step types, roles, memory, tool discriminators).
2. `test/identity-profile.test.ts` — the `IdentityProfile` grammar (#29): distinct,
   bounded role/scope lists (the token carries `uniqueItems` and `maxItems: 64`), and
   `test/platform-roles.test.ts`, which pins the role vocabulary and the scope matrix
   to the table in `docs/security-and-deployment.md` §4.1. The three refusals that
   make a profile an authorization document — an unknown platform role, a business
   role reusing a platform role name, a scope no platform role grants — are the build
   gate's (`@fde/runtime-generator`), because they are policy, not shape.
3. `test/fixtures.test.ts` — the checked-in artifacts: the Acme example Spec, its lock, the Runtime Profile and Identity Profile, the prototype Spec/lock and the model profiles.
4. `test/crossref.test.ts` — cross-document rules, each demonstrated by a real diagnostic.
5. `test/canonical.test.ts` — digests pinned to values computed outside this codebase (`shasum`, Python `hashlib`).
6. `test/contract-drift.test.ts` — structural comparison plus the differential corpus that pins the rules a structural comparison cannot see.
7. `test/topology.test.ts` — the topology invariants the Compose/Helm renderers will rely on.

## `inspect.rb` port map

`prototype/11-solution-spec/inspect.rb` encoded the first real checks. Where each
one lives now:

| `inspect.rb` block | Where it lives |
| --- | --- |
| `apiVersion`, `kind`, `lockVersion`, entity maps keyed by id | `schema.test.ts`, Zod definitions |
| capability template pinned, implementation ref resolves, policy/eval refs pinned | `checkSolution` (`lock_pin_missing`, `unresolved_reference`) |
| agent tools exist, `instructions` exists and is pinned | `checkSolution` (`unresolved_reference`, `spec_file_missing`, `spec_file_unpinned`) |
| model profile pinned, artifact version matches lock, `modelVersion` not floating, embedding rules, fallbacks pinned | Zod (`model-profile.ts`) + `checkSolution` (`lock_pin_mismatch`) |
| side-effecting tools get audit metadata and evidence selectors, `runOutcomeDecision` only omitted when read-only | `checkSolution` (`tool_audit_missing`, `audit_evidence_missing`, `audit_binding_invalid`) |
| `tool.pre_invoke` coverage per side-effecting tool | `checkSolution` (`policy_coverage_missing`) |
| evidence selectors: bound recipe, upstream step, resolvable path, `as: citations` needs an array | `checkSolution` (`audit_binding_invalid`, `unresolved_reference`) |
| workflow steps: refs resolve, approval gate blocks the next side-effecting tool, durable, business roles, duration, predicate pinned + bound + declared by its Policy, args upstream, `evidenceFrom` upstream context/tool, `summaryFrom` resolves to a string | Zod (`solution-spec.ts`) + `checkSolution` (`approval_gate_invalid`, `predicate_unknown`, `workflow_step_duplicate`) |
| connector exists, operation allowed, `builtin` warning, schema files exist and are pinned | `checkSolution` (`connector_operation_not_allowed`, `builtin_tool_field`, `spec_file_missing`) |
| governance / overlay / extension refs pinned | `checkSolution` (`lock_pin_missing`, `lock_pin_unpinned`) |
| Context Package + recipe bindings resolve and versions match | `checkSolution` (`context_package_invalid`, `unresolved_reference`) |
| Eval Suite ↔ dataset digest ↔ lock `evalDatasets` | `checkSolution` (`lock_pin_mismatch`) |
| Compose services/volumes/ports/`depends_on`/startup order, ingress exposure | now a topology invariant in `checkTopology` (`topology.test.ts`) — the renderer consumes `BundleTopology`, so the rules live where all three renderers inherit them |
| generated tree: `GENERATED.yaml` sources, Mastra version pin | **deferred**: needs the generator (#27/#30) |
| packaging: `docker compose config`, `helm template` | **deferred**: the renderers do not exist yet (#32 / #41) |
| policy/eval/CCP artifact *schemas* (metric catalog ids, policy parameter types) | **deferred**: those artifacts are governance assets, owned by #10 / #25; only the cross-reference rules are here |

## Adding a document

1. Add `src/schema/<document>.ts` with `z.strictObject` shapes mirroring the
   documented fields — no invented field names.
2. Add a `parse*` function returning `{ ok, errors }`.
3. If `contracts/` already publishes the document, add it to `documents.ts` and
   to the structural comparison in `contract-drift.test.ts`; anything the
   comparison cannot see needs a case in the differential corpus.
4. Add the artifact to `examples/` and validate it in `fixtures.test.ts`.
