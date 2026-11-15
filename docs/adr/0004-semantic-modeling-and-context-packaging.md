---
status: accepted
---
# 语义建模与上下文打包：CCP 作为源工件、能力切片、确定性 Recipe

v0 的语义建模按 Capability 切片进行，不先建全客户本体；工作台只接收元数据、schema 和脱敏样本，不搬全量客户数据。客户接入的交付物是 **Customer Context Package（CCP）**：客户级、版本化、不可变的声明式源工件，包含 ontology 选择与客户扩展、Semantic Model、Context Source 定义、mapping、Context Recipe、权限 baseline 和 Context Eval Suite；它不含数据、secret、生成图或运行时状态。Solution Spec 通过 `contextPackageRef` 引用 CCP，`solution.lock` pin 精确版本与 digest，Bundle 构建时编译进去。运行时检索由 FDE 编写的确定性 Context Recipe 执行：`resolve → structured → graph → lexical → merge → rank → mask → budget`；Agent 只能选 `recipe_id` 和填 query/filters，不能生成 Cypher/SQL 或改阶段顺序。权限采用语义注解 + 分层强制：源端下推、context-service 注入执行上下文并 mask、审计记录 policy evaluation；未分类默认 restricted，无法强制则 fail closed。这样语义资产可复用、可评测、可离线重建，代价是 v0 仍受 embedded 图/词法检索与 10k/50k 上限约束，且 Context Recipe 需要扩展为 Customer 级可复用定义。

完整方法、流水线、字段与参考场景见 [`docs/semantic-modeling.md`](../semantic-modeling.md)；示例工件见 [`examples/semantic/`](../../examples/semantic/)。

## Considered Options

- **先建全客户本体，再映射数据**：覆盖完整，但 FDE 不是本体专家，容易建出没人用的模型；改为 competency questions 驱动的 Capability 切片，按 eval 通过增量聚合。
- **把客户数据导入工作台做剖析/建模**：建模体验最好，但工作台会持有客户数据，违反部署模型与数据驻留；改为只接收元数据、schema、脱敏样本，profiling 在客户环境执行。
- **CCP 作为构建产物（类似 Customer Bundle）**：部署直觉强，但会出现两个部署单位，且与“Spec 唯一真相、Bundle 可重建”冲突；改为客户级声明式源工件，Bundle 编译它。
- **Context Recipe 仅限 Solution 级**：层级干净，但客户级复用和“客户 Context API”无法成立；改为 Customer 级可复用定义 + Solution Binding，Solution 只能收紧。
- **Agent 自主编排检索**：灵活，但不可审计、不可评测、容易越权；改为 FDE 确定性 Recipe，Agent 只选 Recipe 和参数。
- **只依赖源系统 ACL 或在 Mastra 后置过滤**：实现简单，但检索结果已经离开数据源，泄漏面不可控；改为源端下推 + context-service 强制 + 审计，默认拒绝。

## Consequences

- CCP 成为客户接入的核心交付物；`solution.lock` 增加 `customerContextPackage` pin，Connector 仍单独 pin。
- `GLOSSARY.md` 与 `docs/domain-model.md` 增加 CCP、Domain Ontology、Customer Ontology Extension；Context Recipe 从 Solution 级扩展为 Customer 级可复用 + Solution Binding。
- 工作台不能做全量数据剖析；需要 FDE/客户在客户环境运行只读 profiling/ingest 作业。
- v0 检索仍是 embedded 图 + 词法 + 2-hop；vector 为 experimental，生产索引由「生产检索索引与 100k+ 规模上限」决定。
- 身份/RBAC 词表、答案级评测、成本模型、安全威胁模型、长会话记忆仍由相邻 ticket 或地图 fog 承接。
- 新增 `fde context init/validate/freeze/ingest/rebuild/eval/verify` 的命令面；具体实现由「架构综合与实施切片」收敛。
