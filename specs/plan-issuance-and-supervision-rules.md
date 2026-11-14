# 综合计划合一下达、结构化会签招采、52 条监督预警与纠纷 17 列台账设计（T-14）

状态：阶段二（P1）设计基线。覆盖 AI 法审绑定与受限 PDF 解析（`GAP-04`）、年度综合计划与预算 8 单元 49 表合一下达与 6 类调整闭环（`GAP-06`）、多级组织归并与跨单位承办稽核（`GAP-07`）、四层数值语义及 `÷ 1.06` 税率与五项费用 `bigint` 勾稽（`GAP-08`）、公文 `<w:tbl>` `.docx` 批量导出与检索/待办接入（`GAP-10`）、多部门结构化会签与包干池总额控制（`GAP-14`）、`1:N` 招采台账与 52 条监管预警体系（`GAP-15`）以及诉讼仲裁 17 列官方台账导出与合同全筛联动（`GAP-19`）。

## 1. 事实与数据（V74 只追加迁移）

在 `V73` 基线上只追加 `V74`，已发布及前置 `V1`～`V73` 迁移字节保持零改动；涉及既有表约束或列重建时统一设置 `rebuild: true`，在 `PRAGMA foreign_keys = OFF` 单事务内完成并通过 `PRAGMA foreign_key_check`，完整保留既有列、索引与不可变/单调触发器。

1. **综合计划与预算合一下达及修订表簇（4 张新表）**：
   - `plan_issuance_cycle`：记录年度 `year`、唯一周期编码 `cycle_code`、下达阶段 `issuance_stage`（`pre_arrangement | formal_draft | official | adjusted`）、关联计划批次 `source_plan_batch_id`、关联经营预算版本 `source_budget_version_id`、决策纪要元数据 `decision_doc_meta`、发布冻结快照 `frozen_snapshot_json` 与哈希 `snapshot_sha256`、状态 `status`（`draft | published | superseded | archived`）及乐观锁 `version`；
   - `plan_issuance_unit_pack`：按 `(cycle_id, unit_org_id)` 唯一拆分各一级下达单元包（标准结构覆盖 8 个下达单元、合计 49 张逻辑附表，向非总部的 7 家基层经营单元绑定经营管理目标责任书），记录发文字号 `doc_no`、成文日期 `issued_date`、附表数 `attachment_count`、责任书标志 `has_responsibility_letter` 与编号 `responsibility_letter_no`、关联预算版本 `budget_version_id`、签收状态 `sign_off_status`（`draft | issued | acknowledged | adjust_requested`）、签收人/时间/备注与乐观锁 `version`；
   - `plan_adjustment`：记录年中调整与计划外立项申请，支持 6 类 `adjust_type`（`within_total_realloc | overall_target_change | unplanned_hq_or_station | unplanned_subsidiary_within_cap | unplanned_subsidiary_over_cap | emergency_retroactive`）及由服务端强制派生的 5 类法定审定机构 `approval_body`（`gm_office | board_of_directors | joint_review_company | subsidiary_self_decision | company_approval`），含决策文号 `decision_doc_no`、决策附件 `decision_attachment_id`、应急开工日期 `emergency_start_date`、审批后生成的新周期 `new_cycle_id`、异人复核与例外自审审计字段；
   - `plan_adjustment_line`：支持多量纲调整行，字段含 `plan_item_id`、`stable_item_uid`、`target_sheet_code`、`target_item_name`、`value_type`（`amount_cents | scaled_int | rate_bp | text`）、`scale`、`unit`、`before_val`、`after_val`、`delta_val`、`before_cents`、`after_cents`、`delta_cents`、`budget_account_id` 与说明。
2. **标准冻结报表类型扩展（`std_report` 重建）**：
   - `report_type` 新增 `'plan_issuance_summary'`（年度综合计划与预算下达汇总表），完整保留 `trg_std_report_d`、`trg_std_report_frozen_u`、`trg_std_report_review_once` 三项冻结与单次复核触发器。
