# Runtime Adapter Conformance Cases

These cases are the acceptance suite for a `RuntimeGenerator` (`fde.runtime/v1`, adapter v1.3). They are deliberately separate from [`cases.md`](./cases.md): **C1–C15 are owned by context-service**, **A1–A11 are owned by the generator**. Do not merge the two suites; A-cases cross-reference C-cases where the behavior is the same.

The generator's `generateContractTests()` returns a [`TestPlan`](../../docs/runtime-adapter.md#43-输入输出) mapping each A-case to a command and fixtures. The shared runner executes the plan; the generator does not implement its own runner.

| ID | Case | Expected | Tier | Related C |
|---|---|---|---|---|
| A1 | Runtime capability handshake | Profile digest, family/language, contract major, and every `must` capability are present and not `degraded`; missing capability fails build, and a mismatched runtime fails startup closed. | static + smoke | C9 |
| A2 | Run API parity | `POST /v1/runs`, `GET /v1/runs/{id}`, `POST /v1/runs/{id}/cancel`, and `GET /v1/runs/{id}/stream` match the client OpenAPI; errors use the unified envelope; no runtime-native endpoint leaks. | smoke | C1, C11 |
| A3 | HITL round trip | Approval is created by the workflow, surfaced as `approval.required`, approved through the generated app, resumed, and consumed exactly once; reject and expire paths also terminate or follow the declared branch. | smoke | C8 |
| A4 | Record-before-act | A failing intent Decision blocks the side-effecting Tool; no Tool call is observed; the outcome Decision links to the intent; retries do not create a second audit entry or duplicate the side effect. | smoke | C7 |
| A5 | SSE envelope | `seq` is monotonic from 1; every event carries `run_id` and `trace_id`; heartbeat is at least every 15s; all declared event types use the contract envelope. | smoke | C11 |
| A6 | Restart resume | An unfinished durable Run resumes after a process restart from the runtime state store; completed steps and side effects are not re-executed; `run_id` and trace remain stable. | release | — |
| A7 | Approval expiry / cancel | An expired approval writes an `expired` Decision and the Run ends or takes the declared alternate branch; `cancel` yields `run.cancelled`; completed Decisions remain in the audit store. | release | C8, C12 |
| A8 | Tenant / trace propagation | `ExecutionContext` tenant and scope are enforced end to end; `traceparent` trace-id equals the JWT `trace_id`; no cross-tenant data or runtime-native auth bypass is possible. | smoke | C3, C6 |
| A9 | Extension load | Every declared artifact kind loads in the generated app; incompatible artifact kind or runtimeCompatibility fails at build with `runtime_extension_unsupported`, not at runtime with a 500. | static + smoke | — |
| A10 | Offline install | An air-gapped bundle starts with no public network, no license beacon, and no egress; a profile that requires a license key or egress fails explicitly with `runtime_license_blocked`. | release | — |
| A11 | Deterministic generation | The same Spec + lock + Profile + Extensions + toolchain image produce the same `sourceDigest` and Bundle digest; no timestamps, random IDs, or environment values leak into generated files. | static | — |

## A1 — Runtime capability handshake

Build side:

