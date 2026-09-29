import type { DB } from '../../db/connection';
import { computeLeafIds } from '../../core/tree';
import type { TreeNodeRow } from '../../core/tree';
import { loadSnapshotNodes } from '../tree/snapshot';

/** 数据一致性检查(方案十五.3),可手动触发。 */

export interface CheckResult {
  name: string;
  ok: boolean;
  problems: string[];
}

function rowsToTreeNodes(rows: { id: number; parent_id: number | null; code: string; name: string; type?: string; sort_order: number; status: string }[]): TreeNodeRow[] {
  return rows as TreeNodeRow[];
}

/** 1. 当前实际与最新快照一致性 */
function checkActualVsSnapshot(db: DB): CheckResult {
  const problems: string[] = [];
  const states = db.prepare('SELECT * FROM actual_year_state').all() as { year: number; current_batch_id: number | null }[];
  for (const s of states) {
    if (s.current_batch_id == null) {
      const cnt = (db.prepare('SELECT COUNT(*) AS c FROM actual_current WHERE year = ?').get(s.year) as { c: number }).c;
      if (cnt > 0) problems.push(`${s.year} 年度存在 ${cnt} 条当前实际但无当前快照`);
      continue;
    }
    const batch = db.prepare('SELECT year,status,updates_current FROM actual_snapshot_batch WHERE id = ?').get(s.current_batch_id) as { year: number; status: string; updates_current: number } | undefined;
    if (!batch || batch.year !== s.year || batch.status !== 'active' || batch.updates_current !== 1) {
      problems.push(`${s.year} 年度当前批次引用无效`);
      continue;
    }
    const snap = new Map(
      (db.prepare('SELECT org_id, account_id, cumulative_amount_cents, quantity FROM actual_snapshot_entry WHERE batch_id = ?').all(s.current_batch_id) as { org_id: number; account_id: number; cumulative_amount_cents: number; quantity: number | null }[])
        .map((r) => [`${r.org_id}:${r.account_id}`, { amount: r.cumulative_amount_cents, quantity: r.quantity }])
    );
    const cur = db.prepare('SELECT org_id, account_id, cumulative_amount_cents, quantity FROM actual_current WHERE year = ?').all(s.year) as { org_id: number; account_id: number; cumulative_amount_cents: number; quantity: number | null }[];
    const currentKeys = new Set<string>();
    for (const c of cur) {
      const key = `${c.org_id}:${c.account_id}`;
      currentKeys.add(key);
      const inSnap = snap.get(key);
      if (inSnap === undefined) problems.push(`${s.year} 当前实际 ${c.org_id}×${c.account_id} 不在当前快照中`);
      else {
        if (inSnap.amount !== c.cumulative_amount_cents) problems.push(`${s.year} 当前实际 ${c.org_id}×${c.account_id} 金额与快照不一致`);
        if (inSnap.quantity !== c.quantity) problems.push(`${s.year} 当前实际 ${c.org_id}×${c.account_id} 数量与快照不一致`);
      }
    }
    for (const key of snap.keys()) if (!currentKeys.has(key)) problems.push(`${s.year} 当前快照 ${key.replace(':', '×')} 在当前实际中不存在`);
  }
  return { name: '当前实际与最新快照一致性', ok: problems.length === 0, problems };
}

