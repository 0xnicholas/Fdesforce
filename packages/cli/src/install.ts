import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, checkTopology, digestFiles, isDigest, parseBundleTopology, sha256 } from '@fde/spec';
import type { BundleTopology, Digest, SecretBinding } from '@fde/spec';
import { deploymentInstance, renderCompose } from '@fde/bundle';

import type { BundleManifest } from './build.js';
import { asRecord, asString, isDirectory, isFile, walkFiles } from './fsutil.js';
import { thumbprint } from './ingest.js';
import { checkLicenseGate, readLicenseCatalog, type ResolvedComponent } from './license.js';
import { diagnostic, type Diagnostic } from './types.js';

/**
 * `fde install *` — the customer side of a delivery (#34).
 *
 * Two questions are answered before a single container starts:
 *
 * 1. **may this bundle be deployed?** — `fde install verify` re-derives every claim
 *    the delivery makes: the payload is the content its address names, the pinned
 *    keys signed the bundle and its Release, the Compose file is the render of the
 *    bundled topology, the license boundary holds against the catalog the customer
 *    pinned, and no secret value travelled inside the artifact. Any disagreement is
 *    a non-zero exit with a reason, never a warning.
 * 2. **can this deployment sign?** — `fde install keys` generates the two ES256
 *    issuer key pairs when they are missing, puts the private halves where only
 *    their component can read them and the public halves plus `kid` where
 *    context-service verifies (§5.4). It never regenerates a key it found, and it
 *    never prints one.
 *
 * `secretRef` is the whole configuration story: the bundle names a secret, the
 * customer's store holds it, and the installer decides which mounted file or
 * environment variable that name resolves to (§9.3). Neither command writes a
 * secret into a bundle, a Spec, a log or an audit record.
 */

// ---------------------------------------------------------------------------
// The signature envelope
// ---------------------------------------------------------------------------

/**
 * A detached ES256 signature over one canonical subject string.
 *
 * The shape is deliberately small. The **Bundle** signature's subject is the
 * bundle's address (`bundle.json.digest`); the **Release** signature's subject is
 * the digest of the canonical Release document, so the release's own `bundleDigest`
 * is covered by the signature that approves it. The release chain (CI KMS for the
 * Bundle, the FDE release-manager key for the Release) produces this envelope; this
 * module is the other half of the format, which is what stops the two halves
 * drifting.
 */
export interface SignatureEnvelope {
  signatureVersion: 1;
  alg: 'ES256';
  /** RFC 7638 thumbprint of the signing key: the id the customer pinned. */
  kid: string;
  /** What the signature covers, as a canonical string. */
  subject: string;
  /** base64url ES256 signature over the UTF-8 bytes of `subject`. */
  signature: string;
}