3. **多部门结构化会签表（`ct_countersign`）**：
   - 字段涵盖 `contract_id`、会签轮次 `round_no`、发起时合同核心要素与主合同正文 SHA-256 指纹 `doc_fingerprint`、职能部门编码 `dept_code`（`ANJI | JIANGUAN | DIAOXIN | QIGUAN | CAIWU | JIESUAN | JISHEN`）与名称 `dept_name`、触发规则依据 `trigger_reason`、受权指派人 `assigned_reviewer_user_id`、实际审查人 `reviewer_user_id`/`reviewer_name`、应反馈日期 `due_date`、状态 `status`（`pending | approved | returned | waived | superseded`）、意见 `opinion` 及决定时间 `decided_at`，唯一约束 `(contract_id, round_no, dept_code)`。
4. **招采评委明细、月报 OA 报送日志与配套扩展**：
   - 新建 `ct_procurement_reviewer`：挂接 `V73` 已前置的 `ct_procurement_record(id) ON DELETE CASCADE`，存储 `reviewer_name`、`identity`（`owner | staff | external`）、`title_level`、`mid_title_years`、`has_reg_qualification`、`is_qualified`；
   - 新建 `ct_monthly_report_log`：按 `(org_id, report_month)` 唯一记录月度 5 表下载导出时间 `exported_at`、正式 OA 报送时间 `submitted_at`、OA 流程回执号 `oa_ref_no`、回执附件 `receipt_attachment_id` 及提交人；仅下载导出不视为已完成 OA 报送；
   - `ct_change` 新增不利变更/索赔发生日期 `adverse_occurred_at` 与异常书面报告日期 `adverse_reported_at`（注：`md_supplier.is_in_pool` 与 `pooled_at` 已在 `V73` 建妥，不重复追加）；
   - `ct_document` 重建补充草稿撤回审计列（`withdrawn_at`、`withdrawn_by_user_id`、`withdraw_reason`），更新 `trg_ct_document_u` 仅放行未被引用的草稿文档执行一次性逻辑撤回标记，严禁篡改任何已上传实质元数据或物理删除记录；
   - 前置 `ex_claim` 采购比价最小列：`contract_id`、`is_procurement_expense`、`price_compare_doc_count`，支撑 P1 阶段小额发票报账比价与拆单规则真实联测；
   - 幂等补齐 `ai_feature_binding` 的 `'contract_legal_review'` 默认通道绑定（当存在可用 `ai_channel` 且未绑定时自动关联）。
5. **52 条监管与内控预警规则底座（`risk_rule` 与 `risk_event` 重建扩展）**：
   - `risk_rule` 新增 `rule_scope`（`supervision_net_33 | internal_control_18 | domain_general`）、制度条目编码 `policy_ref_code`（如 `PW-01`～`PW-20`、`CW-01`～`CW-32`）与制度生效起始日 `effective_from`；
   - `risk_event` 新增证据判定状态 `evidence_status`（`confirmed_hit | insufficient_evidence | suspected_clue`），完整重建并保留 `trg_ct_risk_insert/update/delete` 触发器。

## 2. 金额契约、四层数值语义与跨模块勾稽

所有金额在存储与计算层严格使用整数分（`bigint`），严禁 `Number` 浮点参与金融运算；读取潜在超 `2^53` 聚合列统一启用 `.safeIntegers(true)`。

1. **计划与预算四层数值语义**：
   - `raw_source`：源工作簿只读提取的原始缓存值、公式字符串与原表量纲；
   - `exact_calc_cents`：系统 `bigint` 精确计算值，同表层级叶行汇总要求 **`0n` 误差**；
   - `approved_issued_cents`：正式下达通知或目标责任书批复执行分值；新建编制（`strict_compile`）由 `exact_calc_cents` 按声明的 `rounding_rule` 确定性派生，历史复盘（`legacy_reconcile`）保留源批复值并以 `diff_reason_code`（如 `ROUND_WAN_2DEC`、`SOURCE_FLOAT_CACHE_1C`）显式归因；
   - `display_value`：按场景输出两位小数元（`0.01元 = 1n`）或公文两位小数万元（**显示步长 `0.01万元 = 100.00元 = 10000n`，单次 `ROUND_HALF_UP` 半步长最大偏差上界 `≤ 5000n` 即 `50.00元`**）。
