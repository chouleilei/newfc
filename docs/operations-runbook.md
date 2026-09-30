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

`scripts/rollback.sh [--restore-backup <备份文件名>] [--accept-data-loss] [--no-restart]`（AC-X08）：

- 仅当 `backend/dist.old` 与 `frontend/dist.old` 都存在时执行；产物互换，被回退的版本留在 `dist.old`（再次执行即换回）。
- 无 schema 变化：直接 `scripts/rollback.sh`，停服 → 换产物 → 启动 → 就绪检查。
- 有 schema 变化：当前库版本高于旧代码支持的最高版本时脚本拒绝（退出码 4，不停服）并列出 `pre-migrate-*` 备份。
  用 `scripts/rollback.sh --restore-backup pre-migrate-cli-budget-backup-….sqlite` 恢复（不做迁移，保持旧 schema）：
  - 备份之后的写入（审计日志中非备份/迁移动作）先按动作列出，未加 `--accept-data-loss` 时拒绝（退出码 3，服务按原版本重新启动）；
  - 确认后当前库先备份为 `pre-rollback-*`，补齐备份包中的附件对象，再替换库、换回旧产物并启动。
  - 丢弃的写入需按列出的动作与时间补录或对账，不能宣布无损回退。
- 演练：`scripts/release-drill.sh [空目录]` 在临时副本中用真实 deploy/rollback 脚本演练构建失败、迁移失败、schema 变化发布与回退（伪 systemctl 只管副本进程，端口默认 3769）。`deploy.sh`/`rollback.sh` 的 `NEWFC_ROOT`、`NEWFC_DATA_DIR`、`NEWFC_SERVICE`、`NEWFC_SYSTEMCTL`、`NEWFC_SKIP_INSTALL` 仅供演练覆盖，生产保持默认。

## 备份与恢复

- **备份包**：每 24 小时及迁移前在线备份（SQLite backup API）到 `/data/newfc-data/backups/`。每个备份 = 库文件 + `<名>.manifest.json`（库 sha256、schema 版本、引用对象列表）+ 被引用对象（`backups/objects/sha256/…`，多个备份共享，按保留清单回收）。
- **校验**：页面“备份与迁移”→ 校验，逐项显示库完整性/外键、清单、库摘要、对象列表、对象摘要，并核对运行对象目录（缺失/损坏/可从该备份补齐的数量）。
- **页面恢复**：先校验备份包 → 当前库备份为 `pre-restore-*` → 补齐运行对象 → 替换库 → 旧 schema 自动升级。无清单的旧格式备份只在不登记任何文件对象时可恢复。
- **恢复演练**：`npm run restore:drill -- --backup <备份文件> --target <空目录> [--source <原库>]`。在空目录还原库与对象、执行迁移检查、逐表比对行数/金额列合计/状态分布，用随机端口启动临时实例做存活/就绪与关键只读查询，输出 JSON 耗时报告（`<target>/restore-drill-report.json`）。拒绝非空目录、运行数据目录与 newbd/lishui 路径。建议每季度及每次大版本发布后执行一次。
- **恢复窗口（OPEN-04）**：RPO ≤ 24 小时（自动备份间隔；迁移前另有备份）。RTO 以演练实测为准，见验收记录 T-6。

## newbd 数据迁入

`npm run import:newbd -- --source <newbd 快照.sqlite> --target <数据目录> [--replace]`：

- 来源只接受运维复制出的离线快照（先停 newbd 或用 SQLite 在线备份复制），工具拒绝 `/root/newbd`、`/data/newbd` 下的路径。
- 来源 schema 须为 newfc 继承迁移（V1～V38）的前缀，否则列出差异并拒绝。
- 结果目录含 `newfc.sqlite`、`newbd-import-report.json`（核对报告）与 `id-map.csv`（身份映射）；核对未通过时不换入目标。
- 不迁入口令/会话、不创建账号：迁入后执行 `npm run admin:create`。
- 重跑须 `--replace`（旧目标改名保留为 `<目标>.replaced-<时间>`）；目标库在迁入后已有业务写入时拒绝。

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

## OCR 适配（费用审核 AC-F22）

- **配置**：在「系统设置 → 业务设置 → 集成」里填 `OCR 服务地址`（https，或本机 http）和可选的 `OCR 服务密钥`。未配置时，审核运行记录 `OCR_UNAVAILABLE`，材料核对只看附件名，需要人工查看原件。
- **调用范围**：只识别 pdf/png/jpg/jpeg/bmp/tif/tiff/webp/ofd 附件。在后台任务里、写事务之外调用，单次超时 30 秒。
- **请求**：`POST <OCR 服务地址>`，`Content-Type: application/json`，配置了密钥时带 `Authorization: Bearer <密钥>`。请求体：`{"fileName": "...", "contentType": "image/jpeg", "contentBase64": "..."}`。
- **响应**：HTTP 200 的 JSON，`{"text": "全文"}` 或 `{"pages": [{"page": 1, "text": "..."}]}`，两种至少返回一种。非 200、超时或缺字段时记录 `OCR_FAILED`，不当作通过。
- **缓存**：结果按附件 sha256 写入 `ex_ocr_cache`，同一原件不再重复识别。更换 OCR 供应商后如需重新识别，先停服务，再清空该表（`DELETE FROM ex_ocr_cache;`）。
- **兼容性**：接第三方 OCR 时需要一层很薄的转接服务，把上面的契约映射到供应商 API。OPEN-05 结论：与 lishui 一致——lishui 的 OCR 由 Dify 工作流承担，newfc 不引入 Dify，因此沿用本契约；未接 OCR 服务时按附件名核对并转人工复核。

## 模型渠道与费用制度（OPEN-05）

- **模型**：与 lishui 一致，OpenAI 兼容协议、供应商 SiliconFlow。在 `/data/newfc-data/newfc.env` 填 `AI_BASE_URL="https://api.siliconflow.cn/v1"`、`AI_API_KEY`、`AI_MODEL`（须支持 function calling），然后 `systemctl restart newfc`。未配置时助手与费用审核按规则运行，并如实标注“未配置模型”。
- **费用制度样本**：lishui 首版预审规则（差旅 5,000、住宿 1,500、业务招待 3,000、办公 10,000、培训 20,000、车辆 5,000 元；必备材料至少命中 min(2, N) 项）已转写为 `deploy/expense-policy-lishui.json`。发布：

  ```bash
  cd /root/newfc/backend && export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH
  NEWFC_DATA_DIR=/data/newfc-data npm run expense:policy:import -- --file ../deploy/expense-policy-lishui.json
  ```

  同编码已有生效版本时跳过；调整阈值在页面“制度依据”发布新版本（条款不可改，只能出新版本）。
