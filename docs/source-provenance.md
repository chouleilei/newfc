# 源码来源记录

对应 [架构规范 · 源码初始化](../specs/architecture.md)。本文件记录实际导入，不是拟采用基线。

## 首次导入

| 项目 | 内容 |
|---|---|
| 来源项目 | newbd（/root/newbd → /data/newbd） |
| 来源提交 | `c67f6c4336956d64673be5f65a4c63d570ade593`（docs(agents): 大文件拆分改为顺手重构规则） |
| 导出方式 | `git archive <SHA>`，只含已跟踪文件，解到独立暂存目录后逐类审阅再并入 |
| 导出日期 | 2026-09-29 |
| newfc 导入提交 | 首个提交 `chore: import newbd source snapshot c67f6c4 ...`（原样快照，便于与后续适配对比） |
| 业务参考（不导入源码） | lishui-finance-ai `e50b4b6`（6.1.0），仅作需求、规则与验收场景来源 |

### 保留

- `backend/`：src、tests（含 `tests/fixtures/finance/*.xlsx`，由 `scripts/generate-finance-fixtures.ts` 确定性生成的脱敏夹具）、scripts、package.json/package-lock.json、tsconfig、vitest 配置、`AI_ASSISTANT.md`、`assistant-openapi.json`、`assistant-mock.json`。
- `frontend/`：src、tests/e2e、index.html、package.json/package-lock.json、tsconfig、vite/vitest/playwright 配置、`DESIGN.md`。
- 根目录：`.gitignore`、`.env.example`（已改写为 newfc 配置）。
- `docs/` 中 newbd 的现行业务文档（预算口径、财务转换方案与手册、组织/科目编码、AI 助手方案），原 `docs/README.md` 改名为 `docs/inherited-docs-index.md`。代码注释里的「§x.y」多指向这些文档或已排除的历史归档。
- 许可证：newbd 仓库未包含 LICENSE/第三方声明文件；第三方依赖许可证随 npm 包分发，无额外声明需保留。

### 排除

| 类别 | 处理 |
|---|---|
| `.git`、worktree 元数据、remote | 不导入；newfc 执行 `git init -b main`，未设置 origin（OPEN-01） |
| `.env`、SQLite/WAL/SHM、`backend/data/`、备份、附件、日志（`server.log`） | 未跟踪，未导入；运行数据不迁入（OPEN-03 已定：lishui 旧历史不迁入） |
| 构建产物与依赖（dist、node_modules、.e2e-dist） | 未导入；在 newfc 内按锁文件重新安装 |
| 根目录个人业务样本（`*.xlsx`）、网页存档（`*.html`）、截图 | 未跟踪，未导入 |
| newbd `AGENTS.md`、`README.md`、`RELEASE_NOTES.md`（116 KB 历史版本记录） | 不导入；newfc 自建 |
| `docs/archive/`（22 份历史计划与排查报告） | 不导入；需要背景时按来源 SHA 在 newbd 仓库查阅 |
| `start.sh` | 导入后删除：它在启动时自动构建，违反“普通重启不触发安装或构建”；由 `scripts/deploy.sh` + `deploy/newfc.service` 取代 |

## 首次适配（T-0）

- 包名 `newfc-backend` / `newfc-frontend`，版本 0.1.0；Node 固定 24.21.0（`.nvmrc`，engines `>=24.21.0 <25`）。
- 运维环境变量前缀 `BUDGET_*` → `NEWFC_*`（仅配置类变量；代码常量不变）。
- 默认端口 3748 → 3760；E2E 端口 3750/3751 → 3761/3762；默认数据库文件 `newfc.sqlite`；生产数据目录 `/data/newfc-data`。
- SQLite `synchronous` 由 NORMAL 改为 FULL（正式财务写入持久性优先）。
- 新增公开 `GET /api/health/live`、`GET /api/health/ready`；生产入口在已初始化库存在待执行迁移时拒绝启动，要求显式 `npm run migrate:dist`。
- SIGTERM/SIGINT 优雅停止（停止接收连接、关闭数据库）。
- 前端标题与欢迎文案改为 newfc。

## 修复移植记录

newbd 在 c67f6c4 之后的改进按需评估移植，逐条记录：

| 日期 | newbd 来源提交 | 受影响模块 | newfc 提交 | 验证 |
|---|---|---|---|---|
| — | — | — | — | — |

## lishui 样本夹具

lishui 只提供业务规则和验收样本，不导入源码。下列样本按原字节复制为 newfc 的测试夹具，便于与 lishui 验收口径对照：

| newfc 路径 | lishui 来源（`e50b4b6`） | 用途 |
|---|---|---|
| `backend/tests/fixtures/eas-v600/eas_voucher.csv`、`eas_balance.csv`、`eas_auxiliary.csv` | `docs/sample-data/v600/` 同名文件（由 2.2.0 归档 EAS xlsx 派生的示例数据，不含真实凭证） | `tests/t3-eas.test.ts` 的 v600 三件套验收（AC-F05） |
| `deploy/expense-policy-lishui.json` | `backend/app/services/expense_audit/rules.py`（`EXPENSE_TYPE_THRESHOLDS`、`REQUIRED_ATTACHMENT_KEYWORDS`、至少命中 `min(2, N)`）与 `policy_context.py`（条款摘要）；按值转写为 newfc 制度 JSON，非逐字节复制 | OPEN-05 制度样本；`tests/t6-expense-lishui-policy.test.ts` |
| `backend/tests/fixtures/investment_feasibility_yichongqiao.json` | `backend/tests/fixtures/investment_feasibility_yichongqiao.json`（宜冲桥脱敏样本，逐字节一致） | `tests/t5-feasibility-calc.test.ts`、`t5-feasibility.test.ts` 与 E2E `risk-investment.spec.ts` 的 standard-1.0 测算验收（AC-F12） |

`backend/tests/fixtures/feasibility-reference.json` 不是 lishui 文件：由会话临时目录中的独立 Python Decimal 参照实现（按 lishui standard-1.0 calculator/financing_schedule 规则重写，schema 以最小替身代替 pydantic）对上述样本及 10 个变体生成，只用于交叉核对，不作为唯一正确依据；lishui 源码未复制进 newfc。
