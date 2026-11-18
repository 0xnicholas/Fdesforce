# FDE 工作台

FDE 工作台是面向内部 FDE/交付团队的构建器：把一个 Customer 的 Solution 配置成可独立部署的 Bundle。这个上下文描述交付物及其构建、发布、部署与运行，不描述托管 SaaS 或多租户控制面。

本文件只定义领域语言；实现决策记在 `docs/adr/`。

## 交付与配置

**Customer**:
接受解决方案的组织，是构建、交付和隔离的边界。
_Avoid_: Tenant, Client, Account

**Solution**:
针对一个 Customer 的可独立构建、发布和部署的解决方案实例。
_Avoid_: Project, App, Product

**Solution Revision**:
Solution 的一次不可变配置快照；草稿可变，Release 冻结一个 Revision。
_Avoid_: Version, Draft

**Solution Spec**:
Solution Revision 的声明式内容，是生成物的唯一真相来源；不包含生成物、secret 值或环境实际值。
_Avoid_: Config, Manifest

**Environment**:
Customer 拥有的部署目标（如 dev/staging/prod），提供命名 profile 的具体非 secret 值（profile_values）；v0 一个 Environment 只承载一个 Solution 的 Deployment。
_Avoid_: Stage, Cluster, Tenant

## 能力与实现

**Capability**:
业务能力契约，描述做什么、输入输出、副作用和治理要求；是复用、评测和策略绑定的单位。
_Avoid_: Feature, Use Case, Agent

**Capability Template**:
可跨 Customer 复用的、版本化且不可变的 Capability 定义。
_Avoid_: Blueprint, Starter

**Capability Binding**:
Solution 中把一个 Capability Template 绑定到具体实现和 Overlay 的记录。
_Avoid_: Instance, Config

**Agent**:
模型驱动的执行者，由 instructions、model、tools 和 memory 组成，是 Capability 的一种实现。
_Avoid_: Bot, Assistant

**Workflow**:
确定性的编排实现，包含有序步骤（`context | agent | tool | approval`）、人工审批 gate 和持久化状态，是 Capability 的一种实现；v0 无通用分支/并行/条件语言。
_Avoid_: Pipeline, Graph

**Tool**:
Agent 或 Workflow 可调用的、有 schema 的动作；可以是纯代码，也可以由 Connector 提供。
_Avoid_: Function, Action

**Connector**:
对外部系统的接入，拥有凭证引用、数据契约和限流规则，并向 Tool 或 Context Source 提供能力；它是 Customer 级资产，可被多个 Solution 引用。
_Avoid_: Integration, Adapter

**Connector Typed Operation**:
Connector 声明的具名操作（名称、输入/输出 schema、副作用与幂等语义）；Tool 通过 context-service 的 typed operation 端点访问它，ingest 通过同一 Connector 端口的 `read` 访问——外部系统只在 context-service 内部被调用，所以 Tool 不持有 Connector 凭证、也不知道数据源地址（`docs/runtime-adapter.md` D6）。
_Avoid_: Query, SQL, RPC

## 复用与定制

**Template**:
版本化且不可变的跨 Customer 复用单元。
_Avoid_: Blueprint, Starter

**Overlay**:
Customer 或 Solution 对 Template 的声明式差异，按白名单路径合并，不 fork Template。
_Avoid_: Patch, Fork, Customization

**Extension**:
客户自定义的版本化代码包，由 Solution Spec 引用，不直接修改生成物。
_Avoid_: Plugin, Add-on

## 构建与发布

**Bundle**:
不可变、内容寻址的构建产物，包含运行一个 Solution 所需的全部组件和元数据。
_Avoid_: Package, Artifact, Build

**Bundle Topology**:
Bundle 内组件、端口、卷、作业、启动依赖、健康检查和 secret 绑定的唯一部署拓扑声明；Compose/Helm/airgap 从它渲染。
_Avoid_: Deployment manifest, Compose file

**Context Service Topology**:
平台维护的 Bundle Topology 片段：context-service、graph/audit 卷和 migrate/ingest 作业；与 generator 的 `RuntimeTopology` 合成唯一 `BundleTopology`，本身不含启动顺序、命名模板和 ingress。
_Avoid_: context-service manifest, platform compose

**Release**:
对一个 Bundle 的批准和签署记录，按 Solution 全局唯一、不可变，是部署的单位。
_Avoid_: Version, Build

