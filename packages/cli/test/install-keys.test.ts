// Seam: `fde install keys` — the customer-side key generation (§5.4, #34).
//
// The criterion is about where a private key ends up: the app's issuer key in
// `mastra-app`, the jobs key in the maintenance container, and only the public
// halves plus their `kid` in context-service — and nowhere else, least of all in
// the Bundle. So the tests check the files, the modes, the manifest, the pair
// consistency and the bundle's own secret bindings, and they check that no key
// material reaches stdout, stderr or the JSON output.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
}, 180_000);

afterAll(() => sandbox?.cleanup());

const keysArgs = (out: string, extra: string[] = []): string[] => [
  'install',
  'keys',
  '--bundle',
  sandbox.path('bundle'),
  '--out',
  sandbox.path(out),
  ...extra,
];

interface KeysManifest {
  keysVersion: number;
  deploymentId: string;
  issuers: Array<{
    issuer: string;
    iss: string;
    alg: string;
    kid: string;
    signingKey: { secretRef: { store: string; key: string }; file: string; injectInto: string };
    publicKey: { secretRef: { store: string; key: string }; file: string; injectInto: string };
  }>;
}

const manifestOf = (out: string): KeysManifest =>
  JSON.parse(sandbox.read(`${out}/keys.json`)) as KeysManifest;

const publicPem = (path: string): string => readFileSync(path, 'utf8');

/** RFC 7638 thumbprint, computed here rather than trusted from the code under test. */
const thumbprintOf = (pem: string): string => {
  const jwk = createPublicKey(pem).export({ format: 'jwk' });
  const members = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(members).digest('base64url');
};

const derOf = (key: KeyObject): Buffer =>
  key.type === 'private' ? createPublicKey(key).export({ format: 'der', type: 'spki' }) : key.export({ format: 'der', type: 'spki' });

