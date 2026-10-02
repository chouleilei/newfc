import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate, useBlocker, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, Button, App, Input, Typography, Tag, Alert, Result, Space } from 'antd';
import { EnhancedTable as Table } from '../components/EnhancedTable';
import { api } from '../api/client';
import { errorText } from '../components/TreeNodePage';
import { centsToWan, cellValueEquivalent, formatRatio, formatQuantity } from '../utils/money';
import MoneyText from '../components/MoneyText';
import { SPECIAL_SHEETS, findSheet, useSheets } from '../utils/sheets';
import { evaluateFormula } from '../utils/formula';
import { isAccountVisibleForScope } from '../utils/accountScope';
import { invalidateAnalysisQueries } from '../utils/queryInvalidation';
import { useGridInteraction, type CellUpdate } from '../hooks/useGridInteraction';
import { useSummaryNoteUndo } from '../hooks/useSummaryNoteUndo';
import { useFullscreenLayer } from '../hooks/useFullscreenLayer';
import { GridStatusBar, GridFormulaBar, GridFindReplace, PasteSpecialModal, GridContextMenu, useSessionState, loadSession, saveSession } from '../components/GridAddons';
import { buildPristineBudgetValues, buildPristineCellNotes, type CompilationStatus, type MatrixResponse, type SummaryResponse, type SummaryRatioMetric, type Row } from './budgetEdit/types';
import { useBudgetModel } from './budgetEdit/useBudgetModel';
import { useBudgetTotals } from './budgetEdit/useBudgetTotals';
import { useBudgetSaveOrchestration } from './budgetEdit/useBudgetSaveOrchestration';
import { BudgetHeaderActions } from './budgetEdit/BudgetHeaderActions';
import { SummaryCapsules } from './budgetEdit/SummaryCapsules';
import { GridFilterBar } from './budgetEdit/GridFilterBar';
import { BudgetGridTable } from './budgetEdit/BudgetGridTable';
import { NoteEditModal } from './budgetEdit/NoteEditModal';
import { LedgerDrawer } from './budgetEdit/LedgerDrawer';
import { CompilationDrawer } from './budgetEdit/CompilationDrawer';
import { QualityReportContent, type QualityReportData } from './budgetEdit/QualityReport';
import { FinalizeConfirmModal, SetCurrentConfirmModal, kindLabel } from './budgetEdit/VersionLifecycleConfirm';
import { ConflictRecoveryDrawer } from './budgetEdit/ConflictRecoveryDrawer';
import {
  buildRecoveryFile,
  buildResolutionPlan,
  captureBaseline,
  computeThreeWayDiff,
  overlayFromRecovery,
  parseRecoveryFile,
  validateRecoveryContent,
  type ImportOverlay,
} from './budgetEdit/conflictRecovery';
import type { MenuProps } from 'antd';
import { TableSkeleton } from '../components/Skeletons';
import { useAssistantFocus, useAssistantPageContext, useAssistantSelection, useAssistantSurface } from '../assistant/contextHooks';
import { DraftDescriptor } from '../assistant/context';
import { useUrlScopeSync } from '../hooks/useUrlScopeSync';
import type { ScopeIssue } from '../utils/workspaceScope';
import WorkspaceScopeBar from '../components/WorkspaceScopeBar';
import { useThemeMode, statusColor, financeColor } from '../theme';

/**
 * 预算编制:科目按行(缩进层级 + 汇总行)× 叶子组织做列。
 * 顶部用预设表(模板 7 张表)与组织子树筛选行列;叶子科目 × 叶子组织单元格可编辑(草稿)。
 * 行列模型/汇总计算/表格渲染/弹窗抽屉拆分在 ./budgetEdit/ 下,本文件负责装配与动作编排。
 */
