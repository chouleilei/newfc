import fs from 'fs';
import path from 'path';
import { openDatabase, type DB } from '../../db/connection';
import { applyMigrations } from '../../db/migrations';
import { parseCliArgs, parseCsvObjects, requireSafeCliDataDir } from '../../db/cli-guard';
import { seedOrgsFromCsv } from '../org/seed-org-cli';
import { seedPrefixMapFromCsv } from './seed-prefix-map-cli';
import {
  commitLegacyMigrationPlan,
  computeLegacyMigrationPlan,
  type LegacyPipelinePlan,
  type LegacyWorkbookInput,
} from './legacy-migration-pipeline';

export interface DeltaReconcileSummary {
  mode: 'preview' | 'confirm';
  workbookCount: number;
  reconciliation: LegacyPipelinePlan['reconciliation'];
  referenceCodeStats: LegacyPipelinePlan['referenceCodeStats'];
  externalBlockedFiles: string[];
  committed: { created: number; updated: number; unchanged: number; writeLockMs: number } | null;
  auditCounts: {
    totalDbContracts: number;
    duplicateConflictRows: number;
    internalGroupRows: number;
    multiCurrencyRows: number;
    voucherDebitClueRows: number;
    unverifiedForecastRows: number;
    missingSignDateRows: number;
    reversalSettlementRows: number;
  };
  elapsedMs: number;
  peakRssMb: number;
}

function registerExternalRejectedFromInventory(db: DB, records: Record<string, string>[]): void {
  const now = new Date().toISOString();
  for (const r of records) {
    if ((r.batch_group ?? '').trim() !== 'governance-rejected') continue;
    const rawTarget = (r.target_entities ?? '').replace(/（.*?）|\(.*?\)/g, '').replace(/^外部主体/, '').trim();
    if (!rawTarget || rawTarget === 'N/A') continue;
    const itemValue = `EXT_${(r.inventory_id || 'RULE').trim().toUpperCase()}`;
    const ex = db
      .prepare("SELECT id FROM md_dict_item WHERE dict_type = 'org_external_blocklist' AND item_value = ?")
      .get(itemValue) as { id: number } | undefined;
    if (ex) {
      db.prepare("UPDATE md_dict_item SET item_label = ?, status = 'active', updated_at = ? WHERE id = ?").run(rawTarget, now, ex.id);
      continue;
    }
    db.prepare(
      `INSERT INTO md_dict_item (dict_type, item_value, item_label, sort_order, status, created_at, updated_at)
       VALUES ('org_external_blocklist', ?, ?, 10, 'active', ?, ?)`,
    ).run(itemValue, rawTarget, now, now);
  }
}

