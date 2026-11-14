# 主数据底座、16 表计划扩展、合同简码映射与历史容缺清洗设计（T-13）

状态：阶段一（P0）设计基线。覆盖组织与冷启动主数据底座、组织/用户范围批量初始化、业务参数专控、16 表 `.xls`/`.xlsx` 综合计划解析扩展、合同六维简码与法人推导、历史台账 5 步容缺清洗流水线、分级导入导出门禁、受限 `.doc` 法审解析及合同结算/页面已知缺陷修复。

## 1. 事实与数据（V73 只追加迁移）

在 `V72` 基线上只追加 `V73`，已发布 `V1`～`V72` 迁移字节保持不变；涉及修改既有表 `CHECK` 约束或结构时统一通过 `rebuild: true` 在单事务内重建并完整保留既有列、索引与触发器（含 `trg_plan_item_u/d`、`trg_ct_sync_monotonic`、`trg_ct_risk_*`）。

1. **组织树结构扩展（`org` 新增 6 列）**：
   - `org_kind`：`legal_entity`（存续法人）、`hq_dept`（本部职能部门/中心）、`direct_unit`（非独立法人直属分支机构）、`closed_history`（已关停/吸收注销历史主体，配合 `status = 'inactive'`）；
   - `credit_code`：统一社会信用代码（18 位或空串）；
   - `plan_issuance_root_id`：综合计划与预算归口的一级下达单元组织 ID；
   - `is_plan_excluded`：不单独生成综合计划下达通知、仅纳入集团合并口径的开关（`0 | 1`）；
   - `contract_prefix_code`：本主体新签合同规范前缀（未单赋独立简码的子法人统一沿用母公司规范简码）；
   - `is_direct_station`：制度定义的直属水电站政策标志（`0 | 1`，与 `org_kind = 'direct_unit'` 正交解耦：仅制度明确的直属电站置 `1`，其余直属分支机构置 `0`）。
   - 外部合作方/非并表参考主体严禁录入 `org`，拦截清单由配置表 `ct_prefix_org_map WHERE entity_status = 'external'` 动态驱动，源码零硬编码机构名称。
2. **综合计划明细扩展（`plan_item` 重建）**：
   - `sheet_code` 扩展为 16 类标准计划与附表枚举：`investment`、`investment_tech_renovation`、`investment_info`、`investment_other`、`purchase`、`pre_work`、`capacity_add`、`tech_renovation_exp`、`maintenance`、`safety_input`、`five_expenses`、`mgmt_fee`、`mfg_fee`、`annual_kpi`、`profit_budget`、`responsibility_kpi`；
   - 新增跨修订恒定标识 `stable_item_uid`、行层级类型 `item_type`（`leaf | subtotal | section_header | cross_ref_summary`）、`parent_item_key`、`issuance_pack_id`、`cost_nature`、`funding_channel`、实际承办组织 `undertake_org_id`、四层金额列（`submitted_cents`、`exact_calc_cents`、`approved_cents`、`rounding_rule`、`diff_reason_code`）、`estimate_subitem` 与结构化非阻断告警 `warnings_json`；
   - 无项目编码列的工作表按归口组织 + 实际承办组织 + 节路径 + 规范化项目名计算确定性 `item_key`，并分离小计/节头与明细叶行以防重复汇总。
3. **合同前缀映射字典与六维法人归属（`ct_prefix_org_map`）**：
   - 字段涵盖 `raw_prefix`、`canonical_prefix`、`legal_entity_org_id`（`external | ignore` 允许 `NULL`）、`signing_org_id`、`successor_org_id`、`effective_from`、`effective_to`、`parent_canonical_prefix`、`entity_status`（`active_legal | direct_unit | inherited_child | closed_history | external | ignore`）、`allow_new_contract`（默认 `0`）、`prefix_kind`（`internal_prefix | typo_alias | role_prefix | external_counterparty | noise_header_filter`）、`sample_contract_no`、`occurrence_count`、`note`；
   - 六维正交推导：解耦组织性质 `org_kind`、直属电站标志 `is_direct_station`、承办单位 `org_id`、实际对外签约名义 `signing_subject_org_id` + `signing_level`（以母公司名义签署归母公司法人；分子公司以自身名义签署归该分子公司法人）、取号前缀 `canonical_prefix` 与历史注销主体双轨冻结（同时冻结签约时点 `historical_legal_entity_org_id` 与现行承接法人 `legal_entity_org_id`）。