**Deployment**:
Release 在某个 Environment 中的安装实例；同一 Solution × Environment 只有一个 active Deployment。
_Avoid_: Instance, Installation

**Deployment Revision**:
Deployment 中一次 Release 安装的不可变记录，包含 Release 版本、迁移结果和时间戳。
_Avoid_: Deployment, Version

**Runtime Profile**:
平台维护的、版本化的运行时组件与版本组合；Spec 只引用它，`solution.lock` 固定精确版本。
_Avoid_: Runtime version, Stack

**Model Profile**:
平台维护的、版本化且不可变的模型身份与参数组合（provider、model、modelVersion、params、fallback）；Spec 只引用逻辑名 + 兼容范围，`solution.lock` 固定精确版本，Environment 只提供 endpoint/secret。
_Avoid_: Model config, LLM config

**Runtime Generator**:
把 Solution Spec、Runtime Profile 和环境非 secret 值转换为运行时 app 源码、迁移、Bundle Topology 与 contract tests 的构建期组件；每个 runtime family 一个，不进入 Bundle，不是运行时抽象层。
_Avoid_: Runtime adapter, Plugin

**Run**:
Deployment 内一次 Agent 或 Workflow 的执行，带 trace、actor、状态和 provenance。
_Avoid_: Job, Execution

## 治理

**Policy**:
对运行时行为的约束（数据访问、工具、审批、保留、模型路由、PII），由生成的代码和 context-service 强制执行。
_Avoid_: Rule, Guardrail

**Eval Suite**:
版本化的评测定义，包含数据集引用、scorer、gate、阈值和通过标准；不内嵌数据集。
_Avoid_: Test, Benchmark

**Evaluation**:
一次 Eval Suite 的执行，引用被评测的 Bundle 或 Run/Deployment，并记录结果。
_Avoid_: Eval, Test Run

**Waiver**:
在明确记录理由、审批人和有效期的前提下，对一条 threshold gate 的临时豁免；不能豁免 blocking gate；本身是一条 Decision。
_Avoid_: Exception, Override

**Metric Catalog**:
平台维护的版本化指标定义集合，规定指标的含义、公式、方向、数据源和 owner；Capability 只引用指标和阈值。
_Avoid_: KPI list, Metrics sheet

**Eval Dataset**:
客户侧、版本化的评测用例集合，按用途分区并带来源、脱敏状态和 digest；不进入 Bundle。
_Avoid_: Test data, Golden set

**Scorer**:
对一次输出或一条评测用例给出分数或判定的评分组件，可以是确定性规则、统计方法或 LLM judge。
_Avoid_: Judge, Metric

**Gate**:
发布前必须满足的评测条件；`blocking` 逐 case 零容忍，`threshold` 按指标阈值判断，`no_regression` 对基线比较，`monitor` 只观察不阻塞。
_Avoid_: Check, Threshold

**Acceptance Report**:
汇总 Evaluation、SLO 观察窗和未结 Waiver 的技术验收记录，本身是一条 Decision；客户签核流程不在其内。
_Avoid_: Certificate, Sign-off

**SLO**:
对运行时服务水平的可观察目标，例如可用性、延迟、错误率和审计写入成功率。
_Avoid_: SLA, KPI

**Online Evaluation**:
在生产 Run 上按确定性采样执行的评测，用于发现质量漂移和未知失败。
_Avoid_: Monitoring, Live test

**Retention Class**:
数据保留类，决定审计、遥测、评测结果和验收记录的保留期与 legal hold 行为。
_Avoid_: TTL, Expiry

**Incident Severity**:
按安全、审计、质量和运维影响划分的事故等级（P1/P2/P3），决定 kill switch、降级和回滚动作。
_Avoid_: Priority, Alert level

**Output Guard**:
`mastra-app` 在返回模型输出前执行的确定性过滤：阻断 secret、脱敏或阻断 PII、限制外部链接；结果写入 Decision 和 Audit Event。
_Avoid_: DLP, Content filter

**Kill Switch**:
`customer_admin` 执行的事故止血状态，按 deployment/capability/tool 阻断新 Run 与 Tool 调用、取消活跃 Run，并写审计；不是回滚。
_Avoid_: Circuit breaker, Emergency stop

## 身份与访问

