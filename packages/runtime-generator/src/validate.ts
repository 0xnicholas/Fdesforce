import { satisfiesRange } from '@fde/spec';
import type { RuntimeCapabilities, RuntimePinBlock, RuntimeProfile } from '@fde/spec';

import {
  capabilityInconsistencies,
  capabilityLimitations,
  capabilitySupport,
  normalizeCapabilities,
} from './capabilities.js';
import { deriveRequirements } from './requirements.js';
import { pinnedProfileDigest, pinnedProfileRef, profileDigest, profileRef } from './profile.js';
import type {
  RuntimeDiagnostic,
  RuntimeRequirement,
  RuntimeValidationInput,
  RuntimeValidationResult,
} from './port.js';

/**
 * The build gate (`docs/runtime-adapter.md` §7).
 *
 * `validate` answers one question: may this Spec be built against this Profile in
 * this Environment? It derives what the Solution needs, then checks the Profile
 * can provide it. Expected failures are diagnostics — no throw, no `--force`, no
 * waiver — because the only honest way past the gate is to change the Spec, the
 * Profile, the Environment or the Extension.
 *
 * Shared by every generator: a concrete generator's `validate()` delegates here
 * and adds only the grammar it alone understands.
 */

/**
 * `fde.runtime/v1`, the wire baseline this port speaks. A major bump is a new
 * port and a new Bundle, not a new default (`docs/runtime-adapter.md` §11.1).
 */
export const RUNTIME_CONTRACT_MAJOR = 1;

/** Lock fields that own a cross-runtime package version (`solution.lock.runtime`). */
const LOCKED_PACKAGES: Record<string, (pin: RuntimePinBlock) => string> = {
  node: (pin) => pin.node,
  python: (pin) => pin.python,
  '@mastra/core': (pin) => pin.mastra,
};

export function validateRuntime(input: RuntimeValidationInput): RuntimeValidationResult {
  const requirements = deriveRequirements({ spec: input.spec, environment: input.environment });
  const errors: RuntimeDiagnostic[] = [];
  const warnings: RuntimeDiagnostic[] = [];

  // Without a trustworthy Profile there is nothing to check requirements against;
  // the requirements are still reported, because provenance does not depend on it.
  const capabilities = checkProfile(input, errors);
  const profile = input.profile;
  if (capabilities !== undefined && profile !== undefined) {
    checkCapabilityConsistency(capabilities, errors);
    checkRequirements(requirements, capabilities, errors, warnings);
    checkStateStore(input, capabilities, errors);
    checkTopology(capabilities, errors, warnings);
    checkExtensions(input, profile, capabilities, errors);
    checkLicense(profile, requirements, errors);
    checkConnectors(input, errors, warnings);
  }

  return { requirements, errors, warnings };
}

/** A group that claims more than its members provide hides a loss the build should see. */
function checkCapabilityConsistency(capabilities: RuntimeCapabilities, errors: RuntimeDiagnostic[]): void {
  for (const inconsistency of capabilityInconsistencies(capabilities)) {
    const members = inconsistency.members.map((member) => `${member.path} is ${member.support}`).join(', ');
    errors.push({
      code: 'runtime_capability_inconsistent',
      capability: inconsistency.group,
      path: `profile.spec.capabilities.${inconsistency.group}.support`,
      message:
        inconsistency.reason === 'limitations_missing'
          ? `${inconsistency.group} is declared degraded but lists no limitations; a degraded group must say what is lost`
          : `${inconsistency.group} is declared ${inconsistency.declared}, but ${members}; a group level must not be stronger than its weakest build-visible member`,
      remediation: 'fix the declaration, publish a new profile version, then re-lock',
    });
  }
}

/**
 * Every derived requirement is answered by the declaration. `must` fails,
 * `should` warns and lands in build provenance; either way the requirement stays
 * in the result, so a warning can never be mistaken for "not asked for".
 */
