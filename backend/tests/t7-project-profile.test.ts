import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { runWithContext, systemContext } from '../src/core/request-context';
import { createRole } from '../src/modules/security/security.service';
import { boot, get, json, post } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { createProject } from './t4-helpers';

/** T-7 项目档案(360 视图):各域同源汇总,分区按读权限裁剪,行按组织范围过滤,范围外项目 404。 */

const now = '2026-06-30T00:00:00.000Z';
let seq = 0;
function fileObject(db: DB): number {
  seq += 1;
  const sha = `a7${String(seq).padStart(4, '0')}`.padEnd(64, '0');
  return Number(db.prepare('INSERT INTO file_object (sha256, size_bytes, original_name, created_at) VALUES (?, 1, ?, ?)').run(sha, `f${seq}.xlsx`, now).lastInsertRowid);
}

describe('T-7 项目档案', () => {
  it('汇总预算/计划/合同/凭证/风险/投资/日志,按权限与组织范围裁剪', async () => {
    const { base, db, admin, fx } = await boot('newfc-t7-profile-');
    const sh = fx.orgIds.shanghai; const hz = fx.orgIds.hangzhou;
    const p1 = await createProject(base, admin, 'P-SH-09', '上海泵站', sh);

    const pb = Number(db.prepare(`INSERT INTO pb_batch (year, period, name, file_object_id, file_sha256, file_name, is_current, row_count, created_at)
      VALUES (2026, '2026-06', 'pb', ?, 'sha-pb-prof', 'pb.xlsx', 1, 2, ?)`).run(fileObject(db), now).lastInsertRowid);
    const pbe = db.prepare(`INSERT INTO pb_entry (batch_id, row_no, project_id, project_code, project_name, org_id, fund_source, budget_cents, executed_cents, exec_month)
      VALUES (?, ?, ?, 'P-SH-09', '上海泵站', ?, ?, ?, ?, '2026-06')`);
    pbe.run(pb, 2, p1, sh, '自有资金', 10_000_000, 4_000_000);
    pbe.run(pb, 3, p1, hz, '专项债', 5_000_000, 1_000_000); // 杭州组织承担的部分:上海受限用户不可见

    const plan = Number(db.prepare(`INSERT INTO plan_batch (year, actual_period, file_object_id, file_sha256, file_name, amount_unit, is_current, item_count, fact_count, created_at)
      VALUES (2026, '2026-06', ?, 'sha-plan-prof', 'plan.xlsx', 'yuan', 1, 1, 2, ?)`).run(fileObject(db), now).lastInsertRowid);
    const item = Number(db.prepare(`INSERT INTO plan_item (batch_id, sheet_code, row_no, item_name, item_type, item_key, project_id, org_id)
      VALUES (?, 'investment', 5, '上海泵站', 'detail', 'k1', ?, ?)`).run(plan, p1, sh).lastInsertRowid);
    db.prepare(`INSERT INTO plan_fact (batch_id, item_id, field_key, measure, value_type, amount_cents, scaled_value, source_cell) VALUES (?, ?, 'annual_plan', 'annual_plan', 'amount', 8000000, NULL, 'E5')`).run(plan, item);
    db.prepare(`INSERT INTO plan_fact (batch_id, item_id, field_key, measure, value_type, amount_cents, scaled_value, source_cell) VALUES (?, ?, 'physical_progress', 'snapshot', 'ratio', NULL, 450000, 'J5')`).run(plan, item);

    const ct = await json(post(base, admin, '/api/contracts', { contractNo: 'HT-P9', name: '泵站施工', orgId: sh, projectId: p1, originalAmount: '200000.00' }));
    db.prepare(`INSERT INTO ct_payment (contract_id, node_name, amount_cents, status, submitted_at) VALUES (?, '预付款', 3000000, 'submitted', ?)`).run(ct.id, now);

    const eas = Number(db.prepare(`INSERT INTO eas_batch (data_type, org_id, source_company, period, file_object_id, file_sha256, file_name, row_count, status, is_current, parser_version, created_at)
      VALUES ('voucher', ?, '样本', '2026-06', ?, 'sha-eas-prof', 'v.csv', 3, 'active', 1, 't7', ?)`).run(sh, fileObject(db), now).lastInsertRowid);
    const line = db.prepare(`INSERT INTO eas_voucher_line (batch_id, source_row, voucher_date, voucher_no, entry_no, account_code, account_name, summary, debit_cents, credit_cents, project_code)
      VALUES (?, ?, '2026-06-10', ?, '1', '1604', '在建工程', '工程款', ?, 0, ?)`);
    line.run(eas, 2, '记-1', 1_500_000, 'P-SH-09');
    line.run(eas, 3, '记-2', 700_000, 'OLD-09'); // 旧编码经映射指向本项目
    line.run(eas, 4, '记-3', 900_000, 'P-OTHER');
    db.prepare(`INSERT INTO md_code_mapping (source_system, entity_type, source_key, target_id, match_kind, valid_from, created_at)
      VALUES ('eas', 'project', 'OLD-09', ?, 'code', '2020-01-01', ?)`).run(p1, now);

    await json(post(base, admin, '/api/risk/scans'));

    const prof = await json(get(base, admin, `/api/master/projects/${p1}/profile`));
    expect(prof.project).toMatchObject({ id: p1, code: 'P-SH-09', orgName: expect.any(String) });
    expect(prof.budget).toMatchObject({ batch: { id: pb, period: '2026-06' }, budget: '150000.00', executed: '50000.00', rate: '0.333333' });
    expect(prof.plan.items[0].facts).toEqual([
      { key: 'annual_plan', label: '本年计划投资', valueType: 'amount', value: '80000.00' },
      { key: 'physical_progress', label: '形象进度', valueType: 'ratio', value: '0.450000' },
    ]);
    expect(prof.contracts).toMatchObject({ count: 1, currentTotal: '200000.00', paidTotal: '0.00' });
    expect(prof.contracts.payments[0]).toMatchObject({ contractNo: 'HT-P9', amount: '30000.00', status: 'submitted' });
    expect(prof.vouchers).toMatchObject({ projectCodes: ['P-SH-09', 'OLD-09'], lineCount: 2, debitTotal: '22000.00' });
    const rules = (d: { risks: { rows: { ruleCode: string }[] } }) => d.risks.rows.map((r) => r.ruleCode).sort();
    expect(rules(prof)).toEqual(['EAS_BUDGET_DIFF', 'PB_LOW_EXEC']); // PB_LOW_EXEC 命中的是杭州承担部分(执行率 0.2)
    expect(prof.investment).toEqual({ control: null, feasibility: [] });
    expect(prof.reports).toEqual([]);
    expect(prof.logs.map((l: { action: string }) => l.action)).toEqual(expect.arrayContaining(['master.project.create']));
    expect(prof.logs.some((l: { entityType: string }) => l.entityType === 'ct_contract')).toBe(true);

    // 上海受限只读用户:杭州承担的预算行被过滤;无审计权限 → 日志分区为 null
    const shViewer = createScopedUser(db, { username: 'p7-sh', roleCodes: ['viewer'], orgIds: [sh] }).session;
    const limited = await json(get(base, shViewer, `/api/master/projects/${p1}/profile`));
    expect(limited.budget).toMatchObject({ budget: '100000.00', executed: '40000.00', rows: [expect.objectContaining({ fundSource: '自有资金' })] });
    expect(limited.logs).toBeNull();
    expect(limited.contracts.count).toBe(1);
    expect(rules(limited)).toEqual(['EAS_BUDGET_DIFF']);

    // 只有主数据读权限:其余分区全部为 null
    runWithContext(systemContext('cli'), () => createRole(db, { code: 'md_only', name: '只看主数据', permissions: ['master:read'] }));
    const mdOnly = createScopedUser(db, { username: 'p7-md', roleCodes: ['md_only'], allOrgs: true }).session;
    const bare = await json(get(base, mdOnly, `/api/master/projects/${p1}/profile`));
    expect(bare).toMatchObject({ budget: null, plan: null, contracts: null, vouchers: null, risks: null, investment: null, reports: null, logs: null });

    // 范围外项目:与不存在同为 404
    const hzViewer = createScopedUser(db, { username: 'p7-hz', roleCodes: ['viewer'], orgIds: [hz] }).session;
    expect((await get(base, hzViewer, `/api/master/projects/${p1}/profile`)).status).toBe(404);
  });
});
