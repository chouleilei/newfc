import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, easSample, get, json, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { org } from './helpers';
import { parsePlanWorkbook } from '../src/modules/plan-execution/plan.parse';
import { resetNarrativeCache, rewriteTemplateNarrative } from '../src/assistant/narrative';

/**
 * T-7 系统设置补齐 lishui(AC-F23):自定义字段(项目/供应商 extra 按定义校验)、导入字段模板(解析器表头别名)、
 * AI 提示补充(附在硬约束之后,prompt 版本带内容哈希)。
 */

const send = (base: string, s: Session, method: 'PATCH' | 'PUT', url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function expectStatus(res: Response | Promise<Response>, status: number, text?: string | RegExp) {
  const r = await res;
  const body = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  if (text) expect(body.message).toMatch(text);
  return body;
}

describe('T-7 系统设置', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AI_BASE_URL = '';
    process.env.AI_API_KEY = '';
    resetNarrativeCache();
  });

  it('自定义字段:定义校验、项目/供应商 extra 按定义校验与规整、停用', async () => {
    const { base, db, admin, fx } = await boot('newfc-t7-cf-');
    for (const [v, l] of [['design', '设计'], ['build', '施工']]) {
      await expectStatus(post(base, admin, '/api/master/dict-items', { dictType: 'project_stage', itemValue: v, itemLabel: l }), 201);
    }
    const F = '/api/settings/custom-fields';
    await expectStatus(post(base, admin, F, { domain: 'project', fieldCode: 'stage', fieldName: '阶段', fieldType: 'select' }), 400, /字典类型/);
    await expectStatus(post(base, admin, F, { domain: 'project', fieldCode: 'x1', fieldName: 'x', fieldType: 'select', dictType: 'nope_type' }), 400, /没有有效字典项/);
    await expectStatus(post(base, admin, F, { domain: 'project', fieldCode: 'code', fieldName: '编码', fieldType: 'text' }), 400, /内置字段/);
    const stage = await expectStatus(post(base, admin, F, { domain: 'project', fieldCode: 'stage', fieldName: '阶段', fieldType: 'select', dictType: 'project_stage', required: true }), 201);
    expect(stage).toMatchObject({ sortOrder: 10, required: true, options: [{ value: 'design', label: '设计' }, { value: 'build', label: '施工' }] });
    await expectStatus(post(base, admin, F, { domain: 'project', fieldCode: 'capacity', fieldName: '库容(万方)', fieldType: 'number' }), 201);
    await expectStatus(post(base, admin, F, { domain: 'project', fieldCode: 'approved_on', fieldName: '批复日期', fieldType: 'date' }), 201);
    await expectStatus(post(base, admin, F, { domain: 'supplier', fieldCode: 'contact', fieldName: '联系人', fieldType: 'text', required: true }), 201);
    await expectStatus(post(base, admin, F, { domain: 'project', fieldCode: 'stage', fieldName: '重复', fieldType: 'text' }), 409);

    // 项目:必填缺失、类型错误一次列出;合法值规整(整数转十进制字符串、空值移除、未定义键保留)
    const P = { code: 'CF-001', name: '自定义字段项目', orgId: fx.orgIds.shanghai };
    await expectStatus(post(base, admin, '/api/master/projects', P), 400, /阶段不能为空/);
    await expectStatus(post(base, admin, '/api/master/projects', { ...P, extra: { stage: 'x', capacity: '1.5e3', approved_on: '2026-02-30' } }), 400,
      /阶段的取值“x”不是有效选项;库容\(万方\)应为数字.*;批复日期应为 YYYY-MM-DD 日期/);
    await expectStatus(post(base, admin, '/api/master/projects', { ...P, extra: { stage: 'design', capacity: 0.1 } }), 400, /库容/); // 浮点数不接受
    const p = await expectStatus(post(base, admin, '/api/master/projects', { ...P, extra: { stage: 'design', capacity: 1200, approved_on: '', legacy: 'keep' } }), 201);
    expect(p.extra).toEqual({ stage: 'design', capacity: '1200', legacy: 'keep' });

    // 更新:不传 extra 不校验;传 extra 须满足必填;已停用选项的旧值保留,新值拒绝
    await expectStatus(send(base, admin, 'PATCH', `/api/master/projects/${p.id}`, { name: '改名' }), 200);
    await expectStatus(send(base, admin, 'PATCH', `/api/master/projects/${p.id}`, { extra: { capacity: '12.5' } }), 400, /阶段不能为空/);
    const design = (await json(get(base, admin, '/api/master/dict-items?dictType=project_stage'))).items.find((i: { itemValue: string }) => i.itemValue === 'design');
    await expectStatus(send(base, admin, 'PATCH', `/api/master/dict-items/${design.id}`, { expectedVersion: design.version, status: 'inactive' }), 200);
    const kept = await expectStatus(send(base, admin, 'PATCH', `/api/master/projects/${p.id}`, { extra: { stage: 'design', capacity: '12.5' } }), 200);
    expect(kept.extra).toEqual({ stage: 'design', capacity: '12.5' });
    await expectStatus(post(base, admin, '/api/master/projects', { ...P, code: 'CF-002', extra: { stage: 'design' } }), 400, /不是有效选项/);

    // 供应商必填;停用字段后不再校验
    await expectStatus(post(base, admin, '/api/master/suppliers', { name: '甲公司' }), 400, /联系人不能为空/);
    const contact = (await json(get(base, admin, `${F}?domain=supplier`))).items[0];
    await expectStatus(send(base, admin, 'PATCH', `${F}/${contact.id}`, { expectedVersion: contact.version + 1, status: 'inactive' }), 409);
    await expectStatus(send(base, admin, 'PATCH', `${F}/${contact.id}`, { expectedVersion: contact.version, status: 'inactive' }), 200);
    await expectStatus(post(base, admin, '/api/master/suppliers', { name: '甲公司' }), 201);
    expect(() => db.prepare("UPDATE sys_custom_field SET field_type = 'text' WHERE id = ?").run(stage.id)).toThrow(/不可修改/);
    expect(() => db.prepare('DELETE FROM sys_custom_field').run()).toThrow(/只能停用/);

    // 表单用的有效定义对主数据读者开放;设置管理需 settings 权限
    const maint = createScopedUser(db, { username: 'cf-maint', roleCodes: ['data_maintainer'], allOrgs: true }).session;
    const forForm = await json(get(base, maint, '/api/master/custom-fields?domain=supplier'));
    expect(forForm.items).toEqual([]);
    expect((await json(get(base, maint, '/api/master/custom-fields?domain=project'))).items.map((f: { fieldCode: string }) => f.fieldCode)).toEqual(['stage', 'capacity', 'approved_on']);
    expect((await post(base, maint, F, { domain: 'project', fieldCode: 'y1', fieldName: 'y', fieldType: 'text' })).status).toBe(403);
    expect((await get(base, maint, '/api/master/custom-fields?domain=bad')).status).toBe(400);
  });

  it('导入字段模板:表头别名参与 EAS 与计划执行解析;与内置别名冲突拒绝', async () => {
    const { base, db, admin } = await boot('newfc-t7-alias-');
    const catalog = await json(get(base, admin, '/api/settings/import-field-targets'));
    expect(catalog.items.map((c: { dataType: string }) => c.dataType)).toEqual(['eas_voucher', 'eas_balance', 'eas_auxiliary', 'plan_investment', 'plan_purchase', 'plan_maintenance']);
    expect(catalog.items[0].fields.find((f: { key: string }) => f.key === 'projectCode')).toMatchObject({ label: '项目编码', required: false, builtinAliases: ['项目编码'] });

    const A = '/api/settings/import-field-aliases';
    await expectStatus(post(base, admin, A, { dataType: 'eas_voucher', targetField: 'projectCode', sourceAlias: '项目 编码' }), 409, /内置表头/);
    await expectStatus(post(base, admin, A, { dataType: 'eas_voucher', targetField: 'nope', sourceAlias: 'x' }), 400, /没有目标字段/);
    const alias = await expectStatus(post(base, admin, A, { dataType: 'eas_voucher', targetField: 'projectCode', sourceAlias: ' 工程 编码 ', note: '二级单位导出' }), 201);
    expect(alias).toMatchObject({ sourceAlias: '工程编码', targetLabel: '项目编码', status: 'active' });
    await expectStatus(post(base, admin, A, { dataType: 'eas_voucher', targetField: 'projectName', sourceAlias: '工程编码' }), 409, /已登记/);
    await expectStatus(post(base, admin, A, { dataType: 'plan_investment', targetField: 'annual_plan', sourceAlias: '今年计划(万元)' }), 201);

    // EAS:表头“项目编码”改为“工程编码”仍识别到项目编码列
    org.createOrg(db, { parentId: null, code: 'LS', name: '澧水公司' });
    const csv = easSample('eas_voucher.csv').toString('utf8').replace(',项目编码,', ',工程编码,');
    const res = await upload(base, admin, '/api/eas/import', Buffer.from(csv, 'utf8'), 'eas_voucher.csv', { dataType: 'voucher' });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
    expect((db.prepare("SELECT COUNT(*) AS c FROM eas_voucher_line WHERE project_code = 'LS-2026-004'").get() as { c: number }).c).toBe(2);

    // 停用后不再参与识别
    await expectStatus(send(base, admin, 'PATCH', `${A}/${alias.id}`, { expectedVersion: alias.version, status: 'inactive' }), 200);
    const again = await upload(base, admin, '/api/eas/import', Buffer.from(csv.replace('记-0001', '记-9001'), 'utf8'), 'eas_voucher2.csv', { dataType: 'voucher' });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(() => db.prepare("UPDATE sys_import_field_alias SET source_alias = 'x'").run()).toThrow(/不可修改/);

    // 计划执行解析器:额外别名(按表头规整后)参与表头定位与字段识别
    const sheet = { name: '固定资产投资计划', hidden: false, rows: [
      { rowNo: 1, cells: ['序号', '项目编码', '项目名称', '承办单位', '今年计划(万元)'] },
      { rowNo: 2, cells: ['1', 'P-01', '水库加固', '澧水公司', '12.5'] },
    ] };
    expect(parsePlanWorkbook([sheet], 2026).errors[0].message).toMatch(/表头/);
    const parsed = parsePlanWorkbook([sheet], 2026, { investment: { annual_plan: ['今年计划'] } });
    expect(parsed.errors).toEqual([]);
    expect(parsed.sheets[0].items[0].facts.find((f) => f.fieldKey === 'annual_plan')?.amount).toBe(125_000_00n);
    expect((await json(get(base, admin, `${A}?dataType=plan_investment`))).items[0].sourceAlias).toBe('今年计划');
  });

  it('AI 提示补充:按任务保存/清空、带期望版本;prompt 版本带哈希,补充附在硬约束之后', async () => {
    const { base, db, admin } = await boot('newfc-t7-prompt-');
    const S = '/api/settings/ai-prompt-supplements';
    const list = await json(get(base, admin, S));
    expect(list.items.map((i: { taskKey: string }) => i.taskKey)).toEqual(['reportRewrite', 'qualityAdvice', 'trendNarrative', 'checkpointSummary', 'riskExplain', 'forecastInsight', 'feasibilityReport']);
    expect(list.items[4]).toMatchObject({ basePromptVersion: 'risk-explain.v1', effectivePromptVersion: 'risk-explain.v1', content: '', version: 0, updatedBy: null });

    const saved = await expectStatus(send(base, admin, 'PUT', `${S}/riskExplain`, { content: '  整改建议请按“责任部门—完成时限”组织。 ', expectedVersion: 0 }), 200);
    expect(saved).toMatchObject({ content: '整改建议请按“责任部门—完成时限”组织。', version: 1, updatedBy: expect.any(String) });
    expect(saved.effectivePromptVersion).toMatch(/^risk-explain\.v1\+s\.[0-9a-f]{8}$/);
    await expectStatus(send(base, admin, 'PUT', `${S}/riskExplain`, { content: 'x', expectedVersion: 0 }), 409);
    await expectStatus(send(base, admin, 'PUT', `${S}/nope`, { content: 'x', expectedVersion: 0 }), 404);
    await expectStatus(send(base, admin, 'PUT', `${S}/riskExplain`, { content: 'x'.repeat(1001), expectedVersion: 1 }), 400);
    const viewer = createScopedUser(db, { username: 'ps-viewer', roleCodes: ['viewer'], allOrgs: true }).session;
    expect((await send(base, viewer, 'PUT', `${S}/riskExplain`, { content: 'x', expectedVersion: 1 })).status).toBe(403);

    // 改写管道:系统消息 = 硬约束 + 任务 + 补充块;返回版本带哈希
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    const spy = vi.fn(async (_url: string, _init: { body: string }) => ({ ok: true, json: async () => ({ choices: [{ message: { content: '风险 R-01 共 3 条' } }] }) }));
    vi.stubGlobal('fetch', spy);
    const r = await rewriteTemplateNarrative({ enabled: true, promptVersion: 'risk-explain.v1', task: '任务说明', template: '风险 R-01 共 3 条', supplement: saved.content });
    expect(r).toMatchObject({ source: 'model', promptVersion: saved.effectivePromptVersion });
    const sys = JSON.parse(spy.mock.calls[0][1].body).messages[0].content as string;
    expect(sys.indexOf('当前任务：任务说明')).toBeLessThan(sys.indexOf('## 业务补充说明'));
    expect(sys).toContain('不得违背以上任何约束');
    expect(sys.endsWith(saved.content)).toBe(true);

    vi.unstubAllGlobals(); // 之后的接口调用走真实 fetch
    const cleared = await expectStatus(send(base, admin, 'PUT', `${S}/riskExplain`, { content: '', expectedVersion: 1 }), 200);
    expect(cleared).toMatchObject({ content: '', version: 2, effectivePromptVersion: 'risk-explain.v1' });
    const logs = db.prepare("SELECT action, detail_json FROM operation_log WHERE action LIKE 'settings.prompt_supplement.%' ORDER BY id").all() as { action: string; detail_json: string }[];
    expect(logs.map((l) => l.action)).toEqual(['settings.prompt_supplement.save', 'settings.prompt_supplement.clear']);
    expect(logs[0].detail_json).not.toContain('责任部门'); // 审计只记长度与哈希
  });
});
