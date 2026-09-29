# 架构与来源

状态：已确定的目标架构；初始化和代码兼容性尚待验证。部署过程见[运行规范](operations.md)。

## 项目标识与来源

项目与仓库名称确定为 **newfc**，本地目录为 /root/newfc。项目标识统一使用 newfc；前后端包名分别使用 newfc-frontend、newfc-backend，systemd 服务名为 newfc.service。远程仓库归属和地址在创建远程仓库时确定。

| 项目 | 位置或标识 | 用途 |
|---|---|---|
| newbd | /root/newbd，实际指向 /data/newbd | 初始源码来源，现有应用继续独立运行 |
| newbd 固定基线 | c67f6c4336956d64673be5f65a4c63d570ade593 | 本次调研与首次源码快照基线 |
| lishui-finance-ai | /root/lishui-finance-ai，已提交基线 e50b4b6 / 6.1.0 | 业务需求、样本、接口与规则参考 |
| 新应用 newfc | /root/newfc，目录已创建 | 当前含总计划和 specs；后续初始化独立 .git、源码和运行配置 |
| 本方案 | /root/newfc/newfc-plan.md | 总览入口；细则由 specs 各主题文件维护 |

上述提交是调研基线，不自动跟随任一原仓库的最新分支。初始化采用这一明确基线，后续修复另行评估。

## 源码初始化

采用**源码快照 + 新 Git 历史**：

1. 从固定 newbd 提交导出已跟踪源码到独立暂存目录，按文件清单整理后并入 /root/newfc，保留已有 newfc-plan.md 和 specs/。
2. 保留源码、必要静态资源、依赖锁文件、可公开的测试夹具和依赖声明；核对已有许可证/第三方声明并保留适用内容。
3. 排除 .git、.env、SQLite/WAL 文件、运行附件、日志、备份、构建产物、依赖目录、个人业务样本和网页存档。已跟踪文件也要审阅，不能仅依赖 .gitignore 判断是否应带入。
4. 在 /root/newfc 初始化独立 Git 仓库，默认主分支为 main。使用普通独立 .git，不共享 newbd 的 worktree 元数据、Git 对象目录或运行文件软链接。
5. 新增 docs/source-provenance.md，记录来源项目、完整提交 SHA、导出日期、保留/排除文件类别与首次适配内容，保留可追溯的代码来源。
6. 在新仓库建立独立 README、AGENTS、版本记录和启动配置，调整 newbd 原有绝对路径、服务名、端口、数据库默认位置和发布命令。
7. 远程仓库创建后，origin 只指向新仓库；不继承或使用 newbd 的推送地址。初始化文档、提交与发布均按新仓库流程执行。

源码快照使新项目从自身初始提交开始演进；newbd 的完整历史仍可通过来源 SHA 在原仓库查看。新项目初始版本建议从 0.1.0 起步，不沿用两个原项目的版本号作为功能覆盖承诺。

## 修复移植

newbd 的改进按需评估和移植：记录来源提交、受影响模块和新仓库验证结果。对于共享代码的修复，可采用补丁或手工移植；两个产品的数据模型分化后，逐项调整。

不建立自动同步、固定全量合并或运行时读取原仓库代码的机制。新仓库具有自己的发布节奏，达到自身验收条件即可发布，无须合回 newbd。

## 隔离边界

| 对象 | 独立要求 |
|---|---|
| Git | 独立仓库、主分支、remote、标签与发布记录 |
| 配置 | 新项目自己的 .env 与配置模板，凭据单独配置 |
| 数据库 | 新应用自己的 SQLite 文件及 WAL/SHM 文件，置于本机持久磁盘 |
| 文件 | 独立附件、导出、临时文件和备份目录 |
| 进程 | 独立服务名称、日志和端口；初始化前检查端口占用 |
| 构建与依赖 | 在新目录安装与构建，Node 版本和 better-sqlite3 ABI 固定匹配 |
| 验收 | 独立可丢弃测试库，种子脚本明确限定数据目录 |

