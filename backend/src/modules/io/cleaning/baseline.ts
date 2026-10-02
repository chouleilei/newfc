import crypto from 'crypto';
import type { DB } from '../../../db/connection';
import { Errors } from '../../../core/errors';
import { readCurrentTreeDefinition } from '../../tree/snapshot';
import * as budget from '../../budget/budget.service';
import * as actual from '../../actual/actual.service';
import type { CleaningTarget } from './plan';

export interface CleaningBaselineV1 {
  version: 1;
  actualCurrentBatchId?: number | null;
  orgTreeHash?: string;
  accountTreeHash?: string;
  actualYearHash?: string;
  budgetRevision?: number;
}

function currentTreeHash(db: DB, treeType: 'org' | 'account'): string {
  return readCurrentTreeDefinition(db, treeType).hash;
}

function actualYearHash(db: DB, year: number): string {
  const rows = db.prepare(
    `SELECT org_id, account_id, cumulative_amount_cents, quantity, memo
     FROM actual_current WHERE year = ? ORDER BY org_id, account_id`,
  ).all(year);
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function createCleaningBaseline(
  db: DB,
  target: CleaningTarget,
  options: { includeWholeActualYear?: boolean; includeWholeBudgetVersion?: boolean } = {},
): CleaningBaselineV1 {
  if (target.targetKind === 'budget') {
    const version = budget.getVersion(db, target.versionId!);
    return {
      version: 1,
      ...(options.includeWholeBudgetVersion ? { budgetRevision: version.revision } : {}),
    };
  }
  const state = actual.getYearState(db, target.year!);
  return {
    version: 1,
    actualCurrentBatchId: state?.current_batch_id ?? null,
    orgTreeHash: currentTreeHash(db, 'org'),
    accountTreeHash: currentTreeHash(db, 'account'),
    ...(options.includeWholeActualYear ? { actualYearHash: actualYearHash(db, target.year!) } : {}),
  };
}

export function assertCleaningBaseline(db: DB, target: CleaningTarget, baseline: unknown): void {
  if (!baseline || typeof baseline !== 'object' || (baseline as { version?: unknown }).version !== 1) {
    throw Errors.conflict('清洗导入基线格式无效，请取消后重新预览');
  }
  const value = baseline as CleaningBaselineV1;
  if (target.targetKind === 'budget') {
    if (value.budgetRevision !== undefined && budget.getVersion(db, target.versionId!).revision !== value.budgetRevision) {
      throw Errors.conflict('预算导入预览后版本修订已变化，请重新预览');
    }
    return;
  }
  const state = actual.getYearState(db, target.year!);
  if (value.actualCurrentBatchId !== (state?.current_batch_id ?? null)) {
    throw Errors.conflict('当前实际数预览后年度当前批次已变化，请重新预览');
  }
  if (typeof value.orgTreeHash !== 'string' || currentTreeHash(db, 'org') !== value.orgTreeHash) {
    throw Errors.conflict('当前实际数预览后组织树口径已变化，请重新预览');
  }
  if (typeof value.accountTreeHash !== 'string' || currentTreeHash(db, 'account') !== value.accountTreeHash) {
    throw Errors.conflict('当前实际数预览后科目树口径已变化，请重新预览');
  }
  if (value.actualYearHash !== undefined && actualYearHash(db, target.year!) !== value.actualYearHash) {
    throw Errors.conflict('当前实际数预览后该年度其他单元格已变化，请重新预览');
  }
}
