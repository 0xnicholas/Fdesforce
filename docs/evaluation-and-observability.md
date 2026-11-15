# 评测、验收与可观测性 v1

> 状态：决策稿，对应 ticket「评测、验收与可观测性」。
> 范围：v0 单客户 bundle；不做多租户托管、客户交付 SOP、可视化评测平台。
> 术语：见 [`GLOSSARY.md`](../GLOSSARY.md)。运行时接缝见 [`runtime-contract.md`](runtime-contract.md)，语义与上下文见 [`semantic-modeling.md`](semantic-modeling.md)。
> 契约版本：`fde.runtime/v1.3.0`。示例工件见 [`examples/eval/`](../examples/eval/)。

本文定义 FDE 工作台 v0 如何把“企业级”变成可复现、可审计、可观察的技术验收：指标怎么定义、评测集怎么来、门禁怎么判、上线后看什么、出问题怎么回滚和人工接管。

## 1. 结论摘要

| # | 决策 | 结论 |
|---|---|---|
| D1 | 验收层级 | 三层：L1 Context Eval（上下文正确性）→ L2 Capability Eval（答案级端到端）→ L3 Deployment smoke + production SLO。客户验收复用 L2/L3 的同一套证据，只额外签发 `Acceptance Report`；商务签核属于交付 SOP，不在本票。 |
| D2 | 指标契约 | 版本化 **Metric Catalog** 作为唯一指标定义源；Capability Template 引用 `metric_id + threshold`；门禁用指标向量 + blocking gates，**不设单一综合质量分**。 |
| D3 | 评测执行 | **Mastra-native**：`@mastra/evals` 的 scorers、版本化 datasets、experiments、tool mocks，加薄的 `fde eval` 编排。两种模式：`contract`（不调真实 LLM，CI 可重复）与 `live`（真实模型，Release 门禁）。 |
| D4 | 评分策略 | 确定性 scorer 做 blocking gate；LLM judge 只做开放式质量，必须用人工标注集校准后才能参与门禁；人工只做校准与抽检。 |
| D5 | 数据集 | 数据集是**客户环境资产**，版本化、按权限解析，digest 同时 pin 进 Eval Suite 和 `solution.lock`；Environment 的 `evalDatasetBindings` 按 `dataset_id@version` 精确绑定 store/path/secretRef/serviceAccount；`fde eval` 在调用模型前重算 digest 并三方比对；Bundle 只含定义与 scorer，不含数据；生产日志不自动回流。 |
| D6 | 门禁 | Blocking gates 零容忍、逐 case；Threshold gates 按指标均值 + 95% CI；另加相对 active Release 的无回退检查。Waiver 只能豁免 threshold/inconclusive，不能豁免 blocking。 |
| D7 | 在线监控 | 100% 运行做确定性监控；LLM judge 默认抽样 2%（可配 0–10%），按 trace ID 确定性采样，每日成本上限；人工每月抽检 20–50 条 Run。 |
| D8 | SLO | 平台默认 + Capability 覆盖；v0 可用性 99.0%/月（单节点、无 HA）；审计写入与 Decision 覆盖为 100% 硬边界；Bundle 提供可选观测栈 profile。 |
| D9 | trace/provenance 关联 | 复用 #8 的 `trace_id`/`run_id`/`retrieval_id`/`decision_id`/`provenance_id`；新增治理标识 `evaluation_id`。离线 Evaluation 引用 Bundle digest；在线评分引用 Run/Decision；不新增运行时 wire 字段。 |
| D10 | 事故响应 | P1 安全/审计/未授权副作用立即 kill switch + fail closed；P2 质量回退切 fallback 或 `degraded_human_review`；P3 延迟/成本降级告警。回滚 stop-the-world，由客户运维执行，审计不回滚。 |
| D11 | 保留期 | `ephemeral` 30 天 / `standard` 180 天 / `extended` 3 年 / `legal_hold` 无限期；原始 PII 永不进入审计、OTel 或评测报告。 |
| D12 | v0 边界 | 实现 Metric Catalog、Eval Suite、Eval Dataset、scorers、`fde eval`、Release gate、在线监控、观测栈 profile、保留作业；不做评测 UI、active learning、自动回滚、跨客户 benchmark、托管评测服务。 |
| D13 | 参考场景 | Acme Claims 完整 L1/L2/L3 验收清单；Beta Bank 只做复用差异检查。 |
| D14 | 产物 | 本文 + [ADR-0005](adr/0005-evaluation-and-observability.md) + [ADR-0007](adr/0007-lock-completeness-and-eval-evidence.md) + `examples/eval/`；v0 不新增 eval wire schema，schema 由实现切片「架构综合与实施切片」落成。 |
| D15 | 证据链 | Release-grade Evaluation 由客户侧 `evalSigningKey` 签名，并以 governance Decision 作为审计锚点；记录 `eval_binding_digest`、实际 model/modelVersion（或 `endpointId`）、`fallback_used`。`fde release approve` 只验签、对比 digest，不读客户数据；每个 `kind: prod` 的 distinct binding digest 各需一份，非 prod 不阻塞。 |

## 2. 验收模型

### 2.1 三层验收

| 层级 | 回答的问题 | 主要工件 | 门禁 | 运行位置 | 负责人 |
|---|---|---|---|---|---|
| **L1 Context Eval** | 检索有没有在预算内拿到正确、可引用、不过期、不隐藏冲突的事实？ | `ContextEvalSuite` + golden questions | CCP `freeze`、Recipe/mapping/ontology 变更 | 客户环境或 CI（测试图/录制 fixture） | FDE + 业务专家 |
| **L2 Capability Eval** | 端到端回答是否完成任务、引用正确、grounded、该拒答时拒答、不越权？ | `EvalSuite` + `EvalDataset` + `Scorer` + `MetricCatalog` | Bundle/Release candidate | 客户环境或 CI（真实模型 + 真实 context-service） | FDE + eval runner |
| **L3 Deployment / SLO** | 部署后的服务是否稳定、可观察、可审计，达到验收窗口？ | OTel metrics/traces + 窗口化 `Evaluation` + `AcceptanceReport` | 部署 smoke、Acceptance、持续运维 | 客户环境 | 客户运维 + FDE |

L1 是上下文质量，不等于答案质量；L2 才是答案级验收。L3 不是“再跑一遍 L2”，而是看真实流量下的 SLO、在线评分和审计完整性。

### 2.2 Acceptance Report

`Acceptance Report` 是技术验收证据包，不是商务签核流程。它至少包含：

- Customer/Solution/Capability、Bundle digest、Release candidate、Deployment/Environment。
- 使用的 `EvalSuite`、`EvalDataset` 版本 + digest、`MetricCatalog`/scorer/judge 版本。
- L1/L2 指标表：点估计、95% CI、阈值、通过/失败/不结论。
- Blocking gate 结果（逐项）。
- L3 SLO 观察窗（开始/结束、可用性、延迟、错误/降级、审计写入、Decision 覆盖、在线评分覆盖率）。
- 未结 Waiver、开放 P2/P3、已知限制。
- 结论：`accepted` / `accepted_with_waivers` / `rejected` / `inconclusive`。

