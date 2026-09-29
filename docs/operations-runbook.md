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

## 初始化管理员与账号恢复

newfc 没有默认账号、默认口令或关鉴权开关。新库启动后登录页提示“尚未初始化管理员”，由运维在服务器上显式创建：

```bash
cd /root/newfc/backend
export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH
NEWFC_DATA_DIR=/data/newfc-data npm run admin:create -- --username admin --display-name 管理员
# 交互终端输入两次口令(不回显)；非交互: printf '%s\n' "$PW" | NEWFC_DATA_DIR=... npm run admin:create -- --username admin
```

- 只在库内**没有任何用户**时可用；之后的账号在“系统 → 用户与权限”页面维护。
- 口令策略：10～128 位、不含用户名、至少 4 种不同字符；scrypt 哈希存储，审计与接口响应不含口令/令牌。
- 忘记口令或管理员被锁：`NEWFC_DATA_DIR=/data/newfc-data npm run admin:reset-password -- --username admin`。该命令会重新启用账号、吊销全部会话，并要求下次登录修改口令。可在服务运行时执行（SQLite WAL，短事务）。
- 命令同样拒绝在存在待执行迁移的库上运行，先 `npm run migrate:dist`。

会话与授权要点：

| 项 | 规则 |
|---|---|
| 会话 | HttpOnly、`SameSite=Strict` Cookie `newfc_session`，库内只存令牌 SHA-256；空闲 12 小时、绝对 7 天过期；重启不丢会话 |
| CSRF | 写请求须带 `X-CSRF-Token`（登录/会话接口返回），并校验 Origin/`Sec-Fetch-Site` |
| 登录限流 | 同一 IP 或同一账号 10 分钟内失败 8 次锁定 5 分钟（进程内存态，重启清零） |
| 授权 | 角色 = 操作权限；组织范围独立授予，授予某组织即含其全部下级；“全部组织”才能访问集团口径接口 |
| 响应 | 未登录 401、无权限 403、范围外对象 404（不泄露存在）；未登记权限的新接口默认 403 `ROUTE_NOT_AUTHORIZED` |
| 保护 | 内置 admin 角色锁定且自动拥有新权限；不能停用自己，不能移除最后一个启用的管理员 |

排查：错误响应体与响应头 `X-Request-Id` 相同，可在“操作日志”按请求 ID、操作人、结果筛选（`/api/logs?requestId=...`）。
