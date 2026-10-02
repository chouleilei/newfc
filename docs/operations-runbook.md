# 运维手册

本手册以 Linux/systemd 单机部署为例。模板中的 `/root/newfc`、`/data/newfc-data` 和 Node 路径需要按自己的安装位置调整。生产凭据由部署者设置；公开版不提供可共享的供应商账号。

规则来源：[specs/operations.md](../specs/operations.md)。本手册记录 newfc 实际的命令和路径。

## 固定运行参数（OPEN-07 结论）

| 项 | 值 | 依据 |
|---|---|---|
| Node | 24.21.0，`/root/.nvm/versions/node/v24.21.0/bin/node` | `.nvmrc`；better-sqlite3 12.11.1 在该 ABI（137）下安装并通过全部测试。不用 `/usr/bin/node`（v20，已 EOL 且 ABI 不同） |
| SQLite | 3.53.2（better-sqlite3 内置），FTS5 + trigram 分词可用 | 启动自检记录 |
| 服务 | `newfc.service`，模板 `deploy/newfc.service` | 与 newbd-budget.service 完全独立 |
| 端口 | 3760（生产），3761/3762（E2E），测试用 0 随机端口 | 3748 为 newbd 占用 |
| 数据目录 | `/data/newfc-data`（示例路径） | `newfc.sqlite` + WAL/SHM、`backups/`、`files/`、`cleaning-uploads/` |
| 运行身份 | root + `ProtectSystem=strict`、`ProtectHome=read-only`、`ReadWritePaths=/data/newfc-data` | 代码位于 /root/newfc（仅 root 可读）；文件系统隔离保证进程只能写本实例数据目录 |
| 配置 | `/data/newfc-data/newfc.env`（chmod 600），模板为仓库根 `.env.example` | 不共用 newbd 的 .env |
| 外网 | 自有域名 + HTTPS，模板 `deploy/nginx-newfc.example.conf`；单层可信代理时设 `NEWFC_TRUST_PROXY=1` | 关闭 SSE 缓冲、HTTP 跳转 HTTPS，服务只监听本机 |

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

### T-8 升级（V65→V66）

2026-10-03 已通过正式部署脚本发布 T-8。升级时须使用同一提交的前后端产物，由显式迁移执行 V66（历史助手响应规范化），并保留迁移前完整备份包。迁移前备份、本机/公网核验及实际数据边界见 [发布记录](acceptance-records.md#t-8-生产发布2026-10-03)。

已打开的旧浏览器页面需刷新；旧上下文协议会收到明确的刷新提示。V66 不能假定由 V65 旧代码读取；需要回退时按下文恢复匹配的 V65 备份，并核对备份后写入。生产本次未执行回退，恢复/重迁移证据来自临时库验收。

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

- **原有 OCR 服务**：发布适配代码后，在「系统设置 → 业务设置 → 业务参数 → 集成」将 `OCR 接口类型` 选为“原有 OCR 服务（异步）”，`OCR 服务地址` 填 `https://ocr.example.com/api`（不带查询参数），填写 `OCR 登录账号` 和 `OCR 登录密码`，`OCR 识别类型` 默认 `1`，`异步 OCR 超时（秒）` 默认 `120`。`OCR 服务密钥` 不用于这种接口。无需 Dify 或额外转接进程；设置保存后供下一次审核使用，已进入人工复核的单据可通过重跑审核生成新运行。
- **原 JSON 接口**：`OCR 接口类型` 缺省为“JSON 同步接口”，旧配置继续有效；服务地址填写完整调用地址，服务密钥可选，超时仍为 30 秒。
- **调用与失败处理**：仅 pdf/png/jpg/jpeg/bmp/tif/tiff/webp/ofd 附件进入识别，在后台任务、写事务之外调用。服务不支持的格式、认证失败、任务失败、超时、空结果均记录 `OCR_FAILED` 并提示人工查看原件；服务地址未配置记 `OCR_UNAVAILABLE`。不接受重定向，不把识别失败当作审核通过。具体网络契约、响应上限与设置项见 [实施规范](../specs/implementation.md#实施决定t-4)。
- **缓存**：结果按附件 sha256 写入 `ex_ocr_cache`，同一原件不再重复识别。更换 OCR 供应商后如需重新识别，先停服务，再清空该表（`DELETE FROM ex_ocr_cache;`）。
- **验收边界**：原有服务曾在 lishui 的受控联调中识别 PDF 成功；这不是 newfc 当前真实服务验收。本次适配有 HTTP 协议桩和费用审核集成测试，newfc 已配置实际供应商凭据，并按用户确认用合成扫描件完成费用流程验证，不能从其他项目运行目录复制配置。

## 模型渠道与费用制度（OPEN-05）

- **模型**：在系统设置中创建自己的模型渠道并绑定功能，或使用下面的环境变量示例（库内绑定优先），采用 OpenAI 兼容协议。在 `/data/newfc-data/newfc.env` 填 `AI_BASE_URL="https://api.siliconflow.cn/v1"`、`AI_API_KEY`、`AI_MODEL`（须支持 function calling），然后 `systemctl restart newfc`。未配置时助手与费用审核按规则运行，并如实标注“未配置模型”。
- **费用制度样本**：lishui 首版预审规则（差旅 5,000、住宿 1,500、业务招待 3,000、办公 10,000、培训 20,000、车辆 5,000 元；必备材料至少命中 min(2, N) 项）已转写为 `deploy/expense-policy-v1.json`。发布：

  ```bash
  cd /root/newfc/backend && export PATH=/root/.nvm/versions/node/v24.21.0/bin:$PATH
  NEWFC_DATA_DIR=/data/newfc-data npm run expense:policy:import -- --file ../deploy/expense-policy-v1.json
  ```

  同编码已有生效版本时跳过；调整阈值在页面“制度依据”发布新版本（条款不可改，只能出新版本）。


## 仓库独立化与兼容入口

产品与前端内部命名统一为 newfc，助手显示为“财务助手”。浏览器升级时仅在同源下迁移已知旧键，账号偏好只接受 account:<服务端 ID>，不迁移旧显示名/default 空间。来源与历史验收不改写，保留项见 [独立化清理记录](repository-independence.md)。

旧组织/科目 API 初始化脚本已移除；主数据通过正式页面维护或受控导入。`backend/scripts/fixtures/water-finance-master-data.cjs` 仅导出模拟夹具定义，没有数据库或网络操作。`npm run seed:e2e:simulation` 只重建专用可丢弃目录，不能作为生产初始化命令。

费用样本改名为 `deploy/expense-policy-v1.json`；保留已发布的 `LISHUI-EXPENSE-V1` 编码以保证导入幂等和审核引用，不改现有运行数据。使用同编码重新导入仍默认跳过；新版本发布须按既有流程显式指定 `--new-version`。`import:newbd` 保留为来源特定的离线快照兼容入口，并继续拒绝原项目运行路径。
