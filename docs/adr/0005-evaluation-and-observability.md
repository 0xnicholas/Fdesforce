---
status: accepted
---
# 评测与可观测性：Mastra-native、客户侧数据集、确定性 gate + 校准 judge

v0 的评测与验收采用三层结构：L1 Context Eval（上下文质量，CCP/Recipe 门禁）、L2 Capability Eval（答案级端到端，Bundle/Release 门禁）、L3 Deployment/SLO（上线后观察与 Acceptance Report）。L2 以 Mastra-native 的 scorers、版本化 datasets 和 experiments 为基础，加一个薄的 `fde eval` 编排；确定性 scorer 做 blocking gate，LLM judge 只做开放式质量且必须用人工标注集校准后才能参与门禁；数据集是客户环境资产，Bundle 只含定义与 scorer，生产日志不自动回流；遥测、在线评分和评测结果默认留在客户环境，工作台只接收客户批准的脱敏验收报告。这样验收可复现、可审计、可回滚，且不把工作台变成托管评测平台；代价是客户环境要承担评测运行/在线 judge 成本，v0 没有标注 UI、自动回滚和跨客户 benchmark。

完整指标、门禁、数据集治理、SLO、trace 关联、事故 playbook、保留期和 Acme 验收清单见 [`docs/evaluation-and-observability.md`](../evaluation-and-observability.md)；示例工件见 [`examples/eval/`](../../examples/eval/)。

## Considered Options

- **引入 promptfoo / DeepEval / Ragas 作为主评测框架**：生态成熟，但会引入第三套运行时、依赖和版本矩阵，还要把 Mastra 的 datasets/scorers 桥接过去；客户 bundle 更重，air-gapped 交付更复杂。改为 Mastra-native + `fde eval`，缺口用自定义 scorer 补。
- **单一加权 `quality_score` 作为发布依据**：汇报简单，但会掩盖 PII 泄漏、未授权副作用、审计缺写等零容忍失败，也无法跨 Capability 比较风险。改为指标向量 + blocking gates + threshold gates。
- **100% LLM judge**：实现省事，但 judge 自身不稳定、不可审计、成本高，未校准的 judge 不能做企业门禁。改为确定性 gate + 校准 judge + 人工抽检。
- **数据集打进 Bundle 或放在工作台统一管理**：评测分发方便，但 Bundle 会变成客户数据载体，工作台会持有客户数据，违反单客户 bundle 与数据驻留约束。改为客户侧版本化数据集，Eval Suite 只引用 digest。
- **遥测默认回传工作台**：运营方便，但破坏 air-gapped/数据驻留和客户信任。改为客户侧 OTel/eval store，回传只做 opt-in 脱敏摘要。
- **SLO 破线自动回滚**：响应快，但 v0 无 HA、无自动根因，误回滚风险高；P1/P2 必须有人确认。改为分级 playbook + 客户运维执行 stop-the-world 回滚。
- **所有数据保留 7 年**：合规直觉强，但成本/隐私不匹配，且不同数据类型价值不同。改为 `ephemeral`/`standard`/`extended`/`legal_hold` 分级。

## Consequences

- 新增 `fde eval` 命令面和 Metric Catalog/Eval Suite/Eval Dataset/Scorer/Gate/Acceptance Report/SLO/Online Evaluation/Retention Class/Incident Severity 领域术语；`docs/domain-model.md` 与 `GLOSSARY.md` 同步。
- v0 不新增 `fde.runtime/v1` wire 字段；`evaluation_id` 属于治理域，Evaluation/Decision 的字段映射由实现切片收敛。
- 客户环境需要可运行的 eval runner、客户侧 eval store、可选观测栈和 judge 模型凭据；不提供托管评测服务。
- 在线 judge 默认 2% 抽样，产生模型成本；客户必须配置每日上限。人工每月抽检和季度 judge 重校准是运维负担。
- `fde release approve` 必须执行 blocking gate/Evaluation/Waiver 检查；CI 需要接 `fde eval --gate`。
- 数据集 holdout 需要 ACL 和流程约束；v0 没有标注 UI，holdout 管理靠 Git/对象存储权限和 review packet。
- 现有 `docs/semantic-modeling.md` 的在线抽样示例从 5% 收敛到默认 2%，并链接本文；Context Eval 仍是 L1，不重复定义。
- 成本模型、Agent 安全威胁模型、长会话记忆仍在地图 fog；多 runtime 评测由「LangGraph 运行时映射缺口」评估。