/** 2. 锁定版本明细与绑定树引用有效性 */
function checkLockedVersions(db: DB): CheckResult {
  const problems: string[] = [];
  const versions = db.prepare("SELECT * FROM budget_version WHERE status IN ('locked','archived')").all() as { id: number; name: string; year: number; org_tree_snapshot_id: number; account_tree_snapshot_id: number }[];
  for (const v of versions) {
    let orgRows: TreeNodeRow[], accRows: TreeNodeRow[];
    try {
      orgRows = loadSnapshotNodes(db, v.org_tree_snapshot_id);
      accRows = loadSnapshotNodes(db, v.account_tree_snapshot_id);
    } catch (err) {
      problems.push(`版本 ${v.year}/${v.name}: 树快照缺失(${err instanceof Error ? err.message : err})`);
      continue;
    }
    const leafOrgs = computeLeafIds(orgRows);
    const leafAccs = computeLeafIds(accRows);
    const orgIds = new Set(orgRows.map((r) => r.id));
    const accIds = new Set(accRows.map((r) => r.id));
    const entries = db.prepare('SELECT org_id, account_id, amount_cents FROM budget_entry WHERE version_id = ?').all(v.id) as { org_id: number; account_id: number; amount_cents: number }[];
    for (const e of entries) {
      if (!orgIds.has(e.org_id)) problems.push(`版本 ${v.year}/${v.name}: 组织 ${e.org_id} 不在绑定树快照中`);
      else if (!leafOrgs.has(e.org_id)) problems.push(`版本 ${v.year}/${v.name}: 组织 ${e.org_id} 非叶子`);
      if (!accIds.has(e.account_id)) problems.push(`版本 ${v.year}/${v.name}: 科目 ${e.account_id} 不在绑定树快照中`);
      else if (!leafAccs.has(e.account_id)) problems.push(`版本 ${v.year}/${v.name}: 科目 ${e.account_id} 非叶子`);
    }
  }
  return { name: '锁定版本明细与绑定树引用有效性', ok: problems.length === 0, problems };
}

/** 3. 每年度当前生效版本唯一性 */
function checkCurrentVersionUnique(db: DB): CheckResult {
  const problems: string[] = [];
  const rows = db
    .prepare('SELECT year, kind, COUNT(*) AS c FROM budget_version WHERE is_current = 1 GROUP BY year, kind HAVING c > 1')
    .all() as { year: number; kind: string; c: number }[];
  for (const r of rows) problems.push(`${r.year} 年度有 ${r.c} 个当前生效${r.kind === 'forecast' ? '预测' : '预算'}版本`);
  const bad = db
    .prepare("SELECT year, name FROM budget_version WHERE is_current = 1 AND status <> 'locked'")
    .all() as { year: number; name: string }[];
  for (const b of bad) problems.push(`${b.year}/${b.name} 非锁定版本却被标记为当前生效`);
  return { name: '每年度每类当前生效版本唯一性', ok: problems.length === 0, problems };
}

