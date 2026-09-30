import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { runWithContext, systemContext } from '../src/core/request-context';
import { createRole } from '../src/modules/security/security.service';
import { boot, get, json, post } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { createProject } from './t4-helpers';

/**
 * T-6 工作台业务概况(AC-F03):各块按读权限出现、按组织范围计数;无数据如实为 0,
 * 未扫描风险时金额不可用(null + 说明)而不是 0;无项目预算批次时执行率不可用。
 */

const now = '2026-06-30T00:00:00.000Z';

function seedContract(db: DB, no: string, orgId: number, original: number, paid: number): void {
  db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, paid_cents, payment_cap_ratio_scaled, stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 800000, 'performance', 'active', ?, ?)`).run(no, no, `${no} 合同`, orgId, original, paid, now, now);
}

function seedIc(db: DB, mdProjectId: number, orgId: number, summary: object): void {
  const p = Number(db.prepare('INSERT INTO ic_project (md_project_id, org_id, created_at, updated_at) VALUES (?, ?, ?, ?)').run(mdProjectId, orgId, now, now).lastInsertRowid);
  const ver = (type: string) => Number(db.prepare(`INSERT INTO ic_version (project_id, version_type, version_no, name, status, is_current, static_cents, created_at, updated_at)
    VALUES (?, ?, 1, ?, 'confirmed', 1, 100, ?, ?)`).run(p, type, type, now, now).lastInsertRowid);
  const a = ver('design_estimate'); const b = ver('construction_budget');
  db.prepare(`INSERT INTO ic_comparison (project_id, base_version_id, target_version_id, base_content_hash, target_content_hash, redline_version_id,
    thresholds_json, rows_json, summary_json, content_sha256, created_at) VALUES (?, ?, ?, 'a', 'b', ?, '{}', '[]', ?, 'sha', ?)`).run(p, a, b, a, JSON.stringify(summary), now);
}

const blocksOf = async (base: string, s: Parameters<typeof get>[1]) =>
  Object.fromEntries(((await json(get(base, s, '/api/dashboard/domains'))).blocks as any[]).map((b) => [b.key, Object.fromEntries(b.metrics.map((m: any) => [m.label.replace(/\(.*\)$/, ''), m]))]));

describe('T-6 工作台业务概况', () => {
  it('按权限返回块、按范围计数,不可用指标不当作 0', async () => {
    const { base, db, admin, fx } = await boot('newfc-t6-dash-');
    // 空库:全部块存在,计数为 0,风险金额与项目预算执行率不可用
    const empty = await blocksOf(base, admin);
    expect(Object.keys(empty).sort()).toEqual(['contract', 'expense', 'investment', 'project_budget', 'report', 'risk']);
    expect(empty.contract['履约中合同'].value).toBe(0);
    expect(empty.risk['未关闭金额']).toMatchObject({ value: null, note: '尚未执行风险扫描' });
    expect(empty.project_budget['执行率'].value).toBeNull();
    expect(empty.investment['最新快照超限项目'].value).toBe(0);

    seedContract(db, 'HT-SH', fx.orgIds.shanghai, 10_000_000, 2_500_000);
    seedContract(db, 'HT-NJ', fx.orgIds.nanjing, 5_000_000, 0);
    seedIc(db, await createProject(base, admin, 'IC-SH', '上海扩建', fx.orgIds.shanghai), fx.orgIds.shanghai, { totalLevel: 'exceed', exceedCount: 2 });
    seedIc(db, await createProject(base, admin, 'IC-NJ', '南京扩建', fx.orgIds.nanjing), fx.orgIds.nanjing, { totalLevel: 'normal', exceedCount: 0 });
    db.prepare(`INSERT INTO rpt_report (series_no, title, kind, org_id, year, status, created_at, updated_at) VALUES ('RPT-1', 'r', 'risk_investment', ?, 2026, 'pending_approval', ?, ?)`).run(fx.orgIds.nanjing, now, now);
    expect((await post(base, admin, '/api/risk/scans', {})).status).toBe(201);

    const all = await blocksOf(base, admin);
    expect(all.contract['履约中合同'].value).toBe(2);
    expect(all.contract['合同额']).toMatchObject({ value: '150000.00', unit: 'money' });
    expect(all.investment).toMatchObject({ '有对比快照的项目': { value: 2 }, '最新快照超限项目': { value: 1 } });
    expect(all.report['待审批'].value).toBe(1);
    expect(all.risk['未关闭金额'].value).not.toBeNull();

    const sh = createScopedUser(db, { username: 't6-dash-sh', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] });
    const scoped = await blocksOf(base, sh.session);
    expect(scoped.contract['履约中合同'].value).toBe(1);
    expect(scoped.contract['合同额'].value).toBe('100000.00');
    expect(scoped.contract['付款比例'].value).toBe('0.250000');
    expect(scoped.investment['最新快照超限项目'].value).toBe(1);
    expect(scoped.investment['有对比快照的项目'].value).toBe(1);
    expect(scoped.report['待审批'].value).toBe(0);

    // 只有工作台与主数据读权限:不返回任何业务块
    const role = runWithContext(systemContext('cli'), () => createRole(db, { code: 't6_dash_only', name: '仅工作台', permissions: ['dashboard:read', 'master:read'] }));
    const bare = createScopedUser(db, { username: 't6-dash-bare', roleCodes: [role.code], allOrgs: true });
    expect((await json(get(base, bare.session, '/api/dashboard/domains'))).blocks).toEqual([]);
    const none = createScopedUser(db, { username: 't6-dash-none', roleCodes: [], allOrgs: true });
    expect((await get(base, none.session, '/api/dashboard/domains')).status).toBe(403);
  });
});
