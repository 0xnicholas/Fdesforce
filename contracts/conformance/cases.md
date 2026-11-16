# Runtime Contract Conformance Cases

These cases are the acceptance suite for `fde.runtime/v1` (current minor `1.2`). They are fixed here so the first implementation slice can wire them into CI without re-deciding behavior.

| ID | Case | Expected |
|---|---|---|
| C1 | Schema validation | Every request/response example in `docs/runtime-contract.md` validates against its schema |
| C2 | Missing ExecutionContext | `401 unauthenticated`, unified error envelope, `trace_id` present |
| C3 | Wrong tenant | `403 forbidden`; no entity from another tenant is returned |
| C4 | Decision idempotent replay | Same `Idempotency-Key` + same payload returns the original `decision_id`/`provenance_id`, `idempotent_replay=true` |
| C5 | Idempotency conflict | Same key + different payload returns `409 idempotency_conflict` |
| C6 | Trace propagation | `traceparent` trace-id equals JWT `trace_id`; retrieve, decision, and provenance responses carry the same `trace_id` |
| C7 | Record-before-act | A failing intent Decision blocks the side-effect Tool; no Tool call is observed |
| C8 | Approval state machine | `pending → approved → consumed` via `/consume`; expiry produces `expired`; self-approval is denied unless policy allows; consume is idempotent |
| C9 | Contract handshake | Major contract mismatch or missing capability fails startup closed with `contract_mismatch` |
| C10 | 422 normalization | Request-body validation errors use the unified error envelope, not FastAPI's default shape |
| C11 | SSE event envelope | `seq` is monotonic, `run_id`/`trace_id` present, heartbeat at least every 15s |
| C12 | Cancellation | `POST /v1/runs/{run_id}/cancel` yields `run.cancelled`; completed Decisions remain in the audit store |
| C13 | Audit append-only | Replaying a Decision write never creates a second audit entry; `verify_chain` passes after restart |
| C14 | Provenance returns Decision | `GET /v1/provenance/{decision_id}` includes the original Decision, stable IDs only, and no Neo4j/SQLite internal ID |
| C15 | Ready/degraded | `/readyz` reports `degraded` while ingest is incomplete; `retrieve` returns `degraded=true` with a reason |

## Generated workflow / HITL grammar cases (#18)

These cases cover the Solution Spec → runtime mapping decided in #18. C8 covers
the runtime approval state machine; the cases below cover what the generator
emits and how the Spec fields map.

| ID | Case | Expected |
|---|---|---|
| C16 | Approval request mapping | The generated approval request carries `proposed_action.tool/operation/input_digest` derived from the gated Tool, `approver_roles` from the step, `expires_at` resolved from `expiresAfter`, evidence from `evidenceFrom`, and the predicate Policy in `policy_refs`; no free-form `when` or inline `proposedAction` is accepted |
| C17 | Approve → resume → consume | Approval `pending → approved`; workflow resumes; `consume` is called once; the gated Tool executes exactly once; the approval is `consumed`; a repeated `consume` with the same key is idempotent |
| C18 | Reject | A rejected approval never resumes; the gated Tool is not executed; the Run succeeds with `output.approval.status=rejected`; the approval Decision records the rationale; no Tool intent Decision is written |
| C19 | Expire | An expired approval is not resumed; the gated Tool is not executed; the Run succeeds with `output.approval.status=expired`; the approval Decision records expiry |
| C20 | Resume / consume failure | If resume fails before the Tool, no side effect occurs and resume is retried; if the Tool executed but `consume` fails, `consume` is retried with the same idempotency key and the Tool is not re-executed; the approval is not re-decided |
| C21 | Post-approval side effect | The gated Tool still writes intent and outcome Decisions via record-before-act; the intent Decision references the approval Decision; approval does not bypass the audit invariant |
| C22 | Auto-approval | `requiredWhen` false creates no Approval resource, writes an `auto_approved` Decision with the policy evaluation, and executes the gated Tool without entering `waiting_for_human` |
| C23 | Self-approval | Default deny: the requester cannot approve their own request (`403`); a Policy that allows self-approval records the policy evaluation and the approver rationale; no step-level override exists |
| C24 | Policy tighten-only | Build accepts a stricter `amount` override (lower threshold) and rejects a relaxed one (higher threshold); the resolved value is pinned through the Policy Template + lock; `requiredWhen` evaluates the resolved value |
| C25 | Capability entry and grammar validation | Unknown `capability_id` returns `404 not_found`; a known capability maps to its declared implementation entry (workflow `steps[0]` or agent); build fails closed for a non-durable workflow with approval, non-adjacent `gates`, unknown predicate, arg type/schema mismatch, platform role in `approverRoles`, or evidence from a non-context/tool step |

## Decision audit binding cases (#20)

