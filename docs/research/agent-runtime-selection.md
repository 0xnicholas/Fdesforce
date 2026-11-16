# Agent 运行时选型：Mastra 与替代方案

> 关联 ticket：[#3](https://github.com/0xnicholas/Fdesforce/issues/3) · 研究日期：2026-11-14 · 状态：决策 memo
>
> 方法：固定 commit 克隆并阅读各项目源码、官方文档和 npm/GitHub API；关键结论附文件/行号。没有使用二手评测文章作为依据。检索日期均为 2026-11-14。

## 0. 结论

**推荐 Mastra 作为 FDE 工作台 v0 的 Agent 执行层，同时作为生成给客户的 Mastra 解决方案的默认运行时。**

但这是有条件的推荐。采用方式必须是：

- **每客户独立 bundle**：为每个客户生成独立的 Mastra 应用（独立进程/容器），不做一个共享的多租户 Mastra 核心；
- **锁版本**：Mastra、Semantica、生成器模板都锁定精确版本，维护版本矩阵；
- **禁用 EE**：v0 只使用 Apache-2.0 核心，不 import `ee/`，不依赖 RBAC/FGA/Agent Builder；
- **Semantica 生产走 REST**：MCP 只用于本地/IDE；跨容器生产契约用 REST；
- **Spec 是唯一真相**：Mastra 产物是可重建的 codegen 输出，不是新的真相源。

一句话：**Mastra 不是最成熟的运行时，但在“工作台本身就是 Mastra codegen、客户侧也部署 Mastra 应用”这个具体形态下，它是系统摩擦最小的选择。它的主要风险不是能力，而是版本治理与 EE 许可治理。**

如果以下任一前提不成立，应重开本决定：

- 团队是 Python-first，且不愿意长期维护 Node/TS 运行时；
- 工作台要从“生成器”变成共享多租户运行时；
- 客户要求单容器、不能有 Python sidecar/service；
- Mastra 1.x 的破坏性变更频率超出团队的升级预算；
- v0 就需要 EE 的 RBAC/FGA/SSO，且无法接受商业条款。

---

## 1. 评估边界

本 memo 只回答“Agent 执行层选谁”，不回答多租户拓扑、Semantica 本体建模、Solution Spec 格式等；这些分别属于 #12、#4/#9、#7。

评估前提：

- 工作台是**配置与交付层**，不是又一套 Agent 平台；它根据客户需求生成可部署的解决方案。[S1]
- 生成物包含 **Mastra agent/workflow 配置骨架**，以及 Semantica 本体/ingestion 配置、评测集和部署清单。[S4]
- 语义/上下文层大概率是 **Semantica（Python）**；契约用 MCP/REST 隔离，且必须显式设计身份、trace、provenance 的透传。[S1]
- v0 服务内部 FDE/交付团队，不包含公开 SaaS 多租户、完整可视化 Builder、生产级 HA/合规认证。[S1]
- 客户侧可能部署进客户 VPC；这是“自托管能力”权重高于“托管平台体验”的原因。

**判断标准分三档**，而不是给一个看似精确的总分：

- **必须项**：graph workflow、持久化/可恢复执行、HITL、MCP/工具接入、自托管。
- **重要项**：TS/Python 团队匹配、多租户隔离、可观测性/评测。
- **差异项**：与生成物运行时的对称性、许可、成熟度、企业支持、锁定风险。

---

## 2. 对比表

### 2.1 技术能力

| 方案 | 执行模型 / 图工作流 | 持久化执行 | HITL | MCP / 工具 | Memory / 可观测 / 评测 |
|---|---|---|---|---|---|
| **Mastra** | Agent loop 本身是 `dowhile` workflow；`.branch/.parallel/.dountil`；**强** [S5][S14] | workflow snapshot 持久化、跨部署/重启 resume；durable agent 仍是 beta；**强/中** [S12][S13][S9] | tool approval + `suspend()`/`resume()`；**强** [S10][S11] | MCP client + server，stdio/Streamable HTTP；**强** [S15] | memory + scorers/datasets/experiments + OTel exporters；**强** [S16][S17][S18] |
| **LangGraph** | 低层状态图，节点/边显式建模；**强** [S26] | checkpointer + `interrupt()`/`Command(resume=...)`；**强** [S27][S28] | 原生 interrupt，但节点会从头重放，需幂等；**强** [S28] | 通过 `langchain-mcp-adapters` 接 MCP；**中** | LangSmith 提供 tracing/eval；OSS 侧需自己接；**中** [S29][S31] |
| **PydanticAI** | agent 循环 + `pydantic-graph`（图/状态机库）；**中** [S36] | 核心不内置引擎，靠 Temporal/DBOS/Prefect/Restate/AWS Lambda 等 9 种引擎；**中** [S33] | deferred tool calls + 外部事件 token；**强** [S34] | MCP client 一等公民；server 用 FastMCP/MCP SDK；**中** [S35] | OTel + `pydantic-evals`；**强** [S37] |
| **OpenAI Agents SDK** | agent loop/handoffs/agents-as-tools，无图工作流引擎；**弱** | `RunState` 序列化 + Dapr/Temporal/Restate/DBOS 外部集成；**中** [S40] | `needs_approval` + `RunState`；**强** [S39] | MCP client 多传输；无 server 封装；**中** [S40] | 内置 tracing 默认上报 OpenAI；evals 依赖 OpenAI 平台；**中** [S40] |
| **Microsoft Agent Framework** | graph-based workflows，支持 sequential/concurrent/handoff/group；**强** [S41] | checkpoint storage，跨进程 pause/resume；Durable Task/Azure Functions 在独立扩展仓库；**强/中** [S42][S43] | `request_info`/approval 流程；**强** [S41] | MCP client（stdio/HTTP）+ `hosting-mcp`；**强** [S42] | 内置 OTel；Foundry evals 集成；**中** [S41] |
| **Google ADK** | graph workflow，routing/fan-out/loops/nested；**强** [S44] | 文档未提供独立 durable engine；恢复靠 session state/history replay；**中** [S45] | tool confirmation + workflow `require_confirmation`；**强** [S45] | MCP toolsets；**中** [S44] | OTel + 内置 eval CLI/框架；**强** [S45] |
| **Vercel AI SDK** | `ToolLoopAgent` 循环；“workflow”是代码模式，不是图引擎；**弱** [S46] | 核心无 durable execution；需另配 Workflow SDK；**弱** [S47] | `toolApproval` 工具级审批；**中** [S46] | MCP client；**中** [S46] | OTel telemetry；无内置 eval 框架；**弱** [S46] |

### 2.2 交付与治理

| 方案 | 语言 | 自托管 / VPC | 多租户 | 企业支持 | 许可 | 成熟度 / 节奏 | 锁定风险 |
|---|---|---|---|---|---|---|---|
| **Mastra** | TypeScript | `mastra build` 产出独立 Node server，可拷到任意 Node/Bun/Deno 环境；**强** [S19] | `resourceId`/`threadId` 隔离 + `mapUserToResourceId`；RBAC/FGA 是 EE；**中** [S16][S21][S22] | EE + 商业平台，Enterprise 档含 dedicated support；**中** [S25] | Apache-2.0 core；`ee/` 为 source-available Enterprise License；**中** [S6][S7][S8] | 1.0 于 2026-01-20；1.83.0 于 2026-11-13；约 2 个稳定版/周；**快速演进** [S24] | 中：workflow DSL/Agent API 为 Mastra 专有，但可 fork；生成物可从 Spec 重建 |
| **LangGraph** | Python 主实现；JS 独立包 | OSS 可自托管；Agent Server 另有 Cloud/BYOC/self-hosted/standalone；**强** [S29] | OSS 只有 checkpointer/thread_id；assistants/租户能力在 Agent Server；**中** [S29] | LangSmith Enterprise：SSO/RBAC/self-hosted/SLA；**强** [S30] | MIT [S26] | 1.2.22；1.x 稳定；2023 年起；**成熟** | 中：图 API + LangSmith 生态 |
| **PydanticAI** | Python | 库而非托管 runtime；自托管/air-gapped 明确支持；**强** [S37] | `deps` + conversation store；租户列/权限由应用决定；**中** [S37] | Pydantic Enterprise 24/7 + SLA；**强** [S37] | MIT [S32] | 2.68.0；v1 2025-09，v2 2026-06；**快速但 semver** | 低-中：Pydantic/标准 Python，迁移面较小 |
| **OpenAI Agents SDK** | Python + TypeScript | 库可自托管；**强** | session store；租户/权限自建；**弱** [S40] | OpenAI 商业支持；**强** | MIT [S38] | 0.24.0，仍为 0.x；**pre-1.0** | 中：Responses API/tracing 生态 |
| **Microsoft Agent Framework** | Python / .NET / Go | 可自托管；Foundry Hosted Agents 为 Azure 路径；**中** [S41] | Foundry hosting 有 per-user session 隔离；自托管靠应用；**中** [S41] | Microsoft/Azure；**强** | MIT [S41] | Python 1.26.0；2025 年起；**企业背书强** | 中：Azure/Foundry 生态 |
| **Google ADK** | Python / TS / Java / Go | 容器化/Cloud Run/Agent Runtime；**中** [S44] | session service 按 app/user/session；**中** [S45] | Google Cloud；**强** | Apache-2.0 [S44] | 2.14.1；约双周发布；**快** [S44] | 中-高：Gemini/GCP 生态 |
| **Vercel AI SDK** | TypeScript | 任意 JS runtime；无 server/控制面；**强** | `runtimeContext`/`toolsContext`；无内置租户；**弱** [S46] | Vercel 商业支持；**强** | Apache-2.0 [S46] | 7.0.173；生态大；**成熟** | 低-中：provider 抽象好；Workflow 另购/另配 |

**读表结论：**

- 在本次候选中，Mastra 是**集成度最高的 TS 方案**：graph workflow、snapshot 持久化、HITL、MCP server、memory、evals、OTel 在一个框架内。其他 TS 方案要么以 agent loop 为主（OpenAI Agents JS、Vercel AI SDK），要么主实现不在 TS（LangGraph/PydanticAI/MAF/ADK）。
- LangGraph 是**图/持久化最成熟**的方案，但 Python-first，且生产化的 Agent Server、tracing、evals 都指向 LangSmith 商业产品。
- PydanticAI 是**最完整的 Python agent-first 选项之一**，但“库”而非“一体化运行时”：没有内置 workflow runtime/deployer，durability 需要外部引擎。
- Vercel AI SDK 是**模型/流式/UI 工具包**，不是执行层；把它当 runtime 会缺 graph、durable、memory、evals。

---

## 3. 为什么是 Mastra

### 3.1 与生成物运行时对称，避免“工作台一套、客户侧另一套”

Issue #11 明确生成物包含 **Mastra agent/workflow 配置骨架**。[S4] 如果工作台自己也用 Mastra：

- 生成器、预览、校验、e2e 测试可以复用同一个运行时和同一套 DSL；
- FDE 只需要维护一种 Agent 运行时技能，不需要同时精通 Mastra + LangGraph/PydanticAI；
- 版本矩阵只需覆盖 Mastra 一条主线（外加 Semantica），而不是“工作台 Python runtime + 客户 Mastra runtime”两条线；
- 生成物在本地跑通的行为，与客户侧运行时的行为一致，减少“生成器测试通过、部署后失败”的语义漂移。

Issue #1 的设计原则是 **Spec 是唯一真相，生成物可重建**。[S1] 因此 Mastra 是“第一个 codegen target”，不是本体；Spec 仍保持 runtime-agnostic。这一点很关键：它把 Mastra 的锁定风险限制在“生成器适配层”，而不是污染领域模型。

### 3.2 一个框架覆盖 agent loop、workflow、HITL、MCP、memory、evals

Mastra 的 agent loop 不是独立于 workflow 的另一套循环，而是**一个 `dowhile` workflow**：

- `packages/core/src/loop/loop-builder.ts:88` 注释明确写 “Builds the agentic loop: an outer `dowhile` workflow wrapping a single-iteration workflow of ten steps”；
- 同一文件 `:777` 调用 `.dowhile(this.buildIterationWorkflow(), ...)`。[S5]

这意味着 workflow 的 suspend/resume、snapshot、HITL 原语可以复用到 agent loop，而不是“agent 一套、workflow 另一套”的两套语义。

workflow 控制流是完整的：`.parallel()`、`.branch()`、`.dountil()`、`.dowhile()`、嵌套 workflow。[S14] 对 FDE 工作台这种“先校验 Spec、再生成、再评测、再等人工批准、再部署”的流程，图工作流比纯 agent loop 更可控。

持久化方面：

- workflow 的 `suspend()` 会把执行状态保存为 snapshot，snapshot 持久化到 storage provider，**跨部署和应用重启**可 resume；[S13]
- 默认 libSQL，可配 Upstash/PostgreSQL/OracleDB，快照保存在 `workflow_snapshots` 表；[S12]
- agent 级 HITL 也用 snapshot 保存暂停状态，未配置 storage 会报 “snapshot not found”。[S11]

HITL 有两层：

- 工具级 `requireApproval: true` / `requireToolApproval`，流里出现 `tool-call-approval`，调用 `approveToolCall()`/`declineToolCall()` 继续；[S11]
- workflow 级 `suspend()` + `resume({ step, resumeData })`，适合审批节点、人工补充信息、外部回调。[S10]

MCP 是双向的：`MCPClient` 接远程 server，`MCPServer` 把 Mastra agents/tools/workflows/prompts/resources 暴露给其他 MCP 客户端；两者都支持 stdio 和 Streamable HTTP，协议版本 `2026-07-28`。[S15] 对“工作台生成物也要能被客户现有 Agent 调用”的场景，MCP server 是加分项。

memory 以 thread/resource 为作用域，`resourceId` 是线程 owner，创建后不可变；[S16] 这为 per-customer/per-user 隔离提供了原语，但不是自动的多租户安全边界（见风险）。

evals 内置 scorers、datasets、experiments、live evals 和 CI 集成；[S17] observability 产出 span，支持 Langfuse/Datadog/任意 OTel 兼容后端。[S18] 对“评测与溯源是一等公民”的设计原则，这是直接可用的基础设施，不需要再拼第三方的 eval 框架。

### 3.3 自托管/VPC 形态匹配

`mastra build` 把应用编译成独立 Node.js server；`.mastra/output` 是自包含的，可以拷到任意服务器直接运行；支持 Node 22.13+/Bun/Deno/Cloudflare。[S19] 这意味着：

- 不需要 Mastra Cloud 或控制面；
- 可以把整个 bundle 打进客户 VPC 的容器；
- storage、observability、model provider 都由客户环境配置；
- 每客户独立 bundle 的交付模型可行。

许可上，核心是 Apache-2.0；`ee/` 目录是 source-available 的 Mastra Enterprise License。[S6][S8] 只要不使用 EE 功能，v0 的运行时许可风险可控。

### 3.4 TS/Python 边界是“一个契约”，不是“到处双栈”

Semantica 是 Python，Mastra 是 TS，这个 split 无法消除。但它的边界可以收敛为一个服务契约：[S48]

- Semantica 的 MCP server 是 **stdio-only**，代码注释和 `run()` 都明确写 “reads JSON-RPC requests from stdin, writes to stdout”；[S49]
- Semantica 同时提供 FastAPI REST/Explorer API，支持 `SEMANTICA_API_KEY` 认证；[S50]
- MCP server 默认从空的内存图开始，只有设置 `SEMANTICA_KG_PATH` 才加载/持久化文件图；[S49] 它面向 IDE/桌面客户端，不是生产多租户 API；
- 生产应使用 REST + 配置好的图存储（Neo4j/FalkorDB 等），MCP 只用于本地开发/spike；Semantica 自带 Dockerfile、Compose 和 K8s/GCP/Azure 部署清单，适合按客户 VPC 部署。[S51]

Mastra 侧：

- `MCPClient` 支持 stdio 和 Streamable HTTP，HTTP 可配 `requestInit.headers`；[S15]
- `RequestContext` 可以把 tenant/user/trace 等请求级值传给 agent/workflow/tool；[S20]
- 但没有看到 Mastra span 到 Semantica PROV-O 的自动关联机制；需要在 REST header/MCP metadata 里显式传 trace ID/decision ID，并在 Semantica 侧落库。

换句话说：**双栈的成本主要不在“语言”，而在“契约设计”**。无论选 Mastra 还是 Python runtime，只要 Semantica 是独立服务，就要设计身份/trace/provenance 透传；选 Python runtime 只有在“Semantica 同进程”时才能省掉网络 hop，但会带来生命周期耦合和隔离问题（见 §6）。

### 3.5 社区与发布节奏

截至 2026-11-14：

- GitHub 29,514 stars、3,096 forks、770 个 open issue/PR；[S5]
- `@mastra/core` 1.0.0 于 2026-01-20 发布，1.83.0 于 2026-11-13 发布；1.0 以来约 96 个稳定版本，约 2 个/周；[S24]
- 仓库 HEAD 已经是 1.84.0-alpha.1，说明发布节奏很快。[S5]

这对“快速试错”是优势，对“给客户交付稳定运行时”是风险；因此版本治理是采用 Mastra 的前置条件，而不是事后补丁。

---

## 4. 关键风险与缓解

| 风险 | 证据 | 缓解 | 触发升级/重开的信号 |
|---|---|---|---|
| **1.x minor 也会破坏兼容** | `packages/core/CHANGELOG.md` 在 1.11、1.13、1.42、1.44、1.47、1.67、1.68、1.83 等 minor 版本都有 “BREAKING” 条目；例如 1.83 改了 plain `Agent` 的 `durable` 语义。[S23] | 锁精确版本（不用 `^`/`~`）；每月只升一次，升级前读 changelog；生成物做 contract tests；把 Mastra 包在内部 `AgentRuntime` 适配层后面 | 一个季度内 >2 次破坏性升级影响生成物；或升级需要改客户交付物 |
| **durable agent 仍是 beta** | 文档标注 “beta”，并写明 “Breaking changes may occur without a major version bump until the API is stable”。[S9] | v0 用稳定的 workflow snapshot + suspend/resume 做审批/恢复；不把 durable agent 放进关键路径；需要长流恢复时再评估 Inngest（Temporal runner 仍标注 experimental） | durable agent API 在 1.x 内再次 breaking；或生产事故与流恢复相关 |
| **EE 许可限制生产/再分发** | `ee/LICENSE` v2.0（2026-09-22 生效）规定 Enterprise Feature 只能 Development/Testing 免费使用；Production Use 需要书面协议 + License Key；未经协议不得向第三方复制、分发、出租或提供 EE 功能（包括作为 hosted/managed service）；License Key 可能在 build/deploy 阶段检查，且可能过期。[S7] | v0 不 import 任何 `ee/`；不用 RBAC/FGA/Agent Builder/Studio 第三方 SSO；在 CI 里 grep `ee/` import 和 `MASTRA_LICENSE_KEY`；需要 EE 时单独做法律/采购评估，并把“向客户交付”本身纳入许可审查 | 客户要求 SSO/RBAC/FGA；或 Mastra 把更多核心能力重新划入 EE |
| **多租户不是默认安全边界** | 文档明确警告：没有 server-enforced resource scoping 时，已认证调用者可以列出跨资源的 threads、读消息和 working memory；建议 `mapUserToResourceId` 或中间件设置可信 resource ID。[S21] FGA 是 EE。[S22] | v0 每客户独立 bundle；即使共享进程，也用 tenant-scoped storage key + `mapUserToResourceId` + 请求上下文校验；加跨租户访问测试 | 工作台变成共享多租户服务；或客户要求同进程多租户 |
| **Semantica 集成不是“接上 MCP 就行”** | MCP 是 stdio-only、默认内存图；[S49] REST 有 API key 和多组路由；[S50] 当前代码有 22 个 MCP tools，但 `docs/reference/mcp_server.md` 仍写 15 个，文档与代码有漂移。[S49] | 生产 REST-first；MCP 只用于本地/IDE；在 #5 spike 中实际测 REST 延迟、失败模式、租户/身份/trace 透传；版本矩阵锁定 Semantica | REST 延迟/事务不满足；或 Semantica MCP 增加 HTTP transport 且生产可用 |
| **成熟度：1.0 只有 10 个月** | 1.0 于 2026-01-20；770 个 open issue/PR；生产案例和长期支持记录少于 LangGraph。[S24][S5] | v0 范围控制；关键路径保留 fallback；不要在没有 spike 的情况下把 Mastra 作为唯一交付运行时 | 关键客户场景需要 LangGraph 级别的成熟度/支持 |
| **锁定：workflow DSL/Agent API 是 Mastra 专有** | Apache-2.0 可 fork，但生成的 workflow/agent 代码与 Mastra API 绑定。[S6] | Spec 为源；生成物可重建；适配层隔离 Mastra API；避免在 Spec 里暴露 Mastra 内部字段 | 生成物开始包含无法从 Spec 重建的手写 Mastra 逻辑 |
| **可观测/评测在自托管下要自己运营** | Mastra evals/observability 可用，但自托管没有 Mastra Cloud 的托管体验；需要自己配 storage/exporter。[S17][S18] | 用 OTel exporter 把 trace 送到客户已有后端；CI 跑 dataset/experiment；保留原始 eval 结果 | 客户要求托管 eval 平台/SLA |

---

## 5. 被淘汰或降级的方案

### 5.1 LangGraph：不淘汰，但降为“Python/workflow-heavy 备选”

**能力**：LangGraph 是本次候选中图/持久化最成熟的。checkpointer 以 `thread_id` 为 primary key，持久化图状态；`interrupt()` 暂停、`Command(resume=...)` 恢复，节点会从头重放，因此要求副作用幂等。[S27][S28] 这些语义清晰、生产验证多。

**不作为 v0 主选的原因**：

- Python 是主实现；JS 是独立仓库/包（`@langchain/langgraph` 1.7.4，约 3.4k stars），与 Python 版本的版本线、功能 parity 需要额外验证。[S26]
- 生产化的 Agent Server、assistants、auth、tracing、evals 都指向 LangSmith 商业产品；OSS 只给你图和 checkpointer，server/多租户/评测要自己搭。[S29][S30][S31]
- 对“生成物是 Mastra 配置”的工作台，选 LangGraph 会引入第二套运行时和第二种图 DSL；FDE 团队要同时维护 Python 工作台和 TS 生成物，系统摩擦高于 Mastra。

**什么时候选它**：团队 Python-first；工作台本身变成 Python 服务；workflow 复杂度/持久化要求高于“快速生成和预览”；或者 Mastra 的 breaking change 成为交付风险。它是比 PydanticAI 更接近 Mastra“workflow + durability + HITL”组合的 Python 替代。

### 5.2 PydanticAI：不淘汰，但降为“Python/agent-first 备选”

**能力**：PydanticAI 是很好的 Python agent 框架：类型安全、依赖注入、结构化输出、`requires_approval`/deferred tools、MCP client、`pydantic-evals`、OTel、9 种 durable execution 引擎。[S33][S34][S35][S37] 它明确支持 self-host/air-gapped，且不发送 usage telemetry；商业支持有 24/7 SLA。[S37]

**不作为 v0 主选的原因**：

- 它是**库，不是一体化运行时**：有 `Agent.to_web()` 这类 ASGI/chat UI 适配，但没有 Mastra 那种 graph workflow + snapshot + HITL + deployer 的一体化；HTTP/部署/运维层仍由应用自己负责。[S32][S37]
- 核心不内置 durable execution 引擎；durability 靠 Temporal/DBOS/Prefect/Restate/AWS Lambda 等外部引擎，或 Harness 的 `StepPersistence`。[S33] 对 v0 来说，这等于多一个基础设施依赖。
- `pydantic-graph` 是图/状态机库，不是带 checkpointer/server 的 workflow runtime；[S36] 复杂 workflow 仍要自己拼。
- 没有 TS 版本；如果工作台/生成物是 Mastra，选 PydanticAI 会把工作台 backend 推到 Python，同时客户侧仍是 TS，形成“工作台 Python + 生成物 TS”的双栈。

**什么时候选它**：团队 Python-first；工作台是 agent-first（对话式 Spec 起草、分析），不是 workflow-heavy；希望 Semantica 同进程调用；或者需要 Pydantic 生态/Logfire/SLA。它是“单栈 + 同进程 Semantica”的首选，但要把 durable execution 的引擎选型一起做掉。

### 5.3 OpenAI Agents SDK：明确不选

**能力**：Python + TS，agent loop、handoffs、guardrails、sessions、`needs_approval` + `RunState`、多传输 MCP、Dapr/Temporal/Restate/DBOS durability 集成。[S39][S40] 做 OpenAI-only 的快速原型很顺手。

**不选的原因**：

- 仍是 **0.24.0（0.x）**，API 稳定性不如 1.x/2.x 的候选。[S38]
- 没有 graph workflow 引擎；多步审批/长流程要靠 handoffs + 外部 durable 编排，工作台会自己长出一套 workflow 层。
- 内置 tracing 默认上报 OpenAI；自托管/VPC 场景必须显式关闭或换 processor，增加合规审查。[S40]
- evals 指向 OpenAI 平台，不是 OSS 内置；客户 VPC 内不可用或不可接受。[S40]

**什么时候考虑**：客户明确要求 OpenAI 生态、工作台只做轻量 agent、且能接受外部 durable 编排。

### 5.4 Microsoft Agent Framework：不选，但保留 .NET/Azure 场景

**能力**：MAF 有 graph-based workflows、checkpointing、HITL、time-travel、OTel、MCP client/server、Foundry hosting；Python 1.26.0，MIT，Microsoft 背书。[S41][S42] 对 .NET/Azure 客户是很强的选择。

**不选的原因**：

- 语言是 Python/.NET/Go，**没有 TS**；与当前工作台的 TS 形态不匹配。[S41]
- Foundry Hosted Agents、per-user session 隔离、Foundry evals 都偏 Azure；客户 VPC 自托管要自己接 hosting/session。[S41]
- 分布式 durable execution（Durable Task/Azure Functions）在独立扩展仓库，不在核心包；核心 workflow checkpoint 能跨进程恢复，但生产级 durable agent 仍要多一个组件。[S42][S43]

**什么时候重开**：客户/交付团队是 .NET/Azure 栈，或要求 Microsoft 企业支持。

### 5.5 Google ADK：不选，但保留 GCP/Gemini 场景

**能力**：ADK 2.14.1，Apache-2.0，Python/TS/Java/Kotlin/Go；graph workflow、routing/fan-out/loops、HITL tool confirmation、MCP toolsets、内置 eval CLI、Cloud Run/Agent Runtime 部署；双周发布。[S44][S45]

**不选的原因**：

- Python 是主实现；TS 版本（`@google/adk` 2.5.0，约 1.5k stars）明显小于 Python 生态，功能 parity 要验证。[S44]
- 部署和最佳体验偏 GCP（Cloud Run/Agent Runtime/Gemini）；客户 VPC 虽可容器化，但企业支持/评测/托管路径都偏 Google Cloud。
- 持久化恢复是“从 session history 重建已运行节点”，不是独立的 durable execution 引擎；崩溃恢复语义要额外验证。[S45]

**什么时候重开**：客户是 GCP/Gemini 栈，或需要 ADK 的 eval/部署工具链。

### 5.6 Vercel AI SDK：不选为执行层

**能力**：AI SDK 7.0.173，Apache-2.0，TS 生态最好的模型/流式/UI 工具包；`ToolLoopAgent`、tool approval、MCP client、OTel telemetry。[S46] 如果工作台需要 web UI/流式聊天，它很合适。

**不选的原因**：

- “Workflow Patterns”文档明确是**代码模式**（sequential/parallel/routing/evaluator-optimizer），不是图执行引擎。[S46]
- 没有内置 durable execution；要另配 Workflow SDK（Apache-2.0，5.5.0，可 Postgres self-host），多一个运行时和部署面。[S47]
- 没有内置 session/memory store、没有内置 eval 框架；这些要自建或接第三方。[S46]
- 把它当执行层，最终会拼成“AI SDK + Workflow SDK + 自建 memory + 自建 eval”，比 Mastra 的一体化多很多胶水。

**什么时候用**：作为工作台前端/流式层，或客户已有 Vercel/Next.js 栈；不建议作为 Agent 执行层。

---

## 6. TS/Python 双栈：哪种组合摩擦最小？

| 组合 | 语言/进程 | 集成 hop | 身份/trace | 部署 | 主要 failure mode | 团队匹配 |
|---|---|---|---|---|---|---|
| **A. Mastra TS + Semantica REST 服务（推荐）** | TS + Python，2 个进程 | Mastra → HTTP → Semantica → graph DB | `RequestContext` + REST headers；需显式传 trace/decision ID | 2 容器 + DB；每客户 bundle | 网络/超时/重试；跨服务 trace 断链 | TS 主、Python 辅 |
| **B. Python runtime（LangGraph/PydanticAI）+ Semantica** | Python（+ TS UI），1 个后端进程 | agent → 同进程 Semantica（或 HTTP） | 同进程/同 trace；最容易 | 1 个 Python 服务 + DB（+ UI） | 进程耦合；Semantica 资源与 agent 互相影响 | Python 主、TS 辅 |
| **C. TS runtime + 嵌入 Python sidecar** | TS + Python，1 容器 2 runtime | 进程内 spawn/stdio | 需自己传 env/stdio metadata | 单容器，但双 runtime | 进程监督、资源竞争、镜像体积 | 不推荐 |

**结论：对当前“生成物是 Mastra 配置”的工作台，A 的系统摩擦最小。**

原因不是“TS 比 Python 好”，而是：

1. 生成物已经是 Mastra，工作台用 Mastra 可以复用同一运行时、同一 DSL、同一版本矩阵；
2. Semantica 无论是 A 还是 B，只要作为独立服务，就都要设计 REST/MCP 契约；A 并不额外增加一个“语言契约”，只是把契约放在 HTTP 上；
3. B 的“同进程”优势只有在 Semantica 嵌入 agent 进程时才成立；但 Semantica 是有状态的图/检索服务，嵌入会耦合生命周期、内存和升级，生产上通常不推荐；
4. C 把两个 runtime 塞进一个容器，运维复杂度最高，只在客户强制单容器时考虑。

**如果团队是 Python-first**，B 更顺：工作台 backend、Semantica、评测都在 Python，TS 只做 UI；此时 LangGraph（workflow-heavy）或 PydanticAI（agent-first）比 Mastra 更合适。这个判断是“团队技能”优先于“生成物对称性”的例外。

---

## 7. 决策与后续动作

### 7.1 采纳

- **Mastra 作为 v0 的 Agent 执行层**，用于工作台自身的 agent 能力（如 AI 辅助 Spec 起草）和生成物中的 agents/workflows。
- **Mastra 作为生成物的默认运行时**，但 Solution Spec 保持 runtime-agnostic；Mastra 是第一个 codegen target。
- **每客户独立 bundle**：不为 v0 做共享多租户 Mastra 核心；这既匹配 VPC，也避开跨客户的 EE FGA 需求。

### 7.2 必须写进运行时契约/ADR 的约束

1. **版本锁定**：`@mastra/core` 及所有 `@mastra/*` 固定精确版本；生成器记录 Spec/模板/Mastra/Semantica 的版本矩阵；升级走月度窗口 + contract tests。
2. **EE 禁用**：CI 检查不出现 `ee/` import、`MASTRA_LICENSE_KEY`、RBAC/FGA/Agent Builder 配置；需要 EE 时单独做许可/法律评估。
3. **REST-first**：生产 Mastra → Semantica 用 REST；MCP 只用于本地/IDE；如果必须用 MCP，先补一个 HTTP transport wrapper，并在 #5 验证并发/多租户/失败模式。
4. **身份/trace/provenance**：Mastra `RequestContext` 携带 tenant/user/run/trace ID；REST header 透传到 Semantica；Semantica 侧把 decision ID/provenance 与 Mastra trace ID 关联；跨租户访问测试。
5. **存储隔离**：每客户独立 storage schema/database；共享进程时用 tenant-scoped `resourceId` + `mapUserToResourceId`；不依赖默认认证做隔离。
6. **可观测/评测**：OTel exporter 到客户后端；CI 跑 dataset/experiment；保留 eval 结果和生成物版本绑定。
7. **适配层**：工作台内部定义 `AgentRuntime`/`WorkflowRuntime` 接口，Mastra 实现放在 adapter 内；Spec 不暴露 Mastra 内部字段。

### 7.3 下一步

- **#5（Mastra ↔ Semantica spike）**：至少验证两条路径——REST（生产候选）和 MCP stdio（本地候选）；记录延迟、失败模式、身份/trace 透传、Semantica 22 个 tools 的实际可用性，以及 `SEMANTICA_KG_PATH`/图存储配置。[S2]
- **#8（运行时契约）**：把 REST/MCP、身份/trace/provenance、错误/重试/超时/流式/HITL 语义、部署拓扑写成契约；本文的 §6 和 §7.2 作为输入。[S3]
- **#12（多租户/部署拓扑）**：确认“每客户独立 bundle”是否成立；如果客户要求共享控制面 + 独立数据面，再评估 EE FGA 或自建 authz。
- **#7（Spec/工具形态）**：确认 Spec 是否保持 runtime-agnostic；如果 Spec 直接生成 Mastra 代码，锁定风险会上升。
- **CI 基线**：license grep、版本 pin 检查、生成物 contract tests、跨租户访问测试、Semantica REST 契约测试。

### 7.4 重开本决定的触发条件

- 团队主要是 Python 工程师，或无法长期维护 Node 运行时；
- 一个季度内 >2 次 Mastra 破坏性升级影响生成物；
- v0 就需要 EE 的 RBAC/FGA/SSO，且商业条款不可接受；
- Semantica REST 的延迟/事务/图查询在生产 spike 中不达标；
- 客户要求单容器/单进程，不能接受 Python 服务；
- 工作台从“生成器”变成共享多租户运行时。

### 7.5 留给父级的开放问题

1. 团队 TS/Python 人数比例与长期维护意愿？
2. 是否所有客户解决方案都必须是 Mastra，还是允许 polyglot（Spec runtime-agnostic）？
3. 客户 VPC 是否允许 Python 服务/容器，还是只允许单容器？
4. v0 是否需要 EE 的 RBAC/FGA/SSO？
5. 是否存在需要 exactly-once/长时工具调用的场景？如果有，durable agent + Inngest（Temporal runner 仍 experimental）要进入 v0 范围，而不仅是 workflow snapshot。

---

## 8. 来源

**项目上下文**

- [S1] Fdesforce #1：FDE 工作台 v0 系统设计地图 — https://github.com/0xnicholas/Fdesforce/issues/1
- [S2] Fdesforce #5：Mastra ↔ Semantica 最小集成 spike — https://github.com/0xnicholas/Fdesforce/issues/5
- [S3] Fdesforce #8：运行时与集成契约 — https://github.com/0xnicholas/Fdesforce/issues/8
- [S4] Fdesforce #11：样例 Solution Spec 与生成物骨架 — https://github.com/0xnicholas/Fdesforce/issues/11

**Mastra**（源码 commit `7277766d6c967c475675d58ff2d0e5c6d7be7c84`，2026-11-14）

- [S5] 仓库与源码：https://github.com/mastra-ai/mastra/tree/7277766d6c967c475675d58ff2d0e5c6d7be7c84
  - agent loop：`packages/core/src/loop/loop-builder.ts#L88`、`#L777`
  - `@mastra/core` package.json（Apache-2.0，1.84.0-alpha.1）：`packages/core/package.json`
- [S6] 根许可：https://github.com/mastra-ai/mastra/blob/7277766d6c967c475675d58ff2d0e5c6d7be7c84/LICENSE.md#L1-L16
- [S7] EE 许可 v2.0：https://github.com/mastra-ai/mastra/blob/7277766d6c967c475675d58ff2d0e5c6d7be7c84/ee/LICENSE#L1-L46
- [S8] 许可文档：https://mastra.ai/docs/license
- [S9] Durable agents（beta）：https://mastra.ai/docs/harness/durable-agents
- [S10] Workflow HITL：https://mastra.ai/docs/workflows/human-in-the-loop
- [S11] Agent HITL：https://mastra.ai/docs/agents/human-in-the-loop
- [S12] Workflow snapshots：https://mastra.ai/docs/workflows/snapshots
- [S13] Suspend and resume：https://mastra.ai/docs/workflows/suspend-and-resume
- [S14] Workflow control flow：https://mastra.ai/docs/workflows/control-flow
- [S15] MCP：https://mastra.ai/docs/connections/mcp
- [S16] Memory：https://mastra.ai/docs/memory/overview
- [S17] Evals：https://mastra.ai/docs/evals/overview
- [S18] Observability：https://mastra.ai/docs/observability/overview
- [S19] Mastra server deployment：https://mastra.ai/docs/deployment/mastra-server
- [S20] Request context：https://mastra.ai/docs/server/request-context
- [S21] Server middleware（user isolation）：https://mastra.ai/docs/server/middleware
- [S22] FGA（EE）：https://mastra.ai/docs/auth/fga
- [S23] Core changelog（breaking changes）：https://github.com/mastra-ai/mastra/blob/7277766d6c967c475675d58ff2d0e5c6d7be7c84/packages/core/CHANGELOG.md#L443
  - 另见 `#L12918`（1.68.0）、`#L14257`（1.67.0）、`#L26018`/`#L26257`（1.47.0）、`#L28076`（1.44.0）、`#L28730`（1.42.0）、`#L38226`（1.13.0）、`#L38668`（1.11.0）
- [S24] npm `@mastra/core` registry：https://registry.npmjs.org/@mastra/core
- [S25] Mastra pricing（Enterprise 含 dedicated support）：https://mastra.ai/pricing

**LangGraph / LangSmith**

- [S26] 仓库与 pyproject（MIT，1.2.22）：https://github.com/langchain-ai/langgraph/tree/08a2016953789a4f579b4d36bd1967941ec62012
  - `libs/langgraph/pyproject.toml`、`libs/langgraph/langgraph/types.py#L913`、`libs/checkpoint/langgraph/checkpoint/base/__init__.py#L199`
  - JS 包：https://github.com/langchain-ai/langgraphjs
- [S27] Persistence：https://docs.langchain.com/oss/python/langgraph/persistence
- [S28] Interrupts：https://docs.langchain.com/oss/python/langgraph/interrupts
- [S29] LangSmith Agent Server：https://docs.langchain.com/langsmith/deployment
- [S30] LangSmith pricing（Enterprise self-hosted/SLA）：https://www.langchain.com/pricing
- [S31] LangSmith evaluation concepts：https://docs.langchain.com/langsmith/evaluation-concepts

**PydanticAI**（源码 commit `fb64b4100c0882b4d5e1be8b9a38d7ae6b70c795`）

- [S32] 仓库与 pyproject（MIT，2.68.0）：https://github.com/pydantic/pydantic-ai/tree/fb64b4100c0882b4d5e1be8b9a38d7ae6b70c795
  - `Agent.to_web()`：`pydantic_ai_slim/pydantic_ai/agent/__init__.py#L4825-L4834`
- [S33] Durable execution：https://github.com/pydantic/pydantic-ai/blob/fb64b4100c0882b4d5e1be8b9a38d7ae6b70c795/docs/durable_execution/overview.md#L7
- [S34] Deferred tool calls / HITL：https://github.com/pydantic/pydantic-ai/blob/fb64b4100c0882b4d5e1be8b9a38d7ae6b70c795/docs/capabilities/handle-deferred-tool-calls.md
- [S35] MCP client：https://github.com/pydantic/pydantic-ai/blob/fb64b4100c0882b4d5e1be8b9a38d7ae6b70c795/docs/mcp/client.md
- [S36] Graphs：https://github.com/pydantic/pydantic-ai/blob/fb64b4100c0882b4d5e1be8b9a38d7ae6b70c795/docs/graph.md
- [S37] Evals/enterprise/OTel：https://github.com/pydantic/pydantic-ai/blob/fb64b4100c0882b4d5e1be8b9a38d7ae6b70c795/docs/enterprise.md

**OpenAI Agents SDK**（源码 commit `64fbde5d02b42ae5f9db668eb0184cdb3fc9d775`）

- [S38] Python 仓库（MIT，0.24.0）：https://github.com/openai/openai-agents-python/tree/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775
- [S39] HITL：https://github.com/openai/openai-agents-python/blob/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775/docs/human_in_the_loop.md
- [S40] Sessions/MCP/durable/tracing：以 `https://github.com/openai/openai-agents-python/blob/64fbde5d02b42ae5f9db668eb0184cdb3fc9d775/` 为 base，路径为 `docs/sessions/index.md`、`docs/mcp.md`、`docs/running_agents.md#L575`、`docs/tracing.md#L7`

**Microsoft Agent Framework**（源码 commit `92838b60498395142cb8b74693353163e95a0faf`）

- [S41] 仓库与 README（MIT，Python 1.26.0）：https://github.com/microsoft/agent-framework/tree/92838b60498395142cb8b74693353163e95a0faf
- [S42] Workflow checkpoint / MCP：以 `https://github.com/microsoft/agent-framework/blob/92838b60498395142cb8b74693353163e95a0faf/` 为 base，路径为 `python/packages/core/agent_framework/_workflows/_workflow.py#L307-L315`、`python/packages/core/agent_framework/_mcp.py#L4069`、`#L4353`
- [S43] Durable Task 扩展（独立仓库）：https://github.com/microsoft/agent-framework-durable-extension

**Google ADK**（源码 commit `287c0b0e65899b0060efd5672c8f419c1119530d`）

- [S44] 仓库与 README（Apache-2.0，2.14.1）：https://github.com/google/adk-python/tree/287c0b0e65899b0060efd5672c8f419c1119530d
- [S45] Workflow/HITL/eval：以 `https://github.com/google/adk-python/blob/287c0b0e65899b0060efd5672c8f419c1119530d/` 为 base，路径为 `docs/guides/workflow/workflow/index.md#L11`、`docs/guides/tools/tool_confirmation/index.md`、`docs/guides/evaluation/`

**Vercel AI SDK**（源码 commit `0e8e0543aeda7d4dd4ce6eade0d5b7d5a43644c1`）

- [S46] 仓库与 docs（Apache-2.0，7.0.173）：https://github.com/vercel/ai/tree/0e8e0543aeda7d4dd4ce6eade0d5b7d5a43644c1
  - `packages/ai/package.json`、`content/docs/03-agents/01-overview.mdx#L35`、`content/docs/03-agents/03-workflows.mdx#L8`、`content/docs/03-agents/06-tool-approvals.mdx#L8`、`content/docs/03-ai-sdk-core/16-mcp-tools.mdx#L11`
- [S47] Workflow SDK（Apache-2.0，5.5.0）：https://github.com/vercel/workflow

**Semantica**（源码 commit `1e14db0af8d78890b9a1513b49bef264cbb59e9b`，0.8.0）

- [S48] 仓库：https://github.com/semantica-agi/semantica/tree/1e14db0af8d78890b9a1513b49bef264cbb59e9b
- [S49] MCP server（stdio-only、默认内存图、22 tools）：以 `https://github.com/semantica-agi/semantica/blob/1e14db0af8d78890b9a1513b49bef264cbb59e9b/` 为 base，路径为 `semantica_mcp/mcp/server.py#L2`、`#L174`、`#L207`；`semantica_mcp/mcp/session.py#L4`、`#L64`、`#L84`；`semantica_mcp/mcp/tools/__init__.py#L15`
- [S50] REST/Explorer API（API key auth）：同 S49 base，路径为 `semantica/server.py#L223`；部署清单：`Dockerfile`、`deploy/kubernetes/`
- [S51] Semantica 部署：同 S49 base，路径为 `docker-compose.yml`、`deploy/kubernetes/`、`deploy/gcp/`、`deploy/azure/`

---

## 附：给父级更新 #1 “Decisions so far” 的一句话

> - [Agent 运行时选型](https://github.com/0xnicholas/Fdesforce/issues/3)：采用 Mastra 作为 v0 的 Agent 执行层与生成物默认运行时；每客户独立 bundle、锁定版本、禁用 EE；Semantica 生产走 REST，MCP 仅本地；Spec 保持 runtime-agnostic。