4. **历史容缺合同、多币种子表、溯源表与前置招采表**：
   - `ct_contract` 新增来源隔离与容缺字段：`origin`（`manual | standard_import | legacy_migration`）、`migration_mode`（`normal | legacy_tolerant`）、同法人异合同重号冲突组 `duplicate_conflict_group`、金额事实来源 `amount_fact_source`（`confirmed_contract | unit_price_open | voucher_debit_clue | unverified_forecast`）、凭证借方线索额 `clue_voucher_debit_cents`、历史结算/开票/确认收入基线列（`legacy_settled_baseline_cents`、`legacy_invoiced_baseline_cents`、`legacy_revenue_baseline_cents`、`baseline_as_of_date`，严禁覆写单价合同 `original_cents`）、六维主体冻结列、集团内部关联协议双视角互链列（`is_internal_group_tx`、`internal_group_agreement_key`、`counterparty_contract_id`）、多币种状态 `currency_struct_status`（`single | structured_multi | partial_unstructured`）、`procurement_record_id` 及原始文本/缺项列；
   - 新建 `ct_contract_currency_line`：按 `contract_id + amount_role + line_no` 存储复合币种原币整数金额与可选缩放汇率；
   - 新建 `ct_legacy_source_trace`：以 `UNIQUE(source_file_sha256, source_sheet, source_row, pipeline_version)` 作为多工作簿容缺导入幂等重演键，记录源截点 `as_of_date`；
   - 前置新建 `ct_procurement_record` 核心招采过程表：支持 `1` 个采购项目关联 `N` 份合同，为月报第 5 表《招标项目清查表》提供真实招采节点与质疑投诉数据源。

## 2. 金额契约

- 全部新增金额列使用 `INTEGER` 整数分（`_cents`）存储、`core/decimal.ts` 的 `bigint` 计算，读取可能超 `2^53` 的金额列开启 `.safeIntegers(true)`，接口返回两位小数十进制字符串。
- 计划与预算区分四层数值语义（源表原值、系统精确计算分 `exact_calc_cents`、发文批复分 `approved_cents`、展示格式化值），明确区分 `0.01 万元 = 100.00 元 = 10000n 分` 与 `100n 分 = 1.00 元`。
- 非货币量纲（如电量 `万kWh`）自动识别为单价合同描述（`pricing_mode = 'unit_price'`，`original_cents = 0`），严禁误按万元折算入账；记账凭证借方发生额线索标记 `amount_fact_source = 'voucher_debit_clue'`，不冒充已核定合同总价。
- 复合多币种合同拆入 `ct_contract_currency_line`；未配置汇率的外币容缺合同在只读/导入时不抛阻断错误，汇总报表按「人民币合计 + 分币种原币明细 + 含已知汇率折算合计」分列输出，不跨币种裸加、不静默丢弃外币记录。
- 常规结算（`origin != 'legacy_migration'` 且 `migration_mode = 'normal'`）遵循制度附件 8 注 2：允许预付款扣回、保留金、违约金等扣款分项为负数（如质保金退还、预付款冲回），同时数据库与服务层双重强制 `in_contract_cents >= 0`、`other_add_cents >= 0`、`gross_payable_cents >= 0` 且 `net_payable_cents >= 0`；负净额红冲仅限受专有权限保护的历史迁移记录（`origin = 'legacy_migration' AND is_reversal = 1` 且具备冲销原因与来源引用）。

## 3. 状态与事务