**Platform Role**:
固定平台角色词表（`end_user`、`approver`、`customer_admin`、`deployment_operator`、`auditor`、`service`、`support`），授予运行时 scope；随 Bundle 发布。
_Avoid_: Permission, Group

**Business Role**:
客户 IdP group 透传的业务角色，只用于数据权限、row filter 和 `approver_roles`，不授予平台 scope。
_Avoid_: Platform Role, Permission

**IdentityProfile**:
Environment 配置的身份来源与角色映射文档：声明平台角色/业务角色如何从身份来源得出，并据此签发 `ExecutionContext`；v0 为静态 subject 列表（Slice 2.4 起为 OIDC + JWKS + JIT），不含 secret 值，不进 Bundle。
_Avoid_: Auth config, Role config

**Break-glass**:
客户持有的应急管理访问；限时、需审批、写审计，仅用于 IdP 不可用时的管理面恢复。
_Avoid_: Backdoor, Emergency admin

## 语义与上下文

**Ontology**:
版本化的词汇表和约束（classes/properties/SHACL），可以来自 Template，也可以由 Customer 扩展。
_Avoid_: Schema, Vocabulary

**Domain Ontology**:
跨 Customer 复用的、版本化的领域本体模板，提供类、属性、关系和 SHACL 约束的起点。
_Avoid_: Customer Ontology, Schema

**Customer Ontology Extension**:
Customer 对 Domain Ontology 的版本化扩展，只包含客户特有的类、属性和 SHACL 约束。
_Avoid_: Fork, Custom Ontology

**Semantic Model**:
Customer 对 Ontology 的绑定，包含选定的模块、实体映射、解析/合并规则、源优先级和时效规则。
_Avoid_: Knowledge Model

**Entity Mapping**:
从外部表、视图或文档到 Ontology 类/属性的声明式映射，包含键、属性、关系和摄取水位。
_Avoid_: ETL, Mapping table

**Competency Question**:
一个 Capability 的上下文必须能回答的业务问题；用于确定 Ontology 模块、Context Source 和 Context Eval。
_Avoid_: Requirement, Query

**Context Recipe**:
声明式的上下文检索和组装方案；可由 Customer Context Package 提供可复用定义，Solution 引用并可收紧覆盖。
_Avoid_: Prompt, Retriever

**Context Recipe Binding**:
Solution 对 Customer 级 Context Recipe 的引用和收紧配置；不能放宽权限 baseline。
_Avoid_: Override, Instance

**Context Eval Suite**:
版本化的上下文质量评测定义，包含 golden questions、期望事实、指标和阈值。
_Avoid_: Eval, Benchmark

**Context Graph**:
按 Semantic Model 和 Entity Mapping 从 Context Source 物化出的图数据，可重建，不是作者实体。
_Avoid_: Knowledge Graph

**Ingest Ledger**:
图卷上与快照同放的记录：这个图由哪个 frozen Context Package revision 物化、每个 source 的上次结果与 watermark。它让「ingest 未完成」在重启后仍然可读，`/readyz` 与 `retrieve` 由此给出同一个 `partial` 判断。
_Avoid_: Cursor, Checkpoint, State file

**Customer Context Package (CCP)**:
一个 Customer 的版本化、不可变语义上下文资产包，聚合 Ontology 选择与客户扩展、Semantic Model、Context Source 定义、Entity Mapping、Context Recipe、权限 baseline 和 Context Eval Suite；不包含客户数据、secret 或生成物。
_Avoid_: Context Bundle, Knowledge Pack

**Decision**:
一次被记录的选择，包含理由、证据、actor 和 provenance；`subject` 可以是 Run、Evaluation、Release、Deployment、Acceptance Report 或 Solution Revision。
_Avoid_: Log, Note

**Decision Binding**:
一次副作用 Tool 调用的审计配置，由 Tool 的内在属性（分类、保留类）与 Capability 的证据选择合并而成；build 取更严者，缺失则 fail closed。
_Avoid_: Audit config, Wrapper config

**Invocation**:
一次副作用 Tool 调用的执行尝试，用 `invocation_id` 标识；intent 和 outcome Decision 都挂在它上面。
_Avoid_: Tool call, Step

**Intent Decision**:
副作用执行前记录的 Decision，声明拟执行动作、证据、Policy 评估和输入摘要；写入失败则不得执行副作用。
_Avoid_: Pre-log, Audit draft