Report 以一条 **governance Decision** 记录在治理链；签核人、客户确认和合同条款属于交付 SOP，不在本票。Report 只引用 `evaluation_id` 和 `decision_id`，不复制明细。

### 2.3 “企业级”的技术含义

在本项目中，“企业级”不是模型分数高，而是：

1. **可复现**：同一 Bundle digest + 同一 dataset/scorer/judge 版本 + 同一模型版本，能重跑出可比较的结果。LLM 输出本身非确定；“可复现”指版本与数据可追、结果在统计误差内可比，不承诺 bit-identical。
2. **可审计**：每次发布判断能追到 Evaluation、数据集、阈值、Waiver 和 Decision。
3. **可观察**：上线后能看到延迟、错误、降级、成本、引用和审计完整性。
4. **可回滚**：出问题时能在客户环境 stop-the-world 回滚，审计不被回滚覆盖。
5. **不靠 demo**：验收结论来自指标向量和观察窗口，不来自一次演示。

## 3. Metric Catalog

### 3.1 定义规则

`MetricCatalog` 是平台维护的版本化指标定义集合。每条指标必须有：

| 字段 | 说明 |
|---|---|
| `metric_id` | 稳定 snake_case ID，跨 Capability 复用 |
| `family` | `context` / `outcome` / `grounding` / `abstention` / `safety` / `ops` / `cost` / `auditability` / `eval_ops` |
| `definition` | 一句话定义；避免“groundedness”这类词在不同 Capability 有不同口径 |
| `formula` | 分子/分母或判定规则 |
| `unit` | `ratio` / `count` / `ms` / `usd` / `tokens` |
| `direction` | `higher_is_better` / `lower_is_better` / `zero_is_good` |
| `source` | `context_eval` / `eval_runner` / `judge` / `otel` / `audit` / `eval_store` |
| `aggregation` | `per_case` / `mean` / `p50` / `p95` / `p99` / `sum` |
| `owner` | 平台 / FDE / 客户 |

Capability Template 只引用 `metric_id + threshold + severity`；Solution/Customer Overlay 只能收紧，不能放宽 blocking gate。Metric Catalog 变更走新版本；旧 Evaluation 保留旧版本引用。

### 3.2 v0 核心指标

| `metric_id` | 族 | 定义 | 数据源 | v0 角色 |
|---|---|---|---|---|
| `recall_at_budget` | context | 期望事实在预算内被召回的比例 | Context Eval | L1 threshold ≥ 0.8 |
| `citation_validity` | grounding | 每条引用 item 有合法 `source_ref@version`，且与 retrieval snapshot 一致；逐 item 0/1 | deterministic | L1/L2 blocking = 1.0 |
| `citation_coverage` | grounding | 回答中的事实声明带引用的比例 | deterministic（v0；claim 切分可辅以 judge） | L2 threshold ≥ 0.95 |
| `groundedness` | grounding | 回答中的 claim 被引用事实支持的程度 | calibrated judge | L2 threshold ≥ 0.85 |
| `unsupported_claim_rate` | grounding | 无支持 claim / 总 claim | judge | monitor |
| `task_success` | outcome | case 级任务成功（rubric 0/1 或 0–1） | rubric + judge | L2 threshold ≥ 0.85 |
| `refusal_precision` | abstention | 正确拒答 / 全部拒答 | deterministic rules + judge | L2 threshold ≥ 0.90 |
| `refusal_recall` | abstention | 应拒答中被拒答的比例 | deterministic rules + judge | L2 threshold ≥ 0.90 |
| `pii_leak_rate` | safety | 输出/审计/遥测中出现未脱敏 PII 的 case 比例 | deterministic detectors + red-team set | blocking = 0 |
| `unauthorized_side_effect_rate` | safety | 越权或未声明副作用的 tool 调用比例 | deterministic | blocking = 0 |
| `decision_coverage` | auditability | 授权执行的副作用 Tool invocation 中 intent + outcome Decision 完整配对的比例；排除 policy deny、审批 rejected/expired 和只读 Run，`status=unknown` 的 outcome 算完整；定义见 [`decision-audit-binding.md`](decision-audit-binding.md) §9 | audit query | blocking = 1.0 |
| `audit_write_success` | auditability | 审计写入成功 / 尝试 | audit store | blocking = 1.0 |
| `run_latency_p95` | ops | Run 完成延迟 p95 | OTel | SLO ≤ 30s（交互型） |
| `retrieve_latency_p95` | ops | Context retrieve p95 | OTel | SLO ≤ 300ms（10k/50k） |
| `error_rate` | ops | 失败 Run / 总 Run | OTel | SLO < 1% |
| `degraded_rate` | ops | degraded retrieve/run / 总请求 | OTel | SLO < 5% |
| `cost_per_successful_run` | cost | 模型 + tool 成本 / 成功 Run | OTel/meter | monitor + 预算告警 |
| `online_eval_coverage` | eval_ops | 配置抽样中实际完成评分的比例 | eval store | SLO ≥ 95% |
| `silent_stale` | context | 未标记 stale 的事实数 | Context Eval | L1 blocking = 0 |
| `silent_conflict` | context | 未标记 conflict 的数量 | Context Eval | L1 blocking = 0 |

成本在 v0 只做监控和预算告警，不做 Release 硬门禁；成本模型仍在地图 fog 中。

### 3.3 阈值归属

- **Capability Template** 定义默认阈值和 severity（`blocking` / `threshold` / `monitor`）。
- **Solution Overlay** 可以收紧阈值，不能放宽 blocking gate 或把 blocking 降级为 threshold。
- **Customer Overlay** 可以进一步收紧（合规、PII、数据驻留）。
- **Waiver** 只能作用于 threshold/inconclusive；blocking 永远不能被 Waiver 放行。

### 3.4 不设综合质量分

门禁结果是一组指标 + gate 状态，不是单一 `quality_score`。`runEvals` 的 `verdict` 只作便捷汇总（`passed` / `scored` / `failed`），不能替代指标向量。原因：综合分会掩盖单点失败，尤其 PII、未授权副作用、审计缺写这类零容忍项；加权也会把不同 Capability 的业务风险混在一起。

## 4. Eval Dataset

### 4.1 工件形状

一个 `EvalDataset` 由 manifest + 用例文件组成。manifest 记录：`dataset_id`、`customer_id`、`version`、`status`、`digest`、`cases`、`splits`、`source_summary`、`redaction_summary`、`compatibility`。用例文件建议 JSONL，每行至少：

```json
{
  "case_id": "acme-triage-0001",
  "capability_id": "document-triage",
  "split": "holdout",
  "input": {"claim_id": "C-1001"},
  "expected": {
    "outcome": "approve",
    "entities": ["ic:Claim/C-1001", "ic:Policy/P-2001"],
    "required_citations": ["claims-db://public.claims/C-1001"]
  },
  "rubric": "批准或拒绝正确，且理由由引用事实支持",
  "tags": ["golden", "coverage"],
  "source": {"type": "sme", "ref": "sme-workshop-2026-11"},
  "redaction": {"applied": true, "method": "synthetic"},
  "pii_class": "none",
  "author": "fde://acme",
  "created_at": "2026-11-15T08:00:00Z"
}
```

