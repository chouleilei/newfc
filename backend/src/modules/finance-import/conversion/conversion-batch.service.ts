import crypto from 'crypto';
import type { DB } from '../../../db/connection';
import { Errors } from '../../../core/errors';
import { signOfType, yuanStringToCents, type AccountType } from '../../../core/money';
import { parseActualImport, resolveActualImport } from '../../io/excel';
import * as imports from '../../import/import.service';
import { buildStandardActualPreview } from '../../import/preview-detail';
import { convertFinanceActuals } from './convert.service';
import type { FinanceValidationReport } from '../finance.types';
import { writeLog } from '../../audit/log';
import { expandOwnedLeafScope } from '../owned-scope';

export interface ConversionBatchRow {
  id: number;
  source_profile_id: number;
  mapping_version_id: number;
  year: number;
  snapshot_date: string;
  status: 'parsing' | 'blocked' | 'validated' | 'imported' | 'cancelled';
  revision_of_id: number | null;
  balance_name: string;
  balance_sha256: string;
  balance_blob: Buffer;
  profit_name: string;
  profit_sha256: string;
  profit_blob: Buffer;
  journal_name: string | null;
  journal_sha256: string | null;
  journal_blob: Buffer | null;
  profile_adapter_type: string;
  profile_config_json: string;
  normalized_json: string;
  validation_json: string;
  output_sha256: string | null;
  output_blob: Buffer | null;
  import_batch_id: number | null;
  created_at: string;
  validated_at: string | null;
  imported_at: string | null;
  cancelled_at: string | null;
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

export function getConversion(db: DB, id: number): ConversionBatchRow {
  const row = db.prepare('SELECT * FROM finance_conversion_batch WHERE id=?').get(id) as ConversionBatchRow | undefined;
  if (!row) throw Errors.notFound('财务转换批次');
  if (row.import_batch_id) {
    const downstream = db.prepare('SELECT status FROM import_batch WHERE id=?').get(row.import_batch_id) as { status: string } | undefined;
    if (downstream?.status === 'committed' && row.status === 'validated') {
      db.prepare("UPDATE finance_conversion_batch SET status='imported',imported_at=COALESCE(imported_at,?) WHERE id=?").run(new Date().toISOString(), id);
      row.status = 'imported';
    } else if (downstream?.status === 'rolled_back' && row.status === 'imported') {
      db.prepare("UPDATE finance_conversion_batch SET status='validated',imported_at=NULL WHERE id=?").run(id);
      row.status = 'validated';
    }
  }
  return row;
}

/**
 * validation_json 只在转换正常结束后才是完整报告:parsing 批次是占位 '{}',
 * 取消解析中批次也不会补齐。不完整时返回 null,由前端显示「报告尚未生成」,
 * 避免把缺 counts/hashes 的半成品当完整报告解引用。
 */
export function parseValidation(row: ConversionBatchRow): FinanceValidationReport | null {
  try {
    const parsed = JSON.parse(row.validation_json) as Partial<FinanceValidationReport>;
    if (!parsed || typeof parsed !== 'object' || !parsed.counts || !parsed.hashes || !parsed.conservation) return null;
    return parsed as FinanceValidationReport;
  } catch {
    return null;
  }
}

export function publicConversion(row: ConversionBatchRow) {
  const { balance_blob, profit_blob, journal_blob, output_blob, normalized_json, ...rest } = row;
  return { ...rest, validation: parseValidation(row), hasJournal: Boolean(journal_blob), hasOutput: Boolean(output_blob) };
}

export function listConversions(db: DB, limit = 100) {
  const ids = db.prepare('SELECT id FROM finance_conversion_batch ORDER BY id DESC LIMIT ?').all(Math.min(500, Math.max(1, limit))) as { id: number }[];
  return ids.map((r) => publicConversion(getConversion(db, r.id)));
}

export interface RevisionResultSummary { count: number; added: number; modified: number; cleared: number }

export interface RevisionTarget {
  id: number;
  status: ConversionBatchRow['status'];
  mappingVersionId: number;
  revisionOfId: number | null;
  createdAt: string;
  importedAt: string | null;
  importBatchId: number | null;
  importBatchStatus: string | null;
  resultSummary: RevisionResultSummary | null;
}

export interface RevisionTargetResult {
  sourceProfileId: number;
  year: number;
  snapshotDate: string;
  target: RevisionTarget | null;
  revisable: boolean;
  reasonCode: 'ok' | 'no_prior_batch' | 'parsing_in_flight';
  reason: string | null;
}

/**
 * UX-18 修订目标只读查询:按数据源+年度+截止日直接 SQL 定位最新成功批次
 * (status validated/imported,与 createConversion 的期间占用同一口径),不经过默认
 * 前 100 条列表——默认列表之外的旧期间也能找到正确对象。
 * 可修订状态与创建校验保持同语义:同期间存在解析中批次时不可发起(创建同样会被拒绝);
 * 「已有更新批次」不做特殊状态——查询始终返回最新成功批次,旧批次的过时修订由
 * createConversion 的 revisionOfId 校验拒绝。
 */
export function findRevisionTarget(db: DB, sourceProfileId: number, year: number, snapshotDate: string): RevisionTargetResult {
  const profile = db.prepare('SELECT id FROM finance_source_profile WHERE id=?').get(sourceProfileId);
  if (!profile) throw Errors.notFound('财务数据源');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(snapshotDate) || Number(snapshotDate.slice(0, 4)) !== year) {
    throw Errors.validation('年度和截止日期不合法');
  }
  const latest = db.prepare(
    "SELECT id FROM finance_conversion_batch WHERE source_profile_id=? AND year=? AND snapshot_date=? AND status IN ('validated','imported') ORDER BY id DESC LIMIT 1",
  ).get(sourceProfileId, year, snapshotDate) as { id: number } | undefined;
  const parsing = db.prepare(
    "SELECT id FROM finance_conversion_batch WHERE source_profile_id=? AND year=? AND snapshot_date=? AND status='parsing' ORDER BY id DESC LIMIT 1",
  ).get(sourceProfileId, year, snapshotDate) as { id: number } | undefined;

