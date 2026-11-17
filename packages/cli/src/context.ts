import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  RUNTIME_CONTRACT_MAJOR,
  checkContextPackage,
  contextPackageFiles,
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
  type ContextPackage,
  type ContextPackageDocuments,
  type ContextPackageRevision,
  type Digest,
  type ParseResult,
  type SemanticModel,
} from '@fde/spec';
import { parseDocument, stringify as stringifyYaml } from 'yaml';

import { buildCatalogues, type Catalogues } from './artifacts.js';
import { loadToolchain } from './project.js';
import { isFile, readDocument, readText, walkTree } from './fsutil.js';
import { parseRef } from './refs.js';
import { dedupe, diagnostic, type Diagnostic, type Report } from './types.js';
import type { Workspace } from './workspace.js';

/**
 * The Customer Context Package as the CLI sees it: the documents off disk, the
 * content digests, and the cross-asset facts (vendored ontology modules, vendored
 * connectors) that only a resolved workspace knows.
 *
 * This module owns file loading, digesting and the freeze write; the rules that
 * need no filesystem live in `@fde/spec`'s `checkContextPackage`, the same split as
 * `project.ts` + `checkSolution` for the Spec.
 */
export interface ContextPackageProject {
  dir: string;
  /** Package-relative paths, sorted, excluding `revisions/**`. */
  files: string[];
  /** The same file set as text, keyed exactly like `files`. */
  contents: Record<string, string>;
  fileDigests: Record<string, Digest>;
  /** Digest over `files`; undefined when the tree is unreadable (a symlink, a link loop). */
  digest?: Digest;
  manifest?: ContextPackage;
  documents: ContextPackageDocuments;
  revision?: ContextPackageRevision;
  /** Vendored ontology module digests, keyed `name@version`. */
  ontologyModules: Record<string, Digest>;
  connectors: string[];
  /** The pinned platform schema versions the package's compatibility claim is checked against. */
  compatibility: { graphSchema: string; auditSchema: string };
  catalogProblems: Diagnostic[];
  /** Read/parse diagnostics, reported alongside the cross-document findings. */
  errors: Diagnostic[];
}

const MANIFEST = 'manifest.yaml';

