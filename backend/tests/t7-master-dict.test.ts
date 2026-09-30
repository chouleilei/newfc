import { describe, expect, it } from 'vitest';
import { boot, get, json, post } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';

/** T-7 主数据字典项(AC-F07,对应 lishui dict-items):类型/取值唯一且不可改;显示名/排序/状态带期望版本;停用代替删除;写入需全组织 master:write。 */

describe('T-7 字典项', () => {
  it('增改停用、类型汇总、权限', async () => {
    const { base, db, admin, fx } = await boot('newfc-t7-dict-');
    const patch = (s: typeof admin, url: string, body: unknown) =>
      fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    const a = await json(post(base, admin, '/api/master/dict-items', { dictType: 'project_stage', itemValue: 'design', itemLabel: '设计' }));
    expect(a).toMatchObject({ dictType: 'project_stage', itemValue: 'design', itemLabel: '设计', sortOrder: 10, status: 'active', version: 1 });
    const b = await json(post(base, admin, '/api/master/dict-items', { dictType: 'project_stage', itemValue: 'build', itemLabel: '施工' }));
    expect(b.sortOrder).toBe(20);
    await json(post(base, admin, '/api/master/dict-items', { dictType: 'fund_source', itemValue: 'fiscal', itemLabel: '财政资金', sortOrder: 1 }));

    const dup = await post(base, admin, '/api/master/dict-items', { dictType: 'project_stage', itemValue: 'design', itemLabel: '重复' });
    expect([dup.status, (await dup.json()).code]).toEqual([409, 'DUPLICATE']);
    expect((await post(base, admin, '/api/master/dict-items', { dictType: 'Bad-Type', itemValue: 'x', itemLabel: 'x' })).status).toBe(400);
    expect((await post(base, admin, '/api/master/dict-items', { dictType: 'project_stage', itemValue: 'x', itemLabel: ' ' })).status).toBe(400);
    expect((await post(base, admin, '/api/master/dict-items', { dictType: 'project_stage', itemValue: 'x', itemLabel: 'x', status: 'inactive' })).status).toBe(400);

    // 改显示名/排序;版本冲突;停用 → 列表可按状态过滤;取值不可改
    const a2 = await json(patch(admin, `/api/master/dict-items/${a.id}`, { expectedVersion: 1, itemLabel: '勘察设计', sortOrder: 30 }));
    expect(a2).toMatchObject({ itemLabel: '勘察设计', sortOrder: 30, version: 2 });
    const stale = await patch(admin, `/api/master/dict-items/${a.id}`, { expectedVersion: 1, itemLabel: 'x' });
    expect([stale.status, (await stale.json()).code]).toEqual([409, 'VERSION_CONFLICT']);
    expect((await patch(admin, `/api/master/dict-items/${a.id}`, { expectedVersion: 2, itemValue: 'x' })).status).toBe(400);
    const off = await json(patch(admin, `/api/master/dict-items/${b.id}`, { expectedVersion: 1, status: 'inactive' }));
    expect(off.status).toBe('inactive');
    const again = await post(base, admin, '/api/master/dict-items', { dictType: 'project_stage', itemValue: 'build', itemLabel: '施工' });
    expect((await again.json()).message).toContain('已停用');

    const stage = await json(get(base, admin, '/api/master/dict-items?dictType=project_stage'));
    expect(stage.items.map((i: { itemValue: string }) => i.itemValue)).toEqual(['build', 'design']);
    expect((await json(get(base, admin, '/api/master/dict-items?dictType=project_stage&status=active'))).items).toHaveLength(1);
    expect((await json(get(base, admin, '/api/master/dict-types'))).items).toEqual([
      { dictType: 'fund_source', itemCount: 1, activeCount: 1 }, { dictType: 'project_stage', itemCount: 2, activeCount: 1 },
    ]);
    expect(() => db.prepare("UPDATE md_dict_item SET item_value = 'z' WHERE id = ?").run(a.id)).toThrow(/不可修改/);
    expect(() => db.prepare('DELETE FROM md_dict_item').run()).toThrow(/只能停用/);
    expect((db.prepare("SELECT COUNT(*) AS c FROM operation_log WHERE action LIKE 'master.dict.%'").get() as { c: number }).c).toBe(5);

    // 受限组织用户可读不可写;viewer 不可写
    const scoped = createScopedUser(db, { username: 'dict-sh', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.shanghai] }).session;
    expect((await get(base, scoped, '/api/master/dict-items')).status).toBe(200);
    expect((await post(base, scoped, '/api/master/dict-items', { dictType: 'x_type', itemValue: 'a', itemLabel: 'a' })).status).toBe(403);
    const viewer = createScopedUser(db, { username: 'dict-view', roleCodes: ['viewer'], allOrgs: true }).session;
    expect((await get(base, viewer, '/api/master/dict-types')).status).toBe(200);
    expect((await post(base, viewer, '/api/master/dict-items', { dictType: 'x_type', itemValue: 'a', itemLabel: 'a' })).status).toBe(403);
  });
});
