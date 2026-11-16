export {
  canonicalJson,
  digestFiles,
  digestOf,
  isDigest,
  normalizeText,
  sha256,
} from './canonical.js';
export type { Digest, FileEntry, FileSetDigest } from './canonical.js';

export { emitJsonSchema } from './schema-emit.js';

export {
  CAPABILITY_GROUPS,
  CapabilityDetailsSchema,
  CapabilityNodeSchema,
  RuntimeCapabilitiesSchema,
  SupportSchema,
} from './schema/runtime-capabilities.js';
export type {
  CapabilityDetails,
  CapabilityGroup,
  CapabilityNode,
  RuntimeCapabilities,
  Support,
} from './schema/runtime-capabilities.js';

export {
  LicensingSchema,
  ProfileMetadataSchema,
  ProfileRefSchema,
  ProfileSpecSchema,
  RuntimeLanguageSchema,
  RuntimeProfilePinSchema,
  RuntimeProfileSchema,
} from './schema/runtime-profile.js';
export type { ProfileSpec, RuntimeProfile } from './schema/runtime-profile.js';

export {
  BundleTopologySchema,
  BundleTopologySpecSchema,
  ComponentRoleSchema,
  ComponentSchema,
  DeploymentNamingSchema,
  JobSchema,
  NetworkSchema,
  RuntimeTopologySchema,
  RuntimeTopologySpecSchema,
  SecretBindingSchema,
  SecretRefSchema,
  StartupOrderSchema,
  TopologySchema,
  VolumeSchema,
} from './schema/bundle-topology.js';
export type {
  BundleTopology,
  BundleTopologySpec,
  Component,
  Job,
  RuntimeTopology,
  SecretBinding,
  Topology,
  Volume,
} from './schema/bundle-topology.js';

export { ModelProfileSchema, ModelProfileSpecSchema } from './schema/model-profile.js';
export type { ModelProfile, ModelProfileSpec } from './schema/model-profile.js';

export {
  AgentMemorySchema,
  AgentSchema,
  BuildSchema,
  BusinessRoleSchema,
  CapabilityAuditSchema,
  CapabilityBindingSchema,
  DotPathSchema,
  DurationSchema,
  EnvironmentRequirementSchema,
  EvidenceSelectorSchema,
  GovernanceSchema,
  PLATFORM_ROLES,
  PolicyRefSchema,
  SemanticSchema,
  SolutionSpecSchema,
  ToolSchema,
  WorkflowSchema,
  WorkflowStepSchema,
} from './schema/solution-spec.js';
export type {
  Agent,
  BuildSpec,
  CapabilityBinding,
  EvidenceSelector,
  PolicyRef,
  Semantic,
  SolutionSpec,
  Tool,
  Workflow,
  WorkflowStep,
} from './schema/solution-spec.js';

export {
  AssetPinsSchema,
  ConcreteAssetSchema,
  CustomerAssetSchema,
  MaterializedFromSchema,
  RuntimePinBlockSchema,
  SolutionLockSchema,
  SpecManifestSchema,
  TemplatePinsSchema,
  ToolchainPinSchema,
  VersionDigestPinSchema,
} from './schema/solution-lock.js';
export type { AssetPins, ConcreteAsset, RuntimePinBlock, SolutionLock, TemplatePins } from './schema/solution-lock.js';

export {
  parseBundleTopology,
  parseModelProfile,
  parseRuntimeCapabilities,
  parseRuntimeProfile,
  parseRuntimeTopology,
  parseSolutionLock,
  parseSolutionSpec,
  parseTopology,
} from './parse.js';
export type { Diagnostic, ParseResult } from './parse.js';

export { checkSolution, resolveSchemaPath, satisfiesRange } from './crossref.js';
export type {
  CheckSolutionInput,
  ConnectorView,
  ContextPackageView,
  EvalSuiteView,
  PolicyTemplateView,
  ValidationReport,
} from './crossref.js';

export { diffContractShape } from './contract-drift.js';
export type { ContractDiff, ContractShapeInput, DriftReport, StrippedRule } from './contract-drift.js';

export {
  ArtifactRefSchema,
  CapabilityIdSchema,
  ClassificationSchema,
  DigestSchema,
  EntityIdSchema,
  NameSchema,
  ProfileNameSchema,
  RetentionClassSchema,
  RunIdSchema,
  RuntimeFamilySchema,
  SchemaVersionSchema,
  SemverSchema,
  SolutionIdSchema,
  SpecFilePathSchema,
  TenantIdSchema,
  TraceIdSchema,
  UlidSchema,
} from './schema/common.js';

export { documentSchemas } from './documents.js';
export type { DocumentSchema } from './documents.js';

export { checkTopology } from './topology.js';
export type { TopologyReport } from './topology.js';
