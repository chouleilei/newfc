import { expect, login, test } from './access';

const signatories = { ourSignatoryName: '测试法人', ourSignatoryTitle: '法定代表人', ourSignatoryIsLegalRep: true, counterpartySignatoryIsLegalRep: true };
const OK = /确\s*[定认]|OK/;

async function pickAntSelect(page: import('@playwright/test').Page, scope: import('@playwright/test').Locator | import('@playwright/test').Page, label: string, option: string) {
  const nameRe = new RegExp('^(\\*\\s*)?' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
  await scope.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: nameRe }) }).first().click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-item-option', { hasText: option }).first().click();
  await expect(dropdown).toBeHidden();
}
async function pickOrg(page: import('@playwright/test').Page, scope: import('@playwright/test').Locator | import('@playwright/test').Page, name: string) {
  await scope.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '组织', exact: true }) }).first().click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-tree-title', { hasText: name }).first().click();
  await expect(dropdown).toBeHidden();
}

test.describe('T-10 合同全生命周期浏览器闭环 (AC-CLM-01～07)', () => {
  test('八阶段质保闭环、授权阻断、中止恢复、结算勾稽、分级付款与收入收款页面闭环', async ({ page, request }) => {
    const orgs = await (await request.get('/api/org/tree')).json() as { rows: { id: number; name: string }[] };
    const orgId = orgs.rows.find((o) => o.name === '上海公司')!.id;
    const stamp = Date.now();
    const project = await (await request.post('/api/master/projects', { data: { code: `CLM-${stamp}`, name: '泵站生命周期E2E项目', orgId } })).json();
    const supplier = await (await request.post('/api/master/suppliers', { data: { code: `CLM-S-${stamp}`, name: '湘水机电E2E单位' } })).json();

    const uploadApi = async (cid: number, docType: string, name: string, evidenceKind?: string) => {
      const r = await request.post(`/api/contracts/${cid}/documents`, {
        multipart: {
          docType,
          ...(evidenceKind ? { evidenceKind } : {}),
          file: { name, mimeType: 'application/pdf', buffer: Buffer.from(docType + '-' + name) },
        },
      });
      expect(r.status(), await r.text()).toBe(201);
      return r.json();
    };

    // 1) 通过页面新建含质保的支出合同（100万元，我方签署人非法定代表人）
    await login(page);
    await page.goto('/contracts');
    await page.getByRole('button', { name: '新建合同' }).click();
    const dialog = page.getByRole('dialog', { name: '新建合同' });
    const expNo = `E2E-CLM-${stamp}`;
    await dialog.getByLabel('合同编号', { exact: true }).fill(expNo);
    await dialog.getByLabel('合同名称', { exact: true }).fill('E2E 泵站质保与结算合同');
    await pickOrg(page, dialog, '上海公司');
    await dialog.getByLabel('合同类型', { exact: true }).fill('工程');
    await dialog.getByLabel('原始金额(元)', { exact: true }).fill('1000000.00');
    await pickAntSelect(page, dialog, '项目', `泵站生命周期E2E项目(${project.code})`);
    await pickAntSelect(page, dialog, '主供应商 / 客户', `湘水机电E2E单位(${supplier.code})`);
    await dialog.getByLabel('承办人', { exact: true }).fill('张工');
    await dialog.getByLabel('我方签署人姓名', { exact: true }).fill('李副总');
    await dialog.getByLabel('我方签署人职务', { exact: true }).fill('副总经理');
    await pickAntSelect(page, dialog, '对方签署人为法定代表人', '是（法定代表人）');
    await pickAntSelect(page, dialog, '我方签署人为法定代表人', '否（须附授权委托书）');
    await dialog.getByLabel('约定质保期', { exact: true }).check();
    await dialog.getByLabel('质保期(月)', { exact: true }).fill('12');
    await dialog.getByLabel('质保金比例(0～1)', { exact: true }).fill('0.05');
    await dialog.getByRole('button', { name: OK }).click();
    await expect(dialog).toBeHidden();

    const drawer = page.locator('.contract-detail-drawer');
    await expect(drawer.getByText(expNo)).toBeVisible();
    const c = (await (await request.get(`/api/contracts?keyword=${expNo}`)).json())[0];
    await uploadApi(c.id, 'procurement', '定标.pdf', 'bid_award_approval');
    for (const toStage of ['procurement', 'drafting']) {
      const latest = await (await request.get(`/api/contracts/${c.id}`)).json();
      await request.post(`/api/contracts/${c.id}/advance`, { data: { expectedVersion: latest.version, toStage } });
    }
    const txt = await uploadApi(c.id, 'contract_text', '正文.docx');
    let latest = await (await request.get(`/api/contracts/${c.id}`)).json();
    await request.post(`/api/contracts/${c.id}/advance`, { data: { expectedVersion: latest.version, toStage: 'approval' } });
    const rev = await (await request.post(`/api/contracts/${c.id}/reviews`, { data: { documentId: txt.id } })).json();
    await request.post(`/api/contracts/${c.id}/reviews/${rev.reviews[0].id}/decide`, {
      data: { decision: 'approve', exceptionReason: 'E2E 管理员复核' },
    });
    await uploadApi(c.id, 'signed', '盖章件.pdf');
    latest = await (await request.get(`/api/contracts/${c.id}`)).json();
    await request.patch(`/api/contracts/${c.id}`, { data: { expectedVersion: latest.version, signDate: '2026-03-01', effectiveDate: '2026-03-01' } });

    // 缺我方授权书时阻断推进履约，补传后按钮可用
    await page.reload();
    await expect(drawer.getByText('我方签署人非法定代表人，须上传我方《授权委托书》')).toBeVisible();
    await expect(drawer.getByRole('button', { name: '推进到履约执行' })).toBeDisabled();
    await uploadApi(c.id, 'authorization', '授权委托书.pdf', 'our_signatory_auth');
    await page.reload();
    await expect(drawer.getByRole('button', { name: '推进到履约执行' })).toBeEnabled();
    await drawer.getByRole('button', { name: '推进到履约执行' }).click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: OK }).click();
    await expect(drawer.getByText('履约执行').first()).toBeVisible();

    // 页面执行承办人交接与中止/恢复
    await drawer.getByRole('button', { name: '承办人交接' }).click();
    const handoverDlg = page.getByRole('dialog', { name: '承办人动态交接' });
    await handoverDlg.getByLabel('新承办人姓名').fill('赵工');
    await handoverDlg.getByRole('button', { name: OK }).click();
    await expect(handoverDlg).toBeHidden();
    await expect(drawer.getByText('赵工').first()).toBeVisible();

    await drawer.getByRole('button', { name: /中\s*止/ }).click();
    const suspendDlg = page.getByRole('dialog', { name: '中止合同履行' });
    await suspendDlg.getByLabel('原因').fill('汛期停工中止');
    await suspendDlg.getByRole('button', { name: OK }).click();
    await expect(drawer.getByText('已中止')).toBeVisible();
    await drawer.getByRole('button', { name: '恢复履行' }).click();
    const resumeDlg = page.getByRole('dialog', { name: '恢复合同履行' });
    await resumeDlg.getByLabel('原因').fill('恢复施工');
    await resumeDlg.getByRole('button', { name: OK }).click();
    await expect(drawer.getByText('进行中')).toBeVisible();

    // 结算与付款页签：试算提交结算单、复核批准、提交 >50万 分级付款并支付
    await uploadApi(c.id, 'invoice', '发票.pdf');
    await uploadApi(c.id, 'other', '总经理签批.pdf', 'payment_approval_form');
    await drawer.getByRole('tab', { name: /结算与付款/ }).click();
    await drawer.getByRole('button', { name: '提交结算单' }).click();
    const settleDlg = page.getByRole('dialog', { name: '提交结算单' });
    await settleDlg.getByLabel('合同内应结(元)', { exact: true }).fill('800000.00');
    await settleDlg.getByLabel('预留质保金(元)', { exact: true }).fill('50000.00');
    await expect(settleDlg.getByText('试算：一、应结小计 800000.00 元 − 二、应扣小计 50000.00 元 = 三、净应付/收 750000.00 元')).toBeVisible();
    await settleDlg.getByRole('button', { name: OK }).click();
    await expect(settleDlg).toBeHidden();
    await drawer.getByRole('button', { name: /复\s*核/ }).first().click();
    let decideDlg = page.getByRole('dialog', { name: '复核结算单' });
    await decideDlg.getByLabel(/例外原因/).fill('E2E 管理员复核结算');
    await decideDlg.getByRole('button', { name: OK }).click();
    await expect(decideDlg).toBeHidden();

    await drawer.getByRole('button', { name: '付款申请' }).click();
    const payDlg = page.getByRole('dialog', { name: '付款申请' });
    await payDlg.getByLabel('付款节点', { exact: true }).fill('一期进度款');
    await payDlg.getByLabel('金额(人民币元)', { exact: true }).fill('750000.00');
    await expect(payDlg.getByText('制度分级要求：不低于「公司总经理（主要负责人）」')).toBeVisible();
    await pickAntSelect(page, payDlg, '最高审批层级', '公司总经理（主要负责人）');
    await payDlg.getByLabel('最高审批人姓名', { exact: true }).fill('王总');
    await payDlg.getByLabel('最高审批人职务', { exact: true }).fill('总经理');
    await pickAntSelect(page, payDlg, '审批签批单 / 会议纪要附件', '其他 · 总经理签批.pdf');
    await payDlg.getByRole('button', { name: OK }).click();
    await expect(payDlg).toBeHidden();
    await drawer.getByRole('button', { name: /复\s*核/ }).first().click();
    decideDlg = page.getByRole('dialog', { name: '复核付款申请' });
    await decideDlg.getByLabel(/例外原因/).fill('E2E 管理员复核付款');
    await decideDlg.getByRole('button', { name: OK }).click();
    await expect(decideDlg).toBeHidden();
    await drawer.getByRole('button', { name: '登记支付' }).click();
    const regPayDlg = page.getByRole('dialog', { name: '登记支付' });
    await pickAntSelect(page, regPayDlg, '发票', '发票 · 发票.pdf');
    await regPayDlg.getByRole('button', { name: OK }).click();
    await expect(regPayDlg).toBeHidden();
    await expect(drawer.getByText('750,000.00').first()).toBeVisible();

    // 2) 收入合同正向收款闭环（无负数冲抵）
    const incNo = `E2E-INC-${stamp}`;
    let inc = await (await request.post('/api/contracts', {
      data: { ...signatories, contractNo: incNo, name: 'E2E 电站售电合同', contractType: '销售', orgId, projectId: project.id, supplierId: supplier.id, originalAmount: '500000.00', direction: 'income', partyRole: 'seller', isProcurement: false },
    })).json();
    const incTxt = await uploadApi(inc.id, 'contract_text', '售电正文.docx');
    for (const toStage of ['procurement', 'drafting', 'approval']) {
      inc = await (await request.get(`/api/contracts/${inc.id}`)).json();
      await request.post(`/api/contracts/${inc.id}/advance`, { data: { expectedVersion: inc.version, toStage } });
    }
    const incRev = await (await request.post(`/api/contracts/${inc.id}/reviews`, { data: { documentId: incTxt.id } })).json();
    await request.post(`/api/contracts/${inc.id}/reviews/${incRev.reviews[0].id}/decide`, { data: { decision: 'approve', exceptionReason: 'E2E' } });
    await uploadApi(inc.id, 'signed', '售电盖章.pdf');
    inc = await (await request.get(`/api/contracts/${inc.id}`)).json();
    await request.patch(`/api/contracts/${inc.id}`, { data: { expectedVersion: inc.version, signDate: '2026-03-02' } });
    inc = await (await request.get(`/api/contracts/${inc.id}`)).json();
    await request.post(`/api/contracts/${inc.id}/advance`, { data: { expectedVersion: inc.version, toStage: 'performance' } });

    await page.goto(`/contracts?id=${inc.id}`);
    await drawer.getByRole('tab', { name: /结算与收款/ }).click();
    await drawer.getByRole('button', { name: '收款登记' }).click();
    const recDlg = page.getByRole('dialog', { name: '收入合同收款登记' });
    await recDlg.getByLabel('收款节点', { exact: true }).fill('首期电费');
    await recDlg.getByLabel('金额(人民币元)', { exact: true }).fill('300000.00');
    await recDlg.getByRole('button', { name: OK }).click();
    await expect(recDlg).toBeHidden();
    await drawer.getByRole('button', { name: /复\s*核/ }).first().click();
    decideDlg = page.getByRole('dialog', { name: '复核收款申请' });
    await decideDlg.getByLabel(/例外原因/).fill('E2E 管理员复核收款');
    await decideDlg.getByRole('button', { name: OK }).click();
    await expect(decideDlg).toBeHidden();
    await drawer.getByRole('button', { name: '登记到账' }).click();
    const arrDlg = page.getByRole('dialog', { name: '登记收款到账' });
    await arrDlg.getByRole('button', { name: OK }).click();
    await expect(arrDlg).toBeHidden();
    await expect(drawer.getByText('300,000.00').first()).toBeVisible();
    await expect(page.getByText('收入合同额(人民币)：')).toBeVisible();
  });
});

