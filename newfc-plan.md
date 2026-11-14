# newfc 项目总计划

更新：2026-11-14。公开源码版本 v0.2.0，数据库 schema V72。T-0～T-8 已验收发布；T-9 已发布（完整业务样本验收待补齐）；T-10～T-12及独立复核修复已发布至V72。实际证据见 [验收记录](docs/acceptance-records.md)。

2026-11-13 独立复核修复：T-10～T-12 原V70验收结论已由复核报告指出反例；已按报告完成修复、追加V72、通过工程复验并发布生产，备份和本机/公网核验通过，逐项证据以[修复记录](docs/contract-lifecycle-repair-2026-11-13.md)为准。

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
- [智能合同法审一期](specs/contract-legal-review.md) 与 [T-9 开发详细计划](specs/contract-legal-review-plan.md)：签约前智能法审业务契约与分步工程方案（工程验证及生产发布完成；历史样本完整业务验收待完成）。
- [合同全生命周期与监督报送完善设计](specs/contract-lifecycle.md) 与 [T-10～T-12 开发详细计划](specs/contract-lifecycle-plan.md)：八阶段闭环、双向收付结算、变更索赔四位一体、担保/质保/纠纷台账，以及每月 28 日公司 5 表月报、上级《纪巡财审》8 合 1 报送包与 OA 门户只读同步接口方案。
- [主数据底座、16 表计划扩展、合同简码映射与历史容缺清洗设计（T-13）](specs/foundation-and-legacy-migration.md)：阶段一（P0）V73 数据基座、批量初始化、16 表 `.xls` 计划解析、母公司简码映射、历史台账容缺清洗与已知缺陷清零契约。
- [综合计划合一下达、结构化会签招采、52 条监督预警与纠纷 17 列台账设计（T-14）](specs/plan-issuance-and-supervision-rules.md)：阶段二（P1）V74 综合计划 8 单元 49 表合一下达与 6 类调整、`÷ 1.06` 与五项费用 `bigint` 勾稽、公文 `<w:tbl>` 导出、多部门结构化会签、1:N 招采与 52 条监管预警及纠纷 17 列台账契约。

## 已交付阶段与后续工作

**T-8：独立助手契约与页面能力闭环**已于 2026-10-03 完成代码实施与阶段验收：页面与工具定义各自统一来源；单一 pageContext 协议与历史响应 V66 迁移；六类配置草稿、字段帮助及三类真实选区分析。任务和依赖见 [T-8 实施计划](specs/implementation.md#t-8独立助手契约与页面能力闭环)，行为契约见 [AI 规范](specs/ai.md#t-8统一上下文与页面能力契约)，通过条件见 [T-8 验收](specs/acceptance.md#t-8-专项验收已验收)。提交及实际验证见 [阶段验收记录](docs/acceptance-records.md#t-84t-86--阶段完成2026-10-03)。T-8 当次发布至 V66，见 [生产发布记录](docs/acceptance-records.md#t-8-生产发布2026-10-03)。

沿用现有领域 service、SQLite 与组件，持续核对审批、权限、事实口径与页面操作缺口。当前已实现功能核对结果见 [功能完成度检查](docs/function-completeness.md)。

全领域助手补齐已于 2026-10-02 14:25 CST 发布。当晚按用户指定接入 New API/gemini-flash-latest 与 tangdalei 异步 OCR，真实模型工具调用、流式和合成扫描件识别通过。用户已确认无需真实单据；合成单据完整费用流程与字段修复已验收发布，后续按实际使用继续维护；生产版本与联调进度见最近验收记录。

2026-11-12：T-9 智能合同法审一期代码、八项评审修复与工程验证已发布；生产已显式迁移至 V67，规则/解析、制度范本版本、复核门禁、页面及只读助手已上线。备份、本机与公网核验通过，见 [T-9 生产发布记录](docs/acceptance-records.md#t-9-生产发布2026-11-12)。三份种子范本保持候选，AC-CLR-09 多类型正式法审意见配对待补齐，详见[历史样本评估](docs/contract-legal-sample-evaluation.md)。

2026-11-13：完成 T-10～T-12（V68～V70）合同全生命周期与《纪巡财审》标准报送编码、全量回归、浏览器闭环、临时库迁移恢复演练与生产发布（生产 schema 为 V70），直接衔接现有计划/预算/四算与 T-9 法审闭环。详情见 [T-10～T-12 开发详细计划](specs/contract-lifecycle-plan.md) 与 [验收记录](docs/acceptance-records.md#t-10t-12-合同全生命周期与监督报送2026-11-13)。

2026-11-14：整理 v0.2.0 公开源码基线（T-8～T-12及V72复核修复），公开验证见[发布摘要](docs/public-release.md)。下一轮业务适配与数据迁移方案尚未实施；后续先核对实际基线并将确认需求归入对应 specs，再开展开发。AC-CLR-09 与真实 OA/上级平台在线联调仍待完成。
