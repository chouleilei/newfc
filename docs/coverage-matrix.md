# 全量覆盖矩阵（AC-X10）

基线：lishui-finance-ai `architecture/features.json`（e50b4b6，26 项）。newfc 代码基础为 newbd c67f6c4。
操作标记：**继**＝继承 newbd 原样使用，**扩**＝在继承模块上扩展，**新**＝newfc 新建。
证据列中的测试文件均在 `backend/tests/`（后端）、`frontend/src/**`（前端单测）与 `frontend/tests/e2e/`（E2E）；阶段记录见 [acceptance-records.md](acceptance-records.md)。
状态以证据为准：**通过**＝验收场景有自动化证据；**差异**＝与 lishui 能力不同，原因写明；**未完成**＝有计划未交付（当前没有此类功能项，未决事项见文末）。

## 功能覆盖

| 验收 | 功能 | 入口页面 | 主要接口 | 操作清单 | 验收证据 | 状态 |
|---|---|---|---|---|---|---|
| AC-F01 | `platform_auth` | `/login`、顶栏修改口令/退出 | `/api/auth/login|logout|session`、`/api/me`、`/api/me/password` | 扩：登录改为库内用户+持久会话+CSRF；新：停用即失效、口令策略、登录锁定 | `security.test.ts`、`auth-session.spec.ts` | 通过 |
| AC-F02 | `platform_health` | — | `/api/health`、`/api/health/live`、`/api/health/ready` | 继：健康检查；扩：就绪含库可用性 | `newfc-baseline.test.ts`、T-0 记录 | 通过 |
| AC-F03 | `dashboard` | `/` 首页 | `/api/dashboard`、`/api/dashboard/todos`、`/api/dashboard/domains` | 继：预算执行概览；扩：财报摘要（T-3）、业务待办（T-4/T-5）、业务概况六块（T-6，按权限出现） | `dashboard-overview.test.ts`、`t4-expense.test.ts`（待办）、`t6-dashboard.test.ts`、`financeData.test.tsx`、`cross-domain.spec.ts` | 通过 |
| AC-F04 | `contract_import` | `/contracts/import` | `/api/contracts/imports/*` | 新：预览→确认、幂等、PREVIEW_STALE、失败整体回滚 | `t4-contract-import.test.ts`、`project-contract.spec.ts` | 通过 |
| AC-F05 | `eas_workspace` | `/eas` | `/api/eas/import|batches|precheck|sets|locks|corrections|aux-requirements|period-status` | 新：原始批次、预检、集合激活、锁期、更正复核 | `t3-eas.test.ts`、`finance-data.spec.ts` | 通过 |
| AC-F06 | `data_governance` | `/governance` | `/api/governance/scan|issues|dispositions` | 新：扫描去重/重开、三种处置、复核、生效证明 | `t3-governance.test.ts` | 通过 |
| AC-F07 | `master_data` | `/org`、`/account`、`/metric`、`/master-entities`、`/master-health` | `/api/org`、`/api/account`、`/api/metrics`、`/api/master/projects|suppliers|mappings|resolve` | 继：组织/科目/指标树与快照；新：项目、供应商、编码映射 | `master-settings.test.ts`、`master-data-health.test.ts`、`unit.services.test.ts` | 通过 |
| AC-F08 | `operating_budget` | `/budget`、`/actual`、`/analysis`、`/compare` 等 | `/api/versions`、`/api/actual/*`、`/api/io/*`、`/api/report/*` | 继：版本、实际快照、预实分析；扩：组织范围裁剪与审计 | `t2-budget-loop.test.ts`、`integration.test.ts`、`analysis-functional.spec.ts` | 通过 |
| AC-F09 | `project_budget` | `/project-budget` | `/api/project-budget/preview|import|batches|summary` | 新：独立项目预算域，不读写经营预算事实 | `t4-project-budget.test.ts` | 通过 |
| AC-F10 | `financial_statements` | `/statements` | `/api/statements/preview|import|batches|overview` | 新：三大报表导入、激活、作废、指标 | `t3-statements.test.ts`、`finance-data.spec.ts` | 通过 |
| AC-F11 | `finance_forecast` | `/forecast` | `/api/forecast/models|versions|runs` | 新：工作簿导入、公式引擎、冻结、基准/情景运行、对比 | `t5-formula-engine.test.ts`、`t5-forecast.test.ts`、`t6-jobs-restart.test.ts`、`risk-investment.spec.ts` | 通过 |
| AC-F12 | `investment_feasibility` | `/feasibility` | `/api/investment/feasibility/*` | 新：方案编辑/模板导入、冻结测算、敏感性任务、导出 | `t5-feasibility-calc.test.ts`（11 情形对 Python 参照）、`t5-feasibility.test.ts`、`risk-investment.spec.ts` | 通过 |
| AC-F13 | `investment_control` | `/investment-control` | `/api/investment/control/*` | 新：概算/预算/结算导入、映射、对比快照、阈值（T-6 可在业务设置配置） | `t5-investment-control.test.ts`、`t6-settings.test.ts`、`risk-investment.spec.ts` | 通过 |
| AC-F14 | `management_accounting` | `/mgmt`（八个页签） | `/api/mgmt/*` | 新：预警、责任中心、维度、指标、分摊、预算调整、多维分析、绩效；T-4/T-5 接入合同/计划/风险/投资计算器 | `t3-mgmt.test.ts`、`t4-linkage.test.ts`、`t5-linkage.test.ts` | 通过 |
| AC-F15 | `plan_execution` | `/plan` | `/api/plan/preview|import|batches|overview|projects` | 新：三表模板、当期/累计、形象进度 | `t4-plan.test.ts` | 通过 |
| AC-F16 | `project_contract` | `/contracts` | `/api/contracts/*` | 新：阶段、审核、变更、付款申请/复核/支付、归档/重开、作废、文档 | `t4-contracts.test.ts`、`project-contract.spec.ts` | 通过 |
| AC-F17 | `risk_workflow` | `/risk` | `/api/risk/*` | 新：扫描、确认、整改、复核、重开、误报、整改台账 | `t5-risk.test.ts`、`risk-investment.spec.ts` | 通过 |
| AC-F18 | `ai_reports` | `/analysis-reports`、`/insights` | `/api/analysis-reports/*`、`/api/assistant/insights` | 继：洞察草稿；新：审核、冻结、发布任务（DOCX/PDF）、修订 | `t5-reports.test.ts`、`t6-jobs-restart.test.ts`、`risk-investment.spec.ts` | 通过；模板管理见差异 |
| AC-F19 | `standard_reports` | `/standard-reports` | `/api/standard-reports/*` | 新：五类报表（预算执行、财报摘要、EAS 对账、合同付款台账、风险整改台账）冻结、复核、导出 | `t3-standard-reports.test.ts`、`t4-linkage.test.ts`、`t5-linkage.test.ts` | 通过 |
| AC-F20 | `xiaoli_assistant` | `/assistant`、页面侧栏助手 | `/api/assistant/*` | 继：助手编排、规则路由、降级；扩：各域只读工具（T-3～T-5）、`cross_search`（T-6） | `assistant*.test.ts`、`t3/t4-assistant.test.ts`、`t6-search.test.ts`、`assistant*.spec.ts` | 通过 |
| AC-F21 | `agent_observability` | `/jobs` | `/api/jobs`、`/api/model-calls`、`/api/model-calls/stats` | 扩：持久任务、并发上限、取消、重启标记 interrupted；T-6：逐类型对账、失败/中断释放幂等键、任务类型中文名 | `jobs-observability.test.ts`、`t6-jobs-restart.test.ts` | 通过 |
| AC-F22 | `expense_audit` | `/expense`、`/expense/policies` | `/api/expense/claims|policies|queue` | 新：规则/OCR/制度依据审核、缺证待复核、复核后不可变、补件重提 | `t4-expense.test.ts`、`t6-jobs-restart.test.ts` | 通过（OCR/模型为桩协议验证，真实供应商见 OPEN-05） |
| AC-F23 | `system_settings` | `/settings/ai`、`/settings/business` | `/api/settings/ai-channels|ai-feature-bindings|business` | 继：模型渠道（凭据不回显）；扩：业务设置注册表（T-6 加投资控制阈值与预测超时） | `ai-channel-fallback.test.ts`、`master-settings.test.ts`、`t6-settings.test.ts` | 通过 |
| AC-F24 | `security_administration` | `/settings/security` | `/api/security/users|roles|permissions` | 新：用户、角色、组织授权；授权对页面/API/下载/工具/检索生效 | `security.test.ts`、`scope-restricted.spec.ts`、`platform-admin.spec.ts`、`t6-search.test.ts` | 通过 |
| AC-F25 | `audit_log` | `/data?tab=logs` | `/api/logs` | 继：操作日志；扩：操作人/来源/结果/请求 ID、凭据脱敏、各域动作 | `security.test.ts` 及各域测试的日志断言 | 通过 |
| AC-F26 | `cross_domain_search` | 顶栏检索框、`/search` | `/api/search` | 新：十一类对象关键词检索、按权限与组织裁剪、结果路径可打开 | `t6-search.test.ts`、`Search.test.ts`、`App.test.ts`、`cross-domain.spec.ts` | 通过 |