function checkRequirements(
  requirements: ReadonlyArray<RuntimeRequirement>,
  capabilities: RuntimeCapabilities,
  errors: RuntimeDiagnostic[],
  warnings: RuntimeDiagnostic[],
): void {
  for (const requirement of requirements) {
    const resolved = capabilitySupport(capabilities, requirement.capability);
    const limitations = resolved.found ? capabilityLimitations(capabilities, requirement.capability) : [];
    const loss = limitations.length > 0 ? ` — declared limitations: ${limitations.join('; ')}` : '';
    const location = requirement.source.startsWith('spec.') ? { path: requirement.source } : {};
    const target = requirement.level === 'must' ? errors : warnings;
    const expectation =
      requirement.level === 'must' ? 'is required by' : 'is wanted by';

    if (!resolved.found || resolved.support === 'none') {
      target.push({
        code: 'runtime_capability_missing',
        capability: requirement.capability,
        ...location,
        message: `${requirement.capability} ${expectation} ${requirement.source}, but the Runtime Profile cannot generate it`,
        remediation:
          requirement.level === 'must'
            ? 'change the construct that needs it, or choose a Runtime Profile that provides it; there is no --force and no waiver'
            : 'recorded in build provenance; do not promote it with spec.build.requirements unless the deployment needs it',
      });
      continue;
    }

    if (resolved.support === 'degraded') {
      target.push({
        code: 'runtime_capability_degraded',
        capability: requirement.capability,
        ...location,
        message: `${requirement.capability} ${expectation} ${requirement.source}, but the Runtime Profile provides it with a declared loss${loss}`,
        remediation:
          requirement.level === 'must'
            ? 'remove the source of the requirement, or choose a Runtime Profile that provides it fully; there is no --force and no waiver'
            : 'recorded in build provenance, so the limitation is visible in the Release evidence',
      });
    }
  }
}

/**
 * The Environment selects a store; the Profile says which kinds it can run and
 * which schema version it writes. The lock pins what the build was resolved
 * against, so all three have to agree before a migration is generated.
 */
function checkStateStore(
  input: RuntimeValidationInput,
  capabilities: RuntimeCapabilities,
  errors: RuntimeDiagnostic[],
): void {
  const declared = input.environment.stateStore;
  const locked = input.lock.runtime.stateStore;
  const environmentPath = `environment.${input.environment.name}.stateStore`;
  const fail = (path: string, message: string, remediation: string): void => {
    errors.push({ code: 'runtime_state_store_unsupported', path, message, remediation });
  };

  if (declared !== undefined && locked !== undefined && declared.kind !== locked.kind) {
    fail(
      `${environmentPath}.kind`,
      `the Environment selects a ${declared.kind} state store, but solution.lock pins ${locked.kind}`,
      'fix the Environment, or re-lock against the store the deployment actually provides',
    );
  }

  const selected = declared ?? locked;
  if (selected === undefined) return;

  const kinds = capabilities.stateStore.kinds;
  if (!kinds.includes(selected.kind)) {
    fail(
      declared === undefined ? 'runtime.stateStore.kind' : `${environmentPath}.kind`,
      `the selected ${selected.kind} state store is not one this Runtime Profile can run (${kinds.join(', ')})`,
      'select a supported store in the Environment, or choose a Runtime Profile that provides it',
    );
  }

  // A lock written before the state store schema was typed may hold a number.
  const sameVersion = (left: string | number, right: string | number): boolean => String(left) === String(right);
  const schemaVersion = declared?.schemaVersion ?? locked?.schemaVersion;
  const profileVersion = capabilities.stateStore.schemaVersion;
  if (schemaVersion !== undefined && !sameVersion(schemaVersion, profileVersion)) {
    fail(
      'profile.spec.capabilities.stateStore.schemaVersion',
      `the build targets state store schema ${schemaVersion}, but the profile writes schema ${profileVersion}`,
      'align the Environment and the profile; a schema mismatch would break resume after a restart',
    );
  }
  if (
    declared?.schemaVersion !== undefined &&
    locked?.schemaVersion !== undefined &&
    !sameVersion(declared.schemaVersion, locked.schemaVersion)
  ) {
    fail(
      `${environmentPath}.schemaVersion`,
      `the Environment selects state store schema ${declared.schemaVersion}, but solution.lock pins ${locked.schemaVersion}`,
      're-lock after changing the Environment state store selection',
    );
  }
}