describe('fde install keys', () => {
  it('generates one ES256 key pair per issuer, with the public halves and the kid for context-service', async () => {
    const out = 'keys-happy';
    const result = await sandbox.run([...keysArgs(out), '--json']);

    expect(result.code, result.err).toBe(0);
    expect(sandbox.exists(`${out}/execution-context-signing-key.pem`)).toBe(true);
    expect(sandbox.exists(`${out}/execution-context-public-key.pem`)).toBe(true);
    expect(sandbox.exists(`${out}/fde-jobs-signing-key.pem`)).toBe(true);
    expect(sandbox.exists(`${out}/fde-jobs-public-key.pem`)).toBe(true);

    // A private key is readable by its owner only; the public half is a configuration
    // file. A world-readable signing key is the failure mode this asserts away.
    for (const path of ['execution-context-signing-key.pem', 'fde-jobs-signing-key.pem']) {
      expect(statSync(sandbox.path(`${out}/${path}`)).mode & 0o777, path).toBe(0o600);
    }
    for (const path of ['execution-context-public-key.pem', 'fde-jobs-public-key.pem', 'keys.json']) {
      expect(statSync(sandbox.path(`${out}/${path}`)).mode & 0o777, path).toBe(0o644);
    }

    const manifest = manifestOf(out);
    expect(manifest.keysVersion).toBe(1);
    expect(manifest.deploymentId).toBe(DEPLOYMENT_ID);
    expect(manifest.issuers.map((issuer) => issuer.issuer)).toEqual(['mastra-app', 'fde-jobs']);
    expect(manifest.issuers.map((issuer) => issuer.iss)).toEqual([
      `fde://${DEPLOYMENT_ID}`,
      `fde://${DEPLOYMENT_ID}/jobs`,
    ]);
    expect(manifest.issuers.map((issuer) => issuer.alg)).toEqual(['ES256', 'ES256']);

    // §5.4: the private half goes to the component that signs, the public half and its
    // kid to the service that verifies. Never the same destination.
    // The destinations are the bundle's: the component and job names come from the
    // composed topology's claims, and the store from the binding that resolves them.
    expect(manifest.issuers[0]?.signingKey).toEqual({
      secretRef: { store: 'customer', key: 'fde/execution-context-signing-key' },
      file: 'execution-context-signing-key.pem',
      injectInto: ['mastra-app'],
    });
    expect(manifest.issuers[0]?.publicKey).toEqual({
      secretRef: { store: 'customer', key: 'fde/execution-context-public-key' },
      file: 'execution-context-public-key.pem',
      injectInto: ['context-service'],
    });
    expect(manifest.issuers[1]?.signingKey).toEqual({
      secretRef: { store: 'customer', key: 'fde/jobs/signing-key' },
      file: 'fde-jobs-signing-key.pem',
      injectInto: ['ingest'],
    });
    expect(manifest.issuers[1]?.publicKey).toEqual({
      secretRef: { store: 'customer', key: 'fde/jobs/public-key' },
      file: 'fde-jobs-public-key.pem',
      injectInto: ['context-service'],
    });

    // Each pair is a pair, is P-256, and the kid is the public key's thumbprint —
    // context-service derives the same value, so a kid that disagreed would be a
    // token it refuses.
    for (const issuer of manifest.issuers) {
      const privateKey = createPrivateKey(sandbox.read(`${out}/${issuer.signingKey.file}`));
      const publicKey = createPublicKey(sandbox.read(`${out}/${issuer.publicKey.file}`));

      expect(privateKey.asymmetricKeyType, issuer.issuer).toBe('ec');
      expect(privateKey.asymmetricKeyDetails?.namedCurve, issuer.issuer).toBe('prime256v1');
      expect(derOf(privateKey).equals(derOf(publicKey)), issuer.issuer).toBe(true);
      expect(issuer.kid).toBe(thumbprintOf(publicPem(sandbox.path(`${out}/${issuer.publicKey.file}`))));
    }

    // Two issuers, two keys: a shared pair would let a maintenance token pass as a
    // user token.
    expect(manifest.issuers[0]?.kid).not.toBe(manifest.issuers[1]?.kid);
  });

  it('reports what it wrote without ever printing key material', async () => {
    const out = 'keys-json';
    const result = await sandbox.run([...keysArgs(out), '--json']);

    expect(result.code, result.err).toBe(0);
    const output = JSON.parse(result.out) as {
      command: string;
      ok: boolean;
      deploymentId: string;
      issuers: Array<{ issuer: string; kid: string; signingKey: string; publicKey: string }>;
      created: string[];
      errors: unknown[];
    };
    expect(output.command).toBe('install keys');
    expect(output.ok).toBe(true);
    expect(output.deploymentId).toBe(DEPLOYMENT_ID);
    expect(output.issuers.map((issuer) => issuer.issuer)).toEqual(['mastra-app', 'fde-jobs']);
    expect(output.issuers[0]?.signingKey).toBe('execution-context-signing-key.pem');
    expect(output.created).toHaveLength(5);

    // A log is one of the four places a key may not appear (§5.4). Neither is a
    // diagnostic: "the key is invalid" is a statement about a file, not a value.
    for (const stream of [result.out, result.err]) {
      expect(stream).not.toContain('BEGIN');
      expect(stream).not.toContain('PRIVATE KEY');
      expect(stream).not.toContain(createHash('sha256').update(sandbox.read(`${out}/execution-context-signing-key.pem`)).digest('hex'));
    }
  });

  it('keeps the keys it finds: a second run changes nothing', async () => {
    const out = 'keys-idempotent';
    expect((await sandbox.run(keysArgs(out))).code).toBe(0);
    const before = new Map(
      ['execution-context-signing-key.pem', 'execution-context-public-key.pem', 'fde-jobs-signing-key.pem', 'fde-jobs-public-key.pem', 'keys.json'].map(
        (path) => [path, sandbox.read(`${out}/${path}`)],
      ),
    );

    const again = await sandbox.run([...keysArgs(out), '--json']);

    expect(again.code, again.err).toBe(0);
    const output = JSON.parse(again.out) as { created: string[] };
    expect(output.created).toEqual([]);
    for (const [path, content] of before) expect(sandbox.read(`${out}/${path}`), path).toBe(content);
  });

  it('refuses to complete a half pair instead of inventing a matching half', async () => {
    const out = 'keys-incomplete';
    expect((await sandbox.run(keysArgs(out))).code).toBe(0);
    rmSync(sandbox.path(`${out}/execution-context-public-key.pem`));

    const result = await sandbox.run([...keysArgs(out), '--json']);

    expect(result.code).toBe(1);
    const output = JSON.parse(result.out) as { errors: Array<{ code: string; message: string }> };
    expect(output.errors[0]?.code).toBe('install_key_incomplete');
    expect(output.errors[0]?.message).toContain('execution-context-public-key.pem');
    // Nothing was written: a half pair stays a half pair until a human decides.
    expect(existsSync(sandbox.path(`${out}/execution-context-public-key.pem`))).toBe(false);
  });

  it('refuses a public key that is not the private key\'s other half', async () => {
    const out = 'keys-mismatch';
    expect((await sandbox.run(keysArgs(out))).code).toBe(0);
    const stranger = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync(sandbox.path(`${out}/fde-jobs-public-key.pem`), stranger.publicKey);

    const result = await sandbox.run([...keysArgs(out), '--json']);

    expect(result.code).toBe(1);
    const output = JSON.parse(result.out) as { errors: Array<{ code: string; message: string }> };
    expect(output.errors[0]?.code).toBe('install_key_mismatch');
    expect(output.errors[0]?.message).toContain('fde-jobs');
  });

  it('refuses a key on another curve: ES256 is a decision, not a detail', async () => {
    const out = 'keys-rsa';
    expect((await sandbox.run(keysArgs(out))).code).toBe(0);
    const rsa = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    writeFileSync(sandbox.path(`${out}/execution-context-signing-key.pem`), rsa.privateKey);

    const result = await sandbox.run([...keysArgs(out), '--json']);

    expect(result.code).toBe(1);
    const output = JSON.parse(result.out) as { errors: Array<{ code: string; message: string }> };
    expect(output.errors[0]?.code).toBe('install_key_invalid');
    expect(output.errors[0]?.message).toContain('ES256');
  });

  it('refuses a keys directory that belongs to another deployment', async () => {
    const out = 'keys-other-deployment';
    const unboundArgs = ['install', 'keys', '--bundle', sandbox.path('bundle-unbound'), '--out', sandbox.path(out), '--json'];
    expect((await sandbox.run([...unboundArgs, '--deployment', DEPLOYMENT_ID])).code).toBe(0);

    const result = await sandbox.run([...unboundArgs, '--deployment', `dep_${'C'.repeat(26)}`]);

    expect(result.code).toBe(1);
    const output = JSON.parse(result.out) as { errors: Array<{ code: string; message: string }> };
    expect(output.errors[0]?.code).toBe('install_key_deployment_mismatch');
    expect(output.errors[0]?.message).toContain(DEPLOYMENT_ID);
  });

  it('refuses a deployment the bundle does not name', async () => {
    // A key pair is per-Deployment, and the bundle is the record of which one. Naming
    // another deployment here would put this bundle's secret bindings behind that
    // deployment's issuer.
    const result = await sandbox.run([
      'install',
      'keys',
      '--bundle',
      sandbox.path('bundle'),
      '--out',
      sandbox.path('keys-wrong-deployment'),
      '--deployment',
      `dep_${'D'.repeat(26)}`,
      '--json',
    ]);

    expect(result.code).toBe(1);
    const output = JSON.parse(result.out) as { errors: Array<{ code: string; message: string }> };
    expect(output.errors[0]?.code).toBe('deployment_mismatch');
    expect(output.errors[0]?.message).toContain(DEPLOYMENT_ID);
  });

  it('refuses an unbound bundle: a key pair belongs to a Deployment', async () => {
    const result = await sandbox.run([
      'install',
      'keys',
      '--bundle',
      sandbox.path('bundle-unbound'),
      '--out',
      sandbox.path('keys-unbound'),
      '--json',
    ]);

    expect(result.code).toBe(1);
    const output = JSON.parse(result.out) as { errors: Array<{ code: string; message: string }> };
    expect(output.errors[0]?.code).toBe('bundle_unbound');

    // With the deployment named, the same bundle is enough: the key pairs are the
    // deployment's, and the bundle is where the secret names come from.
    const named = await sandbox.run([
      'install',
      'keys',
      '--bundle',
      sandbox.path('bundle-unbound'),
      '--out',
      sandbox.path('keys-unbound'),
      '--deployment',
      DEPLOYMENT_ID,
    ]);
    expect(named.code, named.err).toBe(0);
    expect(manifestOf('keys-unbound').deploymentId).toBe(DEPLOYMENT_ID);
  });

  it('refuses to generate a key the bundle has no secret binding for', async () => {
    // The bundle is authoritative for where a secret goes: generating a key the
    // composed topology never mounts would be a key the deployment cannot read.
    const copy = 'bundle-unbound-secrets';
    cpSync(sandbox.path('bundle'), sandbox.path(copy), { recursive: true });
    const topology = JSON.parse(sandbox.read(`${copy}/deploy/bundle-topology.json`)) as {
      spec: { secretBindings: Array<{ secretRef: { key: string } }>; components: Array<{ secretRefs?: Array<{ key: string }> }> };
    };
    topology.spec.secretBindings = topology.spec.secretBindings.filter(
      (binding) => binding.secretRef.key !== 'fde/jobs/public-key',
    );
    for (const component of topology.spec.components) {
      component.secretRefs = component.secretRefs?.filter((ref) => ref.key !== 'fde/jobs/public-key');
    }
    writeFileSync(sandbox.path(`${copy}/deploy/bundle-topology.json`), `${JSON.stringify(topology, null, 2)}\n`);

    const result = await sandbox.run([
      'install',
      'keys',
      '--bundle',
      sandbox.path(copy),
      '--out',
      sandbox.path('keys-unbound-secret'),
      '--json',
    ]);

    expect(result.code).toBe(1);
    const output = JSON.parse(result.out) as { errors: Array<{ code: string; message: string }> };
    expect(output.errors[0]?.code).toBe('install_key_unbound');
    expect(output.errors[0]?.message).toContain('fde/jobs/public-key');
    expect(existsSync(sandbox.path('keys-unbound-secret'))).toBe(false);
  });

  it('refuses an --out that is a file, not a directory', async () => {
    sandbox.write('keys-not-a-directory', 'occupied\n');

    const result = await sandbox.run([
      'install',
      'keys',
      '--bundle',
      sandbox.path('bundle'),
      '--out',
      sandbox.path('keys-not-a-directory'),
      '--json',
    ]);

    expect(result.code).toBe(1);
    const output = JSON.parse(result.out) as { errors: Array<{ code: string }> };
    expect(output.errors[0]?.code).toBe('install_key_output_invalid');
  });

  it('says what to do when the bundle is not a directory', async () => {
    const result = await sandbox.run(['install', 'keys', '--bundle', sandbox.path('nope'), '--out', sandbox.path('k'), '--json']);

    expect(result.code).toBe(1);
    const output = JSON.parse(result.out) as { errors: Array<{ code: string; remediation?: string }> };
    expect(output.errors[0]?.code).toBe('bundle_missing');
    expect(output.errors[0]?.remediation).toContain('fde build');
  });

  it('keeps the manifest read-only for the operator: the directory is created if absent', async () => {
    // `--out` need not exist: the install flow runs on a fresh host. What it must not
    // do is reuse a directory that already holds unrelated files as a keys directory.
    const result = await sandbox.run(keysArgs('fresh/nested/keys'));
    expect(result.code, result.err).toBe(0);
    expect(manifestOf('fresh/nested/keys').issuers).toHaveLength(2);
    expect(dirname(sandbox.path('fresh/nested/keys'))).toBe(sandbox.path('fresh/nested'));
  });
});
