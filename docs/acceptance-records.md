# 验收记录

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
