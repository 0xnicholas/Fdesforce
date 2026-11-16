import { basename, dirname, join } from 'node:path';

import { digestFiles, normalizeText, sha256, type Digest } from '@fde/spec';

import { asArray, asRecord, asString, isDirectory, listDir, readDocument, readText, walkFiles } from './fsutil.js';
import { highestSatisfying, parseRef } from './refs.js';
import type { Diagnostic } from './types.js';

export type TemplateType = 'solution' | 'capability' | 'policy' | 'eval' | 'ontology' | 'deployment-profile';

export const TEMPLATE_TYPES: readonly TemplateType[] = [
  'solution',
  'capability',
  'policy',
  'eval',
  'ontology',
  'deployment-profile',
];

interface TemplateDescriptor {
  file: string;
  kind: string;
  /** The Solution Template is a directory shaped like a Spec, not a named artifact. */
  checkMetadata: boolean;
}

const TEMPLATE_DESCRIPTORS: Record<TemplateType, TemplateDescriptor> = {
  solution: { file: 'solution.yaml', kind: 'SolutionSpec', checkMetadata: false },
  capability: { file: 'capability.yaml', kind: 'CapabilityTemplate', checkMetadata: true },
  policy: { file: 'policy.yaml', kind: 'PolicyTemplate', checkMetadata: true },
  eval: { file: 'eval-suite.yaml', kind: 'EvalSuiteTemplate', checkMetadata: true },
  ontology: { file: 'ontology.yaml', kind: 'OntologyTemplate', checkMetadata: true },
  'deployment-profile': { file: 'deployment-profile.yaml', kind: 'DeploymentProfileTemplate', checkMetadata: true },
};

export interface DirArtifact {
  name: string;
  version: string;
  dir: string;
  /** Sorted POSIX paths relative to `dir`. */
  files: string[];
  digest: Digest;
  document: Record<string, unknown>;
}

export type ResolveResult<T> = { ok: true; value: T } | { ok: false; error: Diagnostic };

/** Highest vendored version satisfying a range; `undefined` when none does. */
function selectVersion<T extends { version?: string }>(candidates: T[], range: string): T | undefined {
  const version = highestSatisfying(
    candidates.map((candidate) => candidate.version ?? ''),
    range,
  );
  return candidates.find((candidate) => candidate.version === version);
}

/**
 * Versioned-directory artifacts: `root/<name>/<version>/**` (overlays,
 * extensions) or `root/<type>/<name>/<version>/**` (templates). The whole
 * directory is the artifact, so every file in it is part of the digest.
 */
export class DirCatalog {
  readonly problems: Diagnostic[] = [];
  private readonly entries = new Map<string, DirArtifact>();
  private readonly label: string;
  private readonly root: string | undefined;

  constructor(input: {
    root: string | undefined;
    label: string;
    templateType?: TemplateType;
    descriptorFile?: string;
    expectedKind?: string;
    checkMetadata?: boolean;
  }) {
    this.root = input.root;
    this.label = input.label;
    if (input.root === undefined) return;

    if (input.templateType !== undefined) {
      const descriptor = TEMPLATE_DESCRIPTORS[input.templateType];
      for (const name of listDir(join(input.root, input.templateType))) {
        for (const version of listDir(join(input.root, input.templateType, name))) {
          this.add(join(input.root, input.templateType, name, version), name, version, descriptor);
        }
      }
      return;
    }

    const descriptor = {
      file: input.descriptorFile ?? `${input.label}.yaml`,
      kind: input.expectedKind ?? '',
      checkMetadata: input.checkMetadata ?? true,
    };
    for (const name of listDir(input.root)) {
      for (const version of listDir(join(input.root, name))) {
        this.add(join(input.root, name, version), name, version, descriptor);
      }
    }
  }

