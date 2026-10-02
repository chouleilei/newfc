# 验收记录

公开版说明：历史内部 QA 原件保留在维护者本地，链接统一指向 [QA 材料说明](qa/README.md)。公开发布检查见 [公开版验收摘要](public-release.md)。

格式与判定规则见 [specs/acceptance.md](../specs/acceptance.md)。结果只有：通过 / 失败 / 未执行。未列出的验收 ID 均为未执行。

## T-0 独立源码与运行基线

| 项 | 内容 |
|---|---|
| 任务/验收 | T-0；AC-X01、AC-X02、AC-F02 |
| 环境 | Node 24.21.0，better-sqlite3 12.11.1（ABI 137），SQLite 3.53.2，Linux 6.12 x86_64，4 vCPU / 7.9 GiB |
| 来源 | newbd `c67f6c4336956d64673be5f65a4c63d570ade593`，清单见 docs/source-provenance.md |

| 验收 ID | 执行方式 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| AC-X02 继承基线 | 在 /root/newfc 内 `npm ci` 后运行未修改快照的测试 | 继承核心测试通过 | 后端 55 文件/768 项通过；前端 35 文件/405 项通过；`tsc -b` 通过 | 通过 |
| AC-X02 适配后 | 适配提交后后端全量 | 全部通过 | 56 文件/775 项通过 | 通过 |
| AC-F02 | `tests/newfc-baseline.test.ts` + 构建产物实机启动（端口 3769，临时数据目录） | 无外部中间件启动；live 200；ready 200 且 schema 最新；库关闭时 ready 503、live 200；无模型也就绪 | 与预期一致；实机 `ready` 返回 V38，SPA 200，未登录 API 401 | 通过 |
| AC-X01 | 同上测试 + 实机启动 | 独立 .git（无 remote）、独立配置/端口/库/数据目录；运行文件不引用原项目路径 | 测试通过；实机数据只写入临时目录（newfc.sqlite/WAL/SHM、cleaning-uploads） | 通过 |
| AC-X08（部分） | 已初始化旧 schema + `autoMigrate:false` | 拒绝启动且不改库 | 与预期一致 | 部分通过（回退演练待阶段 6） |

资源首测（空库，编译产物，冷启动后 3 次就绪请求）：RSS 约 97 MiB。SIGTERM 后正常关闭数据库退出。

## T-1 首个业务闭环的共同基础

| 项 | 内容 |
|---|---|
| 任务/验收 | T-1；AC-F01、AC-F24、AC-F25、AC-F21、AC-F07、AC-F23 基础场景；AC-X04 本阶段范围；AC-X03 金额契约部分 |
| 环境 | 同 T-0；schema V41（V39 身份与审计、V40 任务与模型调用、V41 主数据与业务设置） |
| 数据 | 全部测试用临时目录 SQLite（`os.tmpdir()`），E2E 用 `backend/data/finance-e2e`、`backend/data/e2e-simulation` 可丢弃库；未触碰 newbd/lishui 运行目录 |

| 验收 ID | 执行方式 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| AC-F01 | `backend/tests/security.test.ts`（真实 HTTP + Cookie + CSRF）；E2E `auth-session.spec.ts` | 未初始化给出指引；HttpOnly+SameSite=Strict；登出/停用即失效；重启会话保持；错误口令 401 且审计不含口令；连续失败 429；缺失/伪造 CSRF 与跨站 Origin 拒绝 | 与预期一致；E2E 界面登录→首页→登出后 `/api/auth/session` 401，Cookie 脚本不可读、localStorage 无令牌 | 通过 |
| AC-F24 | 同上 + `SecurityAdmin` 页面 + `master-settings.test.ts` | 角色/用户/组织授权 CRUD；内置 admin 锁定、最后管理员保护；口令重置强制改口令；授权对 API 生效（403 FORBIDDEN / ROUTE_NOT_AUTHORIZED / SCOPE_RESTRICTED / 范围外 404）；侧栏按权限裁剪 | 与预期一致；`/api/org/tree`、`/api/master/projects`、解析预览按组织范围裁剪；集团口径接口对受限用户明确返回 SCOPE_RESTRICTED | 基础通过（预算/看板/下载/助手工具按范围裁剪在 T-2 完成） |
| AC-F25 | `security.test.ts`、`jobs-observability.test.ts`、`master-settings.test.ts` | 审计记录操作人、对象、结果、来源、request_id；日志与响应不含口令/密钥；`/api/logs` 按对象/操作人/结果/请求/时间过滤 | 与预期一致；错误响应带 requestId 可回查审计 | 通过（后续领域逐域追加动作） |
| AC-F21 | `jobs-observability.test.ts`；E2E `platform-admin.spec.ts`（任务中心） | 成功/失败/取消/中断可区分；重启后 queued/running 标记 interrupted（SERVICE_RESTARTED）；并发有界；幂等键去重；他人任务 404；模型调用只记规模/耗时/错误分类，不存提示词/回答/密钥；token 优先供应商 usage，缺失时估算并标记；保留期清理只删已结束超期任务 | 与预期一致 | 基础通过（各领域重任务接入任务执行器时逐域补场景） |
| AC-F07 | `master-settings.test.ts`；E2E `platform-admin.spec.ts` | 项目/供应商 CRUD，编码不可改；供应商名称归一查重；映射变更 = 退役旧行 + 新增行，按 asOf 复现历史口径；目标改名/停用不改写历史解析；解析顺序与 ambiguous 明确；受限用户映射写入 SCOPE_RESTRICTED、预览不泄露范围外对象 | 与预期一致 | 基础通过（EAS/合同/费用导入接入解析器时逐域验证） |
| AC-F23 | `master-settings.test.ts`；E2E `platform-admin.spec.ts` | 仅登记键可保存，Dify/DB-GPT 等旧平台键 UNKNOWN_SETTING；整批校验，任一不合法全部不写；URL 仅 https/本机 http 且不含账号口令；凭据只写不读（末 4 位预览），响应/审计/页面不含明文；无 settings 权限 403 | 与预期一致；模型渠道沿用继承的 AI 渠道设置 | 基础通过（领域设置随阶段追加键） |
| AC-X04（本阶段） | 上述测试汇总 | 未登录 401、无权限 403、跨组织 404/SCOPE_RESTRICTED、停用用户、CSRF、后台重新授权（角色变更下一请求即生效；排队任务执行前按当前库重新授权，停用/失去权限/失去组织范围 → AUTH_REVOKED 且不执行任务体） | 与预期一致 | 本阶段通过 |
| AC-X03（部分） | `decimal-contract.test.ts`，docs/money-contract.md | 十进制字符串解析/格式化、舍入模式、64 位边界与超限拒绝、分摊守恒、比率分母为零为 null；SQLite int64 往返 safeIntegers 无损 | 与预期一致；实测 better-sqlite3 默认模式超 2^53 静默失真，契约要求 safeIntegers | 部分通过（样本金额对照在 T-2/各域） |

测试汇总：后端 60 文件/816 项通过（`tsc --noEmit` 与测试 tsconfig 均通过）；前端 35 文件/410 项通过、`tsc -b` 通过；E2E simulation 项目 18/18 通过，finance 项目 50/50 通过（含 auth-session、platform-admin）。

继承变化：`ACCESS_PASSWORD`/`x-access-token`/`DISABLE_AUTH` 访问口令机制删除，改为用户会话；E2E 与种子脚本改用 `admin:create` 初始化的可丢弃账号。初始化与恢复见 docs/operations-runbook.md「初始化管理员与账号恢复」。

## T-2 预算导入 → 页面汇总 → 同源 AI 查询

| 项 | 内容 |
|---|---|
| 任务/验收 | T-2；AC-F08、AC-F03、AC-F20；AC-X03（预算样本）、AC-X04（预算/看板/下载/助手范围）、AC-X05、AC-X06、AC-X09（资源基线，OPEN-04） |
| 环境 | 同 T-0；schema V43（V42 助手会话/动作/洞察归属 `owner_user_id`；V43 导入预览创建人 `import_batch.created_by_user_id`） |
| 数据 | 测试全部用临时目录 SQLite；资源基线用临时数据目录 + 构建产物独立端口 3763，结束即删除；未触碰 newbd/lishui 运行目录 |

### 固定样本与期望（`backend/tests/t2-budget-loop.test.ts`）

2026 年，集团 → 华东 → 上海/杭州/南京；标准预算模板（元）：

| 组织 | I01 收入 | C0101 成本 | E01 管理费用 | E02 销售费用 | Q01 销量（数量） |
|---|---|---|---|---|---|
| 上海 | 1,234,567.89 | 600,000.01 | 0.00（显式零） | — | 12.5 |
| 杭州 | 500,000.00 | — | — | 99,999.99 | 3 |
| 南京 | 文件中缺失 | | | | |

期望（分；利润方向带符号，收入正、成本费用负）：上海收入 123456789；集团收入 173456789；集团成本 -60000001；集团费用 -9999999；华东 = 上海 + 杭州；销量按万分之一存 155000（集团），`budgetCents` 为 0，不进入任何金额合计；上海 E01 为显式 0 的事实，南京没有任何事实行（缺失 ≠ 零）。期望值由样本手工计算，不取旧程序输出。

| 验收 ID | 执行方式 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| AC-F08 | `t2-budget-loop.test.ts` 用例 1、2 | 预览与正式导入逐格一致；事实可定位批次（批次 sha256 与原件字节一致）；组织/集团汇总无重复累计、符号/单位/舍入正确；数量不混入金额；缺失与零区分 | 与预期一致 | 通过 |
| AC-X03（预算样本） | 同上 + `decimal-contract.test.ts` | 样本金额逐分精确一致，含正/零/缺失/两位小数舍入边界 | 与预期一致 | 通过（其他域样本随各阶段） |
| AC-X05 | `t2-budget-loop.test.ts` 用例 2 | 重复确认 409 且不重复计入；预览后版本变化 409 且批次作废；写入中途失败（临时触发器注入）整批回滚无半批事实；回滚恢复上一版本；预览绑定操作者，他人确认或取消返回 409 PREVIEW_OWNER_MISMATCH 且预览保持待确认 | 与预期一致。执行中发现：确认失败自动取消预览的逻辑会让他人作废别人的预览，已改为取消同样核对创建人 | 通过（后续导入域复用同一批次机制） |
| AC-F03（本阶段） | `dashboard-overview.test.ts`、`assistant-scope.test.ts`「工作台」、E2E `scope-restricted.spec.ts` | 空库如实显示无草稿/无待采用/无快照；受限账号的组织数与结构问题只计授权范围，不返回全局操作日志（`scopeLimited`），页面给出说明而不是空白；初始化指引对无写权限或部分组织授权的账号只显示进度、不给维护入口 | 与预期一致。E2E 发现指引曾向只读受限账号提供「创建预算版本」等入口，已修正 | 基础通过（跨域卡片随阶段 3～6 补齐） |
| AC-F20（本阶段） | `t2-budget-loop.test.ts` 用例 3、5～7；`assistant-scope.test.ts`；继承用例 `assistant-crossyear.test.ts`（跨年度追问）、`assistant.routing.test.ts`（空正文兜底）、`assistant-context-v2.integration.test.ts`（会话追问） | 页面接口、工具、问答对同一受限用户给出同一数字（上海 123456789，集团 173456789 不出现）并带引用；未点名组织时取唯一授权根并在解析说明中写明；点名范围外组织 404；模型未配置/超时/5xx/并发已满均降级规则查询且事实相同，如实标注模型错误 | 与预期一致 | 基础通过（新领域工具逐域接入） |
| AC-X04（T-2 范围） | `assistant-scope.test.ts`（7 项）、`t2-budget-loop.test.ts` 用例 7、`security.test.ts`、前端 `App.test.ts`、E2E `scope-restricted.spec.ts` | 页面、API、下载、助手工具使用同一 AuthContext：范围外组织 404，集团口径 403 SCOPE_RESTRICTED，多授权根未指定 400 SCOPE_REQUIRED；模型伪造工具参数被拒且回答不含范围外数字；受限用户看不到无权工具；会话/动作/洞察按创建人隔离；预算写入类动作需 budget:write + 全组织，确认与下载前按当前授权复核（用户被移到杭州后原动作 404）；侧栏隐藏集团口径入口 | 与预期一致 | 本阶段通过 |
| AC-X06 | `t2-budget-loop.test.ts` 用例 5～7 | 页面/工具范围与事实一致；模型失败或无数据明确说明，不伪造完成率；非法工具参数不执行；模型不能直接写入（写操作只生成待确认动作） | 与预期一致 | 通过（本闭环范围） |
| AC-X09（基线） | `npm run resource:baseline`（见下） | 固定负载下记录全部指标并满足 OPEN-04 门槛；重任务并发有界；超限明确；导入期间普通查询与任务进度可用 | 全部指标在门槛内，见下表 | 通过（恢复窗口指标在阶段 6） |

### 资源基线与 OPEN-04 门槛

负载：1 集团 + 5 区域 + 100 公司，200 个叶子科目（含数量科目）；构建产物单进程；4 vCPU / 7.9 GiB；Node 24.21.0。脚本 `backend/scripts/resource-baseline.ts`，采样 `/proc/<pid>/status` 的 VmRSS/VmHWM。

| 指标 | OPEN-04 门槛 | 实测（2026-09-30） |
|---|---|---|
| 单文件上限 | 20,000 数据行（不含 1 行表头），10 MiB；可用 `NEWFC_MAX_IMPORT_ROWS`/`NEWFC_MAX_UPLOAD_BYTES` 调整 | 恰好 20,000 行放行；20,001 行 400 VALIDATION_FAILED |
| 超限拒绝耗时 | ≤ 1 s，拒绝前不建完整工作簿 | 76 ms，峰值 RSS 不增 |
| 冷启动到就绪 | ≤ 10 s | 1.2 s（另一次 4.6 s） |
| 空闲 RSS | ≤ 150 MiB | 95.8 MiB |
| 代表性导入（2,000 行，56 KiB） | 预览 ≤ 5 s，确认 ≤ 2 s | 预览 0.40 s，确认 0.07 s（另一次 3.0 s / 0.50 s） |
| 最大导入（20,000 行，496 KiB） | 预览 + 确认 ≤ 15 s；峰值 RSS ≤ 512 MiB | 2.9 s（预览 2.4 s，确认 0.49 s），CPU 3.6 s，峰值 325 MiB |
| 导入期间普通查询/任务进度/会话 | 0 错误，p95 ≤ 1.5 s | 34 次 0 错误，p50 7 ms，p95 503 ms，最大 1.15 s |
| 典型执行报表查询 | p95 ≤ 1 s | p50 57 ms，p95 94 ms（另一次 p95 781 ms） |
| 执行报表导出 | ≤ 3 s | 0.29 s（另一次 1.0 s），32 KiB |
| 助手规则降级问答 | p50 ≤ 1 s | p50 162 ms（另一次 317 ms） |
| 全程最高 RSS | ≤ 512 MiB | 344.8 MiB；库 10.7 MiB，WAL 6.1 MiB |
| 重任务并发 | `NEWFC_JOB_CONCURRENCY` 默认 1，超出排队（持久任务） | `jobs-observability.test.ts` 并发有界通过 |
| 模型外呼并发 | `NEWFC_MODEL_CONCURRENCY` 默认 4，超出立即降级规则查询、不排队 | `t2-budget-loop.test.ts` 并发已满用例通过 |
| 缓存容量 | 助手导出产物缓存 ≤ 8 个且 ≤ 32 MiB；叙述缓存 ≤ 200 条、TTL ≤ 1 h | 代码常量限定的有界 Map（超出按插入顺序淘汰）；淘汰逻辑无单独用例 |

