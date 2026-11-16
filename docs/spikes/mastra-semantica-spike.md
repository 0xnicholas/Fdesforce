# Mastra ↔ Semantica 最小集成 spike

> Ticket: [#5](https://github.com/0xnicholas/Fdesforce/issues/5) · 父地图: [#1](https://github.com/0xnicholas/Fdesforce/issues/1) · 日期: 2026-11-14
> 分支: `spike/5-mastra-semantica` · 性质: **task spike，不是 research**
> 结论状态: **条件通过（Conditional GO）**。薄 REST 服务路径可端到端跑通；Semantica 自带的 REST/MCP serving 路径不能作为生产契约。

## 0. TL;DR

- **Mastra agent → 自有薄 `context-service`（REST）→ Semantica Python API** 跑通了完整闭环：`retrieve → record_decision → get_provenance`，3 次真实 tool call，trace/actor/tenant 透传到 PROV-O，重启后 provenance 校验和与链完整。
- **MCP 对照路径能跑，但不能当生产**：15 个 tool，有 `record_decision`，但没有 provenance / ontology / SHACL tool；stdio 本地进程；图与 REST 服务完全隔离（两套状态）；`SEMANTICA_KG_PATH` 只是单 JSON 文件持久化。
- **Semantica 自带 REST 不能当生产**：79 条路径 / 83 个 operation；没有 decision 写端点（`POST /api/decisions` 返回 405）；`/api/provenance` 返回的是图遍历合成的 `graph_traversal`，checksum 为 `null`，不是 PROV-O；导入的图在重启后归零。
- **Neo4j 核心适配器能用，但没接进 serving path**：`Neo4jStore` 可创建节点/关系、查邻居；节点身份是 Neo4j 内部整数 `id`，`entity_id` 只是 property，不能作为稳定外部 ID。500 节点 + 1000 关系写入分别 5.8s / 15.1s；邻居查询 p50 11.5ms。
- **规模**：10k 节点 / 50k 边时，Semantica `ContextGraph.query()`（词法扫描）p50 61ms、p95 246ms，2-hop 邻居仍只有 0.096ms；10 万级以上不能把 `query()` 当交互式检索。provenance `verify_chain()` 是线性的：6.1k 条 entry 时 1.07s，不能放在读路径。
- **这次 spike 的直接产物**：一个可复现的 3-endpoint 契约、一个候选 bundle manifest、以及给 [#8 运行时契约](https://github.com/0xnicholas/Fdesforce/issues/8) 的 5 条硬约束。

## 1. 环境、依赖、版本

| 项 | 值 |
|---|---|
| 机器 | macOS 13.7.8，8 vCPU / 16 GB |
| Python | 3.12.2（`uv venv --python 3.12`） |
| Semantica | `semantica[explorer,shacl,graph-neo4j]==0.7.0`（PyPI，MIT） |
| Node | 26.2.0（bundle 目标应写 Node 22+） |
| Mastra | `@mastra/core@1.83.0`，`@mastra/mcp@2.9.0` |
| AI SDK | `ai@7.0.173`，`zod@4.6.7` |
| Neo4j | `neo4j:5-community`，digest `sha256:4bae36aff76271e27fd6a6ed0835413f86a284cd179cfb1cb7d188f5f7533aca` |
| 安装体积 | Python venv 538 MB；Node `node_modules` 234 MB |
| 运行占用 | context-service 冷启动 6.03s，RSS 约 212 MB |

**没有使用真实 LLM key。** Mastra agent 使用 `ai/test` 的 `MockLanguageModelV4`：Mastra 的 Agent、tool 注册、tool 执行、多步循环都是真的，只有模型选择 tool 的部分是脚本化的固定序列。这验证了集成通路，不验证真实模型的 tool 选择质量。

复现步骤见 [`spikes/mastra-semantica/README.md`](../../spikes/mastra-semantica/README.md)。完整依赖锁定在 [`service/requirements.lock.txt`](../../spikes/mastra-semantica/service/requirements.lock.txt) 和 [`mastra-app/package-lock.json`](../../spikes/mastra-semantica/mastra-app/package-lock.json)。

## 2. 实际调用链与时序（路径 A，目标路径）

```text
Mastra agent（Node，MockLanguageModelV4）
  │  1. tool call: retrieve_context
  ▼
tool execute → POST /v1/context/retrieve
  headers: X-Tenant-Id: acme
           X-Trace-Id: tr-rest-...
           X-Actor: mastra-agent:spike
  body: {query, max_hops, top_k}
  ▼
context-service（FastAPI，Python 3.12）
  ├─ Semantica ContextGraph.query()（词法检索）
  ├─ get_neighbors(hops=2)（图扩展）
  ├─ 按 tenant_id 过滤
  ├─ ProvenanceManager.get_provenance()（返回 source/checksum）
  └─ track_entity(retrieval:<trace_id>) 写一条审计 entry
  ▼
返回 items + provenance + trace_id
  │  2. tool call: record_decision
  ▼
POST /v1/decisions
  ├─ 校验每个 evidence entity 存在且 tenant 匹配
  ├─ ContextGraph.record_decision(...)（decision/category/decision_maker 节点）
  ├─ ProvenanceManager.track_entity(decision_id, activity_id=trace, used_entities=evidence)
  └─ save_to_file(graph.json)（全量快照）
  ▼
  │  3. tool call: get_provenance
  ▼
GET /v1/provenance/{decision_id}
  └─ entry + lineage + verify_chain()
  ▼
Mastra 最终文本：Refund approved...
```

实测一次运行的 artifact：[`rest-run.json`](../../spikes/mastra-semantica/artifacts/rest-run.json)（agent 步骤/最终文本）、[`rest-verified.json`](../../spikes/mastra-semantica/artifacts/rest-verified.json)（独立 HTTP 复核）。

关键观测：

| 检查项 | 结果 |
|---|---|
| agent tool 调用 | `retrieve_context` → `record_decision` → `get_provenance`，共 3 次 |
| 端到端 wall time | 299 ms（小图、无真实 LLM 延迟） |
| trace 透传 | decision provenance `activity_id = tr-rest-1794657774184` |
| actor 透传 | `agent_id = mastra-agent:spike` |
| tenant 透传 | provenance metadata `tenant_id = acme` |
| 决策证据 | `acme:policy:refund`, `acme:order:1001`, `acme:customer:42`, `acme:policy:premium` |
| 重启后 provenance | checksum 不变；链 valid；15 → 15 条 entry（重启前数据） |
| 重启后图 | 13 节点 / 26 边，检索仍返回 premium/refund 政策 |

注意：`ContextGraph.record_decision()` 自己会创建 `category`、`decision_maker` 节点和 `involves`/`made_by` 边，所以决策写入会让图节点数增长；这些自动节点没有业务 `tenant_id`，本 spike 的检索层会把它们排除，真实服务需要统一写入 tenant 标记。

## 3. MCP 对照路径

用 Mastra `MCPClient` 以 stdio 启动 `python -m semantica.mcp_server`，设置 `SEMANTICA_KG_PATH`。原始结果：[`mcp-run.json`](../../spikes/mastra-semantica/artifacts/mcp-run.json)、[`mcp-restart.json`](../../spikes/mastra-semantica/artifacts/mcp-restart.json)。

15 个 tool：

```text
add_entity, add_relationship, delete_node, export_graph,
extract_entities, extract_relations, find_precedents,
get_causal_chain, get_graph_analytics, get_graph_summary,
query_decisions, query_graph, record_decision, run_reasoning, update_node
```

| 问题 | 结果 |
|---|---|
| 有 decision 写 tool 吗 | 有，`record_decision` |
| 有 provenance tool 吗 | **没有**（名称/能力都不存在） |
| 有 ontology / SHACL tool 吗 | **没有** |
| 与 REST 服务共享图吗 | **不共享**。MCP 里加了 `mcp:probe:policy`，REST 服务检索 `mcp:probe:policy` 返回 `items: []`；REST 图仍是 13 节点 |
| MCP 自己的图重启后保留吗 | 保留：5 节点 / 1 decision（`mcp-graph.json`） |
| 传输 | stdio、本地子进程；没有 HTTP/SSE、没有 API key、没有请求头身份透传 |

**结论：** MCP 是“另一个本地应用”，不是进入 context-service 的传输层。把 MCP 当生产契约会产生两套图、两套状态，且拿不到 PROV-O。它可以继续作为 IDE/本地调试入口，但不能作为 bundle 的运行时主路径。

## 4. Semantica 自带 REST server 对照

`semantica-server` 在 8000 端口启动。OpenAPI：[`semantica-rest-openapi.json`](../../spikes/mastra-semantica/artifacts/semantica-rest-openapi.json)。原始结果：`semantica-rest-*.json`。

| 检查项 | 结果 |
|---|---|
| 路由规模 | 79 条 path / 83 个 operation |
| 认证 | 未设 `SEMANTICA_API_KEY` 时 protected route 返回 503；设 `X-API-Key` 后可访问。`SEMANTICA_ALLOW_ANONYMOUS=true` 仅开发用 |
| 导入 | `POST /api/import` 成功：2 nodes / 1 edge |
| 边类型 | 用原生 `add_edges` 的 `edge_type` 字段导入 `APPLIES_TO` 时，REST import 只读 `type`/`relationship`，边类型静默变成 `related_to`；用 `type` 才保留。导入字段契约与原生 API 不一致 |
| 检索 | `POST /api/graph/search` 能返回导入的 policy |
| decision 写入 | **没有**。`POST /api/decisions` 返回 405；`/api/decisions` 只有 GET |
| provenance | `/api/provenance?node_id=...` 返回 `source: graph_traversal`，`checksum: null`，不是 PROV-O entry |
| 重启 | 导入的 2 节点/1 边在重启后变成 0 节点/0 边；server 启动时创建空 `ContextGraph`，没有加载/写穿路径 |

这四项（无 decision 写、provenance 不是 PROV-O、无持久化、导入字段契约不一致）足以否定“直接把 Semantica REST 当生产契约”。

## 5. Neo4j 适配器

直接调用 `semantica.graph_store.Neo4jStore`（不经过 server/MCP/Explorer）。原始结果：[`neo4j-bench.json`](../../spikes/mastra-semantica/artifacts/neo4j-bench.json)。

| 操作 | 结果 |
|---|---|
| 创建 500 节点 | 5.81s |
| 创建 1000 关系 | 15.11s（实际 995 条，5 条自环被跳过） |
| 1-hop 邻居查询 | p50 11.48ms，p95 39.57ms |
| 节点身份 | 返回 `id: int`（Neo4j 内部 id）；`entity_id` 只是 property |
| 关系创建 | 必须传内部整数 id；`create_relationship('spike:n1', ...)` 会报 “nodes not found” |
| 弃用警告 | Cypher `id()` 在 Neo4j 5 上产生 DEPRECATION 通知 |

**结论：** 核心适配器能工作，但它是“图存储客户端”，不是“语义服务”。如果生产用 Neo4j 做 system of record，必须自己维护稳定外部 ID 映射、事务边界和查询层；不能直接把 `ContextGraph` 的字符串 id 语义套上去。`semantica-server`、MCP、Explorer 目前都没有接 `Neo4jStore`（与 research #4 的结论一致）。

## 6. 性能与占用

### 6.1 HTTP 服务（小图，65 节点）

来源：[`http-bench.json`](../../spikes/mastra-semantica/artifacts/http-bench.json)。200 次 retrieve、50 次 decision、100 次 provenance。

| 接口 | p50 | p95 | p99 | max |
|---|---|---|---|---|
| `POST /v1/context/retrieve` | 15.02 ms | 17.01 ms | 120.42 ms | 127.01 ms |
| `POST /v1/decisions` | 11.76 ms | 17.40 ms | 20.23 ms | 20.23 ms |
| `GET /v1/provenance/{id}` | 19.27 ms | 32.39 ms | 314.58 ms | 314.58 ms |

provenance 的 p99 尾部来自每次读都调用 `verify_chain()`；不是存储慢。

### 6.2 图规模（10k 节点 / 50k 边，进程内）

来源：[`graph-bench.json`](../../spikes/mastra-semantica/artifacts/graph-bench.json)。

| 指标 | 结果 |
|---|---|
| 建 10k 节点 | 0.057s |
| 建 50k 边 | 4.86s |
| 词法 `query()` | p50 61.44ms，p95 245.68ms |
| 2-hop `get_neighbors` | p50 0.096ms，p95 0.322ms |
| `save_to_file` | 1.377s，14.59 MB |
| `load_from_file` | 5.96s |
| 2000 条 `record_decision` | 0.96s |
| 峰值 RSS | 263.5 MB |

`query()` 是 O(n) 的词法扫描（含 `content` 字符串检查），10k 已经到 61ms p50；100k 时不可交互。2-hop 邻居只跟局部度数有关，仍然很快。生产检索必须加向量/全文索引（或把检索下推到 Neo4j/专用向量库），不能直接用 `ContextGraph.query()`。

### 6.3 provenance 链验证

来源：[`provenance-bench.json`](../../spikes/mastra-semantica/artifacts/provenance-bench.json)。

| entry 数 | `verify_chain()` |
|---|---|
| 100 | 8.68 ms |
| 1,100 | 47.51 ms |
| 6,100 | 1,074.02 ms |

单条 `get_provenance` 5.51ms。**必须把链验证移出请求路径**（后台任务/审计作业），否则 audit 规模一上来，provenance 读接口就会到秒级。manifest 里的 `PROVENANCE_VERIFY_ON_READ=false` 就是给这个用的；spike 代码已支持。

### 6.4 磁盘

- context-service 数据目录（seed + bench 决策）：约 528 KB；`graph.json` 143 KB，`provenance.db` 360 KB。
- 10k/50k benchmark 的 `bench-graph.json`：14.59 MB。
- venv 538 MB、`node_modules` 234 MB；生产镜像会因 extras（explorer/shacl/neo4j/连接器）显著更大。

## 7. 失败模式

来源：[`failure-modes.txt`](../../spikes/mastra-semantica/artifacts/failure-modes.txt)。

| 场景 | HTTP | 行为 |
|---|---|---|
| 缺 `X-Tenant-Id` | 400 | `{"error":{"code":"missing_tenant",...}}` |
| 缺 `X-Actor` | 400 | `{"error":{"code":"missing_actor",...}}` |
| 跨 tenant 读/写 | 403 | 决策写入引用 `acme:` entity 但租户是 `globex` → `tenant_mismatch` |
| 不存在的 entity | 404 | `entity_not_found` |
| 不存在的 provenance | 404 | `provenance_not_found` |
| confidence > 1 | 422 | **FastAPI 默认校验错误形状**，没有统一的 `{error:{...}}` 包装 |
| globex 检索 | 200 | 只返回 globex 节点；acme 的退款政策不会泄漏过去 |
| MCP 实体在 REST 检索 | 200 | `items: []`（两套状态） |
| Semantica REST 无 API key | 503 | 要求 `SEMANTICA_API_KEY` 或显式匿名开关 |
| Semantica REST decision 写 | 405 | 路由不存在 |
| Semantica REST 重启 | 200 | 导入图归零 |

**契约缺口：** 请求体校验错误（422）目前是 FastAPI 默认形状，和业务错误（400/403/404）不一致；#8 的契约需要规定统一错误 envelope，或者明确 422 由 Mastra 侧兜底。

## 8. 工作台生成物 / 打包清单

**现状：工作台还没有生成器，这次是手工 bundle。** 候选 manifest 在 [`bundle/manifest.json`](../../spikes/mastra-semantica/bundle/manifest.json)，只描述拓扑和启动字段，不是可安装产物。

从干净环境启动实际需要：

1. Python 3.12 + `semantica[explorer,shacl,graph-neo4j]==0.7.0`（或锁文件）；
2. context-service 代码 + `SPIKE_DATA_DIR` 数据卷 + 8011 端口 + 健康检查；
3. Mastra app：Node 22+，`@mastra/core`/`@mastra/mcp`/`ai`/`zod` 锁定版本，`CONTEXT_SERVICE_URL`、`DEFAULT_TENANT_ID`；
4. 如果启用 Neo4j：Neo4j 5 + 认证信息 + 图存储适配层（当前没有现成 serving 集成）；
5. 请求头契约：`X-Tenant-Id`、`X-Trace-Id`、`X-Actor`。

候选 manifest 缺的字段（`missing_from_candidate` 已列出）：

- Mastra → context-service 的认证（token/mTLS）与每用户授权；
- bundle 签名/checksum、离线镜像 digest；
- 图后端选择与凭据（Neo4j URI/user/password 的 secret ref）；
- bundle / 图 schema / provenance schema 的升级与回滚；
- 组件间 TLS / 网络策略；
- API 契约版本协商与兼容检查；
- 备份/恢复与 provenance 保留策略；
- migration 脚本（当前 `migrations: []`）。

**结论：** 候选 manifest 足以“描述”一个单客户 bundle 的拓扑，但不足以让工作台自动生成可启动产物。至少需要补上认证、图后端、迁移/升级、签名四类字段。

## 9. 对 [#8 运行时契约](https://github.com/0xnicholas/Fdesforce/issues/8) 的硬约束

1. **契约归 context-service 所有，不归 Semantica 原生 REST/MCP。** 生产路径必须是我们自己的稳定 API：`retrieve`、`record_decision`、`get_provenance`；返回稳定的 `entity_id` / `decision_id` / `provenance_id`，不能泄漏 Neo4j 内部整数 id。
2. **身份、trace、tenant 是请求的强制字段，并写入 PROV-O。** `X-Tenant-Id`、`X-Trace-Id`、`X-Actor` 缺一不可；tenant 过滤必须在服务端做；`activity_id`/`agent_id`/`metadata.tenant_id` 要能被 `get_provenance` 查回。错误 envelope 也要带 `trace_id`（422 需要归一化）。
3. **decision/provenance 写入必须显式，不能依赖 Semantica 自动接线。** 0.7.0 的 `DecisionRecorder` 自动 provenance 有已知签名不匹配（research #4）；本 spike 明确调用 `track_entity`。`verify_chain()` 必须异步/离线，不能放在读路径。
4. **图持久化不能是 JSON 全量快照。** 快照适合 spike，不适合 system of record；生产需要事务性图存储 + 稳定外部 ID 映射 + schema 迁移。若选 Neo4j，`Neo4jStore` 当前用内部 id，必须加 adapter。
5. **`ContextGraph.query()` 不能作为生产检索。** 10k 节点已 61ms p50/246ms p95，且是 O(n) 词法扫描；必须定义向量/全文索引方案（Neo4j full-text/vector、Qdrant/PgVector 或 Semantica embeddings）及其降级路径。

## 10. 对打包/部署清单的硬约束

1. **精确 pin + 镜像 digest。** Python 3.12、`semantica==0.7.0`、Mastra `1.83.0`、`@mastra/mcp 2.9.0`、AI SDK `7.0.173`；锁文件随 bundle 交付；不要漂到 0.8.0-dev。
2. **bundle 必须包含 context-service 本身。** 只装 Semantica 不够：原生 REST 没有 decision 写、没有 PROV-O、重启丢图；MCP 是独立图。context-service + 数据卷（graph + provenance）+ 健康检查（冷启动约 6s，RSS 约 200MB）是最小组件。
3. **manifest 必须有图后端、认证、迁移、升级/回滚字段。** 当前候选 manifest 的 `graph_store` 是 prototype JSON；生产要能选 Neo4j/其他 LPG，带 secret ref、迁移脚本、rollback 版本和 bundle 签名。
4. **provenance 独立存储 + 备份/保留策略。** SQLite 只适合单机 spike；bundle 清单要写明 audit store 的备份、保留期和链验证作业，不能和主图共用“全量快照”生命周期。
5. **客户环境字段要显式化。** 离线/air-gapped 私有镜像仓库、客户 TLS/SSO/密钥、CPU/内存/磁盘上限、出站网络策略；这些本次都未验证，但必须在 bundle schema 里留位。

## 11. 未验证 / 风险

- **真实 LLM 未验证**：agent 的 tool 选择是脚本化的；真实模型可能不按 `retrieve → decision → provenance` 顺序调用，或一次调用多个 tool。tool 执行和循环本身是真的。
- **多租户/授权未验证**：只有 tenant 标签过滤，没有用户身份、角色、数据权限；单客户 bundle 内仍有多用户场景。
- **Neo4j serving 未验证**：只测了核心 `Neo4jStore`，没有把 ContextGraph 的检索/决策写路径接到 Neo4j。
- **规模只到 10k/50k（进程内）**：没有通过 HTTP 服务压 100k/500k；research #4 的 100k 数据可作参考，但检索延迟不同。
- **升级/回滚、备份/恢复、air-gapped、Windows/Linux 未测。**
- **MCP `record_decision` 的 provenance 语义未审计**：MCP 没有 provenance tool，无法从协议层查回；research #4 认为自动 provenance 不可用。
- **Semantica REST import 的边类型丢失** 只确认了“输入 APPLIES_TO → 统计 related_to”，未定位到具体 import 分支；生产契约不能依赖这条导入路径。
- **Neo4j `id()` 弃用**：Neo4j 5 已给 DEPRECATION 通知，未来版本可能移除；稳定 ID 方案要避开它。

## 12. 结论

**条件通过。** 目标路径（Mastra agent → 薄 REST context-service → Semantica Python API）已经用事实跑通：真实 agent loop、tool 调用、tenant/trace/actor 透传、PROV-O 写入、重启持久化都成立。MCP 和 Semantica 原生 REST 都被证伪为生产契约；Neo4j 核心适配器可用但 serving 未接；检索和 provenance 验证都有明确的规模上限。

这解除了 #5 对 [#8 运行时契约](https://github.com/0xnicholas/Fdesforce/issues/8) 的 gate；#8 仍被 [#6 领域模型与核心抽象](https://github.com/0xnicholas/Fdesforce/issues/6) 阻塞。下一步不是继续加 spike，而是在 #8 里把上面 5 条运行时约束和 5 条打包约束落成接口/拓扑/失败语义决策；检索索引（10 万级）已提升为 [#15](https://github.com/0xnicholas/Fdesforce/issues/15)，Neo4j serving adapter 留给 #8 决定图存储后细化。

## 13. Artifacts

| 文件 | 内容 |
|---|---|
| [`artifacts/rest-run.json`](../../spikes/mastra-semantica/artifacts/rest-run.json) | REST agent 的原始步骤、tool call、最终文本 |
| [`artifacts/rest-verified.json`](../../spikes/mastra-semantica/artifacts/rest-verified.json) | 独立 HTTP 复核：decision provenance、链、health |
| [`artifacts/mcp-run.json`](../../spikes/mastra-semantica/artifacts/mcp-run.json) | MCP tool 列表、状态隔离、decision 写入 |
| [`artifacts/mcp-restart.json`](../../spikes/mastra-semantica/artifacts/mcp-restart.json) | MCP 图重启后仍为 5 节点/1 decision |
| [`artifacts/semantica-rest-import.json`](../../spikes/mastra-semantica/artifacts/semantica-rest-import.json) | 原生 REST 导入结果 |
| [`artifacts/semantica-rest-stats-after-import.json`](../../spikes/mastra-semantica/artifacts/semantica-rest-stats-after-import.json) | 导入后 2 节点/1 边，边类型 related_to |
| [`artifacts/semantica-rest-provenance.json`](../../spikes/mastra-semantica/artifacts/semantica-rest-provenance.json) | 原生 REST provenance（graph_traversal，checksum null） |
| [`artifacts/semantica-rest-stats-after-restart.json`](../../spikes/mastra-semantica/artifacts/semantica-rest-stats-after-restart.json) | 重启后 0 节点 |
| [`artifacts/http-bench.json`](../../spikes/mastra-semantica/artifacts/http-bench.json) | HTTP 延迟 |
| [`artifacts/graph-bench.json`](../../spikes/mastra-semantica/artifacts/graph-bench.json) | 10k/50k 图规模 |
| [`artifacts/neo4j-bench.json`](../../spikes/mastra-semantica/artifacts/neo4j-bench.json) | Neo4j 适配器 |
| [`artifacts/provenance-bench.json`](../../spikes/mastra-semantica/artifacts/provenance-bench.json) | verify_chain 线性成本 |
| [`artifacts/failure-modes.txt`](../../spikes/mastra-semantica/artifacts/failure-modes.txt) | 失败模式矩阵 |
| [`artifacts/startup-time.txt`](../../spikes/mastra-semantica/artifacts/startup-time.txt) | 冷启动 6.03s |
