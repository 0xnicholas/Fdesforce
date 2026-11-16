# 语义/上下文层选型决策 memo

> Ticket: [#4](https://github.com/0xnicholas/Fdesforce/issues/4) · 父地图: [#1](https://github.com/0xnicholas/Fdesforce/issues/1)
> 日期: 2026-11-14 · 分支: `research/semantic-layer`
> 结论状态: **条件式采纳（Conditional GO）**，以 ticket #5 的 spike 为 gate

## 0. TL;DR

**推荐 Semantica 作为 v0 的语义/上下文引擎，但不把 Semantica 自带的 MCP server 或 REST/Explorer 直接当作生产契约。**

具体形态是：Mastra 只调用一个自有的薄 Python `context-service`（REST/JSON）；该服务内部使用 Semantica 的 Python API 做本体、抽取、决策记录、PROV-O 溯源和图/向量检索；Neo4j 作为持久化图存储（system of record），Semantica 的 `ContextGraph` 只作为请求级/租户级的检索工作集。MCP 只保留给本地开发与 IDE 集成。

这个结论附带三个对早前判断的修正：

1. **0.8.x 在调研时并未发布。** 最新 tag/release 是 `v0.7.0`（2026-09-22）；`main` 的 `pyproject.toml` 写的是 `0.8.0`，`CHANGELOG.md` 仍是 `[Unreleased]`。生产应 pin `0.7.x` 或具体 commit，不要把 0.8.0-dev 当稳定版。[S1][S2]
2. **“MCP 仅内存”基本成立，但不精确。** 0.7.0 的 MCP 默认是进程内 `ContextGraph`，同时支持 `SEMANTICA_KG_PATH` 指向一个 JSON 文件做持久化；它仍然不是图数据库客户端，没有 Neo4j/FalkorDB 后端。`[FEATURE] graph_store (Neo4j)-backed ContextGraph for the MCP tool session`（#1663）仍是 open。[S3][S4][S5]
3. **“Neo4j 只是 feature request”也不准确。** 核心 `semantica.graph_store.Neo4jStore` 和 `GraphBuilder(graph_store=...)` 已实现；但 MCP、REST server、Explorer 三个 serving 入口都没有接上它。分支上早前初稿写的“生产走 REST/Explorer + Neo4j”不成立，需要我们自己写适配服务。本文 §3.2 给出代码级证据。[S6][S7]

一句话：**Semantica 是合适的“引擎”，不是合适的“服务器”。**

---

## 1. 决策与边界

### 1.1 决策

- 采用 **Semantica 0.7.x** 作为 v0 的语义/上下文引擎：本体生成与校验、文档/结构化数据接入、实体与关系抽取、PROV-O 溯源、决策记录、图/向量检索。
- **不采用** Semantica MCP server 作为生产运行时契约；只用于本地 IDE/调试。
- **不直接采用** Semantica REST/Explorer 作为生产 API；其图会话是内存对象，缺少持久化、租户隔离和写穿。生产由我们自有的 `context-service` 暴露稳定契约。
- 图存储使用 **Neo4j**（或客户已有/指定的 LPG 后端）；向量存储用 Qdrant/PgVector；溯源先用 SQLite/Postgres，生产建议独立审计库。
- 版本策略：pin `semantica==0.7.0`（或经验证的 0.7.x patch），锁定传递依赖；0.8.0 发布后再单独评估升级。

### 1.2 目标架构

```text
Mastra (TypeScript)
   │  REST/JSON tools (X-Tenant-Id, X-Trace-Id, X-Actor)
   ▼
context-service (Python 3.12, FastAPI)
   ├── Semantica Python API
   │     ├── ingest / parse / extract / ontology / SHACL
   │     ├── ProvenanceManager (PROV-O)
   │     └── AgentContext / DecisionRecorder (decision records)
   ├── Neo4j (entities, edges, decisions; system of record)
   ├── Qdrant / PgVector (chunks + embeddings)
   └── provenance store (SQLite now; Postgres/audit store later)

Optional: MCP stdio server only for local IDE / developer use.
Optional later: a Streamable HTTP MCP facade in front of context-service.
```

### 1.3 决策 gate（ticket #5）

在以下条件满足前，状态保持“条件式采纳”，不升级为最终架构：

1. 一个真实的 Mastra agent 通过 `context-service` 完成一次 `retrieve → answer → record_decision → get_provenance` 闭环。
2. 同一请求链上能透传 `tenant_id`、`trace_id`、`actor`，并在 PROV-O 记录里查回。
3. 目标规模（至少 10 万节点/边，最好 50 万）下，检索 P95、写入吞吐、内存占用可接受；如果不行，明确降级到 Neo4j 查询/分片策略。
4. 多租户隔离、鉴权、失败模式、重启恢复有可复现实验记录。
5. 与 Mastra 的接口契约（JSON schema、错误码、版本）通过契约测试。

如果 #5 失败，fallback 不是“继续用 Semantica MCP”，而是 **Neo4j GraphRAG + n10s + 自有 PROV-O/decision 层**（见 §8.4）。

---

## 2. 评估标准

| 类别 | 要求 | 为什么是硬要求 |
|---|---|---|
| 语义模型 | Context Graph（实体/关系/多跳）、OWL/SHACL/SKOS 治理 | FDE 交付的是客户业务语义，不是一堆 chunk；本体是跨项目复用的资产 |
| 责任链 | W3C PROV-O、决策记录、因果链、审批/政策 | 客户会问“为什么”，且受监管行业需要可审计 |
| 数据接入 | Snowflake、Databricks、SAP；文档/向量 | 决定首客能否在数周内接入，而不是先写半年 ETL |
| 运行时 | MCP/REST、图存储可换、Python 3.11–3.13 | Mastra 是 TS；跨语言契约必须稳定 |
| 工程 | MIT、成熟度、性能/规模、运维占用 | 决定 v0 是否能自托管、是否能随客户增长 |
| 集成 | 与 Mastra 的调用成本、身份/trace/provenance 透传 | 跨语言边界是主要返工来源 |

---

## 3. Semantica 事实核验

### 3.1 基本事实

| 事实 | 证据 | 判断 |
|---|---|---|
| 最新 release | `v0.7.0`，2026-09-22；`main` 的 `pyproject.toml` 为 `0.8.0`，CHANGELOG 仍 `[Unreleased]` | 生产 pin 0.7.x；0.8 未发布 [S1][S2] |
| 许可 | MIT（仓库、PyPI metadata 均为 MIT） | 商用友好 [S1][S2] |
| Python | 0.7.0: `>=3.10,<3.14`；0.8.0-dev: `>=3.11,<3.14` | 目标 3.11–3.13 满足 [S2] |
| 社区/活跃度 | 约 14.6k stars、46 registered contributors（另有约 100 个匿名提交作者）、139 open issues/PRs、2026-11-13 仍有推送 | 活跃，但仍是 0.x [S1] |
| 定位 | Context Graph + decision intelligence + provenance + ontology + connectors | 与 FDE 需求高度重合 [S1] |

### 3.2 早前两个关键判断的核验

| 早前判断 | 核验结果 | 证据 |
|---|---|---|
| “Semantica 的 MCP 是 in-memory only” | **基本成立，但不精确。** 0.7.0 MCP 默认创建进程内 `ContextGraph`；设置 `SEMANTICA_KG_PATH` 后，每次 mutation 会把整张图写回一个 JSON 文件。它没有 Neo4j/FalkorDB 后端，也没有多副本/租户模型。 | MCP 文档明确“stdio、无 HTTP/SSE、无 API key”；`session.py` 创建 `ContextGraph`；README 写明未设置路径时仅内存；`save_to_file()` 全量序列化。[S3][S4][S5] |
| “Neo4j-backed context graph 是 open feature request” | **对 MCP 会话成立；对核心 graph_store 不成立。** 核心 `Neo4jStore` 已实现，`GraphBuilder(graph_store=...)` 可写入 Neo4j；但 MCP session 没有接它，#1663 仍 open，且无 assignee/milestone。 | `semantica/graph_store/neo4j_store.py`、`graph-neo4j` extra；#1663 正文明确 “MCP tools operate on an in-memory ContextGraph … only supports single-file JSON persistence”。[S6][S7] |
| “生产走 REST/Explorer + Neo4j” | **不成立。** `semantica/server.py` 启动时 `ContextGraph()`；Explorer 的 `GraphSession` 注释明确当前是 in-memory、不连接 FalkorDB；`docker-compose.yml` 虽然起了 FalkorDB，但 Explorer 并未使用。 | 代码级证据：[server.py](https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/server.py#L65-L66)、[explorer/app.py](https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/explorer/app.py#L52-L53)、[docker-compose.yml](https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/docker-compose.yml#L25-L27) |

**结论：** 早前两种说法各对一半。正确的表述是：

> Semantica 的**核心图存储层**支持 Neo4j；但它的**MCP 会话**和**REST/Explorer 服务**仍然围绕进程内 `ContextGraph` 构建，没有把 Neo4j 接进 serving path。生产集成必须自己写适配层，或等 #1663 落地。

### 3.3 复现实验（0.7.0，Python 3.12）

在临时 venv 中安装 `semantica==0.7.0`（安装耗时约 7 秒，base venv 约 545 MB），做了以下 smoke test：

| 实验 | 命令/方法 | 结果 |
|---|---|---|
| MCP 初始化与工具列表 | `python -m semantica.mcp_server`，发送 `initialize` + `tools/list` | `serverInfo.version = 0.7.0`；15 个工具 |
| MCP 文件持久化 | `SEMANTICA_KG_PATH=/tmp/mcp-verify.json`，调用 `add_entity` | 生成 280 B JSON；重启后 `get_graph_summary` 返回 `node_count: 1` |
| ContextGraph 持久化 | 2 个实体 + 1 条 decision（自动生成 category/decision_maker 节点，共 5 节点），`save_to_file` / `load_from_file` | 2,017 B JSON；重载后节点/边/decision 计数一致 |
| PROV-O 导出 | `ProvenanceManager(storage_path=...)` + `track_entity` + `export_prov("turtle")` | 745 B Turtle，包含 `prov:` 术语 |
| 10 万节点全量保存 | `ContextGraph` 逐节点插入后 `save_to_file` | 1.15 s，14.3 MB（单次、非正式 benchmark） |
| decision precedent | 单条 decision，相同 scenario，`find_precedents` | 返回 0 条；内容相似度 0.4，结构相似度 0，combined 0.28，低于默认阈值 0.5 |

最后一项不是“bug 结论”，而是质量信号：官方文档明确 precedent 匹配是 **lexical + structural**，不是 embedding；相同 scenario 也会被 reasoning/entities 稀释，默认阈值下可能查不到。生产必须用真实决策集做评测和调参，不能把 `find_precedents` 当语义搜索。[S9]

### 3.4 能力细节

- **Context Graph**：`ContextGraph` 是线程安全的进程内属性图，节点/边/元数据都在 Python dict/list 中；文档明确“无外部服务、无数据库连接、无网络调用”。这是它快的原因，也是规模上限的原因。[S4]
- **本体治理**：`OntologyGenerator` 可从图生成 OWL；支持 SHACL shape 生成与 `pyshacl` 校验；SKOS 通过 `OntologyEngine`/triplet store 管理。边界：OWL DL 推理不在 Semantica 内，文档明确“reasoning itself runs in the external tool”；本体草稿/提案/版本流的状态在应用内存中，重启会丢失，且不跨 worker 共享。[S10][S11]
- **PROV-O**：`ProvenanceEntry` 与 PROV-O 字段一一映射，`export_prov()` 输出 RDF；SHA-256 链式校验、invalidation tombstone、agent/activity/role 都有。生产仍要决定 provenance store 的持久化与保留策略。[S8]
- **决策记录**：`record_decision()`、因果链、precedent、policy engine 都有；多级 approval chain 需要 graph database backend（Neo4j/FalkorDB），内存 `ContextGraph` 不支持 `execute_query()` 持久化。[S9]
- **连接器**：Snowflake（password/key-pair/OAuth/SSO）、Databricks（PAT/OAuth M2M、Unity Catalog/Delta、lineage）、SAP OData v2/v4（entity set；示例 Business Partners/Sales Orders）。这些都是 optional extras，需要单独安装和凭据。[S12]
- **图存储**：核心支持 Neo4j、FalkorDB、Apache AGE、Amazon Neptune；RDF 侧支持 Oxigraph、Jena、RDF4J、Blazegraph、Anzo。文档的 feature matrix 自己标注 provenance/context 在 LPG 上是 “Partial”，且各后端需要验证。[S11]
- **性能/规模**：README 的 118k 节点 benchmark 是 v0.5.0 的节点搜索/缓存/去重数字，不是端到端吞吐；benchmark harness 明确“no result table is published yet”；#1644 指出 temporal query 会 deep-copy 全图并线性扫描，100M+ facts 不可行。[S13][S14]

### 3.5 运维与服务化限制

- MCP：stdio、本地子进程、无 HTTP/SSE、无 API key；文档明确不支持远程托管。多租户只能一租户一进程/一文件，且没有请求头/身份透传。[S3]
- REST/Explorer：FastAPI + API key，但图会话是内存对象；`semantica.server` 启动时创建空 `ContextGraph`，没有加载/写穿路径；Explorer 可从 JSON 文件加载，但仍是单进程内存图，不是图数据库服务。[S23]
- 运维占用：base 安装约 545 MB；REST 需要 `[explorer]`（FastAPI/uvicorn），SHACL 需要 `[shacl]`，Neo4j 需要 `[graph-neo4j]`，Snowflake/Databricks/SAP 各需对应 extras；生产镜像会明显大于 base。官方 Dockerfile 用 Python 3.13 + `[explorer]` extras，构建时还带 Node 前端。[S2][S15]

### 3.6 三个实现级事实（会直接影响 v0 的承诺）

这不是“产品取舍”，而是 0.7.0/main 当前代码里的事实，必须在设计里绕开或修掉。

**（1）决策记录不会自动产生 PROV-O。** `DecisionRecorder._track_decision_provenance()` 调用 `ProvenanceManager.track_entity(... source_documents=...)`，但真实签名要求的是 `source`；它随后调用的 `ProvenanceManager.track_activity()` 在类上不存在。异常被 `except Exception` 吞掉，只打一条 “Failed to track provenance”，决策仍然写入，但 provenance store 里是 0 条。实测报错：`track_entity() missing 1 required positional argument: 'source'`。单元测试用的是 `MagicMock`，只断言 `track_activity` 被调用，因此没有发现真实 API 不匹配。[S24][S25]

**（2）OWL 一致性/可满足性校验是 placeholder。** `OntologyValidator.validate()` 的 `check_consistency` / `check_satisfiability` 分支是 `pass`，代码注释直接写 “Placeholder implementation for now”；它只做 classes/properties 的结构检查。SHACL 校验（pyshacl）是真实的，但 OWL DL 推理/一致性不在 Semantica 内。[S26]

**（3）MCP/REST 接口不对称（0.7.0）。** MCP 15 tools 里没有 ontology/SHACL，也没有 `get_provenance`（main/0.8 才在 `export.py` 注册）；REST 79 路由里有 ontology/provenance，但 **没有专用 decision 写端点**（`/api/decisions` 只有 GET），决策写入只能走 MCP/Python，或通过 `/api/import` 间接写入。Mastra 无论选哪一边，都缺一半能力；这正是需要自有 `context-service` 的直接原因。[S27]

### 3.7 补充压测（100k 节点/500k 边）

`ContextGraph(advanced_analytics=False)`，Intel i7-7700HQ/16GB/Python 3.12，单机非正式 benchmark：

| 场景 | 结果 |
|---|---|
| 100k 节点 + 500k 边 | 建图 31.06s；RSS 539.7MB |
| `save_to_file` / `load_from_file` | 8.21s / 137.1MB；加载 35.35s |
| 1000 次 2-hop `get_neighbors` | 0.079s（约 79µs/次） |
| 2000 条 `record_decision`（10k 节点图） | 0.47s（约 0.24ms/条） |

含义：10 万/50 万规模在单机可跑，但持久化是瓶颈、建图是批处理级别；百万节点/边会到 GB 级内存和分钟级加载，必须换 Neo4j 或分片。这个数字与 §3.3 的 10 万节点保存测试（1.15s/14.3MB）不矛盾：边密度和 JSON 体积不同。

---

## 4. 对比表

图例：● 一等公民、可直接用；◐ 部分支持/需要额外工作；○ 不是核心能力；n/a 不适用。

| 维度 | Semantica | Cube / dbt semantic layer | LlamaIndex / LangChain GraphRAG | Neo4j 自建 | 商业 KG（Stardog / GraphDB） |
|---|---|---|---|---|---|
| Context Graph | ● `ContextGraph`，但进程内 | ○ 指标/实体图，不是上下文图 | ● `PropertyGraphIndex` | ● 属性图 | ● RDF/OWL 图 |
| OWL / SHACL / SKOS | ◐ 生成/校验/导出；OWL 推理外置；SKOS 管理 | ○ | ○ 只有 Pydantic/抽取 schema | ◐ n10s：RDF/SHACL/OWL/SKOS 导入，partial inference；Labs 实验项目 | ● Stardog SHACL/OWL；GraphDB OWL 2 RL/QL |
| PROV-O 溯源 | ● 字段映射 + `export_prov` | ○ | ○ | ◐ 需在 RDF/named graph 上自建 | ◐ RDF named graph 可承载，需自建 PROV-O |
| 决策记录 | ● decision node/因果/policy；approval chain 需 graph backend | ○ | ○ | ○ 需自建 | ○ 需自建 |
| 结构化连接器 | ● Snowflake / Databricks / SAP OData | ● 仓库 SQL；SAP 非一等 | ◐ loader/integration，需自建 | ◐ ETL/APOC，需自建 | ● 广；Stardog 虚拟图 |
| 文档/向量接入 | ● parser/chunker/vector store，需 extras | ○ | ● 强 | ◐ GraphRAG/loader，需自建 | ◐ 文档/NLP 能力因产品而异 |
| MCP / REST | ◐ MCP stdio 15 tools（无 ontology/provenance）；REST 79 路由（有 ontology/provenance，无 decision 写） | ● Cube MCP/REST/GraphQL/SQL | ◐ 有 MCP/库集成；context API 自建 | ◐ Bolt/HTTP；MCP 自建 | ◐ REST/SPARQL；MCP 自建 |
| 图存储选择 | ● 核心适配器多；serving 未接 | ○ 只有 SQL 仓库 | ● Neo4j/Nebula/FalkorDB/TiDB | ● Neo4j | ○ 厂商存储 |
| Python 3.11–3.13 | ● 0.7: 3.10–3.13；0.8-dev: 3.11–3.13 | n/a（Node/Rust + dbt Python） | ● | ● graphrag 3.10–3.14 | n/a（REST/SPARQL） |
| 许可 | ● MIT | ◐ Cube Apache-2.0/MIT；dbt Apache-2.0 + 付费 SL | ● MIT | ◐ Neo4j GPL-3.0/商业；n10s/GraphRAG Apache-2.0 | ○ 专有 |
| 成熟度 | ◐ 0.7.0、0.x、139 open | ● 成熟 | ● 成熟库 | ● 数据库成熟；自建层新 | ● 成熟 |
| 规模/性能 | ◐ 100k/500k 边：31s 建图、540MB、35s 加载；1M+ 未证 | ● 仓库规模 | ● 取决于存储 | ● 强 | ● 很强（Stardog 宣称 100B points/1T triples） |
| 运维占用 | ◐ Python + 图/向量/溯源存储；base ~545 MB | ◐ 服务 + Cube Store/仓库 | ◐ 库 + 存储 | ◐ Neo4j 集群 | ○ 企业平台 |
| 与 Mastra 集成 | ◐ 需薄 REST 服务；MCP 仅 stdio | ● HTTP/MCP，但只答指标 | ◐ TS 库/自建 | ◐ Bolt/HTTP/自建 | ◐ REST/SPARQL/自建 |
| 对 v0 的适配 | ● 条件式首选 | ○ 互补，不是替代 | ◐ 可控但工程量大 | ◐ 长期备选/降级 | ◐ 受监管客户 fallback |

来源：Semantica [S1]–[S15]、[S23]–[S27]；Cube [S16]；dbt [S17]；LlamaIndex/LangChain [S18][S19]；Neo4j/n10s/GraphRAG [S20]；Stardog/GraphDB [S21]；Mastra [S22]。

---

## 5. 推荐方案

### 5.1 为什么不是“直接用 Semantica 的 MCP/REST”

| 方案 | 能否工作 | 生产问题 |
|---|---|---|
| Mastra `MCPClient` 启动 `python -m semantica.mcp_server` | 本地可以；Mastra 支持 stdio server 的 `command/args` | 每租户一个 Python 进程/JSON 文件；无远程 HTTP；无 API key/请求头；每次 mutation 全量重写 JSON；进程生命周期、并发、隔离、可观测性都要自建 |
| Mastra 调 `semantica-server` REST | 技术上是 FastAPI | 启动即空 `ContextGraph`，没有加载/写穿；无租户；只有 API key；重启丢状态；不能承载生产图 |
| Mastra 调自有 `context-service` | 推荐 | 需要写服务，但契约、租户、鉴权、持久化、trace 都在我们控制内 |

Mastra 本身支持 stdio 和 Streamable HTTP MCP，也支持 custom tools；所以“Mastra 能不能连”不是问题，“连的是不是一个可运维的生产图服务”才是问题。[S22]

### 5.2 `context-service` 契约（建议草案）

```http
POST /v1/context/retrieve
Headers: X-Tenant-Id, X-Trace-Id, X-Actor
Body: { "query": "...", "scope": {...}, "max_hops": 2, "include_provenance": true }
→ { "items": [{ "content": "...", "score": 0.82, "entity_ids": [...],
                "provenance_ids": [...], "citations": [...] }],
    "trace_id": "..." }

POST /v1/decisions
Body: { "category": "...", "scenario": "...", "reasoning": "...",
        "outcome": "...", "confidence": 0.9, "evidence_ids": [...],
        "decision_maker": "...", "metadata": {...} }
→ { "decision_id": "...", "provenance_id": "...", "trace_id": "..." }

GET /v1/provenance/{entity_id}
→ PROV-O JSON/Turtle + source citations + chain verification

POST /v1/ontology/validate
Body: { "shapes": "...", "data": "..." }
→ { "conforms": true/false, "violations": [...] }
```

设计要点：

- **租户**：每个租户独立 Neo4j database/schema 或独立图；`context-service` 强制注入 tenant，不接受客户端任意图名。
- **trace/provenance**：请求头写入 `activity_id`/`agent_id`/`metadata`；返回 `provenance_id`，Mastra 把它放进 agent trace。
- **写路径**：决策/实体写入先落 Neo4j，再更新检索工作集；失败要回滚或标记，不能只写内存。
- **读路径**：优先 Neo4j/Cypher 做结构化/多跳；`ContextGraph` 只加载本次查询所需的子图（注意：`GraphBuilder.load_from_neo4j()` 是整图加载，按查询子图需要自写 Cypher/loader）；大规模租户可退化为 Neo4j GraphRAG 检索。
- **本体**：OWL/SHACL/SKOS 文件进 Git（可评审、可版本化）；发布到图/RDF store；不要依赖 Explorer 的内存 proposal/version 状态。
- **溯源**：PROV-O 导出到对象存储/审计库；SQLite 只适合单租户 v0；生产用 Postgres 或专门审计存储。

### 5.3 与 Semantica 的具体接法

1. **入库/建图**：`GraphBuilder(graph_store=Neo4jStore(...))` 或 `GraphStore(backend="neo4j")` 把实体/关系写入 Neo4j；文档/结构化数据走 `SnowflakeIngestor`/`DatabricksIngestor`/`SAPIngestor` → parse/extract → GraphBuilder。[S6][S12]
2. **决策**：`AgentContext(vector_store=..., knowledge_graph=Neo4jStore(...), decision_tracking=True)` 会自动把带 `execute_query` 的对象当 `graph_store` decision backend，使用 `DecisionRecorder`/`DecisionQuery`/`CausalChainAnalyzer`/`PolicyEngine`。这条路径比 MCP 的 ContextGraph-only 决策工具更接近生产。[S6]
3. **检索**：`ContextRetriever`/`AgentContext` 可接受 graph_store 对象；但图扩展依赖 `get_neighbors` 等能力，必须用目标后端做 spike，不能假设与内存 `ContextGraph` 等价。[S6]
4. **溯源**：`ProvenanceManager` 独立于图存储；在每个 ingest/decision 路径显式调用 `track_entity`/`track_relationship`，并在 API 返回 provenance id。不要依赖 `DecisionRecorder` 的自动接线（见 §3.6）。[S8][S24]
5. **本体**：`OntologyGenerator` + `SHACLGenerator` + `run_shacl_validation` 作为 CI/发布 gate；OWL 推理如需要，外接 HermiT/Pellet/ELK 或商业 reasoner。[S10][S11]

### 5.4 版本与升级策略

- pin `semantica==0.7.0`；用 lockfile 固定 `numpy/scipy/scikit-learn/pyarrow` 等传递依赖。
- 所有对 Semantica 的调用集中在 `semantica_adapter.py`，不把其类型泄漏到 Mastra 契约或 Spec。
- 契约测试覆盖：MCP 工具列表（如果保留 dev 集成）、`record_decision`、`export_prov`、`find_precedents`、SHACL 校验、Neo4j 写入/读取。
- 0.8.0 发布后先跑同一套契约 + 规模测试，再决定升级；不要跟 `main`。

---

## 6. 关键理由（5 条）

1. **能力覆盖最完整，且是 MIT。** 在候选里，只有 Semantica 同时提供 Context Graph、OWL/SHACL/SKOS、PROV-O、决策记录、Snowflake/Databricks/SAP 连接器和可自托管图/向量存储；Cube/dbt 是指标层，LlamaIndex/LangChain 是检索/编排库，Neo4j/商业 KG 需要自己补责任链。对 FDE 工作台，这正好是“企业语义与上下文”那一半。[S1][S16]–[S21]
2. **它的差异化能力是代码级真实存在的，不只是营销。** 我们实际跑通了 `ContextGraph` + `ProvenanceManager.export_prov` + MCP 15 tools + JSON 持久化；PROV-O 字段映射、decision/causal/policy、SHACL/pyshacl、连接器都有明确实现（但 decision→PROV-O 的自动接线有 bug，见 §3.6）。相比之下，Cube/dbt 的“semantic”是 metrics/joins，LlamaIndex 的 graph 是索引结构，都不覆盖“为什么/谁批准/来源链”。[S8]–[S12]
3. **替代方案是品类不匹配，不是功能强弱。** Cube/dbt 解决“指标口径一致”；LlamaIndex/LangChain 解决“文档检索/编排”；Neo4j/商业 KG 解决“图存储/本体推理”。用它们替代 Semantica，等于把本体治理、PROV-O、决策记录、连接器全部自建——这正是工作台最不该重复造的部分。[S16]–[S21]
4. **Semantica 的 serving 缺口是可隔离的，不是引擎缺陷。** MCP 是 stdio/本地/内存；REST/Explorer 是内存图；#1663 未落地。这些都可以通过“薄 Python 服务 + Neo4j system of record”绕开，成本可控；而引擎能力（本体/溯源/决策/连接器）换任何方案都要重写。[S3]–[S7]
5. **决策可逆、失败可降级。** MIT + 可换图存储 + 自有契约意味着：如果 #5 失败，可以保留 Neo4j 数据模型，替换检索/决策实现为 Neo4j GraphRAG + n10s + 自有 PROV-O 层；不会把数据锁死在 Semantica 的私有格式里。pin 0.7.x 也避免被 0.8-dev 的 breaking change 拖住。[S1][S20]

---

## 7. 风险与缓解

| 风险 | 概率/影响 | 缓解 |
|---|---|---|
| 0.x API 变化、0.8 未发布、breaking change | 高/中 | pin 0.7.x + lockfile；适配器隔离；契约测试；升级前跑规模/回归；必要时 fork（MIT） |
| ContextGraph 规模/性能不达标 | 高/高 | Neo4j 做 system of record；`ContextGraph` 只做请求级子图；10 万/50 万节点压测；超过阈值改用 Neo4j/Cypher/GraphRAG |
| MCP 被误当生产 API | 中/高 | 明确 MCP = 本地 IDE；生产只暴露 `context-service`；CI 禁止 Mastra 直连 MCP |
| REST/Explorer 内存图导致数据丢失 | 高/高 | 不直接用 `semantica-server`；自有服务写穿 Neo4j；重启/故障演练 |
| 决策→PROV-O 自动接线 broken（0.7.0/main） | 高/高 | 在 `context-service` 显式调用 `track_entity`/`track_relationship`；不要依赖 `DecisionRecorder`；修 upstream/本地 patch；用真实 `ProvenanceManager` 做集成测试 |
| OWL 一致性/可满足性校验是 placeholder | 中/高 | 不承诺 OWL DL；本体/SHACL 进 Git；外部 reasoner（HermiT/Pellet/Stardog）做形式化校验；SHACL 用 pyshacl |
| 多租户/鉴权缺失 | 高/高 | 网关注入 tenant；每租户独立图/库；API key→OIDC；审计日志；写工具审批 |
| 本体治理状态在内存、重启丢失 | 中/中 | OWL/SHACL/SKOS 进 Git；版本/审批记录落库；不依赖 Explorer proposal 状态 |
| decision precedent 质量 | 中/高 | 真实决策集评测；调阈值/改相似度；必要时用 embedding + LLM rerank；不要把 lexical 当语义搜索 |
| 抽取/本体生成质量 | 中/高 | golden set + 人工审核；schema-guided extraction；领域模板；置信度阈值 |
| 运维复杂、镜像大 | 中/中 | 只装需要的 extras；分离 ingestion worker 与 serving；容器化、健康检查、容量规划 |
| 许可/合规 | 中/高 | MIT 核心；Neo4j Community GPL-3.0 或商业授权需法务确认；连接器/嵌入模型各自许可；数据驻留 |
| 项目健康/支持 | 中/中 | 146 contributors、活跃；但无 1.0/SLA；关键路径准备 fork/替换计划；监控 release |
| 跨语言契约/身份透传 | 中/高 | JSON schema + 版本化；`X-Tenant-Id`/`X-Trace-Id`/`X-Actor`；契约测试；trace 贯通 |

---

## 8. 被淘汰方案

### 8.1 Cube / dbt semantic layer

- **定位**：指标/维度语义层，解决“同一个 revenue 口径”；Cube 的模型是 cubes/views/metrics，dbt 的是 semantic models/metrics。[S16][S17]
- **不满足**：Context Graph（实体/关系/多跳）、OWL/SHACL/SKOS、PROV-O、决策记录；它们不是“为什么/谁批准/来源链”的层。
- **结论**：不作为主语义层。若 v0 需要“受治理的指标问答”，可作为**互补**的 metrics sidecar；不要让 Cube/dbt 承担 context/decision。
- **许可/成本**：Cube Core Apache-2.0/MIT；dbt Semantic Layer 需要 dbt Starter/Enterprise 付费层。[S16][S17]

### 8.2 LlamaIndex / LangChain GraphRAG

- **定位**：文档处理、索引、GraphRAG 检索/编排库；LlamaIndex `PropertyGraphIndex` 支持 Neo4j/Nebula/FalkorDB/TiDB 等。[S18][S19]
- **不满足**：OWL/SHACL/SKOS 治理、PROV-O、决策记录、企业连接器；这些要自己搭。
- **结论**：如果团队想完全自控、且愿意自建责任链，可作为备选；对 v0 工程量大，不作为首选。它们可以作为 Semantica pipeline 内部的抽取/检索组件，但不要成为契约。

### 8.3 Neo4j 自建

- **强项**：成熟、Cypher、生态、规模；`neo4j-graphrag` 提供 GraphRAG（Apache-2.0，Python 3.10–3.14）；n10s 可导入 RDF/OWL/RDFS/SKOS 并做 SHACL 校验。[S20]
- **问题**：n10s 是 Neo4j Labs 实验项目（非 supported product），推理只是 partial；PROV-O、decision records、Snowflake/Databricks/SAP 连接器、MCP/REST 都要自建；Neo4j Community 是 GPL-3.0，企业版/Aura 商业授权。[S20]
- **结论**：不作为 v0 主方案；作为**存储底座**和**降级方案**保留。若 #5 失败，这是第一 fallback。

### 8.4 商业 KG 平台（Stardog / GraphDB 等）

- **强项**：成熟的 OWL/SHACL/SPARQL、推理、规模和企业支持；Stardog 宣称 100B data points/1T triples，GraphDB 支持 OWL 2 RL/QL。[S21]
- **问题**：专有许可、采购周期、按客户/环境成本；没有打包的 agent decision-record/PROV-O 工作流，仍要自建；MCP/Mastra 集成也要自建。Stardog Free 不是开源，且缺 HA/备份/LDAP/完整连接器；Enterprise 需询价。[S21]
- **结论**：v0 不选。若客户已拥有 Stardog/GraphDB，或合规要求厂商 SLA/认证，可作为该客户的部署选项，Semantica 的语义模型/契约仍可复用。

### 8.5 Semantica MCP 作为生产契约

- **问题**：stdio/本地、无 HTTP/SSE、无 API key、无请求头、每租户一进程/一 JSON 文件、全量重写；#1663 未落地。[S3]–[S7]
- **结论**：只用于本地 IDE/开发者体验；生产用 `context-service`。这是本 memo 最重要的“不要做”的一条。

### 8.6 纯向量 RAG

- **问题**：无实体/关系/本体/决策/溯源，无法回答“为什么”和“谁批准”；对 FDE 交付的审计要求不成立。
- **结论**：淘汰；仅作为 `context-service` 内部的一个召回通道。

---

## 9. 未验证/待决问题

- **未跑真实 Mastra ↔ Semantica 集成**：本文只做了 Semantica 本体的 smoke test；Mastra 侧调用、身份/trace 透传、延迟/失败模式由 ticket #5 验证。
- **未接真实 Snowflake/Databricks/SAP**：只核对了代码/文档，没有客户凭据；连接器的分页、schema 映射、SAP OData 覆盖范围需在首客场景验证。
- **未做 Neo4j 生产验证**：核心 `Neo4jStore` 存在，但 `ContextRetriever` 对 graph_store 的图扩展能力、decision backend 的写入一致性需要 spike；#1663 只覆盖 MCP。
- **未做 1M+ 节点压测**：只有 10 万节点（以及 10 万/50 万边）测试；#1644 明确 100M+ temporal 查询不可行。FDE 的规模上限应由 #5 给出。
- **decision→PROV-O 的接线缺陷**：已在 0.7.0/main 的代码与运行中复现；#5 必须决定是修 upstream、在 `context-service` 里显式 track，还是暂时只保证 `ProvenanceManager` 独立可用。**不要**把“决策记录=自动 PROV-O”写进产品承诺。
- **OWL 一致性校验**：`OntologyValidator` 是 placeholder；如果客户要求 OWL DL 保证，#5 需要外接 reasoner 并定义交付物，不能依赖 Semantica 的 `validate()`。
- **0.8.0 发布状态**：没有 v0.8.0 tag/release；无法验证 0.8 的实际行为。本文按 0.7.0 评估。
- **商业平台价格**：Stardog/GraphDB Enterprise 均为询价，无法做 TCO 对比；表中只评能力/许可形态。
- **法务**：Neo4j Community GPL-3.0 的分发/部署边界、商业版授权、第三方连接器/嵌入模型许可，需要法务确认；本文不是法律意见。

---

## 10. 来源

所有链接在 2026-11-14 访问。Semantica 代码/文档链接固定在 commit `1e14db0af8d78890b9a1513b49bef264cbb59e9b`（`main`，2026-11-13），避免 main 漂移。

- **[S1]** Semantica GitHub repo / releases: <https://github.com/semantica-agi/semantica> · <https://github.com/semantica-agi/semantica/releases/tag/v0.7.0>
- **[S2]** `pyproject.toml`（0.8.0、MIT、requires-python、extras）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/pyproject.toml#L7-L26> · extras `#L127-L142`、`#L173-L178`
- **[S3]** MCP 文档（stdio、无 HTTP/SSE、内存/JSON、remote 限制）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/docs/guides/mcp-server.md#L32> · `#L64` · `#L316`
- **[S4]** MCP session 代码（`ContextGraph`）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica_mcp/mcp/session.py#L4-L6> · `#L61-L65`
- **[S5]** MCP README（`SEMANTICA_KG_PATH` 仅文件）+ 全量保存代码: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica_mcp/mcp/README.md#L255> · <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica_mcp/mcp/tools/graph.py#L30-L60> · <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/context/context_graph.py#L1383-L1445>
- **[S6]** `Neo4jStore` / `GraphBuilder(graph_store=...)` / `AgentContext` graph_store decision backend: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/graph_store/neo4j_store.py> · <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/kg/graph_builder.py#L1031-L1062> · <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/context/agent_context.py#L240-L275>
- **[S7]** Issue #1663（MCP 接 graph_store 的 open feature request）: <https://github.com/semantica-agi/semantica/issues/1663>
- **[S8]** PROV-O 文档（字段映射、export）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/docs/guides/provenance.md#L627-L657>
- **[S9]** Decision Intelligence 文档（lexical precedent、approval chain 限制）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/docs/guides/decision-intelligence.md#L159> · `#L312`
- **[S10]** Ontology 文档（OWL 推理外置、proposal 状态内存）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/docs/guides/ontology.md#L26> · `#L320` · `#L406`
- **[S11]** SHACL 文档: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/docs/guides/shacl-validation.md#L1-L11> · Storage backends: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/docs/storage-backends.md#L20-L42>
- **[S12]** Snowflake / Databricks / SAP 连接器: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/docs/integrations/snowflake.md#L1-L18> · <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/docs/integrations/databricks.md#L1-L18> · <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/ingest/sap_ingestor.py#L299-L312>
- **[S13]** README 性能段: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/README.md#L1176-L1187>
- **[S14]** Benchmarks README（无结果表）+ issue #1644（100M+ temporal 限制）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/benchmarks/README.md#L7-L9> · <https://github.com/semantica-agi/semantica/issues/1644>
- **[S15]** Dockerfile（Python 3.13、explorer extras）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/Dockerfile#L26> · `#L95-L126`
- **[S16]** Cube semantic layer / license: <https://cube.dev/docs/product/introduction> · <https://github.com/cube-js/cube/blob/master/LICENSE>
- **[S17]** dbt Semantic Layer / MetricFlow: <https://docs.getdbt.com/docs/use-dbt-semantic-layer/dbt-semantic-layer> · <https://docs.getdbt.com/docs/build/about-metricflow>
- **[S18]** LlamaIndex PropertyGraphIndex / license: <https://docs.llamaindex.ai/en/stable/module_guides/indexing/lpg_index_guide/> · <https://github.com/run-llama/llama_index>
- **[S19]** LangChain repo/license: <https://github.com/langchain-ai/langchain>
- **[S20]** Neo4j / n10s / GraphRAG: <https://github.com/neo4j/neo4j> · <https://neo4j.com/pricing/> · <https://github.com/neo4j-labs/neosemantics> · <https://github.com/neo4j/neo4j-graphrag-python>
- **[S21]** Stardog / GraphDB: <https://www.stardog.com/platform/> · <https://www.stardog.com/pricing/> · <https://graphwise.ai/components/graphdb/>
- **[S22]** Mastra MCP docs（stdio + Streamable HTTP、MCPClient）: <https://mastra.ai/docs/mcp/overview>
- **[S23]** Semantica REST/Explorer serving path（启动即内存图、无 FalkorDB 连接）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/server.py#L65-L66> · <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/explorer/app.py#L52-L53> · <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/docs/explorer-setup.md#L63-L89>
- **[S24]** `DecisionRecorder._track_decision_provenance()`（错误调用 `track_entity(source_documents=...)` 与不存在的 `track_activity`）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/context/decision_recorder.py#L709-L740>
- **[S25]** decision provenance 单测（MagicMock，未覆盖真实 API 不匹配）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/tests/context/test_decision_recorder.py#L405-L416>
- **[S26]** `OntologyValidator.validate()`（consistency/satisfiability 为 `pass`，代码注明 placeholder）: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/ontology/ontology_validator.py#L326-L361>
- **[S27]** 0.7.0 接口实测：MCP 15 tools（无 ontology/provenance）、REST 79 路由（无 `POST /api/decisions`）；main 的 `get_provenance`/`RETRIEVAL_TOOLS` 未发布: <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica_mcp/mcp/tools/__init__.py> · <https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/semantica/explorer/routes/decisions.py#L31-L53>

---

## 附录 A：复现实验命令

```bash
# 1. 临时环境（Python 3.12）
uv venv --python 3.12 /tmp/sem-venv
uv pip install --python /tmp/sem-venv/bin/python 'semantica==0.7.0'

# 2. MCP initialize / tools/list / add_entity
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_entity","arguments":{"id":"test-node","label":"Test Node","type":"Entity"}}}' \
  | SEMANTICA_KG_PATH=/tmp/mcp-verify.json /tmp/sem-venv/bin/python -m semantica.mcp_server

# 3. 重启后读取
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_graph_summary","arguments":{}}}' \
  | SEMANTICA_KG_PATH=/tmp/mcp-verify.json /tmp/sem-venv/bin/python -m semantica.mcp_server

# 4. 10 万节点保存（非正式 benchmark）
/tmp/sem-venv/bin/python - <<'PY'
import time, os, tempfile
from semantica.context import ContextGraph
g = ContextGraph()
for i in range(100_000):
    g.add_node(f"n{i}", "Entity", f"node {i}", idx=i)
p = tempfile.mktemp(suffix=".json")
t = time.perf_counter(); g.save_to_file(p); dt = time.perf_counter() - t
print(dt, os.path.getsize(p))
PY
```

> 说明：以上为单机、单次 smoke test，不是容量规划依据；正式数字由 ticket #5 在目标硬件/数据上产出。
