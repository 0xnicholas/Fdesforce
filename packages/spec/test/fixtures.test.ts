// Seam: the checked-in artifacts. These tests are the acceptance criteria of
// #24 — the Acme example Spec, the example RuntimeProfile and the prototype's
// `solution.lock` must all validate against `@fde/spec`, and the example lock
// must be a real digest manifest, not placeholder hashes.
import { describe, expect, it } from 'vitest';

import {
  digestFiles,
  parseContextPackage,
  parseContextPackageRevision,
  parseContextServiceTopology,
  parseIdentityProfile,
  parseModelProfile,
  parsePermissionProfile,
  parseRuntimeProfile,
  parseSolutionLock,
  parseSolutionSpec,
  parseSemanticModel,
} from '../src/index.js';
import { exampleContextPackageFiles, paths, readSpecFiles, readText, readYaml } from './support/repo.js';

const describeErrors = (errors: ReadonlyArray<{ path?: string; message: string }>): string =>
  errors.map((error) => `${error.path ?? '<root>'}: ${error.message}`).join('\n');

const exampleLock = parseSolutionLock(readYaml(paths.exampleLock));

describe('Acme example Spec (Slice 1 read-only)', () => {
  it('validates against the Solution Spec schema', () => {
    const result = parseSolutionSpec(readYaml(paths.exampleSpec));

    expect(result.ok, result.ok ? '' : describeErrors(result.errors)).toBe(true);
  });

  it('pins only exact versions and digests in its lock', () => {
    expect(exampleLock.ok, exampleLock.ok ? '' : describeErrors(exampleLock.errors)).toBe(true);
  });

  it('has a lock whose file manifest still matches the files on disk', () => {
    if (!exampleLock.ok) throw new Error(describeErrors(exampleLock.errors));

    const files = readSpecFiles(paths.exampleSpecDir, Object.keys(exampleLock.value.spec.files));
    expect(digestFiles(Object.entries(files).map(([path, content]) => ({ path, content })))).toEqual({
      digest: exampleLock.value.spec.digest,
      files: exampleLock.value.spec.files,
    });
  });

  it('has asset digests that match the checked-in customer assets', () => {
    if (!exampleLock.ok) throw new Error(describeErrors(exampleLock.errors));
    const assets = exampleLock.value.assets;
    if (!assets) throw new Error('example lock declares no assets');

    expect(digestFiles([{ path: 'claims-db.yaml', content: readText(paths.exampleConnector) }]).files).toEqual(
      assets.connectors?.['claims-db']?.files
        ? { 'claims-db.yaml': assets.connectors['claims-db'].files['claims-db.yaml'] }
        : {},
    );
    // The eval suite digest is the file digest, so the same artifact cannot be
    // pinned twice with two different values.
    expect(assets.evalSuites?.['claims-triage-quality']?.digest).toBe(
      digestFiles([{ path: 'eval-suite.yaml', content: readText(paths.exampleEvalSuite) }]).files['eval-suite.yaml'],
    );
  });

  it('has a lock that matches the checked-in context package and model profiles', () => {
    if (!exampleLock.ok) throw new Error(describeErrors(exampleLock.errors));

    expect(exampleLock.value.modelProfiles?.['standard']).toBe(
      `1.2.0@${digestFiles([{ path: 'standard.yaml', content: readText(paths.exampleModelProfile) }]).files['standard.yaml']}`,
    );
    expect(exampleLock.value.modelProfiles?.['standard-fallback']).toBe(
      `1.0.0@${digestFiles([{ path: 'standard-fallback.yaml', content: readText(paths.exampleFallbackProfile) }]).files['standard-fallback.yaml']}`,
    );
  });
});

