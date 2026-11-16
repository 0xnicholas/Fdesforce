# FDE Runtime Contract Artifacts

Machine-readable artifacts for `fde.runtime/v1`. The narrative contract lives in [`docs/runtime-contract.md`](../docs/runtime-contract.md).

| File | Surface |
|---|---|
| `runtime-api-v1.openapi.yaml` | Client-facing API exposed by `mastra-app` |
| `context-service-v1.openapi.yaml` | Internal API owned by `context-service` |
| `schemas/common.schema.json` | Shared IDs, classification, retention, policy evaluation |
| `schemas/execution-context.schema.json` | Signed identity assertion |
| `schemas/retrieval.schema.json` | Context retrieval request/response |
| `schemas/decision.schema.json` | Decision write and provenance read |
| `schemas/approval.schema.json` | HITL approval request/decision |
| `schemas/run.schema.json` | Run API request/status/SSE event |
| `schemas/runtime-info.schema.json` | Version/capability handshake |
| `schemas/error.schema.json` | Unified error envelope |
| `conformance/cases.md` | Contract acceptance cases |

## Evaluation artifacts

Metric Catalog, Eval Suite, Eval Dataset, Evaluation, and Acceptance Report are governance artifacts, not part of `fde.runtime/v1`. Their decisions and examples live in [`docs/evaluation-and-observability.md`](../docs/evaluation-and-observability.md) and [`examples/eval/`](../examples/eval/). Zod/JSON Schema for them will be added by the implementation slice; do not look for `eval-*.json` here in v0.

## Versioning

- Contract version: `fde.runtime/v1` (semantic version). Current minor: `1.2.0` (Agent security; see [`docs/agent-security.md`](../docs/agent-security.md)).
- Additive fields or endpoints: minor.
- Breaking changes: `/v2` or a negotiated media type, with at least one minor cycle of deprecation.
- Generated TS clients and Python models come from these files; do not hand-edit them.

## Validation

- JSON Schema files are JSON: `python3 -m json.tool contracts/schemas/<file>.json`.
- OpenAPI files are YAML 1.2; parse them with any YAML 1.2 parser before merging.
