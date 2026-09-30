import type { Express } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import type { ObjectStore } from '../files/object-store';
import { memoryUpload, sendAttachment, uploadName } from '../files/http';
import { id as idSchema } from '../../contracts/common';
import { year as yearSchema } from '../../contracts/project-budget';
import { PLAN_SHEETS, planActivateRequest, planQuery, planUploadForm, planVoidRequest, type PlanSheetCode } from '../../contracts/plan-execution';
import { formFields, queryFields } from '../project-budget/routes';
import {
  activatePlan, getPlanBatch, importPlan, listPlanBatches, planItems, planOriginal, planOverview, planProjectProgress, previewPlan, voidPlan,
} from './plan.service';

addRouteRules([
  { method: 'GET', pattern: /^\/plan\//, permission: 'plan:read' },
  { method: 'WRITE', pattern: /^\/plan\/(preview|import|batches\/\d+\/(activate|void))$/, permission: 'plan:write' },
]);

const id = (v: unknown) => parseInput(idSchema, v);

/** AC-F15 计划执行与形象进度。 */
export function registerPlanRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  const upload = memoryUpload(['.xlsx']);
  app.post('/api/plan/preview', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传计划执行 .xlsx');
    res.json(await previewPlan(db(), req.file.buffer, parseInput(planUploadForm, formFields(req))));
  }));
  app.post('/api/plan/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传计划执行 .xlsx');
    const batch = await importPlan(db(), store(), req.file.buffer, uploadName(req.file.originalname), parseInput(planUploadForm, formFields(req)));
    res.status(batch.replayed ? 200 : 201).json(batch);
  }));
  app.get('/api/plan/batches', wrap((req, res) => {
    const q = queryFields(req);
    if (q.status && q.status !== 'imported' && q.status !== 'voided') throw Errors.validation('查询参数不合法');
    res.json(listPlanBatches(db(), { year: q.year ? parseInput(yearSchema, q.year) : undefined, status: q.status }));
  }));
  app.get('/api/plan/batches/:id', wrap((req, res) => { res.json(getPlanBatch(db(), id(req.params.id))); }));
  app.get('/api/plan/batches/:id/items', wrap((req, res) => {
    const sheet = queryFields(req).sheet;
    if (sheet && !PLAN_SHEETS.includes(sheet as PlanSheetCode)) throw Errors.validation('查询参数不合法');
    res.json(planItems(db(), id(req.params.id), sheet as PlanSheetCode | undefined));
  }));
  app.get('/api/plan/batches/:id/original', wrap((req, res) => {
    const f = planOriginal(db(), store(), id(req.params.id));
    sendAttachment(res, f.fileName, f.contentType, f.content);
  }));
  app.post('/api/plan/batches/:id/activate', wrap((req, res) => {
    res.json(activatePlan(db(), id(req.params.id), parseInput(planActivateRequest, req.body).expectedCurrentBatchId));
  }));
  app.post('/api/plan/batches/:id/void', wrap((req, res) => { res.json(voidPlan(db(), id(req.params.id), parseInput(planVoidRequest, req.body).reason)); }));
  app.get('/api/plan/overview', wrap((req, res) => { res.json(planOverview(db(), parseInput(planQuery, queryFields(req)))); }));
  app.get('/api/plan/projects', wrap((req, res) => { res.json(planProjectProgress(db(), parseInput(planQuery, queryFields(req)))); }));
}