/** 4. 树快照节点引用完整性 */
function checkSnapshots(db: DB): CheckResult {
  const problems: string[] = [];
  const snaps = db.prepare('SELECT id, tree_type, content_json FROM tree_snapshot').all() as { id: number; tree_type: string; content_json: string }[];
  for (const s of snaps) {
    try {
      const parsed = JSON.parse(s.content_json) as { nodes?: { id: number; parentId: number | null; code: string; status: string }[] };
      const nodes = parsed?.nodes;
      if (!Array.isArray(nodes) || nodes.length === 0) {
        problems.push(`快照 #${s.id} (${s.tree_type}) 节点为空`);
        continue;
      }
      const ids = new Set(nodes.map((n) => n.id));
      for (const n of nodes) {
        if (n.parentId != null && !ids.has(n.parentId)) {
          problems.push(`快照 #${s.id} (${s.tree_type}): 节点 ${n.code} 的父节点 ${n.parentId} 不在快照内`);
        }
      }
    } catch (err) {
      problems.push(`快照 #${s.id} (${s.tree_type}) JSON 解析失败: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { name: '树快照节点引用完整性', ok: problems.length === 0, problems };
}

/** 附加:同年度同日同类别 active 快照唯一性(当前批次与历史补录各自独立) */
function checkBatchUniqueness(db: DB): CheckResult {
  const problems: string[] = [];
  const rows = db
    .prepare("SELECT year, snapshot_date, updates_current, COUNT(*) AS c FROM actual_snapshot_batch WHERE status = 'active' GROUP BY year, snapshot_date, updates_current HAVING c > 1")
    .all() as { year: number; snapshot_date: string; updates_current: number; c: number }[];
  for (const r of rows) problems.push(`${r.year} 年 ${r.snapshot_date} 存在 ${r.c} 个 active 的${r.updates_current ? '当前' : '历史补录'}快照`);
  return { name: '同年度同日同类别 active 快照唯一性', ok: problems.length === 0, problems };
}

/** 附加:年度状态 current_batch_id 必须指向同年度 active 且 updates_current=1 的批次 */
function checkCurrentBatchRef(db: DB): CheckResult {
  const problems: string[] = [];
  const states = db.prepare('SELECT * FROM actual_year_state').all() as { year: number; status: string; current_batch_id: number | null }[];
  for (const s of states) {
    if (s.current_batch_id == null) continue;
    const b = db.prepare('SELECT year, status, updates_current FROM actual_snapshot_batch WHERE id = ?').get(s.current_batch_id) as { year: number; status: string; updates_current: number } | undefined;
    if (!b) problems.push(`${s.year} 年度 current_batch_id=${s.current_batch_id} 指向不存在的批次`);
    else if (b.year !== s.year) problems.push(`${s.year} 年度 current_batch_id=${s.current_batch_id} 实际属于 ${b.year} 年`);
    else if (b.status !== 'active') problems.push(`${s.year} 年度 current_batch_id=${s.current_batch_id} 指向 ${b.status} 批次`);
    else if (b.updates_current !== 1) problems.push(`${s.year} 年度 current_batch_id=${s.current_batch_id} 指向历史补录批次(updates_current=0)`);
  }
  return { name: '年度当前快照引用有效性', ok: problems.length === 0, problems };
}

/** 附加:年度最终快照必须存在、属于同年度且来自当前实际链路。重开后允许其被 superseded。
 *  例外:freezeYear 允许经专项确认(nonCurrent)后以历史补录批次关闭年度,
 *  此时 operation_log 留有 nonCurrentConfirmed=true 的 year.freeze 记录,不再视为违规。 */
function checkFinalBatchRef(db: DB): CheckResult {
  const problems: string[] = [];
  const states = db.prepare('SELECT year,status,final_batch_id FROM actual_year_state').all() as {
    year: number;
    status: string;
    final_batch_id: number | null;
  }[];
  for (const state of states) {
    if (state.final_batch_id == null) {
      if (state.status === 'frozen') problems.push(`${state.year} 年度已冻结但没有最终快照`);
      continue;
    }
    const batch = db.prepare('SELECT year,updates_current FROM actual_snapshot_batch WHERE id = ?').get(state.final_batch_id) as {
      year: number;
      updates_current: number;
    } | undefined;
    if (!batch) problems.push(`${state.year} 年度 final_batch_id=${state.final_batch_id} 指向不存在的批次`);
    else if (batch.year !== state.year) problems.push(`${state.year} 年度 final_batch_id=${state.final_batch_id} 实际属于 ${batch.year} 年`);
    else if (batch.updates_current !== 1) {
      const freezeLog = db.prepare(
        "SELECT detail_json FROM operation_log WHERE action = 'year.freeze' AND entity_type = 'actual_year' AND entity_id = ? ORDER BY id DESC LIMIT 1"
      ).get(String(state.year)) as { detail_json: string } | undefined;
      let nonCurrentConfirmed = false;
      try { nonCurrentConfirmed = freezeLog ? Boolean((JSON.parse(freezeLog.detail_json) as { nonCurrentConfirmed?: boolean }).nonCurrentConfirmed) : false; } catch { /* 日志 JSON 损坏按未确认处理 */ }
      if (!nonCurrentConfirmed) problems.push(`${state.year} 年度 final_batch_id=${state.final_batch_id} 指向历史补录批次(updates_current=0)`);
    }
  }
  return { name: '年度最终快照引用有效性', ok: problems.length === 0, problems };
}

export function runConsistencyChecks(db: DB): { ok: boolean; checks: CheckResult[] } {
  void rowsToTreeNodes;
  const checks = [
    checkActualVsSnapshot(db),
    checkLockedVersions(db),
    checkCurrentVersionUnique(db),
    checkSnapshots(db),
    checkBatchUniqueness(db),
    checkCurrentBatchRef(db),
    checkFinalBatchRef(db),
  ];
  return { ok: checks.every((c) => c.ok), checks };
}
