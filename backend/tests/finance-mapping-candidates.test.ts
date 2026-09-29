/**
 * AI 功能增强计划 §四.阶段二验收:
 * - 迁移 V29/V30:映射行 provenance 列默认值、别名表 target_kind 扩展为 finance、
 *   存量别名保留、外键检查通过;
 * - 确定性候选:归一化(全半角/大小写/trim)精确编码、别名、模糊 top-N 排序与去重;
 *   matcher.ts 运行时严格匹配语义不变;
 * - provenance:来源标记与未复核状态、复制版本保留、含未复核行锁定需显式确认
 *   (不新增阻断规则);validateMappingVersion 结构校验语义不变;
 * - AI 残差:模型关闭/高置信/开关关闭均不调用;低置信时白名单校验后追加;
 *   模型故障回退确定性候选;
 * - 真实财务源样例上的确定性命中率有记录(模型介入比例基线)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { testDb, buildFixture, type Fixture } from './helpers';
import { MIGRATIONS, applyMigrations } from '../src/db/migrations';
import {
  createMappingVersion, lockMappingVersion, cloneMappingVersion,
  replaceOrgMappings, replaceAccountMappings, listOrgMappings, listAccountMappings,
  countUnreviewedMappings, exportMappings, importMappings, exportMappingsCsv, importMappingsCsv,
  replaceReconciliationRules,
} from '../src/modules/finance-import/mapping/mapping.service';
import { validateMappingVersion } from '../src/modules/finance-import/mapping/mapping-validator';
import { deterministicCandidates, suggestMappingCandidates, unmappedSources, AI_RESIDUAL_THRESHOLD } from '../src/modules/finance-import/mapping/candidates';
import { createSourceProfile } from '../src/modules/finance-import/source-profile.service';
import { createConversion } from '../src/modules/finance-import/conversion/conversion-batch.service';
import { createAlias, listAliases } from '../src/modules/io/cleaning/alias.service';
import { matchOrg } from '../src/modules/finance-import/mapping/matcher';
import type { NormalizedFinanceRow } from '../src/modules/finance-import/finance.types';
import type { DB } from '../src/db/connection';

/** 从 fromVersion 起的全部迁移版本号(newfc 追加迁移后不必逐条改断言)。 */
const versionsFrom = (fromVersion: number) => MIGRATIONS.map((m) => m.version).filter((v) => v >= fromVersion).sort((a, b) => a - b);

function applyThrough(db: DB, targetVersion: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const migration of MIGRATIONS.filter((item) => item.version <= targetVersion)) {
    const record = () => db.prepare('INSERT INTO schema_migration(version,name,applied_at) VALUES(?,?,?)').run(migration.version, migration.name, new Date().toISOString());
    if (migration.raw) {
      try { db.exec(migration.sql); } finally { db.pragma('foreign_keys = ON'); }
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length) throw new Error(`V${migration.version} foreign_key_check 失败`);
      record();
    } else {
      db.transaction(() => { db.exec(migration.sql); record(); })();
    }
  }
}

