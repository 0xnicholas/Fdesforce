// Seam: the Customer Context Package document grammar (`fde context`).
//
// The CCP is the second family of authored documents after the Solution Spec, and
// it carries the same weight: a schema that lets a weakened default, a bare term
// name or a stage with no mask through would turn a modelling typo into a data
// exposure. Every case below is a document an author could plausibly write.
import { describe, expect, it } from 'vitest';

import {
  parseContextEvalSuite,
  parseContextPackage,
  parseContextPackageRevision,
  parseContextRecipe,
  parseContextSource,
  parseMapping,
  parsePermissionProfile,
  parseSemanticModel,
} from '../src/index.js';
import { examplePackageDir, loadPackage, loose, type Loose } from './support/context-package.js';

const codes = (errors: ReadonlyArray<{ code: string }>): string[] => errors.map((error) => error.code);
const messages = (errors: ReadonlyArray<{ message: string }>): string => errors.map((error) => error.message).join('\n');

describe('the Acme CCP documents', () => {
  it('parse as the kinds they declare', () => {
    const { input, errors } = loadPackage(examplePackageDir);

    expect(errors, messages(errors)).toEqual([]);
    expect(input.manifest.kind).toBe('CustomerContextPackage');
    expect(input.documents.semanticModel?.kind).toBe('SemanticModel');
    expect(Object.keys(input.documents.contextSources).sort()).toEqual([
      'context-sources/claims-db.yaml',
      'context-sources/sharepoint-claims.yaml',
    ]);
    expect(Object.keys(input.documents.mappings).sort()).toEqual([
      'mappings/claims-db-coverages.yaml',
      'mappings/claims-db-customers.yaml',
      'mappings/claims-db-fraud.yaml',
      'mappings/claims-db-policies.yaml',
      'mappings/claims-db.yaml',
      'mappings/sharepoint-claims.yaml',
    ]);
    expect(Object.keys(input.documents.recipes)).toEqual(['recipes/claims-context.yaml']);
    expect(input.documents.permissions?.spec.defaults.unknownClassification).toBe('restricted');
    expect(Object.keys(input.documents.evals)).toEqual(['evals/claims-context.golden.yaml']);
  });

  it('declares both mapping kinds, so the disk format is the discriminator', () => {
    const { input } = loadPackage(examplePackageDir);

    expect(input.documents.mappings['mappings/claims-db.yaml']?.kind).toBe('EntityMapping');
    expect(input.documents.mappings['mappings/sharepoint-claims.yaml']?.kind).toBe('DocumentMapping');
  });
});

describe('ContextPackage manifest', () => {
  const manifest = () => ({
    apiVersion: 'fde.dev/v0',
    kind: 'CustomerContextPackage',
    metadata: { customer: 'acme', name: 'acme-claims-context', version: '1.0.0', status: 'draft' },
    spec: {
      semanticModelRef: 'semantic-model.yaml',
      contextSources: [],
      recipes: [],
      permissionsRef: 'permissions.yaml',
      evals: [],
      compatibility: { specMajor: 'v0', runtimeContract: 'fde.runtime/v1', graphSchema: 1, auditSchema: 1 },
      provenance: { createdBy: 'fde://acme', createdAt: '2026-11-15T08:00:00Z', decisions: [] },
    },
  });

  it('accepts a draft with no sources, recipes or evals yet', () => {
    const result = parseContextPackage(manifest());

    expect(result.ok, result.ok ? '' : messages(result.errors)).toBe(true);
  });

  it('rejects a specMajor or runtimeContract outside the version lines it may name', () => {
    const document = manifest();
    document.spec.compatibility.runtimeContract = 'fde.runtime/1';

    const result = parseContextPackage(document);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(codes(result.errors)).toContain('context_package_invalid');
  });

  it('rejects an unknown field, because a CCP is strict like every other document', () => {
    const document = { ...manifest(), extra: true };

    const result = parseContextPackage(document);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.errors)).toMatch(/unrecognized/i);
  });

  it('rejects a status outside the lifecycle', () => {
    const result = parseContextPackage({
      ...manifest(),
      metadata: { ...manifest().metadata, status: 'published' },
    });

    expect(result.ok).toBe(false);
  });
});

