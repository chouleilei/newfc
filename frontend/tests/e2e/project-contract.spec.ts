import { createRequire } from 'node:module';
import type { Locator, Page } from '@playwright/test';
import { expect, login, test } from './access';

const require = createRequire(import.meta.url);
const XLSX = require('../../../backend/node_modules/xlsx') as typeof import('xlsx');

function buildBiff8PlanWorkbook(): Buffer {
  const wb = XLSX.utils.book_new();
  const sheets: [string, (string | number)[][]][] = [
    ['固定资产投资', [['2026年度固定资产投资计划表'], ['序号', '项目名称', '项目总投资', '已完成投资', '2026年计划投资', '承办单位'], ['1', '合成测试除险加固工程', 5000, 1200, 800, '上海公司']]],
    ['更新改造投资', [['序号', '项目名称', '总投资', '2026年计划投资', '承办单位'], ['1', '机组自动化技改', 600, 300, '上海公司']]],
    ['信息化投资', [['序号', '项目名称', '总投资', '2026年计划投资', '承办单位'], ['1', '调度数据网改造', 200, 100, '上海公司']]],
    ['小型基建投资', [['序号', '项目名称', '总投资', '2026年计划投资', '承办单位'], ['1', '营地零星修缮', 120, 80, '上海公司']]],
    ['固定资产购置', [['序号', '设备名称', '单价', '数量', '年度计划', '承办单位'], ['1', '巡检仪', 5, 2, 10, '上海公司']]],
    ['项目前期', [['序号', '项目名称', '总费用', '年度计划', '承办单位'], ['1', '抽蓄前期专题', 300, 90, '上海公司']]],
    ['新增生产能力', [['序号', '项目名称', '权益比例', '新增容量', '承办单位'], ['1', '二期光伏扩建', 100, 2.5, '上海公司']]],
    ['更新改造费用化', [['序号', '项目名称', '总费用', '2025年计划金额', '承办单位'], ['1', '非资本化技改试验', 50, 30, '上海公司']]],
    ['运行维护', [['序号', '项目名称', '总费用', '年度计划', '承办单位'], ['1', '日常水工巡检维护', 200, 180, '上海公司']]],
    ['安全生产投入', [['序号', '项目名称', '总费用', '年度计划', '承办单位'], ['1', '防汛应急物资储备', 60, 60, '上海公司']]],
    ['五项费用', [['序号', '费用名称', '年度计划', '承办单位'], ['1', '业务招待与会议费', 15, '上海公司']]],
    ['管理费用', [['序号', '费用名称', '年度计划', '承办单位'], ['1', '办公及后勤管理费', 45, '上海公司']]],
    ['制造费用', [['序号', '费用名称', '年度计划', '承办单位'], ['1', '电站生产制造费', 110, '上海公司']]],
    ['汇总表', [['序号', '指标名称', '年度计划', '承办单位'], ['1', '发电量综合指标', 50000, '上海公司']]],
    ['利润表', [['序号', '指标名称', '年度计划', '承办单位'], ['1', '营业总收入目标', 12000, '上海公司']]],
    ['各单位经营指标', [['序号', '指标名称', '年度计划', '承办单位'], ['1', '利润总额考核指标', 900, '上海公司']]],
  ];
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }) as Buffer;
}

/**
 * T-4 界面链路:AC-F04 合同导入预览→确认→台账与详情;AC-F22 报销单提交→后台审核运行(制度条款超限、材料缺失)
 * →人工复核退回补件(管理员同人例外原因)→工作台待办;AC-F09/F15 项目预算与计划执行页面空态。
 */
const OK = /确\s*[定认]|OK/;

async function pickOrg(page: Page, scope: Locator | Page, name: string) {
  await scope.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '组织' }) }).first().click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-tree-title', { hasText: name }).first().click();
  await expect(dropdown).toBeHidden();
}

