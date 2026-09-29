/**
 * T-3 助手只读工具(AC-F05/F10/F14/AC-X04):EAS 期间状态、财报总览、管理会计快照与预警
 * 调用页面同源 service;受限用户缺省落在唯一授权根,显式指定范围外组织 404,不泄漏范围外数据。
 */
import { describe, it, expect } from 'vitest';
import type { DB } from '../src/db/connection';
import { runWithContext } from '../src/core/request-context';
import { loadAuthContext } from '../src/modules/security/security.service';
import { executeTool, toolDefinitions } from '../src/assistant/tools';
import { toolAllowed, TOOL_POLICIES } from '../src/assistant/tool-policy';
import { allowedToolsForCapabilities, pageCapability } from '../src/assistant/page-capabilities';
import { budget, saveActualSnapshot, standardBudgetVersion } from './helpers';
import { createScopedUser } from './http-helpers';
import { boot, json, post, upload } from './t3-helpers';
import { statementWorkbook } from './t3-statement-sample';

function as<T>(db: DB, userId: number, fn: () => T): T {
  const auth = loadAuthContext(db, userId);
  if (!auth) throw new Error('user disabled');
  return runWithContext({ requestId: 'test', source: 'http', auth }, fn);
}

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); return undefined; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; }
}

const NEW_TOOLS = ['eas_period_status', 'statement_overview', 'mgmt_metric_snapshots', 'mgmt_alerts'];

describe('T-3 助手只读工具', () => {
  it('登记为只读 org_scope 工具,向模型暴露定义', () => {
    for (const name of NEW_TOOLS) {
      expect(TOOL_POLICIES[name]?.scope).toBe('org_scope');
      expect(toolDefinitions.some((d) => d.function.name === name)).toBe(true);
      expect(allowedToolsForCapabilities(['finance_data'])).toContain(name);
    }
    expect(pageCapability('assistant')!.capabilities).toContain('finance_data');
  });

  it('受限用户只看到授权组织的快照/预警/财报;范围外组织 404;参数显式校验', async () => {
    const { base, db, admin, fx } = await boot();
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    saveActualSnapshot(fx, 2026, '2026-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '60.00' },
    ]);
    const m = await json(post(base, admin, '/api/mgmt/metrics', {
      code: 'ACT_INC', name: '实际收入', params: { calculator: 'actual_amount', accountCode: 'I01' }, thresholds: { upperWarning: '50.00' },
    }));
    const run = await json(post(base, admin, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [m.id], orgIds: [fx.orgIds.shanghai, fx.orgIds.hangzhou] }));
    expect(await json(post(base, admin, '/api/mgmt/alerts/scan', { runId: run.id }))).toMatchObject({ created: 2 });
    for (const orgId of [fx.orgIds.shanghai, fx.orgIds.hangzhou]) {
      const imp = await upload(base, admin, '/api/statements/import', await statementWorkbook(), 'fs.xlsx', { orgId: String(orgId), period: '2026-05', scope: 'consolidated' });
      expect(imp.status, await imp.clone().text()).toBe(201);
      const batch = await imp.json() as any;
      expect((await post(base, admin, `/api/statements/batches/${batch.id}/activate`, { expectedCurrentBatchId: null })).status).toBe(200);
    }

    const sh = createScopedUser(db, { username: 'as-sh', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] });
    as(db, sh.userId, () => {
      for (const name of NEW_TOOLS) expect(toolAllowed(name)).toBe(true);
      const snaps = executeTool(db, 'mgmt_metric_snapshots', { period: '2026-06' }) as any;
      expect(snaps.items.map((s: any) => [s.orgId, s.value])).toEqual([[fx.orgIds.shanghai, '80.00']]);
      const alerts = executeTool(db, 'mgmt_alerts', {}) as any;
      expect(alerts.items.map((a: any) => a.orgId)).toEqual([fx.orgIds.shanghai]);
      expect(JSON.stringify(alerts)).not.toContain('杭州');
      const fs = executeTool(db, 'statement_overview', { period: '2026-05' }) as any;
      expect(fs.batch.orgId).toBe(fx.orgIds.shanghai);
      expect(fs.unitComparison.map((u: any) => u.orgId)).toEqual([fx.orgIds.shanghai]);
      expect((executeTool(db, 'eas_period_status', { period: '2026-05' }) as any)).toMatchObject({ orgId: fx.orgIds.shanghai, currentSet: null });

      for (const name of NEW_TOOLS) {
        expect(codeOf(() => executeTool(db, name, { orgScopeId: fx.orgIds.hangzhou, period: '2026-05' }))).toBe('NOT_FOUND');
      }
      expect(codeOf(() => executeTool(db, 'eas_period_status', { period: '2026-13' }))).toMatch(/period/);
      expect(codeOf(() => executeTool(db, 'mgmt_alerts', { status: 'deleted' }))).toMatch(/status/);
    });

    // 全组织用户:未指定组织时看全部,指定组织时含下级
    const all = createScopedUser(db, { username: 'as-all', roleCodes: ['viewer'], allOrgs: true });
    as(db, all.userId, () => {
      expect((executeTool(db, 'mgmt_metric_snapshots', { period: '2026-06' }) as any).total).toBe(2);
      expect((executeTool(db, 'mgmt_alerts', { orgScopeId: fx.orgIds.east }) as any).items).toHaveLength(2);
      expect(codeOf(() => executeTool(db, 'eas_period_status', { period: '2026-05' }))).toMatch(/请指定组织/);
    });

    // 缺 mgmt:read 等权限的账号不暴露、不能调用
    const noPerm = createScopedUser(db, { username: 'as-none', roleCodes: [], allOrgs: true });
    as(db, noPerm.userId, () => {
      expect(toolAllowed('mgmt_alerts')).toBe(false);
      expect(codeOf(() => executeTool(db, 'mgmt_alerts', {}))).toBe('FORBIDDEN');
    });
  });
});
