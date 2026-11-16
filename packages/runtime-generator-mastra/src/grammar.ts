import type { Agent, SolutionSpec, Tool } from '@fde/spec';
import type { RuntimeDiagnostic, RuntimeExtensionView } from '@fde/runtime-generator';

import { BUILTIN_TOOLS } from './builtins.js';
import { identifier } from './naming.js';

/**
 * The v0 grammar gate: what this generator refuses to emit.
 *
 * The Solution Spec's grammar (`packages/spec`) is wider than this generator, and
 * deliberately so — `approval` steps, side-effecting Tools, agent `memory` and
 * Tool-interface Extensions are real Slice 2 constructs with their own tickets.
 * Emitting a partial app for them is the one thing that must not happen: a
 * workflow that drops the approval gate, or a Tool offered to the model without
 * record-before-act, looks built and is unsafe.
 *
 * So the gate is a *list of refusals*, checked in `validate` and re-checked (by
 * throwing) before generation, and each refusal names the construct, the path it
 * came from and what would make it buildable.
 */

const GRAMMAR = 'runtime_grammar_unsupported';
const EXTENSION = 'runtime_extension_unsupported';

const refuse = (path: string, message: string, remediation: string): RuntimeDiagnostic => ({
  code: GRAMMAR,
  path,
  message,
  remediation,
});

const rejectExtension = (path: string, message: string): RuntimeDiagnostic => ({
  code: EXTENSION,
  capability: 'extensions',
  path,
  message,
  remediation:
    'remove the Extension reference, or load the artifact from a generator version that implements the artifact loader (A9)',
});

/** Tools the slice can emit are read-only; side effects need record-before-act. */
const isReadOnly = (tool: Tool): boolean => tool.sideEffects === 'read';

/**
 * The path of the Spec's reference to an Extension, so a diagnostic points at the
 * line an author edits. `spec.extensions` holds `name@range` strings and the view
 * carries the resolved `name`, so the match is by name.
 */
function extensionPath(spec: SolutionSpec, name: string): string {
  const index = (spec.spec.extensions ?? []).findIndex((ref) => ref === name || ref.startsWith(`${name}@`));
  return index < 0 ? 'spec.extensions' : `spec.extensions[${index}]`;
}

export function unsupportedGrammar(
  spec: SolutionSpec,
  extensions: ReadonlyArray<RuntimeExtensionView> = [],
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const tools = spec.spec.tools ?? {};
  const agents = spec.spec.agents ?? {};

  diagnostics.push(...unsupportedTools(tools));
  diagnostics.push(...unsupportedAgents(agents, tools));
  diagnostics.push(...unsupportedWorkflows(spec));
  diagnostics.push(...unloadableExtensions(spec, extensions));
  diagnostics.push(...identifierCollisions(spec));

  return diagnostics;
}

/**
 * A side-effecting Tool needs the record-before-act wrapper, the intent/outcome
 * Decisions and the evidence selectors (C26–C32). None of that is generated in
 * this slice — and a Tool the model can call is reachable whether or not a
 * workflow step names it — so a declared write/external Tool fails the build.
 */
function unsupportedTools(tools: Record<string, Tool>): RuntimeDiagnostic[] {
  return Object.entries(tools).flatMap(([name, tool]) => {
    const diagnostics: RuntimeDiagnostic[] = [];

    if (!isReadOnly(tool)) {
      diagnostics.push(
        refuse(
          `spec.tools.${name}`,
          `Tool ${name} declares sideEffects: ${tool.sideEffects}, and this slice generates read-only Tools only`,
          'remove the Tool, or wait for the record-before-act wrapper (C26–C32) that makes a side effect auditable',
        ),
      );
    }

    if (tool.builtin !== undefined && tool.connectorRef !== undefined) {
      diagnostics.push(
        refuse(
          `spec.tools.${name}`,
          `Tool ${name} declares both builtin (${tool.builtin}) and connectorRef (${tool.connectorRef}), so there is no single implementation to generate`,
          'keep exactly one of builtin and connectorRef',
        ),
      );
    } else if (tool.builtin !== undefined && BUILTIN_TOOLS[tool.builtin] === undefined) {
      diagnostics.push(
        refuse(
          `spec.tools.${name}.builtin`,
          `Tool ${name} uses builtin ${tool.builtin}, which this generator does not know`,
          `use one of the builtins the platform publishes: ${Object.keys(BUILTIN_TOOLS).join(', ')}`,
        ),
      );
    } else if (tool.builtin === undefined && tool.connectorRef === undefined) {
      diagnostics.push(
        refuse(
          `spec.tools.${name}`,
          `Tool ${name} declares neither builtin nor connectorRef + operation, so there is no implementation to generate`,
          'declare builtin (a platform Tool) or connectorRef + operation (a typed Connector operation)',
        ),
      );
    }

    return diagnostics;
  });
}

