# 开源代码可用性审计：Mastra 与 Semantica

> 研究日期：2026-11-14
> 关联 ticket：[开源代码可用性审计：Mastra 与 Semantica](https://github.com/0xnicholas/Fdesforce/issues/14)
> 状态：技术/许可审计 memo。**不是法律意见**；对外交付前需要法务复核。

## 1. 问题

在“单客户 bundle、部署到客户自有服务器”的形态下，我们能否**完全利用** Mastra 和 Semantica 的开源代码？

“完全利用”包含三层：

1. **法律**：许可证是否允许内部使用、修改、再分发、打包进客户交付物、收费？
2. **技术**：npm/PyPI 包是否由开源仓库完整构建？有没有闭源二进制、私有 registry、缺失模块？
3. **功能**：核心能力是否藏在 `ee/`、enterprise、cloud 或付费层？

## 2. 结论摘要

| 组件 | 许可证 | 能否完全利用 | 能否打进客户 bundle | 建议 |
|---|---|---|---|---|
| **Mastra 核心**（`ee/` 之外） | Apache-2.0 | **可以** | 可以，需保留 NOTICE/许可 | v0 使用核心；不依赖企业功能 |
| **Mastra `ee/`**（auth、agent-builder、editor） | Mastra Enterprise License v2.0 | **不可以**（生产需商业协议 + License Key） | **不可以**（明确禁止再分发） | 从 bundle 中剥离，或购买 OEM/再分发许可 |
| **Semantica** | MIT | **可以** | 可以，需保留版权/许可声明 | v0 使用；加适配器 + pin 版本 |
| **Neo4j Community**（可选图存储） | GPL-3.0 | 可以，但有 copyleft 义务 | **谨慎**：分发可能触发 GPLv3 义务 | 客户自带，或改用 Apache AGE/Oxigraph |
| **FalkorDB**（可选图存储） | SSPLv1 | 可以，但 SSPL 非 OSI 批准 | **谨慎**：SaaS/再分发限制 | 客户已在用时才考虑 |
| **Apache AGE**（可选图存储） | Apache-2.0 | 可以 | 可以 | 推荐默认的 permissive 图存储 |
| **Oxigraph**（RDF/SPARQL） | Apache-2.0 / MIT | 可以 | 可以 | 推荐 RDF 路径 |

**一句话结论：Semantica 可以完全利用（MIT）；Mastra 只有 Apache-2.0 核心可以完全利用，`ee/` 企业功能不是开源，生产使用和再分发都需要商业协议。单客户 bundle 必须显式剥离 `ee/`，或者购买 Mastra 的 OEM/再分发许可。**

## 3. Mastra 审计

### 3.1 许可证地图

Mastra 采用**分层许可**：

- `ee/` 之外的代码：**Apache-2.0**。
- 任何名为 `ee/` 的目录：**Mastra Enterprise Edition License v2.0**（source-available，不是 open source）。

官方 `LICENSE.md` 明确列出：

- `@mastra/core/auth/ee`
- `@mastra/core/agent-builder/ee`
- `@mastra/editor/ee`

来源：[LICENSE.md](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md) · [ee/LICENSE](https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE)

`ee/LICENSE` 的关键条款：

- **Source-available，不是 open source**。
- 允许阅读、构建、修改、测试；**不允许 Production Use**。
- Production Use 需要：(a) 与 Kepler/Mastra 签署书面协议；(b) 有效的 License Key。
- **不允许再分发**（copy, merge, publish, distribute, sublicense, sell, rent, lease）。
- **不允许作为 hosted/managed service 提供给第三方**。
- 不允许绕过 License Key 检查。

### 3.2 `ee/` 里具体有什么

从仓库树看，`ee/` 覆盖三类能力：

| 路径 | 能力 | 对工作台的影响 |
|---|---|---|
| `packages/core/src/auth/ee` · `packages/_internals/auth/src/ee` | RBAC、FGA、权限、license、telemetry | 如果我们需要 Mastra 内置的企业级 auth/RBAC，就走商业许可 |
| `packages/core/src/agent-builder/ee` | agent builder 的 allowlist、policy、picker | 如果工作台自己生成 agents/workflows，可以不用 |
| `packages/editor/src/ee` | agent/workflow builder、workspace skills | Studio/Editor 的企业功能；客户 bundle 不需要 |

核心的 agents、workflows、HITL、memory、MCP、evals、observability 在 `ee/` 之外，属于 Apache-2.0。

### 3.3 npm 包实际包含 `ee/` 代码

这是最关键的发现：

- `@mastra/core@1.83.0` 的 npm tarball 包含：
  - `package/dist/auth/ee/*`
  - `package/dist/agent-builder/ee/*`
  - `package/LICENSE.md`
- npm metadata 写的是 `Apache-2.0`，但包内 `LICENSE.md` 是分层许可，`ee/` 仍受 Enterprise License 约束。
- tarball 大小约 19MB。

证据：`https://registry.npmjs.org/@mastra/core/-/core-1.83.0.tgz`（`tar -tzf` 可见上述路径）。

这意味着：

- 如果我们把 `@mastra/core` 原样打进客户 bundle（Docker 镜像、离线包、`node_modules`），我们可能在**再分发** Enterprise Features。
- 即使代码没有被 import，许可证对 “access, install, copy, or use” 的约束仍然可能适用。**需要法务确认“安装但未使用”的边界。**
- 最稳妥的工程做法：**在打包阶段删除 `dist/**/ee/**`**，并在构建门禁中检查；如果客户需要这些功能，走商业许可。
- 另一个稳妥做法：不把 `node_modules` 打进 bundle，让客户从 npm 安装；但这仍会把 `ee/` 代码带到客户环境，且生产使用边界不清。不能作为默认方案。

### 3.4 Mastra 结论

- **核心可以完全利用**：Apache-2.0，允许修改、再分发、收费；保留 NOTICE/许可即可。
- **`ee/` 不能完全利用**：生产使用需要商业协议 + License Key，再分发被禁止。
- **单客户 bundle 的默认策略**：只用 Apache-2.0 核心；剥离 `ee/`；auth/RBAC 放在客户应用或工作台自己的层；不使用 Mastra agent-builder/editor 的企业功能。
- **商业触发点**：如果客户要求 Mastra 内置 SSO/RBAC/FGA、agent builder、Studio/Editor 企业功能，或者我们想原样分发 `@mastra/core`，就需要 Mastra 的 OEM/再分发许可。需要联系 Mastra 确认是否有这种许可。

## 4. Semantica 审计

### 4.1 许可证与闭源模块

- 仓库根目录是 **MIT License**，允许使用、复制、修改、合并、发布、再分发、 sublicense、销售，只需保留版权和许可声明。
- 仓库中**没有** `ee/`、`enterprise/`、`pro/`、`cloud/`、`commercial/` 目录。
- README 的 “Enterprise” 章节是**商业支持/服务**（on-prem、private cloud、SLA、professional services），不是闭源代码。
- 源码中没有发现非 MIT 的文件头；核心模块都在 `semantica/` 下。

来源：[LICENSE](https://github.com/semantica-agi/semantica/blob/main/LICENSE) · [README Enterprise](https://github.com/semantica-agi/semantica#enterprise)

### 4.2 版本与发布包

- 源码 `pyproject.toml` 版本：**0.8.0**（调研时未发布）。
- PyPI 最新：**0.7.0**（2026-09-22 发布）。
- GitHub 最新 release：**v0.7.0**。
- Python：**3.11–3.13**；3.10 在 0.8.0 被移除。

**发布包完整性**：已检查本地源码 `/Users/nicholasl/Documents/git-clone/semantica`（commit `1e14db0a`，`v0.7.0-256-g1e14db0a`，`pyproject.toml` 版本 0.8.0）：MIT、无 `ee/`/enterprise/pro/cloud 目录，`mcp_server`、`graph_store/neo4j_store.py`、`explorer`、`provenance`、`ontology`、`context` 等模块齐全；`pyproject.toml` 的 `packages.find` 包含 `semantica*`、`integrations*`、`semantica_mcp*`，`MANIFEST.in` 包含 static/ontology 资源。PyPI 直连下载在本环境被网络卡住，未完整检查 0.7.0 wheel；**建议在 spike 中 `pip download` / 安装 0.7.0 并确认发布包与源码一致。**

### 4.3 功能完整性

从源码与文档看，OSS 版本覆盖：

- Context Graph、决策记录、PROV-O 溯源
- OWL/SHACL/SKOS 本体治理
- 前向链、Datalog、SPARQL 推理
- 时序、冲突检测、去重
- 文档/结构化数据/流/企业连接器
- 图存储（Neo4j、FalkorDB、Apache AGE、Amazon Neptune）
- 向量存储（FAISS、Qdrant、Weaviate、Milvus、Pinecone、PgVector、SQLite）
- MCP server（stdio）、REST/Explorer、CLI、可视化
- 评测模块

没有发现“核心功能只在付费版”的证据；商业版看起来是支持/服务，而不是封闭功能。

### 4.4 依赖许可风险（比 Semantica 本身更关键）

Semantica 是 MIT，但它默认推荐的图存储会引入不同的许可：

| 图存储 | 许可 | 风险 | 建议 |
|---|---|---|---|
| **Neo4j Community** | GPL-3.0 | 分发 bundle 可能触发 GPLv3 的源码提供/同许可义务 | 让客户自带 Neo4j，或改用 Apache AGE/Oxigraph |
| **Neo4j Enterprise** | 商业 | 需要客户/我们购买许可 | 客户已有则用，否则不默认 |
| **FalkorDB** | SSPLv1 | 非 OSI 批准；SaaS/再分发限制 | 客户已在用时才考虑 |
| **Apache AGE** | Apache-2.0 | 低 | **推荐默认的 permissive 图存储** |
| **Oxigraph** | Apache-2.0 / MIT | 低 | **推荐 RDF/SPARQL 路径** |
| **Amazon Neptune** | 商业（AWS） | 云厂商锁定/费用 | 客户在 AWS 且已有 Neptune 时考虑 |

来源：[Neo4j repo](https://github.com/neo4j/neo4j)（GPL-3.0） · [FalkorDB LICENSE](https://github.com/FalkorDB/FalkorDB/blob/main/LICENSE)（SSPLv1） · [Apache AGE](https://github.com/apache/age)（Apache-2.0） · [Oxigraph](https://github.com/oxigraph/oxigraph)（Apache-2.0/MIT）

其他依赖：

- 向量存储大多 permissive（FAISS MIT、Qdrant Apache-2.0、Weaviate BSD-3、Milvus Apache-2.0、PgVector PostgreSQL、SQLite public domain）；Pinecone 是商业 SaaS。
- LLM 提供商是商业条款，不是代码许可；客户 bundle 不应默认绑定某个 provider。
- 仍需一次完整的 SBOM/许可证扫描（npm + Python），本次只做了重点抽查。

### 4.5 Semantica 结论

- **Semantica 代码可以完全利用**：MIT，允许再分发/收费，保留声明即可。
- **图存储是主要许可风险**：默认 Neo4j 是 GPL-3.0；客户 bundle 建议用 **Apache AGE** 或 **Oxigraph**，或让客户自带 Neo4j。
- **发布包需复核**：本地源码（commit `1e14db0a`，0.8.0-dev）已核对为 MIT、无闭源目录、模块齐全；PyPI 0.7.0 wheel 与源码一致性在 spike 中验证；pin 0.7.x 或具体 commit。
- **商业支持**：如果客户需要 SLA/合规认证/on-prem 支持，可以走 Semantica 的商业服务，但不影响 OSS 代码使用。

## 5. 对工作台的影响

### 5.1 打包规则（必须写进 build pipeline）

1. **Mastra 只打包 Apache-2.0 核心**：
   - 删除 `node_modules/@mastra/core/dist/**/ee/**`
   - 不把 `@mastra/editor` 放进生产 bundle
   - 构建门禁检查 `dist/**/ee/**` 是否残留
2. **保留许可文件**：
   - Mastra `LICENSE.md`（至少 Apache-2.0 部分）
   - Semantica `LICENSE`（MIT）
   - `THIRD_PARTY_NOTICES` 汇总所有依赖
3. **SBOM/许可门禁**：
   - npm：`license-checker` / `pnpm licenses` / Syft
   - Python：`pip-licenses` / Syft
   - 默认拒绝 GPL/AGPL/SSPL，除非该组件由客户自带或有法务例外
4. **图存储默认**：
   - 首选 Apache AGE（PostgreSQL 扩展，Apache-2.0）或 Oxigraph（RDF/SPARQL，Apache-2.0/MIT）
   - Neo4j 只在客户自带许可时使用
5. **商业触发点**：
   - 客户要求 Mastra auth/RBAC/FGA、agent-builder、Studio/Editor → 需要 Mastra OEM/再分发许可
   - 客户要求 Neo4j Enterprise / 商业 KG 平台 → 客户自带许可

### 5.2 对 Solution Spec / 运行时契约的影响

- Solution Spec 的 `bundle` 部分应包含：
  - 运行时组件与版本（Mastra core、Semantica、图存储）
  - 许可/notice/SBOM 检查结果
  - 是否包含 `ee/`（默认必须是 false）
  - 图存储类型与许可来源（自带/我们提供）
- 运行时契约应明确：
  - 不依赖 Mastra `ee/` 功能
  - auth/RBAC 由客户应用或工作台层提供
  - 图存储的备份/升级/许可责任
- 原型必须验证：
  - 剥离 `ee/` 后 Mastra 核心仍能正常运行
  - Apache AGE 或 Oxigraph 路径可用
  - `THIRD_PARTY_NOTICES` / SBOM 生成成功

## 6. 未决问题

1. Mastra 是否提供 OEM/再分发许可？价格/条款是什么？
2. “安装 `@mastra/core` 但未使用 `ee/`” 是否构成 Production Use/再分发？需要法务确认。
3. Semantica 0.7.0 的 PyPI wheel 是否与源码一致？在 spike 中验证。
4. Apache AGE vs Oxigraph vs 客户自带 Neo4j 的功能/性能/运维取舍。
5. 完整 SBOM/许可证扫描（本次只做重点抽查）。
6. 客户 bundle 中是否允许包含商业 LLM SDK/驱动？需要按客户合同处理。

## 7. 证据来源

- [Mastra LICENSE.md](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md)
- [Mastra ee/LICENSE](https://github.com/mastra-ai/mastra/blob/main/ee/LICENSE)
- [Mastra core auth/ee](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/auth/ee)
- [Mastra core agent-builder/ee](https://github.com/mastra-ai/mastra/tree/main/packages/core/src/agent-builder/ee)
- [Mastra editor/ee](https://github.com/mastra-ai/mastra/tree/main/packages/editor/src/ee)
- [@mastra/core 1.83.0 npm tarball](https://registry.npmjs.org/@mastra/core/-/core-1.83.0.tgz)
- [Semantica LICENSE](https://github.com/semantica-agi/semantica/blob/main/LICENSE)
- [Semantica pyproject.toml](https://github.com/semantica-agi/semantica/blob/main/pyproject.toml)
- [Semantica README](https://github.com/semantica-agi/semantica)
- [Semantica PyPI](https://pypi.org/project/semantica/)
- [Neo4j repo (GPL-3.0)](https://github.com/neo4j/neo4j)
- [FalkorDB LICENSE (SSPLv1)](https://github.com/FalkorDB/FalkorDB/blob/main/LICENSE)
- [Apache AGE (Apache-2.0)](https://github.com/apache/age)
- [Oxigraph (Apache-2.0/MIT)](https://github.com/oxigraph/oxigraph)
- 本地源码：`/Users/nicholasl/Documents/git-clone/semantica`（commit `1e14db0a`，2026-11-13）
