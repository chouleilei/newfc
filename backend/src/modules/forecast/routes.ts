import type { Express } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import type { ObjectStore } from '../files/object-store';
import { memoryUpload, uploadName } from '../files/http';
import { id as idSchema } from '../../contracts/common';
import {
  ffImportForm, ffModelCreate, ffModelListQuery, ffModelUpdate, ffPublicationListQuery, ffPublicationWithdraw, ffRunPublish, ffRunRequest, ffVersionCommand,
  ffReviewQueueQuery, ffVersionCreate, ffVersionReview, ffVersionUpdate,
} from '../../contracts/finance-forecast';
import { formFields, queryFields } from '../project-budget/routes';
import {
  compareForecastRun, copyForecastVersion, createForecastModel, createForecastVersion, freezeForecastVersion, getForecastModel, getForecastRun, getForecastSheet,
  getForecastVersion, importForecastVersion, listForecastFolders, listForecastModels, listForecastRuns, startForecastRun, updateForecastModel, updateForecastVersion,
} from './forecast.service';
import {
  forecastBaselineTimeline, generateForecastInsight, listForecastInsights, listForecastPublications, listForecastReviewQueue, publishForecastRun, reviewForecastVersion,
  withdrawForecastPublication,
} from './forecast-workflow.service';

addRouteRules([
  { method: 'WRITE', pattern: /^\/forecast\/(versions\/\d+\/review|publications\/\d+\/withdraw)$/, permission: 'forecast:review' },
  { method: 'GET', pattern: /^\/forecast(\/|$)/, permission: 'forecast:read' },
  { method: 'WRITE', pattern: /^\/forecast(\/|$)/, permission: 'forecast:write' },
]);

const id = (v: unknown) => parseInput(idSchema, v);

/** AC-F11 财务预测。服务层按模型 org_id 裁剪范围,范围外 404。 */
export function registerForecastRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  const upload = memoryUpload(['.xlsx']);
  const base = '/api/forecast';
  app.get(`${base}/review-queue`, wrap((req, res) => { res.json(listForecastReviewQueue(db(), parseInput(ffReviewQueueQuery, queryFields(req)))); }));
  app.get(`${base}/models`, wrap((req, res) => { res.json(listForecastModels(db(), parseInput(ffModelListQuery, queryFields(req)))); }));
  app.post(`${base}/models`, wrap((req, res) => { res.status(201).json(createForecastModel(db(), parseInput(ffModelCreate, req.body))); }));
  app.get(`${base}/models/:id`, wrap((req, res) => { res.json(getForecastModel(db(), id(req.params.id))); }));
  app.patch(`${base}/models/:id`, wrap((req, res) => { res.json(updateForecastModel(db(), id(req.params.id), parseInput(ffModelUpdate, req.body))); }));
  app.post(`${base}/models/:id/versions`, wrap((req, res) => {
    res.status(201).json(createForecastVersion(db(), id(req.params.id), parseInput(ffVersionCreate, req.body)));
  }));
  app.post(`${base}/models/:id/imports`, upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传预测工作簿 .xlsx');
    const form = parseInput(ffImportForm, formFields(req));
    res.status(201).json(await importForecastVersion(db(), store(), id(req.params.id), req.file.buffer, uploadName(req.file.originalname), form.note));
  }));
  app.get(`${base}/versions/:id`, wrap((req, res) => { res.json(getForecastVersion(db(), id(req.params.id))); }));
  app.get(`${base}/versions/:id/sheets/:name`, wrap((req, res) => { res.json(getForecastSheet(db(), id(req.params.id), String(req.params.name))); }));
  app.patch(`${base}/versions/:id`, wrap((req, res) => { res.json(updateForecastVersion(db(), id(req.params.id), parseInput(ffVersionUpdate, req.body))); }));
  app.post(`${base}/versions/:id/freeze`, wrap((req, res) => {
    res.json(freezeForecastVersion(db(), id(req.params.id), parseInput(ffVersionCommand, req.body).expectedVersion));
  }));
  app.post(`${base}/versions/:id/copy`, wrap((req, res) => { res.status(201).json(copyForecastVersion(db(), id(req.params.id))); }));
  app.get(`${base}/versions/:id/runs`, wrap((req, res) => { res.json(listForecastRuns(db(), id(req.params.id))); }));
  app.post(`${base}/versions/:id/runs`, wrap((req, res) => {
    const { run } = startForecastRun(db, id(req.params.id), parseInput(ffRunRequest, req.body));
    res.status(202).json(run);
  }));
  app.get(`${base}/runs/:id`, wrap((req, res) => { res.json(getForecastRun(db(), id(req.params.id))); }));
  app.get(`${base}/runs/:id/compare`, wrap((req, res) => { res.json(compareForecastRun(db(), id(req.params.id))); }));

  // T-7:目录、复核、发布、基准时间线、洞察
  app.get(`${base}/folders`, wrap((_req, res) => { res.json(listForecastFolders(db())); }));
  app.get(`${base}/models/:id/baselines`, wrap((req, res) => { res.json(forecastBaselineTimeline(db(), id(req.params.id))); }));
  app.post(`${base}/versions/:id/review`, wrap((req, res) => { res.json(reviewForecastVersion(db(), id(req.params.id), parseInput(ffVersionReview, req.body))); }));
  app.post(`${base}/runs/:id/publish`, wrap((req, res) => { res.status(201).json(publishForecastRun(db(), id(req.params.id), parseInput(ffRunPublish, req.body ?? {}))); }));
  app.get(`${base}/publications`, wrap((req, res) => { res.json(listForecastPublications(db(), parseInput(ffPublicationListQuery, queryFields(req)))); }));
  app.post(`${base}/publications/:id/withdraw`, wrap((req, res) => { res.json(withdrawForecastPublication(db(), id(req.params.id), parseInput(ffPublicationWithdraw, req.body).reason)); }));
  app.get(`${base}/runs/:id/insights`, wrap((req, res) => { res.json(listForecastInsights(db(), id(req.params.id))); }));
  app.post(`${base}/runs/:id/insights`, wrap(async (req, res) => { res.status(201).json(await generateForecastInsight(db(), id(req.params.id))); }));
}
