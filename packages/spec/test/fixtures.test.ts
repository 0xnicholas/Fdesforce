// Seam: the checked-in artifacts. These tests are the acceptance criteria of
// #24 — the Acme example Spec, the example RuntimeProfile and the prototype's
// `solution.lock` must all validate against `@fde/spec`, and the example lock
// must be a real digest manifest, not placeholder hashes.
import { describe, expect, it } from 'vitest';

import {
  digestFiles,
  parseIdentityProfile,
  parseModelProfile,
  parseRuntimeProfile,
  parseSolutionLock,
  parseSolutionSpec,
} from '../src/index.js';
import { paths, readSpecFiles, readText, readYaml } from './support/repo.js';

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

describe('Platform example artifacts', () => {
  it('validates the mastra-1.83-node22 RuntimeProfile', () => {
    const result = parseRuntimeProfile(readYaml(paths.exampleRuntimeProfile));

    expect(result.ok, result.ok ? '' : describeErrors(result.errors)).toBe(true);
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
