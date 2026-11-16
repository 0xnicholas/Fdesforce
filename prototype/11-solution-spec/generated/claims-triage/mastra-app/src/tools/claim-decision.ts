// PROTOTYPE — generated skeleton.
// Source: solution.yaml#/spec/tools/claim-decision + capabilities.document-triage.audit
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { contextClient, type ExecutionContextClaims } from '../runtime/context-client';
import { recordBeforeAct, type DecisionBinding, type DecisionScope } from '../runtime/record-before-act';

const inputSchema = z.object({
  claimId: z.string(),
  outcome: z.enum(['approve', 'deny', 'refer']),
  rationale: z.string().max(4000),
  evidenceRefs: z.array(z.string()).min(1),
});

const binding: DecisionBinding = {
  toolId: 'claim-decision',
  action: {
    toolId: 'claim-decision',
    connectorId: 'claims-db',
    operation: 'recordDecision',
    sideEffects: 'write',
  },
  classification: 'confidential',
  retentionClass: 'standard',
  evidence: [
    { from: 'retrieval', recipe: 'claims-context' },
    { from: 'step', step: 'triage', path: 'output.citedSources', as: 'citations' },
  ],
  policies: [
    { policyId: 'tool-allowlist', version: '1.0.0', enforcementPoint: 'tool.pre_invoke' },
  ],
};

export const claimDecision = createTool({
  id: 'claim-decision',
  description: 'Record the final claim decision in claims-db.',
  inputSchema,
  outputSchema: z.object({
    decisionId: z.string(),
    status: z.enum(['recorded', 'rejected']),
  }),
  execute: async ({ context, runtimeContext }) => {
    const claims = runtimeContext.get('executionContext') as ExecutionContextClaims;
    const scope = runtimeContext.get('decisionScope') as DecisionScope;
    return recordBeforeAct({
      binding,
      claims,
      scope,
      execute: () =>
        contextClient.invokeConnector(claims, {
          connector_id: 'claims-db',
          operation: 'recordDecision',
          input: context,
        }),
    });
  },
});
