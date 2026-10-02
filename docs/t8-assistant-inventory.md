# T-8 页面与工具覆盖清单

本清单记录本次迁移的实际入口，权威定义为 `backend/src/contracts/page-catalog.ts` 与 `assistant/*-tools.ts`。后续新增页面或工具维护契约即可，数量不是产品上限。

| PageId | 路由/页签 | 组件 | 权限/全组织 | 助手能力 |
|---|---|---|---|---|
| eas | /eas | EasWorkspace | eas:read | finance_data, project_data, risk_investment, domain_support |
| governance | /governance | Governance | governance:read | finance_data, project_data, risk_investment, domain_support |
| statements | /statements | Statements | statements:read | finance_data, project_data, risk_investment, domain_support |
| mgmt | /mgmt | ManagementAccounting | mgmt:read | finance_data, project_data, risk_investment, domain_support |
| standard_reports | /standard-reports | StandardReports | report:read | finance_data, project_data, risk_investment, domain_support |
| project_budget | /project-budget | ProjectBudget | project_budget:read | finance_data, project_data, risk_investment, domain_support |
| plan | /plan | PlanExecution | plan:read | finance_data, project_data, risk_investment, domain_support |
| contracts | /contracts | Contracts | contract:read | finance_data, project_data, risk_investment, domain_support |
| contract_import | /contracts/import | ContractImport | contract:import | finance_data, project_data, risk_investment, domain_support |
| expense | /expense | ExpenseClaims | expense:read | finance_data, project_data, risk_investment, domain_support |
| expense_policies | /expense/policies | ExpensePolicies | expense:read | finance_data, project_data, risk_investment, domain_support |
| feasibility | /feasibility | Feasibility | investment:read | finance_data, project_data, risk_investment, domain_support |
| investment_control | /investment-control | InvestmentControl | investment:read | finance_data, project_data, risk_investment, domain_support |
| forecast | /forecast | Forecast | forecast:read | finance_data, project_data, risk_investment, domain_support |
| risk | /risk | RiskLedger | risk:read | finance_data, project_data, risk_investment, domain_support |
| analysis_reports | /analysis-reports | AnalysisReports | report:read | finance_data, project_data, risk_investment, domain_support |
| master_entities | /master-entities | MasterEntities | master:read | finance_data, project_data, risk_investment, domain_support |
| project_profile | /projects/:id | ProjectProfile | master:read | finance_data, project_data, risk_investment, domain_support |
| search | /search | Search | search:use | finance_data, project_data, risk_investment, domain_support |
| jobs | /jobs | JobsCenter | tasks:read | finance_data, project_data, risk_investment, domain_support |
| business_settings | /settings/business | SettingsBusiness | settings:read | finance_data, project_data, risk_investment, domain_support |
| security | /settings/security | SecurityAdmin | security:manage | finance_data, project_data, risk_investment, domain_support |
| dashboard | / | Dashboard | dashboard:read | overview, execution, evidence, finance_data, project_data, risk_investment, domain_support |
| assistant | /assistant | Assistant | assistant:use | assistant_content, execution, comparison, budget, actual, master_data, import_conversion, operations, overview, evidence, finance_data, project_data, risk_investment, domain_support |
| insights | /insights | Insights | assistant:use | assistant_content |
| master_health | /master-health | MasterDataHealthPage | master:read/全组织 | master_data |
| cleaning_config | /cleaning-config | CleaningConfig | import:run/全组织 | import_conversion |
| budget_progress | /progress | BudgetProgress | budget:read/全组织 | budget, overview, execution |
| anomaly_center | /alerts | AnomalyCenter | analysis:read | overview, execution |
| metric_trend | /metric-trend | MetricTrend | analysis:read | comparison, evidence |
| ai_settings | /settings/ai | SettingsAi | settings:read | operations |
| org | /org | OrgManage | master:read | master_data |
| account | /account | AccountManage | master:read | master_data |
| metric | /metric | MetricManage | master:read | master_data |
| budget_versions | /budget | BudgetVersions | budget:read/全组织 | budget |
| budget_edit | /budget/:id | BudgetEdit | budget:read/全组织 | budget, evidence |
| actual | /actual | ActualMaintain | actual:read/全组织 | actual, evidence |
| finance_import | /finance | FinanceImport | finance_import:manage/全组织 | import_conversion |
| analysis | /analysis | Analysis | analysis:read | execution, evidence |
| structure | /structure | Structure | analysis:read | comparison, evidence |
| history | /history | History | analysis:read/全组织 | comparison |
| version_compare | /compare | VersionCompare | analysis:read/全组织 | comparison, evidence |
| calculations | /data?tab=calculations | DataManage | budget:read/全组织 | budget |
| imports | /data?tab=imports | DataManage | import:run/全组织 | import_conversion |
| data_check | /data?tab=check | DataManage | master:read/全组织 | operations |
| yearclose | /data?tab=yearclose | DataManage | actual:finalize/全组织 | operations |
| backup | /data?tab=backup | DataManage | system:backup/全组织 | operations |
| migration | /data?tab=migration | DataManage | system:backup/全组织 | operations |
| data_export | /data?tab=export | DataManage | analysis:export/全组织 | operations |
| logs | /data?tab=logs | DataManage | audit:read | operations |

