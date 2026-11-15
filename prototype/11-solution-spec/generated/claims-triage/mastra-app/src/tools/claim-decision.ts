// PROTOTYPE — generated skeleton.
// Source: solution.yaml#/spec/tools/claim-decision
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { contextClient, type ExecutionContextClaims } from '../runtime/context-client';
import { recordBeforeAct } from '../runtime/record-before-act';

const inputSchema = z.object({
  claimId: z.string(),
  outcome: z.enum(['approve', 'deny', 'refer']),
  rationale: z.string().max(4000),
  evidenceRefs: z.array(z.string()).min(1),
});

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
    const wrapped = recordBeforeAct({
      toolId: 'claim-decision',
      decision: { classification: 'confidential', retentionClass: 'standard' },
      execute: async ({ input }) =>
        contextClient.invokeConnector(claims, {
          connector_id: 'claims-db',
          operation: 'recordDecision',
          input,
        }),
    });
    return wrapped({ input: context, claims });
  },
});
