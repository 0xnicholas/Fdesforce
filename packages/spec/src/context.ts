import { digestFiles, type Digest, type FileEntry, type FileSetDigest } from './canonical.js';
import { error, warn, type ValidationReport } from './report.js';
import type { ContextPackage, ContextPackageRevision } from './schema/context-package.js';
import type { ContextEvalSuite } from './schema/context-eval-suite.js';
import { RECIPE_STAGE_ORDER } from './schema/context-recipe.js';
import type { ContextRecipe } from './schema/context-recipe.js';
import type { ContextSource } from './schema/context-source.js';
import type { Mapping } from './schema/entity-mapping.js';
import type { PermissionProfile } from './schema/permission-profile.js';
import type { SemanticModel } from './schema/semantic-model.js';

/**
 * `checkContextPackage` — the reference half of `fde context validate`.
 *
 * `parse*` answers "is this document shaped correctly"; this answers "do the
 * documents agree": every declared file exists, every named term/recipe/source
 * resolves, every digest in the package matches the content it claims, and a
 * frozen revision still describes the content on disk.
 *
 * The split mirrors `checkSolution`: file loading and platform/connector
 * resolution belong to the CLI (`packages/cli`), which hands this function a view
 * of already-parsed documents plus the few cross-asset facts only it can know
 * (vendored ontology module digests, vendored connector ids). The function is
 * pure, so every rule below is testable without a filesystem.
 *
 * Two rules carry the design's weight and are worth naming:
 *
 * - **Terminology is anchored on the mappings.** A recipe may only name classes,
 *   relations and sources the mappings produce, and a permission annotation may
 *   only name terms that exist. An annotation that names nothing is not harmless:
 *   a typo'd `columnMask`/`rowFilter` is a rule that never applies, which fails
 *   *open* — so it is an error, not a warning. The one exception is a class with
 *   no classification, which the fail-closed default already covers; that is a
 *   warning.
 * - **A frozen version is immutable.** When `revisions/<version>.yaml` exists, the
 *   content digest must equal it, file for file; the fix is a new version, never
 *   an edit. That is what lets `solution.lock`, the revision and the ingest job
 *   name one digest.
 */

export interface ContextPackageDocuments {
  semanticModel?: SemanticModel;
  /** Package path → document, for the sources the manifest declares. */
  contextSources: Record<string, ContextSource>;
  /** Package path → document, for the mappings the Semantic Model declares. */
  mappings: Record<string, Mapping>;
  /** Package path → document, for the recipes the manifest declares. */
  recipes: Record<string, ContextRecipe>;
  permissions?: PermissionProfile;
  /** Package path → document, for the eval suites the manifest declares. */
  evals: Record<string, ContextEvalSuite>;
}

export interface CheckContextPackageInput {
  manifest: ContextPackage;
  documents: ContextPackageDocuments;
  /** Package-relative paths that exist on disk. */
  files: ReadonlyArray<string>;
  /** The recorded revision, when this version is frozen. */
  revision?: ContextPackageRevision;
  /** Computed content digest over the package files (excluding `revisions/**`). */
  digest?: Digest;
  /** Computed per-file content digests — the same map `freeze` records. */
  fileDigests?: Record<string, Digest>;
  /** Vendored Domain Ontology module digests, keyed `name@version`. */
  ontologyModules?: Record<string, Digest>;
  /** Connector ids vendored in the workspace, when one was resolved. */
  connectors?: ReadonlyArray<string>;
  /**
   * The pinned platform schema versions (toolchain), when the caller resolved one.
   * A package declares what it can be compiled into; this is what it is compiled by.
   */
  compatibility?: { graphSchema: string; auditSchema: string };
}

export type ContextPackageReport = ValidationReport;

type Report = ValidationReport;

/**
 * What a package's content is: every file except the freeze records
 * (`revisions/**`, which are provenance *about* the content) and hidden
 * editor/filesystem debris (`.DS_Store`, `.gitignore`) — a digest that moved
 * because of the second would make a package depend on who checked it out.
 *
 * `freeze`, `solution.lock` and the ingest job must agree on this set, so the rule
 * is here once instead of in every reader.
 */