  private add(dir: string, name: string, version: string, descriptor: TemplateDescriptor): void {
    if (!isDirectory(dir)) return;
    const document = readDocument(join(dir, descriptor.file), `${this.label} ${name}@${version}`);
    if (!document.ok) {
      this.problems.push({
        ...document.error,
        code: 'artifact_invalid',
        remediation: `every ${this.label} version directory needs ${descriptor.file}`,
      });
      return;
    }
    if (asString(document.value['kind']) !== descriptor.kind) {
      this.problems.push({
        code: 'artifact_invalid',
        message: `${this.label} ${name}@${version} declares kind ${String(document.value['kind'])}, expected ${descriptor.kind}`,
        path: join(dir, descriptor.file),
      });
      return;
    }
    if (descriptor.checkMetadata) {
      const metadata = asRecord(document.value['metadata']);
      if (metadata['name'] !== name || metadata['version'] !== version) {
        this.problems.push({
          code: 'artifact_invalid',
          message: `${this.label} ${name}@${version} declares ${String(metadata['name'])}@${String(metadata['version'])} in its metadata`,
          path: join(dir, descriptor.file),
          remediation: 'the directory name and metadata must agree; published versions are immutable',
        });
        return;
      }
    }

    const files = walkFiles(dir);
    const digest = digestFiles(files.map((path) => ({ path, content: readText(join(dir, path)) }))).digest;
    this.entries.set(`${name}@${version}`, { name, version, dir, files, digest, document: document.value });
  }

  has(name: string): boolean {
    return [...this.entries.values()].some((entry) => entry.name === name);
  }

  resolve(ref: string, path: string): ResolveResult<DirArtifact> {
    const { name, range } = parseRef(ref);
    const versions = [...this.entries.values()].filter((entry) => entry.name === name).map((entry) => entry.version);
    if (versions.length === 0) {
      return {
        ok: false,
        error: {
          code: 'template_missing',
          message: `${this.label} ${ref} is not in the platform store`,
          path,
          remediation: `vendor ${name} under ${this.root ?? '<platform>'} or fix the reference; network resolution (\`--refresh\`) is not part of this slice`,
        },
      };
    }
    const candidates = [...this.entries.values()].filter((entry) => entry.name === name);
    const entry = selectVersion(candidates, range);
    if (entry === undefined) {
      return {
        ok: false,
        error: {
          code: 'template_missing',
          message: `no vendored ${this.label} satisfies ${ref}; available: ${versions.join(', ')}`,
          path,
          remediation: 'vendor a matching version or widen the Spec range',
        },
      };
    }
    return { ok: true, value: entry };
  }

  /** Provenance pins are exact: resolve `name@version` without range selection. */
  exact(name: string, version: string, path: string): ResolveResult<DirArtifact> {
    const entry = this.entries.get(`${name}@${version}`);
    if (entry === undefined) {
      return {
        ok: false,
        error: {
          code: 'template_missing',
          message: `${this.label} ${name}@${version} is not in the platform store`,
          path,
          remediation: 'vendor the pinned version or re-run `fde spec lock` without the provenance pin',
        },
      };
    }
    return { ok: true, value: entry };
  }
}

export interface DocArtifact {
  name: string;
  version?: string;
  path: string;
  digest: Digest;
  document: Record<string, unknown>;
}

/** Single-document artifacts indexed by document identity, not file path. */
export class DocCatalog {
  readonly problems: Diagnostic[] = [];
  private readonly entries = new Map<string, DocArtifact>();
  private readonly label: string;
  private readonly root: string | undefined;
  private readonly versioned: boolean;

  constructor(input: { root: string | undefined; label: string; kind: string; versioned?: boolean }) {
    this.label = input.label;
    this.root = input.root;
    this.versioned = input.versioned ?? true;
    if (input.root === undefined) return;

    for (const relative of walkFiles(input.root)) {
      if (!/\.ya?ml$/i.test(relative)) continue;
      const path = join(input.root, relative);
      const document = readDocument(path, `${input.label} at ${relative}`);
      if (!document.ok) {
        this.problems.push({ ...document.error, code: 'artifact_invalid' });
        continue;
      }
      if (asString(document.value['kind']) !== input.kind) continue;

      const metadata = asRecord(document.value['metadata']);
      const name = asString(metadata['name']);
      const version = asString(metadata['version']);
      if (name === undefined) {
        this.problems.push({
          code: 'artifact_invalid',
          message: `${input.label} at ${relative} has no metadata.name`,
          path: relative,
        });
        continue;
      }
      if (this.versioned && version === undefined) {
        this.problems.push({
          code: 'artifact_invalid',
          message: `${input.label} ${name} at ${relative} has no metadata.version`,
          path: relative,
        });
        continue;
      }

      const artifact: DocArtifact = {
        name,
        ...(version === undefined ? {} : { version }),
        path,
        digest: sha256(normalizeText(readText(path))),
        document: document.value,
      };
      const key = `${name}@${version ?? ''}`;
      if (this.entries.has(key)) {
        this.problems.push({
          code: 'artifact_duplicate',
          message: `${input.label} ${key} is declared twice (${this.entries.get(key)?.path ?? ''} and ${path})`,
          path: relative,
          remediation: 'one artifact id has one version; remove the stale copy',
        });
        continue;
      }
      this.entries.set(key, artifact);
    }
  }

