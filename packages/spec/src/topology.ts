import { canonicalJson } from './canonical.js';
import type { Diagnostic } from './parse.js';
import type { BundleTopology, RuntimeTopology, SecretBinding, Topology } from './schema/bundle-topology.js';

/**
 * Topology invariants (`docs/runtime-adapter.md` §8.3).
 *
 * These are the Compose/Helm renderer's assumptions expressed once, before any
 * renderer exists: reference integrity, one exposed runtime app, no shared
 * graph/audit volume, startup order, deployment naming, single writers. The
 * renderers (#32) consume `BundleTopology` and may rely on all of it.
 */

export interface TopologyReport {
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

/** A port a component publishes: the only shape the ingress and the renderer may use. */
export interface ExposedPort {
  component: string;
  role: string;
  port: number;
}

/**
 * Every `expose: true` port, with the component that declares it.
 *
 * The invariant checker, the composition and the renderer all need this answer, and
 * three slightly different filters is how a port ends up exposed to one of them and
 * not the others.
 */
export function exposedPorts(
  components: ReadonlyArray<{
    name: string;
    role: string;
    ports?: ReadonlyArray<{ containerPort: number; expose?: boolean }>;
  }>,
): ExposedPort[] {
  return components.flatMap((component) =>
    (component.ports ?? [])
      .filter((port) => port.expose === true)
      .map((port) => ({ component: component.name, role: component.role, port: port.containerPort })),
  );
}

interface TopologyView {
  components: Topology['spec']['components'];
  volumes: Topology['spec']['volumes'];
  jobs: Topology['spec']['jobs'];
  startupOrder: string[];
  secretBindings: SecretBinding[];
  networks?: Array<{ name: string; internal: boolean }>;
  ingress?: { component: string; port: number } | undefined;
  deploymentNaming: { componentNameTemplate: string; namespaceTemplate?: string };
  isBundle: boolean;
}

const toView = (topology: Topology): TopologyView => {
  const spec = topology.spec;
  const view: TopologyView = {
    components: spec.components,
    volumes: spec.volumes,
    jobs: spec.jobs,
    startupOrder: spec.startupOrder,
    secretBindings: spec.secretBindings,
    deploymentNaming: spec.deploymentNaming,
    isBundle: topology.kind === 'BundleTopology',
  };
  const bundle = spec as BundleTopology['spec'];
  if (bundle.networks !== undefined) view.networks = bundle.networks;
  if (bundle.ingress !== undefined) view.ingress = { component: bundle.ingress.component, port: bundle.ingress.port };
  return view;
};

const RUNTIME_APP = 'runtime-app';
const CONTEXT_SERVICE = 'context-service';

/**
 * Roles a bundle may hold at most one of.
 *
 * A `runtime-app` is absent on purpose: two runtime apps already fail
 * `topology_runtime_app_invalid`, and one failure per mistake is what makes a
 * diagnostic actionable. The stores are here because `backend.graph: embedded`
 * is a single-writer store (`docs/runtime-contract.md` §9.4) — the topology has
 * no replica knob, so a second replica can only be written as a second component,
 * and that is exactly what this refuses.
 */
const SINGLETON_ROLES = [CONTEXT_SERVICE, 'state-store', 'graph-store', 'audit-store'] as const;

interface SecretClaim {
  key: string;
  path: string;
  /** `inline` claims carry their own name and target; a `secretRefs` claim needs a binding. */
  inline: boolean;
}

export function checkTopology(topology: RuntimeTopology | BundleTopology): TopologyReport {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const view = toView(topology);
  const fail = (code: string, path: string, message: string): void => {
    errors.push({ code, path, message });
  };
  const note = (code: string, path: string, message: string): void => {
    warnings.push({ code, path, message });
  };

  // Names are the join key for `dependsOn`, `startupOrder`, volumes and mounts.
  const componentNames = new Set<string>();
  for (const [index, component] of view.components.entries()) {
    if (componentNames.has(component.name)) {
      fail('topology_name_conflict', `spec.components[${index}].name`, `component ${component.name} is declared twice`);
    }
    componentNames.add(component.name);
  }
  const jobNames = new Set<string>();
  for (const [index, job] of view.jobs.entries()) {
    if (jobNames.has(job.name)) {
      fail('topology_name_conflict', `spec.jobs[${index}].name`, `job ${job.name} is declared twice`);
    }
    if (componentNames.has(job.name)) {
      fail('topology_name_conflict', `spec.jobs[${index}].name`, `job ${job.name} reuses a component name`);
    }
    jobNames.add(job.name);
  }
  const known = (name: string): boolean => componentNames.has(name) || jobNames.has(name);

  // A volume name is a host-side identity: two definitions of one name are one
  // volume with two sizes, and the renderer would pick whichever came last.
  const volumeNames = new Set<string>();
  for (const [index, volume] of view.volumes.entries()) {
    if (volumeNames.has(volume.name)) {
      fail('topology_name_conflict', `spec.volumes[${index}].name`, `volume ${volume.name} is declared twice`);
    }
    volumeNames.add(volume.name);
  }

  const mountedVolumes = new Set<string>();
  const checkMounts = (mounts: ReadonlyArray<{ name: string; mountPath: string }> | undefined, path: string): void => {
    const paths = new Map<string, string>();
    const volumes = new Map<string, string>();
    for (const [index, mount] of (mounts ?? []).entries()) {
      mountedVolumes.add(mount.name);
      if (!volumeNames.has(mount.name)) {
        fail('topology_reference_missing', `${path}[${index}].name`, `volume ${mount.name} is mounted but not declared`);
      }
      const otherPath = paths.get(mount.mountPath);
      if (otherPath !== undefined) {
        fail(
          'topology_volume_conflict',
          `${path}[${index}].mountPath`,
          `${mount.name} and ${otherPath} are both mounted at ${mount.mountPath}; a container has one filesystem`,
        );
      }
      paths.set(mount.mountPath, mount.name);
      // One volume at two paths is one store playing two roles — how a bundle ends up
      // with graph facts and audit evidence in the same file while every name check
      // passes (§8.3). The mount is a bijection or it is a mistake.
      const otherVolumePath = volumes.get(mount.name);
      if (otherVolumePath !== undefined) {
        fail(
          'topology_volume_conflict',
          `${path}[${index}].name`,
          `volume ${mount.name} is mounted at ${mount.mountPath} and at ${otherVolumePath}; one volume serves one role`,
        );
      }
      volumes.set(mount.name, mount.mountPath);
    }
  };

  const claims: SecretClaim[] = [];
  const claim = (secretRef: { store: string; key: string; version?: string }, path: string, inline: boolean): void => {
    claims.push({ key: canonicalJson(secretRef), path, inline });
  };

  for (const [index, component] of view.components.entries()) {
    const path = `spec.components[${index}]`;
    for (const [depIndex, dependency] of (component.dependsOn ?? []).entries()) {
      if (!known(dependency)) {
        fail('topology_reference_missing', `${path}.dependsOn[${depIndex}]`, `${dependency} is not a component or job`);
      }
      if (dependency === component.name) {
        fail('topology_reference_cycle', `${path}.dependsOn[${depIndex}]`, `${component.name} depends on itself`);
      }
    }
    checkMounts(component.volumes, `${path}.volumes`);

    const ports = component.ports ?? [];
    const containerPorts = new Set<number>();
    const portNames = new Set<string>();
    for (const [portIndex, port] of ports.entries()) {
      if (containerPorts.has(port.containerPort)) {
        fail('topology_port_conflict', `${path}.ports[${portIndex}].containerPort`, `container port ${port.containerPort} is declared twice on ${component.name}`);
      }
      containerPorts.add(port.containerPort);
      if (portNames.has(port.name)) {
        fail('topology_port_conflict', `${path}.ports[${portIndex}].name`, `port name ${port.name} is declared twice on ${component.name}`);
      }
      portNames.add(port.name);
      if (port.expose === true && component.role !== RUNTIME_APP) {
        fail(
          'topology_exposure_invalid',
          `${path}.ports[${portIndex}].expose`,
          `${component.name} is a ${component.role}; only the runtime app may be exposed to the customer ingress`,
        );
      }
    }

    for (const [envIndex, env] of (component.env ?? []).entries()) {
      if (env.secretRef !== undefined) claim(env.secretRef, `${path}.env[${envIndex}].secretRef`, true);
    }
    for (const [refIndex, secretRef] of (component.secretRefs ?? []).entries()) {
      claim(secretRef, `${path}.secretRefs[${refIndex}]`, false);
    }
  }

  for (const [index, job] of view.jobs.entries()) {
    const path = `spec.jobs[${index}]`;
    for (const [stepIndex, step] of job.steps.entries()) {
      for (const field of ['runBefore', 'runAfter'] as const) {
        for (const [refIndex, ref] of (step[field] ?? []).entries()) {
          if (!known(ref)) {
            fail('topology_reference_missing', `${path}.steps[${stepIndex}].${field}[${refIndex}]`, `${ref} is not a component or job`);
          }
        }
      }
      checkMounts(step.volumes, `${path}.steps[${stepIndex}].volumes`);
      for (const [refIndex, secretRef] of (step.secretRefs ?? []).entries()) {
        claim(secretRef, `${path}.steps[${stepIndex}].secretRefs[${refIndex}]`, false);
      }
    }
    checkMounts(job.volumes, `${path}.volumes`);
    for (const [refIndex, secretRef] of (job.secretRefs ?? []).entries()) {
      claim(secretRef, `${path}.secretRefs[${refIndex}]`, false);
    }
  }

  // A claim needs somewhere to arrive: an inline env entry names its own variable,
  // a `secretRefs` entry needs a document-level binding to name one. A binding
  // nothing claims resolves a secret no container reads (§9.3).
  const bound = new Set(view.secretBindings.map((binding) => canonicalJson(binding.secretRef)));
  const claimed = new Set(claims.map((entry) => entry.key));
  for (const entry of claims) {
    if (entry.inline || bound.has(entry.key)) continue;
    fail(
      'topology_secret_binding_missing',
      entry.path,
      'this secret has no secretBinding, so no name, target or install-time lookup says how it arrives',
    );
  }
  for (const [index, binding] of view.secretBindings.entries()) {
    if (!claimed.has(canonicalJson(binding.secretRef))) {
      note(
        'topology_secret_unused',
        `spec.secretBindings[${index}]`,
        `binding ${binding.name} resolves a secret no component or job declares`,
      );
    }
  }

  for (const [index, name] of view.startupOrder.entries()) {
    if (!known(name)) {
      fail('topology_reference_missing', `spec.startupOrder[${index}]`, `${name} is not a component or job`);
    }
  }
  // Only what has to come up belongs in the order: every component, and a job that
  // gates one via `runBefore`. A job whose steps only declare `runAfter` runs once the
  // service it calls is up (ingest), and putting it in the order would make readiness
  // wait for work that is explicitly not part of it (§9.2).
  const gatingJobs = view.jobs
    .filter((job) => job.steps.some((step) => (step.runBefore ?? []).length > 0))
    .map((job) => job.name);
  for (const name of [...componentNames, ...gatingJobs]) {
    if (!view.startupOrder.includes(name)) {
      note('topology_startup_order_incomplete', 'spec.startupOrder', `${name} is not in the startup order`);
    }
  }

  for (const volume of view.volumes) {
    if (!mountedVolumes.has(volume.name)) {
      note('topology_volume_unused', `spec.volumes.${volume.name}`, `volume ${volume.name} is declared but never mounted`);
    }
  }

  const roleCounts = new Map<string, Array<{ name: string; index: number }>>();
  for (const [index, component] of view.components.entries()) {
    const entries = roleCounts.get(component.role) ?? [];
    entries.push({ name: component.name, index });
    roleCounts.set(component.role, entries);
  }
  for (const role of SINGLETON_ROLES) {
    const holders = roleCounts.get(role) ?? [];
    if (holders.length <= 1) continue;
    for (const holder of holders.slice(1)) {
      fail(
        'topology_single_writer_invalid',
        `spec.components[${holder.index}].role`,
        `${holder.name} is a second ${role}; the v0 stores are single-writer, so one bundle holds exactly one`,
      );
    }
  }

  const runtimeApps = view.components.filter((component) => component.role === RUNTIME_APP);
  if (runtimeApps.length !== 1) {
    fail('topology_runtime_app_invalid', 'spec.components', `exactly one ${RUNTIME_APP} component is required, found ${runtimeApps.length}`);
  }
  if (!view.components.some((component) => component.role === CONTEXT_SERVICE)) {
    fail('topology_context_service_missing', 'spec.components', `a ${CONTEXT_SERVICE} component is required; context-service owns the only cross-language seam`);
  }

  // Graph facts and audit evidence must not share a volume: they have different
  // backup, retention and corruption semantics (§8.3).
  const graphMounts = new Set<string>();
  const auditMounts = new Set<string>();
  for (const component of view.components) {
    const target = component.role === 'graph-store' ? graphMounts : component.role === 'audit-store' ? auditMounts : undefined;
    for (const mount of component.volumes ?? []) target?.add(mount.name);
  }
  for (const name of graphMounts) {
    if (auditMounts.has(name)) {
      fail('topology_volume_shared', 'spec.components', `graph-store and audit-store must not share volume ${name}`);
    }
  }

  if (!view.deploymentNaming.componentNameTemplate.includes('{{deployment_id}}')) {
    fail(
      'topology_naming_invalid',
      'spec.deploymentNaming.componentNameTemplate',
      'component names must derive from the deployment id, or two deployments in one environment collide',
    );
  }
  if (
    view.isBundle &&
    view.deploymentNaming.namespaceTemplate !== undefined &&
    !view.deploymentNaming.namespaceTemplate.includes('{{deployment_id}}')
  ) {
    fail(
      'topology_naming_invalid',
      'spec.deploymentNaming.namespaceTemplate',
      'namespace names must derive from the deployment id',
    );
  }

  if (view.networks !== undefined) {
    const networkNames = new Set<string>();
    for (const [index, network] of view.networks.entries()) {
      if (networkNames.has(network.name)) {
        fail('topology_name_conflict', `spec.networks[${index}].name`, `network ${network.name} is declared twice`);
      }
      networkNames.add(network.name);
    }

    // One non-internal network is the ingress component's home and the only way out
    // of the bundle. None means nothing can be published or reach a model endpoint;
    // two means the renderer has to pick, which is a decision the topology owes it.
    const publishes = view.ingress !== undefined || exposedPorts(view.components).length > 0;
    const external = view.networks.filter((network) => !network.internal);
    if (external.length > 1) {
      fail(
        'topology_ingress_network_invalid',
        'spec.networks',
        `exactly one non-internal network is allowed, found ${external.map((network) => network.name).join(', ')}`,
      );
    } else if (publishes && external.length === 0) {
      fail(
        'topology_ingress_network_invalid',
        'spec.networks',
        'this bundle publishes a port but every network is internal, so the ingress component can be reached by nobody',
      );
    }
  }

  if (view.ingress !== undefined) {
    const target = view.components.find((component) => component.name === view.ingress?.component);
    if (target === undefined) {
      fail('topology_reference_missing', 'spec.ingress.component', `ingress targets unknown component ${view.ingress.component}`);
    } else if (target.role !== RUNTIME_APP) {
      fail('topology_exposure_invalid', 'spec.ingress.component', `ingress must target the runtime app, not a ${target.role}`);
    } else if (!(target.ports ?? []).some((port) => port.containerPort === view.ingress?.port && port.expose === true)) {
      fail('topology_exposure_invalid', 'spec.ingress.port', `ingress port ${view.ingress.port} is not an exposed port of ${target.name}`);
    }
  } else if (view.isBundle && exposedPorts(runtimeApps).length === 0) {
    fail('topology_exposure_invalid', 'spec.components', 'the runtime app exposes no port, so no ingress can reach it');
  }

  return { errors, warnings };
}
