// PROTOTYPE — generated skeleton.
// Source: solution.yaml#/spec + docs/runtime-contract.md §9
import { Mastra } from '@mastra/core/mastra';
import { triageAgent } from './agents/triage-agent';
import { documentTriageFlow } from './workflows/document-triage-flow';

export const mastra = new Mastra({
  agents: { triageAgent },
  workflows: { documentTriageFlow },
});
