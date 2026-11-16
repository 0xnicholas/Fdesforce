---
status: accepted
---
# Agent 安全：确定性基线、平台强制与显式残余风险

v0 的身份/权限/部署决策明确把 prompt injection、tool abuse、data exfiltration 的行为层控制留在 bundle 之外，但这不是说风险不存在：检索文档、Tool 返回值、用户输入和 memory 都可能携带指令，模型会照做；只靠「模型会听话」无法交付。本 ADR 把 v0 的 agent 安全收口为**确定性、可 fail closed 的控制基线**：只有签名 Bundle 是可信指令源，所有运行时内容都是不可信数据；生成器用平台拥有的 prompt envelope 和 per-Run nonce 做 instruction/data 分离；副作用 Tool 只能出现在 Workflow 的 approval gate 之后，Agent-only 实现只能读；副作用 Tool 必须有 rate limit 和 Run 预算；`mastra-app` 在返回前做 secret 阻断/PII 脱敏/链接白名单；egress 默认拒绝并限定到声明的 endpoint；memory 不晋升为图事实或证据；kill switch 通过 admin 端点执行 `halt`。概率检测、内容消毒、Extension 沙箱和 HMAC digest 明确延后，并写清残余风险与触发条件。这样 v0 的控制都能在 build 或运行时确定性验证，代价是：平台要拥有 prompt 模板并接受 Tool 返回/memory 的包装开销；副作用只能走 Workflow 审批；输出过滤需要流式 holdback；kill switch 增加一个 admin API 面；注入内容仍可能影响模型对事实的判断，安全边界靠 allowlist/审批/egress/output guard 而非「模型不会上当」。

完整决策、控制清单、契约 delta 与 conformance 见 [`docs/agent-security.md`](../agent-security.md)；运行时版本见 [`docs/runtime-contract.md`](../runtime-contract.md) §10；威胁模型边界见 [`docs/security-and-deployment.md`](../security-and-deployment.md) §2；审计字段见 [`docs/decision-audit-binding.md`](../decision-audit-binding.md) §4。本 ADR 细化 [ADR-0003](0003-runtime-and-integration-contract.md) 的运行时接缝、[ADR-0006](0006-identity-permissions-and-deployment.md) 的威胁模型和 [ADR-0008](0008-decision-audit-binding.md) 的 intent/outcome 语义；不改变 Bundle/Release 的不可变性和 `fde.runtime/v1` 的既有端点语义。

## Considered Options

- **引入 injection classifier/canary/dual-LLM 做 v0 防线**：检测语义级注入听起来直接，但 v0 单节点、无安全运营团队，分类器误报/漏报无法验收，canary 需要模型配合，dual-LLM 增加一次模型调用和延迟；这些都不能 fail closed。改为确定性基线，概率监控只保留在线 judge advisory。
- **只在 Agent instructions 里写「不要听文档里的指令」**：成本最低，但换模板/换模型就失效，无法 conformance，也无法阻止 Tool 滥用。改为平台拥有的 prompt envelope + trust label。
- **在 context-service 里检测/消毒注入内容**：能减少模型看到的指令，但 v0 没有可靠的语义检测，改写会破坏原文引用与审计；改为只做边界标记，不改写内容。
- **允许 Agent-only Capability 调副作用 Tool，由 `tool.pre_invoke` 返回 require approval**：灵活，但要把 HITL 状态机塞进 policy 层，新增 suspend/resume 路径；#18 的 approval gate 已经是一等 Step。改为副作用只走 Workflow + approval gate，Agent-only 只读。
- **rate limit 做成可编辑 Policy Template**：客户可调，但 `Tool.rateLimit` 已经是 Tool 的内在属性，两个真相源会漂移。改为 Tool 声明 + 平台 evaluation，Policy 不再重复。
- **输出过滤只做 redact，不阻断 secret**：用户体验平滑，但 secret 一旦发出无法撤回；改为 secret 硬阻断、PII 默认 redact、Policy 可升级为 block。
- **egress 交给客户网络，bundle 不管**：部署简单，但「注入成功也带不走数据」是 v0 最重要的确定性控制之一；改为 manifest + 安装时 nftables/等价策略，客户不能执行时显式记录 exception。
- **memory 视为平台内部可信状态**：实现简单，但跨会话持久内容可被用户影响，等于给投毒开长期后门；改为不可信数据、不晋升图/证据、跨用户召回拒绝。
- **Extension 进程/容器沙箱**：隔离最强，但 v0 只有签名代码入口，沙箱会增加运行时复杂度和性能成本；改为签名即受信 + 接口白名单 + Connector scope + egress allowlist，沙箱延后。
- **对低熵 PII digest 用 HMAC/CMK**：能降低枚举风险，但引入新的密钥面、轮换和跨版本验签；#12 已定 v0 不做应用层 CMK。改为接受残余风险 + 审计访问控制/卷加密/保留策略，写明重新评估触发。
- **kill switch 用签名配置文件 + 重启**：实现简单，但无法证明是谁按的开关，也不能立即 halt；改为 Runtime API admin 端点 + Audit Event 恢复 + 活跃 Run 取消。
- **新增 `security_blocked` ErrorCode**：语义清楚，但客户应用要多一个分支；kill switch 用 `forbidden` + `details.reason` 已足够，rate limit/tool deny 走 intent/`authz.denied`。

## Consequences

- Solution Spec 新增 `tools.<id>.rateLimit`（非 read 必填）、`capabilities.<id>.budget.maxToolCallsPerRun/maxSteps`、`extensions.<id>.egress`；build 对缺 rate limit、缺 approval gate、Agent-only 写 Tool、放宽预算、非法 egress fail closed。
- `RetrievalItem` 新增 `trust`/`source_kind`；`PolicyEvaluation.enforcement_point` 新增 `output.emit`；Runtime API 新增 `/v1/admin/killswitch` 三个端点；契约升 `fde.runtime/v1.2.0`（additive），`solution.lock` 同步。
- 生成器必须使用平台 prompt 模板，不能由 Agent 作者自由拼接 instructions；Tool 返回与 memory 由 `@fde/runtime` 包装，生成物不能绕过。
- `mastra-app` 增加 output guard（secret/PII/链接/流式 holdback）、rate/budget 计数、kill switch 状态机；`context-service` 增加 `trust`/`source_kind` 返回；`fde install` 增加 egress manifest/规则校验。
- 审计新增 `security.killswitch.enabled/disabled`、`security.output_blocked`；rate limit/tool deny/kill switch 拒绝复用 `authz.denied` + reason code；审计仍不存原文/secret。
- 低熵 PII digest 枚举风险被显式接受；若审计角色外包、客户要求强 PII 保护或出现真实枚举事件，重新评估 keyed digest。
- 评测新增 `adversarial` split（advisory），确定性安全红线进 C33–C40；不把行为级 red-team 做成 Release gate。
- 实现落在「架构综合与实施切片」：prompt envelope、output guard、kill switch、egress、schema/codegen、C33–C40 runner；本 ADR 不实现生产代码。
- 已知残余风险：注入内容仍可能影响模型对事实的判断；PII/secret pattern 有漏报；链接只处理文本输出；Extension 签名代码受信；客户管理员/root 可信。交付时必须按 `docs/agent-security.md` §7 说明。
