import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api/client';
import { errorText } from '../../components/TreeNodePage';
import { centsToYuan, wanToCents, quantitySchema, cellValueEquivalent } from '../../utils/money';
import { isAccountVisibleForScope } from '../../utils/accountScope';
import { invalidateAnalysisQueries } from '../../utils/queryInvalidation';
import type { GridInteraction } from '../../hooks/useGridInteraction';
import { buildPristineBudgetValues, buildPristineCellNotes, type MatrixResponse } from './types';
import {
  captureBaseline,
  baselineFromSave,
  type ConflictBaseline,
} from './conflictRecovery';

type PristineBudget = ReturnType<typeof buildPristineBudgetValues>;

export type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'invalid';

export type DraftSnapshot = {
  values: Map<string, string>;
  formulas: Map<string, string>;
  notes: Map<string, string>;
  /** 汇总格备注(非叶子组织列/非叶子科目行),页面级状态随整包一并保存 */
  summaryNotes: Map<string, string>;
};

export interface SavePayload {
  entries: { orgId: number; accountId: number; amount?: string; quantity?: string; formula?: string; note?: string }[];
  skippedScope: number;
  cellNotes: { orgId: number; accountId: number; note: string }[];
}

/**
 * 预算页专用保存编排:自动保存防抖、Ctrl/Cmd+S 立即排空保存、串行保存队列、
 * 失败/格式错误/并发冲突的持续状态,以及互斥动作(导入/定稿/编制记录)前的排空。
 * 「保存草稿」与「记录本轮修改」在此彻底分离:本 hook 不创建任何编制记录。
 */
