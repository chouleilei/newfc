import fs from 'fs';
import path from 'path';
import { openDatabase, type DB } from '../../db/connection';
import { applyMigrations } from '../../db/migrations';
import { parseCliArgs, parseCsvObjects, requireSafeCliDataDir } from '../../db/cli-guard';
import { confirmOrgBatchImport, previewOrgBatchImport, type OrgBatchImportResult, type OrgImportRowInput } from './org.service';
import { normalizeName } from '../master/master.service';

export function mapOrgSeedCsvRows(csvContent: string): { rows: OrgImportRowInput[]; shortNames: { code: string; shortName: string }[] } {
  const rawRecords = parseCsvObjects(csvContent);
  const rows: OrgImportRowInput[] = [];
  const shortNames: { code: string; shortName: string }[] = [];
  for (const r of rawRecords) {
    const code = r.code || r['编码'] || '';
    const shortName = r.short_name || r.shortName || r['简称'] || '';
    rows.push({
      code,
      parentCode: r.parent_code ?? r.parentCode ?? r['父编码'] ?? '',
      name: r.name ?? r['名称'] ?? '',
      reportFullName: r.report_full_name ?? r.reportFullName ?? r['报表全称'] ?? '',
      creditCode: r.credit_code ?? r.creditCode ?? r['统一社会信用代码'] ?? '',
      orgKind: r.org_kind ?? r.orgKind ?? r['主体分类'] ?? 'legal_entity',
      contractPrefixCode: r.contract_prefix_code ?? r.contractPrefixCode ?? r['合同前缀'] ?? '',
      planIssuanceRootCode: r.plan_issuance_root_code ?? r.planIssuanceRootCode ?? r['归口主单位'] ?? '',
      isPlanExcluded: r.is_plan_excluded ?? r.isPlanExcluded ?? '0',
      isDirectStation: r.is_direct_station ?? r.isDirectStation ?? '0',
      status: r.status ?? r['状态'] ?? 'active',
      sortOrder: r.sort_order ?? r.sortOrder ?? undefined,
    });
    if (code && shortName) {
      shortNames.push({ code, shortName });
    }
  }
  return { rows, shortNames };
}

export function seedOrgsFromCsv(
  db: DB,
  csvContent: string,
  mode: 'preview' | 'confirm' = 'confirm'
): OrgBatchImportResult & { shortNameMappings: number } {
  const { rows, shortNames } = mapOrgSeedCsvRows(csvContent);
  if (mode === 'preview') {
    return { ...previewOrgBatchImport(db, rows), shortNameMappings: 0 };
  }
  const res = confirmOrgBatchImport(db, rows);
  let shortNameMappings = 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const { code, shortName } of shortNames) {
      const orgRow = db.prepare('SELECT id, status FROM org WHERE code = ?').get(code) as { id: number; status: string } | undefined;
      if (!orgRow) continue;
      const sourceKey = normalizeName(shortName);
      if (!sourceKey) continue;
      const existing = db.prepare(
        "SELECT id, target_id FROM md_code_mapping WHERE source_system = 'org_short_name' AND entity_type = 'org' AND match_kind = 'name' AND source_key = ? AND valid_to IS NULL"
      ).get(sourceKey) as { id: number; target_id: number } | undefined;
      if (existing) {
        if (existing.target_id === orgRow.id) continue;
        db.prepare('UPDATE md_code_mapping SET valid_to = ?, retired_at = ? WHERE id = ?').run(now, now, existing.id);
      }
      db.prepare(
        `INSERT INTO md_code_mapping (source_system, entity_type, match_kind, source_key, source_label, target_id, valid_from, note, created_by, created_at)
         VALUES ('org_short_name', 'org', 'name', ?, ?, ?, '2000-01-01T00:00:00.000Z', '组织简称冷启动映射', NULL, ?)`
      ).run(sourceKey, shortName, orgRow.id, now);
      shortNameMappings++;
    }
  })();
  return { ...res, shortNameMappings };
}

function main(): void {
  const dataDir = requireSafeCliDataDir();
  const args = parseCliArgs(process.argv.slice(2));
  const csvPath = args.csv;
  if (!csvPath) {
    throw new Error('请通过 --csv <path> 指定组织主数据 CSV 文件路径');
  }
  const mode = args.mode === 'preview' ? 'preview' : 'confirm';
  const csvContent = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const db = openDatabase(path.join(dataDir, 'newfc.sqlite'));
  try {
    applyMigrations(db);
    const res = seedOrgsFromCsv(db, csvContent, mode);
    process.stdout.write(
      `${JSON.stringify({ mode: res.mode, created: res.created, updated: res.updated, shortNameMappings: res.shortNameMappings, errorCount: res.errors.length })}\n`
    );
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`seed-org-cli 失败：${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