工具迁移基线：79 项；T-8.5 新增两项网格选区工具，当前共 81 项。经营预算/财务/项目/投资工具与后续新增领域工具均已归入同一执行器。模型参数由 Zod 生成，未知字段拒绝。金额单位继续沿用领域 service；列表上限见各工具 schema/service，规则降级复用相同执行器。

| 工具 | 权限 | 范围 | 能力 |
|---|---|---|---|
| domain_ledger | 按已解析 kind 的领域权限 | org_scope | domain_support |
| domain_batch_read | 按已解析 kind 的领域权限 | org_scope | domain_support |
| statement_trends | statements:read | org_scope | domain_support |
| mgmt_workspace | mgmt:read | org_scope | domain_support |
| domain_workspace | 按已解析 kind 的领域权限 | org_scope | domain_support |
| feasibility_report_read | investment:read | global | domain_support |
| get_org_tree | master:read | org_tree | master_data |
| get_account_tree | master:read | global | master_data |
| list_budget_versions | budget:read | global | 通用 |
| list_actual_snapshots | actual:read | global | 通用 |
| get_year_states | actual:read | global | actual, operations |
| list_sheets | master:read | global | 通用 |
| list_metrics | master:read | global | master_data |
| list_calculation_rules | budget:read | global | budget |
| explain_terms | assistant:use | global | 通用 |
| get_navigation_catalog | assistant:use | global | 通用 |
| calculate_execution | analysis:read | org_scope | execution, evidence |
| calculate_trend | analysis:read | org_scope | execution, comparison |
| calculate_anomalies | analysis:read | org_scope | execution |
| calculate_attribution | analysis:read | org_scope | execution |
| calculate_structure | analysis:read | org_scope | comparison |
| calculate_multi_year_trend | analysis:read | org_scope | comparison |
| generate_report | analysis:read | org_scope | assistant_content |
| get_metric_evidence | analysis:read | org_scope | evidence |
| get_budget_cell_history | budget:read | org_cell | budget |
| get_cell_evidence | analysis:read | org_cell | evidence |
| get_cell_notes | analysis:read | org_cell | budget, actual, evidence |
| get_budget_selection | budget:read | org_scope / bounds | budget, evidence |
| get_actual_selection | actual:read | org_scope / bounds | actual, evidence |
| get_budget_matrix | budget:read | all_orgs | budget |
| get_budget_quality | budget:read | all_orgs | budget |
| get_budget_progress | budget:read | all_orgs | budget |
| get_actual_snapshot | actual:read | all_orgs | actual |
| calculate_variance | analysis:read | all_orgs | comparison |
| calculate_accuracy | analysis:read | all_orgs | overview, execution |
| get_historical_comparison | analysis:read | all_orgs | overview, comparison |
| get_dashboard_overview | dashboard:read | global | overview |
| list_insights | analysis:read | all_orgs | assistant_content |
| get_master_data_health | master:read | all_orgs | master_data |
| check_consistency | master:read | all_orgs | operations |
| explain_import | import:run | all_orgs | import_conversion |
| validate_import | import:run | all_orgs | import_conversion, operations |
| get_import_batch | import:run | all_orgs | import_conversion |
| list_cleaning_templates | import:run | global | import_conversion |
| list_cleaning_aliases | import:run | all_orgs | import_conversion |
| get_operation_log | audit:read | all_orgs | operations |
| list_finance_conversions | finance_import:manage | all_orgs | import_conversion |
| get_finance_conversion | finance_import:manage | all_orgs | import_conversion |
| list_finance_mapping_versions | finance_import:manage | all_orgs | import_conversion |
| get_finance_mapping_version | finance_import:manage | all_orgs | import_conversion |
| list_finance_parallel_trials | finance_import:manage | all_orgs | import_conversion |
| list_finance_source_profiles | finance_import:manage | all_orgs | import_conversion |
| list_backups | system:backup | all_orgs | operations |
| eas_period_status | eas:read | org_scope | finance_data |
| statement_overview | statements:read | org_scope | finance_data |
| mgmt_analysis | mgmt:read | org_scope | domain_support |
| mgmt_metric_snapshots | mgmt:read | org_scope | finance_data |
| mgmt_alerts | mgmt:read | org_scope | finance_data |
| project_budget_summary | project_budget:read | org_scope | project_data |
| plan_execution_overview | plan:read | org_scope | project_data |
| contract_summary | contract:read | org_scope | project_data |
| contract_detail | contract:read | global | project_data |
| expense_audit_queue | expense:read | org_scope | project_data |
| feasibility_result | investment:read | org_scope | risk_investment |
| investment_comparison | investment:read | org_scope | risk_investment |
| forecast_runs | forecast:read | org_scope | risk_investment |
| risk_summary | risk:read | org_scope | risk_investment |
| report_list | report:read | org_scope | risk_investment |
| cross_search | search:use | global | 通用 |
| project_profile | project:read | global | domain_support |
| master_entities | master:read | org_scope | domain_support |
| expense_detail | expense:read | global | domain_support |
| policy_search | expense:read | global | domain_support |
| governance_issues | governance:read | org_scope | domain_support |
| standard_report_read | report:read | org_scope | domain_support |
| analysis_report_read | report:read | global | domain_support |
| risk_detail | risk:read | global | domain_support |
| forecast_result | forecast:read | global | domain_support |
| task_status | tasks:read | global | domain_support |
| authorization_scope | assistant:use | global | domain_support |
| configuration_overview | settings:read | global | domain_support |