These cases cover the Solution Spec → Decision contract mapping decided in #20.
C7 and C21 stay the invariant-level cases; C26–C32 cover payload, evidence,
Policy coverage, run-level decisions, and crash recovery.

| ID | Case | Expected |
|---|---|---|
| C26 | Intent completeness | Before a side-effecting Tool executes, exactly one intent Decision exists with `invocation_id`, `action.tool_id`, non-empty `evidence`, at least one `tool.pre_invoke` policy evaluation (with `enforcement_point`/`evaluated_by`), `input_digest`, and `model`/`prompt_version` when an Agent proposed the call; a failing intent write blocks the Tool (C7 payload-level) |
| C27 | Outcome linkage and failure | After execution, exactly one outcome Decision has `parent_decision_id` pointing at the intent, `status=succeeded|failed`, and `output_digest`; an outcome write failure fails the Run, keeps the intent, and a retry reuses the same outcome `decision_id` without re-executing the Tool; `decision_coverage` marks the invocation incomplete |
| C28 | Evidence selectors | A `from: retrieval` selector emits item-level `graph_entity` evidence plus the `retrieval` snapshot ref; a `from: step` artifact selector emits a `run_artifact` with digest; `as: citations` resolves every citation uniquely, and an unresolved or ambiguous citation fails intent write with no Tool execution; an approval-gated call automatically includes `approval` evidence |
| C29 | Policy deny | A `tool.pre_invoke` deny writes an intent with `status=denied` and the deny evaluation; the Tool is not executed, no outcome is written, and the invocation is excluded from `decision_coverage` |
| C30 | Read-only Run | By default a read-only Run writes one `phase=run` Decision with all retrieval snapshots, final `output_digest`, and model/prompt; a capability with `runOutcomeDecision: omitted` writes none and build rejects `omitted` when the capability contains a side-effecting Tool; a failed read-only Run writes `status=failed` |
| C31 | Classification/retention and build fail-closed | A non-read Tool without `audit`, or a side-effecting Tool without an evidence selector, fails build; intent `classification` equals the max of Tool/evidence/Policy; `retention_class` is the strictest of Tool/Policy; an unclassified retrieval item defaults to `restricted` |
| C32 | Crash recovery | On restart with outbox state `executing`, the runtime does not retry the side effect; it writes an outcome with `status=unknown` linked to the same intent and fails the Run; an outbox write failure produces no intent and no execution |

## Agent security cases (#21)

These cases cover the deterministic agent-security controls decided in #21.
C7/C26–C32 stay the audit invariants; C33–C40 cover untrusted content,
approval coverage, abuse budgets, output guard, egress, kill switch, and memory
trust. Behavioral red-team cases live in the `adversarial` Eval split and are
advisory in v0, not conformance.

| ID | Case | Expected |
|---|---|---|
| C33 | Untrusted content envelope | Every RetrievalItem carries `trust=untrusted` and `source_kind`; the generated prompt renders each item inside a per-Run nonce data block with JSON-escaped content; content containing `</data-block>` or fake instructions cannot escape the block; Agent instructions cannot disable the wrapper; missing fields default to `untrusted`/`other` |
| C34 | Tool result envelope | Tool results enter the model as `tool-result-block`; instructions inside a tool result do not change allowlist/approval decisions; tool results never enter the system prompt |
| C35 | Approval coverage | A non-read Tool without an approval gate, an Agent-only implementation containing a non-read Tool, or an auto-approval gate without a pinned Policy makes build fail; a valid gate produces the approval request or `auto_approved` Decision |
| C36 | Rate limit and run budget | Exceeding `perRunMax`, `perActorPerHourMax`, `maxToolCallsPerRun`, or `maxSteps` writes a denied intent, executes no Tool, and writes `authz.denied` with the matching reason code; an unavailable counter store fails closed |
| C37 | Output guard | A secret match produces no output, fails the Run, and writes `security.output_blocked`; a PII match is masked with `redaction_applied=true`; `piiMode=block` blocks the Run; non-citation URLs are not rendered as links |
| C38 | Egress declaration | A Tool Extension missing `egress` resolves to `none`; `connector:<id>` must exist and be allowed; the manifest contains only declared routes; undeclared egress is denied |
| C39 | Kill switch | `POST /v1/admin/killswitch` requires `killswitch:execute`; `halt` blocks new Runs/tool calls, cancels active Runs, and writes audit events; state recovers from the latest Audit Event after restart; `disable` requires a reason and writes audit |
| C40 | Memory trust | Memory renders as a `memory-block` with `trust=untrusted`; memory is not promoted to graph facts or Decision evidence; cross-user/tenant/Solution recall is denied; the full schema assertions wait for #22 |

The runner lands with the first `context-service` implementation. Until then, this table is the contract's test plan; examples and schemas in `docs/runtime-contract.md` and `contracts/schemas/` are the fixtures. The first generator slice must wire C16–C40 into the same runner.