  const base = { sourceProfileId, year, snapshotDate };
  if (!latest) {
    return {
      ...base,
      target: null,
      revisable: false,
      reasonCode: parsing ? 'parsing_in_flight' : 'no_prior_batch',
      reason: parsing
        ? `该期间批次 #${parsing.id} 正在解析，尚无成功批次可修订`
        : '该数据源在该年度与截止日尚无成功批次，本次为首次导入，无需修订',
    };
  }
  // getConversion 同步 validated/imported 与下游提交/撤销状态,保证目标状态与列表一致
  const row = getConversion(db, latest.id);
  let importBatchStatus: string | null = null;
  let resultSummary: RevisionResultSummary | null = null;
  if (row.import_batch_id) {
    const downstream = db.prepare('SELECT status,summary_json FROM import_batch WHERE id=?').get(row.import_batch_id) as { status: string; summary_json: string } | undefined;
    importBatchStatus = downstream?.status ?? null;
    try {
      const summary = JSON.parse(downstream?.summary_json ?? '{}') as Partial<RevisionResultSummary>;
      if (typeof summary.count === 'number' && typeof summary.added === 'number' && typeof summary.modified === 'number' && typeof summary.cleared === 'number') {
        resultSummary = { count: summary.count, added: summary.added, modified: summary.modified, cleared: summary.cleared };
      }
    } catch { /* 旧批次摘要字段不全时按无摘要处理 */ }
  }
  return {
    ...base,
    target: {
      id: row.id,
      status: row.status,
      mappingVersionId: row.mapping_version_id,
      revisionOfId: row.revision_of_id,
      createdAt: row.created_at,
      importedAt: row.imported_at,
      importBatchId: row.import_batch_id,
      importBatchStatus,
      resultSummary,
    },
    revisable: !parsing,
    reasonCode: parsing ? 'parsing_in_flight' : 'ok',
    reason: parsing ? `该期间批次 #${parsing.id} 正在解析，请等待其完成或先取消后再发起修订` : null,
  };
}

