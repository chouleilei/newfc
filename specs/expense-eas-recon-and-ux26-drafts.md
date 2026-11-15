# 报销小额比价拆单预警、EAS 遗留对账、全景互跳与受控草稿设计（T-15 / 阶段三 P2）

状态：**立项实施（独立工作树 `feat/improvement-2026-11`，目标 schema V75）**。本文是阶段三（P2：`GAP-20`、`GAP-21`）唯一维护的领域契约与验收规范，衔接 [T-13 主数据与历史容缺底座](foundation-and-legacy-migration.md)、[T-14 计划下达与 52 条规则](plan-issuance-and-supervision-rules.md)、[智能合同法审设计](contract-legal-review.md) 与 [AI 页面上下文与草稿契约](ai.md)。所有规范文本、代码与公共单测夹具均严格执行零实名、零信用代码、零涉密财务原值脱敏约束。

---

## 1. 范围与问题映射

| 差距项 | 关联功能 | 核心交付目标 | 验收编号 |
|---|---|---|---|
| `GAP-20`（报销侧） | `F16`、`F20`、`F22` | 报销单挂接合同、采购类 `≤ 30,000.00` 元书面市场比价报告服务端自动统计与缺失预警（`EXP_SMALL_PROC_NO_COMPARISON`）、同组织同类别/收款方滚动窗口高频拆单预警（`EXP_SPLIT_BELOW_30K` 联动 `ex_split_alert_log` 与 `PW_14` 客观线索） | `AC-T15-01` |
| `GAP-20`（EAS 侧） | `F05`、`F16`、`F13` | EAS 当前生效批次与合同质保金（`2241*` 期满签证逾 30 天未清）、供应商往来异常负余额（`2202*`/`1123*`/`122103*`）、在建工程（`1604*` 已竣工决算或长期静止未转固遗留）只读对账及 `eas_recon_note` 受控财务核对台账 | `AC-T15-02` |
| `GAP-21`（跨域穿透） | `F07`、`F15`、`F16`、`F20` | `ProjectProfile` 项目全景「计划明细 ↔ 挂接合同（份数/金额）↔ 风险事件」双向下钻过滤，`RiskLedger` 风险事件直跳项目全景与合同抽屉 | `AC-T15-03` |
| `GAP-21`（`UX-26`） | `F15`、`F16`、`F25` | 智能助手扩展 `'contract_draft'` 与 `'plan_issuance_draft'` 两类受控草稿及只读预填建议工具，严格遵循 `AuthContext` + `OrgScope` 同源校验与「只回填表单状态、绝不自动写库」门禁 | `AC-T15-04` |
| `GAP-21`（`AC-CLR-09`） | `F16`、`F25` | 覆盖 8 大业务合同类别（货物采购、大中型施工、小型基建、技术服务、一般服务、运维服务、收入销售、行政移交/重大特殊协议）的「缺陷初稿 vs 法审修订稿」配对真值回归与候选/正式范本门禁核验 | `AC-T15-05`（`AC-CLR-09`） |

---

## 2. 数据库 V75 只追加迁移契约（`migrations-p2-recon-drafts.ts`）

严格遵守只追加原则，**不修改 `V1`～`V74` 任何字节**。新增 `V75`（`v75_expense_split_eas_recon_and_ux26_drafts`）：

1. **`ex_split_alert_log`（报销小额拆单监测追溯日志表）**
   - 列：`id`、`org_id`（外键 `org(id)`）、`normalized_category`（规范化费用类型或供应方分组键）、`supplier_or_payee`（可空文本）、`window_days`（正整数，默认 `30`）、`anchor_date`（`YYYY-MM-DD`）、`claim_ids_json`（命中报销单 ID 升序 JSON 数组）、`claim_nos_json`（命中单号 JSON 数组）、`claim_count`（`>= 2`）、`total_cents`（`INTEGER NOT NULL`，`>= 3000000`）、`risk_event_id`（可空外键 `risk_event(id) ON DELETE SET NULL`）、`fingerprint`（`UNIQUE`，按组织 + 分组键 + 命中单 ID 集合计算，幂等去重）、`detected_at`、`updated_at`。
   - 索引：`idx_ex_split_alert_org(org_id, anchor_date DESC)`。
