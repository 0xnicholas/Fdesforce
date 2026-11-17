// Seam: the two halves of a bundle, with the real artifacts.
//
// `generateTopology` emits the runtime fragment; `platform/context-service` holds the
// platform's. Neither is a deployment on its own, and the generator deliberately names
// a component it does not own (`dependsOn: [context-service]`). This is the check that
// the two actually fit: composing them yields the split topology the ticket asks for —
// one exposed app, a bundle-internal context-service, three distinct volumes, jobs in
// the documented order — and that the result renders.
//
// The composition itself is `@fde/bundle`'s (#32); this package only proves its own
// fragment is the half that fragment expects.
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { composeTopology, deploymentInstance, loadContextServiceTopology, renderCompose } from '@fde/bundle';
import { checkTopology } from '@fde/spec';

import { mastraGenerator } from '../src/index.js';
import { generateInput } from './support/fixtures.js';
import { repoRoot } from './support/repo.js';

const DEPLOYMENT_ID = 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV';

const composed = () => {
  const platform = loadContextServiceTopology({ platformRoot: join(repoRoot, 'platform') });
  if (!platform.ok) throw new Error(JSON.stringify(platform.errors, null, 2));
  const result = composeTopology({
    solution: 'claims-triage',
    revision: 1,
    runtime: mastraGenerator.generateTopology(generateInput()),
    platform: platform.topology,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
  return result;
};

describe('the generator fragment composes with the platform fragment', () => {
  it('composes without an error or a warning', () => {
    const result = composed();

    expect(checkTopology(result.topology).errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('becomes the v0 split topology: one exposed app, a bundle-internal service, three volumes', () => {
    const { topology } = composed();
    const exposed = topology.spec.components.flatMap((component) =>
      (component.ports ?? []).filter((port) => port.expose === true).map(() => component.name),
    );

    expect(exposed).toEqual(['mastra-app']);
    expect(topology.spec.ingress).toEqual({ component: 'mastra-app', port: 4111 });
    expect(topology.spec.volumes.map((volume) => volume.name).sort()).toEqual(['audit', 'graph', 'mastra-state']);
    expect(topology.spec.startupOrder).toEqual(['migrate', 'runtime-migrate', 'context-service', 'mastra-app']);
  });

  it('renders a Compose file for one deployment', () => {
    const { topology } = composed();
    const result = renderCompose(topology, deploymentInstance(topology, DEPLOYMENT_ID));

    if (!result.ok) throw new Error(JSON.stringify(result.errors, null, 2));
    expect(result.file.path).toBe('deploy/compose.yaml');
    expect(result.file.content).toContain('fde-dep-01arz3ndektsv4rrffq69g5fav-mastra-app');
    expect(result.file.content).toContain('127.0.0.1:35312:4111');
  });
});
