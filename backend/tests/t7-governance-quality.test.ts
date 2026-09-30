/**
 * T-7 数据治理补齐 lishui(AC-F06):质量评分(固定扣分规则、组织范围)与主数据匹配建议(只读,采用走映射覆盖 → 复核)。
 *
 * 样本:lishui v600(澧水公司 2026-05),与 t3-governance 相同的预置主数据 → 4 个 eas_master 警告。
 */
import { describe, it, expect } from 'vitest';
import { runWithContext, systemContext } from '../src/core/request-context';
import { createRole } from '../src/modules/security/security.service';
import { org } from './helpers';
import { createScopedUser } from './http-helpers';
import { boot, easSample, EAS_V600, get, json, post, upload } from './t3-helpers';

describe('T-7 质量评分与主数据匹配建议', () => {
  it('评分随问题状态变化;建议按名称相似度给出并按组织范围裁剪;采用后进入复核', async () => {
    const { base, db, admin } = await boot('newfc-t7-gov-');
    const ls = org.createOrg(db, { parentId: null, code: 'LS', name: '澧水公司' }).id;
    const other = org.createOrg(db, { parentId: null, code: 'OT', name: '其他公司' }).id;
    expect((await post(base, admin, '/api/master/projects', { code: 'LS-2026-001', name: '江垭灌区续建配套与节水改造项目', orgId: ls })).status).toBe(201);
    expect((await post(base, admin, '/api/master/suppliers', { name: '湖南水利建设集团有限公司' })).status).toBe(201);
    const zs = await json(post(base, admin, '/api/master/projects', { code: 'ZS-01', name: '皂市水库除险加固工程项目', orgId: ls }));
    const twin = await json(post(base, admin, '/api/master/projects', { code: 'DT-01', name: '澧水流域数字孪生调度平台', orgId: other }));
    const sup = await json(post(base, admin, '/api/master/suppliers', { name: '常德澧源机电设备公司' }));

    const empty = await json(get(base, admin, '/api/governance/quality-score'));
    expect(empty).toMatchObject({ score: '100.00', grade: '优', totals: { total: 0 } });
    expect(empty.dimensions.map((d: { key: string; weight: string }) => [d.key, d.weight])).toEqual([['consistency', '0.40'], ['completeness', '0.30'], ['accuracy', '0.30']]);
    expect(empty.formula).toContain('100 − 8×未处理错误');

    for (const [type, file] of EAS_V600) {
      const res = await upload(base, admin, '/api/eas/import', easSample(file), file, { dataType: type });
      expect(res.status, await res.clone().text()).toBeLessThan(300);
    }
    const set = await json(post(base, admin, '/api/eas/precheck', { orgId: ls, period: '2026-05' }));
    expect((await post(base, admin, `/api/eas/sets/${set.id}/activate`, { expectedVersion: set.version, expectedCurrentSetId: null })).status).toBe(200);
    expect(await json(post(base, admin, '/api/governance/scan', {}))).toMatchObject({ created: 4 });

    // 4 个未处理警告:完整性 100 − 4×2 = 92;综合 = 100×0.4 + 92×0.3 + 100×0.3 = 97.60
    const scored = await json(get(base, admin, '/api/governance/quality-score'));
    expect(scored).toMatchObject({ score: '97.60', grade: '优', totals: { total: 4, open: 4, pendingReview: 0 } });
    expect(scored.dimensions[1]).toMatchObject({ key: 'completeness', score: '92.00', openWarnings: 4, total: 4 });
    expect((await json(get(base, admin, `/api/governance/quality-score?orgId=${other}`))).totals.total).toBe(0);
    expect((await get(base, admin, '/api/governance/quality-score?period=2026-13')).status).toBe(400);

    // 建议:项目按凭证上的项目名匹配;供应商按名称;无相似主数据则为空
    const matches = await json(get(base, admin, '/api/governance/master-data-matches'));
    const byValue = Object.fromEntries(matches.items.map((i: { value: string }) => [i.value, i]));
    expect(Object.keys(byValue).sort()).toEqual(['LS-2026-002', 'LS-2026-004', '常德澧源机电设备有限公司', '长沙云图信息科技有限公司']);
    expect(byValue['LS-2026-002']).toMatchObject({ entity: 'project', orgName: '澧水公司', period: '2026-05', sourceNames: ['皂市水库除险加固工程'] });
    expect(byValue['LS-2026-002'].suggestions[0]).toMatchObject({ targetId: zs.id, code: 'ZS-01', name: '皂市水库除险加固工程项目' });
    expect(Number(byValue['LS-2026-002'].suggestions[0].confidence)).toBeGreaterThanOrEqual(0.9);
    expect(byValue['LS-2026-004'].suggestions[0]).toMatchObject({ targetId: twin.id, confidence: '1.00' }); // 管理员全范围可见
    expect(byValue['常德澧源机电设备有限公司'].suggestions[0]).toMatchObject({ targetId: sup.id, code: null, name: '常德澧源机电设备公司' });
    expect(byValue['长沙云图信息科技有限公司'].suggestions).toEqual([]);
    const only = await json(get(base, admin, '/api/governance/master-data-matches?withSuggestionsOnly=true'));
    expect(only.items).toHaveLength(3);

    // 组织范围:澧水用户看不到其他公司的项目候选;其他公司用户看不到问题
    const lsUser = createScopedUser(db, { username: 'gov7-ls', roleCodes: ['data_maintainer'], orgIds: [ls] }).session;
    const lsView = await json(get(base, lsUser, '/api/governance/master-data-matches'));
    expect(lsView.items.find((i: { value: string }) => i.value === 'LS-2026-004').suggestions).toEqual([]);
    const issue002 = byValue['LS-2026-002'];
    expect((await json(get(base, lsUser, `/api/governance/issues/${issue002.issueId}/match-suggestions`))).suggestions[0].targetId).toBe(zs.id);
    const otUser = createScopedUser(db, { username: 'gov7-ot', roleCodes: ['data_maintainer'], orgIds: [other] }).session;
    expect((await json(get(base, otUser, '/api/governance/master-data-matches'))).items).toEqual([]);
    expect((await json(get(base, otUser, '/api/governance/quality-score'))).score).toBe('100.00');
    expect((await get(base, otUser, `/api/governance/issues/${issue002.issueId}/match-suggestions`)).status).toBe(404);
    runWithContext(systemContext('cli'), () => createRole(db, { code: 'md_only', name: '仅主数据', permissions: ['master:read'] }));
    const noGov = createScopedUser(db, { username: 'gov7-md', roleCodes: ['md_only'], allOrgs: true }).session;
    expect((await get(base, noGov, '/api/governance/quality-score')).status).toBe(403);

    // 采用建议 = 提交映射覆盖处置(仍需复核);评分按待复核扣 1 分
    const maint = createScopedUser(db, { username: 'gov7-maint', roleCodes: ['data_maintainer'], allOrgs: true }).session;
    const submitted = await post(base, maint, `/api/governance/issues/${issue002.issueId}/dispositions`,
      { kind: 'mapping_override', expectedVersion: issue002.issueVersion, reason: '采用匹配建议', targetId: issue002.suggestions[0].targetId });
    expect(submitted.status, await submitted.clone().text()).toBe(201);
    const after = await json(get(base, admin, '/api/governance/quality-score'));
    expect(after.dimensions[1]).toMatchObject({ score: '93.00', openWarnings: 3, pendingReview: 1 });
    expect(after.score).toBe('97.90');
    expect((await json(get(base, admin, '/api/governance/master-data-matches'))).items.find((i: { value: string }) => i.value === 'LS-2026-002').status).toBe('pending_review');
    expect((db.prepare('SELECT COUNT(*) AS c FROM md_code_mapping').get() as { c: number }).c).toBe(0); // 建议本身不写映射
  });
});