2. **`eas_recon_note`（EAS 合同质保金/往来/在建工程遗留财务核对备注表）**
   - 列：`id`、`org_id`（外键 `org(id)`）、`period`（`YYYY-MM`）、`category`（`CHECK (category IN ('warranty_2241_overdue','supplier_negative_balance','cip_1604_legacy'))`）、`target_key`（稳定业务目标键，如 `2241:CT-12`、`neg:220201:SUP-A`、`1604:PRJ-01:160401`）、`recon_status`（`CHECK (recon_status IN ('pending','to_writeoff','explained_normal','resolved'))`）、`voucher_ref`（凭证追溯号，默认 `''`）、`note`（财务核对结论与处理说明）、`updated_by_user_id`（外键 `app_user(id) ON DELETE SET NULL`）、`created_at`、`updated_at`。
   - 唯一约束：`UNIQUE(org_id, period, target_key)`；索引：`idx_eas_recon_note_lookup(org_id, period, category, recon_status)`。
   - **事实隔离铁律**：`eas_voucher_line`、`eas_balance_line`、`eas_aux_line` 继续受不可变触发器保护，任何核对说明只写入 `eas_recon_note` 并记录 `operation_log`，绝不篡改 EAS 原始导入行。
3. **业务配置参数种子（`business_setting` `INSERT OR IGNORE`）**
   - `expense.split_window_days`：默认 `'30'`（连续自然日窗口，`1`～`365`）；
   - `expense.small_procurement_limit_cents`：默认 `'3000000'`（`30,000.00` 元整数分）。
4. **助手受控草稿存储契约说明**
   - 依据 `specs/ai.md` §5.7 五条禁令，未保存页面草稿只在单次请求内存中解析校验，数据库不设草稿暂存表；`ai_message.response_json` 中的 `draftApplied.kind` 由共享契约 `DraftKind`（`page-catalog.ts` + `assistant-openapi.json`）扩展支持 `'plan_issuance_draft'` 与 `'contract_draft'`。

---

## 3. 金额、阈值与核心业务规则

### 3.1 报销采购比价与 30 日拆单预警（`GAP-20` 报销侧）

1. **服务端权威比价附件计数（`price_compare_doc_count`）**：
   - 严禁信任客户端传入的附件数量。每当 `addClaimAttachment` 或草稿附件变更执行时，服务端扫描该报销单全部 `ex_attachment`，凡 `kind_hint = 'price_comparison'` 或规范化 `name`/`kind_hint` 命中 `比价|询价|市场调研|三家报价` 关键词者计入 `price_compare_doc_count` 并回写 `ex_claim`。
   - 若报销单绑定了有效合同 `contract_id`，且该合同已关联具备有效比价记录的 `ct_procurement_record` 或 `procurement` 类文档，审核规则在证据链中一并引用说明。
2. **规则 `EXP_SMALL_PROC_NO_COMPARISON`（对应制度采购条款 §8.1.7 与 `PW_13`）**：
   - 触发条件：`is_procurement_expense = 1`，`amount_cents <= 3_000_000n`（或配置的 `expense.small_procurement_limit_cents`），且 `price_compare_doc_count < 1`，同时单据说明未标注经核实的经常性水电通信缴费等法定豁免凭据。
   - 审核输出：在 `ex_finding` 生成 `severity = 'medium'`（单笔 `>= 1_000_000n` 即 1 万元以上且无合同、无比价时升为 `'high'`）规则发现，提示补传书面市场比价报告。
3. **规则 `EXP_SPLIT_BELOW_30K`（对应制度 §8.1.7 末句、§11.3 与 `PW_14`）**：
   - 统计口径：同一 `org_id` 下，排除已驳回（`conclusion = 'reject'`）及草稿未提交前的无效废单（审核运行时纳入当前送审单与同组织非驳回历史已提交/已审/已复核报销单），按「相同规范化 `expense_type`」或「同一关联 `contract_id`/供应商编码」分组，在滚动 `W`（默认 `30`）个自然日窗口内：
     - 每笔单据满足 `0n < amount_cents <= limit_cents`（单笔未超 `30,000.00` 元门槛，其中采购类或同费用科目高频小额单）；
     - 窗口内笔数 `>= 2` 且累计金额 `sum(amount_cents) >= limit_cents`（`bigint` 精确累加）。
   - 联动动作：
     - 在当次 `ex_audit_run` 写入 `code = 'EXP_SPLIT_BELOW_30K'`（`severity = 'high'`）发现，附带组合单号、笔数、窗口起止日期与累计金额十进制字符串证据；
     - 在短事务内幂等写入/更新 `ex_split_alert_log`，并同步向 `risk_event`（规则 `PW_14`，`subject_type = 'ex_claim'`，`evidence_status = 'suspected_clue'`）登记客观疑似拆单线索供人工复核。

