import { canonicalJson } from './canonical.js';

/**
 * `contracts/` ↔ `@fde/spec` drift detection.
 *
 * Two definitions of the same document exist on purpose: `contracts/schemas` is
 * the published contract, `@fde/spec` is the executable definition. This module
 * compares them structurally and *names every rule it cannot compare*, so a
 * one-sided edit fails CI instead of drifting quietly.
 *
 * Rules that JSON Schema can express but Zod cannot (or that we deliberately
 * express as refinements) are `stripped`: `uniqueItems`, `minProperties`,
 * `if/then` conditional rules, and presence-exclusivity `oneOf`. The differential
 * corpus in `contract-drift.test.ts` is what pins those down behaviorally.
 */

export interface ContractDiff {
  /** Structural path in the compared schema, e.g. `spec.capabilities.hitl.required`. */
  path: string;
  kind: 'missing_in_definition' | 'missing_in_contract' | 'value_mismatch';
  contract?: unknown;
  definition?: unknown;
}

export interface StrippedRule {
  path: string;
  rule: 'uniqueItems' | 'minProperties' | 'if/then' | 'presence-oneOf';
}

export interface DriftReport {
  diffs: ContractDiff[];
  /** Contract rules the structural comparison could not check. Corpus territory. */
  stripped: StrippedRule[];
}

export interface ContractShapeInput {
  /** JSON Schema emitted from the Zod definition. */
  definition: Record<string, unknown>;
  /** Contract file name inside `contracts/schemas`, e.g. `runtime-profile.schema.json`. */
  contractFile: string;
  /** Sub-schema pointer inside the contract file, e.g. `#/$defs/RuntimeTopology`. */
  contractRoot?: string;
}

type Node = Record<string, unknown>;

const IGNORED_KEYS = new Set([
  '$schema',
  '$id',
  'title',
  'description',
  'default',
  'examples',
  'deprecated',
  '$comment',
  // `$defs` are inlined away; keeping them would compare unreachable definitions.
  '$defs',
  'definitions',
]);

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedObject(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = value[key];
  return out;
}

