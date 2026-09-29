import type { Express } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { authOf, type Wrap } from '../security/http';
import { getJobFor, listJobsFor, requestCancel } from './job.service';
import { listModelCalls, modelCallStats } from './model-calls';

const JOB_STATUS = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const CALL_STATUS = new Set(['success', 'error', 'timeout', 'cancelled']);

function positive(value: unknown, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw Errors.validation(`${name} 必须为正整数`);
  return n;
}

function optionalEnum(value: unknown, allowed: Set<string>, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !allowed.has(value)) throw Errors.validation(`${name} 取值不合法`);
  return value;
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 64) throw Errors.validation(`${name} 不合法`);
  return value;
}

/** 任务中心与模型调用记录。任务按创建者可见;模型调用记录需 tasks:read + 全部组织范围(路由表控制)。 */
export function registerJobRoutes(app: Express, db: () => DB, wrap: Wrap): void {
  app.get('/api/jobs', wrap((req, res) => {
    res.json(listJobsFor(db(), authOf(req), {
      status: optionalEnum(req.query.status, JOB_STATUS, 'status'),
      kind: optionalText(req.query.kind, 'kind'),
      page: positive(req.query.page, 'page'),
      pageSize: positive(req.query.pageSize, 'pageSize'),
    }));
  }));
  app.get('/api/jobs/:id', wrap((req, res) => {
    res.json(getJobFor(db(), authOf(req), positive(req.params.id, '任务 ID')!));
  }));
  app.post('/api/jobs/:id/cancel', wrap((req, res) => {
    res.json(requestCancel(db(), authOf(req), positive(req.params.id, '任务 ID')!));
  }));

  const callQuery = (q: Record<string, unknown>) => ({
    feature: optionalText(q.feature, 'feature'),
    status: optionalEnum(q.status, CALL_STATUS, 'status'),
    jobId: positive(q.jobId, 'jobId'),
    from: optionalText(q.from, 'from'),
    to: optionalText(q.to, 'to'),
    page: positive(q.page, 'page'),
    pageSize: positive(q.pageSize, 'pageSize'),
  });
  app.get('/api/model-calls', wrap((req, res) => res.json(listModelCalls(db(), callQuery(req.query as Record<string, unknown>)))));
  app.get('/api/model-calls/stats', wrap((req, res) => res.json({ items: modelCallStats(db(), callQuery(req.query as Record<string, unknown>)) })));
}
