import type { Express, Request } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import type { ObjectStore } from '../files/object-store';
import { memoryUpload, sendAttachment, uploadName } from '../files/http';
import { id as idSchema } from '../../contracts/common';
import { pbActivateRequest, pbBatchListQuery, pbBatchPageQuery, pbSummaryQuery, pbUploadForm, pbVoidRequest } from '../../contracts/project-budget';
import {
  activateProjectBudget, getProjectBudgetBatch, importProjectBudget, listProjectBudgetBatches, listProjectBudgetBatchesPage, previewProjectBudget, projectBudgetEntries,
  projectBudgetOriginal, projectBudgetSummary, voidProjectBudget,
} from './project-budget.service';

addRouteRules([
  { method: 'GET', pattern: /^\/project-budget\//, permission: 'project_budget:read' },
  { method: 'WRITE', pattern: /^\/project-budget\/(preview|import|batches\/\d+\/(activate|void))$/, permission: 'project_budget:write' },
]);

const id = (v: unknown) => parseInput(idSchema, v);
export function formFields(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) if (typeof v === 'string' && v !== '') out[k] = v;
  return out;
}
/** 查询串:去掉空值后交给 schema。 */
export function queryFields(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.query)) if (typeof v === 'string' && v !== '') out[k] = v;
  return out;
}

/** AC-F09 项目预算。服务层按明细组织裁剪范围;写操作要求批次涉及的全部组织在范围内。 */
export function registerProjectBudgetRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  const upload = memoryUpload(['.xlsx']);
  app.post('/api/project-budget/preview', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传项目预算 .xlsx');
    res.json(await previewProjectBudget(db(), req.file.buffer, parseInput(pbUploadForm, formFields(req))));
  }));
  app.post('/api/project-budget/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传项目预算 .xlsx');
    const batch = await importProjectBudget(db(), store(), req.file.buffer, uploadName(req.file.originalname), parseInput(pbUploadForm, formFields(req)));
    res.status(batch.replayed ? 200 : 201).json(batch);
  }));
  app.get('/api/project-budget/batches', wrap((req, res) => {
    res.json(listProjectBudgetBatches(db(), parseInput(pbBatchListQuery, queryFields(req))));
  }));
  app.get('/api/project-budget/batches/page', wrap((req, res) => {
    res.json(listProjectBudgetBatchesPage(db(), parseInput(pbBatchPageQuery, req.query)));
  }));
  app.get('/api/project-budget/batches/:id', wrap((req, res) => { res.json(getProjectBudgetBatch(db(), id(req.params.id))); }));
  app.get('/api/project-budget/batches/:id/entries', wrap((req, res) => { res.json(projectBudgetEntries(db(), id(req.params.id))); }));
  app.get('/api/project-budget/batches/:id/original', wrap((req, res) => {
    const f = projectBudgetOriginal(db(), store(), id(req.params.id));
    sendAttachment(res, f.fileName, f.contentType, f.content);
  }));
  app.post('/api/project-budget/batches/:id/activate', wrap((req, res) => {
    res.json(activateProjectBudget(db(), id(req.params.id), parseInput(pbActivateRequest, req.body).expectedCurrentBatchId));
  }));
  app.post('/api/project-budget/batches/:id/void', wrap((req, res) => { res.json(voidProjectBudget(db(), id(req.params.id), parseInput(pbVoidRequest, req.body).reason)); }));
  app.get('/api/project-budget/summary', wrap((req, res) => { res.json(projectBudgetSummary(db(), parseInput(pbSummaryQuery, queryFields(req)))); }));
}
