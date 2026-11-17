// GENERATED from contracts/schemas/*.json — do not edit.
// Regenerate with `pnpm generate`; CI runs `pnpm generate:check`.

// ---- approval.schema.json

export interface ProposedAction {
  tool: string;
  operation?: string;
  input_digest: Digest;
  summary?: string;
}

export interface ApprovalCreateRequest {
  run_id: RunId;
  capability_id: CapabilityId;
  proposed_action: ProposedAction;
  requested_by: Actor;
  approver_roles: Array<string>;
  expires_at: Timestamp;
  evidence?: Array<Evidence>;
  policy_refs?: Array<string>;
}

export interface Approval {
  approval_id: ApprovalId;
  run_id: RunId;
  tenant_id: TenantId;
  capability_id: CapabilityId;
  status: "pending" | "approved" | "rejected" | "expired" | "consumed";
  proposed_action: ProposedAction;
  requested_by: Actor;
  approver_roles: Array<string>;
  created_at: Timestamp;
  expires_at: Timestamp;
  decided_at?: Timestamp;
  decision_id?: DecisionId;
  provenance_id?: ProvenanceId;
  evidence?: Array<Evidence>;
  policy_refs?: Array<string>;
}

export interface ApprovalDecisionRequest {
  approved: boolean;
  rationale: string;
  actor: Actor;
  trace_id?: TraceId;
}

export interface ApprovalDecisionResponse {
  approval_id: ApprovalId;
  status: "approved" | "rejected";
  decision_id: DecisionId;
  provenance_id: ProvenanceId;
  decided_at: Timestamp;
}

export interface ApprovalList {
  items: Array<Approval>;
  next_cursor?: string;
}

// ---- bundle-topology.schema.json

export type Name = string;

export type ProfileRef = string;

export type ComponentRole = "runtime-app" | "context-service" | "state-store" | "graph-store" | "audit-store" | "job" | "collector";

export interface Port {
  name: string;
  containerPort: number;
  protocol?: "tcp" | "udp";
  expose?: boolean;
}

export interface VolumeMount {
  name: Name;
  mountPath: string;
  readOnly?: boolean;
}

export interface SecretRef {
  store: string;
  key: string;
  version?: string;
}

export type EnvVar = unknown | unknown;

export interface HealthCheck {
  path: string;
  port: number;
  command?: Array<string>;
  initialDelaySeconds?: number;
  periodSeconds?: number;
  timeoutSeconds?: number;
  failureThreshold?: number;
}

export interface ResourceSpec {
  cpu: string;
  memory: string;
}

export type ImageSpec = {
  image: string;
} | {
  build: {
    context: string;
    dockerfile: string;
    target?: string;
  };
};

export interface Component {
  name: Name;
  role: ComponentRole;
  image: ImageSpec;
  command?: Array<string>;
  args?: Array<string>;
  ports?: Array<Port>;
  volumes?: Array<VolumeMount>;
  env?: Array<EnvVar>;
  secretRefs?: Array<SecretRef>;
  healthCheck?: HealthCheck;
  dependsOn?: Array<Name>;
  resources?: ResourceSpec;
}

export interface Volume {
  name: Name;
  size?: string;
  backup?: boolean;
  description?: string;
}

export interface JobStep {
  id: Name;
  command: Array<string>;
  args?: Array<string>;
  runBefore?: Array<Name>;
  runAfter?: Array<Name>;
  timeoutSeconds?: number;
  volumes?: Array<VolumeMount>;
  secretRefs?: Array<SecretRef>;
}

export interface Job {
  name: Name;
  owner: "context-service" | "runtime" | "platform";
  steps: Array<JobStep>;
  volumes?: Array<VolumeMount>;
  env?: Array<EnvVar>;
  secretRefs?: Array<SecretRef>;
}

export interface SecretBinding {
  secretRef: SecretRef;
  target: "env" | "file";
  name: string;
  required?: boolean;
}

export interface DeploymentNaming {
  componentNameTemplate: string;
  namespaceTemplate?: string;
}

export interface Network {
  name: Name;
  internal: boolean;
}