function failedReport(
  hashes: { balanceSha256: string; profitSha256: string; journalSha256?: string },
  code: string,
  message: string,
): FinanceValidationReport {
  return {
    passed: false,
    counts: { sourceRows: 0, nonZeroRows: 0, organizations: 0, sourceAccounts: 0, outputRows: 0 },
    errors: [{ gate: 'parse', code, message }],
    warnings: [],
    conservation: { sourceCents: 0, allocatedCents: 0, differenceCents: 0, passed: false },
    reconciliations: [],
    hashes,
  };
}

function blockedReport(balanceSha256: string, profitSha256: string, error: unknown, journalSha256?: string): FinanceValidationReport {
  return failedReport(
    { balanceSha256, profitSha256, ...(journalSha256 ? { journalSha256 } : {}) },
    'CONVERSION_FAILED',
    error instanceof Error ? error.message : String(error),
  );
}

function interruptedReport(row: ConversionBatchRow): FinanceValidationReport {
  return failedReport(
    {
      balanceSha256: row.balance_sha256,
      profitSha256: row.profit_sha256,
      ...(row.journal_sha256 ? { journalSha256: row.journal_sha256 } : {}),
    },
    'CONVERSION_INTERRUPTED',
    '转换在服务中断时未完成，已按失败关闭；源文件与摘要哈希已保留，请重新发起转换',
  );
}

/**
 * 启动恢复:parsing 批次在插入后即已提交,进程在转换完成前被杀会留下永远不会再推进的
 * 「解析中」记录。这里统一按失败关闭为 blocked 并写入完整中断报告——不复用 cancelled,
 * 因为取消表示人的主动动作。恢复后同期间可立即重新转换(blocked 不参与期间占用)。
 */
export function recoverInterruptedConversions(db: DB): number {
  const rows = db.prepare("SELECT * FROM finance_conversion_batch WHERE status='parsing'").all() as ConversionBatchRow[];
  if (rows.length === 0) return 0;
  const update = db.prepare("UPDATE finance_conversion_batch SET status='blocked',validation_json=? WHERE id=? AND status='parsing'");
  db.transaction((items: ConversionBatchRow[]) => {
    for (const row of items) {
      update.run(JSON.stringify(interruptedReport(row)), row.id);
      writeLog(db, 'finance.conversion.recover', 'finance_conversion_batch', row.id, {
        sourceProfileId: row.source_profile_id,
        mappingVersionId: row.mapping_version_id,
        year: row.year,
        snapshotDate: row.snapshot_date,
        reason: 'CONVERSION_INTERRUPTED',
      });
    }
  })(rows);
  return rows.length;
}

function assertScopeNotOverlapping(db: DB, profileId: number) {
  const profiles = db.prepare("SELECT id,config_json FROM finance_source_profile WHERE status='active' AND id<>?").all(profileId) as { id: number; config_json: string }[];
  const own = JSON.parse((db.prepare('SELECT config_json FROM finance_source_profile WHERE id=?').get(profileId) as { config_json: string }).config_json);
  const ownScope = expandOwnedLeafScope(db, own);
  for (const p of profiles) {
    const other = JSON.parse(p.config_json || '{}');
    const otherScope = expandOwnedLeafScope(db, other);
    const orgOverlap = [...ownScope.orgIds].some((x) => otherScope.orgIds.has(x));
    const accountOverlap = [...ownScope.accountIds].some((x) => otherScope.accountIds.has(x));
    if (orgOverlap && accountOverlap) throw Errors.conflict(`数据源拥有范围与数据源 #${p.id} 冲突`);
  }
}

