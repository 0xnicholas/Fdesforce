import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  ContextServiceClient,
  fetchTransport,
  type IngestJobRequest,
  type IngestJobResult,
  type IngestMode,
  type Transport,
} from '@fde/contracts-client';

import { diagnostic, type Diagnostic } from './types.js';

/**
 * `fde context ingest` — the one command that reaches a runtime.
 *
 * It posts the frozen Context Package to context-service's **internal** maintenance
 * surface (`POST /internal/v1/jobs/ingest`, `contracts/context-service-v1.openapi.yaml`), never
 * to the customer Runtime API: the customer application surface belongs to
 * `mastra-app`, and ingest is a job. The job is authenticated with its own issuer —
 * `iss = fde://<deployment_id>/jobs` — and a maintenance scope (`context:ingest`),
 * so the credential the CLI holds cannot retrieve context or decide approvals
 * (`docs/security-and-deployment.md` §3.3, `docs/runtime-contract.md` §5.1).
 *
 * The wire shapes come from `@fde/contracts-client`, which is generated from
 * `contracts/`; this module carries the identity and the HTTP mechanics, no second
 * copy of the request.
 */

/** `iss` names a Deployment; the contract fixes the `dep_<ULID>` form. */
export const DEPLOYMENT_ID_PATTERN = /^dep_[0-9A-HJKMNP-TV-Z]{26}$/;
/** `solution_id` is the TenantId/SolutionId shape from `contracts/schemas/common.schema.json`. */
export const SOLUTION_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;

const TTL_SECONDS = 300;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface JobsIdentity {
  key: KeyObject;
  /** The `kid` context-service selects the public key by. */
  kid: string;
  deploymentId: string;
  solutionId: string;
  tenantId: string;
}

/** The claims the `fde-jobs` issuer mints; structurally an `ExecutionContext` (§5.1). */
export interface JobsExecutionContextClaims {
  iss: string;
  aud: string;
  sub: string;
  actor: { type: 'service'; id: string; display: string };
  tenant_id: string;
  deployment_id: string;
  solution_id: string;
  trace_id: string;
  roles: string[];
  scopes: string[];
  iat: number;
  exp: number;
  jti: string;
  kid: string;
}

export interface LoadJobsKeyResult {
  key?: KeyObject;
  kid?: string;
  errors: Diagnostic[];
}

/**
 * The maintenance key, from a mounted PEM. Fails closed on anything but ES256:
 * a P-384 key or an RSA key would sign a token context-service cannot verify, and
 * a `kid` that disagrees with the key is a token it rejects.
 */
export function loadJobsKey(pem: string, explicitKid?: string): LoadJobsKeyResult {
  const errors: Diagnostic[] = [];
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    // The parser message can quote the input; this one cannot.
    return {
      errors: [
        diagnostic('context_jobs_key_invalid', 'the jobs key is not a readable PKCS#8 PEM private key', {
          remediation: 'point --jobs-key at the fde-jobs private key (PKCS#8 PEM, ES256)',
        }),
      ],
    };
  }

  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    errors.push(
      diagnostic('context_jobs_key_invalid', 'the jobs key must be an ES256 key (EC P-256); another curve signs under the wrong alg', {
        remediation: 'generate the deployment key with `openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt`',
      }),
    );
    return { errors };
  }

  const kid = explicitKid ?? thumbprint(key);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(kid)) {
    return {
      errors: [
        diagnostic('context_jobs_key_invalid', 'the key id is not a JWK thumbprint', {
          remediation: 'omit --kid to derive the RFC 7638 thumbprint, or pass the id context-service was configured with',
        }),
      ],
    };
  }
  return { key, kid, errors };
}

/**
 * The RFC 7638 JWK thumbprint: the id context-service computes from the public key,
 * so a `kid` that disagrees with its key is impossible by construction.
 */
export function thumbprint(key: KeyObject): string {
  const jwk = createPublicKey(key).export({ format: 'jwk' });
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || jwk.x === undefined || jwk.y === undefined) {
    throw new Error('the jobs key has no P-256 public half');
  }
  const members = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return createHash('sha256').update(members).digest('base64url');
}

