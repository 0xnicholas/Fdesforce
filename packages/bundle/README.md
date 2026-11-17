# `@fde/bundle`

The platform side of a bundle. The generator emits a `RuntimeTopology` fragment and
stops; the platform owns context-service, the graph and audit volumes and the
maintenance jobs. This package is where the halves become one deployment:

```text
RuntimeGenerator.generateTopology ─┐
                                   ├─ composeTopology ─→ BundleTopology ─→ renderCompose ─→ deploy/compose.yaml
platform/context-service/<v> ──────┘                          │
                                                              └─ deploymentInstance(deployment_id) ─→ names, host port
```

```text
src/
  platform-fragment.ts   read + validate `platform/context-service/<version>/topology.yaml`
  compose-topology.ts    RuntimeTopology + ContextServiceTopology → BundleTopology
  deployment.ts          deployment_id → service/volume/network names and the ingress host port
  compose.ts             BundleTopology + DeploymentInstance → the single-node Compose file
```

It depends on `@fde/spec` only. It never imports generator code, never reads a
runtime's conventions and never touches the network — a second generator changes
nothing here (`docs/runtime-adapter.md` §8.1).

## Seams

| Function | Answers |
| --- | --- |
| `loadContextServiceTopology({ platformRoot, version? })` | which vendored platform fragment does this build compose, and is it the document its directory claims? |
| `composeTopology({ solution, revision, runtime, platform })` | is the pair a complete, single-writer bundle with resolvable references? |
| `deploymentInstance(topology, deploymentId)` | what are this deployment's names, and which host port does it publish? |
| `renderCompose(topology, instance)` | what does `docker compose up` read? |

`composeTopology` returns `{ ok: true, topology, warnings } | { ok: false, errors,
warnings }` and runs both the grammar (`parseBundleTopology`) and the invariants
(`checkTopology`) before it returns, so a caller cannot hold a bundle whose
references only resolve after a renderer guessed. Warnings are carried on both
branches because they belong in build provenance whether or not a warning was the
reason to stop. `renderCompose` returns the same union (with `file` instead of
`topology`) and re-runs `checkTopology` for the same reason.

`deploymentInstance` is the one seam that throws instead of returning a report. Its
input is not a document to validate but a caller argument — a deployment id — and a
caller that cannot name its own deployment has nothing to render. The `fde` CLI
validates the id (`DeploymentIdSchema`) before calling, so the throw is a programmer
error, not an operator diagnostic.

## What composition decides

- **The startup order.** Derived, never declared: platform migrations → runtime
  migrations → platform components → runtime components. A job whose steps only
  declare `runAfter` (ingest) is not in it — it starts after the service it calls
  and must not hold readiness. `ContextServiceTopology` has no `startupOrder` field
  for this reason.
- **The ingress.** Derived from the single `expose: true` port of the runtime app;
  two exposed ports are a bundle with no single entry, and the composition refuses.
- **The naming rule and the Profile identity**, taken from the runtime fragment —
  the fragment that owns what is being deployed.

## What the deployment instance decides

`deployment_id` is `dep_<ULID>`; a container name is a lowercase DNS label. The
instance lowercases the id, replaces `_` with `-` and applies
`deploymentNaming.componentNameTemplate` to every component, job, volume and
network, and `namespaceTemplate` to the Compose project. `namespaceTemplate` is
required for that reason — the project name is the deployment's, and a fallback
invented in the renderer would be a second owner of the naming rule. The published host port is
derived too — `30000 + sha256(deployment_id)[0..4] % 20000` — because a fixed 4111
makes two bundles on one customer host contend, and a hand-picked port is a value
the bundle cannot reproduce. It binds to loopback: the customer terminates TLS and
forwards.

## What the Compose renderer emits, and what it refuses

One service per component and per job; `depends_on` with `service_healthy` for a
component and `service_completed_successfully` for a job; every service on the
internal `bundle` network with its topology name as an alias (so
`http://context-service:8011` survives the deployment prefix) and only the ingress
component on the non-internal network; one container per service (the v0 stores are
single-writer, so a replica is a second writer, not capacity); `restart: "no"` for
jobs — quoted, because unquoted `no` is YAML 1.1 `false`.

Secrets stay `secretRef`s. An `env` binding renders `${NAME:?}` and a `file` binding
renders a Compose secret whose path comes from `${NAME_FILE:?}`, resolved by the
install step from the customer's store (`docs/runtime-contract.md` §9.3). The
manifest therefore contains no secret value, and an unset secret is a deployment
that stops instead of one that starts with an empty signing key.

It refuses rather than guesses: a job with more than one step (`renderer_multistep_job`),
a health check with no exec `command` (`renderer_probe_missing`), a job whose owner
has no component image to run in (`renderer_job_image_missing`), and a topology
whose exposed ports do not name one ingress (`renderer_ingress_ambiguous`).

`docker compose -f deploy/compose.yaml config` is the manual check that a rendered
file is what Compose understands; it also fails closed on a missing secret, which is
the behaviour the `${NAME:?}` spellings are for. The automated version is the smoke
deployment (#41).

## Boundaries

- **Helm and the airgap bundle** render from the same `BundleTopology`; they are
  Slice 2.6 (`docs/architecture-synthesis.md` §5). Nothing in this package is
  Compose-specific except `compose.ts`.
- **Building images, SBOM, signing and writing the bundle** are `fde build`'s (#33).
  `fde build` calls `composeTopology` + `deploymentInstance` + `renderCompose`
  and writes the payload; this package still produces a document and a manifest
  and never writes to disk.
- **context-service itself** is #35–#40. The vendored fragment names a build context
  (`context-service`) rather than a digest until the release chain pins one.
