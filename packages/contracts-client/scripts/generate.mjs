#!/usr/bin/env node
// Generate TypeScript wire types and clients from `contracts/`.
//
// `contracts/` (OpenAPI 3.1 + JSON Schema 2020-12) is the single source of truth
// for the wire surface. This script is the only producer of `src/generated/`;
// nothing under that directory may be hand-edited, and `--check` fails CI when
// the committed output no longer matches `contracts/`.
//
// Deterministic by construction: files are visited in sorted order, document
// order is preserved inside a file, and output depends on nothing else (no
// timestamps, no environment, no network).
//
// Usage:
//   node scripts/generate.mjs          # write src/generated/**
//   node scripts/generate.mjs --check  # exit 1 when the committed output is stale

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '../..');
const contractsDir = join(repoRoot, 'contracts');
const schemasDir = join(contractsDir, 'schemas');
const outDir = join(packageRoot, 'src/generated');

const BANNER = (source) =>
  `// GENERATED from ${source} — do not edit.\n// Regenerate with \`pnpm generate\`; CI runs \`pnpm generate:check\`.\n`;

const pascal = (value) =>
  value
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join('');

const camel = (value) => {
  const name = pascal(value);
  return name === '' ? name : name[0].toLowerCase() + name.slice(1);
};

const identifier = (name) => `'${name}'`;
const propertyKey = (name) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : identifier(name));

// ---------------------------------------------------------------------------
// JSON Schema → TypeScript
// ---------------------------------------------------------------------------

const loadJson = (file) => JSON.parse(readFileSync(join(schemasDir, file), 'utf8'));

const schemaFiles = readdirSync(schemasDir)
  .filter((file) => file.endsWith('.json'))
  .sort();

const documents = new Map(schemaFiles.map((file) => [file, loadJson(file)]));

/** `$defs` name → exported TypeScript name, resolving cross-file collisions. */
const typeNames = new Map();
{
  const byName = new Map();
  for (const file of schemaFiles) {
    for (const name of Object.keys(documents.get(file).$defs ?? {})) {
      byName.set(name, [...(byName.get(name) ?? []), file]);
    }
  }
  for (const [name, files] of byName) {
    if (files.length === 1) {
      typeNames.set(`${files[0]}#${name}`, name);
      continue;
    }
    const shapes = files.map((file) => JSON.stringify(documents.get(file).$defs[name]));
    if (new Set(shapes).size === 1) {
      // Identical definitions in two files: one type is the honest output.
      for (const file of files) typeNames.set(`${file}#${name}`, name);
      continue;
    }
    for (const file of files) {
      const stem = pascal(file.replace(/\.schema\.json$/, ''));
      typeNames.set(`${file}#${name}`, `${stem}${name}`);
    }
  }
}

/** Names collected while emitting an OpenAPI module, used to build its imports. */
let referencedTypes = null;