/** Sign one subject. Exported so the release chain and the tests mint what verify reads. */
export function signSubject(input: { privateKeyPem: string; subject: string }): SignatureEnvelope {
  const key = createPrivateKey({ key: input.privateKeyPem, format: 'pem' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('the signing key is not an ES256 (EC P-256) key');
  }
  const signature = sign('sha256', Buffer.from(input.subject, 'utf8'), { key, dsaEncoding: 'ieee-p1363' });
  return {
    signatureVersion: 1,
    alg: 'ES256',
    kid: thumbprint(key),
    subject: input.subject,
    signature: signature.toString('base64url'),
  };
}

/** The Release document's signature subject: its canonical digest, not a re-encoding. */
export function releaseSubject(release: unknown): Digest {
  return sha256(canonicalJson(release));
}

// ---------------------------------------------------------------------------
// Reading the delivery
// ---------------------------------------------------------------------------

/**
 * The `bundle.json` facts the installer reads: a projection of the writer's type
 * (`BundleManifest` in `build.ts`), not a second definition of the document. A field
 * renamed in the writer stops compiling here, and the interop test reads a real
 * build's `bundle.json` through this projection.
 */
export type BundleManifestFacts = Pick<
  BundleManifest,
  | 'bundleVersion'
  | 'solution'
  | 'specDigest'
  | 'lockDigest'
  | 'profile'
  | 'digest'
  | 'files'
  | 'artifacts'
  | 'evidence'
  | 'licenseGate'
>;

export interface ReleaseDocument {
  apiVersion: 'fde.dev/v0';
  kind: 'Release';
  metadata: { customer: string; solution: string; version: string };
  spec: {
    status: string;
    bundleDigest: Digest;
    specDigest: Digest;
    lockDigest: Digest;
    approvedBy: string;
    approvedAt: string;
  };
}

const ONE_BUNDLE_VERSION = 1;

function readJson(path: string, code: string, label: string): { value?: Record<string, unknown>; errors: Diagnostic[] } {
  if (!isFile(path)) {
    return {
      errors: [
        diagnostic(code, `${label} is missing`, {
          path,
          remediation: 'the delivery is incomplete: re-copy the artifact before installing it',
        }),
      ],
    };
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const record = asRecord(parsed);
    if (Object.keys(record).length === 0) throw new Error('not a JSON object');
    return { value: record, errors: [] };
  } catch (cause) {
    return {
      errors: [diagnostic(code, `${label} is not readable JSON: ${(cause as Error).message}`, { path })],
    };
  }
}

function digestsOf(value: unknown): Record<string, Digest> | undefined {
  const record = asRecord(value);
  const entries = Object.entries(record);
  if (entries.length === 0 || !entries.every(([, digest]) => isDigest(digest))) return undefined;
  return Object.fromEntries(entries) as Record<string, Digest>;
}

/** `bundle.json`, checked for the fields the installer relies on. */
function readBundleManifest(bundleDir: string): { manifest?: BundleManifestFacts; errors: Diagnostic[] } {
  const path = join(bundleDir, 'bundle.json');
  if (!isFile(path)) {
    return {
      errors: [
        diagnostic('bundle_manifest_missing', `${bundleDir} holds no bundle.json`, {
          path,
          remediation: 'the delivery is incomplete: verify the bundle archive before installing it',
        }),
      ],
    };
  }

  const read = readJson(path, 'bundle_manifest_invalid', 'bundle.json');
  if (read.value === undefined) return { errors: read.errors };
  const document = read.value;
  const errors: Diagnostic[] = [];
  const bad = (message: string): void => {
    errors.push(diagnostic('bundle_manifest_invalid', `bundle.json ${message}`, { path }));
  };

  const solution = asRecord(document['solution']);
  const evidence = asRecord(document['evidence']);
  const licenseGate = asRecord(document['licenseGate']);
  const profile = asRecord(document['profile']);
  const files = digestsOf(document['files']);
  const artifacts = Array.isArray(document['artifacts']) ? document['artifacts'] : undefined;
  const components = Array.isArray(licenseGate['components']) ? licenseGate['components'] : undefined;
  const customer = asString(solution['customer']);
  const solutionName = asString(solution['solution']);
  const environment = asString(solution['environment']);

  if (document['bundleVersion'] !== ONE_BUNDLE_VERSION) bad(`must declare bundleVersion ${ONE_BUNDLE_VERSION}`);
  if (!isDigest(document['digest'])) bad('declares no usable digest');
  if (!isDigest(document['specDigest'])) bad('declares no usable specDigest');
  if (!isDigest(document['lockDigest'])) bad('declares no usable lockDigest');
  if (customer === undefined) bad('names no solution.customer');
  if (solutionName === undefined) bad('names no solution.solution');
  if (environment === undefined) bad('names no solution.environment');
  if (files === undefined) bad('declares no usable file manifest');
  if (artifacts === undefined || artifacts.some((entry) => typeof entry !== 'string')) bad('declares no usable artifact list');
  if (components === undefined) bad('declares no license components');
  if (asString(evidence['buildProvenance']) === undefined) bad('names no build provenance');
  if (asString(evidence['sbom']) === undefined) bad('names no SBOM');
  if (asString(profile['ref']) === undefined || !isDigest(profile['digest'])) bad('names no Runtime Profile pin');

  if (
    errors.length > 0 ||
    customer === undefined ||
    solutionName === undefined ||
    environment === undefined ||
    files === undefined ||
    artifacts === undefined ||
    components === undefined
  ) {
    return { errors };
  }

  const deploymentId = asString(solution['deploymentId']);
  return {
    manifest: {
      bundleVersion: ONE_BUNDLE_VERSION,
      solution: {
        customer,
        solution: solutionName,
        environment,
        ...(deploymentId === undefined ? {} : { deploymentId }),
        deploymentBound: deploymentId !== undefined,
      },
      specDigest: document['specDigest'] as Digest,
      lockDigest: document['lockDigest'] as Digest,
      profile: { ref: profile['ref'] as string, digest: profile['digest'] as Digest },
      digest: document['digest'] as Digest,
      files,
      artifacts: artifacts as string[],
      evidence: {
        buildProvenance: evidence['buildProvenance'] as string,
        sbom: evidence['sbom'] as string,
      },
      licenseGate: {
        ok: licenseGate['ok'] === true,
        components: (components as unknown[]).map((component) => ({
          name: asString(asRecord(component)['name']) ?? '',
          version: asString(asRecord(component)['version']) ?? '',
          license: asString(asRecord(component)['license']) ?? '',
        })),
      },
    },
    errors: [],
  };
}

export interface LoadedBundle {
  dir: string;
  manifest: BundleManifestFacts;
  topology: BundleTopology;
  deploymentId: string;
}

/**
 * The bundle as the installer needs it: the manifest, the composed topology and the
 * deployment it belongs to. `deploymentOverride` exists for `install keys` on a
 * bundle that was built before its Deployment did — the keys are the deployment's,
 * so the installer can be told one rather than inventing it.
 */
function loadBundle(bundleDir: string, deploymentOverride?: string): { bundle?: LoadedBundle; errors: Diagnostic[] } {
  if (!isDirectory(bundleDir)) {
    return {
      errors: [
        diagnostic('bundle_missing', `${bundleDir} is not a directory`, {
          path: bundleDir,
          remediation: 'pass --bundle with the directory `fde build` wrote',
        }),
      ],
    };
  }

  const manifestRead = readBundleManifest(bundleDir);
  if (manifestRead.manifest === undefined) return { errors: manifestRead.errors };
  const manifest = manifestRead.manifest;

  const topologyPath = join(bundleDir, 'deploy/bundle-topology.json');
  if (!isFile(topologyPath)) {
    return {
      errors: [
        diagnostic('bundle_topology_missing', 'deploy/bundle-topology.json is missing', {
          path: topologyPath,
          remediation: 'the delivery is incomplete: verify the bundle archive before installing it',
        }),
      ],
    };
  }
  const topologyRead = readJson(topologyPath, 'bundle_topology_invalid', 'deploy/bundle-topology.json');
  if (topologyRead.value === undefined) return { errors: topologyRead.errors };
  const parsed = parseBundleTopology(topologyRead.value);
  if (!parsed.ok) {
    return { errors: parsed.errors.map((error) => ({ ...error, code: 'bundle_topology_invalid' })) };
  }

  const recorded = manifest.solution.deploymentId;
  if (recorded !== undefined && deploymentOverride !== undefined && recorded !== deploymentOverride) {
    return {
      errors: [
        diagnostic('deployment_mismatch', `the bundle is bound to ${recorded}, and --deployment names ${deploymentOverride}`, {
          path: 'bundle.json#solution.deploymentId',
          remediation: 'install the bundle this Deployment was built for; --deployment only fills in a bundle that names none',
        }),
      ],
    };
  }

  const deploymentId = deploymentOverride ?? recorded;
  if (deploymentId === undefined) {
    return {
      errors: [
        diagnostic('bundle_unbound', 'the bundle was built before its Deployment existed, so it names no deployment', {
          path: 'bundle.json#solution.deploymentId',
          remediation:
            "rebuild with `fde build --deployment dep_<ULID>` (the Compose names and every signing key are the deployment's), or pass --deployment",
        }),
      ],
    };
  }

  return { bundle: { dir: bundleDir, manifest, topology: parsed.value, deploymentId }, errors: [] };
}

// ---------------------------------------------------------------------------
// fde install keys
// ---------------------------------------------------------------------------

/**
 * The two issuers a deployment signs under (§5.4). One key pair each, never shared.
 *
 * The issuer names and the file prefixes are this command's; the *secret* — its
 * store, its key and the components that claim it — comes from the composed
 * topology, which is the only place that knows how the bundle delivers it.
 */
const ISSUERS = [
  {
    issuer: 'mastra-app',
    suffix: '',
    prefix: 'execution-context',
    signingKey: 'fde/execution-context-signing-key',
    publicKey: 'fde/execution-context-public-key',
  },
  {
    issuer: 'fde-jobs',
    suffix: '/jobs',
    prefix: 'fde-jobs',
    signingKey: 'fde/jobs/signing-key',
    publicKey: 'fde/jobs/public-key',
  },
] as const;

const INSTALL_PRIVATE_KEY_MODE = 0o600;
const INSTALL_PUBLIC_FILE_MODE = 0o644;

export interface InstallKeysManifest {
  keysVersion: 1;
  deploymentId: string;
  issuers: Array<{
    issuer: string;
    iss: string;
    alg: 'ES256';
    kid: string;
    /** Where the private half goes, and under which secret store entry. */
    signingKey: { secretRef: SecretBinding['secretRef']; file: string; injectInto: string[] };
    /** Where the public half and its `kid` go: context-service verifies, it never signs. */
    publicKey: { secretRef: SecretBinding['secretRef']; file: string; injectInto: string[] };
  }>;
}

export interface InstallKeysResult {
  created: string[];
  manifest?: InstallKeysManifest;
  errors: Diagnostic[];
}

/**
 * How the composed bundle delivers one secret: the binding that resolves it, and the
 * components or jobs that claim it. The bundle is authoritative — a key the topology
 * never mounts is a key the deployment cannot read, and an `injectInto` this command
 * invented would be a claim about a container it does not own.
 */
interface DeliveredSecret {
  binding: SecretBinding;
  injectInto: string[];
}

function deliveredSecrets(topology: BundleTopology): Map<string, DeliveredSecret> {
  const delivered = new Map<string, DeliveredSecret>();
  const claimants = new Map<string, Set<string>>();
  const claim = (ref: { store: string; key: string; version?: string }, owner: string): void => {
    const existing = claimants.get(ref.key) ?? new Set<string>();
    existing.add(owner);
    claimants.set(ref.key, existing);
  };

  for (const component of topology.spec.components) {
    for (const ref of component.secretRefs ?? []) claim(ref, component.name);
    for (const env of component.env ?? []) if (env.secretRef !== undefined) claim(env.secretRef, component.name);
  }
  for (const job of topology.spec.jobs) {
    for (const ref of job.secretRefs ?? []) claim(ref, job.name);
    for (const step of job.steps) for (const ref of step.secretRefs ?? []) claim(ref, job.name);
  }

  for (const binding of topology.spec.secretBindings) {
    delivered.set(binding.secretRef.key, {
      binding,
      injectInto: [...(claimants.get(binding.secretRef.key) ?? new Set<string>())].sort(),
    });
  }
  return delivered;
}

type ReadKey = { ok: true; key: KeyObject } | { ok: false; reason: string };

/** A PEM key read for validation. The message names the file, never its content. */
function readPemKey(path: string, kind: 'private' | 'public'): ReadKey {
  let pem: string;
  try {
    pem = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: `${path} could not be read` };
  }
  let key: KeyObject;
  try {
    key = kind === 'private' ? createPrivateKey({ key: pem, format: 'pem' }) : createPublicKey({ key: pem, format: 'pem' });
  } catch {
    return { ok: false, reason: `${path} is not a readable PEM ${kind} key` };
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    return {
      ok: false,
      reason: `${path} is not an ES256 key: §5.4 fixes the deployment keys to EC P-256, and another curve signs tokens context-service refuses`,
    };
  }
  return { ok: true, key };
}

