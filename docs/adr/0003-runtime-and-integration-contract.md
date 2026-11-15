---
status: accepted
---
# 运行时与集成契约：context-service 独占边界、签名执行上下文、独立审计库

v0 的运行时契约由 context-service 独占：Mastra 只通过生成的 TS client 调用 `/v1` REST，Semantica 原生 REST/MCP 不进入生产路径；跨语言身份用每 Deployment 的 ES256 `ExecutionContext` JWT 传播，trace 用 W3C `traceparent`；Decision/Provenance 写独立 append-only 审计库，图事实与审计分离；v0 图存储用 Semantica 进程内 embedded 后端（单写者、10k/50k 交互上限），生产图存储与索引推迟到「生产检索索引与 100k+ 规模上限」；bundle 为 `mastra-app` + `context-service` + `mastra-state`/`graph`/`audit` 卷 + `migrate`/`ingest` 作业，compose/helm/airgap 同构；升级 stop-the-world，audit 不参与常规回滚。这样跨语言接缝只有一个、审计可验证、v0 可交付；代价是生产规模受限，且 Mastra minor 升级仍需 contract tests 兜底。

## Considered Options

- **Mastra 直连 Semantica 原生 REST/MCP**：被 spike 证伪——没有 decision 写端点、没有 PROV-O、导入图重启丢失、MCP 与 REST 是两套状态。
- **明文 `X-Tenant-Id`/`X-Actor` + 内网信任**：单客户 bundle 内仍有多用户/角色，任何内网进程都能冒充；改为签名断言。
- **每个 Context Recipe 生成专用端点/SDK**：契约随 Solution 漂移，兼容矩阵无法收敛；改为固定核心 API + `recipe_id` 参数。
- **审计与主图同库/同快照**：图迁移/重建会污染审计，保留期无法独立；改为独立 append-only 审计库。
- **v0 直接上 Neo4j/生产索引**：事务和索引更成熟，但 spike 的 Neo4j serving 未接通，且会把 v0 交付拖入图存储迁移；改为 embedded + `GraphStore` 端口，生产后端另票决定。

## Consequences

- v0 的 embedded 图是单写者、10k/50k 交互上限；无 HA/灾备认证，不能把 v0 拓扑当生产规模承诺。
- 真实 LLM 的 tool 选择未验证；contract tests 用 mock/固定序列覆盖通路，评测由「评测、验收与可观测性」补。
- 审计库 v0 为 SQLite；大规模 audit 保留/查询需要后续存储方案。
- 客户端 Run API 与审批 API 由生成的 `mastra-app` 提供；客户审批 UI 不在本阶段。
- 生产图存储、Neo4j serving adapter、索引组合与迁移路径仍由「生产检索索引与 100k+ 规模上限」决定。
- Mastra 1.x minor 有破坏性变更记录；每次升级必须跑 contract tests 和兼容矩阵，不能只靠版本范围。
