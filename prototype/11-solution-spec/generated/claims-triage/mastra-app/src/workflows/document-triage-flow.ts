// PROTOTYPE — generated skeleton.
// Source: solution.yaml#/spec/workflows/document-triage-flow (#18 grammar)
//
// v0 approval compiles to request -> wait -> commit:
//   POST /v1/approvals -> approval.required SSE -> suspend()
//   resume() -> POST /v1/approvals/{id}/consume -> gated Tool
// The generated adapter owns this mapping; Mastra only suspends/resumes.
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { triageAgent } from '../agents/triage-agent';
import { claimDecision } from '../tools/claim-decision';
import { retrieveContext } from '../tools/retrieve-context';
import { contextClient, type ExecutionContextClaims } from '../runtime/context-client';

const ClaimSchema = z.object({ claimId: z.string() });
const ContextSchema = z.object({ claimId: z.string(), snapshotDigest: z.string() });
const TriageSchema = z.object({
  claimId: z.string(),
  amount: z.number(),
  outcome: z.enum(['approve', 'deny', 'refer']),
  rationale: z.string(),
  citedSources: z.array(z.string()),
});
const ApprovalSchema = z.object({
  status: z.enum(['approved', 'rejected', 'expired', 'auto_approved']),
  approvalId: z.string().optional(),
  decisionId: z.string().optional(),
});
const DecisionSchema = z.object({ decisionId: z.string(), status: z.string() });

// Generated from the pinned Policy Template + Overlay. The author's
// `requiredWhen` is a named predicate, so the comparison lives here, not in
// the Solution Spec. `expiresAfter: PT24H` compiles to milliseconds.
const CLAIMS_APPROVAL_THRESHOLD = 100_000;
const CLAIMS_APPROVAL_EXPIRES_AFTER_MS = 24 * 60 * 60 * 1000;

const contextStep = createStep({
  id: 'context',
  inputSchema: ClaimSchema,
  outputSchema: ContextSchema,
  execute: async ({ inputData, runtimeContext }) => {
    const result = await retrieveContext.execute!({
      context: { claimId: inputData.claimId },
      runtimeContext,
    } as never);
    return { claimId: inputData.claimId, snapshotDigest: result.snapshot_digest };
  },
});

const triageStep = createStep({
  id: 'triage',
  inputSchema: ContextSchema,
  outputSchema: TriageSchema,
  execute: async ({ inputData }) => {
    const result = await triageAgent.generate(
      `Triage claim ${inputData.claimId}. Context snapshot: ${inputData.snapshotDigest}`,
    );
    return {
      claimId: inputData.claimId,
      amount: 120000,
      outcome: 'approve' as const,
      rationale: result.text,
      citedSources: [],
    };
  },
});

const approvalStep = createStep({
  id: 'approval',
  inputSchema: TriageSchema,
  outputSchema: ApprovalSchema,
  execute: async ({ inputData, runtimeContext, suspend, resumeData }) => {
    // Generated runtime context carries the signed ExecutionContext claims.
    const claims = runtimeContext.claims as ExecutionContextClaims;
    const requiresApproval = inputData.amount > CLAIMS_APPROVAL_THRESHOLD;

    if (!requiresApproval) {
      // requiredWhen=false: no Approval resource; record the policy decision,
      // then execute the gated Tool under record-before-act.
      const decision = await contextClient.writeDecision(claims, {
        decision_id: `dec_${crypto.randomUUID().replaceAll('-', '').slice(0, 26).toUpperCase()}`,
        run_id: claims.runId,
        tenant_id: claims.tenantId,
        capability_id: 'document-triage',
        decision_type: 'approval',
        phase: 'approval',
        actor: claims.actor,
        rationale: `Auto-approved: amount ${inputData.amount} <= ${CLAIMS_APPROVAL_THRESHOLD}`,
        policy_evaluations: [
          {
            policy_id: 'claims-approval-threshold',
            version: '1.0.0',
            outcome: 'allow',
            reason: 'amount below approval threshold',
          },
        ],
        trace_id: claims.traceId,
        timestamp: new Date().toISOString(),
      });
      return { status: 'auto_approved' as const, decisionId: decision.decision_id };
    }

    if (!resumeData) {
      // proposed_action is derived from the gated `commit` step. `summary` is
      // summaryFrom; evidence is generated from evidenceFrom: [context].
      // Requires end_user scope approval:create for the caller's own Run; see
      // the identity-scope follow-up in the #18 resolution.
      const approval = await contextClient.createApproval(
        claims,
        {
          run_id: claims.runId,
          capability_id: 'document-triage',
          proposed_action: {
            tool: 'claim-decision',
            operation: 'recordDecision',
            input_digest: `sha256:${'1'.repeat(64)}`, // generated from resolved Tool input
            summary: inputData.rationale,
          },
          requested_by: claims.actor,
          approver_roles: ['claims-supervisor'],
          expires_at: new Date(Date.now() + CLAIMS_APPROVAL_EXPIRES_AFTER_MS).toISOString(),
          // Placeholder: generated from the context Retrieval Snapshot.
          evidence: [{ entity_id: 'fde:acme:claim:C-1001', version: '3' }],
          policy_refs: ['claims-approval-threshold@1.0.0'],
        },
        `approval:${claims.runId}:approval`,
      );
      // The generated Run service emits `approval.required` and moves the Run
      // to waiting_for_human; Mastra only suspends the workflow.
      return suspend({ approvalId: approval.approval_id });
    }

    const resumed = resumeData as {
      status: 'approved' | 'rejected' | 'expired';
      approvalId: string;
      decisionId?: string;
    };
    if (resumed.status === 'approved') {
      // Resume succeeded; consume is idempotent and must not re-run the Tool.
      // If consume fails, retry with the same key before executing the Tool.
      // consume runs as the mastra-app service subject (approval:consume),
      // not as the requester or the approver.
      const serviceClaims: ExecutionContextClaims = {
        ...claims,
        sub: 'service:mastra-app',
        actor: { type: 'service', id: 'mastra-app' },
        roles: ['service'],
        scopes: ['approval:consume'],
      };
      await contextClient.consumeApproval(serviceClaims, resumed.approvalId);
    }
    return resumed;
  },
});

const commitStep = createStep({
  id: 'commit',
  inputSchema: ApprovalSchema,
  outputSchema: DecisionSchema,
  execute: async ({ inputData, runtimeContext }) => {
    if (!['approved', 'auto_approved'].includes(inputData.status)) {
      // Reject/expire ends the workflow. The Run reports
      // output.approval.status; the gated Tool is not executed.
      return { decisionId: inputData.decisionId ?? '', status: inputData.status };
    }
    const result = await claimDecision.execute!({
      context: {
        claimId: 'C-1001',
        outcome: 'approve',
        rationale: 'Approved by claims-supervisor',
        evidenceRefs: ['claims-db://public.claims/C-1001'],
      },
      runtimeContext,
    } as never);
    return result;
  },
});

export const documentTriageFlow = createWorkflow({
  id: 'document-triage-flow',
  inputSchema: ClaimSchema,
  outputSchema: DecisionSchema,
})
  .then(contextStep)
  .then(triageStep)
  .then(approvalStep)
  .then(commitStep)
  .commit();