/**
 * Thread memory is state in the runtime store and long-term memory is the
 * platform `fde_memory` primitive (C41–C48). Neither is wired in this slice, and
 * an Agent that silently loses its memory is worse than a build that stops.
 */
function unsupportedAgents(
  agents: Record<string, Agent>,
  tools: Record<string, Tool>,
): RuntimeDiagnostic[] {
  return Object.entries(agents).flatMap(([name, agent]) => {
    const diagnostics: RuntimeDiagnostic[] = [];

    if (agent.memory !== undefined) {
      diagnostics.push(
        refuse(
          `spec.agents.${name}.memory`,
          `Agent ${name} declares memory, which this slice does not wire: thread memory needs the runtime state store and long-term memory is the platform fde_memory primitive`,
          'remove the memory declaration, or wait for the memory slice (C41–C48) that generates the store namespace and the recall path',
        ),
      );
    }

    (agent.tools ?? []).forEach((tool, index) => {
      if (tools[tool] !== undefined) return;
      diagnostics.push(
        refuse(
          `spec.agents.${name}.tools[${index}]`,
          `Agent ${name} lists Tool ${tool}, which the Spec does not declare`,
          'declare the Tool under spec.tools, or remove it from the Agent',
        ),
      );
    });

    return diagnostics;
  });
}

/**
 * Workflow steps are checked one by one because the refusal has to point at the
 * step an author can delete — "the workflow is unsupported" is not actionable.
 */
function unsupportedWorkflows(spec: SolutionSpec): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const tools = spec.spec.tools ?? {};
  const agents = spec.spec.agents ?? {};
  const recipes = spec.spec.semantic?.recipeBindings ?? {};

  for (const [workflowId, workflow] of Object.entries(spec.spec.workflows ?? {})) {
    workflow.steps.forEach((step, index) => {
      const path = `spec.workflows.${workflowId}.steps[${index}]`;

      switch (step.type) {
        case 'approval':
          diagnostics.push(
            refuse(
              path,
              `Workflow ${workflowId} step ${step.id} is an approval gate (gates ${step.gates}, approver roles ${step.approverRoles.join(', ')}), which this slice does not generate`,
              'remove the gate from the Spec, or wait for the HITL slice (C16–C25) that generates the request/wait/commit mapping',
            ),
          );
          return;
        case 'tool': {
          const tool = tools[step.tool];
          if (tool === undefined) {
            diagnostics.push(
              refuse(
                path,
                `Workflow ${workflowId} step ${step.id} calls Tool ${step.tool}, which the Spec does not declare`,
                'declare the Tool under spec.tools, or point the step at one that exists',
              ),
            );
            return;
          }
          if (!isReadOnly(tool)) {
            diagnostics.push(
              refuse(
                path,
                `Workflow ${workflowId} step ${step.id} calls Tool ${step.tool}, which declares sideEffects: ${tool.sideEffects}; a side-effecting step needs record-before-act`,
                'remove the step, or wait for the record-before-act wrapper (C26–C32)',
              ),
            );
          }
          return;
        }
        case 'agent':
          if (agents[step.agent] === undefined) {
            diagnostics.push(
              refuse(
                path,
                `Workflow ${workflowId} step ${step.id} calls Agent ${step.agent}, which the Spec does not declare`,
                'declare the Agent under spec.agents, or point the step at one that exists',
              ),
            );
          }
          return;
        case 'context':
          if (recipes[step.recipe] === undefined) {
            diagnostics.push(
              refuse(
                path,
                `Workflow ${workflowId} step ${step.id} uses recipe ${step.recipe}, which spec.semantic.recipeBindings does not bind (so the retrieval budget is undeclared)`,
                'bind the recipe under spec.semantic.recipeBindings, or point the step at a bound recipe',
              ),
            );
          }
          return;
      }
    });
  }

  return diagnostics;
}