function setupDraft(): { db: DB; fx: Fixture; versionId: number } {
  const db = testDb();
  const fx = buildFixture(db);
  const profile = createSourceProfile(db, { code: 'FIXED', name: '固定财务系统', config: { balanceSheetNames: ['科目余额表'], profitSheetNames: ['利润表'], ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I', 'C', 'E'], amountUnit: 'yuan' } });
  const version = createMappingVersion(db, { sourceProfileId: profile.id, name: '候选测试' });
  return { db, fx, versionId: version.id };
}

describe('迁移 V29/V30:provenance 列与别名 finance 扩展', () => {
  it('V28 库升级后存量行默认 manual+已复核,别名数据保留且接受 finance', () => {
    const db = new Database(':memory:') as unknown as DB;
    applyThrough(db, 28);
    // 旧库写入一条别名与一行组织映射
    db.prepare("INSERT INTO org (id, parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (1, NULL, 'G', '集团', 0, 'active', '2026-01-01', '2026-01-01')").run();
    db.prepare("INSERT INTO org (id, parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (2, 1, 'P01', '一厂', 0, 'active', '2026-01-01', '2026-01-01')").run();
    db.prepare("INSERT INTO finance_source_profile (code, name, adapter_type, config_json, status, created_at, updated_at) VALUES ('P', 'p', 'fixed_finance_system_v1', '{}', 'active', '2026-01-01', '2026-01-01')").run();
    db.prepare("INSERT INTO tree_snapshot (tree_type, content_json, content_hash, created_at) VALUES ('org', '{\"nodes\":[]}', 'h1', '2026-01-01'), ('account', '{\"nodes\":[]}', 'h2', '2026-01-01')").run();
    db.prepare("INSERT INTO finance_mapping_version (source_profile_id, version_no, name, status, org_tree_snapshot_id, account_tree_snapshot_id, created_by, created_at) VALUES (1, 1, 'v', 'draft', 1, 2, '', '2026-01-01')").run();
    db.prepare("INSERT INTO finance_org_mapping (mapping_version_id, source_book_code, source_org_code, source_org_name, source_aux_json, target_org_id, priority, note) VALUES (1, '', 'S001', '', '{}', 2, 0, '')").run();
    db.prepare("INSERT INTO import_name_alias (target_kind, mapping_kind, source_text, target_code, created_by, created_at, updated_at) VALUES ('budget', 'org', '旧称', 'P01', '', '2026-01-01', '2026-01-01')").run();

    const applied = applyMigrations(db).map((migration) => migration.version);
    expect(applied).toEqual(versionsFrom(29));
    // 存量映射行默认手工来源 + 已复核
    const mapping = db.prepare('SELECT origin, reviewed FROM finance_org_mapping').get() as { origin: string; reviewed: number };
    expect(mapping).toEqual({ origin: 'manual', reviewed: 1 });
    // 存量别名保留,新枚举接受 finance
    expect((db.prepare('SELECT COUNT(*) c FROM import_name_alias').get() as { c: number }).c).toBe(1);
    db.prepare("INSERT INTO import_name_alias (target_kind, mapping_kind, source_text, target_code, created_by, created_at, updated_at) VALUES ('finance', 'account', '主营收入', 'I01', '', '2026-01-02', '2026-01-02')").run();
    // 旧枚举外的值仍被拒绝
    expect(() => db.prepare("INSERT INTO import_name_alias (target_kind, mapping_kind, source_text, target_code, created_by, created_at, updated_at) VALUES ('other', 'org', 'x', 'y', '', '2026-01-02', '2026-01-02')").run()).toThrow();
    const violations = db.pragma('foreign_key_check') as unknown[];
    expect(violations).toEqual([]);
    db.close();
  });
});

describe('确定性候选建议', () => {
  it('编码归一化后完全一致排第一(全半角、大小写、空白差异被归一)', () => {
    const { db, fx, versionId } = setupDraft();
    // 目标科目编码 I01;源串给全角编码 Ｉ０１(全半角统一后命中)
    const result = deterministicCandidates(db, versionId, { kind: 'account', sourceCode: 'Ｉ０１' });
    expect(result.exactCodeMatched).toBe(true);
    expect(result.candidates[0].targetId).toBe(fx.accIds.incomeMain);
    expect(result.candidates[0].score).toBe(1);
    // 源名称模糊: 主营收入 → 主营业务收入
    const fuzzy = deterministicCandidates(db, versionId, { kind: 'account', sourceName: ' 主营 收入 ' });
    expect(fuzzy.candidates[0].targetId).toBe(fx.accIds.incomeMain);
    expect(fuzzy.candidates[0].score).toBeGreaterThan(0.5);
  });

  it('组织候选按名称模糊打分并去重,目标为快照内 active 叶子', () => {
    const { db, fx, versionId } = setupDraft();
    const result = deterministicCandidates(db, versionId, { kind: 'org', sourceName: '上海公司旧称' });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates[0].targetId).toBe(fx.orgIds.shanghai);
    const ids = result.candidates.map((candidate) => candidate.targetId);
    expect(new Set(ids).size).toBe(ids.length);
    // 父组织(华东大区)不是叶子,不出现在候选里
    expect(ids).not.toContain(fx.orgIds.east);
  });

  it('别名沉淀优先于模糊匹配;matcher.ts 严格全等语义不变', () => {
    const { db, fx, versionId } = setupDraft();
    createAlias(db, { targetKind: 'finance', mappingKind: 'account', sourceText: '水电费', targetCode: 'C0101' }, 'tester');
    const result = deterministicCandidates(db, versionId, { kind: 'account', sourceName: '水电费' });
    const alias = result.candidates.find((candidate) => candidate.source === 'alias');
    expect(alias).toBeDefined();
    expect(alias!.targetId).toBe(fx.accIds.costSub);
    expect(alias!.score).toBeGreaterThan(0.9);
    // matcher.ts 不做归一化:全角编码在严格匹配下不命中
    const row: NormalizedFinanceRow = {
      sourceSheet: 'S', sourceRow: 1, bookCode: 'B', orgCode: 'O1', orgName: 'N',
      accountCode: 'Ｉ０１', accountName: 'x', auxiliary: {},
      cumulativeDebitCents: 0, cumulativeCreditCents: 0, year: 2026, snapshotDate: '2026-06-30',
    };
    expect(() => matchOrg(row, [{
      id: 1, source_book_code: 'B', source_org_code: 'O1', source_org_name: '',
      source_aux_json: '{}', target_org_id: fx.orgIds.shanghai, priority: 0,
    }])).not.toThrow();
    expect(() => matchOrg({ ...row, orgCode: 'Ｏ１' }, [{
      id: 1, source_book_code: 'B', source_org_code: 'O1', source_org_name: '',
      source_aux_json: '{}', target_org_id: fx.orgIds.shanghai, priority: 0,
    }])).toThrow(/未映射/);
  });

  it('真实财务源样例的确定性命中率基线(记录用)', () => {
    const { db, versionId } = setupDraft();
    // 真实样例口径:财务系统常见源名称 → 期望命中的预算主数据
    const samples: { input: { kind: 'org' | 'account'; sourceCode?: string; sourceName?: string }; expectCode: string }[] = [
      { input: { kind: 'account', sourceCode: '4001', sourceName: '主营业务收入' }, expectCode: 'I01' },
      { input: { kind: 'account', sourceName: '主营收入' }, expectCode: 'I01' },
      { input: { kind: 'account', sourceName: '主营业务成本' }, expectCode: 'C01' },
      { input: { kind: 'account', sourceName: '材料成本费' }, expectCode: 'C0101' },
      { input: { kind: 'account', sourceName: '管理费用' }, expectCode: 'E01' },
      { input: { kind: 'account', sourceName: '销售费用' }, expectCode: 'E02' },
      { input: { kind: 'org', sourceName: '上海公司' }, expectCode: 'SH' },
      { input: { kind: 'org', sourceName: '上海分公司' }, expectCode: 'SH' },
      { input: { kind: 'org', sourceName: '杭州公司' }, expectCode: 'HZ' },
      { input: { kind: 'org', sourceName: '南京公司' }, expectCode: 'NJ' },
    ];
    let hits = 0;
    for (const sample of samples) {
      const result = deterministicCandidates(db, versionId, sample.input);
      const top = result.candidates[0];
      if (top?.code === sample.expectCode) hits += 1;
    }
    const hitRate = hits / samples.length;
    // 模型介入比例基线:命中率 = 1 - 残差比例;打印留档
    console.log(`[baseline] 真实财务源样例确定性命中率: ${hits}/${samples.length} = ${(hitRate * 100).toFixed(1)}%`);
    expect(hitRate).toBeGreaterThanOrEqual(0.8);
  });
});

describe('映射行 provenance 与锁定确认', () => {
  it('建议来源行默认未复核,手工行默认已复核;复制版本保留标记', () => {
    const { db, fx, versionId } = setupDraft();
    replaceOrgMappings(db, versionId, [
      { sourceOrgCode: 'S001', targetOrgId: fx.orgIds.shanghai, priority: 10 },
      { sourceOrgCode: 'H001', targetOrgId: fx.orgIds.hangzhou, priority: 10, origin: 'deterministic' },
    ]);
    replaceAccountMappings(db, versionId, [
      { sourceAccountCode: '4001', targetAccountId: fx.accIds.incomeMain, amountRule: 'credit_minus_debit' },
      { sourceAccountCode: '6601', targetAccountId: fx.accIds.expenseAdmin, amountRule: 'debit_minus_credit', origin: 'ai', reviewed: 1 },
    ]);
    const orgRows = listOrgMappings(db, versionId) as unknown as { origin: string; reviewed: number }[];
    expect(orgRows.find((row: any) => row.source_org_code === 'S001')).toMatchObject({ origin: 'manual', reviewed: 1 });
    expect(orgRows.find((row: any) => row.source_org_code === 'H001')).toMatchObject({ origin: 'deterministic', reviewed: 0 });
    const accRows = listAccountMappings(db, versionId) as unknown as { origin: string; reviewed: number }[];
    expect(accRows.find((row: any) => row.source_account_code === '6601')).toMatchObject({ origin: 'ai', reviewed: 1 });
    expect(countUnreviewedMappings(db, versionId)).toBe(1);

    const clone = cloneMappingVersion(db, versionId, 'tester');
    expect(countUnreviewedMappings(db, clone.id)).toBe(1);
  });

  it('含未复核行时锁定需显式确认;确认后锁定语义(draft→locked)不变', () => {
    const { db, fx, versionId } = setupDraft();
    replaceOrgMappings(db, versionId, [{ sourceOrgCode: 'S001', targetOrgId: fx.orgIds.shanghai, origin: 'deterministic' }]);
    replaceAccountMappings(db, versionId, [
      { sourceAccountCode: '4001', targetAccountId: fx.accIds.incomeMain, amountRule: 'credit_minus_debit' },
      { sourceAccountCode: '5001', targetAccountId: fx.accIds.costSub, amountRule: 'debit_minus_credit' },
    ]);
    db.prepare("INSERT INTO finance_reconciliation_rule (mapping_version_id, source_line_alias, target_type, target_code, org_scope_json, comparison, tolerance_cents, tolerance_reason, required) VALUES (?, '营业收入', 'account', 'I', '[]', 'equal', 0, '', 1)").run(versionId);
    expect(validateMappingVersion(db, versionId).passed).toBe(true);
    // 未复核行存在:拒绝并要求确认(409 + UNREVIEWED_MAPPINGS)
    let caught: any;
    try { lockMappingVersion(db, versionId, 'reviewer'); } catch (err) { caught = err; }
    expect(caught?.code).toBe('UNREVIEWED_MAPPINGS');
    expect(caught?.status).toBe(409);
    expect(caught?.details).toMatchObject({ unreviewed: 1 });
    // 显式确认后正常锁定
    const locked = lockMappingVersion(db, versionId, 'reviewer', { confirmUnreviewed: true });
    expect(locked.status).toBe('locked');
  });

  it('origin 枚举校验', () => {
    const { db, fx, versionId } = setupDraft();
    expect(() => replaceOrgMappings(db, versionId, [{ sourceOrgCode: 'X', targetOrgId: fx.orgIds.shanghai, origin: 'robot' }])).toThrow(/origin/);
  });
});

describe('映射导入/导出的 provenance 往返', () => {
  function seedProvenance(db: DB, versionId: number, fx: Fixture): void {
    replaceOrgMappings(db, versionId, [
      { sourceBookCode: 'B1', sourceOrgCode: 'S001', sourceOrgName: '上海旧称', targetOrgId: fx.orgIds.shanghai, priority: 10, note: '手工确认', origin: 'manual' },
      { sourceBookCode: 'B1', sourceOrgCode: 'H001', sourceOrgName: '杭州旧称', targetOrgId: fx.orgIds.hangzhou, priority: 5, origin: 'ai' },
    ]);
    replaceAccountMappings(db, versionId, [
      { sourceAccountCode: '4001', sourceAccountName: '主营收入', targetAccountId: fx.accIds.incomeMain, amountRule: 'credit_minus_debit', origin: 'manual' },
      { sourceAccountCode: '6601', sourceAccountName: '期间费用', targetAccountId: fx.accIds.expenseAdmin, amountRule: 'debit_minus_credit', origin: 'deterministic' },
    ]);
    // 结构校验先于未复核门禁执行,补一条勾稽规则让结构校验通过
    replaceReconciliationRules(db, versionId, [{ sourceLineAlias: '营业收入', targetType: 'account', targetCode: 'I' }]);
  }

  it('XLSX 导出再导入保留 origin 与 reviewed,未复核行数不被抹平', async () => {
    const { db, fx, versionId } = setupDraft();
    seedProvenance(db, versionId, fx);
    expect(countUnreviewedMappings(db, versionId)).toBe(2);

    const buffer = await exportMappings(db, versionId);
    const result = await importMappings(db, versionId, buffer);
    expect(result.unreviewedCount).toBe(2);

    const orgRows = listOrgMappings(db, versionId) as any[];
    expect(orgRows.find((row) => row.source_org_code === 'S001')).toMatchObject({ origin: 'manual', reviewed: 1 });
    expect(orgRows.find((row) => row.source_org_code === 'H001')).toMatchObject({ origin: 'ai', reviewed: 0 });
    const accRows = listAccountMappings(db, versionId) as any[];
    expect(accRows.find((row) => row.source_account_code === '4001')).toMatchObject({ origin: 'manual', reviewed: 1 });
    expect(accRows.find((row) => row.source_account_code === '6601')).toMatchObject({ origin: 'deterministic', reviewed: 0 });
    // 往返后锁定仍要求显式确认:导出再导入不能成为绕过复核提醒的后门
    let caught: any;
    try { lockMappingVersion(db, versionId, 'reviewer'); } catch (err) { caught = err; }
    expect(caught?.code).toBe('UNREVIEWED_MAPPINGS');
    db.close();
  });

  it('CSV 导出再导入同样保留 provenance;显式改为已复核后可被采纳', () => {
    const { db, fx, versionId } = setupDraft();
    seedProvenance(db, versionId, fx);

    for (const sheet of ['org', 'account'] as const) {
      const csv = exportMappingsCsv(db, versionId, sheet).toString('utf8');
      expect(csv).toContain('来源');
      expect(csv).toContain('已复核');
      importMappingsCsv(db, versionId, sheet, Buffer.from(csv, 'utf8'));
    }
    expect(countUnreviewedMappings(db, versionId)).toBe(2);
    expect((listOrgMappings(db, versionId) as any[]).find((row) => row.source_org_code === 'H001')).toMatchObject({ origin: 'ai', reviewed: 0 });

    // 用户在表格里把未复核改成「是」:来源标记保留,复核状态按文件生效
    const reviewed = exportMappingsCsv(db, versionId, 'org').toString('utf8').replace(/否/g, '是');
    importMappingsCsv(db, versionId, 'org', Buffer.from(reviewed, 'utf8'));
    expect((listOrgMappings(db, versionId) as any[]).find((row) => row.source_org_code === 'H001')).toMatchObject({ origin: 'ai', reviewed: 1 });
    expect(countUnreviewedMappings(db, versionId)).toBe(1);
    db.close();
  });

  it('旧版导出文件(无来源/已复核列)按默认值导入,非法取值被拒绝', () => {
    const { db, fx, versionId } = setupDraft();
    seedProvenance(db, versionId, fx);
    // 旧文件只有到「依据」为止的 7 列
    const legacy = '\uFEFF源账套,源组织编码,源组织名称,辅助条件JSON,目标组织编码,优先级,依据\r\n'
      + `B1,S001,上海旧称,{},SH,10,手工确认\r\n`;
    importMappingsCsv(db, versionId, 'org', Buffer.from(legacy, 'utf8'));
    expect((listOrgMappings(db, versionId) as any[])[0]).toMatchObject({ origin: 'manual', reviewed: 1 });

    const badOrigin = '\uFEFF源账套,源组织编码,源组织名称,辅助条件JSON,目标组织编码,优先级,依据,来源,已复核\r\n'
      + 'B1,S001,上海旧称,{},SH,10,,机器人,是\r\n';
    expect(() => importMappingsCsv(db, versionId, 'org', Buffer.from(badOrigin, 'utf8'))).toThrow(/来源/);
    const badReviewed = '\uFEFF源账套,源组织编码,源组织名称,辅助条件JSON,目标组织编码,优先级,依据,来源,已复核\r\n'
      + 'B1,S001,上海旧称,{},SH,10,,手工,大概\r\n';
    expect(() => importMappingsCsv(db, versionId, 'org', Buffer.from(badReviewed, 'utf8'))).toThrow(/已复核/);
    db.close();
  });
});

describe('未映射源清单(批量采纳入口)', () => {
  async function balanceFile(year: number, date: string, rows: { org: string; orgName: string; code: string; name: string; debit: number; credit: number }[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('科目余额表');
    ws.addRow(['账套编码', '组织编码', '组织名称', '科目编码', '科目名称', '本年累计借方', '本年累计贷方', '年度', '截止日期']);
    for (const row of rows) ws.addRow(['BOOK1', row.org, row.orgName, row.code, row.name, row.debit, row.credit, year, date]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  async function profitFile(year: number, date: string, rows: { item: string; amount: number }[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('利润表');
    ws.addRow(['项目', '本年累计金额', '年度', '截止日期']);
    for (const row of rows) ws.addRow([row.item, row.amount, year, date]);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it('按转换批次源明细列出未映射的源组织与源科目,判定与运行时匹配器一致', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const profile = createSourceProfile(db, {
      code: 'FIXED', name: '固定财务系统',
      config: { balanceSheetNames: ['科目余额表'], profitSheetNames: ['利润表'], ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I', 'C', 'E'], amountUnit: 'yuan' },
    });
    // 只映射 S001 与 4001,H001 / 5001 未映射
    const v1 = createMappingVersion(db, { sourceProfileId: profile.id, name: '部分映射' });
    replaceOrgMappings(db, v1.id, [{ sourceBookCode: 'BOOK1', sourceOrgCode: 'S001', targetOrgId: fx.orgIds.shanghai, priority: 10 }]);
    replaceAccountMappings(db, v1.id, [{ sourceAccountCode: '4001', targetAccountId: fx.accIds.incomeMain, amountRule: 'credit_minus_debit' }]);
    replaceReconciliationRules(db, v1.id, [{ sourceLineAlias: '营业收入', targetType: 'account', targetCode: 'I' }]);
    const locked = lockMappingVersion(db, v1.id, 'reviewer');

    const rows = [
      { org: 'S001', orgName: '上海旧称', code: '4001', name: '主营收入', debit: 0, credit: 100 },
      { org: 'S001', orgName: '上海旧称', code: '5001', name: '主营成本', debit: 60, credit: 0 },
      { org: 'H001', orgName: '杭州旧称', code: '4001', name: '主营收入', debit: 0, credit: 50 },
      { org: 'H001', orgName: '杭州旧称', code: '5001', name: '主营成本', debit: 30, credit: 0 },
    ];
    const conversion = await createConversion(db, {
      sourceProfileId: profile.id, mappingVersionId: locked.id, year: 2026, snapshotDate: '2026-06-30',
      balanceName: 'b.xlsx', balance: await balanceFile(2026, '2026-06-30', rows),
      profitName: 'p.xlsx', profit: await profitFile(2026, '2026-06-30', [{ item: '营业收入', amount: 150 }]),
    });
    // 存在未映射行 -> 转换被阻断(既有语义不变)
    expect(conversion.status).toBe('blocked');

    // 新草稿上算未映射清单:H001(2 行)与 5001(2 行)
    const draft = cloneMappingVersion(db, locked.id, 'tester');
    const result = unmappedSources(db, draft.id, conversion.id);
    expect(result.conversionId).toBe(conversion.id);
    expect(result.sourceRowCount).toBe(4);
    expect(result.org.map((row) => row.sourceCode)).toEqual(['H001']);
    expect(result.org[0]).toMatchObject({ sourceBookCode: 'BOOK1', sourceName: '杭州旧称', rowCount: 2, firstSheet: '科目余额表' });
    expect(result.account.map((row) => row.sourceCode)).toEqual(['5001']);
    expect(result.account[0]).toMatchObject({ sourceName: '主营成本', rowCount: 2 });

    // 批量采纳后清单收敛为空
    replaceOrgMappings(db, draft.id, [
      { sourceBookCode: 'BOOK1', sourceOrgCode: 'S001', targetOrgId: fx.orgIds.shanghai, priority: 10 },
      { sourceBookCode: 'BOOK1', sourceOrgCode: 'H001', sourceOrgName: '杭州旧称', targetOrgId: fx.orgIds.hangzhou, origin: 'deterministic' },
    ]);
    replaceAccountMappings(db, draft.id, [
      { sourceAccountCode: '4001', targetAccountId: fx.accIds.incomeMain, amountRule: 'credit_minus_debit' },
      { sourceAccountCode: '5001', sourceAccountName: '主营成本', targetAccountId: fx.accIds.costSub, amountRule: 'debit_minus_credit', origin: 'ai' },
    ]);
    const after = unmappedSources(db, draft.id, conversion.id);
    expect(after.org).toEqual([]);
    expect(after.account).toEqual([]);
    // 采纳行仍是未复核,锁定前需显式确认
    expect(countUnreviewedMappings(db, draft.id)).toBe(2);
    db.close();
  });

  it('转换批次与映射版本不同源时拒绝;批次不存在时 404', async () => {
    const db = testDb();
    buildFixture(db);
    const profileA = createSourceProfile(db, { code: 'A', name: 'A', config: { balanceSheetNames: ['科目余额表'], profitSheetNames: ['利润表'], ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I'], amountUnit: 'yuan' } });
    const profileB = createSourceProfile(db, { code: 'B', name: 'B', config: { balanceSheetNames: ['科目余额表'], profitSheetNames: ['利润表'], ownedOrgCodes: ['WEST'], ownedAccountCodes: ['C'], amountUnit: 'yuan' } });
    const versionB = createMappingVersion(db, { sourceProfileId: profileB.id, name: 'B 草稿' });
    // 手工插入一条属于 profileA 的批次行(不跑完整转换,只验证归属校验)
    const now = new Date().toISOString();
    const versionA = createMappingVersion(db, { sourceProfileId: profileA.id, name: 'A 草稿' });
    const info = db.prepare(
      `INSERT INTO finance_conversion_batch(source_profile_id,mapping_version_id,year,snapshot_date,status,balance_name,balance_sha256,balance_blob,profit_name,profit_sha256,profit_blob,profile_adapter_type,profile_config_json,normalized_json,created_at)
       VALUES(?,?,2026,'2026-06-30','blocked','b',?,?, 'p',?,?, 'fixed_finance_system_v1','{}','{"balance":[]}',?)`,
    ).run(profileA.id, versionA.id, 'a'.repeat(64), Buffer.from('x'), 'b'.repeat(64), Buffer.from('y'), now);
    const conversionId = Number(info.lastInsertRowid);
    expect(() => unmappedSources(db, versionB.id, conversionId)).toThrow(/同一个财务数据源/);
    expect(() => unmappedSources(db, versionA.id, 999_999)).toThrow(/财务转换批次/);
    // 空 normalized 不报错,返回空清单
    expect(unmappedSources(db, versionA.id, conversionId)).toMatchObject({ sourceRowCount: 0, org: [], account: [] });
    db.close();
  });
});

describe('AI 残差建议', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AI_BASE_URL = '';
    process.env.AI_API_KEY = '';
  });

  it('模型未配置时不调用模型,仅返回确定性候选', async () => {
    const { db, versionId } = setupDraft();
    const result = await suggestMappingCandidates(db, versionId, { kind: 'account', sourceName: '水费' }, { allowAi: true });
    expect(result.aiUsed).toBe(false);
    expect(result.candidates.every((candidate) => candidate.source !== 'ai')).toBe(true);
  });

  it('高置信确定性命中时不调用模型;低置信时白名单校验后追加 AI 候选', async () => {
    const { db, fx, versionId } = setupDraft();
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ candidates: [
            { code: 'E03', reason: '其他费用兜底' },
            { code: 'NOT_EXIST', reason: '编造编码应被丢弃' },
            { code: 'I', reason: '非叶子应被丢弃' },
          ] }) } }],
        }),
      };
    }));
    // 高置信:主营业务收入精确名称,不触发模型
    const high = await suggestMappingCandidates(db, versionId, { kind: 'account', sourceName: '主营业务收入' }, { allowAi: true });
    expect(high.deterministicTopScore).toBeGreaterThanOrEqual(AI_RESIDUAL_THRESHOLD);
    expect(high.aiUsed).toBe(false);
    expect(calls).toBe(0);
    // 低置信:完全无关的源串,模型残差兜底;编造编码与非叶子被白名单过滤
    const low = await suggestMappingCandidates(db, versionId, { kind: 'account', sourceName: 'zzzzqqqq' }, { allowAi: true });
    expect(low.deterministicTopScore).toBeLessThan(AI_RESIDUAL_THRESHOLD);
    expect(calls).toBe(1);
    const ai = low.candidates.filter((candidate) => candidate.source === 'ai');
    expect(ai).toHaveLength(1);
    expect(ai[0].targetId).toBe(fx.accIds.expenseOther);
    expect(ai[0].reason).toBe('其他费用兜底');
  });

  it('模型故障时回退确定性候选', async () => {
    const { db, versionId } = setupDraft();
    process.env.AI_BASE_URL = 'http://model.test/v1';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const result = await suggestMappingCandidates(db, versionId, { kind: 'account', sourceName: 'zzzz' }, { allowAi: true });
    expect(result.aiUsed).toBe(false);
    expect(result).toBeDefined();
  });
});

describe('别名机制 finance 扩展', () => {
  it('finance 别名创建/查询/归一化唯一;清单按 kind 过滤', () => {
    const db = testDb();
    buildFixture(db);
    const created = createAlias(db, { targetKind: 'finance', mappingKind: 'org', sourceText: '一厂旧称', targetCode: 'P01' }, 'tester');
    expect(created.target_kind).toBe('finance');
    expect(() => createAlias(db, { targetKind: 'finance', mappingKind: 'org', sourceText: '一厂 旧称', targetCode: 'P01' }, 'tester')).toThrow(/别名/);
    const financeOnly = listAliases(db, { targetKind: 'finance' });
    expect(financeOnly).toHaveLength(1);
    expect(listAliases(db, { targetKind: 'budget' })).toHaveLength(0);
  });
});