同一负载跑了两次，“另一次”是修正表头计数前的首跑（当时与测试并行，耗时偏高）。门槛取两次中较差值并留余量。首跑还发现一个缺陷：行数门禁把表头计入数据行，恰好 20,000 行数据的标准模板被误拒。已修正为“数据行 ≤ 上限，另留 1 行表头”，并加了边界用例（上限行放行，多一行拒绝）。恢复窗口（RPO/RTO）属于阶段 6 的备份恢复验收，未在此测量。

测试汇总（2026-09-30）：后端 62 文件/830 项通过、`tsc --noEmit` 通过；前端 36 文件/412 项通过、`tsc -b` 通过；E2E 全量 69/69 通过（finance + simulation，`--workers=1`，13.1 min）。

E2E 过程发现并修正两处：一是 UX31-S9 偶发 ECONNRESET，原因是服务端空闲连接保持 5 s 短于客户端复用窗口，已改为 keepAlive 65 s / headersTimeout 66 s；二是 `scope-restricted.spec.ts` 依赖共享库状态（空库显示初始化指引、已有数据显示驾驶舱），改为两者任一出现即可。机器负载高（load ~7～8）时 simulation 用例会超时，单独重跑通过，未计为缺陷。

E2E 运行前提：webServer 直接跑 `backend/dist/index.js`，必须先在 backend 执行 `npm run build`，否则会测到旧产物；前端先 `npm run build:e2e`，再以 `E2E_FRONTEND_DIST=.e2e-dist npx playwright test` 运行。

## T-3 财务数据与分析

| 项 | 内容 |
|---|---|
| 任务/验收 | T-3；AC-F05、AC-F06、AC-F10、AC-F14、AC-F19；扩展 AC-F03（工作台财报摘要）、AC-F20（助手工具）、AC-F25（审计动作）；AC-X03～AC-X06 适用场景 |
| 环境 | 同 T-0；schema V48（V44 文件对象与 EAS、V45 数据治理、V46 财务报表、V47 管理会计、V48 标准报表；均在 `migrations-newfc.ts` 追加） |
| 数据 | 测试全部用临时目录 SQLite 与临时对象目录；E2E 用 `backend/data/finance-e2e` 可丢弃库、端口 3761，前端产物 `.e2e-dist`，后端临时编译到会话临时目录，未改 `frontend/dist`、`backend/dist`；未触碰 newbd/lishui 运行目录 |

| 验收 ID | 执行方式 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| 公共基础 | `t3-file-objects.test.ts`（3） | 原件按 sha256 内容寻址、只读、相同内容只登记一次；篡改/缺失时读取报错；孤儿对象与临时文件超过 24 小时宽限期才回收 | 与预期一致；`sweepOrphanObjects` 此前未被调用，已接入启动与每日定时周期 | 通过（备份恢复对象一致性在阶段 6 AC-X07） |
| AC-F05 | `t3-eas.test.ts`（14）；E2E `finance-data.spec.ts` | 三类文件先全量校验再原子写入，幂等重放；事实行触发器禁改；预检 incomplete/failed/warning/passed；激活、锁期、解锁（仅管理员+原因+无待处理更正）；锁后更正申请→候选导入→预检→复核→原子切换；同人复核须例外原因；并发激活后到者 409 | 与预期一致。v600 样本：凭证 6 / 余额 4 / 辅助 4 行，`记-0001/1` 借 2100000.00，`记-0003/2` 贷 900000.00，空项目编码保持 null；首期连续性 warning；配置 220201×项目后按 −900,000.00 通过；超 2^53 分金额无损。E2E 在界面上导入三件套→预检→添加辅助要求→再预检通过→激活为当前集合 | 通过 |
| AC-F06 | `t3-governance.test.ts`（5）；E2E 扫描 | 扫描去重、已解决问题再出现时重开；映射覆盖/误报/重新导入三种处置；提交人≠复核人（管理员同人须例外原因）；生效证明记录前后哈希；来源事实变化返回 GOVERNANCE_FACT_MUTATED；按组织裁剪 | 与预期一致 | 通过 |
| AC-F10 | `t3-statements.test.ts`（5）；E2E `finance-data.spec.ts` | 预览不写库；不平衡模板 BALANCE_NOT_EQUAL 拒绝且不留批次与原件；幂等导入；按期望当前批次激活，冲突 CURRENT_BATCH_CHANGED；作废须原因；公式缺缓存与文本单元格告警且不当作 0 | 样本总资产 1000000.00、负债 420000.00、权益 580000.00、营业总收入 300000.00、净利润 60000.00、资产负债率 0.420000；E2E 界面预览→导入→激活→总览显示 1,000,000.00 / 42.00% | 通过 |
| AC-F14 | `t3-mgmt.test.ts`（9）；E2E 维度创建与八个页签 | 六类计算器取数，缺来源返回原因而非 0；分摊守恒与作废；调整守恒、复核、血缘；预算调整复制新版本并采用、原版本不变；预警去重与确认→关闭；维度预览/确认；多维分析；责任中心；绩效复核保留原分 | 1000.00 按 3:1 → 750.00/250.00；100.00 按 1:1:1 → 33.33/33.33/33.34；作废后快照失效；其余与预期一致 | 通过（合同/风险/投资/计划计算器随阶段 4/5 接入） |
| AC-F19 | `t3-standard-reports.test.ts`（3）；E2E 生成与导出 | 三类报表生成时冻结；来源变化后页面与 Excel 导出不变且逐行一致；复核一次，生成人不能自审；缺来源 409；受限用户只能生成授权组织、全组织口径需全组织权限 | 与预期一致；E2E 生成财务报表摘要，抽屉显示冻结内容并下载 .xlsx | 通过（合同付款台账、风险整改台账在阶段 4/5） |
| AC-F03（扩展） | `frontend/src/pages/financeData/financeData.test.tsx` | 有 statements:read 且存在当前批次时显示财报摘要；无权限不渲染、不请求 | 与预期一致 | 通过 |
| AC-F20（扩展） | `t3-assistant.test.ts`（2） | 新增 `eas_period_status`、`statement_overview`、`mgmt_metric_snapshots`、`mgmt_alerts` 四个 org_scope 只读工具，调用同一 service；范围外 404，参数白名单校验；写操作不暴露 | 与预期一致；受限上海账号只看到上海快照/预警/财报 | 通过 |
| AC-F25（扩展） | 各 T-3 测试中的 operation_log 断言 | EAS 导入/下载/更正、治理扫描/处置/复核、财报导入/激活/作废、分摊调整提交/复核、标准报表生成/复核/导出均有审计，记录操作人与结果 | 与预期一致；冲突被拒的激活不记成功 | 通过 |
| AC-X03 | 上述样本 | 金额以十进制字符串返回，比率 6 位小数，分母为 0 为 null；前端只做字符串排版不经 number | 与预期一致；前端 `utils/decimal.test.ts` 覆盖分组、负数、比率百分比截断 | 本阶段通过 |
| AC-X04 | 各文件“组织范围/越权”用例 | 受限用户对范围外批次、集合、锁、更正、问题、财报批次、成本池、报表返回 404 或 SCOPE_RESTRICTED；助手同名工具同样拒绝；无权限 403 | 与预期一致 | 本阶段通过 |
| AC-X05 | EAS/财报/管理会计用例 | 导入全量校验后原子提交、失败不留批次与事实行；幂等重放；并发激活与版本冲突拒绝后到者；复核只能一次 | 与预期一致 | 本阶段通过 |
| AC-X06 | `t3-assistant.test.ts`、`t3-mgmt.test.ts` | 工具结果与页面同源；不可用快照带原因不当作 0；输出有界（最多 100 行并给出隐藏数） | 与预期一致 | 本阶段通过 |

前端：新增 EAS 工作区、数据治理、财务报表、管理会计（八个页签）、标准报表页面和“财务数据”导航分组；前端以 `@contracts/*` 别名只做 `import type`，测试扫描保证不出现值导入，构建产物中无 zod。

测试汇总（2026-09-30）：
- 后端 69 文件/872 项通过，`tsc --noEmit` 与 `tsconfig.test.json` 均通过；T-3 新增 7 个文件 41 项。
- 前端 38 文件/422 项通过，`tsc -b` 通过。
- E2E `finance-data.spec.ts` 在新建夹具库上 2/2 通过，`--repeat-each=2` 重复运行 4/4 通过。本阶段没有重跑 finance/simulation 全量 E2E（本次运行中途由维护者中止），下一次发布前需补跑。

## T-4 项目、合同与费用

| 项 | 内容 |
|---|---|
| 任务/验收 | T-4；AC-F04、AC-F09、AC-F15、AC-F16、AC-F22；扩展 AC-F03（工作台待办）、AC-F14（三个计算器）、AC-F19（合同付款台账）、AC-F20（五个助手工具）、AC-F25（审计动作）；AC-X03～AC-X06 适用场景 |
| 环境 | 同 T-0；schema V53（V49 项目预算、V50 计划执行、V51 合同、V52 费用审核、V53 `ma_metric`/`std_report` 整表重建追加枚举；均在 `migrations-newfc.ts` 追加） |
| 数据 | 测试全部用临时目录 SQLite、临时对象目录与本机回环桩服务（OCR/模型）；E2E 用重建的 `backend/data/finance-e2e` 可丢弃库、端口 3761、`.e2e-dist`，后端临时编译到会话临时目录；未改 `frontend/dist`、`backend/dist`，未触碰 newbd/lishui 运行目录 |

| 验收 ID | 执行方式 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| AC-F09 | `t4-project-budget.test.ts`（4） | 预览不写库；行期间不符、项目名称不符、负金额报错不写库；幂等导入；同期间二次激活需期望当前批次；作废须原因；导入前后经营预算事实不变；万元表头精确换算 | 两行样本 1,000,000.00/250,000.00 与 500,000.00/0.00，汇总执行率 0.166667；经营预算表前后逐行一致；其余与预期一致 | 通过 |
| AC-F15 | `t4-plan.test.ts`（3） | 三表模板解析，其余 sheet 忽略并列出；同年取数；当期 = 本期年度累计 − 同年上一期；缺年度实际列不可计算；形象进度缺失为 null | 5 月累计完成率 0.300000；6 月当期 3,000,000.00、年度执行率 0.550000；无年度实际列给原因不以开工累计兜底；形象进度缺失为 null | 通过 |
| AC-F16 | `t4-contracts.test.ts`（3）；E2E `project-contract.spec.ts` | 阶段 blocker、审核（同人被拒）、变更、付款申请→复核→凭发票支付；超付与低于已付被拒；归档后拒写、重开；作废须原因且有付款不能作废；受限用户范围外 404 | 100,000.00 + 变更 20,000.00 = 120,000.00；付款 50,000.00 + 70,000.00 后再付 0.01 被拒（CONTRACT_PAYMENT_EXCEEDS）；待办下钻 `todo=change/pay` 与计数同口径 | 通过 |
| AC-F04 | `t4-contract-import.test.ts`（4）；E2E | 预览与确认一致；重复确认只一份合同；预览后库内变化 PREVIEW_STALE；“50”比例与 1970 签订日期被拒；中途失败整体回滚；受限用户不能导入范围外组织 | 与预期一致；E2E 界面上传 CSV → 预览“新增 1” → 确认 → 台账显示履约执行、付款比例 20.00%、导入基线付款 | 通过 |
| AC-F22 | `t4-expense.test.ts`（3）；E2E | 制度条款版本化；差旅 6,000.00 超过条款上限 5,000.00 给出带条款引用的高风险发现；缺住宿证明为材料缺失；未配置 OCR/模型明确记录；模型输出白名单与无效输出记录；复核处置不全/高风险无例外原因 pass 被拒；补件重提生成新运行；复核后不可改 | 与预期一致；OCR 桩验证缓存命中、失败记 OCR_FAILED；E2E 创建报销单→提交→后台审核运行显示 LIMIT_EXCEEDED 与制度版本→退回补件（管理员同人例外原因）→工作台“退回补件报销”下钻 | 通过 |
| AC-F14/F19（扩展） | `t4-linkage.test.ts`（2） | V53 在已有数据上重建且外键完整、触发器保留；`contract_paid`/`contract_payment_rate`/`plan_execution_rate` 取数与缺来源原因；合同付款台账冻结合同版本、不含作废合同、全组织口径需全组织范围 | 与预期一致 | 通过 |
| AC-F03（扩展） | `t4-expense.test.ts` todos 断言；`frontend/src/pages/project/projectContract.test.tsx` | 待办按权限返回项、按组织范围计数；无权限不渲染不请求 | 与预期一致；初始化视图（无预算版本）同样显示 | 通过 |
| AC-F20（扩展） | `t4-assistant.test.ts`（2） | 五个只读工具调用同一 service；受限用户范围外组织/合同 404；参数校验；无权限 FORBIDDEN；无写操作工具 | 与预期一致 | 通过 |
| AC-X03～X06 | 上述用例 | 金额十进制字符串、比率 6 位、分母 0 为 null；范围外 404/SCOPE_RESTRICTED；导入全量校验后原子提交、幂等与期望版本；工具与页面同源 | 与预期一致 | 本阶段通过 |

前端：新增“项目与合同”（项目预算、计划执行、合同台账、合同导入）与“费用审核”（报销单、制度依据）导航和页面，首页待办卡片。

测试汇总（2026-09-30）：
- 后端 76 文件/893 项通过，`tsc --noEmit` 通过；T-4 新增 7 个文件 21 项。
- 前端 39 文件/428 项通过，`tsc -b` 通过。
- E2E `project-contract.spec.ts` 在重建的夹具库上 3/3 通过。未重跑 finance/simulation 全量 E2E，发布前需补跑。
- OCR/模型只用本机桩验证协议；真实供应商与制度样本的支持范围仍待 OPEN-05。

