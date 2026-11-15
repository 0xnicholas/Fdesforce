# PROTOTYPE — generated skeleton.
# Source: solution.yaml#/spec/agents/triage-agent + files/prompts/triage.md
import { Agent } from '@mastra/core/agent';
import { claimsLookup } from '../tools/claims-lookup';
import { retrieveContext } from '../tools/retrieve-context';

// The build resolves the named model profile from the target Environment.
// GAP: the profile name is not versioned or pinned in solution.lock, so the
// same Spec + lock can produce a different model binding per Environment.
export const triageAgent = new Agent({
  id: 'triage-agent',
  name: 'Acme claims triage agent',
  instructions: `You are an assistant for Acme claims adjusters.

Rules:
1. Use only the retrieved context. Every factual statement must cite a source
   from the context block as source_ref@version.
2. If the context is marked incomplete (degraded=true), say so explicitly.
3. Never reveal customer names, email addresses, or full claim identifiers.
4. If the claim amount exceeds the approval threshold, propose the outcome and
   stop; the workflow will request human approval.
5. If the retrieved facts conflict, surface both candidates and do not choose
   silently.

Return a structured result: { claimId, outcome, rationale, citedSources[] }.`,
  model: 'azure-openai/gpt-5.1',
  tools: {
    retrieveContext,
    claimsLookup,
  },
});
