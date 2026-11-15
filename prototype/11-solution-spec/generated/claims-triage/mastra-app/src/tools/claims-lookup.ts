// PROTOTYPE — generated skeleton.
// Source: solution.yaml#/spec/tools/claims-lookup
// GAP: connector-backed Tool execution is not in fde.runtime/v1. See
// runtime/context-client.ts#invokeConnector.
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { contextClient, type ExecutionContextClaims } from '../runtime/context-client';

export const claimsLookup = createTool({
  id: 'claims-lookup',
  description: 'Look up the claim, policy, and coverage facts from claims-db.',
  inputSchema: z.object({
    claimId: z.string(),
  }),
  outputSchema: z.object({
    claimId: z.string(),
    policyNumber: z.string(),
    customerId: z.string(),
    amount: z.number(),
    status: z.enum(['open', 'review', 'closed']),
  }),
  execute: async ({ context, runtimeContext }) => {
    const claims = runtimeContext.get('executionContext') as ExecutionContextClaims;
    return contextClient.invokeConnector(claims, {
      connector_id: 'claims-db',
      operation: 'lookupClaim',
      input: { claimId: context.claimId },
    });
  },
});
