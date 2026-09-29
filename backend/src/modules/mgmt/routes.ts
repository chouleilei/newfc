import type { Express, Request } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import { id as idSchema, period as periodSchema } from '../../contracts/common';
import {
  maAlertAckRequest, maAlertCloseRequest, maAlertScanRequest, maAllocAdjustmentCreate, maAllocConfirmRequest, maAllocRulesRequest, maAllocVoidRequest,
  maAnalysisQuery, maBudgetAdjustmentCreate, maCalcRunRequest, maCostPoolCreate, maCostPoolUpdate, maDimensionCreate, maDimensionUpdate, maMemberConfirmRequest,
  maMemberPreviewRequest, maMetricCreate, maMetricUpdate, maPerfReviewRequest, maPerfSchemeCreate, maPerfScoreRequest, maReviewRequest,
} from '../../contracts/mgmt';
import * as dim from './dimension.service';
import * as metric from './metric.service';
import * as alloc from './allocation.service';
import * as budgetAdj from './budget-adjust.service';
import * as alert from './alert.service';
import * as perf from './performance.service';
import { responsibilityCenters } from './center.service';

/*
 * 口径定义(维度、指标、绩效方案)是全局配置,只对全组织用户开放写;
 * 预算调整生效会切换全局当前版本,与版本锁定/设为当前同样需要 budget:finalize 与全组织权限。
 */
addRouteRules([
  { method: 'GET', pattern: /^\/mgmt\//, permission: 'mgmt:read' },
  { method: 'WRITE', pattern: /^\/mgmt\/(alloc-adjustments|perf-scores)\/\d+\/review$/, permission: 'mgmt:review' },
  { method: 'WRITE', pattern: /^\/mgmt\/budget-adjustments\/\d+\/review$/, permission: 'budget:finalize', allOrgs: true },
  { method: 'WRITE', pattern: /^\/mgmt\/(dimensions|metrics|perf-schemes)(\/\d+)?$/, permission: 'mgmt:write', allOrgs: true },
  { method: 'WRITE', pattern: /^\/mgmt\//, permission: 'mgmt:write' },
]);

const id = (value: unknown) => parseInput(idSchema, value);
const optId = (value: unknown) => (value === undefined || value === '' ? undefined : id(value));
const optPeriod = (value: unknown) => (value === undefined || value === '' ? undefined : parseInput(periodSchema, value));
function opt<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!allowed.includes(value as T)) throw Errors.validation('查询参数不合法');
  return value as T;
}
const list = (value: unknown): string[] | undefined => (typeof value === 'string' && value ? value.split(',').map((x) => x.trim()).filter(Boolean) : undefined);
const body = (req: Request) => req.body ?? {};