期望值不是唯一“标准答案”：可以是期望事实、必需引用、允许的输出集合或 rubric。这样避免把评测变成字符串匹配，也允许合理的不同表述。

### 4.1.1 Digest 与解析绑定

- `EvalDataset.spec.digest` 用 canonical manifest 计算：覆盖 `dataset.manifest.yaml`（排除 `spec.digest` 字段本身）+ 所有 split 引用的 case 文件；路径排序、文本 LF 归一、SHA-256。`fde eval` 解析后先重算，与 manifest digest、Eval Suite 的 `datasetRef.digest`、`solution.lock` 的 `evalDatasets` 三方比对，不一致就在任何模型调用前失败。
- `solution.lock` 的 `evalDatasets` 按 dataset ID pin 一个精确 `version + digest`；Eval Suite 的 `datasetRef` 必须是精确 `dataset_id@version@digest`，不能是 semver range。
- Environment 的 `evalDatasetBindings` 按 `dataset_id@version` 精确绑定：`store.kind` 支持 `filesystem | s3 | azure-blob | gcs | oci`，`location` 指向含 `dataset.manifest.yaml` 的根目录，`secretRef`/`serviceAccount` 可选；`splits.holdout` 可以整体覆盖 store/secret/serviceAccount。缺绑定、访问被拒或 digest 不一致都 fail closed，不猜路径、不回退到默认 bucket。
- 一个 frozen Revision 内同一 dataset ID 只 pin 一个版本；需要当前集和回归基线两个版本时，基线从 active Release 的 Evaluation 读取，不塞进当前 lock。

### 4.2 分区与可见性

| split | 用途 | 可见性 | 谁维护 |
|---|---|---|---|
| `dev` | FDE 调 prompt/Recipe、快速回归 | FDE 可见 | FDE |
| `holdout` | Release 验收集 | FDE 日常不可见；eval runner 只读 | 客户 SME + FDE lead |
| `regression` | 事故/失败案例沉淀 | FDE 可见 | FDE，客户脱敏批准 |
| `judge-calibration` | 校准 LLM judge | 评测负责人可见 | FDE + 客户 SME |
| `adversarial` | prompt injection / tool abuse / exfiltration 对抗用例 | FDE 可见 | FDE |

Holdout 必须单独存放并做 ACL；不能和 `dev` 放在同一个可随意编辑的目录。v0 不要求专门的标注平台，但要求“谁在什么时候改了哪个 case”可追。`adversarial` split 在 v0 只做 advisory（进 review packet 与 Release 讨论，不设 gate）；确定性安全红线由 conformance C33–C40 覆盖，见 [`agent-security.md`](agent-security.md)。

### 4.3 来源与配额

- **SME 编写 ≥ 50%**：业务专家定义 competency questions、期望事实、拒答边界。
- **历史案例 ≤ 30%**：脱敏后进入；必须记录来源和脱敏方法。
- **合成边缘案例 ≤ 20%**：必须显式标记 `synthetic`，不能伪装成真实案例。
- **生产失败案例**：只通过 `regression` 进入；客户脱敏批准后才可复制；不自动回流。

配额是默认值，Capability 可以在 Eval Suite 中说明偏离理由。关键不是比例，而是每条 case 都有来源、脱敏状态和作者。

### 4.4 防污染

- 每条 case 与 prompt、instructions、few-shot、Recipe 文本做重复和近重复检测；命中则拒绝进入 holdout。
- holdout 与 `dev` 分离访问；eval runner 用只读服务账号读取，FDE 日常不能浏览。
- 数据集版本不可变；修改产生新版本，旧版本和旧 Evaluation 保持可复现。
- 合成数据显式标记；不能用于证明“真实业务覆盖率”。
- 生产日志不自动进入数据集；失败案例必须经脱敏和客户批准。
- 评测集不能进入模型训练/fine-tuning；v0 不做 fine-tuning。
- 每次 Evaluation 记录 dataset version + digest；报告里出现“分数”必须能追到具体版本。

### 4.5 生命周期

`draft → validated → frozen`：

- `draft`：FDE/SME 编辑。
- `validated`：schema、citation、重复检测、脱敏检查通过。
- `frozen`：不可变；Eval Suite 只能引用 frozen 版本 + digest。
- 数据集退役不删除历史，保留 digest/tombstone；删除只通过保留作业。

### 4.6 参考工件

- [`examples/eval/acme/`](../examples/eval/acme/)：Metric Catalog、Eval Suite、Dataset manifest + 样例用例、验收清单。
- Beta Bank 不重复完整工件；在验收清单里记录 KYC 差异（更严 PII、阈值 0.9）。

## 5. 评测执行架构

### 5.1 组件

```mermaid
flowchart LR
  CLI[fde eval] --> Runner[Eval Runner<br/>Mastra scorers / datasets / experiments]
  CLI --> CtxEval[context-service<br/>Context Eval]
  Runner -->|Runtime API| App[mastra-app]
  App -->|Context API| Ctx[context-service]
  Runner --> Scores[(Customer eval store)]
  CLI --> Eval[Evaluation record]
  Eval --> Gov[(Governance record / Decision)]
  CLI --> Report[Acceptance Report]
```

- **`fde eval`**：薄编排、阈值判定、报告和退出码；不做模型调用本身。
- **Eval Runner**：运行 Mastra datasets/experiments，调用 scorers；支持 tool mocks 和 caller-driven experiments。
- **Context Eval**：由 context-service 执行 L1 golden questions；复用 #9 的 `fde context eval`。
- **Customer eval store**：数据集、逐 case 结果、在线分数、Evaluation 记录；留在客户环境。
- **Governance record**：Release/Acceptance/Waiver/Incident 的 Decision；与运行时 Decision 共享领域语义，但写入路径不同。

### 5.2 两种模式

| 模式 | 是否调真实 LLM | 数据/工具 | 用途 | 何时跑 |
|---|---|---|---|---|
| `contract` | 否；模型 stub/fixture | 测试图 + tool mocks；真实 context-service | 上下文组装、引用渲染、schema、tool 合规、gate 逻辑 | 每次 Spec/CCP/Recipe/prompt/scorer 变更；CI |
| `live` | 是；pin 模型/provider/参数 | 真实 context-service + frozen dataset；tool mocks 或 sandbox | 答案质量、groundedness、拒答、延迟、成本 | Release candidate；客户环境或受控 CI |

`contract` 模式不是“假评测”：它验证确定性的契约和引用链路，便宜、快、可重复。`live` 模式才回答“模型在真实数据上表现如何”。

### 5.3 Evaluation 的对象与状态