export interface Ingress {
  component: Name;
  port: number;
  hostTemplate?: string;
  tls?: boolean;
}

export type StartupOrder = Array<Name>;

export interface RuntimeMetadata {
  profile: ProfileRef;
  profileDigest: Digest;
  generatorVersion: Semver;
}

export interface BundleMetadata {
  solution: Name;
  revision: number;
  profile: ProfileRef;
  profileDigest: Digest;
}

export interface RuntimeTopologySpec {
  components: Array<Component>;
  volumes: Array<Volume>;
  jobs: Array<Job>;
  startupOrder: StartupOrder;
  secretBindings: Array<SecretBinding>;
  deploymentNaming: DeploymentNaming;
}

export interface BundleTopologySpec {
  components: Array<Component>;
  volumes: Array<Volume>;
  jobs: Array<Job>;
  startupOrder: StartupOrder;
  secretBindings: Array<SecretBinding>;
  deploymentNaming: DeploymentNaming;
  networks: Array<Network>;
  ingress?: Ingress;
}

export interface RuntimeTopology {
  apiVersion: "fde.dev/v0";
  kind: "RuntimeTopology";
  metadata: RuntimeMetadata;
  spec: RuntimeTopologySpec;
}

export interface BundleTopology {
  apiVersion: "fde.dev/v0";
  kind: "BundleTopology";
  metadata: BundleMetadata;
  spec: BundleTopologySpec;
}

export type BundleTopologyTopology = RuntimeTopology | BundleTopology;

// ---- common.schema.json

export type Ulid = string;

export type RunId = string;

export type RetrievalId = string;

export type DecisionId = string;

export type InvocationId = string;

export type ProvenanceId = string;

export type ApprovalId = string;

export type DeploymentId = string;

export type TenantId = string;

export type SolutionId = string;

export type CapabilityId = string;

export type EntityId = string;

export type TraceId = string;

export type Digest = string;

export type Timestamp = string;

export type Semver = string;

export type SchemaVersion = string;

export interface Actor {
  type: "user" | "service" | "system";
  id: string;
  display?: string;
}

export type Classification = "public" | "internal" | "confidential" | "restricted";

export type RetentionClass = "ephemeral" | "standard" | "extended" | "legal_hold";

export interface PolicyEvaluation {
  policy_id: string;
  version: string;
  outcome: "allow" | "deny" | "waived";
  reason?: string;
  enforcement_point?: "context.retrieve" | "tool.pre_invoke" | "agent.pre_invoke" | "approval.request" | "run.post" | "output.emit";
  evaluated_by?: "mastra-app" | "context-service";
}

export type ErrorCode = "invalid_request" | "unauthenticated" | "forbidden" | "not_found" | "thread_not_found" | "conflict" | "idempotency_conflict" | "approval_already_decided" | "run_not_suspended" | "stream_not_resumable" | "validation_failed" | "rate_limited" | "bad_gateway" | "unavailable" | "timeout" | "internal" | "contract_mismatch" | "runtime_capability_mismatch" | "graph_schema_mismatch" | "audit_schema_mismatch";

export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
  trace_id: TraceId;
}

export interface Error {
  error: ErrorDetail;
}

// ---- decision.schema.json

export interface GraphEntityEvidence {
  type?: "graph_entity";
  entity_id: EntityId;
  version?: string;
  retrieval_id?: RetrievalId;
  source_ref?: string;
  relationship?: string;
}

export interface RetrievalEvidence {
  type: "retrieval";
  retrieval_id: RetrievalId;
  snapshot_digest: Digest;
}

export interface RunArtifactEvidence {
  type: "run_artifact";
  run_id?: RunId;
  step_id?: string;
  path?: string;
  digest: Digest;
}

export interface ApprovalEvidence {
  type: "approval";
  approval_id: ApprovalId;
  decision_id: DecisionId;
}

export type Evidence = GraphEntityEvidence | RetrievalEvidence | RunArtifactEvidence | ApprovalEvidence;

export interface Action {
  tool_id: string;
  connector_id?: string;
  operation?: string;
  side_effects: "read" | "write" | "external";
}