2. **多级组织归并、隔离调节项与跨单位承办恒等式**：
   - 二/三级子组织按 `org.plan_issuance_root_id` 自动汇总至 8 个一级下达单元（`unit_org_id`），明细行同时保留实际承办主体 `undertake_org_id`，支持「按归口下达单元」与「按实际承办主体」双视角切换；
   - `org.is_plan_excluded = 1` 的合并报表主体不生成 `plan_issuance_unit_pack` 下达通知，但在周期合并试算 `groupConsolidated` 中作为显式调节项校验：`8 单元精确汇总 + 排除下达主体汇总 == 集团合并总表`（允许跨单元各自 `ROUND_HALF_UP` 到分产生的 `≤ 1n` 次分位舍入差并显式提示）；
   - 公式稽核器扫描源表单元格公式，当明细或汇总公式跨表/跨列引用非本归口单元所属列时，抛出阻断性告警 `CROSS_UNIT_CELL_REF`。
3. **含税计划 ↔ 不含税预算（`÷ 1.06`）与五项费用嵌套稽核**：
   - 含税运维计划转入不含税成本预算统一采用 `roundHalfUpDiv(amountCents * 10000n, 10000n + vatRateBp)`（默认 6% 增值税即 `roundHalfUpDiv(amountCents * 100n, 106n)`，支持配置 6%/9%/13%），扣除核定调整项后单笔允差 **`≤ 1n`（`0.01元`）**；
   - 管理费用表强制检验刚性嵌套恒等式 `管理费用合计(R17) === 人工成本(R18) + 五项费用(R19) + 可控其他管理费(R20) + 税费折旧等非可控项(R21)`（新建编制 `0n` 误差，历史复盘对源表 1 分缓存差标记 `SOURCE_FLOAT_CACHE_1C`），并核验经营管理目标责任书指标 `可控管理费 === R19 + R20` 在 `10000n`（`0.01万元`）步长下的 `ROUND_HALF_UP` 一致性（偏差 `≤ 5000n`）。

## 3. 状态、制度规则与事务门禁

1. **计划下达冻结、签收与 6 类分级调整**：
   - `publishIssuanceCycle` 前置运行合并与税率/五项费用稽核，存在未解释失衡或 `CROSS_UNIT_CELL_REF` 时拒绝发布；通过后将源批次哈希、组织归并快照、税率与舍入规则固化进 `frozen_snapshot_json` + `snapshot_sha256`，将单元包置 `'issued'` 并生成待办；
   - `acknowledge` 校验操作人 `OrgScope` 与 `expectedVersion`（冲突返回 `409 VERSION_CONFLICT`），置 `'acknowledged'`；
   - 6 类调整申请由服务端强制派生 5 类 `approval_body`（禁止客户端降级）：
     - `within_total_realloc` → `gm_office`（不突破总体核心指标，必填决策纪要文号）；
     - `overall_target_change` → `board_of_directors`（必填决议文号与决策附件）；
     - `unplanned_hq_or_station` → `joint_review_company`（本部部门 `hq_dept` 或直属水电站 `is_direct_station = 1` 强制归入）；
     - `unplanned_subsidiary_within_cap` → `subsidiary_self_decision`（非直属电站分子公司且未超年度专项控制上限）；
     - `unplanned_subsidiary_over_cap` → `company_approval`（分子公司超专项控制上限；若突破集团总体指标则自动升格 `board_of_directors`）；
     - `emergency_retroactive` → 按承办组织类型与是否超限自动派生上述对应审批机构，必填 `emergency_start_date`，自开工逾 **5 个工作日**未补立项双向标红预警；
   - 调整复核强制 `submitted_by_user_id !== reviewed_by_user_id`（`self_review = 1` 仅在填写 `exception_reason` 时豁免异人校验，绝不豁免 `decision_doc_no` / `decision_attachment_id`）；批准后在单事务内生成新修订周期（原周期置 `'superseded'`）、新计划批次与修订预算版本，严禁原地覆写已签收包。
