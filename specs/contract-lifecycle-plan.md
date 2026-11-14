# 合同模块全生命周期与监督报送开发详细计划（T-10 ～ T-12）

状态：2026-11-13 编制，原开发基线为生产 schema **V67**。T-10～T-12 曾发布至V70；独立复核后的修复追加V72并已发布生产，现行规则见[生命周期规范第7节](contract-lifecycle.md#7-2026-11-13-复核修复执行细则)，实际验证与发布证据见[修复记录](../docs/contract-lifecycle-repair-2026-11-13.md)。

- **业务规则与验收唯一来源**：[合同模块全生命周期与监督报送完善设计](contract-lifecycle.md)（`AC-CLM-01`～`AC-CLM-14`）与 [智能合同法审一期设计](contract-legal-review.md)（`AC-CLR-01`～`AC-CLR-10`）。
- **受控参考原件位置**：服务器 `/root/newfc/docs/private/contract-lifecycle/` 与 `/root/newfc/docs/private/contract-legal-review/`（索引见 `docs/private/contract-lifecycle/00_参考资料总索引与字段映射说明.md`，受 `.gitignore` 保护，运行时不直接读取）。

---

## 0. VIPCLOUD 新窗口启动指引与硬性工程护栏

在 `VIPCLOUD`（`/root/newfc`）新开开发会话时，可直接发送以下指令启动：

> 请先阅读 `AGENTS.md`、`specs/contract-lifecycle.md`、`specs/contract-lifecycle-plan.md` 及 `docs/private/contract-lifecycle/00_参考资料总索引与字段映射说明.md`。基于当前 V67 基线，按 `T-10.1` → `T-10.5` → `T-11.1` → `T-11.5` → `T-12.1` → `T-12.5` 顺序小步开发，每完成一棒运行源码类型检查与聚焦测试并汇报。

**全程硬性工程护栏（违反任一条即阻断合并）**：

1. **Node 运行时**：先执行 `export PATH=/root/.nvm/versions/node/v24.22.1/bin:$PATH` 并确认 `node -v` 为 `v24.22.1`；严禁使用 `/usr/bin/node`（v20，会导致 `better-sqlite3` ABI 不匹配）。
2. **环境与服务隔离**：严禁读写 `/root/newbd`、`/data/newbd`、端口 `3748` 或 `newbd-budget.service`；测试一律使用 `:memory:` 或 `/tmp/newfc-test-*` 临时目录，严禁触碰 `/data/newfc-data/newfc.sqlite`。
3. **定点金融精度**：所有合同总价、估算上限、结算分项、扣款项、收付款、保函金额、涉诉金额均以 `bigint` 整数分存储，接口统一使用 `MoneyString`（`centsToDecimalString` / `parseDecimalToCents`）；比例统一使用 `RATIO_SCALE = 1_000_000n` 缩放 `bigint`；所有可能超过 `2^53` 的金额列查询必须调用 `.safeIntegers(true)`，严禁 `Number()` 浮点运算。
4. **迁移与表重建安全**：严禁修改 V1～V67 既有迁移。扩展 `ct_contract`、`ct_change`、`ct_payment`、`ct_document` 等带表级 `CHECK` 约束的表时，必须使用 `Migration.rebuild = true` 整表原子重建模式（迁移框架自动包裹 `PRAGMA foreign_keys = OFF` → 单事务重建与数据拷入 → 重建索引与触发器 → `foreign_key_check` → 写入 `schema_migration`）。
5. **T-9 法审快照隔离**：`legalSnapshot`（`backend/src/modules/contracts/legal-context.ts`）仅对签约前正文、核心签约属性（含 `direction`、`pricingMode`、`unitPriceDesc`）及签约前有效 `evidence_kind` 求哈希，不得把签署分发、结算、收付款、变更、保函、质保或纠纷字段纳入指纹。
6. **前后端契约隔离与无新增重依赖**：前端新组件仅 `import type` 后端契约，运行期下拉选项与 `bigint` 预览统一放在 `frontend/src/pages/project/contractOptions.ts`（保持 Vite 产物不打入新增后端 Zod 模块）；Excel 与 ZIP 生成直接复用已锁定的 `exceljs` 与 `jszip`，不引入新二进制包。
7. **短事务与内存边界**：Excel 解析、Workbook 构建、文件读取与 ZIP 压缩全部在 SQLite 写事务外完成，单次 ZIP 打包做总字节上限守卫（默认 ≤200 MiB，超限提示按组织/期间分批导出），保障峰值 RSS ≤ 512 MiB（`OPEN-04`）。

---

## 1. 分期交付路线图与代码结构设计

整个合同模块完善拆分为 **三个递进工程阶段（T-10、T-11、T-12）+ 一条业务核定并行线（T-9 收尾）**：

| 阶段 | Schema | 核心目标 | 关联验收 ID |
|---|---|---|---|
| **T-10：八阶段状态机、全口径底座与双向收付结算** | `V68` | 8 阶段状态机 + `suspended` + 正交分发/归档状态；收支方向、单价合同、20 币种、以收定支关联；多相对方、承办人交接、非法定代表人授权门禁、决策/采购时间链与 OA 审签摘录；`ct_settlement` 结算单（含三类扣款）+ `ct_payment` 50 万/500 万分级门禁 + `ct_receipt` 收入收款闭环；单价合同法审兼容 | `AC-CLM-01`～`AC-CLM-07` |
| **T-11：变更索赔四位一体、担保保险、质保验收与纠纷闭环** | `V69` | `ct_change` 支持 0 金额变更、附件 5 四档+500万/10%自动定级、反索赔与技术审查 10 日跟踪、补充协议唯一号与禁规避采购校验；中止/恢复/解除及担保方书面同意门禁；`ct_guarantee` 保函保险台账、`ct_warranty` 质保期签证释放质保金、`ct_dispute` 17 列诉讼仲裁台账与双备案 | `AC-CLM-08`～`AC-CLM-10` |
| **T-12：多源导入、内外部标准报送包、量化预警与 OA 监督接口** | `V70` | 多模板导入（含逐笔真实收付款历史基线）；公司每月 28 日 5 表月报导出；纪巡财审报送预检 + 6 张官方 Excel + 4 类分级附件目录树 ZIP 导出；10 组新增合同量化风险规则；OA 门户只读全量/增量接口；履约后评价与小澧助手只读工具扩展 | `AC-CLM-11`～`AC-CLM-14` |
| **T-9 收尾（业务并行，不阻塞 T-10～T-12）** | 无新表 | 导出候选范本默认参数核定清单供企管/财务/法务签认，通过 `promote` 转正；补充 5～10 份配对历史法审样本完成 `AC-CLR-09`；按需填入独立 PDF 解析服务地址做线上联调 | `AC-CLR-09` |

### 代码模块化拆分（避免单文件膨胀）

`backend/src/modules/contracts/` 按职责拆分为高内聚子模块：

- `contract.service.ts`：主合同 CRUD、8 阶段 `computeBlockers`、推进/中止/恢复/终止/作废/重开、正交分发与归档状态更新、承办人交接。
- `contract-settlement.service.ts`（新增）：`ct_settlement` 进度/竣工结算单勾稽、`ct_payment` 分级付款校验与支付、`ct_receipt` 收入开票与收款登记。
- `contract-change.service.ts`（新增）：附件 5 分级审批纯函数 `computeChangeApprovalTier`、0 金额与增减变更提交/复核、中止/解除联动、担保方同意书校验。
- `contract-safeguard.service.ts`（新增）：`ct_guarantee` 保函/保证金/保险、`ct_warranty` 质保期与签证释放、`ct_dispute` 纠纷与诉讼仲裁、`ct_evaluation` 履约后评价。
- `contract-import.service.ts`（扩展）：标准台账、公司万元月报、纪巡财审多表（主表 + 实际收付明细 + 变更纠纷）识别、预览与事务确认。
- `contract-export.service.ts`（新增）：① 公司内部 5 表月报 Excel 生成器；② 纪巡财审预检器（`preflightSupervisionExport`）+ 6 表官方模板写入器 + 附件目录树 ZIP 打包器；③ OA 监督门户全量/增量只读查询服务。
- `legal-context.ts` / `legal-rules.ts`（微调）：兼容 `pricing_mode = 'unit_price'` 与直属电站收入合同主体校验，锁死快照边界。

前端 `frontend/src/pages/project/` 按详情页签拆分：

- `Contracts.tsx`：列表筛选、汇总指标卡、阶段进度条与详情抽屉/页签容器。
- `contractOptions.ts`（由 `contractLegalOptions.ts` 扩展并保留兼容重导出）：全部纯前端枚举字典、20 种币种、变更分级与采购层级 `bigint` 实时预览函数。
- `ContractBaseFormModal.tsx`：分步/分组表单（基本与立项来源、多方主体与签署授权、决策与采购过程、履约期限与质保约定）。
- `ContractSettlementTab.tsx`：结算单（一应结 / 二应扣 / 三净付）、付款分级登记、收入合同收款面板。
- `ContractChangeTab.tsx`：变更/索赔/中止/解除登记、附件 5 定级提示、补充协议号与技术审查/纪审备案状态。
- `ContractSafeguardTab.tsx`：保函保险、质保验收签证、法律纠纷与履约后评价面板。
- `ContractExportModal.tsx`：每月 28 日 5 表月报导出、纪巡财审报送预检清单与一键导出 ZIP 包弹窗。

---

## 2. 数据库追加迁移详细设计（V68 ～ V70）

### 2.1 V68：`contract_lifecycle_foundation`（`rebuild: true`）

1. **重建 `ct_contract`**（移除“单价合同阻塞 `original_cents = 0`”与“仅限支出付款”假设，扩展状态枚举与监督底座列）：
   - 修改 `stage` CHECK：`('initiation','procurement','drafting','approval','performance','settlement','warranty','closed')`；存量 `'archived'` 迁移映射为 `'closed'`。
   - 修改 `status` CHECK：`('active','suspended','closed','terminated','voided')`。
   - 修改表级金额 CHECK：
     - `CHECK (original_cents >= 0 AND settled_gross_cents >= 0 AND settled_net_cents >= 0 AND paid_cents >= 0 AND received_cents >= 0)`
     - 总价合同保持 `CHECK (pricing_mode = 'unit_price' OR (original_cents + approved_change_cents >= 0 AND paid_cents <= original_cents + approved_change_cents AND received_cents <= original_cents + approved_change_cents))`；单价合同满足 `CHECK (pricing_mode <> 'unit_price' OR (estimated_ceiling_cents IS NULL OR (paid_cents <= estimated_ceiling_cents AND received_cents <= estimated_ceiling_cents)))`。
   - 新增核心列（均带安全默认值以兼容存量行与快速导入）：
     - 方向与计价：`direction TEXT NOT NULL DEFAULT 'expense' CHECK (direction IN ('expense','income'))`、`pricing_mode TEXT NOT NULL DEFAULT 'lump_sum' CHECK (pricing_mode IN ('lump_sum','unit_price'))`、`unit_price_desc TEXT NOT NULL DEFAULT ''`、`estimated_ceiling_cents INTEGER CHECK (estimated_ceiling_cents IS NULL OR estimated_ceiling_cents >= 0)`、`currency TEXT NOT NULL DEFAULT '人民币'`、`report_category TEXT NOT NULL DEFAULT 'other' CHECK (report_category IN ('engineering','goods','service','other'))`、`summary_text TEXT NOT NULL DEFAULT ''`、`remark TEXT NOT NULL DEFAULT ''`。
     - 立项与资金来源：`plan_item_id INTEGER REFERENCES plan_item(id)`、`budget_type TEXT NOT NULL DEFAULT 'single_listed' CHECK (budget_type IN ('single_listed','lump_sum_pool','emergency_unplanned'))`、`is_emergency INTEGER NOT NULL DEFAULT 0 CHECK (is_emergency IN (0,1))`、`emergency_start_date TEXT`、`funding_source TEXT NOT NULL DEFAULT 'self_owned_other' CHECK (funding_source IN ('fiscal','income_contract','self_owned_other'))`、`funding_source_detail TEXT NOT NULL DEFAULT ''`、`source_income_contract_id INTEGER REFERENCES ct_contract(id)`、`parent_contract_id INTEGER REFERENCES ct_contract(id)`、`external_no_exempt INTEGER NOT NULL DEFAULT 0 CHECK (external_no_exempt IN (0,1))`。
     - 相对方、承办人与授权：`counterparty_names TEXT NOT NULL DEFAULT ''`、`undertaker_name TEXT NOT NULL DEFAULT ''`、`undertaker_dept TEXT NOT NULL DEFAULT ''`、`our_signatory_name TEXT NOT NULL DEFAULT ''`、`our_signatory_title TEXT NOT NULL DEFAULT ''`、`our_signatory_is_legal_rep INTEGER CHECK (our_signatory_is_legal_rep IN (0,1))`、`counterparty_signatory_is_legal_rep INTEGER CHECK (counterparty_signatory_is_legal_rep IN (0,1))`。
     - 决策、采购过程与收入取得：`entrust_reason TEXT NOT NULL DEFAULT ''`、`is_triple_major INTEGER NOT NULL DEFAULT 0 CHECK (is_triple_major IN (0,1))`、`decision_method TEXT CHECK (decision_method IS NULL OR decision_method IN ('meeting','approval','other'))`、`decision_method_other TEXT NOT NULL DEFAULT ''`、`meeting_type TEXT`、`meeting_type_other TEXT NOT NULL DEFAULT ''`、`final_approver_name TEXT NOT NULL DEFAULT ''`、`final_approver_title TEXT NOT NULL DEFAULT ''`、`is_gov_procurement INTEGER NOT NULL DEFAULT 0 CHECK (is_gov_procurement IN (0,1))`、`procurement_plan_text TEXT NOT NULL DEFAULT ''`、`procurement_start_date TEXT`、`supplier_confirm_date TEXT`、`response_docs_complete INTEGER CHECK (response_docs_complete IN (0,1))`、`credit_checked INTEGER CHECK (credit_checked IN (0,1))`、`bid_award_cents INTEGER`、`acquisition_method TEXT CHECK (acquisition_method IS NULL OR acquisition_method IN ('tender','negotiation','other'))`、`acquisition_method_other TEXT NOT NULL DEFAULT ''`、`tender_body_type TEXT CHECK (tender_body_type IS NULL OR tender_body_type IN ('consortium','single'))`、`consortium_members TEXT NOT NULL DEFAULT ''`。
     - 外部审签摘录与专户：`dept_reviewer_name TEXT NOT NULL DEFAULT ''`、`related_mgmt_depts TEXT NOT NULL DEFAULT ''`、`related_mgmt_reviewers TEXT NOT NULL DEFAULT ''`、`unit_approver_name TEXT NOT NULL DEFAULT ''`、`unit_approver_title TEXT NOT NULL DEFAULT ''`、`farmer_wage_account TEXT NOT NULL DEFAULT ''`。
     - 期限、质保、正交状态与派生累计：`term_type TEXT NOT NULL DEFAULT 'unspecified' CHECK (term_type IN ('fixed','conditional','unspecified'))`、`term_start_date TEXT`、`term_end_date TEXT`、`term_condition_text TEXT NOT NULL DEFAULT ''`、`deliverable_submitted INTEGER CHECK (deliverable_submitted IN (0,1))`、`final_accepted INTEGER NOT NULL DEFAULT 0 CHECK (final_accepted IN (0,1))`、`has_warranty INTEGER NOT NULL DEFAULT 0 CHECK (has_warranty IN (0,1))`、`warranty_months INTEGER`、`warranty_retention_ratio_scaled INTEGER`、`settled_gross_cents INTEGER NOT NULL DEFAULT 0`、`settled_net_cents INTEGER NOT NULL DEFAULT 0`、`received_cents INTEGER NOT NULL DEFAULT 0`、`distribution_status TEXT NOT NULL DEFAULT 'pending' CHECK (distribution_status IN ('pending','completed'))`、`distributed_at TEXT`、`company_filed_at TEXT`、`archive_status TEXT NOT NULL DEFAULT 'collecting' CHECK (archive_status IN ('collecting','checked','transferred'))`、`archive_checked_at TEXT`、`archive_transferred_at TEXT`、`archive_transfer_no TEXT`。

2. **重建 `ct_document`（扩展文档与证据枚举，保留不可变触发器）**：
   - `doc_type` 扩展：保留原 9 类，新增 `'authorization'`（签署授权书）、`'qualification'`（资信/资格审查）、`'guarantee'`（保函/保险单）、`'dispute'`（纠纷/法律文书）。
   - `evidence_kind` 扩展：保留原 11 类，新增 `'supplier_qualification'`、`'our_signatory_auth'`、`'counterparty_signatory_auth'`、`'change_decision'`、`'change_agreement'`、`'guarantor_consent'`、`'termination_agreement'`、`'warranty_release_visa'`、`'payment_approval_form'`、`'out_of_plan_approval'`。
   - 新增可选外键列 `change_id INTEGER REFERENCES ct_change(id)`（用于精确绑定某次补充协议的变更决策附件与变更协议文本，支撑纪巡财审按 `<补充协议编号>/01..02` 分槽导出）。

3. **新建 `ct_undertaker_handover`（承办人动态交接只追加表）**：
   - 字段：`id`、`contract_id`、`from_undertaker`、`to_undertaker`、`to_dept`、`reason`、`left_post_date`、`handover_date`、`actor_user_id`、`created_at`；配 `BEFORE UPDATE/DELETE` 只追加触发器。

4. **新建 `ct_settlement`（结算单表）与重建 `ct_payment` + 新建 `ct_receipt`（收入收款表）**：
   - `ct_settlement`：`id`、`contract_id`、`period_no`、`settlement_kind ('progress'|'final')`、`settlement_date`、`in_contract_cents`、`change_claim_cents`、`other_add_cents`、`gross_payable_cents`、`deduct_prepayment_cents`、`deduct_retention_cents`、`deduct_penalty_cents`、`total_deduct_cents`、`net_payable_cents`、`evidence_document_id`、`status ('submitted'|'approved'|'rejected')`、复核审计列（同 `ct_payment`），`UNIQUE(contract_id, period_no)`，配一次复核触发器与勾稽 `CHECK (gross_payable_cents = in_contract_cents + change_claim_cents + other_add_cents AND total_deduct_cents = deduct_prepayment_cents + deduct_retention_cents + deduct_penalty_cents AND net_payable_cents = gross_payable_cents - total_deduct_cents)`。
   - 重建 `ct_payment`：新增 `settlement_id INTEGER REFERENCES ct_settlement(id)`、`payment_type TEXT NOT NULL DEFAULT 'progress' CHECK (payment_type IN ('prepayment','progress','final','warranty_release','other'))`、`currency TEXT NOT NULL DEFAULT '人民币'`、`approval_tier TEXT`、`approver_name TEXT NOT NULL DEFAULT ''`、`approver_title TEXT NOT NULL DEFAULT ''`、`approval_doc_id INTEGER REFERENCES ct_document(id)`、`is_farmer_wage_transfer INTEGER NOT NULL DEFAULT 0 CHECK (is_farmer_wage_transfer IN (0,1))`；保留 `trg_ct_payment_flow`。
   - 新建 `ct_receipt`（收入合同收款）：`id`、`contract_id`、`kind ('normal'|'import_baseline')`、`settlement_id`、`node_name`、`currency`、`amount_cents CHECK (amount_cents > 0)`、`planned_date`、`invoice_document_id`、`status ('submitted'|'approved'|'rejected'|'received')`、复核审计列、`received_date`、`voucher_no`、`received_by_user_id`、`received_at`；配状态机触发器 `submitted → approved/rejected → received`。

### 2.2 V69：`contract_change_safeguard_dispute`（`rebuild: true`）

1. **重建 `ct_change`（去掉 `delta_cents <> 0` 限制，合一承载变更/索赔/中止/解除）**：
   - `change_kind TEXT NOT NULL DEFAULT 'change' CHECK (change_kind IN ('change','claim_by_contractor','counter_claim','suspend','terminate'))`
   - `delta_cents INTEGER NOT NULL DEFAULT 0`（无非零限制！）
   - `change_matter TEXT NOT NULL DEFAULT ''`、`reason TEXT NOT NULL`
   - `involves_biz_or_entity_change INTEGER NOT NULL DEFAULT 0`、`involves_tech_change INTEGER NOT NULL DEFAULT 0`、`is_independent_delegable INTEGER NOT NULL DEFAULT 0`（若为 1 服务层拦截，防规避采购）
   - `decision_method TEXT`、`meeting_type TEXT`、`final_approver_name TEXT NOT NULL DEFAULT ''`
   - `required_approval_tier TEXT NOT NULL DEFAULT 'undertaker_unit'`、`actual_approval_tier TEXT`
   - `supplement_no TEXT`、`normalized_supplement_no TEXT`（建部分唯一索引 `CREATE UNIQUE INDEX idx_ct_change_supp_no ON ct_change(org_root_id, normalized_supplement_no) WHERE normalized_supplement_no IS NOT NULL`，满足纪巡财审“同一法人单位补充协议号不重复”）
   - `has_dispute INTEGER NOT NULL DEFAULT 0 CHECK (has_dispute IN (0,1))`
   - `tech_review_applied_at TEXT`、`tech_review_replied_at TEXT`、`tech_special_audit_doc_id INTEGER REFERENCES ct_document(id)`、`out_of_plan_doc_id INTEGER REFERENCES ct_document(id)`、`guarantor_consent_doc_id INTEGER REFERENCES ct_document(id)`、`discipline_filed_at TEXT`
   - 保留 `trg_ct_change_once` 复核定论触发器（允许在已批准记录上只补录 `supplement_no`、`discipline_filed_at` 备案信息或通过专用备案事件表更新）。
2. **新建 `ct_guarantee`（保函/保证金/工程保险表）**：
   - 字段：`id`、`contract_id`、`guarantee_type ('bid_bond'|'prepayment_guarantee'|'performance_guarantee'|'warranty_guarantee'|'engineering_insurance')`、`direction ('inbound'|'outbound')`、`issuer_name`、`guarantee_no`、`amount_cents`、`deposit_cents`、`ratio_scaled`、`effective_date`、`expiry_date`、`status ('active'|'expired'|'claimed'|'returned')`、`claim_occurred_at`、`claim_reported_at`、`returned_date`、`document_id`、`note`、`created_by_user_id`、`created_at`、`updated_at`。
3. **新建 `ct_warranty`（质保记录与期满签证表）**：
   - 字段：`id`、`contract_id UNIQUE`、`start_date`、`end_date`、`retention_cents`、`defect_records_json`、`inspection_date`、`inspection_conclusion ('passed'|'rectifying')`、`visa_document_id REFERENCES ct_document(id)`、`released_payment_id REFERENCES ct_payment(id)`、`reviewed_by_user_id`、`reviewed_at`、`created_at`、`updated_at`。
4. **新建 `ct_dispute`（纠纷与诉讼仲裁 17 列台账表）**：
   - 字段：`id`、`contract_id`、`change_id REFERENCES ct_change(id)`、`occurred_date`、`reported_to_dept_at`、`litigation_type`、`cause_of_action`、`counterparty_and_role`、`stage ('negotiation'|'mediation'|'arbitration'|'litigation_1st'|'litigation_2nd'|'execution'|'closed')`、`institution_name`、`case_no`、`involved_org_name`、`our_litigation_role`、`accepted_date`、`case_summary`、`gm_approved_at`、`legal_doc_form`、`closed_date`、`dispute_cents`、`judgment_result`、`actual_settled_cents`、`law_firm_and_lawyer`、`filed_to_mgmt_at`、`filed_to_discipline_at`、`created_at`、`updated_at`。

### 2.3 V70：`contract_supervision_and_risk_rules`

1. **扩展 `org` 报送层级路径配置与 `ct_import` 多表类型**：
   - `ALTER TABLE org ADD COLUMN report_full_name TEXT NOT NULL DEFAULT ''`（供纪巡财审输出 `一级单位/二级单位` 标准主体名称；为空时按 `org` 祖先链自动用 `/` 拼接）。
   - `ALTER TABLE ct_import ADD COLUMN import_kind TEXT NOT NULL DEFAULT 'standard_ledger' CHECK (import_kind IN ('standard_ledger','monthly_ledger_wan','supervision_expense_base','supervision_expense_exec','supervision_expense_change','supervision_income_base','supervision_income_exec','supervision_income_change'))`。
2. **新建 `ct_evaluation`（履约后评价表，联动供应商库）**：
   - 字段：`id`、`contract_id UNIQUE`、`supplier_id`、`quality_score`、`schedule_score`、`service_score`、`total_score`、`recommendation ('preferred'|'normal'|'restricted'|'blacklisted')`、`comment`、`evaluated_by_user_id`、`evaluated_at`。
3. **新建 `ct_supervision_export_log`（报送打包审计表）** 并向 `risk_rule` 幂等预置 10 条合同全生命周期量化预警规则（`INSERT OR IGNORE INTO risk_rule ...`），向 `STD_REPORT_TYPES` 注册 `contract_monthly_pack`。

---

## 3. 核心业务算法与 API 路由契约

### 3.1 八阶段推进门禁矩阵（`computeBlockers`）

| 当前阶段 → 下一阶段 | 服务端强制重算阻断条件（任一不满足返回 `409 CONTRACT_STAGE_BLOCKED`） |
|---|---|
| `initiation → procurement` | 1. 支出类非总额包干日常合同须关联 `project_id` 或说明资金来源；2. 必填 `direction`、`legal_category`、`report_category`、`undertaker_name`；3. 支出选 `funding_source = 'income_contract'` 时 `source_income_contract_id` 必须有效；4. 直属电站收入合同 `signing_entity_level` 必须为 `'company'` |
| `procurement → drafting` | 1. 支出采购类（非 `exempt_small`）须填 `procurement_target`、`procurement_method`、`procurement_start_date`、`supplier_confirm_date` 且时间不倒置，并上传采购依据附件；2. 非采购支出须有 `company_approval`；3. 收入合同须填 `acquisition_method` 并有 `client_written_offer` 或中标依据 |
| `drafting → approval` | 1. `lump_sum` 合同 `original_cents > 0`（若有 `bid_award_cents` 则 `original_cents <= bid_award_cents`）；`unit_price` 合同 `unit_price_desc` 非空；2. 已指定主相对方或 `counterparty_names`；3. 已填履约期限三态字段；4. 已上传最新 `contract_text` |
| `approval → performance` | 1. 最新 `contract_text` 已获 `ct_review` 正式 `approved`；2. 若 `legalEnabled` 则绑定 `ct_legal_run` 指纹有效且无日期顺序冲突；3. 重要合同或 `is_triple_major = 1` 具备决策方式/最终审批人及对应依据；4. 已填 `sign_date`、双方签署人信息，且**凡签署人非法定代表人已上传对应授权委托书**；5. 已上传盖章件 `signed` |
| `performance → settlement` | 1. 无 `status = 'suspended'`；2. 已上传履约或阶段验收文件（`performance` / `acceptance`）；3. 成果提交标志（支出 `deliverable_submitted = 1`）已确认 |
| `settlement → warranty`（`has_warranty = 1`）<br>或 `settlement → closed`（`has_warranty = 0`） | 1. 无待审 `ct_change`、`ct_settlement`、`ct_payment`、`ct_receipt`；2. 已上传书面最终验收文件 `acceptance` 且 `final_accepted = 1`；3. `archive_status IN ('checked','transferred')`（制度 12.1 档案完整门禁）；4. 已存在批准的 `final` 结算单；5. 若 `has_warranty = 0`：累计净结算与累计实付/实收已结清且无未退还活跃保函，档案已移交（或管理员登记批次移交说明） |
| `warranty → closed` | 1. `ct_warranty` 已登记期满验收通过（`inspection_conclusion = 'passed'`）并附《质保金支付签证表》；2. 质保金尾款已支付完毕且活跃保函已全部结清退还；3. 无未结案纠纷（`ct_dispute.stage <> 'closed'`） |

### 3.2 附件 5 变更/索赔分级纯函数（`computeChangeApprovalTier`）

```ts
// 输入均为 bigint 整数分，零浮点误差
export function computeChangeApprovalTier(params: {
  originalCents: bigint;
  priorApprovedPositiveCents: bigint; // 历史已批正增加额之和
  deltaCents: bigint;
  changeKind: 'change' | 'claim_by_contractor' | 'counter_claim' | 'suspend' | 'terminate';
  procurementTier: ProcurementTier | null;
  involvesBizOrEntityChange: boolean;
  involvesTechChange: boolean;
  orMode: 'min' | 'max'; // 默认 'min'（内控从严孰低）
}): {
  tier: 'undertaker_unit' | 'undertaker_vp' | 'tech_and_undertaker_vp' | 'dual_vp' | 'general_manager' | 'management_board';
  requireTechSpecialAudit: boolean;
  requireDisciplineFiling: boolean;
}
```

- 比率换算全部采用整数乘法比较，例如 `delta <= 2% * original` 写作 `deltaCents * 100n <= originalCents * 2n`，避免任何除法截断误差。
- `changeKind === 'terminate'` 固定返回 `'general_manager'`；`priorApprovedPositiveCents >= 500_000_000n || (originalCents > 0n && priorApprovedPositiveCents * 10n >= originalCents)` 时，任何 `deltaCents > 0n` 固定返回 `'management_board'`。

### 3.3 新增与扩展 REST API 路由表（`backend/src/modules/contracts/routes.ts`）

| 方法与路径 | 权限码 | 用途 |
|---|---|---|
| `POST /api/contracts/:id/suspend` / `POST /api/contracts/:id/resume` | `contract:write`（中止需附审批记录或关联变更单） | 合同中止履行与恢复履行 |
| `POST /api/contracts/:id/distribution` | `contract:write` | 登记签署后 10 个工作日盖章扫描件分发及分/子公司进项合同报备 |
| `POST /api/contracts/:id/archive-status` | `contract:review` | 档案资料完整性验收（`checked`）与移交档案室登记（`transferred`） |
| `POST /api/contracts/:id/undertaker-handover` | `contract:write` | 承办人岗位调整/调离动态交接登记 |
| `GET/POST /api/contracts/:id/settlements` & `POST .../settlements/:sid/decide` | 读 `contract:read` / 写 `contract:write` / 审 `contract:review` | 进度/竣工结算单（含三类应扣款项）提交与复核 |
| `POST /api/contracts/:id/receipts` / `.../decide` / `.../receive` | 读 `contract:read` / 写 `contract:write` / 审 `contract:review` | 收入合同收款计划/申请、复核与实际到账登记 |
| `GET/POST /api/contracts/:id/guarantees` & `PATCH .../guarantees/:gid` | `contract:read` / `contract:write` | 履约保函、预付款保函、投标/质保保证金与工程保险登记、索赔报告、退还清理 |
| `PUT /api/contracts/:id/warranty` | `contract:write`（期满签证确认需 `contract:review`） | 质保期起止维护、质量缺陷记录与质保期满签证确认 |
| `GET/POST /api/contracts/:id/disputes` & `PATCH .../disputes/:did` | `contract:read` / `contract:write` | 合同纠纷与诉讼仲裁 17 列台账、起诉审批与双备案登记 |
| `PUT /api/contracts/:id/evaluation` | `contract:review` | 履约完结后供应商评价登记 |
| `GET /api/contracts/exports/monthly-ledger` | `contract:read` + `analysis:export` | 导出公司内部每月 28 日 5 表合同月报 `.xlsx` |
| `GET /api/contracts/exports/supervision/preflight` | `contract:read` | 上级《纪巡财审》报送包完整性预检（返回缺字段/缺槽位附件的逐项定位） |
| `POST /api/contracts/exports/supervision/package` | `contract:read` + `analysis:export` | 生成并下载《纪巡财审合同导入》标准 `.zip`（6 张 `.xlsx` + 分级附件目录树） |
| `GET /api/contracts/supervision-portal/full` & `.../incremental` | `contract:read`（按 `AuthContext` 组织裁剪） | 面向公司 OA 纪巡财审统一门户的全量与增量只读同步接口 |

### 3.4 《纪巡财审》6 表 Excel + 4 类附件槽位 ZIP 构建规格

1. **内置纯净表头构造器（零外部运行时文件依赖）**：
   - 离线比对 `docs/private/contract-lifecycle/01_纪巡财审合同导入标准模板/` 中 6 张 `.xlsx`，将第 1～5 行（实际收付款 Sheet 为第 1～4 行）的精确单元格文本、列序号（Row 2）、分组横幅合并区（Row 3）、字段标题（Row 4）、填表说明（Row 5）及下拉 `dataValidations` 编码为 `backend/src/modules/contracts/supervision-template-spec.ts` 常量。测试套件直接加载 `docs/private` 或合成夹具验证导出列标题、行号、校验列表与官方模板 100% 一致，而生产运行时不依赖 `docs/private` 目录。
2. **数据格式化硬规则**：
   - 所有日期列强制格式化为文本 `'YYYY-MM-DD'`（严禁输出中文年月日或时间戳）；
   - 金额列写入精确十进制数值或符合模板要求的不带千分位纯数字字符串（单位：元，最多两位小数，由 `centsToDecimalString` 转换，严禁带 `¥`、逗号、空格或正负号）；
   - 同一合同多次付款/收款在 Sheet2 分多行输出，严禁合并单元格；Sheet2 中的所有合同编号必定同步出现在同工作簿 Sheet1 中。
3. **附件目录树自动归集映射**：
   - **支出合同主附件（`支出合同附件/<合同编号>/`）**：
     - `01决策附件/` ← `evidence_kind IN ('procurement_scheme_approval','bid_award_approval','award_notice','evaluation_report','company_approval','triple_major_decision','legal_opinion')`
     - `02供应商资格审查/` ← `doc_type = 'qualification'` 或 `evidence_kind = 'supplier_qualification'`
     - `03合同文本/` ← 最新盖章件 `doc_type = 'signed'`（无盖章件时不导出到已签包并由预检提示）
     - `04付款方合同签署人授权附件/` ← `evidence_kind = 'our_signatory_auth'`
     - `05收款方合同签署人授权附件/` ← `evidence_kind = 'counterparty_signatory_auth'`
   - **收入合同主附件（`收入合同附件/<合同编号>/`）**：
     - `01决策附件/` ← `evidence_kind IN ('client_written_offer','company_approval','triple_major_decision','legal_opinion','bid_award_approval')`
     - `02合同文本/` ← 最新盖章件 `doc_type = 'signed'`
     - `03收款方合同签署人授权附件/` ← `evidence_kind = 'our_signatory_auth'`
   - **变更与纠纷附件**：
     - 文件夹名 `escapeSupplementFolder(supplement_no)`（将 `|` 转为 `$`、`/` 转为 `%`、`\`/`:`/`*`/`?`/`"`/`<`/`>` 转为 `_`）；
     - 支出：`支出合同变更与纠纷附件/<文件夹名>/01变更决策附件/`（`change_id` 匹配且 `evidence_kind = 'change_decision'`）与 `02变更协议文本/`（`evidence_kind = 'change_agreement'`）；
     - 收入：`收入合同变更与纠纷附件/<文件夹名>/01变更协议文本/`（`change_id` 匹配且 `evidence_kind = 'change_agreement'`）。

---

## 4. 跨模块联动改造清单

1. **项目 360° 档案（`backend/src/modules/master/project-profile.service.ts`）**：
   - 合同分节区分“支出合同总额/已结/已付”与“收入合同总额/已结/已收”，禁止将同一项目下的收入合同与支出合同金额直接相加；补充展示活跃保函与未闭环变更/纠纷计数。
2. **管理会计与标准报表（`contractPaidInPeriod`、`contractPaymentTotals`、`standard-report.service.ts`）**：
   - 既有 `contractPaidInPeriod` 与 `contractPaymentTotals` 限定 `c.direction = 'expense' AND c.currency = '人民币'`，避免混入收入合同或外币导致付款率失真；新增收入合同收款统计指标 `contract_received` 与 `contract_receipt_rate`。
   - `contractPaymentLedger` 标准报表增加“收支方向、计价方式、币种、累计净结算、本期实收/实付”列，并新增 `contract_monthly_pack`（月度 5 表冻结快照）。
3. **工作台待办（`backend/src/modules/report/todo.service.ts`）**：
   - 在合同待办中补充“待复核结算单”“待登记收款”“30 天内到期保函/待签证质保期”“签署超 10 工作日待分发”快捷筛选。
4. **小澧 AI 助手只读工具（`backend/src/assistant/domain-tools.ts` & `domain-facts.ts`）**：
   - 遵循 T-8 单一工具定义契约，扩展 `domain_ledger(kind='contracts')` 支持按 `direction`、`pricingMode`、`archiveStatus` 筛选；
   - 新增只读工具 `contract_lifecycle_detail`（返回指定合同的阶段阻断项、结算扣款汇总、变更定级计算依据、保函质保与纪巡财审预检缺项），严守 `visibleContract` 组织裁剪且绝不直接执行写操作。

---

## 5. 小步实施清单（每棒独立类型检查与测试）

### 阶段一：T-10 底座重构、立项授权与双向结算收付（V68）

- [x] **T-10.1 数据库 V68 重建迁移与契约拆分**：编写 `V68`（`rebuild: true` 重建 `ct_contract`/`ct_payment`/`ct_document`，新建 `ct_undertaker_handover`/`ct_settlement`/`ct_receipt`）；在临时库验证 V67 非空合同/法审数据无损迁移、`archived → closed + transferred` 映射正确及 `foreign_key_check = 0`。
- [x] **T-10.2 八阶段状态机、单价合同与授权/时间链门禁**：更新 `contract.service.ts`、`legal-context.ts` 与 `legal-rules.ts`；实现单价合同 0 初始总价签约、以收定支关联校验、直属电站收入合同主体校验、非法定代表人授权书阻断、采购时间链校验、正交分发/归档及承办人交接接口。确认既有 `t9-legal-*.test.ts` 全部绿灯。
- [x] **T-10.3 结算单与双向分级收付服务**：实现 `contract-settlement.service.ts`（附件 8 结算勾稽、未批变更拦截、档案完整方可最终结算、50 万/500 万分级付款校验、收入合同 `ct_receipt` 正向收款），同步修正 `project-profile` 与管理会计收支隔离口径。
- [x] **T-10.4 前端基础表单重构与结算收付页签**：拆分 `ContractBaseFormModal.tsx`、`ContractSettlementTab.tsx` 与 `contractOptions.ts`，通过 AST 契约边界检查（前端不值导入后端 Zod）。
- [x] **T-10.5 T-10 回归与阶段验收**：补齐 `t10-contract-lifecycle.test.ts` 与 Playwright 用例，完成 `AC-CLM-01`～`AC-CLM-07`。

### 阶段二：T-11 变更索赔四位一体、保函质保与纠纷闭环（V69）

- [x] **T-11.1 数据库 V69 迁移**：`rebuild: true` 重建 `ct_change`（支持 `delta_cents = 0`、四位一体枚举与法人内唯一 `supplement_no`），新建 `ct_guarantee`、`ct_warranty`、`ct_dispute`。
- [x] **T-11.2 附件 5 变更定级与中止/解除引擎**：实现 `contract-change.service.ts`（四档+500万/10%定级、技术审查 10 日跟踪、超计划联动、第 9.1.4 条防拆包规避采购拦截、中止冻结与总经理批准解除+担保方书面同意门禁）。
- [x] **T-11.3 保函保险、质保签证与纠纷服务**：实现 `contract-safeguard.service.ts`（保函押金清理与索赔报告、`settlement → warranty → closed` 质保金解锁闭环、17 列诉讼仲裁台账与企管/纪审双备案）。
- [x] **T-11.4 前端变更索赔与担保质保纠纷页签**：实现 `ContractChangeTab.tsx` 与 `ContractSafeguardTab.tsx`（实时显示附件 5 要求审批层级与阻断提示）。
- [x] **T-11.5 T-11 回归与阶段验收**：补齐 `t11-contract-change-safeguard.test.ts` 与浏览器闭环验证，完成 `AC-CLM-08`～`AC-CLM-10`。

### 阶段三：T-12 多源导入、双口径标准报送包、预警矩阵与 OA 接口（V70）

- [x] **T-12.1 数据库 V70 迁移与量化风险规则**：新增 `org.report_full_name`、`ct_evaluation`、`ct_supervision_export_log`，预置 10 条合同量化风险规则并在 `risk.service.ts` 实现检测器（含同项目同相对方同年度拆分规避招标识别、工作日时限计算）。
- [x] **T-12.2 多模板合同导入升级**：扩展 `contract-import.service.ts` 支持公司万元月报与纪巡财审基本信息/执行及逐笔收付款/变更纠纷模板导入，保留逐笔真实收付款发生日期。
- [x] **T-12.3 公司每月 28 日 5 表月报与纪巡财审 6 表+ZIP 导出器**：实现 `contract-export.service.ts` 与 `supervision-template-spec.ts`（报送完整性预检、6 张官方结构 Excel 生成、4 类编号附件槽位归集打包、内存与权限范围守卫）。
- [x] **T-12.4 OA 监督门户只读接口、履约后评价与小澧助手扩展**：实现 `/supervision-portal/full` 与 `/incremental`、完结后供应商评价联动、小澧助手 `contract_lifecycle_detail` 只读工具及前端 `ContractExportModal.tsx`。
- [x] **T-12.5 全量门禁、备份恢复演练与生产发布**：运行前后端全量类型检查与测试、独立目录构建、Playwright E2E、临时文件库 V67→V70 迁移与备份恢复核验，通过 `scripts/deploy.sh` 正式发布并在 `docs/acceptance-records.md` 登记 `AC-CLM-01`～`AC-CLM-14` 证据。

---

## 6. 验证与发布命令速查

```bash
# 0. 切换固定 Node 版本
export PATH=/root/.nvm/versions/node/v24.22.1/bin:$PATH
node -v # 必须输出 v24.22.1

# 1. 后端源码类型检查与合同专项测试
cd /root/newfc/backend && npx tsc --noEmit && npx vitest run tests/t9-legal-*.test.ts tests/t10-*.test.ts tests/t11-*.test.ts tests/t12-*.test.ts

# 2. 前后端全量门禁
cd /root/newfc/backend && npx tsc --noEmit && npx vitest run
cd /root/newfc/frontend && npx vitest run && npx tsc -b

# 3. 独立产物浏览器 E2E（专用端口与临时库，不碰运行库）
(cd /root/newfc/backend && npx tsc --outDir .e2e-dist --noEmitOnError)
(cd /root/newfc/frontend && npm run build:e2e)
(cd /root/newfc/frontend && npx playwright test --config playwright.contract-legal.config.ts)

# 4. 生产发布（测试 → 构建到 dist.new → 停服 → 备份+显式迁移+种子 → 替换 → 启动 → 就绪检查）
cd /root/newfc && bash scripts/deploy.sh
```
