# Third-party notices (prototype)

This bundle uses only the following upstream components. It is **not** a
complete notice file; the real build generates one from the toolchain image.

| Component | Version | License | Notes |
|---|---|---|---|
| `@mastra/core` | 1.83.0 | Apache-2.0 | core only |
| `mastra` CLI | 1.39.0 | Apache-2.0 | build/runtime CLI |
| `@mastra/libsql` | 1.30.0 | Apache-2.0 | mastra-state store |
| `semantica` | 0.7.0 | MIT | embedded in context-service |
| `fastapi` | 0.115.6 | MIT | context-service |
| `uvicorn` | 0.34.0 | BSD-3-Clause | context-service |
| `pydantic` | 2.10.4 | MIT | context-service |
| `PyYAML` | 6.0.2 | MIT | context-service |
| embedded graph store | — | — | in-process, no GPL dependency |

Excluded from the bundle:

- Mastra `dist/**/ee/**` (enterprise paths require a commercial agreement).
- `@mastra/editor` (not needed by the v0 bundle).
- Neo4j / GPL-3.0 graph backend (production choice deferred to ticket #15).
