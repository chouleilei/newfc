/**
 * 实际数编辑草稿(方案《易用性与直觉化交互实施方案》§4.3/§5.1,任务 UX-09、UX-10)。
 *
 * draft / view 分工:
 * - draft(本 hook 管理):整编辑目标的原值、精确原始金额、数量、明细备注、汇总备注、
 *   脏标记与保存基线。单元格值/备注由 useGridInteraction 持有,本 hook 负责基线采纳、
 *   汇总备注、脏项归并与「放弃=真正恢复基线」;
 * - view(页面 state):组织范围、科目表、筛选、折叠、列显示。调整 view 不触碰 draft。
 *
 * 编辑目标 = 年度 + 任务(current/history) + 历史截止日。目标切换由页面守卫编排,
 * 守卫完成后草稿必然干净,本 hook 随之载入新目标基线;后台 refetch 仅在无本地修改时
 * 才接受服务器基线,绝不覆盖在录内容。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cellValueEquivalent } from '../../utils/money';
import type { GridInteraction } from '../../hooks/useGridInteraction';

/** 实际数编辑任务:更新当前累计 / 补录历史快照(UX-08)。 */
export type ActualTask = 'current' | 'history';

/** 编辑目标:年度 + 任务 + 历史目标截止日;视图参数(组织/筛选/折叠/列)不属于目标。 */
export interface ActualDraftTarget {
  year: number;
  task: ActualTask;
  /** 仅历史任务有意义:用户显式选择的补录截止日;未选为 null(空白待补录)。 */
  historyCutoff: string | null;
}

export const actualTargetKey = (t: ActualDraftTarget): string =>
  `${t.year}:${t.task}:${t.task === 'history' ? (t.historyCutoff ?? '') : ''}`;

/** 目标的服务端基线:当前任务 = 服务器现有累计;历史任务 = 空白待补录(全空)。 */
export interface ActualDraftBaseline {
  /** orgId:accountId -> 万元/数量显示串 */
  values: Map<string, string>;
  /** orgId:accountId -> 明细备注 */
  notes: Map<string, string>;
  /** orgId:accountId -> 汇总格备注(仅当前任务支持) */
  summaryMemos: Map<string, string>;
}

export const EMPTY_BASELINE: ActualDraftBaseline = {
  values: new Map(),
  notes: new Map(),
  summaryMemos: new Map(),
};

export interface DraftDirtyItem {
  /** orgId:accountId */
  key: string;
  orgId: number;
  accountId: number;
  kind: 'value' | 'note' | 'summaryMemo';
  before: string;
  after: string;
  /** 是否在当前视图(可见科目行 × 可见组织列)内 */
  visible: boolean;
}

/**
 * 有效累计截止日(UX-08):显式选择优先;当前任务回落到服务器现有累计截止日;
 * 历史任务没有任何默认(必须显式选日期,不能把今天或最新月份自动当成本次业务期间)。
 */
export function resolveEffectiveCutoff(
  override: string | null,
  task: ActualTask,
  serverCutoff: string | null,
): string | null {
  if (override) return override;
  return task === 'current' ? serverCutoff : null;
}

export type SavePeriodIssue = {
  code: 'missing_cutoff' | 'earlier_than_current';
  message: string;
};

/** 保存前的期间校验(UX-08);返回 null 表示期间可提交(后端仍独立校验)。 */
export function checkSavePeriod(opts: {
  task: ActualTask;
  cutoff: string | null;
  /** 服务器现有累计截止日;本年度尚无实际时为 null */
  serverCutoff: string | null;
}): SavePeriodIssue | null {
  const { task, cutoff, serverCutoff } = opts;
  if (!cutoff) {
    return {
      code: 'missing_cutoff',
      message: task === 'history'
        ? '历史补录必须先选择要补充的历史截止日期'
        : '请先选择本次累计截止日期(本年度尚无已保存的累计实际，无默认期间)',
    };
  }
  if (task === 'current' && serverCutoff && cutoff < serverCutoff) {
    return {
      code: 'earlier_than_current',
      message: `普通更新的截止日不能早于当前累计截止日 ${serverCutoff}(早于该日期的数据请改用「补录历史快照」)`,
    };
  }
  return null;
}

/**
 * 归并草稿待保存项:网格脏格(值或明细备注) + 汇总备注差异。
 * before 取自当前基线(加载基线或上次保存发送内容),after 取自当前编辑态。
 */