- **只容缺历史事实、不容缺迁后新增业务**：`origin = 'legacy_migration'` 仅标记迁入当时的存量事实；历史合同迁入后，任何页面新增变更仍由表级 `CHECK` 强制 `evidence_document_id IS NOT NULL`，新增常规结算仍强制 `net_payable_cents >= 0`。
- **多工作簿容缺流水线与五维行去向 100% 闭合**：支持 `.xls`（离线锁定 `xlsx@0.20.3`，校验 OLE2 魔数、工作表上限 `MAX_LEGACY_SHEETS = 100`、禁宏与原型污染键）与 `.xlsx` 多簿统一内存预检，执行「噪声与外部主体硬过滤 → 量级与非货币纠偏 → 缺失要素/复币/截点基线/红冲归置 → 四级消重（同法人异合同重号保留独立双记录并赋 `duplicate_conflict_group`，集团内部关联协议保留甲乙双方独立法人账套并互链） → 单一 `BEGIN IMMEDIATE` 短事务原子落库」；保持 `plan.hash` 与目标行 `version` 乐观锁（并发修改严格返回 `409 PREVIEW_STALE`）；输出五维行去向恒等式对账单（`源表总行数 = 过滤行数 + 同合同归并折叠行数 + 入库主合同行数 + 补充协议/变更结算子事件行数 + 重号冲突/凭证线索待核行数`）。
- **智能法审与文档解析边界**：候选范本保持人工审定 `promote` 审计转正门禁，严禁迁移脚本自动改写为 `official`；`legalEnabled` 覆盖货物采购、小型施工、工程施工、技术服务、一般服务、重要特殊六大类别（可通过 `contract.legal_review_categories` 配置微调），动态按该类别是否存在生效 `official` 范本决定是否允许输出 `pass`；在写事务外提供带大小、超时（≤ 20s）、内存与输出上限的受限 `.doc` 解析转换器并缓存至 `ct_doc_parse_cache`。
- **导出用途分级门禁**：
  - `supervision_submit`（正式监督报送）：强校验必填项、主合同文本必须为已盖章 `signed`（每槽位最多 1 份文件）、官方 6 模板零合并单元格、严禁正负号写入金额列（拦截 `is_reversal = 1`、未拆分复币及未消歧 `duplicate_conflict_group` 重号），统一执行目录转义 `/`→`%`、`\`→`@`、`|`→`$` 并做同批次转义后目录碰撞预检；
  - `internal_archive`（内部全量归档）：对历史容缺合同不因缺项阻断打包，无 `signed` 时回退保留最新 `contract_text`，并在 ZIP 根目录附带《缺口待补录清单.xlsx》。
- **公司 5 表月报修复**：`01_月度统计表` 修正表头合并至 `A1:R1` 并在标准报表摘要透出统计矩阵；`02_合同台账总表` 关联 `plan_item` 优先输出计划项目名称；`04_变更动态分表` 按最大变更次数动态扩列零截断；`05_招标项目清查表` 直连 `ct_procurement_record`，无记录时标 `待补录` 而非硬编码 `无`。

## 4. 接口与权限

- 新增专有权限码 `contract:migrate`（授予系统管理员角色，普通 `contract:import` 不自动包含）：所有 `legacy_tolerant`、`legacy_batch_upsert` 导入及历史红冲写入均在服务端强制校验 `contract:migrate`（或 `master:write` + `allOrgs`），普通合同 CRUD 忽略或拒绝客户端伪造的历史迁移标记。
- 组织与安全批量接口：`POST /api/org/import`（`master:write` + `allOrgs`，`preview | confirm` 拓扑建树与环检测）、`POST /api/security/users/batch-import`（`security:manage` + `allOrgs`，禁止向停用历史组织授予写范围，初始口令哈希存储并置 `must_change_password = 1`）。
- 业务设置与探活：新增 `contract.countersign_due_days`、`contract.archive_transfer_sla_days`、`contract.legal_review_categories` 配置项及 `POST /api/settings/business/test-pdf-parser`（`settings:manage`）。
- 合同前缀与同源分级预览：`GET/POST/PATCH /api/contracts/prefix-map`（读 `contract:read`，写 `master:write` + `allOrgs`）、`GET /api/contracts/next-no`、`GET /api/contracts/:id/payment-tier-preview`、`GET /api/contracts/:id/change-tier-preview`（读 `contract:read`，与提交校验完全同源）。
- 导入与导出扩展：`POST /api/contracts/imports` 放行 `.csv/.xlsx/.xls` 及 `importMode`；新增 `GET /api/contracts/imports` 批次历史与 `GET /api/contracts/imports/templates/:kind`（兼容 `/template/:kind`）8 类模板下载；监督预检与打包接口支持 `exportPurpose: 'supervision_submit' | 'internal_archive'`。
- 法审原件下载：`legalCatalogSource` 对无扩展名原件按 MIME/魔数补全 `.docx/.pdf/.doc` 后缀。

## 5. 页面与助手

- **组织管理与安全管理（`OrgManage` / `TreeNodePage` / `SecurityAdmin`）**：组织节点支持维护与展示 7 项扩展属性、区分直属分支与直属电站标签、配置化拦截外部主体误录，并提供组织树与用户组织范围两阶段批量导入弹窗。
- **业务参数设置（`SettingsBusiness`）**：提供分组筛选、法人组织多选器、法人上年净资产结构化明细表（缺配时顶部警示大额付款将按集团最高集体决策兜底）、节假日/调休日历面板及 PDF 解析服务连通性自检按钮。
- **综合计划执行（`PlanExecution`）**：支持 `.csv/.xlsx/.xls` 上传、三域分组切换 16 张工作表、折叠展示无项目编码与滞后年份表头提示，补齐 `批复概算`、`累计已付款`、`实际承办单位` 列、项目全景深链、标准空模板下载与执行表导出。
- **主数据与合同工作台（`MasterEntities` / `Contracts` / `ContractImport` / `ContractExportModal`）**：主数据页新增「合同编码前缀映射」页签；新建合同支持智能取号建议、禁用停用历史组织、绑定 `planItemId` 并阻断常规负金额；导入页支持 `.xls`、8 类模板下载、批次历史、按收支方向动态显示「已收/已付」及任务化待办标签；导出弹窗支持「正式监督报送 / 内部归档备份」切换并展示正文与招采就绪摘要；法审面板按 `legalReviewEnabled` 控显并支持 `.doc` 转码状态展示；保函小数比例正则、变更 `changeOrMode` 与依据分类过滤、结算附件 8 四列累计与合法负扣款/负净额阻断、服务端动态付款分级预览、农民工工资专户核对、全量 `<DatePicker>` 替代文本手输日期、事件 `detail` 渲染及标准报表/导出准确文案全部闭环。
- AI 助手继续只调用同源只读服务，不代执行导入确认、范本转正或业务写入。

## 6. 样本与完成条件（`AC-T13-01` ～ `AC-T13-11`）

| 验收 ID | 对应任务 | 可观察通过条件 |
|---|---|---|
| `AC-T13-01` | `GAP-05` | 独立工作树构建测试隔离，不动在线运行目录与生产库；前后端 `tsc`、`vitest`、`npm run typecheck:test` 零错误通过，前后端运行依赖已知高危/严重安全公告清零 |
| `AC-T13-02` | `GAP-01` | 空库与非空 `V72` 库平滑迁移至 `V73` 并通过外键检查与备份恢复演练；组织 6 列与冷启动主数据幂等初始化准确，直属电站与非电站直属分支解耦，外部主体零入 `org` |
| `AC-T13-03` | `GAP-02` | 组织树与多级用户数据范围支持两阶段预览/确认批量导入，环状父节点与停用历史组织写授权被拦截，`OrgScope` 即刻生效 |
| `AC-T13-04` | `GAP-03` | 业务参数支持结构化编辑（净资产表、组织多选、日历、PDF 探活）；配置法人上年净资产后付款审批按 `1%` 与固定上限孰低精确分级，未配时维持集体决策兜底 |
| `AC-T13-05` | `GAP-09` | 离线锁定 `xlsx@0.20.3`；16 表 `.xls`/`.xlsx` 无项目编码与滞后表头年份文件一次预览确认入库，小计行不重复累加，前端展示 16 表及概算/已付/承办列 |
| `AC-T13-06` | `GAP-11` | 移除硬编码单位码与电站名称正则；前缀映射与取号建议全走 `ct_prefix_org_map`，六维签约名义与历史承接主体时点冻结准确 |
| `AC-T13-07` | `GAP-12` | 多工作簿历史容缺导入受 `contract:migrate` 保护并保持 `409 PREVIEW_STALE` 乐观锁；同号异合同双记录保留、集团内部关联协议双视角建账、单价合同执行额入基线列不改原价、复币入子表、负向红冲受控入库、迁后新增变更/结算仍强检，五维行去向 100% 闭合且正逆序重跑幂等 |
| `AC-T13-08` | `GAP-13` | 合同导入放行 `.xls`、提供 8 模板下载与批次历史、收入合同显示「已收金额」；导出区分 `supervision_submit` 强拦截与 `internal_archive` 容缺归档附缺口清单 |
| `AC-T13-09` | `GAP-16` | 6 类业务合同触发法审，候选范本维持人工审定 `promote` 转正门禁，受限 `.doc` 正文在写事务外安全转码解析并缓存，法审原件下载自动补全扩展名 |
| `AC-T13-10` | `GAP-17` | 监督 ZIP 在报送模式严守盖章 `signed` 与每槽 1 件、零合并单元格，在归档模式回退保留 `contract_text`；目录统一按 `/→%`、`\→@`、`|→$` 转义并检测碰撞；月报 `01/02/04/05` 四处口径与截断缺陷修复 |
| `AC-T13-11` | `GAP-18` | 保函小数比例、合同非负金额与编辑锁组织、变更 `changeOrMode` 与依据过滤、结算允许合法负扣款但阻断负净额、4 列累计与同源付款分级预览、`DatePicker` 替代纯文本日期等 7 类前后端缺陷全部修复并通过单测与 E2E |
