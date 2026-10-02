# newfc 项目总计划

更新：2026-10-03。T-0～T-8 已实现、验收并发布。2026-09-30 独立上线，2026-10-03 已发布 T-8，生产 schema 为 V66。代码验证与生产发布状态分别见 [验收记录](docs/acceptance-records.md)。

## 已确定的方向

**newfc 是独立维护、部署与验收的水利财务分析系统。** 已确认的 26 项业务功能与内部流程以 specs 为准；初始源码、业务规则与样本来源见 [来源记录](docs/source-provenance.md)，来源项目的代码、数据与服务保持隔离。

| 项目 | 决定 |
|---|---|
| 项目/仓库 | newfc，目录 /root/newfc |
| 技术 | TypeScript + Express + React/Vite + SQLite |
| 部署 | 单 Node 进程 + systemd，服务 newfc.service |
| 存储与任务 | 本地文件、明确事务、有界任务与持久状态 |
| AI | 应用内编排、同源业务工具与直接模型 API；无 Dify/DB-GPT |
| 范围 | 覆盖 26 项功能入口及内部业务流程 |

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

**T-8：独立助手契约与页面能力闭环**已于 2026-10-03 完成代码实施与阶段验收：页面与工具定义各自统一来源；单一 pageContext 协议与历史响应 V66 迁移；六类配置草稿、字段帮助及三类真实选区分析。任务和依赖见 [T-8 实施计划](specs/implementation.md#t-8独立助手契约与页面能力闭环)，行为契约见 [AI 规范](specs/ai.md#t-8统一上下文与页面能力契约)，通过条件见 [T-8 验收](specs/acceptance.md#t-8-专项验收已验收)。提交及实际验证见 [阶段验收记录](docs/acceptance-records.md#t-84t-86--阶段完成2026-10-03)。T-8 已发布，生产为 T-0～T-8 / V66，见 [生产发布记录](docs/acceptance-records.md#t-8-生产发布2026-10-03)。

沿用现有领域 service、SQLite 与组件，持续核对审批、权限、事实口径与页面操作缺口。当前已实现功能核对结果见 [功能完成度检查](docs/function-completeness.md)。

全领域助手补齐已于 2026-10-02 14:25 CST 发布。当晚按用户指定接入 New API/gemini-flash-latest 与 tangdalei 异步 OCR，真实模型工具调用、流式和合成扫描件识别通过。用户已确认无需真实单据；合成单据完整费用流程与字段修复已验收发布，后续按实际使用继续维护；生产版本与联调进度见最近验收记录。