export function loadContextPackage(input: { dir: string; workspace: Workspace }): ContextPackageProject {
  const dir = resolve(input.dir);
  const errors: Diagnostic[] = [];
  const documents: ContextPackageDocuments = { contextSources: {}, mappings: {}, recipes: {}, evals: {} };

  const tree = walkTree(dir);
  for (const link of tree.links) {
    errors.push(
      diagnostic('context_file_invalid', `${link} is a symlink; a package is its content and may not depend on a path outside it`, {
        path: link,
        remediation: 'copy the file into the package instead of linking it',
      }),
    );
  }
  // `revisions/**` records freezes; it is provenance about the content, not content.
  const files = contextPackageFiles(tree.files);
  const contents: Record<string, string> = {};
  for (const path of files) contents[path] = readText(join(dir, path));

  let fileDigests: Record<string, Digest> = {};
  let digest: Digest | undefined;
  if (errors.length === 0 && files.length > 0) {
    const set = digestFiles(files.map((path) => ({ path, content: contents[path] as string })));
    fileDigests = set.files;
    digest = set.digest;
  }

  const catalogues = buildCatalogues({ platformRoot: input.workspace.platformRoot, assets: input.workspace.assets });

  const manifestPath = join(dir, MANIFEST);
  const manifest = readAndParse(manifestPath, MANIFEST, parseContextPackage, errors);

  if (manifest !== undefined) {
    const documentsErrors: Diagnostic[] = [];
    documents.semanticModel = readAndParse(
      join(dir, manifest.spec.semanticModelRef),
      manifest.spec.semanticModelRef,
      parseSemanticModel,
      documentsErrors,
    );
    for (const path of manifest.spec.contextSources) {
      const document = readAndParse(join(dir, path), path, parseContextSource, documentsErrors);
      if (document !== undefined) documents.contextSources[path] = document;
    }
    for (const entry of documents.semanticModel?.spec.entityMappings ?? []) {
      const document = readAndParse(join(dir, entry.ref), entry.ref, parseMapping, documentsErrors);
      if (document !== undefined) documents.mappings[entry.ref] = document;
    }
    for (const path of manifest.spec.recipes) {
      const document = readAndParse(join(dir, path), path, parseContextRecipe, documentsErrors);
      if (document !== undefined) documents.recipes[path] = document;
    }
    documents.permissions = readAndParse(
      join(dir, manifest.spec.permissionsRef),
      manifest.spec.permissionsRef,
      parsePermissionProfile,
      documentsErrors,
    );
    for (const path of manifest.spec.evals) {
      const document = readAndParse(join(dir, path), path, parseContextEvalSuite, documentsErrors);
      if (document !== undefined) documents.evals[path] = document;
    }
    // A missing file is a cross-document finding (`context_file_missing`), not a
    // parse error: `checkContextPackage` says which reference dangles.
    errors.push(...documentsErrors.filter((error) => error.code !== 'document_missing'));
  }

  const revisionPath = manifest === undefined ? undefined : `revisions/${manifest.metadata.version}.yaml`;
  const revision =
    revisionPath !== undefined && isFile(join(dir, revisionPath))
      ? readAndParse(join(dir, revisionPath), revisionPath, parseContextPackageRevision, errors)
      : undefined;

  return {
    dir,
    files,
    contents,
    fileDigests,
    ...(digest === undefined ? {} : { digest }),
    ...(manifest === undefined ? {} : { manifest }),
    documents,
    ...(revision === undefined ? {} : { revision }),
    ontologyModules: resolveOntologyModules(catalogues, documents.semanticModel, errors),
    connectors: catalogues.connectors.all().map((connector) => connector.name),
    ...compatibilityOf(input.workspace.platformRoot),
    catalogProblems: catalogues.problems,
    errors,
  };
}

function readAndParse<T>(
  path: string,
  slot: string,
  parseDocument: (value: unknown) => ParseResult<T>,
  errors: Diagnostic[],
): T | undefined {
  const document = readDocument(path, slot);
  if (!document.ok) {
    errors.push({ ...document.error, path: slot });
    return undefined;
  }
  const parsed = parseDocument(document.value);
  if (parsed.ok) return parsed.value;
  errors.push(...parsed.errors.map((error) => ({ ...error, path: `${slot}${error.path === undefined ? '' : `: ${error.path}`}` })));
  return undefined;
}

/**
 * The vendored Domain Ontology modules the package was modelled against. The
 * package declares exact `name@version` refs, so this is a lookup, not a range
 * resolution — and an unvendored module is a `context_reference_unknown` below.
 */
function resolveOntologyModules(
  catalogues: Catalogues,
  semanticModel: SemanticModel | undefined,
  errors: Diagnostic[],
): Record<string, Digest> {
  const modules: Record<string, Digest> = {};
  for (const [index, module] of (semanticModel?.spec.ontology.modules ?? []).entries()) {
    const resolved = catalogues.templates.ontology.resolve(module.ref, `semantic-model spec.ontology.modules[${index}]`);
    if (!resolved.ok) {
      errors.push({
        ...resolved.error,
        code: 'context_reference_unknown',
        message: `ontology module ${module.ref} is not in the platform store`,
        remediation: `vendor ${parseRef(module.ref).name} under platform/templates/ontology, or fix the module ref`,
      });
      continue;
    }
    if (`${resolved.value.name}@${resolved.value.version}` !== module.ref) {
      errors.push(
        diagnostic('context_reference_unknown', `ontology module ${module.ref} is not a vendored version`, {
          path: `semantic-model spec.ontology.modules[${index}]`,
          remediation: `a frozen package names an exact module version; write ${resolved.value.name}@${resolved.value.version}`,
        }),
      );
      continue;
    }
    modules[module.ref] = resolved.value.digest;
  }
  return modules;
}

