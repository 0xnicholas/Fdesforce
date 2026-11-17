import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import {
  digestFiles,
  parseContextEvalSuite,
  parseContextPackage,
  parseContextPackageRevision,
  parseContextRecipe,
  parseContextSource,
  parseMapping,
  parsePermissionProfile,
  parseSemanticModel,
  type CheckContextPackageInput,
  type ContextPackageDocuments,
  type Diagnostic,
  type Digest,
  type ParseResult,
} from '../../src/index.js';
import { readText, repoRoot } from './repo.js';

/**
 * The checked-in Acme CCP, loaded the way the CLI loads it: the manifest names the
 * package, every named file is parsed by kind, and the digests are recomputed from
 * disk. Kept here (not in `src/`) because filesystem access belongs to
 * `packages/cli`; the loader exists so `checkContextPackage` can be exercised as
 * the pure function it is.
 */
export const examplePackageDir = 'examples/semantic/acme';
export const exampleOntologyRoot = 'platform/templates/ontology';
export const exampleConnectorRoot = 'examples/spec/acme/customer/connectors';

export function walkPackage(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(join(dir, relative)).isDirectory()) files.push(...walkPackage(dir, relative));
    else files.push(relative);
  }
  return files;
}

export interface LoadedPackage {
  input: CheckContextPackageInput;
  errors: Diagnostic[];
}

export function loadPackage(dir: string): LoadedPackage {
  const errors: Diagnostic[] = [];
  const root = join(repoRoot, dir);
  const files = walkPackage(root);

  const parse = <T>(path: string, parseDocument: (value: unknown) => ParseResult<T>): T | undefined => {
    const result = parseDocument(parseYaml(readFileSync(join(root, path), 'utf8')));
    if (result.ok) return result.value;
    errors.push(...result.errors.map((error) => ({ ...error, path: `${path}: ${error.path ?? ''}` })));
    return undefined;
  };

  const manifest = parse('manifest.yaml', parseContextPackage);
  const documents: ContextPackageDocuments = { contextSources: {}, mappings: {}, recipes: {}, evals: {} };
  if (manifest === undefined) return { errors, input: { manifest: undefined as never, documents, files } };

  documents.semanticModel = parse(manifest.spec.semanticModelRef, parseSemanticModel);
  for (const path of manifest.spec.contextSources) {
    const document = parse(path, parseContextSource);
    if (document !== undefined) documents.contextSources[path] = document;
  }
  for (const entry of documents.semanticModel?.spec.entityMappings ?? []) {
    const document = parse(entry.ref, parseMapping);
    if (document !== undefined) documents.mappings[entry.ref] = document;
  }
  for (const path of manifest.spec.recipes) {
    const document = parse(path, parseContextRecipe);
    if (document !== undefined) documents.recipes[path] = document;
  }
  documents.permissions = parse(manifest.spec.permissionsRef, parsePermissionProfile);
  for (const path of manifest.spec.evals) {
    const document = parse(path, parseContextEvalSuite);
    if (document !== undefined) documents.evals[path] = document;
  }

  // `revisions/**` records the freeze; the package digest covers everything else.
  const content = files.filter((path) => !path.startsWith('revisions/'));
  const fileSet = digestFiles(content.map((path) => ({ path, content: readText(join(dir, path)) })));

  const revisionPath = `revisions/${manifest.metadata.version}.yaml`;
  const revision = files.includes(revisionPath) ? parse(revisionPath, parseContextPackageRevision) : undefined;

  const input: CheckContextPackageInput = {
    manifest,
    documents,
    files,
    digest: fileSet.digest,
    fileDigests: fileSet.files,
    ontologyModules: vendoredOntologyModules(),
    connectors: vendoredConnectors(),
    compatibility: pinnedSchemaVersions(),
    ...(revision === undefined ? {} : { revision }),
  };
  return { input, errors };
}

/** Vendored Domain Ontology module digests, keyed `name@version` — what `DirCatalog` resolves. */
export function vendoredOntologyModules(): Record<string, Digest> {
  const root = join(repoRoot, exampleOntologyRoot);
  const modules: Record<string, Digest> = {};
  for (const name of readdirSync(root).sort()) {
    for (const version of readdirSync(join(root, name)).sort()) {
      const dir = join(root, name, version);
      const files = walkPackage(dir);
      modules[`${name}@${version}`] = digestFiles(
        files.map((path) => ({ path, content: readFileSync(join(dir, path), 'utf8') })),
      ).digest;
    }
  }
  return modules;
}

/** The pinned graph/audit schema versions (`platform/toolchain.yaml`). */
export function pinnedSchemaVersions(): { graphSchema: string; auditSchema: string } {
  const toolchain = parseYaml(readFileSync(join(repoRoot, 'platform/toolchain.yaml'), 'utf8')) as {
    spec?: { schemas?: { graph?: number; audit?: number } };
  };
  return {
    graphSchema: String(toolchain.spec?.schemas?.graph ?? 1),
    auditSchema: String(toolchain.spec?.schemas?.audit ?? 1),
  };
}

/** Connector ids vendored in the workspace — what `DocCatalog` would index. */
export function vendoredConnectors(): string[] {
  const root = join(repoRoot, exampleConnectorRoot);
  return readdirSync(root)
    .filter((name) => name.endsWith('.yaml'))
    .map((name) => {
      const document = parseYaml(readFileSync(join(root, name), 'utf8')) as { metadata?: { name?: string } };
      return document.metadata?.name ?? name;
    })
    .sort();
}