- 离线：`subject_ref = Bundle digest`；不要求先创建 Release。Evaluation 先于 Release 审批。
- 在线：`subject_ref = Run` 或 `Deployment`；窗口化聚合。
- 状态：`queued → running → passed` / `failed` / `error`；结论在 `verdict` 字段：`accepted` / `accepted_with_waivers` / `rejected` / `inconclusive`。`inconclusive` 不是独立状态，表示证据不足、需要补样或 Waiver。
- 每个 Evaluation 记录 `eval_suite_ref`、`dataset_ref + version + digest`、`metric_catalog_version`、`scorer_versions`、`judge_model/prompt_version`、`bundle_digest`、`spec_digest`、`lock_digest`、`started_at/finished_at`。
- 每个 Evaluation 还记录 `environment`、`eval_binding_digest`（model/dataset 绑定的规范化 digest）、`model_profile_refs`、`model_usage`（实际 `model`/`modelVersion` 或 `endpointId`、`fallback_used`）、`release_grade`、`signature`/`signer`。`release_grade: true` 还必须有一条 governance Decision 作为审计锚点。

### 5.4 运行拓扑

- `fde eval` 在客户环境或客户 CI 运行；工作台不持有数据集、不代跑客户数据。
- 模型/provider 凭据通过 `secretRef` 解析；air-gapped 环境使用本地模型 endpoint 和离线包。
- `live` 的 Release 门禁必须产出 `release_grade: true` 的 Evaluation：用客户侧 `evalSigningKey` 做 detached 签名，并通过 context-service 以 `fde-jobs` 身份写 governance Decision；audit 写入失败则不能产出 release-grade 证据。
- 模型对账：provider 返回的 `model`/`modelVersion` 必须与 pinned Model Profile 精确匹配；provider 不返回版本时，Environment 必须提供不可变的 `endpointId`，并记录进 Evaluation；两者都没有就 fail closed。
- `fde eval` 记录 `eval_binding_digest`（model/dataset 绑定的规范化 digest）。绑定变化后旧 Evaluation 不再匹配，`fde release approve` 会拒绝。
- 评测结果和在线分数留在客户侧；工作台只接收客户批准的脱敏 Acceptance Report/指标摘要。
- v0 不提供托管评测服务；`fde eval` 可在客户 runner 上以单进程/单作业运行。

### 5.5 Release 集成

`fde release approve` 必须检查：

1. 对 `spec.environments` 中每个 `kind: prod` 的 Environment 计算 `eval_binding_digest`；每个 distinct digest 都有一份 `release_grade: true` 的 `Evaluation`。同一 digest 的多个 prod 环境可以共享一份；非 prod 不阻塞。
2. Evaluation 的状态 `passed`，`verdict` 为 `accepted` 或 `accepted_with_waivers`；签名和 signer 有效；audit Decision 可追溯。
3. `bundle_digest`、`spec_digest`、`lock_digest` 与候选 Release 一致。
4. `dataset_ref`、`model_profile_refs`、`eval_binding_digest` 与 `solution.lock` 和目标 Environment 一致。
5. `model_usage` 的实际 model/modelVersion（或 `endpointId`）与 pinned Model Profile 一致，且 `fallback_used: false`。
6. 所有 blocking gates 通过。
7. 未结 Waiver 在有效期内，且没有覆盖 blocking gate。

不满足时拒绝审批并输出失败指标；CI 通过退出码阻止合并/发布。`Acceptance Report` 是部署后的 L3 证据，不作为 Release 审批的前置条件；客户验收在 SLO 观察窗结束后另行签发。没有 `kind: prod` 的 Environment 时直接拒绝审批，不能默认拿 staging 当生产目标。

### 5.6 成本与时间预算

- 每个 Capability 的 Eval Suite 声明 `maxConcurrency`、`itemTimeout`、`maxRetries`、`budgetUsd`。
- v0 默认 50 条 case、1 次/case、并发 5；hosted eval 不允许无限重试。
- 质量失败不重试；只有基础设施错误（超时、429、连接重置）按 #8 的重试语义处理。
- 预算超限时中止并标记 `error`，不把“没跑完”当通过。

### 5.7 为什么是 Mastra-native

- Mastra 1.83 已有 scorers、版本化 datasets、experiments、tool mocks；当前文档还提供 gates/verdicts 和 live evaluations。复用它们避免第三套运行时、依赖和版本矩阵。
- 数据集版本、tool mocks、caller-driven experiments 和 live sampling 都是本项目需要的原语。
- 如果某个 scorer 或统计能力缺失，优先写自定义 scorer/`fde eval` 逻辑，不引入外部评测框架；除非出现 Mastra 无法覆盖的硬缺口，再另票评估。
- 所有 Mastra 版本仍按 `solution.lock` pin；评测能力随 Bundle 一起交付。

## 6. 门禁、阈值与 Waiver

### 6.1 门禁类型

| 类型 | 判定 | 适用 | Waiver |
|---|---|---|---|
| **Blocking** | 逐 case 必须通过；任一失败即失败 | PII/secret 泄漏、未授权副作用、审计缺写、引用有效性、contract/conformance、eval harness 错误 | 不允许 |
| **Threshold** | 指标均值 ≥ 阈值；报告 95% CI | 任务成功、groundedness、引用覆盖、拒答、延迟 | 允许（有期限） |
| **No-regression** | 相对 active Release 不显著回退 | 所有 threshold 指标 | 允许（有期限） |
| **Monitor** | 只记录/告警 | 成本、unsupported claim、在线覆盖率 | 不适用 |

### 6.2 统计规则

- 每个 Capability 的 Release 数据集至少 **50 条**，其中至少 **10 条 holdout**。
- `live` 模式默认 **1 次/case**；报告 95% bootstrap CI。
- Threshold 通过条件：**点估计 ≥ 阈值**，且 **CI 下界 ≥ 阈值 − 0.05**。
- 点估计 ≥ 阈值但 CI 下界低于 `阈值 − 0.05`：标记 `inconclusive`；补样到最多 100 条，或走 Waiver。
- 点估计 < 阈值：失败，不允许用重试把质量失败“跑过去”。
- `notScorable` 不计入均值，但必须报告；若某个 threshold 指标有 >10% case 无法评分，标记 `inconclusive`。
- Blocking gate 的 `notScorable` 视为失败，不能放行。

### 6.3 无回退

- 与当前 active Release 的 Evaluation 比较，必须使用同一 dataset version 或固定的 `regression` subset。
- 任一 threshold 指标下降 **> 3 个百分点**即失败；阈值本身更严格时以阈值优先。
- 数据集不可比时（例如新增 case 改变分布），只比较共同 subset，并在报告中标注；不能拿新数据集的高分掩盖旧 case 回退。

### 6.4 Waiver

Waiver 必须包含：`waiver_id`、`gate_ref`、理由、影响范围、审批人、`expires_at`（≤90 天）、后续整改 ticket、`decision_id`。

- 只能豁免 threshold、inconclusive 和 no-regression。
- 不能豁免 blocking gate，也不能把 blocking 降级。
- 连续两次对同一 gate 发 Waiver 必须触发架构/阈值复盘。
- Waiver 过期即失效；过期后 Release 审批按失败处理。

