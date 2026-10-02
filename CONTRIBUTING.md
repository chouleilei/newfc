# 参与开发

先阅读 [AGENTS.md](AGENTS.md)、[规范索引](specs/README.md) 和 [源码来源](docs/source-provenance.md)。需求、接口契约和验收规则在 specs 中维护。

使用 Node 24.21.0，在 backend 和 frontend 分别运行 `npm ci`。提交前执行：

```bash
(cd backend && npx tsc --noEmit && npm test -- --run)
(cd frontend && npm test -- --run && npm run build)
git diff --check
```

测试数据库必须位于临时或可丢弃目录。不要指向正式运行库，不提交真实单据、凭据、会话、备份或内部 QA 原件。浏览器测试的准备方法见 [公开版验收摘要](docs/public-release.md)。

金额使用整数分和定点 bigint；权限由服务端 AuthContext 决定；迁移只追加。AI 只调用同源只读工具，正式写入由业务页面明确确认。提交消息说明功能 ID、任务和验收 ID。

问题报告请提供版本、脱敏操作步骤、实际和预期结果。安全问题通过 [私密报告](SECURITY.md) 提交。