describe('ContextPackageRevision', () => {
  const revision = {
    apiVersion: 'fde.dev/v0',
    kind: 'ContextPackageRevision',
    metadata: { customer: 'acme', name: 'acme-claims-context', version: '1.0.0' },
    spec: {
      digest: `sha256:${'a'.repeat(64)}`,
      files: { 'manifest.yaml': `sha256:${'b'.repeat(64)}` },
      frozenAt: '2026-11-15T08:00:00Z',
      frozenBy: 'fde://acme/fde-lead',
    },
  };

  it('accepts a frozen record', () => {
    const result = parseContextPackageRevision(revision);

    expect(result.ok, result.ok ? '' : messages(result.errors)).toBe(true);
  });

  it('requires a digest, because the version alone does not address content', () => {
    const result = parseContextPackageRevision({
      ...revision,
      spec: { ...revision.spec, digest: 'sha256:not-a-digest' },
    });

    expect(result.ok).toBe(false);
  });

  it('rejects a sourceCommit that is not a commit id', () => {
    const result = parseContextPackageRevision({ ...revision, spec: { ...revision.spec, sourceCommit: 'HEAD' } });

    expect(result.ok).toBe(false);
  });
});

describe('SemanticModel', () => {
  it('requires an ontology module digest, so a frozen package names the TTL it was modelled against', () => {
    const { input } = loadPackage(examplePackageDir);
    const document = loose(input.documents.semanticModel);
    if (document === undefined) throw new Error('no semantic model');
    delete (document.spec.ontology.modules[0] as { digest?: string }).digest;

    const result = parseSemanticModel(document);

    expect(result.ok).toBe(false);
  });

  it('rejects a resolution rule with no key columns', () => {
    const { input } = loadPackage(examplePackageDir);
    const document = loose(input.documents.semanticModel);
    if (document === undefined) throw new Error('no semantic model');
    document.spec.resolution.keys = { Claim: [] };

    const result = parseSemanticModel(document);

    expect(result.ok).toBe(false);
  });
});

describe('ContextSource', () => {
  it('requires classification and freshness, because an unlabelled source has no SLA', () => {
    const source = {
      apiVersion: 'fde.dev/v0',
      kind: 'ContextSource',
      metadata: { customer: 'acme', name: 'claims-db' },
      spec: {
        connectorRef: 'claims-db',
        dataset: 'public.claims',
        classification: 'confidential',
        freshness: { staleAfter: 'PT1H', watermark: 'updated_at' },
        schedule: '*/15 * * * *',
        mode: 'incremental',
      },
    };
    expect(parseContextSource(source).ok).toBe(true);

    const withoutClassification = loose(source);
    delete withoutClassification['spec']['classification'];
    expect(parseContextSource(withoutClassification).ok).toBe(false);

    const unknownClassification = loose(source);
    unknownClassification.spec.classification = 'secret';
    expect(parseContextSource(unknownClassification).ok).toBe(false);
  });

  it('rejects a secret value where only a secretRef belongs', () => {
    const { input } = loadPackage(examplePackageDir);
    const source = loose(input.documents.contextSources['context-sources/claims-db.yaml']);
    if (source === undefined) throw new Error('no source');

    const result = parseContextSource({ ...source, spec: { ...source.spec, password: 'hunter2' } });

    expect(result.ok).toBe(false);
  });
});

describe('mappings', () => {
  it('rejects a bare local name as a term, because a term is prefixed', () => {
    const { input } = loadPackage(examplePackageDir);
    const mapping = loose(input.documents.mappings['mappings/claims-db.yaml']);
    if (mapping === undefined || mapping.kind !== 'EntityMapping') throw new Error('no mapping');
    mapping.spec.entity = 'Claim';

    const result = parseMapping(mapping);

    expect(result.ok).toBe(false);
  });

  it('rejects a column type the ingress has no writer for', () => {
    const { input } = loadPackage(examplePackageDir);
    const mapping = loose(input.documents.mappings['mappings/claims-db.yaml']);
    if (mapping === undefined || mapping.kind !== 'EntityMapping') throw new Error('no mapping');
    mapping.spec.properties['amount'] = { property: 'ic:amount', type: 'money' };

    const result = parseMapping(mapping);

    expect(result.ok).toBe(false);
  });

  it('keeps document extraction as candidates only', () => {
    const { input } = loadPackage(examplePackageDir);
    const mapping = loose(input.documents.mappings['mappings/sharepoint-claims.yaml']);
    if (mapping === undefined || mapping.kind !== 'DocumentMapping') throw new Error('no document mapping');
    mapping.spec.extraction.mode = 'authoritative';

    const result = parseMapping(mapping);

    expect(result.ok).toBe(false);
  });
});

