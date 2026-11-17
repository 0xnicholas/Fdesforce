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
  DURABILITY_MODES,
  EXTENSION_ARTIFACT_KINDS,
  RuntimeCapabilitiesSchema,
  STATE_STORE_KINDS,
  SUPPORT_LEVELS,
  SupportSchema,
  TOPOLOGY_MODES,
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
  IdentityProfileSchema,
  IdentityProfileSpecSchema,
  IdentityProfileSubjectSchema,
  MAX_EXECUTION_CONTEXT_ROLES,
  MAX_EXECUTION_CONTEXT_SCOPES,
} from './schema/identity-profile.js';
export type { IdentityProfile, IdentityProfileSpec, IdentityProfileSubject } from './schema/identity-profile.js';

export {
  PLATFORM_ROLES,
  PLATFORM_ROLE_SCOPES,
  PLATFORM_SCOPES,
  MAINTENANCE_SCOPES,
  isMaintenanceScope,
  isPlatformRole,
  isPlatformRoleName,
  scopesForRoles,
} from './schema/platform-roles.js';
export type { MaintenanceScope, PlatformRole } from './schema/platform-roles.js';

export {
  EntityMappingSchema,
  EntityMappingSpecSchema,
  DocumentMappingSchema,
  DocumentMappingSpecSchema,
  MappingColumnTypeSchema,
  MappingSchema,
} from './schema/entity-mapping.js';
export type { DocumentMapping, DocumentMappingSpec, EntityMapping, EntityMappingSpec, Mapping } from './schema/entity-mapping.js';

export {
  ContextPackageRevisionSchema,
  ContextPackageRevisionSpecSchema,
  ContextPackageSchema,
  ContextPackageSpecSchema,
} from './schema/context-package.js';
export type { ContextPackage, ContextPackageRevision, ContextPackageSpec } from './schema/context-package.js';

export { ContextSourceSchema, ContextSourceSpecSchema } from './schema/context-source.js';
export type { ContextSource, ContextSourceSpec } from './schema/context-source.js';

export { SemanticModelSchema, SemanticModelSpecSchema } from './schema/semantic-model.js';
export type { SemanticModel, SemanticModelSpec } from './schema/semantic-model.js';

export {
  BudgetStageSchema,
  ContextRecipeSchema,
  ContextRecipeSpecSchema,
  GraphStageSchema,
  LexicalStageSchema,
  MaskStageSchema,
  MergeStageSchema,
  RECIPE_STAGE_ORDER,
  RankStageSchema,
  RecipeInputSchemaSchema,
  RecipeStageSchema,
  ResolveStageSchema,
  StructuredStageSchema,
} from './schema/context-recipe.js';
export type { ContextRecipe, ContextRecipeSpec, RecipeStage, RecipeStageType } from './schema/context-recipe.js';

export { MaskActionSchema, PermissionProfileSchema, PermissionProfileSpecSchema, PiiClassSchema } from './schema/permission-profile.js';
export type { MaskAction, PermissionProfile, PermissionProfileSpec, PiiClass } from './schema/permission-profile.js';

export { ContextEvalQuestionSchema, ContextEvalSuiteSchema, ContextEvalSuiteSpecSchema } from './schema/context-eval-suite.js';
export type { ContextEvalQuestion, ContextEvalSuite, ContextEvalSuiteSpec } from './schema/context-eval-suite.js';

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
  parseContextEvalSuite,
  parseContextPackage,
  parseContextPackageRevision,
  parseContextRecipe,
  parseContextSource,
  parseIdentityProfile,
  parseMapping,
  parseModelProfile,
  parsePermissionProfile,
  parseRuntimeCapabilities,
  parseRuntimeProfile,
  parseRuntimeTopology,
  parseSemanticModel,
  parseSolutionLock,
  parseSolutionSpec,
  parseTopology,
} from './parse.js';
export type { Diagnostic, ParseResult } from './parse.js';

export { checkContextPackage } from './context.js';
export type { CheckContextPackageInput, ContextPackageDocuments, ContextPackageReport } from './context.js';

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
  PackageFilePathSchema,
  TenantIdSchema,
  TermNameSchema,
  TraceIdSchema,
  UlidSchema,
} from './schema/common.js';

export { documentSchemas } from './documents.js';
export type { DocumentSchema } from './documents.js';

export { checkTopology } from './topology.js';
export type { TopologyReport } from './topology.js';