test.describe('T-11 变更索赔四位一体、保函质保与纠纷浏览器闭环 (AC-CLM-08～10)', () => {
  test('变更定级实时预览与备案、保函登记与退还、质保签证解锁与纠纷双备案闭环', async ({ page, request }) => {
    const orgs = await (await request.get('/api/org/tree')).json() as { rows: { id: number; name: string }[] };
    const orgId = orgs.rows.find((o) => o.name === '上海公司')!.id;
    const stamp = Date.now();
    const project = await (await request.post('/api/master/projects', { data: { code: `T11-${stamp}`, name: 'T11 E2E工程项目', orgId } })).json();
    const supplier = await (await request.post('/api/master/suppliers', { data: { code: `T11-S-${stamp}`, name: 'T11 E2E承包单位' } })).json();

    const uploadApi = async (cid: number, docType: string, name: string, evidenceKind?: string) => {
      const r = await request.post(`/api/contracts/${cid}/documents`, {
        multipart: {
          docType,
          ...(evidenceKind ? { evidenceKind } : {}),
          file: { name, mimeType: 'application/pdf', buffer: Buffer.from(docType + '-' + name) },
        },
      });
      expect(r.status(), await r.text()).toBe(201);
      return r.json();
    };

    let c = await (await request.post('/api/contracts', {
      data: {
        ...signatories, contractNo: `E2E-T11-${stamp}`,
        name: 'T11 闸门改造施工合同',
        contractType: '工程',
        orgId,
        projectId: project.id,
        supplierId: supplier.id,
        originalAmount: '1000000.00',
        hasWarranty: true,
        warrantyMonths: 12,
        warrantyRetentionRatio: '0.05',
      },
    })).json();
    await uploadApi(c.id, 'procurement', '定标.pdf', 'bid_award_approval');
    for (const toStage of ['procurement', 'drafting']) {
      c = await (await request.get(`/api/contracts/${c.id}`)).json();
      await request.post(`/api/contracts/${c.id}/advance`, { data: { expectedVersion: c.version, toStage } });
    }
    const txt = await uploadApi(c.id, 'contract_text', '正文.docx');
    c = await (await request.get(`/api/contracts/${c.id}`)).json();
    await request.post(`/api/contracts/${c.id}/advance`, { data: { expectedVersion: c.version, toStage: 'approval' } });
    const rev = await (await request.post(`/api/contracts/${c.id}/reviews`, { data: { documentId: txt.id } })).json();
    await request.post(`/api/contracts/${c.id}/reviews/${rev.reviews[0].id}/decide`, { data: { decision: 'approve', exceptionReason: 'E2E' } });
    await uploadApi(c.id, 'signed', '盖章.pdf');
    c = await (await request.get(`/api/contracts/${c.id}`)).json();
    await request.patch(`/api/contracts/${c.id}`, { data: { expectedVersion: c.version, signDate: '2026-03-01', effectiveDate: '2026-03-01' } });
    c = await (await request.get(`/api/contracts/${c.id}`)).json();
    await request.post(`/api/contracts/${c.id}/advance`, { data: { expectedVersion: c.version, toStage: 'performance' } });
    await uploadApi(c.id, 'change', '变更决议.pdf', 'change_decision');
    await uploadApi(c.id, 'guarantee', '履约保函.pdf');
    await uploadApi(c.id, 'settlement', '质保金支付签证表.pdf', 'warranty_release_visa');
    await uploadApi(c.id, 'acceptance', '竣工验收单.pdf');
    await uploadApi(c.id, 'invoice', '发票.pdf');

    await login(page);
    await page.goto(`/contracts?id=${c.id}`);
    const drawer = page.locator('.contract-detail-drawer');
    await expect(drawer.getByText(c.contractNo)).toBeVisible();

    // 1) 变更与索赔页签：附件 5 实时定级、防规避采购提示、0 金额变更提交与备案
    await drawer.getByRole('tab', { name: /变更与索赔/ }).click();
    await drawer.getByRole('button', { name: '提交变更 / 索赔' }).click();
    const chgDlg = page.getByRole('dialog', { name: '提交变更 / 索赔 / 中止 / 解除' });
    await chgDlg.getByLabel('变更金额(元，支持 0 金额或负数)').fill('150000.00');
    await expect(chgDlg.getByText('附件 5 要求审批层级：公司经营层审批')).toBeVisible();
    await expect(chgDlg.getByText('单次或累计增额超原合同 10%')).toBeVisible();
    await chgDlg.getByLabel('具备独立委托条件(制度 9.1.4)').check();
    await expect(chgDlg.getByText(/不得通过变更办理/)).toBeVisible();
    await chgDlg.getByLabel('具备独立委托条件(制度 9.1.4)').uncheck();
    await chgDlg.getByLabel('变更金额(元，支持 0 金额或负数)').fill('0.00');
    await chgDlg.getByLabel('主要事项（≤500字）').fill('工期顺延30天');
    await chgDlg.getByLabel('变更 / 索赔 / 中止 / 解除原因').fill('汛期顺延');
    await pickAntSelect(page, chgDlg, '实际审批层级', '承办单位自行审批（报技术归口与企管部备案）');
    await chgDlg.getByLabel('补充协议编号（法人单位内唯一）').fill(`SUPP-E2E-${stamp}`);
    await pickAntSelect(page, chgDlg, '变更 / 索赔 / 解除依据文档', '变更依据 · 变更决议.pdf');
    await pickAntSelect(page, chgDlg, '决策方式', '审批');
    await chgDlg.getByLabel('最终审批人姓名', { exact: true }).fill('王总');
    await chgDlg.getByLabel('最终审批人身份', { exact: true }).fill('总经理');
    await chgDlg.getByRole('button', { name: OK }).click();
    await expect(chgDlg).toBeHidden();
    await expect(drawer.getByText('工期顺延30天')).toBeVisible();

    await drawer.getByRole('button', { name: /复\s*核/ }).first().click();
    const decideChgDlg = page.getByRole('dialog', { name: '复核变更 / 索赔 / 中止 / 解除' });
    await decideChgDlg.getByLabel(/例外原因/).fill('E2E 复核 0 金额变更');
    await decideChgDlg.getByRole('button', { name: OK }).click();
    await expect(decideChgDlg).toBeHidden();

    // 2) 担保 · 质保 · 纠纷页签：保函登记/退还、质保期签证确认、纠纷登记/双备案
    await drawer.getByRole('tab', { name: /担保 · 质保 · 纠纷/ }).click();
    await drawer.getByRole('button', { name: '登记保函 / 保险' }).click();
    const gDlg = page.getByRole('dialog', { name: '登记保函 / 保证金 / 工程保险' });
    await gDlg.getByLabel('开立机构 / 保险公司').fill('建设银行');
    await gDlg.getByLabel('保函 / 保单编号').fill(`LG-E2E-${stamp}`);
    await gDlg.getByLabel('保函 / 保险金额(元)').fill('100000.00');
    await gDlg.getByLabel('押金金额(元)').fill('20000.00');
    await gDlg.getByRole('button', { name: OK }).click();
    await expect(gDlg).toBeHidden();
    await expect(drawer.getByText(`LG-E2E-${stamp}`)).toBeVisible();

    await drawer.getByRole('button', { name: '维护质保期与缺陷' }).click();
    const wEditDlg = page.getByRole('dialog', { name: '维护质保期与缺陷记录' });
    await wEditDlg.getByLabel('质保金金额(元)').fill('50000.00');
    await wEditDlg.getByLabel('质保开始日期').fill('2025-01-01');
    await wEditDlg.getByLabel('质保开始日期').press('Enter');
    await wEditDlg.getByLabel('质保结束日期').fill('2026-01-01');
    await wEditDlg.getByLabel('质保结束日期').press('Enter');
    await wEditDlg.getByRole('button', { name: OK }).click();
    await expect(wEditDlg).toBeHidden();

    await drawer.getByRole('button', { name: '期满验收签证确认' }).click();
    const wVisaDlg = page.getByRole('dialog', { name: '质保期满验收签证确认' });
    await pickAntSelect(page, wVisaDlg, '验收结论', '期满验收通过');
    await pickAntSelect(page, wVisaDlg, '《质保金支付签证表》附件', '结算文件 · 质保金支付签证表.pdf');
    await wVisaDlg.getByRole('button', { name: OK }).click();
    await expect(wVisaDlg).toBeHidden();
    await expect(drawer.getByText('期满验收通过')).toBeVisible();

    await drawer.getByRole('button', { name: '登记纠纷 / 诉讼' }).click();
    const dDlg = page.getByRole('dialog', { name: '登记纠纷 / 诉讼仲裁（17 列台账）' });
    await pickAntSelect(page, dDlg, '诉讼类型', '民事诉讼');
    await pickAntSelect(page, dDlg, '诉讼地位', '被告');
    await dDlg.getByLabel('案由').fill('工程质保争议');
    await dDlg.getByLabel('案号').fill(`(2026)湘07民初${stamp % 1000}号`);
    await dDlg.getByLabel('涉案金额(元)').fill('50000.00');
    await dDlg.getByRole('button', { name: OK }).click();
    await expect(dDlg).toBeHidden();
    await expect(drawer.getByText(`(2026)湘07民初${stamp % 1000}号`)).toBeVisible();

    const disputeExportPromise = page.waitForEvent('download');
    await drawer.getByRole('button', { name: /导出 17列纠纷台账/ }).click();
    const disputeDownload = await disputeExportPromise;
    expect(disputeDownload.suggestedFilename()).toMatch(/\.xlsx$/);

    // 退还保函并结案纠纷
    await drawer.getByRole('button', { name: /更\s*新/ }).first().click();
    const gUpdDlg = page.getByRole('dialog', { name: '更新保函 / 押金退还 / 索赔报告' });
    await pickAntSelect(page, gUpdDlg, '状态', '已退还 / 清理');
    await gUpdDlg.getByLabel('退还 / 清理日期').fill('2027-06-20');
    await gUpdDlg.getByLabel('退还 / 清理日期').press('Enter');
    await gUpdDlg.getByRole('button', { name: OK }).click();
    await expect(gUpdDlg).toBeHidden();
    await expect(drawer.getByText('已退还 / 清理')).toBeVisible();
  });
});

