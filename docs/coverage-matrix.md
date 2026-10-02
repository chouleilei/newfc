# 全量覆盖矩阵（AC-X10）

基线：lishui-finance-ai `architecture/features.json`（e50b4b6，26 项）。newfc 代码基础为 newbd c67f6c4。
操作标记：**继**＝继承 newbd 原样使用，**扩**＝在继承模块上扩展，**新**＝newfc 新建。
证据列中的测试文件均在 `backend/tests/`（后端）、`frontend/src/**`（前端单测）与 `frontend/tests/e2e/`（E2E）；阶段记录见 [acceptance-records.md](acceptance-records.md)。
状态以证据为准：**通过**＝验收场景有自动化证据；**差异**＝与 lishui 能力不同，原因写明；**未完成**＝有计划未交付（按已登记验收场景判断；内部操作闭环与外部验证仍需持续核对，见 [功能完成度检查](function-completeness.md)）。

## 功能覆盖

| 验收 | 功能 | 入口页面 | 主要接口 | 操作清单 | 验收证据 | 状态 |
|---|---|---|---|---|---|---|
| AC-F01 | `platform_auth` | `/login`、顶栏修改口令/退出 | `/api/auth/login|logout|session`、`/api/me`、`/api/me/password` | 扩：登录改为库内用户+持久会话+CSRF；新：停用即失效、口令策略、登录锁定 | `security.test.ts`、`auth-session.spec.ts` | 通过 |
| AC-F02 | `platform_health` | — | `/api/health`、`/api/health/live`、`/api/health/ready` | 继：健康检查；扩：就绪含库可用性 | `newfc-baseline.test.ts`、T-0 记录 | 通过 |
| AC-F03 | `dashboard` | `/` 首页 | `/api/dashboard`、`/api/dashboard/todos`、`/api/dashboard/domains` | 继：预算执行概览；扩：财报摘要（T-3）、业务待办（T-4/T-5）、业务概况六块（T-6，按权限出现）；预测版本/可研报告复核待办（与列表同口径，按读+复核权限和组织范围裁剪） | `dashboard-overview.test.ts`、`t4-expense.test.ts`（待办）、`t6-dashboard.test.ts`、`financeData.test.tsx`、`cross-domain.spec.ts` | 通过 |
| AC-F04 | `contract_import` | `/contracts/import` | `/api/contracts/imports/*` | 新：预览→确认、幂等、PREVIEW_STALE、失败整体回滚 | `t4-contract-import.test.ts`、`project-contract.spec.ts` | 通过 |
| AC-F05 | `eas_workspace` | `/eas` | `/api/eas/import|batches|precheck|sets|locks|corrections|aux-requirements|period-status` | 新：原始批次、预检、集合激活、锁期、更正复核 | `t3-eas.test.ts`、`finance-data.spec.ts` | 通过 |
| AC-F06 | `data_governance` | `/governance` | `/api/governance/scan|issues|dispositions|quality-score|master-data-matches` | 新：扫描去重/重开、三种处置、复核、生效证明；T-7 补质量评分、主数据匹配建议（采用走映射覆盖复核） | `t3-governance.test.ts`、`t7-governance-quality.test.ts` | 通过 |
| AC-F07 | `master_data` | `/org`、`/account`、`/metric`、`/master-entities`、`/projects/:id`、`/master-health` | `/api/org`、`/api/account`、`/api/metrics`、`/api/master/projects|suppliers|mappings|resolve|dict-types|dict-items`、`/api/master/projects/:id/profile` | 继：组织/科目/指标树与快照；新：项目、供应商、编码映射；T-7 项目档案（预算、计划、合同付款、EAS 凭证、风险、投资控制/可研、相关报告、日志，分区按权限裁剪）、字典项（类型/取值不可改，停用代替删除）；T-8 组织/科目/指标真实配置草稿、字段帮助与指标 refs/query 分析 | `master-settings.test.ts`、`master-data-health.test.ts`、`unit.services.test.ts`、`t7-project-profile.test.ts`、`t7-master-dict.test.ts`、`t8-config-drafts.test.ts`、`t8-selection.test.ts`、`assistant-t8.spec.ts` | 通过 |
| AC-F08 | `operating_budget` | `/budget`、`/actual`、`/analysis`、`/compare` 等 | `/api/versions`、`/api/actual/*`、`/api/io/*`、`/api/report/*` | 继：版本、实际快照、预实分析；扩：组织范围裁剪与审计；T-8 保留网格草稿，预算/实际 bounds 限定真实取数、金额与数量分开 | `t2-budget-loop.test.ts`、`integration.test.ts`、`analysis-functional.spec.ts`、`t8-selection.test.ts`、`assistant-page-context.test.ts`、`grid-interaction.spec.ts` | 通过 |
| AC-F09 | `project_budget` | `/project-budget` | `/api/project-budget/preview|import|batches|summary` | 新：独立项目预算域，不读写经营预算事实 | `t4-project-budget.test.ts`、`list-pagination.test.ts`、`ledgerPagination.test.tsx` | 通过 |
| AC-F10 | `financial_statements` | `/statements` | `/api/statements/preview|import|batches|overview|trends` | 新：三大报表导入、激活、作废、指标；T-7 多期趋势（当月发生额、缺期不插补） | `t3-statements.test.ts`、`t7-statement-trends.test.ts`、`finance-data.spec.ts` | 通过 |
| AC-F11 | `finance_forecast` | `/forecast` | `/api/forecast/models|versions|runs|folders|publications|review-queue` | 新：工作簿导入、公式引擎、冻结、基准/情景运行、对比；T-7 补模型目录、版本复核、运行发布/撤回与已发布列表、基准时间线、运行洞察；待复核队列与首页深链 | `t5-formula-engine.test.ts`、`t5-forecast.test.ts`、`t6-jobs-restart.test.ts`、`t7-forecast-workflow.test.ts`、`risk-investment.spec.ts` | 通过 |
| AC-F12 | `investment_feasibility` | `/feasibility` | `/api/investment/feasibility/*` | 新：方案编辑/模板导入、冻结测算、敏感性任务、导出；T-7 补基准方案、删除方案、可行性报告生成与提交复核；生成/提交/批准重验测算依据，过期拒绝且仍可退回 | `t5-feasibility-calc.test.ts`（11 情形对 Python 参照）、`t5-feasibility.test.ts`、`t7-feasibility-workflow.test.ts`、`risk-investment.spec.ts` | 通过 |
| AC-F13 | `investment_control` | `/investment-control` | `/api/investment/control/*` | 新：概算/预算/结算导入、映射、对比快照、阈值（T-6 可在业务设置配置） | `t5-investment-control.test.ts`、`t6-settings.test.ts`、`risk-investment.spec.ts` | 通过 |
| AC-F14 | `management_accounting` | `/mgmt`（八个页签） | `/api/mgmt/*` | 新：预警、责任中心、维度、指标、分摊、预算调整、多维分析、绩效；T-4/T-5 接入合同/计划/风险/投资计算器 | `t3-mgmt.test.ts`、`t4-linkage.test.ts`、`t5-linkage.test.ts` | 通过 |
| AC-F15 | `plan_execution` | `/plan` | `/api/plan/preview|import|batches|overview|projects` | 新：三表模板、当期/累计、形象进度 | `t4-plan.test.ts` | 通过 |
| AC-F16 | `project_contract` | `/contracts` | `/api/contracts/*` | 新：阶段、审核、变更、付款申请/复核/支付、归档/重开、作废、文档 | `t4-contracts.test.ts`、`project-contract.spec.ts` | 通过 |
| AC-F17 | `risk_workflow` | `/risk` | `/api/risk/*` | 新：扫描、确认、整改、复核、重开、误报、整改台账；T-7 补齐 lishui 规则（20 条内置，含 EAS 凭证类）、自定义规则（复用计算器、可限定组织）、风险解释（只追加）、整改清单 | `t5-risk.test.ts`、`t7-risk-rules.test.ts`、`risk-investment.spec.ts` | 通过 |
| AC-F18 | `ai_reports` | `/analysis-reports`、`/insights` | `/api/analysis-reports/*`、`/api/assistant/insights` | 继：洞察草稿；新：审核、冻结、发布任务（DOCX/PDF）、修订 | `t5-reports.test.ts`、`t6-jobs-restart.test.ts`、`risk-investment.spec.ts` | 通过；模板管理见差异 |
| AC-F19 | `standard_reports` | `/standard-reports` | `/api/standard-reports/*` | 新：五类报表（预算执行、财报摘要、EAS 对账、合同付款台账、风险整改台账）冻结、复核、导出 | `t3-standard-reports.test.ts`、`t4-linkage.test.ts`、`t5-linkage.test.ts` | 通过 |
| AC-F20 | `xiaoli_assistant` | `/assistant`、页面侧栏助手 | `/api/assistant/*` | 继：助手编排、规则路由、降级；扩：各域只读工具（T-3～T-5）、`cross_search`（T-6）；T-8 单一快照/历史响应 V66，50 页面与 81 工具唯一目录，六配置草稿/字段帮助/三种选区 | `assistant*.test.ts`、`t3/t4-assistant.test.ts`、`t6-search.test.ts`、`assistant*.spec.ts`、`t8-*.test.ts`、`assistant-t8.spec.ts` | 通过 |
| AC-F21 | `agent_observability` | `/jobs` | `/api/jobs`、`/api/model-calls`、`/api/model-calls/stats` | 扩：持久任务、并发上限、取消、重启标记 interrupted；T-6：逐类型对账、失败/中断释放幂等键、任务类型中文名 | `jobs-observability.test.ts`、`t6-jobs-restart.test.ts` | 通过 |
| AC-F22 | `expense_audit` | `/expense`、`/expense/policies` | `/api/expense/claims|policies|queue` | 新：规则/OCR/制度依据审核、缺证待复核、复核后不可变、补件重提 | `t4-expense.test.ts`、`list-pagination.test.ts`、`t6-jobs-restart.test.ts`、`ExpenseClaims.test.tsx`、`project-contract.spec.ts` | 通过（OCR/模型为桩协议验证，真实供应商见 OPEN-05） |
| AC-F23 | `system_settings` | `/settings/ai`、`/settings/business` | `/api/settings/ai-channels|ai-feature-bindings|business|custom-fields|import-field-targets|import-field-aliases|ai-prompt-supplements`、`/api/master/custom-fields` | 继：模型渠道（凭据不回显）；扩：业务设置注册表（T-6 加投资控制阈值与预测超时）；T-7 自定义字段（项目/供应商 extra 按定义校验）、导入字段模板（EAS/计划执行表头别名）、AI 提示补充（附在硬约束之后，prompt 版本带哈希）；T-8 更新助手契约/OpenAPI/mock，配置草稿沿用同源设置与校验边界 | `ai-channel-fallback.test.ts`、`master-settings.test.ts`、`t6-settings.test.ts`、`t7-system-settings.test.ts`、`t8-config-drafts.test.ts` | 通过 |
| AC-F24 | `security_administration` | `/settings/security` | `/api/security/users|roles|permissions`、`/api/security/users/:id/sessions`、`/api/security/roles/:id/copy` | 新：用户、角色、组织授权；授权对页面/API/下载/工具/检索生效；T-7 补用户会话查看/吊销、角色复制；T-8 页面/多领域工具/草稿/选区及历史追问按现时服务端授权核验 | `security.test.ts`、`t7-security-sessions.test.ts`、`scope-restricted.spec.ts`、`platform-admin.spec.ts`、`t6-search.test.ts`、`t8-tool-contract.test.ts`、`t8-protocol.test.ts`、`t8-selection.test.ts` | 通过 |
| AC-F25 | `audit_log` | `/data?tab=logs` | `/api/logs` | 继：操作日志；扩：操作人/来源/结果/请求 ID、凭据脱敏、各域动作 | `security.test.ts` 及各域测试的日志断言 | 通过 |
| AC-F26 | `cross_domain_search` | 顶栏检索框、`/search` | `/api/search`、`/api/search/suggestions` | 新：十一类对象关键词检索、按权限与组织裁剪、结果路径可打开；T-7 补顶栏输入联想（可检索类型 + 前缀命中）；项目预算批次 SQL 先匹配再限量，旧批次可见性同领域权限；T-8 检索深链与授权导航共用页面目录 | `t6-search.test.ts`、`t7-search-suggestions.test.ts`、`Search.test.ts`、`App.test.ts`、`cross-domain.spec.ts`、页面目录契约与 `navigation-expansion.spec.ts` | 通过 |

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