## T-5 投资、预测与报告

| 项 | 内容 |
|---|---|
| 任务/验收 | T-5；AC-F11、AC-F12、AC-F13、AC-F17、AC-F18；扩展 AC-F03（风险/报告待办）、AC-F14（两个计算器）、AC-F19（风险整改台账）、AC-F20（五个助手工具）；AC-X03～AC-X06、AC-X09 适用场景 |
| 环境 | 同 T-0；schema V59（V54 可行性、V55 投资控制、V56 财务预测、V57 风险闭环、V58 分析报告、V59 `ma_metric`/`std_report` 整表重建追加计算器与报表类型；均在 `migrations-newfc.ts` 追加） |
| 数据 | 测试全部用临时目录 SQLite 与临时对象目录；可行性样本为 lishui 宜冲桥脱敏夹具（逐字节复制，见来源记录）；Python 参照结果 `feasibility-reference.json` 由会话临时目录中的独立 Decimal 实现生成；E2E 用重建的 `backend/data/finance-e2e` 可丢弃库、端口 3761、`.e2e-dist`，后端临时编译到会话临时目录；未改 `frontend/dist`、`backend/dist`，lishui 只读 |

| 验收 ID | 执行方式 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| AC-F12 | `t5-feasibility-calc.test.ts`（11）、`t5-feasibility.test.ts`（4）；E2E `risk-investment.spec.ts` | 2028 年含税收入 2100.000000、不含税 1934.862385、销项 165.137615、期初留抵 500.000000、实缴 0.000000、期末留抵 352.862385、水资源税 5.000000、水利建设基金 9.674312；三种还款期末债务 0.000000、建设期 DSCR 为空；首年折现 = 净现金流/1.08；延期 1～3 年 NPV 下降；基准 IRR 0.99 成功但未达标；人工融资计划资本化利息检查通过；无债务/有债务项目现金流差额恰为所得税差额；旧 schema 被拒；运行冻结、参数修改后提示重算；模板导入核对 sha256；敏感性为后台任务；导出与冻结结果一致；范围外 404 | 与预期一致；11 个情形（base、等额本息、到期一次、人工计划、无债务、亏损结转、延期 1/2/3 年、基准 0.99、混合）的全部逐年字段与指标与 Python Decimal 参照逐字符串相等；E2E 在页面对样本方案测算，显示“结果最新”与冻结运行 | 通过 |
| AC-F13 | `t5-investment-control.test.ts`（3）；E2E | 导入全量校验（编码格式、重复、父级缺失、父子不平 > 0.01 元、负数、超分精度）；红线优先调整概算；未映射且金额非 0 拒绝确认，映射后通过；基准 100/目标 108 偏差 8、0.080000、attention；基准 0 为 null/new_item，目标 0 为 −1.000000/removed_or_zero；结算 > 预算未超红线只有 settlement_over_budget；阈值覆盖写入快照；作废源版本旧快照不变；导出逐行一致；范围外 404 | 与预期一致；E2E 界面新建项目→导入设计概算 100 万元与施工图预算 108 万元并确认→生成对比快照，显示偏差 80,000.00 元、8.00%、“关注”与控制链“施工图预算超过概算(红线)” | 通过 |
| AC-F11 | `t5-formula-engine.test.ts`（6）、`t5-forecast.test.ts`（4）；E2E | 公式覆盖四则/整数幂/百分号/比较/连接、引用/区域/跨表、SUM…PMT；不支持函数、外部引用、#REF!、循环引用进入诊断；冻结需无错误，冻结后修改被拒（触发器兜底），复制为新草稿；基准唯一；情景参数覆盖并与基准逐项对比；参数越界、#DIV/0! 输出、循环引用、超时记 failed 且无部分输出；超时后 Worker 终止、任务槽释放，下一次运行立即成功 | 与预期一致；E2E 页面冻结样本版本→运行基准（合计 3,310.000000）→情景 growth=0.2（合计 3,640.000000）→对比差额 330.000000 | 通过 |
| AC-F17 | `t5-risk.test.ts`（3）；E2E | 扫描产生风险；再扫只加命中次数；确认→整改→提交→他人复核关闭；再触发重开；误报不重开；非法跳转 RISK_STATE、同人复核被拒；未命中只标记不关闭；受限用户扫描/列表只含范围内；整改台账冻结后不随风险变化；投资控制按每个项目最新快照命中 | 与预期一致；E2E 对偏差 20% 的项目扫描→风险台账“待确认”→确认→开始整改→提交复核→管理员例外原因自审通过→“已关闭”，时间线含“复核通过” | 通过 |
| AC-F18 | `t5-reports.test.ts`（3）；E2E | 生成→编辑（历史）→提交（空章节 REPORT_INCONSISTENT）→同人审批被拒、管理员带例外原因可以→审批后编辑被拒→发布任务渲染 DOCX/PDF；两者段落文本一致、重复下载字节一致、快照脱敏手机号/身份证号；修订号 2 草稿、原发布不变，新修订发布后旧版 superseded；范围隔离 | 与预期一致；PDF 使用 STSong-Light（UniGB-UCS2-H）不嵌字体；E2E 页面生成“风险与投资专题”→提交→例外自审→发布（任务完成后显示发布快照）→导出 DOCX | 通过 |
| AC-F14/F19/F03/F20（扩展） | `t5-linkage.test.ts`（2）；`t4-expense.test.ts` 待办断言；`App.test.ts` | `risk_open_amount` 扫描前不可用（RISK_SCAN_MISSING）而非 0，扫描后按组织取数；`investment_deviation_rate` = Σ偏差/Σ基准；风险整改台账冻结；待办按角色与范围；五个只读工具范围外 NOT_FOUND、参数校验、无权限 FORBIDDEN，无写操作工具；新导航叶子高亮/标题/权限 | 扫描前 RISK_SCAN_MISSING；偏差率 0.050000 带证据；扫描后上海、南京各 10,000.00；其余与预期一致 | 通过 |
| AC-X09（部分） | `t5-forecast.test.ts` 超时用例；敏感性与报告发布走 `submitJob` | 重任务并发 1；Worker 带 `resourceLimits` 与超时，失败/超时后终止并释放任务槽，普通查询不受阻 | 超时运行记 FORECAST_TIMEOUT，随后同版本情景运行立即成功 | 本阶段通过；固定负载全指标在 T-6 复测 |
| AC-X03～X06 | 上述用例 | 金额十进制字符串、比率 6 位、分母 0 为 null；范围外 404/SCOPE_RESTRICTED；导入全量校验后原子提交、确认核对 sha256、期望版本；工具与页面同源 | 与预期一致 | 本阶段通过 |

前端：新增“投资与预测”（可行性测算、投资控制、财务预测）与“风险与报告”（风险台账、分析报告）导航和页面，标准报表页增加风险整改台账，管理会计计算器页签增加两个计算器。

测试汇总（2026-09-30）：
- 后端 84 文件/929 项通过，`tsc --noEmit` 通过；T-5 新增 8 个文件 36 项。T-4 费用测试的业务复核角色待办断言同步纳入 T-5 新待办。
- 前端 39 文件/429 项通过，`tsc -b` 通过。
- E2E `risk-investment.spec.ts` 在重建的夹具库上 3/3 通过。未重跑 finance/simulation 全量 E2E，发布前需补跑。

## T-6 全量覆盖与切换准备

| 项 | 内容 |
|---|---|
| 任务/验收 | T-6；AC-F26；补齐 AC-F03（业务概况）、AC-F21（重启逐类型对账）、AC-F23（业务设置）；跨域 AC-X07～AC-X10，OPEN-04 恢复窗口收口 |
| 环境 | 同 T-0；schema 仍为 V59（本阶段无新迁移；`applyMigrations` 增加 `maxVersion` 参数用于构造旧 schema 夹具） |
| 数据 | 单测全部用临时目录 SQLite 与对象目录；发布演练在会话临时目录的仓库副本中进行（依赖以符号链接引用，不安装），伪 systemctl 只管理副本进程，端口 3769；资源基线与恢复演练用一次性数据目录与会话临时编译产物；E2E 用可丢弃库 `backend/data/finance-e2e`、端口 3761。未改 `frontend/dist`、`backend/dist`，未触碰 newfc.service、newbd/lishui 运行目录 |

| 验收 ID | 执行方式 | 预期 | 实际 | 结果 |
|---|---|---|---|---|
| AC-F26 | `t6-search.test.ts`（3）、`Search.test.ts`、`App.test.ts`；E2E `cross-domain.spec.ts` | 全组织与受限用户返回不同集合；无 contract:read 不返回合同并列入 skipped；报告草稿对非创建人不可见；`%`/`_` 按字面匹配；无 search:use 403 且助手工具同样拒绝；每个结果 path 与模板都在前端路由中；工具输出有界 | 与预期一致；E2E 顶栏检索 → 分组结果 → 打开投资控制详情抽屉 → 返回 → 打开主数据项目（页签与关键词定位） | 通过 |
| AC-F03 | `t6-dashboard.test.ts`（1）；E2E | 业务概况六块按权限出现，计数与各领域列表一致；风险未扫描时金额为空并注明原因 | 与预期一致；E2E 点击“风险”块进入 `/risk` | 通过 |
| AC-F21 | `t6-jobs-restart.test.ts`（1） | 预测/敏感性/报告发布/费用审核任务排队时重启：任务 interrupted（SERVICE_RESTARTED）；预测运行同步为失败可重跑；敏感性无部分结果；报告保持已审批可重新发布；报销单保持审核中可重跑；失败/中断任务释放幂等键 | 与预期一致。修正缺陷：中断的幂等任务原先会让同键重新提交一直返回旧任务 | 通过 |
| AC-F23 | `t6-settings.test.ts`（2） | 投资控制三级阈值（0～1、6 位小数、单调）与预测超时（5～120 秒）可设；5% 偏差默认 attention，改设后 normal；显式阈值优先；旧快照不变 | 与预期一致 | 通过 |
| AC-X07 任务与恢复 | `t6-backup.test.ts`（1）、既有备份用例 3 文件 41 项 | 备份包 = 库 + 清单 + 引用对象；删除一个运行对象后校验指出缺失且可从备份补齐；页面恢复补齐对象；备份对象被篡改时校验失败、演练拒绝；清单缺失不视为一致备份；未引用对象回收；演练拒绝非空/运行目录/newbd 路径 | 与预期一致；备份改为自包含单文件（不再留 -wal/-shm） | 通过 |
| AC-X07 恢复演练 / RTO | `npm run restore:drill`（编译产物）对资源基线规模库的备份 | 空目录还原、迁移检查、逐表行数/金额/状态一致、对象摘要一致、临时实例就绪 | 12.3 MB、134 表、50,360 行、3 个报告产物对象：mismatches 0，存活/就绪与四项系统只读查询通过；耗时 校验 215 ms、复制 14 ms、迁移检查 223 ms、比对 210 ms、临时实例 1,259 ms，**总计 1.9 s** | 通过 |
| AC-X07 newbd 迁入 | `t6-newbd-import.test.ts`（2） | V1～V38 前缀“newbd 形”夹具（预算版本、实际快照、审计，含超 2^53 分金额）迁入后逐表行数、金额、预算按组织/年度/状态、实际快照与当前实际合计、外键全部一致；ID 不变并写身份映射；不建账号；重跑须 --replace 且结果相同；迁入后有业务写入时拒绝；V39+、名称不符与 newbd 运行路径被拒 | 与预期一致；V30 前缀快照同样可迁入 | 通过 |
| AC-X08 发布与回退 | `scripts/release-drill.sh`（仓库副本，1,062 s） | 构建失败 dist 不变、不停服；迁移失败不换产物、库版本不变、失败迁移回滚；schema 变化发布成功且保留 dist.old；库 schema 高于旧代码时回退拒绝且不停服；恢复 pre-migrate 备份时列出备份后写入，未确认拒绝并恢复服务；确认后产物换回基线、库回到 V59、留 pre-rollback 备份并就绪 | 26 项检查全部通过。首跑发现演练脚本自身缺陷：伪 systemctl 记录的是子 shell PID，停服未真正停掉 node，导致后续启动端口冲突（4 项失败）；改为直接后台运行 node 后重跑全部通过 | 通过 |
| AC-X09 资源 | `npm run resource:baseline`（会话临时编译产物，三次） | T-2 门槛不变；新增测量报告发布、预测重算、敏感性、跨域检索、重任务 + 普通查询 | 见下表 | 通过（高负载下一项超限，见说明） |
| AC-X10 全量范围 | [coverage-matrix.md](coverage-matrix.md) | 26 项逐项列入口、接口、操作清单、证据与 lishui 差异；未完成不标退出范围 | 26 项均有自动化证据；差异 10 条均写明原因；未决事项 OPEN-03、OPEN-05 单列；finance/simulation 全量 E2E 79/79 通过 | 通过 |

### 资源复测（AC-X09，2026-09-30）

负载同 T-2（106 组织、200 叶子科目），另种入 500 个项目、200 个供应商；4 vCPU / 7.9 GiB；Node 24.21.0。本机同时运行其他服务（lishui 的 uvicorn --reload、mysqld、dockerd），负载均值 2～5。

| 指标 | 门槛 | 第 3 次（负载 ~2.2） | 第 2 次（负载 ~2.1） | 第 1 次（负载 ~5） |
|---|---|---|---|---|
| 冷启动到就绪 | ≤ 10 s | 1.1 s | 1.4 s | 4.0 s |
| 空闲 RSS | ≤ 150 MiB | 103.1 MiB | 103.3 MiB | 102.9 MiB |
| 代表性导入 预览/确认 | ≤ 5 s / ≤ 2 s | 0.47 s / 0.09 s | 0.51 s / 0.11 s | 1.2 s / 0.21 s |
| 最大导入 合计；峰值 RSS | ≤ 15 s；≤ 512 MiB | 3.1 s；330 MiB | 3.1 s；344 MiB | 9.7 s；323 MiB |
| 导入期间普通请求 | 0 错误，p95 ≤ 1.5 s | 34 次 0 错误，p95 577 ms | 37 次 0 错误，p95 901 ms | 33 次 0 错误，**p95 2.0 s（超限）** |
| 超限拒绝 | ≤ 1 s | 85 ms | 61 ms | 294 ms |
| 典型查询 p95 | ≤ 1 s | 102 ms | 110 ms | 411 ms |
| 执行报表导出 | ≤ 3 s | 0.40 s | 0.34 s | 1.2 s |
| 助手规则降级 p50 | ≤ 1 s | 117 ms | 140 ms | 485 ms |
| 跨域检索 p95（新） | 沿用典型查询 ≤ 1 s | 17 ms | 24 ms | 未测（首跑无项目/供应商种子） |
| 报告发布渲染（新） | 任务成功 | 69 ms | 65 ms | 105 ms |
| 预测重算 2,000 公式单元格（新） | 成功；超时上限 30 s（业务设置） | 190 ms | 257 ms | 未测（首跑脚本前置步骤失败） |
| 敏感性分析（新） | 任务成功；期间普通请求 0 错误 | 144 ms；3 次 p95 139 ms | 188 ms；3 次 p95 183 ms | 518 ms；2 次 p95 516 ms |
| 全程最高 RSS | ≤ 512 MiB | 355 MiB | 369 MiB | 356 MiB |