**Outcome Decision**:
副作用执行后记录的 Decision，链接 intent，记录成功、失败或未知结果与输出摘要。
_Avoid_: Result log, Post-log

**Run Decision**:
Run 终止时记录的汇总 Decision，覆盖只读与副作用 Run，记录证据、最终输出摘要和模型版本。
_Avoid_: Run log, Summary

**Decision Coverage**:
有副作用 Tool invocation 中 intent 与 outcome Decision 完整配对的指标；按 invocation 统计，排除 policy deny 和审批拒绝。
_Avoid_: Audit rate, Log coverage

**Provenance**:
对实体、关系和决策的来源与演化记录，用 PROV-O 表达。
_Avoid_: Audit Log, Lineage

## 运行时与集成

**Runtime Contract**:
工作台生成的运行时组件之间、以及客户应用访问运行时之间的版本化接口约定；v0 为 `fde.runtime/v1`。
_Avoid_: API spec, Integration doc

**Runtime Capability**:
运行时对某一类执行能力的支持声明，例如 durable workflow、HITL、streaming、state store；用 `native | adapter | degraded | none` 表达支持程度。由 Runtime Profile 声明，构建时与 Solution Spec 推导出的要求比对；不等于业务 Capability。
_Avoid_: Capability, Feature

**Context Service**:
拥有检索、Decision/Provenance 写入和审批状态的薄服务；是 Mastra 与 Semantica 之间唯一的运行时边界。
_Avoid_: Semantica service, Context API

**Execution Context**:
一次 Run 中跨组件传播的、经过签名的身份与关联断言，包含 tenant、subject、actor、roles、scopes、run 和 trace；`roles` 是平台角色与业务角色的并集，平台角色授予 scope，业务角色只用于数据权限。
_Avoid_: Auth header, User context

**Service Issuer**:
为特定调用方类别签发 `ExecutionContext` 的签名身份；v0 有 `mastra-app`（用户/Run）和 `fde-jobs`（维护作业）。
_Avoid_: Service account, API key

**Retrieval Snapshot**:
一次上下文检索的不可变结果，带 `retrieval_id` 和摘要，供 Decision 引用。
_Avoid_: Search result, Context cache

**Approval**:
对 Run 中某个拟执行动作的人工授权请求及其决定，本身是一条 Decision。
_Avoid_: Confirmation, Sign-off

**Audit Store**:
只追加、可验证完整性地保存 Decision、Provenance、Audit Event 和 Retrieval Snapshot 的存储，与 Context Graph 分开；快照只留引用与摘要，内容仍在 Context Graph。
_Avoid_: Log, History

**Audit Event**:
审计库中除 Decision/Provenance 外的安全、身份、发布、部署或保留事件；append-only，带 actor、trace 和 retention class。
_Avoid_: Log, Telemetry

**Untrusted Content**:
进入模型上下文但不具指令权威的数据，包括用户输入、检索 item、Tool 返回值、模型中间输出和 memory；只有签名 Bundle 内容是指令来源。
_Avoid_: User content, External data

**Instruction/Data Separation**:
平台把不可信内容包进带标签的 data block，使模型将其视为数据而非指令的强制机制；不依赖内容消毒。
_Avoid_: Prompt hygiene, Guardrail prompt

**Long-term Memory**:
跨 thread 的 Agent 记忆记录，仅显式 `memory.remember` 写入，由平台自有 `fde_memory` 表承载，按 Memory Namespace 隔离；是运行编排状态，不晋升为 Context Graph 事实或 Decision evidence；跨 runtime 不迁移、只导出。
_Avoid_: User profile, Knowledge

**Memory Namespace**:
长期记忆的隔离键 `{tenant_id}/{environment_id}/{solution_id}/{agent_id}/{owner}`；不含 deployment revision、bundle digest 或 runtime family，同 runtime 的 Release 升级沿用同一 namespace。
_Avoid_: Partition, Scope

## 明确不建模

**Engagement**:
交付项目管理概念（范围、里程碑、验收），不进入工作台领域模型。
_Avoid_: Project

**Workspace**:
编辑会话或 UI 概念，不建模；草稿就是 Solution Revision。
_Avoid_: Draft

**Tenant**:
多租户控制面概念，v0 不建模；运行时租户隔离由 `ExecutionContext` 的 `tenant_id` 表达，一个 bundle 对应一个 Customer，不引入 sub-tenant。
_Avoid_: Customer
