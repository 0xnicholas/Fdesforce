---
status: accepted
---
# 架构综合与实施切片：合并顺序线性化、版本引用约定、两片式切片

架构综合（#13）确认 v0 端到端设计通顺，无需回补设计票；但合龙暴露了两处跨分支冲突和一组传播漂移，本 ADR 记录其中的真实取舍。第一，分支合并顺序与编号线性化：本分支（`prototype/11-solution-spec-skeleton` 及其上的 #19/#20/#21 工作）先并，ADR 0001–0009 不动；`design/runtime-adapter`（#17）合并时其 ADR-0007 重编号为 0010，其 additive 契约 delta 顺移为 `fde.runtime/v1.3.0`（`runtime-info` 的 `service` 统一为 `runtime-app`、`runtime`/`capability_details` 字段、`backend.graph: postgres`、A1–A11），版本史线性化为 1.0.0（#8）→ 1.1.0（#20）→ 1.2.0（#21）→ 1.3.0（#17）。第二，契约版本引用约定：`fde.runtime/v1` 一律指 major line，文档头部写当前 minor 全版本，依赖特定 minor 的字段在正文标注。第三，实施拆为两片：Slice 1「配置→部署→只读闭环」先把 Spec→Bundle→Compose→只读 Run→审计的全链路打穿（含一次真实模型 smoke），Slice 2「副作用与治理闭环」再叠加 approval gate、record-before-act、eval 证据链、真实 OIDC、安全基线与升级/回滚演练。这样每片都可独立验收、风险递进；代价是审批与写路径要到 Slice 2 才可用，Slice 1 的演示场景限于只读。

完整组件图、时序索引、冲突清单、切片验收标准与 ADR 索引见 [`docs/architecture-synthesis.md`](../architecture-synthesis.md)。本 ADR 不改变任何已定稿契约的语义。

## Considered Options

- **让 `design/runtime-adapter` 先并、本分支重编号**：两边对称，但本分支已有四份文档和 ADR-0005–0009 的交叉引用网络，重编号成本更高；且 #17 的 delta 语义上叠加在 v1.2.0 之上（它引用了 #18–#21 的字段），排在其后更贴近真实依赖。
- **两个 v1.1 并存、用分支限定词区分**：契约版本史会出现歧义，`runtime-info` 握手无法区分两个"1.1"，fail-closed 检查失去意义。线性化是唯一可验签的选择。
- **文档头与 manifest 全部 pin 当前 minor**：每个 additive minor 都要 bump 全部文档与工件清单，制造持续的机械 diff 噪声；major line 引用 + 头部写当前 minor 在 additive 语义下不损失精度。
- **单一最薄切片（含副作用与审批）**：端到端价值最早出现，但首片同时引入 identity、outbox、审批状态机与 eval gate，失败时无法定位是链路问题还是治理问题；两片切法让 Slice 1 的失败面只剩"配置到只读"。
- **三片或更细**：Slice 2 内部已有明确顺序（审批 → 审计 → eval → 身份 → 安全 → 部署演练），再拆票只增加跟踪开销；保持两片、片内排序。

## Consequences

- `design/runtime-adapter` 合并清单固定为：ADR → 0010、契约 → v1.3.0、`runtime-info` schema 同步、A1–A11 落入 `contracts/conformance/`、各文档头部版本 bump；合并后 prototype 的 `contract_version` 再随动。
- 文档与工件出现版本引用歧义时，按 [`runtime-contract.md`](../runtime-contract.md) §10.1 的约定解释，不再逐处争论。
- 切片实施另开 effort；Slice 1/2 的验收标准即各 component 的开工定义（见合成文档 §5）。
- GAP-1–GAP-5 全部关闭；prototype 恢复为一致性检查床（版本对齐到 v1.2.0）。
