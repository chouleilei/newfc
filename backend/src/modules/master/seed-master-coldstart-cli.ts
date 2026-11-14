import fs from 'fs';
import path from 'path';
import { openDatabase, type DB } from '../../db/connection';
import { applyMigrations } from '../../db/migrations';
import { parseCliArgs, parseCsvObjects, requireSafeCliDataDir } from '../../db/cli-guard';
import { findExternalBlockMatch, listExternalBlockedPatterns } from '../org/org.service';
import { createVersion } from '../budget/budget.service';
import { normalizeName } from './master.service';

export interface ColdstartAccountSeed {
  code: string;
  parentCode?: string | null;
  name: string;
  type: 'income' | 'cost' | 'expense' | 'quantity';
  unit?: string;
  quantityAgg?: 'sum' | 'none';
  sortOrder?: number;
}

export interface ColdstartProjectSeed {
  code: string;
  name: string;
  orgCode: string;
  projectType?: string;
}

export interface ColdstartSupplierSeed {
  code?: string | null;
  name: string;
  supplierType?: string;
  creditCode?: string;
  isInPool?: boolean;
  aliases?: string[];
}

export interface ColdstartOptions {
  year?: number;
  accounts?: ColdstartAccountSeed[];
  projects?: ColdstartProjectSeed[];
  suppliers?: ColdstartSupplierSeed[];
  dictItems?: { dictType: string; itemValue: string; itemLabel: string; sortOrder?: number }[];
  externalInventoryCsv?: string;
}

const DEFAULT_COLDSTART_ACCOUNTS: readonly ColdstartAccountSeed[] = [
  { code: 'INC', parentCode: null, name: '营业总收入', type: 'income', sortOrder: 10 },
  { code: 'INC_POWER', parentCode: 'INC', name: '发电主营收入', type: 'income', sortOrder: 11 },
  { code: 'INC_NON_POWER', parentCode: 'INC', name: '非电业务收入', type: 'income', sortOrder: 12 },
  { code: 'COST', parentCode: null, name: '营业总成本', type: 'cost', sortOrder: 20 },
  { code: 'COST_OM', parentCode: 'COST', name: '运行维护费', type: 'cost', sortOrder: 21 },
  { code: 'COST_TECH_EXP', parentCode: 'COST', name: '费用化更新改造', type: 'cost', sortOrder: 22 },
  { code: 'EXP', parentCode: null, name: '管理及专项费用', type: 'expense', sortOrder: 30 },
  { code: 'EXP_LABOR', parentCode: 'EXP', name: '人工成本', type: 'expense', sortOrder: 31 },
  { code: 'EXP_FIVE', parentCode: 'EXP', name: '五项费用', type: 'expense', sortOrder: 32 },
  { code: 'EXP_CTRL_OTHER', parentCode: 'EXP', name: '其他可控管理费', type: 'expense', sortOrder: 33 },
  { code: 'EXP_TAX_DEP', parentCode: 'EXP', name: '税金及折旧摊销', type: 'expense', sortOrder: 34 },
  { code: 'QTY_GEN', parentCode: null, name: '发电量', type: 'quantity', unit: '万千瓦时', quantityAgg: 'sum', sortOrder: 40 },
];

const DEFAULT_COLDSTART_DICTS: readonly { dictType: string; itemValue: string; itemLabel: string; sortOrder: number }[] = [
  { dictType: 'project_type', itemValue: 'investment', itemLabel: '固定资产投资', sortOrder: 10 },
  { dictType: 'project_type', itemValue: 'tech_renovation', itemLabel: '技术改造', sortOrder: 20 },
  { dictType: 'project_type', itemValue: 'maintenance', itemLabel: '运行维护', sortOrder: 30 },
  { dictType: 'project_type', itemValue: 'safety', itemLabel: '安全生产投入', sortOrder: 40 },
  { dictType: 'supplier_type', itemValue: 'contractor', itemLabel: '工程承包商', sortOrder: 10 },
  { dictType: 'supplier_type', itemValue: 'vendor', itemLabel: '物资设备供应商', sortOrder: 20 },
  { dictType: 'supplier_type', itemValue: 'service_provider', itemLabel: '技术与咨询服务商', sortOrder: 30 },
];

function extractRejectedExternalNamesFromInventoryCsv(csvText: string): string[] {
  const records = parseCsvObjects(csvText);
  const names = new Set<string>();
  for (const r of records) {
    if (r.should_ingest === '0' && r.batch_group === 'governance-rejected') {
      const raw = (r.target_entities ?? '').replace(/^外部主体/, '').replace(/\(.*\)$/, '').replace(/（.*）$/, '').trim();
      if (raw.length >= 2) names.add(raw);
    }
  }
  return [...names];
}

