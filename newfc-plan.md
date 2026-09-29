# newfc 项目总计划

更新：2026-09-29。当前已建立总计划与 specs；尚未导入应用源码、初始化 Git 或部署服务。

## 已确定的方向

**以 newbd 为唯一初始代码基础，在 newfc 独立仓库中扩展实现 lishui-finance-ai 的业务功能。** lishui 提供业务规则与验收参考，不整体复制其源码树、历史文档或部署配置。原有 newbd 与 lishui 的代码、数据和服务保持独立。

| 项目 | 决定 |
|---|---|
| 项目/仓库 | newfc，目录 /root/newfc |
| 技术 | TypeScript + Express + React/Vite + SQLite |
| 部署 | 单 Node 进程 + systemd，服务 newfc.service |
| 存储与任务 | 本地文件、明确事务、有界任务与持久状态 |
| AI | 应用内编排、同源业务工具与直接模型 API；无 Dify/DB-GPT |
| 范围 | 复用 newbd 能力，逐域补齐 lishui 的 26 项功能入口及内部业务流程 |

## 规范入口

从 [specs/README.md](specs/README.md) 开始阅读。详细内容已从总计划移入各主题文件，规则只在对应主题维护：

- [需求与范围](specs/requirements.md)：做什么、26 项功能及阶段归属。
- [架构与来源](specs/architecture.md)：固定源码基线、仓库隔离和技术结构。
- [数据与接口契约](specs/data-contracts.md)：金额、事实、事务、权限和公共协议。
- [AI 规范](specs/ai.md)：工具、上下文、审核与知识检索。
- [运行与迁移](specs/operations.md)：systemd、资源、数据迁入和恢复。
- [实施任务](specs/implementation.md)：阶段依赖、首个预算闭环及未决事项。
- [验收规范](specs/acceptance.md)：功能与跨域验收编号、样本和证据。

## 下一步

执行 T-0：从规范中固定的 newbd 提交导出必要源码，在 newfc 初始化独立仓库，保留本文件和 specs。先验证继承基线，再完成权限与金额契约，推进“预算导入 → 页面汇总 → 同源 AI 查询”的首个闭环。

规范已具备范围、边界和验收追踪；字段级模型、真实样本、资源门槛等仍按 OPEN 项逐阶段落定。文档建立不等于业务实现或测试通过。