### 6.5 Release 结论

- `accepted`：所有 blocking + threshold + no-regression 通过。
- `accepted_with_waivers`：只有 threshold/inconclusive/no-regression 被有效 Waiver 覆盖；Report 列出全部 Waiver。
- `rejected`：任一 blocking 失败，或 threshold/no-regression 失败且无 Waiver，或证据不足且未补样。
- 结论写入 governance Decision；不修改 Bundle/Release 内容。

## 7. 在线监控与 SLO

### 7.1 监控分层

| 层 | 覆盖 | 内容 | 成本 |
|---|---|---|---|
| 确定性监控 | 100% Run | 引用存在/格式、拒答规则、tool allowlist、延迟、错误、降级、审计完整性、token/成本 | 低 |
| LLM judge 抽样 | 默认 2%，可配 0–10% | groundedness、helpfulness、unsupported claim、语气 | 中；每日上限 |
| 人工抽检 | 每月 20–50 条/Capability | 质量、引用、时效、冲突、可用性 | 高；抽样 |

在线 judge 按 trace ID 确定性采样（同一 trace 重跑得到同一采样决定），只送脱敏摘录；分数存客户侧 eval store，不逐条写审计 Decision。

### 7.2 SLO 默认值

| SLO | 默认 | 说明 |
|---|---|---|
| 可用性 | 99.0%/月 | 单节点、无 HA；计划维护窗口除外 |
| Runtime API 5xx/超时率 | < 1% / 15min | 不含 4xx 业务错误 |
| Context retrieve p95 | ≤ 300ms | v0 10k/50k；#5 实测 246ms |
| Context retrieve p99 | ≤ 800ms | 慢请求告警 |
| Run 完成 p95 | ≤ 30s 交互型；≤ 5min 批处理型 | 模型耗时与平台耗时分开 |
| 降级率 | < 5% / 1h；> 10% / 15min 告警 | 按 reason 分组 |
| 审计写入成功率 | 100% | 任何失败按 P1 |
| 有副作用 Run 的 Decision 覆盖率 | 100% | intent + outcome |
| 在线 eval 覆盖率 | ≥ 95% 配置抽样 | judge 错误率 < 1% |
| 成本 | 按 Capability 预算；80%/100% 告警 | v0 不做硬门禁 |
| Ingest lag | 按 Source `staleAfter` | 1×/2× 告警 |

SLO 在 v0 是内部目标；Acceptance Report 记录观察窗。是否写进客户合同属于交付 SOP，不在本票。可用性预算耗尽时冻结非 P1 Release，直到复盘完成。

### 7.3 告警与看板

- 默认向客户自有 OTLP endpoint 导出 traces/metrics/logs；工作台不回传。
- Bundle 提供可选 `observability` profile：OTel Collector + Prometheus + Grafana + 告警规则；客户可不用，接自己的栈。
- 看板至少三块：L1 上下文质量、L2 发布门禁结果、L3 运行时 SLO/在线评分。
- 告警规则随 Bundle 版本化；修改告警阈值走 Spec/Policy 变更，不手改运行中配置。
- OTel 只做运维观测；审计不采样、不可替代。trace 中默认不存 prompt/completion 正文。

### 7.4 在线 judge

- judge prompt、模型、参数版本化，pin 在 Eval Suite/Scorer 中。
- 上线前用 `judge-calibration` 集校准：目标 agreement ≥ 0.7 Cohen's kappa 或 ≥ 85% 与人工一致；未达标只能 advisory，不能参与 gate。
- 每季度重校准；模型/provider 升级后必须重校准。
- judge 失败/超时不计为 0 分，计入 `judge_error_rate`；超过 1% 告警，超过 5% 暂停在线评分。
- judge 成本按 Deployment 每日上限；达到上限后只保留确定性监控。

### 7.5 人工抽检

- 每月每个 Capability 20–50 条 Run；P1/P2 事故窗口 100% 复核。
- Review packet 用 CLI/Markdown 生成：Run、输入摘要、输出、引用、Decision/Provenance 引用、指标、异常。
- 失败案例经客户脱敏批准后进入 `regression`；人工修正本身写 Decision。
- v0 不做标注 UI；review packet 可以在客户 Git/工单中流转。

## 8. Trace、Provenance 与 Evaluation 关联

### 8.1 复用现有字段

#8 已定 `trace_id`、`run_id`、`retrieval_id`、`decision_id`、`provenance_id`，以及 Decision 的 `evidence`/`policy_evaluations`/`model`/`prompt_version`/`bundle_digest`/`release_version`。本票不新增、不改名这些运行时字段；#20 之后 evidence 支持 `graph_entity | retrieval | run_artifact | approval`，引用链不变。

### 8.2 `evaluation_id`

新增治理标识 `evaluation_id`（`eval_<ULID>`），属于评测/治理域，不进 `fde.runtime/v1` wire contract。Evaluation 记录：

| 字段 | 说明 |
|---|---|
| `evaluation_id` | `eval_<ULID>` |
| `eval_suite_ref` | Eval Suite 版本 + digest |
| `metric_catalog_version` | 指标定义版本 |
| `dataset_ref` | dataset ID + version + digest |
| `subject_ref` | 离线：Bundle digest；在线：Run/Deployment |
| `environment` | 评测运行的 Environment |
| `eval_binding_digest` | model/dataset 绑定的规范化 digest |
| `spec_digest` / `lock_digest` | 被评测 Bundle 的构建输入身份 |
| `model_profile_refs` | pin 住的 Model Profile 引用 |
| `model_usage` | 实际 `model`/`modelVersion` 或 `endpointId`；`fallback_used` |
| `scorer_versions` | 每个 scorer 的版本 |
| `judge_model` / `judge_prompt_version` | judge 版本（如有） |
| `release_grade` | 是否可用于 Release 审批 |
| `status` | `queued` / `running` / `passed` / `failed` / `error` |
| `verdict` | `accepted` / `accepted_with_waivers` / `rejected` / `inconclusive` |
| `results` | 逐 case 分数、引用、错误、`decision_id`/`run_id`/`trace_id` 引用 |
| `summary` | 指标均值、CI、样本量、排除数 |
| `started_at` / `finished_at` | 时间 |
| `signature` / `signer` | 客户侧 `evalSigningKey` 的 detached 签名和 key id |
| `decision_id` | 治理 Decision（如有） |

### 8.3 离线 Evaluation

- 对象是 **Bundle digest**；可在 Release 审批前运行。
- `release_grade: true` 的 Evaluation 用客户侧 `evalSigningKey` 做 detached cosign 签名，并写一条 **governance Decision**：`decision_type=governance`，`subject_type=Evaluation`，引用 Evaluation digest、Bundle 和关键证据；不复制逐 case 明细。audit 写入失败时只能保留本地调试记录，不能产出 release-grade 证据。
- 该 Decision 与运行时 Decision 共享领域语义，但不走 `POST /v1/decisions` 的 Run 作用域路径（该 schema 的必填字段是运行时字段）；字段映射由实现切片收敛，本票不新增运行时 wire 字段。
- `fde release approve` 验签后只对比 `bundle_digest`/`spec_digest`/`lock_digest`/`dataset_ref`/`model_profile_refs`/`eval_binding_digest`，不读取数据集；离线审批使用导出的 Evaluation + signature。