说明：
- 第 1 次在发布演练的构建刚结束、机器负载约 5 时运行，导入期间普通请求 p95 为 2.0 s，超过 1.5 s 门槛。负载回落后两次复测均满足门槛。门槛按专用单机部署制定，与其他常驻服务共用机器时不保证。
- 第 1 次还暴露了脚本自身两处问题：检索种子缺失（结果为 0，未真正测到）；预测输出区域写成多行导致冻结失败而被静默跳过。已修正：前置步骤失败立即报错，并种入项目与供应商。
- 敏感性分析在样本规模下 < 0.2 s，期间只采到 3 次普通请求；重任务并发 1、超时与资源释放由 `t5-forecast.test.ts`、`jobs-observability.test.ts` 覆盖。

### 恢复窗口（OPEN-04 收口）

- RPO ≤ 24 小时（自动备份间隔），迁移前与恢复前另有备份。
- RTO：以演练实测为准。资源基线规模（12 MB）的库，从备份包到临时实例就绪共 1.9 s。人工操作（停服、选择备份、确认）另计。库增大时校验与比对耗时随行数线性增长，建议每季度及大版本发布后用 `restore:drill` 复测。

测试汇总（2026-09-30）：
- 后端 90 文件/939 项通过，`tsc --noEmit` 通过；T-6 新增 6 个文件 10 项（检索 3、工作台 1、重启对账 1、业务设置 2、备份包与恢复演练 1、newbd 迁入 2）。
- 前端 40 文件/432 项通过，`tsc -b` 通过。
- E2E `cross-domain.spec.ts` 在重建的夹具库上 2/2 通过。
- finance/simulation 全量 E2E（重建 `finance-e2e`、`e2e-simulation` 夹具库，端口 3761/3762，`.e2e-dist`，后端临时编译产物，AI 环境变量置空）：
  - 首跑 78/79 通过（16.5 min）。失败项为 `risk-investment.spec.ts` 投资控制用例，属于测试自身定位问题：选完“基准版本”后其下拉仍在收起动画中、尚未带 `-hidden` 类，`chooseOption` 的 `.first()` 命中旧下拉里同名选项并一直不可见而超时；页面截图显示“目标版本”下拉与选项正常。单独重跑稳定复现。
  - 修复（仅测试）：`chooseOption` 先等到只剩一个展开的下拉再在其中点选；两次导入的成功提示可能同时存在，断言取最后一条；主数据项目下拉为虚拟列表，改为先输入编码筛选再选（反复重跑累积测试项目后新项目不在首屏渲染）。修复后该用例连续 4 次通过。
  - 重建夹具库后全量重跑 **79/79 通过**（14.3 min），UX31 九个可用性场景均为“独立完成”。

## 生产上线（2026-09-30）

用户确认 OPEN-03（lishui 旧历史不迁入）、OPEN-05（与 lishui 一致）并同意安装 `newfc.service` 正式上线。

| 步骤 | 执行 | 结果 |
|---|---|---|
| 准备 | `install -d -m 700 /data/newfc-data`；`newfc.env` 由 `.env.example` 生成（chmod 600，附 SiliconFlow 模型渠道注释，密钥待填）；单元安装到 `/etc/systemd/system/newfc.service` 并 `daemon-reload` | 完成 |
| 首次发布（第 1 次） | `scripts/deploy.sh --no-restart` | 测试阶段中止：939 项中 `t5-forecast.test.ts` Worker 用例 30.7 s 超时（依赖重装后全量并行负载高；单独 11 s 通过）。未构建、未迁移、服务未动。用例时限放宽到 90 s（`284a353`） |
| 首次发布（第 2 次） | `scripts/deploy.sh --no-restart`（main `d5ac3dc`） | 后端 91 文件/940 项、前端 40 文件/432 项通过；构建到 dist.new；空库迁移至 V60；产物替换，341 s |
| 启动 | `systemctl enable --now newfc.service` | active/enabled；`/api/health/ready` 返回 ready、schema V60；只监听 127.0.0.1:3760；启动内存约 54 MiB；newbd（3748）未受影响 |
| 制度样本 | `npm run expense:policy:import -- --file ../deploy/expense-policy-lishui.json` | 发布 `LISHUI-EXPENSE-V1` v1，6 条条款，生效日期 2020-01-01（审计来源 cli） |
| 首个管理员 | `admin:create` 后立即 `admin:reset-password`，均用随机口令经标准输入传入 | `admin`（id=1，全组织）；临时口令只写入 `/data/newfc-data/initial-admin-password.txt`（root 600），首次登录强制修改；登录接口 200 且 `mustChangePassword: true`；审计日志不含口令 |

未完成：模型密钥（SiliconFlow）与 OCR 服务地址未配置，助手与费用审核按规则运行并标注“未配置”；接入后用真实单据补验模型/OCR 输出（OPEN-05 余项）。

外网访问（2026-09-30）：宿主 nginx 新建独立站点 `newfc.tangdalei.com`（反代 127.0.0.1:3760，`proxy_buffering off` 支持 SSE，上传 20 MiB），`nginx -t` 通过后 reload，certbot 签发证书（2026-12-29 到期，自动续期）并设 HTTP→HTTPS 跳转；`NEWFC_TRUST_PROXY=1` 后重启服务。其他站点配置未改。外网验证：HTTP 301 → HTTPS；首页 200、证书校验通过；就绪 200（V60）；登录 200，会话 Cookie `HttpOnly; SameSite=Strict; Secure`；跨站 Origin 写请求 403，同源带 CSRF 令牌 200；IP 直连 443 拒绝握手、3760 外部不可达。管理员账号改为 `tangdalei`（全组织、管理员角色），引导账号 `admin` 已停用、临时口令文件已删除。

## T-7 lishui 能力补齐（2026-10-01）

上线后对照 lishui 端点与页面复核，补齐覆盖矩阵未列出的能力缺口。

| 项 | 内容 | 证据 |
|---|---|---|
| 风险规则 | V61 重建 `risk_rule`（`detector`/`builtin`/`org_id`，来源增加 `eas`），新增 8 条内置规则：付款超前形象进度、完成投资逼近概算、计划明细未关联项目、已支付缺凭证号、供应商大额集中付款、大额凭证缺项目、预付/暂估/挂账、预算执行与 EAS 入账差异；阈值按比率/金额分别校验 | `t7-risk-rules.test.ts` 用例 1 |
| 自定义规则 | 全组织 `risk:review` 新增；复用内置计算器，可设阈值、等级、适用组织（含下级）；编码冲突 409；内置规则不可改名 | 同上 |
| 风险解释、整改清单 | 解释为确定性模板 + 可选模型改写（`risk-explain.v1`），`risk_ai_note` 只追加、不改风险状态，需 `risk:handle`；清单按来源与证据生成缺失材料与建议下一状态，范围外 404 | `t7-risk-rules.test.ts` 用例 2 |
| 项目档案 | `GET /api/master/projects/:id/profile` + `/projects/:id` 页面：主数据与各域同源汇总；分区按该域读权限裁剪（无权限为 null），行按组织范围过滤，范围外项目 404；EAS 凭证按项目编码及有效编码映射匹配；检索结果与风险详情链接到档案 | `t7-project-profile.test.ts` |
| 财报趋势 | `GET /api/statements/trends`（报表单位 + 口径，缺省同总览、截至最新期间 12 个月，最长 60 个月）：各期语义指标与比率，本年累计类指标相邻期间相减得当月发生额，缺期列出且不插补；范围外组织 404；财报页新增“趋势”页签（折线 + 精确金额表） | `t7-statement-trends.test.ts` |
| 财务预测流程 | V62：`ff_model.folder` 模型目录（前缀筛选含子目录）；冻结即提交复核，`forecast:review`（业务复核人）复核一次，提交人 ≠ 复核人，管理员同人复核须写例外原因，退回须写意见；复核通过版本的成功运行可发布（同一运行只发布一次），复核人填原因撤回，发布表只允许一次撤回、不可删除；基准时间线按冻结版本逐版对比输出合计与变动率；运行洞察为模板 + 可选模型改写（`forecast-insight.v1`），只追加；范围外列表为空、单个 404 | `t7-forecast-workflow.test.ts` |
| 可行性方案与报告 | V63：`if_scenario.is_baseline`（每项目唯一，切换时原基准取消）、软删除（`deleted_at`，有报告的方案 409，删除后 404、编码不可复用、运行保留，风险扫描与分析报告排除已删除方案）；`if_report` 由参数一致的最新成功基准运行生成（模板含指标、模型检查、参数一致的敏感性摘要与结论提示，可选模型改写 `feasibility-report.v1`），正文与依据运行不可改；草稿/退回 → 提交（`investment:write`）→ 通过/退回（新权限 `investment:review`，授予业务复核），提交人 ≠ 复核人，通过后冻结、不可删除；方案参数修改后报告标记依据过期；范围外 404 | `t7-feasibility-workflow.test.ts` |
| 会话与角色复制 | 管理员查看用户会话（只暴露会话 ID 前 16 位句柄与登录来源，不暴露 CSRF 令牌）、吊销指定会话（立即失效、幂等，不能吊销自己当前会话 409 `SESSION_CURRENT`）；复制角色带出全部权限、不带用户，内置锁定角色可作模板，编码冲突 409；两类操作写审计日志 | `t7-security-sessions.test.ts` |
| 检索建议 | `GET /api/search/suggestions`：空关键词返回按读权限裁剪的可检索类型与匹配字段说明；有关键词时复用检索 service，只取编码/标题完全相同或前缀命中（每类 ≤3、总数 ≤8），组织范围与检索同口径；顶栏检索框改为输入联想，回车仍进入完整检索 | `t7-search-suggestions.test.ts` |
| 治理质量评分与匹配建议 | `GET /api/governance/quality-score`：按来源分一致性（EAS 预检）/完整性（EAS 主数据）/准确性（财报）三维，维度分 = 100 − 8×未处理错误 − 2×未处理警告 − 1×待复核（下限 0），综合分按 0.4/0.3/0.3 加权两位小数，公式随结果返回，只统计范围内问题；`GET /api/governance/master-data-matches`、`/issues/:id/match-suggestions`：未处理/待复核 EAS 主数据问题按凭证项目名或供应商名与有效主数据名称相似度（≥0.60，前 3）给候选，不比编码（顺序编码彼此高度相似），项目候选按组织范围裁剪；只读，“采用”预填映射覆盖处置，仍需复核后才写映射 | `t7-governance-quality.test.ts` |
| 字典项 | V64 `md_dict_item`：`(类型, 取值)` 唯一，类型与取值建立后不可改（触发器兜底）、不可物理删除（停用代替，已停用取值重建时提示可重新启用）；显示名/排序/状态带期望版本；新建缺省排在该类型末尾；`/api/master/dict-types` 汇总各类型条数；读需 `master:read`，写需全组织 `master:write`；增改停用写审计；主数据页新增“字典项”页签 | `t7-master-dict.test.ts` |
| 自定义字段 | V65 `sys_custom_field`（项目/供应商；text/number/date/select，select 引用字典类型）：领域/编码/类型不可改、停用代替删除；项目与供应商新建、以及更新时传入 extra 才按有效定义校验——必填、文本 ≤500、数值为十进制字符串（安全整数转字符串，浮点拒绝）、日期 YYYY-MM-DD 且真实存在、下拉取值须为有效字典项（未改动的旧值在选项停用后保留），问题一次列出；空值移除、未定义键原样保留；有效定义经 `/api/master/custom-fields` 对主数据读者开放，管理需 `settings:manage` | `t7-system-settings.test.ts` 用例 1 |
| 导入字段模板 | V65 `sys_import_field_alias`：为 EAS 三类文件与计划执行三张表的目标字段追加表头别名，只影响列识别、不改类型/必填/换算；别名按解析器口径规整，与内置表头或同类型已登记别名相同 409，目标字段不存在 400；停用后不再识别；目录接口列出各字段内置表头 | 同上 用例 2 |
| AI 提示补充 | V65 `ai_prompt_supplement`：七个改写任务各一条补充说明（≤1000 字，带期望版本，清空代替删除），附在系统硬约束与任务说明之后并声明不得违背其上约束；数字/编码守卫不变；非空时 prompt 版本为 `基础版本+s.<sha256 前 8 位>` 并随生成物落库；审计只记长度与哈希；不开放整段提示词替换（与 lishui 可配置 system prompt 的差异） | 同上 用例 3 |

测试汇总（2026-10-01，T-7 全部提交后）：后端 `npx tsc --noEmit` 通过，`npx vitest run` 101 个文件 / 953 个用例通过；前端 `npx vitest run` 40 个文件 / 432 个用例通过，`npx tsc -b` 通过。E2E 未重跑；V61～V65 迁移尚未在生产执行（需经 `scripts/deploy.sh` 发布）。

## T-7 功能闭环复核（2026-10-01）

对应功能 `dashboard`、`finance_forecast`、`investment_feasibility`、`financial_statements`、`master_data`、`system_settings`；任务 T-7，AC-F03/F07/F10/F11/F12/F23 与 AC-X04/X05/X10。核对基线 `811d13a`，增量为当前工作区改动，尚未提交/发布。检查结论见 [功能完成度检查](function-completeness.md)。本次无新增依赖或迁移；HTTP/财务测试只用系统临时目录 SQLite，未访问生产库及其他项目运行目录。

