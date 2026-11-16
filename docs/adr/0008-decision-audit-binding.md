---
status: accepted
---
# Decision Binding 与 record-before-act 审计

record-before-act 是 `fde.runtime/v1` 最重要的运行时不变式，但 v0 的 Spec 只声明 `sideEffects: write`，生成的 wrapper 只能写空证据和空 Policy 评估，`decision_coverage` blocking gate 对有副作用的 Tool 必然失败。本 ADR 把审计绑定拆成两层：Tool 声明内在的 `classification`、`retentionClass` 和 digest 口径；Capability 按 Tool 声明证据选择器和只读 Run 的 `runOutcomeDecision`；build 合并成每次调用的 `DecisionBinding` 并取更严者。`Decision.evidence[]` 从“只允许图实体”扩成 `graph_entity | retrieval | run_artifact | approval` 的 union，让检索快照、agent 输出、工具输入和审批 Decision 都能成为证据。执行载体是随 Bundle 版本化的 `@fde/runtime` 包，生成器只产出声明式 binding；`invocation_id`、intent/outcome ID、`decision_outbox`、digest 和证据解析由 runtime 实现一次。Policy Template 增加 typed `enforcementPoint`，每个副作用 Tool 必须被至少一条 `tool.pre_invoke` policy 覆盖，工具级评估由 mastra-app 执行、数据权限由 context-service 服务端追加。只读 Run 默认写一条 `phase=run` Decision；`decision_coverage` 改为 invocation 级，排除 policy deny 和审批拒绝。这样审计链完整、可查询、可 fail closed，代价是 Spec 作者必须为每个副作用动作显式声明证据选择，runtime 需要维护 outbox 和恢复语义，intent/outcome 的新必填字段构成一次语义收紧的 minor 版本。

完整决策、字段和失败矩阵见 [`docs/decision-audit-binding.md`](../decision-audit-binding.md)；运行时接缝见 [`docs/runtime-contract.md`](../runtime-contract.md) §4.2/§6.2/§7.4；身份与保留词表见 [`docs/security-and-deployment.md`](../security-and-deployment.md) §5；`decision_coverage` 指标见 [`docs/evaluation-and-observability.md`](../evaluation-and-observability.md) §3.2。本 ADR 细化 [ADR-0003](0003-runtime-and-integration-contract.md) 的 Decision 契约和 [ADR-0005](0005-evaluation-and-observability.md) 的审计指标，不改变 Bundle/Release 的不可变性和 `fde.runtime/v1` 的端点集合。

## Considered Options

- **全部审计字段放 Tool**：原型最省事，但同一个 Tool 被不同 Capability/步骤调用时证据集不同，Tool 不应该知道 workflow step。改为 Tool 只放内在属性，Capability 放证据选择。
- **全部放 Capability**：治理单位正确，但 Tool 的数据等级（claims 数据总是 `confidential`）会在每个 Capability 重复声明、容易漂移。改为分层 + build 合并。
- **独立 `decisionBindings` 表**：审计配置集中，但新增顶层概念、引用更容易写错；v0 用现有 Tool/Capability 承载。
- **证据只允许图实体**：`Decision.evidence[].entity_id` 保持不变，但 agent 输出、检索快照、审批 Decision 都塞不进去，副作用动作会缺证据。改为 discriminated union，旧形状兼容。
- **每个 Tool 生成 wrapper**：灵活，但 critical invariant 复制到每个生成物，容易漂移。改为 `@fde/runtime` 统一实现，生成物只声明 binding。
- **用 Mastra agent hooks 强制**：`beforeToolCall` 能阻断 agent 工具调用，但 hook 异常只记录不阻断、`onOutput` 在错误时不触发、workflow tool step 不走 agent hook，不能 fail closed。hooks 只作 defense-in-depth。
- **把 Tool 执行移到 context-service**：强一致，但违反 Mastra 编排与 #17 的 Connector 接缝，v0 过重。
- **Policy evaluations 全由调用方传**：实现简单，但数据权限结果可被伪造或省略。改为工具策略由 mastra-app 评估、数据策略由 context-service 服务端追加。
- **只读 Run 默认不写 Decision**：审计轻，但“为什么这样回答”追不到；改为默认 `required`，只读且输出不可行动才可 `omitted`。
- **`decision_coverage` 按 Run 统计**：审批拒绝的 Run 会天然失败；改为 invocation 级，排除 deny/审批拒绝，`unknown` outcome 算完整。
- **digest 先脱敏或 HMAC**：降低低熵 PII 枚举风险，但 audit 不再精确标识实际动作，且 #12 已定 v0 不做应用层 CMK；v0 接受残余风险，记入 #21。

## Consequences

- Solution Spec 新增 `tools.<id>.audit`、`capabilities.<id>.audit.evidence`/`runOutcomeDecision`、`policyRefs` 的 object 形式和 `PolicyTemplate.spec.enforcementPoint`；build 对非 read Tool 缺审计、缺证据选择、缺 `tool.pre_invoke` 覆盖 fail closed，无 `--force`。
- `DecisionRequest` 新增 `invocation_id`、`action`、`status`，`evidence` 变 union，`PolicyEvaluation` 增加 `enforcement_point`/`evaluated_by`，`retention_class` 收紧为枚举，`fallback_used` 可选；`RetrievalItem` 增加 `classification`，`RetrievalResponse` 增加 `policy_evaluations`。契约升 `fde.runtime/v1.1`（additive + intent/outcome 语义收紧），不新增端点。
- `mastra-app` 需要 `decision_outbox` 表和恢复逻辑；outbox 写失败 fail closed；`executing` 状态不自动重试副作用，写 `status=unknown` outcome 并 P1 告警。
- `context-service` 在 Decision 写入时追加自己的数据策略评估，客户端伪造/省略会被拒绝；检索响应必须返回 item classification 与 policy evaluations。
- 只读 Run 也写 `phase=run` Decision，审计量增加；retention class 决定 outbox/审计的清理，legal hold 覆盖。
- 低熵 PII 的 digest 可被枚举，是已知残余风险；不引入 HMAC/CMK，后续安全票评估。
- 实现落在「架构综合与实施切片」：`@fde/runtime`、outbox 迁移、schema v1.1 codegen、build coverage 检查、Retrieval 字段、C26–C32 runner；本 ADR 不实现生产代码。
- GAP-5 关闭：生成的 wrapper 不再写空 `evidence`/`policy_evaluations`；`decision_coverage` 可以通过 conformance 验证，而不是“实现时临场补字段”。
