// PROTOTYPE — generated runtime skeleton.
// Source: docs/decision-audit-binding.md (#20) + docs/runtime-contract.md §7.4
// The generator emits only the DecisionBinding; ID/outbox/digest/evidence
// logic lives in @fde/runtime (implementation slice #13).
import { contextClient, type ExecutionContextClaims } from './context-client';

export type Classification = 'public' | 'internal' | 'confidential' | 'restricted';
export type RetentionClass = 'ephemeral' | 'standard' | 'extended' | 'legal_hold';
export type SideEffects = 'read' | 'write' | 'external';

export interface EvidenceSelector {
  from: 'retrieval' | 'input' | 'step';
  recipe?: string;
  step?: string;
  path?: string;
  as?: 'artifact' | 'citations';
}

export interface DecisionBinding {
  toolId: string;
  action: {
    toolId: string;
    connectorId?: string;
    operation?: string;
    sideEffects: SideEffects;
  };
  classification: Classification;
  retentionClass: RetentionClass;
  evidence: EvidenceSelector[];
  policies: Array<{
    policyId: string;
    version: string;
    enforcementPoint: 'tool.pre_invoke';
  }>;
}

export interface DecisionScope {
  retrievalSnapshots: Array<{
    retrievalId: string;
    snapshotDigest: string;
    items: Array<{ entityId: string; version: string; sourceRef: string; classification?: Classification }>;
  }>;
  stepOutputs: Record<string, unknown>;
  approval?: { approvalId: string; decisionId: string };
  agent?: { model?: string; modelVersion?: string; promptVersion?: string; fallbackUsed?: boolean };
}

interface RecordBeforeActArgs<Output> {
  binding: DecisionBinding;
  claims: ExecutionContextClaims;
  scope: DecisionScope;
  execute: () => Promise<Output>;
}

const newUlid = (): string =>
  crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase();

const newInvocationId = (): string => `inv_${newUlid()}`;
const newDecisionId = (): string => `dec_${newUlid()}`;

// Placeholder for the frozen runtime implementation. The real resolver:
// - turns selectors into graph_entity / retrieval / run_artifact evidence;
// - rejects empty results, unresolved citations and ambiguous matches;
// - appends the approval evidence automatically.
function resolveEvidence(binding: DecisionBinding, scope: DecisionScope): unknown[] {
  const evidence: unknown[] = [];
  for (const selector of binding.evidence) {
    if (selector.from === 'retrieval') {
      for (const snapshot of scope.retrievalSnapshots) {
        if (selector.recipe && !snapshot.retrievalId.includes(selector.recipe)) continue;
        evidence.push({
          type: 'retrieval',
          retrieval_id: snapshot.retrievalId,
          snapshot_digest: snapshot.snapshotDigest,
        });
        for (const item of snapshot.items) {
          evidence.push({
            type: 'graph_entity',
            entity_id: item.entityId,
            version: item.version,
            retrieval_id: snapshot.retrievalId,
            source_ref: item.sourceRef,
          });
        }
      }
    }
    if (selector.from === 'input') {
      evidence.push({ type: 'run_artifact', path: 'input', digest: 'sha256:placeholder' });
    }
    if (selector.from === 'step') {
      evidence.push({ type: 'run_artifact', path: selector.path, digest: 'sha256:placeholder' });
    }
  }
  if (scope.approval) {
    evidence.push({
      type: 'approval',
      approval_id: scope.approval.approvalId,
      decision_id: scope.approval.decisionId,
    });
  }
  if (evidence.length === 0) {
    throw new Error(`DecisionBinding for ${binding.toolId} resolved empty evidence`);
  }
  return evidence;
}

function digestOf(_value: unknown): string {
  // Placeholder: @fde/runtime uses RFC 8785 canonical JSON + SHA-256.
  return 'sha256:placeholder';
}

export function recordBeforeAct<Output>(args: RecordBeforeActArgs<Output>) {
  const { binding, claims, scope, execute } = args;
  const invocationId = newInvocationId();
  const intentDecisionId = newDecisionId();
  const outcomeDecisionId = newDecisionId();
  const evidence = resolveEvidence(binding, scope);
  const policyEvaluations = binding.policies.map((policy) => ({
    policy_id: policy.policyId,
    version: policy.version,
    enforcement_point: policy.enforcementPoint,
    evaluated_by: 'mastra-app' as const,
    outcome: 'allow' as const,
  }));

  return (async (): Promise<Output> => {
    // GAP: @fde/runtime persists pending IDs to mastra-state.decision_outbox
    // before the intent write; an outbox write failure must fail closed.
    await contextClient.writeDecision(claims, {
      decision_id: intentDecisionId,
      invocation_id: invocationId,
      run_id: claims.runId,
      tenant_id: claims.tenantId,
      capability_id: claims.capabilityId,
      decision_type: 'runtime',
      phase: 'intent',
      action: binding.action,
      status: 'proposed',
      actor: claims.actor,
      rationale: `Execute side-effecting tool ${binding.toolId}`,
      evidence,
      policy_evaluations: policyEvaluations,
      model: scope.agent?.model
        ? { provider: 'azure-openai', model: scope.agent.model, version: scope.agent.modelVersion }
        : undefined,
      prompt_version: scope.agent?.promptVersion,
      input_digest: digestOf(args),
      classification: binding.classification,
      retention_class: binding.retentionClass,
      fallback_used: scope.agent?.fallbackUsed ?? false,
      trace_id: claims.traceId,
      timestamp: new Date().toISOString(),
    });

    try {
      // GAP: outbox marks intent_written -> executing here. Only after the
      // intent write succeeds may the side effect run.
      const output = await execute();
      await contextClient.writeDecision(claims, {
        decision_id: outcomeDecisionId,
        invocation_id: invocationId,
        parent_decision_id: intentDecisionId,
        run_id: claims.runId,
        tenant_id: claims.tenantId,
        capability_id: claims.capabilityId,
        decision_type: 'runtime',
        phase: 'outcome',
        action: binding.action,
        status: 'succeeded',
        actor: claims.actor,
        rationale: `Completed side-effecting tool ${binding.toolId}`,
        evidence,
        policy_evaluations: policyEvaluations,
        output_digest: digestOf(output),
        classification: binding.classification,
        retention_class: binding.retentionClass,
        fallback_used: scope.agent?.fallbackUsed ?? false,
        trace_id: claims.traceId,
        timestamp: new Date().toISOString(),
      });
      return output;
    } catch (error) {
      await contextClient.writeDecision(claims, {
        decision_id: outcomeDecisionId,
        invocation_id: invocationId,
        parent_decision_id: intentDecisionId,
        run_id: claims.runId,
        tenant_id: claims.tenantId,
        capability_id: claims.capabilityId,
        decision_type: 'runtime',
        phase: 'outcome',
        action: binding.action,
        status: 'failed',
        actor: claims.actor,
        rationale: `Failed side-effecting tool ${binding.toolId}`,
        evidence,
        policy_evaluations: policyEvaluations,
        output_digest: digestOf({ status: 'error', error: String(error) }),
        classification: binding.classification,
        retention_class: binding.retentionClass,
        fallback_used: scope.agent?.fallbackUsed ?? false,
        trace_id: claims.traceId,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  })();
}
