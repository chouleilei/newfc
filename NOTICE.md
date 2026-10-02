# 来源与第三方声明

newfc 初始源码来自固定的 newbd 快照，之后在独立仓库内维护；部分业务规则与脱敏测试样本参考 lishui-finance-ai。来源提交、转写范围、兼容保留项及夹具出处见 [源码来源记录](docs/source-provenance.md)。来源标识用于追溯，不代表运行时依赖。

本次发布为源码公开版本，项目开源许可证尚未选定；不会把公开仓库本身视为 MIT 授权。GitHub 服务条款允许的查看和平台内 fork 按其条款执行；其他使用或再分发权限须由权利人确认。

第三方依赖继续适用各自授权。依赖版本以 backend/frontend 的 package-lock.json 为准。直接运行依赖主要包括：

| 依赖 | 许可 |
|---|---|
| Express、better-sqlite3、ExcelJS、Multer、Zod | MIT |
| JSZip | MIT 或 GPL-3.0-or-later 双重许可，本项目采用 MIT 路径 |
| React、React DOM、React Router、Ant Design、TanStack Query、Day.js | MIT |
| Apache ECharts、Remix Icon | Apache-2.0 |
| Fraunces、IBM Plex Sans、IBM Plex Mono | SIL Open Font License 1.1 |

运行依赖附带的 LICENSE/NOTICE 和字体声明汇总在 [第三方许可文本](docs/third-party-licenses.txt)。安装包仍应保留各自版权与许可文件；若再分发构建后的 JS、CSS 或字体，也须一并提供相关许可与声明。构建工具和测试工具采用其各自包内的许可证。