### 3.2 EAS 合同质保金、往来负余额与在建工程遗留对账（`GAP-20` EAS 侧）

1. **数据源与范围**：
   - `GET /api/eas/contract-recon` 需要 `eas:read` 权限，强制按 `currentOrgScope(db)` 过滤 `org_id`（范围外组织返回 404）。
   - 仅读取目标 `(orgId, period)` 当前激活（`is_current = 1 AND status = 'active'`）的 `eas_balance_line` 与 `eas_aux_line`（及同期间 `eas_voucher_line` 辅助穿透），结合 `md_code_mapping`（`source_system = 'eas'`）匹配 `md_project`、`md_supplier`、`ct_contract`、`ct_warranty` 与 `ic_project`。
2. **三类异常核对口径（全量 `bigint` 定点计算）**：
   - `warranty_2241_overdue`（应付质保金到期未清）：科目编码 `2241*`（或科目名称含 `质保金`/`质量保证金`），期末净额 `net_cents = end_credit_cents - end_debit_cents > 0n`，关联合同存在 `ct_warranty` 且满足：`inspection_conclusion = 'passed'` 且 `inspection_date`（缺失时取 `end_date`）距期间末日已超过 `30` 个自然日，或质保期届满且已登记释放付款单但账面余额仍未清零。
   - `supplier_negative_balance`（供应商往来异常负余额）：应付/质保类贷方科目（`2202*`、`2241*`）出现期末借方净额（`end_credit_cents - end_debit_cents < 0n`，即应付账款负余额），或预付/其他应收往来借方科目（`1123*`、`122103*`）出现期末贷方净额（`end_debit_cents - end_credit_cents < 0n`），携带供应商辅助核算或供应商名称。
   - `cip_1604_legacy`（在建工程已竣工或长期挂账遗留）：科目编码 `1604*`（在建工程），期末借方净额 `end_debit_cents - end_credit_cents > 0n`，满足其一：
     a) 关联 `ic_project` 已存在已确认的结算/竣工决算版本（`version_type IN ('settlement','final_account') AND status = 'confirmed'`）或 `ic_project.status = 'archived'`；
     b) 期初借方余额 `> 0n` 且本期借贷发生额均为 `0n`（`debit_cents = 0n AND credit_cents = 0n`），账面长期静止未转固核销。
3. **核对备注登记（`POST /api/eas/contract-recon/notes`）**：
   - 需要 `eas:import` 权限及目标 `orgId` 数据范围权限。
   - 请求体：`{ orgId, period, category, targetKey, reconStatus, voucherRef?, note }`，原子 `INSERT ... ON CONFLICT(org_id, period, target_key) DO UPDATE` 至 `eas_recon_note`，并写 `operation_log`（`eas.contract_recon.note`）。

### 3.3 项目全景双向直联与风险互跳（`GAP-21` 全景侧）

1. **`getProjectProfile` 扩展契约（`project-profile.ts` / `project-profile.service.ts`）**：
   - `contracts.rows[]` 增加 `planItemId: number | null` 与 `planItemName: string | null`（左连接 `plan_item` 并校验同组织范围）。
   - `plan.items[]` 增加 `linkedContractCount: number` 与 `linkedContractAmount: MoneyString`（汇总当前项目下 `plan_item_id = item.id` 且在用户可见范围内的合同份数与人民币现行金额 `bigint` 求和）。
   - `risks.rows[]` 增加 `subjectType: string`、`subjectId: number`、`contractId: number | null`（当 `subject_type = 'contract'` 时为 `subject_id`，当证据 JSON 含 `contractId` 时提取并校验可见性）。