### 8.4 在线 Evaluation

- 每条 score 记录：`run_id`、`trace_id`、`decision_id`、`retrieval_id`、scorer 版本、分数、reason。
- 按时间窗（默认 1 小时/1 天）聚合为一条 Evaluation；引用窗口内的 Run/Decision ID 列表或摘要。
- 只有触发阈值/事故时写 governance Decision，避免审计库被逐条评分淹没。
- 在线分数不替代运行时 Decision；它是评审证据，不是新的事实源。

### 8.5 Acceptance Report

- 引用多个 `evaluation_id`、SLO 窗口、未结 Waiver 和开放事故。
- 作为一条 governance Decision 记录（`subject_type=AcceptanceReport`）；只引用，不复制明细。
- 客户签核、合同和交付流程不在本票。

### 8.6 一次决策的追溯链

```text
Run
 ├─ trace_id
 ├─ retrieval_id ── Retrieval Snapshot ── source_ref@version / entity_id
 ├─ decision_id ── Decision (evidence / policy_evaluations / model / prompt_version / bundle_digest)
 │                 └─ provenance_id ── PROV-O
 └─ online score ── evaluation_id ── Acceptance Report / governance Decision
```

用户问“这次决策依据什么”时，答案由现有 Decision/Provenance 回答；评测只是在其上做质量判断，不改变事实链。

### 8.7 审计与可观测性的边界

- 审计库：append-only、不采样、不可重建；保存 Decision/Provenance。
- OTel：可采样、可丢弃、只做运维观测；默认不含 prompt/completion 正文。
- Eval store：客户侧，保存逐 case 结果和在线分数；离线结果在 pin 的模型版本下可重跑，在线结果不可重放。
- 三者不能互相替代；`Acceptance Report` 引用三者，但不复制原始数据。

## 9. 事故响应

### 9.1 分级

| 等级 | 例子 | 立即动作 | 回滚 | 负责人 |
|---|---|---|---|---|
| **P1** | PII/secret 泄漏、未授权副作用、审计缺写、安全事件 | kill switch（禁用 Capability/tool 路由）、fail closed、保留审计、通知客户 | 与 Release 相关则 stop-the-world 回滚 | FDE on-call + 客户安全/运维 |
| **P2** | groundedness/任务成功率持续回退、SLO 破线 > 1h、降级率持续 > 10% | 切 fallback Recipe/model profile 或 `degraded_human_review`；开事故；收集失败案例 | 与 Release 相关则回滚 | FDE on-call + 客户 owner |
| **P3** | 延迟/成本/新鲜度轻度超标 | 降级（缩 budget、fallback 模型、暂停 ingest）、告警 | 通常不回滚 | FDE on-call |

### 9.2 回滚

- 客户运维执行 `fde deploy plan/rollback`；v0 stop-the-world。
- 生成新的 Deployment Revision；`audit` 不回滚，保留失败部署期间全部审计；`graph` 可恢复升级前快照。
- 回滚本身写 governance Decision；如果迁移不可逆且无快照，回滚被显式拒绝，需要人工批准快照恢复。
- 回滚后重跑 smoke test 和 `runtime-info` 握手。

### 9.3 降级

- 检索失败/超时：`degraded=true + reason`；Capability Policy 决定继续（无上下文）还是失败；不得编造上下文。
- 图规模超限：`degraded=true + reason=scale_limit`；不静默全表扫描。
- 审计写失败：有副作用的 Run fail closed；只读 Run 可返回但标记 `audit_incomplete`，不得声称已审计。
- 模型/provider 失败：按 Capability Policy 重试/降级；失败 Run 写 outcome Decision（如已有 intent）。
- 在线 judge 失败：不影响 Run；计入 `judge_error_rate`，超过阈值暂停在线评分。

### 9.4 人工接管

v0 的“人工接管”是：**审批 + 取消 Run + 客户侧升级队列**。

- 审批走 #8 的 `Approval` 资源；审批人决定写 Decision。
- 取消走 `POST /v1/runs/{run_id}/cancel`；已完成的 Decision 保留；如副作用可能已发生，写一条取消相关 Decision。
- 人可以在客户侧工单/队列中处理，或修正输入后启动新 Run；人工修正写 Decision。
- 不做实时旁路、人工接管 UI、人工 shadowing；这些留给后续阶段。

### 9.5 事后

- 无责复盘；记录时间线、影响、根因、检测/响应缺口。
- 失败案例脱敏后进入 `regression`；下一次 Release 必须跑全量 gate。
- 更新 SLO/告警/阈值/Metric Catalog；变更走新版本。
- 关闭事故写 governance Decision；P1 必须由客户 owner 确认关闭。

## 10. 保留期与 PII

### 10.1 保留类

| 类 | 默认 | 适用 |
|---|---|---|
| `ephemeral` | 30 天 | OTel traces（脱敏、无 prompt/completion 正文）、审计中的脱敏摘录 |
| `standard` | 180 天 | 审计 Decision 元数据/digest、Evaluation 结果、在线评分 |
| `extended` | 3 年 | Release 审批、Acceptance Report、Waiver、回滚 Decision |
| `legal_hold` | 无限期，直到解除 | 法务/审计冻结 |

### 10.2 数据类型的默认值

| 数据 | 默认保留 | 说明 |
|---|---|---|
| 审计 Decision 元数据/digest | `standard` 180 天 | 客户可改 `extended` 3 年 |
| 审计中的脱敏摘录 | 默认不存；Policy 允许时最长 90 天 | 加密；不得含原始 PII |
| OTel traces | `ephemeral` 30 天 | 采样；默认无 prompt/completion 正文 |
| OTel metrics | 13 个月 | 聚合指标 |
| 日志 | 30 天 | 不含 secret/PII |
| Eval Dataset | 客户侧；最后一个引用它的 active Release 退役后至少 1 年 | 客户可延长；legal hold 优先 |
| Evaluation 结果/在线评分 | `standard` 180 天 | 报告引用保留更久 |
| Acceptance Report / Release Decision | `extended` 3 年 | 治理证据 |
| Review packet | `standard` 180 天 | 脱敏；客户可延长 |

### 10.3 PII 规则

- 原始 PII 永不进入审计库、OTel 或评测报告；默认只存 digest/引用。
- 脱敏摘录必须带 `classification`、`redaction_applied`、`retention_class`；Policy 显式允许才存。
- 检索时 mask；无法 mask 时 fail closed；未分类字段默认 `restricted`。
- 模型输出侧另有 output guard：secret 阻断、PII 脱敏/阻断、非引用链接剥离；不替代检索 mask，见 [`agent-security.md`](agent-security.md) §3.3。
- 源数据保留期由客户数据源策略决定；工作台不持客户数据，不复制数据集。
- 删除只通过保留作业：保留 digest/tombstone，写删除 Decision；不原地改写审计历史。
- 灾难恢复导致审计链缺口时，记录缺口并标记 `verification.status`；不得静默修复。

