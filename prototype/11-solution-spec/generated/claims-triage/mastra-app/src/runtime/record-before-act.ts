// PROTOTYPE — generated skeleton.
// Source: solution.yaml#/spec/tools + docs/runtime-contract.md §7.4
// Wraps a side-effecting Tool with intent -> execute -> outcome Decisions.
import { contextClient, type ExecutionContextClaims } from './context-client';

interface RecordBeforeActConfig<Input, Output> {
  toolId: string;
  decision: {
    classification: 'public' | 'internal' | 'confidential' | 'restricted';
    retentionClass: 'ephemeral' | 'standard' | 'extended' | 'legal_hold';
  };
  execute: (args: {
    input: Input;
    claims: ExecutionContextClaims;
    intentDecisionId: string;
  }) => Promise<Output>;
}

export function recordBeforeAct<Input, Output>(config: RecordBeforeActConfig<Input, Output>) {
  return async (args: { input: Input; claims: ExecutionContextClaims }): Promise<Output> => {
    // GAP: the generated wrapper needs a stable evidence list, input digest,
    // policy evaluation summary, and prompt/model version. The Spec has no
    // fields to select them; this skeleton only records a tool id.
    const intent = await contextClient.writeDecision(args.claims, {
      decision_id: `dec_${crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()}`,
      run_id: args.claims.runId,
      tenant_id: args.claims.tenantId,
      decision_type: 'runtime',
      phase: 'intent',
      actor: args.claims.actor,
      rationale: `Execute side-effecting tool ${config.toolId}`,
      evidence: [],
      policy_evaluations: [],
      classification: config.decision.classification,
      retention_class: config.decision.retentionClass,
      trace_id: args.claims.traceId,
      timestamp: new Date().toISOString(),
    });

    try {
      const output = await config.execute({ ...args, intentDecisionId: intent.decision_id });
      await contextClient.writeDecision(args.claims, {
        decision_id: `dec_${crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()}`,
        parent_decision_id: intent.decision_id,
        run_id: args.claims.runId,
        tenant_id: args.claims.tenantId,
        decision_type: 'runtime',
        phase: 'outcome',
        actor: args.claims.actor,
        rationale: `Completed side-effecting tool ${config.toolId}`,
        evidence: [],
        policy_evaluations: [],
        classification: config.decision.classification,
        retention_class: config.decision.retentionClass,
        trace_id: args.claims.traceId,
        timestamp: new Date().toISOString(),
      });
      return output;
    } catch (error) {
      await contextClient.writeDecision(args.claims, {
        decision_id: `dec_${crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()}`,
        parent_decision_id: intent.decision_id,
        run_id: args.claims.runId,
        tenant_id: args.claims.tenantId,
        decision_type: 'runtime',
        phase: 'outcome',
        actor: args.claims.actor,
        rationale: `Failed side-effecting tool ${config.toolId}: ${String(error)}`,
        evidence: [],
        policy_evaluations: [],
        classification: config.decision.classification,
        retention_class: config.decision.retentionClass,
        trace_id: args.claims.traceId,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  };
}
