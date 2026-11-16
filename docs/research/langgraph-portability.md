# LangGraph 运行时映射缺口：Acme Claims 参考场景

> 关联 ticket：[#16](https://github.com/0xnicholas/Fdesforce/issues/16) · 研究日期：2026-11-15 · 状态：研究 memo（#17 的输入，不是 ADR）
>
> 方法：以 `prototype/11-solution-spec-skeleton` 的 Acme `claims-triage` 样例 Spec 为输入，逐项映射到 LangGraph Python 与 LangGraph.js；对照 LangGraph 官方文档、源码、PyPI/npm/GitHub 元数据；Mastra 只作为比较基线，关键事实重新核对。没有实现 LangGraph generator，也没有运行 LangGraph 应用；本文中的代码片段是示意，不是可执行实现。检索日期均为 2026-11-15。

## 0. 结论

**推荐 (a)：v0 继续单运行时（Mastra only），不新增第二 generator，也不切换到 LangGraph。**

一句话理由：LangGraph 的图执行与 checkpoint 能力足以承载 Acme 参考场景，但 **OSS 库不是 server**；生产形态的 Agent Server 使用 Elastic-2.0 的 `langgraph-api`/`langgraph-runtime-inmem` 包，并引入 Postgres/Redis、license key 与 beacon egress。对 v0 的“单客户、air-gapped、稳定 Run API、审批/审计归 context-service”交付形态来说，第二 generator 的边际收益小于新增的拓扑、许可、扩展打包与迁移成本。

这不是否定 LangGraph。更准确的表述是：

- **v0 用 (a)**，但把 #16 的 gap matrix 与 #17 的 `RuntimeGenerator` / `RuntimeCapabilities` 端口一起做完，使 (b) 成为“已验证可开”的选项，而不是“改一个 `runtimeProfile` 字段”；
- **不建议 (c)** 直接切换：会丢掉 Mastra 侧已生成的 workflow/agent/tool 资产、`mastra-state` 的线程状态、内置 eval/observability 集成，并让 v0 的交付节奏绑定到 LangGraph 的 Python/JS 双路径与 Agent Server 许可问题；
- 如果未来做 (b)，**先做 LangGraph.js**，因为它的进程拓扑、Extension 打包（`ts-package`）和现有 Mastra bundle 最接近；只有团队 Python-first、或明确要把 context-service 与 runtime 合成单语言/单容器时，才选 LangGraph Python。

**会推翻本推荐的条件**（任一成立就应重开本决定）：

1. 交付团队长期以 Python 为主，不愿意维护 Node/TS 运行时；
2. 客户明确要求 Python-only、LangGraph 或其生态（例如已有 LangGraph 平台/技能栈），且不接受 Mastra；
3. Mastra 1.x 的破坏性升级在一个季度内超过 2 次并影响交付物；
4. v0 就需要 Postgres 级 checkpointer、HA/多 worker、time travel 或 LangGraph 的 checkpoint 语义；
5. 客户/团队接受 Elastic-2.0 的 Agent Server runtime 包/商业条款，或愿意为 OSS library + 自建 Run API 的工程量买单；
6. Mastra EE 的许可约束成为交付阻塞，且无法通过剥离 `ee/` 解决。

如果 (b) 被批准，应先满足：`RuntimeGenerator` 端口与 `RuntimeCapabilities` schema 已定（#17）；Workflow/HITL grammar 已定（#18）；record-before-act evidence 绑定已定（#20）；并且有一个客户或内部场景作为第二 generator 的验收对象。否则第二 generator 只是“多一套需要同步维护的模板”。

### 0.1 最大的五个缺口

1. **LangGraph OSS 不是 server。** 它只给你 graph + checkpointer；Run API、队列、取消、恢复 worker 都要自建。生产化的 Agent Server 依赖 Elastic-2.0 的 runtime 包，并引入 Postgres/Redis/license/egress，和 v0 的 air-gapped 两服务拓扑冲突。（§4.1、§6.1、§7）
2. **HITL 只有 interrupt/resume，没有审批资源。** 审批创建、角色/scope、过期、consume 都在 context-service；`interrupt()` 恢复时节点从头重跑，必须拆成 request/wait/commit，并做幂等与 reconcile。（§4.2）
3. **Extension 打包跨语言断裂。** `ts-package` 不能加载到 LangGraph Python；要么为 Python 增加 `python-wheel` tool/connector，要么把 Connector Tool 统一成 context-service 的 typed HTTP operation。`recipe`/`scorer` 不受影响，仍在 context-service/eval worker。（§5）
4. **`build.runtimeProfile` 不足以表达/校验能力。** 需要 runtime profile artifact + `RuntimeCapabilities` + Spec 推导要求 + 构建期 fail closed + `runtime-info` 结构化握手。（§7）
5. **Checkpoint/state store 不可跨 runtime 迁移，且 OSS 没有 Run registry。** checkpoint schema 是 runtime 私有、可能含 PII、默认不加密/无保留策略；切换 runtime 要 drain/重建，不能 resume 旧 Run。（§4.7、§6.2、§8）

次一级但同样需要决策的：OTel-only（不经过 LangSmith）没有 first-party 路径；eval 是外层 worker；Python/JS 是两条独立版本线，不能共用模板。

---

## 1. 范围与方法

### 1.1 在范围内

- 同一份 Acme `solution.yaml` 到 LangGraph Python / LangGraph.js 的逐项映射：Agent、Workflow、Tool、Connector、Capability、Extension、HITL、memory、semantic/context、eval、build/deploy。
- 两个 runtime 的语义差异：durable workflow、HITL approve/resume/consume、memory、trace/provenance、streaming、eval hooks、checkpoint/state store 与 Context Graph/audit 的边界。
- Extension 打包：`ts-package` / `python-wheel` / REST / sidecar；`recipe` / `scorer` 归属；是否需要 runtime-neutral Tool/Connector 协议。
- Bundle 拓扑：LangGraph Python vs JS；checkpointer/state store 与 context-service graph/audit；REST vs 合并进程；migrate/ingest；离线/air-gapped；单写者；secrets。
- Runtime profile、构建期校验、`runtime-info` 握手、contract/conformance tests。
- 从 Mastra bundle 切到 LangGraph bundle 的迁移/回滚风险。
- **给 #17 的 10 项 `RuntimeCapabilities` 差异矩阵**，以及每项能否被 `RuntimeGenerator` 端口吸收。

### 1.2 不在范围内

- 不实现 LangGraph generator 或可运行的 LangGraph app；不写生产代码。
- 不修改 ADR、`docs/runtime-contract.md`、`contracts/`、`docs/domain-model.md` 或 prototype 资产。
- 不做性能/容量 benchmark、HA/灾备验证、多租户、UI、真实客户数据。
- 不重新评估 Mastra 与 Semantica 的选型；Mastra 事实只作为基线。

### 1.3 方法与限制

- 以 `prototype/11-solution-spec/acme/solutions/claims-triage/solution.yaml`、`solution.lock`、`generated/claims-triage/` 为唯一输入场景，逐字段对照 `docs/runtime-contract.md` 的 D1–D15、§3 API、§4 真相源矩阵、§6 Decision/PROV-O、§7.4 record-before-act、§8 HITL、§9 bundle 拓扑、§10 版本/升级/回滚。
- LangGraph 事实优先使用官方文档与源码；版本用 PyPI/npm registry 与 GitHub Releases 核对；许可证用 wheel metadata 核对。
- 没有运行 LangGraph，因此本文对“能否工作”的判断是**静态映射 + 文档/源码证据**，不是运行时验证。凡属推断，均标为“推断”或列入 §10.2「未验证 / 开放问题」。
- Workflow/HITL step grammar 仍由 #18 决定；本文所有 `approval` step 的字段映射都是 **provisional (pending #18)**，假设见 §9.2。

### 1.4 版本锚点（2026-11-15）

| 组件 | 版本 / 事实 | 说明 |
|---|---|---|
| `langgraph`（Python） | **1.2.22**，2026-11-14 | MIT；Python >=3.10；依赖 `langchain-core>=1.4.7`、`langgraph-checkpoint>=4.3.0` [S41] |
| `langgraph-checkpoint`（Python） | **4.3.2**，2026-11-14 | `InMemorySaver`、序列化、`BaseCheckpointSaver` [S42] |
| `langgraph-checkpoint-postgres` | **3.2.1**，2026-11-14 | `PostgresSaver` / `AsyncPostgresSaver`、`PostgresStore` [S42] |
| `langgraph-checkpoint-sqlite` | **3.1.3**，2026-10-30 | `SqliteSaver` / `AsyncSqliteSaver` [S42] |
| `langgraph-cli` | **0.4.43**，2026-11-12 | MIT；`inmem` extra 拉 `langgraph-api` 与 `langgraph-runtime-inmem` [S43] |
| `langgraph-sdk`（Python） | **0.4.14**，2026-11-06 | 客户端 SDK [S43] |
| `langchain`（Python） | **1.5.0**，2026-11-11 | MIT；Python >=3.11；`create_agent` 所在包 [S52] |
| `langchain-mcp-adapters`（Python） | **0.3.2**，2026-08-06 | MIT；MCP 工具适配 [S52] |
| `@langchain/langgraph`（JS） | **1.7.4**，2026-11-12 | MIT；Node >=18；peer `@langchain/core ^1.3.4`、`zod ^3.25 或 ^4.2` [S46] |
| `@langchain/langgraph-checkpoint`（JS） | **1.2.2**，2026-10-30 | `MemorySaver`、`BaseStore`、`InMemoryStore` [S47] |
| `@langchain/langgraph-checkpoint-postgres`（JS） | **1.1.3**，2026-11-12 | `PostgresSaver`；`PostgresStore` 走 `./store` 子路径 [S47] |
| `@langchain/langgraph-checkpoint-sqlite`（JS） | **1.1.0**，2026-10-12 | `SqliteSaver`（同步） [S47] |
| `langchain`（JS） | **1.6.6**，2026-11-13 | MIT；依赖 `@langchain/langgraph ^1.6.1` [S53] |
| `@langchain/mcp-adapters`（JS） | **2.0.3**，2026-11-11 | MIT；MCP 工具适配 [S53] |
| `langgraph-api`（Agent Server） | **0.18.0** wheel，**Elastic-2.0**，Python >=3.11 | 依赖 `langsmith[otel]`、OpenTelemetry、`langgraph-runtime-inmem` [S44] |
| `langgraph-runtime-inmem` | **0.38.0**，**Elastic-2.0** | Agent Server 的 in-memory runtime [S45] |
| `@mastra/core` | **1.83.0**，Apache-2.0，Node >=22.13.0 | EE 目录另行 source-available [S62][S63] |

> 注意：LangGraph Python 与 JS 是两条独立版本线（1.2.x vs 1.7.x），不是同一个 semver；不要把 Python 的 `1.2.22` 与 JS 的 `1.7.4` 当成“同一版本的不同语言包”。LangGraph 1.0 于 2025-10-17 发布，JS 1.0 于 2025-10-18 发布；两者都已进入 1.x 稳定线，但 API/包边界不完全对齐（见 §4.8）[S51]。

---

## 2. 参考场景走查：Acme `claims-triage`

### 2.1 Spec 构造到 LangGraph 的总览

| Spec 构造 | LangGraph Python | LangGraph.js | 判断 |
|---|---|---|---|
| `spec.capabilities.document-triage` | 不是 runtime 对象；generator 维护 `capability_id → compiled graph` 路由表 | 同左 | **adapter**：必须显式声明 entrypoint，不能靠命名约定 |
| `spec.agents.triage-agent` | `langchain.agents.create_agent(...)` 返回一个 compiled graph；可作为节点/子图调用 | `createAgent(...)`（`langchain` 包） | **1:1**：instructions/model/tools 都有对应；`memory` 需要 schema |
| `spec.workflows.document-triage-flow` | `StateGraph(TriageState)` + nodes + edges；`approval` → `interrupt()`；`when` → conditional edge | `StateGraph` + `addNode` / `addConditionalEdges` | **adapter**：控制流 1:1，step grammar 需 #18 |
| `spec.workflows.*.durable: true` | `compile(checkpointer=...)`；`durability="sync"`（建议） | `compile({ checkpointer })`；`durability: "sync"` | **1:1**：能力存在，但恢复 worker 要 generator 提供 |
| `spec.workflows.*.steps[type=approval]` | `interrupt(payload)` + `Command(resume=...)`；拆成 request/wait/commit 三个节点 | 同左（`interrupt` / `new Command({ resume })`） | **new abstraction**：审批资源、过期、consume 不在 LangGraph |
| `spec.tools.retrieve-context` | 一个 `@tool` 函数，内部调用 context-service `/v1/context/retrieve` | 一个 `tool()`，同上 | **adapter**：builtin 由 generator 生成 |
| `spec.tools.claims-lookup` | 一个 `@tool`，内部调用 context-service 的 typed connector operation | 同左 | **new abstraction**：Connector operation contract（GAP-1） |
| `spec.tools.claim-decision` | 同上，但外包 record-before-act：intent → execute → outcome | 同左 | **adapter**：wrapper 可生成 |
| `spec.extensions[]` | `python-wheel`（tool/connector）；`recipe`/`scorer` 仍是 context-service/eval worker 的 Python 包 | `ts-package`（tool/connector） | **new abstraction**：Extension 必须声明 runtime 兼容与 artifact kind |
| `spec.semantic.*` | 不变：context-service REST + Context Recipe | 不变 | **1:1**：runtime 不碰 Context Graph |
| `spec.governance.evalSuites` | 无原生 eval；由外部 eval worker 调 Run API | 同左 | **adapter**：eval 是外层 |
| `spec.build.runtimeProfile` | 需要新的 profile artifact 形状（family/language/capabilities）；Spec 字段不变 | 同左 | **new abstraction**：profile 字符串不够 |
| `spec.environments.*` / `deployment.*` | 不变；拓扑由 generator 声明 | 不变 | **adapter/topology** |

### 2.2 Workflow：`context → triage → approval → commit`

参考 Spec 的四步（`solution.yaml:35-56`）在 LangGraph 里不是“一个节点一步”这么直接，原因有两个：

1. `interrupt()` 恢复时**从节点开头重新执行**，所以“创建审批请求”和“等待审批结果”必须拆成两个节点，否则恢复会重复创建审批；
2. `record-before-act` 的 intent Decision 必须放在审批通过之后、副作用之前，且不能被 `interrupt()` 的重放重复写入。

推荐的最小节点划分（示意，不是可执行实现）：

```python
# 示意：LangGraph Python。未运行；API 以 1.2.x 为准。
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.types import interrupt, Command

class TriageState(TypedDict, total=False):
    run_id: str
    claim_id: str
    context_digest: str
    triage: dict
    approval_id: str
    approval: dict
    decision: dict

def context_node(state: TriageState) -> dict:
    snapshot = ctx.retrieve(recipe_id="claims-context", query=state["claim_id"])
    return {"context_digest": snapshot["snapshot_digest"]}

def triage_node(state: TriageState) -> dict:
    result = triage_agent.invoke({"messages": [{"role": "user", "content": ...}]})
    return {"triage": result["structured_response"]}

def request_approval_node(state: TriageState) -> dict:
    # 幂等：Idempotency-Key 派生自 run_id + step id；重放不会创建第二条审批
    approval = ctx.create_approval(
        run_id=state["run_id"],
        capability_id="document-triage",
        proposed_action=f"approve claim {state['triage']['claimId']}",
        approver_roles=["claims-supervisor"],
        expires_at=...,
        evidence=[...],
    )
    return {"approval_id": approval["approval_id"]}

def wait_approval_node(state: TriageState) -> dict:
    # 恢复时节点从头执行；interrupt() 直接返回缓存 resume 值，不会重复 create_approval
    decision = interrupt({
        "approval_id": state["approval_id"],
        "proposed_action": ...,
        "approver_roles": ["claims-supervisor"],
        "expires_at": ...,
    })
    return {"approval": decision}

def commit_node(state: TriageState) -> dict:
    status = state.get("approval", {}).get("status", "auto-approved")
    if status not in ("approved", "auto-approved"):
        return {"decision": {"status": "skipped"}}
    intent = ctx.write_decision(phase="intent", evidence=..., policy_evaluations=[...])
    result = ctx.invoke_connector(
        connector_id="claims-db",
        operation="recordDecision",
        body={...},
        idempotency_key=intent["decision_id"],
    )
    ctx.write_decision(phase="outcome", parent_decision_id=intent["decision_id"], ...)
    return {"decision": result}

builder = StateGraph(TriageState)
builder.add_node("context", context_node)
builder.add_node("triage", triage_node)
builder.add_node("request_approval", request_approval_node)
builder.add_node("wait_approval", wait_approval_node)
builder.add_node("commit", commit_node)
builder.add_edge(START, "context")
builder.add_edge("context", "triage")
builder.add_conditional_edges(
    "triage",
    lambda s: "request_approval" if s["triage"]["amount"] > 100_000 else "commit",
    {"request_approval": "request_approval", "commit": "commit"},
)
builder.add_edge("request_approval", "wait_approval")
builder.add_edge("wait_approval", "commit")
builder.add_edge("commit", END)

graph = builder.compile(checkpointer=checkpointer)
```

恢复：

```python
graph.invoke(
    Command(resume={"status": "approved", "approval_id": "appr_...", "actor": {...}}),
    config={"configurable": {"thread_id": run_to_thread[run_id]}},
)
```

控制流补充：

- `branch` 映射为 `add_conditional_edges`；`parallel` 映射为同一 super-step 的多条 fan-out 边，或 `Send`（每个 item 独立输入，适合 map-reduce）[S26]；
- `Workflow` 可以作为独立 graph，也可以作为父 graph 的 subgraph；subgraph 的 checkpoint 在 `checkpoint_ns` 下隔离，父图不会自动看到子图内部状态 [S22][S28]；
- `Command` 除了 `resume`，还可以从节点返回 `update`/`goto`；但作为 `invoke` 输入时，只有 `Command(resume=...)` 是预期用法 [S23]。

这个形状暴露了三个超出 LangGraph 原生能力的点：

- **request/wait 拆分**：Spec 里的一个 `approval` step 在 LangGraph 里是“一个副作用节点 + 一个 interrupt 节点”，generator 必须知道这个展开规则；
- **expiry**：`interrupt()` 会无限等待（文档明确写“waits indefinitely” [S23]），审批过期必须由 context-service 的后台作业 + 生成器的 reconcile job 处理；LangGraph 没有 interrupt 超时；
- **consume**：`Command(resume=...)` 只有“恢复”语义，没有“审批已消费”语义。consume 必须由生成器在 resume 成功后调用 context-service，并做幂等重试；如果 resume 成功但 consume 失败，只能重试 consume，不能重放副作用 [S12 §8.2]。

JS 版本形状相同，只是 API 名字不同：

```ts
// 示意：LangGraph.js。未运行；API 以 1.7.x 为准。
import { StateGraph, START, END, interrupt, Command } from "@langchain/langgraph";

const waitApproval = async (state: TriageState) => {
  const decision = interrupt({ approvalId: state.approvalId, ... });
  return { approval: decision };
};
```

JS 1.x 还支持在 `StateGraph` 构造时声明 typed interrupts（`interrupts` 配置），用于给 `interrupt()` 的输入/恢复值做类型约束 [S54]。Python 侧对应的是 `interrupt(..., response_schema=...)`，支持 Pydantic/TypedDict/dataclass [S23]。两者语义一致，类型声明方式不同。

### 2.3 Agent、Tool、Connector、Capability

**Agent**：`create_agent` 是 LangChain 1.x 的当前入口，返回一个 compiled graph；`create_react_agent` 已在 LangGraph v1 中弃用，源码直接提示改用 `from langchain.agents import create_agent` [S38][S48]。因此 Agent 映射是 1:1 的：

- `modelProfile` → 生成器解析 Environment 后构造 model 实例；
- `instructions` → `system_prompt`；
- `tools` → LangChain tools；
- `memory` → checkpointer（thread 短期）+ Store（跨 thread 长期）；但 Fdesforce 的 `Agent.memory` 还没有 schema，这是 Spec 缺口，不是 LangGraph 缺口。

**Tool**：LangChain 的 tool 是“带 schema 的函数”。`builtin: retrieve_context` 映射为 generator 生成的 `@tool`，内部调用 context-service；`connectorRef + operation` 映射为另一个 generated tool，内部调用 context-service 的 typed connector operation。LangGraph 本身不提供 Connector 抽象；MCP 适配器也不能替代 Connector，因为 MCP 是工具发现协议，不是客户数据源的 typed operation + scope + idempotency 契约。

**Connector**：仍然归 context-service。原因不是 LangGraph 不能发 HTTP，而是 GAP-1 已经证明：同一个 Connector 要被 Python ingestion 和 TS/Python Tool 共用，唯一不分裂的接缝是 context-service 的 typed operation 端点 [S11][S18]。LangGraph Python 可以选择“同进程直接 import context-service”，但这会绕过 `ExecutionContext` 的 tenant/scope 强制与审计边界，详见 §6.3。

**Capability**：Capability 是业务契约，不是 runtime 对象。LangGraph 没有 Capability/Assistant 的概念（Agent Server 有 assistant，但那是商业 server 的配置单元）。generator 必须显式生成 `capability_id → graph entrypoint` 的映射；原型里 `run-service.ts` 硬编码 `document-triage → document-triage-flow`，这是一个已记录的 gap [S17]。

### 2.4 Extension、semantic、eval、build/deploy

**Extension**：这是最容易低估的差异。Fdesforce 当前模型是：

- `ts-package` → `tool | connector`，打进 Mastra app；
- `python-wheel` → `recipe | scorer`，打进 context-service/eval worker [S2][S13]。

对 LangGraph Python，`ts-package` 不能加载；对 LangGraph.js，`ts-package` 可以。`recipe` / `scorer` 不受 runtime 影响，仍然是 Python 包，归 context-service / eval worker。结论：要么为 LangGraph Python 增加 `python-wheel` 的 tool/connector，要么把跨语言 Tool 统一成 HTTP 调用 context-service。详见 §5。

**Semantic/context**：不变。LangGraph 节点只调用 context-service 的 `/v1/context/retrieve`，拿 `retrieval_id`、items、`snapshot_digest`、`degraded`；不把图事实写入 checkpointer，也不在 runtime 内缓存语义事实。Context Graph 仍是 context-service 的真相源；checkpointer 只存运行编排状态 [S12 §4.1]。

**Eval**：LangGraph OSS 没有 eval 子系统。官方路径是 LangSmith 的 datasets/experiments；也可以由外部 eval worker 调 Run API。Fdesforce 的评测架构本来就是“Bundle 只带 Eval Suite 定义/scorer，数据集客户侧，评测 worker 执行” [S3][S12]，所以 eval 可以留在 runtime 外；但它要求 runtime 暴露稳定的 Run API、trace/Decision 引用和可重放的输入。LangGraph 侧没有原生 eval hook，属于 **adapter**，不是 blocked。

**Build/deploy**：Mastra 有 `mastra build` 生成自包含 Node server [S61]；LangGraph OSS 没有等价的“build 成 server”的库内能力。`langgraph build` 是 CLI 为 Agent Server 构建镜像的路径，而 Agent Server 的 runtime 包是 Elastic-2.0 [S34][S44]。因此第二 generator 必须自己生成 app server（FastAPI/Express 等）+ Dockerfile + 部署清单；这不是不可做，而是工作量与责任从 runtime 转移到 generator。

### 2.5 哪些是 1:1，哪些需要新声明，哪些需要改抽象

**1:1（业务语义可以不变）**：

- Capability/Agent/Workflow/Tool/Connector 的业务含义；
- `instructions` / `modelProfile` / `tools` / `policyRefs` / `evalRefs`；
- Context Recipe 选择与 budget；
- Policy/Eval 引用、Environment 要求、Bundle/Release/Deployment 元数据。

**需要新的 runtime capability 声明（不是 Spec 业务字段）**：

- durable workflow、HITL、streaming、OTel、memory、tool calling、extension packaging、state store、topology、offline/air-gapped；
- 这些不是一个 `runtimeProfile` 字符串能表达的，需要 `RuntimeCapabilities` 清单 + 构建期 fail closed（见 §7）。

**需要改抽象（Spec/协议/端口）**：

- `capability_id → entrypoint` 的显式映射；
- Tool 的 implementation discriminator（`builtin | connector | extension | http`）；
- Extension 的 runtime 兼容与 artifact kind；
- Agent memory 的 schema；
- 审批 step 的字段与 context-service 审批资源的绑定（#18）；
- `solution.lock.runtime` 的 family/language/checkpointer schema；
- `runtime-info` 的结构化能力；
- Run registry / state store 的归属（OSS 库不提供）。

**blocked / 不可直接吸收**：

- 跨 runtime 复用 checkpoint（格式与序列化不同，见 §4.7）；
- LangGraph Python 直接加载 `ts-package` Tool（要么 python-wheel，要么 HTTP）；
- 纯 OTel（不经过 LangSmith）的 first-party 路径（未验证，见 §10.2）；
- air-gapped 场景下的 Agent Server（需要离线商业许可）。

---

## 3. Gap matrix

### 3.1 完整映射矩阵

难度标记：`1:1` = 语义与 API 都有直接对应；`adapter` = 需要生成的适配代码；`new abstraction` = 需要新增 Spec/协议/端口抽象；`blocked` = 当前约束下不能直接做，需要商业/架构决定。

| # | Spec / 协议字段或运行时关注点 | Spec 构造 | Mastra 映射（基线） | LangGraph Python | LangGraph.js | 难度 | 需要的新抽象 | 吸收层 | 证据 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Capability → 执行入口 | `spec.capabilities.*.implementation` | Capability Binding → Agent/Workflow；generator 维护映射 | 编译后的 graph 名；`create_agent` 返回的 graph | 同左 | adapter | `capability_id → entrypoint` 显式映射 | port + generator | 原型 `run-service.ts` 硬编码 [S17] |
| 2 | Agent | `spec.agents.*` | `new Agent`（instructions/model/tools/memory） | `create_agent`（system_prompt/model/tools/middleware）或 graph node | `createAgent`（`langchain` 包） | 1:1 | `Agent.memory` schema | generator | [S39][S48] |
| 3 | Workflow 控制流 | `spec.workflows.*.steps/branches/parallel` | `createWorkflow` / `createStep` / `.branch/.parallel` | `StateGraph` nodes/edges/conditional edges/`Send` | 同左 | adapter | step grammar（#18） | generator | [S26] |
| 4 | **durable workflow** | `durable: true`、`timeout` | workflow snapshot + `suspend()/resume()`，跨重启可恢复 | checkpointer + `durability`；`thread_id`；OSS 无自动 worker | 同左 | adapter | Run registry/reconciler；timeout 语义 | generator + topology | [S21][S22][S32] |
| 5 | **HITL** | `steps[type=approval]`（provisional） | `suspend()` / `resume({step,resumeData})`；跨重启 snapshot | `interrupt()` / `Command(resume=...)`；无审批资源/过期/consume | 同左；typed interrupts | new abstraction | 审批绑定 + resume/consume reconciler | port + generator + context-service | [S23][S12 §8] |
| 6 | **tool calling** | `spec.tools.*` | `createTool`；agent tools；MCP client/server | LangChain `@tool` / `StructuredTool`；MCP adapters | 同左 | adapter | Tool implementation discriminator | generator | [S39][S40] |
| 7 | Connector | `connectorRef + operation` | 无运行时接缝；原型自造 `/v1/connectors/...` | HTTP tool → context-service；无原生 Connector | 同左 | new abstraction | typed Connector operation contract | context-service + port | GAP-1 [S11][S18] |
| 8 | **extension packaging** | `interface: tool/connector/recipe/scorer`、`artifact_ref` | `ts-package` | tool/connector 需 `python-wheel` 或 HTTP；recipe/scorer 仍是 Python | `ts-package` | new abstraction | runtime 兼容 + artifact kind；HTTP sidecar | port + generator | [S2][S13] |
| 9 | **memory** | `Agent.memory`（未定 schema） | Mastra Memory（thread/resource、working memory） | checkpointer（thread 短期）+ Store（跨 thread 长期） | 同左 | adapter | memory schema / namespace / retention | generator + topology | [S21][S27][S57] |
| 10 | Semantic / context | `spec.semantic.*`、recipe bindings | REST context-service | REST context-service；可选同容器 | 同左 | 1:1 | 无（保持 REST） | context-service | [S12 §2–§4] |
| 11 | **streaming** | Runtime API SSE `RunEvent` | Mastra server stream + `writer` | `stream` / `stream_events` 多模式；OSS 无 HTTP/SSE | 同左 | adapter | SSE envelope / heartbeat 映射 | generator | [S24][S16] |
| 12 | Trace / provenance | `traceparent`、Decision/Provenance | OTel + context-service | LangSmith run tree/callbacks；W3C trace 需显式传播；审计仍走 context-service | 同左 | adapter | trace/run ID 映射 | generator + context-service | [S36][S37][S12 §6] |
| 13 | **OTel** | `deployment` 观测要求 | 原生 exporter；任意 OTel 兼容后端 | LangSmith-first；OTLP 经 LangSmith/collector；无 first-party OTel-only | 同左 | adapter / new abstraction | `observability` capability；OTel-only 需自定义 callback | generator + topology | [S36][S55][S58] |
| 14 | Eval hooks | `evalRefs`、Eval Suite | 内置 scorers/datasets/experiments | 无原生 eval；LangSmith 或外部 eval worker | 同左 | adapter | eval hook = Run API + trace | generator + context-service | [S59][S37] |
| 15 | **state store** | `mastra-state` / runtime state | libsql/SQLite/Postgres；workflow snapshots | SQLite/Postgres checkpointer；`checkpoints`/`checkpoint_writes` 表 | 同左 | adapter | state store manifest；schema 版本；加密/保留 | topology + generator | [S22][S49][S50][S64] |
| 16 | Run API / run registry | `/v1/runs`、状态、cancel | Mastra server + 生成 Run service | OSS 无；自建 wrapper 或 Agent Server | 同左 | new abstraction | Run registry/queue/cancel；或 Agent Server adapter | generator + topology | [S30][S32] |
| 17 | **topology** | `build.targets`、BundleTopology | Node app + context-service + `mastra-state`/`graph`/`audit` | Python/JS app + context-service + checkpointer 卷；可同容器 | JS 接近 Mastra | adapter / new abstraction | topology 声明 | port + generator + topology | [S12 §9][S11 GAP-4] |
| 18 | **offline / air-gapped** | `networkClass`、`targets: airgap` | Apache-2.0 OSS，离线 bundle | MIT OSS，离线 wheel；Agent Server 需 Elastic/离线许可 | 同左 | 1:1（OSS）/ blocked（Agent Server） | license/egress 元数据 | topology + license gate | [S34][S35][S44] |
| 19 | Runtime profile / capabilities | `build.runtimeProfile` | profile 字符串 + lock | profile 字符串 + lock；能力清单缺失 | 同左 | new abstraction | `RuntimeCapabilities` schema + 构建期校验 | port | [S2][S15] |
| 20 | 版本 / 升级 / 回滚 | lock、runtime profile、Release | stop-the-world；snapshot/audit 分离 | graph code 对已有 thread 立即生效；checkpoint schema 不跨 runtime | 同左 | new abstraction / blocked | runtime switch policy | topology + generator | [S29][S12 §10] |

### 3.2 10 项 `RuntimeCapabilities` 速查（给 #17）

| 能力 | Mastra | LangGraph Python | LangGraph.js | 建议级别 | 能否被 `RuntimeGenerator` 端口吸收 | 必须留给 generator / topology 的部分 |
|---|---|---|---|---|---|---|
| **durable workflow** | 强：workflow snapshot、跨重启 resume [S56] | 强：checkpointer + durability；恢复 worker 需自建 [S21][S22] | 同左 | must | 声明/校验可以；执行语义不能 | checkpointer 配置、恢复 worker、Run registry |
| **HITL** | 强：`suspend()/resume()`；审批资源仍在 context-service [S56] | 强：`interrupt()/Command(resume)`；无审批资源/过期/consume [S23] | 同左 | must | 同意图/事件可以；审批状态机不能 | request/wait/commit 展开、consume reconcile、expiry job |
| **streaming** | 强：server + stream [S61] | 原语强：values/updates/messages/custom/tasks；无 HTTP/SSE [S24] | 同左 | must | 事件形状可以；传输不能 | SSE 路由、seq、heartbeat、断线重连 |
| **OTel** | 强：原生 exporter、任意 OTel 后端 [S58] | 中：LangSmith/OTLP；OTel-only 未验证 [S36][S55] | 同左 | should（可降级） | 能力声明可以；实现不能 | exporter/collector 配置、trace 映射 |
| **memory** | 强：Memory thread/resource [S57] | 中：checkpointer + Store；语义更原语 [S21][S27] | 同左 | must（若 Agent 声明 memory） | 声明可以；策略不能 | namespace、retention、隔离 |
| **tool calling** | 强：tools + MCP [S60] | 强：LangChain tools + MCP adapters [S39][S40] | 同左 | must | 声明可以；生成不能 | tool schema 生成、Connector 接缝 |
| **extension packaging** | `ts-package` [S2] | `python-wheel` 或 HTTP；`ts-package` 不可用 | `ts-package` | must | 能力声明可以；加载不能 | artifact loader、runtime 兼容检查 |
| **state store** | libsql/SQLite/Postgres [S56][S64] | SQLite/Postgres checkpointer；schema 私有 [S49] | 同左 | must | 声明可以；schema 不能 | 卷/数据库、迁移、加密、单写者 |
| **topology** | Node + context-service；2 服务 | Python + context-service；可同容器 | JS + context-service；接近 Mastra | must | 拓扑清单可以；渲染不能 | BundleTopology、端口/卷、启动顺序 |
| **offline / air-gapped** | Apache-2.0，OSS 可离线 [S62] | MIT，OSS 可离线；Agent Server 需商业离线许可 [S35][S44] | 同左 | must（若 `networkClass: restricted`） | license/egress 声明可以；安装不能 | 离线包、镜像/ wheel 镜像、license gate |

> 结论：**端口可以吸收“声明、校验、事件/API 形状、测试入口”，不能吸收“checkpoint 格式、审批状态机、SSE 传输、Extension 加载、状态存储 schema、拓扑渲染”。** 后者必须由 generator + topology 实现；context-service 继续拥有审批、Decision/Provenance、Connector operation 和语义上下文。

---

## 4. 语义差异

### 4.1 Durable workflow：checkpoint 不等于 durable execution

LangGraph 的 durable 语义是：

- **thread** 是 checkpoint 的主键；`thread_id` 必须由调用方提供；PostgresSaver 的 `thread_id` 受列长度限制，文档建议保持在 255 字符以内 [S22]；
- 每个 **super-step** 边界写 checkpoint；节点内部的中间状态不会单独 checkpoint；失败时同一 super-step 内已成功节点的 writes 会保留（pending writes），恢复时不必重跑 [S22]；
- `durability` 有三档：`exit`（只在结束/中断/错误时写）、`async`（下一步执行时异步写，默认）、`sync`（下一步开始前同步写） [S22][S32]；
- 恢复用同一 `thread_id`：`graph.invoke(None, config)` 继续未完成的工作；`Command(resume=...)` 回答 interrupt；带旧 `checkpoint_id` 的 `invoke` 是 replay [S22][S25]；
- **time travel** 有两种：replay（从旧 checkpoint 重跑其后的节点，LLM/API/interrupt 都会重新执行）和 fork（`update_state` 后从分支继续）；interrupt 在 replay 时总会重新触发 [S25]；
- **checkpoint 不会自动恢复进程**。OSS 库只提供“从 checkpoint 继续”的能力；谁在进程崩溃后重新拉起 Run，是应用的责任。Agent Server 用 task queue + worker 解决这个问题 [S32]，但那是商业 server。

对 Fdesforce 的含义：

- `durable: true` 不能只映射成 `compile(checkpointer=...)`；还需要一个 **Run registry / reconciler**：记录 `run_id ↔ thread_id`、Run 状态、当前 approval、启动时扫描未完成 thread 并重新 `invoke(None, config)`；
- 对 record-before-act 与审批，建议 `durability="sync"`，否则进程在 checkpoint 写入前崩溃可能丢失“已批准/已执行”的边界；
- `timeout: PT5M` 不能直接映射成 graph 级 timeout。LangGraph 的 timeout 是 **node attempt** 级（Python 异步节点 / JS 节点），Run deadline 要由 wrapper 管；有审批的 workflow 更不能把 24h 等待算进 5min deadline。这个语义必须在 #18 的 grammar 里写清楚（是“活动执行预算”还是“墙钟时间”）；
- 节点恢复会**从节点开头重跑**，所以节点内的副作用必须幂等；文档明确建议把副作用放在 `interrupt()` 之后、或拆到独立节点 [S23]。这与 Mastra 的 step 级 resume 类似，但 LangGraph 的“整节点重放”更显式。

### 4.2 HITL：approve → resume → consume 的映射

Fdesforce 的审批是 context-service 的一等资源：`POST /v1/approvals` 创建，`POST /v1/approvals/{id}/decisions` 决定，`POST /v1/approvals/{id}/consume` 标记消费；审批本身写 Decision，`consume` 在 resume 成功后调用 [S12 §8]。LangGraph 只有 `interrupt()` / `Command(resume=...)`，没有 approval 资源、没有 expiry、没有 consume、没有 approver role 校验。映射表：

| Fdesforce 步骤 | LangGraph 原语 | 生成器必须补的 |
|---|---|---|
| Workflow 到达审批点，`POST /v1/approvals` | 无；放在 `request_approval` 节点 | 幂等创建审批；把 `approval_id` 写入 state |
| 发 `approval.required` SSE，Run `waiting_for_human` | `interrupt(payload)` | 从 interrupt payload 生成 SSE；更新 Run 状态 |
| 审批人 `POST /v1/approvals/{id}/decisions` | 无；context-service 处理 | 代理 API；把决定转成 `Command(resume=...)` |
| `resume()` | `Command(resume=value)` | 同一 `thread_id`；恢复后检查 `approval_id` |
| `POST /v1/approvals/{id}/consume` | 无 | resume 成功后调用；幂等重试；失败不重放副作用 |
| `rejected` / `expired` | resume 值或取消 | 过期作业；决定后走替代分支/结束 |
| 多个并行审批 | 多个 `interrupt()`；resume map 按 interrupt ID | 审批队列与 Run 状态聚合 |

关键差异：

- **interrupt 会无限等待**；过期只能由外部作业把审批标记 `expired`，再决定是 `Command(resume={"status":"expired"})` 还是 cancel Run [S23]；
- **同一节点多个 interrupt 按索引匹配**，恢复时不能条件跳过或重排；并行分支的多个 interrupt 用 ID 映射恢复值 [S23]；
- **子图 interrupt** 会从子图节点开头重放；如果子图有自己的 checkpointer，时间旅行/恢复粒度不同 [S28]；
- **审批决定本身**仍应写 context-service 的 Decision；LangGraph checkpoint 不是审计库，不能替代 [S12 §6]；
- **自审/角色/scope** 全在 context-service；runtime 只做代理，不能把审批权限下放到 graph state。

因此 HITL 的结论是：**LangGraph 能承载“暂停/恢复”的机制，但不能承载 Fdesforce 的审批契约**；需要 generator 的 approval adapter + context-service 的审批资源。这个 adapter 在两个 runtime 上都需要，不是 LangGraph 独有；但 LangGraph 的 interrupt 重放语义让“request/wait/commit 拆分”成为必须。

### 4.3 Memory：thread state 与 long-term store

LangGraph 有两套持久化：

- **checkpointer**：thread 作用域的图状态，支撑对话连续性、HITL、time travel、fault tolerance [S21]；
- **Store**：跨 thread 的任意 key-value，按 namespace 组织，可做语义检索；用于用户偏好、事实、共享知识 [S21][S27]。

映射到 Fdesforce：

- `mastra-state` 的“thread/memory”在 LangGraph 对应 checkpointer + Store；两者都属于**运行编排状态**，不是语义真相源 [S12 §4.1]；
- Agent 的 `memory` 目前没有 schema（domain model 只写 `memory`），第二 generator 会被迫猜：是 checkpointer 的 thread 记忆、Store 的 user 记忆，还是两者都有；需要 §9 的 `Agent.memory` 提案；
- Store 的 namespace 必须包含 `tenant_id` / `deployment_id` / `agent_id`，否则跨租户/跨 Solution 可能串记忆；LangGraph 的 namespace 只是 tuple，不强制隔离；
- Store 的值是 JSON dict，不是强 schema；PII/保留策略要由 generator/context-service 的 Policy 约束，不能依赖 LangGraph；
- checkpointer 默认不加密；可以用 `EncryptedSerializer` + `LANGGRAPH_AES_KEY`，但这是部署配置，不是默认 [S22]。checkpoint 里可能含 prompt、tool output、审批 payload，必须按 Fdesforce 的 classification/retention 处理；
- checkpoint 会随 thread 增长；文档明确建议 prune 或设置 retention [S21]。Fdesforce 的 30d/180d/3y 保留类需要生成器提供清理作业，LangGraph 没有内置保留策略 [S1]。

### 4.4 Trace / provenance：LangSmith run tree ≠ W3C trace + audit

LangGraph 的 tracing 是 LangSmith-first：设置 `LANGSMITH_TRACING` / `LANGSMITH_API_KEY`，trace 出现在 LangSmith；可以用 `tracing_context` 选择性开启、加 tags/metadata、用 anonymizer 脱敏 [S37]。OTel 路径是把 span 通过 OTLP 送到 LangSmith 的 `/otel` 端点，再由 collector fanout 到其他后端 [S36]。

Fdesforce 的 trace/provenance 是两套东西：

- **W3C `traceparent`**：mastra-app → context-service 的运维 trace；`trace_id` 必须与 JWT 的 `trace_id` 一致 [S12 §5–§6]；
- **Decision/Provenance**：context-service 的 append-only 审计库，PROV-O 导出，不采样、不可重建 [S12 §6]。

LangGraph 文档没有给出内建的 W3C trace 传播或 PROV-O 映射；它的 `run_id` / `trace_id` 是 LangSmith 的 run tree 标识，不是 Fdesforce 的 `run_<ULID>` / 32-hex trace ID。生成器必须：

- 从 Run API 的 `run_id` / `trace_id` 生成 langgraph config 的 `metadata`，在每个 context-service 调用里带 `traceparent`；
- 用 callback handler 或 OTel span 把 LangGraph 的 node/tool 事件映射到 Fdesforce 的 trace；不要让 LangSmith 的 ID 成为审计 ID；
- 继续让 context-service 写 Decision/Provenance；LangGraph checkpoint 只作为运行时状态，不能作为审计证据。

结论：trace/provenance 是 **adapter + context-service**，不是 LangGraph 能吸收的。LangSmith 可以作为可选的运维观测后端，但不能替代审计。

### 4.5 Streaming：stream mode 到 SSE 事件的映射

LangGraph OSS 提供 `stream` / `astream`（同步/异步迭代器），stream mode 有 `values`、`updates`、`messages`、`custom`、`checkpoints`、`tasks`、`debug`；`messages` 给 token chunk，`custom` 给 `get_stream_writer` 的自定义数据，`tasks` 给 task start/finish，`checkpoints`/`tasks` 需要 checkpointer [S24]。`stream_events(..., version="v3")` 还提供 `stream.messages`、`stream.values`、`stream.interrupted` / `stream.interrupts`、`stream.subgraphs` 等投影 [S23]。

Fdesforce 的 SSE 事件是固定的 `RunEvent`：`run.started`、`text.delta`、`text.done`、`tool.call`、`tool.result`、`approval.required`、`approval.decided`、`run.finished`、`run.failed`、`run.cancelled`、`heartbeat`，每条带 `run_id`、`trace_id`、`seq`、`timestamp`、`payload` [S16]。

映射建议：

| Fdesforce SSE | LangGraph 来源 | 生成器补的 |
|---|---|---|
| `run.started` | wrapper 在 invoke 前 | Run registry |
| `text.delta` | `messages` mode 的 chunk | 转 envelope；`seq` |
| `text.done` | `messages` 结束 / final state | 汇总 |
| `tool.call` | `tasks` / `debug` / callback `on_tool_start` | 工具名/参数摘要 |
| `tool.result` | `tasks` / callback `on_tool_end` | 结果摘要；错误 |
| `approval.required` | `interrupt` payload / `stream.interrupts` | 创建审批后发事件 |
| `approval.decided` | 无原生 | 审批 API 决定后发 |
| `run.finished` / `run.failed` / `run.cancelled` | wrapper | 状态机 |
| `heartbeat` | 无原生 | 15s 定时器 |

也就是说：**LangGraph 提供“流的内容”，不提供“Fdesforce 的 SSE 传输契约”**。OSS 库没有 HTTP server，更没有 `/v1/runs/{id}/stream`；Agent Server 有 `/stream`，但事件格式/端点与 Fdesforce 不同 [S32]。所以 streaming 必须由 generator 的 Run API wrapper 实现，不能直接暴露 LangGraph 的 stream。

### 4.6 Eval hooks

LangGraph OSS 没有 eval 子系统：没有 dataset、scorer、experiment、live eval 的包内 API。官方 eval 在 LangSmith（datasets/experiments/evaluators）；`langgraph-api` 也依赖 `langsmith[otel]` [S44]。社区有 `agentevals`（0.0.9，MIT），但仍是 0.0.x，不是 runtime 内建 [S52]。

Fdesforce 的评测是外层的：Eval Suite 定义/scorer 进 Bundle，数据集客户侧，评测 worker 调 Run API 并写 Evaluation/Decision [S3][S12]。因此：

- LangGraph generator 只需要保证 Run API 的输入/输出、trace/Decision 引用、可重放性；eval hook 可以是 **external**；
- 如果客户要求“runtime 内 live eval”，LangGraph 需要 LangSmith 或自建 callback/scorer，属于额外产品依赖；
- Mastra 的内置 scorers/datasets/experiments 是基线优势，但不是 Fdesforce v0 的必需项，因为 Fdesforce 自己就有 eval worker。

结论：eval 可以被端口吸收为 `eval.hooks: external`；不需要为了 eval 选 LangGraph 或 Mastra。真正需要验证的是 Run API 的输出是否足够稳定、是否能把 Decision 引用带出来。

### 4.7 Checkpoint / state store 与 Context Graph / audit

| 数据 | Fdesforce 真相源 | LangGraph 对应 | 边界 |
|---|---|---|---|
| 语义事实 | Context Graph（v0 embedded） | 无；只能通过 context-service 检索 | 不写入 checkpointer；不缓存为持久投影 |
| Decision / Provenance | Audit Store（append-only、哈希链） | 无 | checkpoint 不是审计；不能替代 |
| Retrieval Snapshot | Audit Store 的快照清单 | 无 | 只把 `retrieval_id` 放进 state/Decision |
| Run 生命周期 | `mastra-state` + runtime app | OSS 无；Agent Server 的 Postgres，或 generator 自建 | 需要 Run registry |
| Workflow snapshot | `mastra-state` | checkpointer（`checkpoints` / `checkpoint_writes` / `checkpoint_blobs`） | 独立卷/数据库；不参与图重建 |
| Thread / memory | `mastra-state` | checkpointer + Store | 运行状态；按 tenant/deployment namespace |
| Context Recipe | Bundle / CCP | 无 | runtime 只读 |
| Policy / Eval 定义 | Bundle | 无 | eval 外层 |

存储细节：

- Postgres saver 的表是 `checkpoint_migrations`、`checkpoints`、`checkpoint_blobs`、`checkpoint_writes`；主键分别是 `(thread_id, checkpoint_ns, checkpoint_id)`、`(thread_id, checkpoint_ns, channel, version)`、`(thread_id, checkpoint_ns, checkpoint_id, task_id, idx)`；`checkpoint_writes` 后续迁移加了 `task_path` [S49]；
- SQLite saver 是 `checkpoints` + `writes` 两张表，主键形状类似 [S42][S49]；
- JS 的 Postgres migrations 表名/列与 Python 基本一致，但序列化实现不同：Python `JsonPlusSerializer` 用 `ormsgpack`（msgpack），JS 用 JSON `stringify`/`load` [S50][S47]。**推断**：即使表结构相同，跨 Python/JS 直接读同一份 checkpoint 不应被视为受支持；没有官方跨语言迁移承诺。
- checkpointer 的 schema 是 runtime 私有实现，不是 `fde.runtime/v1` 契约；升级 LangGraph 可能新增迁移，回滚没有 down migration。切换 runtime 时不能复用旧 checkpoint。
- 每个 checkpoint 有 `checkpoint_ns`：根图是空字符串，子图是 `node_name:uuid`，嵌套子图用 `|` 连接；父图不会自动看到子图状态，需要共享状态时用 Store 或显式写回父图 [S22]。
- checkpointer 可能含 PII/prompt/tool output；默认不加密、无保留策略；需要 `EncryptedSerializer`/`LANGGRAPH_AES_KEY` 或应用层脱敏 + 清理作业 [S22]。

### 4.8 Python / JS parity

两者核心 API 形状相似，但不是完全对等：

| 维度 | Python | JS | 影响 |
|---|---|---|---|
| 版本线 | `langgraph` 1.2.22 | `@langchain/langgraph` 1.7.4 | 独立发布；不能假定同一版本功能相同 [S41][S46] |
| 运行时 | Python >=3.10（`langchain` 1.5 要 >=3.11） | Node >=18（Mastra 要 >=22.13） | 基础镜像/工具链不同 |
| Checkpointer | `InMemorySaver`、`SqliteSaver`/`AsyncSqliteSaver`、`PostgresSaver`/`AsyncPostgresSaver` | `MemorySaver`、`SqliteSaver`（同步）、`PostgresSaver` | JS 没有 `AsyncSqliteSaver`；生产建议 Postgres [S42][S47] |
| Store | `InMemoryStore`、`PostgresStore` | `InMemoryStore`、`BaseStore`；`PostgresStore` 走 `@langchain/langgraph-checkpoint-postgres/store` | JS 的 store 是子路径导出，generator 要写对 import [S47] |
| Interrupt | `interrupt(..., response_schema=...)` | `interrupt()` + `StateGraph({ interrupts })` typed config | 类型声明方式不同 [S23][S54] |
| Streaming | `stream`/`astream`、`stream_events(version="v3")` | `stream`、`streamEvents`；`toLangGraphEventStream` 已移除 | 生成器要分别写传输适配 [S24][S54] |
| Server | `langgraph-cli`/`langgraph dev`（Python >=3.11） | `@langchain/langgraph-cli`/`npx ... dev` | 都不是生产 server；生产是 Agent Server [S30][S34] |
| 生态 | LangChain Python 生态、Pydantic | LangChain JS 生态、Zod | Tool/Extension 打包不同 |

结论：如果做第二 generator，**不要写一个“LangGraph generator”然后指望 Python/JS 共用模板**；至少要有 `langgraph-py` 与 `langgraph-js` 两个 profile/template，或者只选一个路径。JS 路径的拓扑/Extension/Node 版本与现有 Mastra bundle 更接近；Python 路径的收益主要是语言统一和与 context-service 同容器。

---

## 5. Extension 打包

### 5.1 当前模型

Fdesforce 的 Extension 契约是：

- `interface`: `tool | connector | recipe | scorer`；
- `artifact_ref`: `ts-package`（tool/connector）或 `python-wheel`（recipe/scorer）；
- v0 不支持任意容器镜像 [S2][S13]。

这个模型是 **Mastra-centric** 的：`ts-package` 直接打进 Mastra app；`python-wheel` 打进 context-service/eval worker。它没有表达“这个 Extension 能被哪个 runtime 加载”。

### 5.2 四个选项

| 选项 | 做法 | 优点 | 缺点 | 适用 |
|---|---|---|---|---|
| A. `ts-package` only | Tool/Connector 都用 TS 包，LangGraph 只做 JS | 与现有 Mastra 一致；无跨语言 | LangGraph Python 不可用；Python-first 客户被排除 | 只做 LangGraph.js |
| B. 按 runtime 打包 | `ts-package` 给 Mastra/LangGraph.js；`python-wheel` 给 LangGraph Python | 类型安全、无网络 hop；各自原生 | 同一个 Tool 两份实现；版本/测试双倍；客户要维护两套 | 有明确 Python 客户且愿意维护双实现 |
| C. runtime-neutral HTTP | Tool/Connector 统一走 context-service 的 typed operation（或独立 sidecar） | 一份实现；跨语言；审计/权限/幂等集中；air-gapped 可本地 HTTP | 网络 hop；需要 typed operation 契约；sidecar 生命周期 | **推荐**，至少对 Connector |
| D. MCP | Tool 通过 MCP server 暴露 | 生态好；LangGraph/Mastra 都有 client | 契约只覆盖本地/IDE；没有 typed operation/scope/idempotency；不适合生产 [S12 D1] | 本地/IDE，不作为 Bundle 生产路径 |

### 5.3 推荐

1. **Connector-backed Tool 一律走 C**：context-service 暴露 typed connector operation 端点，生成器为每个 `connectorRef + operation` 生成一个薄 tool（TS 或 Python），内部带 `ExecutionContext`、`Idempotency-Key`、`traceparent`。这与 GAP-1 的默认方向一致 [S11]，也避免 Python ingestion 与 runtime tool 各写一套 Connector。
2. **纯计算 Tool** 可以按 runtime 打包（A/B）：如果它没有副作用、没有客户数据访问，`ts-package` 或 `python-wheel` 都可；但要在 Extension manifest 里声明 `runtimeCompatibility`。
3. **`recipe` / `scorer` 保持在 `python-wheel`**：它们属于 context-service / eval worker，不属于 runtime；LangGraph Python/JS 都不应加载它们。这个边界不变。
4. **Extension manifest 增加字段**（最小改动）：
   - `interface`: 保持 `tool | connector | recipe | scorer`；
   - `artifactKind`: `ts-package | python-wheel | http`；
   - `runtimeCompatibility`: `mastra | langgraph-py | langgraph-js | any-http`（数组）；
   - `operationContract`（connector 时）：input/output JSON Schema、sideEffects、scopes、idempotency；
   - `entrypoint`（tool 时）：函数/模块/URL。
5. **v0 不实现任意容器镜像 Extension**；如果未来需要 sidecar，作为 `http` 的一种部署形态，而不是新的 `interface`。

结论：**`ts-package` / `python-wheel` 不足以覆盖 LangGraph 双路径；需要一个 runtime-neutral 的 Tool/Connector HTTP 协议（或至少 typed operation 端点）。** `recipe` / `scorer` 的归属不需要改，它们本来就不在 runtime 里。

---

## 6. Bundle 拓扑

### 6.1 三种（加两种）拓扑

| 拓扑 | 组件 | State store | 许可 / 出网 | 适配度 |
|---|---|---|---|---|
| Mastra（现状） | `mastra-app`（Node）+ `context-service`（Python）+ `graph`/`audit`/`mastra-state` 卷 | libsql/SQLite/Postgres | Apache-2.0 OSS；无 license/egress | 基线 |
| LangGraph.js（split） | `graph-app`（Node）+ `context-service`（Python）+ `langgraph-state`/`graph`/`audit` 卷 | SQLite/Postgres checkpointer + Store | MIT OSS；无 license/egress | **最高**：与 Mastra 同构；`ts-package` 可加载，但 Tool API 需适配（Mastra `createTool` vs LangChain `tool`） |
| LangGraph Python（split） | `graph-app`（Python）+ `context-service`（Python）+ 卷 | SQLite/Postgres | MIT OSS；无 license/egress | 中：多一个 Python 服务；Extension 需 python-wheel/HTTP |
| LangGraph Python（同容器） | 一个容器内跑 graph app + context-service（两个 ASGI app 或同进程路由） | 同上 | 同上 | 中：少一个网络 hop，但生命周期/资源耦合；REST 边界仍在 |
| Agent Server（standalone/self-hosted） | API server + queue worker + Postgres + Redis；可选 LangSmith | Postgres（+ Mongo 可选） | **runtime 包 Elastic-2.0**；`LANGGRAPH_CLOUD_LICENSE_KEY`；beacon egress，air-gapped 需离线许可 | 低：拓扑/许可与 v0 不符；但省去自建 Run API/queue |

Agent Server 的事实：

- 它把 assistants、threads、runs、cron 存在 Postgres；checkpoints 与 store 也默认 Postgres；Redis 只做 pub/sub/取消/流式信号 [S32]；
- 一个 thread 同时最多一个 run 在执行；API server 与 queue worker 分离，可水平扩展 [S32]；
- standalone 部署需要 `LANGGRAPH_CLOUD_LICENSE_KEY`，并要对 `beacon.langchain.com` 出网做 license 校验/usage；air-gapped 要联系销售拿离线许可 [S34][S35]；
- `langgraph-api` wheel 的 license 是 **Elastic-2.0**，不是 MIT；`langgraph-runtime-inmem` 也是 Elastic-2.0 [S44][S45]。`langgraph-cli` 本身 MIT，但 `[inmem]` extra 会拉这两个包 [S43]。
- LangSmith 还列出 Cloud/BYOC/hybrid/self-hosted/standalone 等形态 [S33]；对 v0 只有 standalone/self-hosted 有现实意义，但都绕不开 runtime 包许可与（非 air-gapped）egress 检查。BYOC 只是数据面在客户 VPC，许可/控制面仍在 LangChain 侧。

因此，**v0 不应把 Agent Server 放进 bundle**：它会引入 Postgres + Redis + license + egress，与“单客户、单节点、air-gapped、两服务”的拓扑冲突。如果非要用，必须单独做许可/拓扑决策，不能藏在 runtime profile 里。

### 6.2 Checkpointer/state store vs Context Graph/audit

- **checkpointer/state store**：归 runtime app；保存 graph state、thread memory、pending writes、interrupt；是运行状态，可重建/可丢弃（但不是语义真相）。
- **graph**：归 context-service；可重建；存语义事实/检索；不存 Decision 的权威副本。
- **audit**：归 context-service；append-only、哈希链；不参与常规回滚；不能由 checkpoint 替代。
- 三者的卷/数据库必须分开；`audit` 单独备份，`graph` 可重建，`langgraph-state` 可在切换 runtime 时丢弃/归档。
- v0 单写者：SQLite checkpointer 只能一个进程写；Postgres 可以多 worker，但 Fdesforce v0 的 embedded graph 仍要求 context-service 单副本 [S12 §9.4]。不要把“Postgres checkpointer 支持多 worker”误当成“整个 bundle 可以多副本”。

### 6.3 REST 还是合并进程？

**推荐保持 REST**，即使 LangGraph Python 与 context-service 都是 Python。

理由：

1. 契约边界：context-service 独占 `/v1`，`ExecutionContext` JWT 在服务端强制 tenant/scope；合并进程容易变成“直接函数调用”，绕过 JWT/trace/审计强制点 [S12 D1–D5]。
2. 审计/审批所有权：审批状态、Decision/Provenance 在 context-service；runtime 只代理。合并后仍然要保留这条逻辑边界，否则回滚/替换 runtime 会污染审计。
3. 单写者/生命周期：context-service 的 embedded graph 是单写者；把它和 graph app 合并会让升级/重启耦合，runtime 的崩溃可能影响审计写入。
4. 可测试性：REST 契约可以独立 conformance；合并进程会把 runtime 测试和 context-service 测试绑在一起。

**可以接受的折中**：同一个容器/进程组里跑两个 ASGI app（或同一 FastAPI 挂两组路由），但仍然走 localhost HTTP + `ExecutionContext`。这减少一个容器/网络 hop，不改变契约。不要做“直接 import context-service 函数”的合并。这个折中应作为 topology 选项显式声明，而不是 generator 默认。

### 6.4 migrate / ingest / 启动顺序

LangGraph 拓扑的启动顺序：

1. `migrate`：context-service 的 graph/audit schema 迁移 + checkpointer 的 `setup()`/migration（`checkpoint_migrations`）；两者可以同一个 job，但必须分步、失败即停；
2. `context-service` 启动，`/readyz` 通过（graph/audit schema 匹配）；
3. `ingest` 物化 Context Graph（不阻塞 readiness；未完成时 `retrieve` 返回 `degraded`）；
4. `graph-app` 启动，`GET /v1/runtime-info` 握手通过，`/readyz` 通过；
5. smoke test：`POST /v1/runs`、流式、审批、Decision/Provenance。

checkpointer 的迁移是 runtime 私有的，不属于 `fde.runtime/v1`；Bundle 只需要声明“需要哪个 checkpointer schema 版本”，由 generator 的 migrate 脚本执行。回滚时 checkpointer schema 可能没有 down migration，因此**切换 runtime 不能靠迁移回滚**，只能保留旧卷/旧 bundle。

### 6.5 Offline / air-gapped

- **OSS 路径（推荐）**：LangGraph/ LangChain 的 wheel 与 npm tarball 可以 vendor 到离线包；模型 endpoint 用客户本地/私有部署；checkpointer 用本地 SQLite 或客户 Postgres；不需要 LangSmith；不需要 license/egress。这与 Mastra OSS 路径的离线模型一致 [S35][S62]。
- **Agent Server 路径**：需要 `LANGGRAPH_CLOUD_LICENSE_KEY`，非 air-gapped 还要 beacon egress；air-gapped 要离线商业许可 [S34][S35]。这与“客户 VPC 内自包含 bundle”不兼容，除非客户接受商业许可。
- `langgraph dev` 是本地开发 server，文档明确写“in-memory server designed for development and testing；production use LangSmith Agent Server”，且前置条件列了 LangSmith API key [S30]。不要把 `langgraph dev` 当成离线生产 runtime。
- `langgraph build` 是给 Agent Server 构建镜像的 CLI 路径；如果走 OSS library，generator 自己写 Dockerfile，不需要它 [S34]。

### 6.6 Secrets

- 模型 provider key：runtime app 的 secret；
- checkpointer DB 连接串：runtime app 的 secret（SQLite 时是卷，不是 secret）；
- `ExecutionContext` 私钥：如果保持 REST，仍在 runtime app；公钥在 context-service；
- Connector credentials：context-service（如果 Connector 走 typed operation）；runtime 不接触；
- LangSmith API key（如果启用）：runtime app；air-gapped 不应依赖；
- 审计/图加密密钥：context-service；
- 所有 secret 仍然只以 `secretRef` 出现在 Spec/Bundle，不进 lock/镜像/日志 [S12 §9.3]。

---

## 7. Runtime profile、校验与 contract tests

### 7.1 `build.runtimeProfile` 够不够？

**不够。** 它只解决了“引用哪个版本化 runtime 组合”的问题，没有解决：

- 这个 runtime **支持哪些能力**（durable/HITL/streaming/OTel/memory/tool calling/extension/state store/topology/offline）；
- 这个 runtime **需要什么语言/包/状态存储**；
- Spec 里的哪些构造**隐含了能力要求**（`durable: true`、`approval` step、`Agent.memory`、`airgap` target、`evalRefs`）；
- 构建期如何 **fail closed**，而不是等到运行时才发现少了一个能力；
- Extension 的 artifact kind 是否可加载；
- 运行时 `runtime-info` 如何二次握手，防止“镜像混装”。

当前 `runtimeProfile` 是一个字符串（如 `mastra-1.83-node26@^1.0.0`），lock 里解析出 Mastra/Node/Semantica/context-service 版本 [S2][S10]。这个形状可以保留，但 profile **artifact** 需要扩展，而不是把更多字段塞进 Spec。

### 7.2 建议的 runtime profile 形状

Runtime profile 由平台维护、版本化、内容寻址；Spec 仍只引用 `build.runtimeProfile`，不写 family/language/包版本。示意（YAML，不是最终 schema）：

```yaml
apiVersion: fde.dev/v0
kind: RuntimeProfile
metadata:
  name: langgraph-py312-1.2
  version: 1.0.0
spec:
  family: langgraph
  language: python
  runtimeVersion: 1.2.22
  contractVersion: 1.0.0
  packages:
    langgraph: 1.2.22
    langgraph-checkpoint-postgres: 3.2.1
    langchain: 1.5.0
    langchain-mcp-adapters: 0.3.2
  stateStore:
    kinds: [postgres, sqlite]
    checkpointerSchema: 4
    encryption: optional
  extensionArtifacts: [python-wheel, http]
  topologyModes: [split, merged-container]
  observability:
    otel: degraded
    langsmith: native
    evalHooks: external
  capabilities:
    durable_workflow: native
    hitl: adapter
    streaming: adapter
    memory: native
    tool_calling: native
    state_store: native
    offline: native
  licensing:
    runtime: MIT
    requiresLicenseKey: false
    egress: false
  support:
    offline: true
    airgap: true
```

`RuntimeCapabilities` 的建议 TypeScript 形状（给 #17 输入，不是最终接口）：

```ts
type Support = "native" | "adapter" | "degraded" | "none";

interface RuntimeCapabilities {
  family: "mastra" | "langgraph";
  language: "typescript" | "python";
  runtimeVersion: string;
  contractVersion: string;
  durableWorkflow: {
    support: Support;
    stateStores: Array<"sqlite" | "postgres" | "libsql">;
    durabilityModes: Array<"sync" | "async" | "exit">;
    autoResume: Support;          // OSS: none; Agent Server: native
  };
  hitl: {
    interrupt: Support;
    resume: Support;
    approvalResource: Support;    // LangGraph: none; context-service owns it
    expiry: Support;
    multipleInterrupts: Support;
    consume: Support;
  };
  streaming: {
    tokenStream: Support;
    toolEvents: Support;
    interruptEvents: Support;
    transport: Support;           // OSS: none; generator provides SSE
  };
  observability: {
    otel: Support;
    langsmith: Support;
    evalHooks: Support;
  };
  memory: { thread: Support; longTerm: Support; ttl: Support };
  tools: { native: Support; mcp: Support; connectorOperations: Support };
  extensions: { artifactKinds: Array<"ts-package" | "python-wheel" | "http"> };
  stateStore: {
    checkpointer: Support;
    schemaVersion: number;
    encryption: Support;
    retention: Support;
  };
  topology: {
    modes: Array<"split" | "merged-container" | "agent-server">;
    offline: Support;
  };
  licensing: {
    runtime: "MIT" | "Apache-2.0" | "Elastic-2.0";
    requiresLicenseKey: boolean;
    egress: boolean;
  };
}
```

### 7.3 Spec 隐含的能力要求

构建期应从 Spec 推导要求，而不是让 FDE 手写一份 capability 列表：

| Spec 构造 | 推导出的要求 | 缺失时 |
|---|---|---|
| 任意 Workflow 有 `durable: true` | `durableWorkflow.support != none`；state store 可用 | build fail |
| 任意 `approval` step | `hitl.interrupt/resume != none`；context-service approval API 可用 | build fail（#18 定稿后） |
| 任意 `step.type == agent` 且有 `memory` | `memory.thread/longTerm` 至少一个可用 | build fail |
| 任意 `tool.sideEffects != read` | tool calling + record-before-act wrapper；审计端点可用 | build fail |
| `build.targets` 含 `airgap` 或 Environment `networkClass: restricted` | `topology.offline == native`；无 license/egress | build fail |
| `evalRefs` 非空 | `observability.evalHooks` 至少 `external` | warning 或 fail（按 Policy） |
| Runtime API 总是要求 SSE | `streaming.tokenStream/toolEvents/interruptEvents` 至少 adapter | build fail |
| Extension `interface: tool/connector` | `extensions.artifactKinds` 覆盖 artifact | build fail |
| `connectorRef` 非空 | context-service typed operation（不是 runtime capability） | build fail（GAP-1 未解时） |
| `deployment` 要求 OTel | `observability.otel != none`；否则显式降级/waiver | build fail 或 Policy waiver |

### 7.4 构建期 fail-closed 规则

1. 从 `solution.lock` 解析 `runtime.profile` 的 digest；profile 不存在/不可验证 → fail。
2. 计算 Spec 要求（§7.3）与 profile 的 `capabilities` 取交集；任何 `must` 能力为 `none` → `runtime_capability_missing`。
3. Extension artifact kind 不在 `extensions.artifactKinds` → `runtime_extension_unsupported`。
4. `stateStore.kinds` 与 Environment 选择的后端不匹配 → `runtime_state_store_unsupported`。
5. `topologyModes` 不包含 Bundle 需要的拓扑（split/merged/agent-server）→ `runtime_topology_unsupported`。
6. 许可证 gate：profile 的 `licensing.runtime` 是 `Elastic-2.0` 时，必须有显式许可决策/waiver 和 `licenseKey` secretRef；否则 fail（`runtime_license_blocked`）。这与 Mastra EE 的 license gate 同类 [S2][S62]。
7. `contractVersion`/`graphSchema`/`auditSchema` 不匹配 → fail；启动时 `runtime-info` 再握手一次 [S12 §10.1]。
8. 所有包精确 pin；lock 里记录 `family`、`language`、`packages`、`stateStore`、`checkpointerSchema`，而不是只记录 `mastra/node/python` 字段。

### 7.5 `runtime-info` 握手

当前 `runtime-info` schema 的 `service` enum 只有 `mastra-app`/`context-service`，`capabilities` 是 `string[]` [S15]。这对 LangGraph 不够：

- `service` 需要能表达 `graph-app` / `langgraph-app`，或者统一为 `runtime-app`；
- `capabilities` 需要结构化，至少能表达 `native/adapter/degraded/none`，而不是“有/没有”；
- 需要 `runtime.family` / `language` / `state_store` / `topology` / `license` 字段，以便启动时 fail closed。

建议兼容性方案：

- 保留 `capabilities: string[]`（v1 客户端不破坏）；
- 新增 `runtime` 对象和 `capability_details`（additive，v1.1）：
  ```json
  {
    "contract_version": "1.1.0",
    "service": "runtime-app",
    "runtime": {
      "family": "langgraph",
      "language": "python",
      "version": "1.2.22",
      "state_store": "postgres",
      "topology": "split"
    },
    "capability_details": {
      "durable_workflow": {"support": "native"},
      "hitl": {"support": "adapter"},
      "streaming": {"support": "adapter"},
      "observability": {"otel": "degraded", "langsmith": "native", "eval_hooks": "external"}
    },
    "capabilities": ["runs", "streaming", "approvals", "otel"]
  }
  ```
- `components` 增加 `runtime-app`、`langgraph-state`；`backend.graph/audit` 保持；
- 启动时校验：`runtime.family/language` 与 lock 一致；`capability_details` 覆盖 lock 的 requirements；`state_store` 与部署配置一致；license 状态有效。

这不是“让 context-service 感知 runtime”；`runtime-info` 是 runtime app 的握手端点，context-service 只返回自己的版本/能力。两边各自握手，Run API wrapper 聚合。

### 7.6 Conformance cases

现有 `contracts/conformance/cases.md` 的 C1–C15 是 context-service / runtime contract 的用例 [S14]。第二 generator 需要增加 adapter 级用例（编号建议 A1–A10），并复用 C1–C15 中适用的部分：

| ID | Case | 期望 | 适用 |
|---|---|---|---|
| A1 | Runtime capability handshake | profile 的 must 能力都在 `runtime-info` 中出现；缺失时启动 fail closed | 所有 runtime |
| A2 | Run API parity | `POST /v1/runs`、`GET /v1/runs/{id}`、`cancel`、`stream` 的请求/响应/错误 envelope 与契约一致 | 所有 runtime |
| A3 | HITL round trip | 审批创建 → `approval.required` → approve → resume → consume；拒绝/过期路径 | 所有 runtime |
| A4 | Record-before-act | intent Decision 失败时 Tool 不执行；outcome 关联 intent；重试不产生第二条审计 | 所有 runtime |
| A5 | SSE envelope | `seq` 单调、`run_id`/`trace_id` 存在、heartbeat ≤15s、事件类型齐全 | 所有 runtime |
| A6 | Restart resume | 进程重启后未完成 Run 从 checkpoint 恢复；已完成的节点不重跑 | LangGraph、Mastra |
| A7 | Approval expiry / cancel | 过期审批写 Decision；Run 进入结束/替代分支；cancel 产生 `run.cancelled` | 所有 runtime |
| A8 | Tenant/trace propagation | `ExecutionContext` 的 tenant/scope 强制；`traceparent` 与 JWT `trace_id` 一致 | 所有 runtime |
| A9 | Extension load | 声明的 artifact kind 能被加载；不兼容时 build fail，而不是运行时 500 | 所有 runtime |
| A10 | Offline install | 无公网/无 license/egress 的 bundle 能启动；需要 license 的路径显式失败 | 所有 runtime |

这些用例应该由 `RuntimeGenerator.generateContractTests()` 生成，并在 CI 中按 profile 跑；`fde verify` 也应重跑。C1–C15 继续由 context-service 实现负责，A1–A10 由 generator 负责，两者不要在同一个 suite 里混。

### 7.7 `RuntimeGenerator` 端口（给 #17 的输入）

本文不定义最终接口；从映射结果看，端口至少需要：

```ts
interface RuntimeGenerator {
  capabilities(profile: RuntimeProfile): RuntimeCapabilities;
  validate(spec: SolutionSpec, profile: RuntimeProfile): ValidationResult;
  generateApp(input: GenerateInput): GeneratedApp;
  generateManifests(input: GenerateInput): BundleTopology;
  generateMigrations(input: GenerateInput): MigrationPlan;
  generateContractTests(input: GenerateInput): TestPlan;
}
```

`generateApp` 的输出应是“可重建的源码 + Dockerfile + 启动命令”，不是二进制；`generateManifests` 输出单一 `BundleTopology`，Compose/Helm/airgap 从它渲染；`generateMigrations` 同时覆盖 context-service 的 graph/audit 和 runtime 的 checkpointer；`generateContractTests` 输出 A1–A10 的映射。这个形状与 #17 的 `generateApp/generateManifests/generateContractTests/capabilities` 基本一致 [S6]。

---

## 8. 迁移与回滚风险

从 Mastra bundle 切到 LangGraph bundle，不是“换镜像”，而是**换运行时、换状态存储、换 Extension 加载方式、换拓扑**。风险按严重度排序：

| 风险 | 影响 | 缓解 | 可逆性 |
|---|---|---|---|
| **在途 Run** | LangGraph 不能读 Mastra 的 workflow snapshot；旧 Run 无法在新 runtime 继续 | stop-the-world：停止新 Run，drain 或 cancel 在途 Run；记录 Decision；新 runtime 从新 Run 开始 | 不可逆（旧 Run 只能回旧 bundle 完成） |
| **待审批** | 审批在 context-service，但 resume 依赖旧 runtime 的 snapshot；新 runtime 无法 resume | 切换前批准/拒绝/取消所有 pending；过期作业先跑完；新 runtime 不接受旧 approval_id | 部分可逆：审批记录保留，执行需重跑 |
| **Checkpoint / state store** | LangGraph 表结构/序列化与 Mastra 不同；跨语言也不保证 | 旧 `mastra-state` 卷保留只读；新 `langgraph-state` 空库；不尝试转换；归档旧卷 | 可回滚到旧 bundle + 旧卷 |
| **Thread memory** | Mastra thread 记忆不能导入 LangGraph checkpointer/Store；thread_id 可能冲突 | 新 runtime 新 namespace；不复用旧 thread_id；如需保留对话，导出 transcript 作为附件，不写入 runtime state | 不可逆（记忆不迁移） |
| **Graph rebuild / 升级** | LangGraph 对已有 thread 立即应用最新 graph code；重命名/删除暂停节点会导致 resume 失败 [S29] | 升级前 drain；保持 node 名/state schema 兼容；add-then-remove；不跨大版本改 graph 名 | 可回滚到旧 bundle，但旧 checkpoint 可能已被新代码触碰 |
| **Audit / provenance** | context-service 审计独立，不随 runtime 回滚；新 runtime 的 Run ID 与旧审计不连续 | 写一条迁移 Decision；新 Run 新 ID；审计链保留；不把 checkpoint 当审计 | 审计不回滚；连续可验证 |
| **Bundle 切换** | 新 runtime = 新 generator + 新 bundle；旧 Release 不能“改字段”变成新 runtime | 新 runtime profile + 新 Bundle + 新 Release；旧 Release 保留；stop-the-world；contract tests | 可回滚到旧 Release + 旧卷；新 Release 标记 superseded |
| **客户端 Run API** | 如果暴露 LangGraph 原生 API/Agent Server API，客户端契约断裂 | 生成 wrapper 保持 `/v1/runs`/SSE/approval API；不暴露 LangGraph 原生 API | 可逆（wrapper 层） |
| **License / air-gapped** | Agent Server 的 runtime 包是 Elastic-2.0；需要 license key/egress，离线要商业许可 | v0 只用 OSS library；Agent Server 单独立项；license gate 拦 | 可逆（不部署 Agent Server） |
| **Rollback** | 旧 bundle 的 checkpointer schema 可能已被新版本迁移；没有 down migration | 升级前快照；旧 bundle + 旧卷一起回滚；不可逆迁移显式拒绝 | 取决于迁移是否可逆 |

**推荐的切换顺序**（如果未来批准 (b)）：

1. 冻结 Spec/Release，生成 LangGraph bundle 和迁移计划；
2. 公告维护窗口；停止新 Run；
3. 处理 pending approvals（批准/拒绝/取消），等待过期作业；
4. drain 在途 Run；无法 drain 的 cancel，并写 Decision；
5. 备份 `graph`、`audit`、`mastra-state`，记录 `chain_head`；
6. 部署新 bundle：`migrate` → `context-service` ready → `ingest` → `graph-app` ready → `runtime-info` 握手；
7. smoke test：Run、SSE、审批、Decision/Provenance、record-before-act；
8. 标记 Deployment active；写 Deployment Revision 和迁移 Decision；
9. 保留旧 bundle/旧卷至少一个保留周期，用于回滚。

**回滚**：

- 只回滚到同一 runtime family 的旧 Release；跨 runtime 回滚等于再切一次 runtime，需要同样的 drain/备份；
- 旧 checkpoint 卷必须还在；如果新 runtime 已经写过 `langgraph-state`，回滚到 Mastra 不影响它，但 Mastra 也不会读它；
- 审计不回滚；回滚本身写一条 Decision；如果迁移不可逆且没有快照，显式拒绝回滚 [S12 §10.5]；
- 客户端 Run API 保持稳定，回滚对客户应用透明（除了在途 Run 被 cancel）。

---

## 9. 最小 Spec 抽象改动建议

原则：**Spec 只增加“作者需要表达的业务/治理要求”，不增加 runtime 内部字段**；能由 runtime profile 表达的，不放进 Spec；能由 generator 推导的，不让 FDE 手写。

| # | 改动 | 为什么 | 消费方 | 依赖 |
|---|---|---|---|---|
| P1 | Runtime profile artifact 增加 `family/language/packages/stateStore/topology/licensing/capabilities`；Spec 仍只写 `build.runtimeProfile` | `runtimeProfile` 字符串不足以声明/校验能力 | #17、generator、build | 无 |
| P2 | 可选 `spec.build.requirements`（仅非推导项，如 `observability: otel-only`、`offline: true`） | 少数客户要求无法从 Spec 推导；默认不写 | #17、build | P1 |
| P3 | `spec.capabilities.*.implementation` 增加显式 `entrypoint`（或 generator 生成 `capability_id → graph` 映射） | 原型硬编码映射；第二 runtime 不能靠命名约定 | #7、#17、generator | 无 |
| P4 | `spec.tools.*` 增加 implementation discriminator：`builtin` / `connector` / `extension` / `http` | 当前 `connectorRef` 可选、builtin/Extension 不可寻址 | #7、#17 | GAP-1 |
| P5 | Connector 增加 typed operation manifest（input/output schema、scopes、idempotency、sideEffects） | `connectorRef + operation` 无法生成可执行 Tool | #7、#17、#12 | GAP-1 / #17 |
| P6 | `spec.extensions[]` 增加 `artifactKind` + `runtimeCompatibility` | `ts-package` 与 LangGraph Python 不兼容 | #7、#17 | P1 |
| P7 | `spec.agents.*.memory` 增加 schema：`shortTerm`（thread/none）、`longTerm`（store/none）、`namespace`、`retention` | 当前 `memory` 无形状；两个 runtime 都无法生成 | #7、#17 | 无 |
| P8 | `spec.workflows.*.steps[type=approval]` 的字段与 context-service 审批资源绑定：`proposedAction`、`approverRoles`、`expiresAt`、`evidence`、`selfApproval` | 当前 `human_approval: true` 无法表达；LangGraph 需要 request/wait/commit 展开 | #18、#7、#17 | **provisional (pending #18)** |
| P9 | `spec.workflows.*.timeout` 明确“活动执行预算”还是“墙钟时间”；审批等待是否计入 | LangGraph timeout 是 node attempt 级；审批可能等 24h | #18、#7 | **provisional (pending #18)** |
| P10 | `solution.lock.runtime` 增加 `family`、`language`、`packages`、`stateStore`、`checkpointerSchema` | 当前 lock 只有 mastra/node/python；第二 runtime 无法 pin | #7、#19、#17 | P1 |
| P11 | `runtime-info` 增加 `runtime` + `capability_details`，保留 `capabilities` 字符串数组 | 启动握手需要结构化能力；不能只看版本 | #8、#17 | P1 |
| P12 | BundleTopology 增加 runtime 组件/卷/端口/启动依赖/health/secretRef；Compose/Helm/airgap 从它渲染 | GAP-4；LangGraph 多一个 state store 卷 | #17、#12、#13 | P1 |

**不建议的改动**：

- 不在 Spec 里写 `runtime: langgraph` / `language: python`；这是 profile 的事，不是业务 Spec 的事。
- 不抽象 checkpoint/agent loop/memory 的内部结构（#17 也明确“不抽象 checkpoint”）；只声明能力和边界。
- 不让 context-service 感知 runtime；`runtime-info` 是 runtime app 的端点，context-service 不读 runtime profile。
- 不为 LangGraph 增加“通用图 DSL”；Spec 的 Workflow grammar 仍是业务语义，不是 LangGraph API 的镜像。

### 9.1 依赖 #18 的 provisional 映射

以下内容在 #18 关闭前不应当作最终 schema：

- `approval` step 的字段名/必填性；
- `when` 是受限表达式还是命名 predicate；
- `proposedAction` 的模板语法（当前 Spec 用 `${triage.output.claimId}` 字符串）；
- `approverRoles` 的词表与自审策略；
- 审批过期后 workflow 的行为（结束、替代分支、还是重新发起）；
- `timeout` 的语义（§9 P9）。

本文使用的假设（**assumption used**）：

1. `WorkflowStep` 是 discriminated union：`context | agent | tool | approval | branch | parallel`；
2. `approval` 变体至少包含 `proposedAction`、`approverRoles`、`expiresAt`、`evidence`（引用上游 step 输出）；
3. `when` 是受限表达式，只能引用 typed step 输出和 Policy 参数，不允许任意代码/Cypher/SQL；
4. `approval` 映射为 LangGraph 的 `request_approval → wait_approval → commit` 三节点，`interrupt()` 只在 wait 节点；
5. 审批等待不计入 `timeout` 的活动执行预算；过期由 context-service 作业 + generator reconcile 处理。

如果 #18 的结论不同，§2.2/§4.2/§9 P8–P9 需要重写，但 §3 的能力矩阵与 §6 的拓扑不受影响。

---

## 10. 来源与未验证

### 10.1 来源（访问日期均为 2026-11-15）

**项目上下文**

- [S1] Fdesforce #1：FDE 工作台 v0 系统设计地图 — https://github.com/0xnicholas/Fdesforce/issues/1
- [S2] Fdesforce #7：Solution Spec 与配置工具形态（含 ADR-0002）— https://github.com/0xnicholas/Fdesforce/issues/7 ；ADR：https://github.com/0xnicholas/Fdesforce/blob/design/7-solution-spec/docs/adr/0002-solution-spec-and-config-tooling.md
- [S3] Fdesforce #1 的 Decisions（含 #10 评测决策摘要：三层验收、Bundle 只带定义/scorer、数据集客户侧）— https://github.com/0xnicholas/Fdesforce/issues/1
- [S4] Fdesforce #11：样例 Solution Spec 与生成物骨架 — https://github.com/0xnicholas/Fdesforce/issues/11
- [S5] Fdesforce #16：LangGraph 运行时映射缺口 — https://github.com/0xnicholas/Fdesforce/issues/16
- [S6] Fdesforce #17：Runtime Adapter 端口与能力矩阵 — https://github.com/0xnicholas/Fdesforce/issues/17
- [S7] Fdesforce #18：Workflow/HITL step grammar 与 policy 参数化 — https://github.com/0xnicholas/Fdesforce/issues/18
- [S8] Fdesforce #20：record-before-act evidence 与审计绑定 — https://github.com/0xnicholas/Fdesforce/issues/20
- [S9] 样例 Spec：`prototype/11-solution-spec/acme/solutions/claims-triage/solution.yaml` — https://github.com/0xnicholas/Fdesforce/blob/prototype/11-solution-spec-skeleton/prototype/11-solution-spec/acme/solutions/claims-triage/solution.yaml
- [S10] 样例 lock：`prototype/11-solution-spec/acme/solutions/claims-triage/solution.lock` — https://github.com/0xnicholas/Fdesforce/blob/prototype/11-solution-spec-skeleton/prototype/11-solution-spec/acme/solutions/claims-triage/solution.lock
- [S11] 原型缺口：`prototype/11-solution-spec/GAPS.md` — https://github.com/0xnicholas/Fdesforce/blob/prototype/11-solution-spec-skeleton/prototype/11-solution-spec/GAPS.md
- [S12] 运行时契约：`docs/runtime-contract.md` — https://github.com/0xnicholas/Fdesforce/blob/prototype/11-solution-spec-skeleton/docs/runtime-contract.md
- [S13] 领域模型：`docs/domain-model.md` — https://github.com/0xnicholas/Fdesforce/blob/prototype/11-solution-spec-skeleton/docs/domain-model.md
- [S14] Conformance cases：`contracts/conformance/cases.md` — https://github.com/0xnicholas/Fdesforce/blob/prototype/11-solution-spec-skeleton/contracts/conformance/cases.md
- [S15] Runtime Info schema：`contracts/schemas/runtime-info.schema.json` — https://github.com/0xnicholas/Fdesforce/blob/prototype/11-solution-spec-skeleton/contracts/schemas/runtime-info.schema.json
- [S16] Run/SSE schema：`contracts/schemas/run.schema.json` — https://github.com/0xnicholas/Fdesforce/blob/prototype/11-solution-spec-skeleton/contracts/schemas/run.schema.json
- [S17] 生成的 Mastra workflow / Run service：`prototype/11-solution-spec/generated/claims-triage/mastra-app/src/workflows/document-triage-flow.ts`、`src/runtime/run-service.ts` — https://github.com/0xnicholas/Fdesforce/tree/prototype/11-solution-spec-skeleton/prototype/11-solution-spec/generated/claims-triage/mastra-app/src
- [S18] 生成的 context client / record-before-act：`.../src/runtime/context-client.ts`、`.../src/runtime/record-before-act.ts` — 同上
- [S19] 生成的 Compose 拓扑：`prototype/11-solution-spec/generated/claims-triage/deploy/compose.yaml` — https://github.com/0xnicholas/Fdesforce/blob/prototype/11-solution-spec-skeleton/prototype/11-solution-spec/generated/claims-triage/deploy/compose.yaml
- [S20] 语义建模：`docs/semantic-modeling.md` — https://github.com/0xnicholas/Fdesforce/blob/prototype/11-solution-spec-skeleton/docs/semantic-modeling.md

**LangGraph 官方文档**

- [S21] Persistence（checkpointer vs store、super-step、checkpoint_ns、序列化、加密、retention）— https://docs.langchain.com/oss/python/langgraph/persistence
- [S22] Checkpointers（thread、durability modes、pending writes、checkpointer 库、`get_state_history`）— https://docs.langchain.com/oss/python/langgraph/checkpointers
- [S23] Interrupts（`interrupt()`、`Command(resume=...)`、multiple interrupts、rules、subgraphs、无限等待）— https://docs.langchain.com/oss/python/langgraph/interrupts
- [S24] Streaming（values/updates/messages/custom/checkpoints/tasks/debug、v2、subgraphs）— https://docs.langchain.com/oss/python/langgraph/streaming
- [S25] Time travel（replay/fork、interrupt 重触发、subgraph checkpoint）— https://docs.langchain.com/oss/python/langgraph/use-time-travel
- [S26] Graph API（StateGraph、nodes、edges、conditional edges、Send、Command、super-step、graph migrations）— https://docs.langchain.com/oss/python/langgraph/graph-api
- [S27] Stores（`BaseStore`、namespace、long-term memory、semantic search）— https://docs.langchain.com/oss/python/langgraph/stores
- [S28] Subgraphs（state schemas、subgraph persistence、`checkpointer=True/False/None`）— https://docs.langchain.com/oss/python/langgraph/use-subgraphs
- [S29] Backward compatibility（latest graph 对已有 thread 生效、node/state 变更、in-flight threads）— https://github.com/langchain-ai/docs/blob/main/src/oss/langgraph/backward-compatibility.mdx
- [S30] Local server（`langgraph dev`，in-memory、dev/testing only、LangSmith prerequisite）— https://docs.langchain.com/oss/python/langgraph/local-server
- [S31] Deployment（LangSmith Cloud / Agent Server 选项）— https://docs.langchain.com/oss/python/langgraph/deploy
- [S32] Agent Server（assistants/threads/runs、Postgres/Redis、queue worker、one run per thread）— https://docs.langchain.com/langsmith/agent-server
- [S33] LangSmith Agent Server deployment（Cloud/BYOC/self-hosted/standalone）— https://docs.langchain.com/langsmith/deployment
- [S34] Standalone Agent Server（Docker/Compose/K8s、`LANGGRAPH_CLOUD_LICENSE_KEY`、beacon）— https://docs.langchain.com/langsmith/deploy-standalone-server
- [S35] Self-hosted egress（beacon、air-gapped/offline license）— https://docs.langchain.com/langsmith/self-host-egress
- [S36] Trace with OpenTelemetry（`langsmith[otel]`、`LANGSMITH_OTEL_ENABLED`、LangSmith `/otel`、collector fanout）— https://docs.langchain.com/langsmith/trace-with-opentelemetry
- [S37] LangSmith Observability for LangGraph（`LANGSMITH_TRACING`、tracing_context、anonymizers）— https://docs.langchain.com/oss/python/langgraph/observability
- [S38] LangGraph v1 release notes（`create_react_agent` deprecated、`create_agent`）— https://docs.langchain.com/oss/python/releases/langgraph-v1
- [S39] LangChain Agents（`create_agent`、middleware、HITL middleware）— https://docs.langchain.com/oss/python/langchain/agents
- [S40] LangChain MCP（`MCPAdapter`、transports）— https://docs.langchain.com/oss/python/langchain/mcp

**LangGraph / LangChain 源码与包元数据**

- [S41] PyPI `langgraph` 1.2.22（MIT、Python >=3.10、依赖）— https://pypi.org/project/langgraph/
- [S42] PyPI `langgraph-checkpoint` 4.3.2 / `langgraph-checkpoint-postgres` 3.2.1 / `langgraph-checkpoint-sqlite` 3.1.3 — https://pypi.org/project/langgraph-checkpoint-postgres/ ；https://pypi.org/project/langgraph-checkpoint-sqlite/
- [S43] PyPI `langgraph-cli` 0.4.43（MIT、`inmem` extra 拉 `langgraph-api`/`langgraph-runtime-inmem`）与 `langgraph-sdk` 0.4.14 — https://pypi.org/project/langgraph-cli/ ；https://pypi.org/project/langgraph-sdk/
- [S44] PyPI `langgraph-api` 0.18.0 wheel metadata（`License: Elastic-2.0`、Python >=3.11、`langsmith[otel]`、OTel deps）— https://pypi.org/project/langgraph-api/
- [S45] PyPI `langgraph-runtime-inmem` 0.38.0（`License: Elastic-2.0`）— https://pypi.org/project/langgraph-runtime-inmem/
- [S46] npm `@langchain/langgraph` 1.7.4（MIT、Node >=18、peer deps、release date）— https://www.npmjs.com/package/@langchain/langgraph
- [S47] npm `@langchain/langgraph-checkpoint` 1.2.2 / `-checkpoint-postgres` 1.1.3 / `-checkpoint-sqlite` 1.1.0（exports、`PostgresStore` 子路径）— https://www.npmjs.com/package/@langchain/langgraph-checkpoint-postgres ；https://www.npmjs.com/package/@langchain/langgraph-checkpoint-sqlite
- [S48] GitHub `create_react_agent` deprecation — https://github.com/langchain-ai/langgraph/blob/main/libs/prebuilt/langgraph/prebuilt/chat_agent_executor.py#L274
- [S49] GitHub Postgres checkpointer schema/migrations — https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint-postgres/langgraph/checkpoint/postgres/base.py#L46-L95
- [S50] GitHub Python `JsonPlusSerializer`（`ormsgpack`）— https://github.com/langchain-ai/langgraph/blob/main/libs/checkpoint/langgraph/checkpoint/serde/jsonplus.py#L30
- [S51] GitHub Releases：`1.2.22`（2026-11-14）、`1.0.0`（2025-10-17）— https://github.com/langchain-ai/langgraph/releases/tag/1.2.22 ；https://github.com/langchain-ai/langgraph/releases/tag/1.0.0
- [S52] PyPI `langchain` 1.5.0 / `langchain-mcp-adapters` 0.3.2 / `agentevals` 0.0.9 — https://pypi.org/project/langchain/ ；https://pypi.org/project/langchain-mcp-adapters/ ；https://pypi.org/project/agentevals/
- [S53] npm `langchain` 1.6.6 / `@langchain/mcp-adapters` 2.0.3 — https://www.npmjs.com/package/langchain ；https://www.npmjs.com/package/@langchain/mcp-adapters
- [S54] LangGraph JS v1 migration（typed interrupts、`toLangGraphEventStream` removed、`stream` encoding）— https://github.com/langchain-ai/docs/blob/main/src/oss/javascript/migrate/langgraph-v1.mdx
- [S55] LangChain Core tracers 目录（无 first-party OTel handler）— https://github.com/langchain-ai/langchain/tree/main/libs/core/langchain_core/tracers

**Mastra 基线**

- [S56] Mastra suspend/resume（snapshot、`suspend()`/`resume({step,resumeData})`、跨重启）— https://mastra.ai/docs/workflows/suspend-and-resume
- [S57] Mastra Memory（thread/resource、working memory、observational memory）— https://mastra.ai/docs/memory/overview
- [S58] Mastra Observability（OTel-compatible exporters、storage/exporters）— https://mastra.ai/docs/observability/overview
- [S59] Mastra Evals（scorers/datasets/experiments/live eval）— https://mastra.ai/docs/evals/overview
- [S60] Mastra MCP（MCPClient/MCPServer、stdio/Streamable HTTP）— https://mastra.ai/docs/connections/mcp
- [S61] Mastra server deployment（`mastra build`、自包含 Node server、端口 4111、graceful shutdown）— https://mastra.ai/docs/deployment/mastra-server
- [S62] Mastra license（Apache-2.0 core + EE source-available；`MASTRA_LICENSE_KEY`）— https://mastra.ai/docs/license
- [S63] npm `@mastra/core` 1.83.0（Apache-2.0、Node >=22.13.0）— https://www.npmjs.com/package/@mastra/core
- [S64] 基线 memo：Agent 运行时选型（Mastra workflow snapshot/storage、durable agent）— https://github.com/0xnicholas/Fdesforce/blob/research/agent-runtime/docs/research/agent-runtime-selection.md

### 10.2 未验证 / 开放问题

1. **纯 OTel（不经过 LangSmith）**：官方文档只给出 `langsmith[otel]` → LangSmith `/otel` → collector 的路径；LangChain Core 的 tracer 目录没有 first-party OTel handler [S36][S55]。如果客户要求“只送客户 OTel collector、不部署 LangSmith”，需要自写 callback/第三方 instrumentation；未验证。
2. **跨 Python/JS checkpoint 兼容**：表结构相似，但 Python 用 msgpack、JS 用 JSON；没有官方跨语言恢复承诺。本文按“不可移植”处理，未做实际读写测试 [S49][S50][S47]。
3. **`langgraph dev` 在无 LangSmith key 的离线环境**：文档把 LangSmith API key 列为前置条件，并明确 dev server 只用于开发/测试 [S30]；是否能完全离线启动未验证。生产不应依赖它。
4. **Agent Server 的离线许可条款**：air-gapped 需要联系销售获取 offline license [S35]；商业条款、价格、再分发限制未验证，需要法务/采购评估。
5. **Elastic-2.0 对客户 bundle 的影响**：`langgraph-api`/`langgraph-runtime-inmem` 是 Elastic-2.0 [S44][S45]；作为客户交付物的一部分是否构成“提供托管服务/再分发”，需要法务确认。本文只把它作为 license gate 的输入。
6. **LangGraph JS 的功能完整性**：本文只核对了包导出/文档/类型，没有逐项运行 JS 的 interrupt/checkpointer/stream；Python/JS parity 的边界可能还有未列出的差异。
7. **`interrupt` + 审批过期的实际行为**：需要生成器 reconcile job；没有原型验证“过期后 resume/cancel”的时序与幂等。
8. **`RuntimeCapabilities` 最终 schema**：本文的 TypeScript 形状是 #17 的输入，不是最终契约；字段名/粒度会由 #17 决定。
9. **Mastra 1.83.0 的实际行为**：本文只把 Mastra 作为基线，重新核对了版本/许可/文档；没有重新跑 Mastra 的 HITL/durable agent 测试。
10. **性能/容量**：没有 benchmark LangGraph checkpointer 的写入放大、Postgres 连接、SQLite 单写者、SSE 吞吐；这些会影响生产拓扑选择。
11. **`create_agent` 的 HITL middleware 与 Fdesforce 审批的映射**：`HumanInTheLoopMiddleware` 可以在 agent 工具调用前暂停 [S39]，但 Fdesforce 的审批是 workflow step + context-service 资源；是否用 middleware 还是 `interrupt()` 节点，取决于 #18，未定。
12. **`fde.runtime/v1` schema 的兼容性改动**：`runtime-info` 新增 `runtime`/`capability_details` 是 additive 还是 v1.1，需要 #8/#17 决定；本文只给建议。

---

## 附录：输入给 #17 的 `RuntimeCapabilities` 表

> 这是 #17 的输入，不是最终 schema。`must/optional/degradable` 是建议级别；“port”列表示 `RuntimeGenerator` 端口能否吸收该差异；“generator/topology”列表示必须由具体 generator 或拓扑实现的部分。

| # | 能力 | Mastra | LangGraph Python | LangGraph.js | 建议级别 | port 可吸收 | generator / topology 必须实现 | 建议 conformance |
|---|---|---|---|---|---|---|---|---|
| 1 | **durable workflow** | workflow snapshot、`suspend()/resume()`、跨重启 [S56] | checkpointer + `durability`；OSS 无自动 worker [S21][S22] | 同左 | must | 能力声明、`durability` 配置校验 | 恢复 worker、Run registry、state store 迁移 | A1/A6 |
| 2 | **HITL** | `suspend()/resume()`；审批资源在 context-service [S56][S12 §8] | `interrupt()/Command(resume)`；无 approval/expiry/consume [S23] | 同左；typed interrupts | must | 事件/API 形状、审批代理接口 | request/wait/commit 展开、consume reconcile、expiry job | A3/A7 |
| 3 | **streaming** | server + stream [S61] | stream modes；OSS 无 HTTP/SSE [S24] | 同左 | must | SSE envelope 映射、事件类型 | SSE 路由、seq、heartbeat、断线重连 | A2/A5 |
| 4 | **OTel** | 原生 exporter、任意 OTel 后端 [S58] | LangSmith-first；OTel 经 LangSmith/collector [S36] | 同左 | should（可降级） | `observability.otel` 声明 | exporter/collector 配置、trace ID 映射；OTel-only 需自定义 | A1/A8 |
| 5 | **memory** | Mastra Memory thread/resource [S57] | checkpointer（thread）+ Store（跨 thread） [S21][S27] | 同左 | must（若 Agent 声明 memory） | `memory.thread/longTerm` 声明 | namespace、retention、加密、隔离 | A6 |
| 6 | **tool calling** | tools + MCP client/server [S60] | LangChain tools + MCP adapters [S39][S40] | 同左 | must | 能力声明、tool schema 校验 | tool 生成、Connector 接缝、record-before-act wrapper | A4/A9 |
| 7 | **extension packaging** | `ts-package` [S2] | `python-wheel` 或 HTTP；`ts-package` 不可用 | `ts-package` | must | artifact kind/runtime 兼容声明 | artifact loader、版本/签名校验、HTTP sidecar | A9 |
| 8 | **state store** | libsql/SQLite/Postgres [S56] | SQLite/Postgres checkpointer；schema 私有 [S49] | 同左 | must | `stateStore.kinds/schemaVersion` 声明 | 卷/数据库、迁移、加密、单写者 | A6/A10 |
| 9 | **topology** | Node + context-service；2 服务 [S19] | Python + context-service；split 或 merged-container | JS + context-service；接近 Mastra | must | topology modes 声明 | BundleTopology、端口/卷、启动顺序、health | A10 |
| 10 | **offline / air-gapped** | Apache-2.0 OSS，可离线 [S62] | MIT OSS 可离线；Agent Server 需 Elastic/离线许可 [S35][S44] | 同左 | must（`restricted`/`airgap`） | license/egress 声明、license gate | 离线包、wheel/npm 镜像、license 校验 | A10 |

**补充（不属于 10 项，但 #17 应纳入矩阵）**：

- **eval hooks**：建议作为 `observability.evalHooks: native | external | none` 的附加项；Fdesforce 的 eval worker 是 external，LangGraph 可满足；Mastra 是 native。它不是选 runtime 的硬门槛，但影响“评测与溯源是一等公民”的实现方式。
- **record-before-act**：不是 runtime capability，而是 generator + context-service 的 wrapper 不变式；两个 runtime 都必须通过 A4。不要把它抽象成 runtime 内部机制。
- **single-writer / concurrency**：不是能力，而是 topology 约束；SQLite checkpointer、embedded graph、`mastra-state` 都要求单写者。Agent Server 的 Postgres/Redis 允许多 worker，但 v0 的 context-service 仍单副本 [S12 §9.4]。
