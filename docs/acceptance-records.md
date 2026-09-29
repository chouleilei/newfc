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
