/** 2026-11-13 独立复核反例回归。夹具只设置被测环节的起点，操作均经真实 HTTP/CSRF。 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { boot, get, post, upload } from './t3-helpers';
import { fetchAs, createScopedUser } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';
import { buildMonthlyLedger } from '../src/modules/contracts/contract-export-monthly';
import { officialSheet, writeOfficialWorkbook } from '../src/modules/contracts/supervision-official-workbook';
import official from '../src/modules/contracts/supervision-official-headers.json';
import { workingDaysBetween, workingDayCutoffBefore } from '../src/core/workdays';
import { EXPENSE_EXEC_HEADERS, EXPENSE_EXEC_PAY_HEADERS } from '../src/modules/contracts/supervision-template-spec';

async function response(p: Promise<Response>, status = 200) {
  const r = await p; const b = await r.json() as any;
  expect(r.status, JSON.stringify(b)).toBe(status); return b;
}
const put = (base: string, session: any, url: string, body: unknown) => fetchAs(session, `${base}${url}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const decision = { decision: 'approve', exceptionReason: '单人部署合成测试复核' };
const governance = { actualApprovalTier: 'management_board', changeMatter: '工程变更', decisionMethod: 'approval', finalApproverName: '审批人', finalApproverTitle: '经营层' };

async function setup() {
  const t = await boot('newfc-review-fix-');
  t.db.prepare("INSERT INTO app_setting(key,value_json,updated_at) VALUES ('contract.prior_year_net_assets',?,?)").run(JSON.stringify(JSON.stringify([{ orgId: t.fx.orgIds.east, year: 2025, amount: '10000000000.00' }])), new Date().toISOString());
  // Root is resolved from the server-owned org tree.
  const root = (t.db.prepare('WITH RECURSIVE a(id,parent_id) AS (SELECT id,parent_id FROM org WHERE id=? UNION ALL SELECT o.id,o.parent_id FROM org o JOIN a ON o.id=a.parent_id) SELECT id FROM a WHERE parent_id IS NULL').get(t.fx.orgIds.shanghai) as { id: number }).id;
  t.db.prepare("UPDATE app_setting SET value_json=? WHERE key='contract.prior_year_net_assets'").run(JSON.stringify(JSON.stringify([{ orgId: root, year: 2025, amount: '10000000000.00' }])));
  let seq = 0;
  const contract = async (extra: Record<string, unknown> = {}, stage = 'performance') => {
    const c = await response(post(t.base, t.admin, '/api/contracts', { contractNo: `REVIEW-${++seq}`, name: '合成复核合同', orgId: t.fx.orgIds.shanghai, originalAmount: '1000000.00', ...extra }), 201);
    t.db.prepare('UPDATE ct_contract SET stage=?, sign_date=? WHERE id=?').run(stage, '2025-01-01', c.id);
    return c.id as number;
  };
  const doc = async (id: number, kind: string, type = 'other', changeId?: number) => (await response(upload(t.base, t.admin, `/api/contracts/${id}/documents`, Buffer.from(`synthetic ${kind} ${Math.random()}`), `${kind}.pdf`, { docType: type, evidenceKind: kind, ...(changeId ? { changeId: String(changeId) } : {}) }), 201)).id as number;
  const detail = (id: number) => response(get(t.base, t.admin, `/api/contracts/${id}`));
  const patch = (id: number, body: Record<string, unknown>) => fetchAs(t.admin, `${t.base}/api/contracts/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const settlement = async (id: number, amount = '100.00', kind = 'progress', retention = '0.00') => {
    const d = await response(post(t.base, t.admin, `/api/contracts/${id}/settlements`, { settlementKind: kind, settlementDate: '2025-03-01', inContractAmount: amount, deductRetentionAmount: retention }), 201);
    return response(post(t.base, t.admin, `/api/contracts/${id}/settlements/${d.settlements.at(-1).id}/decide`, decision));
  };
  return { ...t, root, contract, doc, detail, patch, settlement };
}

describe('复核 R01～R19 服务端负向回归', () => {
  it('R01/R19 未验收结算清款归档不能关闭，批准结算不能作废；完整无质保合同可关闭', async () => {
    const t = await setup(); const id = await t.contract({}, 'settlement'); await t.doc(id, 'other', 'acceptance');
    let d = await t.detail(id);
    let b = await response(post(t.base, t.admin, `/api/contracts/${id}/advance`, { expectedVersion: d.version, toStage: 'closed' }), 409);
    expect(b.details.blockers.map((x: any) => x.code)).toEqual(expect.arrayContaining(['FINAL_SETTLEMENT_REQUIRED', 'FINAL_ACCEPTANCE_REQUIRED', 'ARCHIVE_TRANSFER_REQUIRED']));
    d = await response(post(t.base, t.admin, `/api/contracts/${id}/archive-status`, { expectedVersion: d.version, archiveStatus: 'checked', deferNote: '管理员登记批次移交' }));
    d = await t.settlement(id, '100.00', 'final');
    await response(post(t.base, t.admin, `/api/contracts/${id}/void`, { expectedVersion: d.version, reason: '误建' }), 409);
    d = await response(t.patch(id, { expectedVersion: d.version, finalAccepted: true }));
    await response(post(t.base, t.admin, `/api/contracts/${id}/advance`, { expectedVersion: d.version, toStage: 'closed' }), 409);
    const invoice = await t.doc(id, 'other', 'invoice');
    d = await response(post(t.base, t.admin, `/api/contracts/${id}/payments`, { nodeName: '结清', amount: '100.00', paymentType: 'final', approvalTier: 'finance_vp', approverName: '李', approverTitle: '财务副总' }), 201);
    const pid = d.payments[0].id;
    await response(post(t.base, t.admin, `/api/contracts/${id}/payments/${pid}/decide`, decision));
    d = await response(post(t.base, t.admin, `/api/contracts/${id}/payments/${pid}/pay`, { paidDate: '2026-11-13', invoiceDocumentId: invoice }));
    d = await response(post(t.base, t.admin, `/api/contracts/${id}/advance`, { expectedVersion: d.version, toStage: 'closed' }));
    expect(d.status).toBe('closed');
    const completed = (t.db.prepare('SELECT completed_date FROM ct_contract WHERE id=?').get(id) as any).completed_date;
    expect(completed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('R04 未来质保、空质保记录、错类签证均拒绝；保留金自动触发质保阶段', async () => {
    const t = await setup(); const id = await t.contract({ hasWarranty: false }, 'settlement');
    await t.doc(id, 'other', 'acceptance'); let d = await t.detail(id);
    await response(post(t.base, t.admin, `/api/contracts/${id}/archive-status`, { expectedVersion: d.version, archiveStatus: 'transferred' }));
    d = await t.settlement(id, '100.00', 'final', '5.00'); expect(d.nextStage).toBe('warranty');
    const visa = await t.doc(id, 'warranty_release_visa');
    const invoice = await t.doc(id, 'other', 'invoice');
    const base = { startDate: '2025-01-01', endDate: '2030-12-31', inspectionDate: '2026-11-13', inspectionConclusion: 'passed', visaDocumentId: visa };
    expect((await response(put(t.base, t.admin, `/api/contracts/${id}/warranty`, base), 409)).code).toBe('WARRANTY_NOT_EXPIRED');
    await response(post(t.base, t.admin, `/api/contracts/${id}/payments`, { paymentType: 'warranty_release', amount: '5.00', nodeName: '尾款' }), 409);
    await response(put(t.base, t.admin, `/api/contracts/${id}/warranty`, { ...base, endDate: '2026-01-01', visaDocumentId: invoice }), 409);
    d = await response(put(t.base, t.admin, `/api/contracts/${id}/warranty`, { ...base, endDate: '2026-01-01' }));
    expect(d.warranty.inspectionConclusion).toBe('passed');
    await response(put(t.base,t.admin,`/api/contracts/${id}/warranty`,{retentionAmount:'6.00'}));
    t.db.prepare("UPDATE ct_contract SET stage='warranty',final_accepted=1 WHERE id=?").run(id);
    expect((await t.detail(id)).blockers.map((x:any)=>x.code)).toContain('WARRANTY_RETENTION_MISMATCH');
  });

  it('R18 签署身份null和空姓名必须阻断', async () => {
    const t = await setup(); const id = await t.contract({}, 'approval');
    await t.doc(id, 'other', 'signed'); const d = await t.detail(id);
    expect(d.blockers.map((x: any) => x.code)).toEqual(expect.arrayContaining(['OUR_SIGNATORY_REQUIRED','COUNTERPARTY_SIGNATORY_REQUIRED']));
    await response(post(t.base, t.admin, `/api/contracts/${id}/advance`, { expectedVersion: d.version, toStage: 'performance' }), 409);
  });

  it('R02 50万元省略审批拒绝；净资产1%阈值、缺失净资产和审批附件分类从严核验', async () => {
    const t = await setup(); const id = await t.contract({ signingEntityLevel: 'company' });
    expect((await response(post(t.base, t.admin, `/api/contracts/${id}/payments`, { nodeName: '预付款', paymentType: 'prepayment', amount: '500000.00' }), 409)).code).toBe('CONTRACT_APPROVAL_TIER_REQUIRED');
    t.db.prepare("UPDATE app_setting SET value_json=? WHERE key='contract.prior_year_net_assets'").run(JSON.stringify(JSON.stringify([{ orgId: t.root, year: 2025, amount: '10000000.00' }])));
    const body = { nodeName: '净资产1%', paymentType: 'prepayment', amount: '100000.00', approvalTier: 'finance_vp', approverName: '李', approverTitle: '副总' };
    let b = await response(post(t.base, t.admin, `/api/contracts/${id}/payments`, body), 409); expect(b.details.requiredTier).toBe('collective_decision');
    const invoice = await t.doc(id, 'other', 'invoice');
    await response(post(t.base, t.admin, `/api/contracts/${id}/payments`, { ...body, approvalTier: 'collective_decision', approvalDocId: invoice }), 409);
    const approval = await t.doc(id, 'payment_approval_form'); const feasibility = await t.doc(id, 'funding_feasibility');
    const d = await response(post(t.base, t.admin, `/api/contracts/${id}/payments`, { ...body, approvalTier: 'collective_decision', approvalDocId: approval, feasibilityDocId: feasibility }), 201);
    expect(d.payments[0].approvalTier).toBe('collective_decision');
    t.db.prepare("DELETE FROM app_setting WHERE key='contract.prior_year_net_assets'").run();
    b = await response(post(t.base, t.admin, `/api/contracts/${id}/payments`, { ...body, amount: '1.00' }), 409); expect(b.details.requiredTier).toBe('collective_decision');
  });

  it('R03 单价收入无上限/有估算上限均受累计净应收控制，批准与到账再核验', async () => {
    const t = await setup();
    for (const ceiling of [undefined, '10000.00']) {
      const id = await t.contract({ direction: 'income', pricingMode: 'unit_price', originalAmount: '0', estimatedCeilingAmount: ceiling });
      await t.settlement(id);
      const body = { nodeName: '收款', amount: '10000.00' };
      expect((await response(post(t.base, t.admin, `/api/contracts/${id}/receipts`, body), 409)).code).toBe('CONTRACT_RECEIPT_EXCEEDS_SETTLED');
      let d = await response(post(t.base, t.admin, `/api/contracts/${id}/receipts`, { ...body, amount: '100.00' }), 201);
      const rid = d.receipts[0].id;
      await response(post(t.base, t.admin, `/api/contracts/${id}/receipts/${rid}/decide`, decision));
      await response(post(t.base, t.admin, `/api/contracts/${id}/receipts`, { ...body, amount: '0.01' }), 409);
      d = await response(post(t.base, t.admin, `/api/contracts/${id}/receipts/${rid}/receive`, { receivedDate: '2026-11-13' }));
      expect(d.receivedAmount).toBe('100.00');
    }
  });

  it('R05 已中止可解除，省略批准或解除协议拒绝；两个入口共用门禁', async () => {
    const t = await setup(); const id = await t.contract(); let d = await t.detail(id);
    await response(post(t.base, t.admin, `/api/contracts/${id}/terminate`, { expectedVersion: d.version, reason: '解除' }), 409);
    d = await response(post(t.base, t.admin, `/api/contracts/${id}/suspend`, { expectedVersion: d.version, reason: '停工' }));
    const agreement = await t.doc(id, 'termination_agreement'); d = await t.detail(id);
    d = await response(post(t.base, t.admin, `/api/contracts/${id}/terminate`, { expectedVersion: d.version, reason: '解除清算', approvalTier: 'general_manager', terminationAgreementDocumentId: agreement })); expect(d.status).toBe('terminated');
    const other = await t.contract(); d = await t.detail(other);
    await response(post(t.base, t.admin, `/api/contracts/${other}/suspend`, { expectedVersion: d.version, reason: '停工' }));
    const ev = await t.doc(other, 'termination_agreement');
    d = await response(post(t.base, t.admin, `/api/contracts/${other}/changes`, { ...governance, changeKind: 'terminate', reason: '解除清算', delta: '0', evidenceDocumentId: ev }), 201);
    d = await response(post(t.base, t.admin, `/api/contracts/${other}/changes/${d.changes[0].id}/decide`, decision)); expect(d.status).toBe('terminated');
  });

  it('R06/R07 旧格式不能绕过变更定级，六张同时待审在第六张批准时升级且事务回滚', async () => {
    const t = await setup(); const id = await t.contract({ originalAmount: '10000000.00' }); const ev = await t.doc(id, 'change_decision', 'change');
    await response(post(t.base, t.admin, `/api/contracts/${id}/changes`, { delta: '2000000.00', reason: '旧格式', evidenceDocumentId: ev }), 409);
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) {
      const d = await response(post(t.base, t.admin, `/api/contracts/${id}/changes`, { ...governance, actualApprovalTier: 'undertaker_unit', reason: '并行待审', delta: '200000.00', evidenceDocumentId: ev }), 201); ids.push(d.changes.at(-1).id);
    }
    for (const cid of ids.slice(0, 5)) await response(post(t.base, t.admin, `/api/contracts/${id}/changes/${cid}/decide`, decision));
    const b = await response(post(t.base, t.admin, `/api/contracts/${id}/changes/${ids[5]}/decide`, decision), 409); expect(b.details.requiredTier).toBe('management_board');
    const d = await t.detail(id); expect(d.currentAmount).toBe('11000000.00'); expect(d.changes[5].status).toBe('submitted');
    const audit = await t.doc(id, 'tech_special_audit');
    const good = await response(post(t.base, t.admin, `/api/contracts/${id}/changes`, { ...governance, reason: '足级审批', delta: '200000.00', evidenceDocumentId: ev, techSpecialAuditDocId: audit }), 201);
    await response(post(t.base, t.admin, `/api/contracts/${id}/changes/${good.changes.at(-1).id}/decide`, decision));
  });

  it('R08 错类担保同意拒绝，批准前新设担保会重新拦截', async () => {
    const t = await setup(); const id = await t.contract(); const ev = await t.doc(id, 'change_decision', 'change'); const invoice = await t.doc(id, 'other', 'invoice');
    let d = await response(post(t.base, t.admin, `/api/contracts/${id}/changes`, { ...governance, reason: '零额', delta: '0', evidenceDocumentId: ev }), 201); const cid = d.changes[0].id;
    await response(post(t.base, t.admin, `/api/contracts/${id}/guarantees`, { guaranteeType: 'performance_guarantee', amount: '100.00', depositAmount: '0', issuerName: '测试银行', guaranteeNo: 'G-1', direction: 'inbound' }), 201);
    await response(post(t.base, t.admin, `/api/contracts/${id}/changes/${cid}/decide`, decision), 409);
    await response(post(t.base, t.admin, `/api/contracts/${id}/changes`, { ...governance, reason: '错附件', delta: '0', evidenceDocumentId: ev, guarantorConsentDocumentId: invoice }), 409);
    const boundConsent = await t.doc(id,'guarantor_consent','other',cid);
    await response(post(t.base,t.admin,`/api/contracts/${id}/changes`,{...governance,reason:'挪用其他变更同意函',delta:'0',evidenceDocumentId:ev,guarantorConsentDocumentId:boundConsent}),409);
  });

  it('R09/R16 金融事实后币种冻结，跨币种导入在预览拒绝', async () => {
    const t = await setup(); const id = await t.contract(); await t.settlement(id);
    let d = await t.detail(id); expect((await response(t.patch(id, { expectedVersion: d.version, currency: '美元' }), 409)).code).toBe('CONTRACT_CURRENCY_LOCKED');
    const wb = new ExcelJS.Workbook(); const main = wb.addWorksheet('支出合同执行信息'); main.addRow([...EXPENSE_EXEC_HEADERS]); main.addRow([d.contractNo, d.name, '执行中','是','否']);
    const sub = wb.addWorksheet('实际支付时间与金额'); sub.addRow([...EXPENSE_EXEC_PAY_HEADERS]); sub.addRow([d.contractNo,d.name,'2026-01-01','美元','100.00','李','经理']);
    const preview = await response(upload(t.base,t.admin,'/api/contracts/imports',Buffer.from(await wb.xlsx.writeBuffer()),'currency.xlsx'),201);
    expect(preview.errorCount).toBeGreaterThan(0); expect(JSON.stringify(preview)).toContain('币种');
    d = await t.detail(id); expect(d.paidAmount).toBe('0.00');
  });
});

describe('复核报表、接口与静态缺口回归', () => {
  it('R10/R14 作废返回删除标记，风险新增和处置驱动增量，组织范围保持裁剪', async () => {
    const t = await setup(); const id = await t.contract();
    let full = await response(get(t.base,t.admin,'/api/contracts/supervision-portal/full'));
    const cursor = () => `since=${encodeURIComponent(full.nextSince)}&cursorId=${full.nextCursorId}`;
    await response(post(t.base,t.admin,'/api/risk/scans'),201);
    let inc = await response(get(t.base,t.admin,`/api/contracts/supervision-portal/incremental?${cursor()}`));
    expect(inc.items.find((i: any) => i.id===id).openRiskCount).toBeGreaterThan(0);
    full = await response(get(t.base,t.admin,'/api/contracts/supervision-portal/full')); const d = await t.detail(id);
    await response(post(t.base,t.admin,`/api/contracts/${id}/void`,{expectedVersion:d.version,reason:'误建'}));
    inc = await response(get(t.base,t.admin,`/api/contracts/supervision-portal/incremental?${cursor()}`)); expect(inc.items.find((i: any)=>i.id===id)).toMatchObject({deleted:true,status:'voided'});
    const outsider = createScopedUser(t.db,{username:'out-review',roleCodes:['viewer'],orgIds:[t.fx.orgIds.nanjing]}).session;
    const other = await response(get(t.base,outsider,'/api/contracts/supervision-portal/full')); expect(other.items.find((i:any)=>i.id===id)).toBeUndefined();
  });

  it('R11/R15 历史月末金额、币种、稳定完结日期与五表冻结下载一致', async () => {
    const t = await setup(); const id = await t.contract({direction:'income',currency:'美元',originalAmount:'1000.00'});
    let d = await response(post(t.base,t.admin,`/api/contracts/${id}/receipts`,{nodeName:'历史收款',amount:'100.00'}),201);
    await response(post(t.base,t.admin,`/api/contracts/${id}/receipts/${d.receipts[0].id}/decide`,decision));
    await response(post(t.base,t.admin,`/api/contracts/${id}/receipts/${d.receipts[0].id}/receive`,{receivedDate:'2025-04-01'}));
    const out = await get(t.base,t.admin,'/api/contracts/exports/monthly-ledger?period=2025-03'); expect(out.headers.get('content-disposition')).toContain('2025-03');
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await out.arrayBuffer()) as any); expect(wb.worksheets).toHaveLength(5); expect(wb.worksheets[0].getCell('A1').value).toContain('2025年03月');
    const pack = await response(post(t.base,t.admin,'/api/standard-reports',{reportType:'contract_monthly_pack',period:'2025-03'}),201);
    expect(pack.sources.monthlySheets).toHaveLength(5); expect(pack.rows[0]).toMatchObject({currency:'美元',paidOrReceivedWan:'0.00'});
    await response(post(t.base,t.admin,`/api/standard-reports/${pack.id}/review`,{exceptionReason:'单人测试'}));
    t.db.prepare('UPDATE ct_contract SET name=? WHERE id=?').run('事后更名',id);
    const exported = await get(t.base,t.admin,`/api/standard-reports/${pack.id}/export`); const frozen = new ExcelJS.Workbook(); await frozen.xlsx.load(Buffer.from(await exported.arrayBuffer()) as any);
    expect(frozen.worksheets.map(ws=>ws.getSheetValues())).toEqual(wb.worksheets.map(ws=>ws.getSheetValues()));
    const bad = await get(t.base,t.admin,'/api/contracts/exports/monthly-ledger?period=2025-13'); expect(bad.status).toBe(400);
    t.db.prepare("UPDATE ct_contract SET status='closed',stage='closed',completed_date='2025-03-12' WHERE id=?").run(id);
    const monthly=buildMonthlyLedger(t.db,{period:'2025-03'}); expect(monthly.wb.worksheets[0].getCell('E4').value).toBe(pack.rows[0].contractNo);
    t.db.prepare("UPDATE ct_contract SET remark='事后补录' WHERE id=?").run(id);
    expect(buildMonthlyLedger(t.db,{period:'2025-03'}).wb.worksheets[0].getCell('E4').value).toBe(pack.rows[0].contractNo);
  });

  it('R12 官方八张Sheet说明逐格保持、31组下拉保留且无合并，完整列数与长范围不膨胀', async () => {
    let validations = 0;
    for (const [name,spec] of Object.entries(official)) {
      const wb = new ExcelJS.Workbook(); const ws = officialSheet(wb,name);
      for(const [addr,value] of Object.entries(spec.cells)) expect(ws.getCell(addr).value).toBe(value);
      const zip=await JSZip.loadAsync(await writeOfficialWorkbook(wb)); const sheet=await zip.file('xl/worksheets/sheet1.xml')!.async('string');
      expect(sheet).not.toContain('<mergeCell');
      expect((sheet.match(/<dataValidation /g)??[]).length).toBe(spec.validations.length);
      validations+=spec.validations.length;
    }
    expect(validations).toBe(31);
  });

  it('R13/R17 未签署不纳入报送，缺决策/审批人/变更附件预检准确阻断', async () => {
    const t=await setup(); const id=await t.contract({},'drafting'); t.db.prepare('UPDATE ct_contract SET sign_date=NULL WHERE id=?').run(id);
    let pre=await response(get(t.base,t.admin,'/api/contracts/exports/supervision/preflight')); expect(pre.totalCount).toBe(0);
    t.db.prepare("UPDATE ct_contract SET stage='performance',sign_date='2026-01-01' WHERE id=?").run(id);
    pre=await response(get(t.base,t.admin,'/api/contracts/exports/supervision/preflight')); expect(pre.items[0].missingFields).toEqual(expect.arrayContaining(['三重一大决策方式','最终审批人姓名','最终审批人身份']));
    await response(post(t.base,t.admin,'/api/contracts/exports/supervision/package',{}),409);
  });

  it('预算/概算联动初签和结算拦截，90%生成黄色预警；法人补充协议跨部门唯一', async () => {
    const t=await setup(); const project=await createProject(t.base,t.admin,'REVIEW-P','项目',t.fx.orgIds.shanghai);
    const id=await t.contract({projectId:project,originalAmount:'900000.00'});
    const now=new Date().toISOString(); t.db.prepare('INSERT INTO ic_project(md_project_id,org_id,approved_cents,created_at,updated_at) VALUES(?,?,100000000,?,?)').run(project,t.fx.orgIds.shanghai,now,now);
    await response(post(t.base,t.admin,'/api/risk/scans'),201);
    const hit=t.db.prepare("SELECT level FROM risk_event WHERE subject_type='project' AND subject_id=? AND title LIKE '%90%'").get(project) as any; expect(hit.level).toBe('medium');
    await response(post(t.base,t.admin,`/api/contracts/${id}/settlements`,{settlementKind:'progress',settlementDate:'2026-11-13',inContractAmount:'1000000.00'}),409);
    const ev=await t.doc(id,'change_decision','change'); let d=await response(post(t.base,t.admin,`/api/contracts/${id}/changes`,{...governance,delta:'0',reason:'文本',evidenceDocumentId:ev,supplementNo:'SAME-1'}),201);
    const other=await t.contract({orgId:t.fx.orgIds.east}); const otherEv=await t.doc(other,'change_decision','change');
    expect((await response(post(t.base,t.admin,`/api/contracts/${other}/changes`,{...governance,delta:'0',reason:'跨部门重号',evidenceDocumentId:otherEv,supplementNo:'same-1'}),409)).code).toBe('SUPPLEMENT_NO_EXISTS');
  });

  it('供应商评价回写和组织裁剪可见；节假日与调休统一计算', async () => {
    const t=await setup(); const supplier=await createSupplier(t.base,t.admin,'REVIEW-S','合成供应商'); const id=await t.contract({supplierId:supplier});
    t.db.prepare("UPDATE ct_contract SET status='closed',stage='closed' WHERE id=?").run(id);
    await response(put(t.base,t.admin,`/api/contracts/${id}/evaluation`,{qualityScore:5,scheduleScore:4,serviceScore:3,recommendation:'preferred',comment:'合成履约评价'}));
    const s=await response(get(t.base,t.admin,`/api/master/suppliers/${supplier}`)); expect(s.evaluations[0]).toMatchObject({contractId:id,qualityScore:5});
    const calendar={holidays:new Set(['2026-11-16']),workdays:new Set(['2026-11-14'])};
    expect(workingDaysBetween('2026-11-13','2026-11-16',calendar)).toBe(1); expect(workingDayCutoffBefore('2026-11-16',0,calendar)).toBe('2026-11-13');
  });
  it('预算与计划在初签、支付时核验正式来源；包干池跨合同共同占用', async () => {
    const t = await setup(); const project = await createProject(t.base,t.admin,'BUD-P','额度项目',t.fx.orgIds.shanghai);
    const id = await t.contract({projectId:project,originalAmount:'100.00'},'approval');
    const doc = await t.doc(id,'out_of_plan_approval');
    const fo = (t.db.prepare('SELECT file_object_id FROM ct_document WHERE id=?').get(doc) as any).file_object_id;
    // 尚未指定审批文件时，不能仅因附件池里有旧文件就批准新的超计划变更。
    const now = new Date().toISOString();
    const bid = Number(t.db.prepare("INSERT INTO pb_batch(year,period,name,file_object_id,file_sha256,file_name,is_current,row_count,created_at) VALUES(2026,'2026-11','正式预算',?,'sha-budget','b.xlsx',1,1,?)").run(fo,now).lastInsertRowid);
    t.db.prepare("INSERT INTO pb_entry(batch_id,row_no,project_id,project_code,project_name,org_id,fund_source,budget_cents,executed_cents,exec_month) VALUES(?,1,?,'BUD-P','额度项目',?,'自有',5000,0,'2026-11')").run(bid,project,t.fx.orgIds.shanghai);
    t.db.prepare("UPDATE ct_contract SET stage='performance' WHERE id=?").run(id);
    const payment = { nodeName:'超预算付款',amount:'100.00',approvalTier:'finance_vp',approverName:'李',approverTitle:'财务副总',plannedDate:'2026-11-13' };
    expect((await response(post(t.base,t.admin,`/api/contracts/${id}/payments`,payment),409)).code).toBe('BUDGET_APPROVAL_NOTICE_REQUIRED');
    let original=await t.detail(id);await response(t.patch(id,{expectedVersion:original.version,outOfPlanApprovedDate:'2026-10-01'}));
    await response(post(t.base,t.admin,`/api/contracts/${id}/payments`,payment),201);
    // 去掉容缺审批凭据，仅构造该附件的其他合同；本合同没有超预算审批。
    const id2 = await t.contract({projectId:project,originalAmount:'100.00'},'approval');
    const d = await t.detail(id2); expect(d.blockers.map((b:any)=>b.code)).toContain('PROJECT_BUDGET_EXCEEDED');
    await response(post(t.base,t.admin,`/api/contracts/${id2}/advance`,{expectedVersion:d.version,toStage:'performance'}),409);
    const pool = Number(t.db.prepare("INSERT INTO plan_batch(year,actual_period,file_object_id,file_sha256,file_name,amount_unit,is_current,item_count,fact_count,created_at) VALUES(2026,'2026-11',?,'sha-plan','p.xlsx','yuan',1,1,1,?)").run(fo,now).lastInsertRowid);
    const item = Number(t.db.prepare("INSERT INTO plan_item(batch_id,sheet_code,row_no,item_name,item_type,item_key,org_id) VALUES(?,'purchase',1,'包干池','detail','pool',?)").run(pool,t.fx.orgIds.shanghai).lastInsertRowid);
    t.db.prepare("INSERT INTO plan_fact(batch_id,item_id,field_key,measure,value_type,amount_cents,source_cell) VALUES(?,?,'annual_plan','annual_plan','amount',10000,'A1')").run(pool,item);
    await t.contract({planItemId:item,budgetType:'lump_sum_pool',originalAmount:'70.00'});
    const last=await t.contract({planItemId:item,budgetType:'lump_sum_pool',originalAmount:'40.00'},'approval');
    expect((await t.detail(last)).blockers.map((b:any)=>b.code)).toContain('OUT_OF_PLAN_APPROVAL_REQUIRED');
  });

  it('风险处置后增量风险数下降；正式报送只打包最新盖章件和精确变更附件槽', async () => {
    const t=await setup(); const id=await t.contract({ ...{
      counterpartyNames:'合成服务单位',contractType:'服务',reportCategory:'service',summaryText:'服务',fundingSourceDetail:'自有',entrustReason:'必要服务',decisionMethod:'approval',finalApproverName:'王',finalApproverTitle:'总经理',
      procurementMethod:'inquiry',procurementPlanText:'年度采购',procurementStartDate:'2024-12-01',supplierConfirmDate:'2024-12-02',responseDocsComplete:true,creditChecked:true,undertakerName:'张',deptReviewerName:'李',relatedMgmtDepts:'企管',relatedMgmtReviewers:'赵',unitApproverName:'王',unitApproverTitle:'总经理',ourSignatoryName:'王',ourSignatoryTitle:'法人',ourSignatoryIsLegalRep:true,counterpartySignatoryIsLegalRep:true,
    }});
    await t.doc(id,'company_approval');await t.doc(id,'supplier_qualification','qualification');
    const old=await t.doc(id,'other','signed'); const latest=await t.doc(id,'other','signed');
    let pre=await response(get(t.base,t.admin,'/api/contracts/exports/supervision/preflight'));expect(pre.items[0],JSON.stringify(pre)).toMatchObject({ready:true});
    const ev=await t.doc(id,'change_decision','change');let d=await response(post(t.base,t.admin,`/api/contracts/${id}/changes`,{...governance,delta:'0',reason:'文本',evidenceDocumentId:ev,supplementNo:'PKG-1'}),201);
    const cid=d.changes[0].id;await response(post(t.base,t.admin,`/api/contracts/${id}/changes/${cid}/decide`,decision));
    pre=await response(get(t.base,t.admin,'/api/contracts/exports/supervision/preflight'));expect(pre.items[0].missingAttachments).toEqual(expect.arrayContaining([`变更 #${cid} 01变更决策附件`,`变更 #${cid} 02变更协议文本`]));
    await t.doc(id,'change_decision','change',cid);await t.doc(id,'change_agreement','change',cid);
    const out=await post(t.base,t.admin,'/api/contracts/exports/supervision/package',{});expect(out.status).toBe(200);const zip=await JSZip.loadAsync(Buffer.from(await out.arrayBuffer()));
    const signed=Object.keys(zip.files).filter(n=>n.includes('/03合同文本/')&&!zip.files[n].dir);expect(signed).toHaveLength(1);expect(signed[0]).toContain(`/${latest}_`);expect(signed[0]).not.toContain(`/${old}_`);
    await response(post(t.base,t.admin,'/api/risk/scans'),201);const full=await response(get(t.base,t.admin,'/api/contracts/supervision-portal/full'));const before=full.items[0].openRiskCount;expect(before).toBeGreaterThan(0);
    const risk=t.db.prepare("SELECT id,version FROM risk_event WHERE source='contract' AND subject_type='contract' AND subject_id=? AND status='open' LIMIT 1").get(id) as any;
    await response(post(t.base,t.admin,`/api/risk/events/${risk.id}/actions`,{action:'false_positive',expectedVersion:String(risk.version),comment:'人工判定'}),200);
    const inc=await response(get(t.base,t.admin,`/api/contracts/supervision-portal/incremental?since=${encodeURIComponent(full.nextSince)}&cursorId=${full.nextCursorId}`));expect(inc.items.find((c:any)=>c.id===id).openRiskCount).toBe(before-1);
  });

});