2. **结构化多部门会签与包干池总额控制（`GAP-14`）**：
   - 服务端按合同类别、标的属性、金额与预算类型自动派生应会签职能部门并计算 `doc_fingerprint`；会签决定接口除校验 `contract:review` 外，强制校验操作人隶属对应会签部门组织或等于 `assigned_reviewer_user_id`；
   - 当合同金额、付款条款、相对方或主合同正文 `file_sha256` 发生实质变更致 `doc_fingerprint` 改变时，当前轮记录自动置 `'superseded'` 并开启 `round_no + 1` 新轮次；阶段推进门禁校验最新轮次必填部门全数 `'approved' | 'waived'`；会签时限由 `contract.countersign_due_days` 控制（默认 `0` 置 `due_date = NULL`，`> 0` 推算截止日并追踪超期）；
   - `budget_type = 'lump_sum_pool'` 跨同组织同包干科目全部非作废合同聚合年度占用额，突破年度包干总池时抛 `409 BUDGET_POOL_EXCEEDED`；跨年度基建/框架合同分别校验「合同总价 vs 项目总概算」与「本年度计划分配额 vs 当年综合计划批复额」。
3. **`1:N` 招采台账与 52 条监管预警体系（`GAP-15`）**：
   - 单一招采项目可挂接多份合同（`1:N`）；服务端权威重算 `procurement_tier`（公开/邀请招标项目一律提级为 `tier_1`）、`committee_size` 与 `committee_qualified_count`；严格分流 `direct`（校验 8 种法定直接采购情形，情形 6 须附经营层决策文号）与 `direct_reimburse`（`≤ 30,000.00元` 发票报账，隐藏直接采购情形，校验书面市场比价报告与同类高频拆单）；修改多合同共享招采记录须校验操作人对全部关联合同具备编辑范围权限，实质变更自动重评关联合同法审与会签状态；
   - 完整落地采购 `PW-01`～`PW-20`（20 条）与合同 `CW-01`～`CW-32`（32 条）共 **52 条制度预警映射**（其中 `CW-03` 全半角重复并入 `CW-01` 同一规则，`CW-02` 与 `PW-01` 共享同一计算器；`rule_scope` 清晰划分协同监督净版 33 条与内部扩展内控 18 条）；
   - 制度溯及边界：对新规生效日（`2026-06-25`）前签订或 `origin = 'legacy_migration'` 且缺失新规过程留痕的历史合同，检测器输出 `evidence_status = 'insufficient_evidence'`（证据待补核），不误判为现行违规；连续 30 日单笔 `< 30,000.00元` 且同类累计 `>= 30,000.00元` 输出 `suspected_clue`（疑似拆单线索）；`CW-28` 必须核验 `ct_monthly_report_log.submitted_at IS NOT NULL AND oa_ref_no <> ''`；`CW-31`/`CW-32` 严格按 `org.is_direct_station`（`1` vs `0`）分流并排除集团内部交易合同（`is_internal_group_tx = 1`）。
4. **AI 通道诊断与受限文档解析（`GAP-04`）**：
   - `listBindings` 恒返全部 8 项 `AI_FEATURES`（含 `contract_legal_review`），支持多样本探活与近期调用 P50/P95 延迟、超时率及主备故障转移诊断；
   - 本机按需 `/parse-pdf` 适配器仅监听回环地址且不在写事务内运行，返回分页文本与版面块坐标并缓存至 `ct_doc_parse_cache`，未启用时平滑回退本地提取或人工复核。

## 4. 接口、导出与权限契约