export function collectDraftDirtyItems(opts: {
  dirtyKeys: ReadonlySet<string>;
  values: ReadonlyMap<string, string>;
  notes: ReadonlyMap<string, string>;
  baselineValues: ReadonlyMap<string, string>;
  baselineNotes: ReadonlyMap<string, string>;
  summaryMemos: ReadonlyMap<string, string>;
  baselineSummaryMemos: ReadonlyMap<string, string>;
  isCellKeyVisible: (key: string) => boolean;
  isSummaryKeyVisible: (key: string) => boolean;
}): DraftDirtyItem[] {
  const items: DraftDirtyItem[] = [];
  for (const key of opts.dirtyKeys) {
    const [orgId, accountId] = key.split(':').map(Number);
    const beforeV = opts.baselineValues.get(key) ?? '';
    const afterV = opts.values.get(key) ?? '';
    const beforeN = opts.baselineNotes.get(key) ?? '';
    const afterN = opts.notes.get(key) ?? '';
    const valueChanged = !cellValueEquivalent(beforeV, afterV);
    items.push({
      key,
      orgId,
      accountId,
      kind: valueChanged ? 'value' : 'note',
      before: valueChanged ? beforeV : beforeN,
      after: valueChanged ? afterV : afterN,
      visible: opts.isCellKeyVisible(key),
    });
  }
  const summaryKeys = new Set([...opts.summaryMemos.keys(), ...opts.baselineSummaryMemos.keys()]);
  for (const key of summaryKeys) {
    const before = opts.baselineSummaryMemos.get(key) ?? '';
    const after = opts.summaryMemos.get(key) ?? '';
    if (before === after) continue;
    const [orgId, accountId] = key.split(':').map(Number);
    items.push({ key, orgId, accountId, kind: 'summaryMemo', before, after, visible: opts.isSummaryKeyVisible(key) });
  }
  return items;
}

/** 可见/隐藏脏项计数(UX-09 统一提示「待保存修改共 N 项,其中 M 项不在当前视图」)。 */
export function summarizeDirtyItems(items: readonly DraftDirtyItem[]): { total: number; hidden: number } {
  return { total: items.length, hidden: items.filter((item) => !item.visible).length };
}

