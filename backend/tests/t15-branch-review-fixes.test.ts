import { afterEach, describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { createApp } from '../src/server';
import { INTERNAL_PDF_PARSER_TOKEN } from '../src/modules/contracts/local-pdf-parser';
import { assertBudgetPoolCap, computeBudgetPoolUsage } from '../src/modules/contracts/contract-funding';
import { boot, get, json, post, upload } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { budget, buildFixture, closeAllTestDbs, standardBudgetVersion, testDb } from './helpers';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

afterEach(closeAllTestDbs);

async function importPlanWorkbook(base: string, admin: Awaited<ReturnType<typeof boot>>['admin'], sheet: string, rows: unknown[][]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheet);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  const res = await upload(base, admin, '/api/plan/import', buf, 'review-fix.xlsx', {
    year: '2026',
    actualPeriod: '2026-06',
  });
  expect(res.status).toBe(201);
  return json(res);
}

describe('feat/improvement-2026-11 审查 6 项问题修复回归', () => {
  it('1. 跨单位承办视图严格脱敏范围外归口单元的附表、财务指标、文号与组织明细', async () => {
    const { base, admin, db, fx } = await boot('newfc-fix-undertake-scope-');
    const bv = standardBudgetVersion(fx);
    const batch = await importPlanWorkbook(base, admin, '安全生产投入', [
      ['2026年安全生产投入 单位：元'],
      ['序号', '项目名称', '年度计划', '承办单位'],
      ['1', '跨单位承办项目', 100, '华东大区、西部大区'],
      ['2', '华东私密项目', 999, '华东大区'],
    ]);
    const cycle = await json(
      post(base, admin, '/api/plan/issuance/cycles', {
        year: 2026,
        cycleCode: 'FIX-SCOPE-2026',
        sourcePlanBatchId: batch.id,
        sourceBudgetVersionId: bv.id,
      }),
    );
    expect((await post(base, admin, `/api/plan/issuance/cycles/${cycle.id}/publish`, {})).status).toBe(200);

    const westUser = createScopedUser(db, {
      username: 'west-scoped-only',
      roleCodes: ['data_maintainer'],
      orgIds: [fx.orgIds.west],
    });
    const res = await get(base, westUser.session, `/api/plan/issuance/packs?cycleId=${cycle.id}&view=undertake`);
    expect(res.status).toBe(200);
    const data = await json(res);
    const rawJson = JSON.stringify(data);
    expect(rawJson).not.toContain('华东私密项目');
    expect(rawJson).not.toContain('上海公司');
    expect(rawJson).not.toContain('杭州公司');

    const eastRedacted = data.items.find((p: { unitOrgId: number }) => p.unitOrgId === fx.orgIds.east);
    expect(eastRedacted).toBeTruthy();
    expect(eastRedacted.attachments).toEqual([]);
    expect(eastRedacted.attachmentCount).toBe(0);
    expect(eastRedacted.docNo).toBe('');
    expect(eastRedacted.responsibilityLetterNo).toBe('');
    expect(eastRedacted.mergedChildOrgs).toEqual([]);
    expect(eastRedacted.metrics.operatingRevenue).toBe('0.00');
    expect(eastRedacted.metrics.profitBeforeTax).toBe('0.00');
    expect(eastRedacted.metrics.safetyInputTotal).toBe('0.00');
    expect(eastRedacted.undertakeItems).toHaveLength(1);
    expect(eastRedacted.undertakeItems[0].itemName).toBe('跨单位承办项目');
  });

  it('2 & 5. 包干池正确读取已定稿采用(locked)的负向费用预算，且往年合同不占用本年度包干池', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const bv = standardBudgetVersion(fx); // 上海公司管理费用 20.00 元（存储为 -2000 分）
    budget.lockVersion(db, bv.id);
    budget.setCurrentVersion(db, bv.id);

    // 2025 年已结项包干合同 60.00 元，不应计入 2026 年度占用或覆盖 2026 年度池上限
    db.prepare(
      `INSERT INTO ct_contract (
         contract_no, normalized_no, name, org_id, original_cents,
         budget_type, budget_pool_account_id, budget_pool_cap_cents,
         sign_date, stage, status, created_at, updated_at
       ) VALUES ('OLD-2025', 'OLD2025', '往年物业合同', ?, 6000, 'lump_sum_pool', ?, 10000, '2025-03-01', 'closed', 'closed', '2025-03-01', '2025-12-31')`,
    ).run(fx.orgIds.shanghai, fx.accIds.expenseAdmin);

    const within2026: Parameters<typeof computeBudgetPoolUsage>[1] = {
      id: 0,
      org_id: fx.orgIds.shanghai,
      direction: 'expense',
      budget_type: 'lump_sum_pool',
      budget_pool_account_id: fx.accIds.expenseAdmin,
      budget_pool_cap_cents: null,
      plan_item_id: null,
      sign_date: '2026-06-01',
      created_at: '2026-06-01',
      currency: '人民币',
      exchange_rate_scaled: null,
      currency_struct_status: 'single',
      migration_mode: 'normal',
      pricing_mode: 'lump_sum',
      estimated_ceiling_cents: null,
      original_cents: 1500n,
      approved_change_cents: 0n,
      annual_plan_alloc_cents: null,
    };
    const okUsage = computeBudgetPoolUsage(db, within2026);
    expect(okUsage?.capCents).toBe(2000n);
    expect(okUsage?.usedOtherCents).toBe(0n);
    expect(okUsage?.totalUsedCents).toBe(1500n);
    expect(okUsage?.remainingCents).toBe(500n);
    expect(() => assertBudgetPoolCap(db, within2026)).not.toThrow();

    const over2026 = { ...within2026, original_cents: 3000n };
    expect(() => assertBudgetPoolCap(db, over2026)).toThrow(/BUDGET_POOL_EXCEEDED|突破年度包干总额池上限/);
  });

  it('3 & 4. 正式预算录入负向成本/费用时，下达指标利润计算准确（150 - 120 = 30）且运维含税除税勾稽发布通过', async () => {
    const { base, admin, db, fx } = await boot('newfc-fix-budget-sign-');
    // 华东大区：上海收入100/成本60/费用20 + 杭州收入50/成本30/费用10 => 收入150.00，成本费用120.00，利润30.00
    const bvProfit = standardBudgetVersion(fx);
    const profitCycle = await json(
      post(base, admin, '/api/plan/issuance/cycles', {
        year: 2026,
        cycleCode: 'FIX-PROFIT-2026',
        sourceBudgetVersionId: bvProfit.id,
      }),
    );
    const eastPack = profitCycle.packs.find((p: { unitOrgId: number }) => p.unitOrgId === fx.orgIds.east);
    expect(eastPack.metrics.operatingRevenue).toBe('150.00');
    expect(eastPack.metrics.profitBeforeTax).toBe('30.00');

    // 单元预算视图同样返回正向展示成本/费用
    const unitView = await json(get(base, admin, `/api/versions/${bvProfit.id}/unit-view?orgId=${fx.orgIds.east}`));
    expect(unitView.totalsByAccountType).toEqual({ income: 15000, cost: 9000, expense: 3000 });

    // 正常通过 saveEntries 录入运行维护费不含税预算 100.00 元（存储 -10000 分），含税计划 106.00 元 -> 发布 200 通过
    db.prepare("UPDATE account SET name = '运行维护费' WHERE id = ?").run(fx.accIds.costSub);
    const bvVat = budget.createVersion(db, { year: 2026, name: '2026运维勾稽版' });
    budget.saveEntries(db, bvVat.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '100.00' },
    ]);
    const batch = await importPlanWorkbook(base, admin, '运行维护费', [
      ['2026年运行维护费 单位：元'],
      ['序号', '项目名称', '年度计划', '承办单位'],
      ['1', '日常运维', 106, '上海公司'],
    ]);
    const vatCycle = await json(
      post(base, admin, '/api/plan/issuance/cycles', {
        year: 2026,
        cycleCode: 'FIX-VAT-2026',
        sourceBudgetVersionId: bvVat.id,
        sourcePlanBatchId: batch.id,
      }),
    );
    const pubRes = await post(base, admin, `/api/plan/issuance/cycles/${vatCycle.id}/publish`, {});
    expect(pubRes.status).toBe(200);
  });

  it('6. 内部 PDF 解析端点拦截反向代理转发头、非回环 Host 及未持服务令牌的匿名请求', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-fix-pdf-guard-'));
    const { app, holder } = await createApp({ dbPath: path.join(dir, 'newfc.sqlite'), trustProxy: 1 });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      // 携带 X-Forwarded-* / X-Real-IP（即使带了内部令牌也必须按非直连回环拒绝 403）
      const proxiedRes = await fetch(`${base}/api/internal/pdf-parser/health`, {
        headers: {
          authorization: `Bearer ${INTERNAL_PDF_PARSER_TOKEN}`,
          'x-forwarded-for': '198.51.100.20',
          'x-forwarded-proto': 'https',
        },
      });
      expect(proxiedRes.status).toBe(403);

      // 通过原生 HTTP 发送真实非回环公网域名 Host 头（绕过 fetch 禁发头过滤）-> 403
      const hostSpoofStatus = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/api/internal/pdf-parser/health',
            method: 'GET',
            headers: {
              Host: 'finance.example.com',
              Authorization: `Bearer ${INTERNAL_PDF_PARSER_TOKEN}`,
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(hostSpoofStatus).toBe(403);

      // 直连回环但未提供服务令牌 -> 401
      const noAuthRes = await fetch(`${base}/api/internal/pdf-parser/health`);
      expect(noAuthRes.status).toBe(401);

      // 直连回环且携带有效服务令牌 -> 200
      const okRes = await fetch(`${base}/api/internal/pdf-parser/health`, {
        headers: { authorization: `Bearer ${INTERNAL_PDF_PARSER_TOKEN}` },
      });
      expect(okRes.status).toBe(200);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      holder.getDb().close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
