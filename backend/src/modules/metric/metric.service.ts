import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import { safeIntegerAdd, scaledRatio, QUANTITY_SCALE, MONEY_NATURAL_DIVISOR } from '../../core/money';

/**
 * 报表指标(方案四.10/11)。两类:
 * - linear:科目节点与其他指标的线性组合(系数 ±1),值为带符号「分」,利润方向。
 * - ratio :分子 ÷ 分母的比率,值为 RATIO_SCALE(10^6)缩放的定点数,自带有利方向。
 *
 * 两类值单位不同,绝不放进同一个结果映射:computeMetrics 只算 linear,
 * computeMetricRatios 只算 ratio。保存时做循环检测。
 */

/** 公式项角色:线性指标全部 term;比率恰好一个 numerator + 一个 denominator */
export type MetricTermRole = 'term' | 'numerator' | 'denominator';

export type MetricKind = 'linear' | 'ratio';
export type MetricDirection = 'higher_better' | 'lower_better';
export type MetricDisplayFormat = 'percent' | 'number';

export type MetricTermInput = {
  sourceType: 'account' | 'metric';
  sourceAccountId?: number | null;
  sourceMetricId?: number | null;
  coefficient: 1 | -1;
  sortOrder?: number;
  /** 缺省 term(线性);比率必须显式给出 numerator / denominator */
  role?: MetricTermRole;
};

export interface MetricTermRow {
  id: number;
  metric_id: number;
  source_type: 'account' | 'metric';
  source_account_id: number | null;
  source_metric_id: number | null;
  coefficient: 1 | -1;
  sort_order: number;
  role: MetricTermRole;
}

export interface MetricRow {
  id: number;
  code: string;
  name: string;
  display_order: number;
  status: 'active' | 'inactive';
  kind: MetricKind;
  direction: MetricDirection;
  display_format: MetricDisplayFormat;
  unit: string;
  /** 完成率的业务展示符号；存储值与差异始终保持利润方向。 */
  display_sign: 1 | -1;
  created_at: string;
  updated_at: string;
  terms: MetricTermRow[];
}

