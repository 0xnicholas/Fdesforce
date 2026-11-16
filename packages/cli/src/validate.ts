import {
  checkSolution,
  type CheckSolutionInput,
  type ConnectorView,
  type ContextPackageView,
  type EvalSuiteView,
  type ModelProfile,
  type PolicyTemplateView,
} from '@fde/spec';

import type { Project } from './project.js';
import { dedupe, type Diagnostic, type Report } from './types.js';

/**
 * Lock freshness is `fde spec lock --check`'s job. During authoring the Spec
 * changes constantly; `validate` reports the stale lock as a warning instead of
 * making every edit look like a broken reference.
 */
const FRESHNESS_CODES = new Set(['lock_digest_mismatch', 'spec_file_unpinned']);

export function validateProject(project: Project): Report {
  // When the Spec parses and the lock exists, `checkSolution` owns the approval
  // predicate checks; the raw resolver only reports them when cross-document
  // validation cannot run.
  const artifactErrors =
    project.spec !== undefined && project.lock !== undefined
      ? project.artifacts.errors.filter((error) => error.code !== 'predicate_unknown')
      : project.artifacts.errors;

  const errors: Diagnostic[] = [
    ...project.errors,
    ...project.specErrors,
    ...project.fileErrors,
    ...project.lockErrors,
    ...artifactErrors,
    ...project.toolchainErrors,
  ];
  const warnings: Diagnostic[] = [...project.catalogProblems];

  if (!project.lockPresent) {
    errors.push({
      code: 'solution_lock_missing',
      message: 'the Solution has no solution.lock; every build input must be pinned before build',
      path: 'solution.lock',
      remediation: 'run `fde spec lock`',
    });
  } else if (project.lock !== undefined && project.spec !== undefined) {
    const report = checkSolution(views(project));
    for (const error of report.errors) {
      if (FRESHNESS_CODES.has(error.code)) {
        warnings.push({ ...error, remediation: error.remediation ?? 'run `fde spec lock` to refresh the lock' });
      } else {
        errors.push(error);
      }
    }
    warnings.push(...report.warnings.map(withWarningRemediation));
  }

  return { errors: dedupe(errors), warnings: dedupe(warnings) };
}

/** Crossref warnings say what is odd; the CLI says what to do about it. */
const WARNING_REMEDIATIONS: Record<string, string> = {
  builtin_tool_field:
    'built-in tools have no typed discriminator yet (GAPS.md GAP-1); bind a connector-backed operation instead',
  build_targets_legacy: 'use build.platform + build.delivery instead of build.targets',
  lock_pin_unused: 'remove the unused pin, or reference the artifact from the Spec',
  memory_scope_agent: 'use the default scope: end_user unless the agent is shared on purpose',
  recipe_binding_unused: 'remove the unused recipe binding, or use it from a workflow context step',
  recipe_binding_mismatch: 'make the binding key and recipeRef name agree',
};

function withWarningRemediation(warning: Diagnostic): Diagnostic {
  const remediation = warning.remediation ?? WARNING_REMEDIATIONS[warning.code];
  return remediation === undefined ? warning : { ...warning, remediation };
}

function views(project: Project): CheckSolutionInput {
  const artifacts = project.artifacts;
  const contextPackage = artifacts.contextPackage;

  return {
    spec: project.spec as CheckSolutionInput['spec'],
    lock: project.lock as CheckSolutionInput['lock'],
    specFiles: project.specFiles,
    policies: artifacts.policyViews as Record<string, PolicyTemplateView>,
    connectors: Object.fromEntries(
      Object.entries(artifacts.connectors).map(([name, asset]) => [name, asset.document as ConnectorView]),
    ),
    modelProfiles: Object.fromEntries(
      Object.entries(artifacts.models).map(([name, model]) => [name, model.document as ModelProfile]),
    ),
    evalSuites: Object.fromEntries(
      Object.entries(artifacts.evalSuites).map(([name, suite]) => [name, suite.document as EvalSuiteView]),
    ),
    ...(contextPackage === undefined
      ? {}
      : {
          contextPackage: {
            manifest: contextPackage.manifest as ContextPackageView['manifest'],
            recipes: contextPackage.recipes as NonNullable<ContextPackageView['recipes']>,
          },
        }),
    ...(artifacts.runtimeProfile === undefined ? {} : { runtimeProfile: artifacts.runtimeProfile.document }),
  };
}
