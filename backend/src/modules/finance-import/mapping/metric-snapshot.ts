import type { DB } from '../../../db/connection';

export interface MetricSnapshotRow {
  metric_id: number;
  code: string;
  status: string;
}

export interface MetricTermSnapshotRow {
  metric_id: number;
  source_type: 'account' | 'metric';
  source_account_id: number | null;
  source_metric_id: number | null;
  coefficient: number;
  sort_order: number;
}

/**
 * 在映射锁定时固化报表指标公式，避免后续主数据变更改变历史转换结果。
 *
 * 只固化线性指标：财务勾稽是「分」级逐科目守恒核验，比率型指标是 10^6 缩放的
 * 定点比率，公式项也是分子/分母而不是可相加的项，混进来会被下游的线性求值器
 * 当成加减法算出无意义的数。
 */
export function snapshotMetricDefinitions(db: DB, mappingVersionId: number): void {
  db.prepare('DELETE FROM finance_metric_term_snapshot WHERE mapping_version_id=?').run(mappingVersionId);
  db.prepare('DELETE FROM finance_metric_snapshot WHERE mapping_version_id=?').run(mappingVersionId);
  db.prepare(`
    INSERT INTO finance_metric_snapshot(mapping_version_id,metric_id,code,status)
    SELECT ?,id,code,status FROM report_metric WHERE kind='linear' ORDER BY id
  `).run(mappingVersionId);
  db.prepare(`
    INSERT INTO finance_metric_term_snapshot(mapping_version_id,metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order)
    SELECT ?,t.metric_id,t.source_type,t.source_account_id,t.source_metric_id,t.coefficient,t.sort_order
    FROM report_metric_term t JOIN report_metric m ON m.id=t.metric_id
    WHERE m.kind='linear' ORDER BY t.metric_id,t.sort_order,t.id
  `).run(mappingVersionId);
}

export function loadMetricDefinitions(db: DB, mappingVersionId: number): { metrics: MetricSnapshotRow[]; terms: MetricTermSnapshotRow[] } {
  const metrics = db.prepare('SELECT metric_id,code,status FROM finance_metric_snapshot WHERE mapping_version_id=? ORDER BY metric_id').all(mappingVersionId) as MetricSnapshotRow[];
  const terms = db.prepare('SELECT metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order FROM finance_metric_term_snapshot WHERE mapping_version_id=? ORDER BY metric_id,sort_order,id').all(mappingVersionId) as MetricTermSnapshotRow[];
  return { metrics, terms };
}