describe('Acme Customer Context Package', () => {
  it('declares a frozen revision whose digest is the package content digest', () => {
    const manifest = parseContextPackage(readYaml(`${paths.exampleContextPackage}/manifest.yaml`));
    expect(manifest.ok, manifest.ok ? '' : describeErrors(manifest.errors)).toBe(true);
    if (!manifest.ok) return;

    const revision = parseContextPackageRevision(readYaml(`${paths.exampleContextPackage}/revisions/1.0.0.yaml`));
    expect(revision.ok, revision.ok ? '' : describeErrors(revision.errors)).toBe(true);
    if (!revision.ok) return;

    // `revisions/**` records the freeze; everything else is the content it addresses.
    const files = exampleContextPackageFiles().filter((path) => !path.startsWith('revisions/'));
    const recomputed = digestFiles(files.map((path) => ({ path, content: readText(`${paths.exampleContextPackage}/${path}`) })));
    expect(revision.value.spec.digest).toBe(recomputed.digest);
    expect(revision.value.spec.files).toEqual(recomputed.files);
    expect(revision.value.metadata.version).toBe(manifest.value.metadata.version);
  });

  it('binds a Semantic Model to a permission baseline with the fail-closed default', () => {
    const model = parseSemanticModel(readYaml(`${paths.exampleContextPackage}/semantic-model.yaml`));
    expect(model.ok, model.ok ? '' : describeErrors(model.errors)).toBe(true);

    const permissions = parsePermissionProfile(readYaml(`${paths.exampleContextPackage}/permissions.yaml`));
    expect(permissions.ok, permissions.ok ? '' : describeErrors(permissions.errors)).toBe(true);
    if (permissions.ok) expect(permissions.value.spec.defaults.unknownClassification).toBe('restricted');
  });

  it('is pinned in solution.lock at the revision digest, not at the directory digest', () => {
    if (!exampleLock.ok) throw new Error(describeErrors(exampleLock.errors));
    const revision = parseContextPackageRevision(readYaml(`${paths.exampleContextPackage}/revisions/1.0.0.yaml`));
    if (!revision.ok) throw new Error(describeErrors(revision.errors));

    expect(exampleLock.value.assets?.customerContextPackage?.['acme-claims-context']).toBe(
      `${revision.value.metadata.version}@${revision.value.spec.digest}`,
    );
  });
});

describe('Platform example artifacts', () => {
  it('validates the mastra-1.83-node22 RuntimeProfile', () => {
    const result = parseRuntimeProfile(readYaml(paths.exampleRuntimeProfile));

    expect(result.ok, result.ok ? '' : describeErrors(result.errors)).toBe(true);
  });

  it('validates the context-service ContextServiceTopology fragment', () => {
    const result = parseContextServiceTopology(readYaml(paths.exampleContextServiceTopology));

    expect(result.ok, result.ok ? '' : describeErrors(result.errors)).toBe(true);
  });

  it('declares the platform volumes, graph and audit separate and both backed up', () => {
    const result = parseContextServiceTopology(readYaml(paths.exampleContextServiceTopology));
    if (!result.ok) throw new Error(describeErrors(result.errors));

    // The runtime's `mastra-state` is the generator's; these two are the platform's.
    // Sharing one would give graph facts and audit evidence the same backup and
    // retention semantics, and §9.5 backs up each separately.
    expect(result.value.spec.volumes.map((volume) => volume.name).sort()).toEqual(['audit', 'graph']);
    expect(result.value.spec.volumes.every((volume) => volume.backup === true)).toBe(true);
  });

  it('validates the chat model profile and its fallback', () => {
    for (const path of [paths.exampleModelProfile, paths.exampleFallbackProfile]) {
      const result = parseModelProfile(readYaml(path));
      expect(result.ok, result.ok ? '' : `${path}\n${describeErrors(result.errors)}`).toBe(true);
    }
  });
});

describe('Environment identity source', () => {
  it('validates the Acme acme-prod static IdentityProfile', () => {
    const result = parseIdentityProfile(readYaml(paths.exampleIdentityProfile));

    expect(result.ok, result.ok ? '' : describeErrors(result.errors)).toBe(true);
  });
});

describe('Prototype artifacts (schema conformance only)', () => {
  it('validates the prototype Solution Spec, including the approval grammar', () => {
    const result = parseSolutionSpec(readYaml(paths.prototypeSpec));

    expect(result.ok, result.ok ? '' : describeErrors(result.errors)).toBe(true);
  });

  it('validates the prototype solution.lock', () => {
    const result = parseSolutionLock(readYaml(paths.prototypeLock));

    expect(result.ok, result.ok ? '' : describeErrors(result.errors)).toBe(true);
  });

  it('validates the prototype model profiles', () => {
    for (const path of [paths.prototypeModelProfile, paths.prototypeFallbackProfile]) {
      const result = parseModelProfile(readYaml(path));
      expect(result.ok, result.ok ? '' : `${path}\n${describeErrors(result.errors)}`).toBe(true);
    }
  });
});
