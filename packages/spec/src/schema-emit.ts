import { z } from 'zod';

/**
 * Emit the JSON Schema for a Zod definition. Used by `contract-drift.test.ts` to
 * compare the workbench's definitions against the published `contracts/`
 * schemas. Refinements (uniqueness, exclusivity, cross-field rules) are not
 * expressible in JSON Schema and are dropped here on purpose; the differential
 * corpus in the drift test is what pins their behaviour.
 */
export function emitJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  }) as Record<string, unknown>;
}
