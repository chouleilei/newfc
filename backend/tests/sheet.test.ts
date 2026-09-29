import { describe, it, expect } from 'vitest';
import { testDb, buildFixture, account } from './helpers';
import { listSheets, createSheet, updateSheet, deleteSheet } from '../src/modules/sheet/sheet.service';
import { applyMigrations } from '../src/db/migrations';

describe('预设表注册(模板表格)', () => {
  it('迁移种子包含 6 张模板表且编码解析为数组', () => {
    const db = testDb();
    const sheets = listSheets(db);
    expect(sheets.length).toBe(6);
    const master = sheets.find((s) => s.code === 'master');
    expect(master?.rootCodes).toContain('I1');
    expect(master?.collapsedCodes).toEqual(['I11', 'I12', 'C12', 'E2']);
    /* V5:根科目顺序对齐模板(期间费用居中、所得税最后,配合计算行锚点) */
    expect(master?.rootCodes).toEqual(['I1', 'I2', 'I3', 'C1', 'C2', 'C3', 'E1', 'E2', 'E3', 'C4', 'C5', 'C6']);
    const admin = sheets.find((s) => s.code === 'admin_expense');
    expect(admin?.name).toBe('管理类费用表');
    const labor = sheets.find((s) => s.code === 'labor_cost');
    expect(labor?.rootCodes).toEqual(['E201']);
  });

  it('建表/改表/删表与科目编码校验', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 引用不存在的科目编码被拒
    expect(() => createSheet(db, { code: 'S1', name: '测试表', rootCodes: ['NOPE'] })).toThrow(/不存在/);
    // 根为空被拒
    expect(() => createSheet(db, { code: 'S1', name: '测试表', rootCodes: [] })).toThrow(/至少/);
    const s = createSheet(db, {
      code: 'S1', name: '销售口径表',
      rootCodes: ['I'],
      collapsedCodes: ['C01'], sortOrder: 9,
    });
    expect(s.rootCodes).toEqual(['I']);
    expect(s.collapsedCodes).toEqual(['C01']);
    // 编码唯一
    expect(() => createSheet(db, { code: 'S1', name: '重复', rootCodes: ['I'] })).toThrow(/已存在/);
    // 更新名称与根
    const u = updateSheet(db, s.id, { name: '销售口径表2', rootCodes: ['I', 'C'], collapsedCodes: [] });
    expect(u.name).toBe('销售口径表2');
    expect(u.rootCodes).toEqual(['I', 'C']);
    expect(u.collapsedCodes).toEqual([]);
    // 删除
    deleteSheet(db, s.id);
    expect(listSheets(db).some((x) => x.id === s.id)).toBe(false);
    void account;
  });

  it('模板表数量在新增表后正确增长(自助扩展路径)', () => {
    const db = testDb();
    buildFixture(db);
    const before = listSheets(db).length;
    createSheet(db, { code: 'EXTRA', name: '新增表', rootCodes: ['I', 'C'] });
    expect(listSheets(db).length).toBe(before + 1);
  });
});

describe('迁移幂等', () => {
  it('重复应用无副作用', () => {
    const db = testDb();
    applyMigrations(db);
    applyMigrations(db);
    expect(listSheets(db).length).toBe(6);
  });
});
