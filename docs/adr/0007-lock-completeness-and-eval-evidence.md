---
status: accepted
---
# Lock 完整性、Model Profile 与 Evaluation 证据链

v0 的 `solution.lock` 从“版本清单”收紧为“构建输入的完整清单”：它用 `spec.digest` 覆盖 `solution.yaml` 和所有被引用的 solution 本地文件，用 `templates` 放跨客户 Template、`assets` 放 frozen Spec 实际引用的 concrete Customer 资产，并 pin `modelProfiles`、`evalDatasets`、`extensions`、`runtime` 和 `toolchain`。模型身份成为平台维护的版本化 `ModelProfile` 资产（provider、model、modelVersion、params、fallback），Spec 只写逻辑名 + 兼容范围，Environment 只提供 endpoint/secret。Eval Dataset 留在客户环境，由 Environment 的 `evalDatasetBindings` 按 `dataset_id@version` 精确解析；Release-grade Evaluation 由客户侧 `evalSigningKey` 签名并以 governance Decision 锚定，记录 `eval_binding_digest`、实际 model/modelVersion（或 `endpointId`）、`fallback_used` 和所有构建输入 digest。`fde release approve` 只验签、对比 digest，不读取客户数据；每个 `kind: prod` 的 distinct `eval_binding_digest` 各需一份 release-grade Evaluation，非 prod 不阻塞。这样“同 Spec + lock + pinned Extensions + toolchain → 同 Bundle digest”和“Release 评测可追溯”同时成立；代价是严格 lock 带来的编辑摩擦、Model Profile 只能由平台维护，以及 prod 环境按绑定 digest 重复评测的成本。

完整决策、字段和 stage 边界见 [`docs/domain-model.md`](../domain-model.md) §3.3、§3.4、§3.9、§3.12、§3.17，评测流程见 [`docs/evaluation-and-observability.md`](../evaluation-and-observability.md)，签名与部署见 [`docs/security-and-deployment.md`](../security-and-deployment.md)。本 ADR 细化 [ADR-0002](0002-solution-spec-and-config-tooling.md) 的 lock 形状和 [ADR-0005](0005-evaluation-and-observability.md) 的 Release 证据要求；不改变 Bundle/Release 的不可变性和 `fde.runtime/v1` wire contract。

## Considered Options

- **新增 Template 类型 `model_profile`**：复用现有 Template 物化/Overlay 机制，但 Template 是作者内容，会把 provider/model 重新带回客户 Spec；Model Profile 是平台运行时资产，和 `RuntimeProfile` 同属一类。改为 platform-only `ModelProfile` 资产。
- **把 provider/model/params 留在 Environment**：实现最省事，但同一 Spec + lock 在不同环境会静默换模型，破坏可重建性和 Release 证据。改为 lock pin Model Profile，Environment 只留 endpoint/secret。
- **保持 flat `templates`，只补字段**：改动小，但会把 concrete Customer 资产（如 `claims-triage-quality`、`claims-approval-threshold`）误标成 Template，无法表达物化来源。改为 `templates` + `assets` 分节，`materializedFrom` 保留来源。
- **只对 `solution.yaml` 求 `specDigest`**：实现简单，但 prompt、JSON Schema 和 connector contract 可以在 digest 外漂移。改为 canonical file manifest + 逐文件 digest。
- **不签名 Evaluation，或只写 audit Decision**：前者无法离线搬运和验签，后者无法承载逐 case 证据且审批依赖客户网络。改为签名 Evaluation + governance Decision 双锚点。
- **一份 canonical Evaluation 覆盖所有环境**：成本低，但 prod endpoint/dataset 绑定变化时可以复用旧证据。改为每个 distinct prod `eval_binding_digest` 一份；同一 digest 共享。
- **把所有 Environment 都纳入 Release gate**：最严格，但 dev/staging 换 endpoint 也会产生完整评测成本，促使绕过评测。改为只 gate `kind: prod`，非 prod 用 L3 smoke/SLO。
- **宽松 lock（多余条目只告警）**：减少编辑摩擦，但多余条目意味着引用删除或手改，无法区分“陈旧的 lock”与“真实的构建输入”。改为严格生成式 lock，`fde spec lock --check` 任何 diff 都 fail。

## Consequences

- `lockVersion: 1` 的 `solution.lock` 形状被重新定义为上述结构；v0 没有已发布构建器，所以不提供 v1→v2 迁移，原型 lock 直接重建。未来不兼容变更才升 `lockVersion: 2` 并引入 `fde spec lock migrate`。
- `fde spec validate`、`fde spec lock --check`、`fde build`、`fde eval`、`fde release approve`、`fde deploy plan` 的 fail-closed 边界按 `docs/domain-model.md` §6 和 `docs/evaluation-and-observability.md` §5.5 执行；build 不联网、不读客户数据，只要求 dataset pin 存在。
- 新增 per-Environment `evalSigningKey`、Evaluation `signature`/`signer`、`release_grade`、`eval_binding_digest`、`environment_evaluations`；不新增 `fde.runtime/v1` wire 字段，`evaluation_id` 仍属治理域。
- Model Profile 由平台维护；客户特殊模型需要平台新增 profile 版本，不能由客户 repo 自带。客户只配置 endpoint/secret，provider/model/params 不可在 Environment 覆盖。
- prod Environment 按 distinct `eval_binding_digest` 重复评测会产生额外模型/评测成本；staging/dev 不阻塞 Release，但需要 L3 smoke/SLO。
- 严格 lock 会在 Spec 编辑期间制造摩擦；`fde spec lock` 重新生成，`--refresh` 是唯一联网路径，air-gapped 环境依赖 `vendor/`。
- 实现落在「架构综合与实施切片」：Zod/JSON Schema、`fde spec lock --check`、`fde eval` 签名/绑定 digest/实际模型对账、`fde release approve` 证据覆盖；本 ADR 不实现生产 builder。
