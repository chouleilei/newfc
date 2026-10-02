import { z } from 'zod';
import { validateInput, positiveId, sortOrder, nodeStatus } from '../../core/input';
import type { DB } from '../../db/connection';
import type { TreeNodeDto, TreeNodeRow } from '../../core/tree';
import { buildTree, computeLeafIds, isDescendantOf } from '../../core/tree';
import { Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import type { AccountType } from '../../core/money';

export const createAccountSchema = z.object({ parentId: positiveId.nullable(), code: z.string().min(1).max(128), name: z.string().min(1).max(255), type: z.enum(['income', 'cost', 'expense', 'quantity']), unit: z.string().max(80).optional(), quantityAgg: z.enum(['sum', 'none']).optional(), sortOrder: sortOrder.optional() }).strict();
export const updateAccountSchema = createAccountSchema.pick({ name: true, sortOrder: true, unit: true, quantityAgg: true }).partial().extend({ budgetRequired: z.boolean().optional(), basisRequired: z.boolean().optional() }).strict();

export const moveInputSchema = z.object({ parentId: positiveId.nullable() }).strict();
export const statusInputSchema = z.object({ status: nodeStatus }).strict();


function selectSql(db: DB): string {
  const columns = new Set((db.pragma('table_info(account)') as { name: string }[]).map((row) => row.name));
  const quality = columns.has('budget_required')
    ? 'budget_required, basis_required,'
    : '0 AS budget_required, 0 AS basis_required,';
  return `SELECT id, parent_id, code, name, type, unit, quantity_agg, ${quality} sort_order, status, created_at, updated_at FROM account`;
}

export interface AccountRow extends TreeNodeRow {
  type: AccountType;
  unit: string;
  quantity_agg: 'sum' | 'none';
  budget_required: 0 | 1;
  basis_required: 0 | 1;
  created_at: string;
  updated_at: string;
}

export function listAccountRows(db: DB): AccountRow[] {
  return db.prepare(`${selectSql(db)} ORDER BY sort_order, id`).all() as AccountRow[];
}

export function getAccountTree(db: DB): { tree: TreeNodeDto[]; rows: AccountRow[]; leafIds: number[] } {
  const rows = listAccountRows(db);
  return { tree: buildTree(rows), rows, leafIds: [...computeLeafIds(rows)] };
}

export function getAccount(db: DB, id: number): AccountRow {
  const row = db.prepare(`${selectSql(db)} WHERE id = ?`).get(id) as AccountRow | undefined;
  if (!row) throw Errors.notFound('科目');
  return row;
}

export function accountReferenced(db: DB, id: number): boolean {
  const inBudget = db.prepare('SELECT 1 FROM budget_entry WHERE account_id = ? LIMIT 1').get(id);
  const inActual = db.prepare('SELECT 1 FROM actual_current WHERE account_id = ? LIMIT 1').get(id);
  const inSnapshot = db.prepare('SELECT 1 FROM actual_snapshot_entry WHERE account_id = ? LIMIT 1').get(id);
  const inMetric = db.prepare('SELECT 1 FROM report_metric_term WHERE source_type = ? AND source_account_id = ? LIMIT 1').get('account', id);
  // 财务映射目标科目:target_account_id 建表无外键,删除后非停用映射成悬空引用
  // (低版本库无此表——迁移中途状态/旧备份恢复场景按无引用处理)
  const inMapping = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_account_mapping'").get()
    ? db.prepare(
      `SELECT 1 FROM finance_account_mapping m JOIN finance_mapping_version v ON v.id = m.mapping_version_id
       WHERE m.target_account_id = ? AND v.status != 'retired' LIMIT 1`
    ).get(id)
    : undefined;
  return Boolean(inBudget || inActual || inSnapshot || inMetric || inMapping);
}

/** 汇总格备注引用(仅物理删除保护用;不阻塞加子级/移动——备注在节点变为非叶子后依然合法) */
function accountNoteReferenced(db: DB, id: number): boolean {
  const inBudgetNote = db.prepare('SELECT 1 FROM budget_cell_note WHERE account_id = ? LIMIT 1').get(id);
  const inActualNote = db.prepare('SELECT 1 FROM actual_cell_note WHERE account_id = ? LIMIT 1').get(id);
  return Boolean(inBudgetNote || inActualNote);
}

function assertTypeConsistent(rows: AccountRow[], parentId: number | null, type: AccountType): void {
  if (parentId == null) return;
  const parent = rows.find((r) => r.id === parentId);
  if (!parent) throw Errors.notFound('上级科目');
  if (parent.type !== type) {
    throw Errors.validation(`科目类型不一致:父科目 ${parent.code} 为 ${parent.type},子科目必须同为 ${parent.type}`);
  }
}

export function validateCreateAccount(
  db: DB,
  input: { parentId: number | null; code: string; name: string; type: AccountType; unit?: string; quantityAgg?: 'sum' | 'none'; sortOrder?: number }
) {
  validateInput(createAccountSchema, input);
  if (!input.code?.trim()) throw Errors.validation('科目编码不能为空');
  if (!input.name?.trim()) throw Errors.validation('科目名称不能为空');
  if (!['income', 'cost', 'expense', 'quantity'].includes(input.type)) throw Errors.validation('科目类型必须是 income/cost/expense/quantity');
  const isQuantity = input.type === 'quantity';
  const unit = isQuantity ? (input.unit ?? '').trim() : '';
  const quantityAgg = isQuantity ? (input.quantityAgg ?? 'sum') : 'sum';
  if (isQuantity && !unit) throw Errors.validation('数量型科目必须填写计量单位(如 万度 / 元/度 / % / 人)');
  if (!['sum', 'none'].includes(quantityAgg)) throw Errors.validation('数量汇总方式必须是 sum(可加总)或 none(不汇总)');
  const rows = listAccountRows(db);
  if (rows.some((r) => r.code === input.code.trim())) {
    throw Errors.conflict(`科目编码 ${input.code.trim()} 已存在`);
  }
  // 存在明细的叶子科目不能直接增加子科目(方案五.2)
  if (input.parentId != null) {
    const parent = rows.find((r) => r.id === input.parentId);
    if (!parent) throw Errors.notFound('上级科目');
    const hasChildren = rows.some((r) => r.parent_id === parent.id);
    if (!hasChildren && accountReferenced(db, parent.id)) {
      throw Errors.conflict(
        `科目 ${parent.code} 已有预算、实际明细或财务映射引用(叶子科目),不能直接增加子科目;请新建科目并停用旧科目`
      );
    }
  }
  assertTypeConsistent(rows, input.parentId, input.type);
  return { unit, quantityAgg };
}

export function createAccount(
  db: DB,
  input: { parentId: number | null; code: string; name: string; type: AccountType; unit?: string; quantityAgg?: 'sum' | 'none'; sortOrder?: number }
): AccountRow {
  const { unit, quantityAgg } = validateCreateAccount(db, input);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    validateCreateAccount(db, input);
    const info = db
      .prepare(
        'INSERT INTO account (parent_id, code, name, type, unit, quantity_agg, sort_order, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(input.parentId, input.code.trim(), input.name.trim(), input.type, unit, quantityAgg, input.sortOrder ?? 0, 'active', now, now);
    const id = Number(info.lastInsertRowid);
    writeLog(db, 'account.create', 'account', id, { code: input.code.trim(), name: input.name.trim(), type: input.type, unit, quantityAgg, parentId: input.parentId });
    return id;
  });
  return getAccount(db, tx());
}

