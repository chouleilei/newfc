# 智能合同法审一期（T-9）开发详细计划

状态：2026-11-12 已完成 T-9.1～T-9.5 及 T-9.6 的工程实施与自动化验证，并包含八项评审修复发布至生产 V67。历史样本首批离线评估已完成，AC-CLR-09 完整业务验收待补齐。工程证据见 [验收记录](../docs/acceptance-records.md#t-9-智能合同法审一期2026-11-12)，备份及线上核验见 [生产发布记录](../docs/acceptance-records.md#t-9-生产发布2026-11-12)。

- **业务与验收唯一来源**：制度效力边界、AI 三态结论语义、审核规则范围及 `AC-CLR-01`～`AC-CLR-10` 通过条件以 [智能合同法审一期设计](contract-legal-review.md) 为准，本文不重复定义冲突规则。
- **本文职责**：给出可直接在新窗口按步执行的工程落地方案，包括 V67 数据库迁移、DTO 与 API 契约、受控资料离线种子提取、DOCX 原生解析与外部 PDF 接口预留、确定性规则编码、前后端改造清单及 `T-9.1`～`T-9.6` 小步交付计划。

---

## 0. 新窗口启动指引

在新窗口启动开发时，可直接发送以下指令：

> 请先阅读 `AGENTS.md`、`specs/contract-legal-review.md` 和 `specs/contract-legal-review-plan.md`，按 T-9.1 → T-9.6 顺序小步实施合同智能法审模块，每完成一个子阶段运行对应类型检查与聚焦测试并汇报。

开发全程必须遵守的硬性前置环境与边界：

1. **Node 版本固定**：执行任何构建/测试前先确认 `node -v` 为 `v24.22.1`，否则先执行 `export PATH=/root/.nvm/versions/node/v24.22.1/bin:$PATH`（禁止使用 `/usr/bin/node` v20）。
2. **数据库与事务安全**：测试只用内存库或临时目录文件库，严禁触碰运行库；解析、外部 PDF API、OCR 与模型请求一律在 SQLite 写事务外执行，落库使用短事务重验版本与内容指纹。
3. **金额与比率精度**：合同总价、分期金额、采购分级阈值比较统一使用 `backend/src/core/decimal.ts` 的 `bigint` 整数分，禁止 `number` 浮点运算；付款比例、违约金比率使用显式 scale 的缩放 `bigint`；可能超 `2^53` 的金额列查询开启 `.safeIntegers(true)`。
4. **受控原件隔离**：`docs/private/contract-legal-review/` 仅作本地离线核对与提取来源，服务端运行时不直接读取该目录，受控原件与未脱敏资料不入 Git。
5. **PDF 解析暂缓与接口预留**：文字版 PDF 解析后续由外部独立项目通过 HTTP API 提供；本期在系统设置与解析器中预留标准适配接口，优先跑通 **`.docx` 本地原生解析 + 扫描件现有 OCR**。外部 PDF 接口未配置时，上传 `.pdf` 按配置回退现有 OCR 或明确记录 `PDF_PARSER_UNCONFIGURED`（综合结论封顶 `manual_review`，绝不静默放行 `pass`）。

---

## 1. 总体工程架构与文件落位

在不新建第二套合同审批流的前提下，沿用现有 `ct_contract` → `ct_document` → `ct_review` → `ct_event` 闭环扩展：

| 层级 | 新增 / 修改文件 | 职责说明 |
|---|---|---|
| 共享契约 | `backend/src/contracts/project-contract.ts`（扩展）<br>`backend/src/contracts/contract-legal-review.ts`（新增） | 合同法审扩展字段、采购对象与自动计算的采购层级、证据子类型、制度/范本 DTO、法审运行与发现 DTO、Zod 校验 schema |
| 系统设置与 AI 渠道 | `backend/src/modules/settings/business-settings.ts`（扩展）<br>`backend/src/modules/settings/ai-channels.service.ts`（扩展）<br>`backend/src/assistant/model.ts`（扩展）<br>`frontend/src/pages/SettingsAi.tsx`（扩展） | 新增外部 PDF 解析配置项（支持受控内网 HTTP 地址校验，阻断云元数据 SSRF）；在 `AiFeature` / `AI_FEATURES` 新增 `contract_legal_review` 渠道绑定项（注：不误改 T-8 表单字典 `config-fields.ts`） |
| 路由权限守卫 | `backend/src/modules/security/route-rules.ts`（扩展）<br>`backend/src/modules/security/http.ts`（扩展） | 扩展 `RouteRule.permission` 支持 `Permission \| readonly Permission[] \| null`（任一权限满足即放行），供承办人与复核人共用触发接口 |
| 数据库迁移 | `backend/src/db/migrations.ts`（追加 V67）<br>`backend/src/db/migrations-contract-legal.ts`（新增） | 扩展 `ct_contract` / `ct_document` / `ct_review` 列，新建制度、范本、解析缓存、法审运行与发现表及只追加防篡改触发器 |
| 制度与范本库及发布 | `backend/src/modules/contracts/legal-catalog.service.ts`（新增）<br>`backend/src/modules/contracts/legal-seed-cli.ts`（新增）<br>`deploy/contract-legal-seed-v1.json`（新增）<br>`backend/package.json` & `scripts/deploy.sh`（扩展） | 制度条款与候选/正式范本的版本化发布、停用、候选转正、原件存取与检索；提供 `contract:legal:seed`（dist）与 `contract:legal:seed:dev` 幂等 CLI，并在 `deploy.sh` 迁移后执行幂等导入 |
| 文档解析适配 | `backend/src/modules/contracts/document-parser.ts`（新增） | `.docx` 基于 `jszip` 与 `saxes`（纯 JavaScript XML 校验）原生提取段落/表格与位置锚点；识别拦截旧版二进制 `.doc`；`.pdf` 预留外部 HTTP API 客户端并支持按 `sha256` 缓存及 OCR 降级；扫描图片沿用 `ocr-client.ts` |
| 确定性与比对引擎 | `backend/src/modules/contracts/legal-rules.ts`（新增）<br>`backend/src/modules/contracts/template-diff.ts`（新增） | 六组确定性规则（要素、整数分金额/大小写/分期比例、采购层级与签订依据、重要合同证据门禁、日期与未生效禁履行、编号/解除善后）及范本固定/默认/填写项比对 |
| 法审运行编排 | `backend/src/modules/contracts/legal-review-run.ts`（新增）<br>`backend/src/assistant/prompts.ts`（扩展） | 参照 `expense/audit-run.ts`，通过 `submitJob` 后台执行解析→规则→比对→长文本按锚点裁剪→模型结构化审查→引用与数字校验→短事务落库 |
| 合同服务与路由 | `backend/src/modules/contracts/contract.service.ts`（扩展）<br>`backend/src/modules/contracts/routes.ts`（扩展） | 签署前编辑解锁与非采购阻断适配、采购层级自动重算、`decideContractReview` 与 `computeBlockers` 双向指纹门禁、制度/范本及法审运行 API |
| 小澧助手集成 | `backend/src/assistant/domain-tools.ts`、`domain-facts.ts`（含 `DOMAIN_TOOL_NAMES`）、`service.ts`（含 `alignDomainToolArguments` 与 `domainNames`）、`contracts/page-catalog.ts`、`frontend/src/components/assistant/DomainFactView.tsx` | 按 T-8 统一工具契约新增只读工具 `contract_legal_review`（读取最新法审结论、摘要、阻断项与依据条款），遵循同源 `visibleContract` 组织裁剪 |
| 前端页面与 API | `frontend/src/api/projectContract.ts`（扩展）<br>`frontend/src/pages/project/Contracts.tsx`（扩展）<br>`frontend/src/pages/project/ContractLegalPanel.tsx`（新增） | 合同编辑扩展法审元数据与 `approval` 签署前纠错解锁、签订依据分类上传、通过合同域接口轮询法审进度、首屏“结论—摘要—商务要素—红线原文—一次确认/退回”面板及制度/范本管理抽屉 |

---

## 2. 数据库追加迁移（V67）详细设计

在 `backend/src/db/migrations.ts` 追加 `version: 67, name: 'contract_legal_review_v1'`（严禁修改 V1～V66 既有迁移）：

### 2.1 既有合同表扩展（全部带安全默认值，兼容历史数据与台账导入）

1. **`ct_contract` 新增列**：
   - `legal_category TEXT NOT NULL DEFAULT 'other' CHECK (legal_category IN ('goods_procurement','small_construction','tech_service','general_service','construction','income_sales','important_special','other'))`：法审合同大类（其中 `goods_procurement`、`small_construction` 一期默认启用智能法审；`tech_service` 支持试验运行）。
   - `party_role TEXT NOT NULL DEFAULT 'buyer' CHECK (party_role IN ('buyer','seller','employer','contractor','client','provider','other'))`：我方签约立场。
   - `signing_entity_level TEXT NOT NULL DEFAULT 'company' CHECK (signing_entity_level IN ('company','secondary_unit'))`：签约主体层级（公司名义 / 二级单位名义，对应 2026 合同办法第 6.3、7.1 条）。
   - `is_procurement INTEGER NOT NULL DEFAULT 1 CHECK (is_procurement IN (0,1))`：是否属于采购类合同。
   - `procurement_target TEXT CHECK (procurement_target IS NULL OR procurement_target IN ('construction','goods','service'))`：采购对象（采购类必填）。
   - `procurement_method TEXT CHECK (procurement_method IS NULL OR procurement_method IN ('public_tender','invited_tender','negotiation','inquiry','bidding','direct','direct_reimburse'))`：采购方式（含 ≤3 万元直接报账排除标记）。
   - `procurement_tier TEXT CHECK (procurement_tier IS NULL OR procurement_tier IN ('tier_1','tier_2','tier_3','exempt_small','non_procurement'))`：**服务端派生存储**，由 `is_procurement` + `procurement_target` + 当前金额整数分按 2026 采购办法自动算出，禁止客户端手填覆盖。
   - `is_important INTEGER NOT NULL DEFAULT 0 CHECK (is_important IN (0,1))`：是否属于重要合同（股权投资、资产置换/托管、借贷融资、对外担保、并购重组、合资合作等会自动置 1，也可人工勾选）。

2. **`ct_document` 新增列**：
   - 保持原 `doc_type` CHECK 兼容，新增 `evidence_kind TEXT CHECK (evidence_kind IS NULL OR evidence_kind IN ('procurement_scheme_approval','bid_award_approval','award_notice','evaluation_report','company_approval','client_written_offer','legal_opinion','triple_major_decision','tech_spec','safety_protocol','other'))`，用于精确匹配签订依据与重要合同材料，同时不破坏既有 `trg_ct_document_u/d` 只追加约束（由于旧记录不可改删，选错 `evidence_kind` 时通过补传新附件覆盖同 `evidence_kind` 最新记录生效）。

3. **`ct_review` 新增列**：
   - `legal_run_id INTEGER REFERENCES ct_legal_run(id)`：复核确认/退回时绑定的有效智能法审运行 ID（未启用智能法审的旧类型允许为 `NULL`）。
   - `override_high_risk INTEGER NOT NULL DEFAULT 0 CHECK (override_high_risk IN (0,1))`：是否存在人工例外确认记录。
   - 补充触发器 `trg_ct_review_legal_once`：当 `OLD.status <> 'submitted'` 时禁止修改 `legal_run_id` 与 `override_high_risk`，防止定论后篡改绑定运行记录。

### 2.2 新增制度、范本与法审运行表

1. **`ct_legal_policy` & `ct_legal_policy_clause`（制度版本与冻结条款）**：
   - `ct_legal_policy`：`id`、`code`（如 `L-QJ03-04-2026`、`L-QJ02-04-2026`、`XLZ-2025-03`）、`version`、`title`、`doc_no`、`effective_from`、`status ('active'|'retired')`、`retired_reason`、`retired_at`、`source_note`、`source_file_object_id`、`created_by_user_id`、`created_at`，`UNIQUE(code, version)`；配 `BEFORE DELETE` 触发器防止删除已被引用的历史版本（仅允许受控 `retire` 与挂载 `source_file_object_id`）。
   - `ct_legal_policy_clause`：`id`、`policy_id`、`clause_no`（如 `4.2.2`、`7.3`、`8.1`、`10.4`、`附件3`）、`chapter_title`、`clause_text`、`rule_tags_json`、`sort_order`，配 `BEFORE UPDATE/DELETE` 触发器严禁篡改。

2. **`ct_legal_template` & `ct_legal_template_clause`（合同范本版本与结构化条款）**：
   - `ct_legal_template`：`id`、`code`（`TPL-GOODS-2026`、`TPL-SMALL-CONST-2026`、`TPL-DAM-TECH-2026`）、`version`、`name`、`legal_category`、`approval_status ('candidate'|'official'|'retired')`（**关键边界**：未获企管/财务/法务签认前固定为 `'candidate'`，候选范本默认值偏离不冒充公司正式红线，也不支持基于未经确认的争议解决/默认值静默跳过提示）、`promoted_by_user_id`、`promoted_at`、`retired_reason`、`retired_at`、`source_file_object_id`、`notes`、`created_by_user_id`、`created_at`，`UNIQUE(code, version)`；配 `BEFORE DELETE` 触发器防止删除历史范本版本（仅允许 `candidate → official` 转正、`retire` 停用与挂载 `source_file_object_id`，条款调整一律发布新 `version`）。
   - `ct_legal_template_clause`：`id`、`template_id`、`clause_key`、`clause_no`、`title`、`tier ('fixed'|'default_ref'|'placeholder')`（固定条款 / 原稿默认参考值 / `【】` 项目填写项）、`standard_text`、`default_value_note`、`placeholder_keys_json`、`policy_clause_ref`、`sort_order`，同样加 `BEFORE UPDATE/DELETE` 冻结触发器。

3. **`ct_doc_parse_cache`（文档结构化解析缓存）**：
   - 按 `(file_sha256, parser_kind, parser_version)` 唯一缓存提取出的全文、段落数组（含段落序号/章节号/页码/表格单元格定位）与字符统计，避免重复调外部 PDF 接口或 OCR。

4. **`ct_legal_run` & `ct_legal_finding`（只追加智能法审运行与结构化发现）**：
   - `ct_legal_run`：
     - 绑定快照：`contract_id`、`document_id`、`document_sha256`、`contract_version`、`context_fingerprint`（对 `document_sha256` + 当前金额整数分/法审大类/立场/主体层级/采购层级/重要合同标记 + **各有效 `evidence_kind` 最新附件 `sha256` 排序集合**求 sha256，既保证关键依据变化立即失效，又避免补传无关过程附件误伤有效法审；不包含法审批准后补录的 `signDate` / `effectiveDate`，正式确认及推进履约时仍按最新日期和正文履行节点检查顺序）、`policy_refs_json`（本次命中的制度版本列表）、`template_id`（关联范本及快照 `template_approval_status`）、`job_id`。
     - 通道状态：`parse_channel ('docx_native'|'pdf_external_api'|'ocr_fallback'|'failed')`、`parse_status ('ok'|'degraded'|'unavailable'|'failed')`、`model_status ('ok'|'unavailable'|'invalid'|'failed'|'skipped')`。
     - 审核输出：`verdict ('pass'|'revise'|'manual_review')`、`risk_level ('high'|'medium'|'low'|'info')`、`summary_json`（3～5 条结构化意见摘要）、`elements_json`（提取的关键商务要素：甲乙方、标的、合同总价分值、大写金额、税率、分期付款比例、工期/交付期、质保期、违约金、争议解决方式）、`stats_json`、`created_by_user_id`、`created_at`。
   - `ct_legal_finding`：
     - `id`、`run_id`、`source ('rule'|'template_diff'|'parse_ocr'|'model')`、`code`、`severity ('high'|'medium'|'low'|'info')`、`blocking INTEGER NOT NULL CHECK (blocking IN (0,1))`、`title`、`message`、`location_ref`（如 `第5条第2款 / P18`）、`excerpt`（原文摘录）、`expected_text`（制度要求或范本默认值）、`suggested_text`（建议修改文本）、`policy_clause_id`、`template_clause_id`、`sort_order`。
   - `ct_legal_run` 与 `ct_legal_finding` 均加 `BEFORE UPDATE/DELETE` 触发器，确保审计留痕不可改删（`AC-CLR-08`）。

---

## 3. 文档解析与外部 PDF API 预留契约

### 3.1 `.docx` 本地原生解析（本期完整实现）

- 使用项目已安装的 `jszip`（严禁引入重量级原生二进制库），复用 `xlsx-guard.ts` 的 Zip 炸弹防护（条目数、解压总字节上限校验）。
- **旧版二进制 `.doc`（OLE2）显式拦截与防护**：历史原始合同常为旧版 `.doc`（魔数 `D0 CF 11 E0`），`jszip` 无法直接解析。对启用智能法审的合同上传 `doc_type = 'contract_text'` 时，若文件扩展名为 `.doc` 或检测到 OLE2 文件头，接口直接返回明确的 `400 VALIDATION_FAILED` 引导“请将合同另存为 `.docx` 或导出 `.pdf` 后上传”；同时 `document-parser.ts` 兜底识别历史存量 `.doc`，返回结构化发现 `LEGACY_DOC_UNSUPPORTED` 并强制 `verdict = 'manual_review'`，严禁抛出未捕获压缩包异常。
- 解析 `word/document.xml` 按文档流顺序读取 `<w:p>` 与 `<w:tbl>`：
  - 识别“第X条 / X.X / 附件X”层级锚点，记录每段 `index`、`heading`、`text`；
  - 提取表格行与单元格文本（用于核对价格明细、付款节点表、里程碑表）；
  - 检测未清理的修订标记（`<w:ins>` / `<w:del>`）、实际 `<w:comment>` 批注残留及未替换的 `【...】` 占位符。空批注部件及仅含内置分隔符的脚注/尾注部件不产生发现；真实附注保留人工核验提示，非法附属 XML 显式解析失败。

### 3.2 外部 PDF 解析接口预留（按用户计划留好标准插槽）

- 在 `business-settings.ts` 增加配置项：
  - `integration.pdf_parser_base_url`（默认空字符串；允许 `https:`、本机及显式受控私网 IP 的 `http:`；HTTP 主机仅接受 `localhost` 或经 `net.isIP` 确认的本机/私网 IP，DNS 所有结果也必须为本机/私网 IP；地址限制对 IPv4/IPv6 按真实 IP 类型判断，不把域名前缀视作 IP。拦截 `169.254.0.0/16` 等链路本地/云元数据地址，连接固定至已校验 IP 并拒绝重定向）
  - `integration.pdf_parser_api_key`（secret，默认 `null`）
  - `integration.pdf_parser_timeout_seconds`（默认 `60`，范围 `5～300`）
  - `integration.pdf_fallback_ocr`（boolean，默认 `true`：外部 PDF 接口未配置时若已配置 `integration.ocr_base_url`，允许回退 OCR；若均未配置则直接返回 `unavailable`）
- 预留 HTTP 协议（`POST {base_url}/parse-pdf`，`multipart/form-data` 上传 `file` 或传内容流，期望响应 `{ ok: true, pages: [{ pageNo, text, blocks?: [...] }], isScanned?: boolean }`，通过 Zod 校验响应）：
  - 当 `pdf_parser_base_url` 为空时，不报错崩溃，生成结构化发现 `PDF_PARSER_UNCONFIGURED`（或走 OCR 识别扫描件），若文本覆盖度不足以定位关键条款则强制 `verdict = 'manual_review'`。
  - 后续外部 PDF 解析项目上线后，只需在系统设置填入 URL 与密钥（或微调 `document-parser.ts` 中的响应映射适配器），无需改动数据库或上层法审逻辑。

---

## 4. 种子包、确定性规则、范本比对与三态门禁

### 4.1 离线提取制度与候选范本种子（`deploy/contract-legal-seed-v1.json`）

在开发 `T-9.2` 时，编写一次性离线核对脚本从 `docs/private/contract-legal-review/` 提取并人工校对生成仓库内的纯结构化种子文件（仅含制度条文与脱敏通用范本条款，不含任何历史合同敏感信息）：

1. **三部现行制度**：
   - `L-QJ03-04-2026`《澧水公司合同管理办法》（湘澧制〔2026〕17号）：重点收录第 4.2.2（一二级审查）、第 5 章（三类签订依据）、第 6.3/7.1/7.3（审签权限、法律意见、重要合同与“三重一大”）、第 7.2 与附件 3（合同编号单位码 `LS/CJ/JD/ZD/GD/QD/SX/CS/ZT/XM/LN/LJD/WQ/XL/YN/YF` 及类别码 `JG/SG/SJ/CW/TH/XF/QT`）、第 8.1（未签署或未生效前不得实质履行）、第 9 章（变更索赔边界）、第 10.4（解除情形及善后）。
   - `L-QJ02-04-2026`《澧水公司采购管理办法》（湘澧制〔2026〕20号）：收录施工（300 万 / 100 万）、货物（150 万 / 50 万）、服务（100 万 / 30 万）分级阈值、方案与定标审批层级、≤3 万元单一无后续服务直接报账边界。
   - `XLZ-2025-03`《澧水公司法律事务工作管理办法》（湘澧制〔2025〕3号）：收录重要经济合同 100% 法律审查、范本简易合同样本审查及七项法审审查要素。
2. **三份候选范本（`approval_status = 'candidate'`）**：
   - `TPL-GOODS-2026`（设备物资采购合同，一期首发）
   - `TPL-SMALL-CONST-2026`（小型维修改造施工合同，一期首发）
   - `TPL-DAM-TECH-2026`（大坝安全鉴定技术服务合同，二阶段试验样本，不作自动 `pass` 依据）
3. **生产与开发环境幂等种子导入**：
   - 在 `backend/package.json` 同时登记 `"contract:legal:seed": "node dist/modules/contracts/legal-seed-cli.js"` 与 `"contract:legal:seed:dev": "ts-node src/modules/contracts/legal-seed-cli.ts"`（对标 `expense:policy:import`）；
   - 在 `scripts/deploy.sh` 执行 `migrate-cli.js` 成功后，紧接执行 `NEWFC_DATA_DIR="$DATA_DIR" node dist.new/modules/contracts/legal-seed-cli.js`（按 `(code, version)` 幂等跳过已存在版本，绝不覆盖管理员已升版转正的 `official` 范本），确保生产上线后制度库即刻可用。

### 4.2 确定性规则清单（`legal-rules.ts`）

| 规则代码 | 检查逻辑（全部确定性执行，不依赖模型） | 命中等级与结论影响 |
|---|---|---|
| `LEGACY_DOC_UNSUPPORTED` | 存量合同正文为旧版二进制 `.doc`（OLE2）或其他不支持原生解析的格式 | `medium` → 强制 `manual_review` |
| `TEXT_EMPTY_OR_UNREADABLE` | 正文未解析出有效条款、外部 PDF 未配且无 OCR、或字数/章节严重残缺 | `medium` → 强制 `manual_review` |
| `PLACEHOLDER_UNFILLED` | 正文仍残留 `【填写】`、`【...】`、空白下划线占位或未接受的修订标记 | `high` → 阻断 `pass`（`revise`） |
| `OBSOLETE_LAW_BASIS` | 引用已废止的《中华人民共和国合同法》等旧法而非《中华人民共和国民法典》 | `high` → `revise` |
| `CONTRACT_NO_FORMAT` | 核对 `L-QJ03-04-2026` 附件 3 编码：单位码/类别码错误记 `medium` → `revise`；若仅末尾流水号留空待审签赋号则记 `low`/`info` 提醒签署前补齐，不误伤送审 | `medium`（`revise`）或 `info`（提醒） |
| `ESSENTIAL_CLAUSE_MISSING` | 缺失主体、标的、价款、履行期限、验收、违约、争议解决、解除及善后（第 10.4 条）、签署页等核心要素 | `high` → `revise` |
| `SUBSTANTIVE_PERF_BEFORE_EFFECTIVE` | 缺失“未签署或未生效前不得实质履行”或出现倒签/未生效先施工供货表述（违反第 8.1 条） | `high` → `revise` |
| `DISPUTE_DUAL_CONFLICT` | 争议解决同时保留“向仲裁委申请仲裁”与“向人民法院起诉”未择一删除，或机构名称含糊无效 | `high` → `revise` |
| `AMOUNT_UPPER_LOWER_MISMATCH` | 固定总价合同中，正文人民币大写转整数分与小写金额或合同当前金额整数分不一致记 `high` → `revise`；若识别为单价据实结算/暂估上限合同则核对暂估上限并记 `medium` → `manual_review` 供人工复核 | `high`（`revise`）或 `medium`（`manual_review`） |
| `PAYMENT_RATIO_SUM_INVALID` | 分期付款比例（缩放 `bigint`）合计不等于 100%，或分期金额之和不等于合同总价整数分 | `high` → `revise` |
| `TAX_INVOICE_UNCLEAR` | 含税价/不含税价、增值税率或发票开具类型未明确 | `medium` → `revise` |
| `PROCUREMENT_TIER_EVIDENCE_MISSING` | 采购类合同按自动计算的 `procurement_tier` 缺少采购审批/定标/成交通知等签订依据附件；非采购缺批准文件；销售服务缺书面邀约 | `high` → 阻断 `pass` |
| `SMALL_DIRECT_REIMBURSE_HINT` | 金额 ≤ `3_000_000n` 分（3 万元）且内容单一，提示核实是否按 2026 采购办法直接发票报账 | `info` → 不阻断，供经办核对 |
| `IMPORTANT_CONTRACT_GATE` | `is_important = 1`（或正文命中股权/担保/融资/并购/合资关键词）时，未同时上传 `legal_opinion` 与 `triple_major_decision` 附件 | `high` → 强制阻断 `pass`（缺件返回 `manual_review`/`revise`） |
| `DATE_SEQUENCE_CONFLICT` | 签订日期 > 生效日期 > 交付/完工日期 > 验收/质保期顺序倒置 | `high` → `revise` |
| `PARTY_SUPPLIER_MISMATCH` | 正文甲乙方名称与当前合同所属组织、选定供应商名称明显不一致 | `high` → `revise` |

### 4.3 范本比对与候选状态门禁（`template-diff.ts`）

- 范本选择优先使用同类别的正式版本：各编码取未停用的最高正式版本，唯一时选用；没有正式版本时才从候选中按相同方式选择。发布候选不改变正式基准及已绑定运行的有效性；存在多个正式编码无法唯一匹配时转人工，不退回候选。运行与有效性门禁共用同一选择逻辑。
- 按条款锚点将合同正文与所选类型的最新有效范本对齐：
  - `fixed` 固定条款被实质删改（如删除不得转包违法分包、删除廉政或解除善后核心义务）→ 记 `TEMPLATE_FIXED_DEVIATION`（`high`，阻断 `pass`）；
  - `default_ref` 默认参考值变化（如采购 95%/5% 改为预付 50%、3 年质保改为 6 个月、违约金上限下调）→ 记 `TEMPLATE_DEFAULT_CHANGED`（`medium`，首屏展示“原参考值 vs 当前值”）；
  - 纯标点、空格、序号格式差异归为 `low`/`info`，默认折叠不进首屏摘要（满足 `AC-CLR-03`）。
- **未核定范本与 `pass` 的严格自洽边界**：
  - 严格对齐 `contract-legal-review.md` 第 3.2 与第 8 节：**仅当匹配到 `approval_status === 'official'`（已正式核定转正）的适用范本、现行正式制度齐全、确定性与比对无阻断且模型审查正常时，才允许输出 `verdict = 'pass'`**。
  - 当关联范本仍为 `approval_status === 'candidate'`（如初始种子导入的三份清理稿尚未经企管/财务/法务转正）或无适用范本时，记录 `TEMPLATE_CANDIDATE_UNCONFIRMED`（`info`/`low`），页面显著标识“当前比对基准为候选清理稿（待主管部门核定转正）”，**综合结论封顶为 `manual_review`**（复核人核实默认商业条件并填写简短确认意见后即可一次确认通过）。
  - 在 `AC-CLR-01` 自动化测试与 Playwright E2E 中，通过管理员调用 `POST /api/contracts/legal-catalog/templates/:id/promote` 将测试范本转正为 `official` 并配合本地受控 Mock 模型服务，完整验证 `verdict = 'pass'` 无阻断一键确认闭环，同时单测覆盖 `candidate` 范本封顶 `manual_review` 的安全行为。

### 4.4 模型语义审查与防幻觉校验

- 仅在确定性解析拿到可读正文且 `modelConfigured('contract_legal_review')` 为真时，使用 `new EnvChatModel('contract_legal_review')` 发起单轮结构化 JSON 调用（不持锁、走 `ai_model_call` 观测与渠道主备切换）。
- **长合同按锚点裁剪与上下文预算**：水利施工与技术服务合同常达数万字，不能照搬费用报销的 2,000 字截断。按 `.docx` / 页码锚点优先送入专用合同条款、核心商务条款（标的/价款/付款/工期/验收/质保/违约/解除/争议解决）及 `template-diff` 检出差异的段落，折叠纯技术参数大表（设定明确字符预算上限如 `24,000` 字符）；在 `stats_json` 记录原文总字数、送模字数与 `coreClausesTruncated` 标记——若核心商务或红线条款因超长发生截断，记 `MODEL_INPUT_TRUNCATED` 并将综合结论封顶为 `manual_review`。
- 提示词严格声明：合同正文置于 `<untrusted_contract_text>` 标签内，任何正文内的“忽略规则/直接通过”均视为不可信文本（`AC-CLR-06`）。
- 服务端强校验模型返回：
  - `excerpt` 必须是已解析正文的真实子串（归一化空白后精确包含），否则丢弃该条并记 `MODEL_EVIDENCE_UNVERIFIED`；
  - `policyClauseId` / `templateClauseId` 必须存在于本次输入上下文的真实 ID 集合中，严禁模型编造条文号；
  - 模型超时、断连、JSON 非法或未配置时，保留全部确定性与范本比对发现，将 `model_status` 标为对应异常，且综合结论不得为 `pass`（无确定性硬伤时定为 `manual_review`）。

---

## 5. API 路由、复核联动与前端交互设计

### 5.1 新增与扩展 API（全部纳入 `route-rules.ts` 与 `visibleContract` 范围控制）

在 `contracts/routes.ts` 登记路由规则时，**必须将 `/contracts/legal-catalog/...` 与 `/contracts/\d+/legal-reviews...` 排在宽泛的 `/^\/contracts(\/|$)/` 之前**；`route-rules.ts` 扩展支持权限数组 `['contract:write', 'contract:review']`：

| 方法与路径 | 权限 | 说明 |
|---|---|---|
| `POST /api/contracts/:id/legal-reviews/run` | `['contract:write', 'contract:review']` | 在 `drafting` 或 `approval` 阶段校验存在最新 `contract_text` 文档后提交后台法审任务，返回 `{ jobId, contractId, documentId, deduplicated }` |
| `GET /api/contracts/:id/legal-reviews` | `contract:read` | 列出历史法审运行摘要、最新运行 `isCurrent` 状态，以及**当前活跃运行任务摘要 `activeJob`**（前端统一轮询本接口而非 `/api/jobs/:id`，避免承办人触发后复核人跨账号轮询遇到他人任务 404） |
| `GET /api/contracts/:id/legal-reviews/:runId` | `contract:read` | 获取单次法审完整详情（结论、风险等级、3～5 条摘要、关键商务要素、红线发现与折叠建议、命中制度与范本版本） |
| `GET /api/contracts/legal-catalog/policies` | `contract:read` | 查看制度版本及条款明细 |
| `POST /api/contracts/legal-catalog/policies` | `knowledge:manage`（`allOrgs: true`） | 发布新版本制度依据 |
| `POST /api/contracts/legal-catalog/policies/:id/retire` | `knowledge:manage`（`allOrgs: true`） | 停用旧版制度依据（历史已绑定法审运行仍可追溯） |
| `POST /api/contracts/legal-catalog/policies/:id/source` | `knowledge:manage`（`allOrgs: true`） | 上传关联制度正式受控原件 |
| `GET /api/contracts/legal-catalog/policies/:id/source` | `contract:read` | 下载已上传的制度原件（审计记录并校验登录权限） |
| `GET /api/contracts/legal-catalog/templates` | `contract:read` | 查看合同范本列表与条款分层明细 |
| `POST /api/contracts/legal-catalog/templates` | `knowledge:manage`（`allOrgs: true`） | 发布候选或正式范本新版本 |
| `POST /api/contracts/legal-catalog/templates/:id/promote` | `knowledge:manage`（`allOrgs: true`） | 将经主管部门核定的 `candidate` 范本转正为 `official`（写入审计日志与核定说明，不篡改条款内容） |
| `POST /api/contracts/legal-catalog/templates/:id/retire` | `knowledge:manage`（`allOrgs: true`） | 停用旧版合同范本 |
| `POST /api/contracts/legal-catalog/templates/:id/source` | `knowledge:manage`（`allOrgs: true`） | 上传范本清理/标准原件 |
| `GET /api/contracts/legal-catalog/templates/:id/source` | `contract:read` | 下载已上传的范本原件 |

- **后台任务并发去重避坑**：`app_job` 的唯一索引 `idx_app_job_idem(kind, created_by, idempotency_key)` 对已失败/中断的历史任务同样永久生效。因此 `submitJob` **传 `idempotencyKey: null`**，改在 `legal-review-run.ts` 业务层查询是否存在 `status IN ('queued','running')` 且同 `(contract_id, context_fingerprint)` 的活跃任务实现幂等复用，确保外部 PDF / 模型偶发超时失败后同一用户可随时重新触发法审。

### 5.2 与现有 `submitContractReview` / `decideContractReview` 的无缝衔接

- **保持旧类型兼容**：未启用智能法审的普通历史/其他合同类型，原有 `submitContractReview` 与 `decideContractReview` 契约完全不变，确保既有 980+ 后端测试零破坏。
- **生命周期阶段编辑与推进门禁对齐（解决 `approval` 阶段锁死矛盾）**：
  1. **支持起草预审与签署前纠错**：法审可在 `drafting`（预审）与 `approval`（正式送审）阶段触发。在合同进入 `performance` 之前且尚未上传 `signed` 签署件（且当前无未失效的 `approved` 审核，或原审核已退回/需重审）时，放开 `updateContract` 与前端 `Contracts.tsx` 对 `originalAmount`、`supplierId` 及法审元数据的修改限制——一旦修改，`version` 递增且 `context_fingerprint` 变化，旧法审与旧批准自动失效，打通“法审发现金额/主体不一致 → 修正台账或重传正文 → 重新法审”的完整闭环。
  2. **非采购类合同阶段阻断适配**：在 `computeBlockers` 中，当 `is_procurement = 0`（如行政移交协议、非采购服务或 `income_sales` 销售合同）时，`procurement` 阶段不再硬阻断要求 `doc_type = 'procurement'`，改在 `approval` 阶段按法审规则核验批准文件或相对方书面邀约。
- **启用智能法审的合同类型**（一期默认 `goods_procurement`、`small_construction`，以及 `is_important = 1` 或已显式触发法审的合同）：
  - `decideContractReview(..., { decision: 'approve' })` 必须在同一 `immediate` 写事务内校验：① 最新 `ct_legal_run` 绑定的 `document_id` 等于 `ct_review.document_id` 且等于当前最新 `contract_text`；② `context_fingerprint` 与当前合同金额、重要合同标记、关联依据附件一致（换文或改金额后返回 409 `LEGAL_REVIEW_STALE`）；③ 若 `verdict !== 'pass'` 或存在 `high` 风险 / `manual_review`，必须校验允许例外与否：属于法定硬阻断（如重要合同缺法律意见或“三重一大”、未生效实质履行、大小写金额不符）直接拒绝批准；属于候选默认值偏离或待人工补核项，复核人必须填写非空 `comment`（人工核验说明）方可确认，并置 `override_high_risk = 1` 写入审计事件。
  - **`computeBlockers`（`approval → performance`）同步校验**：推进到 `performance` 前，若当前合同属于启用智能法审的类型或 `is_important = 1`，除了核对 `latestText.id === approved.document_id` 外，还必须核对最新 `approved` 的 `ct_review.legal_run_id` 非空且对应 `ct_legal_run.context_fingerprint` 与当前合同实时指纹一致；否则产出 `LEGAL_REVIEW_OUTDATED` 阻断推进，防止“先按普通类型审批通过、再改法审类型/重要标记绕过法审”的漏洞。

### 5.3 前端 `Contracts.tsx` 交互闭环

- **不新增一级菜单**：在现有“项目与合同 → 合同台账”详情弹窗/抽屉内升级“审批签署”与文档区，顶部工具栏增加“法审制度与范本”抽屉入口。
- 合同详情返回服务端派生的 `legalReviewEnabled`（默认法审类别、重要合同或已有法审任务/运行），前端用此状态判断签署前纠错条件，不依赖正式复核是否已绑定运行。前端仅以 `import type` 引用后端法审契约，枚举展示及采购层级预览保留在前端；采购层级以服务端结果为准。
- 签订依据分类只属于附件；合同台账不展示无对应 DTO 字段的分类列。上传成功、切换文档类型或合同后清空所选依据分类，防止无关附件成为有效依据的新版本。
- **承办人视角**：新建/编辑合同时选择法审大类、我方立场、签约主体层级、采购对象与方式（界面实时回显系统算出的“一/二/三级采购”及所需签订依据清单）；上传 `.docx` 正文与对应依据文件后点击“启动智能法审”。
- **复核人首屏视角（严格贴合 `contract-legal-review.md` 第 3.1 节）**：
  1. **顶部结论条**：`建议通过 / 建议修改后重审 / 需补充人工审查` 徽标 + 风险等级 + 绑定的制度/范本版本标签（若为候选范本显式提示）；
  2. **3～5 条核心意见摘要**与**关键商务要素卡片**（甲乙方、大小写金额、付款节点、工期、质保、违约、争议解决）；
  3. **红线与实质偏离列表**（默认展开，点击展示原文位置、摘录、制度/范本依据与建议修改措辞）；
  4. **普通低风险/措辞建议**（默认折叠收起，不干扰首屏决策）；
  5. **底部一次操作栏**：无阻断项时复核人一键“确认通过”；有阻断或退回需求时一键“退回修改”（自动带入主要问题摘要供编辑）。

---

## 6. 分步实施拆解（T-9.1 ～ T-9.6）

每个子阶段独立小步提交，提交信息注明 `F16, T-9.x, AC-CLR-xx`：

| 子阶段 | 核心交付内容 | 完成与验证门禁 |
|---|---|---|
| **T-9.1 契约、设置、权限扩展与 V67 迁移** | 完成 `contracts/contract-legal-review.ts`、扩展 `project-contract.ts`、`business-settings.ts`（含受控内网 URL 校验与 SSRF 防护）、`AiFeature` 枚举（`model.ts` / `ai-channels.service.ts`）及 `route-rules.ts` 多权限数组支持；实现 V67 迁移与防篡改触发器、采购层级自动计算函数 | `cd backend && npx tsc --noEmit`；迁移与触发器防篡改测试、`RouteRule` 数组权限单测、内网 PDF 地址校验与 SSRF 拦截测试、采购分级阈值边界测试（含 `299,999,999n` vs `300,000,000n` 分）全部通过 |
| **T-9.2 离线种子包与制度/范本服务** | 提取校对 `deploy/contract-legal-seed-v1.json`，实现 `legal-catalog.service.ts`（含 `promote` 转正、`retire`、`source` 原件存取）与 `legal-seed-cli.ts`，同步 `package.json` 双脚本及 `scripts/deploy.sh` 幂等种子步骤 | 幂等导入测试（不覆盖已转正 `official` 范本）、`candidate → official` 转正与审计测试、条款不可改删触发器测试、原件下载与跨组织权限测试通过 |
| **T-9.3 文档解析器与确定性/范本引擎** | 实现 `.docx` 原生解析器、旧版 `.doc`（OLE2）显式拦截与兜底、外部 PDF HTTP 适配桩 + OCR 降级、中文大写金额转 `bigint` 分解析器、`legal-rules.ts`（含单价合同与待赋流水号细分边界）及 `template-diff.ts`（含 `candidate` 封顶 `manual_review` 门禁） | 覆盖正常采购/施工 `.docx`、旧版 `.doc` 拦截、占位符残留、大小写金额差 1 分、单价合同区分、付款比例异常、双争议解决冲突、重要合同缺件、`candidate` vs `official` 结论门禁、PDF 未配置降级等单测全部通过 |
| **T-9.4 后台法审编排、生命周期解锁与复核门禁** | 实现 `legal-review-run.ts`（业务层活跃任务去重、长合同按锚点裁剪与截断留痕、模型子串/条款 ID 强校验），改造 `contract.service.ts`（`drafting/approval` 签署前纠错解锁、非采购阶段适配、`decideContractReview` 与 `computeBlockers` 双向指纹校验）及 `routes.ts` 全部端点 | 集成测试（配合本地受控 Mock 模型服务）验证：`official` 范本 `pass` 一键确认、失败任务可重跑、跨用户通过 `legal-reviews` 查询活跃任务不报 404、`approval` 阶段改金额/换文/改法审类型触发 `409 LEGAL_REVIEW_STALE` 及 `computeBlockers` 拦截、提示词注入防御 |
| **T-9.5 前端合同法审面板与小澧助手接入** | 扩展 `frontend/src/api/projectContract.ts`、`SettingsAi.tsx`、`Contracts.tsx` 与 `ContractLegalPanel.tsx` 首屏闭环及制度/范本转正与原件管理界面；按 T-8 全链路（`domain-tools.ts` / `domain-facts.ts` / `service.ts` / `page-catalog.ts` / `DomainFactView.tsx`）接入只读工具 `contract_legal_review` | `cd backend && npx tsc --noEmit && npx vitest run`（含 `t8-tool-contract.test.ts` 与 `page-capabilities.contract.test.ts` 全绿）；`cd frontend && npx vitest run && npx tsc -b`；新增前端测试覆盖签署前纠错、首屏展示与一次确认/退回 |
| **T-9.6 历史样本评估、E2E 与全量验收收口** | 用脱敏样本及公路移交协议（`06→07→08`）验证规则与差异检出并生成评估记录；编写 Playwright E2E（含测试范本转正 + 受控 Mock 模型跑通 `AC-CLR-01` 一键确认及阻断分支）并加入 `playwright.config.ts`；执行临时库迁移、种子幂等导入与备份恢复演练，更新 `docs/acceptance-records.md` 与 `coverage-matrix.md` | 前后端全量测试 + 类型检查 + 独立构建 + 新增 E2E 全部通过；逐项核销 `AC-CLR-01`～`10` 证据并如实标注生产候选范本待主管部门转正及样本覆盖边界 |

---

## 7. 验收核对清单（对应 AC-CLR-01 ～ AC-CLR-10）

- [x] **AC-CLR-01 标准采购合同**：合规采购 `.docx` + 采购签订依据 → 给出结论、摘要与商务要素 → 复核人一次点击完成 `ct_review` 确认。
  - 注：验证 `verdict = 'pass'` 一键确认时须绑定经 `promote` 转正的 `official` 范本与受控模型响应；未转正 `candidate` 范本验证封顶 `manual_review` 并填写核验意见确认。
- [x] **AC-CLR-02 要素缺失与金额不一致**：缺必备条款、留有 `【】`、大小写差 `0.01` 元、付款比例合计异常均定位原文并阻断 `pass`；`bigint` 计算无浮点误差。
- [x] **AC-CLR-03 范本实质修改**：付款比例、质保期、违约责任等偏离在首屏展示“参考值 vs 当前值 + 依据”；纯措辞/标点变化折叠不占首屏。
- [x] **AC-CLR-04 高风险与重要合同**：高风险阻断自动通过；重要合同缺 `legal_opinion` 或 `triple_major_decision` 明确阻断，不允许无依据放行。
- [x] **AC-CLR-05 换文与并发**：重传正文、修改合同关键要素、重复点击确认或任务运行中换文，旧结论自动失效（`LEGAL_REVIEW_STALE`）。
- [x] **AC-CLR-06 PDF 未接入 / OCR / 模型失败**：外部 PDF API 未配、OCR 失败、模型超时或输出幻觉引用时，保留确定性规则发现并标为 `manual_review`，绝不伪造通过。
- [x] **AC-CLR-07 权限与复核分离**：跨组织合同法审结果、正文下载、助手查询均返回 404；同人复核按现有例外规则强校验；制度/范本写入仅限授权管理员。
- [x] **AC-CLR-08 审核留痕**：运行、发现、制度/范本版本、正文 sha256、摘要与人工复核事件只追加不可改删。
- [ ] **AC-CLR-09 历史样本验证**：基于公路移交协议三版配对链及采购/施工/服务脱敏文本记录真实命中、误报与可采纳情况；未取得正式法审意见配对的类型如实登记边界。
- [x] **AC-CLR-10 回归与发布**：既有合同生命周期、合同导入、费用审核回归通过；临时库 V66→V67 迁移与备份恢复校验通过。2026-11-12 正式部署脚本全量测试、构建、完整备份、显式 V67 迁移及候选种子导入通过，本机与公网就绪、数据库及备份完整性检查通过。


## 8. 本次交付与复验入口（2026-11-12）

- T-9.1～T-9.5：V67、设置与渠道、权限、离线种子与版本库、解析/规则/比对、后台编排、双向指纹门禁、页面及只读助手均已实现。
- T-9.6：临时库迁移/备份恢复、前后端回归、独立构建和浏览器验收证据集中记入验收记录；历史评估见 [8 份样本评估](../docs/contract-legal-sample-evaluation.md)。AC-CLR-09 不以文本差异检出冒充完整法律业务验收；AC-CLR-10 的生产发布与线上核验已完成，三份生产种子范本保持 candidate。
- 专项测试：`backend/tests/t9-legal-{core,adapters,integration}.test.ts`、`frontend/src/pages/project/ContractLegalPanel.test.tsx`；浏览器 `frontend/tests/e2e/contract-legal.spec.ts`，并回归 `project-contract.spec.ts`。
- 独立浏览器配置 `frontend/playwright.contract-legal.config.ts` 仅使用 `/tmp/newfc-t9-e2e-*` 和 3764 端口，退出后清理测试目录。复验前用 Node 24.22.1，在 backend 执行 `npx tsc --outDir .t9-dist --noEmitOnError`，在 frontend 执行 `npx tsc -b && npx vite build --outDir /tmp/newfc-t9-frontend --emptyOutDir`，随后 `npx playwright test --config playwright.contract-legal.config.ts`。
- 正式部署仍走 `scripts/deploy.sh`；它先测试和构建、备份并显式迁移，再幂等导入结构化制度/候选范本。种子重跑不覆盖已转正版本，不在服务启动时读取受控原件。
