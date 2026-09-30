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
  feasReportCreate, feasReportListQuery, feasReportReview, feasReportSubmit, feasScenarioCommand, feasSensitivityRequest,
} from '../../contracts/investment-feasibility';
import {
  icCompareRequest, icImportConfirm, icImportForm, icMappingUpdate, icProjectCreate, icProjectListQuery, icProjectUpdate, icVersionConfirm, icVersionVoid,
} from '../../contracts/investment-control';
import { formFields, queryFields } from '../project-budget/routes';
import {
  confirmIcImport, confirmIcVersion, createIcComparison, createIcProject, exportIcComparison, getIcComparison, getIcProject, getIcVersion, icTemplateBuffer,
  listIcComparisons, listIcProjects, previewIcImport, updateIcMapping, updateIcProject, voidIcVersion,
} from './control.service';
import {
  confirmFeasImport, copyFeasScenario, createFeasProject, createFeasScenario, exportFeasRun, exportFeasTemplate, getFeasProject, getFeasRun, getFeasScenario,
  deleteFeasScenario, listFeasProjects, listFeasRuns, previewFeasImport, runFeasScenario, setFeasBaseline, startFeasSensitivity, updateFeasProject, updateFeasScenario,
} from './feasibility.service';
import { createFeasReport, getFeasReport, listFeasReports, reviewFeasReport, submitFeasReport } from './feasibility-report.service';

addRouteRules([
  // 复核人不需要维护权限:先于通用写规则匹配
  { method: 'WRITE', pattern: /^\/investment\/feasibility\/reports\/\d+\/review$/, permission: 'investment:review' },
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
  app.post(`${base}/scenarios/:id/baseline`, wrap((req, res) => {
    res.json(setFeasBaseline(db(), id(req.params.id), parseInput(feasScenarioCommand, req.body ?? {}).expectedVersion));
  }));
  app.delete(`${base}/scenarios/:id`, wrap((req, res) => {
    deleteFeasScenario(db(), id(req.params.id), parseInput(feasScenarioCommand, queryFields(req)).expectedVersion);
    res.status(204).end();
  }));
  app.get(`${base}/reports`, wrap((req, res) => { res.json(listFeasReports(db(), parseInput(feasReportListQuery, queryFields(req)))); }));
  app.post(`${base}/scenarios/:id/reports`, wrap(async (req, res) => {
    res.status(201).json(await createFeasReport(db(), id(req.params.id), parseInput(feasReportCreate, req.body ?? {})));
  }));
  app.get(`${base}/reports/:id`, wrap((req, res) => { res.json(getFeasReport(db(), id(req.params.id))); }));
  app.post(`${base}/reports/:id/submit`, wrap((req, res) => {
    res.json(submitFeasReport(db(), id(req.params.id), parseInput(feasReportSubmit, req.body ?? {}).expectedVersion));
  }));
  app.post(`${base}/reports/:id/review`, wrap((req, res) => { res.json(reviewFeasReport(db(), id(req.params.id), parseInput(feasReportReview, req.body ?? {}))); }));
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

  const ic = '/api/investment/control';
  const tableUpload = memoryUpload(['.csv', '.xlsx']);
  app.get(`${ic}/template`, wrap(async (_req, res) => { sendAttachment(res, '投资科目导入模板.xlsx', XLSX, await icTemplateBuffer()); }));
  app.get(`${ic}/projects`, wrap((req, res) => { res.json(listIcProjects(db(), parseInput(icProjectListQuery, queryFields(req)))); }));
  app.post(`${ic}/projects`, wrap((req, res) => { res.status(201).json(createIcProject(db(), parseInput(icProjectCreate, req.body))); }));
  app.get(`${ic}/projects/:id`, wrap((req, res) => { res.json(getIcProject(db(), id(req.params.id))); }));
  app.patch(`${ic}/projects/:id`, wrap((req, res) => { res.json(updateIcProject(db(), id(req.params.id), parseInput(icProjectUpdate, req.body))); }));
  app.post(`${ic}/projects/:id/imports`, tableUpload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传投资科目表 .xlsx 或 .csv');
    const form = parseInput(icImportForm, formFields(req));
    res.status(201).json(await previewIcImport(db(), store(), id(req.params.id), req.file.buffer, uploadName(req.file.originalname), form));
  }));
  app.post(`${ic}/imports/:id/confirm`, wrap(async (req, res) => {
    res.json(await confirmIcImport(db(), store(), id(req.params.id), parseInput(icImportConfirm, req.body).sha256));
  }));
  app.get(`${ic}/versions/:id`, wrap((req, res) => { res.json(getIcVersion(db(), id(req.params.id))); }));
  app.post(`${ic}/versions/:id/mapping`, wrap((req, res) => { res.json(updateIcMapping(db(), id(req.params.id), parseInput(icMappingUpdate, req.body))); }));
  app.post(`${ic}/versions/:id/confirm`, wrap((req, res) => {
    res.json(confirmIcVersion(db(), id(req.params.id), parseInput(icVersionConfirm, req.body).expectedVersion));
  }));
  app.post(`${ic}/versions/:id/void`, wrap((req, res) => {
    const b = parseInput(icVersionVoid, req.body);
    res.json(voidIcVersion(db(), id(req.params.id), b.expectedVersion, b.reason));
  }));
  app.get(`${ic}/projects/:id/comparisons`, wrap((req, res) => { res.json(listIcComparisons(db(), id(req.params.id))); }));
  app.post(`${ic}/comparisons`, wrap((req, res) => { res.status(201).json(createIcComparison(db(), parseInput(icCompareRequest, req.body))); }));
  app.get(`${ic}/comparisons/:id`, wrap((req, res) => { res.json(getIcComparison(db(), id(req.params.id))); }));
  app.get(`${ic}/comparisons/:id/export`, wrap(async (req, res) => {
    const out = await exportIcComparison(db(), id(req.params.id));
    sendAttachment(res, out.fileName, XLSX, out.buffer);
  }));
}
