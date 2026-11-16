# FDE 工作台 v0 架构综合与实施切片

> 状态：决策稿，对应 ticket「[架构综合与实施切片](https://github.com/0xnicholas/Fdesforce/issues/13)」。
> 范围：地图的合龙检查——把选型研究（#3/#4/#14/#15/#16）、集成 spike（#5）、领域模型（#6）、Solution Spec（#7/#19）、运行时契约（#8/#17/#18/#20）、语义建模（#9）、评测（#10）、身份/部署（#12）与 Agent 安全（#21）的决策合成一份端到端架构，判断通顺性，并拆出可直接开工的实施切片。
> 契约版本：`fde.runtime/v1.2.0`。术语见 [`GLOSSARY.md`](../GLOSSARY.md)；关键取舍见 [ADR-0011](adr/0011-architecture-synthesis-and-slices.md)。

## 1. 结论摘要

**合龙结论：端到端架构通顺，可以进入实施。** 「配置 → 构建 → 打包 → 客户环境部署 → 运行 → 审计 → 评测/验收 → 升级/回滚」的完整路径上，每一步都有已定稿的契约承接，没有发现需要推翻重来或回补设计票的结构性空洞。

支撑这个判断的事实：

- 跨语言接缝只有一个（`mastra-app` → context-service 的 `/v1` REST + 签名 `ExecutionContext`），且已被 #5 的 spike 跑通（3 次 tool call、trace/actor/tenant → PROV-O、重启保留）。
- 不变量链闭合：record-before-act（C7/C26–C32）、审批覆盖（C16–C25/C35）、安全基线（C33–C40）都有 build 期 fail-closed + 运行时强制的双保险，不依赖"模型会听话"。
- 构建可重建性闭合：`solution.lock` v1 覆盖全部构建输入（ADR-0007），Bundle 内容寻址 + 双签名，客户侧 `fde install verify` 双验。
- 许可边界闭合：Mastra core-only（Apache-2.0）、Semantica MIT、生产检索 Postgres + pgvector，bundle 内无 GPL/商用依赖（#14/#15）。

合龙时发现的两处合并期冲突已仲裁（§4.1），8 项文档漂移已清扫（§4.2）；剩余风险全部是实施期 gate 而非设计缺口（§7）。

## 2. 组件图与责任边界

权威的运行期组件表与"不负责"清单在 [`runtime-contract.md`](runtime-contract.md) §2，不在此重述。本节补全构建期（工作台侧）视角，拼出全图：

```mermaid
flowchart LR
  subgraph 工作台侧（构建期，平台网络）
    Git[per-Customer Git<br/>Solution Spec + lock]
    CLI[fde CLI<br/>spec/context/eval/release/deploy]
    GEN[RuntimeGenerator<br/>@fde/runtime-generator，构建期端口]
    PROF[平台资产<br/>RuntimeProfile / ModelProfile / MetricCatalog / Template]
    REG[OCI registry + cosign<br/>Bundle/Release 双签名]
    Git --> CLI --> GEN
    PROF --> CLI
    GEN --> REG
  end
  subgraph 客户环境（运行期，客户 VPC）
    APP[客户应用] -->|HTTPS + SSE| M[mastra-app]
    IDP[客户 IdP] -.OIDC.-> M
    M -->|/v1 REST + ExecutionContext| X[context-service<br/>内嵌 Semantica]
    X --> G[(graph 卷<br/>embedded Context Graph)]
    X --> A[(audit 卷<br/>append-only)]
    M --> S[(mastra-state 卷)]
    X --> SRC[客户数据源<br/>claims-db / sharepoint]
    J[migrate/ingest/rebuild/eval 作业<br/>fde-jobs issuer] --> X
  end
  REG -->|离线包或私有 registry| OP[客户运维<br/>install/upgrade/rollback/backup]
  OP --> 客户环境
```

责任边界的一句话版本：

- **工作台**（CLI + generator + 平台资产 + registry）：构建、校验、打包、签名、验收证据核验；不托管运行时，不持有客户数据，对客户环境无入站连接。
- **`mastra-app`**：唯一入口；认证、编排、record-before-act、output guard、kill switch；不持久化语义事实，不直接查图，不写审计库。
- **`context-service`**：唯一的跨语言接缝；检索、数据权限、Decision/Provenance/Audit Event 写入、稳定 ID；不做编排，不暴露给终端用户。
- **Semantica**：只是 context-service 进程内的库；不承担 serving 检索，生产检索由 Postgres + pgvector 承担（#15）。
- **客户运维**：主机、网络、TLS、IdP、secret store、备份、升级窗口；执行部署动作，不修改生成物。

## 3. 端到端时序（索引）

权威时序图在 [`runtime-contract.md`](runtime-contract.md) §11（只读 Run §11.1、带副作用 Run §11.2、HITL 审批 §11.3、升级/回滚 §11.4）与 §9.2（启动顺序）。低分辨率全链路：

**一次带审批的写 Run**（Acme 理赔分诊，金额 >10 万）：

1. 客户应用带 OIDC token 调 `mastra-app` 的 Run API；验签后签发 `ExecutionContext`（平台角色 ∪ 业务角色）。
2. Workflow 的 `context` step：context-service 执行确定性 Recipe（resolve→structured→graph→lexical→merge→rank→mask→budget），返回带 `trust`/`classification` 的 items + `retrieval_id`。
3. `agent` step：`@fde/runtime` 把检索内容包进 per-Run nonce data block；模型只选 recipe/参数，不生成查询。
4. `approval` step：`requiredWhen` 求值（Policy predicate），命中则创建 Approval、Run 挂起；审批人决定本身是一条 Decision。
5. approve → resume → 副作用 Tool：`tool.pre_invoke` 评估 → intent Decision（写失败则不执行）→ 执行 → outcome Decision；`consume` 幂等收口。
6. output guard 过滤后 SSE 返回；Run 终止写 `phase=run` Decision；全程 `traceparent` 贯穿。

**构建/交付/升级链**：

`fde spec validate` → `fde spec lock --check` → `fde build`（generator 产出 app 源码/迁移/RuntimeTopology，平台合成 BundleTopology，fail closed）→ L1/L2 eval（客户侧数据集、签名 Evaluation）→ `fde release approve`（blocking gate + Waiver 检查 + 双签名）→ OCI 分发/离线包 → 客户侧 `fde install verify` → migrate → 启动（§9.2 顺序）→ smoke。升级是 stop-the-world；常规回滚不恢复 audit（§10.4/§10.5）。

## 4. 一致性仲裁与冲突清单

### 4.1 已仲裁（本 ticket 的决定）

**A. 分支合并顺序与编号线性化**。`design/runtime-adapter`（#17）上也存在一份 ADR-0007，与本分支的 ADR-0007（lock 完整性）冲突；且两边都把各自的 additive 契约 delta 称作 v1.1。仲裁：本分支先并，ADR 0001–0009 不动；`design/runtime-adapter` 合并时其 ADR 重编号为 **0010**，其契约 delta 顺移为 **v1.3.0**（`runtime-info` 的 `service` 统一为 `runtime-app` + `runtime`/`capability_details` 字段 + `backend.graph: postgres` + A1–A11 adapter suite）。版本史线性化为 1.0.0（#8）→ 1.1.0（#20）→ 1.2.0（#21）→ 1.3.0（#17）。本 ticket 的 ADR 用 **0011**。

**B. 契约版本引用约定**。工件/manifest 中的 `fde.runtime/v1` 指 **major line**（additive minor 向后兼容，引用 major 即可）；文档头部写当前 minor 全版本；正文依赖某 minor 才引入的字段时在该处标注（如「≥v1.1」）。约定已写入 [`runtime-contract.md`](runtime-contract.md) §10.1。

### 4.2 已清扫的漂移（非新决策，是已决结论的传播）

1. `GLOSSARY.md` 与 `domain-model.md` §3.6 的 Workflow 定义删除 branch/parallel，改为 #18 的窄 grammar（`context | agent | tool | approval` + `requiredWhen` 命名 predicate）；扩展指向地图雾区。
2. `domain-model.md` §1/§9/§10、`semantic-modeling.md` §8.3/§11、`evaluation-and-observability.md` §13、`runtime-contract.md` §13 的"生产后端待 #15"全部更新为已定结论（Postgres 17 + pgvector）。
3. `contracts/schemas/runtime-info.schema.json` 的 `backend.graph` enum 补 `postgres`（#15 的 additive delta）。
4. `decision-audit-binding.md` §5.1 的 enforcement point 固定词表补 `output.emit`（#21）。
5. `GLOSSARY.md` 枚举补全：Decision subject 加 Acceptance Report；Gate 加 `no_regression`/`monitor`；`evaluation-and-observability.md` §11.1 补 `adversarial` split。
6. `semantic-modeling.md` §10.1 的"Spec pin CCP digest"改为"Spec 引用、`solution.lock` pin"。
7. `prototype/11-solution-spec/GAPS.md` 状态卫生：GAP-1/2/4 标注 resolved 并指向 #17/#18/#12/本 ticket；GAP-2 的旧 grammar 提议标注已被 #18 取代。
8. prototype 三处契约版本对齐到 `1.2.0`（生成的 `runtime-info.ts`、`solution.lock`）。
9. `domain-model.md` §3.4 与 `GLOSSARY.md` 的 Environment 定义补上 #17 D11 的 v0 约束（一个 Environment 一个 Solution），消除 GAP-4 端口/卷冲突的残余歧义。

### 4.3 验证一致的承重接缝

跨文档扫描确认以下关节在所有文档与 schema 间一致（无需动作）：`decision_coverage` 全部按 invocation 级统计；Evidence union `graph_entity | retrieval | run_artifact | approval` 四处一致；`@fde/runtime` 统一拥有 ID/outbox/digest；conformance 编号链 C16–C25 → C26–C32 → C33–C40 与文档互指正确；`runtime-info` 端点名未被 #17 改名（改的是 `service` 值）；在线 judge 2% 默认值三处一致；#19 的 lock 形状（spec manifest + typed templates/assets + modelProfiles/evalDatasets）在 domain-model/ADR/GAPS 间一致。

### 4.4 已知但不阻塞的待办

- `design/runtime-adapter` 合并时：ADR → 0010、契约 → v1.3.0、`runtime-info` schema 同步 `runtime-app`/`runtime`/`capability_details`、A1–A11 落入 `contracts/conformance/`、各文档头部版本 bump。
- 上述合并前，`GLOSSARY.md` 的 Runtime Generator / Runtime Capability 词条在本分支暂无 backing doc，属已知的合并前状态。

## 5. 实施切片

参考场景统一为 **Acme claims-triage**（理赔分诊，金额 >10 万走人工审批）；Beta Bank KYC 只作复用性对照，不进切片验收。切片交付的是可运行、可验收的系统增量，不是文档；本 ticket 只定义切片，实施另开 effort。

### Slice 1「配置 → 部署 → 只读闭环」

**目标**：从一份真实 Spec 到客户环境内一次带审计的只读 Run，全链路最薄闭环。

**范围**：

- `fde` CLI 骨架：`spec init/validate/lock --check/build`、`context init/validate/freeze/ingest`、`install verify`。
- Mastra `RuntimeGenerator` 最小实现 + `RuntimeProfile`（Mastra 1.83.x profile）+ `BundleTopology` 合成 + Compose 渲染。
- Acme Spec 只读路径：`document-triage` 的 `context`+`agent` 步骤、`claims-lookup` 只读 Tool、CCP `acme-claims-context` 编译进 Bundle。
- Bundle 组装 + 单节点 Compose 部署 + `migrate`/`ingest` 作业（ingest 端点记为 context-service 内部端点，不进 Runtime API 面）。
- 只读 Run：Runtime API → Mastra agent → `/v1/retrieve`（embedded 图 + 词法）→ `phase=run` Decision → append-only 审计；`traceparent` 贯穿。
- 身份接缝真做：`ExecutionContext` 签名/验签、`mastra-app`/`fde-jobs` 双 issuer；但用开发用静态身份配置，真实 OIDC/JWKS/JIT 归 Slice 2。
- `GraphStore` 端口的最小契约化（方法、ID 规则、错误语义），实现仍是 embedded。

**验收标准**：

- 全新机器上 `docker compose up` 后 §9.2 启动顺序全绿；`GET /v1/runtime-info` 握手成功（C9）。
- 一条真实模型 endpoint 的 smoke Run 通过（验证 Mastra tool-calling 的真实行为；CI 用确定性 mock）。
- Conformance C1–C15 接入 runner 并全过。
- Semantica pin 在 0.7.x，生成代码的 import 对照 pinned wheel 验证（消除 prototype 的"asserted, not pinned"缺口）。
- 同 Spec + lock + toolchain 两次 build 产出同 digest 的 Bundle。
- 许可 gate：SBOM/notice 检查通过（Mastra core-only、Semantica MIT、无 GPL 组件）。

### Slice 2「副作用与治理闭环」

**目标**：补上 v0 的全部运行时不变量与治理面，达到可交付的单客户形态。

**范围**（内部顺序按此执行）：

1. `approval` step 全链路（C16–C25）：workflow 挂起/恢复、`POST /v1/approvals`、SSE `approval.required`、幂等 `consume`。
2. record-before-act（C26–C32）：`@fde/runtime` 包、`decision_outbox`、intent/outcome、`DecisionBinding` build 期合并与 fail-closed。
3. 评测与 Release 证据链：L1/L2 `fde eval`、`decision_coverage` gate、签名 Evaluation + `eval_binding_digest`、`fde release approve` 验签。
4. 真实身份：OIDC resource server、JWKS/introspection、JIT、平台/业务角色映射、`permissions.yaml` 编译与 mask。
5. Agent 安全基线（C33–C40）：prompt envelope、rate/budget、output guard、egress manifest、kill switch。C40 的完整 memory 断言依赖 [Agent memory 语义与 Spec schema](https://github.com/0xnicholas/Fdesforce/issues/22) 的 schema 定稿。
6. 部署与运维：Helm 渲染 + dry-run、airgap 离线包一次完整离线安装演练、升级/回滚演练（stop-the-world、audit 不回滚）、备份/恢复演练。

**验收标准**：

- Acme「金额 >10 万」场景端到端走通：审批 → 写 Tool → intent/outcome 配对 → `decision_coverage` gate 通过 → Release 按 prod `eval_binding_digest` 验收。
- C16–C40 全过（C40 按 #22 定稿范围）。
- 离线环境从离线包完成全新安装 + 一次升级到新版 Release + 一次回滚，审计链 `verify_chain` 通过。
- 拒绝路径可演示：未批准不执行、policy deny 不执行、kill switch halt 阻断新 Run。

### 显式不在切片内

多 Solution 共处一个 Environment（v0 由 #17 D11 限制为一对一）、Helm 真实集群认证、多节点/HA、100k/500k 性能压测（实施阶段 gate，见 §7）、workflow branch/parallel、成本模型。

## 6. ADR 索引

| ADR | 决策域 | 主要落点 | 切片 |
|---|---|---|---|
| [0001](adr/0001-workbench-domain-model.md) | 领域模型主轴、Customer 边界、不可变 Bundle | Spec schema、CLI | S1 |
| [0002](adr/0002-solution-spec-and-config-tooling.md) | YAML+Zod、物化模板+lock、CLI-first、OCI 分发 | CLI、generator | S1 |
| [0003](adr/0003-runtime-and-integration-contract.md) | context-service 独占接缝、签名 ExecutionContext、独立审计库 | 两个服务 | S1 |
| [0004](adr/0004-semantic-modeling-and-context-packaging.md) | CCP、确定性 Recipe、分层权限 | context-service、CCP 工具链 | S1 |
| [0005](adr/0005-evaluation-and-observability.md) | 三层验收、确定性 gate、客户侧数据集 | `fde eval` | S2.3 |
| [0006](adr/0006-identity-permissions-and-deployment.md) | 客户 IdP、双 issuer、客户运维执行 | mastra-app、部署链 | S2.4/S2.6 |
| [0007](adr/0007-lock-completeness-and-eval-evidence.md) | lock v1、Model Profile、Evaluation 签名 | CLI、Release 链 | S1/S2.3 |
| [0008](adr/0008-decision-audit-binding.md) | DecisionBinding、record-before-act | @fde/runtime | S2.2 |
| [0009](adr/0009-agent-security-controls.md) | Agent 安全确定性基线 | mastra-app、@fde/runtime | S2.5 |
| 0010（#17，合并时重编号） | RuntimeGenerator 端口、能力矩阵、BundleTopology | generator、topology | S1 |
| [0011](adr/0011-architecture-synthesis-and-slices.md) | 本综合：合并顺序、版本约定、切片划分 | — | — |

研究票的结论（Mastra/Semantica 选型 #3/#4、许可审计 #14、检索后端 #15、LangGraph 缺口 #16）不产生 ADR，其结论已并入上表各 ADR 的前提。

## 7. 剩余风险与雾区

实施期 gate（不阻塞开工，阻塞交付承诺）：

- **100k/500k p95 实测**：Postgres + pgvector 的检索性能未实测，是 Postgres/Neo4j 最终选型的实施期 gate（#15 已收口为默认 Postgres）。
- **真实模型 tool-calling**：ADR-0003 的遗留口子；由 Slice 1 的真实模型 smoke 关闭。
- **Semantica 0.7.x API pin**：prototype 的 import 未对照 pinned wheel 验证；Slice 1 验收项。
- **Helm 认证**：v0 只认证 Compose；首个强制 K8s 的客户需额外 spike。

地图雾区（保持 open，不属于本阶段）：

- **成本模型**：LLM、检索、评测与运维容量规划。
- **Workflow branch/parallel 与通用条件语言**：等第二个参考场景再评估。
- **多 Solution 共处 Environment 的拓扑**：v0 由 #17 D11 限制一对一；放开时需要端口/卷分配契约与新拓扑。

开放 ticket 依赖：[Agent memory 语义与 Spec schema](https://github.com/0xnicholas/Fdesforce/issues/22) 不定稿，C40 的完整断言与 Slice 2.5 的 memory 包装不能收口；它不阻塞 Slice 1/Slice 2.1–2.4。
