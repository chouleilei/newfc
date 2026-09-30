/**
 * T-4 助手只读工具(AC-F09/F15/F16/F22/AC-X04):项目预算、计划执行、合同汇总/详情、费用审核队列
 * 调用页面同源 service;受限用户缺省落在唯一授权根,范围外组织/合同 404;无权限不暴露;写操作不是工具。
 */
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { runWithContext } from '../src/core/request-context';
import { loadAuthContext } from '../src/modules/security/security.service';
import { executeTool, toolDefinitions } from '../src/assistant/tools';
import { toolAllowed, TOOL_POLICIES } from '../src/assistant/tool-policy';
import { allowedToolsForCapabilities, pageCapability } from '../src/assistant/page-capabilities';
import { createScopedUser } from './http-helpers';
import { boot } from './t3-helpers';

function as<T>(db: DB, userId: number, fn: () => T): T {
  const auth = loadAuthContext(db, userId);
  if (!auth) throw new Error('user disabled');
  return runWithContext({ requestId: 'test', source: 'http', auth }, fn);
}
function codeOf(fn: () => unknown): string | undefined {
  try { fn(); return undefined; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; }
}

const NEW_TOOLS = ['project_budget_summary', 'plan_execution_overview', 'contract_summary', 'contract_detail', 'expense_audit_queue'];
const now = '2026-06-30T00:00:00.000Z';

describe('T-4 助手只读工具', () => {
  it('登记为只读工具并暴露定义;没有写操作工具', () => {
    for (const name of NEW_TOOLS) {
      expect(TOOL_POLICIES[name]?.scope).toBe(name === 'contract_detail' ? 'global' : 'org_scope');
      expect(toolDefinitions.some((d) => d.function.name === name)).toBe(true);
      expect(allowedToolsForCapabilities(['project_data'])).toContain(name);
    }
    expect(pageCapability('assistant')!.capabilities).toContain('project_data');
    const names = toolDefinitions.map((d) => d.function.name);
    expect(names.filter((n) => /contract|expense|plan_|project_budget/.test(n)).sort()).toEqual([...NEW_TOOLS].sort());
  });

  it('受限用户只看到授权组织;范围外组织与合同 404;参数显式校验;无权限拒绝', async () => {
    const { db, fx } = await boot('newfc-t4-as-');
    const contract = (no: string, orgId: number, original: number, paid: number) => Number(db.prepare(`INSERT INTO ct_contract
      (contract_no, normalized_no, name, org_id, original_cents, paid_cents, stage, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'performance', 'active', ?, ?)`)
      .run(no, no, `${no} 合同`, orgId, original, paid, now, now).lastInsertRowid);
    const sh = contract('HT-SH', fx.orgIds.shanghai, 10_000_000, 2_500_000);
    const nj = contract('HT-NJ', fx.orgIds.nanjing, 50_000_000, 0);
    const claim = (no: string, orgId: number, status: string) => db.prepare(`INSERT INTO ex_claim (claim_no, org_id, applicant, expense_type, amount_cents, occurred_date, status,
      created_at, updated_at, submitted_at) VALUES (?, ?, '张三', '差旅费', 100000, '2026-05-10', ?, ?, ?, ?)`).run(no, orgId, status, now, now, now);
    claim('BX-SH', fx.orgIds.shanghai, 'audited');
    claim('BX-NJ', fx.orgIds.nanjing, 'audited');

    const user = createScopedUser(db, { username: 'as4-sh', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] });
    as(db, user.userId, () => {
      for (const name of NEW_TOOLS) expect(toolAllowed(name)).toBe(true);
      const summary = executeTool(db, 'contract_summary', {}) as any;
      expect(summary).toMatchObject({ count: 1, currentAmount: '100000.00', paidAmount: '25000.00', paymentRate: '0.250000' });
      const detail = executeTool(db, 'contract_detail', { contractId: sh }) as any;
      expect(detail).toMatchObject({ contractNo: 'HT-SH', orgName: '上海公司', currentAmount: '100000.00', stage: 'performance' });
      expect(codeOf(() => executeTool(db, 'contract_detail', { contractId: nj }))).toBe('NOT_FOUND');
      const queue = executeTool(db, 'expense_audit_queue', {}) as any;
      expect(queue.counts.audited).toBe(1);
      expect(queue.awaitingReview.items.map((i: any) => i.claimNo)).toEqual(['BX-SH']);
      expect(JSON.stringify(queue)).not.toContain('南京');
      expect((executeTool(db, 'project_budget_summary', {}) as any)).toMatchObject({ batch: null });
      expect((executeTool(db, 'plan_execution_overview', { year: 2026 }) as any)).toMatchObject({ year: 2026, batch: null });

      for (const name of NEW_TOOLS.filter((n) => n !== 'contract_detail')) {
        expect(codeOf(() => executeTool(db, name, { orgScopeId: fx.orgIds.nanjing, year: 2026 }))).toBe('NOT_FOUND');
      }
      expect(codeOf(() => executeTool(db, 'plan_execution_overview', {}))).toMatch(/year/);
      expect(codeOf(() => executeTool(db, 'plan_execution_overview', { year: 2026, asOfPeriod: '2025-12' }))).toMatch(/计划年度/);
      expect(codeOf(() => executeTool(db, 'contract_detail', { contractId: 'x' }))).toMatch(/contractId/);
    });

    const all = createScopedUser(db, { username: 'as4-all', roleCodes: ['viewer'], allOrgs: true });
    as(db, all.userId, () => {
      expect((executeTool(db, 'contract_summary', {}) as any).count).toBe(2);
      expect((executeTool(db, 'contract_summary', { orgScopeId: fx.orgIds.east }) as any).count).toBe(1);
      expect((executeTool(db, 'expense_audit_queue', {}) as any).counts.audited).toBe(2);
    });

    const noPerm = createScopedUser(db, { username: 'as4-none', roleCodes: [], allOrgs: true });
    as(db, noPerm.userId, () => {
      for (const name of NEW_TOOLS) {
        expect(toolAllowed(name)).toBe(false);
        expect(codeOf(() => executeTool(db, name, { year: 2026, contractId: sh }))).toBe('FORBIDDEN');
      }
    });
  });
});
