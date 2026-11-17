import { basename } from 'node:path';

import { checkTopology, exposedPorts } from '@fde/spec';
import type { BundleTopology, Component, Diagnostic, EnvVar, Job, SecretBinding } from '@fde/spec';
import { Scalar, stringify as stringifyYaml } from 'yaml';

import type { DeploymentInstance } from './deployment.js';

/**
 * The v0 Compose renderer (`docs/runtime-adapter.md` §8.1).
 *
 * It consumes `BundleTopology` and a deployment instance and nothing else: no
 * runtime knowledge, no generator code, no environment reads. Compose is the only
 * target v0 certifies; Helm and the airgap bundle render from the same document in
 * Slice 2.6, which is why every decision here is made from the topology's own
 * fields rather than from a runtime's conventions.
 */

/** Bundle-relative path of the rendered file; the build writes it verbatim (#33). */
export const COMPOSE_PATH = 'deploy/compose.yaml';

export interface RenderedFile {
  path: string;
  content: string;
}

export type RenderComposeResult =
  | { ok: true; file: RenderedFile; warnings: Diagnostic[] }
  | { ok: false; errors: Diagnostic[] };

type Condition = 'service_started' | 'service_healthy' | 'service_completed_successfully';
type Manifest = Record<string, unknown>;

/**
 * `restart: no` unquoted is YAML 1.1 `false`, and this file has more readers than
 * Compose (an operator's `yq`, a CI schema check). The quoted policy name is the only
 * spelling every reader agrees on.
 */
const restartPolicy = (policy: 'no' | 'unless-stopped'): Scalar => {
  const scalar = new Scalar(policy);
  if (policy === 'no') scalar.type = Scalar.QUOTE_DOUBLE;
  return scalar;
};

/**
 * Which component's image a job runs in: the service it maintains, not a copy of its
 * ref — two places to bump one digest is two places to forget one.
 */
const ownerRole = (owner: Job['owner']): 'context-service' | 'runtime-app' | undefined => {
  if (owner === 'context-service') return 'context-service';
  if (owner === 'runtime') return 'runtime-app';
  return undefined;
};

/**
 * A secret reaches the process as an environment variable the install step resolves
 * (`docs/runtime-contract.md` §9.3). `${NAME:?}` is deliberate: an unset secret is a
 * deployment that must stop, not one that starts with an empty signing key.
 */
const requiredVariable = (name: string): string => `\${${name}:?}`;

const environmentOf = (env: ReadonlyArray<EnvVar> | undefined): Record<string, string> =>
  Object.fromEntries((env ?? []).map((entry) => [entry.name, entry.value ?? requiredVariable(entry.name)]));

/** The Compose secret name for a file binding: the basename of its mount path. */
const secretName = (binding: SecretBinding): string => basename(binding.name);

/** The install-time variable that carries a file secret's host path. */
const secretFileVariable = (binding: SecretBinding): string =>
  `${secretName(binding).toUpperCase().replaceAll(/[.-]/g, '_')}_FILE`;

const sameSecretRef = (
  left: { store: string; key: string; version?: string },
  right: { store: string; key: string; version?: string },
): boolean => left.store === right.store && left.key === right.key && left.version === right.version;

/** Compose memory suffixes: `m`/`g` are powers of 1024, like the topology's `Mi`/`Gi`. */
const memoryLimit = (memory: string): string => {
  const match = /^([0-9]+)(Mi|Gi)$/.exec(memory);
  if (match === null) return memory;
  return `${match[1]}${match[2] === 'Gi' ? 'g' : 'm'}`;
};

interface ResolvedSecrets {
  env: Record<string, string>;
  files: Array<{ source: string; target: string }>;
  manifest: Record<string, { file: string }>;
}

/**
 * `secretRefs` say *which* secrets an owner needs; the document's `secretBindings`
 * say how each one arrives. A binding is rendered only for an owner that asked for
 * it, so a secret cannot appear in a container that has no business holding it.
 */
function resolveSecrets(
  refs: ReadonlyArray<{ store: string; key: string; version?: string }> | undefined,
  bindings: ReadonlyArray<SecretBinding>,
): ResolvedSecrets {
  const resolved: ResolvedSecrets = { env: {}, files: [], manifest: {} };
  for (const binding of bindings) {
    if (!(refs ?? []).some((ref) => sameSecretRef(ref, binding.secretRef))) continue;
    if (binding.target === 'env') {
      resolved.env[binding.name] = requiredVariable(binding.name);
      continue;
    }
    const source = secretName(binding);
    resolved.manifest[source] = { file: `\${${secretFileVariable(binding)}:?}` };
    resolved.files.push({ source, target: binding.name });
  }
  return resolved;
}

function healthCheckOf(component: Component): Manifest {
  const check = component.healthCheck;
  if (check === undefined) throw new Error(`${component.name} has no health check`);
  const manifest: Manifest = { test: ['CMD', ...(check.command ?? [])] };
  if (check.initialDelaySeconds !== undefined) manifest['start_period'] = `${check.initialDelaySeconds}s`;
  if (check.periodSeconds !== undefined) manifest['interval'] = `${check.periodSeconds}s`;
  if (check.timeoutSeconds !== undefined) manifest['timeout'] = `${check.timeoutSeconds}s`;
  if (check.failureThreshold !== undefined) manifest['retries'] = check.failureThreshold;
  return manifest;
}

