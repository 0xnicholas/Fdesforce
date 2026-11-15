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
Customer 拥有的部署目标（如 dev/staging/prod），可承载多个 Solution 的 Deployment，并提供命名 profile 的具体非 secret 值（profile_values）。
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
确定性的编排实现，包含步骤、分支、并行、人工审批和持久化状态，是 Capability 的一种实现。
_Avoid_: Pipeline, Graph

**Tool**:
Agent 或 Workflow 可调用的、有 schema 的动作；可以是纯代码，也可以由 Connector 提供。
_Avoid_: Function, Action

**Connector**:
对外部系统的接入，拥有凭证引用、数据契约和限流规则，并向 Tool 或 Context Source 提供能力；它是 Customer 级资产，可被多个 Solution 引用。
_Avoid_: Integration, Adapter

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

**Release**:
对一个 Bundle 的批准和签署记录，按 Solution 全局唯一、不可变，是部署的单位。
_Avoid_: Version, Build

**Deployment**:
Release 在某个 Environment 中的安装实例；同一 Solution × Environment 只有一个 active Deployment。
_Avoid_: Instance, Installation

**Deployment Revision**:
Deployment 中一次 Release 安装的不可变记录，包含 Release 版本、迁移结果和时间戳。
_Avoid_: Deployment, Version

**Run**:
Deployment 内一次 Agent 或 Workflow 的执行，带 trace、actor、状态和 provenance。
_Avoid_: Job, Execution

## 治理

**Policy**:
对运行时行为的约束（数据访问、工具、审批、保留、模型路由、PII），由生成的代码和 context-service 强制执行。
_Avoid_: Rule, Guardrail

**Eval Suite**:
版本化的评测定义，包含数据集、scorer、阈值和通过标准。
_Avoid_: Test, Benchmark

**Evaluation**:
一次 Eval Suite 的执行，引用被评测的 Bundle/Release，并记录结果。
_Avoid_: Eval, Test Run

**Waiver**:
在明确记录理由和审批人的前提下，对一条治理门禁的临时豁免；本身是一条 Decision。
_Avoid_: Exception, Override

## 语义与上下文

**Ontology**:
版本化的词汇表和约束（classes/properties/SHACL），可以来自 Template，也可以由 Customer 扩展。
_Avoid_: Schema, Vocabulary

**Semantic Model**:
Customer 对 Ontology 的绑定，包含选定的模块、实体映射和解析/合并规则。
_Avoid_: Knowledge Model

**Context Source**:
一个已配置的外部数据源或数据集，带有凭证引用、分类和新鲜度要求。
_Avoid_: Data Source

**Context Recipe**:
声明式的上下文检索和组装方案。
_Avoid_: Prompt, Retriever

**Context Graph**:
由 Context Source 物化出的图数据，可重建，不是作者实体。
_Avoid_: Knowledge Graph

**Decision**:
一次被记录的选择，包含理由、证据、actor 和 provenance；`subject` 可以是 Run、Evaluation、Release、Deployment 或 Solution Revision。
_Avoid_: Log, Note

**Provenance**:
对实体、关系和决策的来源与演化记录，用 PROV-O 表达。
_Avoid_: Audit Log, Lineage

## 明确不建模

**Engagement**:
交付项目管理概念（范围、里程碑、验收），不进入工作台领域模型。
_Avoid_: Project

**Workspace**:
编辑会话或 UI 概念，不建模；草稿就是 Solution Revision。
_Avoid_: Draft

**Tenant**:
多租户控制面概念，v0 不建模；运行时 `X-Tenant-Id` 只是技术 header。
_Avoid_: Customer
