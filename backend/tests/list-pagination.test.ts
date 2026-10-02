import { describe, expect, it } from 'vitest';
import { boot, get, json } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { createProject } from './t4-helpers';
import { createRole } from '../src/modules/security/security.service';
import { runWithContext, systemContext } from '../src/core/request-context';

const now = '2026-10-01T00:00:00.000Z';
const largeCents = 9007199254740993n;

describe('台账服务端分页 AC-F09/F16/F22、AC-X04', () => {
  it.each(['contracts', 'expense/claims'])('%s 超过 500 条仍可翻页到旧单据,总数按权限裁剪且金额精确', async (domain) => {
    const { base, db, admin, fx } = await boot('newfc-ledger-page-');
    const insert = domain === 'contracts'
      ? db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`)
      : db.prepare(`INSERT INTO ex_claim (claim_no, applicant, expense_type, org_id, amount_cents, occurred_date, description, created_at, updated_at)
          VALUES (?, '分页申请人', '办公费', ?, ?, '2026-09-30', ?, ?, ?)`);
    db.transaction(() => {
      for (let i = 0; i < 502; i++) {
        const no = `PAGE-${i}`;
        const orgId = i === 501 ? fx.orgIds.nanjing : fx.orgIds.shanghai;
        const cents = i === 0 ? largeCents : 10000n;
        if (domain === 'contracts') insert.run(no, no, '分页样本', orgId, cents, now, now);
        else insert.run(no, orgId, cents, '分页样本', now, now);
      }
    })();
    const viewer = createScopedUser(db, { username: `paged-${domain.replace('/', '-')}`, roleCodes: ['viewer'], orgIds: [fx.orgIds.east] });
    const url = `/api/${domain}/page`;
    const first = await json(get(base, viewer.session, url));
    const last = await json(get(base, viewer.session, `${url}?page=26`));
    const repeat = await json(get(base, viewer.session, `${url}?page=26`));
    expect(first).toMatchObject({ total: 501, page: 1, pageSize: 20 });
    expect(first.items).toHaveLength(20);
    expect(last).toMatchObject({ total: 501, page: 26, pageSize: 20 });
    expect(last.items).toHaveLength(1);
    expect(last.items[0]).toMatchObject(domain === 'contracts'
      ? { contractNo: 'PAGE-0', originalAmount: '90071992547409.93' }
      : { claimNo: 'PAGE-0', amount: '90071992547409.93' });
    expect(repeat).toEqual(last);
    expect(first.items.some((x: { id: number }) => x.id === last.items[0].id)).toBe(false);
    expect((await json(get(base, admin, url))).total).toBe(502);
    const narrowed = await json(get(base, viewer.session, `${url}?keyword=PAGE-0&page=26`));
    expect(narrowed).toMatchObject({ total: 1, page: 1 });
    expect(narrowed.items[0].id).toBe(last.items[0].id);
    const empty = await json(get(base, viewer.session, `${url}?keyword=不存在&page=26`));
    expect(empty).toMatchObject({ items: [], total: 0, page: 1 });
    expect(await json(get(base, viewer.session, `${url}?page=9007199254740991`))).toEqual(last);
    if (domain === 'contracts') {
      expect((await json(get(base, viewer.session, `${url}?stage=archived`))).total).toBe(0);
      expect((await json(get(base, viewer.session, `${url}?todo=review`))).total).toBe(0);
    } else {
      expect((await json(get(base, viewer.session, `${url}?status=audited`))).total).toBe(0);
    }
  });

  it('预算批次超过 300 条可翻页,混合组织批次的总数/汇总不泄露范围外事实', async () => {
    const { base, db, admin, fx } = await boot('newfc-budget-page-');
    const shProject = await createProject(base, admin, 'PAGE-SH', '上海分页项目', fx.orgIds.shanghai);
    const njProject = await createProject(base, admin, 'PAGE-NJ', '南京分页项目', fx.orgIds.nanjing);
    const fileId = Number(db.prepare(`INSERT INTO file_object (sha256, size_bytes, original_name, created_at)
      VALUES (?, 0, 'page.xlsx', ?)`).run('0'.repeat(64), now).lastInsertRowid);
    const batch = db.prepare(`INSERT INTO pb_batch (year, period, name, file_object_id, file_sha256, file_name, row_count, created_at)
      VALUES (2026, '2026-09', ?, ?, ?, 'page.xlsx', 1, ?)`);
    const entry = db.prepare(`INSERT INTO pb_entry (batch_id, row_no, project_id, project_code, project_name, org_id,
      fund_source, budget_cents, executed_cents, exec_month) VALUES (?, ?, ?, ?, '分页项目', ?, '自有资金', ?, 0, '2026-09')`);
    let oldId = 0;
    let mixedId = 0;
    db.transaction(() => {
      for (let i = 0; i < 303; i++) {
        const id = Number(batch.run(i === 0 ? '历史批次' : `分页批次${i}`, fileId, String(i).padStart(64, '0'), now).lastInsertRowid);
        const outside = i === 1;
        entry.run(id, 1, outside ? njProject : shProject, outside ? 'PAGE-NJ' : 'PAGE-SH', outside ? fx.orgIds.nanjing : fx.orgIds.shanghai,
          i === 0 ? largeCents : 10000n);
        if (i === 0) oldId = id;
        if (i === 302) {
          entry.run(id, 2, njProject, 'PAGE-NJ', fx.orgIds.nanjing, 990000n);
          mixedId = id;
        }
      }
    })();
    const viewer = createScopedUser(db, { username: 'budget-page-sh', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] });
    const url = '/api/project-budget/batches/page';
    const first = await json(get(base, viewer.session, `${url}?year=2026&pageSize=10`));
    expect(first).toMatchObject({ total: 302, page: 1, pageSize: 10 });
    expect(first.items[0]).toMatchObject({ id: mixedId, partial: true, totals: { budget: '100.00' } });
    const last = await json(get(base, viewer.session, `${url}?year=2026&page=31&pageSize=10`));
    expect(last.items).toHaveLength(2);
    expect(last.items.at(-1)).toMatchObject({ id: oldId, totals: { budget: '90071992547409.93' } });
    const keyword = await json(get(base, viewer.session, `${url}?keyword=${encodeURIComponent('历史')}`));
    expect(keyword).toMatchObject({ total: 1 });
    expect(keyword.items[0].id).toBe(oldId);
    expect((await json(get(base, viewer.session, `${url}?year=2025`))).total).toBe(0);
    expect((await json(get(base, viewer.session, `${url}?status=voided`))).total).toBe(0);
    expect((await json(get(base, viewer.session, `${url}?period=2026-08`))).total).toBe(0);
    expect((await json(get(base, viewer.session, `/api/project-budget/batches/${oldId}`))).id).toBe(oldId);
  });

  it('分页接口拒绝非法参数、未登录与无领域读权限', async () => {
    const { base, db, admin } = await boot('newfc-page-validation-');
    const role = runWithContext(systemContext('cli'), () => createRole(db, { code: 'page_no_read', name: '无台账权限', permissions: ['master:read'] }));
    const user = createScopedUser(db, { username: 'page-no-read', roleCodes: [role.code], allOrgs: true });
    for (const url of ['/api/contracts/page', '/api/expense/claims/page', '/api/project-budget/batches/page']) {
      expect((await fetch(`${base}${url}`)).status).toBe(401);
      expect((await get(base, user.session, url)).status).toBe(403);
      for (const bad of ['page=0', 'page=-1', 'page=1.5', 'page=bad', 'pageSize=0', 'pageSize=101', 'pageSize=1.5', 'page=1&page=2']) {
        expect((await get(base, admin, `${url}?${bad}`)).status, `${url}?${bad}`).toBe(400);
      }
    }
  });
});
