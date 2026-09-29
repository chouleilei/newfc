import type { Express, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import type { DB } from '../../../db/connection';
import { AppError, Errors } from '../../../core/errors';
import { writeLog } from '../../audit/log';
import { CLEANING_AI_ENABLED, MAX_UPLOAD_BYTES } from '../import-limits';
import { modelConfigured } from '../../../assistant/model';
import { assistantNarrativeRateLimit } from '../../../assistant/rate-limit';
import { CleaningUploadStore } from './upload-store';
import { inspectWorkbook, loadCleaningWorkbook, parseRegionRequest, readRegion } from './workbook';
import { applyCleaningPlan } from './apply';
import { assertTargetMatchesPlan, parseCleaningPlan, parseCleaningTarget, type CleaningTargetKind } from './plan';
import { createPendingCleaningPreview, listPreviewRows, reopenCleaningPreview } from './preview';
import * as templates from './template.service';
import * as aliases from './alias.service';
import { suggestCleaningStructure } from './suggest';

type DbGetter = () => DB;
type Wrapped = (req: Request, res: Response, next: NextFunction) => void;
type Wrap = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => Wrapped;

function actor(req: Request): string { return (req as Request & { authUser?: string }).authUser ?? ''; }

/** Node multipart 生态常把 filename 的 UTF-8 字节按 latin1 解码；只在全部字符可逆时纠正。 */
function uploadName(value: string): string {
  if (!value || [...value].some((char) => char.charCodeAt(0) > 255)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? value : decoded;
}

function targetKind(value: unknown, required = true): CleaningTargetKind | undefined {
  if ((value === undefined || value === '') && !required) return undefined;
  if (value !== 'budget' && value !== 'actual-current') throw Errors.validation('targetKind 必须为 budget 或 actual-current');
  return value;
}

/** 别名端点额外接受 'finance'(财务映射语义别名,AI 功能增强计划阶段二.5);模板等清洗实体仍只限清洗目标。 */
function aliasTargetKind(value: unknown): 'budget' | 'actual-current' | 'finance' | undefined {
  if (value === undefined || value === '') return undefined;
  if (value !== 'budget' && value !== 'actual-current' && value !== 'finance') throw Errors.validation('targetKind 必须为 budget、actual-current 或 finance');
  return value;
}

function positiveInt(value: unknown, label: string, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw Errors.validation(`${label} 必须为正整数`);
  return parsed;
}

/* 分页参数上界:page/pageSize 仅校验正整数时,page=1e9 会构造巨大 OFFSET 触发全表扫描;
   单批预览行有上限(2 万),给分页加合理上界即可。 */
function boundedPageInt(value: unknown, label: string, fallback: number, max: number): number {
  const parsed = positiveInt(value, label, fallback);
  if (parsed > max) throw Errors.validation(`${label} 不能超过 ${max}`);
  return parsed;
}

function publicTemplate(row: templates.ImportMappingTemplateRow) {
  return { id: row.id, name: row.name, targetKind: row.target_kind, config: JSON.parse(row.config_json), createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}

function publicAlias(row: aliases.ImportNameAliasRow) {
  return { id: row.id, targetKind: row.target_kind, mappingKind: row.mapping_kind, sourceText: row.source_text, targetCode: row.target_code, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function registerCleaningRoutes(
  app: Express,
  db: DbGetter,
  wrap: Wrap,
  options: { uploadDirectory: string },
): CleaningUploadStore {
  const store = new CleaningUploadStore(options.uploadDirectory);
  store.initialize();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, callback) => file.originalname.toLocaleLowerCase('en-US').endsWith('.xlsx')
      ? callback(null, true)
      : callback(new AppError('VALIDATION_FAILED', '仅支持 .xlsx 文件', 400)),
  });

  app.post('/api/io/cleaning/workbook', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传 .xlsx 文件');
    targetKind(req.body?.targetKind);
    try {
      const workbook = await loadCleaningWorkbook(req.file.buffer);
      const inspection = inspectWorkbook(workbook);
      const metadata = store.put(uploadName(req.file.originalname), req.file.buffer);
      res.status(201).json({
        token: metadata.token,
        originalName: metadata.originalName,
        sha256: metadata.sha256,
        size: metadata.size,
        ...inspection,
        aiAvailable: CLEANING_AI_ENABLED && modelConfigured(),
        aiSuggestion: null,
      });
    } finally {
      req.file.buffer = null as unknown as Buffer;
    }
  }));

  app.get('/api/io/cleaning/workbook/:token/region', wrap(async (req, res) => {
    const uploadFile = store.get(req.params.token, true);
    const workbook = await loadCleaningWorkbook(uploadFile.buffer);
    const request = parseRegionRequest(req.query as Record<string, unknown>);
    res.json(readRegion(workbook, request));
  }));

  // 结构建议是模型入口:挂独立叙述桶,不与聊天共用配额(AI 功能增强计划 §二.5)
  app.post('/api/io/cleaning/suggest', assistantNarrativeRateLimit, wrap(async (req, res) => {
    const uploadFile = store.get(String(req.body?.token ?? ''), true);
    const kind = targetKind(req.body?.targetKind)!;
    const inspection = inspectWorkbook(await loadCleaningWorkbook(uploadFile.buffer));
    res.json(await suggestCleaningStructure(inspection, kind));
  }));

  app.post('/api/io/cleaning/analyze', wrap(async (req, res) => {
    const uploadFile = store.get(String(req.body?.token ?? ''), true);
    const target = parseCleaningTarget(req.body?.target);
    const plan = parseCleaningPlan(req.body?.plan);
    assertTargetMatchesPlan(target, plan);
    const workbook = await loadCleaningWorkbook(uploadFile.buffer);
    const result = applyCleaningPlan(db(), workbook, target, plan);
    writeLog(db(), 'cleaning.analyze', 'cleaning_upload', uploadFile.metadata.sha256, {
      actor: actor(req),
      targetKind: target.targetKind,
      selectedRows: result.counts.selected,
      effectiveRows: result.counts.effective,
      errorCount: result.counts.errors,
      unresolvedCount: result.counts.unresolved,
    });
    res.json(result);
  }));

  app.post('/api/io/cleaning/preview', wrap(async (req, res) => {
    // get() 在任何业务校验前刷新滑动 TTL；后续 422/409 也不会让用户的临时文件意外过期。
    const token = String(req.body?.token ?? '');
    const uploadFile = store.get(token, true);
    const target = parseCleaningTarget(req.body?.target);
    const plan = parseCleaningPlan(req.body?.plan);
    assertTargetMatchesPlan(target, plan);
    const workbook = await loadCleaningWorkbook(uploadFile.buffer);
    const analysis = applyCleaningPlan(db(), workbook, target, plan);
    const result = createPendingCleaningPreview(db(), {
      analysis,
      originalName: uploadFile.metadata.originalName,
      file: uploadFile.buffer,
      actor: actor(req),
    });
    try { store.remove(token); } catch { /* 批次已完整保存，临时副本留待机会式清理 */ }
    res.status(201).json(result);
  }));

  app.get('/api/io/cleaning/previews/:batchId/rows', wrap((req, res) => {
    const action = typeof req.query.action === 'string' && req.query.action ? req.query.action : undefined;
    const warningOnly = req.query.warningOnly === 'true' || req.query.warningOnly === '1';
    res.json(listPreviewRows(db(), Number(req.params.batchId), {
      page: boundedPageInt(req.query.page, 'page', 1, 10_000),
      pageSize: boundedPageInt(req.query.pageSize, 'pageSize', 100, 200),
      action,
      warningOnly,
    }));
  }));

  // UX-16「修改导入配置」恢复服务(方案 §5.3):静态后缀子路由,不与 :batchId/rows 冲突;
  // 新 token 仅在响应体返回。重复请求幂等返回同一会话(200),首次恢复为 201。
  app.post('/api/io/cleaning/previews/:batchId/reopen', wrap((req, res) => {
    const batchId = Number(req.params.batchId);
    if (!Number.isSafeInteger(batchId) || batchId <= 0) throw Errors.validation('批次 ID 必须是正整数');
    const result = reopenCleaningPreview(db(), batchId, { store, actor: actor(req) });
    res.status(result.reused ? 200 : 201).json(result);
  }));

  app.get('/api/io/cleaning/templates', wrap((req, res) => {
    const kind = targetKind(req.query.targetKind, false);
    res.json({ items: templates.listTemplates(db(), kind).map(publicTemplate) });
  }));
  app.post('/api/io/cleaning/templates', wrap((req, res) => res.status(201).json(publicTemplate(templates.createTemplate(db(), req.body ?? {}, actor(req))))));
  app.patch('/api/io/cleaning/templates/:id', wrap((req, res) => res.json(publicTemplate(templates.updateTemplate(db(), Number(req.params.id), req.body ?? {}, actor(req))))));
  app.delete('/api/io/cleaning/templates/:id', wrap((req, res) => { templates.deleteTemplate(db(), Number(req.params.id), actor(req)); res.status(204).end(); }));

  app.get('/api/io/cleaning/aliases', wrap((req, res) => {
    const kind = aliasTargetKind(req.query.targetKind);
    const mappingKind = req.query.mappingKind === undefined ? undefined : req.query.mappingKind;
    if (mappingKind !== undefined && mappingKind !== 'org' && mappingKind !== 'account') throw Errors.validation('mappingKind 必须为 org 或 account');
    res.json({ items: aliases.listAliases(db(), { targetKind: kind, mappingKind }).map(publicAlias) });
  }));
  app.post('/api/io/cleaning/aliases', wrap((req, res) => res.status(201).json(publicAlias(aliases.createAlias(db(), req.body ?? {}, actor(req))))));
  app.patch('/api/io/cleaning/aliases/:id', wrap((req, res) => res.json(publicAlias(aliases.updateAlias(db(), Number(req.params.id), req.body ?? {}, actor(req))))));
  app.delete('/api/io/cleaning/aliases/:id', wrap((req, res) => { aliases.deleteAlias(db(), Number(req.params.id), actor(req)); res.status(204).end(); }));

  return store;
}
