import type { Express, Request, Response, NextFunction } from 'express';
import { requireActionPermission, requireAllOrgsForAction } from './tool-policy';
import type { ChatRequest } from '../contracts/assistant';
import type { DB } from '../db/connection';
import * as svc from './service';
import { qualityAdvice } from './quality-advice';
import { masterDataSemanticNames } from './master-data-semantic';
import { executeTool } from './tools';
import { parseChatRequest, parsePreviewRequest } from './schemas';
import { assistantRateLimit, assistantNarrativeRateLimit } from './rate-limit';

function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // nginx 反代下必须关闭缓冲，否则代理会攒够一整块才下发，流式退化成一次性。
  res.setHeader('X-Accel-Buffering', 'no');
  (res as any).flushHeaders?.();
}

function sseWrite(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // 压缩中间件存在时需要显式 flush，否则仍会攒包。
  (res as any).flush?.();
}

/**
 * 真流式对话。
 *
 * 与旧实现的区别：先落 SSE 响应头，再把 svc.chat 的 onToken 回调逐块下发；
 * 不再「等完整回答生成完，再把成品按 40 字符切片假装流式」。
 * 首字延迟因此等于模型的首个 delta，而不是整轮工具调用加模型生成的总时长。
 *
 * 响应头已经发出后无法再改成 JSON 错误，因此异常以 `event: error` 下发，
 * 并始终补一个 `event: done`，保证客户端不会卡在等待 done 的状态。
 */
async function streamChat(req: Request, res: Response, db: DB, request: ChatRequest, actor: string): Promise<void> {
  const prepared = svc.prepareChat(db, request);
  sseHeaders(res);
  // 立刻发一个 open 事件，确认连接已建立(也用于击穿代理的首包缓冲)。
  sseWrite(res, 'open', { ok: true });
  let closed = false;
  let completed = false;
  const controller = new AbortController();
  const close = () => {
    closed = true;
    if (!completed) controller.abort();
  };
  res.on('close', close);
  req.on('aborted', close);
  try {
    const result = await svc.chat(db, request, actor, {
      onToken: (chunk) => { if (!closed && chunk) sseWrite(res, 'token', { text: chunk }); },
      // 进度事件：模型路由要先跑工具调用轮，首字延迟可能十几秒；
      // 期间如实播报「正在计算差异归因」这类阶段，避免界面上只有一个转圈。
      onProgress: (event) => { if (!closed) sseWrite(res, 'progress', event); },
      signal: controller.signal,
    }, prepared);
    completed = true;
    if (!closed) sseWrite(res, 'done', { ...result, done: true });
  } catch (err) {
    const error = err as { code?: string; message?: string; status?: number };
    if (!closed) {
      sseWrite(res, 'error', { code: error?.code || 'INTERNAL_ERROR', message: error?.message || '助手请求失败' });
      sseWrite(res, 'done', { done: true, failed: true });
    }
  } finally {
    completed = true;
    res.off('close', close);
    req.off('aborted', close);
    if (!closed) res.end();
  }
}

