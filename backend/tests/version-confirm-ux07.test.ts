import { describe, it, expect } from 'vitest';
import { testDb, buildFixture, standardBudgetVersion, budget } from './helpers';
import { AppError } from '../src/core/errors';
import type { DB } from '../src/db/connection';
import type { Fixture } from './helpers';

/**
 * UX-07 后端:定稿与设为当前的条件校验字段。
 * - POST /api/versions/:id/lock 增加 expectedRevision:事务内复核修订号与质量检查;
 * - POST /api/versions/:id/set-current 增加 expectedCurrentVersionId(允许 null):事务内复核原采用版本;
 * - 两个字段缺省时保持旧调用兼容;不匹配返回 409(AppError status=409, code=CONFLICT)。
 */

function expectConflict(fn: () => unknown, pattern: RegExp): AppError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.status).toBe(409);
    expect(appErr.code).toBe('CONFLICT');
    expect(appErr.message).toMatch(pattern);
    return appErr;
  }
  throw new Error('应抛出 409 冲突,实际未抛出');
}

function lockedVersion(db: DB, fx: Fixture, name: string, year = 2026) {
  const v = standardBudgetVersion(fx, year, name);
  budget.lockVersion(db, v.id);
  return v;
}

describe('UX-07 定稿 expectedRevision(POST /api/versions/:id/lock)', () => {
  it('expectedRevision 匹配:定稿成功', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const revision = budget.getVersion(db, v.id).revision;
    const locked = budget.lockVersion(db, v.id, { expectedRevision: revision });
    expect(locked.status).toBe('locked');
    expect(locked.locked_at).toBeTruthy();
  });

  it('expectedRevision 不匹配:409 且不留下部分状态', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const staleRevision = budget.getVersion(db, v.id).revision;
    // 确认期间草稿被再次保存,revision 前进
    budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '200.00' }]);
    const err = expectConflict(
      () => budget.lockVersion(db, v.id, { expectedRevision: staleRevision }),
      /已被修改.*刷新后/,
    );
    expect(err.message).toContain(`当前修订 ${staleRevision + 1}`);
    // 事务整体回滚:版本仍是草稿,未生成定稿记录点
    const after = budget.getVersion(db, v.id);
    expect(after.status).toBe('draft');
    expect(after.locked_at).toBeNull();
    const checkpoints = db.prepare('SELECT COUNT(*) AS c FROM budget_compilation_checkpoint WHERE version_id = ?').get(v.id) as { c: number };
    expect(checkpoints.c).toBe(0);
    // 刷新后携带新 revision 可以定稿
    budget.lockVersion(db, v.id, { expectedRevision: after.revision });
    expect(budget.getVersion(db, v.id).status).toBe('locked');
  });

  it('expectedRevision 缺省:旧调用兼容,直接定稿', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    expect(budget.lockVersion(db, v.id).status).toBe('locked');
    expect(budget.lockVersion(db, budget.createVersion(db, { year: 2026, name: 'V2' }).id, {}).status).toBe('locked');
  });

  it('expectedRevision 匹配但存在阻断项:质量检查仍在事务内复核并拒绝', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'bad' });
    // 绕过服务层写入非叶子组织明细,制造阻断项
    db.prepare('INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(v.id, fx.orgIds.east, fx.accIds.incomeMain, 1000, new Date().toISOString());
    const revision = budget.getVersion(db, v.id).revision;
    expect(() => budget.lockVersion(db, v.id, { expectedRevision: revision })).toThrow(/定稿前检查未通过/);
    expect(budget.getVersion(db, v.id).status).toBe('draft');
  });

  it('expectedRevision 非法值:400 参数校验', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    for (const bad of [-1, 1.5, NaN]) {
      try {
        budget.lockVersion(db, v.id, { expectedRevision: bad });
        throw new Error('应抛出参数错误');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).status).toBe(400);
        expect((err as AppError).message).toMatch(/expectedRevision/);
      }
    }
    expect(budget.getVersion(db, v.id).status).toBe('draft');
  });
});

