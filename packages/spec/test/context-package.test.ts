// Seam: `checkContextPackage` — the reference rules of `fde context validate`.
//
// Each case below is a modelling mistake with a consequence: a recipe that names a
// term nothing produces, a mask that binds a different baseline, a row filter on a
// class no mapping declares (which fails *open*), a frozen version whose content
// moved. The pure function makes every one of them a two-line test.
import { describe, expect, it } from 'vitest';

import { checkContextPackage, type CheckContextPackageInput } from '../src/index.js';
import { loadPackage } from './support/context-package.js';

const reference = (): CheckContextPackageInput => {
  const { input, errors } = loadPackage('examples/semantic/acme');
  if (errors.length > 0) throw new Error(`the Acme package does not load: ${JSON.stringify(errors)}`);
  return structuredClone(input);
};

const report = (input: CheckContextPackageInput) => checkContextPackage(input);
const codes = (errors: ReadonlyArray<{ code: string }>): string[] => errors.map((error) => error.code);
const messages = (errors: ReadonlyArray<{ path?: string; message: string }>): string =>
  errors.map((error) => `${error.path ?? '<root>'}: ${error.message}`).join('\n');

const recipe = (input: CheckContextPackageInput) => {
  const found = input.documents.recipes['recipes/claims-context.yaml'];
  if (found === undefined) throw new Error('the reference recipe is missing');
  return found;
};

describe('the Acme reference package', () => {
  it('passes with no errors and nothing to warn about', () => {
    const result = report(reference());

    expect(result.errors, messages(result.errors)).toEqual([]);
    expect(result.warnings, messages(result.warnings)).toEqual([]);
  });

  it('is frozen at the digest its content produces', () => {
    const input = reference();

    expect(input.revision?.spec.digest).toBe(input.digest);
    expect(input.revision?.spec.files).toEqual(input.fileDigests);
  });
});

describe('declared files', () => {
  it('reports a declared source that is not in the package', () => {
    const input = reference();
    input.files = input.files.filter((path) => path !== 'context-sources/sharepoint-claims.yaml');

    const result = report(input);

    expect(codes(result.errors)).toContain('context_file_missing');
    expect(messages(result.errors)).toMatch(/sharepoint-claims\.yaml/);
  });

  it('reports a Semantic Model that omits a file the manifest declares', () => {
    const input = reference();
    input.documents.semanticModel?.spec.recipes.splice(0, 1);

    const result = report(input);

    expect(codes(result.errors)).toContain('semantic_model_invalid');
    expect(messages(result.errors)).toMatch(/manifest declares recipes\/claims-context\.yaml/);
  });

  it('reports a document belonging to another Customer', () => {
    const input = reference();
    const source = input.documents.contextSources['context-sources/claims-db.yaml'];
    if (source === undefined) throw new Error('no source');
    source.metadata.customer = 'beta';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_package_invalid');
  });
});

describe('ontology and digests', () => {
  it('reports an ontology module whose claim is not the vendored content', () => {
    const input = reference();
    const module = input.documents.semanticModel?.spec.ontology.modules[0];
    if (module === undefined) throw new Error('no module');
    module.digest = `sha256:${'0'.repeat(64)}`;

    const result = report(input);

    expect(codes(result.errors)).toContain('context_digest_mismatch');
    expect(messages(result.errors)).toMatch(/insurance-claims@1\.0\.0/);
  });

  it('reports an extension digest that no longer describes the file', () => {
    const input = reference();
    const extension = input.documents.semanticModel?.spec.ontology.extensions[0];
    if (extension === undefined) throw new Error('no extension');
    if (input.fileDigests !== undefined) input.fileDigests[extension.path] = `sha256:${'1'.repeat(64)}`;

    const result = report(input);

    expect(codes(result.errors)).toContain('context_digest_mismatch');
    expect(messages(result.errors)).toMatch(/acme-claims-extension\.ttl/);
  });
});