export function useActualDraft(opts: {
  grid: GridInteraction;
  target: ActualDraftTarget;
  /** null = 基线未就绪(加载中/加载失败),不采纳也不清空;历史任务由调用方传 EMPTY_BASELINE */
  baseline: ActualDraftBaseline | null;
  isCellKeyVisible: (key: string) => boolean;
  isSummaryKeyVisible: (key: string) => boolean;
}) {
  const { grid, target } = opts;
  const targetKey = actualTargetKey(target);

  /* ---------- 汇总备注(页面级,随整包保存同事务落库;历史任务只读不支持) ---------- */
  const [summaryMemos, setSummaryMemos] = useState<Map<string, string>>(new Map());
  const summaryPristineRef = useRef<Map<string, string>>(new Map());
  /* 基线前移发生在 ref 上(markSaved/discard/采纳),用版本号驱动 dirty 重算 */
  const [summaryPristineVersion, setSummaryPristineVersion] = useState(0);
  const advanceSummaryPristine = useCallback((next: Map<string, string>) => {
    summaryPristineRef.current = next;
    setSummaryPristineVersion((v) => v + 1);
  }, []);
  const summaryMemosRef = useRef(summaryMemos);
  summaryMemosRef.current = summaryMemos;
  const summaryMemosDirty = useMemo(() => {
    const pristine = summaryPristineRef.current;
    if (pristine.size !== summaryMemos.size) return true;
    for (const [k, v] of summaryMemos) if (pristine.get(k) !== v) return true;
    return false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryMemos, summaryPristineVersion]);
  const summaryMemosDirtyRef = useRef(summaryMemosDirty);
  summaryMemosDirtyRef.current = summaryMemosDirty;

  const setSummaryMemo = useCallback((key: string, text: string) => {
    setSummaryMemos((prev) => {
      const next = new Map(prev);
      if (text) next.set(key, text);
      else next.delete(key);
      return next;
    });
  }, []);

  /* ---------- 服务器基线采纳:仅在没有本地修改时接受;refetch 不得覆盖本地编辑 ---------- */
  const baselineRef = useRef<ActualDraftBaseline | null>(null);
  baselineRef.current = opts.baseline;
  const gridRef = useRef(grid);
  gridRef.current = grid;
  useEffect(() => {
    const baseline = opts.baseline;
    if (!baseline) return;
    const g = gridRef.current;
    if (g.dirty || summaryMemosDirtyRef.current) return;
    // 值与当前内容一致(仅显示格式差异)时不重置——保留撤销栈("保存不清栈"承诺)
    const values = g.values;
    let same = baseline.values.size === values.size;
    if (same) {
      for (const [k, v] of baseline.values) {
        if (!values.has(k) || !cellValueEquivalent(values.get(k) ?? '', v)) { same = false; break; }
      }
    }
    let sameNotes = baseline.notes.size === g.notes.size;
    if (sameNotes) {
      for (const [k, v] of baseline.notes) {
        if ((g.notes.get(k) ?? '') !== v) { sameNotes = false; break; }
      }
    }
    let sameSummary = baseline.summaryMemos.size === summaryMemosRef.current.size;
    if (sameSummary) {
      for (const [k, v] of baseline.summaryMemos) {
        if (summaryMemosRef.current.get(k) !== v) { sameSummary = false; break; }
      }
    }
    // 明细与汇总备注独立比对、独立重置:仅汇总备注变化不清空网格撤销栈
    if (!same || !sameNotes) {
      g.resetData(baseline.values, new Map(), baseline.notes);
      if (!sameSummary) {
        advanceSummaryPristine(new Map(baseline.summaryMemos));
        setSummaryMemos(new Map(baseline.summaryMemos));
      }
      // 焦点位置记忆恢复(等待渲染完成)
      const t = setTimeout(() => gridRef.current.restoreFocus(), 250);
      return () => clearTimeout(t);
    }
    if (!sameSummary) {
      advanceSummaryPristine(new Map(baseline.summaryMemos));
      setSummaryMemos(new Map(baseline.summaryMemos));
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.baseline, targetKey]);

  /** 放弃修改:真正恢复基线(网格值/备注与汇总备注全部回滚),不只是清脏标记(UX-10)。 */
  const discardToBaseline = useCallback(() => {
    const baseline = baselineRef.current ?? EMPTY_BASELINE;
    gridRef.current.resetData(new Map(baseline.values), new Map(), new Map(baseline.notes));
    advanceSummaryPristine(new Map(baseline.summaryMemos));
    setSummaryMemos(new Map(baseline.summaryMemos));
  }, [advanceSummaryPristine]);

  /**
   * 保存成功:网格基线前移到本次发送内容(仅附注未落库的格子保持脏标记);
   * advanceSummary 仅当前任务为 true(历史补录不携带汇总备注,其基线不前移)。
   */
  const markSaved = useCallback((exceptKeys?: ReadonlySet<string>, advanceSummary = true) => {
    gridRef.current.markSaved(exceptKeys);
    if (advanceSummary) advanceSummaryPristine(new Map(summaryMemosRef.current));
  }, [advanceSummaryPristine]);

  /* ---------- 可见/隐藏待保存项(UX-09) ---------- */
  const dirtyItems = useMemo(
    () => collectDraftDirtyItems({
      dirtyKeys: grid.dirtyKeys,
      values: grid.values,
      notes: grid.notes,
      baselineValues: opts.baseline?.values ?? EMPTY_BASELINE.values,
      baselineNotes: opts.baseline?.notes ?? EMPTY_BASELINE.notes,
      summaryMemos,
      baselineSummaryMemos: summaryPristineRef.current,
      isCellKeyVisible: opts.isCellKeyVisible,
      isSummaryKeyVisible: opts.isSummaryKeyVisible,
    }),
    // summaryPristineRef 仅在 markSaved/discard/基线采纳时变化,均伴随 grid 或 summaryMemos 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [grid.dirtyKeys, grid.values, grid.notes, summaryMemos, summaryMemosDirty, opts.baseline, opts.isCellKeyVisible, opts.isSummaryKeyVisible],
  );
  const { total: totalDirty, hidden: hiddenDirty } = useMemo(() => summarizeDirtyItems(dirtyItems), [dirtyItems]);

  return {
    summaryMemos,
    setSummaryMemo,
    summaryMemosDirty,
    dirtyItems,
    /** 待保存修改总数(网格脏格 + 汇总备注差异) */
    totalDirty,
    /** 其中不在当前视图的条数 */
    hiddenDirty,
    anyDirty: totalDirty > 0,
    discardToBaseline,
    markSaved,
  };
}

export type ActualDraft = ReturnType<typeof useActualDraft>;
