# Record-before-act evidence 与审计绑定 v1

> 状态：决策稿，对应 ticket「record-before-act evidence 与审计绑定」(#20)。
> 范围：v0 单客户 bundle；只定 Spec 字段、Decision 契约、生成物/运行时映射与 conformance，不改生产实现。
> 契约版本：`fde.runtime/v1.3.0`（intent/outcome 字段在 v1.1 引入；intent/outcome 的新必填字段是语义收紧）。
> 关联：[运行时与集成契约](runtime-contract.md) · [客户环境内的身份、权限与部署](security-and-deployment.md) · [评测、验收与可观测性](evaluation-and-observability.md) · [ADR-0008](adr/0008-decision-audit-binding.md) · [Workflow/HITL step grammar](https://github.com/0xnicholas/Fdesforce/issues/18) · [solution.lock 完整性](https://github.com/0xnicholas/Fdesforce/issues/19)
> 术语：[`GLOSSARY.md`](../GLOSSARY.md)

## 1. 结论摘要

| # | 决策 | 结论 |
|---|---|---|
| D1 | 绑定归属 | 分层：**Tool** 声明内在审计属性（`classification`、`retentionClass`、digest 口径）；**Capability** 声明每个副作用 Tool 的证据选择与只读 Run 的 outcome 决策；build 合并成每次调用的 `DecisionBinding`，取更严者。 |
| D2 | Evidence 类型 | `Decision.evidence[]` 扩成 discriminated union：`graph_entity`、`retrieval`、`run_artifact`、`approval`；旧形状（无 `type`）按 `graph_entity` 解释。 |
| D3 | 证据选择器 | `from: retrieval` 选 item 级图事实 + snapshot 引用；`from: step` 选 step 输出 artifact 或 `as: citations` 解析引用；`from: input` 选工具输入；approval-gated 调用自动追加审批 Decision。路径复用 #18 的 `{step, path}` 点路径。 |
| D4 | 证据非空 | 每个副作用 Tool 必须声明至少一个 selector；空数组 build fail；intent evidence 必须非空；`from: input` 是合法的 input-only 证据。 |
| D5 | 执行载体 | 平台 runtime 包 `@fde/runtime` 实现 `recordBeforeAct(binding, execute)`；生成器只产出声明式 `DecisionBinding` + 一行调用。Mastra hooks 只作 defense-in-depth，不作为 fail-closed 强制点。 |
| D6 | ID 与幂等 | `invocation_id`（`inv_<ULID>`）标识一次副作用 Tool 调用；`decision_id` 仍由调用方生成；pending ID 与 `Idempotency-Key`（`run_id:capability_id:invocation_id:phase`）落到 `mastra-state` 的 `decision_outbox`，重试复用。 |
| D7 | 崩溃恢复 | outbox 状态机 `prepared → intent_written → executing → executed → done`；`executing` 视为结果未知，不自动重试副作用，写 `status=unknown` outcome，Run fail closed；outbox 写失败则不写 intent、不执行。 |
| D8 | Policy 评估 | `PolicyTemplate` 增加 typed `enforcementPoint`；`policyRefs` 允许 `string | {ref, args?, appliesTo?}`；每个副作用 Tool 必须被至少一条 `tool.pre_invoke` policy 覆盖，否则 build fail；工具级策略由 mastra-app 评估，数据权限由 context-service 服务端追加。 |
| D9 | Policy deny | deny 写 `status=denied` 的 intent Decision，带 deny evaluation；不执行、不写 outcome；不计入 `decision_coverage`。 |
| D10 | classification / retention | 静态声明是下限；`effective_classification = max(tool, evidence, policy)`，`retention_class = strictest(tool, policy)`；未分类 retrieval item 默认 `restricted`；只能升/延长，不能降/缩短。 |
| D11 | 只读 Run | 每个终止 Run 写一条 `phase=run` Decision；`runOutcomeDecision: required` 是默认，只有只读且输出不可行动的 Capability 可 `omitted`，Overlay 只能收紧；失败的只读 Run 写 `status=failed`。 |
| D12 | Decision Coverage | invocation 级：分母是授权通过（policy evaluations 全 `allow`/`waived`）的 intent；分子是恰好一个 outcome child 的 intent；排除 deny、审批 rejected/expired、只读 Run；`status=unknown` 算完整。 |

## 2. 问题与边界

原型 GAP-5 暴露的是结构性问题：`claim-decision` 只有 `sideEffects: write`，生成的 wrapper 只能写 `evidence: []` 和 `policy_evaluations: []`；按现契约，`decision_coverage` blocking gate 对有副作用的 Tool 必然失败。本票把“哪些证据、哪些 Policy、谁生成 ID/digest、失败怎么记”一次性定清楚。

本票**不**负责：

- Agent 行为层安全（prompt injection、tool abuse、data exfiltration）：已由 [Agent 专项安全](agent-security.md) 定稿。
- Connector operation 的幂等语义与 typed operation manifest：归 #17 的实现切片。
- 审计存储后端、保留作业实现、WORM/外部锚定：归 #8/#12 的边界。
- 生产 builder、`@fde/runtime` 包实现、`context-service` 实现：归 [架构综合与实施切片](https://github.com/0xnicholas/Fdesforce/issues/13)。

## 3. Decision Binding

### 3.1 分层

| 层 | 声明 | 为什么在这里 |
|---|---|---|
| **Tool** | `audit.classification`、`audit.retentionClass`、`audit.digests` | 数据等级与动作副作用是 Tool 的内在属性；同一个 Tool 被多个 Capability 调用时不应重复声明。 |
| **Capability** | `audit.evidence.<tool_id>[]`、`audit.runOutcomeDecision` | 证据取决于本次业务动作的上下文（哪些 retrieval snapshot、哪个 step 输出、哪个审批），只有 Capability 的实现知道。 |
| **Policy** | `enforcementPoint`、typed `parameters` | 约束的 enforcement point 是 Policy Template 的属性；binding 只提供 `args` 和 `appliesTo`。 |

Build 把两层合并成每次 Tool 调用的 `DecisionBinding`：

```yaml
tools:
  claim-decision:
    connectorRef: claims-db
    operation: recordDecision
    sideEffects: write
    inputSchema: files/schemas/claim-decision.input.json
    outputSchema: files/schemas/claim-decision.output.json
    audit:
      classification: confidential
      retentionClass: standard
      digests: { input: jcs-sha256, output: jcs-sha256 }

capabilities:
  document-triage:
    template: document-triage@^1.0.0
    implementation:
      type: workflow
      ref: document-triage-flow
    audit:
      evidence:
        claim-decision:
          - from: retrieval
            recipe: claims-context
          - from: step
            step: triage
            path: output.citedSources
            as: citations
      runOutcomeDecision: required
```

### 3.2 合并与校验

- 每个 `sideEffects != read` 的 Tool 必须有 `audit.classification` 和 `audit.retentionClass`；缺失 → build fail。
- 每个 Capability 实现里被调用的副作用 Tool 必须在 `audit.evidence` 中有至少一个 selector；缺失或空数组 → build fail。
- `classification` 只能升：`public < internal < confidential < restricted`。
- `retentionClass` 只能延长：`ephemeral < standard < extended < legal_hold`。
- `audit.digests` 在 v1.1 只允许 `jcs-sha256`；字段保留是为了未来显式声明，不是让作者换算法。
- `runOutcomeDecision` 允许 `required | omitted`；`omitted` 只对只读且输出不可行动的 Capability 有效；含副作用 Tool 时 build fail。
- 生成的 `DecisionBinding` 与 `solution.lock` 一起 pin；build 校验 Tool/Capability/Policy 引用都存在。

## 4. Evidence

### 4.1 Evidence union

`Decision.evidence[]` 的每个元素是以下之一：

| `type` | 字段 | 语义 |
|---|---|---|
| `graph_entity`（缺省） | `entity_id`（必填）、`version?`、`retrieval_id?`、`source_ref?`、`relationship?` | 图事实/源文档引用；旧形状不带 `type` 视为本类型。 |
| `retrieval` | `retrieval_id`、`snapshot_digest` | 本次 Run 使用过的 Retrieval Snapshot 级引用；用于 run-level Decision 和粗粒度证据。 |
| `run_artifact` | `digest`（必填）、`run_id?`、`step_id?`、`path?` | step 输出、工具输入、最终答案等非图实体的内容摘要。 |
| `approval` | `approval_id`、`decision_id` | 审批 Decision；由 runtime 在 approval-gated 调用上自动追加，也满足 conformance C21 的“intent 引用审批 Decision”。 |

规则：

- `graph_entity` 的 item 级证据必须带 `retrieval_id`（来自哪次 snapshot）；`retrieval` 类型只记 snapshot 级引用。
- 同一证据按 `(type, entity_id|retrieval_id|digest|approval_id, version)` 去重，保持 selector 声明顺序。
- `run_artifact` 的 `digest` 用 canonical JSON（RFC 8785）SHA-256；`path` 用 step 的点路径或 `input` / `final_answer`。
- 证据不复制原始内容；审计只存引用和 digest。

### 4.2 Evidence selector

Capability 的 `audit.evidence.<tool_id>` 是 selector 数组：

```yaml
evidence:
  claim-decision:
    - from: retrieval
      recipe: claims-context        # 可选；缺省选本 Run 的所有 snapshot
    - from: input                   # 可选；工具输入作为 run_artifact
    - from: step
      step: triage
      path: output.citedSources      # #18 点路径；相对 step 输出
      as: citations                  # citations | artifact；缺省 artifact
```

- `from: retrieval`：选本 Run 中匹配 `recipe` 的所有 Retrieval Snapshot。每个 snapshot 产生一条 `retrieval` 证据；每个 item 产生一条 `graph_entity` 证据（带 `retrieval_id`/`source_ref`/`version`）。
- `from: step`：`step` 必须是本 Capability 实现中位于调用点之前的 step；`path` 复用一个受限点路径（`a.b`、`a[0]`、`a[*]`），不引入 JSON Pointer。`as: artifact` 把选中的值记成 `run_artifact`；`as: citations` 逐元素解析成 `graph_entity`。
- `from: input`：把工具输入记成 `run_artifact`，`path: input`，digest 与 `input_digest` 相同。
- approval-gated 调用：runtime 自动追加 `approval` 证据，不需要 selector；审批步骤自己的 `evidenceFrom`（#18）继续负责审批请求的证据。
- `as: citations` 的每个元素可以是 `source_ref@version` 字符串，或带 `entity_id`/`source_ref`/`version`/`retrieval_id?` 的对象。解析必须在本 Run 的 retrieval snapshots 中**唯一**命中；未命中或歧义 → intent 写入失败，Tool 不执行（与 `citation_validity` blocking gate 对齐）。
- selector 选不到任何证据且没有其他 selector 产出 → intent 写入失败；`from: input` 总是至少产生一条证据。
- Evidence 的 schema 上限是 200 条；selector 产出超过上限时 fail closed，不静默截断。

### 4.3 非空规则

- `audit.evidence.<tool_id>` 必须存在且非空；`evidence: []` 是 build error，不是运行时降级。
- intent Decision 的 `evidence` 非空；conformance C26 断言这一点。
- 如果业务动作确实没有外部证据，作者显式写 `from: input`，让审计看到这是 input-only decision，而不是静默空证据。

## 5. Policy evaluations

### 5.1 Enforcement point

`PolicyTemplate.spec.enforcementPoint` 是固定词表：

| `enforcement_point` | 评估方 | 触发 |
|---|---|---|
| `context.retrieve` | `context-service` | 每次检索；数据权限、PII mask、row/column filter |
| `tool.pre_invoke` | `mastra-app` | 副作用 Tool 执行前；allowlist、参数校验、rate limit、分类检查 |
| `agent.pre_invoke` | `mastra-app` | Agent 生成前；模型/工具可用性、输入分类 |
| `approval.request` | `mastra-app` | 审批请求或 auto-approval 判定 |
| `run.post` | `mastra-app` | Run 终止时；run-level Decision 的收尾检查 |
| `output.emit` | `mastra-app` | 模型输出返回前；secret 阻断、PII 脱敏、链接白名单（#21 新增） |

`PolicyEvaluation` 增加 `enforcement_point` 和 `evaluated_by`（`mastra-app | context-service`）；`policy_id`/`version`/`outcome`/`reason` 保留。旧 payload 不带这两个字段仍可读；新写入必须带。

### 5.2 Binding 形状

`policyRefs` 的每一项可以是字符串或对象：

```yaml
policyRefs:
  - pii-redaction@^1.0.0
  - ref: tool-allowlist@^1.0.0
    appliesTo: [claim-decision]       # 缺省 = 本 Capability 所有副作用 Tool
    args: { allow: [claim-decision] }
```

- `ref` 指向 pinned Policy Template；`args` 必须是模板 `parameters` 的合法子集。
- `appliesTo` 只允许 Tool id；省略表示覆盖本 Capability 实现里的所有副作用 Tool。
- `enforcementPoint` 由 Policy Template 决定，binding 不能改写。
- Build 规则：每个副作用 Tool 至少被一条 `tool.pre_invoke` policy 覆盖；`appliesTo` 中的 Tool 必须存在；缺覆盖 → build fail，无 `--force`。

### 5.3 谁评估、谁追加

- `mastra-app` 评估 `tool.pre_invoke`、`agent.pre_invoke`、`approval.request`、`run.post`，把结果放进 intent/outcome/run Decision 的 `policy_evaluations`。
- `context-service` 评估 `context.retrieve` 和数据权限；它在 `RetrievalResponse` 中返回这些 evaluation，并在**写入 Decision 时服务端追加**自己的 authoritative 结果。客户端传同名 policy 的 evaluation 会被拒绝（`403 forbidden`），不能伪造或省略。
- `pii-redaction` 等数据策略的 outcome 由 context-service 决定；`tool-allowlist` 等工具策略由 mastra-app 决定。`evaluated_by` 明确记录来源。

### 5.4 Deny 路径

- `tool.pre_invoke` 返回 `deny`：写一条 `phase=intent`、`status=denied` 的 Decision，带 deny evaluation 和非空证据；不执行 Tool、不写 outcome。
- 该 intent 不计入 `decision_coverage` 分母（见 §9）。
- 如果 deny 来自 context-service 的数据策略，context-service 在 Decision 写入时追加 deny；runtime 仍不得执行 Tool。
- `waived` 只允许由 Policy 明确授权；blocking gate 不能 waive（沿用 #10）。

## 6. Runtime 执行

### 6.1 载体

`@fde/runtime` 是随 Bundle 版本化的平台包，提供：

```ts
recordBeforeAct(binding: DecisionBinding, execute: () => Promise<Output>): Promise<Output>
```

生成器只产出 `DecisionBinding` 和一行调用；ID 生成、outbox、digest、证据解析、policy evaluation 收集都在 runtime 包里实现一次。生成的 Tool 代码不重复实现这些逻辑，conformance 只测 runtime 包和生成 binding。

Mastra agent hooks（`beforeToolCall`/`afterToolCall`/`onOutput`）只作 defense-in-depth：hook 异常只记录不阻断、`onOutput` 在错误时不触发、workflow 的 tool step 不走 agent hook，因此不能作为 record-before-act 的 fail-closed 强制点。

### 6.2 ID 与幂等

| ID | 生成方 | 规则 |
|---|---|---|
| `invocation_id` | runtime 模块 | `inv_<ULID>`；一次副作用 Tool 调用一个；intent/outcome/outbox 共用 |
| `decision_id` | runtime 模块 | `dec_<ULID>`；intent 和 outcome 各一个；进入 `executing` 前生成 outcome ID 并持久化 |
| `provenance_id` | context-service | 写入时生成；哈希链仍归 context-service |

- `Idempotency-Key = run_id:capability_id:invocation_id:phase`；重试复用同一 key 和同一 `decision_id`。
- 同 key + 不同 payload → `409 idempotency_conflict`（沿用 #8）。
- 生成物不得手写 `decision_id`；runtime 模块是唯一生成点。

### 6.3 Decision Outbox

`mastra-state` 增加 `decision_outbox` 表（libsql/SQLite），记录：

```text
invocation_id, run_id, capability_id, tool_id,
intent_decision_id, outcome_decision_id, state,
input_digest, output_digest?, result_status?, created_at, updated_at
```

状态机：

| 状态 | 含义 | 恢复动作 |
|---|---|---|
| `prepared` | 已生成 ID，未写 intent | 不执行；写 `status=failed` outcome 或直接失败，Run fail closed |
| `intent_written` | intent 已落审计库 | 不执行；写 `status=failed` outcome，Run fail closed |
| `executing` | 已开始副作用，结果未知 | **不自动重试**；写 `status=unknown` outcome，Run fail closed，P1 告警 |
| `executed` | 副作用已返回，outcome 未写 | 用持久化的 result digest/status 写 outcome，Run 按结果结束 |
| `done` | outcome 已写 | 清理/归档 outbox 记录（按 retention class） |

- outbox 写失败 → 不写 intent、不执行、fail closed。
- `executing` 的“结果未知”不能当成成功或失败；审计必须保留 intent，outcome 标记 `unknown`。
- 连接器级 idempotency 若存在（#17 的 operation manifest），也只能在明确声明幂等时用于重试；v0 默认不重试未知副作用。

### 6.4 Digest

- `input_digest`：Zod 校验、默认值和 coercion 之后的工具输入的 canonical JSON（RFC 8785）SHA-256。
- `output_digest`：成功时 `{status:"ok", value}`，失败时 `{status:"error", error:{code,message}}`；不直接对原始返回值取 digest。
- `run_artifact` 的 digest：被选值的 canonical JSON SHA-256。
- `retrieval` 的 `snapshot_digest` 来自 Retrieval Snapshot，不重算。
- 不存原始 prompt/output/PII；digest 只标识内容，不复制内容。
- 残余风险：低熵 PII（claim id、证件号等）的 digest 可被枚举；本票接受该风险，[Agent 专项安全](agent-security.md) §7 记录补偿控制与重新评估触发，不在 v0 引入 HMAC 或应用层 CMK。

### 6.5 model / prompt / fallback

- intent/outcome/run Decision 的 `model` 和 `prompt_version` 来自产出该动作的 Agent 绑定；workflow 的纯 Tool step 没有 Agent 时可省略。
- `fallback_used` 记录 Model Profile 是否发生 fallback；默认 `false`。`fde eval --mode live` 的 Release 门禁仍禁用 fallback（#19）。
- `model`/`prompt_version`/`fallback_used` 缺失或与实际绑定不一致时，conformance 失败；生产实现不得用占位值。

### 6.6 执行顺序

```text
1. resolve binding + evidence selectors
2. evaluate tool.pre_invoke policies
3. if deny: write intent(status=denied) -> stop
4. outbox prepared (IDs persisted)
5. write intent(status=proposed, evidence, policy evaluations, input digest)
6. outbox intent_written -> executing
7. execute side effect
8. persist result status/digest -> outbox executed
9. write outcome(parent_decision_id=intent, status=succeeded|failed, output digest)
10. outbox done
```

### 6.7 失败矩阵

| 失败点 | 副作用 | 审计 | Run |
|---|---|---|---|
| 证据解析失败 | 不执行 | 无 intent（或写失败日志） | fail closed |
| policy deny | 不执行 | intent `status=denied` + deny evaluation | 按 Capability 策略结束 |
| intent 写入失败 | 不执行 | 无 intent | fail closed |
| 执行失败 | 已尝试 | outcome `status=failed` + error digest | fail |
| outcome 写入失败 | 已发生 | 保留 intent；outbox `executed` 可重试写 outcome | fail，P1 告警 |
| outbox 写失败 | 不执行 | 无 intent | fail closed |
| 崩溃在 executing | 未知 | intent + outcome `status=unknown` | fail，P1 告警 |

## 7. Classification 与 retention

- Tool 的 `audit.classification` / `audit.retentionClass` 是**下限**，不是最终值。
- `effective_classification = max(tool.classification, max(evidence item classification), max(policy classification))`。
- `effective_retention = strictest(tool.retentionClass, policy retention)`。
- `RetrievalItem.classification` 由 context-service 返回；缺省/未分类按 `restricted`（沿用 #12）。
- 只能升/延长：`public < internal < confidential < restricted`；`ephemeral < standard < extended < legal_hold`。
- Build 拒绝缺失 `audit` 的非 read Tool、非法枚举、以及 Overlay 试图降级/缩短。

## 8. 只读 Run 的 run-level Decision

- 每个终止 Run 写一条 `phase=run` Decision：成功、失败、取消、未知都写；side-effect Run 除了 intent/outcome 之外也写这一条汇总。
- `run` Decision 的字段：
  - `decision_type: runtime`、`phase: run`、`status: succeeded | failed | cancelled | unknown`。
  - `evidence`: 本 Run 用到的所有 `retrieval` snapshot 引用 + 最终答案的 `run_artifact`。
  - `input_digest` / `output_digest`：输入摘要与最终答案摘要。
  - `model` / `prompt_version` / `fallback_used`：产出答案的 Agent。
  - `classification` / `retention_class`：按 §7 取最严。
  - 不带 `invocation_id` / `action`。
- 默认 `runOutcomeDecision: required`；Capability 可设 `omitted`，但只对只读且输出不可行动的实现有效；Overlay 只能把 `omitted` 收紧为 `required`。
- 失败的只读 Run 若没有产生答案，仍写 `status=failed` 的 run Decision；取消写 `status=cancelled`。

## 9. Decision Coverage

`decision_coverage` 从 Run 级改为 **invocation 级**，定义写进 Metric Catalog：

- **分母**：`phase=intent` 且 `status=proposed`、`policy_evaluations` 全部为 `allow`/`waived` 的 Decision（即授权执行尝试）。
- **分子**：分母中恰好有一个 outcome child（`parent_decision_id` 指向 intent）的 intent。
- **排除**：`status=denied` 的 intent、审批 rejected/expired 的 Run（没有 intent）、只读 Run。
- **完整**：`status=succeeded`、`status=failed`、`status=unknown` 的 outcome 都算“有 outcome”；只有 intent 没有 outcome 才算不完整。
- **SLO**：有副作用 Run 的 Decision 覆盖率 100%（沿用 #10）。
- 查询由审计库提供；`decision_coverage` 的 blocking gate 逐 invocation 判断，不按 Run 猜。

## 10. Wire schema delta

### 10.1 `DecisionRequest`

新增/变更字段：

| 字段 | 类型 | 规则 |
|---|---|---|
| `invocation_id` | `inv_<ULID>` | `phase=intent|outcome` 必填；run Decision 不带 |
| `action` | object | `phase=intent|outcome` 必填；`tool_id`、`side_effects` 必填，`connector_id`/`operation` 可选 |
| `status` | enum | `proposed|succeeded|failed|denied|unknown|cancelled`；intent 只能是 `proposed|denied`；outcome 只能是 `succeeded|failed|unknown|cancelled`；run 只能是 `succeeded|failed|cancelled|unknown` |
| `evidence` | union array | §4.1 |
| `policy_evaluations` | array | 每项带 `enforcement_point`/`evaluated_by`（新写入） |
| `retention_class` | enum | `ephemeral|standard|extended|legal_hold` |
| `fallback_used` | boolean | 可选，默认 `false` |

`outcome` Decision 必须带 `parent_decision_id` 指向 intent；`intent` Decision 的 `status` 只能是 `proposed` 或 `denied`。

### 10.2 `Evidence`

见 §4.1；JSON Schema 用 `oneOf`，`graph_entity` 的 `type` 可选以兼容旧 payload。

### 10.3 `PolicyEvaluation`

`policy_id`、`version`、`outcome`、`reason` 保留；新增 `enforcement_point` 和 `evaluated_by`（可选以兼容旧 payload；新写入必填）。

### 10.4 Retrieval

- `RetrievalItem.classification`：可选，引用 `Classification`；缺省视为 `restricted`。
- `RetrievalResponse.policy_evaluations`：可选数组，context-service 返回的 `context.retrieve`/数据权限评估；新服务总是返回（可为空）。
- `RetrievalResponse` 仍是 `Context API` 的响应；不新增运行时 wire 端点。

### 10.5 版本

- `fde.runtime/v1.1`：additive 字段 + intent/outcome 的语义收紧；旧客户端不能继续写 intent，但可读旧 Decision。
- `/v2` 只在 breaking 时启用；本票不引入新端点。
- `solution.lock` 的 `runtime.contractVersion` 从 `1.0.0` 升到 `1.1.0`；Bundle 启动握手校验 major 兼容。

## 11. Conformance

新增 C26–C32，接在 #18 的 C16–C25 之后；同一 runner 执行。

| ID | Case | Expected |
|---|---|---|
| C26 | Intent 完整性 | 副作用 Tool 执行前恰好一条 intent Decision；带 `invocation_id`、`action.tool_id`、非空 evidence、至少一条 `tool.pre_invoke` policy evaluation、`input_digest`、agent 触发时的 `model`/`prompt_version`；intent 写失败则 Tool 不执行（C7 的 payload 级补充） |
| C27 | Outcome 链接与失败 | 执行后恰好一条 outcome Decision，`parent_decision_id` 指向 intent，带 `status=succeeded|failed` 和 `output_digest`；outcome 写失败则 Run 失败、intent 保留、重试不产生第二条 outcome，`decision_coverage` 记为不完整 |
| C28 | 证据选择器 | retrieval selector 产出 item 级 evidence；step artifact selector 产出带 digest 的 `run_artifact`；`as: citations` 逐条解析，解析不到或歧义则 intent 写失败且不执行；approval-gated 调用自动带 `approval` evidence |
| C29 | Policy deny | `tool.pre_invoke` deny 写 `status=denied` 的 intent，不执行、不写 outcome，`decision_coverage` 排除 |
| C30 | 只读 Run | 默认写一条 `phase=run` Decision（全部 retrieval snapshot + 最终 `output_digest` + model/prompt）；`runOutcomeDecision: omitted` 的只读 Capability 不写，若含副作用 Tool 则 build 失败；失败的只读 Run 写 `status=failed` |
| C31 | 分类/保留与 build fail-closed | 非 read Tool 缺 `audit` 或 Capability 缺该 Tool 的 evidence selector → build 失败；intent classification = max(tool, evidence, policy)；retention = strictest(tool, policy)；未分类 retrieval item 默认 `restricted` |
| C32 | 崩溃恢复 | outbox 处于 `executing` 时重启不重试副作用，写同一 intent 链接的 `status=unknown` outcome，Run 失败；outbox 写失败则无 intent、无执行 |

## 12. 生成物 / 运行时映射

生成器为每个副作用 Tool 产出：

```ts
const binding: DecisionBinding = {
  toolId: 'claim-decision',
  action: { toolId: 'claim-decision', connectorId: 'claims-db', operation: 'recordDecision', sideEffects: 'write' },
  classification: 'confidential',
  retentionClass: 'standard',
  evidence: [
    { from: 'retrieval', recipe: 'claims-context' },
    { from: 'step', step: 'triage', path: 'output.citedSources', as: 'citations' },
  ],
  policies: [
    { policyId: 'tool-allowlist', version: '1.0.0', enforcementPoint: 'tool.pre_invoke' },
  ],
};

export const claimDecision = createTool({
  // ...
  execute: async ({ context, runtimeContext }) => {
    const claims = runtimeContext.get('executionContext') as ExecutionContextClaims;
    return recordBeforeAct({ binding, claims, execute: () => invokeConnector(claims, context) });
  },
});
```

生成物不包含：outbox 实现、证据解析、digest、ID 生成、policy 评估。它们都在 `@fde/runtime`，版本随 `solution.lock` pin。

## 13. v0 边界与未决

- **不改生产实现**：`@fde/runtime`、`context-service`、`mastra-app` 的实现归 #13。
- **Connector 幂等**：`executing` 不自动重试；若 #17 的 operation manifest 声明幂等且提供查询，可在后续版本启用受控重试。
- **PII digest 枚举**：残余风险，由 [Agent 专项安全](agent-security.md) §7 显式接受并给出重新评估触发。
- **Outbox 清理**：按 retention class 归档；具体作业归 #13。
- **多 runtime**：`@fde/runtime` 是 Mastra generator 的一部分；LangGraph 的可移植性由 #16/#22 决定，不在本票承诺。
- **审批 UI/多审批人**：沿用 #18 的 v0 边界。
- **审计存储后端/WORM**：沿用 #8/#12 的 v0 边界。

## 14. 产物与一致性

| 产物 | 路径 | 说明 |
|---|---|---|
| 本文 | `docs/decision-audit-binding.md` | 决策与字段 |
| ADR | `docs/adr/0008-decision-audit-binding.md` | 关键权衡与被淘汰方案 |
| 运行时契约 | `docs/runtime-contract.md` | §4.2/§6.2/§7.4/§12/§13 同步 |
| Decision schema | `contracts/schemas/decision.schema.json` | v1.1 字段 |
| Retrieval schema | `contracts/schemas/retrieval.schema.json` | `classification` / `policy_evaluations` |
| Common schema | `contracts/schemas/common.schema.json` | `InvocationId`、`RetentionClass`、`PolicyEvaluation` |
| Conformance | `contracts/conformance/cases.md` | C26–C32 |
| 术语 | `GLOSSARY.md` | Decision Binding、Invocation、Intent/Outcome/Run Decision、Decision Coverage |
| 原型 | `prototype/11-solution-spec/` | 样例 Spec/生成物；GAP-5 标记 resolved |

一致性规则：

- 文档中的字段名、枚举、ID 前缀必须与 JSON Schema 一致。
- 所有示例必须能通过 schema 校验；C1 覆盖文档示例。
- `decision_coverage` 的定义必须与 #10 Metric Catalog 一致；改口径走新版本。
- 生成物不可手改；build 重新生成 `DecisionBinding`。

## 15. 对实施切片（#13）的输入

1. **Runtime 包**：`@fde/runtime` 的 `recordBeforeAct`、DecisionBinding 类型、证据解析器、digest、ID/outbox。
2. **Outbox**：`mastra-state` 的 `decision_outbox` 迁移、恢复逻辑、清理作业。
3. **Schema v1.1**：Decision/Retrieval/Common schema 的 codegen、TS/Python 模型、契约握手。
4. **Policy**：Policy Template 的 `enforcementPoint`、typed parameters、`policyRefs` object 形式、build coverage 检查。
5. **Context-service**：RetrievalItem classification、RetrievalResponse policy_evaluations、Decision 写入时服务端追加数据策略评估。
6. **Generator**：从 Tool/Capability 合并 DecisionBinding、生成 evidence selectors、构建期 fail-closed。
7. **Run-level Decision**：每个终止 Run 写 `phase=run`，`runOutcomeDecision` 规则。
8. **Conformance**：C26–C32 接入 runner；C1 覆盖新示例。
9. **Metric Catalog**：`decision_coverage` 的 invocation 级定义与查询。
