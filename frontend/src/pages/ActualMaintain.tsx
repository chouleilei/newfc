import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Space, Button, App, Tag, Typography, Popconfirm, Tooltip, Modal, Input, Alert } from 'antd';
import { EnhancedTable as Table } from '../components/EnhancedTable';
import dayjs from 'dayjs';
import { Link, useBlocker, useSearchParams } from 'react-router-dom';
import { api, download } from '../api/client';
import type { ActualSavePayload } from '../api/actual';
import { errorText } from '../components/TreeNodePage';
import { wanToCents, centsToYuan, quantitySchema, cellValueEquivalent } from '../utils/money';
import { findSheet, pickWritableSheet, isWritableSheet, useSheets } from '../utils/sheets';
import { isAccountVisibleForScope } from '../utils/accountScope';
import { invalidateAnalysisQueries } from '../utils/queryInvalidation';
import { useGridInteraction } from '../hooks/useGridInteraction';
import { useSummaryNoteUndo } from '../hooks/useSummaryNoteUndo';
import { useFullscreenLayer } from '../hooks/useFullscreenLayer';
import { GridStatusBar, GridFindReplace, PasteSpecialModal, GridContextMenu, useSessionState, loadSession, saveSession } from '../components/GridAddons';
import type { MenuProps } from 'antd';
import {
  type VersionRow, type MetricItem, type Batch, type YearData, type OrgTreeResponse, type AccountTreeResponse,
  type GridRow, type AccRow, SOURCE_LABEL, buildPristineActualValues, buildPristineActualMemos, buildPristineActualCellNotes,
} from './actualMaintain/types';
import { useYearMatrices } from './actualMaintain/useYearMatrices';
import { useActualModel } from './actualMaintain/useActualModel';
import { useActualTotals } from './actualMaintain/useActualTotals';
import {
  useActualDraft, EMPTY_BASELINE, resolveEffectiveCutoff, checkSavePeriod,
  type ActualTask, type ActualDraftBaseline, type ActualDraftTarget,
} from './actualMaintain/useActualDraft';
import { PeriodSummary } from './actualMaintain/PeriodSummary';
import {
  useActualSaveOrchestration, newSaveRequestId,
  type ActualSaveMeta, type ActualSaveOutcome,
} from './actualMaintain/useActualSaveOrchestration';
import { PendingChangesModal } from './actualMaintain/PendingChangesModal';
import { ActualHeaderActions } from './actualMaintain/ActualHeaderActions';
import { ActualToolbars } from './actualMaintain/ActualToolbars';
import { TemplateModal } from './actualMaintain/TemplateModal';
import { AddYearModal } from './actualMaintain/AddYearModal';
import { ActualGridTable } from './actualMaintain/ActualGridTable';
import { HistoryImport } from './actualMaintain/HistoryImport';
import { useAssistantFocus, useAssistantPageContext, useAssistantSelection, useAssistantSurface } from '../assistant/contextHooks';
import { DraftDescriptor } from '../assistant/context';
import { useUrlScopeSync } from '../hooks/useUrlScopeSync';
import { resolveActualMode, buildScopeSearch, type ScopeIssue, type ScopeParseResult } from '../utils/workspaceScope';
import WorkspaceScopeBar from '../components/WorkspaceScopeBar';
import { TableSkeleton } from '../components/Skeletons';
import { useThemeMode, statusColor, financeColor } from '../theme';

/**
 * 历史数据维护:科目按行 ×「多组织横向展开 / 多年趋势对比」双视图。
 * 数据来自各年度当前生效版本的预算明细 + 当前累计实际,前端按组织范围汇总;
 * 行列模型/汇总计算/表格渲染/弹窗拆分在 ./actualMaintain/ 下,本文件负责装配与保存编排。
 *
 * UX-09 草稿/视图解耦:draft(整目标的值、备注、汇总备注、脏标记与保存基线)由
 * useActualDraft 持有;view(组织范围、科目表、筛选、折叠、列显示)是本文件 state,
 * 调整 view 绝不重置 draft。编辑目标 = 年度 + 任务(current/history) + 历史截止日;
 * UX-10 目标切换统一走三选一守卫(留在本页 / 保存并切换 / 放弃修改并切换)。
 * UX-12 保存编排:所有保存入口共用 useActualSaveOrchestration——提交前固定请求内容并
 * 生成请求编号 requestId;提交在途与「结果待核对」期间锁定编辑目标;响应丢失先查回执,
 * 已提交按成功处理,未提交可同编号重试(不重复生成快照),回执未确认前不提示成功、不放行守卫。
 */

/** 保存成功结果展示(UX-12):快照批次 + 对应年度分析入口 */
interface ActualSaveSuccessInfo {
  batchId: number;
  saved: number;
  deleted: number;
  cellNotesSaved: number;
  cellNotesDeleted: number;
  replayed: boolean;
  /** true = 响应曾丢失,经保存回执核对确认已提交 */
  viaReceipt: boolean;
  year: number;
  history: boolean;
  snapshotDate: string;
}

/** 本会话最近使用的报表(UX-31 遗留):下次进入回到同一张表,与预算页的视图记忆同语义 */
const ACTUAL_SHEET_KEY = 'newfc-actual-sheet';