/** Everything the reference rules need, assembled once. */
export function contextPackageInput(project: ContextPackageProject): CheckContextPackageInput {
  if (project.manifest === undefined) throw new Error('cannot check a package with no manifest');
  return {
    manifest: project.manifest,
    documents: project.documents,
    files: project.files,
    ...(project.digest === undefined ? {} : { digest: project.digest }),
    fileDigests: project.fileDigests,
    ontologyModules: project.ontologyModules,
    connectors: project.connectors,
    compatibility: project.compatibility,
    ...(project.revision === undefined ? {} : { revision: project.revision }),
  };
}

export interface ValidateContextOptions {
  /**
   * `freeze` turns the "no Context Eval question" warning into an error: freezing a
   * package nothing measured is exactly what the L1 gate exists to prevent. The
   * *run* of that suite needs a context-service, which is not part of this slice.
   */
  requireEval?: boolean;
}

export function validateContextPackage(project: ContextPackageProject, options: ValidateContextOptions = {}): Report {
  const errors: Diagnostic[] = [...project.errors];
  const warnings: Diagnostic[] = [...project.catalogProblems];

  if (project.manifest !== undefined) {
    const report = checkContextPackage(contextPackageInput(project));
    errors.push(...report.errors);
    warnings.push(...report.warnings);
  }

  if (options.requireEval !== true) return { errors: dedupe(errors), warnings: dedupe(warnings) };

  const kept: Diagnostic[] = [];
  for (const warning of warnings) {
    if (warning.code !== 'context_eval_missing') {
      kept.push(warning);
      continue;
    }
    errors.push({
      ...warning,
      remediation: 'add at least one Context Eval question to the suite the package ships, so the freeze is gated by a measurement',
    });
  }
  return { errors: dedupe(errors), warnings: dedupe(kept) };
}

export interface FreezeOptions {
  /** Who is signing the freeze (`fde://acme/fde-lead`); recorded, never inferred. */
  actor: string;
  /** The commit the content came from, when the caller has one. */
  sourceCommit?: string;
  /** Injected so a test can name the moment; never read from the clock in `src/`. */
  now: Date;
}

export type FreezeResult =
  | { status: 'frozen'; revision: ContextPackageRevision; revisionPath: string; manifestChanged: boolean; errors: [] }
  | { status: 'unchanged'; revision: ContextPackageRevision; revisionPath: string; manifestChanged: false; errors: [] }
  | { status: 'refused'; errors: Diagnostic[] };

/**
 * Write the frozen record — or refuse.
 *
 * Freeze is the only writer, and it writes two things at most: the manifest's
 * `metadata.status: frozen` (surgically, so comments survive) and
 * `revisions/<version>.yaml`. That file is the content address: its `digest` is
 * the package digest with `revisions/**` excluded, which is also what
 * `solution.lock` pins and what the ingest job names.
 *
 * Re-running freeze over unchanged content is a no-op, not a re-stamp: the digest
 * is the identity, the timestamp is provenance. Changing content at a frozen
 * version is refused outright — the fix is a new `metadata.version`.
 */