export async function runDeltaReconcileFromInventory(
  db: DB,
  params: {
    orgCsvContent?: string;
    prefixCsvContent?: string;
    inventoryCsvContent: string;
    materialsDir: string;
    extraWorkbookPaths?: string[];
    mode?: 'preview' | 'confirm';
    reverseOrder?: boolean;
  },
): Promise<DeltaReconcileSummary> {
  const t0 = Date.now();
  let peakRss = process.memoryUsage().rss;
  const trackMem = () => {
    const cur = process.memoryUsage().rss;
    if (cur > peakRss) peakRss = cur;
  };

  if (params.orgCsvContent) {
    seedOrgsFromCsv(db, params.orgCsvContent, 'confirm');
  }
  if (params.prefixCsvContent) {
    const pRes = seedPrefixMapFromCsv(db, params.prefixCsvContent, 'confirm');
    if (pRes.errors.length > 0) {
      throw new Error(`前缀字典初始化失败: ${pRes.errors[0].message}`);
    }
  }

  const invRecords = parseCsvObjects(params.inventoryCsvContent);
  registerExternalRejectedFromInventory(db, invRecords);

  const workbooks: LegacyWorkbookInput[] = [];
  for (const r of invRecords) {
    const shouldIngest = (r.should_ingest ?? '').trim() === '1';
    if (!shouldIngest) continue;
    const rel = (r.relative_path ?? '').trim();
    const fullPath = path.resolve(params.materialsDir, rel);
    const content = fs.readFileSync(fullPath);
    workbooks.push({
      inventoryId: (r.inventory_id ?? '').trim(),
      batchGroup: (r.batch_group ?? '').trim(),
      fileName: (r.filename ?? path.basename(fullPath)).trim(),
      content,
      shouldIngest: true,
    });
  }

  for (const extra of params.extraWorkbookPaths ?? []) {
    const full = path.resolve(extra);
    workbooks.push({
      fileName: path.basename(full),
      content: fs.readFileSync(full),
      batchGroup: '2026-09-zip',
      shouldIngest: true,
    });
  }

  if (params.reverseOrder) {
    workbooks.reverse();
  }
  trackMem();

  const plan = await computeLegacyMigrationPlan(db, workbooks);
  trackMem();

  const mode = params.mode ?? 'confirm';
  let committed: DeltaReconcileSummary['committed'] = null;
  if (mode === 'confirm') {
    const res = commitLegacyMigrationPlan(db, plan);
    committed = {
      created: res.created,
      updated: res.updated,
      unchanged: res.unchanged,
      writeLockMs: res.writeLockMs,
    };
    trackMem();
  }

  const cnt = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const auditCounts = {
    totalDbContracts: cnt('SELECT COUNT(*) AS n FROM ct_contract'),
    duplicateConflictRows: cnt("SELECT COUNT(*) AS n FROM ct_contract WHERE duplicate_conflict_group <> ''"),
    internalGroupRows: cnt('SELECT COUNT(*) AS n FROM ct_contract WHERE is_internal_group_tx = 1'),
    multiCurrencyRows: cnt("SELECT COUNT(*) AS n FROM ct_contract WHERE currency_struct_status <> 'single'"),
    voucherDebitClueRows: cnt("SELECT COUNT(*) AS n FROM ct_contract WHERE amount_fact_source = 'voucher_debit_clue'"),
    unverifiedForecastRows: cnt("SELECT COUNT(*) AS n FROM ct_contract WHERE amount_fact_source = 'unverified_forecast'"),
    missingSignDateRows: cnt('SELECT COUNT(*) AS n FROM ct_contract WHERE sign_date IS NULL'),
    reversalSettlementRows: cnt('SELECT COUNT(*) AS n FROM ct_settlement WHERE is_reversal = 1'),
  };

  return {
    mode,
    workbookCount: workbooks.length,
    reconciliation: plan.reconciliation,
    referenceCodeStats: plan.referenceCodeStats,
    externalBlockedFiles: plan.externalBlockedFiles,
    committed,
    auditCounts,
    elapsedMs: Date.now() - t0,
    peakRssMb: Math.round((peakRss / 1024 / 1024) * 100) / 100,
  };
}

async function main(): Promise<void> {
  const dataDir = requireSafeCliDataDir();
  const args = parseCliArgs(process.argv.slice(2));
  const invPath = args['inventory-csv'] ?? args.inventory;
  const materialsDir = args['materials-dir'] ?? args.materials;
  if (!invPath || !materialsDir) {
    throw new Error('用法: --inventory-csv <ledger-inventory.csv> --materials-dir <materials/contract-ledgers> [--org-csv <path>] [--prefix-csv <path>] [--mode preview|confirm]');
  }
  const orgCsvContent = args['org-csv'] ? fs.readFileSync(path.resolve(args['org-csv']), 'utf8') : undefined;
  const prefixCsvContent = args['prefix-csv'] ? fs.readFileSync(path.resolve(args['prefix-csv']), 'utf8') : undefined;
  const inventoryCsvContent = fs.readFileSync(path.resolve(invPath), 'utf8');
  const extraWorkbookPaths = args['extra-files']
    ? args['extra-files'].split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const mode = args.mode === 'preview' ? 'preview' : 'confirm';
  const reverseOrder = args.reverse === '1' || args.reverse === 'true';

  const db = openDatabase(path.join(dataDir, 'newfc.sqlite'));
  try {
    applyMigrations(db);
    const res = await runDeltaReconcileFromInventory(db, {
      orgCsvContent,
      prefixCsvContent,
      inventoryCsvContent,
      materialsDir: path.resolve(materialsDir),
      extraWorkbookPaths,
      mode,
      reverseOrder,
    });
    process.stdout.write(`${JSON.stringify(res)}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`delta-reconcile-cli 失败：${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