test.describe('项目、合同与费用审核页面', () => {
  test('合同与费用台账:服务端翻页、总数和筛选在刷新后保留', async ({ page, request }) => {
    const orgs = await (await request.get('/api/org/tree')).json() as { rows: { id: number; name: string }[] };
    const orgId = orgs.rows.find((o) => o.name === '上海公司')!.id;
    const prefix = `E2E-PAGE-${Date.now()}`;
    for (let i = 0; i < 23; i++) {
      const no = `${prefix}-${i}`;
      const contract = await request.post('/api/contracts', { data: { contractNo: no, name: '分页合同', orgId, originalAmount: '100.00' } });
      expect(contract.status()).toBe(201);
      const claim = await request.post('/api/expense/claims', {
        data: { claimNo: no, applicant: '分页申请人', expenseType: '办公费', orgId, amount: '100.00', occurredDate: '2026-09-30' },
      });
      expect(claim.status()).toBe(201);
    }
    await login(page);
    for (const [path, placeholder] of [['contracts', '编号或名称'], ['expense', '单号/申请人/事由']]) {
      await page.goto(`/${path}?keyword=${prefix}&page=2&pageSize=20`);
      await expect(page.getByText('共 23 条')).toBeVisible();
      await expect(page.locator('.ant-table-tbody .ant-table-row')).toHaveCount(3);
      await expect(page.locator('tr', { hasText: `${prefix}-0` })).toBeVisible();
      await page.reload();
      await expect(page.locator('.ant-table-tbody .ant-table-row')).toHaveCount(3);
      await expect(page.getByPlaceholder(placeholder)).toHaveValue(prefix);
      await page.getByPlaceholder(placeholder).fill(`${prefix}-0`);
      await page.getByPlaceholder(placeholder).press('Enter');
      await expect(page.getByText('共 1 条')).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`/${path}\\?keyword=${prefix}-0&pageSize=20$`));
    }
  });

  test('授权父组织的费用账号默认看到下级单据,范围外单据不可见', async ({ request, browser }, testInfo) => {
    const orgs = await (await request.get('/api/org/tree')).json() as { rows: { id: number; name: string }[] };
    const orgId = (name: string) => orgs.rows.find((o) => o.name === name)!.id;
    const roles = await (await request.get('/api/security/roles')).json() as { items: { id: number; code: string }[] };
    const roleId = roles.items.find((r) => r.code === 'business_reviewer')!.id;
    const stamp = Date.now();
    const visibleNo = `E2E-ORG-SH-${stamp}`;
    const hiddenNo = `E2E-ORG-GROUP-${stamp}`;
    for (const [claimNo, name] of [[visibleNo, '上海公司'], [hiddenNo, '集团']]) {
      const created = await request.post('/api/expense/claims', {
        data: { claimNo, orgId: orgId(name), applicant: '范围测试', expenseType: '办公费', amount: '100.00', occurredDate: '2026-09-30' },
      });
      expect(created.status()).toBe(201);
    }
    const username = `e2e-east-expense-${stamp}`;
    const password = 'Vt9-east-expense-pw';
    const user = await request.post('/api/security/users', {
      data: { username, password, roleIds: [roleId], orgIds: [orgId('华东')], mustChangePassword: false },
    });
    expect(user.status()).toBe(201);
    const context = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL), storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} });
    try {
      const session = await context.request.post('/api/auth/login', { data: { username, password } });
      expect(session.status()).toBe(200);
      const page = await context.newPage();
      await page.goto('/expense?status=draft');
      await expect(page.getByText('全部授权组织')).toBeVisible();
      await expect(page.locator('tr', { hasText: visibleNo })).toBeVisible();
      await expect(page.locator('tr', { hasText: hiddenNo })).toHaveCount(0);
    } finally { await context.close(); }
  });

  test('合同导入:预览计划 → 确认写入 → 台账与详情金额', async ({ page }) => {
    const no = `E2E-HT-${Date.now()}`;
    await login(page);
    await page.goto('/contracts/import');
    const csv = `﻿合同编号,合同名称,项目编码,供应商,合同金额,已付款金额,签订日期,合同类型,责任组织,付款上限比例\n${no},E2E 泵站改造合同,,,100000,20000,2026-03-01,施工,上海公司,\n`;
    await page.locator('input[type=file]').setInputFiles({ name: 'contracts-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByText('新增 1 · 更新 0 · 无变化 0')).toBeVisible();
    await expect(page.locator('tr', { hasText: no })).toContainText('100,000.00');
    await page.getByRole('button', { name: '确认导入' }).click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: OK }).click();
    await expect(page.getByText('已写入:新增 1、更新 0、无变化 0')).toBeVisible();

    await page.getByRole('button', { name: '查看合同台账' }).click();
    await expect(page).toHaveURL(/\/contracts$/);
    await page.getByPlaceholder('编号或名称').fill(no);
    await page.getByPlaceholder('编号或名称').press('Enter');
    const row = page.locator('tr', { hasText: no });
    await expect(row).toContainText('履约执行');
    await expect(row).toContainText('20.00%');
    await row.click();
    const drawer = page.locator('.ant-drawer-content');
    await expect(drawer.getByText(`${no} · E2E 泵站改造合同`)).toBeVisible();
    await expect(drawer.getByText('100,000.00').first()).toBeVisible();
    await drawer.getByRole('tab', { name: /付款/ }).click();
    await expect(drawer.getByText('导入基线')).toBeVisible();
  });

  test('费用审核:提交 → 审核运行引用条款 → 退回补件 → 工作台待办', async ({ page, request }) => {
    const code = `E2E-TRAVEL-${Date.now()}`;
    const policy = await request.post('/api/expense/policies', {
      data: {
        code, title: 'E2E 差旅费管理办法', effectiveFrom: '2026-01-01',
        clauses: [{ clauseNo: '3.1', clauseText: '差旅费单次报销不超过 5,000 元,须附住宿发票', expenseTypes: ['差旅费'], limit: '5000.00', requiredKeywords: ['住宿'] }],
      },
    });
    expect(policy.status(), await policy.text()).toBe(201);

    await login(page);
    await page.goto('/expense');
    await page.getByRole('button', { name: '新建报销单' }).click();
    const dialog = page.getByRole('dialog', { name: '新建报销单' });
    await pickOrg(page, dialog, '上海公司');
    await dialog.getByLabel('申请人').fill('张三');
    await dialog.getByLabel('费用类型').fill('差旅费');
    await dialog.getByLabel('报销金额(元)').fill('6000.00');
    await dialog.getByLabel('事由').fill('E2E 赴杭州现场检查');
    await dialog.getByRole('button', { name: OK }).click();
    await expect(page.getByText(/已创建报销单 BX/)).toBeVisible();
    await expect(page.locator('.ant-table-tbody tr', { hasText: 'E2E 赴杭州现场检查' }).first()).toBeVisible();

    const drawer = page.locator('.ant-drawer-content');
    await drawer.getByRole('button', { name: '提交审核' }).click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: OK }).click();
    await expect(drawer.getByText('待复核').first()).toBeVisible({ timeout: 30_000 });
    await expect(drawer.getByText('LIMIT_EXCEEDED').first()).toBeVisible();
    await expect(drawer.getByText(`${code} v1`).first()).toBeVisible();
    await expect(drawer.getByText('MATERIAL_MISSING').first()).toBeVisible();
    await expect(page.locator('.ant-table-tbody tr', { hasText: 'E2E 赴杭州现场检查' }).first()).toContainText('待复核');

    await drawer.getByRole('combobox', { name: /^处置 #\d+ MATERIAL_MISSING$/ }).first().click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: '缺失材料' }).click();
    await drawer.locator('label.ant-radio-button-wrapper', { hasText: '退回补件' }).click();
    await drawer.getByPlaceholder('复核意见').fill('请补住宿发票');
    await drawer.getByPlaceholder(/例外原因/).fill('E2E 单人环境,管理员自审');
    await drawer.getByRole('button', { name: /提交复核/ }).click();
    await expect(page.getByText('复核已记录')).toBeVisible();
    await expect(drawer.getByText('退回补件').first()).toBeVisible();
    await expect(drawer.getByText('同人例外')).toBeVisible();

    await page.goto('/');
    const card = page.getByTestId('workbench-todo-card');
    await expect(card).toContainText('退回补件报销');
    await card.getByText('退回补件报销').click();
    await expect(page).toHaveURL(/\/expense\?status=supplement/);
    await expect(page.locator('tr', { hasText: 'E2E 赴杭州现场检查' }).first()).toBeVisible();
  });

  test('项目预算与计划执行:无当前批次时给出说明而不是空白或 0', async ({ page }) => {
    await login(page);
    await page.goto('/project-budget');
    await expect(page.getByRole('heading', { name: '导入批次' })).toBeVisible();
    await expect(page.getByRole('button', { name: '导入项目预算' })).toBeVisible();
    await page.goto('/plan');
    await expect(page.getByRole('heading', { name: '项目进度' })).toBeVisible();
    await expect(page.getByRole('button', { name: '导入计划执行' })).toBeVisible();
    await page.goto('/expense/policies');
    await expect(page.getByRole('button', { name: '新建制度依据' })).toBeVisible();
  });

  test('P0: 16表 .xls 综合计划导入、母公司前缀智能取号、容缺历史 .xls 导入与内部归档 ZIP、0.10保函比例、负净额阻断及 DatePicker 支付', async ({ page, request }) => {
    const stamp = Date.now().toString(36).toUpperCase();
    const orgs = (await (await request.get('/api/org/tree')).json()) as { rows: { id: number; code: string; name: string }[] };
    const groupOrg = orgs.rows.find((o) => o.code === 'GROUP')!;
    const shOrg = orgs.rows.find((o) => o.name === '上海公司')!;
    const priorYear = Number(new Date().toISOString().slice(0, 4)) - 1;
    const setRes = await request.put('/api/settings/business', {
      data: {
        'contract.prior_year_net_assets': JSON.stringify([
          { orgId: groupOrg.id, year: priorYear, amount: '90000000.00' },
          { orgId: shOrg.id, year: priorYear, amount: '90000000.00' },
        ]),
      },
    });
    expect(setRes.status(), await setRes.text()).toBe(200);

    await login(page);

    // 1) 上传 16 表 BIFF8 .xls 综合计划并激活
    await page.goto('/plan');
    await page.getByRole('button', { name: '导入计划执行' }).click();
    const planDlg = page.getByRole('dialog', { name: /导入综合计划与执行/ });
    await planDlg.locator('input[type=file]').setInputFiles({
      name: `plan-16sheets-${stamp}.xls`,
      mimeType: 'application/vnd.ms-excel',
      buffer: buildBiff8PlanWorkbook(),
    });
    await planDlg.getByRole('button', { name: /^预\s*览$/ }).click();
    await expect(planDlg.getByText(/校验通过:16 行/)).toBeVisible();
    await expect(planDlg.getByText(/非阻断校验提示/)).toBeVisible();
    await planDlg.getByRole('button', { name: /导\s*入/ }).click();
    await expect(planDlg).toBeHidden();
    await page.getByRole('button', { name: '激活', exact: true }).first().click();
    await expect(page.getByText('固定资产投资计划(1 行)')).toBeVisible();

    // 2) 配置母公司编码前缀映射并验证新建合同点击「生成建议编号」自动回填
    await request.post('/api/contracts/prefix-map', {
      data: {
        rawPrefix: `GRP${stamp.slice(-3)}`,
        canonicalPrefix: 'GRP',
        legalEntityOrgId: groupOrg.id,
        signingOrgId: shOrg.id,
        parentCanonicalPrefix: 'GRP',
        entityStatus: 'inherited_child',
        prefixKind: 'internal_prefix',
        allowNewContract: true,
        note: 'E2E 沿用母公司编码测试',
      },
    });
    await page.goto('/contracts');
    await page.getByRole('button', { name: '新建合同' }).click();
    const createDlg = page.getByRole('dialog', { name: '新建合同' });
    await pickOrg(page, createDlg, '上海公司');
    await expect(createDlg.getByText(/规范取号码：/)).toBeVisible();
    await createDlg.getByRole('button', { name: '生成建议编号' }).click();
    const noInput = createDlg.getByLabel('合同编号', { exact: true });
    await expect(noInput).not.toHaveValue('');
    await createDlg.getByRole('button', { name: /关\s*闭|Close/ }).first().click();
    await expect(createDlg).toBeHidden();

    // 3) 历史容缺导入 .xls（缺签订日期）与内部归档 ZIP 不阻塞导出
    const legacyWb = XLSX.utils.book_new();
    const legacyNo = `MIG-E2E-${stamp}`;
    XLSX.utils.book_append_sheet(
      legacyWb,
      XLSX.utils.aoa_to_sheet([
        ['合同编号', '合同名称', '合同金额', '已付款金额', '签订日期', '合同类型', '责任组织'],
        [legacyNo, '历史容缺泵站抢修合同', 180000, 30000, '', '工程', '上海公司'],
      ]),
      '历史台账',
    );
    const legacyXls = XLSX.write(legacyWb, { type: 'buffer', bookType: 'biff8' }) as Buffer;

    await page.goto('/contracts/import');
    await page.getByText('历史容缺多簿归并入库').click();
    await page.locator('input[type=file]').setInputFiles({
      name: `legacy-${stamp}.xls`,
      mimeType: 'application/vnd.ms-excel',
      buffer: legacyXls,
    });
    await expect(page.getByText('五维行去向对账摘要')).toBeVisible();
    await expect(page.getByText('100% 闭合')).toBeVisible();
    await page.getByRole('button', { name: '确认导入' }).click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: OK }).click();
    await expect(page.getByText(/已写入:新增 1/)).toBeVisible();

    await page.goto('/contracts');
    await page.getByRole('button', { name: '报送导出 (月报 / 纪巡财审)' }).click();
    const expDlg = page.getByRole('dialog', { name: /合同标准报送导出/ });
    await expect(expDlg.getByRole('button', { name: '生成并下载 ZIP 报送包' })).toBeDisabled();
    await expDlg.getByText('内部历史全量归档备份').click();
    await expect(expDlg.getByText(/ZIP 根目录将附带《缺口待补录清单\.xlsx》/)).toBeVisible();
    const archiveDlPromise = page.waitForEvent('download');
    await expDlg.getByRole('button', { name: '打包下载内部归档 ZIP' }).click();
    const archiveDl = await archiveDlPromise;
    expect(archiveDl.suggestedFilename()).toMatch(/\.zip$/);
    await expDlg.getByRole('button', { name: /关\s*闭|Close/ }).first().click();

    // 4) 录入 0.10 保函比例、负净额阻断、/payment-tier-preview 动态分级与 DatePicker 登记支付
    const activeNo = `E2E-P0-ACT-${stamp}`;
    const csv = `合同编号,合同名称,项目编码,供应商,合同金额,已付款金额,签订日期,合同类型,责任组织,付款上限比例\n${activeNo},E2E P0校验综合合同,,,500000,0,2026-06-01,服务,上海公司,\n`;
    await page.goto('/contracts/import');
    await page.locator('input[type=file]').setInputFiles({
      name: 'active-contract.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await page.getByRole('button', { name: '确认导入' }).click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: OK }).click();
    await expect(page.getByText(/已写入:新增 1/)).toBeVisible();

    const found = (await (await request.get(`/api/contracts?keyword=${activeNo}`)).json()) as { id: number; version: number }[];
    const cid = found[0].id;
    await request.patch(`/api/contracts/${cid}`, {
      data: {
        expectedVersion: found[0].version,
        ourSignatoryName: '张法人',
        ourSignatoryTitle: '法定代表人',
        ourSignatoryIsLegalRep: true,
        counterpartySignatoryIsLegalRep: true,
      },
    });
    await request.post(`/api/contracts/${cid}/documents`, {
      multipart: { docType: 'invoice', file: { name: 'inv-p0.pdf', mimeType: 'application/pdf', buffer: Buffer.from('invoice') } },
    });

    await page.goto(`/contracts?id=${cid}`);
    const drawer = page.locator('.contract-detail-drawer');
    await expect(drawer.getByText(activeNo)).toBeVisible();

    // 0.10 保函比例通过校验
    await drawer.getByRole('tab', { name: /担保 · 质保 · 纠纷/ }).click();
    await drawer.getByRole('button', { name: '登记保函 / 保险' }).click();
    const gDlg = page.getByRole('dialog', { name: '登记保函 / 保证金 / 工程保险' });
    await gDlg.getByLabel('担保比例(0～1)').fill('0.10');
    await gDlg.getByRole('button', { name: OK }).click();
    await expect(gDlg).toBeHidden();
    await expect(drawer.getByText('保函 / 保证金 / 工程保险台账 · 1')).toBeVisible();
    await expect(drawer.getByText('履约保函')).toBeVisible();
    const detailAfterGuarantee = await (await request.get(`/api/contracts/${cid}`)).json();
    expect(detailAfterGuarantee.guarantees?.[0]?.ratio).toBe('0.100000');

    // 负净额结算阻断
    await drawer.getByRole('tab', { name: /结算与付款/ }).click();
    await drawer.getByRole('button', { name: '提交结算单' }).click();
    const settleDlg = page.getByRole('dialog', { name: '提交结算单' });
    await settleDlg.getByLabel('扣回预付款(元)', { exact: true }).fill('100.00');
    await expect(settleDlg.getByText(/净应付\/收金额不可为负/)).toBeVisible();
    await expect(settleDlg.getByRole('button', { name: OK })).toBeDisabled();
    await settleDlg.getByLabel('合同内应结(元)', { exact: true }).fill('300000.00');
    await settleDlg.getByRole('button', { name: OK }).click();
    await expect(settleDlg).toBeHidden();

    // 复核结算单 → 付款申请动态分级预览 → 复核 → DatePicker 登记支付
    await drawer.getByRole('button', { name: /复\s*核/ }).first().click();
    let decideDlg = page.getByRole('dialog', { name: '复核结算单' });
    await decideDlg.getByLabel(/例外原因/).fill('E2E 管理员复核结算');
    await decideDlg.getByRole('button', { name: OK }).click();
    await expect(decideDlg).toBeHidden();

    await drawer.getByRole('button', { name: '付款申请' }).click();
    const payDlg = page.getByRole('dialog', { name: '付款申请' });
    await payDlg.getByLabel('付款节点', { exact: true }).fill('一期进度款');
    await payDlg.getByLabel('金额(人民币元)', { exact: true }).fill('200000.00');
    await expect(payDlg.getByText(/1% 门槛：900000\.00 元/)).toBeVisible();
    await payDlg.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: /最高审批层级/ }) }).first().click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last().getByText('公司分管财务副总经理', { exact: true }).click();
    await payDlg.getByLabel('最高审批人姓名', { exact: true }).fill('李副总');
    await payDlg.getByLabel('最高审批人职务', { exact: true }).fill('分管财务领导');
    await payDlg.getByRole('button', { name: OK }).click();
    await expect(payDlg).toBeHidden();

    await drawer.getByRole('button', { name: /复\s*核/ }).first().click();
    decideDlg = page.getByRole('dialog', { name: '复核付款申请' });
    await decideDlg.getByLabel(/例外原因/).fill('E2E 管理员复核付款');
    await decideDlg.getByRole('button', { name: OK }).click();
    await expect(decideDlg).toBeHidden();

    await drawer.getByRole('button', { name: '登记支付' }).click();
    const regPayDlg = page.getByRole('dialog', { name: '登记支付' });
    await expect(regPayDlg.locator('.ant-picker')).toBeVisible();
    await regPayDlg.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: /发票/ }) }).first().click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last().getByText('发票 · inv-p0.pdf', { exact: true }).click();
    await regPayDlg.getByRole('button', { name: OK }).click();
    await expect(regPayDlg).toBeHidden();
    await expect(drawer.getByText('200,000.00').first()).toBeVisible();
  });
});