| 场景 | 执行方式 | 实际结果 | 判定 |
|---|---|---|---|
| 预测复核队列与首页待办 | `t7-forecast-workflow.test.ts` 新增队列用例 | 草稿/已审/归档模型不进入队列；授权上海只见上海，授权华东可见上海+杭州；与首页计数一致；范围外组织 404、无读权限 403；复核后计数变 0 | 通过 |
| 可研待办与审批依据 | `t7-feasibility-workflow.test.ts` | 待审报告与首页计数一致；参数变化后草稿/退回稿提交和待审稿批准均返回 409 `FEAS_REPORT_STALE`；拒绝不改版本/状态，过期稿仍可退回；历史已审报告标记过期且保留 | 通过 |
| 报告生成并发变化 | 同上新增独立用例，桩改写阶段通过真实 HTTP 修改参数 | 生成结束重新核验，返回 `FEAS_REPORT_STALE`，`if_report` 行数仍为 0 | 通过 |
| 待办深链与页面门禁 | 前端 `pages/invest/reviewWorkflow.test.tsx` | `/forecast?tab=reviews` 直接展示队列；可研待审深链按状态取数并定位详情；过期草稿禁提交，过期待审稿禁批准、仍可退回 | 通过 |
| 扩展字段失败与重试 | 同上项目/供应商两例 | 失败明确显示原因，新建不可点击；重试加载成功后可新建 | 通过 |
| 财报批次变化刷新趋势 | 同上财报用例，通过页面激活与确认 | 激活调用成功后旧趋势缓存失效，下一次读取须重新取数 | 通过 |
| 既有功能全量回归 | 后端 `npx tsc --noEmit && npx vitest run`；前端 `npx vitest run && npx tsc -b` | 后端 101 文件 / 955 项通过，源码类型检查通过；前端 41 文件 / 438 项通过，类型检查通过 | 通过 |
| T-7 浏览器全量/正式发布/真实模型与 OCR | 未执行 | 本次仅代码和自动化回归；生产发布状态沿用既有记录，真实供应商输出仍待样本验证 | 未执行 |

补充检查：`backend npx tsc --noEmit -p tsconfig.test.json` 尚未通过，主要是历史 HTTP 测试直接使用 `Response.json()` 的 `unknown` 结果。对 `811d13a` 的独立临时快照（同一 Node/依赖，含前端共享计算源码）复现 694 条既有类型错误；本次触及的三个 HTTP 测试文件改为复用已有 `t3-helpers.json`，剩余 443 条报错均在其他测试文件，源码和本次修改的测试文件无报错；三个文件的 7 项聚焦回归再次通过。不新增响应解析机制。此附加检查与上表规定的源码类型检查/Vitest 分开判定，不把测试可执行等同于全部测试文件类型检查通过。

## 前后端日常操作复核（2026-10-01）

对应功能 `expense_audit`、`cross_domain_search`、`project_budget`、`dashboard` 与 `finance_forecast`；任务 T-7 收口，AC-F03/F09/F11/F22/F26、AC-X04。基线仍为 `811d13a`，改动在工作区，未提交/发布；无新增依赖、迁移或常驻服务。

| 场景 | 实际证据与结果 | 判定 |
|---|---|---|
| 授权根与所属组织分离 | `ExpenseClaims.test.tsx`：只授权华东的账号默认不传 orgId，费用列表与统计取全部授权范围；首页待审深链显示下级单据 | 通过 |
| 创建与后台审核后的页面更新 | 同上：新建后列表/计数重查；详情关闭时审核结束仍刷新待复核筛选，结束后不继续轮询；首页待办/概况缓存失效 | 通过 |
| 状态统计失败 | 同上：保留成功加载的费用列表，显示明确失败原因与重试动作，成功后提示消失 | 通过 |
| 较早预算批次检索 | `t6-search.test.ts`：临时库内 302 个批次，较早匹配批次仍可搜索/联想；上海授权看不到南京明细批次；领域关键词不使用通配符 | 通过 |
| 后端聚焦与全量 | `npx vitest run tests/t6-search.test.ts tests/t4-project-budget.test.ts` 8/8；`npx vitest run` 101 文件 / 956 项；`npx tsc --noEmit` 通过 | 通过 |
| 前端聚焦与全量 | `npx vitest run src/pages/expense/ExpenseClaims.test.tsx` 4/4；`npx vitest run` 42 文件 / 442 项；`npm run build:e2e` 内的 `tsc -b` 与 Vite 构建通过 | 通过 |
| 独立构建与浏览器链路 | 后端 `npx tsc --outDir .e2e-dist`，前端 `npm run build:e2e`；finance 项目的 `project-contract cross-domain risk-investment finance-data` 共 11/11 通过。覆盖费用父组织授权、创建/审核/复核/工作台、合同导入、财报/EAS、投资对比、预测待复核队列→详情→复核后移除→基准/情景对比、风险/报告、检索进入项目档案 | 通过 |

浏览器通过临时 `.e2e-dist/audit.config.ts` 复用原 Playwright 配置，仅启 finance 服务，设置工作目录为 frontend 并把后端入口替换成 `.e2e-dist/index.js`；执行 `E2E_FRONTEND_DIST=.e2e-dist npx playwright test --config=.e2e-dist/audit.config.ts --project=finance project-contract cross-domain risk-investment finance-data`。数据库仅为本仓库可丢弃的 `backend/data/finance-e2e`，端口 3761；未构建/替换运行用 dist，未访问运行库或其他项目目录。

首轮浏览器结果为 9 通过、2 失败：既有用例仍按 searchbox 找联想输入框，且仍按“冻结”旧按钮/消息操作预测版本。核对 trace 后更新为实际 combobox、项目档案入口与“冻结并提交复核”，并补实际队列复核场景；重跑上述 11 项全部通过。该记录为聚焦浏览器回归，不替代 finance/simulation 全量或真实供应商验收。