export function contextPackageFiles(paths: ReadonlyArray<string>): string[] {
  return paths
    .filter((path) => !path.startsWith('revisions/'))
    .filter((path) => !path.split('/').some((segment) => segment.startsWith('.')))
    .sort();
}

/** `digestFiles()` over the package content: the value `freeze` records and the lock pins. */
export function digestContextPackage(entries: ReadonlyArray<FileEntry>): FileSetDigest {
  const content = new Set(contextPackageFiles(entries.map((entry) => entry.path)));
  return digestFiles(entries.filter((entry) => content.has(entry.path)));
}

/** The terms a package's mappings produce: what a recipe or a baseline may name. */
interface Terminology {
  classes: Map<string, string>;
  properties: Map<string, string>;
  relations: Map<string, string>;
}

function collectTerminology(mappings: Record<string, Mapping>): Terminology {
  const terminology: Terminology = { classes: new Map(), properties: new Map(), relations: new Map() };
  const add = (index: Map<string, string>, term: string, where: string): void => {
    if (!index.has(term)) index.set(term, where);
  };

  for (const [path, mapping] of Object.entries(mappings)) {
    if (mapping.kind === 'EntityMapping') {
      add(terminology.classes, mapping.spec.entity, `${path} spec.entity`);
      for (const [column, property] of Object.entries(mapping.spec.properties)) {
        add(terminology.properties, property.property, `${path} spec.properties.${column}`);
      }
      for (const relation of mapping.spec.relations) {
        // Never invent a relation: the relation and its target class come from the mapping.
        add(terminology.relations, relation.property, `${path} spec.relations`);
        add(terminology.classes, relation.targetEntity, `${path} spec.relations`);
      }
      continue;
    }
    for (const term of mapping.spec.extraction.entityTypes) {
      add(terminology.classes, term, `${path} spec.extraction.entityTypes`);
    }
    for (const term of mapping.spec.extraction.relationTypes) {
      add(terminology.relations, term, `${path} spec.extraction.relationTypes`);
    }
  }
  return terminology;
}

function checkTerm(
  report: Report,
  index: Map<string, string>,
  term: string,
  path: string,
  label: string,
  remediation: string,
): void {
  if (index.has(term)) return;
  error(
    report,
    'context_reference_unknown',
    path,
    `${term} is not a ${label} any mapping in this package declares`,
    remediation,
  );
}