describe('UX-07 设为当前 expectedCurrentVersionId(POST /api/versions/:id/set-current)', () => {
  it('expectedCurrentVersionId=null 且当前确无采用版本:设置成功', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = lockedVersion(db, fx, 'V1');
    const current = budget.setCurrentVersion(db, v.id, { expectedCurrentVersionId: null });
    expect(current.is_current).toBe(1);
  });

  it('expectedCurrentVersionId 匹配原采用版本:替换成功', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v1 = lockedVersion(db, fx, 'V1');
    budget.setCurrentVersion(db, v1.id);
    const v2 = lockedVersion(db, fx, 'V2');
    const current = budget.setCurrentVersion(db, v2.id, { expectedCurrentVersionId: v1.id });
    expect(current.is_current).toBe(1);
    expect(budget.getVersion(db, v1.id).is_current).toBe(0);
  });

  it('expectedCurrentVersionId 不匹配:409 且不留下部分状态', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v1 = lockedVersion(db, fx, 'V1');
    budget.setCurrentVersion(db, v1.id);
    const v2 = lockedVersion(db, fx, 'V2');
    // 情形一:以为没有采用版本(null),实际已有 v1
    expectConflict(
      () => budget.setCurrentVersion(db, v2.id, { expectedCurrentVersionId: null }),
      /原采用版本已变化.*刷新后/,
    );
    // 情形二:以为原采用是 v2 自己,实际是 v1
    expectConflict(
      () => budget.setCurrentVersion(db, v2.id, { expectedCurrentVersionId: v2.id }),
      /原采用版本已变化/,
    );
    // 事务整体回滚:采用状态完全未动
    expect(budget.getVersion(db, v1.id).is_current).toBe(1);
    expect(budget.getVersion(db, v2.id).is_current).toBe(0);
  });

  it('expectedCurrentVersionId 缺省:旧调用兼容,直接设置', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v1 = lockedVersion(db, fx, 'V1');
    expect(budget.setCurrentVersion(db, v1.id).is_current).toBe(1);
    const v2 = lockedVersion(db, fx, 'V2');
    expect(budget.setCurrentVersion(db, v2.id, {}).is_current).toBe(1);
    expect(budget.getVersion(db, v1.id).is_current).toBe(0);
  });

  it('预算与预测各自管理:另一用途的采用版本不影响 null 校验', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const forecast = standardBudgetVersion(fx, 2026, '预测F1');
    db.prepare('UPDATE budget_version SET kind = ? WHERE id = ?').run('forecast', forecast.id);
    budget.lockVersion(db, forecast.id);
    budget.setCurrentVersion(db, forecast.id, { expectedCurrentVersionId: null });
    expect(budget.getVersion(db, forecast.id).is_current).toBe(1);
    // 预算用途仍无采用版本,null 复核通过
    const v = lockedVersion(db, fx, '预算V1');
    expect(budget.setCurrentVersion(db, v.id, { expectedCurrentVersionId: null }).is_current).toBe(1);
    // 两种用途各自保留一个当前版本
    expect(budget.getVersion(db, forecast.id).is_current).toBe(1);
    expect(budget.getVersion(db, v.id).is_current).toBe(1);
  });

  it('expectedCurrentVersionId 非法值:400 参数校验', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = lockedVersion(db, fx, 'V1');
    for (const bad of [0, -3, 1.5]) {
      try {
        budget.setCurrentVersion(db, v.id, { expectedCurrentVersionId: bad });
        throw new Error('应抛出参数错误');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        expect((err as AppError).status).toBe(400);
        expect((err as AppError).message).toMatch(/expectedCurrentVersionId/);
      }
    }
    expect(budget.getVersion(db, v.id).is_current).toBe(0);
  });
});
