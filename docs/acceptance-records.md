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