开发与构建不进入 newbd 的 dist、node_modules、backend/data 或 systemd 服务。迁入实际业务数据是单独任务，需要来源、字段映射、数量金额核对和恢复方案；初始源码导出不携带运行数据库。

## 应用结构

| 层次 | 选择与职责 |
|---|---|
| 前端 | 复用 newbd 的 React + TypeScript + Vite 与交互基础，按领域扩展 |
| API | TypeScript + Express；保持薄路由与输入校验 |
| 业务 | 按领域组织 controller/schema/service/repository，复用现有聚焦模块，避免统一大 service |
| 财务计算 | 精确金额表示、十进制计算和明确舍入规则，由领域服务执行 |
| 数据 | better-sqlite3 + SQLite WAL，显式迁移、外键、短事务与备份 |
| 文件 | 本地对象层，保留对象键、SHA-256、不可变原件和权限下载 |
| AI | 应用内模型适配、受控工具、页面上下文、引用与数字校验 |
| 后台工作 | 持久任务状态 + 有界执行；CPU 重任务按需交给线程或临时子进程 |
| 部署 | 默认与 newbd 一致，使用 systemd 管理单 Node 常驻进程，提供 API、SSE 和前端构建产物；按需复用宿主反向代理 |

~~~mermaid
flowchart TD
  UI[React 页面与助手] --> API[Express 认证与数据权限]
  API --> Domains[预算/财报/合同/费用/投资等领域服务]
  API --> Assistant[应用内 AI 编排]
  Assistant --> Tools[参数校验与受控工具]
  Tools --> Domains
  Tools --> Knowledge[本地文档解析与权限检索]
  Assistant --> Models[模型适配与费用控制]
  Models --> Provider[外部模型 API]
  Domains --> DB[(独立 SQLite 数据库)]
  Domains --> Files[(独立本地文件目录)]
  Jobs[有界任务执行器] --> Domains
  Jobs --> Models
~~~

优先使用 newbd 前端与接口体系。lishui 的页面和组件可按需要移植，但不承诺旧 API、表结构和页面布局逐项原样兼容；需要保持的是已确认的业务结果与流程。

复杂预测公式可评估复用 lishui 的 Node/Univer 计算能力，按任务启动并限制并发。扫描件 OCR、语义模型优先调用外部 API，避免本机常驻大模型；相应代价是网络依赖与 API 费用。

## 模块依赖约束

- Express 路由做认证、参数解析和响应；领域 service 执行业务规则及权限范围；repository 只处理持久化。
- API、后台任务和 AI 工具调用同一 service，不各写一套计算或数据筛选。
- 跨域通过明确的读取/业务接口协作；同一事实只有一个写入归属。禁止助手绕过 service 直接写表。
- 继续使用 newbd 的 backend/src/modules、core、assistant 及 frontend/src 结构。按实际修改需要拆文件，不机械地给每个简单模块制造四层空壳。
- 新 API 以运行时 schema 校验；前端类型从共享契约或生成物取得，避免手写不一致 DTO。具体生成工具在首个契约闭环中选定。
- 状态与领域数据直接落 SQLite；不得通过读取 old newbd/lishui 目录形成运行依赖。

## 调研依据

| 来源 | 文件或目录（相对于对应源码仓库） | 用途 |
|---|---|---|
| newbd | backend/src/assistant/ | 模型渠道、工具、页面上下文与引用 |
| newbd | backend/src/core/money.ts、rollup.ts | 精确整数金额、安全范围与汇总 |
| newbd | backend/src/db/connection.ts、backend/src/modules/ | SQLite、预算、实际、导入、备份和认证 |
| lishui | architecture/features.json、backend/tests/ | 功能与验收场景来源 |
| lishui | backend/app/services/expense_audit/、contract_lifecycle/ | 审核规则、证据与人工复核 |
| lishui | backend/app/services/investment_feasibility/、management_accounting/ | 财务计算及快照语义 |

初始化后在 docs/source-provenance.md 写实际导入记录，不能将本规范中的拟采用基线当成已完成导入。