const refToType = (ref, currentFile) => {
  const [target, pointerPart = ''] = ref.split('#');
  // Schema files use `./common.schema.json`; OpenAPI files use `./schemas/common.schema.json`.
  const file = target === '' ? currentFile : target.replace(/^\.\//, '').replace(/^schemas\//, '');
  if (pointerPart === '') {
    // A whole-file ref (`./schemas/error.schema.json`): follow its root ref.
    const document = documents.get(file);
    if (document?.$ref !== undefined) return refToType(document.$ref, file);
    throw new Error(`generate: ${ref} does not resolve to a named type`);
  }
  const match = /^\/\$defs\/(.+)$/.exec(pointerPart);
  if (match === null) {
    throw new Error(`generate: unsupported $ref ${ref} (only #/$defs/* is generated)`);
  }
  const name = typeNames.get(`${file}#${match[1]}`);
  if (name === undefined) throw new Error(`generate: ${currentFile} references unknown ${ref}`);
  referencedTypes?.add(name);
  return name;
};

const literal = (value) => (typeof value === 'string' ? JSON.stringify(value) : String(value));

const docComment = (schema, indent) => {
  const description = schema.description ?? schema.title;
  if (typeof description !== 'string' || description.trim() === '') return '';
  const text = description.trim().replace(/\s+/g, ' ');
  return `${indent}/** ${text.replace(/\*\//g, '*\\/')} */\n`;
};

const objectType = (schema, currentFile, indent) => {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(properties);
  const inner = `${indent}  `;

  if (entries.length === 0) {
    const additional = schema.additionalProperties;
    if (additional === true || additional === undefined) return 'Record<string, unknown>';
    if (additional === false) return 'Record<string, never>';
    return `Record<string, ${tsType(additional, currentFile, indent)}>`;
  }

  const lines = entries.map(([name, property]) => {
    const optional = required.has(name) ? '' : '?';
    return `${docComment(property, inner)}${inner}${propertyKey(name)}${optional}: ${tsType(property, currentFile, inner)};`;
  });
  return `{\n${lines.join('\n')}\n${indent}}`;
};

const tsType = (schema, currentFile, indent = '') => {
  if (schema === true) return 'unknown';
  if (schema === false) return 'never';
  if (schema.$ref !== undefined) return refToType(schema.$ref, currentFile);
  if (schema.const !== undefined) return literal(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(' | ');

  const union = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(union)) return union.map((variant) => tsType(variant, currentFile, indent)).join(' | ');
  if (Array.isArray(schema.allOf)) return schema.allOf.map((variant) => tsType(variant, currentFile, indent)).join(' & ');

  const type = Array.isArray(schema.type) ? schema.type.filter((entry) => entry !== 'null') : schema.type;
  const nullable = Array.isArray(schema.type) && schema.type.includes('null');

  let result;
  switch (type) {
    case 'string':
      result = 'string';
      break;
    case 'integer':
    case 'number':
      result = 'number';
      break;
    case 'boolean':
      result = 'boolean';
      break;
    case 'null':
      result = 'null';
      break;
    case 'array':
      result = `Array<${tsType(schema.items ?? true, currentFile, indent)}>`;
      break;
    case 'object':
      result = objectType(schema, currentFile, indent);
      break;
    default:
      result =
        schema.properties !== undefined || schema.additionalProperties !== undefined
          ? objectType(schema, currentFile, indent)
          : 'unknown';
  }
  return nullable ? `${result} | null` : result;
};

// ---------------------------------------------------------------------------
// Emit: schemas.ts
// ---------------------------------------------------------------------------

const emitSchemas = () => {
  const sections = [];
  // A name emitted once is the same definition everywhere it appears.
  const emitted = new Set();
  for (const file of schemaFiles) {
    const document = documents.get(file);
    const defs = document.$defs ?? {};
    const blocks = [];

    for (const [name, schema] of Object.entries(defs)) {
      const typeName = typeNames.get(`${file}#${name}`);
      if (emitted.has(typeName)) continue;
      emitted.add(typeName);

      const comment = docComment(schema, '');
      const isObject =
        schema.type === 'object' &&
        schema.properties !== undefined &&
        !schema.oneOf &&
        !schema.anyOf &&
        !schema.allOf &&
        schema.enum === undefined;
      const body = isObject
        ? `export interface ${typeName} ${objectType(schema, file, '')}`
        : `export type ${typeName} = ${tsType(schema, file)};`;
      blocks.push(`${comment}${body}`);
    }
    sections.push(`// ---- ${file}\n\n${blocks.join('\n\n')}`);
  }

  return `${BANNER('contracts/schemas/*.json')}\n${sections.join('\n\n')}\n`;
};

// ---------------------------------------------------------------------------
// Emit: one module per OpenAPI document
// ---------------------------------------------------------------------------

const openApiFiles = readdirSync(contractsDir)
  .filter((file) => file.endsWith('.openapi.yaml'))
  .sort();

const loadOpenApi = (file) => parseYaml(readFileSync(join(contractsDir, file), 'utf8'));

const resolvePointer = (doc, ref) => {
  const [, pointerPart = ''] = ref.split('#');
  let cursor = doc;
  for (const raw of pointerPart.split('/').slice(1)) {
    cursor = cursor?.[raw.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return cursor;
};

const resolveIn = (doc, value) => (value?.$ref ? resolvePointer(doc, value.$ref) : value);

const operationSchema = (doc, operation) => {
  const resolved = resolveIn(doc, operation);
  const parameters = (resolved.parameters ?? []).map((parameter) => resolveIn(doc, parameter));
  const pathParams = parameters.filter((parameter) => parameter.in === 'path');
  const headers = parameters.filter((parameter) => parameter.in === 'header');
  const queries = parameters.filter((parameter) => parameter.in === 'query');

  const body = resolved.requestBody
    ? resolveIn(doc, resolved.requestBody).content?.['application/json']?.schema
    : undefined;

  const responses = {};
  for (const [status, response] of Object.entries(resolved.responses ?? {})) {
    const resolvedResponse = resolveIn(doc, response);
    const content = resolvedResponse.content ?? {};
    const mediaType = content['application/json'] ?? Object.values(content)[0];
    responses[status] = mediaType?.schema;
  }
  return { parameters, pathParams, headers, queries, body, responses };
};

const parameterType = (parameter, file) => tsType(parameter.schema ?? {}, file);

const apiPrefix = (file) => pascal(file.replace(/\.openapi\.yaml$/, '').replace(/-v\d+$/, ''));

const emitOpenApi = (file) => {
  const doc = loadOpenApi(file);
  const prefix = apiPrefix(file);
  const operations = [];
  referencedTypes = new Set();

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const operation = item[method];
      if (operation === undefined) continue;
      operations.push({ method, path, operation, ...operationSchema(doc, operation) });
    }
  }

  const mapName = `${prefix.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_OPERATIONS`;

  const operationMap = operations
    .map(({ operation, method, path }) => `  ${operation.operationId}: { method: '${method}', path: '${path}' },`)
    .join('\n');

  const typeAlias = (name, entries, emitValue) => {
    const body = entries.map((entry) => `  ${entry.operation.operationId}: ${emitValue(entry)};`).join('\n');
    return `export interface ${name} {\n${body}\n}`;
  };

  const withEntries = operations.filter((entry) => entry.pathParams.length > 0);
  const headerEntries = operations.filter((entry) => entry.headers.length > 0);
  const queryEntries = operations.filter((entry) => entry.queries.length > 0);
  const bodyEntries = operations.filter((entry) => entry.body !== undefined);
  const responseEntries = operations;

  const blocks = [
    `export const ${mapName} = {\n${operationMap}\n} as const;`,
    `export type ${prefix}Operation = keyof typeof ${mapName};`,
  ];

  if (withEntries.length > 0) {
    blocks.push(
      typeAlias(
        `${prefix}PathParams`,
        withEntries,
        ({ pathParams }) =>
          `{ ${pathParams
            .map((parameter) => `${propertyKey(parameter.name)}: ${parameterType(parameter, file)}`)
            .join('; ')} }`,
      ),
    );
  }
  if (headerEntries.length > 0) {
    blocks.push(
      typeAlias(
        `${prefix}Headers`,
        headerEntries,
        ({ headers }) =>
          `{ ${headers
            .map(
              (parameter) =>
                `${propertyKey(parameter.name)}${parameter.required ? '' : '?'}: ${parameterType(parameter, file)}`,
            )
            .join('; ')} }`,
      ),
    );
  }
  if (queryEntries.length > 0) {
    blocks.push(
      typeAlias(
        `${prefix}Query`,
        queryEntries,
        ({ queries }) =>
          `{ ${queries
            .map(
              (parameter) =>
                `${propertyKey(parameter.name)}${parameter.required ? '' : '?'}: ${parameterType(parameter, file)}`,
            )
            .join('; ')} }`,
      ),
    );
  }
  if (bodyEntries.length > 0) {
    blocks.push(typeAlias(`${prefix}Bodies`, bodyEntries, ({ body }) => tsType(body, file)));
  }
  blocks.push(
    typeAlias(
      `${prefix}Responses`,
      responseEntries,
      ({ responses }) =>
        `{ ${Object.entries(responses)
          .map(([status, schema]) => `${status}: ${schema === undefined ? 'undefined' : tsType(schema, file)}`)
          .join('; ')} }`,
    ),
  );

  const methods = operations
    .map((entry) => {
      const id = entry.operation.operationId;
      const inputParts = [];
      if (entry.pathParams.length > 0) inputParts.push(`pathParams: ${prefix}PathParams[${identifier(id)}]`);
      if (entry.headers.length > 0) inputParts.push(`headers: ${prefix}Headers[${identifier(id)}]`);
      if (entry.queries.length > 0) inputParts.push(`query?: ${prefix}Query[${identifier(id)}]`);
      if (entry.body !== undefined) {
        const optional = entry.operation.requestBody?.required === true ? '' : '?';
        inputParts.push(`body${optional}: ${prefix}Bodies[${identifier(id)}]`);
      }
      const input = inputParts.length === 0 ? '' : `input: { ${inputParts.join('; ')} }`;
      return `  async ${id}(${input}): Promise<ApiResult<${prefix}Responses[${identifier(id)}]>> {\n    return this.call(${identifier(id)}, ${inputParts.length === 0 ? '{}' : 'input'});\n  }`;
    })
    .join('\n\n');

  const className = `${prefix}Client`;
  const schemaImports = [...(referencedTypes ?? [])].sort();
  const imports =
    schemaImports.length === 0
      ? ''
      : `import type { ${schemaImports.join(', ')} } from './schemas.js';\n`;

  return {
    file,
    source: `${BANNER(`contracts/${file}`)}\nimport type { ApiResult, Transport } from '../transport.js';\nimport { send } from '../transport.js';\n${imports}\n${blocks.join(
      '\n\n',
    )}\n\nexport class ${className} {\n  constructor(\n    private readonly transport: Transport,\n    private readonly baseUrl: string,\n    private readonly defaultHeaders: Record<string, string> = {},\n  ) {}\n\n  private async call<K extends ${prefix}Operation>(\n    operation: K,\n    input: { pathParams?: Record<string, string>; headers?: Record<string, string | undefined>; query?: Record<string, unknown>; body?: unknown },\n  ): Promise<ApiResult<${prefix}Responses[K]>> {\n    const { method, path } = ${mapName}[operation];\n    return (await send(this.transport, {\n      method,\n      baseUrl: this.baseUrl,\n      path,\n      pathParams: input.pathParams as Record<string, string> | undefined,\n      query: input.query as Record<string, unknown> | undefined,\n      headers: { ...this.defaultHeaders, ...(input.headers as Record<string, string | undefined> | undefined) },\n      body: input.body,\n    })) as ApiResult<${prefix}Responses[K]>;\n  }\n\n${methods}\n}\n`,
    module: camel(file.replace(/\.openapi\.yaml$/, '')),
    className,
  };
};

// ---------------------------------------------------------------------------
// Write or check
// ---------------------------------------------------------------------------

const outputs = new Map();
outputs.set('schemas.ts', emitSchemas());
const modules = [];
for (const file of openApiFiles) {
  const generated = emitOpenApi(file);
  outputs.set(`${generated.module}.ts`, generated.source);
  modules.push(generated);
}

outputs.set(
  'index.ts',
  `${BANNER('contracts/')}\nexport * from './schemas.js';\n${modules
    .map((generated) => `export * from './${generated.module}.js';`)
    .join('\n')}\n`,
);

const check = process.argv.includes('--check');
const stale = [];
for (const [name, content] of outputs) {
  const path = join(outDir, name);
  if (check) {
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    if (current !== content) stale.push(relative(packageRoot, path));
    continue;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

if (check) {
  if (stale.length > 0) {
    console.error(`contracts/ and src/generated/ disagree; run \`pnpm generate\`:\n  ${stale.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`src/generated/ is up to date (${outputs.size} files).`);
} else {
  console.log(`wrote ${outputs.size} files to ${relative(repoRoot, outDir)}`);
}
