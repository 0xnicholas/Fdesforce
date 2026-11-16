import { basename, dirname, join } from 'node:path';

import {
  digestFiles,
  digestOf,
  parseRuntimeProfile,
  type Digest,
  type ModelProfile,
  type PolicyTemplateView,
  type RuntimeProfile,
} from '@fde/spec';

import type {
  Catalogues,
  ContextPackageArtifact,
  DirArtifact,
  DocArtifact,
  TemplateType,
} from './artifacts.js';
import { asArray, asRecord, asString, isFile, readText } from './fsutil.js';
import { parseRef } from './refs.js';
import type { Diagnostic } from './types.js';

export interface ConcreteAsset {
  version: string;
  digest: Digest;
  files: Record<string, Digest>;
  materializedFrom?: string;
}

export interface ModelProfileAsset {
  pin: string;
  document: ModelProfile;
}

export interface ConnectorAsset {
  digest: Digest;
  files: Record<string, Digest>;
  document: Record<string, unknown>;
}

/**
 * Everything the Spec references, resolved against the vendored stores. Works
 * on the raw YAML document: resolution is independent of schema validity, so
 * `validate` can report a schema error and an unvendored template in one run.
 */
export interface ResolvedArtifacts {
  templates: Record<Exclude<TemplateType, 'solution'>, Record<string, DirArtifact>>;
  overlays: Record<string, DirArtifact>;
  extensions: Record<string, DirArtifact>;
  models: Record<string, ModelProfileAsset>;
  policyAssets: Record<string, ConcreteAsset & { document: Record<string, unknown> }>;
  policyViews: Record<string, PolicyTemplateView>;
  evalTemplates: Record<string, DirArtifact>;
  evalSuites: Record<string, ConcreteAsset & { document: Record<string, unknown> }>;
  evalDatasets: Record<string, string>;
  connectors: Record<string, ConnectorAsset>;
  contextPackage?: ContextPackageArtifact;
  runtimeProfile?: { pin: string; document: RuntimeProfile };
  errors: Diagnostic[];
}

function versionPin(version: string, digest: Digest): string {
  return `${version}@${digest}`;
}

function concreteAsset(artifact: DocArtifact): ConcreteAsset {
  const file = basename(artifact.path);
  const digest = artifact.digest;
  return { version: artifact.version ?? '0.0.0', digest, files: { [file]: digest } };
}

const MATERIALIZED_FROM = /^([a-z][A-Za-z0-9-]*)\/([a-z0-9][a-z0-9.-]*)@([0-9]+\.[0-9]+\.[0-9]+)$/;

/**
 * `materializedFrom: eval/triage-quality@1.0.0` records which Template a concrete
 * Customer asset came from (ADR-0007). It is a claim to verify, not decoration:
 * the named Template must be vendored and is pinned alongside the asset.
 */
function materializedFrom(
  document: Record<string, unknown>,
  expectedType: 'policy' | 'eval',
  path: string,
  errors: Diagnostic[],
): { ref: string; provenance: string; name: string; version: string } | undefined {
  const value = asString(document['materializedFrom']);
  if (value === undefined) return undefined;
  const match = MATERIALIZED_FROM.exec(value);
  if (match === null) {
    errors.push({
      code: 'asset_provenance_invalid',
      message: `${path} declares materializedFrom ${value}, expected <type>/<name>@<version>`,
      path: `${path}.materializedFrom`,
      remediation: `write materializedFrom: ${expectedType}/<template-name>@<x.y.z>`,
    });
    return undefined;
  }
  const [, type = '', name = '', version = ''] = match;
  if (type !== expectedType) {
    errors.push({
      code: 'asset_provenance_invalid',
      message: `${path} declares materializedFrom of type ${type}, expected ${expectedType}`,
      path: `${path}.materializedFrom`,
    });
    return undefined;
  }
  return { ref: `${name}@${version}`, provenance: `${type}/${name}@${version}`, name, version };
}

