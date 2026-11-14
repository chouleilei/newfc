import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { requireSafeCliDataDir } from '../src/db/cli-guard';
import { seedOrgsFromCsv } from '../src/modules/org/seed-org-cli';
import { seedMasterColdstart, validateMasterColdstart } from '../src/modules/master/seed-master-coldstart-cli';
import { boot, get, json, post, type Session } from './t3-helpers';
import { fetchAs } from './http-helpers';

const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** 构造完全脱敏的 35 主体结构 CSV（14 存续法人 + 10 本部部门 + 3 直属非法人[仅 2 直属电站] + 8 历史关停主体） */
function buildSynthetic35OrgCsv(): string {
  const lines = [
    'code,parent_code,name,short_name,report_full_name,credit_code,org_kind,contract_prefix_code,plan_issuance_root_code,is_plan_excluded,is_direct_station,status,sort_order,备注',
    'GRP,,流域水电集团母公司,集团母公司,上级主管机构/流域水电集团母公司,91000000000000001A,legal_entity,GRP,GRP,0,0,active,1,集团母公司',
    'SUB_EN,GRP,清洁能源投资子公司,能源公司,上级主管机构/流域水电集团母公司/清洁能源投资子公司,91000000000000002B,legal_entity,EN,SUB_EN,0,0,active,2,一级子公司',
    'SUB_EN_BJ,SUB_EN,北方新能源科技公司,北方能源,上级主管机构/流域水电集团母公司/清洁能源投资子公司/北方新能源科技公司,91000000000000003C,legal_entity,YNX,SUB_EN,0,0,active,3,二级法人',
    'SUB_EN_QZ,SUB_EN_BJ,南部风力发电公司,南部风电,上级主管机构/流域水电集团母公司/清洁能源投资子公司/北方新能源科技公司/南部风力发电公司,91000000000000004D,legal_entity,YNX,SUB_EN,0,0,active,4,三级法人',
    'SUB_EN_XL,SUB_EN,湘南新能源公司,湘南能源,上级主管机构/流域水电集团母公司/清洁能源投资子公司/湘南新能源公司,91000000000000005E,legal_entity,XLX,SUB_EN,0,0,active,5,二级法人',
    'SUB_EN_YF,SUB_EN,中部风能开发公司,中部风能,上级主管机构/流域水电集团母公司/清洁能源投资子公司/中部风能开发公司,91000000000000006F,legal_entity,YFX,SUB_EN,0,0,active,6,二级法人',
    'SUB_EN_DX,SUB_EN,高山风力发电公司,高山风电,上级主管机构/流域水电集团母公司/清洁能源投资子公司/高山风力发电公司,91000000000000007G,legal_entity,EN,SUB_EN,0,0,active,7,沿用母公司简码',
    'SUB_PM,GRP,工程项目管理子公司,项目子公司,上级主管机构/流域水电集团母公司/工程项目管理子公司,91000000000000008H,legal_entity,PM,SUB_PM,0,0,active,8,一级子公司',
    'SUB_SGC,SUB_PM,水利规划设计研究院公司,设计院公司,上级主管机构/流域水电集团母公司/工程项目管理子公司/水利规划设计研究院公司,91000000000000009J,legal_entity,PM,SUB_PM,0,0,active,9,沿用母公司简码',
    'SUB_EX,GRP,小水电合并隔离子公司,隔离水电,上级主管机构/流域水电集团母公司/小水电合并隔离子公司,91000000000000010K,legal_entity,EXS,GRP,1,0,active,10,不单列计划通知',
    'SUB_ZT,GRP,综合实业开发子公司,综合实业,上级主管机构/流域水电集团母公司/综合实业开发子公司,91000000000000011L,legal_entity,ZTX,SUB_ZT,0,0,active,11,一级子公司',
    'SUB_BH,SUB_ZT,园区物业服务公司,物业子公司,上级主管机构/流域水电集团母公司/综合实业开发子公司/园区物业服务公司,91000000000000012M,legal_entity,ZTX,SUB_ZT,0,0,active,12,沿用母公司简码',
    'SUB_WQ,SUB_ZT,生态康养运营公司,康养公司,上级主管机构/流域水电集团母公司/综合实业开发子公司/生态康养运营公司,91000000000000013N,legal_entity,WQX,SUB_ZT,0,0,active,13,二级法人',
    'SUB_ME,GRP,机电检修工程子公司,机电子公司,上级主管机构/流域水电集团母公司/机电检修工程子公司,91000000000000014P,legal_entity,MEX,SUB_ME,0,0,active,14,一级子公司',
  ];
  for (let i = 1; i <= 10; i++) {
    const code = `HQ_D${String(i).padStart(2, '0')}`;
    lines.push(`${code},GRP,本部职能部门${i},职能${i},流域水电集团母公司/本部职能部门${i},,hq_dept,GRP,GRP,0,0,active,${14 + i},本部部门`);
  }
  lines.push(
    'ST_A,GRP,集团甲级直属水电站,甲水电站,流域水电集团母公司/甲级直属水电站,,direct_unit,STA,ST_A,0,1,active,25,直属水电站A',
    'ST_B,GRP,集团乙级直属水电站,乙水电站,流域水电集团母公司/乙级直属水电站,,direct_unit,STB,ST_B,0,1,active,26,直属水电站B',
    'BR_C,GRP,集团丙非电站直属分公司,丙分公司,流域水电集团母公司/丙非电站直属分公司,,direct_unit,BRC,BR_C,0,0,active,27,非直属电站分支机构'
  );
  for (let i = 1; i <= 8; i++) {
    const code = `HIST_${String(i).padStart(2, '0')}`;
    lines.push(`${code},GRP,历史已注销主体${i},历史${i},流域水电集团母公司/历史已注销主体${i},,closed_history,GRP,GRP,1,0,inactive,${27 + i},历史吸收注销`);
  }
  return lines.join('\n');
}