test.describe('T-12 报送预检导出、5 表月报与完结后履约评价浏览器闭环 (AC-CLM-12～14)', () => {
  test('报送导出弹窗预检/ZIP/5表月报下载及完结合同履约评价登记', async ({ page, request }) => {
    const orgs = await (await request.get('/api/org/tree')).json() as { rows: { id: number; name: string }[] };
    const parentOrgId = orgs.rows.find((o) => o.name === '上海公司')!.id;
    const stamp = Date.now();
    const orgName = `报送测试单位${stamp}`;
    const orgId = (await (await request.post('/api/org', { data: { parentId: parentOrgId, code: `T12ORG-${stamp}`, name: orgName } })).json()).id;
    const project = await (await request.post('/api/master/projects', { data: { code: `T12-P-${stamp}`, name: 'T12报送E2E项目', orgId } })).json();
    const supplier = await (await request.post('/api/master/suppliers', { data: { code: `T12-S-${stamp}`, name: 'T12E2E供应商' } })).json();

    const uploadApi = async (cid: number, docType: string, name: string, evidenceKind?: string) => {
      const r = await request.post(`/api/contracts/${cid}/documents`, {
        multipart: { docType, ...(evidenceKind ? { evidenceKind } : {}), file: { name, mimeType: 'application/pdf', buffer: Buffer.from(docType + '-' + name) } },
      });
      expect(r.status(), await r.text()).toBe(201);
      return r.json();
    };

    await login(page);
    const evalNo = `E2E-T12-${stamp}`;
    const created = await (await request.post('/api/contracts', {
      data: {
        ...signatories, contractNo: evalNo,
        legalCategory: 'other',
        summaryText: '合成报送合同', fundingSourceDetail: '自有资金', entrustReason: '设备维保', decisionMethod: 'approval', finalApproverName: '王总', finalApproverTitle: '总经理',
        procurementMethod: 'inquiry', procurementPlanText: '年度计划', procurementStartDate: '2026-03-01', supplierConfirmDate: '2026-03-15', responseDocsComplete: true, creditChecked: true,
        undertakerName: '张工', deptReviewerName: '部门审核人', relatedMgmtDepts: '企管部', relatedMgmtReviewers: '归口审核人', unitApproverName: '王总', unitApproverTitle: '总经理', reportCategory: 'service', name: 'E2E 完结评价与报送合同', contractType: '服务', orgId,
        projectId: project.id, supplierId: supplier.id, originalAmount: '50000.00',
        signDate: '2026-04-10', hasWarranty: false,
      },
    })).json();
    await uploadApi(created.id, 'procurement', 'proc.pdf', 'company_approval');
    await uploadApi(created.id, 'qualification', 'qualification.pdf', 'supplier_qualification');
    const docTxt = await uploadApi(created.id, 'contract_text', 'txt.pdf');
    await uploadApi(created.id, 'signed', 'sgn.pdf');
    await uploadApi(created.id, 'performance', 'perf.pdf');
    await uploadApi(created.id, 'acceptance', 'acc.pdf');
    const docInv = await uploadApi(created.id, 'invoice', 'inv.pdf');

    let d = await (await request.get(`/api/contracts/${created.id}`)).json();
    for (const toStage of ['procurement', 'drafting', 'approval']) {
      d = await (await request.post(`/api/contracts/${created.id}/advance`, { data: { expectedVersion: d.version, toStage } })).json();
    }
    d = await (await request.post(`/api/contracts/${created.id}/reviews`, { data: { documentId: docTxt.id } })).json();
    d = await (await request.post(`/api/contracts/${created.id}/reviews/${d.reviews[0].id}/decide`, { data: { decision: 'approve', exceptionReason: 'E2E' } })).json();
    for (const toStage of ['performance', 'settlement']) {
      d = await (await request.post(`/api/contracts/${created.id}/advance`, { data: { expectedVersion: d.version, toStage } })).json();
    }
    d = await (await request.patch(`/api/contracts/${created.id}`, { data: { expectedVersion: d.version, finalAccepted: true } })).json();
    d = await (await request.post(`/api/contracts/${created.id}/archive-status`, { data: { expectedVersion: d.version, archiveStatus: 'transferred' } })).json();
    d = await (await request.post(`/api/contracts/${created.id}/settlements`, { data: { settlementKind: 'final', settlementDate: '2026-05-01', inContractAmount: '50000.00' } })).json();
    d = await (await request.post(`/api/contracts/${created.id}/settlements/${d.settlements[0].id}/decide`, { data: { decision: 'approve', exceptionReason: 'E2E' } })).json();
    d = await (await request.post(`/api/contracts/${created.id}/payments`, { data: { nodeName: '全款', amount: '50000.00', approvalTier: 'finance_vp', approverName: '李副总', approverTitle: '财务副总经理' } })).json();
    d = await (await request.post(`/api/contracts/${created.id}/payments/${d.payments[0].id}/decide`, { data: { decision: 'approve', exceptionReason: 'E2E' } })).json();
    d = await (await request.post(`/api/contracts/${created.id}/payments/${d.payments[0].id}/pay`, { data: { paidDate: '2026-05-01', invoiceDocumentId: docInv.id } })).json();
    d = await (await request.post(`/api/contracts/${created.id}/advance`, { data: { expectedVersion: d.version, toStage: 'closed' } })).json();
    expect(d.status).toBe('closed');

    await page.goto('/contracts');
    await page.getByRole('button', { name: '报送导出 (月报 / 纪巡财审)' }).click();
    const exportDlg = page.getByRole('dialog', { name: /合同标准报送导出/ });
    await expect(exportDlg.getByText('纳入报送合同')).toBeVisible();
    await pickOrg(page, exportDlg, orgName);
    await expect(exportDlg.getByText(evalNo)).toBeVisible();

    const zipDownloadPromise = page.waitForEvent('download');
    await exportDlg.getByRole('button', { name: '生成并下载 ZIP 报送包' }).click();
    const zipDownload = await zipDownloadPromise;
    expect(zipDownload.suggestedFilename()).toMatch(/\.zip$/);

    await exportDlg.getByRole('tab', { name: '公司每月 28 日 5 表月报' }).click();
    const xlsxDownloadPromise = page.waitForEvent('download');
    await exportDlg.getByRole('button', { name: /下载 .* 公司 5 表月报/ }).click();
    const xlsxDownload = await xlsxDownloadPromise;
    expect(xlsxDownload.suggestedFilename()).toMatch(/\.xlsx$/);
    await exportDlg.getByRole('button', { name: 'Close' }).click();

    // 打开已完结合同登记履约后评价
    await page.getByText(evalNo).first().click();
    const drawer = page.locator('.contract-detail-drawer');
    await drawer.getByRole('tab', { name: /担保 · 质保 · 纠纷/ }).click();
    await drawer.getByRole('button', { name: '登记履约评价' }).click();
    const evalDlg = page.getByRole('dialog', { name: '登记履约后评价（采购办法 13.2）' });
    await evalDlg.getByLabel('综合评价意见').fill('E2E 按期保质完成');
    await evalDlg.getByRole('button', { name: OK }).click();
    await expect(evalDlg).toBeHidden();
    await expect(drawer.getByText('15 / 15')).toBeVisible();
    await expect(drawer.getByText('E2E 按期保质完成')).toBeVisible();
  });
});

