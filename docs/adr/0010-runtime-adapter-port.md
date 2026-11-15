---
status: accepted
---
# 运行时 Adapter：构建期 RuntimeGenerator 端口，不做运行时抽象

v0 的可替换性收敛为构建期 `RuntimeGenerator` 端口：每个 runtime family 一个 generator，把 Solution Spec + Runtime Profile 转换为 app 源码、迁移、`RuntimeTopology` 片段和 contract tests；Runtime Profile 承载 10 组 `RuntimeCapabilities`，build 从 Spec 推导 `must / should` 并 fail closed；generator 只声明 runtime 片段，由平台与 context-service 拓扑合成唯一 `BundleTopology`；`runtime-info` 以 additive v1.3 统一为 `runtime-app` 并用结构化 `capability_details` 二次握手。这样换 runtime 是换 Bundle/Release，不是改 Spec 或客户 Run API；代价是旧 Run/checkpoint/thread 不能跨 runtime 迁移，第二 generator 仍需完整实现。

## Considered Options

- **运行时抽象层（universal `AgentRuntime` / `WorkflowRuntime`）**：checkpoint 重放语义、SSE 传输、Extension 加载、审批状态机与拓扑无法统一；硬抽象会把 Mastra/LangGraph 的差异漏进 context-service 或客户 API。
- **只保留 `runtimeProfile` 字符串，把能力写进 generator 代码**：无法在 build 时审阅/校验一个未安装的 generator，也无法对缺少能力 fail closed。
- **generator 输出完整 `BundleTopology`**：每个 generator 都必须知道 context-service 的端口、卷和迁移，第二 generator 会复制并逐渐漂移；改为片段合成。
- **每个 runtime family 增加一个 `service` enum**：每接一个 runtime 都改客户 Run API schema；改为 `runtime-app` + `runtime.family`。
- **v0 直接切 LangGraph**：Agent Server 的 Elastic-2.0 runtime 包、Postgres/Redis、license key 与 beacon egress 与 v0 的单客户、单节点、air-gapped 两服务拓扑冲突；v0 保持 Mastra only。

## Consequences

- `RuntimeProfile` 成为新的版本化 artifact；`solution.lock` 必须固定 profile digest、generator 版本和精确包版本。
- 第二 generator 仍需先定 [Workflow/HITL step grammar 与 policy 参数化](https://github.com/0xnicholas/Fdesforce/issues/18)、[record-before-act evidence 与审计绑定](https://github.com/0xnicholas/Fdesforce/issues/20)、[Agent memory 语义与 Spec schema](https://github.com/0xnicholas/Fdesforce/issues/22)；端口不能替它们做决定。
- 跨 runtime 切换是 stop-the-world 的新 Bundle/Release；旧 checkpoint/thread memory 不迁移，audit 不回滚，v0 不提供切换工具。
- `runtime-info` v1.3 是 additive，但 `RuntimeInfo.additionalProperties: false` 要求客户端 schema 同步升级；v0 尚未实现，按 minor 处理。
- 实现切片（`packages/runtime-generator`、Mastra generator、topology 合成/渲染、A-suite runner、`runtime-info` v1.3）归 [架构综合与实施切片](https://github.com/0xnicholas/Fdesforce/issues/13)。