export function seedMasterColdstart(db: DB, options: ColdstartOptions = {}) {
  const now = new Date().toISOString();
  const year = options.year ?? 2026;
  const accounts = options.accounts ?? DEFAULT_COLDSTART_ACCOUNTS;
  const dicts = [...DEFAULT_COLDSTART_DICTS, ...(options.dictItems ?? [])];
  if (options.externalInventoryCsv) {
    const rejectedNames = extractRejectedExternalNamesFromInventoryCsv(options.externalInventoryCsv);
    rejectedNames.forEach((label, idx) => {
      dicts.push({
        dictType: 'org_external_blocklist',
        itemValue: `EXT_REJECT_${idx + 1}`,
        itemLabel: label,
        sortOrder: (idx + 1) * 10,
      });
    });
  }

  let accountsCreated = 0;
  let dictsCreated = 0;
  let projectsCreated = 0;
  let suppliersCreated = 0;
  let mappingsCreated = 0;
  let budgetVersionEnsured = false;

  db.transaction(() => {
    const accCodeToId = new Map<string, number>(
      (db.prepare('SELECT id, code FROM account').all() as { id: number; code: string }[]).map((r) => [r.code, r.id])
    );
    for (const a of accounts) {
      if (accCodeToId.has(a.code)) continue;
      const parentId = a.parentCode ? (accCodeToId.get(a.parentCode) ?? null) : null;
      const info = db.prepare(
        `INSERT INTO account (parent_id, code, name, type, unit, quantity_agg, sort_order, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).run(
        parentId,
        a.code,
        a.name,
        a.type,
        a.type === 'quantity' ? (a.unit ?? '项') : '',
        a.type === 'quantity' ? (a.quantityAgg ?? 'sum') : 'sum',
        a.sortOrder ?? 0,
        now,
        now
      );
      accCodeToId.set(a.code, Number(info.lastInsertRowid));
      accountsCreated++;
    }

    for (const d of dicts) {
      const ex = db.prepare('SELECT id FROM md_dict_item WHERE dict_type = ? AND item_value = ?').get(d.dictType, d.itemValue);
      if (ex) continue;
      db.prepare(
        `INSERT INTO md_dict_item (dict_type, item_value, item_label, sort_order, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`
      ).run(d.dictType, d.itemValue, d.itemLabel, d.sortOrder ?? 10, now, now);
      dictsCreated++;
    }

    const orgByCode = new Map<string, number>(
      (db.prepare('SELECT id, code FROM org').all() as { id: number; code: string }[]).map((r) => [r.code, r.id])
    );
    const defaultActiveOrg = db.prepare("SELECT id, code FROM org WHERE status = 'active' ORDER BY sort_order, id LIMIT 1").get() as
      | { id: number; code: string }
      | undefined;

    const projectSeeds: ColdstartProjectSeed[] = options.projects ?? (
      defaultActiveOrg
        ? [{ code: `PRJ-${year}-BASE`, name: `${year}年度综合基础专项`, orgCode: defaultActiveOrg.code, projectType: 'investment' }]
        : []
    );
    for (const p of projectSeeds) {
      const orgId = orgByCode.get(p.orgCode);
      if (!orgId) continue;
      const ex = db.prepare('SELECT id FROM md_project WHERE code = ?').get(p.code);
      if (ex) continue;
      db.prepare(
        `INSERT INTO md_project (code, name, project_type, org_id, status, extra_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', '{}', ?, ?)`
      ).run(p.code, p.name, p.projectType ?? 'investment', orgId, now, now);
      projectsCreated++;
    }

    const supplierSeeds: ColdstartSupplierSeed[] = options.suppliers ?? [
      { code: 'SUP-INIT-001', name: '待核实历史客商占位档案', supplierType: 'service_provider', isInPool: false },
    ];
    for (const s of supplierSeeds) {
      const norm = normalizeName(s.name);
      let supRow = db.prepare('SELECT id FROM md_supplier WHERE normalized_name = ? OR (code IS NOT NULL AND code = ?)').get(
        norm,
        s.code ?? null
      ) as { id: number } | undefined;
      if (!supRow) {
        const info = db.prepare(
          `INSERT INTO md_supplier (code, name, normalized_name, supplier_type, credit_code, status, is_in_pool, pooled_at, extra_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, '{}', ?, ?)`
        ).run(
          s.code ?? null,
          s.name,
          norm,
          s.supplierType ?? '',
          s.creditCode ?? '',
          s.isInPool ? 1 : 0,
          s.isInPool ? now.slice(0, 10) : null,
          now,
          now
        );
        supRow = { id: Number(info.lastInsertRowid) };
        suppliersCreated++;
      }
      for (const alias of s.aliases ?? []) {
        const aliasKey = normalizeName(alias);
        if (!aliasKey) continue;
        const exMap = db.prepare(
          "SELECT id FROM md_code_mapping WHERE source_system = 'legacy_alias' AND entity_type = 'supplier' AND match_kind = 'name' AND source_key = ? AND valid_to IS NULL"
        ).get(aliasKey);
        if (exMap) continue;
        db.prepare(
          `INSERT INTO md_code_mapping (source_system, entity_type, match_kind, source_key, source_label, target_id, valid_from, note, created_by, created_at)
           VALUES ('legacy_alias', 'supplier', 'name', ?, ?, ?, '2000-01-01T00:00:00.000Z', '客商曾用名冷启动映射', NULL, ?)`
        ).run(aliasKey, alias, supRow.id, now);
        mappingsCreated++;
      }
    }

  })();

  const hasVersion = db.prepare('SELECT id FROM budget_version WHERE year = ? LIMIT 1').get(year);
  const orgCount = (db.prepare('SELECT COUNT(*) AS c FROM org').get() as { c: number }).c;
  const accCount = (db.prepare('SELECT COUNT(*) AS c FROM account').get() as { c: number }).c;
  if (!hasVersion && accCount > 0 && orgCount > 0) {
    createVersion(db, { year, name: `${year}年度初始预算草案`, note: '冷启动期初预算版本底座' });
    budgetVersionEnsured = true;
  }

  return {
    accountsCreated,
    dictsCreated,
    projectsCreated,
    suppliersCreated,
    mappingsCreated,
    budgetVersionEnsured,
    validation: validateMasterColdstart(db),
  };
}

export function validateMasterColdstart(db: DB) {
  const orgRows = db.prepare(
    'SELECT code, name, status, org_kind, is_direct_station, is_plan_excluded, contract_prefix_code FROM org'
  ).all() as {
    code: string;
    name: string;
    status: string;
    org_kind: string;
    is_direct_station: number;
    is_plan_excluded: number;
    contract_prefix_code: string;
  }[];

  const blocked = listExternalBlockedPatterns(db);
  let externalInOrg = 0;
  for (const r of orgRows) {
    if (findExternalBlockMatch(blocked, { code: r.code, name: r.name, contractPrefixCode: r.contract_prefix_code })) {
      externalInOrg++;
    }
  }

  const countOf = (table: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  const counts = {
    orgTotal: orgRows.length,
    activeLegalEntities: orgRows.filter((r) => r.org_kind === 'legal_entity' && r.status === 'active').length,
    hqDepts: orgRows.filter((r) => r.org_kind === 'hq_dept' && r.status === 'active').length,
    directUnits: orgRows.filter((r) => r.org_kind === 'direct_unit' && r.status === 'active').length,
    directStations: orgRows.filter((r) => r.is_direct_station === 1).length,
    closedHistory: orgRows.filter((r) => r.org_kind === 'closed_history' && r.status === 'inactive').length,
    externalInOrg,
    accounts: countOf('account'),
    dictItems: countOf('md_dict_item'),
    projects: countOf('md_project'),
    suppliers: countOf('md_supplier'),
    codeMappings: countOf('md_code_mapping'),
  };

  const problems: string[] = [];
  if (counts.orgTotal === 0) problems.push('org 表为空');
  if (counts.externalInOrg > 0) problems.push(`发现 ${counts.externalInOrg} 条外部主体误入 org 表`);
  const activeClosed = orgRows.filter((r) => r.org_kind === 'closed_history' && r.status !== 'inactive');
  if (activeClosed.length > 0) problems.push(`历史关停主体未置 inactive: ${activeClosed.map((r) => r.code).join(',')}`);
  if (counts.accounts === 0) problems.push('account 科目树为空');
  if (counts.dictItems === 0) problems.push('md_dict_item 数据字典为空');

  return { ok: problems.length === 0, counts, problems };
}

function main(): void {
  const dataDir = requireSafeCliDataDir();
  const args = parseCliArgs(process.argv.slice(2));
  const externalInventoryCsv = args['inventory-csv']
    ? fs.readFileSync(path.resolve(args['inventory-csv']), 'utf8')
    : undefined;
  const year = args.year ? Number(args.year) : 2026;
  const db = openDatabase(path.join(dataDir, 'newfc.sqlite'));
  try {
    applyMigrations(db);
    const res = seedMasterColdstart(db, { year, externalInventoryCsv });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    if (!res.validation.ok) process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`seed-master-coldstart-cli 失败：${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