## 配置草稿与选择入口

| 页面/操作 | 草稿 | 字段/同源校验 |
|---|---|---|
| 组织新建、编辑、移动、状态确认 | org_form | 具体操作白名单、服务器 updatedAt、层级循环与引用 |
| 科目新建、编辑、移动、状态；表格新建/编辑 | account_form | 类型、数量单位与汇总、引用、表格根科目与折叠规则 |
| 指标线性/比率新建与编辑 | metric_formula | 完整依赖、循环、分子分母、量纲与方向 |
| 数据管理测算模板新建与编辑 | calculation_rule | 数量/单价/税率、输出引用、指定版本只读试算 |
| 预算/实际清洗向导、配置页模板 | cleaning_template | 当前用户文件所有者、指纹、有效期、区域/列/单位/映射、业务基线 |
| 配置页别名、向导名称映射 | alias_rule | 规范化重名、目标有效性、当前映射与长期别名区分 |

字段含义与约束在 `contracts/config-fields.ts` 维护，正式保存与草稿复用领域 validator。已有对象使用同源 updatedAt，新建使用 clientKey；向导分析携带当前文件来源与指纹。问答不创建树快照或导入批次；正式提交在短事务内重检。

| 选择 | 实际页面 | 同源服务/工具 | 处理边界 |
|---|---|---|---|
| bounds | 预算编制、实际录入网格 | analysis/selection.service；get_budget_selection、get_actual_selection | 页面工作表与有权组织求交，父子叶子去重；金额/数量分别 bigint 汇总，范围内草稿叠加 |
| refs | 指标、清洗别名列表 | selection-context；list_metrics、list_cleaning_aliases | 全部选中 ID 核验、失效/冲突拒绝，编辑和切页签清空 |
| query | 指标、清洗别名筛选结果 | 与正式列表共用 list-filters 和 service | 先核对总量，覆盖分页外匹配项；筛选变更清选择，拒绝 SQL/自报总数/行数据 |

三种选择均限制 500 个对象/单元格，详情最多 30 项并说明省略；不支持的工具拒绝活动选择。注册表 token 防止迟到清理覆盖新对象。OpenAPI 的页面与工具快照由 `scripts/update-assistant-catalog.ts` 派生，运行时仍只引用源码目录。