function loadTerms(db: DB, metricIds: number[]): Map<number, MetricTermRow[]> {
  const map = new Map<number, MetricTermRow[]>();
  if (metricIds.length === 0) return map;
  const placeholders = metricIds.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM report_metric_term WHERE metric_id IN (${placeholders}) ORDER BY sort_order, id`)
    .all(...metricIds) as MetricTermRow[];
  for (const t of rows) {
    if (!map.has(t.metric_id)) map.set(t.metric_id, []);
    map.get(t.metric_id)!.push(t);
  }
  return map;
}

export function listMetrics(db: DB): MetricRow[] {
  const rows = db
    .prepare('SELECT * FROM report_metric ORDER BY display_order, id')
    .all() as (Omit<MetricRow, 'terms'>)[];
  const terms = loadTerms(db, rows.map((r) => r.id));
  return rows.map((r) => ({ ...r, terms: terms.get(r.id) ?? [] }));
}

/** 在预算定稿事务内固化完整指标定义；状态表用于区分“合法的零指标快照”和缺失快照。 */
export function snapshotMetricsForVersion(db: DB, versionId: number): void {
  if (db.prepare('SELECT 1 FROM budget_metric_snapshot_state WHERE version_id = ?').get(versionId)) return;
  const now = new Date().toISOString();
  db.prepare('INSERT INTO budget_metric_snapshot_state(version_id,created_at) VALUES (?,?)').run(versionId, now);
  db.prepare(`
    INSERT INTO budget_metric_snapshot(version_id,metric_id,code,name,display_order,status,kind,direction,display_format,unit,display_sign,created_at,updated_at)
    SELECT ?,id,code,name,display_order,status,kind,direction,display_format,unit,display_sign,created_at,updated_at FROM report_metric
  `).run(versionId);
  db.prepare(`
    INSERT INTO budget_metric_term_snapshot(version_id,metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
    SELECT ?,metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role FROM report_metric_term
  `).run(versionId);
}

/** 锁定/归档版本读取固化定义；草稿仍使用当前公式供编制预览。 */
export function listMetricsForVersion(db: DB, versionId: number): MetricRow[] {
  // 版本不存在时过去落入「无快照 → 返回全量现行指标」分支:调用方拿到 200 + 错误
  // 口径的数据,比 404 更难排查。其他调用点(report/budget)都已先取过版本,这里补上。
  const version = db.prepare('SELECT 1 FROM budget_version WHERE id = ?').get(versionId);
  if (!version) throw Errors.notFound('预算版本');
  const snapshotted = db.prepare('SELECT 1 FROM budget_metric_snapshot_state WHERE version_id = ?').get(versionId);
  if (!snapshotted) return listMetrics(db);
  const rows = db.prepare(`
    SELECT metric_id AS id,code,name,display_order,status,kind,direction,display_format,unit,display_sign,created_at,updated_at
    FROM budget_metric_snapshot WHERE version_id = ? ORDER BY display_order,metric_id
  `).all(versionId) as (Omit<MetricRow, 'terms'>)[];
  const terms = db.prepare(`
    SELECT id,metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role
    FROM budget_metric_term_snapshot WHERE version_id = ? ORDER BY sort_order,id
  `).all(versionId) as MetricTermRow[];
  const byMetric = new Map<number, MetricTermRow[]>();
  for (const term of terms) byMetric.set(term.metric_id, [...(byMetric.get(term.metric_id) ?? []), term]);
  return rows.map((row) => ({ ...row, terms: byMetric.get(row.id) ?? [] }));
}

export function getMetric(db: DB, id: number): MetricRow {
  const row = db.prepare('SELECT * FROM report_metric WHERE id = ?').get(id) as Omit<MetricRow, 'terms'> | undefined;
  if (!row) throw Errors.notFound('报表指标');
  return { ...row, terms: loadTerms(db, [id]).get(id) ?? [] };
}

/** 循环检测:metric 引用图存在环则报错(自引用也拦截) */
export function assertNoCycle(
  definitions: Map<number, MetricTermInput[]>,
  startId: number,
  editingId: number | null = null
): void {
  const visiting = new Set<number>();
  const visited = new Set<number>();
  const dfs = (id: number, path: number[]) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id].join(' -> ');
      throw Errors.validation(`指标公式存在循环引用: ${cycle}`);
    }
    visiting.add(id);
    for (const t of definitions.get(id) ?? []) {
      if (t.sourceType === 'metric' && t.sourceMetricId != null) {
        // 允许引用其他指标,但正在编辑的指标使用新定义
        if (t.sourceMetricId === id) throw Errors.validation('指标公式存在循环引用: 指标直接引用自身');
        dfs(t.sourceMetricId, [...path, t.sourceMetricId]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  void editingId;
  dfs(startId, [startId]);
}

/** 比率的一侧:来源 + 符号系数(成本费用存负数,配 -1 让比率读正) */
export interface RatioSide {
  role: 'numerator' | 'denominator';
  sourceType: 'account' | 'metric';
  sourceId: number;
  coefficient: 1 | -1;
  /** money:金额科目或线性指标(分);quantity:数量科目(10^4 缩放) */
  basis: 'money' | 'quantity';
}

/**
 * 取出比率指标的分子与分母。basis 由科目类型决定,指标一律 money。
 * 定义不完整时抛错——调用方拿到的一定是可计算的两侧。
 */
export function ratioSides(db: DB | null, metric: MetricRow, accountTypeOf?: Map<number, string>): { numerator: RatioSide; denominator: RatioSide } {
  const pick = (role: 'numerator' | 'denominator'): RatioSide => {
    const found = metric.terms.filter((t) => t.role === role);
    if (found.length !== 1) {
      throw Errors.validation(`比率指标 ${metric.code} 必须恰好有一个${role === 'numerator' ? '分子' : '分母'}`);
    }
    const t = found[0];
    if (t.source_type === 'metric') {
      return { role, sourceType: 'metric', sourceId: t.source_metric_id!, coefficient: t.coefficient, basis: 'money' };
    }
    const accountId = t.source_account_id!;
    const type = accountTypeOf?.get(accountId)
      ?? (db ? (db.prepare('SELECT type FROM account WHERE id = ?').get(accountId) as { type: string } | undefined)?.type : undefined);
    return {
      role,
      sourceType: 'account',
      sourceId: accountId,
      coefficient: t.coefficient,
      basis: type === 'quantity' ? 'quantity' : 'money',
    };
  };
  return { numerator: pick('numerator'), denominator: pick('denominator') };
}

function validateTerms(db: DB, terms: MetricTermInput[], kind: MetricKind): void {
  if (terms.length === 0) throw Errors.validation('指标至少需要一个公式项');
  const uniqueTerms = new Set<string>();
  for (const [i, t] of terms.entries()) {
    if (t.coefficient !== 1 && t.coefficient !== -1) throw Errors.validation(`第 ${i + 1} 个公式项系数必须是 1 或 -1`);
    const role: MetricTermRole = t.role ?? 'term';
    if (kind === 'linear' && role !== 'term') {
      throw Errors.validation(`线性指标的公式项不能设置分子/分母角色(第 ${i + 1} 项)`);
    }
    if (kind === 'ratio' && role === 'term') {
      throw Errors.validation(`比率指标的公式项必须指明分子或分母(第 ${i + 1} 项)`);
    }
    if (t.sourceType === 'account') {
      if (t.sourceAccountId == null) throw Errors.validation(`第 ${i + 1} 个公式项缺少科目引用`);
      const acc = db.prepare('SELECT type, quantity_agg FROM account WHERE id = ?').get(t.sourceAccountId) as
        { type: string; quantity_agg: string } | undefined;
      if (!acc) {
        throw Errors.validation(`公式引用的科目 ${t.sourceAccountId} 不存在`);
      }
      if (acc.type === 'quantity') {
        // 线性指标是金额口径,数量与金额完全隔离;比率允许数量作为分子/分母,
        // 但必须可跨组织累计——不可汇总的单价/税率没有合法的范围合计值。
        if (kind === 'linear') {
          throw Errors.validation('指标公式只能引用金额科目(收入/成本/费用),不能引用数量型科目');
        }
        if (acc.quantity_agg !== 'sum') {
          throw Errors.validation('比率只能引用可累计(汇总方式=可加总)的数量科目;单价、税率等不可汇总科目没有范围合计值');
        }
      }
    } else if (t.sourceType === 'metric') {
      if (t.sourceMetricId == null) throw Errors.validation(`第 ${i + 1} 个公式项缺少指标引用`);
      const target = db.prepare('SELECT kind FROM report_metric WHERE id = ?').get(t.sourceMetricId) as { kind: MetricKind } | undefined;
      if (!target) {
        throw Errors.validation(`公式引用的指标 ${t.sourceMetricId} 不存在`);
      }
      // 比率是无量纲/带自然单位的定点数,与「分」不可混算,因此比率指标是终端节点:
      // 既不能被线性指标相加,也不能充当另一个比率的分子分母。
      if (target.kind === 'ratio') {
        throw Errors.validation('比率指标不能被其他指标引用(比率与金额单位不同,不可混算)');
      }
    } else {
      throw Errors.validation(`第 ${i + 1} 个公式项类型必须是 account 或 metric`);
    }
    const sourceId = t.sourceType === 'account' ? t.sourceAccountId : t.sourceMetricId;
    const uniqueKey = `${t.sourceType}:${sourceId}:${role}`;
    if (uniqueTerms.has(uniqueKey)) throw Errors.validation(`第 ${i + 1} 个公式项与前面的来源和角色重复`);
    uniqueTerms.add(uniqueKey);
  }
  if (kind === 'ratio') {
    const numerators = terms.filter((t) => t.role === 'numerator').length;
    const denominators = terms.filter((t) => t.role === 'denominator').length;
    if (numerators !== 1 || denominators !== 1) {
      throw Errors.validation(`比率指标必须恰好有一个分子和一个分母(当前分子 ${numerators} 个、分母 ${denominators} 个)`);
    }
  }
}

export function createMetric(
  db: DB,
  input: {
    code: string; name: string; displayOrder?: number; terms: MetricTermInput[];
    kind?: MetricKind; direction?: MetricDirection; displayFormat?: MetricDisplayFormat; unit?: string; displaySign?: 1 | -1;
  }
): MetricRow {
  if (!input.code?.trim()) throw Errors.validation('指标编码不能为空');
  if (!input.name?.trim()) throw Errors.validation('指标名称不能为空');
  if (db.prepare('SELECT 1 FROM report_metric WHERE code = ?').get(input.code.trim())) {
    throw Errors.conflict(`指标编码 ${input.code.trim()} 已存在`);
  }
  const kind = normalizeKind(input.kind);
  const direction = normalizeDirection(input.direction);
  const displayFormat = normalizeDisplayFormat(input.displayFormat);
  const displaySign = normalizeDisplaySign(input.displaySign, kind);
  validateTerms(db, input.terms, kind);
  // 新指标自身不在已有图中,只需检查它引用的指标图无环(引用自身在 validateTerms 后通过 dfs 兜底)
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const info = db
      .prepare(`INSERT INTO report_metric (code, name, display_order, status, kind, direction, display_format, unit, display_sign, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.code.trim(), input.name.trim(), input.displayOrder ?? 0, 'active', kind, direction, displayFormat, (input.unit ?? '').trim(), displaySign, now, now);
    const id = Number(info.lastInsertRowid);
    insertTerms(db, id, input.terms);
    // 建图检查:包含新指标
    const defs = currentDefinitions(db);
    assertNoCycle(defs, id);
    writeLog(db, 'metric.create', 'metric', id, { code: input.code.trim(), name: input.name.trim(), kind });
    return id;
  });
  return getMetric(db, tx());
}

