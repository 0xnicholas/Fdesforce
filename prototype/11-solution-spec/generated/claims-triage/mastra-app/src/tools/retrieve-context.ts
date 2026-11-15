// PROTOTYPE — generated skeleton.
// Source: solution.yaml#/spec/tools/retrieve-context (PROPOSED builtin Tool)
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { contextClient, type ExecutionContextClaims } from '../runtime/context-client';

export const retrieveContext = createTool({
  id: 'retrieve-context',
  description: 'Retrieve the claims context recipe for a claim and optional query.',
  inputSchema: z.object({
    claimId: z.string(),
    query: z.string().optional(),
    maxTokens: z.number().int().min(1).max(4000).optional(),
  }),
  execute: async ({ context, runtimeContext }) => {
    const claims = runtimeContext.get('executionContext') as ExecutionContextClaims;
    return contextClient.retrieve(claims, {
      recipe_id: 'claims-context',
      query: context.query ?? `claim ${context.claimId}`,
      filters: { claim_id: context.claimId },
      budget: { max_nodes: 50, max_tokens: context.maxTokens ?? 4000, max_hops: 2 },
    });
  },
});