const spkiDer = (key: KeyObject): Buffer =>
  (key.type === 'private' ? createPublicKey(key) : key).export({ format: 'der', type: 'spki' });

/**
 * `fde install keys` — generate the deployment's two issuer key pairs, or keep the
 * ones already present.
 *
 * Idempotent by design: an install re-run must not rotate a key, because rotating
 * is `fde keys rotate` (Slice 2) and a key that moves takes every token with it. A
 * half pair is refused rather than completed — the missing half cannot be derived
 * from the present one, and guessing is how a deployment ends up with a public key
 * nothing signs under.
 */
export function installKeys(input: { bundleDir: string; outDir: string; deploymentId?: string }): InstallKeysResult {
  const created: string[] = [];
  if (existsSync(input.outDir) && !isDirectory(input.outDir)) {
    return {
      created,
      errors: [
        diagnostic('install_key_output_invalid', `${input.outDir} exists and is not a directory`, {
          path: input.outDir,
          remediation: 'pass --out with a directory the keys can be written to; the install flow creates it when it is absent',
        }),
      ],
    };
  }

  const loaded = loadBundle(input.bundleDir, input.deploymentId);
  if (loaded.bundle === undefined) return { created, errors: loaded.errors };

  const delivered = deliveredSecrets(loaded.bundle.topology);
  const errors: Diagnostic[] = [];

  const deliveryOf = (secret: string): DeliveredSecret | undefined => {
    const found = delivered.get(secret);
    if (found === undefined) {
      errors.push(
        diagnostic('install_key_unbound', `the bundle's topology binds no secret named ${secret}`, {
          path: `secretBindings[${secret}]`,
          remediation: `generate keys for the deployment this bundle describes, or add the ${secret} binding to the platform fragment and rebuild`,
        }),
      );
      return undefined;
    }
    if (found.injectInto.length === 0) {
      errors.push(
        diagnostic('install_key_unbound', `the bundle binds ${secret} and no component or job claims it`, {
          path: `secretBindings[${secret}]`,
          remediation: 'a binding with no claimant mounts nowhere: fix the fragment so the component that signs or verifies claims it',
        }),
      );
      return undefined;
    }
    return found;
  };

  const deliveries = ISSUERS.map((issuer) => ({
    issuer,
    signing: deliveryOf(issuer.signingKey),
    public: deliveryOf(issuer.publicKey),
  }));
  if (errors.length > 0) return { created, errors };

  const issuers: InstallKeysManifest['issuers'] = [];
  for (const { issuer: definition, signing, public: publicDelivery } of deliveries) {
    if (signing === undefined || publicDelivery === undefined) continue;
    const signingKeyFile = `${definition.prefix}-signing-key.pem`;
    const publicKeyFile = `${definition.prefix}-public-key.pem`;
    const signingPath = join(input.outDir, signingKeyFile);
    const publicPath = join(input.outDir, publicKeyFile);
    const signingExists = isFile(signingPath);
    const publicExists = isFile(publicPath);

    let publicKey: KeyObject;

    if (signingExists !== publicExists) {
      const missing = signingExists ? publicKeyFile : signingKeyFile;
      errors.push(
        diagnostic('install_key_incomplete', `${definition.issuer} has only one half of its key pair: ${missing} is missing`, {
          path: join(input.outDir, missing),
          remediation:
            'restore the missing half from the secret store, or delete the present half and re-run to mint a new pair; the installer never completes a half pair',
        }),
      );
      continue;
    }

    if (signingExists && publicExists) {
      const signingHalf = readPemKey(signingPath, 'private');
      if (!signingHalf.ok) {
        errors.push(diagnostic('install_key_invalid', signingHalf.reason, { path: signingPath }));
        continue;
      }
      const publicHalf = readPemKey(publicPath, 'public');
      if (!publicHalf.ok) {
        errors.push(diagnostic('install_key_invalid', publicHalf.reason, { path: publicPath }));
        continue;
      }
      if (!spkiDer(signingHalf.key).equals(spkiDer(publicHalf.key))) {
        errors.push(
          diagnostic('install_key_mismatch', `${publicKeyFile} is not the public half of ${signingKeyFile}`, {
            path: publicPath,
            remediation:
              'the pair is inconsistent: restore both halves from the secret store, or delete both and re-run to mint a new pair',
          }),
        );
        continue;
      }
      publicKey = publicHalf.key;
    } else {
      const pair = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
      });
      mkdirSync(input.outDir, { recursive: true });
      writeFileSync(signingPath, pair.privateKey, { mode: INSTALL_PRIVATE_KEY_MODE });
      writeFileSync(publicPath, pair.publicKey, { mode: INSTALL_PUBLIC_FILE_MODE });
      created.push(signingKeyFile, publicKeyFile);
      publicKey = createPublicKey({ key: pair.publicKey, format: 'pem' });
    }

    issuers.push({
      issuer: definition.issuer,
      iss: `fde://${loaded.bundle.deploymentId}${definition.suffix}`,
      alg: 'ES256',
      kid: thumbprint(publicKey),
      signingKey: {
        secretRef: signing.binding.secretRef,
        file: signingKeyFile,
        injectInto: signing.injectInto,
      },
      publicKey: {
        secretRef: publicDelivery.binding.secretRef,
        file: publicKeyFile,
        injectInto: publicDelivery.injectInto,
      },
    });
  }

  if (errors.length > 0) return { created, errors };

  const manifest: InstallKeysManifest = { keysVersion: 1, deploymentId: loaded.bundle.deploymentId, issuers };
  const manifestPath = join(input.outDir, 'keys.json');
  const manifestExisted = isFile(manifestPath);

  // A keys directory belongs to one deployment. Reusing it for another would file
  // one deployment's signatures under another's issuer.
  if (isFile(manifestPath)) {
    try {
      const existing = asRecord(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
      const recorded = asString(existing['deploymentId']);
      if (recorded !== undefined && recorded !== loaded.bundle.deploymentId) {
        return {
          created,
          errors: [
            diagnostic('install_key_deployment_mismatch', `${input.outDir} holds keys for ${recorded}, not ${loaded.bundle.deploymentId}`, {
              path: manifestPath,
              remediation: "a key pair is per-Deployment: install into a directory of this deployment's own, or rotate deliberately",
            }),
          ],
        };
      }
    } catch {
      // An unreadable manifest is rewritten below; the key material is what matters.
    }
  }

  mkdirSync(input.outDir, { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: INSTALL_PUBLIC_FILE_MODE });
  if (!manifestExisted) created.push('keys.json');

  return { created, manifest, errors: [] };
}