export default function BudgetEdit() {
  const { mode } = useThemeMode();
  const sc = statusColor(mode);
  const fc = financeColor(mode);
  /* 徽标浅底一律由本色 12%/30% 派生,亮暗自换挡(不新增色相) */
  const softBg = (c: string, pct = 12) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
  const { id } = useParams();
  const versionId = Number(id);
  // URL 定位参数(进度总览「点击行跳转定位」新增能力):
  // ?orgId=<组织ID>[&accountId=<科目ID>] —— 数据加载完成后将网格焦点移动到该组织列(可带科目行)。
  const [searchParams] = useSearchParams();
  const locateOrgId = useMemo(() => {
    const raw = searchParams.get('orgId');
    const parsed = raw == null ? NaN : Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [searchParams]);
  const locateAccountId = useMemo(() => {
    const raw = searchParams.get('accountId');
    const parsed = raw == null ? NaN : Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [searchParams]);
  const locateAppliedRef = useRef<string | null>(null);
  const validVersionId = Number.isInteger(versionId) && versionId > 0;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message, modal } = App.useApp();

  // 附注与公式编辑弹窗
  const [noteModalOpen, setNoteModalOpen] = useState(false);
  const [noteTarget, setNoteTarget] = useState<{ orgId: number; row: Row; summary: boolean } | null>(null);
  const [noteFormText, setNoteFormText] = useState('');
  const [noteFormFormula, setNoteFormFormula] = useState('');

  // 汇总格备注(非叶子组织列/非叶子科目行):独立于网格交互层的页面级状态,
  // 与明细共用同一整包保存、同一 revision 并发保护;已提交的备注编辑经 useSummaryNoteUndo
  // 纳入网格统一撤销栈(UX-23-6),与明细操作按发生顺序撤销
  const [summaryNotes, setSummaryNotes] = useState<Map<string, string>>(new Map());

  // 测算底稿附注台账抽屉
  const [ledgerDrawerOpen, setLedgerDrawerOpen] = useState(false);
  const [compilationDrawerOpen, setCompilationDrawerOpen] = useState(false);
  const [compilationFocusCell, setCompilationFocusCell] = useState<{ orgId: number; accountId: number } | null>(null);
  const [checkpointPending, setCheckpointPending] = useState(false);
  const [draftActionPending, setDraftActionPending] = useState(false);

  const [sheetKey, setSheetKey] = useState<string>('profit');
  const [orgColScopeId, setOrgColScopeId] = useState<number | null>(null);
  const [keyword, setKeyword] = useState('');
  const [nonZeroOnly, setNonZeroOnly] = useState(false);
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [collapseLevel, setCollapseLevel] = useState<number | null>(null); // null=全部展开; 0=仅一级汇总; 1=二大类
  const { sheets: dbSheets, loading: sheetsLoading } = useSheets();
  /* UX-06:全部科目(all)纳入可选视图——按版本快照构造行模型,不依赖自定义模板恰好存在 */
  const sheetOptions = useMemo(
    () => [...SPECIAL_SHEETS, ...dbSheets],
    [dbSheets]
  );

  /* 科目表切换:与 GridFilterBar 同一路径(重置层级展开、关闭附注弹窗);同值幂等,
     因为 URL 写回后的再解析会再次经过这里。同时记忆为该版本最近使用的视图(UX-06)。 */
  const changeSheet = (k: string) => {
    if (k === sheetKey) return;
    setSheetKey(k);
    saveSession(`newfc-budget-sheet-${versionId}`, k);
    setCollapseLevel(null);
    /* 附注弹窗若仍开着,noteTarget 是旧表的 row 对象,保存会写入已不存在的 row key
       (summary 分支无守卫,直接 setSummaryNotes 随整包提交)。切表时强制关闭。 */
    setNoteModalOpen(false);
    setNoteTarget(null);
  };

  /* URL 范围契约(UX-02):?sheet= 进 URL,刷新/书签恢复同一科目表;orgId/accountId
     仍是一次性定位参数(见下方 locate 效应),不参与镜像写回。
     非法科目表给出可见原因并保持当前表,不静默换成另一个编辑视图。 */
  const [scopeIssues, setScopeIssues] = useState<ScopeIssue[]>([]);
  const pendingUrlSheetRef = useRef<string | null>(null);
  /** pendingUrlSheetRef 内容变化的信号(页内 search 变化也要重新走归属校验) */
  const [pendingSheetVersion, setPendingSheetVersion] = useState(0);
  useUrlScopeSync('budget_edit', { sheet: sheetKey }, (parsed) => {
    if (parsed.scope.sheet) {
      pendingUrlSheetRef.current = parsed.scope.sheet;
      setPendingSheetVersion((v) => v + 1);
    }
    if (parsed.issues.length > 0) {
      setScopeIssues((prev) => [...prev, ...parsed.issues.filter((issue) => !prev.some((p) => p.key === issue.key && p.raw === issue.raw))]);
    }
  }, { keys: ['sheet'] });

  /* 科目表归属校验依赖预设表清单(异步):清单就绪后再应用或给出失效原因 */
  useEffect(() => {
    const pending = pendingUrlSheetRef.current;
    if (pending == null || sheetsLoading) return;
    pendingUrlSheetRef.current = null;
    if (pending === sheetKey) return;
    const target = sheetOptions.find((s) => s.key === pending);
    if (target) {
      changeSheet(pending);
    } else {
      const currentName = sheetOptions.find((s) => s.key === sheetKey)?.name ?? sheetKey;
      setScopeIssues((prev) => (prev.some((p) => p.key === 'sheet' && p.raw === pending) ? prev : [...prev, {
        key: 'sheet', field: 'sheet', raw: pending, reason: 'not_found',
        detail: `链接中的科目表「${pending}」不存在,已保持当前「${currentName}」`,
      }]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheetsLoading, sheetOptions, pendingSheetVersion]);

  // 手感增强 UI 状态:查找替换 / 选择性粘贴 / 右键菜单 / 行密度
  const [findState, setFindState] = useState<{ open: boolean; mode: 'find' | 'replace' }>({ open: false, mode: 'find' });
  const [pasteSpecialOpen, setPasteSpecialOpen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ open: boolean; x: number; y: number; r: number; c: number }>({ open: false, x: 0, y: 0, r: 0, c: 0 });
  const [density, setDensity] = useSessionState<'compact' | 'standard' | 'relaxed'>('newfc-grid-density', 'compact');
  const [fullscreen, setFullscreen] = useState(false);
  const exitFullscreen = useCallback(() => setFullscreen(false), []);
  useFullscreenLayer(fullscreen, exitFullscreen);

  /* ---------- 行列模型(查询 + 预设表展开 + 多级组织列) ---------- */
  const model = useBudgetModel(versionId, sheetKey, orgColScopeId, dbSheets);
  const { data, metricsData, rowIndex, rows, rowById, orgIndex, effectiveOrgScope, orgCols, orgDisplayCols, collapsedOrgCols, toggleCollapseOrgCol, orgNavCols, orgTreeData } = model;
  const [visibleOrgNavCols, setVisibleOrgNavCols] = useState<number[]>(orgNavCols);
  const handleVisibleOrgLeafIdsChange = useCallback((next: number[]) => {
    setVisibleOrgNavCols((current) => current.length === next.length && current.every((orgId, index) => orgId === next[index]) ? current : next);
  }, []);

  const editable = data?.version.status === 'draft';

  /* UX-06 默认视图(每个版本各解析一次,URL 显式 ?sheet= 优先,由上方归属校验效应处理):
     1. 草稿:恢复该版本上次使用的有效视图(会话内记忆,视图被删除则放弃),
        无记忆(新草稿首次进入)落在可填写的「全部科目」;
     2. 定稿/归档:默认只读「一级汇总」。 */
  const [sheetDefaultedFor, setSheetDefaultedFor] = useState<number | null>(null);
  useEffect(() => {
    if (sheetDefaultedFor === versionId) return;
    if (!data || sheetsLoading) return;
    if (searchParams.get('sheet') != null) { setSheetDefaultedFor(versionId); return; }
    setSheetDefaultedFor(versionId);
    const remembered = loadSession<string>(`newfc-budget-sheet-${versionId}`, '');
    const rememberedValid = remembered !== '' && sheetOptions.some((s) => s.key === remembered);
    const target = data.version.status === 'draft'
      ? (rememberedValid ? remembered : 'all')
      : 'overview';
    if (target !== sheetKey) changeSheet(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, sheetsLoading, sheetOptions, versionId, sheetDefaultedFor, searchParams]);

  const compilationQuery = useQuery({
    queryKey: ['budget-checkpoints', versionId],
    queryFn: () => api.get<CompilationStatus>(`/versions/${versionId}/checkpoints`),
    enabled: validVersionId,
  });
  const checkpointCellCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of compilationQuery.data?.items ?? []) for (const change of item.changes) {
      const key = `${change.orgId}:${change.accountId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [compilationQuery.data]);
  const qualityQuery = useQuery({
    queryKey: ['budget-quality', versionId],
    queryFn: () => api.get<QualityReportData>(`/versions/${versionId}/quality`),
    enabled: validVersionId,
  });

  const refreshSummary = useCallback(async () => {
    const s = await api.get<SummaryResponse>(`/versions/${versionId}/summary`);
    setSummary(s);
  }, [versionId]);
  useEffect(() => {
    if (!validVersionId) return;
    void refreshSummary().catch(() => undefined);
  }, [refreshSummary, validVersionId]);

  /* ---------- 统一表格交互层(选区/撤销/粘贴/填充/查找,见《预算表格手感优化方案》) ---------- */
  const grid = useGridInteraction({
    getRows: () => visibleRows.filter((r): r is Row => r.kind === 'account' && r.isLeaf).map((r) => ({ id: r.id, type: r.type, label: `${r.code} ${r.name}` })),
    getCols: () => visibleOrgNavCols.map((id) => ({ id, label: orgIndex.byId.get(id)?.name ?? String(id) })),
    isCellEditable: (rowId, colId) => cellEditable(rowById.get(rowId), colId),
    cellDomId: (rowId, colId) => `cell-${colId}-${rowId}`,
    onOpenNote: (rowId, colId) => openNoteModal(rowId, colId),
    onOpenFind: (mode) => setFindState({ open: true, mode }),
    onOpenPasteSpecial: () => setPasteSpecialOpen(true),
    notify: (type, text) => message[type](text),
    persistKey: `newfc-budget-${versionId}`,
  });
  const { values, formulas, notes, invalidCells, dirty, markPersisted, resetData } = grid;

  /* ---------- 保存编排(UX-05):自动保存防抖、Ctrl/Cmd+S 立即排空保存、串行保存队列、
       失败/格式错误/并发冲突的持续反馈;与「记录本轮修改」彻底分离 ---------- */
  const {
    autoSaveState, lastAutoSavedAt, saveConflict, saveError, anyDirty,
    latestDraftRef, revisionRef, baselineRef, savePendingCountRef, summaryNotesPristineRef, summaryNotesRef, summaryNotesDirtyRef,
    buildSavePayload, drainDraftSaves, waitForInFlightSaves, requestSaveNow, runAfterSaves, reloadAfterConflict,
    beginConflictResolution, saveResolvedDraft, reenterConflict,
  } = useBudgetSaveOrchestration({
    versionId, data, editable, draftActionPending, dirty,
    invalidCount: invalidCells.size,
    values, formulas, notes, summaryNotes, setSummaryNotes,
    markPersisted, resetData, refreshSummary,
  });
  const editingEnabled = editable && !draftActionPending && !saveConflict;

  /* UX-23-6:汇总格备注的已提交编辑纳入网格统一撤销栈,与明细操作按发生顺序撤销;
     定稿/冲突等只读期间重放被 canEdit 守卫拒绝,只读限制不被撤销绕过 */
  const applySummaryNote = useSummaryNoteUndo({
    grid,
    notes: summaryNotes,
    setNote: (key, text) => setSummaryNotes((prev) => {
      const next = new Map(prev);
      if (text) next.set(key, text); else next.delete(key);
      return next;
    }),
    canEdit: editingEnabled,
  });

  /* ---------- UX-20/UX-21 并发冲突恢复:三方差异、导出/导入本地修改、选定恢复 ---------- */
  const [conflictDrawerOpen, setConflictDrawerOpen] = useState(false);
  /** 冲突时拉取的服务器最新矩阵(只用于比较与恢复,不覆盖网格) */
  const [conflictServer, setConflictServer] = useState<MatrixResponse | null>(null);
  const [conflictFetchError, setConflictFetchError] = useState<string | null>(null);
  const [conflictLoading, setConflictLoading] = useState(false);
  /** 用户勾选要恢复的本地修改(默认全不选 = 保留服务器值) */
  const [conflictSelected, setConflictSelected] = useState<Set<string>>(new Set());
  /** 导入恢复文件后的本地侧重叠(走同一差异确认流程) */
  const [importOverlay, setImportOverlay] = useState<ImportOverlay | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingResolution, setPendingResolution] = useState<{
    updates: CellUpdate[];
    merged: { values: Map<string, string>; formulas: Map<string, string>; notes: Map<string, string>; summaryNotes: Map<string, string> };
    server: MatrixResponse;
  } | null>(null);
  const [resolving, setResolving] = useState(false);

  // 冲突发生/重新发生:拉取最新服务器矩阵用于三方比较;冲突解除(恢复成功/放弃/切版本)时清空会话状态
  useEffect(() => {
    if (!saveConflict) {
      setConflictServer(null);
      setConflictFetchError(null);
      setConflictLoading(false);
      setConflictDrawerOpen(false);
      setConflictSelected(new Set());
      setImportOverlay(null);
      setImportError(null);
      return;
    }
    let cancelled = false;
    setConflictLoading(true);
    setConflictFetchError(null);
    api.get<MatrixResponse>(`/versions/${versionId}/matrix`)
      .then((m) => { if (!cancelled) { setConflictServer(m); setConflictSelected(new Set()); } })
      .catch((e) => { if (!cancelled) setConflictFetchError(errorText(e)); })
      .finally(() => { if (!cancelled) setConflictLoading(false); });
    return () => { cancelled = true; };
  }, [saveConflict, versionId]);

  const conflictBaseline = baselineRef.current ?? (data ? captureBaseline(data) : null);
  const accountTypeOf = useCallback(
    (accountId: number) => (conflictServer ?? data)?.accountNodes.find((n) => n.id === accountId)?.type,
    [conflictServer, data],
  );
  const conflictDiff = useMemo(() => {
    if (!conflictServer || !conflictBaseline) return null;
    return computeThreeWayDiff({
      baseline: conflictBaseline,
      local: { values, formulas, notes, summaryNotes },
      server: conflictServer,
      accountTypeOf,
      overlay: importOverlay,
    });
  }, [conflictServer, conflictBaseline, values, formulas, notes, summaryNotes, accountTypeOf, importOverlay]);

  /** 导出本地待保存修改:当前浏览器中的未提交输入 + 版本/基线标识,不含认证信息 */
  const exportLocalRecovery = useCallback(() => {
    if (!conflictDiff || !conflictBaseline || !data) return;
    const file = buildRecoveryFile({
      versionId,
      versionName: data.version.name,
      year: data.version.year,
      baselineRevision: conflictBaseline.revision,
      diffs: conflictDiff.diffs,
      localDisplay: values,
    });
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `预算冲突恢复-v${versionId}-r${conflictBaseline.revision}.json`;
    a.click();
    URL.revokeObjectURL(url);
    message.success('已导出本地待保存修改');
  }, [conflictDiff, conflictBaseline, data, values, versionId, message]);

  /** 导入恢复文件:版本/格式校验失败明确拒绝;通过后并入本地侧,重新走差异确认 */
  const importRecoveryFile = useCallback((file: File) => {
    setImportError(null);
    void file.text().then((text) => {
      const parsed = parseRecoveryFile(text, versionId);
      if (!parsed.ok) {
        setImportError(parsed.error);
        return;
      }
      const errors = validateRecoveryContent(parsed.file, accountTypeOf);
      if (errors.length > 0) {
        setImportError(errors.join('；'));
        return;
      }
      setImportOverlay(overlayFromRecovery(parsed.file));
      if (conflictBaseline && parsed.file.baselineRevision !== conflictBaseline.revision) {
        message.warning(`恢复文件导出自基线修订 ${parsed.file.baselineRevision}，与当前基线 ${conflictBaseline.revision} 不同，已按当前基线重新比对`);
      }
      message.success(`已载入 ${parsed.file.entries.length + parsed.file.summaryNotes.length} 项本地修改，请在差异清单中勾选确认`);
    }).catch((e) => setImportError(errorText(e)));
  }, [versionId, accountTypeOf, conflictBaseline, message]);

  /** 应用选定恢复项:基于最新服务器矩阵构造变更 -> 校验 -> 明确确认 -> 现有保存链路 */
  const applyConflictResolution = useCallback(() => {
    if (!conflictDiff || !conflictServer) return;
    const plan = buildResolutionPlan({
      diffs: conflictDiff.diffs,
      selectedKeys: conflictSelected,
      server: conflictServer,
      accountTypeOf,
      current: { values, formulas, notes, summaryNotes },
    });
    if (plan.errors.length > 0) {
      modal.error({
        title: '恢复项包含无法提交的内容',
        content: plan.errors.slice(0, 10).join('\n'),
      });
      return;
    }
    modal.confirm({
      title: '应用选定的本地修改',
      content: `将以服务器最新数据为基础，恢复 ${conflictSelected.size} 项本地修改并立即保存；未勾选的本地修改会被服务器值覆盖（可先导出 JSON 备份）。保存仍带并发校验，期间服务器若再被修改会重新报冲突。`,
      okText: '应用并保存',
      cancelText: '再想想',
      onOk: () => {
        beginConflictResolution(conflictServer);
        setPendingResolution({ updates: plan.updates, merged: plan.merged, server: conflictServer });
        setConflictDrawerOpen(false);
      },
    });
  }, [conflictDiff, conflictServer, conflictSelected, accountTypeOf, values, formulas, notes, summaryNotes, modal, beginConflictResolution]);

  /* 恢复写入在冲突锁解除后的渲染提交阶段执行:applyCells 的可编辑守卫读到的是渲染期闭包,
     同一事件处理器内 setState 尚未生效,直接调用会被全部跳过 */
  useEffect(() => {
    if (!pendingResolution || saveConflict) return;
    const { updates, merged, server } = pendingResolution;
    setPendingResolution(null);
    const result = grid.applyCells(updates, '冲突恢复');
    setSummaryNotes(new Map(merged.summaryNotes));
    if (result.invalid > 0) {
      message.error('恢复的修改包含无法提交的格式，已保持冲突暂停状态，请修正标红单元格');
      reenterConflict();
      return;
    }
    setResolving(true);
    void saveResolvedDraft(
      { values: merged.values, formulas: merged.formulas, notes: merged.notes, summaryNotes: merged.summaryNotes },
      server.version.revision,
      buildPristineBudgetValues(server),
    )
      .then(() => message.success('已在服务器最新数据上应用选定修改并保存'))
      .catch(() => undefined)
      .finally(() => setResolving(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingResolution, saveConflict]);

  /** 科目-组织适用范围按"单个组织"判定(与实际数页/后端校验同口径):每个叶子列只能编制对该组织适用的科目 */
  const cellEditable = (row: Row | undefined, orgId: number): boolean => {
    if (!editingEnabled || !row || !row.isLeaf || row.status === 'inactive') return false;
    if (!visibleOrgNavCols.includes(orgId)) return false;
    const orgCode = orgIndex.byId.get(orgId)?.code;
    return orgCode != null && isAccountVisibleForScope(row.code, new Set([orgCode]));
  };

  /* ---------- 财务助手页面登记(§7.2 budget_edit) ---------- */
  useAssistantPageContext({
    pageKey: 'budget_edit',
    ready: Boolean(data?.version),
    notReadyReason: '正在读取预算版本与矩阵',
    readyState: 'loading',
    scope: {
      budgetVersionId: validVersionId ? versionId : undefined,
      year: data?.version.year,
      orgScopeId: orgColScopeId ?? undefined,
    },
    view: {
      sheetKey,
      ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
      ...(nonZeroOnly ? { nonZeroOnly } : {}),
      ...(collapseLevel != null ? { collapseLevel } : {}),
    },
    dirty: dirty && Boolean(editable),
    dirtyCount: dirty && editable ? grid.dirtyCount : 0,
    serializeDraft: () => {
      const latest = latestDraftRef.current;
      if (!latest.dirty || !data || !editable) return null;
      // 只发送脏单元格；解析与整包保存同一套 buildSavePayload(§9.6 复用保存 DTO)。
      const payload = buildSavePayload(latest, grid.dirtyKeys);
      return {
        kind: 'budget_grid',
        base: {
          versionId,
          revision: revisionRef.current ?? data.version.revision,
          orgTreeSnapshotId: data.version.org_tree_snapshot_id,
          accountTreeSnapshotId: data.version.account_tree_snapshot_id,
        },
        changes: payload.entries,
      } satisfies DraftDescriptor;
    },
  });

  // 当前单元格焦点(§5.5 cell)：行=科目，列=组织。
  useAssistantFocus(
    grid.activeIds && data
      ? { kind: 'cell', source: 'budget', sourceId: versionId, orgId: grid.activeIds.colId, accountId: grid.activeIds.rowId, valueKind: 'amount' }
      : null,
    grid.activeIds ? `${grid.activeIds.colLabel} × ${grid.activeIds.rowLabel}` : null,
  );

  // 浮层登记(§5.4)：附注弹窗 / 台账抽屉 / 编制记录抽屉 / 右键菜单。
  useAssistantSurface({
    open: noteModalOpen,
    kind: 'modal',
    key: 'note_editor',
    entity: noteTarget ? { entityType: 'account', id: noteTarget.row.id } : null,
  });
  useAssistantSurface({ open: ledgerDrawerOpen, kind: 'drawer', key: 'ledger' });
  useAssistantSurface({ open: compilationDrawerOpen, kind: 'drawer', key: 'compilation' });
  useAssistantSurface({ open: ctxMenu.open, kind: 'context_menu', key: 'grid_menu' });

  // 只有本地无未保存修改时才接受查询返回的新基线。否则后台刷新可能
  // 将他人的新 revision 配给本地旧整包，反而绕过冲突保护。
  useEffect(() => {
    if (!data || dirty || saveConflict || savePendingCountRef.current > 0) return;
    revisionRef.current = data.version.revision;
  }, [data, dirty, saveConflict]);

  // 数据加载 -> 统一交互层重置(快照/撤销栈/脏格/校验态)。
  // 保存后回读与服务端一致(仅显示格式差异)时不重置——保留撤销栈("保存不清栈"承诺);
  // 有未保存编辑(含汇总格备注)时不自动覆盖(避免后台 refetch 重建 data 对象时误清用户输入)
  useEffect(() => {
    if (!data) return;
    if (dirty || summaryNotesDirtyRef.current) return;
    const pristine = buildPristineBudgetValues(data);
    let same = pristine.values.size === values.size
      && pristine.formulas.size === formulas.size
      && pristine.notes.size === notes.size;
    if (same) {
      for (const [k, v] of pristine.values) {
        if (!values.has(k) || !cellValueEquivalent(values.get(k) ?? '', v)) { same = false; break; }
      }
    }
    if (same) {
      for (const [k, f] of pristine.formulas) {
        if (formulas.get(k) !== f) { same = false; break; }
      }
    }
    if (same) {
      for (const [k, n] of pristine.notes) {
        if (notes.get(k) !== n) { same = false; break; }
      }
    }
    if (!same) grid.resetData(pristine.values, pristine.formulas, pristine.notes);
    // 汇总格备注与明细同一响应包,独立比对独立重置
    const pristineNotes = buildPristineCellNotes(data);
    let sameNotes = pristineNotes.size === summaryNotesRef.current.size;
    if (sameNotes) {
      for (const [k, v] of pristineNotes) {
        if (summaryNotesRef.current.get(k) !== v) { sameNotes = false; break; }
      }
    }
    if (!sameNotes) {
      summaryNotesPristineRef.current = pristineNotes;
      setSummaryNotes(pristineNotes);
    }
    // 焦点位置记忆恢复(等待渲染完成);带 ?orgId= 定位时由下方定位效应覆盖。
    const t = setTimeout(() => { if (!locatePendingRef.current) grid.restoreFocus(); }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  /* ---------- 取值与汇总(自底向上记忆化 + 利润表勾稽) ---------- */
  const totals = useBudgetTotals({ values, data, metricsData, sheetKey, dbSheets, rowIndex, rowById, orgIndex, orgCols });
  const { totalCache, orgAccTotals, metricValue, displayTotal, rowHasValue } = totals;

  const visibleRows = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return rows.filter((r) => {
      if (collapseLevel != null && r.kind === 'account' && r.depth > collapseLevel) return false;
      const text = r.label ? `${r.code} ${r.name} ${r.label}` : `${r.code} ${r.name}`;
      if (kw && !text.toLowerCase().includes(kw)) return false;
      if (nonZeroOnly && !rowHasValue(r)) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, keyword, nonZeroOnly, collapseLevel, orgCols, totalCache, orgAccTotals, rowHasValue]);

  // 矩形选区 → bounds(§5.6)：行=叶子科目，列=组织。超过 500 项时后端拒绝截断式 refs,bounds 天然覆盖全部。
  const gridLeafRows = useMemo(
    () => visibleRows.filter((r): r is Row => r.kind === 'account' && r.isLeaf),
    [visibleRows],
  );
  useAssistantSelection(
    grid.selection && grid.selectionSize > 1
      ? {
        mode: 'bounds',
        bounds: {
          sheetKey,
          orgIds: visibleOrgNavCols.slice(grid.selection.c1, grid.selection.c2 + 1),
          accountIds: gridLeafRows.slice(grid.selection.r1, grid.selection.r2 + 1).map((row) => row.id),
        },
      }
      : null,
  );

  /** 可编辑叶子行的网格行号(交互层坐标系) */
  const gridRowIdx = useMemo(() => {
    const m = new Map<number, number>();
    visibleRows.forEach((r) => { if (r.kind === 'account' && r.isLeaf) m.set(r.id, m.size); });
    return m;
  }, [visibleRows]);
  const gridColIdx = useMemo(() => new Map(visibleOrgNavCols.map((id, i) => [id, i] as const)), [visibleOrgNavCols]);

  /** UX-23-1:定稿/归档版本「基于此版继续编制」——走与版本列表相同的复制流程生成新草稿,创建后直接进入可编辑明细 */
  const continueFromLocked = useCallback(() => {
    const baseName = data?.version.name ?? '预算';
    let name = `${baseName}-修订`;
    modal.confirm({
      title: '基于此版继续编制',
      content: (
        <div>
          <div style={{ marginBottom: 8, color: 'var(--newfc-text-tertiary)' }}>将复制当前版本（含全部明细与备注）生成新草稿，原定稿版本不变；创建后直接进入新草稿开始编制。</div>
          <Input defaultValue={name} maxLength={80} onChange={(e) => { name = e.target.value; }} />
        </div>
      ),
      okText: '复制为新草稿',
      cancelText: '取消',
      onOk: async () => {
        const created = await api.post<{ id: number }>(`/versions/${versionId}/copy`, { name: name.trim() || `${baseName}-修订` });
        message.success('已复制为新草稿');
        navigate(`/budget/${created.id}?sheet=all`);
      },
    });
  }, [data?.version.name, modal, versionId, message, navigate]);

  /* UX-23-4:被筛选/列配置隐藏的待保存格计数(预算为整包保存,网格脏格即待保存口径) */
  const budgetHiddenDirty = useMemo(() => {
    if (!grid.dirty) return 0;
    const rowIds = new Set(gridRowIdx.keys());
    const colIds = new Set(gridColIdx.keys());
    let n = 0;
    for (const k of grid.dirtyKeys) {
      const [c, r] = k.split(':').map(Number);
      if (!rowIds.has(r) || !colIds.has(c)) n++;
    }
    return n;
  }, [grid.dirty, grid.dirtyKeys, gridRowIdx, gridColIdx]);

  /* 汇总格备注脏项计数:与明细脏格一并计入状态栏「待保存修改」总数 */
  const summaryDirtyCount = useMemo(() => {
    const pristine = summaryNotesPristineRef.current;
    let n = 0;
    for (const k of new Set([...summaryNotes.keys(), ...pristine.keys()])) {
      if ((summaryNotes.get(k) ?? '') !== (pristine.get(k) ?? '')) n++;
    }
    return n;
    // summaryNotesPristineRef 仅在保存/加载/导入时前进,均伴随 summaryNotes 或 data 变化
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaryNotes, data]);

  /** URL 定位(?orgId=[&accountId=]):数据与索引就绪后聚焦目标格,优先于位置记忆恢复。 */
  const locatePendingRef = useRef(false);
  /* 定位失败提示只发一次:目标列被列配置持久化隐藏时 c/r 恒为 undefined,
     原逻辑静默 return,用户从进度总览跳过来后页面毫无定位反馈。 */
  const locateNotifiedRef = useRef<string | null>(null);
  useEffect(() => {
    if (locateOrgId == null || !data) return;
    const key = `${versionId}:${locateOrgId}:${locateAccountId ?? ''}`;
    if (locateAppliedRef.current === key) return;
    const c = gridColIdx.get(locateOrgId);
    const r = locateAccountId != null ? gridRowIdx.get(locateAccountId) : gridRowIdx.keys().next().value;
    if (c == null || r == null) {
      if (locateNotifiedRef.current !== key) {
        locateNotifiedRef.current = key;
        message.info(c == null ? '目标组织列已被列配置隐藏,请在列配置中恢复后再定位' : '目标科目行不在当前预算表中');
      }
      return;
    }
    locatePendingRef.current = true;
    const t = setTimeout(() => {
      grid.focusCell(r, c);
      locateAppliedRef.current = key;
      locatePendingRef.current = false;
    }, 260);
    return () => { clearTimeout(t); locatePendingRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, locateOrgId, locateAccountId, gridRowIdx, gridColIdx, versionId]);

  const openNoteModal = (rowId: number, orgId: number) => {
    const row = rowById.get(rowId);
    if (!row) return;
    const key = `${orgId}:${row.id}`;
    // 叶子组织 × 叶子科目的附注在明细行上;其余(汇总列/汇总科目行)走汇总格备注
    const leafOrgSet = new Set(data?.leafOrgIds ?? []);
    const isSummary = !row.isLeaf || !leafOrgSet.has(orgId);
    setNoteTarget({ orgId, row, summary: isSummary });
    setNoteFormText(isSummary ? (summaryNotes.get(key) ?? '') : (notes.get(key) ?? ''));
    setNoteFormFormula(isSummary ? '' : (formulas.get(key) ?? ''));
    setNoteModalOpen(true);
  };

  /** 附注与公式弹窗保存:叶子格走 applyCells 统一入口(公式求值/校验/撤销入栈);汇总格写入页面级备注状态 */
  const handleSaveNoteModal = () => {
    if (!noteTarget) return;
    const { orgId, row, summary } = noteTarget;
    const key = `${orgId}:${row.id}`;
    const newNote = noteFormText.trim();
    const newFormula = noteFormFormula.trim();

    if (summary) {
      // UX-23-6:汇总备注提交走统一撤销栈;「取消」不经过此处,只放弃本次弹窗输入
      applySummaryNote(key, newNote);
      setNoteModalOpen(false);
      message.success('已更新汇总格备注');
      return;
    }

    if (newFormula) {
      const evalRes = evaluateFormula(newFormula, row.type === 'quantity' ? 4 : 2);
      if (!evalRes.ok) {
        message.error(`公式格式有误: ${evalRes.error}`);
        return;
      }
    }

    grid.applyCells([{ key, formula: newFormula || null, note: newNote || null, type: row.type }], '附注与公式');

    setNoteModalOpen(false);
    message.success('已更新单元格测算依据与公式');
  };

  /* ---------- 导入 / 清空 / 编制记录 / 定稿(保存编排见 useBudgetSaveOrchestration) ---------- */
  /**
   * UX-13 导入互斥·准备阶段:创建任何导入预览前排空自动保存队列并保存最新草稿,
   * 随后锁定编辑目标(draftActionPending → 网格/汇总格禁输入、自动保存暂停),
   * 直至确认或取消。不能到确认时才保存草稿——那会让自己的保存使刚生成的预览基线失效。
   */
  const prepareImport = useCallback(async (): Promise<boolean> => {
    if (draftActionPending) return false;
    setDraftActionPending(true);
    try {
      await drainDraftSaves();
      return true;
    } catch (e) {
      setDraftActionPending(false);
      message.error(`导入前保存草稿失败，已取消导入：${errorText(e)}`);
      return false;
    }
  }, [draftActionPending, drainDraftSaves, message]);
  /** 取消/失败时解除导入编辑锁;确认成功由 importBudget 解锁 */
  const releaseImportLock = useCallback(() => setDraftActionPending(false), []);

  /**
   * 导入提交后的数据采用(标准预览与清洗向导共用;UX-15):
   * 确认(只发批次 ID,含结果未知恢复)已在统一预览面板/清洗向导内完成,
   * 这里只读取服务端真值刷新网格并解锁;失败不重复提示,由调用方(面板)统一说明。
   */
  const importBudget = useCallback(async (importBatchId: number) => {
    try {
      // dirty 状态会阻止普通 query 回读覆盖本地网格，因此导入后必须显式采用服务端真值。
      const imported = await api.get<MatrixResponse>(`/versions/${versionId}/matrix`);
      revisionRef.current = imported.version.revision;
      const pristine = buildPristineBudgetValues(imported);
      qc.setQueryData(['budget-matrix', versionId], imported);
      resetData(pristine.values, pristine.formulas, pristine.notes);
      const importedNotes = buildPristineCellNotes(imported);
      summaryNotesPristineRef.current = importedNotes;
      setSummaryNotes(importedNotes);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['budget-checkpoints', versionId] }),
        refreshSummary(),
        invalidateAnalysisQueries(qc),
      ]);
      message.success(`导入成功(批次 #${importBatchId})，已刷新为服务器数据`);
      setDraftActionPending(false);
    } catch (e) {
      // 批次已提交,仅本地刷新失败:解锁避免死锁,错误抛出由面板提示「请手动刷新」
      setDraftActionPending(false);
      throw e;
    }
  }, [message, qc, refreshSummary, resetData, versionId]);

  const clear = useMutation({
    mutationFn: async () => {
      await waitForInFlightSaves();
      const expectedRevision = revisionRef.current;
      if (expectedRevision == null) throw new Error('预算草稿修订基线尚未加载');
      return api.del<{ deleted: number; revision: number }>(`/versions/${versionId}/entries`, { expectedRevision });
    },
    onSuccess: (result) => {
      revisionRef.current = result.revision;
      message.success('已清空');
      grid.resetData(new Map(), new Map(), new Map());
      summaryNotesPristineRef.current = new Map();
      setSummaryNotes(new Map());
      qc.invalidateQueries({ queryKey: ['budget-matrix', versionId] });
      qc.invalidateQueries({ queryKey: ['budget-checkpoints', versionId] });
      void refreshSummary();
      void invalidateAnalysisQueries(qc);
    },
    onError: (e) => message.error(errorText(e)),
  });

  /* ---------- UX-07 定稿/采用确认(与版本列表共用同一确认组件,均携带条件校验字段) ---------- */
  const [finalizeConfirm, setFinalizeConfirm] = useState<{ quality: QualityReportData } | null>(null);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [finalizeSubmitting, setFinalizeSubmitting] = useState(false);
  const [setCurrentConfirm, setSetCurrentConfirm] = useState<{ previousCurrent: { id: number; name: string } | null } | null>(null);
  const [setCurrentError, setSetCurrentError] = useState<string | null>(null);
  const [setCurrentSubmitting, setSetCurrentSubmitting] = useState(false);

  /** 采用确认前取该年度同用途的原采用版本(null=无),作为 expectedCurrentVersionId 复核基线 */
  const openSetCurrentConfirm = useCallback(async () => {
    if (!data) return;
    try {
      const list = await api.get<{ id: number; name: string; kind: 'budget' | 'forecast'; is_current: 0 | 1 }[]>(`/versions?year=${data.version.year}`);
      const prev = list.find((x) => x.kind === data.version.kind && x.is_current === 1 && x.id !== versionId);
      setSetCurrentError(null);
      setSetCurrentConfirm({ previousCurrent: prev ? { id: prev.id, name: prev.name } : null });
    } catch (e) {
      message.error(errorText(e));
    }
  }, [data, message, versionId]);

  const confirmSetCurrent = useCallback(async () => {
    if (!setCurrentConfirm || !data) return;
    setSetCurrentSubmitting(true);
    try {
      await api.post(`/versions/${versionId}/set-current`, { expectedCurrentVersionId: setCurrentConfirm.previousCurrent?.id ?? null });
      setSetCurrentConfirm(null);
      message.success(`已设为当前${kindLabel(data.version.kind)}`);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['budget-matrix', versionId] }),
        qc.invalidateQueries({ queryKey: ['versions'] }),
        invalidateAnalysisQueries(qc),
      ]);
    } catch (e) {
      /* 409 等:后端原因内联展示并保留弹窗,同时刷新数据让确认方看到最新采用状态 */
      setSetCurrentError(errorText(e));
      void qc.invalidateQueries({ queryKey: ['budget-matrix', versionId] });
    } finally {
      setSetCurrentSubmitting(false);
    }
  }, [setCurrentConfirm, data, message, qc, versionId]);

  /** 「记录本轮修改」:独立按钮,可选说明;先排空保存队列,再把记录动作串行排进同一队列。 */
  const recordCompilation = useCallback(() => {
    let title = '';
    modal.confirm({
      title: '记录本轮修改',
      content: (
        <div>
          <div style={{ marginBottom: 8, color: 'var(--newfc-text-tertiary)' }}>草稿会先完成保存，再记录相对上次记录点的具体变化；说明可选。数据保存不依赖本操作。</div>
          <Input placeholder="可选：如“第一轮部门讨论”" maxLength={80} onChange={(e) => { title = e.target.value; }} />
        </div>
      ),
      okText: '生成记录',
      onOk: async () => {
        setCheckpointPending(true);
        try {
          await drainDraftSaves();
          const result = await runAfterSaves(() => api.post<{ created: boolean; changeCount: number }>(`/versions/${versionId}/checkpoints`, { title: title.trim() || undefined }));
          if (result.created) message.success(`已记录本轮 ${result.changeCount} 处修改`);
          else message.info('草稿已保存；相对上次记录点没有新的修改');
          await compilationQuery.refetch();
        } catch (e) {
          message.error(errorText(e));
          throw e;
        } finally {
          setCheckpointPending(false);
        }
      },
    });
  }, [compilationQuery, drainDraftSaves, message, modal, runAfterSaves, versionId]);

  /** 台账定位:确保组织列在可视范围内后聚焦目标单元格(汇总格无输入框,回退到备注锚点) */
  const locateCell = useCallback((orgId: number, accountId: number) => {
    setOrgColScopeId(null);
    setTimeout(() => {
      const el = document.getElementById(`cell-${orgId}-${accountId}`) ?? document.getElementById(`note-cell-${orgId}-${accountId}`);
      if (el) {
        el.focus();
        el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
      }
    }, 150);
  }, []);

  const finalizeVersion = useCallback(async () => {
    if (draftActionPending) return;
    setDraftActionPending(true);
    try {
      await drainDraftSaves();
      const r = await qualityQuery.refetch();
      if (r.data && !r.data.canFinalize) {
        // 阻断与提醒全部展示,并附处理建议;定位与定稿体检同一套渲染。
        modal.error({
          title: '定稿前检查未通过',
          width: 780,
          content: <QualityReportContent quality={r.data} versionId={versionId} onLocate={locateCell} withAdvice />,
        });
        setDraftActionPending(false);
        return;
      }
      if (!r.data) {
        setDraftActionPending(false);
        return;
      }
      /* 质量通过 → 共享定稿确认框(UX-07);draftActionPending 保持 true 到确认/取消,
         与全程暂停编辑共同守住锁定版本不可变约束 */
      setFinalizeError(null);
      setFinalizeConfirm({ quality: r.data });
    } catch (e) {
      setDraftActionPending(false);
      message.error(errorText(e));
    }
  }, [draftActionPending, message, modal, qualityQuery, drainDraftSaves, locateCell, versionId]);

  const cancelFinalize = useCallback(() => {
    setFinalizeConfirm(null);
    setFinalizeError(null);
    setDraftActionPending(false);
  }, []);

  const confirmFinalize = useCallback(async () => {
    if (!finalizeConfirm || !data) return;
    setFinalizeSubmitting(true);
    try {
      // 确认前再次排空保存队列;expectedRevision 由后端事务内复核(UX-07)
      await drainDraftSaves();
      const expectedRevision = revisionRef.current ?? data.version.revision;
      await api.post(`/versions/${versionId}/lock`, { expectedRevision });
      setFinalizeConfirm(null);
      setFinalizeError(null);
      message.success('版本已定稿');
      const kind = data.version.kind;
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['budget-matrix', versionId] }),
        qc.invalidateQueries({ queryKey: ['versions'] }),
        qc.invalidateQueries({ queryKey: ['budget-checkpoints', versionId] }),
        invalidateAnalysisQueries(qc),
      ]);
      /* 定稿不自动采用:明示下一步。查看这一版 = 留在本页(已刷新为只读定稿)。 */
      modal.confirm({
        title: '定稿完成，接下来？',
        content: '定稿只冻结内容，不会改变当前采用版本。可以留在本页查看这一版（只读），或把它设为当前采用版本。',
        okText: `设为当前${kindLabel(kind)}`,
        cancelText: '查看这一版',
        onOk: () => { void openSetCurrentConfirm(); },
      });
    } catch (e) {
      /* 409 等:后端原因内联展示并保留弹窗,同时刷新数据让确认方看到最新修订 */
      setFinalizeError(errorText(e));
      void qc.invalidateQueries({ queryKey: ['budget-matrix', versionId] });
    } finally {
      setFinalizeSubmitting(false);
      setDraftActionPending(false);
    }
  }, [finalizeConfirm, data, drainDraftSaves, message, modal, qc, versionId, openSetCurrentConfirm]);

  /* ---------- 未保存保护:应用内跳转拦截 + 刷新/关闭提醒 ---------- */
  const blocker = useBlocker(({ currentLocation, nextLocation }) => anyDirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state === 'blocked') {
      modal.confirm({
        title: '草稿仍在自动保存',
        content: '当前修改尚未写入数据库。可稍候再离开，或放弃这部分修改。',
        okText: '放弃并离开',
        okButtonProps: { danger: true },
        cancelText: '留在本页',
        onOk: () => blocker.proceed(),
        onCancel: () => blocker.reset(),
      });
    }
  }, [blocker, modal]);
  useEffect(() => {
    if (!anyDirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [anyDirty]);

  /* ---------- 后端权威轻量测算模板：只返回预览，写回仍进入网格撤销栈 ---------- */
  const calculateWithRule = async () => {
    try {
      await drainDraftSaves();
      const rules = await api.get<{ items: { id: number; name: string; sheet_code: string }[] }>('/calculation-rules');
      const rule = rules.items.find((item) => item.sheet_code === sheetKey) ?? rules.items[0];
      if (!rule) { message.info('尚未配置启用的测算模板'); return; }
      const preview = await api.post<{
        items: { orgId: number; outputAccountId: number; displayAmountCents: number; formula: string; note: string }[];
        skipped: { orgId: number; reason: string }[];
      }>(`/versions/${versionId}/calculation-preview`, { ruleId: rule.id });
      if (preview.items.length === 0) { message.warning(`「${rule.name}」没有可计算的组织，请先补齐输入参数`); return; }
      modal.confirm({
        title: `测算预览：${rule.name}`,
        content: `将写入 ${preview.items.length} 个组织，跳过 ${preview.skipped.length} 个输入不完整的组织。写入后可 Ctrl+Z 撤销。`,
        onOk: () => {
          const updates: CellUpdate[] = preview.items.map((item) => ({
            key: `${item.orgId}:${item.outputAccountId}`,
            value: centsToWan(item.displayAmountCents),
            formula: item.formula,
            note: item.note,
            type: rowById.get(item.outputAccountId)?.type,
          }));
          const result = grid.applyCells(updates, `测算模板：${rule.name}`);
          message.success(`已写入 ${result.written} 个单元格`);
        },
      });
    } catch (e) { message.error(errorText(e)); }
  };

  const openQualityReport = async () => {
    try {
      await drainDraftSaves();
      const result = await qualityQuery.refetch();
      const quality = result.data;
      if (!quality) return;
      modal.info({
        title: '定稿体检（服务端权威结果）',
        width: 780,
        content: <QualityReportContent quality={quality} versionId={versionId} onLocate={locateCell} withAdvice />,
      });
    } catch (e) { message.error(errorText(e)); }
  };

  const sheetDataPresence = useMemo(() => {
    const result = new Map<string, boolean>();
    if (!data) return result;
    const nodeByCode = new Map(rowIndex.nodes.map((node) => [node.code, node]));
    const nonEmptyAccountIds = new Set<number>();
    for (const [key, value] of values) {
      if (value.trim() !== '') nonEmptyAccountIds.add(Number(key.split(':')[1]));
    }
    for (const sheetDef of sheetOptions) {
      const accountIds = new Set<number>();
      const visit = (id: number) => {
        if (accountIds.has(id)) return;
        accountIds.add(id);
        (rowIndex.children.get(id) ?? []).forEach(visit);
      };
      /* overview/all 的根来自版本快照本身,不在 SheetDef.roots 上 */
      const rootCodes = sheetDef.key === 'overview' || sheetDef.key === 'all'
        ? rowIndex.nodes.filter((n) => n.parent_id == null).map((n) => n.code)
        : sheetDef.roots;
      for (const code of rootCodes) {
        const node = nodeByCode.get(code);
        if (node) visit(node.id);
      }
      result.set(sheetDef.key, [...accountIds].some((accountId) => nonEmptyAccountIds.has(accountId)));
    }
    return result;
  }, [data, rowIndex, sheetOptions, values]);
  const hasDataInSheet = useCallback((sKey: string) => sheetDataPresence.get(sKey) ?? false, [sheetDataPresence]);

  // 与台账抽屉同口径:仅统计附注或公式非空的单元格(含汇总格备注)
  const totalNotesCount = useMemo(() => {
    let c = 0;
    for (const key of new Set([...notes.keys(), ...formulas.keys()])) {
      const note = notes.get(key)?.trim() ?? '';
      const formula = formulas.get(key)?.trim() ?? '';
      if (note || formula) c++;
    }
    for (const note of summaryNotes.values()) if (note.trim()) c++;
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, formulas, summaryNotes]);

  if (!validVersionId) {
    return <Result status="warning" title="预算版本地址无效" subTitle="版本 ID 必须是正整数。" extra={<Button onClick={() => navigate('/budget')}>返回预算版本</Button>} />;
  }
  if (model.error) {
    return <Result status="error" title="预算矩阵加载失败" subTitle={errorText(model.error)} extra={<><Button onClick={() => navigate('/budget')}>返回预算版本</Button><Button type="primary" onClick={() => void model.refetch()}>重试</Button></>} />;
  }
  /* 矩阵加载用骨架屏而不是转圈:表头 + 数据行轮廓提前描绘即将出现的表格 */
  if (model.isLoading || !data) return <Card><TableSkeleton columns={6} rows={8} /></Card>;

  const v = data.version;
  const autoSaveText = autoSaveState === 'saving' ? '正在保存…'
    : autoSaveState === 'error' ? '保存失败（修改仍在本页）'
      : autoSaveState === 'invalid' ? '有格式错误，暂停保存'
        : lastAutoSavedAt ? `已保存 ${lastAutoSavedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
          : '草稿实时自动保存';
  const autoSaveTone = autoSaveState === 'error' || autoSaveState === 'invalid' ? 'bad' : autoSaveState === 'saving' ? 'warn' : 'good';
  const autoSaveColor = autoSaveTone === 'bad' ? sc.bad : autoSaveTone === 'warn' ? sc.warn : sc.good;
  const activeCell = grid.activeIds ? { orgId: grid.activeIds.colId, rowId: grid.activeIds.rowId } : null;
  /* UX-23-3:活动格单位(数量=科目计量单位,金额=万元),供公式栏与状态栏确认输入对象 */
  const activeRowForUnit = activeCell ? rowById.get(activeCell.rowId) : undefined;
  const activeUnit = activeRowForUnit ? (activeRowForUnit.type === 'quantity' ? (activeRowForUnit.unit ?? '数量') : '万元') : null;
  /* UX-23-1:整表只读原因——只读格悬浮可读到;定稿/归档版本在网格区给「基于此版继续编制」入口 */
  const gridReadonlyReason = editingEnabled
    ? null
    : v.status !== 'draft'
      ? `版本已${v.status === 'locked' ? '定稿' : '归档'}，内容为只读；修订请「基于此版继续编制」复制为新草稿`
      : saveConflict
        ? '检测到并发冲突，编辑已暂停；请先在页面顶部处理冲突提示'
        : '正在执行导入/定稿等操作，编辑已暂时锁定';
  const sheet = findSheet(sheetKey, dbSheets);
  /* UX-06 空态:当前表没有任何可填写的启用末级科目时,给出具体配置入口而不是空白网格 */
  const sheetAccountRows = rows.filter((r): r is Row => r.kind === 'account');
  const noFillableRows = !sheet?.metric
    && (sheetAccountRows.length === 0 || sheetAccountRows.every((r) => !r.isLeaf || r.status === 'inactive'));

  return (
    /* 无壳:外层 .newfc-content 已是唯一的岛。
       标题保留 —— 它带的是版本名与定稿状态,不是页面名的重复。 */
    <Card
      className="newfc-root-card"
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Button size="small" onClick={() => navigate('/budget')} style={{ borderRadius: 6 }}>← 返回</Button>
          <span style={{ fontSize: 16, fontWeight: 650 }}>{v.year} 年 · {v.name}</span>
          <span
            style={{
              padding: '2px 8px',
              borderRadius: 12,
              fontSize: 12,
              fontWeight: 500,
              background: v.status === 'draft' ? softBg(sc.warn) : v.status === 'locked' ? softBg(fc.income) : 'var(--newfc-fill)',
              color: v.status === 'draft' ? sc.warn : v.status === 'locked' ? fc.income : 'var(--newfc-text-tertiary)',
              border: `1px solid ${v.status === 'draft' ? softBg(sc.warn, 30) : v.status === 'locked' ? softBg(fc.income, 30) : 'var(--newfc-border)'}`,
            }}
          >
            {v.status === 'draft' ? '草稿编制中' : v.status === 'locked' ? '🔒 已定稿' : '已归档'}
          </span>
          {editable && (
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 12,
                fontSize: 12,
                fontWeight: 500,
                background: softBg(autoSaveColor),
                color: autoSaveColor,
                border: `1px solid ${softBg(autoSaveColor, 30)}`,
              }}
            >
              ● {autoSaveText}
            </span>
          )}
          {editable && (compilationQuery.data?.unrecordedChangeCount ?? 0) > 0 && (
            <span
              style={{ fontSize: 12, color: fc.expense }}
              title="数据已保存在系统中；这里指这些修改尚未生成可查阅的编制记录，可用右上角「记录本轮修改」生成"
            >
              尚有 {compilationQuery.data?.unrecordedChangeCount} 处修改未生成编制记录
            </span>
          )}
          {v.is_current ? (
            <span
              style={{
                padding: '2px 8px',
                borderRadius: 12,
                fontSize: 12,
                fontWeight: 500,
                background: softBg(sc.good),
                color: sc.good,
                border: `1px solid ${softBg(sc.good, 30)}`,
              }}
            >
              ✓ 当前生效版本
            </span>
          ) : null}
        </div>
      }
      extra={
        <BudgetHeaderActions
          versionId={versionId}
          version={v}
          editable={editable}
          dirty={anyDirty}
          quality={qualityQuery.data}
          totalNotesCount={totalNotesCount}
          autoSavePending={autoSaveState === 'saving'}
          draftActionPending={draftActionPending}
          checkpointPending={checkpointPending}
          checkpointCount={compilationQuery.data?.items.length ?? 0}
          onRecord={recordCompilation}
          onSaveNow={requestSaveNow}
          onOpenCompilation={() => setCompilationDrawerOpen(true)}
          onClear={() => clear.mutate()}
          onFinalize={() => void finalizeVersion()}
          onCalculate={() => void calculateWithRule()}
          onQuality={() => void openQualityReport()}
          onOpenLedger={() => setLedgerDrawerOpen(true)}
          onImport={importBudget}
          onPrepareImport={prepareImport}
          onReleaseImportLock={releaseImportLock}
        />
      }
    >
      {saveConflict && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="已停止自动保存：其他页面已更新该草稿"
          description="本页未保存内容仍保留在网格中。可打开差异清单逐格核对基线、本地与服务器内容，导出本地修改备份，并选择要恢复的修改；也可以明确放弃本地内容并读取服务器最新版本。"
          action={(
            <Space>
              <Button type="primary" onClick={() => setConflictDrawerOpen(true)}>查看差异并恢复</Button>
              <Button danger onClick={() => void reloadAfterConflict()}>放弃本地内容并刷新</Button>
            </Space>
          )}
        />
      )}
      {!saveConflict && saveError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message="保存失败，最新修改仍保留在本页"
          description={`原因：${saveError}。尚未保存的内容仍在网格中，不会丢失；可直接重试，修正或继续编辑后也会再次自动保存。`}
          action={<Button size="small" onClick={requestSaveNow}>立即重试保存</Button>}
        />
      )}
      {!saveConflict && !saveError && autoSaveState === 'invalid' && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="存在格式错误，已暂停保存"
          description="标红的单元格内容不是合法金额或数量；修正后自动恢复保存，已保存的内容不受影响。"
        />
      )}
      {scopeIssues.length > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ marginBottom: 12 }}
          onClose={() => setScopeIssues([])}
          message="链接中的范围参数已忽略"
          description={scopeIssues.map((issue) => issue.detail).join('；')}
        />
      )}
      <SummaryCapsules summary={summary} />

      {/* 全屏时整块工作区(范围条/工具栏/公式栏/查找栏/表格/状态栏)一起进入覆盖层,
          退出全屏按钮与 Esc 始终可用,不会被覆盖层自身遮住 */}
      <div className={fullscreen ? 'newfc-grid-fullscreen' : undefined}>
      {/* UX-04:全屏与大表滚动时仍需确认「正在修改哪一年、哪个组织、哪一版」 */}
      <WorkspaceScopeBar
        year={v.year}
        orgName={effectiveOrgScope != null ? (orgIndex.byId.get(effectiveOrgScope)?.name ?? '全部组织') : '全部组织'}
        versionName={v.name}
        statusLabel={v.status === 'draft' ? '草稿编制中' : v.status === 'locked' ? '已定稿(只读)' : '已归档(只读)'}
        status={v.status === 'draft' ? 'ready' : 'readonly'}
        extra={<span className="newfc-scope-bar-label">科目表 {sheet?.name ?? sheetKey}</span>}
        style={{ marginBottom: 8 }}
      />
      <GridFilterBar
        sheetKey={sheetKey}
        onSheetKeyChange={changeSheet}
        sheetOptions={sheetOptions}
        hasDataInSheet={hasDataInSheet}
        orgTreeData={orgTreeData}
        effectiveOrgScope={effectiveOrgScope}
        onOrgScopeChange={(id) => { setOrgColScopeId(id); setNoteModalOpen(false); setNoteTarget(null); }}
        keyword={keyword}
        onKeywordChange={setKeyword}
        nonZeroOnly={nonZeroOnly}
        onNonZeroOnlyChange={setNonZeroOnly}
        collapseLevel={collapseLevel}
        onCollapseLevelChange={setCollapseLevel}
        editable={editable}
        canUndo={grid.canUndo}
        canRedo={grid.canRedo}
        onUndo={grid.undo}
        onRedo={grid.redo}
        density={density}
        onDensityChange={setDensity}
        fullscreen={fullscreen}
        onFullscreenChange={setFullscreen}
      />

      {editable && !sheet?.metric && grid.activeIds && (
        <GridFormulaBar
          cellLabel={`${grid.activeIds.colLabel} · ${grid.activeIds.rowLabel}`}
          unit={activeUnit}
          value={values.get(`${grid.activeIds.colId}:${grid.activeIds.rowId}`) ?? ''}
          formula={formulas.get(`${grid.activeIds.colId}:${grid.activeIds.rowId}`) ?? ''}
          note={notes.get(`${grid.activeIds.colId}:${grid.activeIds.rowId}`) ?? ''}
          onOpenNote={() => openNoteModal(grid.activeIds!.rowId, grid.activeIds!.colId)}
        />
      )}
      <GridFindReplace
        open={findState.open}
        mode={findState.mode}
        onClose={() => setFindState((s) => ({ ...s, open: false }))}
        hasFormulaNotes
        onSearch={(q, s) => grid.findMatches(q, s)}
        onJump={grid.jumpToMatch}
        onReplaceAll={grid.replaceMatches}
      />

      {noFillableRows && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message={sheetAccountRows.length === 0 ? `「${sheet?.name ?? sheetKey}」没有可展示的科目行` : `「${sheet?.name ?? sheetKey}」没有可填写的末级科目`}
          description="预算在「末级科目 × 末级组织」单元格上填写。请先在科目配置中维护启用状态的科目树（自定义表格需选择存在的根科目），并确认组织配置中存在末级组织；也可以从右上角「导入 Excel」入口直接导入已有表格。"
          action={(
            <Space size={8}>
              <Button size="small" onClick={() => navigate('/account')}>科目与表格配置</Button>
              <Button size="small" onClick={() => navigate('/org')}>组织配置</Button>
            </Space>
          )}
        />
      )}
      <BudgetGridTable
        visibleRows={visibleRows}
        isMetricSheet={Boolean(sheet?.metric)}
        sheetName={sheet?.name}
        orgDisplayCols={orgDisplayCols}
        collapsedOrgCols={collapsedOrgCols}
        onToggleCollapseOrgCol={toggleCollapseOrgCol}
        onVisibleLeafIdsChange={handleVisibleOrgLeafIdsChange}
        values={values}
        formulas={formulas}
        notes={notes}
        summaryNotes={summaryNotes}
        canEditSummary={editingEnabled}
        invalidCells={invalidCells}
        activeCell={activeCell}
        formulaPreview={grid.formulaPreview}
        grid={grid}
        gridRowIdx={gridRowIdx}
        gridColIdx={gridColIdx}
        cellEditable={cellEditable}
        totalCache={totalCache}
        orgAccTotals={orgAccTotals}
        metricValue={metricValue}
        displayTotal={displayTotal}
        density={density}
        onOpenNote={openNoteModal}
        historyCount={(orgId, accountId) => checkpointCellCounts.get(`${orgId}:${accountId}`) ?? 0}
        onOpenCellHistory={(orgId, accountId) => { setCompilationFocusCell({ orgId, accountId }); setCompilationDrawerOpen(true); }}
        onCtxMenu={setCtxMenu}
        fullscreen={fullscreen}
        readonlyReason={gridReadonlyReason}
        continueEntry={!editable ? { label: '基于此版继续编制', onClick: continueFromLocked } : null}
        rowsCollapsedByFilter={collapseLevel != null}
        onShowAllRowLevels={() => setCollapseLevel(null)}
        firstDraftHint={editable && sheetKey === 'all'}
      />

      <GridStatusBar
        dirtyCount={grid.dirtyCount + summaryDirtyCount}
        hiddenDirtyCount={budgetHiddenDirty}
        onShowAllDirty={() => { setKeyword(''); setNonZeroOnly(false); setCollapseLevel(null); message.info('已清除筛选，显示全部科目行；如仍有列被隐藏，请在表格上方「列配置」中恢复'); }}
        canUndo={grid.canUndo}
        undoDepth={grid.undoDepth}
        stats={grid.selectionStats}
        saving={autoSaveState === 'saving'}
        activeCell={grid.activeIds ? { label: `${grid.activeIds.colLabel} · ${grid.activeIds.rowLabel}`, unit: activeUnit } : null}
      />
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
            case 'note': {
              const rowId = grid.activeIds?.rowId; const colId = grid.activeIds?.colId;
              if (rowId != null && colId != null) openNoteModal(rowId, colId);
              break;
            }
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
          { key: 'clear', label: '清空数值(保留附注)(Delete)' },
          { key: 'clearAll', label: '清除全部(含公式与附注)' },
          { type: 'divider' },
          { key: 'note', label: '编辑附注与公式(Shift+F2)' },
        ] satisfies MenuProps['items']}
      />

      {summary && summary.metrics.length > 0 && (
        <Card size="small" title="指标汇总(只读,按版本绑定树快照计算)" style={{ marginTop: 16 }}>
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={summary.metrics.map((m) => ({ ...m, value: summary.metricValues[String(m.id)] ?? 0 }))}
            columns={[
              { title: '指标编码', dataIndex: 'code', width: 120, ellipsis: { showTitle: true } },
              { title: '指标名称', dataIndex: 'name', width: 160 },
              { title: '金额(万元,利润方向)', dataIndex: 'value', align: 'right' as const, render: (val: number) => <MoneyText cents={val} hideUnit /> },
            ]}
          />
        </Card>
      )}

      {summary && (summary.ratioMetrics?.length ?? 0) > 0 && (
        <Card
          size="small"
          title="比率指标(只读,按本版本全部预算数先汇总分子分母再相除)"
          style={{ marginTop: 16 }}
        >
          <Table
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={summary.ratioMetrics}
            columns={[
              { title: '指标编码', dataIndex: 'code', width: 120, ellipsis: { showTitle: true } },
              { title: '指标名称', dataIndex: 'name', width: 160 },
              {
                title: '口径', width: 150,
                render: (_val: unknown, row: SummaryRatioMetric) => (row.displayFormat === 'percent' ? '百分比' : row.unit || '自然单位')
                  + (row.direction === 'lower_better' ? ' · 越低越好' : ' · 越高越好'),
              },
              {
                title: '预算比率', align: 'right' as const, width: 140,
                render: (_val: unknown, row: SummaryRatioMetric) => formatRatio(row.scaled, row.displayFormat, row.unit),
              },
              {
                title: '分子 / 分母', render: (_val: unknown, row: SummaryRatioMetric) => (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {row.numeratorBasis === 'quantity' ? formatQuantity(row.numeratorRaw) : <MoneyText cents={row.numeratorRaw} size="sm" />}
                    {' ÷ '}
                    {row.denominatorBasis === 'quantity' ? formatQuantity(row.denominatorRaw) : <MoneyText cents={row.denominatorRaw} size="sm" />}
                  </Typography.Text>
                ),
              },
            ]}
          />
        </Card>
      )}

      <NoteEditModal
        open={noteModalOpen}
        target={noteTarget}
        summary={noteTarget?.summary}
        orgName={noteTarget ? orgIndex.byId.get(noteTarget.orgId)?.name : undefined}
        currentValue={noteTarget
          ? noteTarget.summary
            ? displayTotal(noteTarget.row, orgIndex.leavesUnder(noteTarget.orgId).reduce((s, lid) => s + totalCache(noteTarget.row.id, lid), 0))
            : (values.get(`${noteTarget.orgId}:${noteTarget.row.id}`) ?? '')
          : ''}
        formText={noteFormText}
        formFormula={noteFormFormula}
        onFormTextChange={setNoteFormText}
        onFormFormulaChange={setNoteFormFormula}
        onSave={handleSaveNoteModal}
        onCancel={() => setNoteModalOpen(false)}
      />

      <LedgerDrawer
        open={ledgerDrawerOpen}
        onClose={() => setLedgerDrawerOpen(false)}
        data={data}
        values={values}
        notes={notes}
        formulas={formulas}
        summaryNotes={summaryNotes}
        rowById={rowById}
        onLocate={locateCell}
        versionId={versionId}
      />

      <CompilationDrawer
        open={compilationDrawerOpen}
        onClose={() => setCompilationDrawerOpen(false)}
        data={data}
        compilation={compilationQuery.data}
        loading={compilationQuery.isLoading}
        focusCell={compilationFocusCell}
      />

      {/* UX-20/UX-21 冲突恢复抽屉:三方差异 + 导出/导入本地修改 + 选定恢复 */}
      <ConflictRecoveryDrawer
        open={conflictDrawerOpen && saveConflict}
        onClose={() => setConflictDrawerOpen(false)}
        loading={conflictLoading}
        error={conflictFetchError}
        onRetry={() => {
          setConflictFetchError(null);
          setConflictLoading(true);
          api.get<MatrixResponse>(`/versions/${versionId}/matrix`)
            .then((m) => { setConflictServer(m); setConflictSelected(new Set()); })
            .catch((e) => setConflictFetchError(errorText(e)))
            .finally(() => setConflictLoading(false));
        }}
        diffs={conflictDiff?.diffs ?? []}
        convergedCount={conflictDiff?.convergedCount ?? 0}
        baselineRevision={conflictBaseline?.revision ?? null}
        serverRevision={conflictServer?.version.revision ?? null}
        server={conflictServer}
        selectedKeys={conflictSelected}
        onSelectedKeysChange={setConflictSelected}
        onExportLocal={exportLocalRecovery}
        onImportFile={importRecoveryFile}
        importError={importError}
        applying={resolving}
        onApply={applyConflictResolution}
        onDiscard={() => { setConflictDrawerOpen(false); void reloadAfterConflict(); }}
      />

      {/* UX-07 定稿/采用确认:与版本列表共用同一组件;定位为网格定位后关闭弹窗 */}
      {finalizeConfirm && (
        <FinalizeConfirmModal
          open
          version={{ id: versionId, year: data.version.year, name: data.version.name, kind: data.version.kind }}
          quality={finalizeConfirm.quality}
          confirmPending={finalizeSubmitting}
          error={finalizeError}
          onLocate={(orgId, accountId) => { cancelFinalize(); locateCell(orgId, accountId); }}
          onConfirm={() => void confirmFinalize()}
          onCancel={cancelFinalize}
        />
      )}
      {setCurrentConfirm && (
        <SetCurrentConfirmModal
          open
          version={{ id: versionId, year: data.version.year, name: data.version.name, kind: data.version.kind }}
          previousCurrent={setCurrentConfirm.previousCurrent}
          confirmPending={setCurrentSubmitting}
          error={setCurrentError}
          onConfirm={() => void confirmSetCurrent()}
          onCancel={() => { setSetCurrentConfirm(null); setSetCurrentError(null); }}
        />
      )}
    </Card>
  );
}