## T-8 专项验收（2026-10-03）

T-8.1～T-8.6 代码实施与验收通过，尚未发布；生产仍为 T-0～T-7 / V65。提交、完整命令与组合浏览器复验、资源及迁移恢复证据见 [阶段验收记录](acceptance-records.md#t-84t-86--阶段完成2026-10-03)。覆盖清单见 [页面与工具目录](t8-assistant-inventory.md)。

| 验收 | 场景 | 证据 | 状态 |
|---|---|---|---|
| AC-T8-01 | 50 页面/页签与导航、动态深链、授权入口 | 页面目录契约、App/pageContext/userPrefs/Search；assistant-pages/independent-shell/navigation-expansion | 通过 |
| AC-T8-02 | 81 工具唯一 schema/校验/执行 | t8-tool-contract、assistant.catalog-tools、page-capabilities.contract | 通过 |
| AC-T8-03 | 页面/工具/草稿/选区/历史的现时授权 | assistant-scope、t8-tool-contract/config-drafts/cleaning-draft/selection/protocol；scope-restricted | 通过 |
| AC-T8-04 | 唯一 pageContext、旧请求拒绝、刷新保留输入 | t8-protocol、assistant-page-context、assistant.session；assistant-dock | 通过 |
| AC-T8-05 | 优先级、冲突与生命周期/迟到清理 | assistant-page-context、assistant-context-v2.integration（仅文件名保留）、Registry 18 项；assistant-t8 | 通过 |
| AC-T8-06 | V66 历史迁移、幂等、失败回滚与备份恢复 | t8-protocol 临时文件库；正文/事实/引用/金额/归属保留 | 通过 |
| AC-T8-07 | 线性/比率指标真实草稿、循环与依赖 | t8-config-drafts、ratio.metrics、management.metrics；assistant-t8 | 通过 |
| AC-T8-08 | 测算引用/税率/输出与只读试算 | t8-config-drafts、测算回归；assistant-t8 | 通过 |
| AC-T8-09 | 清洗文件/区域/单位/覆盖/别名 | t8-cleaning-draft 7 项、t8-config-drafts；assistant-t8/cleaning-import/UX31-S5 | 通过 |
| AC-T8-10 | 组织/科目部分更新、移动/状态与约束 | t8-config-drafts；assistant-t8 | 通过 |
| AC-T8-11 | 六配置字段事实、定位与窄屏操作 | t8-config-drafts、Registry；assistant-t8 | 通过 |
| AC-T8-12 | bounds 真实取数、父子去重、精确金额/数量 | t8-selection；grid-interaction | 通过 |
| AC-T8-13 | refs 全对象核验、限额与清理 | t8-selection、assistant-page-context、Registry；assistant-t8 | 通过 |
| AC-T8-14 | query 同源筛选、分页外集合与超限 | t8-selection；assistant-t8 指标/别名筛选分析 | 通过 |
| AC-T8-15 | 受控模型/流式、降级/取消、原始数据隔离及业务只读 | t8-config-drafts 11 项、t8-selection 10 项、t8-cleaning-draft、assistant.routing | 通过（受控上游，非供应商外呼） |
| AC-T8-16 | 文档/协议清理、全量单测、浏览器、独立构建与资源 | 后端 1026、前端 480；全部 94 浏览器场景组合复验；V66 恢复；资源符合 OPEN-04 | 通过（未触及的 443 条遗留测试 TS 错误另列记录） |

## 与 lishui 的能力差异

| 功能 | lishui | newfc | 原因 |
|---|---|---|---|
| 平台 | Dify/DB-GPT、MySQL、Redis、MinIO、Celery | 单进程 Node + SQLite + 内容寻址对象目录 + 进程内任务队列 | 单人维护、单机部署；范围边界禁止常驻中间件 |
| URL/API/表结构 | `/operating-budget`、`/risks`、`/users` 等 | 沿用 newbd 导航（`/budget`、`/risk`、`/settings/security` 等） | 需求明确不要求旧 URL/API/表结构兼容 |
| `contract_import` | 通用 `/data-import` 导入中心 | 各域独立导入入口（合同、项目预算、计划、财报、EAS、投资控制） | 每域先全量校验再原子提交，预览与确认同口径 |
| `ai_reports` | `/reports/templates` 用户维护报告模板 | 内置报告类型的确定性模板 + 可选模型改写（带事实护栏） | 报告正文必须可追溯到同源事实；用户自由模板无法保证审核冻结后的口径一致 |
| `xiaoli_assistant` | DB-GPT 先行问答、Dify 编排 | 本地编排 + 同源只读工具，未配置模型时规则路由降级 | 不引入 DB-GPT/Dify；AI 不得直接写库 |
| `agent_observability` | `/agents` Agent 运行记录 | `/jobs` 持久任务 + 模型调用记录 | 无 Agent 平台，重任务统一走任务队列 |
| `expense_audit` | 平台 OCR/模型 | 可配置 OCR/模型渠道，未配置时明确记录并转人工复核 | OPEN-05 已定：模型 New API/gemini-flash-latest（OpenAI 兼容）；OCR 直连 tangdalei 异步接口；制度样本为 lishui 首版规则 `deploy/expense-policy-v1.json`。超阈值严重度为高（lishui 为中），同类多行按合计比较阈值（lishui 按单据合计与逐行） |
| `finance_forecast` | Univer 在线工作簿编辑 + 独立 Node 计算服务、What-if 滑块 | 上传工作簿（JSON 保存）、内置受限公式引擎（Worker 隔离、超时与内存上限）、参数/输出配置、情景运行与基准对比；不提供在线单元格编辑 | 不引入 Univer 计算服务与 MinIO（specs/implementation.md 预测定位）；编辑在 Excel 中完成后导入为新草稿，情景参数替代滑块 |
| 历史数据 | MySQL/MinIO 运行数据 | newbd 快照用 `import:newbd` 迁入；lishui 业务数据经各域标准文件导入 | 不引入 MySQL；审批流水、会话、模型日志不迁入（OPEN-03 已定） |
| `risk_workflow` 规则 | `scan.py` 硬编码规则；自定义规则只存元数据、不参与扫描 | 规则 = 计算器 + 阈值/等级/组织；自定义规则复用内置计算器并真正参与扫描 | lishui `PROJECT_CODE_MISSING` → `PLAN_PROJECT_UNMAPPED`（newfc 预算行必须关联项目，缺口只在计划明细）；`CONTRACT_CODE_MISSING` → `CONTRACT_PAY_NO_VOUCHER`（合同编号必填，追溯断点落在付款缺凭证号）；`CONTRACT_OVERPAY` 由数据库约束阻断，保留 `CONTRACT_PAY_OVER_CAP` |
| `investment_control` 预警 | 投资控制内的预警台账 `/alerts`，逐条 `sync-risk` 手工推送到风险中心 | 不设独立预警台账：`IC_OVER_REDLINE`（超批复概算红线）、`IC_CONTROL_BREAK`（四算控制链被突破）、`IC_DEVIATION_EXCEED`（科目偏差超限）作为风险规则，由风险扫描直接从已确认版本与对比快照生成风险事件，处理/复核在风险台账完成；可行性测算同理（`FEAS_*` 五条） | 同一事实只在风险中心留一条事件与处理记录，避免预警与风险两套状态需要人工同步 |
| `security_administration` 服务账号 | `/security/service-accounts`：为 Dify/DB-GPT 等外部平台签发 internal/HMAC 凭据、轮换与停用 | 不提供（退出范围） | 服务账号只为外部编排平台回调而设；newfc 无外部平台，助手与任务在进程内以服务端构建的 `AuthContext` 调用同源 service，没有需要凭据的调用方 |
| `security_administration` 能力票据 | `/security/capability-tickets`：为 Agent/平台调用签发带策略快照的一次性票据、列表与撤销 | 不提供（退出范围） | 票据用于把用户权限快照带给进程外 Agent；newfc 的 AI 工具与页面同进程同校验，权限每次按会话实时解析，无需也不应另存快照 |
| `xiaoli_assistant` AI 评测 | `/ai/eval-cases`、`/ai/eval-runs`（含 mock 运行）在线评测台 | 不提供运行时评测台（退出范围）；等价保障在测试套件：`assistant.*.test.ts` 路由/工具/缺陷回归、`narrative-guard.test.ts` 事实守卫 | 评测是研发期质量手段，放进生产运行库会混入非业务数据；单人维护下由 Vitest 回归承担 |
| `system_settings` 提示词 | `/system-settings/ai-prompts` 可整段替换 system prompt、启用工具与免责声明 | 只允许按改写任务追加“业务补充说明”（`/settings/ai-prompt-supplements`），硬约束、工具清单不可配置 | AI 只能解释同源事实的边界不能被设置页放开；补充内容体现在 prompt 版本哈希中 |
| `system_settings` 导入字段模板 | 可改目标字段的标签/类型/必填/缺省值/查重键 | 只追加表头别名（`/settings/import-field-aliases`） | 字段类型、必填与换算是解析器口径（金额单位、精度）的一部分，随解析器版本审阅，不交给设置页 |
| `system_settings` 组织与分析指标 | `/system-settings/org-units|org-aliases|analysis-metrics` | 沿用继承的 `/org`、`/metric` 页面与 `/master-entities` 编码映射（来源系统 + 名称/编码 → 组织） | 同一事实只保留一个维护入口 |
| `cross_domain_search` | 无独立路由 | 关键词检索（精确 → 前缀 → 包含），非语义检索 | 结果须可解释且与各页权限同口径 |

## 未决事项（不属于退出范围）

finance/simulation 全量 E2E 已于 2026-09-30 补跑，79/79 通过（见验收记录 T-6 测试汇总）。

- OPEN-03：已定（2026-09-30）——lishui 旧历史（审批流水、会话、模型日志）不迁入。
- OPEN-05：已定（2026-09-30）——与 lishui 一致，见上表 `expense_audit` 行；2026-10-02 新增原有 OCR 服务账号接口适配（`ocr-adapter.test.ts`），保留 JSON 接口。真实供应商已配置，按用户确认以合成扫描件完成费用完整流程；证据见最新验收记录，真实业务准确率未评估。
