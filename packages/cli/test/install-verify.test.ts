// Seam: `fde install verify` — may this delivery be deployed? (#34, #23 user story 16)
//
// A customer installs only what the platform signed. The tests build a real bundle,
// sign it with the two pinned keys the release chain would use, and then break one
// thing at a time: the payload, the signature, the key, the Release, the license
// evidence, the catalog, the Compose file, a stray key file. Each case asserts a
// non-zero exit and the readable reason an operator reads, because "verify failed"
// with no code is a support ticket rather than a diagnosis.
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { releaseSubject, signSubject } from '../src/index.js';
import { makeSandbox, type Sandbox } from './support/sandbox.js';

const DEPLOYMENT_ID = 'dep_01ARZ3NDEKTSV4RRFFQ69G5FAV';

let sandbox: Sandbox;

const buildArgs = (sb: Sandbox, out: string, deploymentId?: string): string[] => {
  const args = [
    'build',
    '--spec',
    sb.specDir,
    '--out',
    sb.path(out),
    '--target',
    'compose',
    '--environment',
    'acme-prod',
    '--workspace',
    sb.workspace,
  ];
  return deploymentId === undefined ? args : [...args, '--deployment', deploymentId];
};

beforeAll(async () => {
  sandbox = makeSandbox();
  const built = await sandbox.run(buildArgs(sandbox, 'bundle', DEPLOYMENT_ID));
  if (built.code !== 0) throw new Error(`build failed: ${built.err}`);
  const unbound = await sandbox.run(buildArgs(sandbox, 'bundle-unbound'));
  if (unbound.code !== 0) throw new Error(`unbound build failed: ${unbound.err}`);
}, 240_000);

afterAll(() => sandbox?.cleanup());

interface Manifest {
  digest: string;
  specDigest: string;
  lockDigest: string;
  solution: { customer: string; solution: string; environment: string; deploymentId?: string };
  evidence: { buildProvenance: string; sbom: string };
  files: Record<string, string>;
  artifacts: string[];
  licenseGate: { ok: boolean; components: Array<{ name: string; version: string; license: string }> };
}

const manifestOf = (bundle = 'bundle'): Manifest => JSON.parse(sandbox.read(`${bundle}/bundle.json`)) as Manifest;

const keyPair = (): { privatePem: string; publicPem: string } => {
  const pair = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { privatePem: pair.privateKey, publicPem: pair.publicKey };
};

const bundleKey = keyPair();
const releaseKey = keyPair();

interface Delivery {
  bundle: string;
  dir: string;
  signature: string;
  publicKey: string;
  release: string;
  releaseSignature: string;
  releasePublicKey: string;
  catalog: string;
}

interface ReleaseDocument {
  apiVersion: string;
  kind: string;
  metadata: { customer: string; solution: string; version: string };
  spec: {
    status: string;
    bundleDigest: string;
    specDigest: string;
    lockDigest: string;
    approvedBy: string;
    approvedAt: string;
  };
}

const releaseFor = (manifest: Manifest, overrides: Partial<ReleaseDocument['spec']> = {}): ReleaseDocument => ({
  apiVersion: 'fde.dev/v0',
  kind: 'Release',
  metadata: { customer: manifest.solution.customer, solution: manifest.solution.solution, version: '1.0.0' },
  spec: {
    status: 'approved',
    bundleDigest: manifest.digest,
    specDigest: manifest.specDigest,
    lockDigest: manifest.lockDigest,
    approvedBy: 'fde://acme/fde-lead',
    approvedAt: '2026-11-15T09:00:00.000Z',
    ...overrides,
  },
});

/** Write the customer's pinned license catalog, copying the components the bundle carries. */
const catalogFor = (components: Array<{ name: string; version: string; license: string }>, denied: string[]): string =>
  [
    'apiVersion: fde.dev/v0',
    'kind: LicenseCatalog',
    'metadata: {name: customer-pin, version: 0.1.0}',
    'spec:',
    '  denied:',
    ...denied.map((license) => `    - ${license}`),
    '  components:',
    ...components.flatMap((component) => [
      `    "${component.name}":`,
      `      license: ${component.license}`,
      '      source: bundle',
    ]),
    '',
  ].join('\n');