### 10.4 Legal hold

- 客户法务/合规可以按 tenant/Solution/Run/时间窗发起 `legal_hold`；解除也必须记录。
- `legal_hold` 覆盖普通保留作业；解除后按原 `retention_class` 继续。
- 发起/解除都是 governance Decision，带理由、审批人和范围。

## 11. v0 边界

### 11.1 v0 实现（自动）

| 能力 | 内容 |
|---|---|
| Metric Catalog | YAML/Zod schema、版本化；指标定义、公式、数据源、方向、owner |
| Eval Suite | dataset ref/version/digest、split、scorers、gates、thresholds、pass criteria、judge 配置；随 Bundle 编译 |
| Eval Dataset | manifest + JSONL；来源/脱敏/作者/版本/digest；`dev`/`holdout`/`regression`/`judge-calibration`/`adversarial`（advisory）；`fde eval dataset validate` |
| Scorers | 确定性 scorer（引用、schema、tool、拒答、PII、审计、延迟/成本）+ Mastra 预置 + 自定义 judge |
| `fde eval` | `--mode contract\|live`、`--suite`、`--bundle`、`--environment`、`--report`、`--gate`；verdict、CI、JSON/Markdown、CI exit code；`live` 门禁校验 dataset digest、实际 model、fallback、签名和 audit |
| Evaluation 证据 | customer-side `evalSigningKey` 签名；governance Decision；`eval_binding_digest`；实际 model/modelVersion 或 `endpointId`；`release_grade` |
| Release 集成 | `fde release approve` 按每个 distinct prod `eval_binding_digest` 验签、对比 dataset/model pin 和 fallback，无证据/有效 Waiver 时拒绝 |
| 在线监控 | 100% 确定性指标；2% judge 抽样；每日成本上限；月度 review packet；告警 |
| 对抗性评测 | `adversarial` split（20–50 条，advisory）；确定性安全红线由 C33–C40 覆盖；见 [`agent-security.md`](agent-security.md) |
| 观测栈 | OTLP 导出；可选 `observability` profile（Collector + Prometheus + Grafana + 规则）；保留作业 |
| 参考场景 | Acme Claims 完整套件 + Beta Bank 差异检查 |

### 11.2 v0 人工流程（HITL）

- SME 编写/批准 holdout；FDE 编写 dev/regression。
- judge 校准标注（建议 100 条/客户）与季度重校准。
- 每月 20–50 条 Run 抽检；P1/P2 事故窗口 100% 复核。
- Acceptance Report 签核、Waiver 审批、事故指挥与回滚决定。

### 11.3 明确不做（v0）

- 标注/评审 UI、active learning、自动数据集策展。
- drift 自动检测/自动重训练、A/B 实验平台、跨客户 benchmark、fleet 遥测。
- 托管评测服务、实时人工旁路/接管 UI、自动回滚、judge 微调。
- 合规认证、HA/灾备认证、成本优化模型（地图 fog）。
- 多 runtime 评测（由「LangGraph 运行时映射缺口」评估）。
- 生产检索索引/100k+ 规模（由「生产检索索引与 100k+ 规模上限」评估）。

### 11.4 与实现切片的关系

「架构综合与实施切片」负责：

- 把 Metric Catalog/Eval Suite/Eval Dataset/Evaluation 落成 Zod/JSON Schema。
- 落 `decision_coverage` 的 invocation 级查询，以及 Decision Binding 的生成物/conformance（见 [`decision-audit-binding.md`](decision-audit-binding.md)）。
- 实现 `fde eval` 最小闭环：dataset binding resolve → digest 三方校验 → contract/live run → 实际 model 对账 → verdict → 签名 Evaluation + governance Decision → `fde release approve` gate。
- 落 `eval_binding_digest`、`release_grade`、customer-side `evalSigningKey` 和按 distinct prod binding 的审批覆盖。
- 接 Acme 参考数据集和 2–3 个 deterministic scorer；LLM judge 先接一个（groundedness）。
- 接 OTel/可选观测栈和保留作业。
- 不在该切片实现完整评测平台。

## 12. 参考场景：Acme Claims 验收清单

场景：Customer `acme`，Solution `claims-triage`，Capability `document-triage`，CCP `acme-claims-context@1.0.0`，Sources `claims-db`（结构化，staleAfter 1h）和 `sharepoint-claims`（文档，staleAfter 24h）。

### 12.1 L1 Context Eval

- [ ] 20 条 golden questions（[`examples/semantic/acme/evals/claims-context.golden.yaml`](../examples/semantic/acme/evals/claims-context.golden.yaml)）。
- [ ] `recall_at_budget` ≥ 0.80。
- [ ] `citation_validity` = 1.00。
- [ ] `silent_stale` = 0。
- [ ] `silent_conflict` = 0。
- [ ] `budget_efficiency` 记录（不设硬阈值）。
- [ ] 每个 degraded 结果有 `reason`；不得静默。

### 12.2 L2 Capability Eval

- [ ] 数据集 ≥ 50 条，其中 holdout ≥ 10 条；版本 + digest 记录。
- [ ] `task_success` ≥ 0.85。
- [ ] `citation_validity` = 1.00（blocking）。
- [ ] `citation_coverage` ≥ 0.95。
- [ ] `groundedness` ≥ 0.85（judge 已校准）。
- [ ] `refusal_precision` ≥ 0.90。
- [ ] `refusal_recall` ≥ 0.90。
- [ ] `pii_leak_rate` = 0（blocking）。
- [ ] `unauthorized_side_effect_rate` = 0（blocking）。
- [ ] `decision_coverage` = 1.00（blocking）。
- [ ] `audit_write_success` = 1.00（blocking）。
- [ ] 相对 active Release 无 threshold 指标下降 > 3pp。
- [ ] `run_latency_p95` ≤ 30s（交互型）；`retrieve_latency_p95` ≤ 300ms。
- [ ] `cost_per_successful_run` 在 Capability 预算内；80%/100% 告警已配置（监控项，不作 Release 硬门禁）。
- [ ] 报告 95% CI；无未解释的 `inconclusive`；有 Waiver 的列出。
- [ ] judge 校准 agreement ≥ 0.70 kappa 或 ≥ 85%。
- [ ] Evaluation `release_grade: true`、已用 `evalSigningKey` 签名，并有 governance Decision。
- [ ] `eval_binding_digest` 与目标 prod Environment 匹配；实际 model/modelVersion（或 `endpointId`）与 pinned Model Profile 匹配；`fallback_used: false`。
- [ ] dataset digest 与 lock、Eval Suite、manifest 三方一致；holdout ACL 已生效。

### 12.3 L3 Deployment / SLO