export function useBudgetSaveOrchestration(opts: {
  versionId: number;
  data: MatrixResponse | undefined;
  editable: boolean;
  draftActionPending: boolean;
  /** 网格脏标记(汇总格备注脏标记由 hook 内部合并) */
  dirty: boolean;
  invalidCount: number;
  values: Map<string, string>;
  formulas: Map<string, string>;
  notes: Map<string, string>;
  summaryNotes: Map<string, string>;
  setSummaryNotes: (next: Map<string, string>) => void;
  markPersisted: GridInteraction['markPersisted'];
  resetData: GridInteraction['resetData'];
  refreshSummary: () => Promise<void>;
}) {
  const {
    versionId, data, editable, draftActionPending, dirty, invalidCount,
    values, formulas, notes, summaryNotes, setSummaryNotes,
    markPersisted, resetData, refreshSummary,
  } = opts;
  const { message } = App.useApp();
  const qc = useQueryClient();

  const [autoSaveState, setAutoSaveState] = useState<SaveState>('idle');
  const [lastAutoSavedAt, setLastAutoSavedAt] = useState<Date | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  /** 持续可见的保存失败原因;成功或冲突处理后清除,不依赖转瞬即逝的 toast */
  const [saveError, setSaveError] = useState<string | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const savePendingCountRef = useRef(0);
  const revisionRef = useRef<number | null>(null);
  /** 冲突三方比较的精确基线:最后一次与服务器一致的矩阵状态(加载/保存成功/恢复采纳时更新) */
  const baselineRef = useRef<ConflictBaseline | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDraftRef = useRef<DraftSnapshot & { dirty: boolean; invalidCount: number }>({
    values: new Map(), formulas: new Map(), notes: new Map(), summaryNotes: new Map(), dirty: false, invalidCount: 0,
  });

  const summaryNotesPristineRef = useRef<Map<string, string>>(new Map());
  const summaryNotesDirty = useMemo(() => {
    const pristine = summaryNotesPristineRef.current;
    if (pristine.size !== summaryNotes.size) return true;
    for (const [k, v] of summaryNotes) if (pristine.get(k) !== v) return true;
    return false;
  }, [summaryNotes]);
  const summaryNotesRef = useRef(summaryNotes);
  const summaryNotesDirtyRef = useRef(summaryNotesDirty);
  summaryNotesRef.current = summaryNotes;
  summaryNotesDirtyRef.current = summaryNotesDirty;
  /** 网格脏标记或汇总格备注脏标记:离开拦截/自动保存/数据回读守卫统一按合并口径 */
  const anyDirty = dirty || summaryNotesDirty;

  latestDraftRef.current = { values, formulas, notes, summaryNotes, dirty, invalidCount };

  // 切换版本时清空保存编排状态,避免旧版本的基线/冲突状态串到新草稿;
  // 保存队列不重置:旧版本在途保存仍按序完成(markPersisted 只作用网格基线)
  useEffect(() => {
    revisionRef.current = null;
    baselineRef.current = null;
    setSaveConflict(false);
    setSaveError(null);
    setAutoSaveState('idle');
    setLastAutoSavedAt(null);
    summaryNotesPristineRef.current = new Map();
    setSummaryNotes(new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId]);

  /* 冲突基线捕获:仅在本地无未保存修改、无冲突、无在途保存时采纳查询返回的服务器矩阵。
     有脏输入时绝不前进基线——三方比较的“编辑基线”必须是本地修改共同针对的那份服务器状态。 */
  useEffect(() => {
    if (!data || anyDirty || saveConflict || savePendingCountRef.current > 0) return;
    baselineRef.current = captureBaseline(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, anyDirty, saveConflict]);

  const buildSavePayload = useCallback((snapshot: DraftSnapshot, onlyKeys?: ReadonlySet<string>, pristineOverride?: PristineBudget): SavePayload => {
    const accById = new Map((data?.accountNodes ?? []).map((n) => [n.id, n]));
    const pristine = pristineOverride ?? (data ? buildPristineBudgetValues(data) : undefined);
    const entries: SavePayload['entries'] = [];
    let skippedScope = 0;
    const cellKeys = new Set([...snapshot.values.keys(), ...snapshot.formulas.keys(), ...snapshot.notes.keys()].filter((key) => !onlyKeys || onlyKeys.has(key)));
    for (const key of cellKeys) {
      const display = snapshot.values.get(key) ?? '';
      const [orgId, accountId] = key.split(':').map(Number);
      const acc = accById.get(accountId);
      const formula = snapshot.formulas.get(key)?.trim() || undefined;
      const note = snapshot.notes.get(key)?.trim() || undefined;
      // 科目-组织适用范围与实际数侧同口径:跳过无效组合(后端已强校验),
      // 整包替换模式下这些存量行随之清理
      const orgCode = data?.orgNodes.find((n) => n.id === orgId)?.code;
      if (!acc || !orgCode || !isAccountVisibleForScope(acc.code, new Set([orgCode]))) {
        if (display.trim() !== '') skippedScope++;
        continue;
      }
      // 未编辑过的格子直接回传服务端原始精度:万元两位小数显示会把 <50 元的存量值
      // 舍入成 0.00,重新解析再保存会静默删除这些行
      const orig = pristine ? pristine.origByKey.get(key) : undefined;
      const untouched = pristine != null && orig != null && cellValueEquivalent(display, pristine.values.get(key) ?? '');
      if (acc.type === 'quantity') {
        const q = untouched ? (orig.quantity ?? '') : display.trim();
        if (q === '') {
          // 留空但带附注/公式:按 0 提交保留附注(后端 keepEntry 明确保留零值测算依据);
          // 全空则跳过(整包替换下即删除语义)。自动保存路径绝不 throw。
          if (formula || note) entries.push({ orgId, accountId, quantity: '0', formula, note });
          continue;
        }
        // 非空非法值在写入时已标红并拦截自动保存;此处防御性跳过而非 throw
        if (!quantitySchema.safeParse(q).success) continue;
        entries.push({ orgId, accountId, quantity: q, formula, note });
        continue;
      }
      if (untouched && orig.amountDisplay !== '') {
        entries.push({ orgId, accountId, amount: orig.amountDisplay, formula, note });
        continue;
      }
      const trimmed = display.trim();
      if (trimmed === '') {
        // 金额留空但带附注/公式:按 0 提交保留附注;全空跳过(删除语义)
        if (formula || note) entries.push({ orgId, accountId, amount: centsToYuan(0), formula, note });
        continue;
      }
      const cents = wanToCents(trimmed);
      // 非空非法值在写入时已标红(invalidCells)并拦截自动保存;此处防御性跳过而非 throw,
      // 避免自动保存链被单个坏格子打断且无任何格子定位
      if (cents == null) continue;
      if (cents === 0 && !formula && !note) continue;
      entries.push({ orgId, accountId, amount: centsToYuan(cents), formula, note });
    }
    // 汇总格备注整包提交(空备注不提交 = 删除;onlyKeys 模式下不影响,草稿序列化只取 entries)
    const cellNotes: SavePayload['cellNotes'] = [];
    for (const [key, raw] of snapshot.summaryNotes) {
      const note = raw.trim();
      if (!note) continue;
      const [orgId, accountId] = key.split(':').map(Number);
      cellNotes.push({ orgId, accountId, note });
    }
    return { entries, skippedScope, cellNotes };
  }, [data]);

  /** 所有整包保存严格串行，避免较早请求后到达并覆盖较新的草稿。
   *  opts.expectedRevision: 冲突恢复保存显式指定基线修订(刚采纳的服务器矩阵);
   *  opts.pristine: 冲突恢复保存以服务器最新矩阵做"未编辑直通"基准,避免用旧 data 破坏服务器新值的原始精度。 */
  const enqueueSave = useCallback((snapshot: DraftSnapshot, opts?: { expectedRevision?: number; pristine?: PristineBudget }): Promise<void> => {
    let payload: SavePayload;
    try {
      payload = buildSavePayload(snapshot, undefined, opts?.pristine);
    } catch (e) {
      setAutoSaveState('invalid');
      setSaveError(errorText(e));
      message.error(errorText(e));
      return Promise.reject(e);
    }
    savePendingCountRef.current += 1;
    setAutoSaveState('saving');
    const task = saveChainRef.current.catch(() => undefined).then(async () => {
      let succeeded = false;
      try {
        if (saveConflict) throw new Error('草稿存在并发冲突，请先刷新服务器版本');
        const expectedRevision = opts?.expectedRevision ?? revisionRef.current;
        if (expectedRevision == null) throw new Error('预算草稿修订基线尚未加载');
        const result = await api.put<{ saved: number; deleted: number; revision: number }>(`/versions/${versionId}/entries`, {
          entries: payload.entries,
          cellNotes: payload.cellNotes,
          expectedRevision,
        });
        revisionRef.current = result.revision;
        // 整包替换语义:保存成功后服务器状态 = 本次实际提交内容,基线同步推进(精确值)
        baselineRef.current = baselineFromSave(result.revision, payload, (accountId) => data?.accountNodes.find((n) => n.id === accountId)?.type);
        markPersisted(snapshot.values, snapshot.formulas, snapshot.notes);
        summaryNotesPristineRef.current = new Map(snapshot.summaryNotes);
        setLastAutoSavedAt(new Date());
        setSaveError(null);
        succeeded = true;
        if (payload.skippedScope > 0) {
          message.warning(`已跳过 ${payload.skippedScope} 条不适用于当前组织的科目组合`);
        }
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['budget-matrix', versionId] }),
          qc.invalidateQueries({ queryKey: ['budget-checkpoints', versionId] }),
          qc.invalidateQueries({ queryKey: ['budget-quality', versionId] }),
          refreshSummary(),
          invalidateAnalysisQueries(qc),
        ]);
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setSaveConflict(true);
          setSaveError(null);
          message.error('检测到其他页面已修改该草稿，已停止自动保存');
        } else {
          setSaveError(errorText(e));
          message.error(`自动保存失败：${errorText(e)}`);
        }
        throw e;
      } finally {
        savePendingCountRef.current = Math.max(0, savePendingCountRef.current - 1);
        if (savePendingCountRef.current > 0) setAutoSaveState('saving');
        else setAutoSaveState(succeeded ? 'saved' : 'error');
      }
    });
    saveChainRef.current = task;
    return task;
  }, [buildSavePayload, data, markPersisted, message, qc, refreshSummary, saveConflict, versionId]);

  const persistLatest = useCallback(() => {
    const latest = latestDraftRef.current;
    return enqueueSave({
      values: new Map(latest.values),
      formulas: new Map(latest.formulas),
      notes: new Map(latest.notes),
      summaryNotes: new Map(latest.summaryNotes),
    });
  }, [enqueueSave]);

  /* ---------- 草稿自动保存:约 1.3 秒防抖,输入停止后落库 ---------- */
  useEffect(() => {
    if (!editable || draftActionPending || saveConflict || !anyDirty) return;
    if (invalidCount > 0) {
      setAutoSaveState('invalid');
      return;
    }
    autoSaveTimerRef.current = setTimeout(() => {
      autoSaveTimerRef.current = null;
      void persistLatest().catch(() => undefined);
    }, 1300);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    };
  }, [anyDirty, draftActionPending, editable, formulas, invalidCount, notes, persistLatest, saveConflict, summaryNotes, values]);

  const cancelPendingTimer = useCallback(() => {
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  /** 互斥写操作前停止防抖并排空保存队列，避免旧整包草稿晚到覆盖新状态。 */
  const drainDraftSaves = useCallback(async () => {
    cancelPendingTimer();
    const latest = latestDraftRef.current;
    if (latest.invalidCount > 0) throw new Error('存在格式错误，请先修正后再继续');
    // 防抖窗口内的最新网格(含汇总格备注)尚未入队；导入/定稿/记录前必须强制将它入队。
    if (latest.dirty || summaryNotesDirtyRef.current) await persistLatest();
    await saveChainRef.current;
  }, [cancelPendingTimer, persistLatest]);

  /** 清空等整包替换动作:仅等待在途保存结束,不先把本地草稿再写一遍。 */
  const waitForInFlightSaves = useCallback(async () => {
    cancelPendingTimer();
    await saveChainRef.current;
  }, [cancelPendingTimer]);

  /** Ctrl/Cmd+S 与「保存」按钮:立即排空防抖并保存最新输入,不弹任何记录命名框。 */
  const requestSaveNow = useCallback(() => {
    if (!editable || draftActionPending) return;
    if (saveConflict) {
      message.warning('草稿存在并发冲突，已停止保存；请先在页面顶部处理冲突提示');
      return;
    }
    cancelPendingTimer();
    const latest = latestDraftRef.current;
    if (latest.invalidCount > 0) {
      setAutoSaveState('invalid');
      message.warning(`有 ${latest.invalidCount} 处格式错误，已暂停保存；修正标红单元格后自动恢复`);
      return;
    }
    if (!latest.dirty && !summaryNotesDirtyRef.current) {
      message.info('所有修改已保存');
      return;
    }
    void persistLatest().catch(() => undefined);
  }, [cancelPendingTimer, draftActionPending, editable, message, persistLatest, saveConflict]);

  /* ---------- 全局快捷键: Ctrl/Cmd+S 立即保存草稿(不生成编制记录) ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        requestSaveNow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [requestSaveNow]);

  /** 在保存队列之后串行执行互斥任务(如生成编制记录),后续保存自动排在其后。 */
  const runAfterSaves = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const task = saveChainRef.current.catch(() => undefined).then(fn);
    saveChainRef.current = task.then(() => undefined, () => undefined);
    return task;
  }, []);

  const reloadAfterConflict = useCallback(async () => {
    const server = await api.get<MatrixResponse>(`/versions/${versionId}/matrix`);
    const pristine = buildPristineBudgetValues(server);
    revisionRef.current = server.version.revision;
    baselineRef.current = captureBaseline(server);
    qc.setQueryData(['budget-matrix', versionId], server);
    resetData(pristine.values, pristine.formulas, pristine.notes);
    const serverNotes = buildPristineCellNotes(server);
    summaryNotesPristineRef.current = serverNotes;
    setSummaryNotes(serverNotes);
    saveChainRef.current = Promise.resolve();
    setSaveConflict(false);
    setSaveError(null);
    setAutoSaveState('idle');
    message.success('已加载服务器最新草稿');
  }, [message, qc, resetData, setSummaryNotes, versionId]);

  /* ---------- UX-20/UX-21 冲突恢复:三方比较 + 基于最新基线应用选定恢复项 ---------- */

  /**
   * 采纳刚拉取的服务器最新矩阵为冲突恢复基线(不覆盖网格):
   * 前进 revision/精确基线、更新查询缓存(供科目/组织/范围判定),解除冲突锁使 applyCells 可用。
   */
  const beginConflictResolution = useCallback((server: MatrixResponse) => {
    revisionRef.current = server.version.revision;
    baselineRef.current = captureBaseline(server);
    qc.setQueryData(['budget-matrix', versionId], server);
    setSaveConflict(false);
    setSaveError(null);
  }, [qc, versionId]);

  /**
   * 冲突恢复保存:只保存合并后的草稿(服务器最新值 + 用户选定的本地修改),
   * 以刚采纳的服务器 revision 为 expectedRevision;服务器期间又被修改(409)时重新进入冲突流程。
   */
  const saveResolvedDraft = useCallback((snapshot: DraftSnapshot, expectedRevision: number, pristine: PristineBudget): Promise<void> => {
    return enqueueSave(snapshot, { expectedRevision, pristine });
  }, [enqueueSave]);

  /** 恢复应用中途发现非法内容:重新进入冲突状态,保持自动保存暂停 */
  const reenterConflict = useCallback(() => {
    setSaveConflict(true);
  }, []);

  return {
    // 状态
    autoSaveState, lastAutoSavedAt, saveConflict, saveError, anyDirty, summaryNotesDirty,
    // 引用(页面基线守卫/序列化读取同一份)
    latestDraftRef, revisionRef, baselineRef, savePendingCountRef, summaryNotesPristineRef, summaryNotesRef, summaryNotesDirtyRef,
    // 动作
    buildSavePayload, persistLatest, drainDraftSaves, waitForInFlightSaves, requestSaveNow, runAfterSaves, reloadAfterConflict,
    // 冲突恢复(UX-20/UX-21)
    beginConflictResolution, saveResolvedDraft, reenterConflict,
  };
}