describe('T-GAP-01 组织主体 6 列扩展、非空 V72→V73 迁移与冷启动主数据基座', () => {
  it('非空 V72 数据库平滑升级至 V73：保留既有合同/文档/结算/付款/法审与触发器且通过外键校验', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-v72-to-v73-'));
    const dbPath = path.join(dir, 'drill.sqlite');
    const db = openDatabase(dbPath);
    const now = '2026-11-14T08:00:00.000Z';
    try {
      applyMigrations(db, 72);
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(72);

      const orgId = Number(
        db.prepare("INSERT INTO org (parent_id, code, name, sort_order, status, report_full_name, created_at, updated_at) VALUES (NULL, 'ORG_HQ', '测试本部', 1, 'active', '测试本部全称', ?, ?)")
          .run(now, now).lastInsertRowid
      );
      const fId = Number(
        db.prepare("INSERT INTO file_object (sha256, size_bytes, content_type, original_name, created_at) VALUES (?, 128, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'body.docx', ?)")
          .run('a'.repeat(64), now).lastInsertRowid
      );
      const cid = Number(
        db.prepare(`INSERT INTO ct_contract (
          contract_no, normalized_no, name, org_id, original_cents, settled_gross_cents, settled_net_cents, paid_cents,
          stage, status, completed_date, out_of_plan_approved_date, created_at, updated_at
        ) VALUES ('GRP-CG-01/2026-001', 'GRP-CG-01/2026-001', '升级前存量合同', ?, 1000000, 500000, 480000, 300000, 'performance', 'active', NULL, '2026-02-01', ?, ?)`)
          .run(orgId, now, now).lastInsertRowid
      );
      const docId = Number(
        db.prepare("INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_at, evidence_kind) VALUES (?, 'contract_text', ?, '正文.docx', ?, 'other')")
          .run(cid, fId, now).lastInsertRowid
      );
      const setId = Number(
        db.prepare(`INSERT INTO ct_settlement (
          contract_id, period_no, settlement_kind, settlement_date,
          in_contract_cents, change_claim_cents, other_add_cents, gross_payable_cents,
          deduct_prepayment_cents, deduct_retention_cents, deduct_penalty_cents, total_deduct_cents, net_payable_cents,
          evidence_document_id, status, submitted_at
        ) VALUES (?, 1, 'progress', '2026-05-01', 500000, 0, 0, 500000, 0, 20000, 0, 20000, 480000, ?, 'approved', ?)`)
          .run(cid, docId, now).lastInsertRowid
      );
      db.prepare(`INSERT INTO ct_payment (
        contract_id, kind, settlement_id, payment_type, node_name, currency, amount_cents, feasibility_doc_id, status, submitted_at
      ) VALUES (?, 'normal', ?, 'progress', '首期款', '人民币', 300000, ?, 'approved', ?)`)
        .run(cid, setId, docId, now);
      db.prepare(`INSERT INTO ct_legal_run (
        contract_id, document_id, document_sha256, contract_version, context_fingerprint, policy_refs_json,
        parse_channel, parse_status, model_status, verdict, risk_level, summary_json, elements_json, stats_json, created_at
      ) VALUES (?, ?, ?, 1, 'fp1', '[]', 'docx_native', 'ok', 'skipped', 'manual_review', 'low', '[]', '{}', '{}', ?)`)
        .run(cid, docId, 'a'.repeat(64), now);

      const applied = applyMigrations(db);
      expect(applied.map((m) => m.version)).toContain(73);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      const upgraded = db.prepare('SELECT org_id, legal_entity_org_id, origin, migration_mode, out_of_plan_approved_date FROM ct_contract WHERE id = ?').get(cid) as Record<string, unknown>;
      expect(upgraded).toMatchObject({
        org_id: orgId,
        legal_entity_org_id: orgId,
        origin: 'manual',
        migration_mode: 'normal',
        out_of_plan_approved_date: '2026-02-01',
      });

      expect(() => db.prepare("UPDATE ct_document SET name = '篡改' WHERE id = ?").run(docId)).toThrow(/不可修改/);
      expect(() => db.prepare("DELETE FROM ct_settlement WHERE id = ?").run(setId)).toThrow(/不可删除/);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GET /api/org/tree 与 POST/PATCH /api/org 返回 7 个 camelCase 扩展属性，并配置化拦截外部主体', async () => {
    const { base, admin, db } = await boot('newfc-t13-org-api-');
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO ct_prefix_org_map (
      raw_prefix, canonical_prefix, legal_entity_org_id, entity_status, allow_new_contract, prefix_kind, note, created_at, updated_at
    ) VALUES ('EXTV', 'EXT', NULL, 'external', 0, 'external_counterparty', '外部排除: 外部联营测试公司', ?, ?)`).run(now, now);

    const rootRes = await post(base, admin, '/api/org', {
      parentId: null,
      code: 'HQ_ROOT',
      name: '合成集团母公司',
      orgKind: 'legal_entity',
      creditCode: '91000000000000099X',
      contractPrefixCode: 'HQR',
      reportFullName: '上级机构/合成集团母公司',
      isPlanExcluded: false,
      isDirectStation: false,
    });
    expect(rootRes.status).toBe(201);
    const root = await json(rootRes);
    expect(root).toMatchObject({
      code: 'HQ_ROOT',
      orgKind: 'legal_entity',
      creditCode: '91000000000000099X',
      contractPrefixCode: 'HQR',
      isPlanExcluded: false,
      isDirectStation: false,
      reportFullName: '上级机构/合成集团母公司',
    });

    const stRes = await post(base, admin, '/api/org', {
      parentId: root.id,
      code: 'ST_01',
      name: '合成直属水电站',
      orgKind: 'direct_unit',
      planIssuanceRootId: root.id,
      contractPrefixCode: 'ST01',
      isDirectStation: true,
    });
    expect(stRes.status).toBe(201);

    const patched = await json(
      patch(base, admin, `/api/org/${root.id}`, {
        reportFullName: '上级机构/合成集团母公司(更新)',
        isPlanExcluded: true,
      })
    );
    expect(patched.isPlanExcluded).toBe(true);
    expect(patched.reportFullName).toBe('上级机构/合成集团母公司(更新)');

    const extByName = await post(base, admin, '/api/org', {
      parentId: root.id,
      code: 'SUB_OK',
      name: '外部联营测试公司项目部',
      orgKind: 'legal_entity',
    });
    expect(extByName.status).toBe(400);
    expect((await json(extByName)).code).toBe('EXTERNAL_ENTITY_FORBIDDEN');

    const extByPrefix = await post(base, admin, '/api/org', {
      parentId: root.id,
      code: 'EXTV',
      name: '正常名称主体',
      orgKind: 'legal_entity',
    });
    expect(extByPrefix.status).toBe(400);
    expect((await json(extByPrefix)).code).toBe('EXTERNAL_ENTITY_FORBIDDEN');

    const treeBody = await json(get(base, admin, '/api/org/tree'));
    const hqNode = treeBody.tree.find((n: { code: string }) => n.code === 'HQ_ROOT');
    expect(hqNode).toMatchObject({
      orgKind: 'legal_entity',
      creditCode: '91000000000000099X',
      isPlanExcluded: true,
      contractPrefixCode: 'HQR',
      isDirectStation: false,
    });
    const stNode = hqNode.children.find((n: { code: string }) => n.code === 'ST_01');
    expect(stNode).toMatchObject({
      orgKind: 'direct_unit',
      planIssuanceRootId: root.id,
      isDirectStation: true,
    });
    expect(treeBody.externalBlockedPatterns.prefixes).toContain('EXTV');
    expect(treeBody.externalBlockedPatterns.names).toContain('外部联营测试公司');
  });

  it('冷启动主数据初始化套件幂等验证：14+10+3(含2直属电站)+8 精确分类，配套科目/字典/项目/供应商完整且 CLI 目录守卫生效', () => {
    expect(() => requireSafeCliDataDir({})).toThrow(/必须显式设置环境变量 NEWFC_DATA_DIR/);
    expect(() => requireSafeCliDataDir({ NEWFC_DATA_DIR: path.join(process.cwd(), 'data') })).toThrow(/禁止指向工作区默认目录/);
    expect(() => requireSafeCliDataDir({ NEWFC_DATA_DIR: '/data/newfc-data' })).toThrow(/严禁 CLI 访问受保护目录/);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-coldstart-'));
    const db = openDatabase(path.join(dir, 'coldstart.sqlite'));
    try {
      applyMigrations(db);
      const csv = buildSynthetic35OrgCsv();
      const first = seedOrgsFromCsv(db, csv, 'confirm');
      expect(first).toMatchObject({ created: 35, updated: 0, errors: [] });

      const second = seedOrgsFromCsv(db, csv, 'confirm');
      expect(second).toMatchObject({ created: 0, updated: 35, errors: [] });

      const cold = seedMasterColdstart(db, {
        year: 2026,
        suppliers: [
          { code: 'SUP-01', name: '甲级水工建设有限公司', supplierType: 'contractor', isInPool: true, aliases: ['甲级水工曾用名公司'] },
        ],
      });
      expect(cold.validation.ok).toBe(true);
      expect(cold.validation.counts).toMatchObject({
        orgTotal: 35,
        activeLegalEntities: 14,
        hqDepts: 10,
        directUnits: 3,
        directStations: 2,
        closedHistory: 8,
        externalInOrg: 0,
      });
      expect(cold.validation.counts.accounts).toBeGreaterThanOrEqual(12);
      expect(cold.validation.counts.dictItems).toBeGreaterThanOrEqual(7);
      expect(cold.validation.counts.projects).toBeGreaterThanOrEqual(1);
      expect(cold.validation.counts.suppliers).toBeGreaterThanOrEqual(1);
      expect(cold.validation.counts.codeMappings).toBeGreaterThanOrEqual(35);

      const directRows = db.prepare("SELECT code, is_direct_station FROM org WHERE org_kind = 'direct_unit' ORDER BY code").all() as {
        code: string;
        is_direct_station: number;
      }[];
      expect(directRows).toEqual([
        { code: 'BR_C', is_direct_station: 0 },
        { code: 'ST_A', is_direct_station: 1 },
        { code: 'ST_B', is_direct_station: 1 },
      ]);

      const coldAgain = seedMasterColdstart(db, { year: 2026 });
      expect(coldAgain.accountsCreated).toBe(0);
      expect(validateMasterColdstart(db).ok).toBe(true);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
