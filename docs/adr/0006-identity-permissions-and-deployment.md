---
status: accepted
---
# 身份、权限与部署：客户 IdP + 平台/业务角色、一 bundle 一 tenant、客户侧审计、客户运维执行

v0 的身份与授权以客户 IdP 为唯一用户源：客户应用持有 OIDC 登录会话，`mastra-app` 作为 resource server 校验 access token（JWT + JWKS，opaque token 走 introspection），JIT 映射 `sub`/groups，不建本地用户表；平台角色固定词表并授予 scope，业务角色从 IdP group 透传、只用于数据权限和 `approver_roles`，映射放在 Environment 配置并写 configuration Decision。授权分两层：`mastra-app` 做平台 RBAC，`context-service` 做编译式数据权限（`permissions.yaml` + Recipe filter + mask），不引入 OPA/Cedar；一个 bundle 一个 `tenant_id`（= Customer），不引入 sub-tenant，硬隔离业务单元用独立 bundle。服务身份拆成 `mastra-app` 与 `fde-jobs` 两个 issuer，各自 per-Deployment ES256 key；审计库在客户侧 append-only，除 Decision/Provenance 外记录 `auth/authz/identity/release/deployment/retention/audit` 事件，`auditor` 读/导出、`customer_admin` 读 + retention/legal hold，工作台不回传。部署由客户运维执行签名 `fde` CLI + runbook，工作台无入站连接、无常驻凭证，FDE 只走客户 IdP 的限时 `support` 角色，本地 break-glass 凭证归客户；v0 只认证单节点 Compose，Helm 生成但不承诺，airgap 用完全离线签名包。这样身份、数据权限、审计和部署责任都有单一归属，v0 可在客户环境闭环；代价是 IdP group/卷加密/单节点运维都依赖客户纪律，SCIM、SAML、CMK/BYOK、WORM、HA/DR 和 agent 专项安全控制延后。

完整威胁模型、角色/scope 表、审计事件、RACI、v0 范围与默认值见 [`docs/security-and-deployment.md`](../security-and-deployment.md)；运行时接缝见 [`docs/runtime-contract.md`](../runtime-contract.md)。

## Considered Options

- **bundle 本地用户库 / 自建登录页**：部署自包含，但会引入第二套密码/MFA/用户生命周期，客户 IdP 治理失效；改为客户 IdP OIDC + JIT，bundle 不存普通用户。
- **把 IdP token 原样透传给 context-service**：少一次签发，但内部服务会信任外部 audience，租户/scope 无法收敛；改为 `mastra-app` 验签后签发短时 `ExecutionContext`。
- **单一扁平角色词表**：实现简单，但客户业务角色会污染平台授权，role 爆炸；改为平台角色固定词表 + 业务角色透传，业务角色不能获得平台 scope。
- **OPA/Cedar 统一策略**：表达力强，但 air-gapped 多一个运行时、延迟和版本矩阵，v0 策略仍需可审计；改为编译式数据策略 + 确定性代码。
- **sub-tenant / workspace 层级**：同一 bundle 内硬隔离方便，但会扩散到 `ExecutionContext`、图、审计和部署拓扑；改为一个 bundle 一个 tenant，硬隔离用独立 bundle。
- **工作台远程管理面 / FDE 常驻访问**：支持方便，但把工作台变成托管控制面，违背单客户部署模型；改为客户运维执行 + 客户 IdP 限时 `support`。
- **应用层 CMK/BYOK/信封加密**：密钥托管更强，但 air-gapped KMS/HSM 集成成本高，v0 无客户数据入工作台；改为客户卷加密/TLS/secret store，bundle 只持 per-Deployment 签名 key。
- **审计只记 Decision/Provenance**：实现最小，但登录、角色变更、部署、导出等安全事件无处可查；改为独立审计库同时保存 Audit Event，OTel/SIEM 不替代审计。

## Consequences

- `mastra-app` 必须实现 OIDC resource server、JWKS/introspection、claim/group 映射和 support/break-glass 闸门；不提供登录 UI。
- `ExecutionContext.roles` 变成平台角色 ∪ 业务角色的并集；业务角色与平台角色重名由 `fde identity validate` 拒绝；`iss` 增加 `fde://<deployment_id>/jobs`。
- 新增 `IdentityProfile`（Environment 配置）、Audit Event schema/family，以及 `fde identity validate`、`keys rotate`、`audit export`、`audit retention`、`break-glass` 命令面；由「架构综合与实施切片」落地。
- 客户必须提供 OIDC IdP、加密卷、TLS、secret store、备份介质、维护窗口和（air-gapped）内部 NTP/模型 endpoint；没有 SCIM/admin UI，IdP group 管理靠客户流程。
- v0 只认证单节点 Compose；Helm 清单生成并 smoke 验证，但强制 K8s 的客户需要额外 spike；无 HA，SLO 99.0%/月不覆盖主机故障。
- 审计完整性依赖哈希链、备份和客户 SIEM 拉取；无 WORM/外部锚定，root 管理员篡改只能靠导出/备份发现。
- prompt injection、tool abuse、data exfiltration 的专项控制不在本 ADR；由独立 ticket [#21](https://github.com/0xnicholas/Fdesforce/issues/21) 承接，残余风险用 tool allowlist、审批、record-before-act、审计和评测缓解。
- 若未来转多租户/托管控制面，需要重开身份、tenant、审计回传和部署责任，不是配置切换。