function recordArtifact<T extends { name: string; version: string; digest: Digest }>(
  map: Record<string, T>,
  artifact: T,
  label: string,
  path: string,
  errors: Diagnostic[],
): void {
  const existing = map[artifact.name];
  if (existing !== undefined && existing.digest !== artifact.digest) {
    errors.push({
      code: 'artifact_conflict',
      message: `${label} ${artifact.name} resolves to two versions: ${existing.version} and ${artifact.version}`,
      path,
      remediation: 'use one compatible range for the same artifact id, or vendor a single version',
    });
    return;
  }
  map[artifact.name] = artifact;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const text = asString(value);
    if (text !== undefined) return text;
  }
  return undefined;
}

/** `policyRefs` entries are `string` or `{ref, args?, appliesTo?}`. */
function policyRefsOf(value: unknown, path: string): Array<{ ref: string; path: string }> {
  return asArray(value).flatMap((entry, index) => {
    const ref = typeof entry === 'string' ? entry : firstString(asRecord(entry)['ref']);
    return ref === undefined ? [] : [{ ref, path: `${path}[${index}]` }];
  });
}

export function resolveArtifacts(catalogues: Catalogues, raw: Record<string, unknown>): ResolvedArtifacts {
  const errors: Diagnostic[] = [];
  const resolved: ResolvedArtifacts = {
    templates: { capability: {}, policy: {}, eval: {}, ontology: {}, 'deployment-profile': {} } as ResolvedArtifacts['templates'],
    overlays: {},
    extensions: {},
    models: {},
    policyAssets: {},
    policyViews: {},
    evalTemplates: {},
    evalSuites: {},
    evalDatasets: {},
    connectors: {},
    errors,
  };

  const spec = asRecord(raw['spec']);

  const addTemplate = (type: Exclude<TemplateType, 'solution'>, ref: string, path: string): DirArtifact | undefined => {
    const result = catalogues.templates[type].resolve(ref, path);
    if (!result.ok) {
      errors.push(result.error);
      return undefined;
    }
    recordArtifact(resolved.templates[type], result.value, `${type} template`, path, errors);
    return result.value;
  };

  const addPolicy = (ref: string, path: string): void => {
    const { name } = parseRef(ref);
    if (catalogues.policyAssets.has(name)) {
      const result = catalogues.policyAssets.resolve(ref, path);
      if (!result.ok) {
        errors.push(result.error);
        return;
      }
      const asset = concreteAsset(result.value);
      const existing = resolved.policyAssets[name];
      if (existing !== undefined && existing.digest !== asset.digest) {
        errors.push({
          code: 'artifact_conflict',
          message: `policy asset ${name} resolves to two versions: ${existing.version} and ${asset.version}`,
          path,
        });
        return;
      }
      const origin = materializedFrom(result.value.document, 'policy', `policy asset ${name}`, errors);
      if (origin !== undefined && addTemplate('policy', origin.ref, `assets.policies.${name}.materializedFrom`) === undefined) {
        return;
      }
      resolved.policyAssets[name] = {
        ...asset,
        ...(origin === undefined ? {} : { materializedFrom: origin.provenance }),
        document: result.value.document,
      };
      resolved.policyViews[name] = result.value.document as unknown as PolicyTemplateView;
      return;
    }
    const artifact = addTemplate('policy', ref, path);
    if (artifact !== undefined) resolved.policyViews[name] = artifact.document as unknown as PolicyTemplateView;
  };

  const addEvalSuite = (ref: string, path: string): void => {
    const { name } = parseRef(ref);
    if (catalogues.evalSuites.has(name)) {
      const result = catalogues.evalSuites.resolve(ref, path);
      if (!result.ok) {
        errors.push(result.error);
        return;
      }
      const asset = concreteAsset(result.value);
      const existing = resolved.evalSuites[name];
      if (existing !== undefined && existing.digest !== asset.digest) {
        errors.push({
          code: 'artifact_conflict',
          message: `Eval Suite ${name} resolves to two versions: ${existing.version} and ${asset.version}`,
          path,
        });
        return;
      }
      const origin = materializedFrom(result.value.document, 'eval', `Eval Suite ${name}`, errors);
      if (origin !== undefined && addTemplate('eval', origin.ref, `assets.evalSuites.${name}.materializedFrom`) === undefined) {
        return;
      }
      resolved.evalSuites[name] = {
        ...asset,
        ...(origin === undefined ? {} : { materializedFrom: origin.provenance }),
        document: result.value.document,
      };
      return;
    }
    const artifact = addTemplate('eval', ref, path);
    if (artifact !== undefined) resolved.evalTemplates[name] = artifact;
  };

  const addModelProfile = (ref: string, path: string, seen = new Set<string>()): void => {
    const { name } = parseRef(ref);
    if (seen.has(name)) return;
    seen.add(name);

    const result = catalogues.modelProfiles.resolve(ref, path);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    const document = result.value.document as ModelProfile;
    const version = asString(asRecord(result.value.document['metadata'])['version']) ?? result.value.version ?? '0.0.0';
    const pin = versionPin(version, result.value.digest);
    if (resolved.models[name] === undefined) {
      resolved.models[name] = { pin, document };
    } else if (resolved.models[name]?.pin !== pin) {
      errors.push({
        code: 'artifact_conflict',
        message: `Model Profile ${name} resolves to two versions: ${resolved.models[name]?.pin ?? ''} and ${pin}`,
        path,
      });
    }
    for (const [index, fallback] of asArray(asRecord(document['spec'])['fallback']).entries()) {
      const fallbackRef = asString(asRecord(fallback)['profile']);
      if (fallbackRef !== undefined) addModelProfile(fallbackRef, `${path}.fallback[${index}].profile`, seen);
    }
  };

  const addOverlay = (ref: string, path: string): void => {
    const result = catalogues.overlays.resolve(ref, path);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    recordArtifact(resolved.overlays, result.value, 'overlay', path, errors);
  };

  const addExtension = (ref: string, path: string): void => {
    const result = catalogues.extensions.resolve(ref, path);
    if (!result.ok) {
      errors.push(result.error);
      return;
    }
    recordArtifact(resolved.extensions, result.value, 'extension', path, errors);
  };

  // Capabilities, their governance bindings and implementation refs.
  for (const [capabilityId, rawBinding] of Object.entries(asRecord(spec['capabilities']))) {
    const binding = asRecord(rawBinding);
    const path = `spec.capabilities.${capabilityId}`;
    const template = asString(binding['template']);
    if (template !== undefined) addTemplate('capability', template, `${path}.template`);
    for (const policy of policyRefsOf(binding['policyRefs'], `${path}.policyRefs`)) addPolicy(policy.ref, policy.path);
    for (const [index, entry] of asArray(binding['evalRefs']).entries()) {
      const ref = asString(entry);
      if (ref !== undefined) addEvalSuite(ref, `${path}.evalRefs[${index}]`);
    }
    for (const [index, entry] of asArray(binding['overlayRefs']).entries()) {
      const ref = asString(entry);
      if (ref !== undefined) addOverlay(ref, `${path}.overlayRefs[${index}]`);
    }
    for (const [index, entry] of asArray(binding['extensionRefs']).entries()) {
      const ref = asString(entry);
      if (ref !== undefined) addExtension(ref, `${path}.extensionRefs[${index}]`);
    }
  }

  // Agents: model profiles (including fallbacks) and policies.
  for (const [agentId, rawAgent] of Object.entries(asRecord(spec['agents']))) {
    const agent = asRecord(rawAgent);
    const path = `spec.agents.${agentId}`;
    const profile = asString(agent['modelProfile']);
    if (profile !== undefined) addModelProfile(profile, `${path}.modelProfile`);
    for (const policy of policyRefsOf(agent['policyRefs'], `${path}.policyRefs`)) addPolicy(policy.ref, policy.path);
    const embedding = asString(asRecord(asRecord(agent['memory'])['longTerm'])['embeddingProfile']);
    if (embedding !== undefined) addModelProfile(embedding, `${path}.memory.longTerm.embeddingProfile`);
  }

  // Workflows: policies, approval predicates and step output schemas are
  // handled by the project's file collection.
  for (const [workflowId, rawWorkflow] of Object.entries(asRecord(spec['workflows']))) {
    const workflow = asRecord(rawWorkflow);
    const path = `spec.workflows.${workflowId}`;
    for (const policy of policyRefsOf(workflow['policyRefs'], `${path}.policyRefs`)) addPolicy(policy.ref, policy.path);

    for (const [index, rawStep] of asArray(workflow['steps']).entries()) {
      const step = asRecord(rawStep);
      if (asString(step['type']) !== 'approval') continue;
      const predicate = asString(asRecord(step['requiredWhen'])['predicate']);
      if (predicate === undefined) continue;
      const predicatePath = `${path}.steps[${index}].requiredWhen.predicate`;
      addPolicy(predicate, predicatePath);
      const policy = resolved.policyViews[parseRef(predicate).name];
      if (policy !== undefined && asRecord(policy['spec'])['predicate'] === undefined) {
        errors.push({
          code: 'predicate_unknown',
          message: `Policy ${parseRef(predicate).name} declares no predicate; an approval gate can only bind a named Policy predicate`,
          path: predicatePath,
          remediation: 'bind a Policy Template whose spec.predicate names the predicate kind, or drop requiredWhen',
        });
      }
    }
  }

  // Tools: connectors are Customer assets; their data contract is part of the pin.
  for (const [toolId, rawTool] of Object.entries(asRecord(spec['tools']))) {
    const tool = asRecord(rawTool);
    const connectorRef = asString(tool['connectorRef']);
    if (connectorRef === undefined) continue;
    const connector = catalogues.connectors.get(connectorRef);
    const path = `spec.tools.${toolId}.connectorRef`;
    if (connector === undefined) {
      errors.push({
        code: 'artifact_missing',
        message: `connector ${connectorRef} is not in the workspace`,
        path,
        remediation: 'vendor the connector under the workspace asset root or fix the reference',
      });
      continue;
    }
    const connectorDir = dirname(connector.path);
    const files = [basename(connector.path)];
    const contract = asString(asRecord(connector.document['spec'])['dataContract']);
    if (contract !== undefined) {
      if (!isFile(join(connectorDir, contract))) {
        errors.push({
          code: 'spec_file_missing',
          message: `connector ${connectorRef} declares dataContract ${contract}, which does not exist`,
          path,
        });
        continue;
      }
      files.push(contract);
    }
    const manifest = digestFiles(files.map((file) => ({ path: file, content: readText(join(connectorDir, file)) })));
    resolved.connectors[connectorRef] = { digest: manifest.digest, files: manifest.files, document: connector.document };
  }

  // Solution-level governance.
  const governance = asRecord(spec['governance']);
  for (const policy of policyRefsOf(governance['policies'], 'spec.governance.policies')) addPolicy(policy.ref, policy.path);
  for (const [index, entry] of asArray(governance['evalSuites']).entries()) {
    const ref = asString(entry);
    if (ref !== undefined) addEvalSuite(ref, `spec.governance.evalSuites[${index}]`);
  }

  for (const [index, entry] of asArray(spec['overlays']).entries()) {
    const ref = asString(entry);
    if (ref !== undefined) addOverlay(ref, `spec.overlays[${index}]`);
  }
  for (const [index, entry] of asArray(spec['extensions']).entries()) {
    const ref = asString(entry);
    if (ref !== undefined) addExtension(ref, `spec.extensions[${index}]`);
  }

  // Context Package + the ontology modules it declares.
  const contextPackageRef = asString(asRecord(spec['semantic'])['contextPackageRef']);
  if (contextPackageRef !== undefined) {
    const result = catalogues.contextPackages.resolve(contextPackageRef, 'spec.semantic.contextPackageRef');
    if (!result.ok) {
      errors.push(result.error);
    } else {
      resolved.contextPackage = result.value;
      const ontology = asRecord(asRecord(result.value.semanticModel?.['spec'])['ontology']);
      for (const [index, rawModule] of asArray(ontology['modules']).entries()) {
        const module = asRecord(rawModule);
        const ref = asString(module['ref']);
        if (ref === undefined || asString(module['source']) !== 'template') continue;
        const artifact = addTemplate('ontology', ref, `semantic-model ontology modules[${index}]`);
        const declared = asString(module['digest']);
        if (artifact !== undefined && declared !== undefined && declared !== artifact.digest) {
          errors.push({
            code: 'ontology_digest_mismatch',
            message: `Context Package declares ontology ${ref} digest ${declared}, but the vendored template is ${artifact.digest}`,
            path: `semantic-model ontology modules[${index}].digest`,
            remediation: 're-freeze the Context Package against the pinned ontology version',
          });
        }
      }
    }
  }

  // Deployment profile: a logical name; the lock pins the highest vendored version.
  const deploymentProfile = asString(asRecord(spec['deployment'])['profile']);
  if (deploymentProfile !== undefined) {
    addTemplate('deployment-profile', deploymentProfile, 'spec.deployment.profile');
  }

  // Eval datasets are declared by the concrete Eval Suite; the manifest, when
  // vendored, must agree with the declared version and digest.
  for (const [suiteName, suite] of Object.entries(resolved.evalSuites)) {
    const datasetRef = asRecord(asRecord(suite.document['spec'])['datasetRef']);
    const id = asString(datasetRef['id']);
    const version = asString(datasetRef['version']);
    const digest = asString(datasetRef['digest']);
    if (id === undefined || version === undefined || digest === undefined) continue;
    resolved.evalDatasets[id] = versionPin(version, digest as Digest);
    if (!catalogues.datasets.has(id)) continue;
    const dataset = catalogues.datasets.resolve(`${id}@${version}`, `evalSuites.${suiteName}.spec.datasetRef`);
    if (!dataset.ok) continue;
    const declared = asString(asRecord(dataset.value.document['spec'])['digest']);
    if (declared !== digest) {
      errors.push({
        code: 'eval_dataset_mismatch',
        message: `Eval Suite ${suiteName} pins dataset ${id}@${version} (${digest}), the dataset manifest declares ${String(declared)}`,
        path: `evalSuites.${suiteName}.spec.datasetRef`,
        remediation: 're-freeze the dataset and update both the suite and the manifest',
      });
    }
  }

  // Runtime Profile: exact version + canonical-document digest.
  const runtimeProfileRef = asString(asRecord(spec['build'])['runtimeProfile']);
  if (runtimeProfileRef !== undefined) {
    const path = 'spec.build.runtimeProfile';
    const result = catalogues.runtimeProfiles.resolve(runtimeProfileRef, path);
    if (!result.ok) {
      errors.push(result.error);
    } else {
      const parsed = parseRuntimeProfile(result.value.document);
      if (!parsed.ok) {
        errors.push(
          ...parsed.errors.map((error) => ({
            ...error,
            path: error.path === undefined ? path : `${path}.${error.path}`,
          })),
        );
      } else {
        resolved.runtimeProfile = {
          pin: `${parsed.value.metadata.name}@${parsed.value.metadata.version}@${digestOf(parsed.value)}`,
          document: parsed.value,
        };
      }
    }
  }

  return resolved;
}