## 跨域验收

| 验收 | 场景 | 证据 | 状态 |
|---|---|---|---|
| AC-X01 | 仓库与运行隔离 | T-0 记录；演练/测试只用临时目录，发布演练在副本中进行 | 通过 |
| AC-X02 | 继承基线 | [source-provenance.md](source-provenance.md)、`newfc-baseline.test.ts` | 通过 |
| AC-X03～X06 | 金额口径、权限、导入事务、AI 同源 | T-2～T-5 各阶段记录 | 通过 |
| AC-X07 | 任务与恢复 | `t6-jobs-restart.test.ts`、`t6-backup.test.ts`（备份包、校验、页面恢复补齐对象、`restore:drill` 独立目录演练）、`t6-newbd-import.test.ts` | 通过 |
| AC-X08 | 发布与回退 | `scripts/release-drill.sh`（构建失败/迁移失败/成功发布/schema 回退拒绝/数据丢失确认/回退就绪），结果见 T-6 记录 | 通过 |
| AC-X09 | 资源与可用性 | `npm run resource:baseline`（T-6 增加报告发布、预测重算、敏感性、跨域检索、重任务+普通查询 p95），结果见 T-6 记录 | 通过（负载约 5 时一次导入期间 p95 超限，负载回落后两次复测满足，见记录） |
| AC-X10 | 全量范围 | 本文件 | 通过（未决事项见下） |

