import { describe, expect, it } from 'vitest';
import { runWithContext, systemContext } from '../src/core/request-context';
import { createRole } from '../src/modules/security/security.service';
import { boot, get, json } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';

/** T-7 检索建议(AC-F26,对应 lishui search/suggestions):类型按读权限裁剪;关键词只取完全相同/前缀命中,范围同检索口径。 */

describe('T-7 检索建议', () => {
  it('类型裁剪、前缀联想、组织范围', async () => {
    const { base, db, admin, fx } = await boot('newfc-t7-suggest-');
    await createProject(base, admin, 'SG-001', '泵站改造一期', fx.orgIds.shanghai);
    await createProject(base, admin, 'SG-002', '泵站改造二期', fx.orgIds.hangzhou);
    await createProject(base, admin, 'XX-9', '城区泵站', fx.orgIds.shanghai); // 只“包含”关键词,不进联想
    await createSupplier(base, admin, 'S-01', '泵站设备公司');

    const all = await json(get(base, admin, '/api/search/suggestions'));
    expect(all.items).toEqual([]);
    expect(all.types).toHaveLength(11);
    expect(all.types[0]).toEqual({ type: 'project', label: '项目', hint: '按项目编码、名称、类型' });

    const s = await json(get(base, admin, `/api/search/suggestions?q=${encodeURIComponent('泵站')}`));
    expect(s.items.map((i: { title: string }) => i.title).sort()).toEqual(['泵站改造一期', '泵站改造二期', '泵站设备公司'].sort());
    expect(s.items.find((i: { code: string }) => i.code === 'SG-001')).toMatchObject({ type: 'project', typeLabel: '项目', path: expect.stringMatching(/^\/projects\/\d+$/) });
    const byCode = await json(get(base, admin, '/api/search/suggestions?q=sg-00'));
    expect(byCode.items.map((i: { code: string }) => i.code).sort()).toEqual(['SG-001', 'SG-002']);
    expect((await json(get(base, admin, '/api/search/suggestions?q=%25'))).items).toEqual([]);
    expect((await get(base, admin, `/api/search/suggestions?q=${'x'.repeat(65)}`)).status).toBe(400);

    // 受限用户:只看到有权限的类型;项目按组织范围过滤
    runWithContext(systemContext('cli'), () => createRole(db, { code: 'md_search', name: '主数据检索', permissions: ['master:read', 'search:use'] }));
    const sh = createScopedUser(db, { username: 'sg-sh', roleCodes: ['md_search'], orgIds: [fx.orgIds.shanghai] }).session;
    const limited = await json(get(base, sh, `/api/search/suggestions?q=${encodeURIComponent('泵站')}`));
    expect(limited.types.map((t: { type: string }) => t.type)).toEqual(['project', 'supplier']);
    expect(limited.items.map((i: { title: string }) => i.title).sort()).toEqual(['泵站改造一期', '泵站设备公司'].sort());

    // 没有检索权限:403
    runWithContext(systemContext('cli'), () => createRole(db, { code: 'md_nosearch', name: '无检索', permissions: ['master:read'] }));
    const no = createScopedUser(db, { username: 'sg-no', roleCodes: ['md_nosearch'], allOrgs: true }).session;
    expect((await get(base, no, '/api/search/suggestions')).status).toBe(403);
  });
});