export function freezeContextPackage(project: ContextPackageProject, options: FreezeOptions): FreezeResult {
  // `context_package_not_frozen` is the inconsistency freeze is here to repair
  // (`status: frozen` with no revision yet), so it is not a reason to refuse.
  const report = validateContextPackage(project, { requireEval: true });
  const blocking = report.errors.filter((error) => error.code !== 'context_package_not_frozen');
  if (blocking.length > 0) return { status: 'refused', errors: blocking };

  const manifest = project.manifest;
  if (manifest === undefined) throw new Error('validated a package with no manifest');
  const version = manifest.metadata.version;
  const revisionPath = `revisions/${version}.yaml`;

  if (manifest.metadata.status === 'draft') {
    return {
      status: 'refused',
      errors: [
        diagnostic('context_package_not_validated', 'the manifest still declares status draft', {
          path: 'metadata.status',
          remediation: 'mark the package `status: validated` once it validates, then freeze; a draft is not a release',
        }),
      ],
    };
  }

  // Reaching this point with a revision means validation already proved it matches
  // the content (a mismatch is `context_package_modified`, which is blocking above).
  // So freezing again is a no-op rather than a re-stamp: the digest is the identity.
  if (project.revision !== undefined) {
    return {
      status: 'unchanged',
      revision: project.revision,
      revisionPath: join(project.dir, revisionPath),
      manifestChanged: false,
      errors: [],
    };
  }

  // The digest must cover the *frozen* manifest, so flip the status first and
  // re-digest; otherwise the recorded address would describe a draft.
  const manifestText =
    manifest.metadata.status === 'frozen' ? (project.contents[MANIFEST] as string) : freezeStatus(project.contents[MANIFEST] as string);
  const contents: Record<string, string> = { ...project.contents, [MANIFEST]: manifestText };
  const set = digestFiles(Object.entries(contents).map(([path, content]) => ({ path, content })));

  const revision: ContextPackageRevision = {
    apiVersion: 'fde.dev/v0',
    kind: 'ContextPackageRevision',
    metadata: { customer: manifest.metadata.customer, name: manifest.metadata.name, version },
    spec: {
      digest: set.digest,
      files: set.files,
      frozenAt: options.now.toISOString(),
      frozenBy: options.actor,
      ...(options.sourceCommit === undefined ? {} : { sourceCommit: options.sourceCommit }),
    },
  };

  const manifestChanged = manifestText !== project.contents[MANIFEST];
  if (manifestChanged) writeFileSync(join(project.dir, MANIFEST), manifestText);
  const target = join(project.dir, revisionPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderRevision(revision));

  return { status: 'frozen', revision, revisionPath: target, manifestChanged, errors: [] };
}

/** `metadata.status: frozen`, edited in place so the author's comments survive. */
function freezeStatus(text: string): string {
  const document = parseDocument(text);
  document.setIn(['metadata', 'status'], 'frozen');
  return document.toString();
}

const REVISION_HEADER = [
  '# Generated by `fde context freeze` — do not hand-edit.',
  '#',
  '# The frozen revision of this Context Package version: `spec.digest` is the',
  '# content digest of the package (everything but `revisions/**`), the same value',
  '# `solution.lock` pins and the ingest job names. A frozen version is immutable;',
  '# change it by bumping `metadata.version` and freezing again.',
  '',
].join('\n');

export function renderRevision(revision: ContextPackageRevision): string {
  return REVISION_HEADER + stringifyYaml(revision, { lineWidth: 0, aliasDuplicateObjects: false });
}

// ---------------------------------------------------------------------------
// fde context init — the scaffold
// ---------------------------------------------------------------------------

export interface ScaffoldOptions {
  customer: string;
  /** The package name (`acme-claims-context`). */
  name: string;
  version: string;
  /** Recorded as `provenance.createdBy` and `provenance.createdAt`. */
  actor: string;
  createdAt: Date;
  /** Graph/audit schema versions from the pinned toolchain. */
  schemas: { graph: number | string; audit: number | string };
  contractMajor: string;
}

/**
 * A draft package, complete enough to validate and honest enough to be useless
 * until an author does the modelling: no ontology module is chosen, no source is
 * registered, no mapping is written, and the eval suite has no questions — so
 * `freeze` refuses until the slice exists. Scaffolds that "look modelled" are how
 * a customer ends up with semantics nobody chose.
 */
