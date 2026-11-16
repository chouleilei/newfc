# v0.3.1 公开发布

版本日期：2026-11-16。范围：T-0～T-15 及合同全生命周期界面与查询交互优化，数据库 schema **V75**（无新增迁移）。软件版本、数据库迁移版本与阶段任务编号分别管理。历史摘要保留在 [v0.3.0 发布记录](public-release-v0.3.0.md)、[v0.2.0 发布记录](public-release-v0.2.0.md) 和 [v0.1.0 发布记录](public-release-v0.1.0.md)。

## 本次变化

- 全生命周期直观阶段引导：`Contracts` 主列表顶部新增八阶段（含「需求立项」）漏斗筛选条，详情抽屉新增八阶段 `Steps`、签署分发/归档正交标签、需求立项摘要（含计划调整联动入口）及已关闭未评价履约评价提醒。
- 分阶段填报与阻断就地消缺：`ContractBaseFormModal` 按合同阶段默认折叠非当前关注分组并支持 `focusSection` 聚焦定位与计划外应急提示；抽屉阻断项按错误码直达对应表单分组、预设常用附件类型或切换会签/结算/变更/担保页签。
- 待办、线索与监督联动：后端扩展 `todo=countersign|review_or_countersign`、`legacyFilter=clue`、`pendingCountersigns` 及 `summary.pending` 细分计数，工作台「待审核/会签合同」及页面可点击待办标签精准直达；新增可展开 `ContractSupervisionOverviewBar` 协同监督概览、`ContractExportModal` 预检点击直达合同抽屉补录，以及 `MasterEntities` 供应商「合同履约评价」列；签署后默认折叠智能法审面板，高级筛选支持折叠与一键重置。

详细结果见 [更新记录](../CHANGELOG.md) 和 [阶段验收记录](acceptance-records.md#v031-合同全生命周期交互优化与生产部署2026-11-16v75)。

## 发布与升级范围

GitHub 仓库为 https://github.com/chouleilei/newfc，使用 [MIT](../LICENSE) 许可，第三方声明见 [NOTICE](../NOTICE.md)。发布源码、锁定依赖清单、脱敏通用制度/候选范本种子、离线 XLSX 包和合成测试夹具。

不发布私有方案、真实财务及合同原件、运行数据库、附件对象、备份、会话、凭据或内部 QA 原件。`docs/private/` 保持 Git 忽略。

本次同时完成生产部署和 GitHub 发版。生产于 **2026-11-16 09:08:15 CST** 从 v0.3.0 / V75 滚动更新至 **v0.3.1 / V75**（无新增 schema 迁移）：使用 Node **24.22.1** 通过 `scripts/deploy.sh` 完成全量单测、前后端构建、幂等迁移/种子检查与服务重启，本机与公网健康、权限边界及数据库完整性核验通过。上一版产物保留在 `dist.old`，升级与回退说明见 [运维手册](operations-runbook.md#v031-合同交互完善更新2026-11-16v75)。

## 验证

本轮在 v0.3.1 代码与版本变更后，使用 Node **24.22.1** 和锁文件依赖执行发布门禁与线上核验；测试数据库均为内存库或临时目录。

| 检查 | 实际结果 |
|---|---|
| 后端源码与测试类型检查 | `tsc --noEmit`、`npm run typecheck:test` 通过 |
| 后端全量测试 | 144 文件 / 1187 项通过（950.65s，含新增会签与线索筛选单测） |
| 后端生产依赖审计 | 0 漏洞 |
| 前端全量测试 | 67 文件 / 526 项通过（422.49s，含新增全生命周期交互单测） |
| 前端类型与隔离生产构建 | `tsc -b`、Vite 构建通过（39.80s） |
| 前端生产依赖审计 | 0 漏洞 |
| 浏览器 Playwright E2E | 本补丁未单独重跑全量 E2E；最近一次全量 117 项通过记录见 [v0.3.0 发布记录](public-release-v0.3.0.md#验证) |
| 生产部署 | `scripts/deploy.sh` 退出码 0；schema 保持 V75；主进程 PID 3062005 启动于 2026-11-16 09:08:15 CST，NRestarts=0 |
| 生产健康与权限 | 本机/公网 live、ready 均 200，schema V75；登录页 200，未登录业务接口 401 |
| 当前库完整性 | `PRAGMA integrity_check=ok`、`foreign_key_check=[]`、最高迁移版本 75；近 10 分钟 warning 日志为空 |

测试输出包含 jsdom `getComputedStyle`、Rollup Zod 注释位置和 `NO_COLOR`/`FORCE_COLOR` 警告；均未造成测试或构建失败。

## 已知边界

- `AC-CLR-09` 八类合同材料已完成合成配对工程回归，但正式历史法审意见、逐条人工标注和建议采纳评价仍待业务证据；合成结果不计作正式业务验收。
- 三份初始法审范本保持 candidate，须经授权人工核定后转正。
- 真实 OA 接收端与上级平台在线导入尚未联调。
- 财务预测使用受限公式引擎，检索使用关键词/FTS；模型建议须人工复核。