| 领域 | 路由与方法 | 权限与组织范围 | 关键契约说明 |
|---|---|---|---|
| 计划合一下达 | `GET/POST /api/plan/issuance/cycles`、`GET /api/plan/issuance/cycles/:id`、`POST .../reconcile`、`POST .../publish`、`GET .../export-zip` | 查看 `plan:read`；创建/发布/全包导出 `plan:write` 或 `plan:read` + `allOrgs` | 创建 8 单元拆包、运行合并与 `/1.06` 及五项费用稽核、冻结快照发布、一键打包 `.docx` 通知/附表/责任书 + `.xlsx` 底稿 |
| 分单位签收与导出 | `GET /api/plan/issuance/packs`、`GET /api/plan/issuance/packs/:id`、`POST .../acknowledge`、`GET .../export-docx` | `plan:read` / `plan:write` + `OrgScope` | 受限用户仅见授权组织包（越权返回 `404`）；签收传 `expectedVersion`；公文 `.docx` 生成规范 `<w:tbl>` 跨页重复表头表格 |
| 计划年中调整 | `GET/POST /api/plan/issuance/adjustments`、`POST /api/plan/issuance/adjustments/:id/review` | 申报 `plan:write` + `OrgScope`；复核 `plan:write` + `allOrgs` | 服务端强制计算 `approvalBody`；批准后单事务派生新周期与修订预算版本 |
| 本单位预算只读视图 | `GET /api/versions/:id/summary`、`GET /api/versions/:id/unit-view` | `budget:read` + `OrgScope` | 放行非 `allOrgs` 用户读取授权组织预算摘要与明细，保持版本锁定/切换/建版 `allOrgs: true` |
| 检索/报表/待办 | `GET /api/search?types=plan_item`、`POST /api/standard-reports` (`plan_issuance_summary`)、`GET /api/dashboard/todos` | `plan:read` / `report:read` + `OrgScope` | 全局搜索深链定位 `/plan?batchId=...&itemId=...`；工作台统计 `plan_issuance_ack` 与 `plan_adjustment_review` |
| 多部门会签 | `GET /api/contracts/:id/countersigns`、`POST /api/contracts/:id/countersigns/:cid/decide` | 查看 `contract:read`；决定 `contract:review` + 部门/指派人校验 | 返回轮次与指纹状态；他部门人员禁止越权代签 |
| 1:N 招采与月报登记 | `GET/POST /api/procurement-records`、`GET/PUT /api/procurement-records/:pid`、`GET/PUT /api/contracts/:id/procurement`、`POST /api/contracts/monthly-report-log` | `contract:read` / `contract:write` + `OrgScope`（共享修改需全关联范围权限） | 服务端重算等级与合格评委数，脱敏超范围关联合同；登记 OA 报送单号消除 `CW-28` |
| 纠纷 17 列与台账增强 | `GET /api/contracts/disputes/export`、`GET /api/contracts/page`、`GET /api/contracts/summary`、`POST /api/contracts/:id/documents/:docId/withdraw` | `contract:read` / `contract:write` + `OrgScope` | 导出标准 17 列纠纷 `.xlsx`：序号、诉讼类型、案由、相对方及其诉讼地位、程序阶段、受理机构、案号、涉诉单位、诉讼地位、受理时间、案情简介、法律文书形式、结案时间、诉讼金额、裁判结果、单位实际获得或支付的金额、备注（代理律所及承办律师）；列表与 `summary` 全筛选同步、白名单排序、按币种独立汇总（禁跨币种直接相加）、未引用草稿附件受控撤回 |

## 5. 页面与助手

- **AI 设置页（`SettingsAi`）**：完整渲染 8 项 `AI_FEATURES`，对未绑定主渠道的功能显示告警标签与一键绑定保存控件；展示多样本探活及近期调用 P50/P95 延迟、超时率与主备切换诊断。
- **综合计划与预算合一下达工作台（`PlanExecution` / `BudgetVersions` / `StandardReports` / `Search` / `Dashboard`）**：`PlanExecution` 升级为四页签（下达周期与合一下达、本单位下达包与签收、计划调整与计划外审批、月度执行与 16 表台账），支持归口单元/实际承办双视角、合并与 `/1.06` 及五项费用稽核阻断面板、`.docx`/`.zip` 导出及 URL 深链高亮；`BudgetVersions` 允许下属单位只读查看授权预算并隐藏全域写按钮；`StandardReports`、`Search` 与工作台待办/域概览全面接入计划域。
- **合同全生命周期增强（`Contracts` / `ContractBaseFormModal` / `ContractCountersignTab` / `ContractProcurementTab` / `ContractSafeguardTab` / `ContractChangeTab` / `ContractExportModal` / `MasterEntities` / `RiskLedger`）**：补齐合同表单 `planItemId`、本年计划分配额、包干池实时余额预警、`parentContractId`、`creditChecked`、`responseDocsComplete` 等全量字段；新增「多部门会签」与「招采过程（1:N）」详情页签；`RiskLedger` 支持按 `ruleScope`（净版 33 条 / 扩展内控 18 条 / 全部）与 `evidenceStatus`（确认违规 / 证据待补核 / 疑似拆单线索）过滤；纠纷台账提供日常紧凑展开视图与完整 17 列切换、4 类标准下拉选择、200 字案情简介计数及 17 列 `.xlsx` 导出；合同主列表实现全筛选与 KPI `summary` 严格联动、白名单列排序、分币种汇总行以及关联补充协议上传与草稿文档撤回。
- AI 助手在 P1 保持同源只读查询与诊断，不直接执行签收、审批、会签或正式入库。