export function scaffoldContextPackage(options: ScaffoldOptions): Record<string, string> {
  const modelName = options.name.replace(/-context$/, '') || options.name;
  const recipeName = `${modelName}-context`;
  const recipePath = `recipes/${recipeName}.yaml`;
  const evalPath = `evals/${recipeName}.golden.yaml`;

  const manifest = {
    apiVersion: 'fde.dev/v0',
    kind: 'CustomerContextPackage',
    metadata: {
      customer: options.customer,
      name: options.name,
      version: options.version,
      status: 'draft',
    },
    spec: {
      semanticModelRef: 'semantic-model.yaml',
      contextSources: [],
      recipes: [recipePath],
      permissionsRef: 'permissions.yaml',
      evals: [evalPath],
      compatibility: {
        specMajor: 'v0',
        runtimeContract: options.contractMajor,
        graphSchema: options.schemas.graph,
        auditSchema: options.schemas.audit,
      },
      provenance: {
        createdBy: options.actor,
        createdAt: options.createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        decisions: [],
      },
    },
  };

  const semanticModel = {
    apiVersion: 'fde.dev/v0',
    kind: 'SemanticModel',
    metadata: { customer: options.customer, name: modelName, version: options.version },
    spec: {
      ontology: { modules: [], extensions: [] },
      sources: [],
      entityMappings: [],
      resolution: { keys: {}, sourcePrecedence: {}, merge: { strategy: 'same_as', minConfidence: 0.8 } },
      freshness: { defaultStaleAfter: 'PT24H', perSource: {} },
      recipes: [{ ref: recipePath }],
      permissions: { ref: 'permissions.yaml' },
      evals: [{ ref: evalPath }],
    },
  };

  const permissions = {
    apiVersion: 'fde.dev/v0',
    kind: 'PermissionProfile',
    metadata: { customer: options.customer, name: `${options.name}-baseline` },
    spec: {
      defaults: { unknownClassification: 'restricted', pii: 'redact' },
      classifications: {},
      properties: {},
      rowFilters: {},
      scopes: {},
    },
  };

  const recipe = {
    apiVersion: 'fde.dev/v0',
    kind: 'ContextRecipe',
    metadata: { customer: options.customer, name: recipeName, version: options.version },
    spec: {
      semanticModelRef: `${modelName}@${options.version}`,
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      // The shortest pipeline that is still a pipeline: mask and budget are
      // mandatory, the retrieval stages arrive when a source and a mapping do.
      stages: [
        { type: 'merge', dedupe: ['entity_id', 'content_hash'] },
        { type: 'mask', permissions: 'permissions.yaml' },
        { type: 'budget', maxNodes: 50, maxTokens: 4000, maxHops: 2 },
      ],
      output: { render: 'mastra', includeCitations: true },
    },
  };

  const evalSuite = {
    apiVersion: 'fde.dev/v0',
    kind: 'ContextEvalSuite',
    metadata: { customer: options.customer, name: recipeName, version: options.version },
    spec: {
      recipeRef: `${recipeName}@${options.version}`,
      thresholds: { recallAtBudget: 0.8, citationValidity: 1, silentStale: 0, silentConflict: 0 },
      questions: [],
    },
  };

  return {
    [MANIFEST]: render(manifest),
    'semantic-model.yaml': render(semanticModel),
    'permissions.yaml': render(permissions),
    [recipePath]: render(recipe),
    [evalPath]: render(evalSuite),
  };
}

function render(document: unknown): string {
  return stringifyYaml(document, { lineWidth: 0, aliasDuplicateObjects: false });
}

/**
 * What a package declares as compatible, read from the pinned toolchain through the
 * same loader the Spec path uses (so a missing or malformed toolchain is a
 * diagnostic here too, not a silent default).
 */
export function toolchainCompatibility(platformRoot: string): {
  graph: number | string;
  audit: number | string;
  contractMajor: string;
  errors: Diagnostic[];
} {
  const loaded = loadToolchain(platformRoot);
  return {
    graph: loaded.toolchain?.schemas.graph ?? 0,
    audit: loaded.toolchain?.schemas.audit ?? 0,
    contractMajor: RUNTIME_CONTRACT_MAJOR,
    errors: loaded.errors,
  };
}

/** The compatibility *input* `checkContextPackage` compares the manifest's claim with. */
function compatibilityOf(platformRoot: string): { compatibility: { graphSchema: string; auditSchema: string } } {
  const pinned = toolchainCompatibility(platformRoot);
  return { compatibility: { graphSchema: String(pinned.graph), auditSchema: String(pinned.audit) } };
}