2. **前端双向交互（`ProjectProfile.tsx` / `RiskLedger.tsx`）**：
   - `ProjectProfile` 计划执行页签每张计划卡片/明细展示 `已挂接合同：{linkedContractCount} 份 / {linkedContractAmount} 元`，点击后直接切换至「合同付款」页签并激活 `planItemId` 过滤条件（同时提供一键跳转 `/contracts?projectId={id}&planItemId={itemId}` 入口）。
   - `ProjectProfile` 合同页签顶部展示当前 `planItemId` 筛选标签与「清除筛选」按钮，表格新增「关联综合计划项」列。
   - `ProjectProfile` 风险页签与 `RiskLedger` 列表/详情抽屉对关联项目、关联合同提供可点击跳转链接（`/projects/:projectId`、`/contracts?id=:contractId`）。

### 3.4 智能助手受控草稿 `UX-26`（`GAP-21` 助手侧）

1. **草稿类型注册与权限范围**：
   - `DraftKind` 新增 `'plan_issuance_draft'`（绑定页面 `plan`）与 `'contract_draft'`（绑定页面 `contracts`）；同步更新 `CONFIG_FIELD_HELP`、`assistant-openapi.json`。
   - 权限门控：`contract_draft` 校验 `contract:read` 且草稿内 `orgId` / `projectId` / `planItemId` / `targetId` 必须属于 `currentOrgScope(db)`（二级单位受限账号可在自身授权组织范围内使用，越权组织立即拒绝 `SCOPE_RESTRICTED` 或 `NOT_FOUND`）；`plan_issuance_draft` 校验 `plan:read` 且 `orgId` / `cycleId` 属于 `currentOrgScope(db)`；既有 T-8 全局配置草稿维持 `requireAllOrgs` 不变。
2. **确定性预检与受控建议生成（只读零副作用）**：
   - `contract_draft`：校验组织、关联综合计划项 `planItemId`、收支方向、法审类别与金额格式；基于 `ct_prefix_org_map` 与 `suggestNextContractNo` 只读推算建议 `contractNo`、基于计划项推算 `budgetType` 与可用计划额度提示、基于组织与类别推算默认会签部门列表 `countersignDepts`，放入 `analysis.suggestedFields`（仅含服务端数据库派生的安全结构化字段，绝不回传客户端未保存隐私文本至外部模型）。
   - `plan_issuance_draft`：校验下达周期阶段或 6 类调整类型 `adjustType`、申请单位与明细量纲，自动按服务端权威矩阵推算 `approvalBody` 及制度条款依据放入 `analysis.suggestedFields`。
   - 同时在 `domain-tools.ts` 提供只读工具 `suggest_contract_draft` 与 `suggest_plan_issuance_draft` 供对话查询同源调用。
3. **前端回填与防误写红线**：
   - `ContractBaseFormModal.tsx` 与 `PlanIssuanceTabs.tsx` 接入 `useAssistantDraft` + `ConfigFormAssistant`。
   - 用户点击助手事实面板「填入助手建议草稿」时，仅通过浏览器内存事件更新 Antd `Form` 字段值并渲染 `<Tag color="processing">助手建议草稿 · 待人工确认</Tag>`，**绝不自动触发 `POST /api/contracts`、`POST /api/plan/issuance-cycles` 或 `POST /api/plan/adjustments`**；未点击弹窗确认按钮直接刷新或关闭弹窗时，数据库行数 100% 不变。

### 3.5 `AC-CLR-09` 多类别合同配对法审回归规范

建立覆盖 **8 类脱敏业务合同样本**的自动化配对回归套件（`backend/tests/t15-legal-regression-ac-clr-09.test.ts` 与离线评估脚本扩展）：

1. **8 类样本覆盖矩阵**：
   - 类别 1：货物采购（`goods_procurement`）— 缺陷稿（过期《合同法》依据、付款比例和 ≠ 100%、缺违约上限、未填占位符）vs 修订合规稿；
   - 类别 2：大中型工程施工（`construction`）— 缺陷稿（合同生效前实质进场施工、缺安全协议依据与质量保修条款）vs 修订合规稿；
   - 类别 3：小型基建工程（`small_construction`）— 缺陷稿（大小写金额不一致、缺转包违法分包禁止条款）vs 修订合规稿；
   - 类别 4：技术服务（`tech_service`）— 缺陷稿（缺知识产权归属与验收标准、税率发票不明）vs 修订合规稿；
   - 类别 5：一般综合服务（`general_service`）— 缺陷稿（缺解除善后与争议管辖、关键空白占位符）vs 修订合规稿；
   - 类别 6：运行维护服务（`general_service` 运维子类）— 原版稿 vs 内部法审修改版（考核扣款与运维响应时限完善）；
   - 类别 7：收入销售合同（`income_sales`）— 缺陷稿（收款保障与逾期违约缺失、电价/结算计价口径不明）vs 修订合规稿；
   - 类别 8：行政移交/重大特殊协议（`important_special` / `other`）— 原始稿 vs 律师修改稿 vs 终版稿（3 项已知责任与效力条款追踪 `3/3 -> 0/3 -> 1/3`，且缺三重一大/法律意见书时触发 `IMPORTANT_CONTRACT_GATE`）。
