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

The runner lands with the first `context-service` implementation. Until then, this table is the contract's test plan; examples and schemas in `docs/runtime-contract.md` and `contracts/schemas/` are the fixtures.