export interface ModelRef {
  provider: string;
  model: string;
  version?: string;
}

export type DecisionRequest = unknown & unknown & unknown & unknown;

export interface DecisionResponse {
  decision_id: DecisionId;
  provenance_id: ProvenanceId;
  trace_id: TraceId;
  created_at: Timestamp;
  idempotent_replay: boolean;
  chain_head?: Digest;
}

export interface ProvenanceResponse {
  decision_id: DecisionId;
  provenance_id: ProvenanceId;
  trace_id: TraceId;
  decision: DecisionRequest;
  prov_o: Record<string, unknown>;
  lineage: Array<{
    type: string;
    id: string;
    relationship?: string;
  }>;
  verification: {
    status: "valid" | "pending" | "stale" | "invalid";
    checked_at?: Timestamp;
    chain_head?: Digest;
  };
}

// ---- error.schema.json



// ---- execution-context.schema.json



// ---- ingest-job.schema.json

export type JobId = string;

/** `incremental` follows each source watermark, `backfill` replays a window, `rebuild` rebuilds the graph from the sources and the package. */
export type IngestMode = "incremental" | "backfill" | "rebuild";

/** The frozen Context Package revision the job compiles. The digest is the one the revision recorded and `solution.lock` pinned, so a job can only ever materialize semantics that were frozen. */
export interface IngestPackageRef {
  name: string;
  version: Semver;
  digest: Digest;
}

export interface IngestJobRequest {
  package: IngestPackageRef;
  mode: IngestMode;
  /** Context Source ids to ingest. Absent means every source the package declares. */
  sources?: Array<string>;
}

export interface IngestSourceResult {
  source: string;
  status: "ok" | "degraded" | "failed";
  entities?: number;
  edges?: number;
  /** The watermark the next incremental run resumes from. */
  watermark?: string;
  /** Why the source is degraded or failed. */
  reason?: string;
}

/** The finished job. Synchronous in this slice: the response is the outcome, not a handle to poll. */
export interface IngestJobResult {
  job_id: JobId;
  status: "succeeded" | "degraded" | "failed";
  package: IngestPackageRef;
  mode: IngestMode;
  started_at: Timestamp;
  finished_at: Timestamp;
  sources: Array<IngestSourceResult>;
  message?: string;
}

// ---- retrieval.schema.json

export interface Subject {
  type: "user" | "service";
  id: string;
  roles?: Array<string>;
  scopes?: Array<string>;
}

export interface Budget {
  max_nodes?: number;
  max_tokens?: number;
  max_hops?: number;
}

export interface BudgetUsed {
  nodes?: number;
  tokens?: number;
  hops?: number;
}

export interface RetrieveRequest {
  recipe_id: string;
  query: string;
  subject?: Subject;
  filters?: Record<string, unknown>;
  budget?: Budget;
}

export interface RetrievalItem {
  entity_id: EntityId;
  type: string;
  content: string;
  score: number;
  source_ref: string;
  version: string;
  classification?: Classification;
  trust?: "untrusted";
  source_kind?: "structured" | "document" | "web" | "derived" | "other";
  provenance_id?: ProvenanceId;
  metadata?: Record<string, unknown>;
}

export type RetrieveResponse = unknown;

// ---- run.schema.json

export interface RunCreateRequest {
  capability_id: CapabilityId;
  input: Record<string, unknown>;
  /** Client-owned conversation thread handle. Required when the referenced capability declares `memory.thread` (v1.4); first use binds the thread to (tenant_id, actor.type, actor.id), later mismatches return 404 thread_not_found. */
  thread_id?: string;
  metadata?: Record<string, unknown>;
}

export interface RunCreateResponse {
  run_id: RunId;
  trace_id: TraceId;
  status: "queued" | "running";
  stream_url: string;
}

export interface RunStatus {
  run_id: RunId;
  trace_id: TraceId;
  capability_id: CapabilityId;
  status: "queued" | "running" | "waiting_for_human" | "succeeded" | "failed" | "cancelled";
  started_at: Timestamp;
  finished_at?: Timestamp;
  output?: Record<string, unknown>;
  error?: ErrorDetail;
  decisions?: Array<DecisionId>;
  approvals?: Array<ApprovalId>;
  usage?: Record<string, unknown>;
}

