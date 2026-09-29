# AGENTS.md

newfc：以 newbd（c67f6c4 快照）为代码基础、扩展 lishui-finance-ai 业务功能的水利财务分析系统。单人维护、单机部署。

## 先读

1. [newfc-plan.md](newfc-plan.md) → [specs/README.md](specs/README.md)。specs 是需求、契约和验收的唯一来源；规则只在对应主题文件维护。
2. 阶段验收证据记在 [docs/acceptance-records.md](docs/acceptance-records.md)；代码来源在 [docs/source-provenance.md](docs/source-provenance.md)。
3. 继承自 newbd 的业务口径文档见 [docs/inherited-docs-index.md](docs/inherited-docs-index.md)。

## 硬性边界

- 不读写 newbd（/root/newbd、/data/newbd、端口 3748、newbd-budget.service）或 lishui 的运行目录；lishui 只作只读参考。
- 不引入 Dify/DB-GPT、MySQL、Redis、MinIO、Celery 等常驻中间件。
- 金额：整数分存储；新接口以十进制字符串返回（`backend/src/core/decimal.ts` 的 `centsToDecimalString`/`parseDecimalToCents`，bigint 定点、64 位范围；读可能超 2^53 的金额列必须 `.safeIntegers(true)`），禁止用 number 浮点做金融计算；比率/数量/单价用显式 scale 的缩放 bigint（`parseScaled`/`ratioString`/`allocateCents`），契约见 `docs/money-contract.md`。继承模块的 number 金额继续走 `core/money.ts` 的安全整数校验。
- 权限：service 接收服务端构建的 `AuthContext`（用户/权限/组织范围），API、任务、AI 工具、下载、搜索使用同一校验；不信任客户端声明的范围。
- 写入：短事务；导入先全量校验再原子提交；模型调用、OCR、长解析不在写事务里。
- AI 只能调用同源 service 的只读工具；正式写操作走页面显式确认。
- 迁移只追加（`backend/src/db/migrations.ts`），生产通过 `npm run migrate:dist` 显式执行。

## 命令

Node 固定 24.21.0（`.nvmrc`）。shell 默认 Node 若不同，先 `export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH`，不要用 `/usr/bin/node`（v20，ABI 不匹配）。

| 目的 | 命令 |
|---|---|
| 后端聚焦测试 | `cd backend && npx vitest run tests/<file>.test.ts` |
| 后端全量 | `cd backend && npx tsc --noEmit && npx vitest run` |
| 前端测试/类型 | `cd frontend && npx vitest run && npx tsc -b` |
| 开发运行 | `cd backend && npm run dev`（3760）；`cd frontend && npm run dev`（5173，代理 /api） |
| 发布 | `scripts/deploy.sh`（测试→构建到 dist.new→停服→备份+迁移→替换→启动→就绪检查） |

测试数据库只用临时目录或内存库，绝不指向运行库。

## 代码结构

- `backend/src/server.ts`：继承的路由表；新领域路由放 `backend/src/modules/<domain>/routes.ts` 并在 server.ts 注册。
- `backend/src/modules/<domain>/`：按领域组织 service（业务+权限范围）与必要的 repository/schema；简单模块不强拆四层。
- `backend/src/assistant/`：助手编排、工具注册（新领域工具调用领域 service）。
- `frontend/src/pages/`：页面；新领域页面沿用现有导航与组件。

提交保持小步，消息说明功能 ID、任务与验收 ID。