export function validateUpdateAccount(db: DB, id: number, input: { name?: string; sortOrder?: number; unit?: string; quantityAgg?: 'sum' | 'none'; budgetRequired?: boolean; basisRequired?: boolean }) {
  validateInput(updateAccountSchema, input);
  const acc = getAccount(db, id);
  if (input.name !== undefined && !input.name.trim()) throw Errors.validation('科目名称不能为空');
  const isLeaf = !db.prepare('SELECT 1 FROM account WHERE parent_id = ? LIMIT 1').get(id);
  if (!isLeaf && (input.budgetRequired === true || input.basisRequired === true)) {
    throw Errors.validation('只有末级科目可以设置预算必填或测算依据要求');
  }
  if (acc.type !== 'quantity' && (input.unit !== undefined || input.quantityAgg !== undefined)) {
    throw Errors.validation('只有数量型科目可以设置单位与汇总方式');
  }
  let unit = acc.unit;
  let quantityAgg = acc.quantity_agg;
  if (acc.type === 'quantity') {
    if (input.unit !== undefined) {
      unit = input.unit.trim();
      if (!unit) throw Errors.validation('数量型科目必须填写计量单位');
    }
    if (input.quantityAgg !== undefined) {
      if (!['sum', 'none'].includes(input.quantityAgg)) throw Errors.validation('数量汇总方式必须是 sum(可加总)或 none(不汇总)');
      /* 指标可在科目改为 none 之前定义并引用它(validateTerms 只拦定义时)。
         一旦改成 none,该引用会把不可汇总的单价/税率累计成无意义比率——
         在改写处直接拒绝,指向先解除指标引用。 */
      if (input.quantityAgg === 'none' && acc.quantity_agg !== 'none') {
        const referencing = db.prepare(
          `SELECT DISTINCT m.id, m.name FROM report_metric m
           JOIN report_metric_term t ON t.metric_id = m.id
           WHERE t.source_type = 'account' AND t.source_account_id = ?`,
        ).all(id) as { id: number; name: string }[];
        if (referencing.length) {
          throw Errors.validation(`科目仍被指标引用(${referencing.map((r) => r.name).join('、')}),不能改为不可汇总;请先在指标公式中解除引用`);
        }
      }
      quantityAgg = input.quantityAgg;
    }
  }
  return { acc, unit, quantityAgg };
}

