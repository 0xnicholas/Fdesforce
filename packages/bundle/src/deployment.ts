import { createHash } from 'node:crypto';

import { DeploymentIdSchema, NameSchema } from '@fde/spec';
import type { BundleTopology } from '@fde/spec';

/**
 * The deployment instance (`docs/runtime-adapter.md` §8.3).
 *
 * A `BundleTopology` is deployment-agnostic: it names templates, not things. Every
 * concrete name — services, volumes, networks — and the one host port that is
 * published are derived from the `deployment_id` here, deterministically, so that
 * two deployments of the same bundle on one host cannot collide and the same id
 * always renders the same manifest.
 *
 * Pure: no clock, no environment, no disk. The renderer takes an instance as input
 * rather than deriving it, so a caller can print the names before rendering and get
 * the same answer the manifest contains.
 */

/** The published host port range. Above the container ports, below the ephemeral allocation. */
const HOST_PORT_BASE = 30000;
const HOST_PORT_RANGE = 20000;

export interface DeploymentIngress {
  /** The composed service name that publishes the port. */
  service: string;
  /** The topology names of the exposed component and its container port. */
  component: string;
  containerPort: number;
  hostIp: string;
  hostPort: number;
}

export interface DeploymentInstance {
  deploymentId: string;
  /** Compose project / Helm namespace: one per deployment. */
  project: string;
  /** Topology name → the name the deployment actually uses, for components and jobs. */
  services: Record<string, string>;
  /** Topology name → the deployment's volume name. */
  volumes: Record<string, string>;
  /** Topology name → the deployment's network name. */
  networks: Record<string, string>;
  ingress?: DeploymentIngress;
}

const fail = (message: string): never => {
  throw new Error(message);
};

/**
 * `dep_<ULID>` is uppercase and underscore-separated; a Docker/Compose/Helm name is
 * lowercase and hyphen-separated. The mapping is injective (`_` is only in the
 * `dep_` prefix, and ULIDs are Crockford base32), so two ids never derive one name.
 */
function deploymentSlug(deploymentId: string): string {
  if (!DeploymentIdSchema.safeParse(deploymentId).success) {
    return fail(`deployment id ${JSON.stringify(deploymentId)} is not dep_<ULID>; the id is the deployment's identity`);
  }
  return deploymentId.toLowerCase().replaceAll('_', '-');
}

type NamingTemplate = 'componentNameTemplate' | 'namespaceTemplate';

interface NameRequest {
  template: string;
  /** Which `deploymentNaming` field it is, for the remediation. */
  templateField: NamingTemplate;
  slug: string;
  /** The `{{component}}` substitution: a component, job, volume or network name. */
  object?: string;
  /** What is being named, for the diagnostic. */
  label: string;
}

function derivedName({ template, templateField, slug, object, label }: NameRequest): string {
  const name = template
    .replaceAll('{{deployment_id}}', slug)
    .replaceAll('{{component}}', object ?? '');
  if (name.length > 63) {
    return fail(
      `${label} name ${name} is too long for a container runtime (63 characters); deploymentNaming.${templateField} must be shorter, or the object renamed`,
    );
  }
  if (!NameSchema.safeParse(name).success) {
    return fail(
      `${label} name ${name} is not a lowercase hyphen-separated DNS label; fix deploymentNaming.${templateField}`,
    );
  }
  return name;
}

/**
 * The published port, derived from the id rather than chosen.
 *
 * Hash-derived on purpose: a fixed host port makes two bundles on one customer host
 * contend for 4111, and a port the operator picks by hand is a value the bundle
 * cannot reproduce. A collision in a 20 000-port window is a deploy-time `bind`
 * failure the runbook covers, not a silently wrong manifest.
 */
function ingressHostPort(deploymentId: string): number {
  const digest = createHash('sha256').update(deploymentId, 'utf8').digest();
  return HOST_PORT_BASE + (digest.readUInt32BE(0) % HOST_PORT_RANGE);
}

export function deploymentInstance(topology: BundleTopology, deploymentId: string): DeploymentInstance {
  const slug = deploymentSlug(deploymentId);
  const { componentNameTemplate, namespaceTemplate } = topology.spec.deploymentNaming;
  if (namespaceTemplate === undefined) {
    // The project name is the deployment's, not the renderer's: falling back to a
    // template invented here would make this module a second owner of the naming rule.
    return fail('deploymentNaming.namespaceTemplate is required to name a deployment; set it on the runtime fragment');
  }
  const name = (object: string, label: string): string =>
    derivedName({ template: componentNameTemplate, templateField: 'componentNameTemplate', slug, object, label });

  // One naming rule for every deployment object. v0 has one template for components;
  // volumes and networks are named with it too, so an operator looking at a volume
  // name can find the deployment that owns it.
  const services: Record<string, string> = {};
  for (const component of topology.spec.components) services[component.name] = name(component.name, 'component');
  for (const job of topology.spec.jobs) services[job.name] = name(job.name, 'job');

  const volumes: Record<string, string> = {};
  for (const volume of topology.spec.volumes) volumes[volume.name] = name(volume.name, 'volume');

  const networks: Record<string, string> = {};
  for (const network of topology.spec.networks) networks[network.name] = name(network.name, 'network');

  const project = derivedName({ template: namespaceTemplate, templateField: 'namespaceTemplate', slug, label: 'project' });

  const instance: DeploymentInstance = { deploymentId, project, services, volumes, networks };
  const ingress = topology.spec.ingress;
  if (ingress !== undefined) {
    instance.ingress = {
      service: services[ingress.component] ?? name(ingress.component, 'component'),
      component: ingress.component,
      containerPort: ingress.port,
      hostIp: '127.0.0.1',
      hostPort: ingressHostPort(deploymentId),
    };
  }
  return instance;
}
