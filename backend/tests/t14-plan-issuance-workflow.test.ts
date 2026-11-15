import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { seedOrgsFromCsv } from '../src/modules/org/seed-org-cli';
import { boot, get, json, post, upload } from './t3-helpers';
import { createScopedUser } from './http-helpers';

/** 构造完全脱敏的 8 个下达单元 + 1 个免发主体 + 本部部门组织树 */
function buildDesensitized8UnitOrgCsv(): string {
  return [
    'code,parent_code,name,short_name,report_full_name,credit_code,org_kind,contract_prefix_code,plan_issuance_root_code,is_plan_excluded,is_direct_station,status,sort_order,备注',
    'GRP_HQ,,流域水电集团总部,集团总部,流域水电集团总部,91000000000000001A,legal_entity,GRP,GRP_HQ,0,0,active,1,集团总部',
    'HQ_FIN,GRP_HQ,集团财务资产部,财务部,流域水电集团总部/集团财务资产部,,hq_dept,GRP,GRP_HQ,0,0,active,2,本部部门并入总部',
    'ST_HUB_A,GRP_HQ,甲级直属水电枢纽,甲枢纽,流域水电集团总部/甲级直属水电枢纽,,direct_unit,STA,ST_HUB_A,0,1,active,3,直属电站A',
    'ST_HUB_B,GRP_HQ,乙级直属水电枢纽,乙枢纽,流域水电集团总部/乙级直属水电枢纽,,direct_unit,STB,ST_HUB_B,0,1,active,4,直属电站B',
    'BR_OP_C,GRP_HQ,丙区综合运维分公司,丙分公司,流域水电集团总部/丙区综合运维分公司,,direct_unit,BRC,BR_OP_C,0,0,active,5,非电站直属分支',
    'SUB_EN_D,GRP_HQ,清洁能源开发子公司,能源子公司,流域水电集团总部/清洁能源开发子公司,91000000000000002B,legal_entity,END,SUB_EN_D,0,0,active,6,独立法人子公司D',
    'SUB_IND_E,GRP_HQ,综合实业运营子公司,实业子公司,流域水电集团总部/综合实业运营子公司,91000000000000003C,legal_entity,INE,SUB_IND_E,0,0,active,7,独立法人子公司E',
    'SUB_PM_F,GRP_HQ,工程建设管理子公司,建管子公司,流域水电集团总部/工程建设管理子公司,91000000000000004D,legal_entity,PMF,SUB_PM_F,0,0,active,8,独立法人子公司F',
    'SUB_ME_G,GRP_HQ,机电检修科技子公司,机电子公司,流域水电集团总部/机电检修科技子公司,91000000000000005E,legal_entity,MEG,SUB_ME_G,0,0,active,9,独立法人子公司G',
    'SUB_EX_X,GRP_HQ,合并隔离小型水电公司,隔离子公司,流域水电集团总部/合并隔离小型水电公司,91000000000000009Z,legal_entity,EXX,GRP_HQ,1,0,active,10,免发通知但纳入合并',
  ].join('\n');
}