function normalizeKind(kind?: MetricKind): MetricKind {
  if (kind == null) return 'linear';
  if (kind !== 'linear' && kind !== 'ratio') throw Errors.validation('指标类型必须是 linear 或 ratio');
  return kind;
}

function normalizeDirection(direction?: MetricDirection): MetricDirection {
  if (direction == null) return 'higher_better';
  if (direction !== 'higher_better' && direction !== 'lower_better') {
    throw Errors.validation('有利方向必须是 higher_better 或 lower_better');
  }
  return direction;
}

function normalizeDisplayFormat(format?: MetricDisplayFormat): MetricDisplayFormat {
  if (format == null) return 'percent';
  if (format !== 'percent' && format !== 'number') throw Errors.validation('展示格式必须是 percent 或 number');
  return format;
}

function normalizeDisplaySign(value: unknown, kind: MetricKind): 1 | -1 {
  if (kind === 'ratio') return 1;
  if (value == null) return 1;
  if (value !== 1 && value !== -1) throw Errors.validation('金额指标展示符号必须是 1 或 -1');
  return value;
}

function insertTerms(db: DB, metricId: number, terms: MetricTermInput[]): void {
  const stmt = db.prepare(
    `INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order, role)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  terms.forEach((t, i) => {
    stmt.run(
      metricId,
      t.sourceType,
      t.sourceType === 'account' ? t.sourceAccountId ?? null : null,
      t.sourceType === 'metric' ? t.sourceMetricId ?? null : null,
      t.coefficient,
      t.sortOrder ?? i,
      t.role ?? 'term'
    );
  });
}

function currentDefinitions(db: DB): Map<number, MetricTermInput[]> {
  const map = new Map<number, MetricTermInput[]>();
  const rows = db.prepare('SELECT * FROM report_metric_term').all() as MetricTermRow[];
  for (const r of rows) {
    if (!map.has(r.metric_id)) map.set(r.metric_id, []);
    map.get(r.metric_id)!.push({
      sourceType: r.source_type,
      sourceAccountId: r.source_account_id,
      sourceMetricId: r.source_metric_id,
      coefficient: r.coefficient,
      sortOrder: r.sort_order,
      role: r.role,
    });
  }
  return map;
}

export function updateMetric(
  db: DB,
  id: number,
  input: {
    name?: string; displayOrder?: number; status?: 'active' | 'inactive'; terms?: MetricTermInput[];
    kind?: MetricKind; direction?: MetricDirection; displayFormat?: MetricDisplayFormat; unit?: string; displaySign?: 1 | -1;
  }
): MetricRow {
  const metric = getMetric(db, id);
  if (input.name !== undefined && !input.name.trim()) throw Errors.validation('指标名称不能为空');
  const kind = input.kind === undefined ? metric.kind : normalizeKind(input.kind);
  const direction = input.direction === undefined ? metric.direction : normalizeDirection(input.direction);
  const displayFormat = input.displayFormat === undefined ? metric.display_format : normalizeDisplayFormat(input.displayFormat);
  const displaySign = input.displaySign === undefined && kind === metric.kind
    ? metric.display_sign
    : normalizeDisplaySign(input.displaySign, kind);
  // 改类型必须同时给出新公式:线性项与比率的分子分母不能互相解释
  if (kind !== metric.kind && input.terms === undefined) {
    throw Errors.validation('切换指标类型时必须同时提交新的公式定义');
  }
  if (input.terms) validateTerms(db, input.terms, kind);
  // 已被其他指标引用的线性指标不能改成比率:比率不可被引用,会让引用方失去合法取数
  if (kind === 'ratio' && metric.kind === 'linear') {
    const ref = db
      .prepare('SELECT 1 FROM report_metric_term WHERE source_type = ? AND source_metric_id = ? LIMIT 1')
      .get('metric', id);
    if (ref) throw Errors.conflict('该指标被其他指标公式引用,不能改为比率型(比率不能被引用)');
  }
  if (input.status === 'inactive' && metric.status === 'active') {
    const ref = db
      .prepare('SELECT 1 FROM report_metric_term WHERE source_type = ? AND source_metric_id = ? LIMIT 1')
      .get('metric', id);
    if (ref) throw Errors.conflict('该指标被其他指标公式引用,不能停用');
  }
  const tx = db.transaction(() => {
    db.prepare(`UPDATE report_metric SET name = ?, display_order = ?, status = ?, kind = ?, direction = ?,
                display_format = ?, unit = ?, display_sign = ?, updated_at = ? WHERE id = ?`).run(
      input.name !== undefined ? input.name.trim() : metric.name,
      input.displayOrder ?? metric.display_order,
      input.status ?? metric.status,
      kind,
      direction,
      displayFormat,
      input.unit !== undefined ? input.unit.trim() : metric.unit,
      displaySign,
      new Date().toISOString(),
      id
    );
    if (input.terms) {
      db.prepare('DELETE FROM report_metric_term WHERE metric_id = ?').run(id);
      insertTerms(db, id, input.terms);
    }
    const defs = currentDefinitions(db);
    assertNoCycle(defs, id);
    writeLog(db, 'metric.update', 'metric', id, { name: input.name, kind, termsReplaced: input.terms !== undefined });
  });
  tx();
  return getMetric(db, id);
}

export function deleteMetric(db: DB, id: number): void {
  getMetric(db, id);
  const ref = db
    .prepare('SELECT 1 FROM report_metric_term WHERE source_type = ? AND source_metric_id = ? LIMIT 1')
    .get('metric', id);
  if (ref) throw Errors.conflict('该指标被其他指标公式引用,不能删除');
  db.transaction(() => {
    db.prepare('DELETE FROM report_metric_term WHERE metric_id = ?').run(id);
    db.prepare('DELETE FROM report_metric WHERE id = ?').run(id);
    writeLog(db, 'metric.delete', 'metric', id, {});
  })();
}

/**
 * 按拓扑序计算线性指标值(方案八.3)。比率指标不在此计算(单位不同,见 computeMetricRatios)。
 * @param accountTotals 科目节点累计金额映射(带符号)
 * @param metrics 指标定义(比率指标会被跳过)
 * @returns metricId -> 带符号金额(仅线性指标)
 */
export function computeMetrics(
  accountTotals: Map<number, number>,
  metrics: MetricRow[]
): Map<number, number> {
  const byId = new Map(metrics.filter((m) => m.kind !== 'ratio').map((m) => [m.id, m]));
  const result = new Map<number, number>();
  const visiting = new Set<number>();
  const calc = (id: number): number => {
    if (result.has(id)) return result.get(id)!;
    if (visiting.has(id)) throw Errors.conflict('指标公式存在循环引用(计算阶段)');
    const m = byId.get(id);
    if (!m) return 0;
    visiting.add(id);
    let sum = 0;
    for (const t of m.terms) {
      if (t.source_type === 'account') {
        sum = safeIntegerAdd(sum, (accountTotals.get(t.source_account_id!) ?? 0) * t.coefficient, '指标金额汇总');
      } else {
        sum = safeIntegerAdd(sum, calc(t.source_metric_id!) * t.coefficient, '指标金额汇总');
      }
    }
    visiting.delete(id);
    result.set(id, sum);
    return sum;
  };
  for (const m of byId.values()) calc(m.id);
  return result;
}

/** 比率指标的取数来源:三张范围内合计映射 */
export interface RatioSourceTotals {
  /** accountId -> 带符号分(科目子树合计,不做组织交叉) */
  money: Map<number, number>;
  /** accountId -> 10^4 缩放数量(科目子树合计,仅 quantity_agg=sum) */
  quantity: Map<number, number>;
  /** metricId -> 线性指标值(分),取自 computeMetrics 保证与报表同源 */
  linear: Map<number, number>;
}

export interface MetricRatioValue {
  /** RATIO_SCALE(10^6)缩放的定点比率;分母为 0 时为 null(N/A,不伪造 0) */
  scaled: number | null;
  special: null | 'na_zero_denominator';
  /** 已乘符号系数、归一到业务读法的分子原值(money=分,quantity=10^4 缩放) */
  numeratorRaw: number;
  denominatorRaw: number;
  numeratorBasis: 'money' | 'quantity';
  denominatorBasis: 'money' | 'quantity';
}

const NATURAL_DIVISOR: Record<'money' | 'quantity', number> = {
  money: MONEY_NATURAL_DIVISOR,
  quantity: QUANTITY_SCALE,
};

/**
 * 计算比率指标。
 *
 * 两侧先各自换算到自然单位(金额 -> 元,数量 -> 科目计量单位)再相除,因此
 * money/money 得到无量纲比率,money/quantity 得到「元 ÷ 计量单位」。
 * 除法用 BigInt 精确完成并按 RATIO_SCALE 四舍五入,结果可复现。
 *
 * @param accountTypeOf accountId -> 科目类型,用于判定某一侧走金额还是数量口径
 */
export function computeMetricRatios(
  totals: RatioSourceTotals,
  metrics: MetricRow[],
  accountTypeOf: Map<number, string>
): Map<number, MetricRatioValue> {
  const result = new Map<number, MetricRatioValue>();
  for (const metric of metrics) {
    if (metric.kind !== 'ratio') continue;
    let sides;
    try {
      sides = ratioSides(null, metric, accountTypeOf);
    } catch {
      // 定义不完整(例如历史快照里缺一侧)不应让整张报表失败,跳过该比率
      continue;
    }
    const rawOf = (side: RatioSide): number => {
      const base = side.sourceType === 'metric'
        ? totals.linear.get(side.sourceId) ?? 0
        : side.basis === 'quantity'
          ? totals.quantity.get(side.sourceId) ?? 0
          : totals.money.get(side.sourceId) ?? 0;
      return base * side.coefficient;
    };
    const numeratorRaw = rawOf(sides.numerator);
    const denominatorRaw = rawOf(sides.denominator);
    const scaled = scaledRatio(
      numeratorRaw,
      denominatorRaw,
      NATURAL_DIVISOR[sides.numerator.basis],
      NATURAL_DIVISOR[sides.denominator.basis],
    );
    result.set(metric.id, {
      scaled,
      special: scaled == null ? 'na_zero_denominator' : null,
      numeratorRaw,
      denominatorRaw,
      numeratorBasis: sides.numerator.basis,
      denominatorBasis: sides.denominator.basis,
    });
  }
  return result;
}

export interface MetricTermContribution {
  sourceType: 'account' | 'metric';
  sourceId: number;
  coefficient: 1 | -1;
  /** 该项自身的值:科目项为科目节点合计,指标项为嵌套指标值;未乘系数 */
  rawCents: number;
  /** 计入本指标的贡献 = rawCents × coefficient */
  contributionCents: number;
}

export interface MetricBreakdown {
  metricId: number;
  /** 指标值,取自 computeMetrics,与报表同源 */
  valueCents: number;
  terms: MetricTermContribution[];
  /** Σ contributionCents */
  sumOfTermsCents: number;
  /** 逐项贡献之和是否等于指标值(指标穿透的守恒核对) */
  reconciled: boolean;
}

/**
 * 单个指标的公式项级拆解(指标穿透,方案四.10/11 + 八.3)。
 *
 * 指标值一律取自 computeMetrics,保证穿透明细与报表指标同源;本函数只负责把
 * computeMetrics 内部累加时丢弃的逐项贡献重新算出来。科目/指标是否存在、是否停用
 * 由调用方结合树快照标注 —— 这里不做判断,因为 accountTotals 缺键既可能是科目
 * 不存在,也可能是该科目在当前范围内金额为零。
 */
export function metricBreakdown(
  accountTotals: Map<number, number>,
  metrics: MetricRow[],
  metricId: number
): MetricBreakdown {
  const metric = metrics.find((m) => m.id === metricId);
  if (!metric) throw Errors.notFound('报表指标');
  if (metric.kind === 'ratio') {
    // 比率没有「逐项贡献求和 = 指标值」这种守恒结构,它的构成就是分子与分母两个数,
    // 报表层已直接给出,不走线性穿透。
    throw Errors.validation(`${metric.name}(${metric.code})是比率型指标,请查看分子与分母,不适用线性公式穿透`);
  }
  const values = computeMetrics(accountTotals, metrics);
  let sum = 0;
  const terms = metric.terms.map((t) => {
    const isAccount = t.source_type === 'account';
    const sourceId = (isAccount ? t.source_account_id : t.source_metric_id) ?? 0;
    // 与 computeMetrics 完全一致的取值口径:缺失一律按零参与
    const rawCents = isAccount ? accountTotals.get(sourceId) ?? 0 : values.get(sourceId) ?? 0;
    const contributionCents = rawCents * t.coefficient;
    sum = safeIntegerAdd(sum, contributionCents, '指标穿透合计');
    return { sourceType: t.source_type, sourceId, coefficient: t.coefficient, rawCents, contributionCents };
  });
  const valueCents = values.get(metricId) ?? 0;
  return { metricId, valueCents, terms, sumOfTermsCents: sum, reconciled: sum === valueCents };
}

/** 公式引用了停用科目的检测(界面标注用,方案四.11) */
export function metricsWithDisabledAccount(db: DB): Set<number> {
  const rows = db
    .prepare(
      `SELECT DISTINCT t.metric_id FROM report_metric_term t
       JOIN account a ON a.id = t.source_account_id
       WHERE t.source_type = 'account' AND a.status = 'inactive'`
    )
    .all() as { metric_id: number }[];
  return new Set(rows.map((r) => r.metric_id));
}