export default function ActualMaintain() {
  const { mode } = useThemeMode();
  const sc = statusColor(mode);
  const fc = financeColor(mode);
  /* 徽标浅底由本色 12%/30% 派生,亮暗自换挡(不新增色相) */
  const softBg = (c: string, pct = 12) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [searchParams] = useSearchParams();
  /**
   * 当前报表。空串 = 尚未落定,由下方「默认落点」效应在预设表就绪后选定
   * (URL 显式 ?sheet= 优先,其次本会话最近使用,最后是首张可填写预设表)。
   * 不预置 'profit':利润表只有指标计算行,新用户首次进入没有任何输入格。
   */
  const [sheetKey, setSheetKey] = useState<string>(() => loadSession<string>(ACTUAL_SHEET_KEY, ''));
  const [orgScopeId, setOrgScopeId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'orgs' | 'years'>('orgs');
  const [editYear, setEditYear] = useState<number>(new Date().getFullYear());
  /** 编辑任务:更新当前实际 / 补录历史快照(UX-08,替代原隐蔽复选框);不按年度隐式推断 */
  const [historyMode, setHistoryMode] = useState(false);
  const task: ActualTask = historyMode ? 'history' : 'current';
  /**
   * 用户显式选择的累计截止日(按目标年度+任务打标,目标切换后自动失效)。
   * 不再默认今天/年末:当前任务回落到服务器现有累计截止日,历史任务保持空白待选(UX-08)。
   */
  const [cutoffSel, setCutoffSel] = useState<{ year: number; task: ActualTask; date: string } | null>(null);
  const [keyword, setKeyword] = useState('');
  const [nonZeroOnly, setNonZeroOnly] = useState(false);
  const [activeRowId, setActiveRowId] = useState<number | null>(null);
  const [collapseLevel, setCollapseLevel] = useState<number | null>(null);
  const { sheets: dbSheets, loading: sheetsLoading } = useSheets();

  // 手感增强 UI 状态:查找 / 选择性粘贴 / 右键菜单 / 行密度
  const [findState, setFindState] = useState<{ open: boolean; mode: 'find' | 'replace' }>({ open: false, mode: 'find' });
  const [pasteSpecialOpen, setPasteSpecialOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ open: boolean; x: number; y: number; r: number; c: number }>({ open: false, x: 0, y: 0, r: 0, c: 0 });
  const [density, setDensity] = useSessionState<'compact' | 'standard' | 'relaxed'>('newfc-actual-density', 'compact');
  const [fullscreen, setFullscreen] = useState(false);
  const exitFullscreen = useCallback(() => setFullscreen(false), []);
  useFullscreenLayer(fullscreen, exitFullscreen);

  // 自定义新增的历史年份列表
  const [customYears, setCustomYears] = useState<number[]>([]);
  const [addYearModalOpen, setAddYearModalOpen] = useState(false);
  const [newYearInput, setNewYearInput] = useState<number>(new Date().getFullYear() - 5);

  // 模板下载配置弹窗 / 全部待保存项弹窗
  const [tplModalOpen, setTplModalOpen] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [reopenReason, setReopenReason] = useState('');

  /* ---------- UX-12 保存编排:幂等提交 + 结果未知恢复(单在途请求) ---------- */
  const saveOrch = useActualSaveOrchestration();
  /** 提交在途(供按钮 loading / 快捷键判断) */
  const saving = saveOrch.submitting;
  /**
   * 提交在途或存在待核对提交时锁定该实际编辑目标(输入禁用):
   * 保证重试内容与首次提交逐字节一致、成功后 markSaved 基线前移等于发送内容。
   */
  const saveTargetLocked = saving || saveOrch.pending != null;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  /** UX-13:导入进行中(预览待确认/清洗向导打开)锁定编辑目标,避免手工输入与导入写入并发覆盖 */
  const [importBusy, setImportBusy] = useState(false);
  const importBusyRef = useRef(false);
  importBusyRef.current = importBusy;
  /** 最近一次保存成功结果(快照批次 + 分析入口),关闭前持续可见 */
  const [saveResult, setSaveResult] = useState<ActualSaveSuccessInfo | null>(null);

  const { data: orgTree } = useQuery({ queryKey: ['tree', 'org'], staleTime: 300_000, queryFn: ({ signal }) => api.get<OrgTreeResponse>('/org/tree', { signal }) });
  const { data: accTree } = useQuery({ queryKey: ['tree', 'account'], staleTime: 300_000, queryFn: ({ signal }) => api.get<AccountTreeResponse>('/account/tree', { signal }) });
  const { data: metrics } = useQuery({ queryKey: ['metrics'], staleTime: 300_000, queryFn: ({ signal }) => api.get<{ items: MetricItem[] }>('/metrics', { signal }) });
  const { data: versions } = useQuery({ queryKey: ['versions'], queryFn: ({ signal }) => api.get<VersionRow[]>('/versions', { signal }) });
  const { data: yearStates } = useQuery({ queryKey: ['actual-years'], queryFn: ({ signal }) => api.get<{ year: number; status: string }[]>('/actual/years', { signal }) });
  const { data: batches } = useQuery({ queryKey: ['batches', editYear], queryFn: ({ signal }) => api.get<Batch[]>(`/actual/batches?year=${editYear}`, { signal }) });

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    const s = new Set<number>(versions?.map((v) => v.year) ?? []);
    (yearStates ?? []).forEach((y) => s.add(y.year));
    // 默认展示近5年 (例如 2022, 2023, 2024, 2025, 2026)
    for (let offset = 4; offset >= 0; offset--) {
      s.add(currentYear - offset);
    }
    customYears.forEach((y) => s.add(y));
    return [...s].sort((a, b) => a - b);
  }, [versions, yearStates, customYears]);

  useEffect(() => {
    if (years.length && !years.includes(editYear)) setEditYear(years[years.length - 1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [years]);

  /** 各年度数据:当前生效版本(无则最新锁定/归档)预算 + 当前累计实际 */
  const yearData = useYearMatrices(years, versions, editYear, viewMode);

  /** 编辑年度实际值(整年全组织,保存整包替换,不会误删未展示组织的数据) */
  const editYearData = yearData[editYear];
  const frozen = editYearData?.actualFrozen ?? false;
  /** 预算矩阵是独立请求:任何可见年度失败都要显式提示,不能把失败当作「预算为空」 */
  const budgetLoadErrorYears = years.filter((y) => yearData[y]?.budgetLoadStatus === 'error');

  /* ---------- 行列模型(组织树索引 + 多级组织列 + 预设表科目行) ---------- */
  const model = useActualModel(orgTree, accTree, metrics, sheetKey, dbSheets, orgScopeId);
  const { orgIndex, effectiveScopeId, scopeLeaves, scopeLeafSet, singleLeafScope, orgDisplayCols, collapsedOrgCols, toggleCollapseOrgCol, scopeLeafOrgCodes, accIndex, accById, orgTreeData, rows } = model;
  const [visibleOrgLeafIds, setVisibleOrgLeafIds] = useState<number[]>([]);
  const handleVisibleOrgLeafIdsChange = useCallback((next: number[]) => {
    setVisibleOrgLeafIds((current) => current.length === next.length && current.every((orgId, index) => orgId === next[index]) ? current : next);
  }, []);

  /* ---------- 取值与汇总(叶子组织×(年度,方向)科目树汇总缓存) ---------- */
  const totals = useActualTotals({ years, yearData, scopeLeaves, accIndex, orgIndex, metrics, sheetKey, dbSheets });
  const { displayOf, displayOfOrg } = totals;

  const visibleRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rows.filter((r) => {
      if (collapseLevel != null && r.kind === 'account' && r.depth > collapseLevel) return false;
      const text = r.label ? `${r.code} ${r.name} ${r.label}` : `${r.code} ${r.name}`;
      if (kw && !text.toLowerCase().includes(kw)) return false;
      if (nonZeroOnly) {
        if (viewMode === 'years') {
          if (!years.some((y) => displayOf(r, y, 'budget') !== '' || displayOf(r, y, 'actual') !== '')) return false;
        } else {
          if (!orgDisplayCols.some((c) => displayOfOrg(r, editYear, c.leafIds, 'actual') !== '')) return false;
        }
      }
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, keyword, nonZeroOnly, collapseLevel, years, viewMode, orgDisplayCols, editYear, displayOf, displayOfOrg]);

  /* ---------- 累计截止日(UX-08):显式选择 > 当前任务的服务器截止;历史任务无默认 ---------- */
  const serverCutoff = editYearData?.actualCutoff ?? null;
  const cutoffOverride = cutoffSel && cutoffSel.year === editYear && cutoffSel.task === task ? cutoffSel.date : null;
  const effectiveCutoff = resolveEffectiveCutoff(cutoffOverride, task, serverCutoff);
  /** 编辑目标 = 年度 + 任务 + 历史截止日(UX-09);视图参数不属于目标 */
  const target: ActualDraftTarget = useMemo(
    () => ({ year: editYear, task, historyCutoff: historyMode ? effectiveCutoff : null }),
    [editYear, task, historyMode, effectiveCutoff],
  );
  /** 保存前的期间校验结果(未选截止日 / 早于当前累计截止日),用于禁用原因与守卫 */
  const periodIssue = checkSavePeriod({ task, cutoff: effectiveCutoff, serverCutoff });

  const cellEditable = (row: GridRow, orgId?: number): boolean => {
    // UX-12:提交在途/结果待核对期间锁定编辑目标,禁止继续输入
    if (saveTargetLocked) return false;
    // UX-13:导入进行中(预览待确认/清洗向导打开)锁定编辑目标,导入与手工输入不能并发覆盖
    if (importBusy) return false;
    if (editYearData?.actualLoadStatus !== 'ready') return false;
    // 历史补录必须先显式选择目标日期,输入区从空白待补录状态开始(UX-08/UX-10)
    if (historyMode && effectiveCutoff == null) return false;
    if (row.kind !== 'account' || !row.isLeaf) return false;
    if (editYearData?.actualFrozen) return false;
    if (accById.get(row.id)?.status !== 'active') return false;
    // 科目-组织适用范围按"单个组织"判定:行可见仅要求范围内任一组织适用,
    // 但每个叶子列只能录入对该组织适用的科目,避免落库无效组织-科目组合
    if (orgId != null) {
      if (!scopeLeafSet.has(orgId)) return false;
      const orgCode = orgIndex.byId.get(orgId)?.code;
      return orgCode != null && isAccountVisibleForScope(row.code, new Set([orgCode]));
    }
    if (singleLeafScope == null) return false;
    return isAccountVisibleForScope(row.code, scopeLeafOrgCodes);
  };

  /* ---------- 统一表格交互层(选区/撤销/矩阵粘贴/填充/查找,见《预算表格手感优化方案》) ---------- */
  const accRowById = useMemo(() => new Map(visibleRows.filter((r): r is AccRow => r.kind === 'account').map((r) => [r.id, r])), [visibleRows]);
  const grid = useGridInteraction({
    getRows: () => visibleRows
      .filter((r): r is AccRow => r.kind === 'account' && r.isLeaf && accById.get(r.id)?.status === 'active')
      .map((r) => ({ id: r.id, type: r.type, label: `${r.code} ${r.name}` })),
    getCols: () => {
      if (viewMode === 'orgs') {
        return visibleOrgLeafIds.map((id) => ({ id, label: orgIndex.byId.get(id)?.name ?? String(id) }));
      }
      // 多年趋势视图:仅"维护年度实际数"一列可编辑(键为 singleLeafScope)
      return singleLeafScope != null ? [{ id: singleLeafScope, label: `${editYear} 年实际数` }] : [];
    },
    isCellEditable: (rowId, colId) => {
      const row = accRowById.get(rowId);
      if (!row) return false;
      if (viewMode === 'orgs') return cellEditable(row, colId);
      return cellEditable(row);
    },
    cellDomId: (rowId, colId) => `actual-cell-${colId}-${rowId}`,
    onOpenFind: (mode) => setFindState({ open: true, mode }),
    onOpenPasteSpecial: () => setPasteSpecialOpen(true),
    notify: (type, text) => message[type](text),
    persistKey: `newfc-actual-${editYear}-${viewMode}-${singleLeafScope ?? 'multi'}`,
  });
  const { values, notes, invalidCells } = grid;

  /* ---------- 草稿(UX-09):整目标值/备注/汇总备注/基线;view 调整不重置 draft ---------- */
  const visibleAccountIds = useMemo(
    () => new Set(visibleRows.filter((r) => r.kind === 'account').map((r) => r.id)),
    [visibleRows],
  );
  const visibleCellOrgIds = useMemo(
    () => (viewMode === 'orgs' ? new Set(visibleOrgLeafIds) : new Set<number>(singleLeafScope != null ? [singleLeafScope] : [])),
    [viewMode, visibleOrgLeafIds, singleLeafScope],
  );
  const isCellKeyVisible = useCallback((key: string) => {
    const [orgId, accountId] = key.split(':').map(Number);
    return visibleAccountIds.has(accountId) && visibleCellOrgIds.has(orgId);
  }, [visibleAccountIds, visibleCellOrgIds]);
  /** 汇总备注挂在非叶子组织列/非叶子科目行上;多年视图无汇总格,全部视为不在视图 */
  const visibleSummaryOrgIds = useMemo(
    () => new Set(viewMode === 'orgs' ? orgDisplayCols.map((c) => c.id) : []),
    [viewMode, orgDisplayCols],
  );
  const isSummaryKeyVisible = useCallback((key: string) => {
    const [orgId, accountId] = key.split(':').map(Number);
    return visibleAccountIds.has(accountId) && visibleSummaryOrgIds.has(orgId);
  }, [visibleAccountIds, visibleSummaryOrgIds]);

  /** 目标基线:当前任务 = 服务器现有累计;历史任务 = 空白待补录(不预填当前累计输入,UX-10) */
  const draftBaseline = useMemo<ActualDraftBaseline | null>(() => {
    if (!accTree) return null;
    if (historyMode) return EMPTY_BASELINE;
    if (!editYearData || editYearData.actualLoadStatus !== 'ready') return null;
    return {
      values: buildPristineActualValues(editYearData, accTree.rows),
      notes: buildPristineActualMemos(editYearData),
      summaryMemos: buildPristineActualCellNotes(editYearData),
    };
  }, [editYearData, accTree, historyMode]);

  const draft = useActualDraft({
    grid,
    target,
    baseline: draftBaseline,
    isCellKeyVisible,
    isSummaryKeyVisible,
  });
  /** 网格未保存录入或汇总格备注未保存:离开拦截/保存按钮/数据回读守卫统一按合并口径 */
  const anyDirty = draft.anyDirty;
  const anyDirtyRef = useRef(anyDirty);
  anyDirtyRef.current = anyDirty;

  /* ---------- URL 范围契约(UX-02):year/org/sheet/view/mode/cutoff 进 URL,刷新与书签恢复;
     search 变化经 onApply 接到与手动切换完全一致的目标守卫(三选一),
     不能只比较 pathname 当作路由不变。非法值给可见说明,绝不静默换成另一个可写目标。 */
  const [scopeIssues, setScopeIssues] = useState<ScopeIssue[]>([]);
  const latchScopeIssues = useCallback((issues: ScopeIssue[]) => {
    if (issues.length === 0) return;
    setScopeIssues((prev) => [...prev, ...issues.filter((issue) => !prev.some((p) => p.key === issue.key && p.raw === issue.raw))]);
  }, []);
  const applyUrlRef = useRef<(parsed: ScopeParseResult) => void>(() => {});
  /** 待归属校验的 URL 对象(组织/科目表目录是异步加载的,就绪后再应用或报原因) */
  const pendingUrlRef = useRef<{ org?: number | null; sheet?: string | null } | null>(null);
  const urlSync = useUrlScopeSync('actual', {
    year: editYear,
    orgScopeId: orgScopeId ?? undefined,
    sheet: sheetKey,
    view: viewMode,
    mode: historyMode ? 'history' : 'current',
    cutoff: effectiveCutoff ?? undefined,
  }, (parsed) => applyUrlRef.current(parsed));

  /* ---------- 目标切换/离开/进入导入统一守卫(UX-10/UX-13):纯视图切换不弹窗,目标变化三选一 ---------- */
  const [guard, setGuard] = useState<{
    nextLabel: string;
    verb: '切换' | '离开' | '导入';
    apply: () => void;
    onCancel: () => void;
  } | null>(null);
  const [guardSaving, setGuardSaving] = useState(false);
  /**
   * 目标变化(年度/任务/历史截止日/离开页面)与进入导入统一入口:
   * 无未保存修改直接执行;否则弹三选一,取消时把 URL 还原为页面实际范围。
   */
  const requestTargetSwitch = useCallback((nextLabel: string, apply: () => void, verb: '切换' | '离开' | '导入' = '切换', onCancel?: () => void) => {
    // UX-12:提交在途时不允许切换/放弃,避免「保存成功时草稿已切走」导致基线前移错位
    if (savingRef.current) { message.info('正在提交保存，请稍候'); return; }
    // UX-13:导入进行中不允许切换目标或再次进入导入,先完成或取消当前导入
    if (importBusyRef.current) { message.info('导入进行中，请先完成或取消当前导入'); return; }
    if (!anyDirtyRef.current) { apply(); return; }
    setGuard({ nextLabel, apply, verb, onCancel: onCancel ?? (() => urlSync.syncNow()) });
  }, [urlSync, message]);

  /** 守卫「保存并切换/离开」:沿用正常保存编排,仅完整成功(无残留仅附注格)才放行 */
  const saveForGuardRef = useRef<() => Promise<boolean>>(() => Promise.resolve(false));
  const saveAndProceed = useCallback(async () => {
    if (!guard) return;
    setGuardSaving(true);
    try {
      const ok = await saveForGuardRef.current();
      if (!ok) return; // 保存失败/部分未保存:停留在当前目标,不切换
      guard.apply();
      setGuard(null);
    } finally {
      setGuardSaving(false);
    }
  }, [guard]);
  const discardAndProceed = useCallback(() => {
    if (!guard) return;
    // 放弃必须真正恢复基线(回滚草稿),不只是清脏标记;
    // 同时放弃未核对的保存提交(属于旧目标,重试内容不随目标迁移)
    saveOrch.dismissPending();
    draft.discardToBaseline();
    guard.apply();
    setGuard(null);
  }, [guard, draft, saveOrch]);
  const cancelGuard = useCallback(() => {
    if (guardSaving) return;
    guard?.onCancel();
    setGuard(null);
  }, [guard, guardSaving]);

  /* ---------- 财务助手页面登记(§7.2 actual) ---------- */
  useAssistantPageContext({
    pageKey: 'actual',
    ready: Boolean(orgTree && accTree) && editYearData?.actualLoadStatus === 'ready' && sheetKey !== '',
    notReadyReason: '正在读取实际数矩阵',
    readyState: 'loading',
    scope: {
      year: editYear,
      actualSnapshotId: editYearData?.actualCurrentBatchId ?? undefined,
      orgScopeId: orgScopeId ?? undefined,
    },
    view: {
      ...(sheetKey !== '' ? { sheetKey } : {}),
      viewMode,
      ...(historyMode ? { historyMode: true } : {}),
      ...(effectiveCutoff ? { cutoff: effectiveCutoff } : {}),
      ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
      ...(nonZeroOnly ? { nonZeroOnly } : {}),
      ...(collapseLevel != null ? { collapseLevel } : {}),
    },
    // 历史补录任务的修改写入历史快照而非当前累计，不属于 actual_grid 草稿口径。
    dirty: grid.dirty && !frozen && !historyMode,
    dirtyCount: grid.dirty && !frozen && !historyMode ? grid.dirtyCount : 0,
    serializeDraft: () => {
      if (!grid.dirty || frozen || historyMode) return null;
      const built = buildActualEntries(grid.dirtyKeys);
      if (built.error) throw new Error(built.error);
      return {
        kind: 'actual_grid',
        base: { year: editYear, batchId: editYearData?.actualCurrentBatchId ?? null },
        changes: built.entries,
      } satisfies DraftDescriptor;
    },
  });

  // 当前单元格焦点(§5.5 cell)：行=科目，列=组织(多年视图为汇总列)。
  const gridActiveOrgId = grid.activeIds ? grid.activeIds.colId : null;
  useAssistantFocus(
    grid.activeIds && editYearData?.actualCurrentBatchId != null && gridActiveOrgId != null
      ? { kind: 'cell', source: 'actual', sourceId: editYearData.actualCurrentBatchId, orgId: gridActiveOrgId, accountId: grid.activeIds.rowId, valueKind: 'amount' }
      : null,
    grid.activeIds ? `${grid.activeIds.colLabel} × ${grid.activeIds.rowLabel}` : null,
  );

  // 矩形选区 → bounds(§5.6)。
  const actualLeafRows = useMemo(
    () => visibleRows.filter((r): r is AccRow => r.kind === 'account' && r.isLeaf && accById.get(r.id)?.status === 'active'),
    [visibleRows, accById],
  );
  useAssistantSelection(
    grid.selection && grid.selectionSize > 1
      ? {
        mode: 'bounds',
        bounds: {
          sheetKey,
          orgIds: viewMode === 'orgs'
            ? visibleOrgLeafIds.slice(grid.selection.c1, grid.selection.c2 + 1)
            : singleLeafScope != null ? [singleLeafScope] : [],
          accountIds: actualLeafRows.slice(grid.selection.r1, grid.selection.r2 + 1).map((row) => row.id),
        },
      }
      : null,
  );

  // 浮层登记(§5.4)：模板下载 / 新增年份 / 重开年度 / 右键菜单 / 待保存项。备注弹窗在其 state 定义后登记。
  useAssistantSurface({ open: tplModalOpen, kind: 'modal', key: 'template_download' });
  useAssistantSurface({ open: addYearModalOpen, kind: 'modal', key: 'add_year' });
  useAssistantSurface({ open: reopenOpen, kind: 'modal', key: 'reopen_year' });
  useAssistantSurface({ open: ctxMenu.open, kind: 'context_menu', key: 'grid_menu' });
  useAssistantSurface({ open: pendingOpen, kind: 'modal', key: 'pending_changes' });
  useAssistantSurface({ open: guard != null, kind: 'modal', key: 'target_guard' });

  const [memoTarget, setMemoTarget] = useState<{ orgId: number; accountId: number; summary: boolean } | null>(null);
  const [memoText, setMemoText] = useState('');
  // 备注弹窗(§5.4 note_editor)：登记当前编辑的科目对象。
  useAssistantSurface({
    open: memoTarget != null,
    kind: 'modal',
    key: 'note_editor',
    entity: memoTarget ? { entityType: 'account', id: memoTarget.accountId } : null,
  });
  /** 汇总格备注仅在当前实际任务可编辑:历史补录写历史快照,不进 actual_cell_note;导入进行中同样锁定(UX-13) */
  const canEditSummaryMemo = editYearData?.actualLoadStatus === 'ready' && !frozen && !historyMode && !saveTargetLocked && !importBusy;
  /* UX-23-6:汇总备注的已提交编辑纳入网格统一撤销栈,与明细操作按发生顺序撤销;
     历史任务/冻结/保存锁定/导入期间重放被 canEdit 守卫拒绝,只读限制不被撤销绕过 */
  const applySummaryMemo = useSummaryNoteUndo({
    grid,
    notes: draft.summaryMemos,
    setNote: draft.setSummaryMemo,
    canEdit: canEditSummaryMemo,
  });
  const openMemo = useCallback((orgId: number, accountId: number, summary = false) => {
    const key = `${orgId}:${accountId}`;
    setMemoTarget({ orgId, accountId, summary });
    setMemoText(summary ? (draft.summaryMemos.get(key) ?? '') : (grid.notes.get(key) ?? ''));
  }, [draft.summaryMemos, grid.notes]);

  /* 科目表切换:同值幂等(URL 写回后的再解析会再次经过这里);记忆为本会话最近使用。
     备注弹窗的 key 属于旧表的 row,切表时强制关闭,避免对已不存在的行保存。 */
  const changeSheet = useCallback((k: string) => {
    if (k === sheetKey) return;
    setSheetKey(k);
    saveSession(ACTUAL_SHEET_KEY, k);
    setMemoTarget(null);
  }, [sheetKey]);

  /** 网格行/列号(交互层坐标系) */
  const gridRowIdx = useMemo(() => {
    const m = new Map<number, number>();
    visibleRows.forEach((r) => { if (r.kind === 'account' && r.isLeaf && accById.get(r.id)?.status === 'active') m.set(r.id, m.size); });
    return m;
  }, [visibleRows, accById]);
  const gridColIdx = useMemo(() => {
    const m = new Map<number, number>();
    if (viewMode === 'orgs') {
      visibleOrgLeafIds.forEach((id) => m.set(id, m.size));
    } else if (singleLeafScope != null) {
      m.set(singleLeafScope, 0);
    }
    return m;
  }, [viewMode, visibleOrgLeafIds, singleLeafScope]);

  /* ---------- 全局快捷键: Ctrl+S / Cmd+S 快速保存 ---------- */
  /** 最新 doSave(编排统一入口):快捷键效应的依赖不含待核对状态,必须经 ref 取最新闭包 */
  const doSaveRef = useRef<(allowEmptyReplace?: boolean, allowFinanceOwned?: boolean, onDone?: (ok: boolean) => void) => Promise<void>>(() => Promise.resolve());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (frozen) return;
        if (viewMode === 'years' && singleLeafScope == null) {
          message.info('多年趋势视图下请先选择单一末级组织,再使用 Ctrl+S 保存');
          return;
        }
        void doSaveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozen, viewMode, singleLeafScope, saving, values, effectiveCutoff, editYear, historyMode]);

  /* 路由离开守卫:与目标切换同一守卫弹窗(留在本页 / 保存并离开 / 放弃修改并离开) */
  const blocker = useBlocker(({ currentLocation, nextLocation }) => anyDirty && currentLocation.pathname !== nextLocation.pathname);
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;
  useEffect(() => {
    if (blocker.state === 'blocked') {
      setGuard({
        nextLabel: '其他页面',
        verb: '离开',
        apply: () => blockerRef.current.proceed?.(),
        onCancel: () => blockerRef.current.reset?.(),
      });
    }
  }, [blocker.state]);
  useEffect(() => {
    if (!anyDirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [anyDirty]);

  /* ---------- 切换 handler(UX-10):纯视图切换直接保留草稿;目标变化走同一守卫 ---------- */
  const handleYearChange = (newYear: number) => {
    if (newYear === editYear) return;
    const apply = () => {
      // 显式选择不在既有列表的年度时,按「添加历史年份」处理(与新增年份入口同语义)
      if (!years.includes(newYear)) setCustomYears((prev) => (prev.includes(newYear) ? prev : [...prev, newYear]));
      setEditYear(newYear);
    };
    requestTargetSwitch(`${newYear} 年 · ${historyMode ? '补录历史快照' : '更新当前实际'}`, apply);
  };

  // 组织范围/视图模式/科目表/筛选/折叠均为纯 view 调整:草稿按 orgId:accountId 键跨视图存活,
  // 不再弹「丢弃输入」提醒(UX-09/UX-10)。
  const handleOrgScopeChange = (v: number | null) => setOrgScopeId(v);
  const handleViewModeChange = (v: 'orgs' | 'years') => setViewMode(v);

  /** 任务切换(更新当前实际 ⇄ 补录历史快照):编辑目标变化,有未保存修改时三选一 */
  const requestTaskChange = (nextHistory: boolean, presetHistoryCutoff?: string) => {
    if (nextHistory === historyMode) return;
    const nextTask: ActualTask = nextHistory ? 'history' : 'current';
    const label = nextHistory
      ? '补录历史快照（从空白开始，不更新当前累计）'
      : '更新当前实际';
    const apply = () => {
      setHistoryMode(nextHistory);
      if (nextHistory && presetHistoryCutoff) setCutoffSel({ year: editYear, task: nextTask, date: presetHistoryCutoff });
    };
    requestTargetSwitch(label, apply);
  };

  /** 截止日选择:当前任务的截止日不是目标维度,直接应用;历史任务的目标日期属于编辑目标,脏时走守卫 */
  const handleCutoffChange = (d: dayjs.Dayjs | null) => {
    if (!d) return;
    const date = d.format('YYYY-MM-DD');
    if (date === effectiveCutoff) return;
    if (historyMode && effectiveCutoff != null) {
      requestTargetSwitch(`补录历史快照 · 截止 ${date}`, () => setCutoffSel({ year: editYear, task: 'history', date }));
      return;
    }
    setCutoffSel({ year: editYear, task, date });
  };

  /* URL → 页面范围应用(search 变化与手动切换走同一批守卫 handler);
     赋值在每次渲染执行,保证读到最新的 state 与 handler 闭包。 */
  /** pendingUrlRef 内容变化的信号(异步目录校验效应的依赖) */
  const [pendingUrlVersion, setPendingUrlVersion] = useState(0);
  applyUrlRef.current = (parsed: ScopeParseResult) => {
    latchScopeIssues(parsed.issues);
    const s = parsed.scope;
    const nextYear = s.year ?? null;
    const nextHistory = s.mode != null ? resolveActualMode(s) === 'history' : historyMode;
    const nextTask: ActualTask = nextHistory ? 'history' : 'current';
    const effectiveYear = nextYear ?? editYear;
    // 截止日必须属于目标年度
    let nextCutoff: string | null = null;
    if (s.cutoff) {
      if (Number(s.cutoff.slice(0, 4)) === effectiveYear) {
        nextCutoff = s.cutoff;
      } else {
        latchScopeIssues([{ key: 'cutoff', field: 'cutoff', raw: s.cutoff, reason: 'out_of_range', detail: `链接中的累计截止日 ${s.cutoff} 不属于 ${effectiveYear} 年,已忽略` }]);
      }
    }
    // 显示视图是纯 view 调整:直接应用,不弹窗
    if (s.view && s.view !== viewMode) handleViewModeChange(s.view);

    /* 目标变化合成一次守卫决策(年度/任务/历史截止日),避免叠加多个弹窗 */
    const yearChanged = nextYear != null && nextYear !== editYear;
    const taskChanged = nextTask !== task;
    const historyCutoffChanged = !yearChanged && !taskChanged && nextTask === 'history'
      && nextCutoff != null && effectiveCutoff != null && nextCutoff !== effectiveCutoff;
    const applyTarget = () => {
      if (yearChanged && nextYear != null) {
        if (!years.includes(nextYear)) setCustomYears((prev) => (prev.includes(nextYear) ? prev : [...prev, nextYear]));
        setEditYear(nextYear);
      }
      if (taskChanged) setHistoryMode(nextHistory);
      if (nextCutoff != null) setCutoffSel({ year: effectiveYear, task: nextTask, date: nextCutoff });
    };
    if (yearChanged || taskChanged || historyCutoffChanged) {
      const label = `${effectiveYear} 年 · ${nextTask === 'history' ? '补录历史快照' : '更新当前实际'}${nextTask === 'history' && nextCutoff ? ` · 截止 ${nextCutoff}` : ''}`;
      requestTargetSwitch(label, applyTarget);
    } else if (nextCutoff != null && nextCutoff !== effectiveCutoff) {
      // 当前任务的截止日不是目标维度,直接应用
      setCutoffSel({ year: effectiveYear, task: nextTask, date: nextCutoff });
    }

    if (s.orgScopeId != null || s.sheet != null) {
      pendingUrlRef.current = { org: s.orgScopeId ?? null, sheet: s.sheet ?? null };
      setPendingUrlVersion((v) => v + 1);
    }
  };

  /* 组织/科目表归属校验:目录(组织树/预设表)异步就绪后统一应用;失效对象给出原因并保持现状 */
  useEffect(() => {
    const pending = pendingUrlRef.current;
    if (!pending) return;
    if (pending.org != null && !orgTree) return;
    if (pending.sheet != null && sheetsLoading) return;
    if (pending.org != null && orgTree) {
      const org = orgTree.rows.find((row) => row.id === pending.org);
      if (!org) {
        latchScopeIssues([{ key: 'org', field: 'orgScopeId', raw: String(pending.org), reason: 'not_found', detail: `链接中的组织 ${pending.org} 不存在或已删除,已保持当前组织范围` }]);
      } else if (org.status !== 'active') {
        latchScopeIssues([{ key: 'org', field: 'orgScopeId', raw: String(pending.org), reason: 'inactive', detail: `链接中的组织「${org.name}」已停用,已保持当前组织范围` }]);
      } else {
        handleOrgScopeChange(pending.org);
      }
    }
    if (pending.sheet != null) {
      const sheetKeys = ['profit', 'overview', ...dbSheets.map((item) => item.key)];
      if (sheetKeys.includes(pending.sheet)) {
        if (pending.sheet !== sheetKey) changeSheet(pending.sheet);
      } else {
        /* 失效的链接参数不能把录入页留在空表上:保留已有选择,否则改用默认可填写预设表 */
        const fallback = sheetKey !== '' && findSheet(sheetKey, dbSheets) != null ? sheetKey : (pickWritableSheet(dbSheets) ?? 'profit');
        const fallbackName = findSheet(fallback, dbSheets)?.name ?? fallback;
        if (fallback !== sheetKey) changeSheet(fallback);
        latchScopeIssues([{ key: 'sheet', field: 'sheet', raw: pending.sheet, reason: 'not_found', detail: `链接中的科目表「${pending.sheet}」不存在,已改用「${fallbackName}」` }]);
      }
    }
    pendingUrlRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgTree, dbSheets, sheetsLoading, pendingUrlVersion]);

  /* ---------- 默认落点(UX-31 遗留):首次进入落在有输入格的预设表 ----------
     优先级:URL 显式 ?sheet= > 本会话最近使用 > 首张可填写预设表。
     利润表只有指标计算行、一级汇总只有汇总行,新用户首次进入看不到任何输入格,
     因此不再默认停在只读视图;此处只在「本页尚无显式选择」时落一次,之后完全由用户控制。 */
  const sheetDefaultedRef = useRef(false);
  useEffect(() => {
    if (sheetDefaultedRef.current || sheetsLoading) return;
    // URL 带 ?sheet= 时交由上方归属校验决定(非法值要能给出原因,不能被默认落点覆盖)
    if (searchParams.get('sheet') != null) { sheetDefaultedRef.current = true; return; }
    sheetDefaultedRef.current = true;
    // 记忆值可能指向已被删除的预设表;失效即重新落点
    if (sheetKey !== '' && findSheet(sheetKey, dbSheets) != null) return;
    changeSheet(pickWritableSheet(dbSheets) ?? 'profit');
  }, [sheetsLoading, dbSheets, sheetKey, searchParams, changeSheet]);

  /** 当前视图没有任何可填写单元格,且存在可切换的预设表:给出一键切换引导。
      报表尚未落定时(sheetKey 为空)不提示——那是骨架期,不是用户选出的只读视图。 */
  const writableSheetKey = pickWritableSheet(dbSheets);
  const sheetLacksInput = sheetKey !== '' && !sheetsLoading && writableSheetKey != null && !isWritableSheet(findSheet(sheetKey, dbSheets));

  /**
   * 实际数条目构建(保存与助手草稿共用同一解析口径,§9.6)：
   * onlyKeys 传入时只构建这些脏单元格(助手草稿),缺省为全量(整包保存)。
   */
  const buildActualEntries = useCallback((onlyKeys?: ReadonlySet<string>): {
    entries: { orgId: number; accountId: number; amount?: string; quantity?: string; memo?: string }[];
    skippedScope: number;
    skippedMemoOnly: { key: string; label: string }[];
    pristine: Map<string, string>;
    error?: string;
  } => {
    const pristine = editYearData && accTree ? buildPristineActualValues(editYearData, accTree.rows) : new Map<string, string>();
    const entries: { orgId: number; accountId: number; amount?: string; quantity?: string; memo?: string }[] = [];
    let skippedScope = 0;
    const skippedMemoOnly: { key: string; label: string }[] = [];
    for (const key of new Set([...values.keys(), ...notes.keys()])) {
      if (onlyKeys && !onlyKeys.has(key)) continue;
      const display = values.get(key) ?? '';
      // 清空 = 删除该行(整包替换模式下服务端会删除未提交组合),不能当格式错误阻断保存
      const memo = notes.get(key)?.trim() || undefined;
      if (display.trim() === '' && !memo) continue;
      const [orgId, accountId] = key.split(':').map(Number);
      const acc = accById.get(accountId);
      const orgCode = orgIndex.byId.get(orgId)?.code;
      // 跳过不适用于该组织的存量组合:后端会拒绝这类条目,不跳过会导致整包保存失败
      // (整包替换模式下这些无效存量行随之清理)
      if (!acc || !orgCode || !isAccountVisibleForScope(acc.code, new Set([orgCode]))) {
        skippedScope++;
        continue;
      }
      const label = `${orgIndex.byId.get(orgId)?.name ?? orgId} × ${acc.name}`;
      // 未编辑过的格子直接回传服务端原始精度:万元两位小数显示会把 <50 元的存量值
      // 舍入成 0.00,重新解析再保存会静默删除这些行
      const orig = editYearData?.actualEntries.get(key);
      const untouched = orig != null && cellValueEquivalent(display, pristine.get(key) ?? '');
      if (acc.type === 'quantity') {
        const q = untouched ? (orig!.quantity ?? '') : display.trim();
        if (q === '') {
          // 仅附注无数值:实际侧行删除即附注丢失。跳过并显式提示,格子保持脏标记
          if (memo) skippedMemoOnly.push({ key, label });
          continue;
        }
        if (!quantitySchema.safeParse(q).success) return { entries: [], skippedScope, skippedMemoOnly, pristine, error: `数量格式不正确(最多四位小数):${label} = "${display}"` };
        entries.push({ orgId, accountId, quantity: q, memo });
      } else {
        if (untouched && orig!.amountDisplay !== '') {
          entries.push({ orgId, accountId, amount: orig!.amountDisplay, memo });
          continue;
        }
        const trimmed = display.trim();
        if (trimmed === '') {
          if (memo) skippedMemoOnly.push({ key, label });
          continue;
        }
        const cents = wanToCents(trimmed);
        if (cents == null) return { entries: [], skippedScope, skippedMemoOnly, pristine, error: `金额格式不正确(万元,最多两位小数):${label} = "${display}"` };
        if (cents === 0) {
          // 显式 0+附注同样无法落库(实际侧 0 值即删除行),按仅附注处理
          if (memo) skippedMemoOnly.push({ key, label });
          continue;
        }
        entries.push({ orgId, accountId, amount: centsToYuan(cents), memo });
      }
    }
    return { entries, skippedScope, skippedMemoOnly, pristine };
  }, [accTree, accById, editYearData, notes, orgIndex.byId, values]);

  /**
   * 保存结果统一处理(UX-12):仅「回执已确认的成功」才更新基线、提示成功并放行守卫;
   * 结果未知/明确失败/部分未保存均保留输入且 onDone(false)。
   */
  const applySaveOutcome = async (outcome: ActualSaveOutcome, meta: ActualSaveMeta, onDone?: (ok: boolean) => void) => {
    switch (outcome.kind) {
      case 'in_flight':
        // 已有提交在途:本次触发被忽略,不算失败也不放行
        onDone?.(false);
        return;
      case 'rejected':
        message.error(outcome.message);
        onDone?.(false);
        return;
      case 'uncommitted':
        message.warning('本次保存未提交成功(已核对服务端无写入):输入已保留,可用相同请求编号重试');
        onDone?.(false);
        return;
      case 'unverified':
        message.warning('保存提交结果未知:响应丢失且回执查询失败,输入已保留;请用相同请求编号重试核对(不会重复生成快照)');
        onDone?.(false);
        return;
      case 'success': {
        const r = outcome.result;
        message.success(meta.history ? '保存成功:历史快照已补录,当前累计不变' : '保存成功:当前实际已更新并生成全量快照');
        // 仅附注未落库的格子保持脏标记,避免"看似已存、刷新即丢";
        // 汇总备注基线仅当前任务前移(历史任务不携带汇总备注)
        draft.markSaved(
          meta.skippedMemoOnlyKeys.length > 0 ? new Set(meta.skippedMemoOnlyKeys) : undefined,
          !meta.history,
        );
        setSaveResult({
          batchId: r.batchId,
          saved: r.saved,
          deleted: r.deleted,
          cellNotesSaved: r.cellNotesSaved,
          cellNotesDeleted: r.cellNotesDeleted,
          replayed: r.replayed,
          viaReceipt: outcome.viaReceipt,
          year: meta.year,
          history: meta.history,
          snapshotDate: meta.snapshotDate,
        });
        await qc.invalidateQueries({ queryKey: ['actual-matrix', editYear] });
        qc.invalidateQueries({ queryKey: ['batches', editYear] });
        qc.invalidateQueries({ queryKey: ['actual-years'] });
        await invalidateAnalysisQueries(qc);
        if (meta.skippedMemoOnlyKeys.length > 0) {
          // 部分备注未随保存落库:不算完整成功,守卫不能放行切换(UX-10)
          onDone?.(false);
          return;
        }
        onDone?.(true);
        return;
      }
    }
  };

  /**
   * 保存编排(所有入口共用:保存按钮 / Ctrl+S / 守卫「保存并切换」,UX-12)。
   * onDone 供守卫等待最终结果:true = 完整保存成功可切换;失败/取消/结果未知/部分未保存均为 false。
   */
  const doSave = async (allowEmptyReplace = false, allowFinanceOwned = false, onDone?: (ok: boolean) => void) => {
    // 防重复提交:编排层单在途请求,双击/连按 Ctrl+S 不会产生多个批次
    if (saving) { onDone?.(false); return; }
    // 有待核对的提交:任何保存入口统一转为「相同请求编号 + 冻结内容」重试,
    // 不重新构建请求、不新建编号、不重走确认(服务端幂等返回原回执)
    const pendingSave = saveOrch.pending;
    if (pendingSave) {
      try {
        const retried = await saveOrch.retryPending();
        if (retried) await applySaveOutcome(retried.outcome, retried.meta, onDone);
        else onDone?.(false);
      } catch (e) {
        message.error(errorText(e));
        onDone?.(false);
      }
      return;
    }
    if (!editYearData || editYearData.actualLoadStatus !== 'ready') {
      message.error(editYearData?.actualLoadStatus === 'error' ? `实际数加载失败，禁止保存：${editYearData.actualLoadError ?? '请刷新重试'}` : '实际数尚未加载完成，请稍候');
      onDone?.(false);
      return;
    }
    if (!anyDirty) { message.info('没有需要保存的修改'); onDone?.(false); return; }
    // 期间校验(UX-08):未选截止日不能提交;普通更新早于当前累计截止日时说明原因并给历史补录入口
    const issue = checkSavePeriod({ task, cutoff: effectiveCutoff, serverCutoff });
    if (issue) {
      if (issue.code === 'earlier_than_current' && effectiveCutoff) {
        const date = effectiveCutoff;
        modal.confirm({
          title: '截止日早于当前累计截止日',
          content: `${issue.message}。如要补充 ${date} 的历史数据,可切换为历史补录(当前未保存输入需先保存或放弃)。`,
          okText: `切换为历史补录(截止 ${date})`,
          cancelText: '留在当前任务',
          onOk: () => { requestTaskChange(true, date); onDone?.(false); },
          onCancel: () => onDone?.(false),
        });
      } else {
        message.error(issue.message);
        onDone?.(false);
      }
      return;
    }
    // checkSavePeriod 已保证期间合法:此处截止日必然非空
    const snapshotDate = effectiveCutoff!;
    try {
      const built = buildActualEntries();
      if (built.error) { message.error(built.error); onDone?.(false); return; }
      const entries = built.entries;
      const skippedScope = built.skippedScope;
      const pristine = built.pristine;
      // 汇总格备注只在当前实际任务随整包提交;历史补录写历史快照,不携带
      const cellNotesPayload = historyMode
        ? undefined
        : [...draft.summaryMemos.entries()]
            .map(([key, raw]) => {
              const memo = raw.trim();
              if (!memo) return null;
              const [orgId, accountId] = key.split(':').map(Number);
              return { orgId, accountId, memo };
            })
            .filter((n): n is { orgId: number; accountId: number; memo: string } => n != null);
      if (historyMode && draft.summaryMemosDirty) {
        message.warning('汇总格备注不参与历史补录,本次不会保存;切回当前实际后再保存');
      }
      if (!historyMode && !allowFinanceOwned) {
        const owned = new Map(editYearData.financeOwnedCells.map((cell) => [`${cell.orgId}:${cell.accountId}`, cell]));
        const changed = new Map<string, (typeof editYearData.financeOwnedCells)[number]>();
        for (const key of new Set([...values.keys(), ...pristine.keys()])) {
          const cell = owned.get(key);
          if (cell && !cellValueEquivalent(values.get(key) ?? '', pristine.get(key) ?? '')) changed.set(key, cell);
        }
        if (changed.size > 0) {
          const profileNames = [...new Set([...changed.values()].map((cell) => cell.profileName))].join('、');
          modal.confirm({
            title: `有 ${changed.size} 个单元格由财务转换维护`,
            content: `命中数据源“${profileNames}”的拥有范围。手工保存仍被允许，但这些值可能被后续财务转换覆盖。是否继续？`,
            okText: '仍然手工保存',
            onOk: () => void doSave(allowEmptyReplace, true, onDone),
            onCancel: () => onDone?.(false),
          });
          return;
        }
      }
      if (skippedScope > 0) {
        message.warning(`已跳过 ${skippedScope} 条不适用于当前组织的科目组合(整包替换模式下将同时清理)`);
      }
      if (built.skippedMemoOnly.length > 0) {
        const sample = built.skippedMemoOnly.slice(0, 3).map((s) => s.label).join(';');
        message.warning(`有 ${built.skippedMemoOnly.length} 个格子只填了附注没有数值,附注未保存(附注需随数值一并保存):${sample}${built.skippedMemoOnly.length > 3 ? ' 等' : ''}`);
      }
      if (!historyMode && entries.length === 0 && editYearData.actualEntries.size > 0 && !allowEmptyReplace) {
        modal.confirm({
          title: `确认清空 ${editYear} 年全部当前实际？`,
          content: '此操作会删除该年度全部当前实际并生成空快照，请确认这是有意操作。',
          okText: '确认清空', okButtonProps: { danger: true },
          onOk: () => void doSave(true, allowFinanceOwned, onDone),
          onCancel: () => onDone?.(false),
        });
        return;
      }
      const meta: ActualSaveMeta = {
        year: editYear,
        history: historyMode,
        snapshotDate,
        skippedMemoOnlyKeys: built.skippedMemoOnly.map((s) => s.key),
      };
      // UX-12:提交前固定请求内容并生成请求编号;同编号同内容重试由服务端返回原回执
      const payload: ActualSavePayload = {
        year: editYear,
        snapshotDate,
        entries,
        mode: 'replace',
        history: historyMode,
        expectedCurrentBatchId: editYearData.actualCurrentBatchId,
        allowEmptyReplace,
        cellNotes: cellNotesPayload,
        requestId: newSaveRequestId(),
      };
      const outcome = await saveOrch.submit(payload, meta);
      await applySaveOutcome(outcome, meta, onDone);
    } catch (e) {
      message.error(errorText(e));
      onDone?.(false);
    }
  };
  doSaveRef.current = doSave;
  saveForGuardRef.current = () => new Promise<boolean>((resolve) => { void doSaveRef.current(false, false, resolve); });

  const openYear = async (reason: string): Promise<boolean> => {
    try {
      await api.post(`/years/${editYear}/reopen`, { reason });
      message.success('年度已重新打开');
      qc.invalidateQueries({ queryKey: ['actual-matrix', editYear] });
      qc.invalidateQueries({ queryKey: ['actual-years'] });
      void invalidateAnalysisQueries(qc);
      return true;
    } catch (e) { message.error(errorText(e)); return false; }
  };

  /** 新增年份入口与年度切换走同一守卫(UX-10) */
  const handleAddCustomYear = () => {
    if (!newYearInput || !Number.isInteger(newYearInput)) {
      message.error('请输入有效年份数字');
      return;
    }
    if (newYearInput < 1990 || newYearInput > 2100) {
      message.error('年份范围必须在 1990 至 2100 之间');
      return;
    }
    setAddYearModalOpen(false);
    if (newYearInput === editYear) { message.info(`当前已在 ${newYearInput} 年`); return; }
    requestTargetSwitch(`${newYearInput} 年（新增历史年份）`, () => {
      if (!years.includes(newYearInput)) setCustomYears((prev) => (prev.includes(newYearInput) ? prev : [...prev, newYearInput]));
      setEditYear(newYearInput);
      message.success(`已添加并切换至 ${newYearInput} 年`);
    });
  };

  /** 可见筛选范围 < 保存影响范围(整年整包)时给明确摘要(UX-08 验收) */
  const scopeNarrowed = useMemo(() => {
    if (draft.hiddenDirty > 0) return true;
    if (keyword.trim() || nonZeroOnly || collapseLevel != null) return true;
    const rootId = orgTree?.tree[0]?.id ?? null;
    const allLeafCount = rootId != null ? orgIndex.leavesUnder(rootId).length : 0;
    if (allLeafCount > 0 && scopeLeaves.length < allLeafCount) return true;
    if (viewMode === 'years' && scopeLeaves.length > 1) return true;
    return false;
  }, [draft.hiddenDirty, keyword, nonZeroOnly, collapseLevel, orgTree, orgIndex, scopeLeaves, viewMode]);

  /** 全部待保存项(含视图外),供一键查看弹窗 */
  const pendingItems = useMemo(
    () => draft.dirtyItems.map((item) => ({
      ...item,
      orgName: orgIndex.byId.get(item.orgId)?.name ?? String(item.orgId),
      accountLabel: (() => {
        const acc = accById.get(item.accountId);
        return acc ? `${acc.code} ${acc.name}` : String(item.accountId);
      })(),
    })),
    [draft.dirtyItems, orgIndex, accById],
  );

  const sheet = findSheet(sheetKey, dbSheets);

  /* UX-23-1:整表只读原因——只读格悬浮可读到 */
  const gridReadonlyReason = saveTargetLocked
    ? '保存提交在途或结果待核对，编辑已暂时锁定，完成后自动恢复'
    : frozen
      ? `年度已冻结，${editYear} 年实际数只读；如需修改请先「重开年度」`
      : historyMode && effectiveCutoff == null
        ? '请先在上方选择要补录的历史截止日期'
        : null;
  /* UX-23-3:活动格单位(数量=科目计量单位,金额=万元),状态栏确认输入对象 */
  const gridActiveAcc = grid.activeIds ? accById.get(grid.activeIds.rowId) : undefined;
  const gridActiveUnit = gridActiveAcc ? (gridActiveAcc.type === 'quantity' ? (gridActiveAcc.unit ?? '数量') : '万元') : null;

  return (
    /* 无壳:外层 .newfc-content 已是唯一的岛。
       标题保留 —— 它带的是冻结状态、截止日等运行期信息,不是页面名的重复。 */
    <Card
      className="newfc-root-card"
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {/* 原「录入与快照」标题与侧栏同名,已删(侧栏现名「实际录入与快照」);Tooltip 保留在原地继续承担口径说明 */}
          <Tooltip
            title={
              viewMode === 'orgs'
                ? `【多组织横向展开视图】: 行=科目; 列=多级组织架构(${editYear} 年实际数，首列为所选范围总汇总，向右依次展开各板块小计与各电站/单位明细，支持折叠/展开); 金额单位万元，数量按计量单位。`
                : '【多年趋势对比视图】: 行=科目; 列=各年度「预算数(当前生效版本)/ 实际数(当前累计)」对比; 金额单位万元，普通科目行按界面口径显示正数。'
            }
          >
            <i className="ri-information-line" style={{ color: 'var(--newfc-text-tertiary)', fontSize: 14, cursor: 'pointer' }} aria-hidden />
          </Tooltip>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 12,
                fontSize: 12,
                fontWeight: 500,
                background: softBg(frozen ? fc.income : sc.good),
                color: frozen ? fc.income : sc.good,
                border: `1px solid ${softBg(frozen ? fc.income : sc.good, 30)}`,
              }}
            >
              {frozen ? '🔒 年度已冻结' : '🟢 填报开放'}
            </span>
            {anyDirty && (
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: 12,
                  fontSize: 12,
                  fontWeight: 500,
                  background: softBg(sc.warn),
                  color: sc.warn,
                  border: `1px solid ${softBg(sc.warn, 30)}`,
                }}
              >
                ● 未保存
              </span>
            )}
            <span style={{ fontSize: 12, color: 'var(--newfc-text-tertiary)' }}>
              当前累计截至: <b>{serverCutoff ?? '无快照'}</b>
            </span>
          </div>
        </div>
      }
      extra={
        <ActualHeaderActions
          editYear={editYear}
          frozen={frozen}
          historyMode={historyMode}
          saving={saving}
          canSave={editYearData?.actualLoadStatus === 'ready' && anyDirty && !(viewMode === 'years' && singleLeafScope == null)}
          saveBlockReason={periodIssue?.message ?? null}
          hasUnsavedChanges={anyDirty}
          importLocked={importBusy}
          onOpenTemplate={() => setTplModalOpen(true)}
          onSave={() => void doSave()}
          onImported={() => { setImportBusy(false); qc.invalidateQueries({ queryKey: ['actual-matrix', editYear] }); qc.invalidateQueries({ queryKey: ['batches', editYear] }); qc.invalidateQueries({ queryKey: ['actual-years'] }); void invalidateAnalysisQueries(qc); }}
          onRequestImport={(proceed) => requestTargetSwitch('导入', proceed, '导入', () => undefined)}
          onImportLockChange={setImportBusy}
        />
      }
    >
      {/* 全屏时整块工作区(工具栏/表格/状态栏)一起进入覆盖层,
          退出全屏按钮与 Esc 始终可用,不会被覆盖层自身遮住 */}
      {budgetLoadErrorYears.length > 0 && (
        <Alert
          type="error" showIcon style={{ marginBottom: 8 }}
          message={`预算数据加载失败(${budgetLoadErrorYears.map((y) => `${y} 年`).join('、')}),预实对比列不可用`}
          action={<Button size="small" onClick={() => void qc.invalidateQueries({ queryKey: ['budget-matrix'] })}>重试</Button>}
        />
      )}
      {/* 只读汇总视图没有输入格:给出切到可填写预设表的入口,不让用户对着空表找格子 */}
      {sheetLacksInput && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 8 }}
          message={`「${sheet?.name ?? '当前报表'}」是只读汇总视图，没有可直接录入的单元格`}
          description="录入实际数请切换到展开到末级科目的预设表。"
          action={
            <Button size="small" type="primary" onClick={() => changeSheet(writableSheetKey)}>
              切到「{findSheet(writableSheetKey, dbSheets)?.name ?? writableSheetKey}」
            </Button>
          }
        />
      )}
      {scopeIssues.length > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ marginBottom: 8 }}
          onClose={() => setScopeIssues([])}
          message="链接中的范围参数已忽略"
          description={scopeIssues.map((issue) => issue.detail).join('；')}
        />
      )}
      {/* UX-12:结果未知/明确失败的持续状态——输入保留、目标锁定,
          「相同请求编号重试」不会重复生成快照;回执未确认前绝不显示成功 */}
      {saveOrch.pending && (
        <Alert
          type={saveOrch.pending.status === 'unverified' ? 'error' : 'warning'}
          showIcon
          style={{ marginBottom: 8 }}
          message={saveOrch.pending.status === 'unverified' ? '保存提交结果未知，待核对' : '本次保存未提交成功'}
          description={
            <>
              {saveOrch.pending.status === 'unverified'
                ? `上次保存响应丢失，且回执查询失败（${saveOrch.pending.reason ?? '未知原因'}），尚未确认是否已写入。你的输入仍保留在表格中；编辑已暂时锁定，请重试核对——使用相同请求编号重试不会重复生成快照。`
                : '已核对服务端：上次保存请求没有写入。你的输入仍保留在表格中；编辑已暂时锁定，可用相同请求编号直接重试。'}
              <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12, marginTop: 4 }}>
                请求编号 {saveOrch.pending.requestId} · {saveOrch.pending.meta.year} 年 · 截至 {saveOrch.pending.meta.snapshotDate}
              </Typography.Text>
            </>
          }
          action={
            <Space size={8}>
              <Button size="small" type="primary" loading={saving} onClick={() => void doSaveRef.current()}>
                相同请求编号重试
              </Button>
              <Button
                size="small"
                danger
                disabled={saving}
                onClick={() => {
                  saveOrch.dismissPending();
                  message.info('已放弃本次提交的核对；输入仍保留在表格中，可继续编辑后重新保存');
                }}
              >
                放弃本次提交，继续编辑
              </Button>
            </Space>
          }
        />
      )}
      {/* UX-12:保存成功结果(快照批次 + 对应年度分析入口),关闭前持续可见 */}
      {saveResult && (
        <Alert
          type="success"
          showIcon
          closable
          style={{ marginBottom: 8 }}
          onClose={() => setSaveResult(null)}
          message={saveResult.history
            ? `历史快照已补录（批次 #${saveResult.batchId}），当前累计不变`
            : `当前实际已更新并生成全量快照（批次 #${saveResult.batchId}）`}
          description={
            <>
              {saveResult.year} 年 · 截至 {saveResult.snapshotDate}；写入 {saveResult.saved} 项、清除 {saveResult.deleted} 项
              {saveResult.cellNotesSaved > 0 || saveResult.cellNotesDeleted > 0
                ? `；汇总备注更新 ${saveResult.cellNotesSaved} 项、清除 ${saveResult.cellNotesDeleted} 项`
                : ''}
              {saveResult.viaReceipt ? '。本次响应曾丢失，已经保存回执核对确认提交成功，未重复生成快照' : ''}。
              <Link
                style={{ marginLeft: 8 }}
                to={`/analysis?${buildScopeSearch('analysis', { year: saveResult.year, actualSnapshotId: saveResult.batchId })}`}
              >
                在 {saveResult.year} 年年度执行分析中查看
              </Link>
            </>
          }
        />
      )}
      <div className={fullscreen ? 'newfc-grid-fullscreen' : undefined}>
      {/* UX-04:全屏与大表滚动时仍需确认录入对象;区分「实际截至(服务器现有累计)」与
          「待提交截止(本次保存将写入)」。切换年度加载期间显示骨架,不混显旧年度数值。 */}
      <WorkspaceScopeBar
        year={editYear}
        orgName={effectiveScopeId != null ? (orgIndex.byId.get(effectiveScopeId)?.name ?? '全部组织') : '全部组织'}
        versionName={editYearData?.budgetVersion?.name ?? null}
        statusLabel={frozen ? '年度已冻结(只读)' : historyMode ? '补录历史快照' : '更新当前实际'}
        status={editYearData?.actualLoadStatus === 'loading' ? 'loading' : frozen ? 'readonly' : 'ready'}
        asOfDate={serverCutoff}
        pendingDate={effectiveCutoff}
        style={{ marginBottom: 8 }}
      />
      <ActualToolbars
        viewMode={viewMode}
        onViewModeChange={handleViewModeChange}
        orgTreeData={orgTreeData}
        effectiveScopeId={effectiveScopeId}
        onOrgScopeChange={handleOrgScopeChange}
        sheetKey={sheetKey}
        onSheetKeyChange={changeSheet}
        dbSheets={dbSheets}
        editYear={editYear}
        onYearChange={handleYearChange}
        years={years}
        onAddYear={() => setAddYearModalOpen(true)}
        frozen={frozen}
        onReopen={() => { setReopenReason(''); setReopenOpen(true); }}
        keyword={keyword}
        onKeywordChange={setKeyword}
        nonZeroOnly={nonZeroOnly}
        onNonZeroOnlyChange={setNonZeroOnly}
        collapseLevel={collapseLevel}
        onCollapseLevelChange={setCollapseLevel}
        cutoff={effectiveCutoff ? dayjs(effectiveCutoff) : null}
        onCutoffChange={handleCutoffChange}
        historyMode={historyMode}
        onHistoryModeChange={requestTaskChange}
        canUndo={grid.canUndo}
        canRedo={grid.canRedo}
        onUndo={grid.undo}
        onRedo={grid.redo}
        density={density}
        onDensityChange={setDensity}
        fullscreen={fullscreen}
        onFullscreenChange={setFullscreen}
      />

      {/* UX-08:期间摘要持续可见;普通更新早于当前累计截止日时给历史补录入口 */}
      <PeriodSummary
        year={editYear}
        task={task}
        cutoff={effectiveCutoff}
        serverCutoff={serverCutoff}
        scopeNarrowed={scopeNarrowed}
        onSwitchToHistory={(date) => requestTaskChange(true, date)}
      />

      <TemplateModal
        open={tplModalOpen}
        onClose={() => setTplModalOpen(false)}
        years={years}
        editYear={editYear}
        currentSheetKey={sheetKey}
        currentCutoff={effectiveCutoff ? dayjs(effectiveCutoff) : null}
        orgTreeData={orgTreeData}
        initialOrgIds={scopeLeaves}
        allLeafOrgIds={orgIndex.leavesUnder(orgTree?.tree[0]?.id ?? 0)}
        currentOrg={singleLeafScope != null ? { id: singleLeafScope, name: orgIndex.byId.get(singleLeafScope)?.name ?? '' } : null}
        dbSheets={dbSheets}
      />

      <AddYearModal
        open={addYearModalOpen}
        value={newYearInput}
        onValueChange={setNewYearInput}
        onConfirm={handleAddCustomYear}
        onCancel={() => setAddYearModalOpen(false)}
      />

      {/* 切换年度的加载窗口内用骨架占位:网格编辑值要等基线重置效应后才属于新年度,
          直接沿用旧值渲染会出现「新年度标题配旧年度数值」(§4.10)。
          报表尚未落定(空串)或当前表暂不可解析时同样占位:预设表清单还没回来时,
          按记忆值渲染会得到一张空表,而不是「还没有数据」。 */}
      {editYearData?.actualLoadStatus === 'loading' || sheet == null ? (
        <div className="matrix-container" style={{ padding: 16 }}>
          <TableSkeleton columns={6} rows={8} />
        </div>
      ) : (
      <ActualGridTable
        viewMode={viewMode}
        visibleRows={visibleRows}
        years={years}
        editYear={editYear}
        yearData={yearData}
        sheetName={sheet?.name}
        orgDisplayCols={orgDisplayCols}
        collapsedOrgCols={collapsedOrgCols}
        onToggleCollapseOrgCol={toggleCollapseOrgCol}
        onVisibleLeafIdsChange={handleVisibleOrgLeafIdsChange}
        values={values}
        notes={notes}
        summaryNotes={draft.summaryMemos}
        canEditSummaryMemo={canEditSummaryMemo}
        onOpenMemo={openMemo}
        invalidCells={invalidCells}
        grid={grid}
        gridRowIdx={gridRowIdx}
        gridColIdx={gridColIdx}
        cellEditable={cellEditable}
        displayOf={displayOf}
        displayOfOrg={displayOfOrg}
        density={density}
        activeRowId={activeRowId}
        onActiveRowChange={setActiveRowId}
        singleLeafScope={singleLeafScope}
        onCtxMenu={setCtxMenu}
        fullscreen={fullscreen}
        readonlyReason={gridReadonlyReason}
      />
      )}

      {/* UX-09/UX-10:统一待保存计数(含汇总备注),隐藏项给出一键查看全部入口 */}
      <GridStatusBar
        dirtyCount={draft.totalDirty}
        hiddenDirtyCount={draft.hiddenDirty}
        onShowAllDirty={() => setPendingOpen(true)}
        canUndo={grid.canUndo}
        undoDepth={grid.undoDepth}
        stats={grid.selectionStats}
        saving={saving}
        activeCell={grid.activeIds ? { label: `${grid.activeIds.colLabel} · ${grid.activeIds.rowLabel}`, unit: gridActiveUnit } : null}
      />
      <PendingChangesModal
        open={pendingOpen}
        onClose={() => setPendingOpen(false)}
        items={pendingItems}
        unitHint="金额单位：万元；数量按科目计量单位。"
      />

      {/* UX-10/UX-13 目标切换/离开/进入导入统一守卫:三选一,保存失败或取消不放行 */}
      <Modal
        open={guard != null}
        title={guard?.verb === '离开' ? '有未保存的实际数录入' : guard?.verb === '导入' ? '导入前有未保存的实际数录入' : '切换编辑目标'}
        closable={!guardSaving}
        maskClosable={false}
        keyboard={false}
        onCancel={cancelGuard}
        footer={[
          <Button key="stay" disabled={guardSaving} onClick={cancelGuard}>{guard?.verb === '导入' ? '取消导入' : '留在本页'}</Button>,
          <Button key="discard" danger disabled={guardSaving || saving} onClick={discardAndProceed}>
            放弃修改并{guard?.verb ?? '切换'}
          </Button>,
          <Button key="save" type="primary" loading={guardSaving || saving} onClick={() => void saveAndProceed()}>
            保存并{guard?.verb ?? '切换'}
          </Button>,
        ]}
      >
        <Typography.Paragraph style={{ marginBottom: 8 }}>
          待保存修改共 <b>{draft.totalDirty}</b> 项
          {draft.hiddenDirty > 0 ? <>，其中 <b>{draft.hiddenDirty}</b> 项不在当前视图</> : ''}
          。
          {guard?.verb === '离开' ? '离开本页' : guard?.verb === '导入' ? '开始导入' : `切换到「${guard?.nextLabel}」`}前请选择处理方式：
        </Typography.Paragraph>
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
          「保存并{guard?.verb ?? '切换'}」会先按当前期间摘要提交整包保存，成功后才{guard?.verb ?? '切换'}；
          「放弃修改并{guard?.verb ?? '切换'}」会把表格恢复到上次保存的内容。
        </Typography.Paragraph>
      </Modal>
      <Modal
        open={memoTarget != null}
        title={memoTarget?.summary ? '汇总格备注' : '实际数备注'}
        okText="保存"
        cancelText="取消"
        onCancel={() => setMemoTarget(null)}
        onOk={() => {
          if (!memoTarget) return;
          const key = `${memoTarget.orgId}:${memoTarget.accountId}`;
          const text = memoText.trim();
          if (memoTarget.summary) {
            // UX-23-6:汇总备注提交走统一撤销栈;弹窗「取消」不经过此处,只放弃本次弹窗输入
            applySummaryMemo(key, text);
          } else {
            grid.applyCells([{ key, note: text || null }], '实际数备注');
          }
          setMemoTarget(null);
        }}
      >
        {memoTarget?.summary && (
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            该格为汇总值（随明细自动计算），备注仅作批注，不影响数值汇总；保存实际数时一并落库。
          </Typography.Text>
        )}
        <Input.TextArea rows={5} maxLength={2000} showCount value={memoText} onChange={(e) => setMemoText(e.target.value)} placeholder={memoTarget?.summary ? '记录该汇总口径的整体说明' : '填写该实际数的来源或说明'} />
      </Modal>
      </div>

      <PasteSpecialModal
        open={pasteSpecialOpen}
        onClose={() => setPasteSpecialOpen(false)}
        targetLabel={grid.activeIds ? `${grid.activeIds.colLabel} · ${grid.activeIds.rowLabel}` : null}
        onApply={(text, opts) => {
          if (!grid.active) { message.warning('请先点击一个起始单元格'); return; }
          grid.reportPaste(grid.pasteText(text, grid.active.r, grid.active.c, opts));
        }}
      />

      <GridContextMenu
        open={ctxMenu.open}
        x={ctxMenu.x}
        y={ctxMenu.y}
        onClose={() => setCtxMenu((m) => ({ ...m, open: false }))}
        onAction={(key) => {
          switch (key) {
            case 'copy': void grid.copySelectionAsync(false); break;
            case 'copyHeader': void grid.copySelectionAsync(true); break;
            case 'paste': void grid.pasteAtActiveAsync(); break;
            case 'pasteSpecial': setPasteSpecialOpen(true); break;
            case 'fillDown': grid.fillDown(); break;
            case 'fillRight': grid.fillRight(); break;
            case 'clear': grid.clearSelectionValues(false); break;
            case 'clearAll': grid.clearSelectionValues(true); break;
            default: break;
          }
        }}
        items={[
          { key: 'copy', label: '复制选区(Ctrl+C,可粘到 Excel)' },
          { key: 'copyHeader', label: '复制选区(含表头)' },
          { key: 'paste', label: '粘贴到此处' },
          { key: 'pasteSpecial', label: '选择性粘贴…(转置/跳过空)' },
          { type: 'divider' },
          { key: 'fillDown', label: '向下填充(Ctrl+D)' },
          { key: 'fillRight', label: '向右填充(Ctrl+R)' },
          { key: 'clear', label: '清空数值(Delete)' },
          { key: 'clearAll', label: '清除全部' },
        ] satisfies MenuProps['items']}
      />

      <Card size="small" title={`实际快照批次(${editYear} 年)`} style={{ marginTop: 16 }}>
        <Table
          size="small" rowKey="id" loading={!batches} dataSource={batches ?? []}
          columns={[
            { title: '截止日期', dataIndex: 'snapshot_date', width: 110 },
            { title: '修订', dataIndex: 'revision', width: 60 },
            { title: '状态', dataIndex: 'status', width: 100, render: (s: string) => (s === 'active' ? <Tag color="green">active</Tag> : <Tag>superseded</Tag>) },
            { title: '来源', dataIndex: 'source', width: 100, render: (s: string) => SOURCE_LABEL[s] ?? s },
            { title: '更新当前实际', dataIndex: 'updates_current', width: 110, render: (v: number) => (v ? '是' : '否(补录)') },
            { title: '创建时间', dataIndex: 'created_at', width: 170, render: (v: string) => v.slice(0, 19).replace('T', ' ') },
            {
              title: '操作', width: 160,
              render: (_, b: Batch) => (
                <Space>
                  <Button size="small" onClick={() => download(`/io/export/snapshot/${b.id}`, `快照-${b.year}-${b.snapshot_date}-r${b.revision}.xlsx`)}>导出</Button>
                  {b.status === 'superseded' && (
                    <Popconfirm title="删除已替代的历史修订?" onConfirm={async () => {
                      try { await api.del(`/actual/batches/${b.id}`); message.success('已删除'); qc.invalidateQueries({ queryKey: ['batches'] }); void invalidateAnalysisQueries(qc); }
                      catch (e) { message.error(errorText(e)); }
                    }}>
                      <Button size="small" danger>删除</Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title="历史快照补录" style={{ marginTop: 16 }}>
        <Space wrap>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            补录允许任意历史截止日期,不更新当前实际;树口径使用导入时的当前树结构并记录绑定;同日重复导入生成新修订并替代旧快照。
          </Typography.Text>
        </Space>
        <Modal
          title="重新打开年度"
          open={reopenOpen}
          onCancel={() => setReopenOpen(false)}
          confirmLoading={reopening}
          okButtonProps={{
            disabled: !reopenReason.trim(),
            title: reopenReason.trim() ? undefined : '请先填写重开原因(将记录到操作日志)',
          }}
          onOk={async () => {
            // 原来:原因为空时 onOk 静默什么都不做;失败也照样关窗。现在禁用按钮并说明原因,
            // 请求期间锁定按钮防重复提交,失败保留弹窗与已填内容
            if (!reopenReason.trim()) { message.warning('请填写重开原因(将记录到操作日志)'); return; }
            setReopening(true);
            try { if (await openYear(reopenReason)) setReopenOpen(false); }
            finally { setReopening(false); }
          }}
        ><Input.TextArea rows={4} placeholder="请输入原因(将记录日志)" value={reopenReason} onChange={e=>setReopenReason(e.target.value)} /></Modal>
        <HistoryImport year={editYear} onDone={() => { qc.invalidateQueries({ queryKey: ['actual-matrix', editYear] }); qc.invalidateQueries({ queryKey: ['batches', editYear] }); void invalidateAnalysisQueries(qc); }} />
      </Card>
    </Card>
  );
}
