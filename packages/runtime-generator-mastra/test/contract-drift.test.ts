// Seam: the platform catalogue against the wire contract.
//
// The generated app is a standalone bundle, so it cannot import
// `@fde/contracts-client` for the retrieval shapes — the catalogue in
// `src/builtins.ts` is the app's copy of
// `contracts/schemas/retrieval.schema.json`. A copy that drifts is worse than no
// copy: a Tool whose schema declares fewer properties than the contract, or
// closes an object the contract leaves open, silently rejects valid calls.
//
// So this test compares the copy to the contract, property by property. It is the
// same idea as `@fde/spec`'s `contract-drift.test.ts`, for the one document whose
// types a *generated* artifact has to carry itself.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { RETRIEVAL } from '../src/index.js';
import { repoRoot } from './support/repo.js';

interface JsonSchemaObject {
  type?: string;
  required?: string[];
  properties?: Record<string, unknown>;
  additionalProperties?: boolean | Record<string, unknown>;
}

const readSchema = (name: string): { $defs: Record<string, JsonSchemaObject> } =>
  JSON.parse(readFileSync(join(repoRoot, `contracts/schemas/${name}.schema.json`), 'utf8')) as {
    $defs: Record<string, JsonSchemaObject>;
  };

const retrieval = readSchema('retrieval');
const common = readSchema('common');

/** `PolicyEvaluation` is shared, so it lives in `common.schema.json`. */
const defs: Record<string, JsonSchemaObject> = { ...retrieval.$defs, ...common.$defs };

type CatalogueObject = { schema: Record<string, unknown>; fields: ReadonlyArray<{ name: string; optional?: boolean }> };

const pairs: ReadonlyArray<{ def: string; copy: CatalogueObject }> = [
  { def: 'RetrieveRequest', copy: RETRIEVAL.request },
  { def: 'RetrieveResponse', copy: RETRIEVAL.response },
  { def: 'RetrievalItem', copy: RETRIEVAL.item },
  { def: 'Budget', copy: RETRIEVAL.budget },
  { def: 'BudgetUsed', copy: RETRIEVAL.budgetUsed },
  { def: 'Subject', copy: RETRIEVAL.subject },
  { def: 'PolicyEvaluation', copy: RETRIEVAL.policyEvaluation },
];

const asObject = (value: Record<string, unknown>): JsonSchemaObject => value as JsonSchemaObject;

describe('the retrieval catalogue is the contract', () => {
  it.each(pairs)('$def declares the same properties', ({ def, copy }) => {
    const declared = Object.keys(defs[def]?.properties ?? {}).sort();
    const copied = Object.keys(asObject(copy.schema).properties ?? {}).sort();

    expect(copied).toEqual(declared);
  });

  it.each(pairs)('$def requires the same properties', ({ def, copy }) => {
    expect([...(asObject(copy.schema).required ?? [])].sort()).toEqual([...(defs[def]?.required ?? [])].sort());
  });

  it.each(pairs)('$def agrees on whether extra properties are allowed', ({ def, copy }) => {
    const declared = defs[def]?.additionalProperties ?? true;
    const copied = asObject(copy.schema).additionalProperties ?? true;

    expect(copied).toBe(declared);
  });

  it('covers every object retrieval.schema.json defines', () => {
    const emitted = new Set(pairs.map((pair) => pair.def));
    const objects = Object.entries(retrieval.$defs)
      .filter(([, node]) => node.type === 'object')
      .map(([name]) => name);

    expect(objects.filter((name) => !emitted.has(name))).toEqual([]);
  });
});

describe('the TypeScript view matches the schema beside it', () => {
  it.each(pairs)('$def: every required property is a non-optional field', ({ def, copy }) => {
    const fields = copy.fields;
    const optional = new Set(fields.filter((field) => field.optional === true).map((field) => field.name));
    const names = new Set(fields.map((field) => field.name));

    expect([...(asObject(copy.schema).required ?? [])].filter((name) => optional.has(name))).toEqual([]);
    expect([...(asObject(copy.schema).required ?? [])].filter((name) => !names.has(name))).toEqual([]);
    expect(fields.map((field) => field.name).sort()).toEqual(Object.keys(defs[def]?.properties ?? {}).sort());
  });
});
