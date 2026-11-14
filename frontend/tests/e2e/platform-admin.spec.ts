import { expect, login, test } from './access';

/** T-1 界面链路:AC-F07 项目主数据、AC-F23 业务设置(凭据不回显)、AC-F21 任务中心。 */
test.describe('平台基础页面', () => {
  test('新建项目并在列表中看到归属组织', async ({ page }) => {
    const code = `P-E2E-${Date.now().toString(36).toUpperCase()}`;
    await login(page);
    await page.goto('/master-entities');
    await page.getByRole('button', { name: '新建项目' }).click();
    const dialog = page.getByRole('dialog', { name: '新建项目' });
    await dialog.getByLabel('项目编码').fill(code);
    await dialog.getByLabel('项目名称').fill('端到端测试项目');
    await dialog.getByLabel('归属组织').click();
    await page.locator('.ant-select-tree-title', { hasText: '上海公司' }).click();
    await dialog.getByRole('button', { name: /确\s*定|OK/ }).click();
    await expect(page.getByText('已保存')).toBeVisible();
    const row = page.locator('tr', { hasText: code });
    await expect(row).toContainText('上海公司');
    await expect(row).toContainText('启用');
  });

  test('业务设置:保存后回显;凭据只显示末 4 位', async ({ page }) => {
    const secret = `e2e-ocr-${Date.now()}-k9z2`;
    await login(page);
    await page.goto('/settings/business');
    const nameRow = page.locator('tr', { hasText: '报表单位名称' });
    await nameRow.locator('input').fill('端到端测试单位');
    await page.locator('tr', { hasText: 'OCR 服务密钥' }).locator('input').fill(secret);
    await page.getByRole('button', { name: /保\s*存/ }).click();
    await expect(page.getByText('设置已保存')).toBeVisible();
    await page.reload();
    await expect(page.locator('tr', { hasText: '报表单位名称' }).locator('input')).toHaveValue('端到端测试单位');
    await expect(page.locator('tr', { hasText: 'OCR 服务密钥' })).toContainText('已配置 ****k9z2');
    expect(await page.content()).not.toContain(secret);
  });

  test('任务中心可见后台任务与模型调用两个视图', async ({ page }) => {
    await login(page);
    await page.goto('/jobs');
    await expect(page.getByRole('tab', { name: '后台任务' })).toBeVisible();
    await page.getByRole('tab', { name: '模型调用' }).click();
    await expect(page.getByText('不保存提示词与回答正文')).toBeVisible();
  });

  test('P0: 批量导入组织树、批量初始化多级账号授权及二级法人上年净资产驱动 40万元付款按分管财务领导放行', async ({ page, request }) => {
    const stamp = Date.now().toString(36).toUpperCase();
    const subOrgCode = `E2ESUB_${stamp}`;
    const subOrgName = `示范二级法人_${stamp}`;
    const batchUser = `e2e_sub_u_${stamp.toLowerCase()}`;

    await login(page);

    // 1) 组织管理页：批量导入组织树（预览 → 确认）
    await page.goto('/org');
    await page.getByRole('button', { name: '批量导入组织' }).click();
    const orgModal = page.getByRole('dialog', { name: '批量导入组织树（预览 → 确认）' });
    const orgCsv = [
      'code,parentCode,name,orgKind,creditCode,planIssuanceRootCode,contractPrefixCode,isPlanExcluded,isDirectStation,reportFullName,status,sortOrder',
      `${subOrgCode},EAST,${subOrgName},legal_entity,,EAST,ESB,false,false,集团/${subOrgName},active,88`,
    ].join('\n');
    await orgModal.locator('textarea').fill(orgCsv);
    await orgModal.getByRole('button', { name: '解析并预览' }).click();
    await expect(orgModal.getByText(/校验通过：共 1 行/)).toBeVisible();
    await orgModal.getByRole('button', { name: '确认提交' }).click();
    await expect(orgModal).toBeHidden();
    await expect(page.getByText(subOrgName).first()).toBeVisible();

    // 2) 用户与权限页：批量初始化用户与数据范围（预览 → 确认）
    await page.goto('/settings/security');
    await page.getByRole('button', { name: '批量初始化用户与数据范围' }).click();
    const userModal = page.getByRole('dialog', { name: '批量初始化用户与数据范围（预览 → 确认）' });
    const userCsv = [
      'username,displayName,roleCodes,allOrgs,orgCodes,initialPassword',
      `${batchUser},二级法人经办_${stamp},business_reviewer,否,${subOrgCode},InitPass#2026Z`,
    ].join('\n');
    await userModal.locator('textarea').fill(userCsv);
    await userModal.getByRole('button', { name: '解析并预览' }).click();
    await expect(userModal.getByText(/预览通过：共 1 行/)).toBeVisible();
    await userModal.getByRole('button', { name: '确认批量导入' }).click();
    await expect(userModal).toBeHidden();
    await expect(page.locator('.ant-table-tbody tr', { hasText: batchUser }).first()).toBeVisible();

    // 3) 业务设置页：为该二级法人配置上年净资产 80,000,000.00 元（1% 门槛 800,000.00 元 > 400,000.00 元）
    await page.goto('/settings/business');
    await page.getByRole('button', { name: '一键填入全部在运二级法人' }).click();
    await page.getByRole('button', { name: '+ 新增法人净资产行' }).click();
    const netAssetSection = page.locator('tr').filter({ has: page.getByRole('rowheader', { name: '法人年度净资产', exact: true }) });
    const lastAssetRow = netAssetSection.locator('.ant-table-tbody tr').last();
    await lastAssetRow.locator('.ant-select-selector').click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await dropdown.getByText(`${subOrgName} (${subOrgCode})`, { exact: true }).click();
    await lastAssetRow.getByPlaceholder('如 50000000.00').fill('80000000.00');
    await page.getByRole('button', { name: /^保\s*存$/ }).click();
    await expect(page.getByText('设置已保存')).toBeVisible();

    // 4) 验证该二级法人名下合同 400,000.00 元付款按分管财务领导放行（不误判为集体决策）
    const orgs = (await (await request.get('/api/org/tree')).json()) as { rows: { id: number; code: string }[] };
    const subOrgId = orgs.rows.find((o) => o.code === subOrgCode)!.id;
    const priorYear = new Date().getFullYear() - 1;
    const activeYear = priorYear + 1;
    const created = await request.post('/api/contracts', {
      data: {
        contractNo: `ESB-QT-${stamp}/${activeYear}-001`,
        name: '净资产分级阈值验证合同',
        contractType: '服务',
        orgId: subOrgId,
        budgetType: 'lump_sum_pool',
        counterpartyNames: '示范服务相对方',
        signingEntityLevel: 'secondary_unit',
        legalCategory: 'other',
        isProcurement: false,
        originalAmount: '1000000.00',
        ourSignatoryName: '张法人',
        ourSignatoryTitle: '执行董事',
        ourSignatoryIsLegalRep: true,
        counterpartySignatoryIsLegalRep: true,
        signDate: `${activeYear}-05-01`,
        effectiveDate: `${activeYear}-05-01`,
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    let c = await created.json();
    const upTxt = await request.post(`/api/contracts/${c.id}/documents`, {
      multipart: { docType: 'contract_text', file: { name: 'body.pdf', mimeType: 'application/pdf', buffer: Buffer.from('body') } },
    });
    const docTxt = await upTxt.json();
    await request.post(`/api/contracts/${c.id}/documents`, {
      multipart: { docType: 'signed', file: { name: 'signed.pdf', mimeType: 'application/pdf', buffer: Buffer.from('signed') } },
    });
    for (const toStage of ['procurement', 'drafting', 'approval']) {
      c = await (await request.get(`/api/contracts/${c.id}`)).json();
      const advRes = await request.post(`/api/contracts/${c.id}/advance`, { data: { expectedVersion: c.version, toStage } });
      expect(advRes.status(), await advRes.text()).toBe(200);
    }
    const revRes = await request.post(`/api/contracts/${c.id}/reviews`, { data: { documentId: docTxt.id } });
    expect(revRes.status(), await revRes.text()).toBe(201);
    const rev = await revRes.json();
    const decRes = await request.post(`/api/contracts/${c.id}/reviews/${rev.reviews[0].id}/decide`, {
      data: { decision: 'approve', exceptionReason: 'E2E 管理员复核' },
    });
    expect(decRes.status(), await decRes.text()).toBe(200);
    c = await (await request.get(`/api/contracts/${c.id}`)).json();
    const perfRes = await request.post(`/api/contracts/${c.id}/advance`, { data: { expectedVersion: c.version, toStage: 'performance' } });
    expect(perfRes.status(), await perfRes.text()).toBe(200);

    const payRes = await request.post(`/api/contracts/${c.id}/payments`, {
      data: {
        paymentType: 'prepayment',
        nodeName: '首期预付款',
        amount: '400000.00',
        plannedDate: `${activeYear}-06-15`,
        approvalTier: 'finance_vp',
        approverName: '陈副总',
        approverTitle: '分管财务领导',
      },
    });
    expect(payRes.status(), await payRes.text()).toBe(201);
  });
});