/**
 * Two Spec ids that map to one TypeScript identifier would emit a tree that does
 * not compile, and the author would be looking at generated code to find out why.
 * Agents and workflows share a module (the Mastra instance); Tools share theirs.
 */
function identifierCollisions(spec: SolutionSpec): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const namespaces: Array<{ kind: string; ids: string[] }> = [
    { kind: 'agents', ids: Object.keys(spec.spec.agents ?? {}) },
    { kind: 'workflows', ids: Object.keys(spec.spec.workflows ?? {}) },
    { kind: 'tools', ids: Object.keys(spec.spec.tools ?? {}) },
  ];

  const check = (ids: ReadonlyArray<{ id: string; kind: string }>, namespace: string): void => {
    const taken = new Map<string, string>();
    for (const { id, kind } of ids) {
      const generated = identifier(id);
      const previous = taken.get(generated);
      if (previous !== undefined) {
        diagnostics.push(
          refuse(
            `spec.${kind}.${id}`,
            `${id} and ${previous} both generate the identifier ${generated} in the ${namespace} module`,
            'rename one of them: the generated tree needs one identifier per construct',
          ),
        );
        continue;
      }
      taken.set(generated, `${kind}.${id}`);
    }
  };

  const flatten = (kinds: ReadonlyArray<string>): Array<{ id: string; kind: string }> =>
    kinds.flatMap((kind) => {
      const entry = namespaces.find((candidate) => candidate.kind === kind);
      return (entry?.ids ?? []).map((id) => ({ id, kind }));
    });

  check(flatten(['agents', 'workflows']), 'mastra-app instance');
  check(flatten(['tools']), 'Tools');

  return diagnostics;
}

/**
 * Who loads an Extension artifact decides whether the generated app is involved.
 * A `connector` Extension is executed by context-service through a typed
 * operation, so the app never sees the artifact; a `tool` Extension is code that
 * has to load *inside* the app (A9), which this slice cannot emit. `recipe` and
 * `scorer` artifacts belong to context-service and the eval worker.
 */
function unloadableExtensions(
  spec: SolutionSpec,
  extensions: ReadonlyArray<RuntimeExtensionView>,
): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = [];
  const views = new Map(extensions.map((extension) => [extension.name, extension]));
  const referenced = (spec.spec.extensions ?? []).map((ref) => ref.split('@')[0] ?? ref);

  /** One rule for every place the Spec references an Extension, whichever list it is in. */
  const judge = (name: string, path: string, artifact: string): void => {
    const view = views.get(name);
    if (view === undefined) {
      diagnostics.push(
        rejectExtension(path, `Extension ${artifact} is referenced, but the build did not resolve the artifact`),
      );
      return;
    }
    if (view.interface !== 'tool') return;
    diagnostics.push(
      rejectExtension(
        path,
        `Extension ${artifact} has interface: tool, which the generated app has to load itself; this slice emits no artifact loader`,
      ),
    );
  };

  for (const name of referenced) {
    const view = views.get(name);
    judge(name, extensionPath(spec, name), `${name}@${view?.version ?? '?'}`);
  }

  for (const [capabilityId, capability] of Object.entries(spec.spec.capabilities)) {
    (capability.extensionRefs ?? []).forEach((ref, index) => {
      judge(
        ref.split('@')[0] ?? ref,
        `spec.capabilities.${capabilityId}.extensionRefs[${index}]`,
        ref,
      );
    });
  }

  return diagnostics;
}
