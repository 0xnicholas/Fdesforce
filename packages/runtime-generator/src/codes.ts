/**
 * The validation-class diagnostic codes (`docs/runtime-adapter.md` §7.3).
 *
 * Only the codes `validate` can decide live here. A code is a contract with the
 * CLI and with build provenance, so it is a closed union rather than a free
 * string: adding one is a deliberate decision, not a typo. The generation-class
 * codes (`runtime_generation_nondeterministic`, `runtime_manifest_invalid`) and
 * the platform schema check (`runtime_schema_mismatch`) belong to `fde build`
 * (#33), and the runtime-side handshake codes belong to the generated app (#30).
 */
export const RUNTIME_DIAGNOSTIC_CODES = [
  'runtime_profile_missing',
  'runtime_profile_mismatch',
  'runtime_contract_mismatch',
  'runtime_capability_missing',
  'runtime_capability_degraded',
  'runtime_capability_inconsistent',
  'runtime_state_store_unsupported',
  'runtime_topology_unsupported',
  'runtime_topology_unused_mode',
  'runtime_extension_unsupported',
  'runtime_license_blocked',
  'runtime_connector_contract_missing',
  'runtime_connector_operation_untyped',
] as const;
export type RuntimeDiagnosticCode = (typeof RUNTIME_DIAGNOSTIC_CODES)[number];