const DELIVERED_DENIED = ['GPL-2.0', 'GPL-3.0', 'AGPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'SSPL-1.0', 'Elastic-2.0', 'BUSL-1.1'];

/**
 * The customer pins the catalog the build was gated on — same bytes, same digest. A
 * catalog the bundle was not gated on is a different test (`license_catalog_mismatch`).
 */
const pinnedCatalog = (): string => sandbox.read('platform/licenses.yaml');

/**
 * A complete, valid delivery: the bundle plus the four artifacts and the pinned
 * catalog a customer receives. Each test mutates one thing.
 */
function deliver(name: string, options: { bundle?: string; release?: ReleaseDocument; catalog?: string } = {}): Delivery {
  const bundle = options.bundle ?? 'bundle';
  const manifest = manifestOf(bundle);
  const dir = `delivery-${name}`;
  const release = options.release ?? releaseFor(manifest);
  const signature = signSubject({ privateKeyPem: bundleKey.privatePem, subject: manifest.digest });
  const releaseSignature = signSubject({ privateKeyPem: releaseKey.privatePem, subject: releaseSubject(release) });
  const catalog = options.catalog ?? pinnedCatalog();

  const write = (file: string, content: string): string => {
    sandbox.write(`${dir}/${file}`, content);
    return join(sandbox.root, dir, file);
  };

  return {
    bundle: sandbox.path(bundle),
    dir: sandbox.path(dir),
    signature: write('bundle.sig', `${JSON.stringify(signature, null, 2)}\n`),
    publicKey: write('bundle.pub', bundleKey.publicPem),
    release: write('release.json', `${JSON.stringify(release, null, 2)}\n`),
    releaseSignature: write('release.sig', `${JSON.stringify(releaseSignature, null, 2)}\n`),
    releasePublicKey: write('release.pub', releaseKey.publicPem),
    catalog: write('licenses.yaml', catalog),
  };
}

const verifyArgs = (delivery: Delivery): string[] => [
  'install',
  'verify',
  '--bundle',
  delivery.bundle,
  '--signature',
  delivery.signature,
  '--public-key',
  delivery.publicKey,
  '--release',
  delivery.release,
  '--release-signature',
  delivery.releaseSignature,
  '--release-public-key',
  delivery.releasePublicKey,
  '--license-catalog',
  delivery.catalog,
  '--json',
];

interface VerifyOutput {
  command: string;
  ok: boolean;
  bundle: {
    digest: string;
    customer: string;
    solution: string;
    environment: string;
    deploymentId: string;
    files: number;
    licenseComponents: Array<{ name: string; license: string }>;
  };
  release: { version: string; approvedBy: string; status: string };
  errors: Array<{ code: string; message: string; remediation?: string }>;
  warnings: unknown[];
}

async function verify(delivery: Delivery): Promise<{ code: number; out: VerifyOutput; err: string }> {
  const result = await sandbox.run(verifyArgs(delivery));
  return { code: result.code, out: JSON.parse(result.out) as VerifyOutput, err: result.err };
}

const codesOf = (output: VerifyOutput): string[] => output.errors.map((error) => error.code);

describe('fde install verify', () => {
  it('accepts a delivery the pinned keys signed and the pinned catalog allows', async () => {
    const delivery = deliver('ok');

    const result = await verify(delivery);

    expect(result.code, JSON.stringify(result.out.errors, null, 2)).toBe(0);
    const manifest = manifestOf();
    expect(result.out.command).toBe('install verify');
    expect(result.out.ok).toBe(true);
    expect(result.out.errors).toEqual([]);
    expect(result.out.bundle).toMatchObject({
      digest: manifest.digest,
      customer: 'acme',
      solution: 'claims-triage',
      environment: 'acme-prod',
      deploymentId: DEPLOYMENT_ID,
      files: manifest.artifacts.length,
    });
    expect(result.out.bundle.licenseComponents).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '@mastra/core', license: 'Apache-2.0' })]),
    );
    expect(result.out.release).toMatchObject({ version: '1.0.0', approvedBy: 'fde://acme/fde-lead', status: 'approved' });
  });

  it('reports the digest and the deployment on the success line, not just "ok"', async () => {
    const delivery = deliver('text');
    const args = verifyArgs(delivery).filter((arg) => arg !== '--json');

    const result = await sandbox.run(args);

    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(manifestOf().digest);
    expect(result.out).toContain(DEPLOYMENT_ID);
    expect(result.out).toContain('acme/claims-triage');
  });

  it('refuses a missing bundle, and a bundle with no manifest', async () => {
    const delivery = deliver('missing');
    const absent = await verify({ ...delivery, bundle: sandbox.path('nope') });
    expect(absent.code).toBe(1);
    expect(codesOf(absent.out)).toContain('bundle_missing');

    sandbox.write('empty-bundle/README', 'not a bundle\n');
    const manifestless = await verify({ ...delivery, bundle: sandbox.path('empty-bundle') });
    expect(manifestless.code).toBe(1);
    expect(codesOf(manifestless.out)).toContain('bundle_manifest_missing');
    expect(manifestless.out.errors[0]?.remediation).toContain('incomplete');
  });

  it('refuses a bundle that was built before its Deployment existed', async () => {
    const unbundled = manifestOf('bundle-unbound');
    expect(unbundled.solution.deploymentId).toBeUndefined();
    const delivery = deliver('unbound', { bundle: 'bundle-unbound' });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('bundle_unbound');
  });

  it('refuses a payload file that changed after it was addressed', async () => {
    const copy = 'bundle-modified';
    cpSync(sandbox.path('bundle'), sandbox.path(copy), { recursive: true });
    writeFileSync(join(sandbox.path(copy), 'mastra-app/src/index.ts'), 'tampered\n');
    const delivery = deliver('modified', { bundle: copy });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toEqual(['bundle_file_modified']);
    expect(result.out.errors.map((error) => error.message).join(' ')).toContain('mastra-app/src/index.ts');
  });

  it('refuses a payload file that disappeared', async () => {
    const copy = 'bundle-missing-file';
    cpSync(sandbox.path('bundle'), sandbox.path(copy), { recursive: true });
    const { rmSync } = await import('node:fs');
    rmSync(join(sandbox.path(copy), 'deploy/migration-plan.json'));
    const delivery = deliver('missing-file', { bundle: copy });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('bundle_file_missing');
    expect(result.out.errors[0]?.remediation).toContain('re-copy');
  });

  it('refuses a manifest whose address is not what its payload digests to', async () => {
    const copy = 'bundle-address';
    cpSync(sandbox.path('bundle'), sandbox.path(copy), { recursive: true });
    const path = join(sandbox.path(copy), 'bundle.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest;
    manifest.digest = `sha256:${'e'.repeat(64)}`;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    // Signed over the address the build wrote; the manifest now claims another one.
    const delivery = deliver('address');
    const result = await verify({ ...delivery, bundle: sandbox.path(copy) });

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('bundle_digest_mismatch');
    // The signature covered the address the build wrote, and this is not it.
    expect(codesOf(result.out)).toContain('bundle_signature_mismatch');
  });

  it('refuses a delivery without its build provenance, or with a manifest that is not the topology\'s', async () => {
    const { rmSync } = await import('node:fs');
    const withoutEvidence = 'bundle-no-provenance';
    cpSync(sandbox.path('bundle'), sandbox.path(withoutEvidence), { recursive: true });
    rmSync(join(sandbox.path(withoutEvidence), 'build-provenance.json'));
    const missing = await verify(deliver('no-provenance', { bundle: withoutEvidence }));
    expect(missing.code).toBe(1);
    expect(codesOf(missing.out)).toContain('evidence_missing');

    const drifted = 'bundle-profile-drift';
    cpSync(sandbox.path('bundle'), sandbox.path(drifted), { recursive: true });
    const path = join(sandbox.path(drifted), 'bundle.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest & { profile: { digest: string } };
    manifest.profile.digest = `sha256:${'f'.repeat(64)}`;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
    const profile = await verify(deliver('profile-drift', { bundle: drifted }));
    expect(profile.code).toBe(1);
    expect(codesOf(profile.out)).toContain('bundle_profile_mismatch');
  });

  it('refuses a Release document that is not a Release', async () => {
    const delivery = deliver('release-invalid');
    writeFileSync(delivery.release, `${JSON.stringify({ apiVersion: 'fde.dev/v0', kind: 'Correspondence' }, null, 2)}\n`);

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('release_invalid');
  });

  it('refuses a payload file it cannot read, instead of skipping the check', async () => {
    // A gate that fails open on a permission error is a gate an attacker with a
    // `chmod` can walk through; running as root would make this test meaningless.
    if ((process.getuid?.() ?? 1) === 0) return;

    const { chmodSync } = await import('node:fs');
    const copy = 'bundle-unreadable';
    cpSync(sandbox.path('bundle'), sandbox.path(copy), { recursive: true });
    chmodSync(join(sandbox.path(copy), 'mastra-app/src/index.ts'), 0o000);
    const delivery = deliver('unreadable', { bundle: copy });

    try {
      const result = await verify(delivery);

      expect(result.code).toBe(1);
      expect(codesOf(result.out)).toContain('bundle_file_unreadable');
      expect(result.out.errors.find((error) => error.code === 'bundle_file_unreadable')?.remediation).toContain('permissions');
    } finally {
      chmodSync(join(sandbox.path(copy), 'mastra-app/src/index.ts'), 0o644);
    }
  });

  it('refuses a file the manifest never addressed', async () => {
    const copy = 'bundle-extra';
    cpSync(sandbox.path('bundle'), sandbox.path(copy), { recursive: true });
    writeFileSync(join(sandbox.path(copy), 'deploy/unlisted.sh'), '#!/bin/sh\necho outside the payload\n');
    const delivery = deliver('extra', { bundle: copy });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('bundle_file_unlisted');
    expect(result.out.errors.map((error) => error.message).join(' ')).toContain('deploy/unlisted.sh');
  });

  it('refuses a bundle signature whose kid is not the pinned key', async () => {
    const delivery = deliver('wrong-bundle-key');
    const stranger = keyPair();
    writeFileSync(delivery.signature, JSON.stringify(signSubject({ privateKeyPem: stranger.privatePem, subject: manifestOf().digest })));

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('bundle_key_mismatch');
    expect(result.out.errors[0]?.message).toContain('pinned key');
  });

  it('refuses a signature that does not verify, and one over another digest', async () => {
    const forged = deliver('forged-signature');
    const envelope = JSON.parse(readFileSync(forged.signature, 'utf8')) as { signature: string };
    writeFileSync(forged.signature, JSON.stringify({ ...envelope, signature: Buffer.from('not a signature').toString('base64url') }));
    const forgedResult = await verify(forged);
    expect(forgedResult.code).toBe(1);
    expect(codesOf(forgedResult.out)).toContain('bundle_signature_invalid');

    const elsewhere = deliver('elsewhere-subject');
    const other = signSubject({ privateKeyPem: bundleKey.privatePem, subject: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' });
    writeFileSync(elsewhere.signature, JSON.stringify(other));
    const elsewhereResult = await verify(elsewhere);
    expect(elsewhereResult.code).toBe(1);
    expect(codesOf(elsewhereResult.out)).toContain('bundle_signature_mismatch');
  });

  it('refuses a pinned key that cannot verify anything', async () => {
    const delivery = deliver('rsa-key');
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync(delivery.publicKey, rsa.publicKey);

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('bundle_key_invalid');
    expect(result.out.errors[0]?.remediation).toContain('offline');
  });

  it('refuses the delivery when the Release does not describe this bundle', async () => {
    const manifest = manifestOf();
    const delivery = deliver('release-other-bundle', {
      release: releaseFor(manifest, { bundleDigest: `sha256:${'d'.repeat(64)}` }),
    });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('release_mismatch');
    expect(result.out.errors.map((error) => error.message).join(' ')).toContain('bundleDigest');
  });

  it('refuses a Release that is not approved', async () => {
    const manifest = manifestOf();
    const delivery = deliver('release-draft', { release: releaseFor(manifest, { status: 'draft' }) });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('release_not_approved');
  });

  it('refuses a Release signature that does not verify, and one over an edited document', async () => {
    const tampered = deliver('release-tampered');
    const envelope = JSON.parse(readFileSync(tampered.releaseSignature, 'utf8')) as { signature: string };
    writeFileSync(tampered.releaseSignature, JSON.stringify({ ...envelope, signature: 'c2lnbmF0dXJl' }));
    const tamperedResult = await verify(tampered);
    expect(tamperedResult.code).toBe(1);
    expect(codesOf(tamperedResult.out)).toContain('release_signature_invalid');

    const edited = deliver('release-edited');
    const release = JSON.parse(readFileSync(edited.release, 'utf8')) as ReleaseDocument;
    release.spec.approvedBy = 'fde://acme/someone-else';
    writeFileSync(edited.release, `${JSON.stringify(release, null, 2)}\n`);
    const editedResult = await verify(edited);
    expect(editedResult.code).toBe(1);
    expect(codesOf(editedResult.out)).toContain('release_signature_mismatch');
  });

  it('refuses a bundle whose SBOM and manifest disagree about its components', async () => {
    const copy = 'bundle-sbom-drift';
    cpSync(sandbox.path('bundle'), sandbox.path(copy), { recursive: true });
    const spdx = JSON.parse(sandbox.read(`${copy}/sbom/spdx.json`)) as { packages: Array<{ name: string }> };
    spdx.packages = spdx.packages.filter((pkg) => pkg.name !== '@mastra/core');
    writeFileSync(join(sandbox.path(copy), 'sbom/spdx.json'), `${JSON.stringify(spdx, null, 2)}\n`);
    const delivery = deliver('sbom-drift', { bundle: copy });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('license_evidence_mismatch');
  });

  it('refuses a license the customer\'s boundary denies, even though the bundle passed its own gate', async () => {
    const manifest = manifestOf();
    const strict = catalogFor(manifest.licenseGate.components, [...DELIVERED_DENIED, 'Apache-2.0']);
    const delivery = deliver('license-denied', { catalog: strict });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('license_blocked');
    expect(result.out.errors.map((error) => error.message).join(' ')).toContain('@mastra/core');
  });

  it('refuses a component the customer\'s catalog does not declare', async () => {
    const manifest = manifestOf();
    const incomplete = catalogFor(
      manifest.licenseGate.components.filter((component) => component.name !== 'context-service'),
      DELIVERED_DENIED,
    );
    const delivery = deliver('license-undeclared', { catalog: incomplete });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('license_undeclared');
  });

  it('refuses a build provenance that disagrees with the signed NOTICE about the catalog', async () => {
    // The catalog digest lives in NOTICE (payload, so signed) and in the provenance
    // (evidence, so not). Editing the evidence alone is what this refuses: the
    // boundary is anchored on the signed copy.
    const copy = 'bundle-provenance-drift';
    cpSync(sandbox.path('bundle'), sandbox.path(copy), { recursive: true });
    const path = join(sandbox.path(copy), 'build-provenance.json');
    const provenance = JSON.parse(readFileSync(path, 'utf8')) as { licenseGate: { catalogDigest: string } };
    provenance.licenseGate.catalogDigest = `sha256:${'1'.repeat(64)}`;
    writeFileSync(path, `${JSON.stringify(provenance, null, 2)}\n`);
    const delivery = deliver('provenance-drift', { bundle: copy });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toEqual(['license_evidence_mismatch']);
    expect(result.out.errors[0]?.message).toContain('NOTICE');
  });

  it('refuses a catalog that is not the one the bundle was gated on', async () => {
    const manifest = manifestOf();
    const widened = catalogFor(manifest.licenseGate.components, [...DELIVERED_DENIED, 'WTFPL']);
    const delivery = deliver('license-catalog-drift', { catalog: widened });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toEqual(['license_catalog_mismatch']);
    expect(result.out.errors[0]?.remediation).toContain('pinned');
  });

  it('refuses a bundle carrying a private key', async () => {
    const copy = 'bundle-leak';
    cpSync(sandbox.path('bundle'), sandbox.path(copy), { recursive: true });
    writeFileSync(join(sandbox.path(copy), 'mastra-app/leaked-key.pem'), bundleKey.privatePem);
    const delivery = deliver('leak', { bundle: copy });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('bundle_secret_leak');
    expect(result.out.errors.map((error) => error.message).join(' ')).not.toContain('BEGIN');
    expect(result.out.errors.find((error) => error.code === 'bundle_secret_leak')?.remediation).toContain('rotate');
  });

  it('refuses a hand-edited Compose file', async () => {
    const copy = 'bundle-compose';
    cpSync(sandbox.path('bundle'), sandbox.path(copy), { recursive: true });
    const path = join(sandbox.path(copy), 'deploy/compose.yaml');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n# edited by hand\n`);
    const delivery = deliver('compose', { bundle: copy });

    const result = await verify(delivery);

    expect(result.code).toBe(1);
    expect(codesOf(result.out)).toContain('compose_mismatch');
    expect(result.out.errors.find((error) => error.code === 'compose_mismatch')?.remediation).toContain('never hand-edited');
  });

  it('is a usage error, not a verification failure, when an input is missing', async () => {
    const delivery = deliver('usage');
    const result = await sandbox.run(['install', 'verify', '--bundle', delivery.bundle]);

    expect(result.code).toBe(2);
    expect(result.err).toContain('missing required flag --signature');
  });
});