test.describe('T-14 多部门会签、总额包干池监控、1:N 招采台账与列表分币种联动汇总 (AC-T14-06～08)', () => {
  test('包干池实时超限预警、发起多部门会签与录入意见、1:N 招采异议校验保存及列表分币种汇总行', async ({ page, request }) => {
    const orgs = (await (await request.get('/api/org/tree')).json()) as { rows: { id: number; name: string }[] };
    const orgId = orgs.rows.find((o) => o.name === '上海公司')!.id;
    const stamp = Date.now();
    const project = await (
      await request.post('/api/master/projects', {
        data: { code: `T14-P-${stamp}`, name: '示范闸门控制系统改造', orgId },
      })
    ).json();
    const supplier = await (
      await request.post('/api/master/suppliers', {
        data: { code: `T14-S-${stamp}`, name: '示范自控成套设备公司', isInPool: true },
      })
    ).json();

    await login(page);
    await page.goto('/contracts');

    // 1) 新建合同弹窗：切换「生产经营总额包干」验证实时超限红字告警，调高上限后保存
    await page.getByRole('button', { name: '新建合同' }).click();
    const dialog = page.getByRole('dialog', { name: '新建合同' });
    const ctNo = `E2E-T14-${stamp}`;
    await dialog.getByLabel('合同编号', { exact: true }).fill(ctNo);
    await dialog.getByLabel('合同名称', { exact: true }).fill('示范闸门控制柜采购合同');
    await pickOrg(page, dialog, '上海公司');
    await dialog.getByLabel('合同类型', { exact: true }).fill('采购');
    await dialog.getByLabel('原始金额(元)', { exact: true }).fill('600000.00');
    await pickAntSelect(page, dialog, '项目', `示范闸门控制系统改造(${project.code})`);
    await pickAntSelect(page, dialog, '主供应商 / 客户', `示范自控成套设备公司(${supplier.code})`);
    await pickAntSelect(page, dialog, '立项计划口径', '生产经营总额包干');
    await dialog.getByLabel('包干总额池年度上限(元)').fill('500000.00');
    await expect(dialog.getByText(/生产经营总额包干池超限预警/)).toBeVisible();
    await dialog.getByLabel('包干总额池年度上限(元)').fill('1000000.00');
    await expect(dialog.getByText('生产经营总额包干池额度监控')).toBeVisible();
    await dialog.getByRole('button', { name: OK }).click();
    await expect(dialog).toBeHidden();

    // 2) 详情抽屉：发起多部门会签并录入部门会签通过意见
    const drawer = page.locator('.contract-detail-drawer');
    await expect(drawer.getByText(ctNo)).toBeVisible();
    const createdCt = (await (await request.get(`/api/contracts?keyword=${ctNo}`)).json())[0] as { id: number };
    const sessionInfo = (await (await request.get('/api/auth/session')).json()) as { user: { id: number } };
    await drawer.getByRole('tab', { name: /多部门会签/ }).click();
    await drawer.getByRole('button', { name: '发起制度多部门会签' }).click();
    await expect(drawer.getByText(/当前轮次第 1 轮/)).toBeVisible();
    // 指派当前登录审查人为本轮部门审查人，使页面开放「录入会签结论」按钮（防止无部门归属越权代签）
    await request.post(`/api/contracts/${createdCt.id}/countersigns`, {
      data: {
        assignedReviewers: {
          CAIWU: sessionInfo.user.id,
          QIGUAN: sessionInfo.user.id,
        },
      },
    });
    await page.reload();
    await drawer.getByRole('tab', { name: /多部门会签/ }).click();
    const signButtons = drawer.getByRole('button', { name: '录入会签结论' });
    await expect(signButtons.first()).toBeVisible();
    await signButtons.first().click();
    const signDlg = page.getByRole('dialog', { name: /录入会签结论/ });
    await signDlg.getByLabel('会签审查意见').fill('经审查资金安排与包干额度合规，同意会签');
    await signDlg.getByRole('button', { name: '提交会签结论' }).click();
    await expect(signDlg).toBeHidden();
    await expect(drawer.getByText('同意通过').first()).toBeVisible();

    // 3) 详情抽屉：进入「招采过程」页签，验证质疑投诉必填拦截与补填保存
    await drawer.getByRole('tab', { name: /招采过程/ }).click();
    await drawer.getByLabel('是否存在质疑/澄清/投诉/举报').click();
    await drawer.getByRole('button', { name: '保存招采过程记录' }).click();
    await expect(drawer.getByText('存在质疑或投诉时必须填写详述与处置情况')).toBeVisible();
    await drawer.getByLabel(/质疑\/投诉事项及核查处置结论详述/).fill('供应商技术参数澄清已按期书面答复办结');
    await drawer.getByRole('button', { name: '保存招采过程记录' }).click();
    await expect(page.getByText('招采全过程记录已保存')).toBeVisible();

    // 4) 关闭抽屉，验证列表筛选与分币种汇总行联动展示
    await drawer.locator('.ant-drawer-close').click();
    await page.getByPlaceholder('编号或名称').fill(ctNo);
    await page.getByPlaceholder('编号或名称').press('Enter');
    await expect(page.getByText(/当前筛选合计（人民币 · 1 份）/)).toBeVisible();
  });
});