- [ ] Smoke：`/healthz`、`/readyz`、retrieve、decision、provenance、approval 全通过。
- [ ] 30 天观察窗可用性 ≥ 99.0%。
- [ ] Runtime API 5xx/超时率 < 1%。
- [ ] `retrieve_latency_p95` ≤ 300ms；p99 ≤ 800ms。
- [ ] `run_latency_p95` ≤ 30s。
- [ ] `degraded_rate` < 5%。
- [ ] 审计写入成功率 100%；有副作用 Run 的 Decision 覆盖率 100%。
- [ ] 在线 eval 覆盖率 ≥ 95%；judge 错误率 < 1%。
- [ ] 2% judge 抽样与每日成本上限已配置。
- [ ] 无开放 P1；开放 P2/P3 有 owner 和期限；Waiver 列表完整。
- [ ] `Acceptance Report` 已签发为 governance Decision；客户签核在交付 SOP 中完成。

### 12.4 Acceptance Report 摘要示例

```yaml
kind: AcceptanceReport
metadata:
  customer: acme
  solution: claims-triage
  capability: document-triage
spec:
  bundleDigest: sha256:abc...
  releaseCandidate: 1.0.0
  deployment: acme-prod
  evaluations:
    - eval_01ARZ3NDEKTSV4RRFFQ69G5FAV  # L2
    - eval_01ARZ3NDEKTSV4RRFFQ69G5FAW  # L1
  metricCatalog: metrics@1.0.0
  dataset: claims-triage-quality@1.0.0@sha256:...
  sloWindow: {from: 2026-11-01T00:00:00Z, to: 2026-12-01T00:00:00Z}
  verdict: accepted
  waivers: []
  openIncidents: []
```

### 12.5 Beta Bank 差异检查

- 复用同一方法，不重复完整清单。
- `kyc-review` / `document-triage`；CCP `beta-kyc-context@1.0.0`；Sources `beta-dms`、`core-banking`。
- 更严 PII：姓名/证件号全 mask；`pii_leak_rate` = 0 仍为 blocking。
- `recall_at_budget` ≥ 0.90；`groundedness` ≥ 0.90；其他阈值按 Capability Template 收紧。
- judge 校准集必须覆盖 KYC 术语和拒答边界。
- 差异记录在 Beta 的 Eval Suite/README，不复制 Acme 清单。

### 12.6 失败走查

- `sharepoint-claims` 不可用：`retrieve` 返回 `degraded=true, reason=partial`；Agent 可用 `claims-db` 的结构化事实，但 prompt 标注“文档上下文不完整”；`citation_coverage`/`groundedness` 可能下降。若低于 L2 阈值，Release gate 失败；生产环境按影响定 P2/P3，不得编造文档引用。
- 在线样本发现 PII：P1，kill switch + fail closed + 审计保留；若与 Release 相关则回滚；写 incident Decision。
- 审计写失败：有副作用 Run fail closed，P1；只读 Run 标记 `audit_incomplete`，不得声称已审计。

## 13. 边界与未决

| 事项 | 归属 |
|---|---|
| IdP/SSO、RBAC/ABAC 词表、客户/工作台责任划分 | [客户环境内的身份、权限与部署](https://github.com/0xnicholas/Fdesforce/issues/12) |
| 生产检索后端 | 已由[生产检索索引与 100k+ 规模上限](https://github.com/0xnicholas/Fdesforce/issues/15)定为 Postgres 17 + pgvector；retrieve p95 的 100k/500k 实测留作实施阶段 gate |
| LangGraph/第二 runtime 的评测语义 | [LangGraph 运行时映射缺口](https://github.com/0xnicholas/Fdesforce/issues/16) |
| 成本模型、容量规划 | 地图「Not yet specified」 |
| Agent 安全威胁模型、prompt injection 具体控制 | 已由 [Agent 专项安全](agent-security.md) 定稿；本票保留 `pii_leak`/`unauthorized_side_effect` 指标，`adversarial` split advisory，确定性红线在 C33–C40 |
| 长会话记忆、用户偏好 | 地图「Not yet specified」 |
| 客户交付 SOP、商务验收/合同 | 地图「Out of scope」 |
| 评测 UI/标注平台、active learning、自动回滚、跨客户 benchmark | 本票明确不做 |
| 合规认证、HA/灾备认证 | 地图「Out of scope」 |

## 14. 关键权衡与被淘汰方案

| 选择 | 被淘汰方案 | 理由 |
|---|---|---|
| Mastra-native + `fde eval` | 引入 promptfoo/DeepEval/Ragas 作为主 runner | 第三套运行时/依赖/版本矩阵；数据集和 scorer 仍要桥接；客户 bundle 更重 |
| 指标向量 + blocking gates | 单一加权 `quality_score` | 综合分掩盖 PII/审计/越权等零容忍失败；不同 Capability 风险不可比 |
| 确定性 gate + 校准 judge | 100% LLM judge | judge 自身不稳定、不可审计、成本高；未校准不能做硬门禁 |
| 数据集留在客户环境 | 数据集进 Bundle/工作台 | Bundle 会变成数据分发载体；工作台持有客户数据违反部署模型 |
| 遥测留在客户环境 | 默认回传工作台 | 数据驻留、air-gapped、客户信任；回传只做 opt-in 脱敏摘要 |
| 人工确认回滚 | 自动回滚 | v0 无 HA/自动根因；误回滚风险高；P1/P2 必须有人确认 |
| 分级保留 | 全部 7 年 | 成本/隐私/合规不匹配；按数据类型分级，legal hold 覆盖 |

完整权衡与后果见 [ADR-0005](adr/0005-evaluation-and-observability.md)。

## 15. 产物与一致性

| 产物 | 路径 | 说明 |
|---|---|---|
| 本文 | `docs/evaluation-and-observability.md` | 评测、验收与可观测性决策稿 |
| ADR | `docs/adr/0005-evaluation-and-observability.md` | 决策记录与权衡 |
| 示例 | `examples/eval/acme/` | Metric Catalog、Eval Suite、Dataset、验收清单 |
| 术语 | `GLOSSARY.md` | Metric Catalog、Eval Dataset、Scorer、Gate、Acceptance Report、SLO、Online Evaluation、Retention Class、Incident Severity |
| 领域模型 | `docs/domain-model.md` | Eval Suite/Evaluation/Waiver 扩展；新增治理实体 |
| 运行时契约 | `docs/runtime-contract.md` | §6.5/§13 交叉引用；不新增 wire 字段 |
| 语义建模 | `docs/semantic-modeling.md` | §9.3/§9.4/§11 交叉引用；在线抽样改为默认 2% |

一致性规则：

- Metric Catalog/Eval Suite/Eval Dataset/Evaluation 的 YAML 示例必须能通过 YAML 1.2 解析；JSONL 每行必须是合法 JSON。
- 数据集 digest、Eval Suite 版本、scorer/judge 版本必须能在 Evaluation 中追到。
- blocking gate 不可被 Waiver 覆盖；`fde release approve` 必须执行该规则。
- 本文不新增 `fde.runtime/v1` 字段；eval wire schema 由实现切片落成。
- 文档中的指标名、ID 前缀和阈值必须与 `examples/eval/acme/` 一致。
