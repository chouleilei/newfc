import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import net from 'net';
import os from 'os';
import { openDatabase, type DB } from './db/connection';
import { applyMigrations, appliedMigrations, pendingMigrations, dbInitialized, MIGRATIONS } from './db/migrations';
import { AppError, Errors, errorBody } from './core/errors';
import { safeIntegerAdd } from './core/money';
import { isValidDate, yearOfDate } from './core/dates';
import * as org from './modules/org/org.service';
import * as account from './modules/account/account.service';
import * as metric from './modules/metric/metric.service';
import * as budget from './modules/budget/budget.service';
import * as actual from './modules/actual/actual.service';
import * as report from './modules/report/report.service';
import * as structure from './modules/report/structure.service';
import { multiYearTrend, MAX_TREND_YEARS } from './modules/report/multi-year';
import { dashboardOverview } from './modules/report/dashboard.service';
import * as io from './modules/io/excel';
import * as exportSvc from './modules/io/export.service';
import { runConsistencyChecks } from './modules/check/consistency';
import * as backup from './modules/backup/backup.service';
import { writeLog, queryLogs } from './modules/audit/log';
import { listSnapshots, getSnapshot } from './modules/tree/snapshot';
import * as sheet from './modules/sheet/sheet.service';
import * as calculation from './modules/calculation/calculation.service';
import * as importBatch from './modules/import/import.service';
import { buildStandardActualPreview, buildStandardBudgetPreview } from './modules/import/preview-detail';
import { budgetQualityReport } from './modules/check/budget-quality';
import { budgetProgressReport } from './modules/budget/progress.service';
import {
  masterDataHealthReport, orgStructureIssues, accountStructureIssues, structureCheckPayload,
} from './modules/check/master-data-health';
import * as evidence from './modules/evidence/evidence.service';
import {
  makeWrap, registerRequestContext, registerAuthRoutes, registerSessionAuth, registerRouteGuard, registerSecurityRoutes, requestContextOf,
} from './modules/security/http';
import { ensureBuiltinRoles } from './modules/security/security.service';
import { currentAuth, runWithContext, systemContext } from './core/request-context';
import * as financeProfiles from './modules/finance-import/source-profile.service';
import * as financeMappings from './modules/finance-import/mapping/mapping.service';
import { validateMappingVersion } from './modules/finance-import/mapping/mapping-validator';
import { suggestMappingCandidates, unmappedSources } from './modules/finance-import/mapping/candidates';
import { assistantNarrativeRateLimit } from './assistant/rate-limit';
import { anomalyReport } from './assistant/anomaly';
import { scheduleCheckpointSummary, checkpointSummaryStatus, requeueCheckpointSummary, recoverNarrativeTasks } from './assistant/checkpoint-summary';
import * as financeConversions from './modules/finance-import/conversion/conversion-batch.service';
import * as financeParallel from './modules/finance-import/conversion/parallel-trial.service';
import { registerAssistantRoutes } from './assistant/controller';
import * as aiChannels from './modules/settings/ai-channels.service';
import { setChannelResolver, setModelCallRecorder } from './assistant/model';
import { purgeExpiredJobs, recoverInterruptedJobs } from './modules/jobs/job.service';
import { getSetting, listBusinessSettings, saveBusinessSettings } from './modules/settings/business-settings';
import { registerMasterRoutes } from './modules/master/routes';
import { registerEasRoutes } from './modules/eas/routes';
import { registerGovernanceRoutes } from './modules/governance/routes';
import { registerStatementRoutes } from './modules/statements/routes';
import { registerMgmtRoutes } from './modules/mgmt/routes';
import { ObjectStore } from './modules/files/object-store';
import { currentCellOrgId, currentOrgScopeId, orgInScope, resolveOrgScope } from './modules/security/scope';
import { insertModelCall } from './modules/jobs/model-calls';
import { registerJobRoutes } from './modules/jobs/routes';
import { registerCleaningRoutes } from './modules/io/cleaning/routes';
import { MAX_UPLOAD_BYTES } from './modules/io/import-limits';
import { assertNoFinanceOwnedConflicts } from './modules/finance-import/owned-scope';

/** 数据库句柄:恢复备份后可整体替换连接 */
class DbHolder implements backup.RestoreHandle {
  private db: DB;
  constructor(public readonly dbPath: string) {
    this.db = openDatabase(dbPath);
  }
  getDb(): DB { return this.db; }
  reopenWith(db: DB): void { this.db = db; }
}

export interface ServerOptions {
  dbPath: string;
  port?: number;
  host?: string;
  backupCronHours?: number;
  /** 可信反向代理跳数；直连部署必须保持 false（默认）。 */
  trustProxy?: false | number;
  /**
   * 已初始化的库存在待执行迁移时是否在启动时自动应用(先自动备份)。
   * 测试/开发默认 true；生产入口 index.ts 传 false，要求部署步骤显式执行 `npm run migrate:dist`。
   * 全新空库始终直接建表(无业务数据可丢失)。
   */
  autoMigrate?: boolean;
}