export function checkContextPackage(input: CheckContextPackageInput): ContextPackageReport {
  const report: Report = { errors: [], warnings: [] };
  const { manifest, documents, files } = input;
  const customer = manifest.metadata.customer;
  const spec = manifest.spec;
  const semanticModel = documents.semanticModel;
  const modelPath = spec.semanticModelRef;

  const requireFile = (path: string, slot: string): boolean => {
    if (files.includes(path)) return true;
    error(report, 'context_file_missing', slot, `${slot} names ${path}, which is not in the package`, `add ${path} to the package, or fix ${slot}`);
    return false;
  };

  // ---- the manifest names the package: every declared file must exist ------
  requireFile(modelPath, 'spec.semanticModelRef');
  for (const [index, path] of spec.contextSources.entries()) requireFile(path, `spec.contextSources[${index}]`);
  for (const [index, path] of spec.recipes.entries()) requireFile(path, `spec.recipes[${index}]`);
  requireFile(spec.permissionsRef, 'spec.permissionsRef');
  for (const [index, path] of spec.evals.entries()) requireFile(path, `spec.evals[${index}]`);

  if (semanticModel === undefined) {
    error(report, 'context_file_missing', 'spec.semanticModelRef', `${modelPath} is not a SemanticModel document`);
  }

  // ---- one Customer per package --------------------------------------------
  const ownerOf = (path: string, document: { metadata: { customer: string } } | undefined): void => {
    if (document === undefined || document.metadata.customer === customer) return;
    error(
      report,
      'context_package_invalid',
      `${path} metadata.customer`,
      `${path} belongs to Customer ${document.metadata.customer}, but the package is ${customer}; a package is one Customer's semantics`,
      `move ${path} to the ${document.metadata.customer} package, or fix metadata.customer`,
    );
  };
  ownerOf(modelPath, semanticModel);
  for (const [path, document] of Object.entries({
    ...documents.contextSources,
    ...documents.mappings,
    ...documents.recipes,
    ...documents.evals,
  })) {
    ownerOf(path, document);
  }
  ownerOf(spec.permissionsRef, documents.permissions);

  const sources = semanticModel === undefined ? [] : semanticModel.spec.sources;

  // ---- the compatibility claim is checked, not merely declared -------------
  if (input.compatibility !== undefined) {
    const declared = spec.compatibility;
    const pairs: Array<[string, string | number, string]> = [
      ['graphSchema', declared.graphSchema, input.compatibility.graphSchema],
      ['auditSchema', declared.auditSchema, input.compatibility.auditSchema],
    ];
    for (const [field, claim, pinned] of pairs) {
      if (String(claim) === pinned) continue;
      error(
        report,
        'context_compatibility_mismatch',
        `spec.compatibility.${field}`,
        `the package declares ${field} ${String(claim)}, but the pinned toolchain is ${pinned}; the Context Graph it compiles to would not match the deployment`,
        're-freeze the package against the pinned toolchain, or pin the toolchain the package was frozen against',
      );
    }
  }

  // ---- the Semantic Model and the manifest list the same files -------------
  if (semanticModel !== undefined) {
    const agree = (declared: ReadonlyArray<string>, listed: ReadonlyArray<string>, slot: string, why: string): void => {
      for (const path of declared) {
        if (listed.includes(path)) continue;
        error(
          report,
          'semantic_model_invalid',
          `${modelPath} spec.${slot}`,
          `the manifest declares ${path}, which the Semantic Model does not list under spec.${slot}`,
          `add ${path} to the Semantic Model, or remove it from the manifest`,
        );
      }
      for (const path of listed) {
        if (declared.includes(path)) continue;
        error(
          report,
          'semantic_model_invalid',
          `${modelPath} spec.${slot}`,
          `the Semantic Model lists ${path}, which the manifest does not declare; ${why}`,
          `add ${path} to the manifest, or remove it from the Semantic Model`,
        );
      }
    };
    agree(spec.contextSources, sources.map((source) => source.contextSource), 'sources', 'an undeclared source is not part of the package');
    agree(spec.recipes, semanticModel.spec.recipes.map((entry) => entry.ref), 'recipes', 'a recipe outside the manifest is not compiled');
    agree(spec.evals, semanticModel.spec.evals.map((entry) => entry.ref), 'evals', 'an eval suite outside the manifest is not frozen with the package');

    if (semanticModel.spec.permissions.ref !== spec.permissionsRef) {
      error(
        report,
        'semantic_model_invalid',
        `${modelPath} spec.permissions.ref`,
        `the Semantic Model binds ${semanticModel.spec.permissions.ref}, but the manifest declares ${spec.permissionsRef}`,
        'a package has one permission baseline; point both at it',
      );
    }

    // Each source id resolves to one document, and that document agrees.
    const sourceIds = new Map<string, string>();
    for (const [index, source] of sources.entries()) {
      const path = source.contextSource;
      const previous = sourceIds.get(source.ref);
      if (previous !== undefined) {
        error(
          report,
          'context_reference_unknown',
          `${modelPath} spec.sources[${index}].ref`,
          `source ${source.ref} is declared twice (${previous} and ${path})`,
          'one source id resolves to one definition; a recipe stage selects it by that id',
        );
      } else {
        sourceIds.set(source.ref, path);
      }

      const document = documents.contextSources[path];
      if (document === undefined) continue;
      if (document.metadata.name !== source.ref) {
        error(
          report,
          'context_reference_unknown',
          `${modelPath} spec.sources[${index}].ref`,
          `source ${source.ref} points at ${path}, which declares metadata.name ${document.metadata.name}`,
          'make the source id and the document name agree',
        );
      }
      if (input.connectors !== undefined && !input.connectors.includes(document.spec.connectorRef)) {
        error(
          report,
          'context_reference_unknown',
          `${path} spec.connectorRef`,
          `connector ${document.spec.connectorRef} is not in the workspace, so source ${source.ref} has nothing to read from`,
          `vendor the ${document.spec.connectorRef} connector under the workspace asset root, or fix the reference`,
        );
      }
    }

    // ---- ontology modules and extensions: the digest must be the content ---
    for (const [index, module] of semanticModel.spec.ontology.modules.entries()) {
      const vendored = input.ontologyModules?.[module.ref];
      if (vendored === undefined || vendored === module.digest) continue;
      error(
        report,
        'context_digest_mismatch',
        `${modelPath} spec.ontology.modules[${index}].digest`,
        `the package was modelled against ${module.ref} at ${module.digest}, but the vendored module is ${vendored}`,
        're-freeze the package against the pinned module version, or vendor the version the package declares',
      );
    }
    for (const [index, extension] of semanticModel.spec.ontology.extensions.entries()) {
      const slot = `${modelPath} spec.ontology.extensions[${index}]`;
      if (!requireFile(extension.path, slot)) continue;
      const actual = input.fileDigests?.[extension.path];
      if (actual === undefined || actual === extension.digest) continue;
      error(
        report,
        'context_digest_mismatch',
        `${slot}.digest`,
        `${extension.path} declares ${extension.digest}, but the file is ${actual}`,
        'recompute the digest after editing the extension, or restore the frozen file',
      );
    }

    // ---- mappings read through the connector their source declares ---------
    for (const [index, entry] of semanticModel.spec.entityMappings.entries()) {
      const path = entry.ref;
      const slot = `${modelPath} spec.entityMappings[${index}]`;
      if (!requireFile(path, slot)) continue;
      const mapping = documents.mappings[path];
      if (mapping === undefined) {
        error(report, 'context_file_missing', slot, `${path} is not an EntityMapping or DocumentMapping document`);
        continue;
      }
      const source = sources.find((candidate) => candidate.ref === mapping.metadata.source);
      const sourceDocument = source === undefined ? undefined : documents.contextSources[source.contextSource];
      if (source === undefined || sourceDocument === undefined) {
        error(
          report,
          'context_reference_unknown',
          `${path} metadata.source`,
          `mapping ${path} declares source ${mapping.metadata.source}, which the Semantic Model does not declare`,
          'declare the source in spec.sources, or fix metadata.source',
        );
        continue;
      }
      if (sourceDocument.spec.connectorRef !== mapping.spec.connectorRef) {
        error(
          report,
          'context_reference_unknown',
          `${path} spec.connectorRef`,
          `mapping ${path} reads through connector ${mapping.spec.connectorRef}, but source ${mapping.metadata.source} uses ${sourceDocument.spec.connectorRef}`,
          'a mapping reads through the connector its source declares',
        );
      }
    }
  }

  const terminology = collectTerminology(documents.mappings);

  // ---- recipes: the pipeline, the terms it names, the baseline it masks with -
  for (const [path, recipe] of Object.entries(documents.recipes)) {
    checkRecipe(report, {
      path,
      recipe,
      sourceIds: new Set(sources.map((source) => source.ref)),
      terminology,
      permissionsRef: spec.permissionsRef,
      files,
      ...(semanticModel === undefined ? {} : { semanticModel }),
    });
  }

  // ---- permissions: every annotation names a term that exists ---------------
  if (documents.permissions !== undefined) {
    checkPermissions(report, { path: spec.permissionsRef, profile: documents.permissions, terminology });
  }

  // ---- eval suites: the recipe, its version, and the inputs it accepts ------
  for (const [path, suite] of Object.entries(documents.evals)) {
    checkEvalSuite(report, { path, suite, recipes: documents.recipes, terminology });
  }

  // ---- every declarative file under a package directory is declared -------
  // A file the manifest does not name is digested (it is content) but never
  // compiled, which reads as "this mapping is in force" when it is not.
  // `ontology/` is exempt: the Customer extension is declared above, while a copy
  // of a Domain Ontology module is a reference to the vendored template (§3.3).
  const declared = new Set<string>([
    modelPath,
    spec.permissionsRef,
    ...spec.contextSources,
    ...spec.recipes,
    ...spec.evals,
    ...(semanticModel?.spec.entityMappings.map((entry) => entry.ref) ?? []),
    ...(semanticModel?.spec.ontology.extensions.map((extension) => extension.path) ?? []),
  ]);
  for (const path of files) {
    if (!/^(context-sources|mappings|recipes|evals)\//.test(path)) continue;
    if (declared.has(path)) continue;
    warn(report, 'context_file_unused', path, 'is in the package but no document declares it: it is digested, not compiled');
  }

  // ---- a frozen version is immutable --------------------------------------
  checkRevision(report, input);

  // ---- the L1 gate needs something to run ---------------------------------
  const questions = Object.values(documents.evals).reduce((total, suite) => total + suite.spec.questions.length, 0);
  if (questions === 0) {
    const slot = spec.evals.length === 0 ? 'spec.evals' : (spec.evals[0] as string);
    warn(
      report,
      'context_eval_missing',
      slot,
      'the package declares no Context Eval question, so freezing it would ship semantics nothing measured',
    );
  }

  return report;
}

interface RecipeContext {
  path: string;
  recipe: ContextRecipe;
  sourceIds: Set<string>;
  terminology: Terminology;
  permissionsRef: string;
  files: ReadonlyArray<string>;
  semanticModel?: SemanticModel;
}

function checkRecipe(report: Report, context: RecipeContext): void {
  const { path, recipe } = context;
  const stages = recipe.spec.stages;

  // The pipeline is ordered, each stage runs at most once, and mask + budget are
  // mandatory: they are the two stages that cannot be dropped without either
  // leaking data or overflowing the prompt.
  const seen = new Set<string>();
  let highest = -1;
  for (const [index, stage] of stages.entries()) {
    const slot = `${path} spec.stages[${index}]`;
    if (seen.has(stage.type)) {
      error(report, 'context_recipe_invalid', slot, `stage ${stage.type} appears twice; the pipeline runs each stage at most once`, 'remove the duplicate stage');
    }
    seen.add(stage.type);

    const position = RECIPE_STAGE_ORDER.indexOf(stage.type);
    if (position < highest) {
      error(
        report,
        'context_recipe_invalid',
        slot,
        `stage ${stage.type} comes after a later stage; the pipeline is ${RECIPE_STAGE_ORDER.join(' → ')}`,
        `move ${stage.type} earlier so the stages follow the canonical order`,
      );
    }
    highest = Math.max(highest, position);
  }
  for (const mandatory of ['mask', 'budget'] as const) {
    if (seen.has(mandatory)) continue;
    error(
      report,
      'context_recipe_invalid',
      `${path} spec.stages`,
      `recipe ${recipe.metadata.name} has no ${mandatory} stage`,
      mandatory === 'mask'
        ? 'a recipe without mask returns unmasked items; add a mask stage bound to the package baseline'
        : 'a recipe without budget can overflow the prompt; add a budget stage',
    );
  }

  if (context.semanticModel !== undefined) {
    const expected = `${context.semanticModel.metadata.name}@${context.semanticModel.metadata.version}`;
    if (recipe.spec.semanticModelRef !== expected) {
      error(
        report,
        'context_reference_unknown',
        `${path} spec.semanticModelRef`,
        `recipe ${recipe.metadata.name} binds Semantic Model ${recipe.spec.semanticModelRef}, but the package's model is ${expected}`,
        `write semanticModelRef: ${expected}, or freeze the recipe against its own package`,
      );
    }
  }

  for (const [index, stage] of stages.entries()) {
    const slot = `${path} spec.stages[${index}]`;
    switch (stage.type) {
      case 'resolve':
        checkTerm(report, context.terminology.classes, stage.entity, `${slot}.entity`, 'class', 'map the class from a source, or drop the resolve stage');
        break;
      case 'structured':
        if (!context.sourceIds.has(stage.source)) {
          error(report, 'context_reference_unknown', `${slot}.source`, `source ${stage.source} is not declared by the Semantic Model`, 'declare the source, or fix the stage');
        }
        for (const [position, term] of stage.entities.entries()) {
          checkTerm(report, context.terminology.classes, term, `${slot}.entities[${position}]`, 'class', 'map the class from a source before retrieving it');
        }
        break;
      case 'graph':
        for (const [position, relation] of stage.relations.entries()) {
          checkTerm(report, context.terminology.relations, relation, `${slot}.relations[${position}]`, 'relation', 'map the relation from a source, or drop it from the stage');
        }
        break;
      case 'lexical':
        if (!context.sourceIds.has(stage.source)) {
          error(report, 'context_reference_unknown', `${slot}.source`, `source ${stage.source} is not declared by the Semantic Model`, 'declare the source, or fix the stage');
        }
        break;
      case 'mask':
        if (stage.permissions !== context.permissionsRef) {
          error(
            report,
            'context_recipe_invalid',
            `${slot}.permissions`,
            `the mask stage binds ${stage.permissions}, but the package baseline is ${context.permissionsRef}; a recipe cannot substitute a different baseline`,
            `write permissions: ${context.permissionsRef}`,
          );
        }
        break;
      case 'merge':
      case 'rank':
      case 'budget':
        break;
    }
  }

  const outputSchema = recipe.spec.output.schema;
  if (outputSchema !== undefined && !context.files.includes(outputSchema)) {
    error(report, 'context_file_missing', `${path} spec.output.schema`, `output schema ${outputSchema} is not in the package`, `add ${outputSchema}, or drop spec.output.schema`);
  }
}

function checkPermissions(
  report: Report,
  context: { path: string; profile: PermissionProfile; terminology: Terminology },
): void {
  const { path, profile, terminology } = context;
  const spec = profile.spec;

  for (const term of Object.keys(spec.classifications)) {
    checkTerm(report, terminology.classes, term, `${path} spec.classifications.${term}`, 'class', 'map the class, or drop the annotation');
  }
  for (const term of Object.keys(spec.properties)) {
    checkTerm(report, terminology.properties, term, `${path} spec.properties.${term}`, 'property', 'a mask on a property no mapping declares never applies; map the property, or drop the annotation');
  }
  for (const term of Object.keys(spec.rowFilters)) {
    checkTerm(report, terminology.classes, term, `${path} spec.rowFilters.${term}`, 'class', 'a row filter on a class no mapping declares is never pushed down; map the class, or drop the filter');
  }
  for (const term of Object.keys(spec.scopes)) {
    checkTerm(report, terminology.classes, term, `${path} spec.scopes.${term}`, 'class', 'a scope on a class no mapping declares protects nothing; map the class, or drop the entry');
  }

  for (const term of terminology.classes.keys()) {
    if (Object.hasOwn(spec.classifications, term)) continue;
    warn(
      report,
      'context_permissions_unclassified',
      `${path} spec.classifications`,
      `${term} has no classification entry; retrieval treats it as ${spec.defaults.unknownClassification}`,
    );
  }
}

function checkEvalSuite(
  report: Report,
  context: {
    path: string;
    suite: ContextEvalSuite;
    recipes: Record<string, ContextRecipe>;
    terminology: Terminology;
  },
): void {
  const { path, suite, recipes, terminology } = context;
  const at = suite.spec.recipeRef.lastIndexOf('@');
  const name = at < 0 ? suite.spec.recipeRef : suite.spec.recipeRef.slice(0, at);
  const recipe = Object.values(recipes).find((candidate) => candidate.metadata.name === name);

  if (name === '' || recipe === undefined) {
    error(
      report,
      'context_reference_unknown',
      `${path} spec.recipeRef`,
      `eval suite ${suite.metadata.name} evaluates recipe ${suite.spec.recipeRef}, which is not in the package`,
      'add the recipe to the package, or fix recipeRef',
    );
    return;
  }
  if (suite.spec.recipeRef !== `${name}@${recipe.metadata.version}`) {
    error(
      report,
      'context_reference_unknown',
      `${path} spec.recipeRef`,
      `eval suite ${suite.metadata.name} evaluates ${suite.spec.recipeRef}, but the package's ${name} recipe is ${recipe.metadata.version}`,
      `write recipeRef: ${name}@${recipe.metadata.version}`,
    );
  }

  // A golden question's expected entities are `ic:Claim/C-1001` ids: if the class
  // half names nothing the package produces, the recall threshold can never be met.
  for (const [index, question] of suite.spec.questions.entries()) {
    for (const [position, entity] of question.expectedEntities.entries()) {
      const separator = entity.indexOf('/');
      const term = separator < 0 ? '' : entity.slice(0, separator);
      if (term === '' || !terminology.classes.has(term)) {
        error(
          report,
          'context_reference_unknown',
          `${path} spec.questions[${index}].expectedEntities[${position}]`,
          `question ${question.id} expects ${entity}, but ${term || entity} is not a class any mapping in this package declares`,
          'map the class from a source, or fix the expected entity',
        );
      }
    }
  }

  // `query`/`filters` are the run-time inputs every recipe accepts; everything
  // else must be declared, or the stage that reads it fails at run time.
  const allowed = new Set([...Object.keys(recipe.spec.inputSchema.properties ?? {}), 'query', 'filters']);
  for (const [index, question] of suite.spec.questions.entries()) {
    for (const key of Object.keys(question.input)) {
      if (allowed.has(key)) continue;
      error(
        report,
        'context_reference_unknown',
        `${path} spec.questions[${index}].input.${key}`,
        `question ${question.id} passes ${key}, which recipe ${name} does not accept`,
        `declare ${key} in the recipe's inputSchema, or fix the question`,
      );
    }
  }
}

function checkRevision(report: Report, input: CheckContextPackageInput): void {
  const { manifest, revision, digest, fileDigests } = input;
  const version = manifest.metadata.version;
  const slot = `revisions/${version}.yaml`;

  if (revision === undefined) {
    if (manifest.metadata.status !== 'frozen') return;
    error(
      report,
      'context_package_not_frozen',
      'metadata.status',
      `${manifest.metadata.name}@${version} declares status frozen, but there is no ${slot}; nothing content-addresses it`,
      'run `fde context freeze`',
    );
    return;
  }

  if (
    revision.metadata.customer !== manifest.metadata.customer ||
    revision.metadata.name !== manifest.metadata.name ||
    revision.metadata.version !== version
  ) {
    error(
      report,
      'context_package_modified',
      `${slot} metadata`,
      `the revision records ${revision.metadata.customer}/${revision.metadata.name}@${revision.metadata.version}, but the package is ${manifest.metadata.customer}/${manifest.metadata.name}@${version}`,
      'restore the frozen manifest, or bump metadata.version and freeze again',
    );
  }

  if (manifest.metadata.status !== 'frozen') {
    error(
      report,
      'context_package_modified',
      'metadata.status',
      `${slot} freezes ${version}, but the manifest declares status ${manifest.metadata.status}; a frozen version does not go back to draft`,
      'restore metadata.status: frozen, or bump metadata.version and freeze again',
    );
  }

  if (digest !== undefined && revision.spec.digest !== digest) {
    error(
      report,
      'context_package_modified',
      `${slot} spec.digest`,
      `the frozen revision records ${revision.spec.digest}, but the package content digests to ${digest}`,
      'restore the frozen content, or bump metadata.version and freeze again; a frozen version is immutable',
    );
  }

  if (fileDigests === undefined) return;
  const changed = changedFiles(revision.spec.files, fileDigests);
  if (changed.length === 0) return;
  error(
    report,
    'context_package_modified',
    `${slot} spec.files`,
    `the frozen revision and the package disagree on ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more file(s)` : ''}`,
    'restore the frozen content, or bump metadata.version and freeze again',
  );
}

function changedFiles(frozen: Record<string, string>, actual: Record<string, string>): string[] {
  const paths = [...new Set([...Object.keys(frozen), ...Object.keys(actual)])].sort();
  return paths.filter((path) => frozen[path] !== actual[path]);
}
