# 验收规范

状态：所有项待 newfc 实现和验证。对应功能范围见[需求](requirements.md)，阶段见[实施任务](implementation.md)。

## 证据记录

每次阶段验收记录：任务/功能/验收 ID、新仓库提交、依赖与数据库版本、样本标识/哈希、执行方式、预期与实际、结果及剩余差异。位置可用单份阶段记录或 PR 描述，不要求为每个测试创建一份报告。

测试结果分为通过、失败、未执行；不可把跳过真实模型/OCR、无数据或仅成功启动写成业务等价通过。来源 Python 测试只用于提取场景，newfc 需有自己的 TS/SQLite/页面证据。

## 功能验收映射

原测试路径相对于 lishui-finance-ai 的 e50b4b6 基线，实施前核对是否适用，并扩展到模块内的异常分支。

| 验收 ID | 功能 ID | 必须验证的结果 | 原项目测试场景参考 |
|---|---|---|---|
| AC-F01 | `platform_auth` | 登录/退出、失效、CSRF、停用用户及越权访问 | `backend/tests/test_auth.py` |
| AC-F02 | `platform_health` | 无外部中间件启动；库不可用时就绪失败 | `backend/tests/test_health.py` |
| AC-F03 | `dashboard` | 筛选实际影响数据；无数据/异常如实展示 | `backend/tests/test_dashboard_executive.py` |
| AC-F04 | `contract_import` | 预览与确认一致，重复提交和失败回滚正确 | `backend/tests/test_import_service.py` |
| AC-F05 | `eas_workspace` | 对账、锁期、更正复核、当前批次原子切换 | `backend/tests/test_eas_mapping.py`、`backend/tests/test_eas_import_transaction.py`、`backend/tests/test_eas_sample_import_acceptance.py`、`backend/tests/test_management_accounting.py` |
| AC-F06 | `data_governance` | 治理不得直接篡改原始财务事实 | `backend/tests/test_governance_scope.py` |
| AC-F07 | `master_data` | 停用/映射不改历史快照，编码关系明确 | `backend/tests/test_master_data_v410.py` |
| AC-F08 | `operating_budget` | 同样本年度/组织、累计口径和符号一致 | `backend/tests/test_budget_template_parser.py` |
| AC-F09 | `project_budget` | 项目预算不读写经营预算事实 | `backend/tests/test_budget_template_parser.py` |
| AC-F10 | `financial_statements` | 利润/现金流累计与资产负债期末口径正确 | `backend/tests/test_financial_statements.py` |
| AC-F11 | `finance_forecast` | 公式、重算失败、版本冻结及资源释放 | `backend/tests/test_finance_forecast.py` |
| AC-F12 | `investment_feasibility` | 现金流、税费、融资、IRR/NPV/DSCR 与舍入 | `backend/tests/test_investment_feasibility.py` |
| AC-F13 | `investment_control` | 版本比较、超限提示及历史结果可追溯 | `backend/tests/test_investment_control_api.py` |
| AC-F14 | `management_accounting` | 八个既有子功能逐项覆盖，分摊守恒与快照一致 | `backend/tests/test_management_accounting.py` |
| AC-F15 | `plan_execution` | 当期/累计区分，同年批次取数规则一致 | `backend/tests/test_plan_execution.py` |
| AC-F16 | `project_contract` | 变更、付款、审核与证据关联，拒绝非法流转 | `backend/tests/test_contract_canonical_api.py` |
| AC-F17 | `risk_workflow` | 风险发现、处理、复核和重复触发行为明确 | `backend/tests/test_risks.py` |
| AC-F18 | `ai_reports` | 审批后冻结，已发布只能修订，DOCX/PDF 一致 | `backend/tests/test_reports.py`、`backend/tests/test_report_publication_workflow.py` |
| AC-F19 | `standard_reports` | 表内勾稽、期间/组织、金额与导出一致 | `backend/tests/test_finance_reports.py` |
| AC-F20 | `xiaoli_assistant` | 页面同源、上下文冲突/越权拒绝、模型失败降级 | `backend/tests/test_xiaoli_chat_orchestration.py`、`backend/tests/test_xiaoli_dbgpt_first_finance_qa.py` |
| AC-F21 | `agent_observability` | 成功/失败/中断可区分，重启不丢持久任务状态 | `backend/tests/test_agent_service.py` |
| AC-F22 | `expense_audit` | 规则/OCR/制度依据、缺证待复核、结论不可变 | `backend/tests/test_expense_ai_audit_v370.py` |
| AC-F23 | `system_settings` | 配置校验、凭据不回显，无旧平台设置依赖 | `backend/tests/test_system_settings_service.py` |
| AC-F24 | `security_administration` | 用户/角色管理及授权对页面、API、文件、工具生效 | `backend/tests/test_security_roles_api.py` |
| AC-F25 | `audit_log` | 操作人、对象、结果和来源可定位，日志不含凭据 | `backend/tests/test_permissions_audit.py` |
| AC-F26 | `cross_domain_search` | 只返回有权访问的业务对象，结果可回到真实页面 | `backend/tests/test_search.py` |