describe('compatibility', () => {
  it('reports a package frozen against another graph schema than the pinned toolchain', () => {
    const input = reference();
    input.compatibility = { graphSchema: '2', auditSchema: '1' };

    const result = report(input);

    expect(codes(result.errors)).toContain('context_compatibility_mismatch');
    expect(messages(result.errors)).toMatch(/graphSchema 1, but the pinned toolchain is 2/);
  });

  it('accepts the version the toolchain pins', () => {
    const input = reference();

    expect(report(input).errors).toEqual([]);
  });
});

describe('mappings and sources', () => {
  it('reports a mapping whose source the Semantic Model does not declare', () => {
    const input = reference();
    const mapping = input.documents.mappings['mappings/claims-db-customers.yaml'];
    if (mapping === undefined) throw new Error('no mapping');
    mapping.metadata.source = 'core-banking';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/core-banking/);
  });

  it('reports a mapping that reads through another connector than its source', () => {
    const input = reference();
    const mapping = input.documents.mappings['mappings/claims-db-coverages.yaml'];
    if (mapping === undefined) throw new Error('no mapping');
    mapping.spec.connectorRef = 'sharepoint-claims';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/sharepoint-claims/);
  });

  it('reports a Context Source whose connector is not vendored', () => {
    const input = reference();
    input.connectors = ['claims-db'];

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/connector sharepoint-claims is not in the workspace/);
  });
});

describe('recipe pipeline', () => {
  it('reports a recipe with no mask stage', () => {
    const input = reference();
    const document = recipe(input);
    document.spec.stages = document.spec.stages.filter((stage) => stage.type !== 'mask');

    const result = report(input);

    expect(codes(result.errors)).toContain('context_recipe_invalid');
    expect(messages(result.errors)).toMatch(/no mask stage/);
  });

  it('reports a recipe with no budget stage', () => {
    const input = reference();
    const document = recipe(input);
    document.spec.stages = document.spec.stages.filter((stage) => stage.type !== 'budget');

    const result = report(input);

    expect(codes(result.errors)).toContain('context_recipe_invalid');
    expect(messages(result.errors)).toMatch(/no budget stage/);
  });

  it('reports stages that do not follow the canonical order', () => {
    const input = reference();
    const document = recipe(input);
    const lexical = document.spec.stages.find((stage) => stage.type === 'lexical');
    document.spec.stages = document.spec.stages.filter((stage) => stage.type !== 'lexical');
    document.spec.stages.unshift(lexical as never);

    const result = report(input);

    expect(codes(result.errors)).toContain('context_recipe_invalid');
    expect(messages(result.errors)).toMatch(/the pipeline is resolve → structured/);
  });

  it('reports a mask stage bound to a different baseline', () => {
    const input = reference();
    const document = recipe(input);
    const mask = document.spec.stages.find((stage) => stage.type === 'mask');
    if (mask === undefined) throw new Error('no mask stage');
    mask.permissions = 'permissions-lax.yaml';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_recipe_invalid');
    expect(messages(result.errors)).toMatch(/cannot substitute a different baseline/);
  });

  it('reports a class the mappings never produce', () => {
    const input = reference();
    const document = recipe(input);
    const structured = document.spec.stages.find((stage) => stage.type === 'structured');
    if (structured === undefined) throw new Error('no structured stage');
    structured.entities.push('ic:FraudFlag');

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/ic:FraudFlag/);
  });

  it('reports a relation the mappings never declare', () => {
    const input = reference();
    const document = recipe(input);
    const graph = document.spec.stages.find((stage) => stage.type === 'graph');
    if (graph === undefined) throw new Error('no graph stage');
    graph.relations.push('ic:hasClaim');

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/ic:hasClaim/);
  });

  it('reports a stage selecting a source that is not declared', () => {
    const input = reference();
    const document = recipe(input);
    const lexical = document.spec.stages.find((stage) => stage.type === 'lexical');
    if (lexical === undefined) throw new Error('no lexical stage');
    lexical.source = 'beta-dms';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/beta-dms/);
  });

  it('reports a recipe bound to another Semantic Model version', () => {
    const input = reference();
    recipe(input).spec.semanticModelRef = 'acme-claims@2.0.0';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/acme-claims@1\.0\.0/);
  });
});