/** A v0 job is one container running one one-shot command. */
const jobCommand = (job: Job): string[] => {
  const [step] = job.steps;
  return [...(step?.command ?? []), ...(step?.args ?? [])];
};

export function renderCompose(topology: BundleTopology, instance: DeploymentInstance): RenderComposeResult {
  const errors: Diagnostic[] = [];

  // Rendering a topology the invariants reject would ship a broken bundle behind a
  // valid-looking manifest, so the renderer refuses instead of guessing.
  const report = checkTopology(topology);
  if (report.errors.length > 0) return { ok: false, errors: report.errors };

  for (const job of topology.spec.jobs) {
    if (job.steps.length !== 1) {
      errors.push({
        code: 'renderer_multistep_job',
        path: `spec.jobs.${job.name}.steps`,
        message: `${job.name} has ${job.steps.length} steps; the v0 Compose renderer runs one one-shot command per job, and a shell pipeline would hide which step failed`,
      });
    }
    if (ownerRole(job.owner) === undefined) {
      errors.push({
        code: 'renderer_job_image_missing',
        path: `spec.jobs.${job.name}.owner`,
        message: `a ${job.owner}-owned job has no component image to run in; name an owner whose service the job maintains`,
      });
    }
  }
  for (const component of topology.spec.components) {
    if (component.healthCheck !== undefined && component.healthCheck.command === undefined) {
      errors.push({
        code: 'renderer_probe_missing',
        path: `spec.components.${component.name}.healthCheck`,
        message: `${component.name} declares a health check without an exec \`command\`, so Compose cannot ask it whether it is ready`,
      });
    }
  }

  // Exactly one exposed port, and it is the ingress. Two would be a second entry
  // nobody named; none would be a bundle the customer cannot call.
  const exposed = exposedPorts(topology.spec.components);
  const ingress = topology.spec.ingress;
  if (
    exposed.length !== 1 ||
    ingress === undefined ||
    exposed[0]?.component !== ingress.component ||
    exposed[0]?.port !== ingress.port
  ) {
    errors.push({
      code: 'renderer_ingress_ambiguous',
      path: 'spec.ingress',
      message: `the bundle must expose exactly one port and route the ingress to it, found ${exposed.length === 0 ? 'none' : exposed.map((entry) => `${entry.component}:${entry.port}`).join(', ')}`,
    });
  }
  if (errors.length > 0 || ingress === undefined) return { ok: false, errors };

  const componentNamed = (name: string): Component | undefined =>
    topology.spec.components.find((component) => component.name === name);
  const componentByRole = (role: string): Component | undefined =>
    topology.spec.components.find((component) => component.role === role);
  const serviceName = (name: string): string => instance.services[name] ?? name;
  const isJob = (name: string): boolean => componentNamed(name) === undefined;
  const conditionTo = (name: string): Condition =>
    isJob(name)
      ? 'service_completed_successfully'
      : componentNamed(name)?.healthCheck === undefined
        ? 'service_started'
        : 'service_healthy';

  // `depends_on` is the startup order in Compose terms (`docs/runtime-contract.md`
  // §9.2): a component waits for what it depends on and for every job that must
  // `runBefore` it; a job waits for whatever it declares it runs after.
  const dependencies = new Map<string, Map<string, Condition>>();
  const depend = (from: string, to: string, condition: Condition): void => {
    const edges = dependencies.get(from) ?? new Map<string, Condition>();
    edges.set(to, condition);
    dependencies.set(from, edges);
  };
  for (const component of topology.spec.components) {
    for (const dependency of component.dependsOn ?? []) depend(component.name, dependency, conditionTo(dependency));
  }
  for (const job of topology.spec.jobs) {
    const [step] = job.steps;
    for (const target of step?.runBefore ?? []) depend(target, job.name, 'service_completed_successfully');
    for (const target of step?.runAfter ?? []) depend(job.name, target, conditionTo(target));
  }
  const dependenciesOf = (name: string): Manifest => {
    const edges = dependencies.get(name) ?? new Map<string, Condition>();
    return Object.fromEntries([...edges].map(([target, condition]) => [serviceName(target), { condition }]));
  };
  /** `depends_on` only when there is an edge; an empty map would be a validation error. */
  const dependsOn = (name: string): Manifest => {
    const edges = dependenciesOf(name);
    return Object.keys(edges).length === 0 ? {} : { depends_on: edges };
  };

  const externalNetworks = new Set(
    topology.spec.networks.filter((network) => !network.internal).map((network) => network.name),
  );
  const networksOf = (name: string): Manifest =>
    Object.fromEntries(
      topology.spec.networks
        .filter((network) => !externalNetworks.has(network.name) || name === ingress.component)
        .map((network) => [
          network.name,
          // The topology name is the address bundle-internal configuration already
          // uses (`http://context-service:8011`); the deployment prefix must not break it.
          { aliases: [name] },
        ]),
    );

  // Volumes and networks are keyed by their topology name and pin the deployment's name
  // in `name:` — Compose's own pattern, and it keeps the manifest readable while the
  // object on the host still belongs to exactly one deployment.
  const volumesOf = (
    mounts: ReadonlyArray<{ name: string; mountPath: string; readOnly?: boolean }> | undefined,
  ): string[] =>
    (mounts ?? []).map((mount) => `${mount.name}:${mount.mountPath}${mount.readOnly === true ? ':ro' : ''}`);

  const imageOf = (component: Component): Manifest => {
    if (component.image.image !== undefined) return { image: component.image.image };
    const build = component.image.build;
    if (build === undefined) throw new Error(`${component.name} has neither an image nor a build context`);
    return {
      build: {
        // The manifest lives one directory below the bundle root, so a build context
        // named relative to the bundle (`mastra-app`) is one level up from here.
        context: `../${build.context}`,
        dockerfile: build.dockerfile,
        ...(build.target === undefined ? {} : { target: build.target }),
      },
    };
  };

  const resourcesOf = (component: Component): Manifest =>
    component.resources === undefined
      ? {}
      : { cpus: component.resources.cpu, mem_limit: memoryLimit(component.resources.memory) };

  const secrets: Record<string, { file: string }> = {};
  const services: Manifest = {};

  for (const component of topology.spec.components) {
    const resolved = resolveSecrets(component.secretRefs, topology.spec.secretBindings);
    Object.assign(secrets, resolved.manifest);
    const environment = { ...environmentOf(component.env), ...resolved.env };
    const service: Manifest = {
      ...imageOf(component),
      ...(component.command === undefined && component.args === undefined
        ? {}
        : { command: [...(component.command ?? []), ...(component.args ?? [])] }),
      ...(component.name === ingress.component && instance.ingress !== undefined
        ? {
            ports: [
              `${instance.ingress.hostIp}:${instance.ingress.hostPort}:${instance.ingress.containerPort}`,
            ],
          }
        : {}),
      ...(Object.keys(environment).length === 0 ? {} : { environment }),
      ...(component.volumes === undefined ? {} : { volumes: volumesOf(component.volumes) }),
      ...(resolved.files.length === 0 ? {} : { secrets: resolved.files }),
      ...(component.healthCheck === undefined ? {} : { healthcheck: healthCheckOf(component) }),
      ...resourcesOf(component),
      networks: networksOf(component.name),
      // One container per service: the stores are single-writer, so a Compose replica
      // is a second writer, not capacity (`docs/runtime-contract.md` §9.4).
      restart: restartPolicy('unless-stopped'),
      ...dependsOn(component.name),
    };
    services[serviceName(component.name)] = service;
  }

  for (const job of topology.spec.jobs) {
    const [step] = job.steps;
    const role = ownerRole(job.owner);
    const owner = role === undefined ? undefined : componentByRole(role);
    if (owner === undefined) throw new Error(`job ${job.name} has no owner component to run in`);
    const resolved = resolveSecrets(
      [...(job.secretRefs ?? []), ...(step?.secretRefs ?? [])],
      topology.spec.secretBindings,
    );
    Object.assign(secrets, resolved.manifest);
    const environment = { ...environmentOf(job.env), ...resolved.env };
    const mounts = [...(job.volumes ?? []), ...(step?.volumes ?? [])];
    const service: Manifest = {
      ...imageOf(owner),
      command: jobCommand(job),
      ...(Object.keys(environment).length === 0 ? {} : { environment }),
      ...(mounts.length === 0 ? {} : { volumes: volumesOf(mounts) }),
      ...(resolved.files.length === 0 ? {} : { secrets: resolved.files }),
      networks: networksOf(job.name),
      // `no` is what makes a one-shot job finish: a job that restarts forever is a
      // migration that keeps re-running or an ingest that never completes.
      restart: restartPolicy('no'),
      ...dependsOn(job.name),
    };
    services[serviceName(job.name)] = service;
  }

  const manifest: Manifest = {
    name: instance.project,
    'x-fde-bundle': {
      solution: topology.metadata.solution,
      revision: topology.metadata.revision,
      deployment_id: instance.deploymentId,
      profile: topology.metadata.profile,
      profile_digest: topology.metadata.profileDigest,
    },
    services,
    volumes: Object.fromEntries(
      topology.spec.volumes.map((volume) => [volume.name, { name: instance.volumes[volume.name] ?? volume.name }]),
    ),
    networks: Object.fromEntries(
      topology.spec.networks.map((network) => [
        network.name,
        { name: instance.networks[network.name] ?? network.name, internal: network.internal },
      ]),
    ),
    ...(Object.keys(secrets).length === 0 ? {} : { secrets }),
  };

  return {
    ok: true,
    file: { path: COMPOSE_PATH, content: stringifyYaml(manifest, { lineWidth: 0 }) },
    warnings: report.warnings,
  };
}