export interface RunEvent {
  run_id: RunId;
  trace_id: TraceId;
  seq: number;
  type: "run.started" | "text.delta" | "text.done" | "tool.call" | "tool.result" | "approval.required" | "approval.decided" | "run.finished" | "run.failed" | "run.cancelled" | "heartbeat";
  timestamp: Timestamp;
  payload: Record<string, unknown>;
}

// ---- runtime-capabilities.schema.json

export type Support = "native" | "adapter" | "degraded" | "none";

export type EvalHooks = "native" | "external" | "none";

export type StateStoreKind = "sqlite" | "libsql" | "postgres";

export type DurabilityMode = "sync" | "async" | "exit";

export type ExtensionArtifactKind = "ts-package" | "python-wheel" | "http";

export type TopologyMode = "split" | "merged-container" | "agent-server";

export type Limitations = Array<string>;

export type DegradedRequiresLimitations = unknown;

export type CapabilityNode = DegradedRequiresLimitations;

export type DurableWorkflow = DegradedRequiresLimitations;

export type Hitl = DegradedRequiresLimitations;

export type Streaming = DegradedRequiresLimitations;

export type Observability = DegradedRequiresLimitations;

export type Memory = DegradedRequiresLimitations;

export type Tools = DegradedRequiresLimitations;

export type Extensions = DegradedRequiresLimitations;

export type StateStore = DegradedRequiresLimitations;

export type RuntimeCapabilitiesTopology = DegradedRequiresLimitations;

export type Offline = DegradedRequiresLimitations;

export interface RuntimeCapabilities {
  durableWorkflow: DurableWorkflow;
  hitl: Hitl;
  streaming: Streaming;
  observability: Observability;
  memory: Memory;
  tools: Tools;
  extensions: Extensions;
  stateStore: StateStore;
  topology: RuntimeCapabilitiesTopology;
  offline: Offline;
}

/** Flat capability-path map used by runtime-info. Paths are the same as the RuntimeCapabilities tree, e.g. hitl.consume. */
export type CapabilityDetails = Record<string, CapabilityNode>;

// ---- runtime-info.schema.json

export interface ComponentInfo {
  name: "runtime-app" | "runtime-state" | "mastra-app" | "mastra-state" | "context-service" | "graph-store" | "audit-store";
  version: string;
  contract_version: Semver;
  status: "ready" | "degraded" | "starting" | "failed";
  schema_version?: SchemaVersion;
}

export interface RuntimeDescriptor {
  family: string;
  language: "typescript" | "python";
  version: Semver;
  profile_digest: Digest;
  generator_version: Semver;
  state_store: StateStoreKind;
  topology: TopologyMode;
  licensing: Licensing;
}

export interface Limits {
  max_nodes: number;
  max_edges: number;
  max_request_timeout_ms: number;
  max_run_deadline_ms: number;
}

export type RuntimeInfo = unknown;

// ---- runtime-profile.schema.json

export type ProfileName = string;

export type RuntimeFamily = string;

export type RuntimeLanguage = "typescript" | "python";

export interface Metadata {
  name: ProfileName;
  version: Semver;
  description?: string;
}

export interface Generator {
  name: Name;
  version: Semver;
}

/** Exact package versions. Ranges are not allowed; resolve them in the profile artifact. */
export type PackagePins = Record<string, Semver>;

export interface Licensing {
  runtime: "Apache-2.0" | "MIT" | "Elastic-2.0" | "other";
  requiresLicenseKey: boolean;
  egress: boolean;
}

export interface ProfileSpec {
  generator: Generator;
  family: RuntimeFamily;
  language: RuntimeLanguage;
  runtimeVersion: Semver;
  contractVersion: Semver;
  packages: PackagePins;
  capabilities: RuntimeCapabilities;
  licensing: Licensing;
}

export interface RuntimeProfile {
  apiVersion: "fde.dev/v0";
  kind: "RuntimeProfile";
  metadata: Metadata;
  spec: ProfileSpec;
}