/** v0 renders the split topology only, and hides an embedded single writer in it. */
function checkTopology(
  capabilities: RuntimeCapabilities,
  errors: RuntimeDiagnostic[],
  warnings: RuntimeDiagnostic[],
): void {
  const modes = capabilities.topology.modes;
  if (!modes.includes('split')) {
    errors.push({
      code: 'runtime_topology_unsupported',
      capability: 'topology',
      path: 'profile.spec.capabilities.topology.modes',
      message: `v0 builds the split topology, and this profile declares no split mode (${modes.join(', ')})`,
      remediation: 'choose a Runtime Profile that supports split, or wait for the v0 topology to gain the mode',
    });
  } else {
    const unrendered = modes.filter((mode) => mode !== 'split');
    if (unrendered.length > 0) {
      warnings.push({
        code: 'runtime_topology_unused_mode',
        capability: 'topology',
        path: 'profile.spec.capabilities.topology.modes',
        message: `the profile declares ${unrendered.join(', ')}, which v0 does not render; the build uses split`,
        remediation: 'nothing to do; the mode is reserved for a later slice',
      });
    }
  }

  if (capabilities.topology.singleWriter !== true) {
    errors.push({
      code: 'runtime_topology_unsupported',
      capability: 'topology',
      path: 'profile.spec.capabilities.topology.singleWriter',
      message: 'v0 deploys a single runtime app replica, so a runtime that needs multiple writers cannot run here',
      remediation: 'choose a Runtime Profile that can run single-writer, or change the topology the deployment needs',
    });
  }
}

/** An Extension artifact must load in the generated app: right kind, right runtime. */
function checkExtensions(
  input: RuntimeValidationInput,
  profile: RuntimeProfile,
  capabilities: RuntimeCapabilities,
  errors: RuntimeDiagnostic[],
): void {
  const kinds = capabilities.extensions.artifactKinds;
  for (const extension of input.extensions ?? []) {
    const artifact = `${extension.name}@${extension.version}`;
    const fail = (message: string): void => {
      errors.push({
        code: 'runtime_extension_unsupported',
        capability: 'extensions',
        path: 'spec.extensions',
        message,
        remediation: 'publish the artifact in a kind the profile loads, or choose a Runtime Profile that loads it',
      });
    };

    if (!kinds.includes(extension.artifactKind)) {
      fail(`Extension ${artifact} is a ${extension.artifactKind} artifact, and the profile loads ${kinds.join(', ')}`);
      continue;
    }
    if (extension.runtimeCompatibility === undefined) continue;
    const compatible = extension.runtimeCompatibility.some(
      (combination) =>
        combination.family === profile.spec.family && combination.language === profile.spec.language,
    );
    if (!compatible) {
      const declared = extension.runtimeCompatibility
        .map((combination) => `${combination.family}/${combination.language}`)
        .join(', ');
      fail(
        `Extension ${artifact} declares runtimeCompatibility ${declared}, which does not include ${profile.spec.family}/${profile.spec.language}`,
      );
    }
  }
}

/** An air-gapped target cannot satisfy a license key or a beacon, so it fails at build. */
function checkLicense(
  profile: RuntimeProfile,
  requirements: ReadonlyArray<RuntimeRequirement>,
  errors: RuntimeDiagnostic[],
): void {
  const offline = requirements.some(
    (requirement) => requirement.capability === 'offline' && requirement.level === 'must',
  );
  if (!offline) return;

  const licensing = profile.spec.licensing;
  if (licensing.requiresLicenseKey) {
    errors.push({
      code: 'runtime_license_blocked',
      capability: 'offline',
      path: 'profile.spec.licensing.requiresLicenseKey',
      message: 'the target is air-gapped, and this runtime needs a license key nothing can install offline',
      remediation: 'choose a runtime that runs offline without a license key (v0 has no key delivery path)',
    });
  }
  if (licensing.egress) {
    errors.push({
      code: 'runtime_license_blocked',
      capability: 'offline',
      path: 'profile.spec.licensing.egress',
      message: 'the target is air-gapped, and this runtime declares egress (a license beacon or telemetry)',
      remediation: 'choose a runtime with no egress, or relax the network class of the target',
    });
  }
}

/**
 * A Connector-backed Tool reaches the outside world only through a typed
 * operation (D6). The operation must be declared; whether it is *typed* today
 * depends on GAP-1, so an untyped operation is a warning until #29 lands the
 * manifest.
 */
