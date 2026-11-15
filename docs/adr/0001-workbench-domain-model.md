---
status: accepted
---
# 工作台领域模型：Customer 边界、Capability 契约、不可变 Bundle

v0 的领域模型以 **Customer → Solution → Solution Revision** 为交付主轴，显式建模 Environment、Bundle、Release、Deployment 和 Run，不建模 Tenant、Engagement 或 Workspace；跨客户复用通过版本化不可变 Template + 声明式 Overlay + 版本化 Extension，禁止 fork；Capability 是业务能力契约和治理/评测单位，Agent 与 Workflow 只是实现；构建产物是内容寻址、不可变的 Bundle，Release 是签署/批准记录，Deployment 绑定 Solution × Environment。这样单客户 bundle 可以独立构建、交付、升级和回滚，同时不引入多租户控制面；代价是每个 Solution 的 Bundle 自包含，跨 Solution 共享运行时或 Context Graph 需要未来另开拓扑。
