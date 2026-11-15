/** T-13～T-15 独立验收的反例回归，全部使用内存库。 */
import { describe, expect, it } from 'vitest';
import { buildFixture, testDb } from './helpers';
import { detectClaimSplitCluster, evaluateRules, resolveLinkedContractComparisonRef } from '../src/modules/expense/audit-run';
import { visibleClaim } from '../src/modules/expense/expense.service';
import type { DB } from '../src/db/connection';
import { analyzeContractDraftFields } from '../src/assistant/config-draft';
import { normalizeDraftInput } from '../src/assistant/draft-context';
import { runWithContext, systemContext } from '../src/core/request-context';
import { listEasContractRecon } from '../src/modules/eas/eas-recon.service';
import { createIssuanceCycle, publishIssuanceCycle, createPlanAdjustment, reviewPlanAdjustment, getIssuanceCycle, getUnitPack } from '../src/modules/plan-execution/plan-issuance.service';
import { planAdjustmentCreateRequest } from '../src/contracts/plan-execution';
import { formatScaled } from '../src/core/decimal';

function contract(db: DB, orgId: number, key: string, payee: string): number {
  return Number(db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, counterparty_names, created_at, updated_at)
    VALUES (?, ?, ?, ?, 10000000, ?, '2026-01-01', '2026-01-01')`).run(key, key, key, orgId, payee).lastInsertRowid);
}
function claim(db: DB, orgId: number, key: string, type: string, amount: bigint, date: string, contractId: number | null = null) {
  const id = Number(db.prepare(`INSERT INTO ex_claim (claim_no, org_id, applicant, department, expense_type, amount_cents, occurred_date, description, status, contract_id, is_procurement_expense, created_at, updated_at)
    VALUES (?, ?, '合成人员', '合成部门', ?, ?, ?, '采购事项中提到水电费，尚无豁免证据', 'audited', ?, 1, '2026-01-01', '2026-01-01')`).run(key, orgId, type, amount, date, contractId).lastInsertRowid);
  return visibleClaim(db, id);
}

describe('独立验收 AC-T15-01/02/04 的越权、证据与金额反例', () => {
  it('计划修订真实落盘金额/数量/比率/文本，保留行元数据并按万元正确展示公文指标', () => {
    const db = testDb(); const fx = buildFixture(db); const org = fx.orgIds.shanghai;
    db.prepare("UPDATE org SET status = 'inactive'").run();
    db.prepare("UPDATE org SET status = 'active', parent_id = NULL, plan_issuance_root_id = id WHERE id = ?").run(org);
    const file = Number(db.prepare("INSERT INTO file_object (sha256,size_bytes,original_name,created_at) VALUES (?,1,'multi.xlsx','2026-01-01')").run('f'.repeat(64)).lastInsertRowid);
    const batch = Number(db.prepare("INSERT INTO plan_batch (year,actual_period,file_object_id,file_sha256,file_name,amount_unit,item_count,fact_count,created_at) VALUES (2026,'2026-06',?,'multi-values','multi.xlsx','yuan',5,5,'2026-01-01')").run(file).lastInsertRowid);
    const insItem = db.prepare("INSERT INTO plan_item (batch_id,sheet_code,row_no,item_name,item_key,stable_item_uid,org_id,parent_item_key,estimate_subitem) VALUES (?,?,?,?,?,?,?,'section-a','概算子项证据')");
    const insFact = db.prepare("INSERT INTO plan_fact (batch_id,item_id,field_key,measure,value_type,amount_cents,scaled_value,text_value,source_cell) VALUES (?,?,'annual_plan','annual_plan',?,?,?,?,'A1')");
    const defs = [
      { type: 'amount_cents', fact: 'amount', sheet: 'purchase', before: '90071992547409.93', after: '90071992547409.94', amount: 9_007_199_254_740_993n, scaled: null, text: null },
      { type: 'scaled_int', fact: 'quantity', sheet: 'capacity_add', before: '10.1234', after: '12.5678', amount: null, scaled: 101234n, text: null },
      { type: 'rate_bp', fact: 'ratio', sheet: 'capacity_add', before: '0.500001', after: '0.600009', amount: null, scaled: 500001n, text: null },
      { type: 'text', fact: 'text', sheet: 'maintenance', before: '原计划描述', after: '修订计划描述', amount: null, scaled: null, text: '原计划描述' },
      { type: 'amount_cents', fact: 'amount', sheet: 'purchase', before: '1060000.00', after: '1060000.00', amount: 106000000n, scaled: null, text: null },
    ];
    const ids = defs.map((d, index) => {
      const id = Number(insItem.run(batch,d.sheet,index+1,`指标${index}`,`item-${index}`,`uid-${index}`,org).lastInsertRowid);
      insFact.run(batch,id,d.fact,d.amount,d.scaled,d.text); return id;
    });
    expect(()=>createIssuanceCycle(db, { year:2026,cycleCode:'UNMAPPED',issuanceStage:'official',sourcePlanBatchId:batch,decisionDocMeta:{unitAttachments:{UNKNOWN:[]}} })).toThrow(/单位映射/);
    const cycle = createIssuanceCycle(db, { year: 2026, cycleCode: 'MULTI-VALUE', issuanceStage: 'official', sourcePlanBatchId: batch });
    const draftPack = getUnitPack(db, getIssuanceCycle(db, cycle.id).packs![0].id);
    draftPack.attachments!.find((a) => a.sheetCode === 'purchase')!.rows.find((r) => r.itemName === '指标0')!.amountOrValue = formatScaled(9_007_199_254_740_993n,6,false);
    const orgCode = (db.prepare('SELECT code FROM org WHERE id=?').get(org) as { code:string }).code;
    db.prepare('UPDATE plan_issuance_cycle SET decision_doc_meta=? WHERE id=?').run(JSON.stringify({unitAttachments:{[orgCode]:draftPack.attachments},unitMetrics:{[orgCode]:{purchaseTotal:'90071993607409.93',investmentTotal:'90071993607409.93'}}}),cycle.id);
    publishIssuanceCycle(db, cycle.id);
    const sourcePack = getUnitPack(db, getIssuanceCycle(db, cycle.id).packs![0].id);
    expect(sourcePack.attachments!.find((a) => a.sheetCode === 'purchase')!.rows.find((r) => r.itemName === '指标4')).toMatchObject({ unit: '万元', amountOrValue: '106.00' });
    const input = planAdjustmentCreateRequest.parse({ cycleId: cycle.id, unitPackId: sourcePack.id, adjustType: 'within_total_realloc', reason: '多量纲独立验收', lines: defs.slice(0,4).map((d,index) => ({ planItemId: ids[index], targetSheetCode: d.sheet, targetItemName: `指标${index}`, valueType: d.type, scale: 4, beforeVal: d.before, afterVal: d.after })) });
    const adj = createPlanAdjustment(db, input);
    expect(adj.lines[2]).toMatchObject({ scale: 6, beforeVal: '0.500001', afterVal: '0.600009', deltaVal: '0.100008' });
    const approved = reviewPlanAdjustment(db, adj.id, { action: 'approve', decisionDocNo: '合成决策〔2026〕1号' });
    const next = getIssuanceCycle(db, approved.newCycleId!);
    const facts = db.prepare("SELECT i.stable_item_uid, i.parent_item_key, i.estimate_subitem, f.amount_cents, f.scaled_value, f.text_value FROM plan_item i JOIN plan_fact f ON f.item_id=i.id WHERE i.batch_id=? ORDER BY i.row_no").safeIntegers(true).all(next.sourcePlanBatchId) as Record<string,unknown>[];
    expect(facts[0]).toMatchObject({ amount_cents: 9_007_199_254_740_994n, stable_item_uid: 'uid-0', parent_item_key: 'section-a', estimate_subitem: '概算子项证据' });
    expect(facts[1].scaled_value).toBe(125678n);
    expect(facts[2].scaled_value).toBe(600009n);
    expect(facts[3].text_value).toBe('修订计划描述');
    const revised = getUnitPack(db,next.packs![0].id);
    expect(revised.metrics.purchaseTotal).toBe('90071993607409.94');
    expect(revised.attachments!.find((a)=>a.sheetCode==='capacity_add')!.rows.find((r)=>r.itemName==='指标2')!.amountOrValue).toBe('0.600009');
    expect(revised.attachments!.find((a)=>a.sheetCode==='maintenance')!.rows.find((r)=>r.itemName==='指标3')!.amountOrValue).toBe('修订计划描述');
  });

  it('比价豁免必须有有效证据，空招采记录、普通采购附件和事由关键词均不能免检', () => {
    const db = testDb(); const fx = buildFixture(db); const org = fx.orgIds.shanghai;
    const cid = contract(db, org, 'COMPARE-1', '供应方甲');
    const c = claim(db, org, 'COMPARE-CLAIM', '采购费', 1_500_000n, '2026-06-01', cid);
    const pid = Number(db.prepare(`INSERT INTO ct_procurement_record (org_id, procurement_title, comparison_quotes_json, created_at, updated_at)
      VALUES (?, '空招采留痕', '[]', '2026-01-01', '2026-01-01')`).run(org).lastInsertRowid);
    db.prepare('UPDATE ct_contract SET procurement_record_id = ? WHERE id = ?').run(pid, cid);
    expect(resolveLinkedContractComparisonRef(db, cid)).toBeNull();
    const finding = evaluateRules({ claim: c, lines: [], attachments: [], clauses: [], ocrTexts: new Map() }).findings;
    expect(finding.some((f) => f.code === 'EXP_SMALL_PROC_NO_COMPARISON')).toBe(true);
    db.prepare('UPDATE ct_procurement_record SET comparison_quotes_json = ? WHERE id = ?')
      .run(JSON.stringify([{ vendorName: '合成供应方甲', quoteAmount: '15000.00' }]), pid);
    expect(resolveLinkedContractComparisonRef(db, cid)).toContain('采购记录');
  });

  it('拆单只累计共享同一键的单据，30日窗口不含第31天，重审同一组合指纹稳定', () => {
    const db = testDb(); const fx = buildFixture(db); const org = fx.orgIds.shanghai;
    const ctA = contract(db, org, 'SPLIT-A', '供应方甲'); const ctB = contract(db, org, 'SPLIT-B', '供应方乙');
    const a = claim(db, org, 'SPLIT-1', '设备维修费', 1_000_000n, '2026-06-01', ctA);
    claim(db, org, 'SPLIT-2', '设备维修费', 1_000_000n, '2026-06-02', ctB);
    claim(db, org, 'SPLIT-3', '软件服务费', 1_000_000n, '2026-06-03', ctA);
    expect(detectClaimSplitCluster(db, a, 3_000_000n, 30)).toBeNull();
    const d = claim(db, org, 'SPLIT-4', '设备维修费', 1_000_000n, '2026-06-04', ctB);
    const fromA = detectClaimSplitCluster(db, a, 3_000_000n, 30)!;
    const fromD = detectClaimSplitCluster(db, d, 3_000_000n, 30)!;
    expect(fromA.totalCents).toBe(3_000_000n);
    expect(fromA.fingerprint).toBe(fromD.fingerprint);
    const org2 = fx.orgIds.hangzhou;
    const boundary = claim(db, org2, 'BOUNDARY-1', '设备维修费', 1_500_000n, '2026-06-01');
    claim(db, org2, 'BOUNDARY-2', '设备维修费', 1_500_000n, '2026-07-01');
    expect(detectClaimSplitCluster(db, boundary, 3_000_000n, 30)).toBeNull();
  });

  it('受限草稿额度仅计本范围合同，年度额度不能误用大于年度计划的累计金额，周期基线不可越权', () => {
    const db = testDb(); const fx = buildFixture(db); const org = fx.orgIds.shanghai;
    const file = Number(db.prepare("INSERT INTO file_object (sha256,size_bytes,original_name,created_at) VALUES (?,1,'plan.xlsx','2026-01-01')").run('d'.repeat(64)).lastInsertRowid);
    const batch = Number(db.prepare("INSERT INTO plan_batch (year,actual_period,file_object_id,file_sha256,file_name,amount_unit,item_count,fact_count,created_at) VALUES (2026,'2026-06',?,'review-plan','plan.xlsx','yuan',1,2,'2026-01-01')").run(file).lastInsertRowid);
    const item = Number(db.prepare("INSERT INTO plan_item (batch_id,sheet_code,row_no,item_name,item_key,org_id) VALUES (?,'investment',1,'计划项','acceptance-item',?)").run(batch,org).lastInsertRowid);
    for (const [key, amount] of [['annual_plan', 10_000_000n], ['total', 90_000_000n]] as const) db.prepare("INSERT INTO plan_fact (batch_id,item_id,field_key,measure,value_type,amount_cents,source_cell) VALUES (?,?,?,?,'amount',?,'A1')").run(batch,item,key,key,amount);
    const foreign = contract(db, fx.orgIds.west, 'FOREIGN-OCCUPANCY', '范围外供应方');
    db.prepare('UPDATE ct_contract SET plan_item_id = ? WHERE id = ?').run(item, foreign);
    const foreignCycle = Number(db.prepare("INSERT INTO plan_issuance_cycle (year,cycle_code,issuance_stage,status,created_at,updated_at) VALUES (2026,'PRIVATE-CYCLE','official','draft','2026-01-01','2026-01-01')").run().lastInsertRowid);
    const scoped = { ...systemContext('cli'), auth: { userId: 0, username: 'review', displayName: 'review', permissions: new Set(['contract:read', 'plan:read'] as const), allOrgs: false, orgRootIds: [org] } };
    runWithContext(scoped, () => {
      const out = analyzeContractDraftFields(db, { orgId: org, planItemId: item, originalAmount: '150000.00' });
      expect(out.explanation.join(' ')).toContain('计划额度 100000.00');
      expect(out.explanation.join(' ')).toContain('已挂接合同占用 0.00');
      expect(() => normalizeDraftInput(db, { kind: 'plan_issuance_draft', base: { operation: 'update', id: foreignCycle, updatedAt: '2026-01-01' }, changes: { year: 2026 } })).toThrow(/授权组织范围/);
    });
  });

  it('EAS 资产类负余额检出且金额超2^53仍精确，无项目/客商证据不能把单位总余额归给单份合同', () => {
    const db = testDb(); const fx = buildFixture(db); const org = fx.orgIds.shanghai;
    const cid = contract(db, org, 'WARRANTY-AMBIGUOUS', '供应方甲');
    db.prepare("INSERT INTO ct_warranty (contract_id,start_date,end_date,retention_cents,inspection_date,inspection_conclusion,created_at,updated_at) VALUES (?,'2025-01-01','2026-01-01',50000,'2026-01-01','passed','2026-01-01','2026-01-01')").run(cid);
    const file = Number(db.prepare("INSERT INTO file_object (sha256,size_bytes,original_name,created_at) VALUES (?,1,'balance.csv','2026-01-01')").run('e'.repeat(64)).lastInsertRowid);
    const batch = Number(db.prepare("INSERT INTO eas_batch (data_type,org_id,source_company,period,file_object_id,file_sha256,file_name,row_count,debit_total_cents,credit_total_cents,status,is_current,parser_version,created_at) VALUES ('balance',?,'合成单位','2026-06',?,'review-balance','balance.csv',3,0,0,'active',1,'v1','2026-06-30')").run(org,file).lastInsertRowid);
    for (const [i, code] of ['224101','112301','12210301'].entries()) db.prepare(`INSERT INTO eas_balance_line (batch_id,source_row,account_code,account_name,begin_debit_cents,begin_credit_cents,debit_cents,credit_cents,end_debit_cents,end_credit_cents,supplier_name) VALUES (?,?,?,'合成科目',0,0,0,0,0,?,?)`).run(batch,i+2,code,9_007_199_254_740_993n,i===0?null:'供应方甲');
    const out = listEasContractRecon(db, { orgId: org, period: '2026-06' });
    expect(out.summary.byCategory.warranty_2241_overdue.count).toBe(0);
    expect(out.summary.byCategory.supplier_negative_balance).toEqual({ count: 2, totalAbsAmount: '180143985094819.86' });
    const foreignProject = Number(db.prepare("INSERT INTO md_project (code,name,org_id,status,created_at,updated_at) VALUES ('OUTSIDE-PROJECT','范围外项目私密名称',?,'active','2026-01-01','2026-01-01')").run(fx.orgIds.west).lastInsertRowid);
    db.prepare("INSERT INTO eas_balance_line (batch_id,source_row,account_code,account_name,begin_debit_cents,begin_credit_cents,debit_cents,credit_cents,end_debit_cents,end_credit_cents,project_code) VALUES (?,8,'160401','在建工程',10000,0,0,0,10000,0,'OUTSIDE-PROJECT')").run(batch);
    const scoped = { ...systemContext('cli'), auth: { userId: 0, username: 'review', displayName: 'review', permissions: new Set(['eas:read'] as const), allOrgs: false, orgRootIds: [org] } };
    runWithContext(scoped, () => {
      const scopedResult = listEasContractRecon(db, { orgId: org, period: '2026-06' });
      const cip = scopedResult.items.find((r) => r.category === 'cip_1604_legacy')!;
      expect(cip.projectId).not.toBe(foreignProject);
      expect(cip.projectId).toBeNull(); expect(cip.projectName).toBeNull();
      expect(JSON.stringify(scopedResult)).not.toContain('范围外项目私密名称');
    });
  });
});
