/**
 * `@fde/bundle` — the platform side of a bundle.
 *
 * The generator emits a `RuntimeTopology` fragment and stops there; the platform
 * owns context-service, the graph/audit volumes and the maintenance jobs. This
 * package is where the two halves become one `BundleTopology`
 * (`composeTopology`), where a deployment id becomes concrete names and a host port
 * (`deploymentInstance`), and where the v0 renderer turns that document into a
 * single-node Compose file (`renderCompose`).
 *
 * It reads `@fde/spec` types only — never generator code, and never a runtime SDK,
 * so a second generator changes nothing here (§8.1).
 */
export { composeTopology } from './compose-topology.js';
export type { ComposeTopologyInput, ComposeTopologyResult } from './compose-topology.js';

export { COMPOSE_PATH, renderCompose } from './compose.js';
export type { RenderedFile, RenderComposeResult } from './compose.js';

export { deploymentInstance } from './deployment.js';
export { CONTEXT_SERVICE_TOPOLOGY_DIR, loadContextServiceTopology } from './platform-fragment.js';
export type { LoadContextServiceTopologyResult } from './platform-fragment.js';
export type { DeploymentIngress, DeploymentInstance } from './deployment.js';