## 6. 样本与完成条件（`AC-T14-01` ～ `AC-T14-08`）

| 验收 ID | 对应任务 | 可观察通过条件 |
|---|---|---|
| `AC-T14-01` | `GAP-04` | `V74` 幂等补齐且 `listBindings` 恒返全部 8 项功能含 `contract_legal_review`；支持通道多样本 P50/P95 延迟诊断与主备故障转移；受限 `/parse-pdf` 与 `.doc` 解析在写事务外输出结构化段落/块并命中 `ct_doc_parse_cache` |
| `AC-T14-02` | `GAP-06` | `V72 -> V73 -> V74` 空库与非空库平滑升级并通过外键与完整性检查；完成「周期创建 → 8 单元拆包 → 冻结快照发布 → 受限单位签收（乐观锁防并发、跨单位越权 `404`）→ 6 类调整服务端派生 5 类 `approval_body`、异人复核并生成新周期与修订预算版本」全链路闭环，下属单位可只读查看本单位预算且零全域写按钮暴露 |
| `AC-T14-03` | `GAP-07` | 二/三级组织按 `plan_issuance_root_id` 自动归并至一级下达单元并保留 `undertake_org_id` 双视角；`is_plan_excluded = 1` 主体不生成下达包但精确闭合集团合并汇总（到分）；源表跨单位公式错引被 `CROSS_UNIT_CELL_REF` 100% 阻断检出 |
| `AC-T14-04` | `GAP-08` | 四层数值语义落盘清晰；含税运维转不含税成本 `÷ 1.06` 全程 `bigint` 定点计算（允差 `≤ 1n`）；管理费 `R17 = R18 + R19 + R20 + R21` 与责任书可控管理费 `R19 + R20` 按 `0.01万元 = 10000n` 步长（半步长 `≤ 5000n`）校验准确，失衡周期禁止发布 |
| `AC-T14-05` | `GAP-10` | `renderDocx` 生成含合规 `<w:tbl>` 跨页表头且确定性可复现的公文 `.docx` 及全集团 `.zip` 包（8 份通知 + 49 附表 + 7 份责任书 + `.xlsx` 底稿），不破坏既有段落提取；标准报表 `plan_issuance_summary`、全局检索 `plan_item` 与首页待办按 `OrgScope` 穿透准确 |
| `AC-T14-06` | `GAP-14` | `ct_countersign` 自动派生应会签职能部门、按配置推算 `due_date`、禁止非本部门/非受权指派人越权代签，合同核心要素或正文指纹变更后自动置旧轮次 `superseded` 并开启新轮次；`lump_sum_pool` 跨合同超池返回 `409 BUDGET_POOL_EXCEEDED`；新建/编辑表单补齐字段全量持久化 |
| `AC-T14-07` | `GAP-15` | `1:N` 招采记录与评委子表结构化落库，服务端强制重算招标提级 `tier_1` 与合格评委数，严格分流 `direct` 与 `direct_reimburse`，跨合同共享修改强制校验全关联范围权限；52 条制度预警规则（含合并复用、`rule_scope`、历史合同 `'insufficient_evidence'` 边界、月报 OA 正式报送日志校验与直属电站/分子公司分流）全部就绪并零异常扫描 |
| `AC-T14-08` | `GAP-19` | 纠纷台账支持紧凑展开与完整 17 列切换、4 类下拉字典、200 字提示及标准 17 列 `.xlsx` 导出；合同列表与 `summary` 全量筛选严格同步、排序白名单防注入、按币种独立汇总不跨币种误加，未引用草稿附件支持受审计撤回而引用证据保持不可变 |