## 跨域验收

| ID | 场景 | 通过条件 |
|---|---|---|
| AC-X01 | 仓库与运行隔离 | 独立 .git/配置/SQLite/文件/端口；构建、启动、测试不读写两个原项目运行目录 |
| AC-X02 | 继承基线 | 来源 SHA 与导入清单可核对；新目录安装/构建及继承核心测试通过；无旧中间件也能就绪 |
| AC-X03 | 金额与口径 | 已核实样本精确一致，覆盖正负/零/缺失/舍入/安全边界/超限；数值无法表示时明确拒绝 |
| AC-X04 | 权限与身份 | 未登录、无权限、跨组织、停用用户、CSRF 和后台重新授权均按契约处理 |
| AC-X05 | 导入与写事务 | 重复确认、版本冲突、文件变化、并发写及中途失败不造成重复或部分成功 |
| AC-X06 | AI 同源与降级 | 页面/工具范围与事实一致，失败及无数据明确，引用可追溯，无模型直接写入 |
| AC-X07 | 任务与恢复 | 重启后任务状态可解释，幂等恢复；备份在独立目录恢复后库、附件、金额及关键页面一致 |
| AC-X08 | 发布与回退 | 构建失败保留运行产物；迁移显式；按 schema 与新增写入情况验证兼容回退或恢复 |
| AC-X09 | 资源与可用性 | 固定负载下记录全部指标并满足已定门槛；重任务并发有界，超限明确，普通查询和进度可用 |
| AC-X10 | 全量范围 | 全部 26 项及各域操作清单逐项验收；能力差异明确说明，未完成不能自动标为退出范围 |

## 样本集设计

- 财务：年度/组织/版本交叉、收入/费用符号、冲回、缺失/零、边界金额、精度与汇总溢出；比例和数量独立。
- 导入：合法、缺列/非法金额、重复、原件变化、已锁期间、旧预览、失败回滚。
- 权限：至少不同组织范围和不同操作权限的可丢弃用户，接口、文件、检索、任务、工具全部覆盖。
- 流程：费用复核追加、合同变更、EAS 更正切换、报告冻结/修订、投资已核实计算结果。
- 模型：未配置、超时、空正文、非法参数、无知识命中、被当成指令的文档文本和 OCR 失败。

样本不得使用正在运行的数据库作为可删除测试库。真实来源样本需脱敏并保留核对方法；尚未取得的样本登记为未验证，不用任意 mock 代替真实能力结论。

## 最小检查与发布条件

日常只运行改动关联的类型/单元/集成检查；涉及页面流转时加入对应浏览器路径。阶段完成核对任务列出的验收 ID。首次正式业务部署前，构建、财务与权限、文件 SQLite 迁移/恢复、关键页面和固定资源负载均需有实际通过记录。

本规范不要求大型 CI 平台、固定覆盖率百分比或每次运行全量外部模型测试。新增测试应验证业务边界或实际风险，不重复实现内部步骤。