function pointer(doc: unknown, path: string): unknown {
  let cursor: unknown = doc;
  for (const raw of path.replace(/^#\//, '').split('/')) {
    if (raw === '' || raw === '#') continue;
    cursor = (cursor as Record<string, unknown> | undefined)?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cursor;
}

function resolveRef(ref: string, currentFile: string, docs: ReadonlyMap<string, unknown>): unknown {
  const [target, pointerPart = ''] = ref.split('#');
  const file = target === '' || target === undefined ? currentFile : target.replace(/^\.\//, '');
  const doc = docs.get(file);
  if (doc === undefined) throw new Error(`contract drift: ${currentFile} references unknown schema ${file}`);
  return pointerPart === '' ? doc : pointer(doc, `#${pointerPart}`);
}

/** Inline `$ref`s so both sides can be compared as plain trees. */
function inlineRefs(
  node: unknown,
  currentFile: string,
  docs: ReadonlyMap<string, unknown>,
  seen: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(node)) return node.map((item) => inlineRefs(item, currentFile, docs, seen));
  if (!isNode(node)) return node;

  if (typeof node['$ref'] === 'string') {
    const ref = node['$ref'];
    const key = `${currentFile}#${ref}`;
    if (seen.has(key)) throw new Error(`contract drift: circular $ref ${key}`);
    const target = resolveRef(ref, currentFile, docs);
    // A ref into another file changes the base for that file's own internal refs.
    const targetFile = ref.includes('.') ? ref.split('#')[0]!.replace(/^\.\//, '') : currentFile;
    const nextSeen = new Set(seen);
    nextSeen.add(key);
    const rest = Object.fromEntries(Object.entries(node).filter(([name]) => name !== '$ref'));
    const resolved = inlineRefs(target, targetFile, docs, nextSeen) as Node;
    return inlineRefs({ ...resolved, ...rest }, targetFile, docs, nextSeen);
  }

  const out: Node = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = inlineRefs(value, currentFile, docs, seen);
  }
  return out;
}

const PRESENCE_ONLY = (variant: Node): boolean =>
  Object.keys(variant).every((key) => key === 'required');

/**
 * Flatten the two union shapes the contract uses for "exactly one of":
 * - presence-only variants (`{required:[x]}`) — Zod expresses this as a refinement;
 * - full object variants that differ only by which field they require — merged so
 *   the compared shape is the flat optional-property object Zod produces.
 */
function flattenPresenceUnion(node: Node, path: string, stripped: StrippedRule[]): Node {
  const key = node['oneOf'] !== undefined ? 'oneOf' : node['anyOf'] !== undefined ? 'anyOf' : undefined;
  if (key === undefined) return node;
  const variants = node[key];
  if (!Array.isArray(variants)) return node;

  const nodes = variants.filter(isNode);
  if (nodes.length !== variants.length) return node;
  if (!nodes.every((variant) => PRESENCE_ONLY(variant) || variant['type'] === 'object')) return node;

  stripped.push({ path, rule: 'presence-oneOf' });
  const merged: Node = { ...node };
  delete merged['oneOf'];
  delete merged['anyOf'];

  if (nodes.every(PRESENCE_ONLY)) return merged;
  if (merged['type'] === undefined) merged['type'] = 'object';

  const properties: Record<string, unknown> = { ...((node['properties'] as Record<string, unknown> | undefined) ?? {}) };
  let additionalProperties = node['additionalProperties'];
  for (const variant of nodes) {
    for (const [name, property] of Object.entries((variant['properties'] as Record<string, unknown> | undefined) ?? {})) {
      if (properties[name] !== undefined && canonicalJson(properties[name]) !== canonicalJson(property)) {
        throw new Error(`contract drift: ${path} unions disagree about property ${name}`);
      }
      properties[name] = property;
    }
    if (additionalProperties === undefined) additionalProperties = variant['additionalProperties'];
  }
  merged['properties'] = properties;
  if (additionalProperties !== undefined) merged['additionalProperties'] = additionalProperties;
  return merged;
}

/** Normalize one side: inline refs, drop docs/noise, flatten presence unions, record stripped rules. */
function normalize(node: unknown, path: string, stripped: StrippedRule[]): unknown {
  if (Array.isArray(node)) return node.map((item, index) => normalize(item, `${path}[${index}]`, stripped));
  if (!isNode(node)) return node;

  let out = flattenPresenceUnion(node as Node, path, stripped);
  out = { ...out };

  for (const key of IGNORED_KEYS) delete out[key];

  if (out['uniqueItems'] !== undefined) {
    stripped.push({ path, rule: 'uniqueItems' });
    delete out['uniqueItems'];
  }
  if (out['minProperties'] !== undefined) {
    stripped.push({ path, rule: 'minProperties' });
    delete out['minProperties'];
  }
  // Zod turns `z.number().int()` into the full safe-integer range; the contract
  // only says "integer".
  if (out['maximum'] === Number.MAX_SAFE_INTEGER) delete out['maximum'];
  if (out['minimum'] === Number.MIN_SAFE_INTEGER) delete out['minimum'];

  if (out['if'] !== undefined || out['then'] !== undefined || out['else'] !== undefined) {
    stripped.push({ path, rule: 'if/then' });
    delete out['if'];
    delete out['then'];
    delete out['else'];
  }

  const result: Node = {};
  for (const [key, value] of Object.entries(out)) {
    if (key === 'properties' && isNode(value)) {
      result[key] = sortedObject(
        Object.fromEntries(
          Object.entries(value).map(([name, schema]) => [name, normalize(schema, `${path}.properties.${name}`, stripped)]),
        ),
      );
      continue;
    }
    if (key === 'propertyNames' && isNode(value)) {
      // JSON object keys are always strings; the contract omits the redundant type.
      const normalized = normalize(value, `${path}.propertyNames`, stripped) as Node;
      const withoutType = { ...normalized };
      if (withoutType['type'] === 'string') delete withoutType['type'];
      result[key] = withoutType;
      continue;
    }
    if (key === 'pattern' && typeof value === 'string') {
      // `\/` and `/` are the same character class member in ECMA-262; Zod always
      // escapes the slash, the contract does not.
      result[key] = value.replace(/\\\//g, '/');
      continue;
    }
    if (key === 'required' && Array.isArray(value)) {
      result[key] = [...value].sort();
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf' || key === 'allOf') && Array.isArray(value)) {
      const variants = value
        .map((variant, index) => normalize(variant, `${path}.${key}[${index}]`, stripped))
        .filter((variant) => canonicalJson(variant) !== '{}')
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)));
      if (variants.length > 0) result[key] = variants;
      continue;
    }
    result[key] = normalize(value, `${path}.${key}`, stripped);
  }
  return sortedObject(result);
}

function joinPath(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

function diffNodes(contract: unknown, definition: unknown, path: string, diffs: ContractDiff[]): void {
  if (contract === undefined && definition === undefined) return;
  if (contract === undefined) {
    diffs.push({ path, kind: 'missing_in_contract', definition });
    return;
  }
  if (definition === undefined) {
    diffs.push({ path, kind: 'missing_in_definition', contract });
    return;
  }
  if (isNode(contract) && isNode(definition)) {
    const keys = [...new Set([...Object.keys(contract), ...Object.keys(definition)])].sort();
    for (const key of keys) {
      diffNodes(contract[key], definition[key], joinPath(path, key), diffs);
    }
    return;
  }
  if (canonicalJson(contract) !== canonicalJson(definition)) {
    diffs.push({ path, kind: 'value_mismatch', contract, definition });
  }
}

/**
 * Compare the JSON Schema emitted from a Zod definition against the published
 * contract. Returns every structural difference plus the rules that were not
 * compared at all.
 */
export function diffContractShape(input: ContractShapeInput, docs: ReadonlyMap<string, unknown>): DriftReport {
  const stripped: StrippedRule[] = [];
  const contractFile = input.contractFile;
  const contractDoc = docs.get(contractFile);
  if (contractDoc === undefined) throw new Error(`contract drift: ${contractFile} is not loaded`);

  const rawContract = input.contractRoot === undefined ? contractDoc : pointer(contractDoc, input.contractRoot);
  if (rawContract === undefined) throw new Error(`contract drift: ${contractFile}#${String(input.contractRoot)} does not exist`);

  const contract = normalize(inlineRefs(rawContract, contractFile, docs), '', stripped);
  // Zod inlines its own `$defs`, so a definition never carries cross-file refs.
  const definition = normalize(inlineRefs(input.definition, contractFile, docs), '', stripped);

  const diffs: ContractDiff[] = [];
  diffNodes(contract, definition, '', diffs);

  return { diffs, stripped };
}