export function createJobsToken(
  identity: JobsIdentity,
  options: { traceId: string; now: Date },
): { token: string; claims: JobsExecutionContextClaims } {
  const iat = Math.floor(options.now.getTime() / 1000);
  const iss = `fde://${identity.deploymentId}/jobs`;
  const claims: JobsExecutionContextClaims = {
    iss,
    aud: 'context-service',
    sub: iss,
    actor: { type: 'service', id: 'fde-jobs', display: 'fde-jobs' },
    tenant_id: identity.tenantId,
    deployment_id: identity.deploymentId,
    solution_id: identity.solutionId,
    trace_id: options.traceId,
    // A maintenance credential is not a platform role grant: it carries the
    // narrow maintenance scopes, which do not include `context:retrieve`.
    roles: ['service'],
    scopes: ['context:ingest'],
    iat,
    exp: iat + TTL_SECONDS,
    jti: ulid(),
    kid: identity.kid,
  };

  const header = { alg: 'ES256', typ: 'JWT', kid: identity.kid };
  const signingInput = `${base64urlJson(header)}.${base64urlJson(claims)}`;
  // P1363 is the JWS signature encoding; DER would produce a token no conforming
  // verifier accepts.
  const signature = sign('sha256', Buffer.from(signingInput, 'utf8'), { key: identity.key, dsaEncoding: 'ieee-p1363' });
  return { token: `${signingInput}.${signature.toString('base64url')}`, claims };
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** Crockford base32 ULID — `jti` needs uniqueness, not meaning. */
export function ulid(now: Date = new Date()): string {
  let time = now.getTime();
  const timeChars: string[] = [];
  for (let index = 0; index < 10; index += 1) {
    timeChars.unshift(CROCKFORD[time % 32] as string);
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  const randomChars: string[] = [];
  for (let index = 0; index < 16; index += 1) randomChars.push(CROCKFORD[(random[index] as number) % 32] as string);
  return `${timeChars.join('')}${randomChars.join('')}`;
}

export function traceparentOf(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

export interface IngestOptions {
  baseUrl: string;
  request: IngestJobRequest;
  identity: JobsIdentity;
  traceId: string;
  now: Date;
  transport?: Transport;
}

export interface IngestOutcome {
  result?: IngestJobResult;
  status?: number;
  traceId: string;
  errors: Diagnostic[];
}

/**
 * Post the frozen package to the internal job endpoint.
 *
 * The response is the finished job (synchronous in this slice), so the CLI reports
 * the outcome rather than a handle: an ingest that returned `degraded` is a real
 * answer, and the operator needs to see which sources degraded.
 */
export async function runIngest(options: IngestOptions): Promise<IngestOutcome> {
  const { token } = createJobsToken(options.identity, { traceId: options.traceId, now: options.now });
  const client = new ContextServiceClient(options.transport ?? fetchTransport, options.baseUrl, {
    authorization: `Bearer ${token}`,
  });

  let response: Awaited<ReturnType<typeof client.startIngestJob>>;
  try {
    response = await client.startIngestJob({
      headers: { traceparent: traceparentOf(options.traceId, newSpanId()) },
      body: options.request,
    });
  } catch (error) {
    // A refused connection is a failed job, not a crash in the authoring tool: the
    // operator needs the endpoint and the reason, not a stack trace.
    return {
      status: 0,
      traceId: options.traceId,
      errors: [
        diagnostic('context_ingest_failed', `context-service at ${options.baseUrl} could not be reached: ${error instanceof Error ? error.message : String(error)}`, {
          remediation: 'check that context-service is running and reachable from here; ingest runs inside the bundle network',
        }),
      ],
    };
  }

  if (response.status === 200) {
    return { result: response.body, status: response.status, traceId: options.traceId, errors: [] };
  }

  const envelope = response.body as { error?: { code?: string; message?: string; details?: { reason?: string } } } | undefined;
  const reason = envelope?.error?.details?.reason;
  const detail = envelope?.error?.message ?? `context-service answered ${String(response.status)} with no error envelope`;
  return {
    status: response.status,
    traceId: options.traceId,
    errors: [
      diagnostic(
        'context_ingest_failed',
        `the ingest job was refused: ${detail}${reason === undefined ? '' : ` (${envelope?.error?.code ?? 'error'}: ${reason})`}`,
        { remediation: ingestRemediation(reason) },
      ),
    ],
  };
}

function ingestRemediation(reason: string | undefined): string {
  if (reason === 'package_not_frozen') {
    return 'the runtime only materializes frozen semantics: run `fde context freeze` and ingest the revision digest';
  }
  if (reason === 'unauthenticated' || reason === 'forbidden') {
    return 'the jobs key must be the one context-service holds the public half of, with the context:ingest scope';
  }
  return 'read the context-service log for this job id, or check that the deployment id and package digest match the bundle';
}

export function readJobsKeyFile(path: string): { pem?: string; errors: Diagnostic[] } {
  try {
    return { pem: readFileSync(path, 'utf8'), errors: [] };
  } catch {
    return {
      errors: [
        diagnostic('context_jobs_key_missing', `the jobs key file ${path} could not be read`, {
          remediation: 'mount the fde-jobs private key and pass --jobs-key <file>',
        }),
      ],
    };
  }
}

export type { IngestJobRequest, IngestJobResult, IngestMode, Transport };
