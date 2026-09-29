# 运维手册

规则来源：[specs/operations.md](../specs/operations.md)。本手册记录 newfc 实际的命令和路径。

## 固定运行参数（OPEN-07 结论）

| 项 | 值 | 依据 |
|---|---|---|
| Node | 24.21.0，`/root/.nvm/versions/node/v24.21.0/bin/node` | `.nvmrc`；better-sqlite3 12.11.1 在该 ABI（137）下安装并通过全部测试。不用 `/usr/bin/node`（v20，已 EOL 且 ABI 不同） |
| SQLite | 3.53.2（better-sqlite3 内置），FTS5 + trigram 分词可用 | 启动自检记录 |
| 服务 | `newfc.service`，模板 `deploy/newfc.service` | 与 newbd-budget.service 完全独立 |
| 端口 | 3760（生产），3761/3762（E2E），测试用 0 随机端口 | 3748 为 newbd 占用 |
| 数据目录 | `/data/newfc-data`（持久盘 /dev/vdb1） | `newfc.sqlite` + WAL/SHM、`backups/`、`files/`、`cleaning-uploads/` |
| 运行身份 | root + `ProtectSystem=strict`、`ProtectHome=read-only`、`ReadWritePaths=/data/newfc-data` | 代码位于 /root/newfc（仅 root 可读）；文件系统隔离保证进程只能写本实例数据目录 |
| 配置 | `/data/newfc-data/newfc.env`（chmod 600），模板为仓库根 `.env.example` | 不共用 newbd 的 .env |

## 首次安装

```bash
install -d -m 700 /data/newfc-data
cp /root/newfc/.env.example /data/newfc-data/newfc.env && chmod 600 /data/newfc-data/newfc.env   # 按需填写模型等配置
cp /root/newfc/deploy/newfc.service /etc/systemd/system/newfc.service
systemctl daemon-reload
/root/newfc/scripts/deploy.sh --no-restart      # 安装依赖、测试、构建、创建空库迁移
systemctl enable --now newfc.service
curl -fsS http://127.0.0.1:3760/api/health/ready
```

首个管理员：见下文“初始化管理员”。需要域名/HTTPS 时在宿主 Nginx 新建独立站点，`proxy_buffering off` 以支持 SSE，并设 `NEWFC_TRUST_PROXY=1`。

## 发布

`scripts/deploy.sh [--skip-tests] [--no-restart]`：

1. 锁文件变化时 `npm ci`（Node 版本必须等于 `.nvmrc`）。
2. 类型检查 + 后端/前端单元测试（失败即中止，运行中的服务不受影响）。
3. 构建到 `dist.new`，产物不完整则中止。
4. 停止服务 → `node dist.new/db/migrate-cli.js`（有待执行迁移时先备份到 `backups/`）。
5. `dist` → `dist.old`，`dist.new` → `dist`；启动并在 30 秒内轮询 `/api/health/ready`。

普通 `systemctl restart newfc` 只运行现有 `dist`，不安装、不构建、不迁移。已初始化库存在待执行迁移时服务拒绝启动（日志提示执行显式迁移）。

## 代码回退

- 无 schema 变化：`mv backend/dist backend/dist.bad && mv backend/dist.old backend/dist`（前端同理）后重启。
- 有 schema 变化：旧代码不保证兼容新 schema。先停服，从 `backups/` 中该次发布的 `pre-migrate-*` 备份恢复（见下），再换回旧产物。若新版本已有新增业务写入，先导出这些记录并确定对账方案，不能只换 URL 宣布无损回退。

## 备份与恢复

- 自动：每 24 小时及迁移前在线备份（SQLite backup API）到 `/data/newfc-data/backups/`。
- 页面：系统设置 → 备份，可创建、校验、恢复。
- 附件对象与数据库的一致性备份、独立目录恢复演练：见阶段 6 记录（AC-X07）。

## 初始化管理员

T-1 完成后补充（显式命令创建，不存在默认密码）。
