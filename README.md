# newfc 水利财务分析

以 newbd 固定快照（c67f6c4）为代码基础，在独立仓库中扩展 lishui-finance-ai 业务功能的单机财务分析系统：TypeScript + Express + React/Vite + SQLite，单 Node 进程 + systemd（`newfc.service`），应用内 AI 编排，无 Dify/DB-GPT 与常驻中间件。

- 方向与范围：[newfc-plan.md](newfc-plan.md)、[specs/](specs/README.md)
- 实现状态与验收证据：[docs/acceptance-records.md](docs/acceptance-records.md)
- 代码来源：[docs/source-provenance.md](docs/source-provenance.md)
- 开发约定：[AGENTS.md](AGENTS.md)；版本记录：[CHANGELOG.md](CHANGELOG.md)

## 快速开始（开发）

```bash
export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH   # Node 24.21.0，见 .nvmrc
cd backend && npm ci && npm run dev                      # http://127.0.0.1:3760，数据在 backend/data
cd frontend && npm ci && npm run dev                     # http://localhost:5173
```

首次启动空库后按 [运维手册](docs/operations-runbook.md) 初始化首个管理员。

## 部署

见 [docs/operations-runbook.md](docs/operations-runbook.md)：`deploy/newfc.service` 模板、`scripts/deploy.sh` 发布流程、数据目录 `/data/newfc-data`、备份与恢复。