  has(name: string): boolean {
    return [...this.entries.values()].some((entry) => entry.name === name);
  }

  get(name: string): DocArtifact | undefined {
    return this.entries.get(`${name}@`);
  }

  resolve(ref: string, path: string): ResolveResult<DocArtifact> {
    const { name, range } = parseRef(ref);
    const candidates = [...this.entries.values()].filter((entry) => entry.name === name);
    if (candidates.length === 0) {
      return {
        ok: false,
        error: {
          code: 'artifact_missing',
          message: `${this.label} ${ref} is not in the workspace`,
          path,
          remediation: `vendor ${name} under ${this.root ?? '<asset root>'} or fix the reference`,
        },
      };
    }
    const entry = selectVersion(candidates, range);
    if (entry === undefined) {
      return {
        ok: false,
        error: {
          code: 'artifact_missing',
          message: `no vendored ${this.label} satisfies ${ref}`,
          path,
          remediation: 'vendor a matching version or widen the Spec range',
        },
      };
    }
    return { ok: true, value: entry };
  }

  all(): DocArtifact[] {
    return [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export interface ContextPackageArtifact {
  name: string;
  version: string;
  dir: string;
  files: string[];
  digest: Digest;
  manifest: Record<string, unknown>;
  recipes: Record<string, Record<string, unknown>>;
  semanticModel?: Record<string, unknown>;
}

/** A Customer Context Package is a directory; the manifest names its parts. */
export class ContextPackageCatalog {
  readonly problems: Diagnostic[] = [];
  private readonly entries = new Map<string, ContextPackageArtifact>();
  private readonly root: string | undefined;

  constructor(root: string | undefined) {
    this.root = root;
    if (root === undefined) return;

    for (const relative of walkFiles(root)) {
      if (basename(relative) !== 'manifest.yaml') continue;
      const path = join(root, relative);
      const document = readDocument(path, `context package at ${relative}`);
      if (!document.ok) {
        this.problems.push({ ...document.error, code: 'artifact_invalid' });
        continue;
      }
      if (document.value['kind'] !== 'CustomerContextPackage') continue;
      const metadata = asRecord(document.value['metadata']);
      const name = asString(metadata['name']);
      const version = asString(metadata['version']);
      if (name === undefined || version === undefined) {
        this.problems.push({
          code: 'artifact_invalid',
          message: `context package ${relative} needs metadata.name and metadata.version`,
          path: relative,
        });
        continue;
      }

      const dir = dirname(path);
      const spec = asRecord(document.value['spec']);
      const recipes: Record<string, Record<string, unknown>> = {};
      for (const declared of asArray(spec['recipes'])) {
        const file = asString(declared);
        if (file === undefined) continue;
        const recipe = readDocument(join(dir, file), `recipe ${file} of ${name}`);
        if (!recipe.ok) {
          this.problems.push({ ...recipe.error, code: 'artifact_invalid' });
          continue;
        }
        const recipeName = asString(asRecord(recipe.value['metadata'])['name']);
        if (recipeName !== undefined) recipes[recipeName] = recipe.value;
      }

      const semanticModelRef = asString(spec['semanticModelRef']);
      const semanticModel =
        semanticModelRef === undefined
          ? undefined
          : readDocument(join(dir, semanticModelRef), `semantic model of ${name}`);
      if (semanticModel !== undefined && !semanticModel.ok) {
        this.problems.push({ ...semanticModel.error, code: 'artifact_invalid' });
      }

      const files = walkFiles(dir);
      const digest = digestFiles(files.map((file) => ({ path: file, content: readText(join(dir, file)) }))).digest;

      this.entries.set(`${name}@${version}`, {
        name,
        version,
        dir,
        files,
        digest,
        manifest: document.value,
        recipes,
        ...(semanticModel?.ok === true ? { semanticModel: semanticModel.value } : {}),
      });
    }
  }

  resolve(ref: string, path: string): ResolveResult<ContextPackageArtifact> {
    const { name, range } = parseRef(ref);
    const candidates = [...this.entries.values()].filter((entry) => entry.name === name);
    if (candidates.length === 0) {
      return {
        ok: false,
        error: {
          code: 'artifact_missing',
          message: `Context Package ${ref} is not in the workspace`,
          path,
          remediation: `vendor ${name} under ${this.root ?? '<contextPackages root>'} or fix the reference`,
        },
      };
    }
    const entry = selectVersion(candidates, range);
    if (entry === undefined) {
      return {
        ok: false,
        error: {
          code: 'artifact_missing',
          message: `no vendored Context Package satisfies ${ref}`,
          path,
          remediation: 'freeze a matching package version',
        },
      };
    }
    return { ok: true, value: entry };
  }
}

export interface Catalogues {
  templates: Record<TemplateType, DirCatalog>;
  overlays: DirCatalog;
  extensions: DirCatalog;
  modelProfiles: DocCatalog;
  runtimeProfiles: DocCatalog;
  connectors: DocCatalog;
  evalSuites: DocCatalog;
  datasets: DocCatalog;
  policyAssets: DocCatalog;
  contextPackages: ContextPackageCatalog;
  problems: Diagnostic[];
}

export function buildCatalogues(input: {
  platformRoot: string;
  assets: {
    connectors?: string;
    contextPackages?: string;
    evalSuites?: string;
    datasets?: string;
    policies?: string;
  };
}): Catalogues {
  const templatesRoot = join(input.platformRoot, 'templates');
  const templates = Object.fromEntries(
    TEMPLATE_TYPES.map((type) => [
      type,
      new DirCatalog({ root: templatesRoot, label: `${type} template`, templateType: type }),
    ]),
  ) as Record<TemplateType, DirCatalog>;

  const overlays = new DirCatalog({
    root: join(input.platformRoot, 'overlays'),
    label: 'overlay',
    descriptorFile: 'overlay.yaml',
    expectedKind: 'Overlay',
  });
  const extensions = new DirCatalog({
    root: join(input.platformRoot, 'extensions'),
    label: 'extension',
    descriptorFile: 'extension.yaml',
    expectedKind: 'Extension',
  });

  const modelProfiles = new DocCatalog({
    root: join(input.platformRoot, 'model-profiles'),
    label: 'Model Profile',
    kind: 'ModelProfile',
  });
  const runtimeProfiles = new DocCatalog({
    root: join(input.platformRoot, 'runtime-profiles'),
    label: 'Runtime Profile',
    kind: 'RuntimeProfile',
  });

  const connectors = new DocCatalog({
    root: input.assets.connectors,
    label: 'connector',
    kind: 'Connector',
    versioned: false,
  });
  const evalSuites = new DocCatalog({
    root: input.assets.evalSuites,
    label: 'Eval Suite',
    kind: 'EvalSuite',
  });
  const datasets = new DocCatalog({ root: input.assets.datasets, label: 'Eval Dataset', kind: 'EvalDataset' });
  const policyAssets = new DocCatalog({
    root: input.assets.policies,
    label: 'Policy asset',
    kind: 'PolicyTemplate',
  });
  const contextPackages = new ContextPackageCatalog(input.assets.contextPackages);

  const problems = [
    ...Object.values(templates).flatMap((catalogue) => catalogue.problems),
    ...overlays.problems,
    ...extensions.problems,
    ...modelProfiles.problems,
    ...runtimeProfiles.problems,
    ...connectors.problems,
    ...evalSuites.problems,
    ...datasets.problems,
    ...policyAssets.problems,
    ...contextPackages.problems,
  ];

  return {
    templates,
    overlays,
    extensions,
    modelProfiles,
    runtimeProfiles,
    connectors,
    evalSuites,
    datasets,
    policyAssets,
    contextPackages,
    problems,
  };
}
