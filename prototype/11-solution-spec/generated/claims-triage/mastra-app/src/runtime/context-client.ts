// PROTOTYPE — generated skeleton.
// Source: solution.lock#/runtime + docs/runtime-contract.md
// GAP: the generated client must sign an ExecutionContext JWT with the
// deployment key and forward traceparent. The contract does not say how the
// generated app discovers the key/kid or where the trace root is created.
import { SignJWT, importJWK } from 'jose';
import { randomUUID } from 'node:crypto';

const CONTEXT_SERVICE_URL = process.env.CONTEXT_SERVICE_URL ?? 'http://context-service:8011';

async function signExecutionContext(claims: Record<string, unknown>): Promise<string> {
  const jwk = JSON.parse(process.env.EXECUTION_CONTEXT_JWK ?? '{}');
  const key = await importJWK(jwk, 'ES256');
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid: process.env.EXECUTION_CONTEXT_KID ?? 'proto' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .setJti(randomUUID())
    .sign(key);
}

export interface ExecutionContextClaims {
  tenantId: string;
  deploymentId: string;
  solutionId: string;
  runId: string;
  traceId: string;
  sub: string;
  actor: { type: 'user' | 'service' | 'system'; id: string };
  roles: string[];
  scopes: string[];
}

export class ContextClient {
  private async post(
    path: string,
    body: unknown,
    claims: ExecutionContextClaims,
    idempotencyKey = randomUUID(),
  ) {
    const token = await signExecutionContext({
      iss: `fde://${claims.deploymentId}`,
      aud: 'context-service',
      sub: claims.sub,
      actor: claims.actor,
      tenant_id: claims.tenantId,
      deployment_id: claims.deploymentId,
      solution_id: claims.solutionId,
      run_id: claims.runId,
      trace_id: claims.traceId,
      roles: claims.roles,
      scopes: claims.scopes,
    });

    const response = await fetch(`${CONTEXT_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        traceparent: `00-${claims.traceId}-0000000000000001-01`,
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const envelope = await response.json().catch(() => ({}));
      throw new Error(`context-service ${response.status}: ${JSON.stringify(envelope)}`);
    }
    return response.json();
  }

  retrieve(claims: ExecutionContextClaims, body: unknown) {
    return this.post('/v1/context/retrieve', body, claims);
  }

  writeDecision(claims: ExecutionContextClaims, body: unknown) {
    return this.post('/v1/decisions', body, claims);
  }

  createApproval(claims: ExecutionContextClaims, body: unknown, idempotencyKey?: string) {
    return this.post('/v1/approvals', body, claims, idempotencyKey);
  }

  consumeApproval(claims: ExecutionContextClaims, approvalId: string) {
    return this.post(
      `/v1/approvals/${approvalId}/consume`,
      {},
      claims,
      `consume:${approvalId}`,
    );
  }

  // GAP: no connector-operation endpoint exists in fde.runtime/v1. A generated
  // Tool bound to `connectorRef` has nowhere to execute. Options are a new
  // context-service endpoint, a TS-side connector package, or restricting
  // connector-backed tools to context retrieval stages.
  invokeConnector(claims: ExecutionContextClaims, body: unknown) {
    return this.post('/v1/connectors/claims-db/operations', body, claims);
  }
}

export const contextClient = new ContextClient();
