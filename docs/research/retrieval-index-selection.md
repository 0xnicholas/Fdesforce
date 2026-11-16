# 生产检索索引与 100k+ 规模上限：决策 memo

> Ticket: [#15](https://github.com/0xnicholas/Fdesforce/issues/15) · 父地图: [#1](https://github.com/0xnicholas/Fdesforce/issues/1)
> 日期: 2026-11-15 · 分支: `research/retrieval-index`
> 结论状态: **条件式采纳（Conditional GO）**。默认生产后端选 **PostgreSQL 17 + pgvector + 全文本 GIN + adjacency/recursive CTE**；Neo4j 仅作为客户已有/接受 GPL 的 fallback。100k 的 hybrid end-to-end p95 已实测：Postgres 56.9ms、Neo4j 37.6ms、Qdrant+Neo4j 31.8ms；500k 三方案也已实测：Postgres 35.6ms、Qdrant+Neo4j 47.8ms、Neo4j 92.6ms（Neo4j 2GB heap 会 OOM，需 3GB）。全部低于 300ms，详见 §2.5/§2.6 与 §9。

## 0. TL;DR

**默认生产方案是 PostgreSQL + pgvector，不是 Neo4j，也不是 Qdrant。**

具体形态：

- 一个 PostgreSQL 17 实例同时承担图结构（`entities` / `edges` 表或 adjacency）、全文本索引（`tsvector` + GIN）和向量索引（pgvector HNSW）。
- `context-service` 自己实现 `GraphStore` 端口，批量写入、稳定 `entity_id`、按 tenant 过滤；Semantica 继续做 ingest / ontology / provenance，**不把 `ContextGraph.query()` 或 `Neo4jStore` 当生产检索层**。
- 1–2 跳扩展用 recursive CTE；如果后续需要 Cypher 兼容，再评估 Apache AGE，不把它作为 v0 依赖。
- Neo4j 5.26 Community 的 full-text + vector + Cypher 在技术上更贴图，但 Community 是 GPL-3.0；默认 bundle 不承担这个分发风险。客户已有 Neo4j 或接受商业许可时，Neo4j 是首选替代。
- Qdrant 作为第二存储只增加运维和一致性问题；只有在 pgvector 的向量召回/延迟成为瓶颈时，才作为可选 sidecar。
- v0 的 embedded 后端保持 10k/50k 上限；超过就返回 `degraded=true, reason=scale_limit`，不静默变慢。

**已验证 / 未验证：** 100k 的 Postgres、Neo4j、Qdrant retrieval p50/p95/recall 已实测（§2.5），三者 hybrid end-to-end p95 均低于 300ms。500k 的 Postgres、Qdrant+Neo4j、Neo4j 也均已完成（§2.6/§9）；Neo4j 在 2GB heap 下 bulk load OOM、3GB 后完成。Embedding 使用 512d potion 作为索引对比的代理，bge-small 的生产 recall 仍需在实施 gate 重跑。**在把 Postgres 写进生产承诺前，仍需用生产 embedding 在 100k/500k 复跑 §9 的 performance gate。**

## 1. 决策与边界

### 1.1 决策

| # | 决策 | 结论 |
|---|---|---|
| D1 | 默认生产图/索引存储 | PostgreSQL 17 + pgvector + `tsvector` GIN + adjacency/recursive CTE；一个存储，许可为 PostgreSQL/pgvector |
| D2 | Neo4j 的定位 | 客户已有 Neo4j、接受 GPL-3.0 或购买商业许可时的 fallback；不是默认 bundle |
| D3 | Qdrant 的定位 | 不作为默认；仅当 pgvector 向量召回/延迟不达标时，作为可选 vector sidecar |
| D4 | v0 embedded | 保持 10k 节点 / 50k 边交互上限；生产不再使用 JSON 全量快照作为 system of record |
| D5 | Semantica 的定位 | 语义/图/抽取/PROV-O 引擎；检索索引由 `context-service` 拥有，不依赖 `ContextGraph.query()` 或 `Neo4jStore` serving |
| D6 | 契约 | `/v1/context/retrieve` 请求/响应不变；`GraphStore` 是内部端口；`runtime-info.backend.graph` 需要 additive 增加 `postgres` |
| D7 | 性能 gate | 生产发布前必须在 100k/500k 上验证 hybrid p95 < 300ms 与 recall；未通过则切 Neo4j（许可允许时）或加 Qdrant |

### 1.2 与 #8 / #14 的关系

- #8 已决定 v0 用 embedded 图、单写者、10k/50k；生产图存储/索引留给本票。本 memo 给 #8 的答案是：**默认 Postgres+pgvector；Neo4j 作为客户许可 fallback；`GraphStore` 端口和 `/v1/context/retrieve` 不变。**
- #14 已给出许可结论：Semantica MIT 可完全用；Neo4j Community GPL-3.0，客户 bundle 建议用 Apache AGE/Oxigraph 替代。本 memo 尊重这个结论：不把 Neo4j 放进默认 bundle；Postgres+pgvector 是许可更干净的等价选择。
- 本 memo **不是**说 Neo4j 性能差；它只是不适合作为默认分发形态。若客户已有 Neo4j，它仍是技术首选。

## 2. 已核验事实

### 2.1 Semantica 0.7.0 的能力边界

Semantica 0.7.0（PyPI，MIT）是合适的语义引擎，但不是生产检索/图服务。以下为本地安装源码核验：

| 事实 | 证据 | 影响 |
|---|---|---|
| `ContextGraph.query()` 是 O(n) 线性扫描 | `context/context_graph.py` 1099–1138：遍历 `self.nodes.values()`，对 `content` 做 `any(word in content_lower)`，按词重叠打分 | 10k 已接近 300ms；100k 不可交互。不能作为生产检索 |
| `ContextGraph` 没有倒排/向量索引 | 同上；只持 Python dict/list | 必须把检索下推到数据库 |
| `Neo4jStore` 写入是逐条事务 | `graph_store/neo4j_store.py` 346–398、621–690；`create_relationship` 用 `MATCH (a),(b) WHERE id(a)=...` | 实测 44.8 节点/s、64.8 关系/s；100k 外推约 37 分钟。生产必须 bulk `UNWIND`，不能直接用适配器灌数据 |
| `Neo4jStore` 用 Neo4j 内部整数 ID | `create_node` 返回 `id: int`，`entity_id` 只是 property；`create_relationship` 只接受内部 int | 不能把内部 ID 暴露给 Context API；必须维护 `entity_id` 唯一映射 |
| `Neo4jStore.create_index()` 没有 vector 分支 | `graph_store/neo4j_store.py` 982–1025：只有 `fulltext` 和 btree/range | 向量索引必须由 `context-service` 自己执行 DDL；适配器不能代劳 |
| `get_neighbors` 只接受内部 int | `graph_store/neo4j_store.py` 860–912；传 `entity_id` 不会报错但匹配不到 | 静默空结果比报错更危险；适配器必须显式解析 |
| `VectorStore` 支持多后端 | `vector_store/vector_store.py` 114：`faiss`、`weaviate`、`qdrant`、`milvus`、`pinecone`、`pgvector`、`inmemory`、`sqlite` | 库层面能力存在，但不等于 `ContextGraph` 检索会使用它 |
| `search_hybrid` 不是 lexical+graph | `vector_store/vector_store.py` 1594–1615：先按 metadata 过滤，再做向量相似度 | 不能把 Semantica 的 “hybrid” 当作 BM25 + 图扩展 |
| `HybridSearch` 是 vector + metadata | `vector_store/hybrid_search.py` 250–300 | 同上；需自建 lexical/vector/graph 融合 |
| embeddings 支持多种 provider | `embeddings/embedding_generator.py` 81：sentence-transformers、OpenAI、BGE、FastEmbed | 可作为 ingest 侧 embedding 参数；生产模型/维度是实施参数，不是本票的索引决策 |
| 图与向量没有统一 serving 适配 | `Neo4jStore` 是存储客户端；MCP/REST 仍是 `ContextGraph` | 生产必须自有 `context-service` + 自有 `GraphStore` 实现（与 #5/#14 结论一致） |

### 2.2 Neo4jStore 适配器实测（100k/500k 探针）

来源：[`research/retrieval-index/results/semantica_neo4j_adapter_probe.json`](../../research/retrieval-index/results/semantica_neo4j_adapter_probe.json)；运行环境 macOS 13.7.8 / i7-7700HQ / 16GB，Docker VM 8GB，Neo4j 5.26.0-community。

| 操作 | 结果 | 含义 |
|---|---|---|
| 顺序 `create_node` × 500 | 11.153s，44.8 节点/s | 100k 外推 37.2 分钟；不可用于 ingest |
| 顺序 `create_relationship` × 995 | 15.353s，64.8 关系/s | 500k 外推 128.6 分钟；不可用于 ingest |
| `create_nodes` 批量 × 500 | 5.386s，92.8 节点/s | 仍是逐条 CREATE；不是 bulk 路径 |
| `get_neighbors` 1-hop | p50 9.86ms，p95 20.16ms | 单跳查询可用，但走内部 int ID |
| bulk `UNWIND` 100k 节点 | 20.536s，4,869.5 节点/s | 生产 ingest 必须走这条 |
| bulk `UNWIND` 500k 边 | 121.072s，4,129.8 边/s | 生产 ingest 必须走这条 |
| 容器峰值 RSS | 1,536MB | 100k/500k 规模的内存下限参考 |
| ID 语义 | 返回 `id: int`；`entity_id` 是 property；按 `entity_id` 建关系失败 | 需要 `entity_id` 唯一约束 + 自有映射 |
| `create_index(..., "vector")` | 实际创建了 btree/range，不是 vector index | 向量 DDL 自己写 |

### 2.3 10k / 50k embedded baseline

来源：[`research/retrieval-index/results/embedded-10k.json`](../../research/retrieval-index/results/embedded-10k.json)（本次重跑，合成数据集，10k 节点 / 50k 边）；以及 #5 的 10k/50k 结果。

| 指标 | 本次 10k 重跑 | #5 10k/50k | 说明 |
|---|---|---|---|
| keyword p50 / p95 | 17.36ms / 46.67ms | 61.44ms / 245.68ms | 查询词选择性不同；本次关键词更窄 |
| paraphrase p50 / p95 | 60.70ms / 287.32ms | — | 无精确词时仍靠 O(n) 扫描，已接近 300ms |
| keyword recall@10 | 1.00 | — | 精确词命中 |
| paraphrase recall@10 | 0.0373 | — | 纯词法对同义改写几乎无效 |
| 2-hop 扩展 p95 | 0.86ms | 0.322ms | 局部遍历本身很快 |
| ingest | 节点 0.14s / 边 3.61s | — | 内存图，不是生产写入 |
| RSS | 368MB | 263.5MB | 10k/50k 规模 |
| snapshot | 18.85MB；save 1.03s / load 3.73s | 14.59MB；1.38s / 5.96s | JSON 全量快照，不能当生产系统记录 |

结论：embedded 在 10k 还能跑，但 paraphrase p95 已接近 300ms、recall 几乎为零；100k 的 O(n) 扫描必然超时。**v0 上限 10k/50k 是合理的；生产必须换索引。**

### 2.4 100k/500k 数据与 bulk 规模

- 合成数据集：100k 节点 / 500k 边，70 个 concept、210 条查询、700 个 gold 节点；节点文件 36.9MB，边 30.3MB；生成 3.0s。500k 节点 / 2.5M 边：节点 184.6MB、边 155.6MB；生成约 6s。
- 512 维 embedding：100k × 512 × float32 = 195MB，`minishlab/potion-retrieval-32M` 在本机 13.3s 生成；500k 为 977MB、74.6s。
- Neo4j bulk：§2.2 的 20.5s / 121s；容器峰值 1.5GB。
- 100k 三后端检索实测见 §2.5；500k 见 §2.6。

### 2.5 100k 检索实测（100k 节点 / 500k 边，主证据）

环境：macOS 13.7.8 / Intel i7-7700HQ / 16GB；Docker VM 8GB / 8 CPU。Neo4j 5.26 Community heap 2GB + pagecache 512MB、容器 6GB；PostgreSQL 17 `pgvector/pgvector:pg17` 容器 6GB、`maintenance_work_mem=1GB`、HNSW `m=16, ef_construction=64`、`hnsw.ef_search=100`；Qdrant 1.12.5 容器 5GB、HNSW `m=16, ef_construct=100`、`hnsw_ef=128`。每模式 warmup 100、measured 500，另做 200 次 end-to-end（候选 + 5 个 anchor 的 2-hop 扩展）。原始文件：[`neo4j-100k.json`](../../research/retrieval-index/results/neo4j-100k.json)、[`pgvector-100k.json`](../../research/retrieval-index/results/pgvector-100k.json)、[`qdrant-100k.json`](../../research/retrieval-index/results/qdrant-100k.json)。

> **Embedding caveat（重要）**：本表使用 `minishlab/potion-retrieval-32M`（512d，静态检索模型），不是生产要用的 `BAAI/bge-small-en-v1.5`（384d）。原因是 bge-small 在本机真实文本上持续吞吐只有约 8–28 texts/s，100k 需约 1–2 小时、500k 需要数小时，超出了本票的机器时间；bge-small 的 10k 向量基线也未跑完。索引延迟/磁盘/内存的对比仍然有效（512d 比 384d 更重，是保守上界）；**recall@10 只说明该 embedding + 索引组合，不能直接当作 bge-small 的生产 recall**。§2.3 的 embedded 结果是纯词法基线，不依赖 embedding。

| backend | mode | p50 | p95 | p99 | recall@10 | e2e p95（含 2-hop） |
|---|---|---:|---:|---:|---:|---:|
| Neo4j | keyword (Lucene) | 4.28ms | 6.21ms | 7.97ms | **1.000** | 13.48ms |
| Neo4j | vector (HNSW) | 21.04ms | 25.61ms | 29.06ms | 0.217 | 31.47ms |
| Neo4j | hybrid (RRF) | 24.85ms | 32.54ms | 48.30ms | 0.657 | **37.56ms** |
| PostgreSQL+pgvector | keyword (GIN) | 1.80ms | 3.23ms | 5.41ms | **1.000** | 18.62ms |
| PostgreSQL+pgvector | vector (HNSW) | 16.38ms | 97.33ms | 272.10ms | 0.066 | 34.85ms |
| PostgreSQL+pgvector | hybrid (RRF in SQL) | 14.81ms | 23.71ms | 40.57ms | 0.551 | **56.89ms** |
| Qdrant + Neo4j | vector (Qdrant) | 12.34ms | 16.73ms | 24.00ms | 0.175 | 30.96ms |
| Qdrant + Neo4j | keyword (Neo4j) | 4.36ms | 6.72ms | 12.77ms | **1.000** | 13.54ms |
| Qdrant + Neo4j | hybrid (cross-store) | 15.44ms | 23.38ms | 31.78ms | 0.647 | **31.79ms** |

注释：

- **三种组合在 100k 的 hybrid end-to-end p95 都低于 300ms**：Qdrant+Neo4j 31.8ms、Neo4j 37.6ms、Postgres 56.9ms。单看“满足 p95 < 300ms”，三个都通过。
- **Neo4j 的 hybrid 检索本身最快（p95 32.5ms）**；Qdrant 的跨存储 hybrid 依赖 Neo4j 做 lexical + 2-hop，仍更快是因为 Qdrant 向量查询最快（p95 16.7ms）。
- **Postgres 的 vector p95 97ms / p99 272ms 明显差于 Neo4j/Qdrant**，主要来自 pgvector HNSW 的 tenant post-filter 与 512d 向量文本参数的解析开销；hybrid p95 23.7ms 仍达标，但 p99 尾延迟需要关注。
- 本表 recall 的差异主要来自 embedding（potion）而不是索引：同一 query 下各后端 top-10 召回不同，但都受限于该模型的语义质量；生产必须用 bge-small 或客户模型重跑 §9 的 gate。

载入/索引/资源：

| backend | 载入 | 索引构建 | 磁盘 | 容器内存峰值 |
|---|---|---|---:|---:|
| Neo4j | 100k 节点 133.6s（749/s）；500k 边 29.5s（17.0k/s） | full-text 3.7s；vector 34.6s | 2.39GB（data 0.85GB + tx 1.54GB） | 2.58GB |
| PostgreSQL+pgvector | 100k 节点 56.0s（1.8k/s）；500k 边 1.16s | HNSW 105.6s；GIN 3.7s；tenant/edge 0.8s | 1.28GB（DB 668MB） | 206MB |
| Qdrant | 100k points upsert 48.9s（2.0k/s）+ settle 17.3s | HNSW 在 upsert 中增量构建 | 327MB | 722MB |

### 2.6 500k 规模（三方案已实测）

500k / 2.5M 边使用同一 schema 和 512d embedding。Neo4j 在初始 2GB heap 下 bulk load 触发 `Neo4j.TransientError.General.MemoryPoolOutOfMemoryError`；改用 heap 3GB + pagecache 1GB 后完成。原始文件：[`neo4j-500k.json`](../../research/retrieval-index/results/neo4j-500k.json)、[`neo4j-500k-load.json`](../../research/retrieval-index/results/neo4j-500k-load.json)、[`pgvector-500k.json`](../../research/retrieval-index/results/pgvector-500k.json)、[`qdrant-500k.json`](../../research/retrieval-index/results/qdrant-500k.json)。

| Neo4j 500k | 结果 |
|---|---|
| 节点写入 | 前 310k 由一次被工具超时中断的运行完成；重启后 190k 在 426.6s 内写入（445/s）；全量约 15–20min |
| 边写入 | 2.5M 在 242.0s 内写入（10.3k/s，按 `entity_id` 唯一索引） |
| full-text index | 26.2s |
| vector index（512d, HNSW） | 209.7s |
| 容器内存峰值 / 磁盘 | 4.16GB / 6.34GB（data 4.04GB + tx 2.31GB） |
| keyword p50 / p95 / p99 | 7.65ms / 16.53ms / 23.25ms；recall 1.000；e2e p95 48.6ms |
| vector p50 / p95 / p99 | 62.3ms / 78.2ms / 94.7ms；recall 0.073；e2e p95 100.9ms |
| hybrid p50 / p95 / p99 | 62.9ms / 72.8ms / 77.0ms；recall 0.562；e2e p95 **92.6ms** |

结论：**Neo4j 500k 的 hybrid + 2-hop e2e p95 为 92.6ms，仍低于 300ms**；但 2GB heap 不够，生产至少 3GB heap，且 512d 向量索引构建约 3.5min。vector 的 recall 0.073 是 potion 模型在 500k 上的质量信号，不是 bge 的结论。

Qdrant + Neo4j 500k（同一 Neo4j 图，Qdrant 只存 512d 向量）：

| Qdrant + Neo4j 500k | 结果 |
|---|---|
| Qdrant points | 500k；upsert 383.7s（1.3k/s）+ settle 82.4s |
| Qdrant 内存 / 磁盘 | 容器 RSS 962MB；存储 1.49GB |
| vector p50 / p95 / p99 | 13.56ms / 17.16ms / 19.47ms；recall 0.171；e2e p95 62.5ms |
| keyword（Neo4j）p50 / p95 / p99 | 5.25ms / 6.35ms / 6.96ms；recall 1.000；e2e p95 36.5ms |
| hybrid（跨存储）p50 / p95 / p99 | 19.54ms / 24.04ms / 27.82ms；recall 0.572；e2e p95 **47.8ms** |

Qdrant 的 500k hybrid e2e p95 47.8ms，仍低于 300ms；跨存储方案的代价是 upsert 383.7s、两个存储的备份/一致性，以及 1.49GB 额外磁盘。

PostgreSQL + pgvector 500k（同一数据集，GIN + HNSW + recursive CTE）：

| Postgres 500k | 结果 |
|---|---|
| 节点写入 | 500k；292.8s（1.7k/s，50k 一块、每块独立事务） |
| 边写入 | 2.5M；8.7s（286k/s） |
| HNSW / GIN / tenant / edge 索引 | 975.4s / 16.7s / 0.5s / 1.8s |
| 容器内存峰值 / 磁盘 | 391MB / 5.08GB（DB 4.03GB） |
| keyword p50 / p95 / p99 | 1.37ms / 3.03ms / 5.22ms；recall 1.000；e2e p95 16.8ms |
| vector p50 / p95 / p99 | 14.03ms / 18.94ms / 20.36ms；recall 0.045；e2e p95 34.2ms |
| hybrid p50 / p95 / p99 | 16.18ms / 23.95ms / 25.91ms；recall 0.559；e2e p95 **35.6ms** |

结论：**Postgres 500k 的 hybrid + 2-hop e2e p95 为 35.6ms，低于 Neo4j（92.6ms）和 Qdrant+Neo4j（47.8ms）**；单存储方案在 500k 上反而最快，代价是 HNSW 构建 16.3 分钟、DB 4.03GB。注意 100k 用 500 次测量、500k 用 100 次，且各轮容器共存情况不同；跨规模只看是否 <300ms，不把 35.6ms 解读为“规模越大越快”。100k 的 vector p99 272ms 在 500k 为 20.4ms，但 500k 的 p99 约 1 个样本，不能据此否定 100k 的尾延迟异常；生产 embedding/真实数据下仍需用足够样本复测尾延迟。vector recall 0.045、hybrid recall 0.559 是 potion embedding 的质量信号，不是 bge 的结论。

## 3. 候选方案对比

| 维度 | PostgreSQL 17 + pgvector | Neo4j 5.26 Community | Qdrant + 图存储 | Semantica embedded |
|---|---|---|---|---|
| 许可 | PostgreSQL License / pgvector PostgreSQL License | GPL-3.0；商业版另购 | Apache-2.0 | MIT |
| 图结构 | adjacency 表 / recursive CTE；可选 Apache AGE | 原生属性图 + Cypher | 无图，需 Neo4j/Postgres | 进程内属性图 |
| 全文本 | `tsvector` + GIN | Lucene full-text index | 无（需 Neo4j/外部） | O(n) 扫描 |
| 向量 | pgvector HNSW | 原生 vector index（HNSW） | HNSW | 无内置生产索引 |
| 1–2 跳 | recursive CTE，v0 足够 | Cypher，最自然 | 依赖图存储 | `get_neighbors`，快但只在内存 |
| 运维面 | 1 个 Postgres | 1 个 Neo4j | 2 个存储 + 一致性 | 进程内，无独立服务 |
| 客户 bundle | 许可干净，推荐默认 | 需法务/客户许可 | 多一个组件 | v0 only |
| 100k hybrid e2e p95 | 56.9ms（实测） | 37.6ms（实测） | 31.8ms（实测，跨两库） | 287ms（10k paraphrase；100k 未测） |
| 500k hybrid e2e p95 | **35.6ms（实测）** | **92.6ms（实测）** | **47.8ms（实测，跨两库）** | 不可交互 |
| 结论 | **默认（条件式）** | 客户许可 fallback | 可选 sidecar | v0 10k/50k |

注：100k 每模式 500 次测量、500k 每模式 100 次；跨规模只比较是否满足 300ms，不把排序当作规模趋势。100k 的 Qdrant/Neo4j 数据见 §2.5，500k 见 §2.6。

## 4. 推荐方案

### 4.1 默认：PostgreSQL + pgvector + 全文本 + recursive CTE

理由：

1. **许可是默认 bundle 的硬约束。** #14 已经把 Neo4j 从默认候选降级；Postgres/pgvector 是 PostgreSQL License，Qdrant 是 Apache-2.0，但 Qdrant 多一个存储。默认 bundle 不应要求客户法务接受 GPL 或商业许可。
2. **一个存储同时解决图、词法、向量。** `entities` / `edges`、`tsvector` GIN、pgvector HNSW 在同一个 Postgres；备份、升级、监控、租户过滤都只有一套。
3. **1–2 跳足够覆盖 v0 Recipe。** `docs/semantic-modeling.md` 的 `graph` stage 是 1–2 跳；recursive CTE 可以表达，不需要 Cypher。若未来需要更复杂的图查询，再评估 Apache AGE 或 Neo4j。
4. **稳定 ID 容易保持。** `entity_id` 作为唯一键，内部 `id` 不暴露；`GraphStore` 的 `entity_id` 语义与 #8 一致。
5. **可逆。** 如果 performance gate 失败，切 Neo4j（客户许可）或加 Qdrant；数据模型和 `entity_id` 不变。

100k/500k 实测补充（§2.5/§2.6）：Postgres 的 hybrid end-to-end p95 为 56.9ms（100k）和 35.6ms（500k），满足 300ms 目标；500k 时甚至快于 Neo4j（92.6ms）和 Qdrant+Neo4j（47.8ms）。但 Neo4j Community 是 GPL-3.0，Qdrant 方案多一个存储和跨库一致性；**在默认 bundle 的许可/运维约束下，Postgres 是默认选择**。如果客户已有 Neo4j 或接受商业许可，Neo4j 应作为首选替代；如果 Postgres 的 vector p99 在生产数据上恶化（100k 曾出现 272ms，500k 为 20.4ms），再加 Qdrant sidecar，而不是把 Neo4j 放进默认 bundle。

建议的 schema（实施细节，不是本票强制）：

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE entities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id text NOT NULL UNIQUE,
  type text NOT NULL,
  name text NOT NULL,
  text text NOT NULL,
  topic text,
  tenant_id text NOT NULL,
  version text NOT NULL,
  embedding vector(512) NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(name,'') || ' ' || coalesce(text,''))
  ) STORED
);