## 与 lishui 的能力差异

| 功能 | lishui | newfc | 原因 |
|---|---|---|---|
| 平台 | Dify/DB-GPT、MySQL、Redis、MinIO、Celery | 单进程 Node + SQLite + 内容寻址对象目录 + 进程内任务队列 | 单人维护、单机部署；范围边界禁止常驻中间件 |
| URL/API/表结构 | `/operating-budget`、`/risks`、`/users` 等 | 沿用 newbd 导航（`/budget`、`/risk`、`/settings/security` 等） | 需求明确不要求旧 URL/API/表结构兼容 |
| `contract_import` | 通用 `/data-import` 导入中心 | 各域独立导入入口（合同、项目预算、计划、财报、EAS、投资控制） | 每域先全量校验再原子提交，预览与确认同口径 |
| `ai_reports` | `/reports/templates` 用户维护报告模板 | 内置报告类型的确定性模板 + 可选模型改写（带事实护栏） | 报告正文必须可追溯到同源事实；用户自由模板无法保证审核冻结后的口径一致 |
| `xiaoli_assistant` | DB-GPT 先行问答、Dify 编排 | 本地编排 + 同源只读工具，未配置模型时规则路由降级 | 不引入 DB-GPT/Dify；AI 不得直接写库 |
| `agent_observability` | `/agents` Agent 运行记录 | `/jobs` 持久任务 + 模型调用记录 | 无 Agent 平台，重任务统一走任务队列 |
| `expense_audit` | 平台 OCR/模型 | 可配置 OCR/模型渠道，未配置时明确记录并转人工复核 | 供应商与制度样本待 OPEN-05 确认 |
| `finance_forecast` | Univer 在线工作簿编辑 + 独立 Node 计算服务、What-if 滑块 | 上传工作簿（JSON 保存）、内置受限公式引擎（Worker 隔离、超时与内存上限）、参数/输出配置、情景运行与基准对比；不提供在线单元格编辑 | 不引入 Univer 计算服务与 MinIO（specs/implementation.md 预测定位）；编辑在 Excel 中完成后导入为新草稿，情景参数替代滑块 |
| 历史数据 | MySQL/MinIO 运行数据 | newbd 快照用 `import:newbd` 迁入；lishui 业务数据经各域标准文件导入 | 不引入 MySQL；审批流水、会话、模型日志保留范围待 OPEN-03 |
| `cross_domain_search` | 无独立路由 | 关键词检索（精确 → 前缀 → 包含），非语义检索 | 结果须可解释且与各页权限同口径 |

## 未决事项（不属于退出范围）

finance/simulation 全量 E2E 已于 2026-09-30 补跑，79/79 通过（见验收记录 T-6 测试汇总）。

- OPEN-03：lishui 旧历史（审批流水、会话、模型日志）的保留范围——真实数据迁入前确认。
- OPEN-05：真实 OCR/模型供应商与制度样本——费用审核以桩协议验证，接入真实供应商时补样本验收。
