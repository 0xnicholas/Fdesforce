// PROTOTYPE — generated skeleton.
// Source: solution.yaml#/spec/workflows/document-triage-flow
// GAP: the workflow step grammar is not defined anywhere. `type: approval`,
// `when`, `approverRoles`, `expiresAt`, and `proposedAction` are provisional;
// the generator cannot validate them, and `human_approval: true` in the
// domain model carries none of the runtime contract's approval fields.
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { triageAgent } from '../agents/triage-agent';
import { claimDecision } from '../tools/claim-decision';
import { retrieveContext } from '../tools/retrieve-context';

const ClaimSchema = z.object({ claimId: z.string() });
const ContextSchema = z.object({ claimId: z.string(), snapshotDigest: z.string() });
const TriageSchema = z.object({
  claimId: z.string(),
  amount: z.number(),
  outcome: z.enum(['approve', 'deny', 'refer']),
  rationale: z.string(),
  citedSources: z.array(z.string()),
});
const ApprovalSchema = z.object({ status: z.enum(['approved', 'rejected', 'auto-approved']) });
const DecisionSchema = z.object({ decisionId: z.string(), status: z.string() });

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
    // GAP: no generated binding from capability output schema to workflow step.
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
  execute: async ({ inputData, suspend, resumeData }) => {
    if (inputData.amount <= 100000) {
      return { status: 'auto-approved' as const };
    }
    if (!resumeData) {
      // GAP: Mastra suspend payload is not connected to POST /v1/approvals.
      // The generated adapter must create the approval, emit
      // `approval.required`, and map the decision back into resumeData.
      return suspend({
        proposedAction: `approve claim ${inputData.claimId} for ${inputData.amount}`,
        approverRoles: ['claims-supervisor'],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
    }
    return resumeData as { status: 'approved' | 'rejected' };
  },
});

const commitStep = createStep({
  id: 'commit',
  inputSchema: ApprovalSchema,
  outputSchema: DecisionSchema,
  execute: async ({ inputData, runtimeContext }) => {
    if (inputData.status !== 'approved') {
      return { decisionId: '', status: 'skipped' };
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