export function updateAccount(db: DB, id: number, input: { name?: string; sortOrder?: number; unit?: string; quantityAgg?: 'sum' | 'none'; budgetRequired?: boolean; basisRequired?: boolean }): AccountRow {
  const { acc, unit, quantityAgg } = validateUpdateAccount(db, id, input);
  db.transaction(() => {
    validateUpdateAccount(db, id, input);
    db.prepare('UPDATE account SET name = ?, unit = ?, quantity_agg = ?, budget_required = ?, basis_required = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(
      input.name !== undefined ? input.name.trim() : acc.name,
      unit,
      quantityAgg,
      input.budgetRequired === undefined ? acc.budget_required : input.budgetRequired ? 1 : 0,
      input.basisRequired === undefined ? acc.basis_required : input.basisRequired ? 1 : 0,
      input.sortOrder ?? acc.sort_order,
      new Date().toISOString(),
      id
    );
    writeLog(db, 'account.update', 'account', id, { name: input.name, unit, quantityAgg: input.quantityAgg, budgetRequired: input.budgetRequired, basisRequired: input.basisRequired, sortOrder: input.sortOrder });
  })();
  return getAccount(db, id);
}

/** 移动科目:新父节点类型必须一致,且不能移动到自身后代(方案五.2) */
export function validateMoveAccount(db: DB, id: number, newParentId: number | null) {
  validateInput(moveInputSchema, { parentId: newParentId });
  const acc = getAccount(db, id);
  if (newParentId != null) {
    const target = getAccount(db, newParentId);
    if (target.id === id) throw Errors.validation('目标父节点不能是自身');
    if (isDescendantOf(listAccountRows(db), newParentId, id)) {
      throw Errors.validation('目标父节点不能是自身的后代');
    }
    if (target.type !== acc.type) {
      throw Errors.validation(`科目类型不一致:${acc.code} 为 ${acc.type},目标父科目 ${target.code} 为 ${target.type}`);
    }
    const targetHasChildren = db.prepare('SELECT 1 FROM account WHERE parent_id = ? LIMIT 1').get(target.id);
    if (!targetHasChildren && accountReferenced(db, target.id)) {
      throw Errors.conflict(
        `科目 ${target.code} 已被预算、实际、快照或指标引用，不能通过移动节点将其变为父科目；请先迁移存量数据`,
      );
    }
  }
  return undefined;
}

export function moveAccount(db: DB, id: number, newParentId: number | null): AccountRow {
  validateMoveAccount(db, id, newParentId);
  db.transaction(() => {
    validateMoveAccount(db, id, newParentId);
    db.prepare('UPDATE account SET parent_id = ?, updated_at = ? WHERE id = ?').run(newParentId, new Date().toISOString(), id);
    writeLog(db, 'account.move', 'account', id, { newParentId });
  })();
  return getAccount(db, id);
}

export function validateSetAccountStatus(db: DB, id: number, status: 'active' | 'inactive') {
  validateInput(statusInputSchema, { status });
  if (status !== 'active' && status !== 'inactive') throw Errors.validation('状态必须是 active 或 inactive');
  getAccount(db, id);
  return undefined;
}

export function setAccountStatus(db: DB, id: number, status: 'active' | 'inactive'): AccountRow {
  validateSetAccountStatus(db, id, status);
  const action = status === 'inactive' ? 'account.deactivate' : 'account.activate';
  db.transaction(() => {
    validateSetAccountStatus(db, id, status);
    db.prepare('UPDATE account SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    writeLog(db, action, 'account', id, { status });
  })();
  return getAccount(db, id);
}

export function deleteAccount(db: DB, id: number): void {
  const acc = getAccount(db, id);
  const childCount = db.prepare('SELECT COUNT(*) AS c FROM account WHERE parent_id = ?').get(id) as { c: number };
  if (childCount.c > 0) throw Errors.conflict('存在下级科目,不能删除');
  // 汇总格备注的科目侧可以是叶子(另一侧非叶子),物理删除会留下悬挂批注
  if (accountReferenced(db, id) || accountNoteReferenced(db, id)) {
    throw Errors.conflict('科目已被业务数据或财务映射引用,不能物理删除(可停用)');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM account WHERE id = ?').run(id);
    writeLog(db, 'account.delete', 'account', id, { deleted: true, code: acc.code });
  })();
}

export function checkAccountStructure(db: DB): { ok: boolean; problems: string[] } {
  const rows = listAccountRows(db);
  const problems: string[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    if (r.parent_id != null) {
      const parent = byId.get(r.parent_id);
      if (!parent) problems.push(`科目 ${r.code} 的父节点 ${r.parent_id} 不存在(孤儿节点)`);
      else if (parent.type !== r.type) problems.push(`科目 ${r.code}(${r.type}) 与父科目 ${parent.code}(${parent.type}) 类型不一致`);
    }
  }
  for (const r of rows) {
    const seen = new Set<number>();
    let cur: AccountRow | undefined = r;
    while (cur && cur.parent_id != null) {
      if (seen.has(cur.id)) { problems.push(`科目 ${r.code} 所在链路存在循环`); break; }
      seen.add(cur.id);
      cur = byId.get(cur.parent_id);
    }
  }
  return { ok: problems.length === 0, problems };
}
