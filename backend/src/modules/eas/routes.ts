import type { Express, Request } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import type { ObjectStore } from '../files/object-store';
import { memoryUpload, sendAttachment, uploadName } from '../files/http';
import {
  easActivateRequest, easAuxRequirementCreate, easCorrectionCreate, easCorrectionReview, easImportForm, easLockRequest,
  easPrecheckRequest, easUnlockRequest, EAS_DATA_TYPES,
} from '../../contracts/eas';
import { id as idSchema, period as periodSchema } from '../../contracts/common';
import {
  activateSet, batchLines, batchOriginal, createCorrection, deactivateAuxRequirement, getBatch, getCorrection, getSet, importEasFile,
  listAuxRequirements, listBatches, listCorrections, listLocks, listSets, lockEvents, lockPeriod, periodStatus, precheck, precheckCorrection,
  reviewCorrection, unlockPeriod, upsertAuxRequirement,
} from './eas.service';

addRouteRules([
  { method: 'GET', pattern: /^\/eas\//, permission: 'eas:read' },
  { method: 'WRITE', pattern: /^\/eas\/(import|precheck)$/, permission: 'eas:import' },
  { method: 'WRITE', pattern: /^\/eas\/aux-requirements(\/\d+\/deactivate)?$/, permission: 'eas:import' },
  { method: 'WRITE', pattern: /^\/eas\/sets\/\d+\/activate$/, permission: 'eas:period_lock' },
  { method: 'WRITE', pattern: /^\/eas\/locks(\/\d+\/unlock)?$/, permission: 'eas:period_lock' },
  { method: 'WRITE', pattern: /^\/eas\/corrections(\/\d+\/precheck)?$/, permission: 'eas:correction_submit' },
  { method: 'WRITE', pattern: /^\/eas\/corrections\/\d+\/review$/, permission: 'eas:correction_review' },
]);

const CONTENT_TYPES: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function id(value: unknown): number { return parseInput(idSchema, value); }
function optId(value: unknown): number | undefined { return value === undefined || value === '' ? undefined : id(value); }
function optPeriod(value: unknown): string | undefined { return value === undefined || value === '' ? undefined : parseInput(periodSchema, value); }
function optEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!allowed.includes(value as T)) throw Errors.validation('查询参数不合法');
  return value as T;
}
/** multipart 表单字段:空字符串视为未填。 */
function formFields(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((req.body ?? {}) as Record<string, unknown>)) if (typeof v === 'string' && v !== '') out[k] = v;
  return out;
}

/** AC-F05 EAS 原始事实与期间控制。服务层按 AuthContext 裁剪组织范围,范围外对象 404。 */
export function registerEasRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  const upload = memoryUpload(['.csv', '.xlsx']);

  app.post('/api/eas/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传 EAS 导出文件(.csv 或 .xlsx)');
    const form = parseInput(easImportForm, formFields(req));
    const fileName = uploadName(req.file.originalname);
    const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    const batch = await importEasFile(db(), store(), { content: req.file.buffer, fileName, contentType: CONTENT_TYPES[ext], form });
    res.status(batch.replayed ? 200 : 201).json(batch);
  }));

  app.get('/api/eas/batches', wrap((req, res) => {
    res.json(listBatches(db(), {
      orgId: optId(req.query.orgId), period: optPeriod(req.query.period), dataType: optEnum(req.query.dataType, EAS_DATA_TYPES),
      status: optEnum(req.query.status, ['candidate', 'active', 'superseded'] as const),
    }));
  }));
  app.get('/api/eas/batches/:id', wrap((req, res) => { res.json(getBatch(db(), id(req.params.id))); }));
  app.get('/api/eas/batches/:id/lines', wrap((req, res) => {
    res.json(batchLines(db(), id(req.params.id), optId(req.query.page) ?? 1, optId(req.query.pageSize) ?? 100));
  }));
  app.get('/api/eas/batches/:id/original', wrap((req, res) => {
    const file = batchOriginal(db(), store(), id(req.params.id));
    sendAttachment(res, file.fileName, file.contentType, file.content);
  }));

  app.post('/api/eas/precheck', wrap((req, res) => { res.status(201).json(precheck(db(), parseInput(easPrecheckRequest, req.body))); }));
  app.get('/api/eas/sets', wrap((req, res) => { res.json(listSets(db(), { orgId: optId(req.query.orgId), period: optPeriod(req.query.period) })); }));
  app.get('/api/eas/sets/:id', wrap((req, res) => { res.json(getSet(db(), id(req.params.id))); }));
  app.post('/api/eas/sets/:id/activate', wrap((req, res) => {
    res.json(activateSet(db(), id(req.params.id), parseInput(easActivateRequest, req.body).expectedVersion));
  }));

  app.get('/api/eas/period-status', wrap((req, res) => {
    const period = optPeriod(req.query.period);
    if (!period) throw Errors.validation('请指定期间');
    res.json(periodStatus(db(), id(req.query.orgId), period));
  }));

  app.get('/api/eas/locks', wrap((_req, res) => { res.json(listLocks(db())); }));
  app.get('/api/eas/locks/:id/events', wrap((req, res) => { res.json(lockEvents(db(), id(req.params.id))); }));
  app.post('/api/eas/locks', wrap((req, res) => { res.status(201).json(lockPeriod(db(), parseInput(easLockRequest, req.body))); }));
  app.post('/api/eas/locks/:id/unlock', wrap((req, res) => { res.json(unlockPeriod(db(), id(req.params.id), parseInput(easUnlockRequest, req.body))); }));

  app.get('/api/eas/corrections', wrap((req, res) => { res.json(listCorrections(db(), { status: optEnum(req.query.status, ['pending'] as const) })); }));
  app.get('/api/eas/corrections/:id', wrap((req, res) => { res.json(getCorrection(db(), id(req.params.id))); }));
  app.post('/api/eas/corrections', wrap((req, res) => { res.status(201).json(createCorrection(db(), parseInput(easCorrectionCreate, req.body))); }));
  app.post('/api/eas/corrections/:id/precheck', wrap((req, res) => { res.status(201).json(precheckCorrection(db(), id(req.params.id))); }));
  app.post('/api/eas/corrections/:id/review', wrap((req, res) => {
    res.json(reviewCorrection(db(), id(req.params.id), parseInput(easCorrectionReview, req.body)));
  }));

  app.get('/api/eas/aux-requirements', wrap((req, res) => { res.json(listAuxRequirements(db(), optId(req.query.orgId))); }));
  app.post('/api/eas/aux-requirements', wrap((req, res) => { res.status(201).json(upsertAuxRequirement(db(), parseInput(easAuxRequirementCreate, req.body))); }));
  app.post('/api/eas/aux-requirements/:id/deactivate', wrap((req, res) => { res.json(deactivateAuxRequirement(db(), id(req.params.id))); }));
}