function checkConnectors(
  input: RuntimeValidationInput,
  errors: RuntimeDiagnostic[],
  warnings: RuntimeDiagnostic[],
): void {
  for (const [name, tool] of Object.entries(input.spec.spec.tools ?? {})) {
    if (tool.connectorRef === undefined) continue;
    const path = `spec.tools.${name}`;
    const connector = input.connectors?.[tool.connectorRef];
    const operation = tool.operation;

    if (connector === undefined) {
      errors.push({
        code: 'runtime_connector_contract_missing',
        capability: 'tools.connectorOperations',
        path,
        message: `Tool ${name} needs connector ${tool.connectorRef}, which the Environment does not resolve`,
        remediation: 'resolve the Connector asset and pin it in solution.lock',
      });
      continue;
    }

    const declared = operation === undefined ? undefined : connector.operations[operation];
    if (operation === undefined || declared === undefined) {
      errors.push({
        code: 'runtime_connector_contract_missing',
        capability: 'tools.connectorOperations',
        path,
        message: `Connector ${connector.name} declares no typed operation ${operation ?? '<missing>'}, so the generated Tool has nothing to call`,
        remediation: 'declare the operation on the Connector, or point the Tool at an operation it does declare',
      });
      continue;
    }

    const manifestTyped = declared.inputSchema !== undefined && declared.outputSchema !== undefined;
    const toolTyped = tool.inputSchema !== undefined && tool.outputSchema !== undefined;
    if (!manifestTyped && !toolTyped) {
      warnings.push({
        code: 'runtime_connector_operation_untyped',
        capability: 'tools.connectorOperations',
        path,
        message: `operation ${connector.name}.${operation} declares no input/output schema and the Tool pins none, so the seam is untyped (GAPS.md GAP-1)`,
        remediation: 'pin the schemas on the Tool now, or declare the typed operation when the Connector manifest supports it',
      });
    }
  }
}

/**
 * Content address, then identity, then compatibility. A digest mismatch is
 * `runtime_profile_missing` (the pinned artifact was not the one resolved); an
 * identity or version disagreement is `runtime_profile_mismatch`; an
 * incompatible contract major is `runtime_contract_mismatch`.
 */
function checkProfile(input: RuntimeValidationInput, errors: RuntimeDiagnostic[]): RuntimeCapabilities | undefined {
  const { profile, lock } = input;
  if (profile === undefined) {
    errors.push({
      code: 'runtime_profile_missing',
      path: 'spec.build.runtimeProfile',
      message: 'no Runtime Profile artifact was resolved for this build',
      remediation:
        'vendor the profile under platform/runtime-profiles and pin it with `fde spec lock`, then rebuild',
    });
    return undefined;
  }

  const digest = profileDigest(profile);
  const pinnedDigest = pinnedProfileDigest(lock.runtime);
  if (pinnedDigest === undefined) {
    errors.push({
      code: 'runtime_profile_missing',
      path: 'runtime.profile',
      message: 'solution.lock pins the runtime profile without a digest, so the artifact cannot be trusted',
      remediation: 'regenerate the lock with `fde spec lock`',
    });
    return undefined;
  }
  if (pinnedDigest !== digest) {
    errors.push({
      code: 'runtime_profile_missing',
      path: 'runtime.profile',
      message: `the resolved Runtime Profile hashes to ${digest}, but solution.lock pins ${pinnedDigest}`,
      remediation: 'the profile artifact changed without a lock refresh; run `fde spec lock` and review the diff',
    });
    return undefined;
  }

  const mismatch = (path: string, message: string, remediation: string): void => {
    errors.push({ code: 'runtime_profile_mismatch', path, message, remediation });
  };

  const ref = profileRef(profile);
  const pinned = pinnedProfileRef(lock.runtime);
  if (pinned.name !== profile.metadata.name || pinned.version !== profile.metadata.version) {
    mismatch(
      'runtime.profile',
      `solution.lock pins ${pinned.name}@${pinned.version}, but the resolved artifact is ${ref}`,
      're-resolve the profile the Spec references, or refresh the lock',
    );
  }

  checkSpecReference(input, profile, mismatch);
  checkGeneratorIdentity(input, profile, mismatch);
  checkContractVersion(profile, lock.runtime, errors, mismatch);
  checkPackagePins(profile, lock.runtime, mismatch);

  return normalizeCapabilities(profile.spec.capabilities);
}

