import fs from 'fs';
import path from 'path';
import { openDatabase, type DB } from '../../db/connection';
import { applyMigrations } from '../../db/migrations';
import { parseCliArgs, parseCsvObjects, requireSafeCliDataDir } from '../../db/cli-guard';
import { PREFIX_ENTITY_STATUSES, PREFIX_KINDS, type PrefixEntityStatus, type PrefixKind } from '../../contracts/contract-lifecycle';

interface OrgLookupRow {
  id: number;
  code: string;
  org_kind: string;
  parent_id: number | null;
}

export interface PrefixSeedResult {
  mode: 'preview' | 'confirm';
  totalRows: number;
  created: number;
  updated: number;
  allowNewCount: number;
  byStatus: Record<PrefixEntityStatus, number>;
  errors: { row: number; message: string }[];
}

export function seedPrefixMapFromCsv(
  db: DB,
  csvContent: string,
  mode: 'preview' | 'confirm' = 'confirm',
): PrefixSeedResult {
  const records = parseCsvObjects(csvContent);
  const orgRows = db.prepare('SELECT id, code, org_kind, parent_id FROM org').all() as OrgLookupRow[];
  const orgByCode = new Map(orgRows.map((o) => [o.code.toUpperCase(), o]));
  const orgById = new Map(orgRows.map((o) => [o.id, o]));

  const nearestLegalId = (orgId: number | null): number | null => {
    let cur = orgId != null ? orgById.get(orgId) : undefined;
    while (cur) {
      if (cur.org_kind === 'legal_entity') return cur.id;
      cur = cur.parent_id != null ? orgById.get(cur.parent_id) : undefined;
    }
    return null;
  };

  const errors: { row: number; message: string }[] = [];
  const byStatus: Record<PrefixEntityStatus, number> = {
    active_legal: 0,
    direct_unit: 0,
    inherited_child: 0,
    closed_history: 0,
    external: 0,
    ignore: 0,
  };

  interface ParsedSeedItem {
    rawPrefix: string;
    canonicalPrefix: string;
    legalEntityOrgId: number | null;
    signingOrgId: number | null;
    successorOrgId: number | null;
    parentCanonicalPrefix: string;
    entityStatus: PrefixEntityStatus;
    allowNewContract: number;
    prefixKind: PrefixKind;
    sampleContractNo: string;
    occurrenceCount: number;
    note: string;
  }
  const items: ParsedSeedItem[] = [];

  records.forEach((r, idx) => {
    const rowNo = idx + 2;
    const rawPrefix = (r.raw_prefix ?? r.rawPrefix ?? '').normalize('NFKC').trim().toUpperCase();
    const canonicalPrefix = (r.canonical_prefix ?? r.canonicalPrefix ?? '').normalize('NFKC').trim().toUpperCase();
    if (!rawPrefix || !canonicalPrefix) {
      errors.push({ row: rowNo, message: 'raw_prefix 或 canonical_prefix 为空' });
      return;
    }

    const legalCode = (r.legal_entity_code ?? r.legalEntityCode ?? '').trim().toUpperCase();
    const signingCode = (r.signing_org_code ?? r.signingOrgCode ?? '').trim().toUpperCase();
    const signingNameHint = (r.signing_org_name ?? r.signingOrgName ?? '').trim();
    const rawStatus = (r.entity_status ?? r.entityStatus ?? '').trim();

    let legalOrg = legalCode ? orgByCode.get(legalCode) ?? null : null;
    let signingOrg = signingCode ? orgByCode.get(signingCode) ?? null : null;

    if (!signingOrg && rawStatus === 'external' && signingNameHint) {
      const codeTokens = signingNameHint.toUpperCase().match(/[A-Z]{2,6}/g) ?? [];
      for (const tok of codeTokens) {
        const found = orgByCode.get(tok);
        if (found) {
          signingOrg = found;
          break;
        }
      }
    }
    if (!legalOrg && rawPrefix === 'CS-服务' && signingOrg) {
      const lid = nearestLegalId(signingOrg.id);
      if (lid != null) legalOrg = orgById.get(lid) ?? null;
    }

    let entityStatus: PrefixEntityStatus;
    if ((PREFIX_ENTITY_STATUSES as readonly string[]).includes(rawStatus)) {
      entityStatus = rawStatus as PrefixEntityStatus;
    } else if (rawStatus === 'active') {
      if (signingOrg?.org_kind === 'direct_unit') entityStatus = 'direct_unit';
      else if (signingOrg?.org_kind === 'legal_entity' && signingOrg.code.toUpperCase() !== canonicalPrefix) {
        entityStatus = 'inherited_child';
      } else entityStatus = 'active_legal';
    } else if (rawStatus === 'inactive') {
      entityStatus = 'closed_history';
    } else {
      errors.push({ row: rowNo, message: `未知 entity_status: ${rawStatus}` });
      return;
    }

    if (!['external', 'ignore'].includes(entityStatus) && !legalOrg) {
      errors.push({ row: rowNo, message: `前缀 ${rawPrefix} 未能在 org 表中找到对应法人编码 ${legalCode}` });
      return;
    }

    const csvAllowNew = String(r.allow_new_contract ?? r.allowNewContract ?? '0').trim() === '1';
    const allowNewContract =
      csvAllowNew &&
      ['active_legal', 'direct_unit'].includes(entityStatus) &&
      (rawPrefix === canonicalPrefix || rawPrefix === 'CJ')
        ? 1
        : 0;

    const rawKind = (r.prefix_kind ?? r.prefixKind ?? 'internal_prefix').trim();
    const prefixKind: PrefixKind = (PREFIX_KINDS as readonly string[]).includes(rawKind)
      ? (rawKind as PrefixKind)
      : 'internal_prefix';

    const successorOrgId = entityStatus === 'closed_history' ? (legalOrg?.id ?? null) : null;
    byStatus[entityStatus]++;
    items.push({
      rawPrefix,
      canonicalPrefix,
      legalEntityOrgId: legalOrg?.id ?? null,
      signingOrgId: signingOrg?.id ?? null,
      successorOrgId,
      parentCanonicalPrefix: (r.parent_canonical_prefix ?? r.parentCanonicalPrefix ?? '').trim().toUpperCase(),
      entityStatus,
      allowNewContract,
      prefixKind,
      sampleContractNo: (r.sample_contract_no ?? r.sampleContractNo ?? '').trim(),
      occurrenceCount: Math.max(0, Number.parseInt(String(r.occurrence_count ?? r.occurrenceCount ?? '0'), 10) || 0),
      note: (r['备注'] ?? r.note ?? '').trim(),
    });
  });

  const allowNewCount = items.filter((i) => i.allowNewContract === 1).length;
  if (mode === 'preview' || errors.length > 0) {
    return { mode, totalRows: records.length, created: 0, updated: 0, allowNewCount, byStatus, errors };
  }

  let created = 0;
  let updated = 0;
  const now = new Date().toISOString();
  db.transaction(() => {
    for (const it of items) {
      const existing = db.prepare('SELECT id FROM ct_prefix_org_map WHERE raw_prefix = ?').get(it.rawPrefix) as { id: number } | undefined;
      if (existing) {
        db.prepare(
          `UPDATE ct_prefix_org_map SET
            canonical_prefix = ?, legal_entity_org_id = ?, signing_org_id = ?, successor_org_id = ?,
            parent_canonical_prefix = ?, entity_status = ?, allow_new_contract = ?, prefix_kind = ?,
            sample_contract_no = ?, occurrence_count = ?, note = ?, updated_at = ?
          WHERE id = ?`,
        ).run(
          it.canonicalPrefix,
          it.legalEntityOrgId,
          it.signingOrgId,
          it.successorOrgId,
          it.parentCanonicalPrefix,
          it.entityStatus,
          it.allowNewContract,
          it.prefixKind,
          it.sampleContractNo,
          it.occurrenceCount,
          it.note,
          now,
          existing.id,
        );
        updated++;
      } else {
        db.prepare(
          `INSERT INTO ct_prefix_org_map (
            raw_prefix, canonical_prefix, legal_entity_org_id, signing_org_id, successor_org_id,
            parent_canonical_prefix, entity_status, allow_new_contract, prefix_kind,
            sample_contract_no, occurrence_count, note, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          it.rawPrefix,
          it.canonicalPrefix,
          it.legalEntityOrgId,
          it.signingOrgId,
          it.successorOrgId,
          it.parentCanonicalPrefix,
          it.entityStatus,
          it.allowNewContract,
          it.prefixKind,
          it.sampleContractNo,
          it.occurrenceCount,
          it.note,
          now,
          now,
        );
        created++;
      }
    }
  })();

  return { mode, totalRows: records.length, created, updated, allowNewCount, byStatus, errors };
}

function main(): void {
  const dataDir = requireSafeCliDataDir();
  const args = parseCliArgs(process.argv.slice(2));
  const csvPath = args.csv;
  if (!csvPath) {
    throw new Error('请通过 --csv <path> 指定合同前缀映射 CSV 文件路径');
  }
  const mode = args.mode === 'preview' ? 'preview' : 'confirm';
  const csvContent = fs.readFileSync(path.resolve(csvPath), 'utf8');
  const db = openDatabase(path.join(dataDir, 'newfc.sqlite'));
  try {
    applyMigrations(db);
    const res = seedPrefixMapFromCsv(db, csvContent, mode);
    if (res.errors.length > 0) {
      throw new Error(`前缀映射校验失败 (${res.errors.length} 项): ${res.errors[0].message}`);
    }
    process.stdout.write(`${JSON.stringify(res)}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`seed-prefix-map-cli 失败：${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