describe('permission baseline', () => {
  it('reports a row filter on a class no mapping declares, because it never pushes down', () => {
    const input = reference();
    const permissions = input.documents.permissions;
    if (permissions === undefined) throw new Error('no permissions');
    permissions.spec.rowFilters['ic:Claimn'] = 'tenant_id = :tenant_id';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/ic:Claimn/);
  });

  it('reports a mask on a property no mapping produces, because it never applies', () => {
    const input = reference();
    const permissions = input.documents.permissions;
    if (permissions === undefined) throw new Error('no permissions');
    permissions.spec.properties['ic:customerPhonenumber'] = { columnMask: 'hash' };

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/ic:customerPhonenumber/);
  });

  it('reports a scope entry for a class no mapping declares', () => {
    const input = reference();
    const permissions = input.documents.permissions;
    if (permissions === undefined) throw new Error('no permissions');
    permissions.spec.scopes['ic:FraudFlag'] = ['claims:fraud:read'];

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
  });

  it('warns, rather than fails, when a mapped class has no classification', () => {
    const input = reference();
    const permissions = input.documents.permissions;
    if (permissions === undefined) throw new Error('no permissions');
    delete permissions.spec.classifications['ic:Coverage'];

    const result = report(input);

    expect(result.errors).toEqual([]);
    expect(codes(result.warnings)).toContain('context_permissions_unclassified');
  });
});

describe('eval suites', () => {
  const suite = (input: CheckContextPackageInput) => {
    const found = input.documents.evals['evals/claims-context.golden.yaml'];
    if (found === undefined) throw new Error('the reference eval suite is missing');
    return found;
  };

  it('reports a recipeRef that no recipe in the package answers', () => {
    const input = reference();
    suite(input).spec.recipeRef = 'ghost-recipe@1.0.0';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/ghost-recipe/);
  });

  it('reports a version drift between the suite and the recipe', () => {
    const input = reference();
    suite(input).spec.recipeRef = 'claims-context@1.1.0';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/claims-context recipe is 1\.0\.0/);
  });

  it('reports an input the recipe does not accept', () => {
    const input = reference();
    const question = suite(input).spec.questions[0];
    if (question === undefined) throw new Error('no question');
    question.input['policy_number'] = 'P-2001';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_reference_unknown');
    expect(messages(result.errors)).toMatch(/policy_number/);
  });

  it('warns when the package declares no question at all, so a freeze has nothing to gate on', () => {
    const input = reference();
    suite(input).spec.questions = [];

    const result = report(input);

    expect(result.errors).toEqual([]);
    expect(codes(result.warnings)).toContain('context_eval_missing');
  });
});

describe('frozen revisions', () => {
  it('reports content that moved after the freeze', () => {
    const input = reference();
    if (input.fileDigests !== undefined) input.fileDigests['recipes/claims-context.yaml'] = `sha256:${'2'.repeat(64)}`;

    const result = report(input);

    expect(codes(result.errors)).toContain('context_package_modified');
    expect(messages(result.errors)).toMatch(/recipes\/claims-context\.yaml/);
  });

  it('reports a manifest that went back to draft while the revision stands', () => {
    const input = reference();
    input.manifest.metadata.status = 'validated';

    const result = report(input);

    expect(codes(result.errors)).toContain('context_package_modified');
    expect(messages(result.errors)).toMatch(/does not go back to draft/);
  });

  it('reports a frozen manifest with no revision at all', () => {
    const input = reference();
    delete input.revision;

    const result = report(input);

    expect(codes(result.errors)).toContain('context_package_not_frozen');
  });

  it('accepts a draft package that has never been frozen', () => {
    const input = reference();
    delete input.revision;
    input.manifest.metadata.status = 'draft';

    const result = report(input);

    expect(result.errors, messages(result.errors)).toEqual([]);
  });
});
