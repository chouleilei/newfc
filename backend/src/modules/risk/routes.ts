import type { Express } from 'express';
import multer from 'multer';
import type { DB } from '../../db/connection';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import type { ObjectStore } from '../files/object-store';
import { sendAttachment, uploadName } from '../files/http';
import { MAX_UPLOAD_BYTES } from '../io/import-limits';
import { id as idSchema } from '../../contracts/common';
import { riskActionForm, riskListQuery, riskRuleCreate, riskRuleUpdate, riskScanRequest } from '../../contracts/risk';
import { formFields, queryFields } from '../project-budget/routes';
import {
  actOnRisk, createRiskRule, explainRisk, getRiskEvent, getRiskScan, listRiskEvents, listRiskRules, listRiskScans, riskActionAttachment, riskChecklist, riskSummary,
  scanRisks, updateRiskRule,
} from './risk.service';

/* 处理动作的具体权限(risk:handle / risk:review)由 service 按动作校验;路由层只要求能看风险。 */
addRouteRules([
  { method: 'GET', pattern: /^\/risk(\/|$)/, permission: 'risk:read' },
  { method: 'WRITE', pattern: /^\/risk\/rules(\/[A-Z0-9_]+)?$/, permission: 'risk:review' },
  { method: 'WRITE', pattern: /^\/risk\/events\/\d+\/explain$/, permission: 'risk:handle' },
  { method: 'WRITE', pattern: /^\/risk\/events\/\d+\/actions$/, permission: 'risk:read' },
  { method: 'WRITE', pattern: /^\/risk\/scans$/, permission: 'risk:handle' },
]);

const id = (v: unknown) => parseInput(idSchema, v);

/** AC-F17 风险闭环。服务层按风险 org_id 裁剪范围,范围外 404。 */
export function registerRiskRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  const base = '/api/risk';
  app.get(`${base}/rules`, wrap((_req, res) => { res.json(listRiskRules(db())); }));
  app.post(`${base}/rules`, wrap((req, res) => { res.status(201).json(createRiskRule(db(), parseInput(riskRuleCreate, req.body ?? {}))); }));
  app.patch(`${base}/rules/:code`, wrap((req, res) => { res.json(updateRiskRule(db(), String(req.params.code), parseInput(riskRuleUpdate, req.body ?? {}))); }));
  app.get(`${base}/summary`, wrap((req, res) => {
    const q = queryFields(req);
    res.json(riskSummary(db(), q.orgId ? { orgId: id(q.orgId) } : {}));
  }));
  app.get(`${base}/scans`, wrap((_req, res) => { res.json(listRiskScans(db())); }));
  app.get(`${base}/scans/:id`, wrap((req, res) => { res.json(getRiskScan(db(), id(req.params.id))); }));
  app.post(`${base}/scans`, wrap((req, res) => { res.status(201).json(scanRisks(db(), parseInput(riskScanRequest, req.body ?? {}))); }));
  app.get(`${base}/events`, wrap((req, res) => { res.json(listRiskEvents(db(), parseInput(riskListQuery, queryFields(req)))); }));
  app.get(`${base}/events/:id`, wrap((req, res) => { res.json(getRiskEvent(db(), id(req.params.id))); }));
  app.post(`${base}/events/:id/actions`, upload.single('file'), wrap((req, res) => {
    const form = parseInput(riskActionForm, formFields(req));
    const file = req.file ? { buffer: req.file.buffer, name: uploadName(req.file.originalname), contentType: req.file.mimetype || undefined } : undefined;
    res.json(actOnRisk(db(), store(), id(req.params.id), form, file));
  }));
  app.post(`${base}/events/:id/explain`, wrap(async (req, res) => { res.status(201).json(await explainRisk(db(), id(req.params.id))); }));
  app.get(`${base}/events/:id/checklist`, wrap((req, res) => { res.json(riskChecklist(db(), id(req.params.id))); }));
  app.get(`${base}/events/:id/actions/:actionId/attachment`, wrap((req, res) => {
    const f = riskActionAttachment(db(), store(), id(req.params.id), id(req.params.actionId));
    sendAttachment(res, f.fileName, f.contentType, f.content);
  }));
}
