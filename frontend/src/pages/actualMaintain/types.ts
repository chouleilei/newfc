import { yuanToWanDisplay } from '../../utils/money';

/**
 * 历史数据维护页数据模型:年度矩阵响应 + 网格行模型 + 服务端基线重建。
 */

export interface MatrixEntry { orgId: number; accountId: number; amountCents: number; amountDisplay: string; quantity: string | null; memo?: string }
export interface ActualMatrixResponse {
  yearState: { year: number; status: string; current_batch_id: number | null } | null;
  currentBatch: { id: number; snapshot_date: string; revision: number; source: string } | null;
  orgRows: OrgNode[];
  accountRows: AccountNode[];
  leafOrgIds: number[];
  leafAccountIds: number[];
  activeAccountIds: number[];
  financeOwnedCells: { profileId: number; profileName: string; orgId: number; orgCode: string; accountId: number; accountCode: string }[];
  entries: (MatrixEntry & { source: string })[];
  /** 汇总格备注(组织或科目至少一侧非叶子;叶子×叶子备注在 entries.memo 上,不进快照) */
  cellNotes: { orgId: number; accountId: number; memo: string }[];
}
export interface BudgetMatrixResponse {
  version: { id: number; year: number; name: string; status: string; is_current: 0 | 1 };
  entries: MatrixEntry[];
}
export interface VersionRow { id: number; year: number; name: string; status: string; is_current: 0 | 1; kind: 'budget' | 'forecast' }
export interface MetricItem { id: number; code: string; name: string; terms: { source_type: string; source_account_id: number | null; source_metric_id: number | null; coefficient: number }[] }
export interface Batch {
  id: number; year: number; snapshot_date: string; revision: number; status: string;
  source: string; updates_current: 0 | 1; note: string; created_at: string;
}

export interface OrgNode { id: number; parent_id: number | null; code: string; name: string; status: string }
export interface OrgTreeResponse {
  tree: { id: number; code: string; name: string; children: unknown[] }[];
  rows: OrgNode[];
}
export interface AccountNode { id: number; parent_id: number | null; code: string; name: string; type?: string; unit?: string; quantity_agg?: string; status: string }
export interface AccountTreeResponse { rows: AccountNode[] }

export const SOURCE_LABEL: Record<string, string> = { manual: '手工', excel_import: 'Excel导入', history_import: '历史补录' };

export interface YearData {
  budgetEntries: Map<string, MatrixEntry>; // orgId:accountId -> 叶子明细
  budgetVersion?: VersionRow;
  actualEntries: Map<string, MatrixEntry>;
  /** 汇总格备注:orgId:accountId -> 备注(当前年度口径,不进快照批次) */
  actualCellNotes: Map<string, string>;
  actualFrozen: boolean;
  actualCutoff?: string;
  actualCurrentBatchId: number | null;
  financeOwnedCells: ActualMatrixResponse['financeOwnedCells'];
  actualLoadStatus: 'loading' | 'ready' | 'error';
  actualLoadError?: string;
  /** 预算矩阵是独立请求:失败必须显式标记,不能把空 Map 当作「预算为零」展示 */
  budgetLoadStatus: 'loading' | 'ready' | 'error';
  budgetLoadError?: string;
}

export interface AccRow {
  kind: 'account';
  id: number;
  code: string;
  name: string;
  depth: number;
  type: string;
  unit?: string;
  /** 数量型科目的上级汇总方式:sum=可加总 / none=不汇总(单价类等) */
  quantityAgg?: string;
  isLeaf: boolean;          // 树结构叶子(可编辑的前提)
  collapsedHere: boolean;   // 本表折叠显示的汇总科目(只读,明细在专属表)
  /* 利润表模板行专用 */
  label?: string;
  indent?: number;
  bold?: boolean;
}
export interface MetricRow { kind: 'metric'; id: number; code: string; name: string; label?: string; indent?: number; bold?: boolean }
export type GridRow = AccRow | MetricRow;

/** 从服务端年度数据重建编辑值基线(orgId:accountId -> 万元/数量显示串) */
export function buildPristineActualValues(
  yd: YearData,
  accRows: { id: number; type?: string }[],
): Map<string, string> {
  const m = new Map<string, string>();
  const accById = new Map(accRows.map((r) => [r.id, r]));
  for (const e of yd.actualEntries.values()) {
    const acc = accById.get(e.accountId);
    m.set(`${e.orgId}:${e.accountId}`, acc?.type === 'quantity' ? (e.quantity ?? '') : yuanToWanDisplay(e.amountDisplay));
  }
  return m;
}

export function buildPristineActualMemos(yd: YearData): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of yd.actualEntries.values()) if (e.memo) m.set(`${e.orgId}:${e.accountId}`, e.memo);
  return m;
}

/** 从服务端年度数据重建汇总格备注基线(orgId:accountId -> 备注) */
export function buildPristineActualCellNotes(yd: YearData): Map<string, string> {
  return new Map(yd.actualCellNotes);
}