export async function createApp(opts: ServerOptions) {
  const holder = new DbHolder(opts.dbPath);
  const db = () => holder.getDb();
  // 迁移前自动备份(AGENTS.md 规则):启动即可能应用破坏性迁移,必须先留恢复点;
  // 手动迁移路由 /api/migrations/apply 同样先备份,这里保证无人值守升级也有备份。
  // 全新库(尚无 schema_migration)无任何业务数据可备份,直接建表——否则备份收尾
  // 写审计日志会因 operation_log 尚未创建而崩溃,导致新部署无法首次启动
  const pending = pendingMigrations(db());
  if (pending.length > 0 && dbInitialized(db())) {
    if (opts.autoMigrate === false) {
      throw new Error(`数据库存在 ${pending.length} 个待执行迁移(V${pending.map((m) => m.version).join(', V')})；`
        + '请先执行显式迁移步骤 `npm run migrate:dist`(会先备份)再启动服务');
    }
    await backup.createBackup(db(), backup.backupDirOf(opts.dbPath), 'pre-migrate-auto');
  }
  applyMigrations(db());
  ensureBuiltinRoles(db());
  // 持久任务恢复(AC-F21):上个进程未完成的任务标为 interrupted,不静默丢失
  try {
    const interrupted = recoverInterruptedJobs(db());
    if (interrupted > 0) console.warn(`[startup] ${interrupted} 个未完成任务已标记为 interrupted`);
    purgeExpiredJobs(db(), getSetting<number>(db(), 'jobs.retention_days'));
  } catch (error) {
    console.error('[startup] 恢复中断任务失败', error);
  }
  // 财务转换中断恢复:上次进程在解析中途退出会留下永远不会推进的 parsing 批次,
  // 启动时按失败关闭(blocked + CONVERSION_INTERRUPTED 报告),原件保留、可重新转换。
  // 恢复失败不阻止服务启动。
  try {
    financeConversions.recoverInterruptedConversions(db());
  } catch (error) {
    console.error('[startup] 恢复中断的财务转换批次失败', error);
  }
  // pending 导入批次的原始文件 blob 过期清理(默认 7 天):
  // 预览后不确认也不取消,file_blob 会永久滞留库内。清理失败不阻止启动。
  try {
    const swept = importBatch.sweepExpiredPendingBatches(db());
    if (swept > 0) console.log(`[startup] 清理过期 pending 导入批次 ${swept} 个`);
  } catch (error) {
    console.error('[startup] 清理过期导入批次失败', error);
  }
  // 异步叙述任务恢复(AI 功能增强计划 §三.4):上次进程留下的 pending 与
  // 崩溃遗留的 stale running 在这里回收重排;恢复失败不影响服务启动。
  recoverNarrativeTasks(db());

  const app = express();
  registerRequestContext(app);
  // 登录接口单独使用极小请求体,防止未认证请求借审计日志撑爆数据库
  app.use('/api/auth', express.json({ limit: '16kb' }));
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  // 直连默认不信任任何转发头，避免客户端伪造 X-Forwarded-For 绕开按 IP 限流。
  // 单层 nginx 反代部署应显式设 1；其他部署必须按真实代理层数配置。
  app.set('trust proxy', opts.trustProxy ?? false);

  // 先进入 promise 链再调用 fn(同步校验异常也交给统一错误处理),并重新进入请求上下文。
  const wrap = makeWrap();

  const queryString = (value: unknown, name: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string') throw Errors.validation(`${name} 必须是单个字符串`);
    return value;
  };

  const positiveQueryInt = (value: unknown, name: string, fallback: number): number => {
    if (value === undefined) return fallback;
    const text = queryString(value, name)!;
    if (!/^\d+$/.test(text)) throw Errors.validation(`${name} 必须为正整数`);
    const parsed = Number(text);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw Errors.validation(`${name} 必须为正整数`);
    return parsed;
  };

  const optionalPositiveQueryInt = (value: unknown, name: string): number | undefined => (
    value === undefined ? undefined : positiveQueryInt(value, name, 1)
  );

  /** 分析类路由共用的可空正整数查询参数解析(batchId/orgScopeId 等)。 */
  const analysisOptionalInt = (value: unknown, label: string): number | null => {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw Errors.validation(`${label} 必须是正整数`);
    return parsed;
  };

  /** 路径参数的正整数校验:Number('abc') 是 NaN,直接下传会变成静默 404/500。 */
  const positiveParam = (value: unknown, name: string): number => {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) throw Errors.validation(`${name} 必须为正整数`);
    return parsed;
  };

  const optionalYearQuery = (value: unknown, name = 'year'): number | undefined => {
    if (value === undefined) return undefined;
    const text = queryString(value, name)!;
    if (!/^\d{4}$/.test(text)) throw Errors.validation(`${name} 必须是 1900-9999 的整数`);
    const year = Number(text);
    if (year < 1900 || year > 9999) throw Errors.validation(`${name} 必须是 1900-9999 的整数`);
    return year;
  };

  /** 整表替换端点的请求体边界:只接受数组或 {items:[...]};其他形态在进入删除/插入事务前以 400 拒绝。 */
  const bodyArray = (value: unknown, name: string): Record<string, unknown>[] => {
    const items = Array.isArray(value)
      ? value
      : value !== null && typeof value === 'object'
        ? (value as { items?: unknown }).items
        : undefined;
    if (!Array.isArray(items)) throw Errors.validation(`${name} 必须是数组(或 { items: [...] })`);
    if (items.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
      throw Errors.validation(`${name} 的每一项必须是对象`);
    }
    return items as Record<string, unknown>[];
  };

  registerAuthRoutes(app, { db, wrap });

  /* ============ 存活/就绪检查(公开，不含业务数据) ============ */
  // 存活:进程可响应即可。就绪:本实例数据库可查询、schema 为最新、数据目录可写。
  // 模型是否配置不影响就绪(确定性业务不依赖模型)。
  app.get('/api/health/live', (_req, res) => {
    res.json({ ok: true, status: 'live', uptimeSeconds: Math.round(process.uptime()) });
  });
  app.get('/api/health/ready', (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    try {
      const row = db().prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration').get() as { version: number };
      const latest = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
      checks.database = { ok: true };
      checks.schema = row.version === latest
        ? { ok: true, detail: `V${row.version}` }
        : { ok: false, detail: `当前 V${row.version}，期望 V${latest}` };
    } catch {
      checks.database = { ok: false, detail: '数据库不可查询' };
      checks.schema = { ok: false, detail: '无法读取 schema 版本' };
    }
    if (opts.dbPath === ':memory:') {
      checks.storage = { ok: true, detail: 'memory' };
    } else {
      try {
        fs.accessSync(path.dirname(opts.dbPath), fs.constants.W_OK);
        checks.storage = { ok: true };
      } catch {
        checks.storage = { ok: false, detail: '数据目录不可写' };
      }
    }
    if (restoreInFlight) checks.restore = { ok: false, detail: '备份恢复进行中' };
    const ok = Object.values(checks).every((c) => c.ok);
    res.status(ok ? 200 : 503).json({ ok, status: ok ? 'ready' : 'not_ready', checks });
  });

  registerSessionAuth(app, db);
  // 认证通过后才解析普通 API 的大请求体，避免匿名请求占用 JSON 解析 CPU/内存。
  app.use(express.json({ limit: '20mb' }));
  // 路由权限表(默认拒绝)与组织参数可见性核验
  registerRouteGuard(app, db);
  registerSecurityRoutes(app, db, wrap);
  registerJobRoutes(app, db, wrap);
  registerMasterRoutes(app, db, wrap);
  // T-3 新领域:原件存放在数据库同目录的 objects/(内存库用临时目录)
  const objectStore = ObjectStore.forDbPath(opts.dbPath);
  registerEasRoutes(app, db, wrap, () => objectStore);
  registerGovernanceRoutes(app, db, wrap);
  registerStatementRoutes(app, db, wrap, () => objectStore);
  registerMgmtRoutes(app, db, wrap);
  app.get('/api/settings/business', wrap((_req, res) => res.json({ items: listBusinessSettings(db()) })));
  app.put('/api/settings/business', wrap((req, res) => res.json({ items: saveBusinessSettings(db(), req.body) })));

  /* ============ 恢复期间的请求门闸 ============ */
  // 恢复会关闭并替换数据库连接:中途到达的业务请求会拿到已关闭的连接,大面积 500。
  // 恢复进行中时,除会话/恢复本身/健康检查外的 API 一律返回 503,让前端明确提示
  // 「维护中」而不是把正常操作误报成失败。
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    if (!restoreInFlight) return next();
    const pathWhitelist = req.path === '/health'
      || req.path.startsWith('/auth/')
      /* 只放行恢复本体与只读列表;备份创建/删除等写操作在连接被换掉后仍
         会拿到旧句柄,恢复中途触发会大面积 500 或写出错位的备份文件 */
      || req.path === '/backup/list'
      || req.path === '/backup/restore';
    if (pathWhitelist) return next();
    res.status(503).json({ code: 'RESTORING', message: '备份恢复进行中,请稍后再试' });
  });
  registerAssistantRoutes(app, db, wrap);

  // 模型调用观测(AC-F21):只记规模/耗时/结果,不记正文;写入失败不影响调用
  setModelCallRecorder((record) => {
    try { insertModelCall(db(), record); } catch (error) { console.error('[model-call] 记录失败', error); }
  });

  // LLM 渠道管理(§7.3):把库内渠道解析注入模型适配层;功能调用按 binding 选渠道。
  setChannelResolver((feature) => {
    if (!feature) return { primary: aiChannels.anyChannel(db()), fallback: null, anyEnabled: aiChannels.anyEnabledChannel(db()) };
    const primary = aiChannels.primaryChannelForFeature(db(), feature)
      // binding 缺失时回退任一 enabled 渠道(与升级前 env 全局共享行为一致)。
      ?? aiChannels.anyChannel(db());
    return {
      primary,
      fallback: primary ? aiChannels.fallbackChannelForFeature(db(), feature, primary.id) : null,
      anyEnabled: aiChannels.anyEnabledChannel(db()),
    };
  });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, cb) => {
      if (file.originalname.toLowerCase().endsWith('.xlsx')) cb(null, true);
      else cb(new AppError('VALIDATION_FAILED', '仅支持 .xlsx 文件', 400));
    },
  });
  const financeMappingUpload = multer({
    storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, cb) => /\.(xlsx|csv)$/i.test(file.originalname) ? cb(null, true) : cb(new AppError('VALIDATION_FAILED', '映射文件仅支持 .xlsx 或 .csv', 400)),
  });

  const cleaningUploadDirectory = opts.dbPath === ':memory:'
    ? path.join(os.tmpdir(), 'newfc-cleaning-uploads-memory')
    : path.join(path.dirname(opts.dbPath), 'cleaning-uploads');
  const cleaningUploads = registerCleaningRoutes(app, db, wrap, { uploadDirectory: cleaningUploadDirectory });

  app.get('/api/health', wrap((_req, res) => {
    const row = db().prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migration').get() as { version: number };
    res.json({ ok: true, database: 'ready', schemaVersion: row.version });
  }));

  /* ============ 财务实际数确定性转换 ============ */
  app.get('/api/finance/source-profiles', wrap((_req, res) => res.json({ items: financeProfiles.listSourceProfiles(db()) })));
  app.post('/api/finance/source-profiles', wrap((req, res) => res.status(201).json(financeProfiles.createSourceProfile(db(), req.body ?? {}, (req as Request & {authUser?:string}).authUser ?? ''))));
  app.patch('/api/finance/source-profiles/:id', wrap((req, res) => res.json(financeProfiles.updateSourceProfile(db(), Number(req.params.id), req.body ?? {}, (req as Request & {authUser?:string}).authUser ?? ''))));

  app.get('/api/finance/mapping-versions', wrap((req, res) => res.json({ items: financeMappings.listMappingVersions(db(), optionalPositiveQueryInt(req.query.sourceProfileId, 'sourceProfileId')) })));
  app.post('/api/finance/mapping-versions', wrap((req, res) => res.status(201).json(financeMappings.createMappingVersion(db(), { ...req.body, createdBy: (req as Request & {authUser?:string}).authUser ?? '' }))));
  app.post('/api/finance/mapping-versions/:id/clone', wrap((req, res) => res.status(201).json(financeMappings.cloneMappingVersion(db(), Number(req.params.id), (req as Request & {authUser?:string}).authUser ?? ''))));
  app.post('/api/finance/mapping-versions/:id/validate', wrap((req, res) => res.json(validateMappingVersion(db(), Number(req.params.id)))));
  app.post('/api/finance/mapping-versions/:id/lock', wrap((req, res) => res.json(financeMappings.lockMappingVersion(db(), Number(req.params.id), (req as Request & {authUser?:string}).authUser ?? '', { confirmUnreviewed: req.body?.confirmUnreviewed === true }))));
  // 映射候选建议(计划阶段二):确定性 top-N 为主,allowAi 时模型只兜低置信残差;叙述桶限流
  app.post('/api/finance/mapping-versions/:id/mapping-candidates', assistantNarrativeRateLimit, wrap(async (req, res) => {
    const versionId = Number(req.params.id);
    if (!Number.isSafeInteger(versionId) || versionId <= 0) throw Errors.validation('映射版本 ID 必须是正整数');
    const kind = req.body?.kind;
    if (kind !== 'org' && kind !== 'account') throw Errors.validation('kind 必须为 org 或 account');
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length === 0) throw Errors.validation('items 不能为空');
    if (items.length > 100) throw Errors.validation('items 最多 100 条');
    const allowAi = req.body?.allowAi === true;
    const results = [] as Awaited<ReturnType<typeof suggestMappingCandidates>>[];
    for (const [index, raw] of items.entries()) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Errors.validation(`items 第 ${index + 1} 条必须是对象`);
      const item = raw as Record<string, unknown>;
      for (const field of ['sourceCode', 'sourceName', 'sourceBookCode'] as const) {
        if (item[field] !== undefined && typeof item[field] !== 'string') throw Errors.validation(`items 第 ${index + 1} 条 ${field} 必须是字符串`);
        if (typeof item[field] === 'string' && (item[field] as string).length > 500) throw Errors.validation(`items 第 ${index + 1} 条 ${field} 过长`);
      }
      results.push(await suggestMappingCandidates(db(), versionId, {
        kind,
        ...(typeof item.sourceCode === 'string' ? { sourceCode: item.sourceCode } : {}),
        ...(typeof item.sourceName === 'string' ? { sourceName: item.sourceName } : {}),
        ...(typeof item.sourceBookCode === 'string' ? { sourceBookCode: item.sourceBookCode } : {}),
      }, { allowAi }));
    }
    res.json({ items: results });
  }));
  app.post('/api/finance/mapping-versions/:id/retire', wrap((req, res) => res.json(financeMappings.retireMappingVersion(db(), Number(req.params.id), (req as Request & {authUser?:string}).authUser ?? ''))));
  // 未映射源清单(计划阶段二:批量采纳工作流的入口)。判定复用运行时匹配器,只读、零模型调用。
  app.get('/api/finance/mapping-versions/:id/unmapped-sources', wrap((req, res) => {
    const conversionId = optionalPositiveQueryInt(req.query.conversionId, 'conversionId');
    if (conversionId === undefined) throw Errors.validation('conversionId 必须提供:未映射清单按某个财务转换批次的源明细计算');
    res.json(unmappedSources(db(), positiveParam(req.params.id, '映射版本 ID'), conversionId));
  }));
  app.get('/api/finance/mapping-versions/:id/org-mappings', wrap((req, res) => res.json({ items: financeMappings.listOrgMappings(db(), Number(req.params.id)) })));
  app.put('/api/finance/mapping-versions/:id/org-mappings', wrap((req, res) => res.json({ items: financeMappings.replaceOrgMappings(db(), positiveParam(req.params.id, '映射版本 ID'), bodyArray(req.body, '组织映射'), (req as Request & {authUser?:string}).authUser ?? '') })));
  app.get('/api/finance/mapping-versions/:id/account-mappings', wrap((req, res) => res.json({ items: financeMappings.listAccountMappings(db(), Number(req.params.id)) })));
  app.put('/api/finance/mapping-versions/:id/account-mappings', wrap((req, res) => res.json({ items: financeMappings.replaceAccountMappings(db(), positiveParam(req.params.id, '映射版本 ID'), bodyArray(req.body, '科目映射'), (req as Request & {authUser?:string}).authUser ?? '') })));
  app.get('/api/finance/mapping-versions/:id/reconciliation-rules', wrap((req, res) => res.json({ items: financeMappings.listReconciliationRules(db(), Number(req.params.id)) })));
  app.put('/api/finance/mapping-versions/:id/reconciliation-rules', wrap((req, res) => res.json({ items: financeMappings.replaceReconciliationRules(db(), positiveParam(req.params.id, '映射版本 ID'), bodyArray(req.body, '勾稽规则'), (req as Request & {authUser?:string}).authUser ?? '') })));
  app.post('/api/finance/mapping-versions/:id/import', financeMappingUpload.single('file'), wrap(async (req, res) => { if (!req.file) throw Errors.validation('请上传映射 .xlsx 或 .csv');const id=Number(req.params.id),actor=(req as Request&{authUser?:string}).authUser??'';if(req.file.originalname.toLowerCase().endsWith('.csv')){const sheet=String(req.query.sheet??'');if(!['org','account','reconciliation'].includes(sheet))throw Errors.validation('CSV 导入必须指定 sheet=org/account/reconciliation');const result=financeMappings.importMappingsCsv(db(),id,sheet as 'org'|'account'|'reconciliation',req.file.buffer);writeLog(db(),'finance.mapping.import','finance_mapping_version',id,{actor,format:'csv',sheet,fileName:req.file.originalname});return res.json(result);}const result=await financeMappings.importMappings(db(),id,req.file.buffer);writeLog(db(),'finance.mapping.import','finance_mapping_version',id,{actor,format:'xlsx',fileName:req.file.originalname,...result});res.json(result); }));
  app.get('/api/finance/mapping-versions/:id/export', wrap(async (req, res) => {if(req.query.format==='csv'){const sheet=String(req.query.sheet??'');if(!['org','account','reconciliation'].includes(sheet))throw Errors.validation('CSV 导出必须指定 sheet=org/account/reconciliation');const buf=financeMappings.exportMappingsCsv(db(),Number(req.params.id),sheet as 'org'|'account'|'reconciliation');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition',`attachment; filename="finance-mappings-${sheet}.csv"`);return res.send(buf);}const buf=await financeMappings.exportMappings(db(),Number(req.params.id));res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="finance-mappings.xlsx"');res.send(buf); }));

  app.post('/api/finance/conversions/preview', upload.fields([{name:'balance',maxCount:1},{name:'profit',maxCount:1},{name:'journal',maxCount:1}]), wrap(async (req, res) => {
    const files=req.files as Record<string,Express.Multer.File[]>|undefined;const balance=files?.balance?.[0],profit=files?.profit?.[0],journal=files?.journal?.[0];if(!balance||!profit)throw Errors.validation('请同时上传余额表和利润表 .xlsx');
    const row=await financeConversions.createConversion(db(),{sourceProfileId:Number(req.body.sourceProfileId),mappingVersionId:Number(req.body.mappingVersionId),year:Number(req.body.year),snapshotDate:String(req.body.snapshotDate??''),balanceName:balance.originalname,balance:balance.buffer,profitName:profit.originalname,profit:profit.buffer,journalName:journal?.originalname,journal:journal?.buffer,revisionOfId:req.body.revisionOfId?Number(req.body.revisionOfId):undefined,actor:(req as Request&{authUser?:string}).authUser??''});res.status(201).json(financeConversions.publicConversion(row));
  }));
  // UX-18 修订目标只读查询:静态子路径必须注册在 '/api/finance/conversions/:id' 之前,否则被当作批次编号
  app.get('/api/finance/conversions/revision-target', wrap((req, res) => {
    const sourceProfileId = optionalPositiveQueryInt(req.query.sourceProfileId, 'sourceProfileId');
    if (sourceProfileId === undefined) throw Errors.validation('缺少 sourceProfileId');
    const year = optionalYearQuery(req.query.year);
    if (year === undefined) throw Errors.validation('缺少 year');
    const cutoff = queryString(req.query.cutoff, 'cutoff');
    if (!cutoff || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw Errors.validation('cutoff 格式必须为 YYYY-MM-DD');
    res.json(financeConversions.findRevisionTarget(db(), sourceProfileId, year, cutoff));
  }));
  app.get('/api/finance/conversions', wrap((req, res) => res.json({items:financeConversions.listConversions(db(),positiveQueryInt(req.query.limit, 'limit', 100))})));
  app.get('/api/finance/conversions/:id', wrap((req, res) => res.json(financeConversions.publicConversion(financeConversions.getConversion(db(),Number(req.params.id))))));
  app.get('/api/finance/conversions/:id/validation-report', wrap((req, res) => {const row=financeConversions.getConversion(db(),Number(req.params.id));res.json({validation:financeConversions.parseValidation(row)});}));
  app.get('/api/finance/conversions/:id/output', wrap((req, res) => {const row=financeConversions.getConversion(db(),Number(req.params.id));if(!row.output_blob)throw Errors.conflict('该批次没有通过校验的标准文件');res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="finance-actual-${row.year}-${row.snapshot_date}.xlsx"`);res.send(row.output_blob);}));
  app.get('/api/finance/conversions/:id/balance-source', wrap((req, res) => {const row=financeConversions.getConversion(db(),Number(req.params.id));res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(row.balance_name)}"`);res.send(row.balance_blob);}));
  app.get('/api/finance/conversions/:id/profit-source', wrap((req, res) => {const row=financeConversions.getConversion(db(),Number(req.params.id));res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(row.profit_name)}"`);res.send(row.profit_blob);}));
  app.get('/api/finance/conversions/:id/journal-source', wrap((req, res) => {const row=financeConversions.getConversion(db(),Number(req.params.id));if(!row.journal_blob||!row.journal_name)throw Errors.notFound('序时簿原件');res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(row.journal_name)}"`);res.send(row.journal_blob);}));
  app.post('/api/finance/conversions/:id/create-import-preview', wrap(async (req, res) => res.status(201).json(await financeConversions.createImportPreviewWithSummary(db(),Number(req.params.id)))));
  app.post('/api/finance/conversions/:id/cancel', wrap((req, res) => {financeConversions.cancelConversion(db(),Number(req.params.id),(req as Request&{authUser?:string}).authUser??'');res.json({ok:true});}));
  app.get('/api/finance/parallel-trials', wrap((req, res) => res.json({items:financeParallel.listParallelTrials(db(),optionalPositiveQueryInt(req.query.conversionId, 'conversionId'))})));
  app.post('/api/finance/conversions/:id/parallel-trials', upload.single('file'), wrap(async (req, res) => {if(!req.file)throw Errors.validation('请上传原手工实际数 .xlsx');res.status(201).json(await financeParallel.createParallelTrial(db(),{conversionId:Number(req.params.id),manualName:req.file.originalname,manual:req.file.buffer,actor:(req as Request&{authUser?:string}).authUser??''}));}));
  app.put('/api/finance/parallel-trials/:id/explanations', wrap((req, res) => res.json(financeParallel.saveExplanations(db(),Number(req.params.id),req.body?.items??[]))));
  app.post('/api/finance/parallel-trials/:id/review', wrap((req, res) => res.json(financeParallel.reviewParallelTrial(db(),Number(req.params.id),(req as Request&{authUser?:string}).authUser??''))));
  app.get('/api/finance/parallel-trials/:id/manual-source', wrap((req, res) => {const row=financeParallel.getParallelTrial(db(),Number(req.params.id));res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="${encodeURIComponent(row.manual_name)}"`);res.send(row.manual_blob);}));
  app.get('/api/finance/parallel-trials/:id/report', wrap(async(req,res)=>{const buf=await financeParallel.parallelTrialReport(db(),Number(req.params.id));res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition','attachment; filename="finance-parallel-trial.xlsx"');res.send(buf);}));

  /* ============ 组织管理 ============ */
  app.get('/api/org/tree', wrap((_req, res) => {
    const auth = currentAuth();
    const scope = auth ? resolveOrgScope(db(), auth) : null;
    res.json(org.getOrgTree(db(), scope && !scope.all ? (id) => orgInScope(scope, id) : undefined));
  }));
  app.post('/api/org', wrap((req, res) => {
    const { parentId = null, code, name, sortOrder } = req.body ?? {};
    res.status(201).json(org.createOrg(db(), { parentId, code, name, sortOrder }));
  }));
  app.patch('/api/org/:id', wrap((req, res) => {
    res.json(org.updateOrg(db(), Number(req.params.id), req.body ?? {}));
  }));
  app.post('/api/org/:id/move', wrap((req, res) => {
    if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'parentId')) throw Errors.validation('移动组织必须提供 parentId（移到根节点请显式传 null）');
    const parentId = req.body.parentId;
    if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) throw Errors.validation('parentId 必须是正整数或 null');
    res.json(org.moveOrg(db(), Number(req.params.id), parentId));
  }));
  app.post('/api/org/:id/status', wrap((req, res) => {
    const { status } = req.body ?? {};
    if (status !== 'active' && status !== 'inactive') throw Errors.validation('status 必须是 active 或 inactive');
    res.json(org.setOrgStatus(db(), Number(req.params.id), status));
  }));
  app.delete('/api/org/:id', wrap((req, res) => {
    org.deleteOrg(db(), Number(req.params.id));
    res.status(204).end();
  }));
  app.get('/api/org/check', wrap((_req, res) => res.json(structureCheckPayload(orgStructureIssues(db())))));

  /* ============ 科目管理 ============ */
  app.get('/api/account/tree', wrap((_req, res) => res.json(account.getAccountTree(db()))));
  app.post('/api/account', wrap((req, res) => {
    const { parentId = null, code, name, type, unit, quantityAgg, sortOrder } = req.body ?? {};
    res.status(201).json(account.createAccount(db(), { parentId, code, name, type, unit, quantityAgg, sortOrder }));
  }));
  app.patch('/api/account/:id', wrap((req, res) => {
    res.json(account.updateAccount(db(), Number(req.params.id), req.body ?? {}));
  }));
  app.post('/api/account/:id/move', wrap((req, res) => {
    if (!Object.prototype.hasOwnProperty.call(req.body ?? {}, 'parentId')) throw Errors.validation('移动科目必须提供 parentId（移到根节点请显式传 null）');
    const parentId = req.body.parentId;
    if (parentId !== null && (!Number.isInteger(parentId) || parentId <= 0)) throw Errors.validation('parentId 必须是正整数或 null');
    res.json(account.moveAccount(db(), Number(req.params.id), parentId));
  }));
  app.post('/api/account/:id/status', wrap((req, res) => {
    const { status } = req.body ?? {};
    if (status !== 'active' && status !== 'inactive') throw Errors.validation('status 必须是 active 或 inactive');
    res.json(account.setAccountStatus(db(), Number(req.params.id), status));
  }));
  app.delete('/api/account/:id', wrap((req, res) => {
    account.deleteAccount(db(), Number(req.params.id));
    res.status(204).end();
  }));
  app.get('/api/account/check', wrap((_req, res) => res.json(structureCheckPayload(accountStructureIssues(db())))));

  /* ============ 主数据健康体检(AI 功能增强计划阶段三) ============ */
  app.get('/api/master-data/health', wrap((_req, res) => {
    res.json(masterDataHealthReport(db()));
  }));

  /* ============ 报表指标 ============ */
  app.get('/api/metrics', wrap((_req, res) => {
    const metrics = metric.listMetrics(db());
    const disabled = metric.metricsWithDisabledAccount(db());
    res.json({ items: metrics.map((m) => ({ ...m, referencesDisabledAccount: disabled.has(m.id) })) });
  }));
  app.post('/api/metrics', wrap((req, res) => {
    res.status(201).json(metric.createMetric(db(), req.body ?? {}));
  }));
  app.patch('/api/metrics/:id', wrap((req, res) => {
    res.json(metric.updateMetric(db(), Number(req.params.id), req.body ?? {}));
  }));
  app.delete('/api/metrics/:id', wrap((req, res) => {
    metric.deleteMetric(db(), Number(req.params.id));
    res.status(204).end();
  }));

  /* ============ 预设表 ============ */
  app.get('/api/sheets', wrap((_req, res) => res.json({ items: sheet.listSheets(db()) })));
  app.post('/api/sheets', wrap((req, res) => {
    const { code, name, rootCodes, collapsedCodes, sortOrder } = req.body ?? {};
    res.status(201).json(sheet.createSheet(db(), { code, name, rootCodes, collapsedCodes, sortOrder }));
  }));
  app.patch('/api/sheets/:id', wrap((req, res) => {
    res.json(sheet.updateSheet(db(), Number(req.params.id), req.body ?? {}));
  }));
  app.delete('/api/sheets/:id', wrap((req, res) => {
    sheet.deleteSheet(db(), Number(req.params.id));
    res.status(204).end();
  }));

  /* ============ 树快照 ============ */
  app.get('/api/snapshots', wrap((req, res) => {
    const treeType = queryString(req.query.treeType, 'treeType');
    if (treeType !== undefined && treeType !== 'org' && treeType !== 'account') {
      throw Errors.validation('treeType 必须为 org 或 account');
    }
    res.json(listSnapshots(db(), { treeType: treeType as 'org' | 'account' | undefined }));
  }));
  app.get('/api/snapshots/:id', wrap((req, res) => {
    const row = getSnapshot(db(), Number(req.params.id));
    if (!row) throw Errors.notFound('树快照');
    res.json(row);
  }));

  /* ============ 预算版本 ============ */
  app.get('/api/versions', wrap((req, res) => {
    const year = optionalYearQuery(req.query.year);
    res.json(budget.listVersions(db(), year));
  }));
  app.post('/api/versions/generation-preview', wrap((req, res) => {
    res.json(budget.previewVersionGeneration(db(), req.body ?? {}));
  }));
  app.post('/api/versions', wrap((req, res) => {
    res.status(201).json(budget.createVersion(db(), req.body ?? {}));
  }));
  app.get('/api/versions/:id', wrap((req, res) => res.json(budget.getVersion(db(), Number(req.params.id)))));
  app.patch('/api/versions/:id', wrap((req, res) => {
    res.json(budget.renameVersion(db(), Number(req.params.id), req.body ?? {}));
  }));
  app.delete('/api/versions/:id', wrap((req, res) => {
    budget.deleteVersion(db(), Number(req.params.id));
    res.status(204).end();
  }));
  app.get('/api/versions/:id/matrix', wrap((req, res) => res.json(budget.getEditMatrix(db(), Number(req.params.id)))));
  app.get('/api/versions/:id/metrics', wrap((req, res) => {
    // 定稿版本读锁定时的指标快照，草稿版本读当前定义。
    res.json({ items: metric.listMetricsForVersion(db(), Number(req.params.id)) });
  }));
  /**
   * 指标趋势分析(阶段四):单版本全指标预算/实际值,与报表同源(scopedMetricRollup)。
   * linear 指标返回带符号分;display_sign 由前端按既有口径换算万元展示;
   * ratio 指标返回 RATIO_SCALE(10^6) 缩放的定点比率,分母为 0 时 scaled=null(N/A)。
   * 实际值缺失与 0 必须可区分(0 是合法实际值,不能标成「未冻结」):rollup 无该指标时返回 null。
   */
  app.get('/api/versions/:id/metric-values', wrap((req, res) => {
    const scope = report.completionScope(db(), { versionId: positiveParam(req.params.id, 'id'), batchId: analysisOptionalInt(req.query.batchId, 'batchId') });
    const defs = scope.metricDefinitions;
    const budgetRoll = report.scopedMetricRollup(scope, 'budget');
    const actualRoll = report.scopedMetricRollup(scope, 'actual');
    res.json({
      items: defs.map((def) => ({
        id: def.id,
        code: def.code,
        name: def.name,
        kind: def.kind,
        unit: def.unit,
        displaySign: def.display_sign,
        budgetCents: def.kind === 'ratio' ? null : (budgetRoll.metrics.get(def.id) ?? 0),
        actualCents: def.kind === 'ratio' ? null : (actualRoll.metrics.get(def.id) ?? null),
        budgetRatio: def.kind === 'ratio' ? (budgetRoll.metricRatios.get(def.id)?.scaled ?? null) : null,
        actualRatio: def.kind === 'ratio' ? (actualRoll.metricRatios.get(def.id)?.scaled ?? null) : null,
      })),
    });
  }));
  app.put('/api/versions/:id/entries', wrap((req, res) => {
    const { entries = [], expectedRevision, cellNotes } = req.body ?? {};
    if (!Array.isArray(entries)) throw Errors.validation('entries 必须是数组');
    // cellNotes(汇总格备注)与明细同事务整包替换;缺省表示不动汇总备注(导入/助手等链路)
    if (cellNotes !== undefined && !Array.isArray(cellNotes)) throw Errors.validation('cellNotes 必须是数组');
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Errors.validation('整包保存必须提供非负整数 expectedRevision');
    res.json(budget.saveEntries(db(), Number(req.params.id), entries, expectedRevision, cellNotes));
  }));
  app.delete('/api/versions/:id/entries', wrap((req, res) => {
    const expectedRevision = req.body?.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw Errors.validation('清空草稿必须提供非负整数 expectedRevision');
    res.json(budget.clearEntries(db(), Number(req.params.id), expectedRevision));
  }));
  app.get('/api/versions/:id/validate', wrap((req, res) => res.json(budget.validateForLock(db(), Number(req.params.id)))));
  app.get('/api/versions/:id/quality', wrap((req, res) => res.json(budgetQualityReport(db(), Number(req.params.id)))));
  // 编制进度总览(普通路由,无限流;锁定版本照常返回,空版本返回全零行)
  app.get('/api/versions/:id/progress', wrap((req, res) => res.json(budgetProgressReport(db(), Number(req.params.id)))));
  app.get('/api/versions/:id/checkpoints', wrap((req, res) => {
    res.json(budget.listCompilationCheckpoints(db(), Number(req.params.id)));
  }));
  // 定稿前记录的最新记录点 id,用于定稿后比对是否新创建了记录点
  const latestCheckpointId = (conn: DB, versionId: number): number | null => {
    const row = conn.prepare('SELECT id FROM budget_compilation_checkpoint WHERE version_id = ? ORDER BY sequence_no DESC LIMIT 1').get(versionId) as { id: number } | undefined;
    return row?.id ?? null;
  };
  app.get('/api/versions/:id/cell-history', wrap((req, res) => {
    const orgId = Number(req.query.orgId); const accountId = Number(req.query.accountId);
    if (!Number.isSafeInteger(orgId) || !Number.isSafeInteger(accountId) || orgId <= 0 || accountId <= 0) throw Errors.validation('orgId 和 accountId 必须为正整数');
    res.json(budget.getBudgetCellHistory(db(), Number(req.params.id), orgId, accountId));
  }));
  app.post('/api/versions/:id/checkpoints', wrap((req, res) => {
    const result = budget.recordCompilationCheckpoint(db(), Number(req.params.id), { title: req.body?.title });
    // 小结在事务外异步生成(尽力而为),不在写入同步路径上调用模型
    if (result.created && result.checkpoint) scheduleCheckpointSummary(db(), result.checkpoint.id);
    res.status(result.created ? 201 : 200).json(result);
  }));
  // AI 功能增强计划 §四.阶段六:记录点小结轮询(异步任务表状态 + 已持久化小结)
  // checkpointId 必须属于 URL 中的 versionId:记录点 id 全局自增,不校验归属等于跨版本读取。
  app.get('/api/versions/:id/checkpoints/:checkpointId/summary', wrap((req, res) => {
    res.json(checkpointSummaryStatus(db(), positiveParam(req.params.checkpointId, '记录点 ID'), positiveParam(req.params.id, '版本 ID')));
  }));
  // 重试用尽或需要重新生成时的人工恢复入口;叙述桶限流,写入仍只走确定性 + 守卫后的改写
  app.post('/api/versions/:id/checkpoints/:checkpointId/summary/regenerate', assistantNarrativeRateLimit, wrap((req, res) => {
    const versionId = positiveParam(req.params.id, '版本 ID');
    const checkpointId = positiveParam(req.params.checkpointId, '记录点 ID');
    // 先校验归属,再排队
    checkpointSummaryStatus(db(), checkpointId, versionId);
    const taskId = requeueCheckpointSummary(db(), checkpointId);
    res.status(202).json({ taskId, ...checkpointSummaryStatus(db(), checkpointId, versionId) });
  }));
  app.post('/api/versions/:id/lock', wrap((req, res) => {
    // UX-07:新确认 UI 必传 expectedRevision,事务内复核修订与质量;缺省保持旧调用兼容
    const expectedRevision = req.body?.expectedRevision;
    const before = latestCheckpointId(db(), Number(req.params.id));
    const locked = budget.lockVersion(db(), Number(req.params.id), { expectedRevision });
    // 定稿同事务自动创建的记录点同样在事务外异步生成小结
    const after = latestCheckpointId(db(), Number(req.params.id));
    if (after != null && after !== before) scheduleCheckpointSummary(db(), after);
    res.json(locked);
  }));
  app.post('/api/versions/:id/set-current', wrap((req, res) => {
    // UX-07:新确认 UI 必传 expectedCurrentVersionId(null 表示当前无采用版本),事务内复核原采用版本;缺省保持旧调用兼容
    const expectedCurrentVersionId = req.body?.expectedCurrentVersionId;
    res.json(budget.setCurrentVersion(db(), Number(req.params.id), { expectedCurrentVersionId }));
  }));
  app.post('/api/versions/:id/archive', wrap((req, res) => res.json(budget.archiveVersion(db(), Number(req.params.id)))));
  app.post('/api/versions/:id/copy', wrap((req, res) => {
    const { name, note, targetYear, growthRate } = req.body ?? {};
    // 服务层支持跨年复制与按比例放大(assistant 路径在用),HTTP 路由必须透传,不能静默丢弃
    if (targetYear !== undefined && !Number.isInteger(targetYear)) throw Errors.validation('targetYear 必须是整数年度');
    res.status(201).json(budget.copyVersion(db(), Number(req.params.id), name, note, targetYear, growthRate));
  }));
  app.get('/api/versions/:id/summary', wrap((req, res) => {
    const s = budget.versionSummary(db(), Number(req.params.id));
    // 类型合计:按叶子明细直接归类(与指标同口径,避免交叉矩阵重复计数)
    const accById = new Map(s.accRows.map((a) => [a.id, a]));
    const entries = db()
      .prepare('SELECT account_id, amount_cents FROM budget_entry WHERE version_id = ?')
      .all(Number(req.params.id)) as { account_id: number; amount_cents: number }[];
    const totals = { income: 0, cost: 0, expense: 0 };
    for (const e of entries) {
      const t = accById.get(e.account_id)?.type;
      if (t === 'income') totals.income = safeIntegerAdd(totals.income, e.amount_cents, '收入汇总');
      else if (t === 'cost') totals.cost = safeIntegerAdd(totals.cost, e.amount_cents, '成本汇总');
      else if (t === 'expense') totals.expense = safeIntegerAdd(totals.expense, e.amount_cents, '费用汇总');
    }
    res.json({
      version: s.version,
      // 金额口径指标与比率指标分列:两者单位不同(分 vs 10^6 缩放定点比率),不能混进同一张表
      metrics: s.metrics.filter((m) => m.kind !== 'ratio').map((m) => ({ id: m.id, code: m.code, name: m.name })),
      metricValues: Object.fromEntries(s.rollup.metrics),
      ratioMetrics: s.metrics
        .filter((m) => m.kind === 'ratio')
        .map((m) => {
          const value = s.rollup.metricRatios.get(m.id);
          return {
            id: m.id,
            code: m.code,
            name: m.name,
            direction: m.direction,
            displayFormat: m.display_format,
            unit: m.unit,
            scaled: value?.scaled ?? null,
            numeratorRaw: value?.numeratorRaw ?? 0,
            denominatorRaw: value?.denominatorRaw ?? 0,
            numeratorBasis: value?.numeratorBasis ?? 'money',
            denominatorBasis: value?.denominatorBasis ?? 'money',
          };
        }),
      totalsByAccountType: totals,
      cell: Object.fromEntries(
        [...s.rollup.cell.entries()].map(([orgId, rowMap]) => [orgId, Object.fromEntries(rowMap)])
      ),
    });
  }));

  /* ============ 轻量测算模板 ============ */
  app.get('/api/calculation-rules', wrap((req, res) => {
    res.json({ items: calculation.listRules(db(), req.query.all === '1') });
  }));
  app.post('/api/calculation-rules', wrap((req, res) => {
    res.status(201).json(calculation.saveRule(db(), req.body ?? {}));
  }));
  app.put('/api/calculation-rules/:id', wrap((req, res) => {
    res.json(calculation.saveRule(db(), { ...(req.body ?? {}), id: Number(req.params.id) }));
  }));
  app.post('/api/versions/:id/calculation-preview', wrap((req, res) => {
    const ruleId = Number(req.body?.ruleId);
    if (!Number.isInteger(ruleId)) throw Errors.validation('缺少 ruleId');
    res.json(calculation.previewRule(db(), Number(req.params.id), ruleId));
  }));

  /* ============ 实际数 ============ */
  app.get('/api/actual/years', wrap((_req, res) => res.json(actual.listYearStates(db()))));
  app.get('/api/actual/matrix', wrap((req, res) => {
    const year = Number(req.query.year);
    if (!Number.isInteger(year)) throw Errors.validation('缺少 year 参数');
    res.json(actual.getActualMatrix(db(), year));
  }));
  app.post('/api/actual/save', wrap((req, res) => {
    const { year, snapshotDate, entries = [], note, history = false, expectedCurrentBatchId, allowEmptyReplace = false, cellNotes, requestId } = req.body ?? {};
    if (!Number.isInteger(year)) throw Errors.validation('缺少年度');
    if (!Array.isArray(entries)) throw Errors.validation('entries 必须是数组');
    // cellNotes(汇总格备注)随当前实际整包替换;缺省表示不动(导入/财务转换链路),历史补录拒收
    if (cellNotes !== undefined && !Array.isArray(cellNotes)) throw Errors.validation('cellNotes 必须是数组');
    if (!history && !Object.prototype.hasOwnProperty.call(req.body ?? {}, 'expectedCurrentBatchId')) {
      throw Errors.validation('整包保存缺少当前批次基线，请刷新页面后重试');
    }
    if (expectedCurrentBatchId != null && !Number.isInteger(expectedCurrentBatchId)) throw Errors.validation('当前批次基线不合法');
    // UX-11:requestId 由客户端在用户明确提交时生成;缺省保持旧行为(不去重)。
    // 服务端只做格式校验与回执去重,格式细节(长度/字符集)在服务层统一判定。
    if (requestId !== undefined && typeof requestId !== 'string') throw Errors.validation('requestId 必须是字符串');
    res.json(actual.saveActual(db(), {
      year, snapshotDate, entries, source: 'manual', note, mode: 'replace', history: Boolean(history),
      expectedCurrentBatchId: expectedCurrentBatchId ?? null,
      allowEmptyReplace: allowEmptyReplace === true,
      cellNotes,
      requestId,
    }));
  }));
  // UX-11 只读回执查询:注册在 /api/actual/batches/:id 等 :id 参数路由之前,避免被参数路由抢占。
  // 404 语义:不存在不代表输入一定未到达(可能请求根本没到服务端),重试仍须沿用相同请求编号。
  app.get('/api/actual/save-requests/:requestId', wrap((req, res) => {
    const requestId = String(req.params.requestId);
    actual.assertValidSaveRequestId(requestId);
    const receipt = actual.getSaveReceipt(db(), requestId);
    if (!receipt) {
      throw new AppError('NOT_FOUND', '该请求编号没有已提交成功的保存回执(查不到不代表输入一定未到达,重试请沿用相同请求编号)', 404);
    }
    res.json({ committed: true, ...receipt });
  }));
  app.get('/api/actual/batches', wrap((req, res) => {
    const year = optionalYearQuery(req.query.year);
    res.json(actual.listBatches(db(), year));
  }));
  app.get('/api/actual/batches/:id', wrap((req, res) => {
    const id = Number(req.params.id);
    res.json({ batch: actual.getBatch(db(), id), entries: actual.getBatchEntries(db(), id) });
  }));
  app.delete('/api/actual/batches/:id', wrap((req, res) => {
    actual.deleteSupersededBatch(db(), Number(req.params.id));
    res.status(204).end();
  }));

  /* ============ 年度关闭 ============ */
  app.post('/api/years/:year/freeze', wrap((req, res) => {
    const { finalBatchId, confirmEmpty = false, confirmNonCurrent = false } = req.body ?? {};
    if (!Number.isInteger(finalBatchId)) throw Errors.validation('缺少 finalBatchId');
    res.json(report.freezeYear(db(), Number(req.params.year), finalBatchId, { empty: confirmEmpty === true, nonCurrent: confirmNonCurrent === true }));
  }));
  app.post('/api/years/:year/reopen', wrap((req, res) => {
    const { reason } = req.body ?? {};
    res.json(report.reopenYear(db(), Number(req.params.year), reason));
  }));

  /* ============ 分析报表 ============ */
  const analysisSheetKey = (value: unknown): string => {
    const key = typeof value === 'string' && value.trim() ? value.trim() : 'all';
    const valid = new Set(['profit', 'overview', 'all', ...sheet.listSheets(db()).filter((item) => item.status === 'active').map((item) => item.code)]);
    if (!valid.has(key)) throw Errors.validation(`未知或已停用的预算表格: ${key}`);
    return key;
  };
  app.get('/api/report/completion', wrap((req, res) => {
    const versionId = Number(req.query.versionId);
    if (!Number.isInteger(versionId) || versionId <= 0) throw Errors.validation('缺少有效 versionId');
    // 节奏偏离预警阈值:页面以百分点传入(0-100),服务内按比率(0-1)判定。
    const thresholdRaw = req.query.warningThreshold;
    const thresholdPercent = thresholdRaw == null || thresholdRaw === '' ? null : Number(thresholdRaw);
    if (thresholdPercent != null && (!Number.isFinite(thresholdPercent) || thresholdPercent < 0 || thresholdPercent > 100)) {
      throw Errors.validation('warningThreshold 必须是 0-100 的数值');
    }
    res.json(report.completionReport(db(), {
      versionId,
      batchId: analysisOptionalInt(req.query.batchId, 'batchId'),
      orgScopeId: currentOrgScopeId(db(), analysisOptionalInt(req.query.orgScopeId, 'orgScopeId')),
      accountScopeId: analysisOptionalInt(req.query.accountScopeId, 'accountScopeId'),
      sheetKey: analysisSheetKey(req.query.sheetKey),
      summaryLevel: analysisOptionalInt(req.query.summaryLevel, 'summaryLevel'),
      warningThreshold: thresholdPercent == null ? null : thresholdPercent / 100,
    }));
  }));
  app.get('/api/report/historical', wrap((_req, res) => res.json(report.historicalComparison(db()))));
  /* ============ LLM 渠道管理(设置中心,§7.2) ============
     普通路由,不挂 assistant 限流;连通性测试单独挂宽松限流(10/min 防连点,独立桶)。
     渠道与绑定是敏感配置(决定 AI 请求发往哪里、用哪把 key),全部写操作都落审计日志。 */
  const channelTestBuckets = new Map<string, { count: number; resetAt: number }>();
  /** 每处理这么多次请求做一次过期 key 清理,防止 Map 随不同来源 IP 单调增长。 */
  const CHANNEL_TEST_SWEEP_EVERY = 50;
  let channelTestSweepCountdown = CHANNEL_TEST_SWEEP_EVERY;
  const channelTestRateLimit = (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    channelTestSweepCountdown -= 1;
    if (channelTestSweepCountdown <= 0) {
      channelTestSweepCountdown = CHANNEL_TEST_SWEEP_EVERY;
      for (const [k, bucket] of channelTestBuckets) {
        if (now >= bucket.resetAt) channelTestBuckets.delete(k);
      }
    }
    const bucket = channelTestBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      channelTestBuckets.set(key, { count: 1, resetAt: now + 60_000 });
      return next();
    }
    if (bucket.count >= 10) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        code: 'RATE_LIMITED',
        message: `连通性测试过于频繁（每分钟上限 10 次），请 ${retryAfterSeconds} 秒后重试`,
        retryAfterSeconds,
      });
      return;
    }
    bucket.count++;
    next();
  };
  app.get('/api/settings/ai-channels', wrap((_req, res) => res.json({ items: aiChannels.listChannels(db()) })));
  app.post('/api/settings/ai-channels', wrap((req, res) => {
    const result = aiChannels.createChannel(db(), req.body ?? {});
    writeLog(db(), 'settings.ai_channel.create', 'settings', '-', { channelId: result.id, baseUrl: (req.body?.baseUrl ?? '') as string });
    res.status(201).json(result);
  }));
  app.patch('/api/settings/ai-channels/:id', wrap((req, res) => {
    const id = positiveParam(req.params.id, 'id');
    const result = aiChannels.updateChannel(db(), id, req.body ?? {});
    // 只记改了哪些字段名,不落 apiKey 明文/密钥变更标记入日志(审计需要知道改了配置,不需要知道密钥本身)
    writeLog(db(), 'settings.ai_channel.update', 'settings', '-', { channelId: id, fields: Object.keys(req.body ?? {}) });
    res.json(result);
  }));
  app.delete('/api/settings/ai-channels/:id', wrap((req, res) => {
    const id = positiveParam(req.params.id, 'id');
    const result = aiChannels.deleteChannel(db(), id);
    writeLog(db(), 'settings.ai_channel.delete', 'settings', '-', { channelId: id, affectedFeatures: result.affectedFeatures });
    res.json(result);
  }));
  app.post('/api/settings/ai-channels/:id/test', channelTestRateLimit, wrap(async (req, res) => {
    const id = positiveParam(req.params.id, 'id');
    const result = await aiChannels.testChannel(db(), id);
    writeLog(db(), 'settings.ai_channel.test', 'settings', '-', { channelId: id, status: result.status });
    res.json(result);
  }));
  app.get('/api/settings/ai-feature-bindings', wrap((_req, res) => res.json({ items: aiChannels.listBindings(db()) })));
  app.put('/api/settings/ai-feature-bindings', wrap((req, res) => {
    const items = aiChannels.saveBindings(db(), req.body ?? {});
    writeLog(db(), 'settings.ai_binding.save', 'settings', '-', {
      bindings: items.map((row) => ({ feature: row.feature, primary: row.primaryChannelId, fallback: row.fallbackChannelId })),
    });
    res.json({ items });
  }));

  /**
   * 预警中心:确定性异常检测(与助手「异常与质量检查」同一 anomalyReport 函数)。
   * 普通路由,不经过 registerAssistantRoutes、不挂 assistant 限流中间件;零模型依赖。
   * 阈值查询参数校验后透传(缺省用函数默认值 0.2/0.3/0.3,非法值 400)。
   */
  app.get('/api/analysis/anomalies', wrap((req, res) => {
    const versionId = Number(req.query.versionId);
    if (!Number.isInteger(versionId) || versionId <= 0) throw Errors.validation('缺少有效 versionId');
    const thresholdQuery = (value: unknown, name: string): number | undefined => {
      const text = queryString(value, name);
      if (text === undefined) return undefined;
      const parsed = Number(text);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 10) throw Errors.validation(`${name} 必须在 0 到 10 之间`);
      return parsed;
    };
    res.json(anomalyReport(db(), {
      versionId,
      batchId: analysisOptionalInt(req.query.batchId, 'batchId'),
      orgScopeId: currentOrgScopeId(db(), analysisOptionalInt(req.query.orgScopeId, 'orgScopeId')),
      accountScopeId: analysisOptionalInt(req.query.accountScopeId, 'accountScopeId'),
      sheetKey: analysisSheetKey(req.query.sheetKey),
      threshold: thresholdQuery(req.query.threshold, 'threshold'),
      yoyThreshold: thresholdQuery(req.query.yoyThreshold, 'yoyThreshold'),
      peerThreshold: thresholdQuery(req.query.peerThreshold, 'peerThreshold'),
    }));
  }));
  // AI 功能增强计划阶段五:N 年同口径对比(编码对齐 + 可比性声明 + 维度下探)
  app.get('/api/report/multi-year-trend', wrap((req, res) => {
    const baseYear = Number(req.query.baseYear);
    if (!Number.isSafeInteger(baseYear) || baseYear < 2000 || baseYear > 2100) throw Errors.validation('baseYear 必须是 2000-2100 的整数年');
    const depth = req.query.depth === undefined ? undefined : Number(req.query.depth);
    if (depth !== undefined && (!Number.isSafeInteger(depth) || depth < 1 || depth > MAX_TREND_YEARS)) throw Errors.validation(`depth 必须是 1 到 ${MAX_TREND_YEARS} 的整数`);
    const orgCodes = typeof req.query.orgCodes === 'string' && req.query.orgCodes.trim()
      ? req.query.orgCodes.split(',').map((code) => code.trim()).filter(Boolean)
      : undefined;
    // 受限用户按授权范围裁剪(orgCodes 只能在范围内再收窄,由 multiYearTrend 取交集)
    const orgScopeId = currentOrgScopeId(db(), analysisOptionalInt(req.query.orgScopeId, 'orgScopeId'));
    res.json(multiYearTrend(db(), { baseYear, ...(depth !== undefined ? { depth } : {}), ...(orgCodes ? { orgCodes } : {}), ...(orgScopeId != null ? { orgScopeId } : {}) }));
  }));
  app.get('/api/report/structure', wrap((req, res) => {
    const versionId = Number(req.query.versionId);
    if (!Number.isInteger(versionId) || versionId <= 0) throw Errors.validation('缺少有效 versionId');
    const basisMode = typeof req.query.basisMode === 'string' && req.query.basisMode.trim() ? req.query.basisMode.trim() : 'parent';
    if (!['parent', 'account', 'metric'].includes(basisMode)) throw Errors.validation('basisMode 必须是 parent/account/metric');
    res.json(structure.structureReport(db(), {
      versionId,
      batchId: analysisOptionalInt(req.query.batchId, 'batchId'),
      orgScopeId: currentOrgScopeId(db(), analysisOptionalInt(req.query.orgScopeId, 'orgScopeId')),
      accountScopeId: analysisOptionalInt(req.query.accountScopeId, 'accountScopeId'),
      sheetKey: analysisSheetKey(req.query.sheetKey),
      summaryLevel: analysisOptionalInt(req.query.summaryLevel, 'summaryLevel'),
      basisMode: basisMode as 'parent' | 'account' | 'metric',
      basisId: analysisOptionalInt(req.query.basisId, 'basisId'),
    }));
  }));
  app.get('/api/report/trend', wrap((req, res) => {
    const year = Number(req.query.year);
    const versionId = Number(req.query.versionId);
    if (!Number.isInteger(year) || year < 1900 || year > 9999 || !Number.isInteger(versionId) || versionId <= 0) throw Errors.validation('缺少有效 year 或 versionId');
    const trendKind = typeof req.query.trendKind === 'string' ? req.query.trendKind : 'composite';
    if (!['metric', 'account', 'composite'].includes(trendKind)) throw Errors.validation('trendKind 必须是 metric/account/composite');
    const trendId = analysisOptionalInt(req.query.trendId, 'trendId');
    if (trendKind !== 'composite' && trendId == null) throw Errors.validation('所选趋势指标缺少 trendId');
    res.json(report.yearTrend(db(), {
      year,
      versionId,
      accountScopeId: analysisOptionalInt(req.query.accountScopeId, 'accountScopeId'),
      orgScopeId: currentOrgScopeId(db(), analysisOptionalInt(req.query.orgScopeId, 'orgScopeId')),
      sheetKey: analysisSheetKey(req.query.sheetKey),
      batchId: analysisOptionalInt(req.query.batchId, 'batchId'),
      trendKind: trendKind as 'metric' | 'account' | 'composite',
      trendId,
    }));
  }));
  app.get('/api/report/version-compare', wrap((req, res) => {
    const base = Number(req.query.base);
    const target = Number(req.query.target);
    if (!Number.isInteger(base) || !Number.isInteger(target)) throw Errors.validation('缺少 base 或 target');
    res.json(report.versionCompare(db(), base, target));
  }));
  app.get('/api/report/accuracy', wrap((req, res) => {
    const year = Number(req.query.year);
    if (!Number.isInteger(year)) throw Errors.validation('缺少 year');
    res.json(report.accuracyReport(db(), year));
  }));
  app.get('/api/evidence/budget-cell', wrap((req, res) => {
    const versionId = Number(req.query.versionId);
    const accountId = Number(req.query.accountId);
    const orgId = req.query.orgId == null ? undefined : Number(req.query.orgId);
    if (!Number.isInteger(versionId) || !Number.isInteger(accountId) || (orgId != null && !Number.isInteger(orgId))) throw Errors.validation('证据查询参数不完整');
    res.json(evidence.budgetCellEvidence(db(), versionId, accountId, currentCellOrgId(db(), orgId)));
  }));
  app.get('/api/evidence/actual-cell', wrap((req, res) => {
    const batchId = Number(req.query.batchId);
    const accountId = Number(req.query.accountId);
    const orgId = req.query.orgId == null ? undefined : Number(req.query.orgId);
    if (!Number.isInteger(batchId) || !Number.isInteger(accountId) || (orgId != null && !Number.isInteger(orgId))) throw Errors.validation('证据查询参数不完整');
    res.json(evidence.actualCellEvidence(db(), batchId, accountId, currentCellOrgId(db(), orgId)));
  }));
  /** 指标穿透:范围参数与 /api/report/completion 共用同一套校验,保证穿透数字与报表逐分相等 */
  app.get('/api/evidence/metric-cell', wrap((req, res) => {
    const versionId = Number(req.query.versionId);
    const metricId = Number(req.query.metricId);
    if (!Number.isInteger(versionId) || !Number.isInteger(metricId)) throw Errors.validation('证据查询参数不完整');
    res.json(evidence.metricEvidence(db(), {
      versionId,
      metricId,
      batchId: analysisOptionalInt(req.query.batchId, 'batchId'),
      orgScopeId: currentOrgScopeId(db(), analysisOptionalInt(req.query.orgScopeId, 'orgScopeId')),
      accountScopeId: analysisOptionalInt(req.query.accountScopeId, 'accountScopeId'),
      sheetKey: analysisSheetKey(req.query.sheetKey),
    }));
  }));

  /* ============ Excel 导入 ============ */
  app.get('/api/io/template/actual', wrap(async (req, res) => {
    // 查询参数逐项校验:年份/组织 ID/截止日期/预设表 key,防止 NaN 与未知 sheetKey
    // 静默回退成全量科目树模板(前端拿到的与请求的口径不一致)
    const validSheetKeys = new Set(['profit', 'overview', 'all', ...sheet.listSheets(db()).map((s) => s.code)]);
    const checkSheetKey = (k: string) => {
      if (!validSheetKeys.has(k)) {
        throw Errors.validation(`未知的表格 key: ${k}(可用: ${[...validSheetKeys].join(', ')})`);
      }
    };
    const parseNumArr = (v: unknown): number[] | undefined => {
      const raw = typeof v === 'string'
        ? v.split(',').map((s) => s.trim())
        : Array.isArray(v) ? v.map(String) : undefined;
      if (raw == null) return undefined;
      const nums: number[] = [];
      for (const s of raw) {
        if (s === '') continue;
        const n = Number(s);
        if (!Number.isInteger(n) || n <= 0) throw Errors.validation(`参数包含非法数值: "${s}"`);
        nums.push(n);
      }
      return nums;
    };
    const parseYear = (v: unknown, label: string): number | undefined => {
      if (v == null || v === '') return undefined;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1900 || n > 9999) throw Errors.validation(`${label}必须是 1900-9999 的整数: "${String(v)}"`);
      return n;
    };
    const year = parseYear(req.query.year, 'year');
    const years = (() => {
      const nums = parseNumArr(req.query.years);
      if (nums == null) return undefined;
      return nums.map((n) => {
        if (n < 1900 || n > 9999) throw Errors.validation(`years 包含非法年份: ${n}`);
        return n;
      });
    })();
    const orgId = (() => {
      const n = parseNumArr(req.query.orgId);
      if (n == null) return undefined;
      if (n.length > 1) throw Errors.validation('orgId 只能是单个组织 ID');
      return n[0];
    })();
    const orgIds = parseNumArr(req.query.orgIds);
    const cutoff = typeof req.query.cutoff === 'string' && req.query.cutoff !== '' ? req.query.cutoff : undefined;
    if (cutoff && !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
      throw Errors.validation(`cutoff 格式必须为 YYYY-MM-DD: "${cutoff}"`);
    }
    const sheetKey = typeof req.query.sheetKey === 'string' && req.query.sheetKey !== '' ? req.query.sheetKey : undefined;
    if (sheetKey) checkSheetKey(sheetKey);
    const sheetKeys = (() => {
      if (typeof req.query.sheetKeys !== 'string' || req.query.sheetKeys === '') return undefined;
      const keys = req.query.sheetKeys.split(',').map((s) => s.trim()).filter(Boolean);
      keys.forEach(checkSheetKey);
      return keys;
    })();

    const buf = await io.actualImportTemplateBuffer(db(), {
      year,
      years,
      cutoff,
      orgId,
      orgIds,
      sheetKey,
      sheetKeys,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="actual-import-template.xlsx"');
    res.send(buf);
  }));
  app.get('/api/io/template/budget', wrap(async (_req, res) => {
    const buf = await io.budgetImportTemplateBuffer(db());
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="budget-import-template.xlsx"');
    res.send(buf);
  }));
  app.post('/api/io/actual/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传 .xlsx 文件');
    try {
      const confirm = req.body?.confirm === 'true' || req.body?.confirm === true;
      const history = req.body?.history === 'true' || req.body?.history === true;
      const parsed = await io.parseActualImport(req.file.buffer, db());
      if (!parsed.ok) {
        writeLog(db(), 'import.failed', 'actual_import', '-', { errors: parsed.errors.slice(0, 50) });
        throw Errors.importValidation('导入文件存在错误', parsed.errors);
      }
      const requestedSnapshotDate = req.body?.snapshotDate;
      if (requestedSnapshotDate != null && requestedSnapshotDate !== '') {
        if (!history) throw Errors.validation('仅历史补录可指定覆盖文件中的截止日期');
        if (typeof requestedSnapshotDate !== 'string' || !isValidDate(requestedSnapshotDate)) {
          throw Errors.validation('历史截止日期格式必须为 YYYY-MM-DD');
        }
        const requestedYear = yearOfDate(requestedSnapshotDate);
        const rowYears = new Set(parsed.rows.map((row) => row.year).filter((year): year is number => year != null));
        if (rowYears.size !== 1 || !rowYears.has(requestedYear)) {
          throw Errors.validation(`历史截止日期 ${requestedSnapshotDate} 必须与导入文件年度一致`);
        }
        parsed.rows.forEach((row) => { row.snapshotDate = requestedSnapshotDate; });
        parsed.dates = [requestedSnapshotDate];
      }
      const resolved = io.resolveActualImport(db(), parsed, history);
      const totalCount = resolved.batches.reduce((sum, b) => sum + b.entries.length, 0);
      if (!history) {
        assertNoFinanceOwnedConflicts(db(), resolved.batches.flatMap((group) => group.entries.map((entry) => ({ orgId: entry.orgId, accountId: entry.accountId }))));
      }

      const previewSummary = {
          preview: true,
          year: resolved.year,
          snapshotDate: resolved.snapshotDate,
          count: totalCount,
          years: resolved.batches.map((b) => b.year),
          batches: resolved.batches.map((b) => ({ year: b.year, snapshotDate: b.snapshotDate, count: b.entries.length })),
          entries: resolved.entries.slice(0, 200),
      };
      // UX-14:创建批次时按服务端整数分冻结统一摘要与逐行明细(多年度多截止日按组保留);
      // payload 只存可执行输入,源行位置只进冻结明细,不进 payload。
      const unifiedPreview = buildStandardActualPreview(db(), { history, batches: resolved.batches, source: 'standard' });
      const created = importBatch.createBatch(db(), {
        kind: 'actual',
        history,
        originalName: req.file.originalname,
        file: req.file.buffer,
        payload: { history, note: req.body?.note ?? 'Excel 导入', batches: resolved.batches.map((b) => ({ year: b.year, snapshotDate: b.snapshotDate, entries: b.entries })) },
        summary: { years: resolved.batches.map((b) => b.year), count: totalCount, history },
        preview: unifiedPreview,
      });
      if (!confirm) return res.json({ ...previewSummary, unifiedPreview: unifiedPreview.summary, importBatchId: created.id, sha256: created.sha256 });
      const committed = importBatch.commitBatch(db(), created.id);
      const result = JSON.parse(committed.result_json) as Record<string, unknown>;
      res.json({ preview: false, importBatchId: committed.id, sha256: committed.sha256, ...result });
    } finally {
      // 导入文件用后即删(memoryStorage 无临时文件,主动释放引用)
      req.file.buffer = null as unknown as Buffer;
    }
  }));
  app.post('/api/io/budget/import', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传 .xlsx 文件');
    const versionId = Number(req.body?.versionId);
    if (!Number.isInteger(versionId)) throw Errors.validation('缺少 versionId');
    const confirm = req.body?.confirm === 'true' || req.body?.confirm === true;
    const parsed = await io.parseBudgetImport(req.file.buffer);
    if (!parsed.ok) {
      writeLog(db(), 'import.failed', 'budget_import', String(versionId), { errors: parsed.errors.slice(0, 50) });
      throw Errors.importValidation('导入文件存在错误', parsed.errors);
    }
    const targetVersion = budget.getVersion(db(), versionId);
    const entries = io.resolveBudgetImport(db(), versionId, parsed);
    const treeSnapshotIds = { org: targetVersion.org_tree_snapshot_id, account: targetVersion.account_tree_snapshot_id };
    // UX-14:统一预览摘要与逐行差异在创建批次时冻结(分类与 saveEntries 落库语义一致)
    const unifiedPreview = buildStandardBudgetPreview(db(), versionId, entries, parsed.rows);
    const created = importBatch.createBatch(db(), {
      kind: 'budget',
      targetVersionId: versionId,
      originalName: req.file.originalname,
      file: req.file.buffer,
      payload: { versionId, entries },
      summary: { versionId, count: entries.length, treeSnapshotIds },
      preview: unifiedPreview,
    });
    if (!confirm) return res.json({ preview: true, importBatchId: created.id, sha256: created.sha256, count: entries.length, treeSnapshotIds, entries: entries.slice(0, 200), unifiedPreview: unifiedPreview.summary });
    const committed = importBatch.commitBatch(db(), created.id);
    res.json({ preview: false, importBatchId: committed.id, sha256: committed.sha256, ...(JSON.parse(committed.result_json) as object) });
  }));

  app.get('/api/io/import-batches', wrap((req, res) => {
    res.json({ items: importBatch.listBatches(db(), positiveQueryInt(req.query.limit, 'limit', 100)) });
  }));
  // UX-14:两个静态后缀子路由都在 ':id' 段之后还有路径段,不会被 GET :id 吃掉;保持相邻注册。
  app.get('/api/io/import-batches/:id/preview-rows', wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw Errors.validation('批次 ID 必须是正整数');
    const orgId = req.query.orgId === undefined ? undefined : Number(req.query.orgId);
    const warningOnly = req.query.warningOnly === '1' || req.query.warningOnly === 'true';
    res.json(importBatch.listBatchPreviewRows(db(), id, {
      page: req.query.page === undefined ? undefined : Number(req.query.page),
      pageSize: req.query.pageSize === undefined ? undefined : Number(req.query.pageSize),
      orgId,
      action: typeof req.query.action === 'string' && req.query.action !== '' ? req.query.action : undefined,
      warningOnly,
    }));
  }));
  app.get('/api/io/import-batches/:id', wrap((req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw Errors.validation('批次 ID 必须是正整数');
    res.json(importBatch.getBatchDetail(db(), id));
  }));
  app.post('/api/io/import-batches/:id/confirm', wrap((req, res) => {
    if (Object.prototype.hasOwnProperty.call(req.body ?? {}, 'entries')) throw Errors.validation('确认接口不接受客户端 entries，只使用待确认批次中的服务端 payload');
    const id = Number(req.params.id);
    let row;
    try {
      row = importBatch.commitBatch(db(), id);
    } catch (error) {
      // 确认失败(校验、基线、状态任一不过)时自动取消该 pending 批次:
      // 它的业务前提已失效,留着只会永远占据库内原件 blob,且无任何 TTL 清理。
      try { importBatch.cancelBatch(db(), id); } catch { /* 非 pending(已被并发处理)则忽略 */ }
      throw error;
    }
    res.json({ id: row.id, status: row.status, kind: row.kind, result: JSON.parse(row.result_json) });
  }));
  app.post('/api/io/import-batches/:id/rollback', wrap((req, res) => {
    const row = importBatch.rollbackBatch(db(), Number(req.params.id));
    res.json({ id: row.id, status: row.status, kind: row.kind });
  }));
  app.post('/api/io/import-batches/:id/cancel', wrap((req, res) => {
    importBatch.cancelBatch(db(), Number(req.params.id));
    res.json({ ok: true });
  }));
  app.get('/api/io/import-batches/:id/source', wrap((req, res) => {
    const row = importBatch.getBatch(db(), Number(req.params.id));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.original_name)}"`);
    res.send(row.file_blob);
  }));

  /* ============ 导出 ============ */
  const sendXlsx = (res: Response, buf: Buffer, filename: string) => {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.send(buf);
  };
  app.get('/api/io/export/budget-detail/:versionId', wrap(async (req, res) => {
    sendXlsx(res, await exportSvc.exportBudgetDetail(db(), Number(req.params.versionId)), '预算编制明细.xlsx');
  }));
  app.get('/api/io/export/actual-current/:year', wrap(async (req, res) => {
    const year = optionalYearQuery(req.params.year);
    if (year == null) throw Errors.validation('year 必须是 1900-9999 的整数');
    sendXlsx(res, await exportSvc.exportActualCurrent(db(), year), '当前累计实际.xlsx');
  }));
  app.get('/api/io/export/completion/:versionId', wrap(async (req, res) => {
    const versionId = Number(req.params.versionId);
    if (!Number.isInteger(versionId) || versionId <= 0) throw Errors.validation('versionId 必须是正整数');
    sendXlsx(res, await exportSvc.exportCompletion(db(), versionId, {
      batchId: analysisOptionalInt(req.query.batchId, 'batchId'),
      orgScopeId: currentOrgScopeId(db(), analysisOptionalInt(req.query.orgScopeId, 'orgScopeId')),
      accountScopeId: analysisOptionalInt(req.query.accountScopeId, 'accountScopeId'),
      sheetKey: analysisSheetKey(req.query.sheetKey),
      summaryLevel: analysisOptionalInt(req.query.summaryLevel, 'summaryLevel'),
      forecastVersionId: analysisOptionalInt(req.query.forecastVersionId, 'forecastVersionId'),
    }), '预算完成情况.xlsx');
  }));
  app.get('/api/io/export/historical', wrap(async (_req, res) => {
    sendXlsx(res, await exportSvc.exportHistorical(db()), '历年预实对比.xlsx');
  }));
  app.get('/api/io/export/structure/:versionId', wrap(async (req, res) => {
    const versionId = Number(req.params.versionId);
    if (!Number.isInteger(versionId) || versionId <= 0) throw Errors.validation('versionId 必须是正整数');
    const basisMode = typeof req.query.basisMode === 'string' && req.query.basisMode.trim() ? req.query.basisMode.trim() : 'parent';
    if (!['parent', 'account', 'metric'].includes(basisMode)) throw Errors.validation('basisMode 必须是 parent/account/metric');
    sendXlsx(res, await exportSvc.exportStructure(db(), {
      versionId,
      batchId: analysisOptionalInt(req.query.batchId, 'batchId'),
      orgScopeId: currentOrgScopeId(db(), analysisOptionalInt(req.query.orgScopeId, 'orgScopeId')),
      accountScopeId: analysisOptionalInt(req.query.accountScopeId, 'accountScopeId'),
      sheetKey: analysisSheetKey(req.query.sheetKey),
      summaryLevel: analysisOptionalInt(req.query.summaryLevel, 'summaryLevel'),
      basisMode: basisMode as 'parent' | 'account' | 'metric',
      basisId: analysisOptionalInt(req.query.basisId, 'basisId'),
    }), '结构占比.xlsx');
  }));
  app.get('/api/io/export/version-compare', wrap(async (req, res) => {
    sendXlsx(res, await exportSvc.exportVersionCompare(db(), Number(req.query.base), Number(req.query.target)), '版本对比.xlsx');
  }));
  app.get('/api/io/export/snapshot/:batchId', wrap(async (req, res) => {
    sendXlsx(res, await exportSvc.exportSnapshot(db(), Number(req.params.batchId)), '实际快照.xlsx');
  }));
  app.get('/api/io/export/logs', wrap(async (req, res) => {
    /* 与 /api/logs 列表同一筛选参数,导出结果跟随界面筛选 */
    sendXlsx(res, await exportSvc.exportLogs(db(), {
      action: queryString(req.query.action, 'action'),
      entityType: queryString(req.query.entityType, 'entityType'),
    }), '操作日志.xlsx');
  }));
  app.get('/api/io/export/metrics', wrap(async (_req, res) => {
    sendXlsx(res, await exportSvc.exportMetricList(db()), '报表指标.xlsx');
  }));

  /* ============ 操作日志 ============ */
  app.get('/api/logs', wrap((req, res) => {
    // NaN/负数直传 SQL 的 LIMIT/OFFSET 会触发 SqliteError,必须先拦下
    const page = positiveQueryInt(req.query.page, 'page', 1);
    const pageSize = positiveQueryInt(req.query.pageSize, 'pageSize', 50);
    res.json(queryLogs(db(), {
      page,
      pageSize,
      action: queryString(req.query.action, 'action'),
      entityType: queryString(req.query.entityType, 'entityType'),
      entityId: queryString(req.query.entityId, 'entityId'),
      actorUserId: req.query.actorUserId === undefined ? undefined : positiveQueryInt(req.query.actorUserId, 'actorUserId', 1),
      result: queryString(req.query.result, 'result'),
      requestId: queryString(req.query.requestId, 'requestId'),
      from: queryString(req.query.from, 'from'),
      to: queryString(req.query.to, 'to'),
    }));
  }));

  /* ============ 备份恢复 ============ */
  const backupCreateCooldownMs = 5_000;
  let backupCreateInFlight = false;
  let lastBackupCreateStartedAt = 0;
  // 恢复是全局互斥的库替换操作:并发第二次恢复会与进行中的 close/copy/reopen 互相打架
  let restoreInFlight = false;
  app.get('/api/backup/list', wrap((_req, res) => {
    // 不返回服务器绝对路径:目录结构对客户端无用处,暴露即为侦察信息
    res.json({ items: backup.listBackups(backup.backupDirOf(opts.dbPath)) });
  }));
  app.post('/api/backup/create', wrap(async (req, res) => {
    const rawTag = req.body?.tag;
    if (rawTag !== undefined && rawTag !== null && typeof rawTag !== 'string') {
      throw Errors.validation('tag 必须是字符串');
    }
    const now = Date.now();
    if (backupCreateInFlight) throw new AppError('TOO_MANY_REQUESTS', '备份正在生成，请稍后重试', 429);
    if (now - lastBackupCreateStartedAt < backupCreateCooldownMs) {
      throw new AppError('TOO_MANY_REQUESTS', '备份创建过于频繁，请 5 秒后重试', 429);
    }
    backupCreateInFlight = true;
    lastBackupCreateStartedAt = now;
    try {
      const result = await backup.createBackup(db(), backup.backupDirOf(opts.dbPath), rawTag ?? '');
      res.json(result);
    } finally {
      backupCreateInFlight = false;
    }
  }));
  app.get('/api/backup/verify', wrap((req, res) => {
    const file = queryString(req.query.file, 'file');
    if (!file) throw Errors.validation('file 不能为空');
    const rawScope = queryString(req.query.scope, 'scope');
    if (rawScope !== undefined && rawScope !== 'daily' && rawScope !== 'monthly') {
      throw Errors.validation('scope 必须为 daily 或 monthly');
    }
    const scope = rawScope === 'monthly' ? 'monthly' : 'daily';
    res.json(backup.verifyBackupFile(backup.resolveBackupFile(backup.backupDirOf(opts.dbPath), file, scope)));
  }));
  app.post('/api/backup/restore', wrap(async (req, res) => {
    const { file, scope, confirmed } = req.body ?? {};
    if (confirmed !== true) throw Errors.validation('恢复需二次确认(confirmed=true)');
    if (restoreInFlight) throw new AppError('RESTORE_IN_PROGRESS', '已有恢复操作进行中,请等待完成后再试', 409);
    const target = backup.resolveBackupFile(backup.backupDirOf(opts.dbPath), String(file ?? ''), scope === 'monthly' ? 'monthly' : 'daily');
    restoreInFlight = true;
    try {
      const result = await backup.restoreBackup(holder, opts.dbPath, target, confirmed);
      res.json(result);
    } finally {
      restoreInFlight = false;
    }
  }));

  /* ============ 一致性检查 ============ */
  app.get('/api/check/consistency', wrap((_req, res) => res.json(runConsistencyChecks(db()))));

  /* ============ 迁移管理 ============ */
  app.get('/api/migrations', wrap((_req, res) => {
    const applied = appliedMigrations(db());
    res.json({
      applied,
      pending: MIGRATIONS.filter((m) => !applied.some((a) => a.version === m.version)).map((m) => ({ version: m.version, name: m.name })),
    });
  }));
  app.post('/api/migrations/apply', wrap(async (req, res) => {
    const { confirmed } = req.body ?? {};
    if (confirmed !== true) throw Errors.validation('迁移前将自动备份,需确认(confirmed=true)');
    await backup.createBackup(db(), backup.backupDirOf(opts.dbPath), 'pre-migrate');
    const applied = applyMigrations(db());
    for (const m of applied) writeLog(db(), 'migration.apply', 'schema_migration', m.version, { name: m.name });
    res.json({ applied: applied.map((m) => ({ version: m.version, name: m.name })) });
  }));

  /* ============ 仪表盘 ============ */
  app.get('/api/dashboard', wrap((_req, res) => {
    res.json(dashboardOverview(db()));
  }));

  /* ============ 前端静态文件(单机部署:React 构建产物由本服务托管) ============ */
  const distDir = process.env.NEWFC_FRONTEND_DIST || path.join(__dirname, '../../frontend/dist');
  if (fs.existsSync(distDir)) {
    app.use(express.static(distDir));
    app.get(/^\/(?!api).*/, (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  /* ============ 错误处理 ============ */
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const requestId = requestContextOf(res)?.requestId;
    if (err instanceof AppError) {
      res.status(err.status).json({ ...errorBody(err), requestId });
      return;
    }
    if (err instanceof multer.MulterError) {
      res.status(400).json({ code: 'UPLOAD_FAILED', message: `上传失败: ${err.message}`, requestId });
      return;
    }
    // 内部异常细节只进日志不回传客户端(SQL/路径等信息不外泄);
    // body-parser 等中间件错误自带 4xx status:保留状态码,同样不回传原文
    const status = (err as { status?: unknown }).status;
    console.error(`[unhandled] requestId=${requestId ?? '-'}`, err);
    if (typeof status === 'number' && status >= 400 && status < 500) {
      res.status(status).json({ code: 'REQUEST_REJECTED', message: '请求格式或大小不符合要求', requestId });
      return;
    }
    res.status(500).json({ code: 'INTERNAL_ERROR', message: '服务器内部错误,详情见服务端日志', requestId });
  });

  return { app, holder, cleaningUploads };
}

/** 独立启动入口 */
export async function startServer(opts: ServerOptions) {
  const port = opts.port ?? 3760;
  const host = opts.host ?? '127.0.0.1';
  // 先做无副作用的端口探测，避免重复启动时先迁移/备份生产库，最后才因 EADDRINUSE 崩溃。
  await new Promise<void>((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, host, () => probe.close((error) => error ? reject(error) : resolve()));
  });
  const { app, holder } = await createApp(opts);
  const server = app.listen(port, host);
  // 空闲长连接保持时间长于常见客户端/反代的复用窗口,避免服务端恰在客户端复用时关闭连接(ECONNRESET);
  // headersTimeout 须大于 keepAliveTimeout。
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.once('listening', () => {
      server.off('error', onError);
      resolve();
    });
  });
  console.log(`newfc 后端已启动: http://${host}:${port}`);
  server.on('error', (error) => console.error('[server]', error));
  // 定时自动备份(方案十三.1:每天一次;重启即重置,个人系统足够)
  const backupHours = opts.backupCronHours ?? 24;
  const timer = setInterval(() => {
    backup.createBackup(holder.getDb(), backup.backupDirOf(opts.dbPath)).catch((e) => console.error('[backup]', e));
  }, backupHours * 3600 * 1000);
  timer.unref();
  // 优雅停止:停止接收新连接、关闭数据库(WAL 检查点)后退出;超时强停交给 systemd TimeoutStopSec,
  // 下次启动由各恢复逻辑识别中断任务。
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[shutdown] 收到 ${signal}，停止接收新请求`);
    clearInterval(timer);
    server.close(() => {
      try { holder.getDb().close(); } catch (error) { console.error('[shutdown] 关闭数据库失败', error); }
      console.log('[shutdown] 已关闭数据库，退出');
      process.exit(0);
    });
    // 长连接(SSE)不会自行结束:给在途请求短暂收尾时间后强制断开
    setTimeout(() => server.closeAllConnections?.(), 5000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}
