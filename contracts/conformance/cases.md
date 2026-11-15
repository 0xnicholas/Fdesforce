# Runtime Contract Conformance Cases

These cases are the acceptance suite for `fde.runtime/v1`. They are fixed here so the first implementation slice can wire them into CI without re-deciding behavior.

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

The runner lands with the first `context-service` implementation. Until then, this table is the contract's test plan; examples and schemas in `docs/runtime-contract.md` and `contracts/schemas/` are the fixtures. The first generator slice must wire C16–C25 into the same runner.
