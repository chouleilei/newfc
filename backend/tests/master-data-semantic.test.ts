/**
 * 主数据「语义命名相似」AI 薄层验收(AI 功能增强计划 §四.阶段三):
 * - 模型未配置/开关关闭 -> semanticAvailable=false,pairs 为空,体检报告完整可用;
 * - 模型输出经白名单校验:编码必须存在于清单、自指/重复对剔除、数量封顶;
 * - 字面等价对(归一化后同名)被排除(确定性侧职责);
 * - 模型故障/非法 JSON 回退,不产生任何写入;
 * - 结果 source 恒为 'model',只读建议。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDb, buildFixture } from './helpers';
import { masterDataSemanticNames } from '../src/assistant/master-data-semantic';
import { masterDataHealthReport } from '../src/modules/check/master-data-health';
import { PROMPT_VERSION } from '../src/assistant/prompts';

function stubModel(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }] }),
  })));
}

describe('主数据语义命名相似(AI 薄层)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AI_BASE_URL = '';
    process.env.AI_API_KEY = '';
    delete process.env.BUDGET_MASTER_DATA_AI;
  });

  it('模型未配置时不可用,pairs 为空且报告完整可用', async () => {
    const db = testDb();
    buildFixture(db);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await masterDataSemanticNames(db);
    expect(result.semanticAvailable).toBe(false);
    expect(result.pairs).toEqual([]);
    expect(result.note).toContain('未配置模型');
    expect(fetchSpy).not.toHaveBeenCalled();
    // 体检报告不受影响
    expect(() => masterDataHealthReport(db)).not.toThrow();
    db.close();
  });

  it('BUDGET_MASTER_DATA_AI=0 独立关闭', async () => {
    const db = testDb();
    buildFixture(db);
    process.env.BUDGET_MASTER_DATA_AI = '0';
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await masterDataSemanticNames(db);
    expect(result.semanticAvailable).toBe(false);
    expect(result.note).toContain('BUDGET_MASTER_DATA_AI');
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });

  it('白名单校验:只保留清单内编码的合法对,剔除编造编码/自指/重复', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    stubModel({
      pairs: [
        { kind: 'org', a: 'EAST', b: 'WEST', reason: '都是大区级单位' },
        { kind: 'org', a: 'EAST', b: 'WEST', reason: '重复对' },
        { kind: 'org', a: 'EAST', b: 'EAST', reason: '自指' },
        { kind: 'org', a: 'EAST', b: 'NOPE', reason: '编造编码' },
        { kind: 'account', a: 'E01', b: 'E02', reason: '都是期间费用' },
        { kind: 'metric', a: 'GROSS', b: 'OP', reason: '非法 kind' },
      ],
    });
    const result = await masterDataSemanticNames(db);
    expect(result.semanticAvailable).toBe(true);
    expect(result.source).toBe('model');
    expect(result.promptVersion).toBe(PROMPT_VERSION.masterDataSemantic);
    expect(result.pairs).toHaveLength(2);
    const orgPair = result.pairs.find((pair) => pair.kind === 'org')!;
    expect([orgPair.aCode, orgPair.bCode].sort()).toEqual(['EAST', 'WEST']);
    expect(orgPair.aName + orgPair.bName).toContain('大区');
    expect(result.pairs.find((pair) => pair.kind === 'account')!.reason).toBe('都是期间费用');
    void fx;
    db.close();
  });

  it('字面等价(归一化同名)对被排除:确定性侧职责,不进语义建议', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO org (parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (?, 'SH-02', '上海公司', 0, 'active', ?, ?)")
      .run(fx.orgIds.west, now, now);
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    stubModel({ pairs: [{ kind: 'org', a: 'SH', b: 'SH-02', reason: '同名' }] });
    const result = await masterDataSemanticNames(db);
    expect(result.semanticAvailable).toBe(true);
    expect(result.pairs).toEqual([]);
    expect(result.note).toContain('未发现');
    db.close();
  });

  it('模型故障与非法 JSON 均回退,不影响体检报告', async () => {
    const db = testDb();
    buildFixture(db);
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const failed = await masterDataSemanticNames(db);
    expect(failed.semanticAvailable).toBe(false);
    expect(failed.note).toContain('模型调用失败');

    stubModel('这不是 JSON');
    const invalid = await masterDataSemanticNames(db);
    expect(invalid.semanticAvailable).toBe(false);
    expect(invalid.note).toContain('JSON');

    expect(() => masterDataHealthReport(db)).not.toThrow();
    db.close();
  });

  it('零写入:不产生任何业务表变更', async () => {
    const db = testDb();
    buildFixture(db);
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    stubModel({ pairs: [{ kind: 'org', a: 'EAST', b: 'WEST', reason: 'x' }] });
    const before = {
      org: (db.prepare('SELECT COUNT(*) c FROM org').get() as { c: number }).c,
      account: (db.prepare('SELECT COUNT(*) c FROM account').get() as { c: number }).c,
      log: (db.prepare('SELECT COUNT(*) c FROM operation_log').get() as { c: number }).c,
    };
    await masterDataSemanticNames(db);
    expect((db.prepare('SELECT COUNT(*) c FROM org').get() as { c: number }).c).toBe(before.org);
    expect((db.prepare('SELECT COUNT(*) c FROM account').get() as { c: number }).c).toBe(before.account);
    expect((db.prepare('SELECT COUNT(*) c FROM operation_log').get() as { c: number }).c).toBe(before.log);
    db.close();
  });
});