/** `spec.build.runtimeProfile` is a name + range; it must select this artifact. */
function checkSpecReference(
  input: RuntimeValidationInput,
  profile: RuntimeProfile,
  mismatch: (path: string, message: string, remediation: string) => void,
): void {
  const reference = input.spec.spec.build.runtimeProfile;
  const at = reference.indexOf('@');
  const name = at < 0 ? reference : reference.slice(0, at);
  const range = at < 0 ? '' : reference.slice(at + 1);

  if (name !== profile.metadata.name) {
    mismatch(
      'spec.build.runtimeProfile',
      `the Spec references ${name}, but the resolved artifact is ${profile.metadata.name}`,
      'reference the profile the Environment is meant to run',
    );
    return;
  }
  if (!satisfiesRange(range, profile.metadata.version)) {
    mismatch(
      'spec.build.runtimeProfile',
      `the Spec accepts ${name}@${range}, which ${profile.metadata.version} does not satisfy`,
      'widen the range, or pin a profile version that satisfies it',
    );
  }
}

/** A generator may only validate a profile of its own family and version. */
function checkGeneratorIdentity(
  input: RuntimeValidationInput,
  profile: RuntimeProfile,
  mismatch: (path: string, message: string, remediation: string) => void,
): void {
  if (input.generator === undefined) return;
  if (input.generator.family !== profile.spec.family) {
    mismatch(
      'profile.spec.family',
      `the ${input.generator.family} generator cannot build a ${profile.spec.family} profile`,
      'run the generator that owns this runtime family',
    );
  }
  if (input.generator.version !== profile.spec.generator.version) {
    mismatch(
      'profile.spec.generator.version',
      `the running generator is ${input.generator.version}, but the profile was written for ${profile.spec.generator.version}`,
      'pin the generator version the lock records, or publish a new profile',
    );
  }
  if (input.generator.language !== undefined && input.generator.language !== profile.spec.language) {
    mismatch(
      'profile.spec.language',
      `the generator emits ${input.generator.language}, but the profile is for ${profile.spec.language}`,
      'run the generator that matches the profile language',
    );
  }
}

/**
 * The contract version is pinned by both documents. A different major is a
 * different wire contract (`runtime_contract_mismatch`); a different minor is
 * drift between two pins of the same contract (`runtime_profile_mismatch`).
 */
function checkContractVersion(
  profile: RuntimeProfile,
  pin: RuntimePinBlock,
  errors: RuntimeDiagnostic[],
  mismatch: (path: string, message: string, remediation: string) => void,
): void {
  const major = (version: string): number => Number.parseInt(version.split('.')[0] ?? '', 10);
  const contractMismatch = (path: string, message: string): void => {
    errors.push({
      code: 'runtime_contract_mismatch',
      path,
      message,
      remediation: `this port speaks fde.runtime/v${RUNTIME_CONTRACT_MAJOR}; a new major needs a new generator and a new Bundle`,
    });
  };

  if (major(pin.contractVersion) !== RUNTIME_CONTRACT_MAJOR) {
    contractMismatch(
      'runtime.contractVersion',
      `solution.lock pins contract ${pin.contractVersion}, which this port cannot speak`,
    );
    return;
  }
  if (major(profile.spec.contractVersion) !== major(pin.contractVersion)) {
    contractMismatch(
      'profile.spec.contractVersion',
      `the profile declares contract ${profile.spec.contractVersion}, but the lock pins ${pin.contractVersion}`,
    );
    return;
  }
  if (profile.spec.contractVersion !== pin.contractVersion) {
    mismatch(
      'profile.spec.contractVersion',
      `the profile declares contract ${profile.spec.contractVersion}, but the lock pins ${pin.contractVersion}`,
      'refresh the lock after the profile contract moved, or pin the profile version that matches the lock',
    );
  }
}

/** A package the lock owns a version for cannot disagree with the profile. */
function checkPackagePins(
  profile: RuntimeProfile,
  pin: RuntimePinBlock,
  mismatch: (path: string, message: string, remediation: string) => void,
): void {
  for (const [name, version] of Object.entries(profile.spec.packages)) {
    const locked = LOCKED_PACKAGES[name]?.(pin);
    if (locked === undefined || locked === version) continue;
    mismatch(
      `profile.spec.packages.${name}`,
      `the profile pins ${name} ${version}, but solution.lock pins ${locked}`,
      'align the profile with the locked toolchain, or re-lock against the new profile',
    );
  }
}