export function registerAssistantRoutes(
  app: Express,
  db: () => DB,
  wrap: (fn: (req: Request, res: Response) => any) => (req: Request, res: Response, next: NextFunction) => void,
) {
  app.post('/api/assistant/chat', assistantRateLimit, wrap(async (req, res) => res.json(await svc.chat(db(), parseChatRequest(req.body), (req as any).authUser || ''))));
  app.post('/api/assistant/chat/stream', assistantRateLimit, wrap(async (req, res) => {
    // 请求体校验必须在写 SSE 响应头之前完成，这样格式错误仍能返回结构化 400。
    const request = parseChatRequest(req.body);
    await streamChat(req, res, db(), request, (req as any).authUser || '');
  }));
  // 只保留 POST 流式入口。曾经存在的 `GET /api/assistant/chat/stream` 已删除：
  // 它会创建会话、写 ai_message、写操作日志并消耗模型额度，却是一个 GET——
  // GET 不经 CSRF 校验，带着会话 Cookie 的跨站 `new EventSource(...)` 就能触发这些副作用
  // (简单 GET 无预检、CORS 只挡读取不挡副作用)。
  // 前端一直走 POST + fetch 读流，因此直接移除，不保留兼容层。
  app.post('/api/assistant/preview', assistantRateLimit, wrap((req, res) => {
    const parsed = parsePreviewRequest(req.body);
    if (!parsed.idempotencyKey && req.header('idempotency-key')) parsed.idempotencyKey = req.header('idempotency-key')!.trim();
    return res.status(201).json(svc.preview(db(), parsed, (req as any).authUser || ''));
  }));
  // 确认会落库、下载会重算导出、取消会写操作日志：三个都属于「消耗资源的写入型入口」，
  // 与 rate-limit.ts 自述的口径一致，必须一起限流(原来只有 chat/preview 挂了)。
  app.post('/api/assistant/actions/:id/confirm', assistantRateLimit, wrap(async (req, res) => res.json(await svc.confirmAsync(db(), Number(req.params.id), (req as any).authUser || '', req.body?.confirmationToken))));
  app.get('/api/assistant/actions/:id/download', assistantRateLimit, wrap(async (req, res) => {
    const out = await svc.exportArtifact(db(), Number(req.params.id));
    res.setHeader('Content-Type', out.filename.endsWith('.csv') ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
    res.send(out.buffer);
  }));
  app.post('/api/assistant/actions/:id/cancel', assistantRateLimit, wrap((req, res) => res.json(svc.cancel(db(), Number(req.params.id), (req as any).authUser || ''))));
  app.get('/api/assistant/conversations', wrap((_req, res) => res.json({ items: svc.conversations(db()) })));
  app.get('/api/assistant/conversations/:id', wrap((req, res) => res.json(svc.conversation(db(), Number(req.params.id)))));
  app.patch('/api/assistant/conversations/:id', wrap((req, res) => res.json(svc.renameConversation(db(), Number(req.params.id), req.body?.title, (req as any).authUser || ''))));
  app.delete('/api/assistant/conversations/:id', wrap((req, res) => res.json(svc.deleteConversation(db(), Number(req.params.id), (req as any).authUser || ''))));
  app.get('/api/assistant/insights', wrap((req, res) => res.json({ items: svc.insights(db(), req.query.limit == null ? 50 : Number(req.query.limit)) })));
  // saveInsight 按 kind 在后端重新确定性计算归因/异常/报告并写 ai_insight,
  // 属于「做重计算的写入型入口」,与 rate-limit.ts 自述口径一致,必须限流。
  app.post('/api/assistant/insights', assistantRateLimit, wrap((req, res) => res.status(201).json(svc.saveInsight(db(), req.body || {}, (req as any).authUser || ''))));
  app.get('/api/assistant/insights/:id', wrap((req, res) => res.json(svc.insight(db(), Number(req.params.id)))));
  app.delete('/api/assistant/insights/:id', wrap((req, res) => res.json(svc.deleteInsight(db(), Number(req.params.id), (req as any).authUser || ''))));
  app.get('/api/assistant/glossary', wrap((req, res) => {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(executeTool(db(), 'explain_terms', { query }));
  }));
  app.get('/api/assistant/navigation', wrap((_req, res) => res.json(executeTool(db(), 'get_navigation_catalog', {}))));
  // 方案 4.3 差异归因:只读,按组织/科目/方向排序并逐层展开
  app.post('/api/assistant/attribution', assistantRateLimit, wrap((req, res) => res.json(svc.attribution(db(), req.body || {}))));
  // 方案 4.3 报告生成:执行月报 / 年度复盘 / 预算讨论材料(只读,确定性组稿)
  app.post('/api/assistant/report', assistantRateLimit, wrap(async (req, res) => res.json(await svc.reportDraft(db(), req.body || {}))));
  // 方案 4.1 导入辅助:错误解释 + 组织/科目匹配建议 + 未匹配与重复清单(只读)
  app.post('/api/assistant/import-help', assistantRateLimit, wrap((req, res) => res.json(svc.importHelp(db(), req.body || {}))));
  // AI 功能增强计划 §四.阶段一:定稿质量门禁「解释 + 修复建议」(只读;叙述桶限流,不与聊天共用配额)
  app.post('/api/assistant/quality-advice', assistantNarrativeRateLimit, wrap(async (req, res) => {
    const versionId = Number(req.body?.versionId);
    if (!Number.isSafeInteger(versionId) || versionId <= 0) {
      res.status(400).json({ code: 'VALIDATION_FAILED', message: 'versionId 必须是正整数' });
      return;
    }
    // 定稿质量门禁是整版检查(集团口径),与预算质量工具同一授权
    requireActionPermission('budget:read', '查看预算质量');
    requireAllOrgsForAction('预算质量建议');
    res.json(await qualityAdvice(db(), versionId));
  }));
  // AI 功能增强计划 §四.阶段三.AI:主数据「语义命名相似」候选对(只读建议,永不作为事实,零写入)
  app.post('/api/assistant/master-data-semantic-names', assistantNarrativeRateLimit, wrap(async (_req, res) => {
    requireActionPermission('master:read', '查看主数据');
    requireAllOrgsForAction('主数据语义检查');
    res.json(await masterDataSemanticNames(db()));
  }));
}