// ---------------------------------------------------------------------------
// fde install verify
// ---------------------------------------------------------------------------

export interface InstallVerifyInput {
  bundleDir: string;
  signaturePath: string;
  publicKeyPath: string;
  releasePath: string;
  releaseSignaturePath: string;
  releasePublicKeyPath: string;
  licenseCatalogPath: string;
}

export interface InstallVerifySummary {
  ok: boolean;
  bundle?: {
    digest: Digest;
    customer: string;
    solution: string;
    environment: string;
    deploymentId: string;
    files: number;
    licenseComponents: ResolvedComponent[];
  };
  release?: { version: string; approvedBy: string; approvedAt: string; status: string };
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

/** A PEM-encoded public key, or a diagnostic. */
function readPublicKey(path: string, prefix: 'bundle' | 'release'): { key?: KeyObject; kid?: string; errors: Diagnostic[] } {
  const read = readPemKey(path, 'public');
  if (!read.ok) {
    return {
      errors: [
        diagnostic(`${prefix}_key_invalid`, read.reason, {
          path,
          remediation: 'pin the public key the release chain published; the installer verifies offline, not against a registry',
        }),
      ],
    };
  }
  return { key: read.key, kid: thumbprint(read.key), errors: [] };
}

/**
 * One detached signature, checked against one pinned key.
 *
 * The order is the one an operator can act on: is the envelope readable, does its
 * `kid` name the key that was pinned, does its subject name the thing being
 * deployed, does the signature verify. Each failure has its own code, so "wrong
 * key" is not reported as "tampered artifact".
 */
function verifySignature(input: {
  envelopePath: string;
  publicKeyPath: string;
  expectedSubject: string;
  signingKey: { key: KeyObject; kid: string };
  prefix: 'bundle_signature' | 'release_signature';
  label: string;
  keyPrefix: 'bundle' | 'release';
  flag: string;
}): Diagnostic[] {
  const read = readJson(input.envelopePath, `${input.prefix}_invalid`, input.label);
  if (read.value === undefined) {
    return read.errors.map((error) =>
      isFile(input.envelopePath)
        ? error
        : {
            ...error,
            code: `${input.prefix}_missing`,
            message: `the ${input.label} is missing`,
            remediation: `pass ${input.flag} with the detached signature the release chain published`,
          },
    );
  }

  const document = read.value;
  const errors: Diagnostic[] = [];
  const invalid = (message: string): void => {
    errors.push(diagnostic(`${input.prefix}_invalid`, `${input.label} ${message}`, { path: input.envelopePath }));
  };

  if (document['signatureVersion'] !== 1) invalid('must declare signatureVersion 1');
  if (document['alg'] !== 'ES256') invalid(`must declare alg ES256, not ${JSON.stringify(document['alg'])}`);
  const kid = asString(document['kid']);
  const subject = asString(document['subject']);
  const signature = asString(document['signature']);
  if (kid === undefined) invalid('carries no kid');
  if (subject === undefined) invalid('carries no subject');
  if (signature === undefined) invalid('carries no signature');
  if (errors.length > 0 || kid === undefined || subject === undefined || signature === undefined) return errors;

  if (kid !== input.signingKey.kid) {
    return [
      diagnostic(
        `${input.keyPrefix}_key_mismatch`,
        `${input.label} was signed by key ${kid}, and the pinned key is ${input.signingKey.kid}`,
        {
          path: input.publicKeyPath,
          remediation: 'pin the key that signed this delivery; verifying against another key proves nothing about this one',
        },
      ),
    ];
  }

  if (subject !== input.expectedSubject) {
    return [
      diagnostic(`${input.prefix}_mismatch`, `${input.label} covers ${subject}, not ${input.expectedSubject}`, {
        path: input.envelopePath,
        remediation: 'the artifact and its signature belong to different deliveries; re-copy both from the release',
      }),
    ];
  }

  let verified = false;
  try {
    verified = verify('sha256', Buffer.from(subject, 'utf8'), { key: input.signingKey.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  } catch {
    verified = false;
  }
  if (!verified) {
    return [
      diagnostic(`${input.prefix}_invalid`, `${input.label} does not verify against the pinned key`, {
        path: input.envelopePath,
        remediation: 'the artifact or its signature was altered after signing, or the pinned key is not the one that signed it',
      }),
    ];
  }

  return [];
}

const NOTICE_COMPONENT = /^- (?<name>\S+) (?<version>\S+) — (?<license>\S+)(?: \([^)]*\))?$/u;
/** The catalog digest `NOTICE` records, which is what the Bundle signature covers. */
const NOTICE_CATALOG = /^Built under license catalog (sha256:[a-f0-9]{64})\.$/mu;

interface ComponentTriple {
  name: string;
  version: string;
  license: string;
}

function sameComponents(left: ReadonlyArray<ComponentTriple>, right: ReadonlyArray<ComponentTriple>): boolean {
  const encode = (components: ReadonlyArray<ComponentTriple>): string[] =>
    components.map((component) => `${component.name}\u0000${component.version}\u0000${component.license}`).sort();
  const a = encode(left);
  const b = encode(right);
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/**
 * `fde install verify` — may this delivery be deployed?
 *
 * Everything is re-derived from bytes on disk: the payload is hashed, the Compose
 * file is re-rendered from the topology the manifest addresses, the license verdict
 * is recomputed from the SBOM under the customer's pinned catalog and cross-checked
 * against `NOTICE` (which is payload-signed), and the whole tree is scanned for key
 * material. A bundle that lies about any of it is refused.
 */
export function verifyInstall(input: InstallVerifyInput): InstallVerifySummary {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];

  const loaded = loadBundle(input.bundleDir);
  if (loaded.bundle === undefined) return { ok: false, errors: loaded.errors, warnings };
  const { manifest, topology, deploymentId } = loaded.bundle;
  const bundleDir = input.bundleDir;
  const bundleSummary: NonNullable<InstallVerifySummary['bundle']> = {
    digest: manifest.digest,
    customer: manifest.solution.customer,
    solution: manifest.solution.solution,
    environment: manifest.solution.environment,
    deploymentId,
    files: manifest.artifacts.length,
    licenseComponents: [],
  };
  const summary: InstallVerifySummary = { ok: false, bundle: bundleSummary, errors, warnings };

  // 1. The payload is the content the address names, and the tree holds nothing else.
  //    `digestFiles` is the same rule `fde build` addressed the bundle with, so a
  //    verification cannot compute a different answer from the one it is checking.
  const onDisk = walkFiles(bundleDir);
  const payloadEntries: Array<{ path: string; content: string }> = [];
  let payloadIntact = true;
  for (const path of Object.keys(manifest.files)) {
    const absolute = join(bundleDir, path);
    if (!isFile(absolute)) {
      payloadIntact = false;
      errors.push(
        diagnostic('bundle_file_missing', `${path} is in the manifest and not in the bundle`, {
          path: absolute,
          remediation: 'the delivery is incomplete: re-copy the bundle, then verify it again',
        }),
      );
      continue;
    }
    try {
      payloadEntries.push({ path, content: readFileSync(absolute, 'utf8') });
    } catch (cause) {
      payloadIntact = false;
      errors.push(
        diagnostic('bundle_file_unreadable', `${path} could not be read: ${(cause as Error).message}`, {
          path: absolute,
          remediation: 'every file in the payload is hashed and scanned, so one that cannot be read is one that cannot be verified: fix its permissions',
        }),
      );
    }
  }

  const digested = digestFiles(payloadEntries);
  for (const [path, pinned] of Object.entries(manifest.files)) {
    const actual = digested.files[path];
    if (actual === undefined || actual === pinned) continue;
    payloadIntact = false;
    errors.push(
      diagnostic('bundle_file_modified', `${path} digests to ${actual}, and the manifest pins ${pinned}`, {
        path: join(bundleDir, path),
        remediation: 'the payload moved after it was addressed: a bundle is immutable, so re-copy the release artifact',
      }),
    );
  }
  if (payloadIntact && digested.digest !== manifest.digest) {
    errors.push(
      diagnostic('bundle_digest_mismatch', `the payload digests to ${digested.digest}, and the manifest claims ${manifest.digest}`, {
        path: join(bundleDir, 'bundle.json'),
        remediation: 'the manifest and the payload are not one delivery; re-copy both from the release',
      }),
    );
  }

  const accounted = new Set([...Object.keys(manifest.files), 'bundle.json', manifest.evidence.buildProvenance, manifest.evidence.sbom]);
  for (const path of onDisk) {
    if (accounted.has(path)) continue;
    errors.push(
      diagnostic('bundle_file_unlisted', `${path} is in the bundle and in no manifest entry`, {
        path: join(bundleDir, path),
        remediation: 'a bundle carries exactly the payload it addresses: remove the file, or rebuild the bundle with it',
      }),
    );
  }

  // 2. The payload's identity is what the evidence says it is.
  const provenancePath = join(bundleDir, manifest.evidence.buildProvenance);
  const provenanceRead = readJson(provenancePath, 'evidence_invalid', manifest.evidence.buildProvenance);
  if (provenanceRead.value === undefined) {
    errors.push(
      ...(isFile(provenancePath)
        ? provenanceRead.errors
        : [
            diagnostic('evidence_missing', `${manifest.evidence.buildProvenance} is missing from the delivery`, {
              path: provenancePath,
              remediation: 'build provenance is part of a bundle; re-copy the release artifact',
            }),
          ]),
    );
  }

  if (manifest.profile.digest !== topology.metadata.profileDigest) {
    errors.push(
      diagnostic('bundle_profile_mismatch', `bundle.json pins Runtime Profile ${manifest.profile.digest}, and the topology it carries is ${topology.metadata.profileDigest}`, {
        path: join(bundleDir, 'bundle.json'),
        remediation: 'the manifest and the topology are not one delivery; re-copy both from the release',
      }),
    );
  }

  // 3. The Compose file is the render of the topology the manifest addresses. A
  //    hand-edited deployment manifest is a deployment nobody reviewed, and it is
  //    also where a secret literal would have to appear.
  const invariants = checkTopology(topology);
  if (invariants.errors.length > 0) {
    errors.push(...invariants.errors.map((error) => ({ ...error, code: 'bundle_topology_invalid' })));
  } else {
    const composePath = join(bundleDir, 'deploy/compose.yaml');
    if (!isFile(composePath)) {
      errors.push(
        diagnostic('compose_missing', 'deploy/compose.yaml is missing from the delivery', {
          path: composePath,
          remediation: 'the delivery is incomplete: re-copy the bundle',
        }),
      );
    } else {
      let instance;
      try {
        instance = deploymentInstance(topology, deploymentId);
      } catch (cause) {
        errors.push(
          diagnostic('deployment_invalid', (cause as Error).message, {
            path: 'bundle.json#solution.deploymentId',
            remediation: 'pass a Deployment id the contract accepts (dep_<ULID>), or rebuild the bundle',
          }),
        );
        instance = undefined;
      }
      if (instance !== undefined) {
        const rendered = renderCompose(topology, instance);
        if (!rendered.ok) {
          errors.push(...rendered.errors.map((error) => ({ ...error, code: 'compose_mismatch' })));
        } else if (rendered.file.content !== readFileSync(composePath, 'utf8')) {
          errors.push(
            diagnostic('compose_mismatch', 'deploy/compose.yaml is not the render of the bundled topology', {
              path: composePath,
              remediation: 'generated artifacts are never hand-edited: rebuild the bundle and deploy its Compose file',
            }),
          );
        }
      }
    }
  }

  // 4. The license boundary, re-derived under the customer's pinned catalog.
  const license = verifyLicenseBoundary({
    bundleDir,
    manifest,
    provenance: provenanceRead.value,
    catalogPath: input.licenseCatalogPath,
  });
  errors.push(...license.errors);
  bundleSummary.licenseComponents = license.components;

  // 5. No secret value travelled inside the artifact.
  errors.push(...scanForKeyMaterial(bundleDir, onDisk));

  // 6. The Bundle signature, then the Release that approves it.
  const bundleKey = readPublicKey(input.publicKeyPath, 'bundle');
  errors.push(...bundleKey.errors);
  if (bundleKey.key !== undefined && bundleKey.kid !== undefined) {
    errors.push(
      ...verifySignature({
        envelopePath: input.signaturePath,
        publicKeyPath: input.publicKeyPath,
        expectedSubject: manifest.digest,
        signingKey: { key: bundleKey.key, kid: bundleKey.kid },
        prefix: 'bundle_signature',
        label: 'bundle signature',
        keyPrefix: 'bundle',
        flag: '--signature',
      }),
    );
  }

  const releaseRead = readRelease(input.releasePath);
  errors.push(...releaseRead.errors);
  if (releaseRead.release !== undefined) {
    const release = releaseRead.release;
    summary.release = {
      version: release.metadata.version,
      approvedBy: release.spec.approvedBy,
      approvedAt: release.spec.approvedAt,
      status: release.spec.status,
    };

    if (release.spec.status !== 'approved') {
      errors.push(
        diagnostic('release_not_approved', `the Release is ${release.spec.status}; only an approved Release may be installed`, {
          path: input.releasePath,
          remediation: 'deploy the Release the FDE release manager approved, not a draft or a recalled one',
        }),
      );
    }
    const disagreements = [
      release.spec.bundleDigest === manifest.digest ? undefined : `bundleDigest ${release.spec.bundleDigest} (bundle is ${manifest.digest})`,
      release.spec.specDigest === manifest.specDigest ? undefined : `specDigest ${release.spec.specDigest} (bundle is ${manifest.specDigest})`,
      release.spec.lockDigest === manifest.lockDigest ? undefined : `lockDigest ${release.spec.lockDigest} (bundle is ${manifest.lockDigest})`,
      release.metadata.customer === manifest.solution.customer ? undefined : `customer ${release.metadata.customer} (bundle is ${manifest.solution.customer})`,
      release.metadata.solution === manifest.solution.solution ? undefined : `solution ${release.metadata.solution} (bundle is ${manifest.solution.solution})`,
    ].filter((entry): entry is string => entry !== undefined);
    if (disagreements.length > 0) {
      errors.push(
        diagnostic('release_mismatch', `the Release does not describe this bundle: ${disagreements.join('; ')}`, {
          path: input.releasePath,
          remediation: 'install the bundle the Release names; a Release approves one bundle, and this is not it',
        }),
      );
    }

    const releaseKey = readPublicKey(input.releasePublicKeyPath, 'release');
    errors.push(...releaseKey.errors);
    if (releaseKey.key !== undefined && releaseKey.kid !== undefined) {
      errors.push(
        ...verifySignature({
          envelopePath: input.releaseSignaturePath,
          publicKeyPath: input.releasePublicKeyPath,
          expectedSubject: releaseSubject(release.raw),
          signingKey: { key: releaseKey.key, kid: releaseKey.kid },
          prefix: 'release_signature',
          label: 'release signature',
          keyPrefix: 'release',
          flag: '--release-signature',
        }),
      );
    }
  }

  summary.ok = errors.length === 0;
  return summary;
}

function readRelease(path: string): { release?: ReleaseDocument & { raw: Record<string, unknown> }; errors: Diagnostic[] } {
  const read = readJson(path, 'release_invalid', 'the Release document');
  if (read.value === undefined) {
    return {
      errors: read.errors.map((error) =>
        isFile(path)
          ? error
          : {
              ...error,
              code: 'release_missing',
              message: 'the Release document is missing',
              remediation: 'pass --release with the Release record the FDE release manager signed',
            },
      ),
    };
  }

  const document = read.value;
  const metadata = asRecord(document['metadata']);
  const spec = asRecord(document['spec']);
  const errors: Diagnostic[] = [];
  const invalid = (message: string): void => {
    errors.push(diagnostic('release_invalid', `the Release document ${message}`, { path }));
  };

  if (document['apiVersion'] !== 'fde.dev/v0') invalid('must declare apiVersion fde.dev/v0');
  if (document['kind'] !== 'Release') invalid('must declare kind Release');
  for (const field of ['customer', 'solution', 'version'] as const) {
    if (asString(metadata[field]) === undefined) invalid(`names no metadata.${field}`);
  }
  for (const field of ['status', 'approvedBy', 'approvedAt'] as const) {
    if (asString(spec[field]) === undefined) invalid(`names no spec.${field}`);
  }
  for (const field of ['bundleDigest', 'specDigest', 'lockDigest'] as const) {
    if (!isDigest(spec[field])) invalid(`declares no usable spec.${field}`);
  }
  if (errors.length > 0) return { errors };

  return {
    release: {
      apiVersion: 'fde.dev/v0',
      kind: 'Release',
      metadata: {
        customer: asString(metadata['customer']) as string,
        solution: asString(metadata['solution']) as string,
        version: asString(metadata['version']) as string,
      },
      spec: {
        status: asString(spec['status']) as string,
        bundleDigest: spec['bundleDigest'] as Digest,
        specDigest: spec['specDigest'] as Digest,
        lockDigest: spec['lockDigest'] as Digest,
        approvedBy: asString(spec['approvedBy']) as string,
        approvedAt: asString(spec['approvedAt']) as string,
      },
      raw: document,
    },
    errors: [],
  };
}

/**
 * The redistribution boundary, re-derived: the SBOM's components, the manifest's
 * verdict on them, and the `NOTICE` that ships in the payload must be one answer,
 * and that answer must satisfy the catalog the customer pinned.
 */
function verifyLicenseBoundary(input: {
  bundleDir: string;
  manifest: BundleManifestFacts;
  provenance: Record<string, unknown> | undefined;
  catalogPath: string;
}): { components: ResolvedComponent[]; errors: Diagnostic[] } {
  const errors: Diagnostic[] = [];
  const cwd = input.bundleDir;

  if (!input.manifest.licenseGate.ok) {
    errors.push(
      diagnostic('license_gate_failed', 'the bundle records a failed license gate', {
        path: join(cwd, 'bundle.json'),
        remediation: 'a bundle that did not pass its license gate is not distributable; rebuild it',
      }),
    );
  }

  const sbomRead = readJson(join(cwd, input.manifest.evidence.sbom), 'evidence_invalid', input.manifest.evidence.sbom);
  const sbomComponents: ComponentTriple[] =
    sbomRead.value === undefined
      ? []
      : (Array.isArray(sbomRead.value['packages']) ? (sbomRead.value['packages'] as unknown[]) : []).map((entry) => {
          const pkg = asRecord(entry);
          return {
            name: asString(pkg['name']) ?? '',
            version: asString(pkg['versionInfo']) ?? '',
            license: asString(pkg['licenseDeclared']) ?? '',
          };
        });
  if (sbomRead.errors.length > 0) errors.push(...sbomRead.errors);
  else if (sbomComponents.length === 0) {
    errors.push(
      diagnostic('license_evidence_mismatch', 'the SBOM declares no component, so the license boundary covers nothing', {
        path: join(cwd, input.manifest.evidence.sbom),
      }),
    );
  }

  const manifestComponents: ComponentTriple[] = input.manifest.licenseGate.components;
  if (!sameComponents(sbomComponents, manifestComponents)) {
    errors.push(
      diagnostic('license_evidence_mismatch', 'the SBOM and bundle.json disagree about which components the bundle carries', {
        path: join(cwd, input.manifest.evidence.sbom),
        remediation: 'the license evidence and the license verdict must be one answer; rebuild the bundle',
      }),
    );
  }

  const noticePath = join(cwd, 'NOTICE');
  let noticeCatalog: string | undefined;
  if (!isFile(noticePath)) {
    errors.push(
      diagnostic('license_evidence_mismatch', 'the bundle carries no NOTICE', {
        path: noticePath,
        remediation: 'NOTICE is the redistributed copy of the license facts; a bundle without one is not distributable',
      }),
    );
  } else {
    const notice = readFileSync(noticePath, 'utf8');
    const noticeComponents = notice
      .split('\n')
      .map((line) => NOTICE_COMPONENT.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({
        name: match.groups?.['name'] ?? '',
        version: match.groups?.['version'] ?? '',
        license: match.groups?.['license'] ?? '',
      }));
    if (!sameComponents(noticeComponents, sbomComponents)) {
      errors.push(
        diagnostic('license_evidence_mismatch', 'NOTICE and the SBOM disagree about the components this bundle carries', {
          path: noticePath,
          remediation: 'NOTICE ships in the payload and the SBOM beside it: two answers means one of them was edited',
        }),
      );
    }
    noticeCatalog = NOTICE_CATALOG.exec(notice)?.[1];
  }

  const catalog = readLicenseCatalog(input.catalogPath);
  if (catalog.catalog === undefined) return { components: [], errors: [...errors, ...catalog.errors] };

  // The catalog is the policy the build was gated on. A different one means the
  // verdict cannot be reproduced, which is exactly what "license 边界不符" means. The
  // claim is read from NOTICE — payload-signed — and cross-checked against the build
  // provenance, so editing the unsigned evidence cannot move the boundary.
  const provenanceCatalog = asString(asRecord(asRecord(input.provenance)['licenseGate'])['catalogDigest']);
  if (noticeCatalog === undefined) {
    errors.push(
      diagnostic('license_evidence_mismatch', 'NOTICE does not name the license catalog this bundle was built under', {
        path: noticePath,
        remediation: 'the catalog digest belongs in NOTICE, where the Bundle signature covers it; rebuild the bundle',
      }),
    );
  } else if (provenanceCatalog !== undefined && provenanceCatalog !== noticeCatalog) {
    errors.push(
      diagnostic('license_evidence_mismatch', `NOTICE names catalog ${noticeCatalog}, and the build provenance names ${provenanceCatalog}`, {
        path: noticePath,
        remediation: 'the license evidence must be one answer; a provenance file that disagrees with the signed NOTICE was edited',
      }),
    );
  }
  const builtUnder = noticeCatalog ?? provenanceCatalog;
  if (builtUnder !== undefined && builtUnder !== catalog.catalog.digest) {
    errors.push(
      diagnostic('license_catalog_mismatch', `the verified catalog digests to ${catalog.catalog.digest}, and the bundle was built under ${builtUnder}`, {
        path: input.catalogPath,
        remediation: "verify with the catalog the Release pinned; a verdict under another boundary is not the build's verdict",
      }),
    );
  }

  const gate = checkLicenseGate({
    catalog: catalog.catalog,
    inventory: sbomComponents,
    // The gate narrows this to Mastra packages itself; passing every name keeps the
    // core-only rule in one place instead of restating its predicate here.
    mastraPackages: sbomComponents.map((component) => component.name),
  });
  errors.push(...gate.errors);

  return {
    components: gate.components.map((component) => ({
      name: component.name,
      version: component.version,
      license: component.license,
      ...(component.source === undefined ? {} : { source: component.source }),
      ...(component.url === undefined ? {} : { url: component.url }),
    })),
    errors,
  };
}

const PRIVATE_KEY_MARKER = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/u;

/**
 * §5.4: no private key is ever inside a bundle. Scan every file, payload or not —
 * and fail closed on one that cannot be read, because a file the installer cannot
 * inspect is a file it cannot clear.
 */
function scanForKeyMaterial(bundleDir: string, files: ReadonlyArray<string>): Diagnostic[] {
  const errors: Diagnostic[] = [];
  for (const path of files) {
    let content: string;
    try {
      content = readFileSync(join(bundleDir, path), 'utf8');
    } catch (cause) {
      errors.push(
        diagnostic('bundle_file_unreadable', `${path} could not be read: ${(cause as Error).message}`, {
          path: join(bundleDir, path),
          remediation: 'every file in the bundle is checked for key material, so an unreadable one is an unverified one: fix its permissions and verify again',
        }),
      );
      continue;
    }
    if (!PRIVATE_KEY_MARKER.test(content)) continue;
    errors.push(
      diagnostic('bundle_secret_leak', `${path} carries a private key`, {
        path: join(bundleDir, path),
        remediation: 'a private key belongs in the customer secret store and in no artifact: rebuild the bundle from a template that references it, and rotate the leaked key',
      }),
    );
  }
  return errors;
}
