import crypto from 'crypto';
import { z } from 'zod';
import type { DB } from '../db/connection';
import type { AuthContext } from '../core/request-context';
import { AppError, Errors } from '../core/errors';
import { validateInput, positiveId } from '../core/input';
import type { CleaningUploadStore } from '../modules/io/cleaning/upload-store';
import { loadCleaningWorkbook } from '../modules/io/cleaning/workbook';
import { parseCleaningPlan, parseCleaningTarget, assertTargetMatchesPlan } from '../modules/io/cleaning/plan';
import { applyCleaningPlan } from '../modules/io/cleaning/apply';
import { analyzeCleaningImpact, assertCleaningPreviewOwner, recoverCleaningPlanAndTarget } from '../modules/io/cleaning/preview';
import { getBatch, assertImportPreviewBaseline } from '../modules/import/import.service';
import type { NormalizedDraft } from './draft-context';
import type { PageScope } from '../contracts/assistant';

export const cleaningDraftSchema = z.object({ plan: z.unknown(), target: z.unknown(), name: z.string().max(100).optional() }).strict();
export const cleaningSourceSchema = z.union([
  z.object({ token: z.string().uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/i) }).strict(),
  z.object({ batchId: positiveId, sha256: z.string().regex(/^[0-9a-f]{64}$/i) }).strict(),
]);

/** 在 HTTP/SSE 响应头及模型调用前完成有界文件读取；不续期或创建导入预览。 */
export async function analyzeCleaningDraft(db: DB, draft: NormalizedDraft, scope: PageScope, auth: AuthContext | undefined, uploads?: CleaningUploadStore, signal?: AbortSignal): Promise<void> {
  const fields = validateInput(cleaningDraftSchema, draft.config?.fields);
  const plan = parseCleaningPlan(fields.plan);
  const target = parseCleaningTarget(fields.target);
  assertTargetMatchesPlan(target, plan);
  if (target.targetKind === 'budget' ? target.versionId !== scope.budgetVersionId : target.year !== scope.year) throw new AppError('CONTEXT_CONFLICT', '清洗草稿目标与页面范围冲突', 409);
  const source = validateInput(cleaningSourceSchema, draft.fileSource);
  let buffer: Buffer;
  if ('token' in source) {
    if (!uploads) throw Errors.notFound('清洗暂存服务');
    buffer = uploads.readOwned(source.token, auth?.userId ?? 0, { targetKind: target.targetKind, sha256: source.sha256 }).buffer;
  } else {
    assertCleaningPreviewOwner(db, source.batchId, auth);
    const batch = getBatch(db, source.batchId);
    if (batch.created_by_user_id !== (auth?.userId ?? null)) throw Errors.forbidden('无权分析此清洗预览');
    if (batch.status !== 'pending' || !batch.file_blob || Date.now() - Date.parse(batch.created_at) >= 7 * 24 * 3600 * 1000) throw new AppError('DRAFT_STALE', '清洗预览已失效，请重新上传', 409);
    if (batch.sha256 !== source.sha256 || crypto.createHash('sha256').update(batch.file_blob).digest('hex') !== source.sha256) throw Errors.conflict('清洗预览指纹已变化');
    if ((target.targetKind === 'budget' && batch.target_version_id !== target.versionId) || (target.targetKind === 'actual-current' && batch.kind !== 'actual')) throw Errors.conflict('清洗预览目标不一致');
    const original = recoverCleaningPlanAndTarget(batch).target;
    if (!original || JSON.stringify(original) !== JSON.stringify(target)) throw Errors.conflict('清洗预览目标或截止日期不一致');
    try { assertImportPreviewBaseline(db, batch); } catch (error) {
      if (error instanceof AppError && error.code === 'CONFLICT') throw new AppError('DRAFT_STALE', '清洗预览基线已变化，请重新检查导入结果', 409);
      throw error;
    }
    buffer = batch.file_blob;
  }
  const workbook = await loadCleaningWorkbook(buffer);
  signal?.throwIfAborted();
  const analysis = applyCleaningPlan(db, workbook, target, plan);
  const impact = analyzeCleaningImpact(db, analysis);
  const affected = new Set(analysis.rows.filter((row) => row.targetOrgId != null).map((row) => row.targetOrgId));
  if (affected.size > 500) throw new AppError('CONTEXT_TOO_LARGE', '清洗分析超过 500 个组织，请缩小区域', 413);
  draft.issues = analysis.errors.map((issue) => `数据行 ${issue.row} · ${issue.field} · ${issue.code}`).slice(0, 30);
  draft.analysis = {
    issues: draft.issues,
    explanation: [
      `当前未保存清洗计划：${plan.sheets.length} 个工作表，${plan.columns.length} 项列映射，${analysis.counts.selected} 行选中、${analysis.counts.effective} 行有效、${analysis.counts.excluded} 行排除。`,
      `${analysis.counts.errors} 项错误、${analysis.counts.unresolved} 项未匹配名称、${analysis.counts.warnings} 项提醒${analysis.errors.length > 30 ? '（错误详情仅显示前 30 项）' : ''}。`,
      `口径：${plan.valueKind === 'quantity' ? '数量（与金额隔离）' : `${plan.amountUnit === 'wan' ? '万元' : '元'}，${plan.signConvention === 'profit_signed' ? '利润方向' : '展示正数'}`}。`,
      `覆盖影响已按同源预览规则核验：${JSON.stringify((impact.summary as { actions?: unknown }).actions)}；未创建导入批次或保存模板、别名。`,
    ],
  };
}