/** AC-F14 管理会计。服务层按 AuthContext 裁剪组织范围。 */
export function registerMgmtRoutes(app: Express, db: () => DB, wrap: Wrap): void {
  /* 维度 */
  app.get('/api/mgmt/dimensions', wrap((_req, res) => { res.json(dim.listDimensions(db())); }));
  app.get('/api/mgmt/dimensions/:id', wrap((req, res) => { res.json(dim.getDimension(db(), id(req.params.id))); }));
  app.post('/api/mgmt/dimensions', wrap((req, res) => { res.status(201).json(dim.createDimension(db(), parseInput(maDimensionCreate, body(req)))); }));
  app.patch('/api/mgmt/dimensions/:id', wrap((req, res) => { res.json(dim.updateDimension(db(), id(req.params.id), parseInput(maDimensionUpdate, body(req)))); }));
  app.post('/api/mgmt/dimensions/:id/members/preview', wrap((req, res) => { res.json(dim.previewMembers(db(), id(req.params.id), parseInput(maMemberPreviewRequest, body(req)))); }));
  app.post('/api/mgmt/dimensions/:id/members/confirm', wrap((req, res) => { res.json(dim.confirmMembers(db(), id(req.params.id), parseInput(maMemberConfirmRequest, body(req)))); }));

  /* 指标与计算 */
  app.get('/api/mgmt/metrics', wrap((req, res) => { res.json(metric.listMetrics(db(), { status: opt(req.query.status, ['active', 'inactive'] as const) })); }));
  app.post('/api/mgmt/metrics', wrap((req, res) => { res.status(201).json(metric.createMetric(db(), parseInput(maMetricCreate, body(req)))); }));
  app.patch('/api/mgmt/metrics/:id', wrap((req, res) => { res.json(metric.updateMetric(db(), id(req.params.id), parseInput(maMetricUpdate, body(req)))); }));
  app.get('/api/mgmt/calc-runs', wrap((req, res) => {
    res.json(metric.listCalcRuns(db(), { period: optPeriod(req.query.period), kind: opt(req.query.kind, ['calc', 'allocation'] as const) }));
  }));
  app.get('/api/mgmt/calc-runs/:id', wrap((req, res) => { res.json(metric.getCalcRun(db(), id(req.params.id))); }));
  app.post('/api/mgmt/calc-runs', wrap((req, res) => { res.status(201).json(metric.createCalcRun(db(), parseInput(maCalcRunRequest, body(req)))); }));
  app.get('/api/mgmt/snapshots', wrap((req, res) => {
    res.json(metric.listSnapshots(db(), {
      metricId: optId(req.query.metricId), orgId: optId(req.query.orgId), period: optPeriod(req.query.period), runId: optId(req.query.runId),
      status: opt(req.query.status, ['valid', 'unavailable', 'invalidated'] as const),
    }));
  }));
  app.get('/api/mgmt/analysis', wrap((req, res) => {
    res.json(metric.analyze(db(), parseInput(maAnalysisQuery, {
      metricIds: list(req.query.metricIds), periods: list(req.query.periods), groupBy: req.query.groupBy || undefined,
      dimensionId: req.query.dimensionId || undefined, orgIds: list(req.query.orgIds),
    })));
  }));

  /* 分摊 */
  app.get('/api/mgmt/cost-pools', wrap((req, res) => { res.json(alloc.listPools(db(), { period: optPeriod(req.query.period), orgId: optId(req.query.orgId) })); }));
  app.get('/api/mgmt/cost-pools/:id', wrap((req, res) => { res.json(alloc.getPool(db(), id(req.params.id))); }));
  app.get('/api/mgmt/cost-pools/:id/preview', wrap((req, res) => { res.json(alloc.previewAllocation(db(), id(req.params.id))); }));
  app.post('/api/mgmt/cost-pools', wrap((req, res) => { res.status(201).json(alloc.createPool(db(), parseInput(maCostPoolCreate, body(req)))); }));
  app.patch('/api/mgmt/cost-pools/:id', wrap((req, res) => { res.json(alloc.updatePool(db(), id(req.params.id), parseInput(maCostPoolUpdate, body(req)))); }));
  app.put('/api/mgmt/cost-pools/:id/rules', wrap((req, res) => { res.json(alloc.setRules(db(), id(req.params.id), parseInput(maAllocRulesRequest, body(req)))); }));
  app.post('/api/mgmt/cost-pools/:id/confirm', wrap((req, res) => {
    res.status(201).json(alloc.confirmAllocation(db(), id(req.params.id), parseInput(maAllocConfirmRequest, body(req)).expectedVersion));
  }));
  app.get('/api/mgmt/alloc-runs', wrap((req, res) => { res.json(alloc.listRuns(db(), { poolId: optId(req.query.poolId), status: opt(req.query.status, ['confirmed', 'voided'] as const) })); }));
  app.get('/api/mgmt/alloc-runs/:id', wrap((req, res) => { res.json(alloc.getRun(db(), id(req.params.id))); }));
  app.get('/api/mgmt/alloc-runs/:id/lineage', wrap((req, res) => { res.json(alloc.lineage(db(), id(req.params.id))); }));
  app.post('/api/mgmt/alloc-runs/:id/void', wrap((req, res) => { res.json(alloc.voidAllocation(db(), id(req.params.id), parseInput(maAllocVoidRequest, body(req)).reason)); }));
  app.post('/api/mgmt/alloc-runs/:id/adjustments', wrap((req, res) => {
    res.status(201).json(alloc.createAdjustment(db(), id(req.params.id), parseInput(maAllocAdjustmentCreate, body(req))));
  }));
  app.get('/api/mgmt/alloc-adjustments', wrap((_req, res) => { res.json(alloc.listPendingAdjustments(db())); }));
  app.get('/api/mgmt/alloc-adjustments/:id', wrap((req, res) => { res.json(alloc.getAdjustment(db(), id(req.params.id))); }));
  app.post('/api/mgmt/alloc-adjustments/:id/review', wrap((req, res) => { res.json(alloc.reviewAdjustment(db(), id(req.params.id), parseInput(maReviewRequest, body(req)))); }));

  /* 预算调整 */
  app.get('/api/mgmt/budget-adjustments', wrap((req, res) => {
    res.json(budgetAdj.listBudgetAdjustments(db(), { status: opt(req.query.status, ['pending', 'effective', 'rejected'] as const) }));
  }));
  app.get('/api/mgmt/budget-adjustments/:id', wrap((req, res) => { res.json(budgetAdj.getBudgetAdjustment(db(), id(req.params.id))); }));
  app.post('/api/mgmt/budget-adjustments', wrap((req, res) => { res.status(201).json(budgetAdj.submitBudgetAdjustment(db(), parseInput(maBudgetAdjustmentCreate, body(req)))); }));
  app.post('/api/mgmt/budget-adjustments/:id/review', wrap((req, res) => {
    res.json(budgetAdj.reviewBudgetAdjustment(db(), id(req.params.id), parseInput(maReviewRequest, body(req))));
  }));

  /* 预警 */
  app.get('/api/mgmt/alerts', wrap((req, res) => {
    res.json(alert.listAlerts(db(), {
      status: opt(req.query.status, ['open', 'acknowledged', 'closed', 'unclosed'] as const), orgId: optId(req.query.orgId),
      period: optPeriod(req.query.period), metricId: optId(req.query.metricId),
    }));
  }));
  app.get('/api/mgmt/alerts/:id', wrap((req, res) => { res.json(alert.getAlert(db(), id(req.params.id))); }));
  app.post('/api/mgmt/alerts/scan', wrap((req, res) => { res.json(alert.scanAlerts(db(), parseInput(maAlertScanRequest, body(req)).runId)); }));
  app.post('/api/mgmt/alerts/:id/acknowledge', wrap((req, res) => { res.json(alert.acknowledgeAlert(db(), id(req.params.id), parseInput(maAlertAckRequest, body(req)))); }));
  app.post('/api/mgmt/alerts/:id/close', wrap((req, res) => { res.json(alert.closeAlert(db(), id(req.params.id), parseInput(maAlertCloseRequest, body(req)))); }));

  /* 责任中心 */
  app.get('/api/mgmt/centers', wrap((req, res) => {
    res.json(responsibilityCenters(db(), { period: parseInput(periodSchema, req.query.period), orgId: optId(req.query.orgId) }));
  }));

  /* 绩效 */
  app.get('/api/mgmt/perf-schemes', wrap((_req, res) => { res.json(perf.listSchemes(db())); }));
  app.get('/api/mgmt/perf-schemes/:id', wrap((req, res) => { res.json(perf.getScheme(db(), id(req.params.id))); }));
  app.post('/api/mgmt/perf-schemes', wrap((req, res) => { res.status(201).json(perf.createScheme(db(), parseInput(maPerfSchemeCreate, body(req)))); }));
  app.post('/api/mgmt/perf-schemes/:id/score', wrap((req, res) => { res.status(201).json(perf.scorePerformance(db(), id(req.params.id), parseInput(maPerfScoreRequest, body(req)))); }));
  app.get('/api/mgmt/perf-scores', wrap((req, res) => {
    res.json(perf.listScores(db(), {
      schemeId: optId(req.query.schemeId), period: optPeriod(req.query.period), orgId: optId(req.query.orgId), status: opt(req.query.status, ['scored', 'reviewed'] as const),
    }));
  }));
  app.get('/api/mgmt/perf-scores/:id', wrap((req, res) => { res.json(perf.getScore(db(), id(req.params.id))); }));
  app.post('/api/mgmt/perf-scores/:id/review', wrap((req, res) => { res.json(perf.reviewScore(db(), id(req.params.id), parseInput(maPerfReviewRequest, body(req)))); }));
}