describe('ContextRecipe', () => {
  it('accepts the claims-context recipe', () => {
    const { input } = loadPackage(examplePackageDir);
    const result = parseContextRecipe(input.documents.recipes['recipes/claims-context.yaml']);

    expect(result.ok, result.ok ? '' : messages(result.errors)).toBe(true);
  });

  it('bounds the graph stage to two hops, because the v0 graph is 1–2', () => {
    const { input } = loadPackage(examplePackageDir);
    const recipe = loose(input.documents.recipes['recipes/claims-context.yaml']);
    if (recipe === undefined) throw new Error('no recipe');
    const graph = recipe.spec.stages.find((stage: Loose) => stage.type === 'graph');
    if (graph === undefined) throw new Error('no graph stage');
    graph.maxHops = 3;

    const result = parseContextRecipe(recipe);

    expect(result.ok).toBe(false);
  });

  it('rejects a stage type the pipeline does not have', () => {
    const { input } = loadPackage(examplePackageDir);
    const recipe = loose(input.documents.recipes['recipes/claims-context.yaml']);
    if (recipe === undefined) throw new Error('no recipe');
    recipe.spec.stages.push({ type: 'reorder' });

    const result = parseContextRecipe(recipe);

    expect(result.ok).toBe(false);
  });

  it('requires the query stage to declare its source and topK', () => {
    const { input } = loadPackage(examplePackageDir);
    const recipe = loose(input.documents.recipes['recipes/claims-context.yaml']);
    if (recipe === undefined) throw new Error('no recipe');
    recipe.spec.stages = recipe.spec.stages.filter((stage: Loose) => stage.type !== 'lexical');
    recipe.spec.stages.splice(3, 0, { type: 'lexical', query: '$query' });

    const result = parseContextRecipe(recipe);

    expect(result.ok).toBe(false);
  });
});

describe('PermissionProfile', () => {
  it('accepts the Acme baseline', () => {
    const { input } = loadPackage(examplePackageDir);
    const result = parsePermissionProfile(input.documents.permissions);

    expect(result.ok, result.ok ? '' : messages(result.errors)).toBe(true);
  });

  it('refuses to let a baseline relax the fail-closed default', () => {
    const { input } = loadPackage(examplePackageDir);
    const profile = loose(input.documents.permissions);
    if (profile === undefined) throw new Error('no permissions');
    profile.spec.defaults.unknownClassification = 'internal';

    const result = parsePermissionProfile(profile);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.errors)).toMatch(/restricted/i);
  });

  it('rejects an annotation that says nothing', () => {
    const { input } = loadPackage(examplePackageDir);
    const profile = loose(input.documents.permissions);
    if (profile === undefined) throw new Error('no permissions');
    profile.spec.properties['ic:coveragetype'] = {};

    const result = parsePermissionProfile(profile);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(messages(result.errors)).toMatch(/must say something/i);
  });

  it('rejects a mask action outside redact | hash | tokenize | null', () => {
    const { input } = loadPackage(examplePackageDir);
    const profile = loose(input.documents.permissions);
    if (profile === undefined) throw new Error('no permissions');
    profile.spec.defaults.pii = 'scramble';

    const result = parsePermissionProfile(profile);

    expect(result.ok).toBe(false);
  });
});

describe('ContextEvalSuite', () => {
  it('accepts the golden questions and their thresholds', () => {
    const { input } = loadPackage(examplePackageDir);
    const result = parseContextEvalSuite(input.documents.evals['evals/claims-context.golden.yaml']);

    expect(result.ok, result.ok ? '' : messages(result.errors)).toBe(true);
  });

  it('bounds the thresholds to a ratio a report can produce', () => {
    const { input } = loadPackage(examplePackageDir);
    const suite = loose(input.documents.evals['evals/claims-context.golden.yaml']);
    if (suite === undefined) throw new Error('no eval suite');
    suite.spec.thresholds.recallAtBudget = 80;

    const result = parseContextEvalSuite(suite);

    expect(result.ok).toBe(false);
  });
});
