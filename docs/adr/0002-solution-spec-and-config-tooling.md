---
status: accepted
---
# Solution Spec 与配置工具形态：YAML + Zod、物化模板 + lock、CLI-first

v0 的 Solution Spec 以 YAML 为规范载体、Zod 为唯一定义（导出 JSON Schema 和 TS 类型），每个 Customer 一个 Git 仓库；`fde spec init` 把版本化 Template 物化为完整 Spec，`solution.lock` 固定 Template、Extension、Customer 级对象、runtime profile 和 toolchain 的精确版本与 digest，build 只读 lock；客户代码只能通过 Extension artifact 进入，Spec 保持声明式；工具是 `fde` CLI + CI，不建常驻工作台服务；Bundle 和 Release 用 OCI + 双签名，Revision/Release 的真相源是 Git tag + OCI artifact + 客户侧 Deployment 记录。这样 Spec 可评审、可离线重建、无控制面；代价是 v0 只有 Mastra generator，换运行时需要新的 generator、Extension 打包和 Bundle 拓扑，不是配置切换。

完整决策、最小示例和反例见 [Solution Spec 与配置工具形态](https://github.com/0xnicholas/Fdesforce/issues/7)；运行时可移植性缺口见 [LangGraph 运行时映射缺口](https://github.com/0xnicholas/Fdesforce/issues/16)。

## Consequences

- Template/Extension 需要 OCI registry 和 cosign 签名；离线交付走 `vendor/` 或客户私有镜像。
- Spec 的实体集合是 id-keyed map；Overlay 只按 allowlist 路径 `add | set | remove`。
- `solution.lock` 是 Spec 的一部分，必须随 Revision 冻结；build 不解析浮动范围，也不回拉模板。
- v0 单运行时；LangGraph 映射由后续 research ticket 评估，不在本 ADR 承诺双运行时。
