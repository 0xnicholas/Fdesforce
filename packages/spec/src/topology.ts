import type { Diagnostic } from './parse.js';
import type { BundleTopology, RuntimeTopology, Topology } from './schema/bundle-topology.js';

/**
 * Topology invariants (`docs/runtime-adapter.md` §8.3).
 *
 * These are the Compose/Helm renderer's assumptions expressed once, before any
 * renderer exists: reference integrity, one exposed runtime app, no shared
 * graph/audit volume, startup order, deployment naming. The renderers (#32)
 * consume `BundleTopology` and may rely on all of it.
 */

export interface TopologyReport {
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

interface TopologyView {
  components: Topology['spec']['components'];
  volumes: Topology['spec']['volumes'];
  jobs: Topology['spec']['jobs'];
  startupOrder: string[];
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
    deploymentNaming: spec.deploymentNaming,
    isBundle: topology.kind === 'BundleTopology',
  };
  const ingress = (spec as BundleTopology['spec']).ingress;
  if (ingress !== undefined) view.ingress = { component: ingress.component, port: ingress.port };
  return view;
};

const RUNTIME_APP = 'runtime-app';
const CONTEXT_SERVICE = 'context-service';

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

  const volumeNames = new Set(view.volumes.map((volume) => volume.name));
  const mountedVolumes = new Set<string>();
  const checkMounts = (mounts: ReadonlyArray<{ name: string }> | undefined, path: string): void => {
    for (const [index, mount] of (mounts ?? []).entries()) {
      mountedVolumes.add(mount.name);
      if (!volumeNames.has(mount.name)) {
        fail('topology_reference_missing', `${path}[${index}].name`, `volume ${mount.name} is mounted but not declared`);
      }
    }
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
    for (const [portIndex, port] of ports.entries()) {
      if (containerPorts.has(port.containerPort)) {
        fail('topology_port_conflict', `${path}.ports[${portIndex}].containerPort`, `container port ${port.containerPort} is declared twice on ${component.name}`);
      }
      containerPorts.add(port.containerPort);
      if (port.expose === true && component.role !== RUNTIME_APP) {
        fail(
          'topology_exposure_invalid',
          `${path}.ports[${portIndex}].expose`,
          `${component.name} is a ${component.role}; only the runtime app may be exposed to the customer ingress`,
        );
      }
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
    }
    checkMounts(job.volumes, `${path}.volumes`);
  }

  for (const [index, name] of view.startupOrder.entries()) {
    if (!known(name)) {
      fail('topology_reference_missing', `spec.startupOrder[${index}]`, `${name} is not a component or job`);
    }
  }
  for (const name of [...componentNames, ...jobNames]) {
    if (!view.startupOrder.includes(name)) {
      note('topology_startup_order_incomplete', 'spec.startupOrder', `${name} is not in the startup order`);
    }
  }

  for (const volume of view.volumes) {
    if (!mountedVolumes.has(volume.name)) {
      note('topology_volume_unused', `spec.volumes.${volume.name}`, `volume ${volume.name} is declared but never mounted`);
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

  if (view.ingress !== undefined) {
    const target = view.components.find((component) => component.name === view.ingress?.component);
    if (target === undefined) {
      fail('topology_reference_missing', 'spec.ingress.component', `ingress targets unknown component ${view.ingress.component}`);
    } else if (target.role !== RUNTIME_APP) {
      fail('topology_exposure_invalid', 'spec.ingress.component', `ingress must target the runtime app, not a ${target.role}`);
    } else if (!(target.ports ?? []).some((port) => port.containerPort === view.ingress?.port && port.expose === true)) {
      fail('topology_exposure_invalid', 'spec.ingress.port', `ingress port ${view.ingress.port} is not an exposed port of ${target.name}`);
    }
  } else if (view.isBundle && runtimeApps.length === 1) {
    const exposed = (runtimeApps[0]?.ports ?? []).filter((port) => port.expose === true);
    if (exposed.length === 0) {
      fail('topology_exposure_invalid', 'spec.components', 'the runtime app exposes no port, so no ingress can reach it');
    }
  }

  return { errors, warnings };
}