- Resolve `solution.lock.runtime.profile` and its digest; a missing or mismatched profile fails with `runtime_profile_missing` / `runtime_profile_mismatch`.
- Derive `must` requirements from the Spec (see [`docs/runtime-adapter.md`](../../docs/runtime-adapter.md#71-从-spec-推导要求)).
- Every `must` capability path exists in `RuntimeCapabilities` and is not `none`; `must` + `degraded` fails with `runtime_capability_degraded`.

Runtime side:

- The generated app reports `service: runtime-app`, `runtime.profile_digest`, `runtime.family/language/version`, and `capability_details` through `/v1/runtime-info`; `mastra-app` is only the v1.0 alias and does not satisfy the new handshake.
- A missing or mismatched capability fails `/readyz` with 503 and `runtime_capability_mismatch`; the Run API does not serve.

## A2 — Run API parity

- Start a Run with `Idempotency-Key`; the response is `202` (or the contract's declared status) with `run_id`, `trace_id`, `status`, and `stream_url`.
- `GET /v1/runs/{id}` returns status, output, error, and Decision/Approval references in the contract shape.
- `cancel` returns `202`; the stream eventually emits `run.cancelled`.
- Generated app must not expose Mastra/LangGraph native endpoints or IDs as the client API.

## A3 — HITL round trip

- The generated workflow calls context-service `POST /v1/approvals` with `run_id`, `capability_id`, `proposed_action`, evidence refs, `approver_roles`, and `expires_at`.
- The Run enters `waiting_for_human` and emits `approval.required`.
- Approval through the generated app proxies the approver's `ExecutionContext` to context-service; reject/expire paths are handled.
- On approval, the runtime resumes and calls `POST /v1/approvals/{id}/consume`; consume is idempotent; a consume failure retries consume without re-executing the side effect.

## A4 — Record-before-act

- Before any side-effecting Tool, the generated wrapper writes `phase=intent` with evidence, policy evaluations, and the proposed action digest.
- If the intent write fails, the Tool is not called and the Run fails (or requests human intervention).
- After the side effect, the wrapper writes `phase=outcome` with `parent_decision_id`; failure still writes an outcome.
- Repeating the same `Idempotency-Key`/`decision_id` returns the original entry; no second audit entry.

## A5 — SSE envelope

- Event types: `run.started`, `text.delta`, `text.done`, `tool.call`, `tool.result`, `approval.required`, `approval.decided`, `run.finished`, `run.failed`, `run.cancelled`, `heartbeat`.
- `seq` starts at 1 and is monotonic; `run_id` and `trace_id` are present; heartbeat at least every 15s.
- Disconnect behavior follows the Capability Policy; if replay is unsupported, `GET /v1/runs/{id}` is the recovery path.

## A6 — Restart resume

- Start a durable Run, stop the runtime process after a checkpoint, restart it, and resume the same Run.
- The Run registry maps `run_id ↔ thread_id`; the reconciler picks up unfinished Runs.
- Completed steps and side effects are not re-executed; the state store is the only runtime state used.
- If the state store is missing or schema-mismatched, startup fails closed rather than silently starting a new Run.

## A7 — Approval expiry / cancel

- Expiry writes an `expired` Decision and moves the Run to the declared terminal/alternate branch; it does not leave the Run `waiting_for_human` forever.
- Cancel writes `run.cancelled`; completed Decisions remain; any possibly executed side effect is recorded.
- A late approval after expiry/decision is rejected with `approval_already_decided`.

## A8 — Tenant / trace propagation

- Every context-service call carries a signed `ExecutionContext` with `tenant_id`, `scopes`, `run_id`, and `trace_id`.
- `traceparent` trace-id equals the JWT `trace_id`; mismatch is `403`.
- The runtime must not accept a client-supplied tenant/actor as truth; no runtime-native path bypasses context-service.

## A9 — Extension load

- The generator checks `artifactKind` and `runtimeCompatibility` at build; unsupported combinations fail with `runtime_extension_unsupported`.
- Supported `ts-package` / `python-wheel` / `http` artifacts load through the generated loader; HTTP sidecars declare health and startup dependencies in the topology.
- A runtime 500 caused by a missing/incompatible artifact is a failure, not a warning.

## A10 — Offline install

- Build an offline bundle; install on a host with no public network.
- No license beacon or egress is attempted; checksums/SBOM verify; the runtime app becomes ready.
- A profile with `licensing.requiresLicenseKey: true` or `egress: true` fails at build for an air-gapped target with `runtime_license_blocked`; it does not fail silently at runtime.

## A11 — Deterministic generation

- Run generation twice with identical inputs (Spec, lock, Profile, Extensions, toolchain image) and compare file hashes and Bundle digest.
- No timestamps, random IDs, environment values, or ordering instability may appear in generated source/manifests.
- `fde verify` re-runs generation and fails on drift; CI runs the same check.

## Runner and CI

| Stage | Cases | Where |
|---|---|---|
| `fde build` | A1 (build checks), A9 (static), A11, schema validation | Workbench CLI |
| PR / bundle smoke | A2–A5, A8, A9 (load) | Compose bundle in CI |
| Release gate | A6, A7, A10 | Compose bundle with restart/air-gap fixtures |
| `fde verify` | A1, A9 (static), A11, C1 examples | Workbench CLI |
| context-service CI | C1–C15 | context-service implementation |

Mastra adapter must pass A1–A11. The LangGraph pseudo-adapter only maps each A-case to the implementation it would need; it does not run a suite in v0.
