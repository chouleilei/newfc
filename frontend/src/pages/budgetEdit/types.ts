import { yuanToWanDisplay } from '../../utils/money';

/**
 * 预算编制页数据模型:服务端矩阵响应 + 网格行模型 + 服务端基线重建。
 */

export interface MatrixNode {
  id: number;
  parent_id: number | null;
  code: string;
  name: string;
  type?: string;
  unit?: string;
  quantity_agg?: string;
  status: string;
}
export interface MatrixResponse {
  version: { id: number; year: number; name: string; status: string; is_current: 0 | 1; kind: 'budget' | 'forecast'; note: string; org_tree_snapshot_id: number; account_tree_snapshot_id: number; revision: number };
  orgNodes: MatrixNode[];
  accountNodes: MatrixNode[];
  leafOrgIds: number[];
  leafAccountIds: number[];
  entries: { orgId: number; accountId: number; amountCents: number; amountDisplay: string; quantity: string | null; formula?: string; note?: string }[];
  /** 汇总格备注(组织或科目至少一侧非叶子;叶子×叶子附注在 entries.note 上) */
  cellNotes: { orgId: number; accountId: number; note: string }[];
}

/** 从服务端矩阵重建汇总格备注基线(orgId:accountId -> 备注) */
export function buildPristineCellNotes(data: Pick<MatrixResponse, 'cellNotes'>): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of data.cellNotes ?? []) {
    if (n.note?.trim()) m.set(`${n.orgId}:${n.accountId}`, n.note);
  }
  return m;
}

export interface SummaryRatioMetric {
  id: number;
  code: string;
  name: string;
  direction: 'higher_better' | 'lower_better';
  displayFormat: 'percent' | 'number';
  unit: string;
  /** RATIO_SCALE(10^6)缩放;分母为 0 时为 null(N/A) */
  scaled: number | null;
  numeratorRaw: number;
  denominatorRaw: number;
  numeratorBasis: 'money' | 'quantity';
  denominatorBasis: 'money' | 'quantity';
}

export interface SummaryResponse {
  totalsByAccountType: { income: number; cost: number; expense: number };
  metrics: { id: number; code: string; name: string }[];
  metricValues: Record<string, number>;
  /** 比率指标(分子 ÷ 分母),单位与金额指标不同,单独一张表展示 */
  ratioMetrics?: SummaryRatioMetric[];
}

export interface CheckpointValue {
  amountCents: number;
  quantity: number | null;
  formula: string;
  note: string;
}

/** 记录点变化类型(后端 diffCheckpointCells 判别,AI 功能增强计划 §四.阶段六.1) */
export type CheckpointChangeKind = 'amount' | 'quantity' | 'formula' | 'note' | 'mixed';

export interface CompilationCheckpoint {
  id: number;
  versionId: number;
  sequenceNo: number;
  title: string;
  changeCount: number;
  autoCreated: boolean;
  createdAt: string;
  changes: { orgId: number; accountId: number; kind: CheckpointChangeKind; before: CheckpointValue; after: CheckpointValue }[];
  /** 本轮修改小结:异步生成,未生成时为空串,前端回退变化清单 */
  summary?: string;
  summarySource?: '' | 'template' | 'model';
}

export interface CompilationStatus {
  versionId: number;
  items: CompilationCheckpoint[];
  unrecordedChangeCount: number;
  lastCheckpointAt: string | null;
}
export interface MetricItem {
  id: number;
  code: string;
  name: string;
  terms: { source_type: string; source_account_id: number | null; source_metric_id: number | null; coefficient: number }[];
}

/** 科目树索引(版本绑定快照口径) */
export interface AccIndex {
  nodes: MatrixNode[];
  byId: Map<number, MatrixNode>;
  children: Map<number, number[]>;
}

export interface Row {
  kind: 'account';
  id: number;
  code: string;
  name: string;
  depth: number;
  type: string;
  unit?: string;
  quantityAgg?: string;
  isLeaf: boolean;          // 树结构叶子(可编辑的前提)
  collapsedHere: boolean;   // 本表折叠显示的汇总科目(只读,明细在专属表)
  status: string;
  childIds: number[];
  /* 利润表模板行专用 */
  label?: string;           // 模板行文字(如"其中：营业成本")
  indent?: number;          // 模板缩进层级
  bold?: boolean;           // 小计行加粗
}
export interface MetricRow {
  kind: 'metric';
  id: number;
  code: string;
  name: string;
  label?: string;
  indent?: number;
  bold?: boolean;
}
export type GridRow = Row | MetricRow;

/** 从服务端版本数据重建编辑值基线(值/公式/附注三张表,格式与加载 effect 一致) */
export function buildPristineBudgetValues(data: MatrixResponse): {
  values: Map<string, string>; formulas: Map<string, string>; notes: Map<string, string>;
  origByKey: Map<string, MatrixResponse['entries'][number]>;
} {
  const vMap = new Map<string, string>();
  const fMap = new Map<string, string>();
  const nMap = new Map<string, string>();
  const origByKey = new Map<string, MatrixResponse['entries'][number]>();
  const accById = new Map(data.accountNodes.map((n) => [n.id, n]));
  for (const e of data.entries) {
    const k = `${e.orgId}:${e.accountId}`;
    vMap.set(k, accById.get(e.accountId)?.type === 'quantity' ? (e.quantity ?? '') : yuanToWanDisplay(e.amountDisplay));
    if (e.formula) fMap.set(k, e.formula);
    if (e.note) nMap.set(k, e.note);
    origByKey.set(k, e);
  }
  return { values: vMap, formulas: fMap, notes: nMap, origByKey };
}