2. **范本转正与结论门禁断言**：
   - 数据库迁移脚本严禁自动把 `'candidate'` 范本改为 `'official'`；
   - 范本处于 `'candidate'` 时，即使修订合规稿零高/中风险规则发现，`runContractLegalReview` 仍输出 `verdict = 'manual_review'`（含 `TEMPLATE_CANDIDATE_UNCONFIRMED`）；
   - 经授权人员调用 `changeLegalCatalog(..., 'promote')` 显式审计转正为 `'official'` 后，缺陷稿输出 `'fail'` 或 `'manual_review'`（100% 召回预设红线缺陷），修订合规稿输出 `'pass'`；无正式范本的行政移交协议始终保持 `'manual_review'`，绝不误放行 `'pass'`。

---

## 4. 验收标准（`AC-T15-01`～`AC-T15-05`）

| 验收 ID | 验收断言 | 验证载体 |
|---|---|---|
| `AC-T15-01` | 报销单可挂接同范围合同并标记采购类报销；比价附件数由服务端根据上传材料自动重算；`≤ 30,000.00` 元采购无书面比价触发 `EXP_SMALL_PROC_NO_COMPARISON`；同组织同类滚动 30 日多笔小额累计 `≥ 30,000.00` 元触发 `EXP_SPLIT_BELOW_30K`、写入 `ex_split_alert_log` 并同步 `PW_14` 疑似拆单线索；前端表单实时提示 §8.1.7 要求 | `backend/tests/t15-expense-split-and-eas-recon.test.ts`、`frontend/src/pages/expense/ExpenseClaims.test.tsx`、`cross-domain.spec.ts` |
| `AC-T15-02` | `GET /api/eas/contract-recon` 准确检出 `2241*` 质保期满签证超 30 天未清、供应商往来异常负余额、`1604*` 已竣工或长期静止在建工程遗留三类异常；`POST /api/eas/contract-recon/notes` 幂等保存核对结论与凭证号且 `eas_balance_line`/`eas_voucher_line` 零改动；`EasWorkspace` 第 5 页签同屏穿透并支持权限门控备注登记 | `backend/tests/t15-expense-split-and-eas-recon.test.ts`、`frontend/src/pages/financeData/EasContractRecon.test.tsx`、`cross-domain.spec.ts` |
| `AC-T15-03` | `getProjectProfile` 返回计划行挂接合同份数/精确金额、合同行 `planItemId`/`planItemName`、风险行关联对象；`ProjectProfile` 点击计划挂接合同直接过滤合同页签，`RiskLedger` 支持直跳项目全景与合同详情，权限裁剪与 `OrgScope` 一致 | `backend/tests/t15-profile-assistant-ux26.test.ts`、`frontend/src/pages/project/ProjectProfile.test.tsx`、`cross-domain.spec.ts` |
| `AC-T15-04` | `'contract_draft'` 与 `'plan_issuance_draft'` 纳入 `PAGE_CATALOG` 与 OpenAPI 契约；助手按母公司简码映射与计划项生成预填建议并校验 `OrgScope`；未保存表单私密值不出网；回填仅修改前端 `Form` 并展示待确认标签，用户确认前数据库零写入 | `backend/tests/t15-profile-assistant-ux26.test.ts`、`frontend/src/assistant/domainContext.test.tsx`、`assistant-domains.spec.ts` |
| `AC-T15-05` | 完成 `AC-CLR-09` 8 类脱敏合同「缺陷稿 vs 修订稿」配对回归，必检红线规则零漏检、候选范本保持 `manual_review`、显式 `promote` 转正后合规稿 `pass`、非采购特殊协议不误判 `pass`，同步更新离线评估报告 | `backend/tests/t15-legal-regression-ac-clr-09.test.ts`、`docs/contract-legal-sample-evaluation.md` |