export async function createConversion(db: DB, input: {
  sourceProfileId: number;
  mappingVersionId: number;
  year: number;
  snapshotDate: string;
  balanceName: string;
  balance: Buffer;
  profitName: string;
  profit: Buffer;
  journalName?: string;
  journal?: Buffer;
  revisionOfId?: number;
  actor?: string;
}): Promise<ConversionBatchRow> {
  const profile = db.prepare('SELECT * FROM finance_source_profile WHERE id=?').get(input.sourceProfileId) as { id: number; status: string; adapter_type: string; config_json: string } | undefined;
  if (!profile || profile.status !== 'active') throw Errors.validation('数据源不存在或已停用');
  const mapping = db.prepare('SELECT * FROM finance_mapping_version WHERE id=?').get(input.mappingVersionId) as { id: number; source_profile_id: number; status: string; org_tree_snapshot_id: number; account_tree_snapshot_id: number } | undefined;
  if (!mapping || mapping.source_profile_id !== profile.id || mapping.status !== 'locked') throw Errors.validation('映射版本不属于该数据源或未锁定');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.snapshotDate) || Number(input.snapshotDate.slice(0, 4)) !== input.year) throw Errors.validation('年度和截止日期不合法');
  assertScopeNotOverlapping(db, profile.id);
  const balanceSha256 = sha(input.balance);
  const profitSha256 = sha(input.profit);
  const journalSha256 = input.journal ? sha(input.journal) : undefined;
  const duplicate = db.prepare("SELECT id FROM finance_conversion_batch WHERE balance_sha256=? AND profit_sha256=? AND mapping_version_id=? AND status='imported'").get(balanceSha256, profitSha256, mapping.id) as { id: number } | undefined;
  if (duplicate) throw Errors.conflict(`相同原件和映射已成功导入(批次 #${duplicate.id})`);
  const period = db.prepare("SELECT id FROM finance_conversion_batch WHERE source_profile_id=? AND year=? AND snapshot_date=? AND status IN ('validated','imported') ORDER BY id DESC LIMIT 1").get(profile.id, input.year, input.snapshotDate) as { id: number } | undefined;
  if (period && !input.revisionOfId) throw Errors.conflict(`该期间已有成功批次 #${period.id}，必须指定 revisionOfId 创建修订`);
  if (input.revisionOfId && (!period || input.revisionOfId !== period.id)) throw Errors.validation('revisionOfId 必须指向该数据源、期间的最新成功批次');
  const now = new Date().toISOString();
  // 同期间活动批次检查与插入必须在同一事务:两个并发请求各自看到「无 parsing」再先后插入,
  // 会绕过 revisionOfId 修订链得到两个同期间成功批次。better-sqlite3 同步事务保证交错安全。
  const id = db.transaction(() => {
    const active = db.prepare("SELECT id FROM finance_conversion_batch WHERE source_profile_id=? AND year=? AND snapshot_date=? AND status='parsing' LIMIT 1").get(profile.id, input.year, input.snapshotDate) as { id: number } | undefined;
    if (active) throw Errors.conflict(`该期间批次 #${active.id} 正在解析，请等待其完成或先取消后再试`);
    const info = db.prepare(`INSERT INTO finance_conversion_batch(source_profile_id,mapping_version_id,year,snapshot_date,status,revision_of_id,balance_name,balance_sha256,balance_blob,profit_name,profit_sha256,profit_blob,journal_name,journal_sha256,journal_blob,profile_adapter_type,profile_config_json,created_at)VALUES(?,?,?,?,'parsing',?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      profile.id, mapping.id, input.year, input.snapshotDate, input.revisionOfId ?? null,
      input.balanceName.slice(0, 255), balanceSha256, input.balance,
      input.profitName.slice(0, 255), profitSha256, input.profit,
      input.journalName?.slice(0, 255) ?? null, journalSha256 ?? null, input.journal ?? null,
      profile.adapter_type, profile.config_json, now,
    );
    return Number(info.lastInsertRowid);
  })();
  try {
    const result = await convertFinanceActuals(db, {
      balance: input.balance, profit: input.profit, journal: input.journal,
      year: input.year, snapshotDate: input.snapshotDate,
      profile, mappingVersion: mapping,
      balanceSha256, profitSha256, journalSha256, conversionBatchId: id,
    });
    // CAS:用户在解析期间可以取消批次;状态已离开 parsing 时保留终态,不回写转换结果
    db.prepare(`UPDATE finance_conversion_batch SET status=?,normalized_json=?,validation_json=?,output_sha256=?,output_blob=?,validated_at=? WHERE id=? AND status='parsing'`).run(
      result.report.passed ? 'validated' : 'blocked',
      JSON.stringify({ balance: result.normalized, profit: result.profits }),
      JSON.stringify(result.report),
      result.report.hashes.outputSha256 ?? null,
      result.output ?? null,
      result.report.passed ? new Date().toISOString() : null,
      id,
    );
  } catch (error) {
    db.prepare("UPDATE finance_conversion_batch SET status='blocked',validation_json=? WHERE id=? AND status='parsing'").run(
      JSON.stringify(blockedReport(balanceSha256, profitSha256, error, journalSha256)), id,
    );
  }
  const created = getConversion(db, id);
  writeLog(db, 'finance.conversion.create', 'finance_conversion_batch', id, {
    actor: input.actor ?? '',
    sourceProfileId: profile.id,
    mappingVersionId: mapping.id,
    year: input.year,
    snapshotDate: input.snapshotDate,
    status: created.status,
    balanceSha256, profitSha256, journalSha256,
  });
  return created;
}

function currentBaseline(db: DB, resolved: ReturnType<typeof resolveActualImport>): string {
  const keys = resolved.batches.flatMap((g) => g.entries.map((e) => `${g.year}:${e.orgId}:${e.accountId}`));
  const rows = db.prepare('SELECT year,org_id,account_id,cumulative_amount_cents,quantity,updated_at FROM actual_current ORDER BY year,org_id,account_id').all() as { year: number; org_id: number; account_id: number }[];
  return sha(Buffer.from(JSON.stringify(rows.filter((r) => keys.includes(`${r.year}:${r.org_id}:${r.account_id}`)))));
}

export interface ImportPreviewResult {
  importBatchId: number;
  sha256: string;
  count: number;
  added: number;
  modified: number;
  cleared: number;
  changesByOrgAndRoot?: { orgCode: string; rootAccountCode: string; changeCents: number }[];
}

/**
 * 创建导入预览。输出 Excel 只解析一次:新增/修改/清零统计、基线和按组织×根科目变化额
 * 全部基于同一份解析结果与同一 actual_current 基线,避免此前「先建预览再二次解析算摘要」
 * 造成的重复 CPU 与两阶段基线不一致。
 */
async function createImportPreviewCore(db: DB, id: number, withChanges: boolean): Promise<ImportPreviewResult> {
  const batch = getConversion(db, id);
  if (batch.status !== 'validated' || !batch.output_blob) throw Errors.conflict('只有校验通过的转换批次可创建导入预览');
  // 撤销/取消过的下游导入批次已失效,清除旧链接后允许重新预览(否则撤销后永久无法再导入);
  // pending 链接是已存在的有效预览,committed 由下方 sha256 查重兜底,均保留。
  if (batch.import_batch_id) {
    const downstream = db.prepare('SELECT status FROM import_batch WHERE id=?').get(batch.import_batch_id) as { status: string } | undefined;
    if (downstream && downstream.status === 'rolled_back') {
      db.prepare('UPDATE finance_conversion_batch SET import_batch_id=NULL WHERE id=?').run(id);
      batch.import_batch_id = null;
    } else if (downstream && downstream.status !== 'cancelled') {
      throw Errors.conflict('该转换批次已创建导入预览');
    }
  }
  const duplicate = db.prepare("SELECT id FROM import_batch WHERE sha256=? AND status IN ('pending','committed')").get(batch.output_sha256) as { id: number } | undefined;
  if (duplicate) throw Errors.conflict(`标准文件已有有效导入批次 #${duplicate.id}`);
  const parsed = await parseActualImport(batch.output_blob, db);
  const resolved = resolveActualImport(db, parsed, false);
  const existing = new Map((db.prepare('SELECT year,org_id,account_id,cumulative_amount_cents FROM actual_current WHERE year=?').all(batch.year) as { year: number; org_id: number; account_id: number; cumulative_amount_cents: number }[]).map((r) => [`${r.org_id}:${r.account_id}`, r.cumulative_amount_cents]));
  const orgByCode = new Map((db.prepare('SELECT id,code FROM org').all() as { id: number; code: string }[]).map((r) => [r.code, r.id]));
  const accounts = db.prepare('SELECT id,parent_id,code,type FROM account').all() as { id: number; parent_id: number | null; code: string; type: AccountType }[];
  const accountByCode = new Map(accounts.map((r) => [r.code, r]));
  const accountById = new Map(accounts.map((r) => [r.id, r]));
  const rootCodeOf = (account: { id: number; parent_id: number | null; code: string }): string => {
    let current = account;
    while (current.parent_id != null) {
      const parent = accountById.get(current.parent_id);
      if (!parent) break;
      current = parent;
    }
    return current.code;
  };
  let added = 0;
  let modified = 0;
  let cleared = 0;
  const grouped = new Map<string, number>();
  for (const row of parsed.rows) {
    const orgId = orgByCode.get(row.orgCode);
    const account = accountByCode.get(row.accountCode);
    if (!orgId || !account) continue;
    const key = `${orgId}:${account.id}`;
    const old = existing.get(key);
    const next = yuanStringToCents(row.amountText || '0')! * signOfType(account.type);
    if (old === undefined && next !== 0) added++;
    else if (old !== undefined && old !== next) {
      if (next === 0) cleared++;
      else modified++;
    }
    if (withChanges) {
      const groupKey = `${row.orgCode}|${rootCodeOf(account)}`;
      grouped.set(groupKey, (grouped.get(groupKey) ?? 0) + next - (old ?? 0));
    }
  }
  const changesByOrgAndRoot = withChanges
    ? [...grouped.entries()].map(([key, changeCents]) => {
      const [orgCode, rootAccountCode] = key.split('|');
      return { orgCode, rootAccountCode, changeCents };
    })
    : undefined;
  const baseline = currentBaseline(db, resolved);
  // UX-14 适配:财务转换输出即标准实际文件,统一差异按同一构建器冻结
  // (基线为同一 actual_current 快照;源行来自输出文件的解析行);
  // payload 只存可执行输入,确认/撤销语义不变。
  const unifiedPreview = buildStandardActualPreview(db, { history: false, batches: resolved.batches, source: 'finance' });
  const created = imports.createBatch(db, {
    kind: 'actual',
    originalName: `finance-conversion-${id}.xlsx`,
    file: batch.output_blob,
    payload: { history: false, note: `财务转换批次 #${id}`, batches: resolved.batches.map((group) => ({ year: group.year, snapshotDate: group.snapshotDate, entries: group.entries })) },
    summary: {
      financeConversionId: id,
      mappingVersionId: batch.mapping_version_id,
      balanceSha256: batch.balance_sha256,
      profitSha256: batch.profit_sha256,
      journalSha256: batch.journal_sha256,
      reconciled: true,
      journalVerified: Boolean(batch.journal_sha256),
      baseline, added, modified, cleared,
      count: resolved.entries.length,
      ...(changesByOrgAndRoot ? { changesByOrgAndRoot } : {}),
    },
    preview: unifiedPreview,
  });
  // 回写链接必须是条件更新:parseActualImport 让出事件循环期间,转换可能已被取消,
  // 或另一并发预览已抢先建链(两处窗口都会留下永远 pending 的孤儿批次)。
  const linked = db.prepare("UPDATE finance_conversion_batch SET import_batch_id=? WHERE id=? AND status='validated' AND import_batch_id IS NULL").run(created.id, id);
  if (linked.changes === 0) {
    imports.cancelBatch(db, created.id);
    throw Errors.conflict('转换批次状态已变化或已存在导入预览,本次预览已取消');
  }
  return { importBatchId: created.id, sha256: created.sha256, count: resolved.entries.length, added, modified, cleared, ...(changesByOrgAndRoot ? { changesByOrgAndRoot } : {}) };
}

export function createImportPreview(db: DB, id: number): Promise<ImportPreviewResult> {
  return createImportPreviewCore(db, id, false);
}

export function createImportPreviewWithSummary(db: DB, id: number): Promise<ImportPreviewResult> {
  return createImportPreviewCore(db, id, true);
}

export function cancelConversion(db: DB, id: number, actor = '') {
  const b = getConversion(db, id);
  if (b.status === 'imported') throw Errors.conflict('已导入批次不能取消，请先撤销下游导入');
  db.transaction(() => {
    if (b.import_batch_id) {
      const child = imports.getBatch(db, b.import_batch_id);
      if (child.status === 'pending') imports.cancelBatch(db, child.id);
    }
    db.prepare("UPDATE finance_conversion_batch SET status='cancelled',cancelled_at=? WHERE id=?").run(new Date().toISOString(), id);
    writeLog(db, 'finance.conversion.cancel', 'finance_conversion_batch', id, { actor, previousStatus: b.status, importBatchId: b.import_batch_id });
  })();
}
