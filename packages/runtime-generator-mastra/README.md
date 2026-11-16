# `@fde/runtime-generator-mastra`

The v0 `RuntimeGenerator` implementation (`docs/runtime-adapter.md` §12): it turns
the read-only Acme Solution Spec into a mastra-app source tree, and refuses to
build anything this slice cannot generate honestly.

This ticket is the **app skeleton** ([#27](https://github.com/0xnicholas/Fdesforce/issues/27)).
`generateTopology`, `generateMigrations` and `generateContractTests` belong to the
Run API + state store slice ([#28](https://github.com/0xnicholas/Fdesforce/issues/28)),
and they throw — an empty topology would render a deployment that silently has no
runtime in it.

```text
src/
  generator.ts  the port: capabilities / validate / generateApp (+ the #28 methods)
  grammar.ts    what this generator refuses, and why
  app.ts        the file emitters
  builtins.ts   the platform built-in Tools and the retrieval contract
  naming.ts     the one place a Spec id becomes a TypeScript identifier
```

## The generated tree

```text
mastra-app/
  Dockerfile                  node:<locked>, npm install, runs src/index.ts
  package.json                every dependency from the Runtime Profile, node from the lock
  tsconfig.json               typecheck-only (`erasableSyntaxOnly`, `allowImportingTsExtensions`)
  src/index.ts                boots the instance, `/healthz` only (#28 adds the Run API)
  src/mastra.ts               the Mastra instance: agents + workflows
  src/agents/<agent>.ts       instructions baked verbatim from the pinned prompt file
  src/workflows/<flow>.ts     one `createStep` per Spec step, chained in declared order
  src/tools/<tool>.ts         one `createTool` per reachable Tool
  src/schemas/<file>.ts       each referenced JSON Schema, verbatim
  src/runtime/retrieval.ts    the platform retrieval contract (types + JSON Schema)
  src/runtime/context-client.ts   the single seam to context-service
  src/runtime/execution-context.ts the per-Run token + traceparent the Run service provides
```

Paths are bundle-root-relative and sorted; every file carries an explicit mode;
`sourceDigest` is `digestFiles()` over the returned set, the same rule
`solution.lock.spec.digest` uses.

### Where every version comes from

| Version | Source |
| --- | --- |
| `@mastra/core` and any other app dependency | `RuntimeProfile.spec.packages` — the Profile describes the generated app, so its package set *is* the app's dependency set |
| Node | `solution.lock.runtime.node` |
| provider / model / model version / params | the pinned `ModelProfile` document |
| contract version | `solution.lock.runtime.contractVersion` (`FDE_CONTRACT_VERSION` build arg) |

Nothing in the generated tree is a constant in this package, and nothing reads a
clock, randomness, an environment value, the network or the disk (`test/determinism.test.ts`,
`test/compile.test.ts`). An Environment supplies the endpoint and the secret; it
never supplies a version.

### Why the app runs TypeScript directly

`package.json`'s dependency set is exactly the Runtime Profile's package set, and
the Profile pins no compiler — so there is no build step, and the image runs
`node --experimental-strip-types src/index.ts`. The compile check is
`tsc --noEmit` over the same sources with the workbench toolchain
(`test/compile.test.ts` runs it against this package's pinned `@mastra/core`);
`tsconfig.json` sets `erasableSyntaxOnly`, which makes the compiler prove the
sources can be stripped. Import specifiers therefore carry the `.ts` extension,
which is what Node's type stripping resolves.

## The grammar gate

`validate` is the shared capability gate (`@fde/runtime-generator`) plus this
generator's grammar gate. `generateApp` re-checks and throws, so a caller that
skipped `validate` cannot get a tree with a construct silently dropped out of it.

| Construct | Diagnostic | Why |
| --- | --- | --- |
| `approval` step | `runtime_grammar_unsupported` | HITL request/wait/commit and `approval.required` SSE are C16–C25 |
| Tool with `sideEffects: write \| external` | `runtime_grammar_unsupported` | record-before-act, intent/outcome Decisions and evidence selectors are C26–C32; a Tool the model can call is reachable whether or not a step names it |
| a `tool` step calling a side-effecting Tool | `runtime_grammar_unsupported` | same, reported at the step as well as the Tool |
| Agent `memory` declaration | `runtime_grammar_unsupported` | thread memory needs the runtime state store, long-term memory is `fde_memory` (C41–C48) |
| Extension with `interface: tool` | `runtime_extension_unsupported` | the app would have to load the artifact itself (A9); v0 emits no loader |
| capability-level `extensionRefs` | `runtime_extension_unsupported` | same |
| a workflow step referencing an undeclared Tool, Agent or recipe binding | `runtime_grammar_unsupported` | there is nothing to generate |
| an Agent listing a Tool the Spec does not declare | `runtime_grammar_unsupported` | same |
| two Spec ids that map to one TypeScript identifier | `runtime_grammar_unsupported` | the tree would not compile, and the author would be reading generated code to find out why |
| a Tool that is neither `builtin` nor `connectorRef` + `operation` | `runtime_grammar_unsupported` | no implementation to generate |
| a builtin this generator does not publish | `runtime_grammar_unsupported` | the builtin has no body and no schema |

A `connector` Extension is accepted: context-service executes it through a typed
operation, so the generated app never sees the artifact. That is what makes the
read-only Acme Spec buildable while the full Acme scenario (approval gate, write
Tool, memory) is not.

### What the tree deliberately does not do

These are not silent drops: each belongs to another component, and each is
recorded here so an FDE engineer reading the tree knows where it went.

| Spec construct | Where it lands |
| --- | --- |
| `workflow.durable`, `workflow.timeout`, capability `budget` | the Run service and the runtime state store (#28) |
| `build.toolchain.image` | build provenance (#33): the tree does not depend on it, so it is not baked into a file |
| capability `audit.runOutcomeDecision`, Tool `audit` / `rateLimit` | record-before-act and the policy enforcement points (#29) |
| `policyRefs`, `governance`, `evalRefs`, `overlays` | policy/eval artifacts compiled by the CLI, not app source |
| `semantic.contextPackageRef`, connector manifests | the CCP that context-service loads |
| the Connector typed-operation endpoint | `fde.runtime/v1` publishes no `/v1/connectors/...` yet (GAPS.md GAP-1, #29); the generated Connector Tool calls the path the seam will own, which keeps the app's only gap visible in one file |
| `environments`, `deployment` | the Bundle topology and the Compose renderer (#32) |
| Model Profile `params.responseFormat` / `params.extra` | structured output comes from the step's `outputSchema`, and `extra` is an untyped vendor escape hatch with no pinned meaning — neither is baked, and the reference profile declares neither |

## Test seams

| File | Seam |
| --- | --- |
| `test/grammar.test.ts` | the gate, one refused construct at a time |
| `test/app.test.ts` | the generated tree: paths, modes, pins, agent/workflow/tools content |
| `test/determinism.test.ts` | A11: same input → same bytes and digest; no build-time entropy |
| `test/compile.test.ts` | the tree typechecks against the pinned `@mastra/core`, plus the package boundary |
| `test/contract-drift.test.ts` | the retrieval catalogue against `contracts/schemas/retrieval.schema.json` |
| `test/port.test.ts` | port identity, `capabilities`, and the #28 methods failing loudly |

`test/compile.test.ts` and `test/determinism.test.ts` are what turn the ticket's
acceptance criteria into something CI can enforce. The compile test materialises
the tree inside this package's `node_modules/.cache`, so `@mastra/core`,
`@types/node` and `typescript` resolve from the versions this package pins —
`devDependencies['@mastra/core']` is asserted to equal the Profile's pin, so the
check cannot silently drift from the artifact it is checking.
