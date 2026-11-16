---
status: accepted
---
# Agent memory：Spec schema、namespace 隔离与显式写入

v0 的 `Agent.memory` 是运行编排状态，不是语义真相源：thread 记忆自动记录消息历史（关闭 Mastra workingMemory/semanticRecall），长期记忆只允许显式 `memory.remember` primitive 写入平台自有 `fde_memory` 表（状态存储同库、带 `schemaVersion`），任何记忆都不自动晋升为 Context Graph 事实、Decision evidence 或 Policy。隔离键为 `{tenant_id}/{environment_id}/{solution_id}/{agent_id}/{owner}`，不含 deployment revision 与 runtime family；跨 runtime 不迁移，只导出 `fde.memory/v1` JSONL 附件、不提供 import。记忆进入 prompt 时包成 `memory-block`（`trust=untrusted`），沿用 ADR-0009 的不可信内容规则；`ModelProfile.kind` 区分 `chat | embedding`，embedding 必填 `dimensions` 且禁止 fallback。这样两个 runtime（Mastra / LangGraph）共享同一 Spec 语义与表契约；代价是召回实现（FTS5 + 可选向量）由平台 `fde-runtime` 包承担，且禁止 runtime 原生自动抽取。

## Considered Options

- **使用 runtime 原生长期记忆（Mastra semanticRecall / LangGraph BaseStore）**：自动写入无法审计与隔离，跨 runtime 语义不一致，且 LangGraph Store 无 namespace 级删除；改为平台自有表 + 显式 primitive。
- **记忆晋升为图事实/Decision evidence（受控 `memory.promote`）**：模糊运行编排状态与语义真相源的边界，投毒面扩大；v0 不提供任何晋升路径，"记住偏好" 走 Spec 变更 + 重建。
- **namespace 绑定 deployment revision / bundle digest**：Release 升级会清空记忆，违背升级连续性；同 runtime 升级沿用同一 `mastra-state` 卷。
- **在线删除 API / 终端用户自助删除**：v0 删除依赖客户运维以 `fde-jobs` issuer 执行的 purge 作业，审计只记计数与 digest/tombstone，内容永不进审计。

## Consequences

- Spec 形状：`memory` 缺省 = 无记忆；`thread`（`lastMessages` 1–100，要求 Workflow `durable: true`）与 `longTerm`（`write: explicit`、`recall: semantic | none`、`scope: end_user | agent`、`embeddingProfile` 条件必填）独立开关；`retentionClass` 沿用保留类词表。
- 契约 `fde.runtime/v1.4.0`：`thread_not_found` 错误码；Capability 声明 `memory.thread` 时 `thread_id` 必填，归属不符返回 404 不给存在性探测；conformance C41–C48 与 adapter A12。
- 记忆治理作业（retention/purge/export）归 `fde-jobs` issuer；`legal_hold` 覆盖清理。
- 未实现：召回排序细节与性能调参留实施切片；v0 不做向量库选型、跨客户共享记忆、记忆 UI。