CREATE TABLE edges (
  src bigint NOT NULL REFERENCES entities(id),
  dst bigint NOT NULL REFERENCES entities(id),
  rel_type text NOT NULL,
  tenant_id text NOT NULL
);

CREATE INDEX entities_tenant ON entities (tenant_id);
CREATE INDEX entities_hnsw ON entities USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX entities_gin ON entities USING gin (tsv);
CREATE INDEX edges_src ON edges (src);
CREATE INDEX edges_dst ON edges (dst);
```

查询路径：`lexical`（GIN + `websearch_to_tsquery`）→ `vector`（HNSW + tenant filter）→ `expand`（recursive CTE 1–2 跳）→ RRF/recipe rank → mask/budget。具体权重由 Recipe 决定，不在本票。

### 4.2 Neo4j：客户许可 fallback

Neo4j 5.26 Community 的 full-text + native vector index + Cypher 是技术上最顺的单库方案；如果客户已有 Neo4j 或购买商业许可，优先用它：

- `:Entity {entity_id}` 唯一约束；full-text index on `name,text`；vector index 512d cosine。
- ingest 用 `UNWIND` 批量，不用 `Neo4jStore` 逐条写；`entity_id` 是唯一外部 ID，内部 int ID 不返回。
- 1–2 跳用 Cypher；`context-service` 的 `GraphStore` 实现与 Postgres 版共享接口。
- 如果 performance gate 显示 Postgres 不达标，Neo4j 是技术 fallback；但默认 bundle 仍不打包 GPL 版本，由客户环境提供或单独许可。

### 4.3 Qdrant：不默认，保留为 sidecar

Qdrant 的向量索引和过滤能力很好，但默认方案里它是第二套存储：

- 图/词法仍在 Postgres 或 Neo4j，Qdrant 只存向量；跨存储写入需要一致性/补偿，备份和升级变成两套。
- 只有在 pgvector HNSW 的 recall 或 p95 明显不达标、且图存储不能换时，才加 Qdrant；此时 `GraphStore` 仍是图的主写者，Qdrant 是可重建索引。
- 如果加 Qdrant，`retrieve` 的 `index` 仍是 `hybrid`，`degraded.reason=index_unavailable` 用于 Qdrant 不可用时的 lexical-only fallback。

### 4.4 为什么不继续 embedded

`ContextGraph.query()` 是 O(n) 词法扫描；10k 的 paraphrase p95 已 287ms，recall 0.037；100k 必然超时。embedded 只适合 v0 的 10k/50k 和本地开发，不作为生产承诺。

## 5. 接口与迁移

### 5.1 `GraphStore` 端口（内部）

`GraphStore` 是 context-service 的内部端口，不暴露给 Mastra。建议方法（都带 `tenant_id`，写入幂等、批量）：

```text
upsert_entities(tenant_id, entities, embeddings=None) -> None
upsert_relationships(tenant_id, relationships) -> None
delete_by_source(tenant_id, source_ref) -> int
get_entity(tenant_id, entity_id) -> Entity | None
lexical_search(tenant_id, query, limit) -> list[Candidate]
vector_search(tenant_id, vector, limit) -> list[Candidate]
expand(tenant_id, anchors, hops, limit) -> list[Entity]
stats() -> dict
health() -> Health
```

约束：

- 只使用稳定 `entity_id`；绝不把 Postgres `id` / Neo4j 内部 int 暴露给 Context API 或审计。
- `upsert_*` 按 `entity_id` 幂等；删除按 `source_ref`/租户，不按内部 ID。
- 批量接口；禁止逐条事务写入（§2.2 已证明不可行）。
- `lexical_search` / `vector_search` 返回候选（`entity_id`、score、source_ref、version、provenance_id）；排序/融合由 Recipe 层做。
- `expand` 只做 1–2 跳，返回去重后的实体；不编造关系。

### 5.2 `/v1/context/retrieve` 不变

`contracts/schemas/retrieval.schema.json` 已经包含所需的 `index` 枚举和 `degraded.reason`：

- `index`：`lexical`、`graph`、`fulltext`、`vector`、`hybrid`。
- `degraded.reason`：`scale_limit`、`index_unavailable`、`timeout`、`partial`、`empty`。
- `items[]` 字段不变：`entity_id`、`type`、`content`、`score`、`source_ref`、`version`、`provenance_id`、`metadata`。

因此 **不需要改 wire contract**。生产实现只需把 `GraphStore` 换成 Postgres/Neo4j 实现，并让 recipe 的 `lexical`/`vector`/`graph` stage 调用对应方法。

### 5.3 `runtime-info` 的 additive 变更

`contracts/schemas/runtime-info.schema.json` 的 `backend.graph` 当前枚举是 `["embedded","neo4j"]`。默认 Postgres 需要增加 `"postgres"`：

```json
"graph": { "type": "string", "enum": ["embedded", "neo4j", "postgres"] }
```

这是 additive minor change，不破坏已有客户端；`backend.audit` 仍为 `sqlite|postgres`。`limits.max_nodes` / `max_edges` 按后端部署值返回（v0 embedded 10k/50k；生产按 gate 实测 envelope，不写营销数字）。

### 5.4 embedded → production 迁移

1. **快照/重建**：v0 的 `ContextGraph.save_to_file()` 产出 JSON；生产 importer 读取 nodes/edges，按 `entity_id` 映射。能重建的图优先从 Customer Context Package / 源数据重建；快照导入用于连续性。
2. **稳定 ID**：`fde:<tenant>:<type>:<key>` 不变；Postgres `entities.entity_id` 唯一；Neo4j `:Entity {entity_id}` 唯一约束。源键变化用 `same_as` 保留旧 ID（#8 §4.2）。
3. **cutover**：沿用 #8 的 stop-the-world 升级：停写 → 备份 embedded snapshot/audit → 迁移 → 校验计数/ID/抽样检索 → 启动新 context-service → smoke test → 新 Deployment Revision。
4. **回滚**：保留上一 Release + embedded snapshot；回滚只恢复图，不回滚 audit（#8 §10.5）。生产不 dual-write；ingest 可重放。
5. **审计**：audit store 独立，不随图迁移；`retrieval_id` / `snapshot_digest` 语义不变。

## 6. 失败与降级

| 情况 | 行为 | 返回 |
|---|---|---|
| 图存储不可用 | 不编造关系；Recipe 决定失败或继续 | `degraded=true`, `reason=index_unavailable` |
| 全文本索引不可用 | 跳过 lexical，保留 vector/graph | `degraded=true`, `reason=index_unavailable` 或 `partial` |
| 向量索引不可用 | 跳过 vector，保留 lexical/graph | `degraded=true`, `reason=index_unavailable` |
| 2-hop 扩展失败/超时 | 返回未扩展候选，不编造边 | `degraded=true`, `reason=partial` / `timeout` |
| 整体超时 | 返回 504 envelope；context-service 有自己的最大执行时间 | `timeout`（retryable） |
| 无结果 | 不编造上下文 | `degraded=true`, `reason=empty` |
| embedded 超规模 | 不静默全表扫描 | `degraded=true`, `reason=scale_limit` |
| 审计写失败 | 有副作用的 Run fail closed；只读 Run 标记 `audit_incomplete` | **fail closed**（#8 §7.3） |

`degraded=true` 时 prompt 必须标注“上下文不完整”；不得假装完整（`docs/semantic-modeling.md` §6.4）。

## 7. 运维占用

| 组件 | 镜像/进程 | 100k 实测内存/磁盘 | 备份/升级 |
|---|---|---|---|
| Postgres + pgvector | `pgvector/pgvector:pg17`（460MB 镜像） | 容器 RSS 206MB；DB 668MB、卷 1.28GB（512d 向量）；HNSW 构建 105.6s | `pg_dump`/WAL；与 context-service 一起 stop-the-world |
| Neo4j 5.26 | `neo4j:5.26.0-community`（541MB 镜像） | 容器 RSS 2.58GB；data 0.85GB + tx 1.54GB；heap 2GB + pagecache 512MB；冷启动 37s | dump/restore；同 stop-the-world |
| Qdrant 1.12 | `qdrant/qdrant:v1.12.5`（188MB 镜像） | 容器 RSS 722MB；存储 327MB；冷启动 0.15s | snapshot；多一个组件 |
| Embedded | 进程内 | 10k/50k RSS 368MB；snapshot 18.85MB | JSON 快照；v0 only |

500k 实测：Postgres 容器 RSS 391MB、DB 4.03GB、卷 5.08GB、HNSW 构建 975.4s；Neo4j 4.16GB、6.34GB（需 ≥3GB heap，2GB 会 OOM）；Qdrant 962MB、1.49GB。三者的 500k 资源都来自 §2.6 的实测 JSON。

生产 bundle 默认只有 `context-service` + Postgres（以及 mastra-app/audit）；Neo4j/Qdrant 只在对应部署 profile 出现。

## 8. 被淘汰方案

| 方案 | 为什么不选 |
|---|---|
| Semantica embedded 扩到 100k+ | `ContextGraph.query()` O(n)；10k paraphrase p95 287ms、recall 0.037；100k 不可交互 |
| Semantica `Neo4jStore` 作为 serving 适配器 | 逐条写 44.8 节点/s；内部 int ID；`create_index` 无 vector；`get_neighbors` 只认 int；必须自写 bulk 适配层 |
| Semantica `VectorStore` / `HybridSearch` 作为检索层 | 库里有 Qdrant/PgVector/FAISS，但 `search_hybrid` 是 vector+metadata，不是 lexical+graph；`ContextGraph` 不调用它；需要自建融合 |
| Neo4j 作为默认 bundle | 技术可行，但 Community GPL-3.0 与默认分发冲突（#14）；作为客户许可 fallback 保留 |
| Qdrant 作为默认第二存储 | 图/词法仍需另一存储；跨存储一致性、备份、升级、运维翻倍；没有证据表明 pgvector 不够 |
| 纯向量 RAG | 无实体/关系/本体/决策/溯源；不满足 FDE 的审计要求 |
| Apache AGE 作为默认 | 许可干净，但多一个扩展/版本/运维面；v0 的 1–2 跳用 recursive CTE 足够；未 benchmark，不作为默认 |
| Neo4j 作为“唯一正确”图库 | 规模/图查询强，但默认 bundle 的许可与运维成本高于 Postgres；客户已有 Neo4j 时再选 |

## 9. 已验证与未验证 / performance gate

**500k 三方案均已完成**（§2.6）：Neo4j 在 2GB heap 下 bulk load OOM，改用 3GB 后完成，hybrid + 2-hop e2e p95 92.6ms；Qdrant+Neo4j 47.8ms；Postgres 35.6ms。Postgres 的 HNSW 构建 975.4s、DB 4.03GB，是默认方案的资源代价。**bge-small 未在 100k/500k 上跑完**：本机吞吐 8–28 texts/s，100k 需 1–2 小时、500k 数小时；§2.5/§2.6 的 recall 来自 512d potion，不能当作生产 bge recall。

仍未验证：

- bge-small（384d）在 100k/500k 的 recall@10、p50/p95；本表只能证明索引/存储层的延迟/资源，不能证明生产 embedding 的召回。
- 并发（8 客户端）、tenant 过滤选择性（本测试 acme 约 95%）、1M 节点/边、HA/备份恢复演练。
- Apache AGE 的可用性与性能；只做了许可与替代性分析。
- 真实客户语料的分布、文档长度、重复/冲突；合成语料每 concept 只有 10 个 gold，recall 绝对值偏乐观或偏悲观都可能。
- Postgres 的 vector p99 在 100k 为 272ms、500k 为 20.4ms；500k 每模式只有 100 次测量（p99 约 1 个样本），不能据此排除 100k 的尾延迟异常，生产数据/embedding 下需用足够样本复测。

**Performance gate（实施前必须跑）：**

1. 用 `research/retrieval-index/` 的 harness 生成 100k/500k 数据，用生产 embedding（bge-small 或客户模型）重新生成向量，跑 `bench_pgvector.py`、`bench_neo4j.py`，可选 `bench_qdrant.py`。
2. 验收：hybrid + 2-hop 的 p95 < 300ms；recall@10 不低于 lexical baseline（具体阈值由 #10 的 context eval gate 定，不在本票拍数字）。
3. 记录磁盘、容器 RSS、索引构建时间、冷启动、失败模式。
4. 如果 Postgres 不达标：优先切 Neo4j（客户许可允许时）；否则加 Qdrant sidecar；仍不达标再考虑 AGE/分片/只读副本。
5. 只有 gate 通过后，才把 `runtime-info.backend.graph="postgres"` 写进生产 Release；否则保持 `embedded` 或客户许可的 `neo4j`。

## 10. 复现资产

- `research/retrieval-index/README.md`：环境、数据生成、容器、运行命令、已收集结果、caveats。
- `research/retrieval-index/generate_dataset.py`、`concepts.py`：确定性合成数据集（100k/500k，70 concepts，210 queries，700 gold nodes）。
- `research/retrieval-index/bench_embedded.py`：10k/50k embedded baseline。
- `research/retrieval-index/bench_neo4j.py`：Neo4j full-text + vector + 2-hop。
- `research/retrieval-index/bench_qdrant.py`：Qdrant vector + Neo4j lexical/graph。
- `research/retrieval-index/bench_pgvector.py`：Postgres pgvector + GIN + recursive CTE。
- `research/retrieval-index/probes/semantica_neo4j_adapter_probe.py`：适配器 vs bulk 探针。
- `research/retrieval-index/results/embedded-10k.json`、`neo4j-10k.json`、`neo4j-100k.json`、`neo4j-500k.json`、`neo4j-500k-load.json`、`pgvector-10k.json`、`pgvector-100k.json`、`pgvector-500k.json`、`qdrant-10k.json`、`qdrant-100k.json`、`qdrant-500k.json`、`summary.json`/`summary.md`：本 memo 引用的原始结果。
- 未提交数据/DB 卷：本机重跑时放在 `/Users/nicholasl/Documents/build-whatever/fdesforce-retrieval-data`（临时，可重建；不提交）。

## 11. 来源

- **[S1]** Semantica 0.7.0（PyPI，MIT）与源码：<https://github.com/semantica-agi/semantica/releases/tag/v0.7.0>
- **[S2]** `semantica/context/context_graph.py` 1099–1138（`ContextGraph.query` 线性扫描）
- **[S3]** `semantica/vector_store/vector_store.py` 114（`SUPPORTED_BACKENDS`）、1594–1615（`search_hybrid`）
- **[S4]** `semantica/vector_store/hybrid_search.py` 250–300（`HybridSearch`）
- **[S5]** `semantica/graph_store/neo4j_store.py` 346–398（`create_node`）、621–690（`create_relationship`）、860–912（`get_neighbors`）、982–1025（`create_index`）
- **[S6]** `semantica/embeddings/embedding_generator.py` 81（supported models）
- **[S7]** 本仓库 `research/retrieval-index/results/semantica_neo4j_adapter_probe.json`
- **[S8]** 本仓库 `research/retrieval-index/results/embedded-10k.json`
- **[S9]** 本仓库 `docs/spikes/mastra-semantica-spike.md`（#5）: <https://github.com/0xnicholas/Fdesforce/blob/spike/5-mastra-semantica/docs/spikes/mastra-semantica-spike.md>
- **[S10]** 开源代码可用性审计（#14）: <https://github.com/0xnicholas/Fdesforce/issues/14>
- **[S11]** 运行时与集成契约（#8）: <https://github.com/0xnicholas/Fdesforce/blob/design/8-runtime-contract/docs/runtime-contract.md>
- **[S12]** Retrieval schema: [`contracts/schemas/retrieval.schema.json`](https://github.com/0xnicholas/Fdesforce/blob/design/8-runtime-contract/contracts/schemas/retrieval.schema.json)（`index`/`degraded.reason` 枚举）
- **[S13]** Runtime info schema: [`contracts/schemas/runtime-info.schema.json`](https://github.com/0xnicholas/Fdesforce/blob/design/8-runtime-contract/contracts/schemas/runtime-info.schema.json)（`backend.graph` 枚举）
- **[S14]** 许可：PostgreSQL License <https://www.postgresql.org/about/licence/>；pgvector PostgreSQL License <https://github.com/pgvector/pgvector/blob/master/LICENSE>；Qdrant Apache-2.0 <https://github.com/qdrant/qdrant/blob/master/LICENSE>；Neo4j Community GPL-3.0 <https://github.com/neo4j/neo4j>；Apache AGE Apache-2.0 <https://github.com/apache/age>
- **[S15]** 本仓库 `research/retrieval-index/README.md`（复现命令与 caveats）
- **[S16]** Neo4j full-text index：<https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/full-text-indexes/>；vector index：<https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/vector-indexes/>
- **[S17]** Qdrant indexing / HNSW：<https://qdrant.tech/documentation/concepts/indexing/>；payload filtering：<https://qdrant.tech/documentation/concepts/filtering/>
- **[S18]** pgvector README（HNSW、`ef_search`、operator classes）：<https://github.com/pgvector/pgvector>
- **[S19]** Apache AGE：<https://age.apache.org/>；Apache-2.0 许可：<https://github.com/apache/age/blob/master/LICENSE>
- **[S20]** 本表使用的 512d benchmark embedding：<https://huggingface.co/minishlab/potion-retrieval-32M>（static model；不是生产选型）

> 注：§2.5 的 100k 数字是实测，但 embedding 是 512d potion（见 §2.5 caveat），不是 bge-small；§2.2 的 bulk 数字来自 `Neo4jStore` 适配器探针。不要把 §2.5 的 recall 当作 bge-small 生产 recall；§9 的 performance gate 仍需用生产 embedding 复跑。
