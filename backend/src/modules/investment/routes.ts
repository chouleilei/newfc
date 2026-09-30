import type { Express } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import type { ObjectStore } from '../files/object-store';
import { memoryUpload, sendAttachment, uploadName } from '../files/http';
import { id as idSchema } from '../../contracts/common';
import {
  feasImportConfirm, feasProjectCreate, feasProjectListQuery, feasProjectUpdate, feasRunRequest, feasScenarioCopy, feasScenarioCreate, feasScenarioUpdate,
  feasSensitivityRequest,
} from '../../contracts/investment-feasibility';
import { queryFields } from '../project-budget/routes';
import {
  confirmFeasImport, copyFeasScenario, createFeasProject, createFeasScenario, exportFeasRun, exportFeasTemplate, getFeasProject, getFeasRun, getFeasScenario,
  listFeasProjects, listFeasRuns, previewFeasImport, runFeasScenario, startFeasSensitivity, updateFeasProject, updateFeasScenario,
} from './feasibility.service';

addRouteRules([
  { method: 'GET', pattern: /^\/investment(\/|$)/, permission: 'investment:read' },
  { method: 'WRITE', pattern: /^\/investment(\/|$)/, permission: 'investment:write' },
]);

const id = (v: unknown) => parseInput(idSchema, v);
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** AC-F12 投资可行性测算 / AC-F13 投资控制。服务层按 org_id 裁剪范围,范围外 404。 */
export function registerInvestmentRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  const upload = memoryUpload(['.xlsx']);
  const base = '/api/investment/feasibility';

  app.get(`${base}/template`, wrap(async (req, res) => {
    const q = queryFields(req);
    const out = await exportFeasTemplate(db(), q.scenarioId ? id(q.scenarioId) : undefined);
    sendAttachment(res, out.fileName, XLSX, out.buffer);
  }));
  app.get(`${base}/projects`, wrap((req, res) => { res.json(listFeasProjects(db(), parseInput(feasProjectListQuery, queryFields(req)))); }));
  app.post(`${base}/projects`, wrap((req, res) => { res.status(201).json(createFeasProject(db(), parseInput(feasProjectCreate, req.body))); }));
  app.get(`${base}/projects/:id`, wrap((req, res) => { res.json(getFeasProject(db(), id(req.params.id))); }));
  app.patch(`${base}/projects/:id`, wrap((req, res) => { res.json(updateFeasProject(db(), id(req.params.id), parseInput(feasProjectUpdate, req.body))); }));
  app.post(`${base}/projects/:id/scenarios`, wrap((req, res) => {
    res.status(201).json(createFeasScenario(db(), id(req.params.id), parseInput(feasScenarioCreate, req.body)));
  }));
  app.post(`${base}/projects/:id/imports`, upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传标准模板 .xlsx');
    res.status(201).json(await previewFeasImport(db(), store(), id(req.params.id), req.file.buffer, uploadName(req.file.originalname)));
  }));
  app.post(`${base}/imports/:id/confirm`, wrap(async (req, res) => {
    res.json(await confirmFeasImport(db(), store(), id(req.params.id), parseInput(feasImportConfirm, req.body)));
  }));

  app.get(`${base}/scenarios/:id`, wrap((req, res) => { res.json(getFeasScenario(db(), id(req.params.id))); }));
  app.patch(`${base}/scenarios/:id`, wrap((req, res) => { res.json(updateFeasScenario(db(), id(req.params.id), parseInput(feasScenarioUpdate, req.body))); }));
  app.post(`${base}/scenarios/:id/copy`, wrap((req, res) => { res.status(201).json(copyFeasScenario(db(), id(req.params.id), parseInput(feasScenarioCopy, req.body))); }));
  app.post(`${base}/scenarios/:id/run`, wrap((req, res) => {
    res.status(201).json(runFeasScenario(db(), id(req.params.id), parseInput(feasRunRequest, req.body).expectedVersion));
  }));
  app.post(`${base}/scenarios/:id/sensitivity`, wrap((req, res) => {
    const { jobId } = startFeasSensitivity(db, id(req.params.id), parseInput(feasSensitivityRequest, req.body));
    res.status(202).json({ jobId });
  }));
  app.get(`${base}/scenarios/:id/runs`, wrap((req, res) => { res.json(listFeasRuns(db(), id(req.params.id))); }));
  app.get(`${base}/runs/:id`, wrap((req, res) => { res.json(getFeasRun(db(), id(req.params.id))); }));
  app.get(`${base}/runs/:id/export`, wrap(async (req, res) => {
    const out = await exportFeasRun(db(), id(req.params.id));
    sendAttachment(res, out.fileName, XLSX, out.buffer);
  }));
}
