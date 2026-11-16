# FDE Runtime Contract Artifacts

Machine-readable artifacts for `fde.runtime/v1`. The narrative contract lives in [`docs/runtime-contract.md`](../docs/runtime-contract.md).

| File | Surface |
|---|---|
| `runtime-api-v1.openapi.yaml` | Client-facing API exposed by the generated runtime app (`mastra-app` in v0) |
| `context-service-v1.openapi.yaml` | Internal API owned by `context-service` |
| `schemas/common.schema.json` | Shared IDs, classification, retention, policy evaluation |
| `schemas/execution-context.schema.json` | Signed identity assertion |
| `schemas/retrieval.schema.json` | Context retrieval request/response |
| `schemas/decision.schema.json` | Decision write and provenance read |
| `schemas/approval.schema.json` | HITL approval request/decision |
| `schemas/run.schema.json` | Run API request/status/SSE event |
| `schemas/runtime-info.schema.json` | Version/capability handshake (`v1.3` adds `runtime` + `capability_details`) |
| `schemas/runtime-profile.schema.json` | Runtime profile artifact referenced by `build.runtimeProfile` |
| `schemas/runtime-capabilities.schema.json` | Shared Runtime Capability declaration and handshake detail map |
| `schemas/bundle-topology.schema.json` | `RuntimeTopology` fragment and composed `BundleTopology` |
| `schemas/error.schema.json` | Unified error envelope |
| `conformance/cases.md` | Runtime contract acceptance cases (C1–C40) |
| `conformance/adapter-cases.md` | Runtime adapter acceptance cases (A1–A11) |

## Evaluation artifacts

Metric Catalog, Eval Suite, Eval Dataset, Evaluation, and Acceptance Report are governance artifacts, not part of `fde.runtime/v1`. Their decisions and examples live in [`docs/evaluation-and-observability.md`](../docs/evaluation-and-observability.md) and [`examples/eval/`](../examples/eval/). Zod/JSON Schema for them will be added by the implementation slice; do not look for `eval-*.json` here in v0.

## Versioning

- Contract version: `fde.runtime/v1` (semantic version). Current minor: `1.4.0` (Agent memory; see [`docs/adr/0012-agent-memory.md`](../docs/adr/0012-agent-memory.md)).
- Additive fields or endpoints: minor. Version history: `1.0.0` (runtime contract, #8) → `1.1.0` (decision audit binding, #20) → `1.2.0` (agent security, #21) → `1.3.0` (runtime adapter, #17: `runtime-info` unified to `runtime-app` + `runtime`/`capability_details` + `backend.graph: postgres` + A1–A11) → `1.4.0` (agent memory, #22: `thread_not_found`, `thread_id` required with `memory.thread`, C41–C48, A12).
- Breaking changes: `/v2` or a negotiated media type, with at least one minor cycle of deprecation.
- Generated TS clients and Python models come from these files; do not hand-edit them.

## Validation

- JSON Schema files are JSON: `python3 -m json.tool contracts/schemas/<file>.json`.
- OpenAPI files are YAML 1.2; parse them with any YAML 1.2 parser before merging.