function buildSyntheticPlanWorkbook(): Buffer {
  const wb = XLSX.utils.book_new();
  const purchaseRows = [
    ['2026年固定资产购置计划表 单位：元'],
    ['序号', '设备名称', '年度计划', '年度实际', '承办单位'],
    ['1', '甲枢纽主变在线监测装置', 1200000, 300000, '甲级直属水电枢纽'],
    ['2', '能源子公司逆变器备件', 800000, 200000, '清洁能源开发子公司'],
  ];
  const maintRows = [
    ['2026年运行维护费 单位：元'],
    ['序号', '项目名称', '年度计划', '本年累计实际', '承办单位'],
    ['1', '甲枢纽日常运行维护', 1060000, 250000, '甲级直属水电枢纽'],
    ['2', '能源子公司风场运维', 530000, 100000, '清洁能源开发子公司'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(purchaseRows), '固定资产购置计划');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(maintRows), '运行维护费');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('T-GAP-06 / AC-T14-02 V72→V73→V74 迁移与综合计划 8 单元合一下达、签收及 6 类调整闭环', () => {
  it('非空 V72 数据库平滑升级至 V73 再升级至 V74，通过 integrity_check 与 foreign_key_check 且保留触发器', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-v72-v74-'));
    const dbPath = path.join(tmpDir, 'upgrade.sqlite');
    const db = openDatabase(dbPath);
    const now = '2026-11-14T10:00:00.000Z';
    try {
      applyMigrations(db, 72);
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(72);

      // 在 V72 写入非空 std_report 与 risk_item 数据
      db.prepare(`INSERT INTO org (id, parent_id, code, name, status, sort_order, created_at, updated_at) VALUES (1, NULL, 'HQ01', '测试集团本部', 'active', 1, ?, ?)`).run(now, now);
      db.prepare(`
        INSERT INTO std_report (
          report_type, title, org_id, period, params_json, columns_json, rows_json,
          summary_json, sources_json, content_sha256, status, generated_at
        ) VALUES ('budget_execution', '预算执行测试报表', 1, '2026-06', '{}', '[]', '[]', '{}', '[]', ?, 'generated', ?)
      `).run('a'.repeat(64), now);

      applyMigrations(db, 73);
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(73);

      applyMigrations(db, 74);
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(74);

      const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
      expect(integrity[0].integrity_check).toBe('ok');
      const fkErrors = db.pragma('foreign_key_check') as unknown[];
      expect(fkErrors).toHaveLength(0);

      // 验证 V74 全部 52 项制度规则（51 行新规则 + 原有 12 行，且 rule_scope 33+18 精确匹配）
      const net33 = (db.prepare(`SELECT COUNT(*) AS n FROM risk_rule WHERE rule_scope = 'supervision_net_33'`).get() as { n: number }).n;
      const ic18 = (db.prepare(`SELECT COUNT(*) AS n FROM risk_rule WHERE rule_scope = 'internal_control_18'`).get() as { n: number }).n;
      expect(net33).toBe(33);
      expect(ic18).toBe(18);

      // 验证 std_report 删除拦截触发器完好保留
      expect(() => db.prepare('DELETE FROM std_report WHERE id = 1').run()).toThrow(/不可删除/);
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('完成 8 单元拆包(7份责任书)、冻结发布、受限组织签收/乐观锁/预算只读查看、6类调整→5类审定机构派生及修订新周期闭环', async () => {
    const { base, admin, db } = await boot('newfc-t14-plan-wf-');

    // 将 boot 预置活跃测试组织停用，导入标准脱敏 8 单元组织树
    db.prepare(`UPDATE org SET status = 'inactive'`).run();
    seedOrgsFromCsv(db, buildDesensitized8UnitOrgCsv(), 'confirm');

    const orgMap = new Map<string, number>();
    for (const r of db.prepare('SELECT id, code FROM org').all() as { id: number; code: string }[]) {
      orgMap.set(r.code, r.id);
    }
    const hubAId = orgMap.get('ST_HUB_A')!;
    const subDId = orgMap.get('SUB_EN_D')!;

    // 创建 2026 经营预算版本并录入科目分录
    const accIncome = Number(
      db.prepare(`INSERT INTO account (code, name, type, status, sort_order, created_at, updated_at) VALUES ('INC_OP', '主营发电收入', 'income', 'active', 1, datetime('now'), datetime('now'))`).run().lastInsertRowid,
    );
    const accMaint = Number(
      db.prepare(`INSERT INTO account (code, name, type, status, sort_order, created_at, updated_at) VALUES ('COST_MAINT', '运行维护费(不含税)', 'cost', 'active', 2, datetime('now'), datetime('now'))`).run().lastInsertRowid,
    );
    const bvRes = await json(post(base, admin, '/api/versions', { year: 2026, name: '2026年度经营预算初版', kind: 'budget' }));
    const bvId = bvRes.id as number;
    const now = new Date().toISOString();
    // 含税 1,060,000.00 / 1.06 = 1,000,000.00；含税 530,000.00 / 1.06 = 500,000.00
    db.prepare(`INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, updated_at) VALUES (?, ?, ?, ?, ?)`).run(bvId, hubAId, accIncome, 500_000_000, now);
    db.prepare(`INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, updated_at) VALUES (?, ?, ?, ?, ?)`).run(bvId, hubAId, accMaint, 100_000_000, now);
    db.prepare(`INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, updated_at) VALUES (?, ?, ?, ?, ?)`).run(bvId, subDId, accIncome, 300_000_000, now);
    db.prepare(`INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, updated_at) VALUES (?, ?, ?, ?, ?)`).run(bvId, subDId, accMaint, 50_000_000, now);

    // 导入并激活 2026 综合计划批次
    const wbBuf = buildSyntheticPlanWorkbook();
    const impRes = await upload(base, admin, '/api/plan/import', wbBuf, '2026综合计划.xlsx', { year: '2026', actualPeriod: '2026-06' });
    expect(impRes.status).toBe(201);
    const impBatch = await json(impRes);
    await json(post(base, admin, `/api/plan/batches/${impBatch.id}/activate`, { expectedCurrentBatchId: null }));

    // 创建合一下达周期 -> 自动拆分 8 个一级下达单元（排除 is_plan_excluded=1 的 SUB_EX_X，本部部门并入 GRP_HQ）
    const cycleRes = await post(base, admin, '/api/plan/issuance/cycles', {
      year: 2026,
      cycleCode: 'PLAN-2026-INIT',
      issuanceStage: 'official',
      sourcePlanBatchId: impBatch.id,
      sourceBudgetVersionId: bvId,
      issuedDate: '2026-03-10',
      annualSpecialCaps: [{ unitOrgId: subDId, sheetCode: 'maintenance', amount: '700000.00' }],
    });
    expect(cycleRes.status).toBe(201);
    const cycle = await json(cycleRes);
    expect(cycle.unitPackCount).toBe(8);
    expect(cycle.excludedOrgs.map((o: any) => o.code)).toContain('SUB_EX_X');
    expect(cycle.packs.filter((p: any) => p.hasResponsibilityLetter)).toHaveLength(7);
    expect(cycle.packs.find((p: any) => p.unitOrgCode === 'GRP_HQ').hasResponsibilityLetter).toBe(false);

    // 勾稽核对通过并正式发布冻结快照
    const recReport = await json(post(base, admin, `/api/plan/issuance/cycles/${cycle.id}/reconcile`, {}));
    expect(recReport.passed).toBe(true);
    expect(recReport.blockingCount).toBe(0);

    const published = await json(post(base, admin, `/api/plan/issuance/cycles/${cycle.id}/publish`, {}));
    expect(published.status).toBe('published');
    expect(published.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(published.packs.every((p: any) => p.signOffStatus === 'issued')).toBe(true);

    const hubAPack = published.packs.find((p: any) => p.unitOrgCode === 'ST_HUB_A');
    const subDPack = published.packs.find((p: any) => p.unitOrgCode === 'SUB_EN_D');

    // 创建受限组织用户（仅授权 ST_HUB_A）
    const hubAUser = createScopedUser(db, {
      username: 'hub-a-planner',
      roleCodes: ['viewer', 'data_maintainer'],
      orgIds: [hubAId],
    });
    const reviewerUser = createScopedUser(db, {
      username: 'group-plan-reviewer',
      roleCodes: ['admin'],
      allOrgs: true,
    });

    // 受限用户仅能看到本单位下达包；跨单位读取/签收返回 404
    const scopedPacks = (await json(get(base, hubAUser.session, `/api/plan/issuance/packs?cycleId=${cycle.id}`))).items;
    expect(scopedPacks).toHaveLength(1);
    expect(scopedPacks[0].unitOrgId).toBe(hubAId);

    const crossGet = await get(base, hubAUser.session, `/api/plan/issuance/packs/${subDPack.id}`);
    expect(crossGet.status).toBe(404);
    const crossAck = await post(base, hubAUser.session, `/api/plan/issuance/packs/${subDPack.id}/acknowledge`, {
      expectedVersion: subDPack.version,
      ackNote: '越权签收测试',
    });
    expect(crossAck.status).toBe(404);

    // 独立复核：列表和详情都不得泄露集团冻结快照、其他单位包统计或未发布草稿。
    const scopedCycles = await json(get(base, hubAUser.session, '/api/plan/issuance/cycles'));
    const scopedCycle = scopedCycles.items.find((c: any) => c.id === cycle.id);
    expect(scopedCycle.frozenSnapshot).toEqual({});
    expect(scopedCycle.unitPackCount).toBe(1);
    const draft = await json(post(base, admin, '/api/plan/issuance/cycles', {
      year: 2026, cycleCode: 'PRIVATE-DRAFT', sourcePlanBatchId: impBatch.id,
    }));
    expect((await get(base, hubAUser.session, `/api/plan/issuance/cycles/${draft.id}`)).status).toBe(404);

    // 申请包不能成为修改其他单位明细的通行证，旧批次、重复明细也必须先拒绝。
    const foreignItem = db.prepare('SELECT id, stable_item_uid FROM plan_item WHERE batch_id = ? AND org_id = ? LIMIT 1')
      .get(impBatch.id, subDId) as { id: number; stable_item_uid: string };
    const ownItem = db.prepare('SELECT id, stable_item_uid FROM plan_item WHERE batch_id = ? AND org_id = ? LIMIT 1')
      .get(impBatch.id, hubAId) as { id: number; stable_item_uid: string };
    const crossLine = { planItemId: foreignItem.id, targetSheetCode: 'purchase', targetItemName: '越权调整', beforeVal: '800000.00', afterVal: '900000.00' };
    const adjustmentBase = { cycleId: cycle.id, unitPackId: hubAPack.id, adjustType: 'within_total_realloc', reason: '独立复核反例' };
    expect((await post(base, hubAUser.session, '/api/plan/issuance/adjustments', { ...adjustmentBase, lines: [crossLine] })).status).toBe(404);
    const ownLine = { ...crossLine, planItemId: ownItem.id, beforeVal: '1200000.00', afterVal: '1300000.00' };
    expect((await post(base, hubAUser.session, '/api/plan/issuance/adjustments', { ...adjustmentBase, lines: [ownLine, ownLine] })).status).toBe(400);

    // 受限用户可只读查看本单位经营预算明细（/unit-view），但调用全域定稿 /lock 返回 403
    const unitBv = await json(get(base, hubAUser.session, `/api/versions/${bvId}/unit-view`));
    expect(unitBv.rows.every((e: any) => e.orgId === hubAId)).toBe(true);
    expect(unitBv.rows.length).toBeGreaterThan(0);
    const forbiddenLock = await post(base, hubAUser.session, `/api/versions/${bvId}/lock`, { expectedVersion: 1 });
    expect(forbiddenLock.status).toBe(403);

    // 本单位正常签收 + 乐观锁并发冲突 409 VERSION_CONFLICT
    const ackOk = await json(
      post(base, hubAUser.session, `/api/plan/issuance/packs/${hubAPack.id}/acknowledge`, {
        expectedVersion: hubAPack.version,
        ackNote: '甲枢纽已核对计划与预算附表无误，确认签收',
      }),
    );
    expect(ackOk.signOffStatus).toBe('acknowledged');
    expect(ackOk.version).toBe(hubAPack.version + 1);

    const ackConflict = await post(base, hubAUser.session, `/api/plan/issuance/packs/${hubAPack.id}/acknowledge`, {
      expectedVersion: hubAPack.version,
      ackNote: '旧版本号重复提交',
    });
    expect(ackConflict.status).toBe(409);
    expect((await json(ackConflict)).code).toBe('VERSION_CONFLICT');

    // 验证 6 类 adjustType 强制由服务端派生全部 5 类法定 approvalBody（客户端无法伪造）
    const subDUser = createScopedUser(db, {
      username: 'sub-d-planner',
      roleCodes: ['data_maintainer'],
      orgIds: [subDId],
    });

    const adjCases: Array<{
      session: typeof hubAUser.session;
      packId: number;
      adjustType: string;
      expectedBody: string;
      extra?: Record<string, unknown>;
    }> = [
      { session: hubAUser.session, packId: hubAPack.id, adjustType: 'within_total_realloc', expectedBody: 'gm_office' },
      { session: hubAUser.session, packId: hubAPack.id, adjustType: 'overall_target_change', expectedBody: 'board_of_directors' },
      { session: hubAUser.session, packId: hubAPack.id, adjustType: 'unplanned_hq_or_station', expectedBody: 'joint_review_company' },
      { session: subDUser.session, packId: subDPack.id, adjustType: 'unplanned_subsidiary_within_cap', expectedBody: 'subsidiary_self_decision' },
      { session: subDUser.session, packId: subDPack.id, adjustType: 'unplanned_subsidiary_over_cap', expectedBody: 'company_approval' },
      {
        session: subDUser.session,
        packId: subDPack.id,
        adjustType: 'emergency_retroactive',
        expectedBody: 'company_approval',
        extra: { emergencyStartDate: '2026-01-05' },
      },
    ];

    let firstAdjId = 0;
    for (const c of adjCases) {
      const res = await post(base, c.session, '/api/plan/issuance/adjustments', {
        cycleId: cycle.id,
        unitPackId: c.packId,
        adjustType: c.adjustType,
        reason: `测试${c.adjustType}调整申请`,
        ...c.extra,
        lines: [
          {
            targetSheetCode: 'maintenance',
            targetItemName: '专项检修调增项',
            valueType: 'amount_cents',
            scale: 2,
            unit: '元',
            beforeVal: '0.00',
            afterVal: '106000.00',
            budgetAccountId: accMaint,
          },
        ],
      });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(body.approvalBody).toBe(c.expectedBody);
      if (c.adjustType === 'emergency_retroactive') {
        expect(body.emergencyOverdue5Workdays).toBe(true);
      }
      if (!firstAdjId) firstAdjId = body.id;
    }
    // 客户端自报“额度内”不能覆盖冻结上限；核心目标变更也不能通过 false 标志降级。
    const overCap = await json(post(base, subDUser.session, '/api/plan/issuance/adjustments', {
      cycleId: cycle.id, unitPackId: subDPack.id, adjustType: 'unplanned_subsidiary_within_cap', reason: '上限反例',
      lines: [{ targetSheetCode: 'maintenance', targetItemName: '新增超限专项', beforeVal: '0', afterVal: '200000.00' }],
    }));
    expect(overCap.approvalBody).toBe('company_approval');
    const coreTarget = await json(post(base, subDUser.session, '/api/plan/issuance/adjustments', {
      cycleId: cycle.id, unitPackId: subDPack.id, adjustType: 'unplanned_subsidiary_within_cap', exceedsOverallTarget: false, reason: '核心目标反例',
      lines: [{ targetSheetCode: 'annual_kpi', targetItemName: '新增经营核心指标', beforeVal: '0', afterVal: '100000.00' }],
    }));
    expect(coreTarget.approvalBody).toBe('board_of_directors');

    // 提交人自审无例外说明拦截；异人复核批准后自动生成修订新周期与修订预算版本，原周期置 superseded 但冻结快照不变
    const adminSelfAdj = await json(
      post(base, admin, '/api/plan/issuance/adjustments', {
        cycleId: cycle.id,
        unitPackId: hubAPack.id,
        adjustType: 'within_total_realloc',
        reason: '管理员自提调整验证异人复核',
        lines: [
          {
            targetSheetCode: 'purchase',
            targetItemName: '甲枢纽主变在线监测装置',
            valueType: 'amount_cents',
            beforeVal: '1200000.00',
            afterVal: '1300000.00',
          },
        ],
      }),
    );
    const selfRevFail = await post(base, admin, `/api/plan/issuance/adjustments/${adminSelfAdj.id}/review`, {
      action: 'approve',
      decisionDocNo: '总办纪〔2026〕12号',
    });
    expect(selfRevFail.status).toBe(400);

    // 异人复核批准 firstAdjId（甲枢纽运维调增 +106,000.00 元，同步调整经营预算科目）
    const revApproved = await json(
      post(base, reviewerUser.session, `/api/plan/issuance/adjustments/${firstAdjId}/review`, {
        action: 'approve',
        decisionDocNo: '总办纪〔2026〕15号',
        comment: '经总办会审议同意总额内调剂',
      }),
    );
    expect(revApproved.status).toBe('approved');
    expect(revApproved.newCycleId).toBeGreaterThan(cycle.id);

    const oldCycleAfter = await json(get(base, admin, `/api/plan/issuance/cycles/${cycle.id}`));
    expect(oldCycleAfter.status).toBe('superseded');
    expect(oldCycleAfter.snapshotSha256).toBe(published.snapshotSha256);

    const newCycle = await json(get(base, admin, `/api/plan/issuance/cycles/${revApproved.newCycleId}`));
    expect(newCycle.issuanceStage).toBe('adjusted');
    expect(newCycle.sourceBudgetVersionId).not.toBe(bvId);
    expect(newCycle.reconcileReport.passed).toBe(true);
    expect(db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id = ? AND org_id = ? AND account_id = ?').safeIntegers(true).get(newCycle.sourceBudgetVersionId, hubAId, accMaint)).toEqual({ amount_cents: 110000000n });
    // 同一旧周期的第二份在途申请不能再次批准并覆盖已派生的新周期。
    const staleReview = await post(base, reviewerUser.session, `/api/plan/issuance/adjustments/${adminSelfAdj.id}/review`, {
      action: 'approve', decisionDocNo: '旧周期重复审批',
    });
    expect(staleReview.status).toBe(409);
  });
});
