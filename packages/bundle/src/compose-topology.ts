import { checkTopology, exposedPorts, parseBundleTopology } from '@fde/spec';
import type {
  BundleTopology,
  ContextServiceTopology,
  Diagnostic,
  Job,
  RuntimeTopology,
} from '@fde/spec';

/**
 * `composeTopology` (`docs/runtime-adapter.md` §8.1).
 *
 * The generator declares only the runtime it owns; the platform declares
 * context-service, the graph/audit volumes and the migrate/ingest jobs. Neither
 * half is a deployment, and neither may render one. This is the single step where
 * the two become `BundleTopology` — the only deployment-topology source the
 * Compose/Helm/airgap renderers consume.
 *
 * It is a pure function of the two fragments: no clock, no environment, no disk.
 * The composed document is parsed and checked before it is returned, so a caller
 * cannot hold a bundle whose references only resolve after a renderer guessed.
 */

export interface ComposeTopologyInput {
  /** The Solution this bundle deploys (`BundleTopology.metadata.solution`). */
  solution: string;
  /** The Solution revision the Spec was at when the build read it. */
  revision: number;
  /** `RuntimeGenerator.generateTopology` — the runtime-owned fragment. */
  runtime: RuntimeTopology;
  /** The vendored platform fragment (`kind: ContextServiceTopology`). */
  platform: ContextServiceTopology;
}

export type ComposeTopologyResult =
  | { ok: true; topology: BundleTopology; warnings: Diagnostic[] }
  | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] };

const RUNTIME_APP = 'runtime-app';

/** A job gates startup only when one of its steps says what it must run before. */
const gatesStartup = (job: Job): boolean => job.steps.some((step) => (step.runBefore ?? []).length > 0);

/**
 * Startup order, derived rather than declared (`docs/runtime-contract.md` §9.2).
 *
 * Platform migrations, then runtime migrations, then platform components, then
 * runtime components. A job whose steps only declare `runAfter` (ingest) is not in
 * the order: it starts once the service it calls is healthy and must never hold
 * readiness hostage. A fragment cannot post its own opinion here — this is the one
 * place the order is decided, which is why `ContextServiceTopology` has no
 * `startupOrder` field at all.
 */
function composeStartupOrder(input: {
  platform: ContextServiceTopology['spec'];
  runtime: RuntimeTopology['spec'];
}): string[] {
  const gating = (jobs: ReadonlyArray<Job>): string[] => jobs.filter(gatesStartup).map((job) => job.name);
  return [
    ...gating(input.platform.jobs),
    ...gating(input.runtime.jobs),
    ...input.platform.components.map((component) => component.name),
    ...input.runtime.components.map((component) => component.name),
  ];
}

export function composeTopology(input: ComposeTopologyInput): ComposeTopologyResult {
  const errors: Diagnostic[] = [];
  const platform = input.platform.spec;
  const runtime = input.runtime.spec;

  // The ingress has one entry and one port: an app that exposes two leaves the
  // composition guessing which one the customer is meant to reach.
  const exposed = exposedPorts(runtime.components)
    .filter((entry) => entry.role === RUNTIME_APP)
    .map((entry) => ({ component: entry.component, port: entry.port }));
  if (exposed.length > 1) {
    errors.push({
      code: 'topology_exposure_invalid',
      path: 'runtime.spec.components',
      message: `the runtime app exposes ${exposed.length} ports (${exposed
        .map((entry) => `${entry.component}:${entry.port}`)
        .join(', ')}); the composed ingress accepts exactly one`,
    });
  }
  if (errors.length > 0) return { ok: false, errors, warnings: [] };

  const document = {
    apiVersion: 'fde.dev/v0' as const,
    kind: 'BundleTopology' as const,
    metadata: {
      solution: input.solution,
      revision: input.revision,
      profile: input.runtime.metadata.profile,
      profileDigest: input.runtime.metadata.profileDigest,
    },
    spec: {
      components: [...platform.components, ...runtime.components],
      volumes: [...platform.volumes, ...runtime.volumes],
      jobs: [...platform.jobs, ...runtime.jobs],
      startupOrder: composeStartupOrder({ platform, runtime }),
      secretBindings: [...platform.secretBindings, ...runtime.secretBindings],
      // Naming is one rule for the whole bundle, so it comes from the fragment that
      // owns the runtime app rather than from each fragment's own idea of it.
      deploymentNaming: runtime.deploymentNaming,
      networks: platform.networks,
      ...(exposed.length === 1 && exposed[0] !== undefined ? { ingress: exposed[0] } : {}),
    },
  };

  const parsed = parseBundleTopology(document);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] };

  const report = checkTopology(parsed.value);
  if (report.errors.length > 0) return { ok: false, errors: report.errors, warnings: report.warnings };

  return { ok: true, topology: parsed.value, warnings: report.warnings };
}
