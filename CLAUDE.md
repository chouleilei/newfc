# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

以上为项目规则（硬性边界、命令、代码结构），以下只补充 AGENTS.md 未覆盖的内容。

## 补充命令

- 后端快速子集：`cd backend && npm run test:fast`；前端：`cd frontend && npm run test:fast`（utils/hooks）。
- 后端测试代码类型检查：`cd backend && npm run typecheck:test`（`tsc --noEmit` 不含 tests）。
- 本地空库：`cd backend && npm run migrate && npm run admin:create:dev -- --username admin --display-name 管理员`（无默认账号；交互输入口令）。
- 提交前：`git diff --check`。仓库不配置 GitHub CI，检查全在本地跑。
- E2E（Playwright，`--workers=1`）：先 `cd backend && npx tsc --outDir .e2e-dist --noEmitOnError`，再 `cd frontend && npm run build:e2e && E2E_BACKEND_DIST=.e2e-dist npx playwright test <spec>`。配置会在 3761（finance 夹具）/3762（simulation 夹具）起一次性后端并重建 seed 数据；指向 3748/3760 会直接报错。细节见 `docs/public-release.md`。

## 架构要点

**请求链路**（`backend/src/server.ts` 的 `startServer`）：`registerRequestContext` → 认证路由 → `registerSessionAuth`（Cookie 会话 + CSRF）→ `registerRouteGuard` → 各领域 `register*Routes(app, db, wrap, () => objectStore)` → 助手路由 → 静态前端。`index.ts` 以 `autoMigrate: false` 启动，迁移只走 CLI。

**路由权限默认拒绝**：每个 `/api` 路由必须在 `modules/security/route-rules.ts` 的规则表中命中一条（`addRouteRules`，按登记顺序、具体的在前），否则 403。新领域模块在自己的 `routes.ts` 里调用 `addRouteRules` 登记。`allOrgs: true` 标记只对全组织用户开放的继承接口；已按范围裁剪的接口由 service 用 `AuthContext` 过滤。

**AuthContext 传递**：`core/request-context.ts` 用 `AsyncLocalStorage` 携带 `RequestContext`（`source`: http/assistant/task/cli/system，含 `auth`、`jobId`）。HTTP、任务执行器和助手工具都从这里拿服务端构建的身份与 `orgRootIds`，授予某组织即含全部下级。

**前后端共享契约**：`backend/src/contracts/` 是纯类型/zod 契约（权限枚举、页面目录 `page-catalog.ts`、各领域 wire 类型）。前端通过 `@contracts/*` 别名引用，**只允许 `import type`**（构建产物不得引入 zod）。

**迁移**：`db/migrations.ts`（V1–V38 继承 + 尾部追加）与 `db/migrations-newfc.ts`（V39 起 newfc 自有）合并为 `MIGRATIONS`。条目可带 `apply`（代码迁移）、`raw`（事务外）、`rebuild`（整表重建，单事务内含 `foreign_key_check`）。已发布条目不改，只追加新版本号；当前生产为 V66。

**财务助手（`backend/src/assistant/`）**：
- 工具：`tools.ts` 的 `TOOL_REGISTRY` 用 `defineTools` 声明，每个工具带 zod schema、`capabilities`、`policy`（权限 + 范围 `ToolScope`）和只读 `execute`。领域工具调用领域 service，不自写查询口径。
- 页面能力：`contracts/page-catalog.ts` 的 `PAGE_CATALOG` 是页面唯一目录（权限、可见字段、选区模式、草稿类型、领域能力）；`page-capabilities.ts` 由能力推导本轮可暴露的工具。前端 `src/assistant/`（`pageContext.ts`、`AssistantContextRegistry`）按同一目录上报单一 pageContext。
- 草稿（`config-draft.ts` 等）只做只读校验，与正式保存共用业务规则；正式写入在页面确认。
- 无模型配置时退化为确定性事实/模板回答；`tests/setup.ts` 默认清空 `AI_*`/`OPENAI_*` 环境变量，真机联调需 `AI_TEST_ALLOW_REAL_MODEL=1`。

**文件与任务**：上传/导出文件经 `ObjectStore`（随库目录）管理；长任务走 `modules/jobs`（持久状态，任务内 `RequestContext.source='task'`）。Excel 读写集中在 `modules/io`（`xlsx-guard.ts`、`import-limits.ts` 做输入防护）。

## 测试约定

- 后端用 `tests/helpers.ts`：`testDb()`（内存库 + 全量迁移）、`tempFileDb()`（`os.tmpdir()` 临时文件库），以及标准主数据夹具；连接在每个测试文件结束时由 setup 统一关闭。
- HTTP 级测试用 `tests/http-helpers.ts`；财务夹具在 `backend/tests/fixtures/finance/`，仅供测试。
- vitest 后端 `maxWorkers: 2`、超时 30s；前端 jsdom、超时 15s。

## 文档维护

规则只在 specs 对应主题文件维护（见 `specs/README.md`）；阶段完成需在 `docs/acceptance-records.md` 附提交与实际验证证据。提交消息带功能 ID（F..）、任务（T-..）和验收 ID（AC-..），例：`test(F08,F20): T-8.6 ... (AC-T8-07/12/16)`。
