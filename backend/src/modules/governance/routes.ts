import type { Express } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import { id as idSchema, period as periodSchema } from '../../contracts/common';
import { GOV_ISSUE_STATUSES, GOV_SOURCE_TYPES, govDispositionCreate, govReviewRequest, govScanRequest } from '../../contracts/governance';
import { getIssue, listIssues, reviewDisposition, scanIssues, submitDisposition, verifyIssue } from './governance.service';

addRouteRules([
  { method: 'GET', pattern: /^\/governance\//, permission: 'governance:read' },
  { method: 'WRITE', pattern: /^\/governance\/(scan|issues\/\d+\/dispositions)$/, permission: 'governance:resolve' },
  { method: 'WRITE', pattern: /^\/governance\/dispositions\/\d+\/review$/, permission: 'governance:review' },
]);

const id = (value: unknown) => parseInput(idSchema, value);
function opt<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!allowed.includes(value as T)) throw Errors.validation('查询参数不合法');
  return value as T;
}

/** AC-F06 数据治理。服务层按 AuthContext 裁剪组织范围。 */
export function registerGovernanceRoutes(app: Express, db: () => DB, wrap: Wrap): void {
  app.get('/api/governance/issues', wrap((req, res) => {
    res.json(listIssues(db(), {
      status: opt(req.query.status, GOV_ISSUE_STATUSES), sourceType: opt(req.query.sourceType, GOV_SOURCE_TYPES),
      orgId: req.query.orgId ? id(req.query.orgId) : undefined, period: req.query.period ? parseInput(periodSchema, req.query.period) : undefined,
    }));
  }));
  app.get('/api/governance/issues/:id', wrap((req, res) => { res.json(getIssue(db(), id(req.params.id))); }));
  app.get('/api/governance/issues/:id/verify', wrap((req, res) => { res.json(verifyIssue(db(), id(req.params.id))); }));
  app.post('/api/governance/scan', wrap((req, res) => { res.json(scanIssues(db(), parseInput(govScanRequest, req.body ?? {}))); }));
  app.post('/api/governance/issues/:id/dispositions', wrap((req, res) => {
    res.status(201).json(submitDisposition(db(), id(req.params.id), parseInput(govDispositionCreate, req.body)));
  }));
  app.post('/api/governance/dispositions/:id/review', wrap((req, res) => {
    res.json(reviewDisposition(db(), id(req.params.id), parseInput(govReviewRequest, req.body)));
  }));
}