日志保留于 `/tmp/newfc-independent-backend-focused.log`、`/tmp/newfc-independent-backend-all.log`、`/tmp/newfc-independent-frontend-focused.log`、`/tmp/newfc-independent-frontend-all.log`、`/tmp/newfc-independent-frontend-build.log`、`/tmp/newfc-independent-browser-rerun.log`。前端包体积及后续数据量/交互改进优先级见 [功能完成度检查](function-completeness.md#前后端后续改进优先级)。

## 台账分页与定位复核（2026-10-01）

对应功能 `project_budget`、`project_contract`、`expense_audit`、`cross_domain_search`；任务 T-7 收口，AC-F09/F16/F22/F26、AC-X04/X05。仍为 `811d13a` 基线上的工作区增量，未提交/发布；无新增依赖、迁移或常驻服务。

新增 `/api/contracts/page`、`/api/expense/claims/page`、`/api/project-budget/batches/page`，返回公共分页结构。领域列表和分页共用同一过滤函数；范围与筛选同时应用到 count/items，在短读事务中读取。已有数组接口保持兼容；页面使用分页接口，保存 URL 筛选及页码，改变筛选回第一页。预算深链按 ID 读取，激活前读取当前期间的生效批次并显式确认，后端继续校验 expectedCurrentBatchId。

| 场景 | 证据 | 实际结果 |
|---|---|---|
| 超过旧上限仍可查看旧单据 | `list-pagination.test.ts`，合同与费用各 502 条，其中 1 条在范围外 | 授权总数 501，第一页 20 条，第 26 页能读取旧单据；相同更新时间按 ID 稳定排序；超尾页收敛到实际尾页，空筛选 page=1 |
| 范围裁剪与金额精度 | 同上，金额分为 `9007199254740993n` | 分页返回 `90071992547409.93`；范围外对象不计数、不出现在页内 |
| 预算批次分页与部分可见 | 同上，303 批次含 1 个范围外批次和 1 个混合组织批次 | 受限总数 302，第 31 页可读取较早批次；混合批次只汇总授权金额并标记 partial；年度/期间/状态/关键词过滤有效 |
| 参数与权限 | 同上，三种分页接口 | 非正整数、超大 pageSize、重复 page 参数均 400；未登录 401、无领域读权限 403 |
| URL 条件恢复、分页与重查 | `ExpenseClaims.test.tsx` 新增操作用例 | 从网址恢复组织、关键词及第 26 页；翻页保留筛选；重新搜索回第一页；此前创建/审核刷新场景仍通过 |
| 预算旧批次定位与失败恢复 | `ledgerPagination.test.tsx` | 按 ID 直接读取旧年度批次，不调用有限数组列表；切换 ID 不复用另一对象缓存；失败保留定位并可重试 |
| 激活确认与当前批次不在列表内 | 同上 | 从期间汇总读取列表外的当前批次 #77，确认框展示替换对象；取消不写入，确认请求带 expectedCurrentBatchId=77 |
| 后端全量及类型 | `npx tsc --noEmit && npx vitest run` | 102 文件 / 960 项通过，源码类型检查通过 |
| 前端全量及类型 | `npx vitest run && npx tsc -b` | 43 文件 / 446 项通过，类型检查通过 |
| 隔离构建与浏览器 | 后端 `npx tsc --outDir .e2e-dist`，前端 `npm run build:e2e`；复用上一节临时 Playwright 配置，运行四组 finance 场景 | 12/12 通过；新增真实合同/费用第二页、刷新保留筛选/页码、搜索回第一页及总数场景；既有财报/EAS、投资/预测复核、风险/报告、检索与费用流程仍通过 |

后端聚焦 `list-pagination.test.ts`、`t4-project-budget.test.ts`、`t6-search.test.ts` 共 12/12。所有库仅为系统临时目录或可丢弃的 `backend/data/finance-e2e`，浏览器端口 3761；运行 dist、运行库和其他项目目录未修改。初次组件检查修正了测试查询方法名称；双确认组件用例改用局部文本查询以减少 jsdom 的样式计算，完整回归通过。此证据仍不是 finance/simulation 浏览器全量或真实供应商验收。

日志：`/tmp/newfc-pagination-backend-focused.log`、`/tmp/newfc-pagination-backend-all.log`、`/tmp/newfc-pagination-frontend-focused.log`、`/tmp/newfc-pagination-frontend-types.log`、`/tmp/newfc-pagination-frontend-build.log`、`/tmp/newfc-pagination-browser.log`；前端全量结果由终端会话输出保存于本次工作记录。

## 原有 OCR 服务适配（2026-10-02）

用户要求适配原项目使用的 `https://ocr.tangdalei.com/api`。任务 T-7，AC-F22/F23、AC-X06；代码基线仍为 `811d13a`，本次增量在已有工作区之上，未提交/发布。按原项目历史源码协议重写 TypeScript 适配（来源见 source-provenance.md），仅只读查阅 lishui 源码/历史文档；没有读取其他项目运行配置、运行数据库或真实凭据，没有修改生产产物和服务。

新增 OCR 接口类型、登录账号/密码、识别类型与总超时设置；通用设置页面根据登记表自动显示新增字段。默认保留 JSON 同步接口，原有服务模式在进程内完成表单登录、multipart 上传、每秒查询任务状态和 Markdown 下载，不新增依赖、迁移或常驻服务。网络调用仍在写事务外，成功结果沿用附件 sha256 缓存；失败与空结果记录 OCR_FAILED，仍由人工复核。

| 场景 | 证据 | 实际结果 | 判定 |
|---|---|---|---|
| 原有接口流程 | `ocr-adapter.test.ts` 的真实本地 HTTP 服务 | 登录表单字段、multipart 文件与 api_type 正确；保留 /api 路径前缀；任务 ID 路径编码；processing 后继续查询、完成后读取 Markdown；图片按原文件名与 MIME 上传 | 通过 |
| 异常、时限与凭据 | 同上 | 401、缺 token/任务 ID、失败状态、畸形 JSON、空结果、响应超过 1 MiB、重定向均拒绝；整个流程共用总时限，超时不下载；错误不含密码/token/供应商原文 | 通过 |
| 费用审核与缓存 | 同上，临时目录 SQLite + 真实 HTTP 单据操作 | 识别文字参与住宿/交通材料核对；重跑复用缓存；供应商失败不缓存，单据仍为待人工复核、conclusion 为 null | 通过 |
| 设置与原接口兼容 | 同上及 `master-settings.test.ts`、`t4-expense.test.ts` | 密码不回显/不写审计正文；类型/时限校验；异步根地址拒绝查询参数/片段，整批拒绝不留下其他字段；旧 JSON/OCR 及费用流程通过 | 通过 |
| 相邻业务设置 | `t6-settings.test.ts` | 投资控制阈值跨项校验、默认设置取值与预测超时行为通过 | 通过 |
| 后端源码类型与聚焦回归 | Node 24.21.0；`npx tsc --noEmit`；`npx vitest run tests/ocr-adapter.test.ts tests/t4-expense.test.ts tests/master-settings.test.ts tests/t6-settings.test.ts` | 类型检查通过，4 文件 / 27 项通过（新增 OCR 文件 12 项），日志 `/tmp/newfc-ocr-adapter-checks.log` | 通过 |
| 真实 OCR、浏览器全量及生产发布 | 未执行 | 未取得 newfc 的真实登录凭据；原项目 2026-06-04 的成功记录不替代本次供应商验收。发布后须在 newfc 设置页配置并用真实单据补验；前后端/浏览器全量仍沿用前文记录 | 未执行 |


## 独立项目复查与重新发布（2026-10-02）

对应功能 `platform_auth`、`dashboard`、`operating_budget`、`xiaoli_assistant`、`agent_observability`、`cross_domain_search`；任务 T-7 收口，AC-F01/F03/F08/F20/F21/F26、AC-X04/X07。基线仍为 `811d13a`，本次修复与前文尚未发布的 T-7、分页和 OCR 增量共同发布；未提交。问题与修复清单见 [独立项目排查](independence-audit.md)。

产品修复：左上角统一水利财务分析品牌与图标；原预算编制/实际/分析合并为“经营预算”，保留 12 个叶子路由及权限；首页全部收起、深链仅展开所属组、手动单组展开。修复手机顶栏和检索控件、检索误高亮首页、工作台单位和预算初始化文案。登录/退出/失效清空查询缓存并取消在途查询；个人偏好按服务端用户 ID 隔离；收藏、最近访问及模型调用页签按权限/范围裁剪。再次复查发现助手全局提示词和词典混用预算金额口径，改为按领域区分分、元字符串与显式单位，以及差异的方向含义。

旧显示名/default 偏好可能由不同账号共用，因此不自动迁移到 ID 空间；旧记录保留，收藏/保存视图需重新设置。授权收窄仅隐藏该账号不可用的个人入口，不删除记录。

| 浏览器与构建场景 | 实际执行与结果 | 判定 |
|---|---|---|
| 首次聚焦界面检查 | 18 项：17 通过、1 失败；截图确认手机顶栏账号菜单超出视口，随后修复布局 | 已修复并复验 |
| finance/simulation 全量 | `E2E_FRONTEND_DIST=.e2e-dist npx playwright test --config=.e2e-dist/audit.config.ts`：84 项，80 通过、4 失败；助手/实际页/首页旧选择器误选顶栏控件，手机检索用例误用 textbox 而实际为 searchbox | 首次失败记录保留 |
| 最终构建与受影响场景 | 后端 `npx tsc --outDir .e2e-dist --noEmitOnError`；前端 `npx tsc -b`、Vite 输出 `/tmp/newfc-shell-frontend-final`。复跑 assistant、assistant-dock、cleaning-import、independent-shell、deep-functional-audit、navigation-expansion 共 20 项：19 通过、1 失败 | 主要复验通过 |
| 导入保护最后复验 | 上一轮实际报表已正确定位，但组件输入框被选中标签挡住，点击超时；改为点击该控件的可见 selector 区域，不使用强制点击，不删断言。cleaning-import 两项 2/2 通过，覆盖六步导入与未保存编辑守卫 | 通过 |
| 主界面与会话隔离 | independent-shell 三项均通过：品牌、折叠、12 个叶子入口、深链、高亮、万元仅在对应预算页；桌面暗色与 390px 手机检索/账号菜单；同标签页同名账号切换后重查业务数据且不共用收藏 | 通过 |
| 跨域业务及逐页检查 | 全量中的财报/EAS、合同导入/台账翻页、费用补件/审核/待办、投资/预测复核、风险/报告、检索、受限账号、桌面逐页与各页手机溢出检查通过；失败的跨年度深度交互复验通过，含筛选/穿透/下载/年度关闭/日志 | 通过 |

上述是“全量后按影响复验”的组合证据，不表述成最后一次全量 84/84。浏览器只用本仓库可丢弃的 finance-e2e/e2e-simulation 库和 3761/3762，未对生产执行写入用例。截图 `/tmp/newfc-independent-shell-desktop.png`、`/tmp/newfc-independent-shell-dark.png`、`/tmp/newfc-independent-shell-mobile.png` 已人工核对；修复前手机截图另存 `/tmp/newfc-independent-shell-mobile-before.png`。

日志：`/tmp/newfc-shell-browser-first.log`、`/tmp/newfc-shell-browser-all.log`、`/tmp/newfc-shell-browser-final.log`、`/tmp/newfc-shell-browser-cleaning-final.log`、`/tmp/newfc-shell-backend-final-build.log`、`/tmp/newfc-shell-frontend-final-build.log`。首次全量及 20 项复验的失败 trace、截图和报告分别保存在 `/tmp/newfc-shell-browser-all-results`、`/tmp/newfc-shell-browser-all-report`、`/tmp/newfc-shell-browser-final-results`、`/tmp/newfc-shell-browser-final-report`。

真实模型/OCR 的凭据配置与真实单据输出仍需按原供应商验收补验；协议测试与确定性问答不替代真实供应商验证。附加的后端测试文件类型检查历史错误沿用前文单独记录，不与源码类型/Vitest 混为一项。

发布门禁（`scripts/deploy.sh`，Node 24.21.0）：后端源码 `tsc --noEmit` 与 103 文件 / 972 用例通过；前端 46 文件 / 455 用例通过。包含本次会话缓存隔离三例、同名账号 ID 命名空间、授权入口隐藏与恢复、模型调用页签门禁，以及原有金额/权限/事务/T-7/分页/OCR 回归。实际日志 `/tmp/newfc-shell-deploy-migration.log`。


正式发布：`NEWFC_ROOT=/root/newfc NEWFC_DATA_DIR=/data/newfc-data NEWFC_SERVICE=newfc.service NEWFC_PORT=3760 scripts/deploy.sh` 返回 0；后端正式编译、前端 `tsc -b`/Vite 构建通过。脚本停服后创建迁移前备份，再显式应用 V61～V65，替换产物并启动，就绪检查通过。备份 `/data/newfc-data/backups/pre-migrate-cli-budget-backup-2026-10-02-065635.sqlite`（清单 V60）经只读验证：SQLite 完整性、外键、清单、库摘要及对象清单均通过；上一版保留在 backend/dist.old 与 frontend/dist.old。本次没有恢复生产库，也未把只读备份校验称为新的恢复演练。

线上验证（2026-10-02）：newfc.service 于 06:56:36 CST 启动，active/running、NRestarts=0；本机 3760 与 `https://newfc.tangdalei.com` 的 live/ready 均 200，schema 为 V65，数据库/存储检查通过。两端首页与 favicon 内容和正式 dist 完全一致，未登录 dashboard 均 401。公网真实浏览器加载登录页成功，标题 `newfc 水利财务分析`，无 pageerror；截图 `/tmp/newfc-shell-production-login.png`。验证只发只读请求，没有创建测试账号或写入业务数据。日志 `/tmp/newfc-shell-production-check.log`；部署日志 `/tmp/newfc-shell-deploy-migration.log`。


线上截图补查：登录页仍无条件显示 `npm run admin:create` 初始化命令，已上线实例容易误导普通用户；改为“请使用管理员分配的账号登录，无法登录时请联系管理员。”，命令仍在运行手册。最后仅修改这一句界面文案，未改业务/接口/依赖，按低影响改动执行 `scripts/deploy.sh --skip-tests`；沿用刚完成的 972/455 全量测试，重新完成前后端编译、前端类型检查及正式构建，不为纯文案新增测试。此次无待执行迁移，使用前一次已验证的 V60 备份；dist.old 现在保存首次更新后的 V65 产物。

最终服务于 2026-10-02 06:59:39 CST 启动，active/running、NRestarts=0，部署返回 0；重新执行本机/公网 live/ready、V65、未登录 401、正式首页/图标匹配和备份完整性检查，全部通过。公网浏览器额外断言新账号帮助可见、初始化命令不可见，标题正确且无 pageerror；更新 `/tmp/newfc-shell-production-login.png`。最终构建/部署日志 `/tmp/newfc-shell-deploy.log`，最终线上日志 `/tmp/newfc-shell-production-check.log`；全量测试及迁移日志保留在 `/tmp/newfc-shell-deploy-migration.log`。


## T-7 二次身份排查（2026-10-02，AC-F01/F11/F12、AC-X04）

承接已经部署的独立项目外壳修复，再检查账号切换、在途响应与复核身份。新增修复：CSRF 刷新仅在原账号/权限/组织范围/改密状态不变时重试一次；变化时不重放旧操作，清会话回登录页；旧普通请求、下载和助手流不能返回旧数据或以迟到 401 清掉新会话。可研和预测本人提交提示由服务端按账号 ID 生成，修复同名及改名误判；后台复核权限和例外原因校验继续有效。无新增依赖或迁移。

聚焦后端：`t7-feasibility-workflow`、`t7-forecast-workflow` 共 2 文件 / 4 用例通过，既有完整 HTTP 流程中增加同名/改名、提交人与不同复核人各自读取的身份字段断言。使用临时数据库。后端源码编译至 `.e2e-dist` 通过；前端 `tsc -b` 与隔离 Vite 构建至 `/tmp/newfc-followup-frontend` 通过。日志 `/tmp/newfc-followup-backend-focused.log`、`/tmp/newfc-followup-backend-build.log`、`/tmp/newfc-followup-frontend-build.log`。

前端聚焦最终验证：4 文件 / 33 用例通过（client、assistant.session、AuthGate、reviewWorkflow）。覆盖账号/权限/组织/改密变化不重试，解码及令牌刷新期间切换会话，迟到 200/401 与 SSE，不同账号同名/实际提交人改名的可研和预测弹窗实际提交，以及既有缓存与过期稿保护。页面用例首轮两项超过默认 5 秒；改为定位具体确认文本并给新增 Antd 交互用例 20 秒时限后完整复验通过，保留所有业务断言。日志 `/tmp/newfc-followup-focused-final.log`，首轮日志 `/tmp/newfc-followup-review-ui.log`。

隔离浏览器回归：finance 项目共 19/19 通过，包含 auth-session、independent-shell、assistant、assistant-dock、risk-investment。新增双页共享 Cookie 场景：A 页留有未提交供应商表单，B 页退出并登录另一账号，A 页写请求只返回一次 403，无重试，回登录页且旧弹窗卸载；服务端检索确认未创建供应商，B 页保持登录。其余覆盖品牌/默认折叠/深链/手机、同名账号偏好隔离、助手一次性与流式、投资控制、可研/预测冻结与情景、风险报告。只使用可丢弃夹具库 3761/3762，没有生产写入。日志 `/tmp/newfc-followup-browser.log`。本轮不重复前一轮全站 84 项审计，范围与组合证据见上文。

正式发布门禁：Node 24.21.0，`scripts/deploy.sh` 的后端源码类型检查、103 文件 / 972 用例，以及前端 47 文件 / 469 用例全部通过，包含全部已有金额、授权、事务、分页、OCR、工作流与新增身份回归。日志 `/tmp/newfc-followup-deploy.log`。

正式重新部署：`NEWFC_ROOT=/root/newfc NEWFC_DATA_DIR=/data/newfc-data NEWFC_SERVICE=newfc.service NEWFC_PORT=3760 scripts/deploy.sh` 返回 0；前后端 dist.new 编译、前端类型与 Vite 构建通过，停服、显式迁移检查、替换、启动及就绪检查成功。本次数据库已是最新版本，没有待执行迁移，也未创建新的迁移前备份；schema 保持 V65，上一版代码产物保留在 dist.old。

线上只读验证（2026-10-02 07:36:33 CST 启动）：newfc.service 为 active/running，NRestarts=0；本机 3760 与 `https://newfc.tangdalei.com` 的 live/ready 均 200，数据库、V65 schema、存储检查通过；未登录 dashboard 均 401，首页和 favicon 内容均与正式 dist 一致。公网 Chromium 加载登录页，标题 `newfc 水利财务分析`、账号帮助正确，无 pageerror。没有生产测试账号或业务写入。日志 `/tmp/newfc-followup-production-check.log`、`/tmp/newfc-followup-service-status.log`；截图 `/tmp/newfc-followup-production-login.png`；完整发布日志 `/tmp/newfc-followup-deploy.log`。

## F20 助手全领域补齐（2026-10-02，AC-F20、AC-X04/X06）

本轮为已授权的助手功能补齐，仅修改工作区源码及验收文档，未提交或发布。页面能力目录从 28 个扩为 50 个，新增独立领域 ID、只读工具、当前页签/筛选/详情上下文、名称歧义澄清、规则降级摘要、精确金额事实与实际来源深链。覆盖经营预算之外的 EAS、财报/趋势、管理会计、项目预算、计划、合同、报销/制度、可研、投资控制、预测、风险、报告、治理、主数据、任务与配置等入口；详细契约唯一维护于 `specs/ai.md`。

关键验收：`90071992547409.93` 元的合同金额从 service 到问答与引用保持字符串精度；预测版本与经营预算版本同号时不混用，可研/投资项目不误读主数据项目。范围外、缺权限、伪造详情 ID、对象与组织冲突被拒绝；模型遗漏 ID 自动补齐，冲突参数不查询其他对象。筛选后合同只返回命中行；管理会计模型参数保留所选指标、期间及分组；EAS 待处理更正、预测撤回记录与主数据页签保留各自过滤。2025-05 历史财报批次在当前年度环境中仍返回 2025 年及实际期间，显式年度/月度冲突返回 409，不换成当前生效数据。费用只引用当前审核运行，制度无命中明确说明，模型故障仍输出真实规则事实和流式正文。聊天不付款、复核、批准或发布。

自动化证据（Node 24.21.0；全部测试库为临时目录/内存库）：

- 本轮前段后端全量 `tsc --noEmit && vitest run`：104 文件 / 983 用例通过；前端全量：49 文件 / 473 用例通过。后续增补三个领域用例及收尾修复后，没有把前段全量结果冒充最终完整全量结果。
- 收尾后端类型检查及 `assistant-domains`、`assistant-context-v2`、`assistant.routing`、`assistant` 聚焦回归：4 文件 / 121 用例通过；最后合同中文状态/查询意图修正后，`assistant-domains` 15/15 再次通过，后端隔离编译至 `.e2e-dist` 成功。
- 收尾前端 `domainContext`、`DomainFactView`、`pageContext`、`workspaceScope`：4 文件 / 41 用例通过；`tsc -b` 与隔离 Vite 构建成功，产物仅在 `.e2e-dist`。最终构建日志 `/tmp/newfc-assistant-frontend-final-build.log`。
- Chromium finance 项目 `assistant-dock` 与 `assistant-domains`：最终构建后 5/5 通过（32.8 秒），包含手机输入区滚动可达性与推荐单列断言；日志 `/tmp/newfc-assistant-browser-final.log`。测试从临时目录 `/tmp/newfc-assistant-qa-9Xohhh` 的一次性 SQLite 夹具运行，服务仅绑定 3761，无生产库/生产服务写入。使用 `E2E_USE_EXISTING_SERVER=1 E2E_TARGET_IS_DISPOSABLE=1`，没有运行默认仓库目录 seed。
- 手机输入后等待布局稳定、再次滚动定位并重拍截图，跨域浏览器场景 1/1 通过（15.0 秒）；日志 `/tmp/newfc-assistant-browser-mobile-final.log`。复核结束已关闭本轮临时 3761 服务。
- 受控模型响应验证工具注参、冲突拒绝、全部工具失败降级与供应商超时；这些是协议/降级测试，不代表真实外部模型供应商或 OCR 单据已经验收。

浏览器及视觉复核保留既有「年度账册」风格，未重设计。任务视角发现助手被合同抽屉遮挡，工程视角发现手机消息区高度归零，窄屏阅读视角发现推荐问题双列截断；分别修复浮层层级、手机整页滚动与单列推荐，并复拍验证。首屏可见业务范围，输入区可滚动访问；桌面与 390×844 手机页面均无页面横向溢出。截图保存在 [助手 QA 目录](qa/README.md)：`assistant-contract-desktop.png`、`assistant-contract-mobile.png`、`assistant-home-desktop.png`、`assistant-home-mobile.png`、`assistant-home-mobile-composer.png`。

边界：制度查询当前是关键词匹配，未宣称语义召回；列表按有界条数显示，不宣称全库金额汇总；正式财务写入仍走业务页面。外部模型/OCR 的真实业务单据联调、生产发布均未在本轮执行。没有新增常驻中间件、依赖或数据库迁移，没有访问其他项目运行目录。

## F20 线上发布与真实供应商联调准备（2026-10-02，AC-F20、AC-F22/F23、AC-X04/X06）

用户明确要求“部署到线上；真实模型和 OCR 单据联调”后，执行 `NEWFC_ROOT=/root/newfc NEWFC_DATA_DIR=/data/newfc-data NEWFC_SERVICE=newfc.service NEWFC_PORT=3760 scripts/deploy.sh`，返回 0。Node 24.21.0 发布门禁：后端 `tsc --noEmit`、104 文件 / 987 用例通过；前端 49 文件 / 473 用例通过。后端正式编译、前端 `tsc -b` 与 Vite 构建到 dist.new 均成功；随后停服、显式迁移检查、替换、启动和就绪检查完成。schema 保持 V65，无待执行迁移，未创建新的迁移前备份，上一版代码保留在 backend/dist.old、frontend/dist.old。既有 V60 迁移前备份另经只读完整性、外键、清单、库摘要及对象清单核验通过；未执行恢复演练。发布日志 `/tmp/newfc-assistant-production-deploy.log`。

生产服务于 2026-10-02 14:25:31 CST 启动，active/running、NRestarts=0。本机 3760 与 `https://newfc.tangdalei.com` 的 live/ready 均返回 200，数据库、V65 schema、存储检查通过；两端首页与 favicon 摘要均与正式 dist 一致，未登录 dashboard 均 401。正式后端产物包含 50 个页面能力及 19 个新增领域工具。使用只读生产数据库连接、从数据库加载既有管理员 AuthContext，对合同汇总、费用队列、预测运行、风险汇总、授权范围和配置概览六个只读工具完成 service 验证；未创建生产测试账号/会话或写入测试业务。公网 Chromium 登录页标题及账号帮助正确，无 pageerror。结果与截图见 [生产检查 JSON](qa/README.md)、[生产登录页](qa/README.md)，控制台日志 `/tmp/newfc-assistant-production-check.log`。

真实联调的就绪检查发现：newfc.env 无模型地址、模型名或密钥，数据库无模型渠道/功能绑定及 OCR 设置；报销单、附件、文件对象均为 0。已向用户请求在 newfc 后台配置凭据，或提供本机安全配置文件路径，以及脱敏真实单据路径、金额与预期结果。没有读取或复制其他项目运行配置，没有在聊天/日志中输出凭据。

已完成真实网络协议核对：SiliconFlow `/v1/models` 未认证请求返回 401；通过与生产适配相同的 Node fetch 访问 OCR 首页和 `/openapi.json` 均 200，线上 OpenAPI 版本 2.0.0 包含 `/api/auth/token`、`/api/ocr/pdf`、`/api/status/{task_id}`、`/api/download/{task_id}`。登录为 username/password 表单，上传必填 api_type/file，完成状态 completed，与现有适配一致。在线 schema 留存于 `/tmp/newfc-ocr-provider-schema.json`；脱敏就绪报告见 [联调状态](qa/README.md)。这证明网络和公开协议可达，**不代表认证、真实模型推理、OCR 单据识别或费用审核结果已验收**；缺少凭据与样本时未伪造联调成功。


## 模型与 OCR 配置接入（2026-10-02 20:10 CST）

用户明确授权接入并提供 newfc 模型/OCR 凭据后，调用线上正式编译产物的渠道、绑定与业务设置 service；身份由数据库中有效管理员 `tangdalei` 构建，验证 `settings:manage` 与全组织权限，以 CLI 上下文写入脱敏审计。配置先全量校验、后短事务提交，外呼在事务外执行；未读取或修改其他项目运行库，没有创建生产测试账号、会话、报销单或附件。

- 主模型渠道 `New API Gemini`：`https://new-api.tangdalei.com/v1`，`gemini-flash-latest`，超时 60 秒、启用流式；七项 AI 功能均绑定该渠道。模型凭据仅保存在 newfc 运行库，不写入 Git/验收日志。
- OCR：`tangdalei_http`，`https://ocr.tangdalei.com/api`，登录账号/密码已配置；类型 `1`，异步超时 120 秒。没有引入 Dify/DB-GPT、嵌入或重排服务。
- 配置前创建独立 SQLite 备份（文件权限 600），只读完整性检查通过；备份路径与 SHA-256 见证据。渠道和业务设置均由每次调用读取，无需重启；结束时生产 ready/V65 通过。本次只接入配置，没有重新构建或发布当前工作树代码。

| 真实供应商检查 | 实际结果 | 判定 |
|---|---|---|
| 模型渠道连通 | 成功，7,812 ms；系统按超过 5 秒标记 degraded，表示响应较慢 | 可用，有延迟 |
| 模型工具调用 | 指定只读测试工具和 `sample_id` 参数匹配，4,180 ms | 通过 |
| 模型 SSE 流式 | 收到正文标记和最终结果，2,256 ms | 通过 |
| OCR 登录 | HTTP 200，取得 token；未记录 token | 通过 |
| OCR 异步识别 | 合成栅格 PDF 的登录→上传→状态轮询→Markdown 下载完整成功，15,477 ms；`NEWFC-TEST-20261002`、`2026-10-02`、`123.45` 均一致 | 通过（合成样本） |
| 真实业务单据费用验收 | 仍未取得脱敏真实单据与人工期望；本次未创建生产业务数据 | 未执行 |

脱敏结果与配置前备份摘要见 [provider-activation.json](qa/README.md)。此前“未配置”的就绪报告是接入前的历史快照；现已接入并验证供应商实际调用，真实业务验收仍须单独补齐。


## 合成单据收尾与字段修复发布（2026-10-02）

范围：T-7；AC-F07/F22/F23、AC-X03/X04/X06/X08。用户明确要求完成费用联调与字段修复发布，并说明“不需要真实单据”，本轮使用明确标记 SYNTHETIC TEST ONLY 的合成栅格 PDF 完成收尾，不再等待真实单据。基线为 `811d13a` 加当前增量，未创建新提交；发布源为 `/root/newfc`，只合入当前工作树的字段控件修复及其回归测试，保留生产源码已有的助手、分页、身份隔离和 OCR 异步适配。

验收实例使用独立临时 SQLite 夹具，经真实登录、CSRF、组织授权及同源 HTTP/API 流程操作。供应商使用已配置的 New API/gemini-flash-latest 和 tangdalei OCR，未模拟模型或 OCR 响应；外呼不在写事务内。

| 场景 | 预期与实际 | 结果 |
|---|---|---|
| 首轮提交 | 合成金额 `6000.00`、日期 `2026-10-02`、编号 `SYN-20261002-001` 均被 OCR 正确识别；模型与 OCR 状态均为 ok。制度上限 `5000.00`，返回 LIMIT_EXCEEDED 及真实条款引用，缺 Accommodation 返回 MATERIAL_MISSING | 通过 |
| 模型建议与待复核 | 模型建议指出超限、缺材料和测试凭证标识；页面显示待复核，正式结论 null。两次费用模型调用均 success，分别 9336/9615 ms | 通过 |
| 权限 | 跨组织详情 404；提交人无复核权限返回 403 | 通过 |
| 补件重审 | 独立复核人退回补件，增加 Accommodation 合成证明后重新提交；缺材料规则消失，超限仍保留，新审核结论仍为空 | 通过 |
| 人工门禁 | 旧 runId 返回 EXPENSE_RUN_STALE；高风险无例外理由返回 EXPENSE_EXCEPTION_REQUIRED；不同复核人填写明确合成测试例外后通过，selfReview=false；已结论再次复核返回 CLAIM_STATE | 通过 |
| 字段保存 | 浏览器在新建项目录入 `1234567890123.123456`，API 持久值与项目档案显示完全一致；组件回归另覆盖文本、日期及字典项 | 通过 |
| 隔离与清理 | 前后生产 ex_claim、ex_attachment、file_object 均为 0；临时库的渠道密钥、OCR 密码及会话已清理，库与证据的凭据排除扫描通过 | 通过 |

发布运行 `/root/newfc/scripts/deploy.sh`（未跳过测试），Node 24.21.0。后端 tsc 与 104 文件 / 987 测试通过；前端 50 文件 / 474 测试通过，tsc -b、正式前后端构建通过。显式迁移检查后 schema 保持 V65、无待执行迁移，正式产物替换及启动就绪成功，上一版产物保留在 dist.old。最终启动与健康信息见 release.json；本机与公网 live/ready 均 200，首页及首页引用的全部 JS/CSS 与正式 dist 的 SHA-256 一致，未登录 dashboard 返回 401。七项模型绑定与 OCR 配置在重启后保持有效。

脱敏证据见 [收尾目录](qa/README.md)、[流程结果](qa/README.md)、[发布核验](qa/README.md)。历史“等待真实单据”的记录保留为当时状态；本次按用户确认以合成样本完成这两项收尾。未执行真实业务单据识别准确率评估，合成测试中的人工批准只存在临时库。


## 全仓库独立化清理（2026-10-02）

T-0/T-7；AC-X01、AC-F20/F22。用户明确要求整个仓库清理非必要来源项目痕迹，保留确有必要的兼容与业务口径。本轮删除两个混用 newfc 本地数据库与旧 3748 API 的初始化运维流程，提取纯模拟主数据；前端统一财务助手、FinanceEmpty、newfc 样式/变量/事件/浏览器键，保留同源账号 ID 偏好迁移；制度样本及测试改名，已发布业务编码保持不变。现行文档与接口示例已同步；来源、历史证据、安全拒绝规则、离线快照兼容、迁移名称和业务映射均保留并说明理由。详见 [仓库独立化记录](repository-independence.md)。

Node 24.21.0。后端 tsc 与 104 文件 / 988 用例通过；前端全量 51 文件 / 477 用例通过。最终标签迁移逻辑及新增用例经兼容专项 3 文件 / 27 用例通过；最终前端 tsc -b 与前后端隔离构建通过。最终制度/隔离专项 2 文件 / 9 用例通过，补强后的源码/样式隔离门禁 8 用例通过。finance/simulation 浏览器运行 assistant-dock、fullscreen、independent-shell、navigation-expansion，共 11/11 通过；亮暗桌面与手机截图人工复查通过。E2E 配置加载即拒绝 3748/3760，未发请求；基线比对确认迁移、前后端组织/科目映射、模拟主数据、制度编码和规则没有改变。git diff --check 通过。

产物仅写入各自 `.e2e-dist`；未替换正式 dist、部署或修改生产库，无新增迁移，schema 保持 V65。未访问原项目目录、数据库、服务或端口；未创建 Git 提交、remote 或推送，保留此前工作树修改。历史验收中的旧文件名、品牌和制度发布命令继续表示当时真实执行记录，不做追溯改写。脱敏摘要、复现命令与截图见 [验收目录](qa/README.md)。


## v0.1.0 公开发布准备（2026-10-02）

T-0～T-7；AC-F01～F26、AC-X01～X10 的已记录场景。用户明确要求整理首个公开版本并推送 GitHub，指定仓库名 newfc；已创建独立公开仓库 `chouleilei/newfc` 和 origin，并启用私密漏洞报告。项目开源许可证待定，本次不擅自附加 MIT 授权，来源和许可状态见 NOTICE.md。

公开版补充安装说明、模拟截图、通用 nginx 示例、源码来源与第三方声明、依赖更新和本地密钥扫描。内部 QA 原件留本地，忽略运行配置、数据库和备份；原始运维文档副本保留在被忽略的 docs/private 中。

独立目录安装新锁文件：Node 24.21.0；后端 104 文件 / 988 项、前端 51 文件 / 478 项最终全量通过；源码类型与正式构建通过。Playwright 新内核安装完成后 finance/simulation 专项最终 11/11 通过。空库实际迁移至 V65、管理员创建、登录、HttpOnly/SameSite=Strict Cookie、匿名 API 拒绝及 SPA/ready 均通过。前后端 npm audit 均零漏洞。完整 Git 历史与公开文件（含压缩/解码）经 Gitleaks 8.30.1 核查，仅精确排除两处已核实的测试值后通过。首次环境差异与最终复验分列，详见 public-release.md。

本轮未执行生产部署、未替换正式 dist 或 node_modules、未改变生产 schema/配置/业务数据，未访问其他项目运行目录。

公开发布收尾：用户明确要求不增加 GitHub CI 复杂度，本次移除尚未正式发布的 Actions/Dependabot 配置，取消运行并关闭仓库 Actions；最终版本以已通过的本地验收为依据。


## MIT 开源授权（2026-10-02）

T-0/T-7；AC-X01/X10。用户明确要求“开源 mit”，添加标准 MIT LICENSE（Copyright 2026 newfc contributors），前后端 package.json 与锁文件根包元数据声明 MIT；README、NOTICE、来源记录、公开版说明和远程事项同步。MIT 授权明确包含本仓库源码及 v0.1.0 发布源码，第三方依赖保留原有授权。

本次仅修改许可、文档和包元数据，依赖版本、业务代码与生产服务没有变化。本地核对 MIT 标准文本、包/锁文件一致性、文档链接及 git diff --check；沿用已通过的本地发布验证，不重跑业务测试或启用 GitHub CI。v0.1.0 已发布标签保持原提交，发布说明明确授权范围并附 LICENSE 文件，避免改写已发布版本。

## T-8.1 / T-8.2 页面与工具统一来源（2026-10-02）

F07/F20/F24/F26；T-8.1、T-8.2；AC-T8-01/02/03 的源码与聚焦测试证据。页面目录及权限码迁入纯数据 contracts，50 个实际页面/页签由前后端共同引用；菜单、标题、授权导航、收藏/最近访问以及检索结果路径改用目录。未知路由不猜范围，任务中心要求 tasks:read。实际覆盖见 [页面与工具清单](t8-assistant-inventory.md)。

79 个既有工具统一为按域 ToolDefinition，Zod 同时负责运行参数解析与模型 schema（锁定 zod-to-json-schema 3.25.0），标签、能力、权限与分发由定义派生；规则与模型均进入 executeTool。未知工具/字段拒绝；多类型工具按解析后的 kind 校验领域权限。删除平行权限/标签/schema/能力工具表、逐工具分发 switch 和读取前端源码的目录/检索契约测试。保留领域 service 的二次权限和组织检查。

Node 24.21.0；后端 `npx tsc --noEmit` 与 9 文件 / 47 用例通过（t8-tool-contract、page-capabilities.contract、assistant.catalog-tools、assistant-scope、assistant.extensions、t6-search、t3-assistant、t4-assistant、t5-linkage）。前端 `npx tsc -b` 与 5 文件 / 53 用例通过（App、pageContext、domainContext、AssistantContextRegistry、userPrefs）。CommonJS 实际加载注册表为 79 项；git diff --check 通过。此前未知参数忽略的测试改为明确拒绝，并用合法参数验证越权，避免参数错误掩盖授权问题。

这是两个相互引用目录及消费者的连续迁移提交；T-8.3～T-8.6、最终浏览器/全量/构建/迁移/资源门禁仍待完成，不标记全阶段完成。测试只用临时/内存数据库，未部署或迁移生产库。

## T-8.3 单一页面快照与历史响应迁移（2026-10-03）

F07/F20/F24/F26；T-8.3；AC-T8-04/05/06 与 AC-T8-03 的源码、聚焦及临时文件库证据。共享契约统一到 `contracts/assistant.ts`，范围字段统一为 orgScopeId/accountScopeId/pageKey。聊天、SSE、归因、报告与导入辅助均消费 pageContext；HTTP/SSE 共用只读预检，在响应头、模型或会话落库之前拒绝旧单传/双传、缺快照、未知版本/页面及资源冲突。独立助手发送空或实际手动筛选的快照，页面登记缺失时阻止发送，去掉 URL 猜范围、兼容字段映射和合并状态。失败/协议刷新提示保留输入。

V66 仅规范化 ai_message.response_json 的上下文元数据：已知范围映射到 effectiveContext/contextTrace，历史范围标记 historical，未知范围保存 historicalRange 并标记不可续用；损坏 JSON 报记录 ID，整个迁移回滚。正文、事实、引用、金额字符串、归属及生命周期不重算。运行入口没有旧 JSON reader；历史追问核对当前授权，模型历史摘要也过滤无法核验的旧范围。业务报告 service 使用独立正式 DTO，页面报告入口先核验快照。

Node 24.21.0；后端源码 `npx tsc --noEmit` 通过。助手及报告/导航/预算闭环扩展回归 19 文件 / 302 项通过；追加历史模型授权用例后，t8-protocol 与 assistant.routing 2 文件 / 58 项通过。前端 pageContext、Registry、domainContext、session 4 文件 / 27 项与 `npx tsc -b` 通过。`npx tsc -p tsconfig.test.json` 中本次触及文件无类型错误；仍有未触及的 t4-contracts、t5 投资/预测等旧 HTTP Response.json unknown 类型错误，后续阶段全量记录，不关闭检查。

临时文件库实际验证 V65→V66、重复 migrate 不转换、坏 JSON 回滚、迁移前完整备份包及现有 restoreBackup 恢复后重迁移到 V66；已知历史组织授权撤销后拒绝追问，明确选择新范围时旧正文/事实不进入受控模型。前端路由/页签/范围变更清理焦点和选区，失败输入保留的浏览器门禁仍在阶段最终 E2E 中核对。

T-8.4～T-8.6 与最终全量/浏览器/构建/资源门禁未完成，不能据此标记 T-8 完成。生产 schema 仍为 V65；未部署、未运行生产迁移或替换正式产物。

## T-8.4～T-8.6 / 阶段完成（2026-10-03）

F07/F08/F20/F23/F24/F26；T-8.1～T-8.6；AC-T8-01～16、AC-X01/X03/X04/X05/X06/X08/X09/X10。实现提交：`a8c5f39`（页面/工具目录）、`2bd01e4`（单协议/V66）、`c2061a9`（配置草稿/字段/真实选区）、`a957791`（文档/资源/回归收口）；浏览器测试修正 `a5a3efc`、`8953b98`。覆盖清单见 [t8-assistant-inventory.md](t8-assistant-inventory.md)。本记录关闭代码实施与阶段验收；生产发布另行记录。

六类配置草稿与正式操作共用领域校验，接入真实表单、移动/状态操作、字段帮助及问题定位。清洗暂存文件按当前用户、SHA-256、目标、有效期和业务基线只读核验；不续期，不创建树快照或导入批次。预算/实际网格 bounds 从同源事实读取并按叶子去重，金额与数量用 bigint 分别累计；指标/别名 refs 核验每个对象，query 复用列表筛选且包含分页外匹配项。服务端绑定选择范围，模型工具参数不能覆盖；超限、失效、冲突和不支持的分析明确拒绝。

### 专项验收证据

下列文件位于 backend/tests、frontend/src/assistant 或 frontend/tests/e2e；所有条目通过。样本为本仓库 `buildFixture`/`standardBudgetVersion`、finance-e2e/e2e-simulation 可丢弃夹具及临时生成 Excel，不使用业务运行库。

| ID | 实际证据与可观察结果 |
|---|---|
| AC-T8-01 | `pageContext`、`domainContext`、`App`、`userPrefs`、`Search`、页面目录契约测试；`assistant-pages`、`independent-shell`、`navigation-expansion` 浏览器用例。50 页面/页签共用目录，菜单短名与完整页名显式区分，动态路由、深链、未知路径与授权导航通过；独立前端构建通过。 |
| AC-T8-02 | `t8-tool-contract`、`assistant.catalog-tools`、`page-capabilities.contract`：81 工具同一执行定义，schema 必填/枚举/长度/边界/未知参数正负例与运行校验一致，未知工具拒绝；模型与规则复用执行器。 |
| AC-T8-03 | `assistant-scope`、`t8-tool-contract`、`t8-config-drafts`、`t8-cleaning-draft`、`t8-selection`、`t8-protocol`；`scope-restricted`：按 kind 验权，组织/科目/文件/实体范围检查先于取数，历史追问使用现时授权，范围外事实和引用不返回。 |
| AC-T8-04 | `t8-protocol`、`assistant-page-context`、`assistant.session`、`assistant-dock`：所有入口只发送 pageContext；旧单传/双传/缺快照/未知版本及页面在 HTTP/SSE 模型调用或会话写入前失败，刷新提示保留输入，独立助手空 scope 正常。 |
| AC-T8-05 | `assistant-page-context`、`assistant-context-v2.integration`（保留的测试文件名，内部使用唯一新协议）、Registry 18 项、`assistant-t8`：范围优先级/冲突、未就绪阻止、最新输入序列化及路由/对象/浮层/焦点/选择清理通过，旧清理 token 不覆盖新选择。 |
| AC-T8-06 | `t8-protocol` 临时文件库 V65→V66、重复迁移、损坏 JSON 整体回滚、迁移前完整备份与 restoreBackup 恢复后重迁移；正文、引用、原始事实、金额、归属不改，未知范围拒绝含糊追问，撤销授权后不向模型发送旧范围内容。详见前述 T-8.3 记录。 |
| AC-T8-07 | `t8-config-drafts`、`ratio.metrics`、`management.metrics`；`assistant-t8` 线性/比率真实弹窗：多跳循环、失效/停用引用、分子分母及数量汇总约束同正式保存；显示未保存与“已有定稿快照不会重算”。 |
| AC-T8-08 | `t8-config-drafts` 与测算回归；`assistant-t8`：引用/输出/税率校验同正式规则，指定版本的只读试算与正式计算一致，无版本明确不计算；沿用金额依据规则，不能计算的金额项列明 skipped，不保存规则或预算条目。 |
| AC-T8-09 | `t8-cleaning-draft` 7 项、`t8-config-drafts`、清洗回归；`assistant-t8`、`cleaning-import`、UX31-S5：实际区域/列/单位/符号/映射/覆盖影响可分析；规范化别名冲突同正式校验；他人/过期/篡改/错目标/基线变化文件拒绝，无批次/模板/别名写入。 |
| AC-T8-10 | `t8-config-drafts`；`assistant-t8` 组织/科目真实表单：部分更新、循环移动、状态操作、不可变字段、单位/指标引用及汇总约束同正式操作；草稿不改当前树或历史快照。 |
| AC-T8-11 | `t8-config-drafts` 字段白名单与受控模型、Registry、`assistant-t8` 六类表单：字段帮助使用当前字段事实，问题可定位，hover 不改焦点；关闭助手/弹窗保持未保存输入，清洗窄屏实际可操作。 |
| AC-T8-12 | `t8-selection` 与 `grid-interaction`：预算父子去重金额 150.00、稀疏科目金额 -80.00、草稿金额 123.45 与数量 1.2345 分开；实际当前累计金额 90.01；不含范围外草稿，清空恢复页面范围，历史视图明确不支持。 |
| AC-T8-13 | `t8-selection`、`assistant-page-context`、Registry；`assistant-t8` 指标/别名实际多选：只分析选中 ID，失效/越权/超限/冲突拒绝，模型不能覆盖选区；编辑与切页签清理。 |
| AC-T8-14 | `t8-selection`；`assistant-t8` 指标/别名实际筛选入口：service 全匹配集合包含分页外对象，先核对总量，超过 500 明确拒绝，详情 30 项截断标识真实；伪造总数/行数据/未知筛选不改变事实，不支持工具不忽略选择。 |
| AC-T8-15 | `t8-config-drafts` 11 项、`t8-selection` 10 项、`t8-cleaning-draft`、`assistant.routing`：六配置受控 JSON 模型及 onToken、上游失败、无模型；真实工具分片流/超时/取消协议回归。原始表单标记、备注、文件令牌/指纹不进上游或持久响应；取消不落会话或业务，正常回答除会话/审计/调用账本外无业务写入。受控模型验证不表示供应商真实外呼。 |
| AC-T8-16 | 最终类型/全量单测、finance/simulation 浏览器全部场景组合复验、隔离产物构建、V66 迁移恢复、资源实测通过；OpenAPI/mock/生成目录/实现说明与资源脚本已更新，旧协议只保留拒绝负例和历史追溯，运行时无旧 reader。 |

### 最终门禁

Node v24.21.0，Linux 6.12.90，4 vCPU / 7.9 GiB。后端只在临时/内存库测试；浏览器使用本仓库可重建 finance-e2e/e2e-simulation，端口 3761/3762；资源使用临时库和 3763。后端隔离输出 `.t8-dist`，前端输出 `/tmp/newfc-t8-frontend`，结束后移除后端临时产物。

| 执行 | 实际结果 |
|---|---|
| backend `npx tsc --noEmit`、`npx vitest run` | 源码类型通过；109 文件 / 1026 项通过。最终助手/草稿/清洗/选择/协议聚焦 5 文件 / 86 项也通过。 |
| frontend `npx vitest run`、`npx tsc -b` | 51 文件 / 480 项通过，类型通过。 |
| backend `npx tsc --outDir .t8-dist --noEmitOnError`；frontend `npm run build:e2e -- --outDir /tmp/newfc-t8-frontend` | 独立构建通过，正式 dist 未替换。 |
| `E2E_BACKEND_DIST=.t8-dist E2E_FRONTEND_DIST=/tmp/newfc-t8-frontend npx playwright test --workers=1` | 全部 94 项实际执行：90 通过 / 4 失败，34.1 分钟；两处 T-8 断言及 UX31-S1/S9 失败按下行复验。 |
| 同环境 `npx playwright test assistant-t8.spec.ts usability-trial.spec.ts --workers=1`；最终 `npx playwright test usability-trial.spec.ts --workers=1` | 受影响 15 项复验为 13 通过 / 2 失败，其中新增 T-8 8/8 通过；修正首次编制入口定位及业务录入 helper 后，UX31 最终 7/7 通过（10.2 分钟）。完整轮与受影响复验合计覆盖全部 94 场景通过，未表述为单轮 94/94。 |
| `npm run resource:baseline -- --dist .t8-dist/index.js --port 3763 --out /tmp/newfc-t8-resource-final.json` | 全部负载断言通过，指标如下。 |
| backend `npx tsc -p tsconfig.test.json` | 附加检查仍有 443 条未触及的 T-4～T-7 HTTP Response.json unknown 等遗留类型错误；本次触及助手、T-8 与脚本文件无错误。与既有差异一致，不关闭类型检查、不宣称全测试 TS 通过。 |

浏览器首轮全部 94 项执行为 84 通过 / 10 失败，发现服务端范围 label 丢失、菜单短名与完整页名期待及旧组件定位/断言差异；范围 label 已修并追加后端回归，其他断言按真实 UI/回答调整。最终全量为 90 通过 / 4 失败：清洗焦点定位与比率历史提示断言已修正；UX31-S1/S9 在末尾因大网格操作/保存总时长失败。中间 `--last-failed` 复验为 1 通过 / 2 失败 / 1 未执行（诊断后主动停止）；定位到比率树选择器关闭动画与下一弹层竞争，补等待关闭后 T-8 全部 8 项通过。受影响 15 项复验为 13 通过 / 2 失败，又暴露首次编制同名创建按钮定位歧义及逐字符慢速录入触发多轮防抖保存。入口明确选择工具栏，UX31 使用标准整值 fill 并按 Enter 提交；业务断言、180/300 秒时限与默认完整 trace 均保留，最终 UX31 7/7 通过，S1 为 2.7 分钟、S9 为 1.2 分钟。逐键输入/移动/撤销与矩阵粘贴仍有完整轮 grid-interaction 通过证据。本次收尾仅修正测试同步/定位/录入方式，产品代码未再改动；不改写失败轮，不伪称单轮全部通过。

### 资源验收（OPEN-04 / AC-X09）

规模 106 组织、200 叶子科目。冷启动 1139 ms，稳定空闲 RSS 112.1 MiB；20,000 行导入 2486 ms、峰值 RSS 365.4 MiB、预览/确认均 HTTP 200；期间普通查询 37 次 / 0 错误，p95 612.9 ms。20,001 行返回 HTTP 400 / VALIDATION_FAILED。

400 格选择 HTTP 200 / 520 ms，真实 count=400、details=30、truncated=true；六配置全部 HTTP 200 / 10～47 ms，五合法草稿 issues=0，刻意不完整清洗草稿 issues=1，证明返回校验事实。2,000 格预测 succeeded / 262 ms；报告发布、敏感性、跨域检索、无模型降级均成功。观测最高 RSS 383.9 MiB，最终 RSS 378.5 / HWM 383.3 MiB；满足空闲 ≤150、峰值 ≤512 MiB、最大导入 ≤15 s、普通 p95 ≤1.5 s 门槛。

日志：`/tmp/newfc-t8-backend-full-final4.log`、`/tmp/newfc-t8-source-types-final4.log`、`/tmp/newfc-t8-final-regression.log`、`/tmp/newfc-t8-frontend-after-field-search.log`、`/tmp/newfc-t8-frontend-types-after-field-search.log`、`/tmp/newfc-t8-build-final3.log`、`/tmp/newfc-t8-build-frontend-final3.log`、`/tmp/newfc-t8-full-browser.log`、`/tmp/newfc-t8-browser-final2.log`、`/tmp/newfc-t8-browser-failed-rerun.log`、`/tmp/newfc-t8-browser-affected-final.log`、`/tmp/newfc-t8-browser-ux31-final.log`、`/tmp/newfc-t8-resource-final.json`、`/tmp/newfc-t8-test-types-final3.log`。本机日志路径是执行证据，非公开下载地址。

**未部署、未执行生产迁移、未替换正式产物；生产仍为 T-0～T-7 / schema V65。V66 仅临时库完成迁移与备份恢复验证。** 本阶段未访问 newbd 或 lishui 的运行目录/服务；源码来源、历史文档与已确认业务口径保留。发布时需前后端同版本与显式迁移，旧页面协议刷新路径已验证。
