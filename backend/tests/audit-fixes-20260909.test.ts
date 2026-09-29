/**
 * 2026-09-09 全仓排查报告修复的回归测试(编号对应 docs/archive/排查报告-2026-09-09.md)。
 */
import { describe, expect, it } from 'vitest';
import { testDb, buildFixture } from './helpers';
import {
  wanStringToCents, centsToWanText, AmountFormatError, displayToSignedCents,
} from '../src/core/money';
import { isDescendantOf, TreeCycleError, type TreeNodeRow } from '../src/core/tree';
import { allocateFixedRatio } from '../src/modules/finance-import/mapping/allocator';
import * as org from '../src/modules/org/org.service';
import * as account from '../src/modules/account/account.service';
import * as actual from '../src/modules/actual/actual.service';
import { createSourceProfile } from '../src/modules/finance-import/source-profile.service';
import { createMappingVersion, replaceOrgMappings, replaceAccountMappings } from '../src/modules/finance-import/mapping/mapping.service';

describe('L-3 万元字符串千分位必须规范分组', () => {
  it('规范千分位与无逗号照常解析', () => {
    expect(wanStringToCents('1,234.5')).toBe(1_234_500_000);
    expect(wanStringToCents('1234.5')).toBe(1_234_500_000);
    expect(wanStringToCents('-1,234,567.89')).toBe(-1_234_567_890_000);
  });
  it('错位分组拒绝入账而非静默按错误数值解析', () => {
    expect(() => wanStringToCents('1,2,3')).toThrow(AmountFormatError);
    expect(() => wanStringToCents('12,34')).toThrow(AmountFormatError);
    expect(() => wanStringToCents('1234,567')).toThrow(AmountFormatError);
  });
});

describe('L-5 centsToWanText 对非法输入抛错(与同模块其他换算一致)', () => {
  it('NaN/Infinity/非安全整数不再粉饰为 0.00', () => {
    expect(() => centsToWanText(Number.NaN)).toThrow(/非法金额/);
    expect(() => centsToWanText(Number.POSITIVE_INFINITY)).toThrow(/非法金额/);
    expect(centsToWanText(145_000)).toBe('0.15');
  });
});

describe('L-7 金额/数量格式错误是 400 客户端错误而非 500', () => {
  it('AmountFormatError 继承 AppError 且 status=400', () => {
    try {
      displayToSignedCents('abc', 'income');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AmountFormatError);
      expect((err as { status?: number }).status).toBe(400);
      expect((err as { code?: string }).code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('L-2 isDescendantOf 环路守卫', () => {
  it('存量数据含环时抛 TreeCycleError 而非死循环', () => {
    const rows: TreeNodeRow[] = [
      { id: 1, parent_id: 2, code: 'A', name: 'A', sort_order: 0, status: 'active' },
      { id: 2, parent_id: 1, code: 'B', name: 'B', sort_order: 0, status: 'active' },
    ];
    expect(() => isDescendantOf(rows, 1, 3)).toThrow(TreeCycleError);
  });
});

describe('L-8 实际数年度显式范围校验', () => {
  it('100-1899 年由 400 拦截,不再落到 CHECK 约束成 500', () => {
    const db = testDb();
    buildFixture(db);
    try {
      actual.saveActual(db, { year: 100, snapshotDate: '0100-01-01', entries: [], source: 'manual', mode: 'upsert' });
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
      expect((err as Error).message).toMatch(/1900-9999/);
    }
  });
});

describe('L-12 固定比例分配大金额不失真', () => {
  it('分子超过 2^53 时仍逐分守恒且余数分配正确', () => {
    // 9007 万元(分)× 满权重即越过 Number 安全整数;BigInt 路径必须精确
    const total = 9_007_199_254_740;
    const parts = allocateFixedRatio(total, [
      { targetCode: 'A', weight: 333_333 },
      { targetCode: 'B', weight: 333_333 },
      { targetCode: 'C', weight: 333_334 },
    ]);
    expect(parts.reduce((s, v) => s + v, 0)).toBe(total);
    // 同余数按目标编码稳定排序:A/B 同余数,A 先得尾差
    const even = allocateFixedRatio(10_000_000_001, [
      { targetCode: 'B', weight: 500_000 },
      { targetCode: 'A', weight: 500_000 },
    ]);
    expect(even).toEqual([5_000_000_000, 5_000_000_001]);
    expect(even.reduce((s, v) => s + v, 0)).toBe(10_000_000_001);
  });
});

describe('M-1 删除保护覆盖财务映射引用', () => {
  it('被非停用映射版本引用的组织/科目不能物理删除', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const profile = createSourceProfile(db, {
      code: 'P1', name: '数据源',
      config: { ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I'], amountUnit: 'yuan' },
    });
    const mapping = createMappingVersion(db, { sourceProfileId: profile.id, name: 'v1' });
    replaceOrgMappings(db, mapping.id, [{ sourceBookCode: 'B', targetOrgId: fx.orgIds.shanghai }]);
    replaceAccountMappings(db, mapping.id, [{ sourceAccountCode: '4001', targetAccountId: fx.accIds.incomeMain, amountRule: 'credit_minus_debit' }]);
    expect(() => org.deleteOrg(db, fx.orgIds.shanghai)).toThrow(/财务映射/);
    expect(() => account.deleteAccount(db, fx.accIds.incomeMain)).toThrow(/财务映射/);
  });

  it('retired 映射版本不再阻塞删除', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const profile = createSourceProfile(db, {
      code: 'P1', name: '数据源',
      config: { ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I'], amountUnit: 'yuan' },
    });
    const mapping = createMappingVersion(db, { sourceProfileId: profile.id, name: 'v1' });
    replaceOrgMappings(db, mapping.id, [{ sourceBookCode: 'B', targetOrgId: fx.orgIds.nanjing }]);
    db.prepare("UPDATE finance_mapping_version SET status='retired' WHERE id=?").run(mapping.id);
    expect(() => org.deleteOrg(db, fx.orgIds.nanjing)).not.toThrow();
  });
});

describe('L-13 数据源拥有范围重叠在保存时即拦截', () => {
  it('第二个 active 数据源声明重叠范围时 409', () => {
    const db = testDb();
    buildFixture(db);
    createSourceProfile(db, { code: 'P1', name: '数据源一', config: { ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I'], amountUnit: 'yuan' } });
    expect(() => createSourceProfile(db, { code: 'P2', name: '数据源二', config: { ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I'], amountUnit: 'yuan' } })).toThrow(/拥有范围.*重叠/);
    // 停用状态不拦截(不参与转换)
    expect(() => createSourceProfile(db, { code: 'P3', name: '数据源三', status: 'inactive', config: { ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I'], amountUnit: 'yuan' } })).not.toThrow();
  });
});
