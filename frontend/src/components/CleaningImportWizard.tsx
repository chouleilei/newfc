import { ConfigFormAssistant, changedFields } from './assistant/ConfigFormAssistant';
import { useAssistantDraft } from '../assistant/contextHooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import dayjs from 'dayjs';
import {
  Alert, App, Button, Card, Checkbox, DatePicker, Descriptions, Divider, Empty, Input, InputNumber,
  Modal, Radio, Select, Space, Spin, Statistic, Steps, Table, Tag, Tooltip, Typography, Upload,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiError, api, errorText as sharedErrorText } from '../api/client';
import { confirmImportBatchWithRecovery } from '../api/importBatch';
import {
  cleaningApi, reopenExpiredDetails, uploadCleaningWorkbook,
  type CleaningAlias, type CleaningAnalysis, type CleaningColumnField, type CleaningIssue, type CleaningPlan,
  type CleaningPreview, type CleaningPreviewRow, type CleaningRowHintKind, type CleaningTarget, type CleaningTargetKind,
  type CleaningTemplate, type CleaningTemplateConfig, type CleaningWorkbookUpload, type WorkbookRowPreview,
} from '../api/cleaning';
import { centsToWan, centsToYuan, formatQuantity } from '../utils/money';
import { CLEANING_FIELD_LABELS, checkReupload, excelColumnLetter, mappingStorageKey, planToWizardState, rowCoordinateKey, templateConfigFromPlan, templateInitialState } from '../utils/cleaning';

const { Dragger } = Upload;
const FIELD_OPTIONS = Object.entries(CLEANING_FIELD_LABELS).map(([value, label]) => ({ value: value as CleaningColumnField, label }));
const ACTION_LABEL: Record<string, string> = { insert: '新增', overwrite: '覆盖', unchanged: '不变', clear: '清零', excluded: '排除' };
const ACTION_COLOR: Record<string, string> = { insert: 'green', overwrite: 'orange', unchanged: 'default', clear: 'red', excluded: 'blue' };
const ROW_HINT_LABEL: Record<CleaningRowHintKind, string> = { subtotal: '疑似合计/小计行', header: '疑似表头合并行', trailer: '疑似跨页表尾', note: '疑似备注行', blank: '疑似空段行' };

export interface CleaningImportWizardProps {
  open: boolean;
  targetKind: CleaningTargetKind;
  versionId?: number;
  year: number;
  targetLabel: string;
  onClose: () => void;
  /**
   * UX-15:批次确认(只发批次 ID,含结果未知恢复)由向导内部完成;
   * 本回调在服务端已确认提交后调用,只负责刷新页面数据与解锁,不再发起 confirm。
   */
  onConfirmBatch: (batchId: number) => Promise<void>;
  /** UX-15:确认前动态门禁(如实际页上传后又出现未保存输入),返回原因则阻止确认 */
  confirmGuard?: () => string | null;
}

function defaultSnapshotDate(year: number): string {
  const today = dayjs();
  return today.year() === year ? today.format('YYYY-MM-DD') : `${year}-12-31`;
}

// 行坐标键与人工映射存储键与 utils/cleaning 的纯函数共用,保证 plan 恢复态与向导运行态一致
const coordinateKey = rowCoordinateKey;
const mappingKey = mappingStorageKey;

// 清洗向导只显示主错误信息:逐行错误已在预览表格中呈现,toast 不重复展开
function errorText(error: unknown): string {
  return sharedErrorText(error, { includeFieldErrors: false, fallback: '操作失败' });
}

function headerText(workbook: CleaningWorkbookUpload, sheetName: string, headerRow: number, column: number): string {
  return workbook.sheets.find((sheet) => sheet.name === sheetName)?.sampleRows
    .find((row) => row.row === headerRow)?.cells.find((cell) => cell.column === column)?.text ?? '';
}

function samples(workbook: CleaningWorkbookUpload, sheetName: string, startRow: number, column: number): string[] {
  return (workbook.sheets.find((sheet) => sheet.name === sheetName)?.sampleRows ?? [])
    .filter((row) => row.row >= startRow)
    .map((row) => row.cells.find((cell) => cell.column === column)?.text ?? '')
    .filter(Boolean).slice(0, 3);
}

export default function CleaningImportWizard(props: CleaningImportWizardProps) {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const clearActionLabel = props.targetKind === 'actual-current' ? '删除' : '清零/删除';
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [workbook, setWorkbook] = useState<CleaningWorkbookUpload | null>(null);
  const [templates, setTemplates] = useState<CleaningTemplate[]>([]);
  const [aliases, setAliases] = useState<CleaningAlias[]>([]);
  const [activeAlias, setActiveAlias] = useState<{ id?: number; mappingKind: 'org' | 'account'; sourceText: string } | null>(null);
  const [aliasDrafts, setAliasDrafts] = useState<Record<number, { sourceText: string; targetCode: string }>>({});
  const [templateId, setTemplateId] = useState<number | undefined>();
  const [selectedSheets, setSelectedSheets] = useState<string[]>([]);
  const [ranges, setRanges] = useState<Record<string, { headerRow: number; dataStartRow: number; dataEndRow: number }>>({});
  const [activeSheet, setActiveSheet] = useState('');
  const [regionRows, setRegionRows] = useState<WorkbookRowPreview[]>([]);
  const [regionCache, setRegionCache] = useState<Record<string, WorkbookRowPreview>>({});
  const [regionPage, setRegionPage] = useState(1);
  const [regionTotal, setRegionTotal] = useState(0);
  const [rowPickMode, setRowPickMode] = useState<'header' | 'start' | 'end'>('header');
  const [mappings, setMappings] = useState<Record<number, CleaningColumnField>>({});
  const [valueKind, setValueKind] = useState<'amount' | 'quantity'>('amount');
  const [amountUnit, setAmountUnit] = useState<'yuan' | 'wan'>('yuan');
  const [signConvention, setSignConvention] = useState<'display_positive' | 'profit_signed'>('display_positive');
  const [clearBlankNotes, setClearBlankNotes] = useState(false);
  const [aiApplied, setAiApplied] = useState(false);
  const [snapshotDate, setSnapshotDate] = useState(defaultSnapshotDate(props.year));
  const [manualMappings, setManualMappings] = useState<Record<string, string>>({});
  const [excludedRows, setExcludedRows] = useState<Set<string>>(new Set());
  /** 行级建议逐条处置(阶段四):key 为行坐标,采纳=写回 plan.excludedRows,拒绝=仅记录不再提示 */
  const [rowHintDecisions, setRowHintDecisions] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const [analysis, setAnalysis] = useState<CleaningAnalysis | null>(null);
  const [analysisDirty, setAnalysisDirty] = useState(false);
  const [issueField, setIssueField] = useState<string>();
  const [preview, setPreview] = useState<CleaningPreview | null>(null);
  const [previewRows, setPreviewRows] = useState<CleaningPreviewRow[]>([]);
  const [previewPage, setPreviewPage] = useState(1);
  const [previewTotal, setPreviewTotal] = useState(0);
  const [actionFilter, setActionFilter] = useState<string>();
  const [warningOnly, setWarningOnly] = useState(false);
  const [overwriteAccepted, setOverwriteAccepted] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  /** UX-15:确认结果未知/失败的持续状态;failed=服务端已拒绝并自动取消该预览(不可重试,需重新检查) */
  const [confirmIssue, setConfirmIssue] = useState<{ kind: 'failed' | 'retry'; message: string } | null>(null);
  const [templateDraftMode, setTemplateDraftMode] = useState<'create' | 'update'>('create');
  const [templateName, setTemplateName] = useState('');
  /** UX-17:reopen 单在途守卫——重复点击/响应丢失重试不并行发起,后端同批次幂等返回同一恢复会话 */
  const [reopening, setReopening] = useState(false);
  const reopeningRef = useRef(false);
  /** UX-17:源文件失效(410)后等待重传的核对期望(指纹+文件名) */
  const [reuploadExpectation, setReuploadExpectation] = useState<{ sha256: string; originalName: string } | null>(null);
  /** UX-17:重传文件与失效原件指纹不同的持续提示,重新分析成功后清除 */
  const [reuploadChanged, setReuploadChanged] = useState(false);

  const reset = () => {
    setActiveAlias(null); setStep(0); setBusy(false); setWorkbook(null); setTemplateId(undefined); setSelectedSheets([]); setRanges({}); setAliases([]); setAliasDrafts({});
    setActiveSheet(''); setRegionRows([]); setRegionCache({}); setRegionPage(1); setMappings({}); setValueKind('amount'); setAmountUnit('yuan');
    setSignConvention('display_positive'); setClearBlankNotes(false); setAiApplied(false); setSnapshotDate(defaultSnapshotDate(props.year));
    setManualMappings({}); setExcludedRows(new Set()); setAnalysis(null); setAnalysisDirty(false); setPreview(null); setPreviewRows([]);
    setPreviewPage(1); setActionFilter(undefined); setWarningOnly(false); setOverwriteAccepted(false); setConfirmed(false); setTemplateName(''); setTemplateDraftMode('create');
    setConfirmIssue(null); setRowHintDecisions({});
    reopeningRef.current = false; setReopening(false); setReuploadExpectation(null); setReuploadChanged(false);
  };

  useEffect(() => {
    if (!props.open) return;
    reset();
    cleaningApi.templates(props.targetKind).then((result) => setTemplates(result.items)).catch(() => setTemplates([]));
    cleaningApi.aliases(props.targetKind).then((result) => {
      setAliases(result.items);
      setAliasDrafts(Object.fromEntries(result.items.map((item) => [item.id, { sourceText: item.sourceText, targetCode: item.targetCode }])));
    }).catch(() => setAliases([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.targetKind, props.year, props.versionId]);

  const target = useMemo<CleaningTarget>(() => props.targetKind === 'budget'
    ? { targetKind: 'budget', versionId: props.versionId }
    : { targetKind: 'actual-current', year: props.year, snapshotDate }, [props.targetKind, props.versionId, props.year, snapshotDate]);

  const selectedTemplate = templates.find((item) => item.id === templateId);
  const aiDiffers = Boolean(workbook?.aiSuggestion && (
    !selectedSheets.includes(workbook.aiSuggestion.sheet)
    || ranges[workbook.aiSuggestion.sheet]?.headerRow !== workbook.aiSuggestion.headerRow
    || ranges[workbook.aiSuggestion.sheet]?.dataStartRow !== workbook.aiSuggestion.dataStartRow
    || workbook.aiSuggestion.columns.some((column) => mappings[column.col] !== column.field)
  ));

  const applyTemplate = (source: CleaningWorkbookUpload, config: CleaningTemplateConfig, id?: number) => {
    const state = templateInitialState(config, source);
    setSelectedSheets(state.selectedSheets); setRanges(state.ranges); setActiveSheet(state.selectedSheets[0] ?? '');
    setMappings(state.mappings); setValueKind(config.valueKind); setAmountUnit(config.amountUnit ?? 'yuan');
    setSignConvention(config.signConvention ?? 'display_positive'); setClearBlankNotes(Boolean(config.clearBlankNotes));
    setTemplateId(id); setAiApplied(false);
  };

  const initializeWorkbook = (source: CleaningWorkbookUpload, preserveConfiguration: boolean) => {
    if (preserveConfiguration && Object.keys(mappings).length > 0) {
      const existing = selectedSheets.filter((name) => source.sheets.some((sheet) => sheet.name === name));
      const names = existing.length ? existing : source.sheets.filter((sheet) => sheet.state === 'visible').slice(0, 1).map((sheet) => sheet.name);
      setSelectedSheets(names);
      setRanges(Object.fromEntries(names.map((name) => {
        const sheet = source.sheets.find((item) => item.name === name)!;
        const previous = ranges[name];
        const headerRow = Math.min(sheet.rowCount, previous?.headerRow ?? 1);
        const dataStartRow = Math.min(sheet.rowCount, Math.max(headerRow + 1, previous?.dataStartRow ?? headerRow + 1));
        return [name, { headerRow, dataStartRow, dataEndRow: sheet.rowCount }];
      })));
      setActiveSheet(names[0] ?? '');
      return;
    }
    if (selectedTemplate) { applyTemplate(source, selectedTemplate.config, selectedTemplate.id); return; }
    const ai = source.aiSuggestion;
    const suggestedSheet = ai && source.sheets.some((sheet) => sheet.name === ai.sheet) ? ai.sheet : undefined;
    const first = suggestedSheet ?? source.sheets.find((sheet) => sheet.state === 'visible')?.name ?? source.sheets[0]?.name;
    if (!first) return;
    const sheet = source.sheets.find((item) => item.name === first)!;
    const headerRow = ai?.headerRow ?? 1;
    const dataStartRow = ai?.dataStartRow ?? Math.min(sheet.rowCount, headerRow + 1);
    setSelectedSheets([first]); setActiveSheet(first);
    setRanges({ [first]: { headerRow, dataStartRow, dataEndRow: ai?.dataEndRow ?? sheet.rowCount } });
    if (ai?.columns.length) {
      setMappings(Object.fromEntries(ai.columns.map((column) => [column.col, column.field])));
      if (ai.columns.some((column) => column.field === 'quantity')) setValueKind('quantity');
      else if (ai.columns.some((column) => column.field === 'amount')) setValueKind('amount');
      setAiApplied(true);
    }
  };

  const handleFile = async (file: File) => {
    setBusy(true);
    try {
      let source = await uploadCleaningWorkbook(file, props.targetKind);
      // 上传接口只负责快速落盘；AI 推荐通过独立请求获取，避免模型延迟阻塞上传关键路径。
      if (source.aiAvailable) {
        try {
          const ai = await cleaningApi.suggest(source.token, props.targetKind);
          source = { ...source, aiAvailable: ai.available, aiSuggestion: ai.suggestion };
        } catch { /* AI 推荐失败不影响手工清洗 */ }
      }
      const preserve = Boolean(workbook || Object.keys(mappings).length);
      // UX-17:410 恢复后的重传必须核验指纹——与失效原件一致才沿用行级排除与按源文本的映射;
      // 文件不同则清空这两类与旧文件坐标/文本绑定的配置,并持续提示重新核对(分析成功后解除)。
      const expectation = reuploadExpectation;
      const keepRecoveredRows = Boolean(expectation && checkReupload(expectation.sha256, source.sha256).kind === 'same');
      // 列映射、单位等结构配置可以复用；排除坐标、源文本人工映射和分页缓存都只属于
      // 旧工作簿。重新上传后必须清空，避免同名 sheet 的普通数据行被旧坐标静默排除。
      setWorkbook(source); setAnalysis(null); setAnalysisDirty(false); setIssueField(undefined); setPreview(null); setConfirmed(false);
      if (!keepRecoveredRows) { setExcludedRows(new Set()); setManualMappings({}); }
      setAiApplied(false); setRowHintDecisions({});
      setRegionRows([]); setRegionCache({}); setRegionPage(1); setRegionTotal(0);
      setPreviewRows([]); setPreviewPage(1); setPreviewTotal(0); setActionFilter(undefined); setWarningOnly(false); setOverwriteAccepted(false);
      initializeWorkbook(source, preserve);
      if (expectation) {
        setReuploadExpectation(null);
        if (keepRecoveredRows) {
          setReuploadChanged(false);
          message.success('重新上传的文件与失效原件一致，名称映射、排除行与单位配置已全部保留');
        } else {
          setReuploadChanged(true);
          message.warning('文件与上次不同，请重新核对映射、单位与排除行；行级排除和按源文本的映射已清空');
        }
      } else {
        message.success('工作簿已安全读取');
      }
    } catch (error) { modal.error({ title: '文件读取失败', content: errorText(error) }); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    if (!props.open || step !== 1 || !workbook || !activeSheet) {
      setBusy(false);
      return;
    }
    const sheet = workbook.sheets.find((item) => item.name === activeSheet);
    if (!sheet) { setBusy(false); return; }
    let cancelled = false;
    setBusy(true);
    cleaningApi.region(workbook.token, {
      sheet: activeSheet, startRow: 1, endRow: sheet.rowCount, startCol: 1, endCol: Math.max(1, sheet.columnCount), page: regionPage, pageSize: 50,
    }).then((result) => { if (!cancelled) {
      setRegionRows(result.rows); setRegionTotal(result.total);
      setRegionCache((current) => ({ ...current, ...Object.fromEntries(result.rows.map((row) => [coordinateKey(activeSheet, row.row), row])) }));
    } })
      .catch((error) => { if (!cancelled) handleTokenError(error); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, step, workbook?.token, activeSheet, regionPage]);

  const handleTokenError = (error: unknown) => {
    if (error instanceof ApiError && error.status === 404) {
      setWorkbook(null);
      message.warning('临时文件已失效，请重新上传；已填写的映射配置会保留');
    } else message.error(errorText(error));
  };

  const setRangeRow = (sheetName: string, kind: 'header' | 'start' | 'end', row: number) => {
    setRanges((current) => {
      const old = current[sheetName];
      if (!old) return current;
      if (kind === 'header') return { ...current, [sheetName]: { headerRow: row, dataStartRow: Math.max(row + 1, old.dataStartRow), dataEndRow: Math.max(row + 1, old.dataEndRow) } };
      if (kind === 'start') return { ...current, [sheetName]: { ...old, dataStartRow: Math.max(old.headerRow + 1, row), dataEndRow: Math.max(row, old.dataEndRow) } };
      return { ...current, [sheetName]: { ...old, dataEndRow: Math.max(old.dataStartRow, row) } };
    });
  };

  const selectSheets = (names: string[]) => {
    if (!workbook) return;
    setSelectedSheets(names);
    setRanges((current) => Object.fromEntries(names.map((name) => {
      const sheet = workbook.sheets.find((item) => item.name === name)!;
      return [name, current[name] ?? { headerRow: 1, dataStartRow: Math.min(2, sheet.rowCount), dataEndRow: sheet.rowCount }];
    })));
    if (!names.includes(activeSheet)) { setActiveSheet(names[0] ?? ''); setRegionPage(1); }
  };

  const buildPlan = (): CleaningPlan => ({
    version: 1,
    targetKind: props.targetKind,
    sheets: selectedSheets.map((sheetName) => ({ sheetName, ...ranges[sheetName] })),
    columns: Object.entries(mappings).map(([sourceColumn, field]) => ({ sourceColumn: Number(sourceColumn), field })).sort((a, b) => a.sourceColumn - b.sourceColumn),
    valueKind,
    ...(valueKind === 'amount' ? { amountUnit, signConvention } : {}),
    excludedRows: [...excludedRows].map((key) => {
      const [sheetName, row] = JSON.parse(key) as [string, number];
      return { sheetName, row, reason: analysis?.rows.find((item) => item.sheetName === sheetName && item.rowNumber === row)?.suspectedReason ?? '用户排除' };
    }),
    mappings: Object.entries(manualMappings).map(([key, targetCode]) => {
      const [kind, sourceText] = key.split('\u0000') as ['org' | 'account', string];
      return { kind, sourceText, targetCode };
    }),
    clearBlankNotes,
    templateId,
    aiSuggested: aiApplied,
  });

  useAssistantDraft(props.open && workbook != null, `cleaning:${workbook?.sha256}:${props.targetKind}:${props.versionId ?? props.year}:${confirmed}:${templateDraftMode}`, () => {
    if (!workbook) return null;
    if (confirmed) {
      const old = templateDraftMode === 'update' ? selectedTemplate : null;
      return { kind: 'cleaning_template', base: old ? { id: old.id, updatedAt: old.updatedAt, operation: 'update' } : { clientKey: 'new-template', operation: 'create' }, changes: old ? { config: templateConfigFromPlan(buildPlan()) } : { name: templateName, targetKind: props.targetKind, config: templateConfigFromPlan(buildPlan()) } };
    }
    return { kind: 'cleaning_template', base: { clientKey: 'current-cleaning-plan', operation: 'analyze', source: preview ? { batchId: preview.importBatchId, sha256: preview.sha256 } : { token: workbook.token, sha256: workbook.sha256 } }, changes: { plan: buildPlan(), target, name: templateName } };
  });
  useAssistantDraft(props.open && activeAlias != null && step === 3, `cleaning-alias:${activeAlias?.id ?? activeAlias?.sourceText}`, () => {
    if (!activeAlias) return null;
    const old = activeAlias.id == null ? null : aliases.find((item) => item.id === activeAlias.id);
    const current = old ? aliasDrafts[old.id] : { sourceText: activeAlias.sourceText, targetCode: manualMappings[mappingKey(activeAlias.mappingKind, activeAlias.sourceText)] };
    return { kind: 'alias_rule', base: old ? { id: old.id, updatedAt: old.updatedAt, operation: 'update' } : { clientKey: 'new-cleaning-alias', operation: 'create' }, changes: old ? changedFields(current ?? {}, { sourceText: old.sourceText, targetCode: old.targetCode }) : { targetKind: props.targetKind, mappingKind: activeAlias.mappingKind, ...current } };
  });

  /** 行级建议处置(阶段四):采纳写回 plan.excludedRows;拒绝仅记录,不进入 plan。 */
  const decideRowHint = (sheetName: string, row: number, decision: 'accepted' | 'rejected') => {
    setRowHintDecisions((current) => ({ ...current, [coordinateKey(sheetName, row)]: decision }));
    if (decision === 'accepted') {
      setExcludedRows((current) => new Set([...current, coordinateKey(sheetName, row)]));
    } else {
      setExcludedRows((current) => {
        const next = new Set(current);
        next.delete(coordinateKey(sheetName, row));
        return next;
      });
    }
    setAnalysis(null);
    setAnalysisDirty(true);
  };

  const validateRegion = (): string | null => {
    if (!workbook || selectedSheets.length < 1) return '请至少选择一个工作表';
    for (const name of selectedSheets) {
      const range = ranges[name];
      if (!range || range.headerRow < 1 || range.dataStartRow <= range.headerRow || range.dataEndRow < range.dataStartRow) return `${name} 的表头或数据范围不合法`;
    }
    return null;
  };

  const validateColumns = (): string | null => {
    const fields = Object.values(mappings);
    if (!fields.includes('orgCode') && !fields.includes('orgName')) return '请映射组织编码或组织名称';
    if (!fields.includes('accountCode') && !fields.includes('accountName')) return '请映射科目编码或科目名称';
    if (valueKind === 'amount' && !fields.includes('amount')) return '金额导入必须映射金额列';
    if (valueKind === 'quantity' && !fields.includes('quantity')) return '数量导入必须映射数量列';
    if (fields.includes('amount') && fields.includes('quantity')) return '一次导入不能混合金额和数量';
    return null;
  };

  const analyze = async (): Promise<CleaningAnalysis | null> => {
    if (!workbook) return null;
    setBusy(true);
    try {
      const result = await cleaningApi.analyze(workbook.token, target, buildPlan());
      setAnalysis(result); setAnalysisDirty(false); setReuploadChanged(false); return result;
    } catch (error) { handleTokenError(error); return null; }
    finally { setBusy(false); }
  };

  const createPreview = async () => {
    if (!workbook) return;
    setBusy(true);
    try {
      const current = analysisDirty || !analysis ? await cleaningApi.analyze(workbook.token, target, buildPlan()) : analysis;
      setAnalysis(current); setAnalysisDirty(false);
      if (current.counts.errors || current.counts.unresolved) {
        message.warning('请先处理全部错误和未决名称映射'); return;
      }
      const pending = await cleaningApi.preview(workbook.token, target, buildPlan());
      setPreview(pending); setPreviewPage(1); setStep(4);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) handleTokenError(error);
      else modal.error({ title: '无法生成导入检查', content: errorText(error) });
    } finally { setBusy(false); }
  };

  useEffect(() => {
    if (!preview || (step !== 4 && step !== 5)) return;
    let cancelled = false;
    cleaningApi.previewRows(preview.importBatchId, { page: previewPage, pageSize: 100, action: actionFilter, warningOnly })
      .then((result) => { if (!cancelled) { setPreviewRows(result.items); setPreviewTotal(result.total); } })
      .catch((error) => { if (!cancelled) message.error(errorText(error)); });
    return () => { cancelled = true; };
  }, [preview, previewPage, actionFilter, warningOnly, step, message]);

  /**
   * UX-17:把批次中冻结的计划/目标恢复为向导配置状态。
   * 旧分析与旧预览一律作废(需重新 analyze 生成全新预览);覆盖确认勾选不沿用到新差异。
   * wb 为 null 时(源文件失效待重传)仍按计划恢复配置到允许范围,重传时按新文件收敛。
   */
  const applyPlanState = (plan: CleaningPlan | null, recoveredTarget: CleaningTarget | null, wb: CleaningWorkbookUpload | null) => {
    if (plan) {
      const restored = planToWizardState(plan, wb);
      setSelectedSheets(restored.selectedSheets);
      setRanges(restored.ranges);
      setActiveSheet(restored.selectedSheets[0] ?? '');
      setMappings(restored.mappings);
      setValueKind(restored.valueKind);
      setAmountUnit(restored.amountUnit);
      setSignConvention(restored.signConvention);
      setClearBlankNotes(restored.clearBlankNotes);
      // 模板可能已被删除:仅在当前模板列表中存在时保留关联
      setTemplateId(restored.templateId !== undefined && templates.some((item) => item.id === restored.templateId) ? restored.templateId : undefined);
      setManualMappings(restored.manualMappings);
      setExcludedRows(new Set(restored.excludedRowKeys));
    }
    if (recoveredTarget?.snapshotDate) setSnapshotDate(recoveredTarget.snapshotDate);
    setAiApplied(false); setRowHintDecisions({});
    setAnalysis(null); setAnalysisDirty(true); setIssueField(undefined);
    setPreview(null); setPreviewRows([]); setPreviewPage(1); setPreviewTotal(0); setActionFilter(undefined); setWarningOnly(false);
    setOverwriteAccepted(false); setConfirmIssue(null); setConfirmed(false);
    setRegionRows([]); setRegionCache({}); setRegionPage(1); setRegionTotal(0);
  };

  /**
   * UX-17:修改导入配置——服务端从原待确认批次恢复原文件/计划/目标并取消旧批次,
   * 返回新上传凭证(重复请求幂等返回同一会话);前端单在途,不并行发起。
   * 410(源文件已失效):计划与目标仍随 details 恢复,明确要求重新上传并核验指纹。
   */
  const doReopen = async (batchId: number) => {
    if (reopeningRef.current) return;
    reopeningRef.current = true;
    setReopening(true);
    try {
      const result = await cleaningApi.reopen(batchId);
      // 恢复的是同一原件:沿用已读取的工作簿结构,仅换新临时凭证;
      // 工作簿已不在本地(如临时凭证曾过期)则退化为重传路径。
      const restoredWorkbook: CleaningWorkbookUpload | null = workbook && workbook.sha256 === result.sha256
        ? { ...workbook, token: result.token }
        : null;
      applyPlanState(result.plan, result.target, restoredWorkbook);
      setWorkbook(restoredWorkbook);
      setReuploadExpectation(restoredWorkbook ? null : { sha256: result.sha256, originalName: result.originalName });
      setReuploadChanged(false);
      setStep(restoredWorkbook ? 1 : 0);
      message.success(restoredWorkbook
        ? `已恢复原文件与导入配置，旧批次 #${result.sourceBatchId} 已取消；请核对后重新检查导入结果`
        : '原计划与目标已恢复；原文件无法直接复用，请重新上传同一文件');
    } catch (error) {
      const expired = reopenExpiredDetails(error);
      if (expired) {
        applyPlanState(expired.plan, expired.target, null);
        setWorkbook(null);
        setReuploadExpectation({ sha256: expired.sha256, originalName: expired.originalName });
        setReuploadChanged(false);
        setStep(0);
        modal.warning({
          title: '原文件已失效，需要重新上传',
          content: `${errorText(error)}。名称映射、排除行、单位等配置已恢复到允许范围；重新上传时会核验文件指纹，文件有变化需重新核对。`,
        });
      } else {
        modal.error({
          title: '无法恢复导入配置',
          content: `${errorText(error)}。如刚才已发起过恢复，可安全重试——服务端对同一批次幂等返回同一恢复会话，不会重复取消或重复占用临时文件。`,
        });
      }
    } finally {
      reopeningRef.current = false;
      setReopening(false);
    }
  };

  const requestReopen = () => {
    if (!preview || reopeningRef.current) return;
    const batchId = preview.importBatchId;
    modal.confirm({
      title: '修改导入配置？',
      content: `将取消待确认批次 #${batchId}，恢复原上传文件与全部配置（名称映射、排除行、单位、模板），无需重复上传有效原件；重新分析后生成全新预览，本次已勾选的覆盖确认不会沿用到新差异。`,
      okText: '恢复并修改配置',
      cancelText: '暂不修改',
      onOk: () => doReopen(batchId),
    });
  };

  const saveAlias = async (kind: 'org' | 'account', sourceText: string) => {
    const targetCode = manualMappings[mappingKey(kind, sourceText)];
    if (!targetCode) return;
    try {
      const saved = await cleaningApi.saveAlias({ targetKind: props.targetKind, mappingKind: kind, sourceText, targetCode });
      setAliases((items) => [saved, ...items]);
      setAliasDrafts((items) => ({ ...items, [saved.id]: { sourceText: saved.sourceText, targetCode: saved.targetCode } }));
      message.success(`已保存别名：${sourceText} → ${targetCode}`);
    } catch (error) { message.warning(errorText(error)); }
  };

  const updateAlias = async (item: CleaningAlias) => {
    const draft = aliasDrafts[item.id];
    if (!draft?.sourceText.trim() || !draft.targetCode) return;
    try {
      const saved = await cleaningApi.updateAlias(item.id, draft);
      setAliases((items) => items.map((old) => old.id === saved.id ? saved : old));
      message.success('别名已更新');
    } catch (error) { message.error(errorText(error)); }
  };

  const deleteAlias = (item: CleaningAlias) => modal.confirm({
    title: `删除别名“${item.sourceText}”？`, okType: 'danger',
    onOk: async () => {
      try {
        await cleaningApi.deleteAlias(item.id);
        setAliases((items) => items.filter((old) => old.id !== item.id));
        message.success('别名已删除');
      } catch (error) { message.error(errorText(error)); }
    },
  });

  const renameTemplate = () => {
    const selected = templates.find((item) => item.id === templateId);
    if (!selected) return;
    let nextName = selected.name;
    modal.confirm({
      title: '修改模板名称', content: <Input defaultValue={selected.name} onChange={(event) => { nextName = event.target.value; }} />,
      onOk: async () => {
        try {
          const saved = await cleaningApi.updateTemplate(selected.id, { name: nextName.trim() });
          setTemplates((items) => items.map((item) => item.id === saved.id ? saved : item));
          message.success('模板已更新');
        } catch (error) { message.error(errorText(error)); }
      },
    });
  };

  const deleteTemplate = () => {
    const selected = templates.find((item) => item.id === templateId);
    if (!selected) return;
    modal.confirm({
      title: `删除模板“${selected.name}”？`, okType: 'danger',
      onOk: async () => {
        try { await cleaningApi.deleteTemplate(selected.id); setTemplates((items) => items.filter((item) => item.id !== selected.id)); setTemplateId(undefined); message.success('模板已删除'); }
        catch (error) { message.error(errorText(error)); }
      },
    });
  };

  const overwriteTemplate = async () => {
    const selected = templates.find((item) => item.id === templateId);
    if (!selected) return;
    try {
      const saved = await cleaningApi.updateTemplate(selected.id, { config: templateConfigFromPlan(buildPlan()) });
      setTemplates((items) => items.map((item) => item.id === saved.id ? saved : item));
      message.success('模板结构配置已更新');
    } catch (error) { message.error(errorText(error)); }
  };

  /**
   * UX-15:确认只发送批次 ID;结果未知(响应丢失)先查批次状态——
   * 已提交按成功处理并标注「经批次状态核对」,仍待确认允许重试同一批次,
   * 绝不自动新建导入批次。服务端确认失败会自动取消该 pending 批次,标记 failed 不再可重试。
   */
  const confirmBatch = async () => {
    if (!preview) return;
    const blocked = props.confirmGuard?.();
    if (blocked) { message.warning(blocked); return; }
    setBusy(true);
    setConfirmIssue(null);
    try {
      const outcome = await confirmImportBatchWithRecovery(preview.importBatchId);
      switch (outcome.kind) {
        case 'committed':
          await props.onConfirmBatch(preview.importBatchId);
          setConfirmed(true);
          message.success(props.targetKind === 'actual-current' ? '当前累计实际数已更新并生成新快照' : '预算导入已完成');
          if (outcome.viaRecovery) message.info('确认响应曾丢失，已经批次状态核对确认提交成功，未重复导入');
          return;
        case 'rejected':
          // 服务端在确认失败时已自动取消该批次;预览失效,可经「恢复配置并重新导入」取回计划与目标
          setConfirmIssue({ kind: 'failed', message: `${outcome.message}；该预览已失效。可点击下方「恢复配置并重新导入」取回本次配置（原文件仍在时一并恢复，已清除则需重新上传同一文件）。` });
          return;
        case 'still-pending':
          setConfirmIssue({ kind: 'retry', message: '确认请求未收到响应；已核对批次仍为待确认，可直接重试确认（同一批次，不会重复导入，也不会新建批次）。' });
          return;
        case 'unverifiable':
          setConfirmIssue({ kind: 'retry', message: `确认结果未知：${outcome.reason}。在核对前不要重新上传，以免重复导入；请重试确认（同一批次，已提交时服务端会拒绝重复确认）。` });
          return;
      }
    } catch (error) { modal.error({ title: '确认写入失败', content: errorText(error) }); }
    finally { setBusy(false); }
  };

  const saveTemplate = async () => {
    if (!templateName.trim()) return;
    try {
      const saved = await cleaningApi.saveTemplate({ name: templateName.trim(), targetKind: props.targetKind, config: templateConfigFromPlan(buildPlan()) });
      setTemplates((items) => [saved, ...items]); setTemplateId(saved.id); message.success('导入模板已保存');
    } catch (error) { message.error(errorText(error)); }
  };

  const requestClose = () => {
    // failed:服务端已在确认失败时自动取消该批次,关闭不再重复取消
    if (preview && !confirmed && confirmIssue?.kind !== 'failed') {
      modal.confirm({
        title: `取消待确认批次 #${preview.importBatchId}？`,
        content: '这份预览已固定。关闭向导将取消该批次；如只需修改映射或排除行，可改用「修改导入配置」恢复原文件与配置，无需重新上传有效原件。',
        okText: '取消批次并关闭', okType: 'danger',
        onOk: async () => {
          try { await api.post(`/io/import-batches/${preview.importBatchId}/cancel`); props.onClose(); }
          catch (error) { message.error(errorText(error)); }
        },
      });
      return;
    }
    props.onClose();
  };

  const next = async () => {
    if (step === 0) {
      if (!workbook) return message.warning('请先上传 .xlsx 文件');
      if (props.targetKind === 'actual-current' && !snapshotDate) return message.warning('请选择截止日期');
      setStep(1); return;
    }
    if (step === 1) {
      const error = validateRegion(); if (error) return message.warning(error);
      setStep(2); return;
    }
    if (step === 2) {
      const error = validateColumns(); if (error) return message.warning(error);
      const result = await analyze(); if (result) setStep(3); return;
    }
    if (step === 3) return createPreview();
    if (step === 4) setStep(5);
  };

  const renderTargetFile = () => (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="导入目标">{props.targetLabel}</Descriptions.Item>
        <Descriptions.Item label="目标类型">{props.targetKind === 'budget' ? '草稿预算版本' : '当前累计实际数'}</Descriptions.Item>
        {props.targetKind === 'actual-current' && <Descriptions.Item label="截止日期" span={2}>
          <DatePicker value={snapshotDate ? dayjs(snapshotDate) : null} onChange={(date) => setSnapshotDate(date?.format('YYYY-MM-DD') ?? '')} disabledDate={(date) => date.year() !== props.year} />
        </Descriptions.Item>}
      </Descriptions>
      {props.targetKind === 'actual-current' && <Alert type="warning" showIcon message="本次操作将更新当前累计实际数，并创建新的实际快照。" />}
      {/* UX-17:源文件失效(410)后的重传要求与指纹核验说明 */}
      {reuploadExpectation && !workbook && <Alert type="warning" showIcon
        message={`原文件「${reuploadExpectation.originalName}」已失效，请重新上传`}
        description={`名称映射、排除行、单位等配置已恢复。重新上传时将核验文件指纹（${reuploadExpectation.sha256.slice(0, 16)}…）：与原件一致则全部配置直接沿用；文件有变化则需重新核对映射与单位。`} />}
      <Space wrap>
        <Select
          allowClear placeholder="可选：复用已有导入模板" style={{ width: 360 }} value={templateId}
          options={templates.map((item) => ({ value: item.id, label: item.name }))}
          onChange={(id) => {
            setTemplateId(id);
            const template = templates.find((item) => item.id === id);
            if (template && workbook) applyTemplate(workbook, template.config, template.id);
          }}
        />
        <Button disabled={!templateId} onClick={renameTemplate}>重命名模板</Button>
        <Button danger disabled={!templateId} onClick={deleteTemplate}>删除模板</Button>
      </Space>
      <Dragger accept=".xlsx" multiple={false} showUploadList={false} disabled={busy} beforeUpload={(file) => { void handleFile(file as File); return Upload.LIST_IGNORE; }}>
        <p className="ant-upload-drag-icon"><i className="ri-inbox-2-line" aria-hidden /></p>
        <p className="ant-upload-text">点击或拖入非标准 .xlsx 文件</p>
        <p className="ant-upload-hint">文件会经过安全扫描；金额和数量始终由后端确定性读取。</p>
      </Dragger>
      {workbook && <Card size="small">
        <Descriptions size="small" column={3}>
          <Descriptions.Item label="文件">{workbook.originalName}</Descriptions.Item>
          <Descriptions.Item label="指纹">{workbook.sha256.slice(0, 16)}…</Descriptions.Item>
          <Descriptions.Item label="工作表">{workbook.sheets.length}</Descriptions.Item>
        </Descriptions>
        {workbook.aiSuggestion ? <Alert style={{ marginTop: 8 }} type="info" showIcon icon={<i className="ri-robot-2-line" aria-hidden />} message="已载入 AI 结构建议；浅色标签仅作预填，仍需人工确认。" />
          : <Alert style={{ marginTop: 8 }} type="success" showIcon message={workbook.aiAvailable ? 'AI 未返回有效建议，手工向导不受影响。' : 'AI 未配置，当前使用完整手工流程。'} />}
      </Card>}
      {/* UX-17:同目标类型文件带出最近更新的模板;模板只预填结构,文件结构、单位与差异仍须人工核对 */}
      {workbook && !templateId && templates.length > 0 && <Alert type="info" showIcon
        message={`可复用最近更新的模板「${templates[0].name}」`}
        description="一键带出该模板的工作表、行列对应与金额单位配置；带出后仍需核对文件结构、单位与差异，模板不会代替确认。"
        action={<Button size="small" type="primary" ghost onClick={() => {
          applyTemplate(workbook, templates[0].config, templates[0].id);
          message.success(`已带出模板「${templates[0].name}」的结构配置，请继续核对`);
        }}>带出该模板</Button>} />}
    </Space>
  );

  const regionColumns = useMemo<ColumnsType<WorkbookRowPreview>>(() => {
    const sheet = workbook?.sheets.find((item) => item.name === activeSheet);
    const columns: ColumnsType<WorkbookRowPreview> = [{ title: '行', dataIndex: 'row', fixed: 'left', width: 64 }];
    for (let index = 1; index <= (sheet?.columnCount ?? 0); index++) columns.push({
      title: excelColumnLetter(index), width: 150,
      render: (_, row) => {
        const cell = row.cells.find((item) => item.column === index);
        return <Space size={4}><span>{cell?.text}</span>{cell?.formula && <Tag color="red">公式</Tag>}{cell?.merged && <Tag>合并</Tag>}</Space>;
      },
    });
    columns.push({
      title: '设定', fixed: 'right', width: 190,
      render: (_, row) => <Space size={2}>
        <Button size="small" type={ranges[activeSheet]?.headerRow === row.row ? 'primary' : 'default'} onClick={(event) => { event.stopPropagation(); setRangeRow(activeSheet, 'header', row.row); }}>表头</Button>
        <Button size="small" type={ranges[activeSheet]?.dataStartRow === row.row ? 'primary' : 'default'} onClick={(event) => { event.stopPropagation(); setRangeRow(activeSheet, 'start', row.row); }}>开始</Button>
        <Button size="small" type={ranges[activeSheet]?.dataEndRow === row.row ? 'primary' : 'default'} onClick={(event) => { event.stopPropagation(); setRangeRow(activeSheet, 'end', row.row); }}>结束</Button>
      </Space>,
    });
    return columns;
  }, [workbook, activeSheet, ranges]);

  const renderRegion = () => (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert type="info" showIcon message="选中的工作表共用同一列映射；每张表可分别指定表头、开始行和结束行。隐藏工作表默认不选中。" />
      <Select data-assistant-field="sheets" mode="multiple" style={{ width: '100%' }} value={selectedSheets} onChange={selectSheets} options={workbook?.sheets.map((sheet) => ({
        value: sheet.name, label: `${sheet.name}${sheet.state !== 'visible' ? '（隐藏）' : ''} · ${sheet.rowCount} 行 × ${sheet.columnCount} 列`,
      }))} />
      <Space wrap>
        <span>当前预览：</span>
        <Select value={activeSheet} style={{ width: 240 }} onChange={(name) => { setActiveSheet(name); setRegionPage(1); }} options={selectedSheets.map((name) => ({ value: name, label: name }))} />
        <Radio.Group value={rowPickMode} onChange={(event) => setRowPickMode(event.target.value)} optionType="button" options={[{ label: '点击设为表头', value: 'header' }, { label: '点击设为开始', value: 'start' }, { label: '点击设为结束', value: 'end' }]} />
      </Space>
      {selectedSheets.map((name) => <Space key={name} wrap>
        <Typography.Text strong>{name}</Typography.Text>
        <span>表头</span><InputNumber data-assistant-field="headerRow" min={1} value={ranges[name]?.headerRow} onChange={(value) => value && setRangeRow(name, 'header', value)} />
        <span>数据开始</span><InputNumber data-assistant-field="dataStartRow" min={1} value={ranges[name]?.dataStartRow} onChange={(value) => value && setRangeRow(name, 'start', value)} />
        <span>数据结束</span><InputNumber data-assistant-field="dataEndRow" min={1} value={ranges[name]?.dataEndRow} onChange={(value) => value && setRangeRow(name, 'end', value)} />
      </Space>)}
      {(() => {
        // 行级建议(阶段四):仅当前工作簿建议表;已排除行默认视为采纳
        if (!workbook?.aiSuggestion) return null;
        const hintSheet = workbook.aiSuggestion.sheet;
        const hints = (workbook.aiSuggestion.rowHints ?? []).filter((hint) => hint.row >= (ranges[hintSheet]?.dataStartRow ?? 1));
        if (hints.length === 0) return null;
        return (
          <Alert
            type="info"
            showIcon
            icon={<i className="ri-robot-2-line" aria-hidden />}
            message={`AI 行级识别建议(${hintSheet}):采纳写入排除行并随整轮重跑生效,拒绝仅不再提示`}
            description={
              <div style={{ maxHeight: 160, overflow: 'auto' }}>
                {hints.map((hint) => {
                  const key = coordinateKey(hintSheet, hint.row);
                  const decided = rowHintDecisions[key];
                  const excluded = excludedRows.has(key);
                  const accepted = decided === 'accepted' || (decided === undefined && excluded);
                  return (
                    <Space key={key} size={6} style={{ marginBottom: 4 }}>
                      <Tag color={hint.kind === 'subtotal' ? 'orange' : 'blue'}>第 {hint.row} 行 · {ROW_HINT_LABEL[hint.kind]}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{hint.reason}</Typography.Text>
                      <Button size="small" type={accepted ? 'primary' : 'default'} disabled={accepted}
                        onClick={() => decideRowHint(hintSheet, hint.row, 'accepted')}>
                        {accepted ? '已采纳(已排除)' : '采纳(排除此行)'}
                      </Button>
                      <Button size="small" danger={decided === 'rejected'} disabled={decided === 'rejected'}
                        onClick={() => decideRowHint(hintSheet, hint.row, 'rejected')}>
                        {decided === 'rejected' ? '已拒绝' : '拒绝'}
                      </Button>
                    </Space>
                  );
                })}
              </div>
            }
          />
        );
      })()}
      <Spin spinning={busy}>
        <Table rowKey="row" size="small" bordered columns={regionColumns} dataSource={regionRows} scroll={{ x: 'max-content', y: 420 }}
          onRow={(row) => ({ onClick: () => setRangeRow(activeSheet, rowPickMode, row.row), style: { cursor: 'pointer' } })}
          pagination={{ current: regionPage, pageSize: 50, total: regionTotal, showSizeChanger: false, onChange: setRegionPage }} />
      </Spin>
    </Space>
  );

  const renderColumns = () => {
    if (!workbook || !selectedSheets[0]) return <Empty />;
    const sheetName = selectedSheets[0];
    const sheet = workbook.sheets.find((item) => item.name === sheetName)!;
    const range = ranges[sheetName];
    const resolvedHeaderText = (column: number) => regionCache[coordinateKey(sheetName, range.headerRow)]?.cells.find((cell) => cell.column === column)?.text
      ?? headerText(workbook, sheetName, range.headerRow, column);
    const cachedRows = Object.entries(regionCache).flatMap(([key, row]) => {
      const [cachedSheet] = JSON.parse(key) as [string, number];
      return cachedSheet === sheetName && row.row >= range.dataStartRow ? [row] : [];
    }).sort((a, b) => a.row - b.row);
    const resolvedSamples = (column: number) => {
      const cached = cachedRows.map((row) => row.cells.find((cell) => cell.column === column)?.text ?? '').filter(Boolean).slice(0, 3);
      return cached.length ? cached : samples(workbook, sheetName, range.dataStartRow, column);
    };
    const usedFields = new Set(Object.values(mappings));
    const data = Array.from({ length: sheet.columnCount }, (_, index) => ({ column: index + 1 }));
    return <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert type="warning" showIcon message="系统不会自动确认元/万元或负数口径；以下选择会在确认页再次展示。" />
      <Table data-assistant-field="columns" rowKey="column" size="small" pagination={false} dataSource={data} scroll={{ y: 430 }} columns={[
        { title: 'Excel 列', width: 90, render: (_, row) => `${excelColumnLetter(row.column)} (${row.column})` },
        { title: '原始表头', render: (_, row) => resolvedHeaderText(row.column) || <Typography.Text type="secondary">空</Typography.Text> },
        { title: '样例', render: (_, row) => resolvedSamples(row.column).join(' / ') || '—' },
        { title: 'AI 建议', width: 150, render: (_, row) => {
          const suggestion = workbook.aiSuggestion?.columns.find((item) => item.col === row.column);
          return suggestion ? <Tooltip title={suggestion.reason}><Tag color="geekblue">{CLEANING_FIELD_LABELS[suggestion.field]} {Math.round(suggestion.confidence * 100)}%</Tag></Tooltip> : '—';
        } },
        { title: '用户最终选择', width: 220, render: (_, row) => <Select allowClear style={{ width: '100%' }} value={mappings[row.column]} placeholder="不导入"
          options={FIELD_OPTIONS.map((item) => ({ ...item, disabled: usedFields.has(item.value) && mappings[row.column] !== item.value }))}
          onChange={(field) => { setMappings((current) => { const next = { ...current }; if (field) next[row.column] = field; else delete next[row.column]; return next; }); setAnalysis(null); }} /> },
      ] as ColumnsType<{ column: number }>} />
      <Divider style={{ margin: '4px 0' }} />
      <Space wrap>
        <span>导入值类型</span><Radio.Group data-assistant-field="valueKind" value={valueKind} onChange={(event) => {
          const next = event.target.value as 'amount' | 'quantity'; setValueKind(next);
          setMappings((current) => Object.fromEntries(Object.entries(current).filter(([, field]) => field !== (next === 'amount' ? 'quantity' : 'amount'))) as Record<number, CleaningColumnField>);
        }} options={[{ label: '金额', value: 'amount' }, { label: '数量', value: 'quantity' }]} />
        {valueKind === 'amount' && <>
          <span>文件单位</span><Radio.Group data-assistant-field="amountUnit" value={amountUnit} onChange={(event) => setAmountUnit(event.target.value)} options={[{ label: '元', value: 'yuan' }, { label: '万元', value: 'wan' }]} />
          <span>负数口径</span><Select data-assistant-field="signConvention" style={{ width: 280 }} value={signConvention} onChange={setSignConvention} options={[
            { value: 'display_positive', label: '普通展示口径（成本费用填正数）' },
            { value: 'profit_signed', label: '利润方向口径（成本费用为负）' },
          ]} />
        </>}
        {Object.values(mappings).includes('note') && <Checkbox checked={clearBlankNotes} onChange={(event) => setClearBlankNotes(event.target.checked)}>源备注为空时显式清空旧备注</Checkbox>}
      </Space>
      {valueKind === 'amount' && signConvention === 'profit_signed' && <Alert type="warning" showIcon message="利润方向口径：文件中的成本 -100 会先转成保存服务展示输入 100，再由既有保存规则存为负方向金额；不会重复反向。" />}
      {valueKind === 'quantity' && <Alert type="info" showIcon message="数量按 10⁴ 定点缩放；合法负数量表示冲销或更正，只警告，不施加利润方向。" />}
      {aiDiffers && <Alert type="info" showIcon message="用户最终选择与 AI 建议不同；系统将以用户选择为准。" />}
    </Space>;
  };

  const filteredIssues = (analysis?.errors ?? []).filter((item) => !issueField || item.field === issueField);
  const suspectedRows = (analysis?.rows ?? []).filter((row) => row.suspectedReason && row.suspectedReason !== '完全空行');
  const renderAnalyze = () => !analysis ? <Empty description="正在生成分析结果" /> : (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Space wrap>
        <Tag color={analysis.counts.errors ? 'red' : 'green'}>错误 {analysis.counts.errors}</Tag>
        <Tag color={analysis.counts.unresolved ? 'orange' : 'green'}>未决映射 {analysis.counts.unresolved}</Tag>
        <Tag>有效行 {analysis.counts.effective}</Tag><Tag>排除行 {analysis.counts.excluded}</Tag>
        {analysisDirty && <Tag color="gold">配置已修改，请重新分析</Tag>}
        <Button loading={busy} onClick={() => void analyze()}>重新分析 / 批量接受唯一精确匹配</Button>
      </Space>
      {analysis.errors.length > 0 && <Card size="small" title={<Space><i className="ri-error-warning-line" aria-hidden />解析错误<Select allowClear placeholder="按字段筛选" style={{ width: 180 }} value={issueField} onChange={setIssueField} options={[...new Set(analysis.errors.map((item) => item.field))].map((field) => ({ value: field, label: field }))} /></Space>}>
        <Table rowKey={(row) => `${row.sheetName}:${row.row}:${row.code}`} size="small" pagination={{ pageSize: 8 }} dataSource={filteredIssues} columns={[
          { title: '位置', render: (_, row) => `${row.sheetName}!${row.row}` }, { title: '字段', dataIndex: 'field' }, { title: '问题', dataIndex: 'message' },
        ] as ColumnsType<CleaningIssue>} />
      </Card>}
      {analysis.unresolved.length > 0 && <Card size="small" title="按相同源文本批量匹配（一次选择应用到全部对应行）">
        <Table rowKey={(row) => `${row.kind}:${row.sourceText}`} size="small" pagination={{ pageSize: 8 }} dataSource={analysis.unresolved} columns={[
          { title: '类型', render: (_, row) => row.kind === 'org' ? '组织' : '科目' },
          { title: '源文本', dataIndex: 'sourceText' },
          { title: '涉及行', render: (_, row) => row.rows.slice(0, 5).map((item) => `${item.sheetName}!${item.row}`).join('、') + (row.rows.length > 5 ? ` 等 ${row.rows.length} 行` : '') },
          { title: '相似候选', render: (_, row) => row.candidates.slice(0, 3).map((item) => <Tag key={item.code}>{item.code} {item.name} {Math.round(item.score * 100)}%</Tag>) },
          { title: '人工选择', width: 360, render: (_, row) => {
            const key = mappingKey(row.kind, row.sourceText);
            const options = row.kind === 'org' ? analysis.targets.orgs : analysis.targets.accounts;
            return <Space.Compact style={{ width: '100%' }}><Select showSearch optionFilterProp="label" style={{ width: 275 }} value={manualMappings[key]} placeholder="搜索编码、名称或路径"
              options={options.map((item) => ({ value: item.code, label: `${item.code} · ${item.path}${item.status !== 'active' ? '（停用，仅更正）' : ''}` }))}
              onChange={(code) => { setManualMappings((current) => ({ ...current, [key]: code })); setAnalysisDirty(true); }} />
              <Button disabled={!manualMappings[key]} onClick={() => setActiveAlias({ mappingKind: row.kind, sourceText: row.sourceText })}>检查别名</Button><Button disabled={!manualMappings[key]} onClick={() => void saveAlias(row.kind, row.sourceText)}>存别名</Button></Space.Compact>;
          } },
        ]} />
      </Card>}
      <Card data-assistant-field="mappings" size="small" title={`名称别名管理${aliases.length ? `（${aliases.length}）` : ''}`}>
        {aliases.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未保存别名；可在上方人工选择目标后点击“存别名”" /> : <Table
          rowKey="id" onRow={(row) => ({ "data-assistant-alias-id": String(row.id) } as React.HTMLAttributes<HTMLTableRowElement>)} size="small" pagination={{ pageSize: 6 }} dataSource={aliases} columns={[
            { title: '类型', width: 80, render: (_, row) => row.mappingKind === 'org' ? '组织' : '科目' },
            { title: '源文本', render: (_, row) => <Input data-assistant-field="sourceText" value={aliasDrafts[row.id]?.sourceText ?? row.sourceText} onChange={(event) => setAliasDrafts((items) => ({ ...items, [row.id]: { sourceText: event.target.value, targetCode: items[row.id]?.targetCode ?? row.targetCode } }))} /> },
            { title: '目标', width: 360, render: (_, row) => {
              const options = row.mappingKind === 'org' ? analysis.targets.orgs : analysis.targets.accounts;
              return <Select data-assistant-field="targetCode" showSearch optionFilterProp="label" style={{ width: '100%' }} value={aliasDrafts[row.id]?.targetCode ?? row.targetCode}
                options={[...(options.some((item) => item.code === row.targetCode) ? [] : [{ value: row.targetCode, label: `${row.targetCode}（当前树中无效）` }]), ...options.map((item) => ({ value: item.code, label: `${item.code} · ${item.path}` }))]}
                onChange={(code) => setAliasDrafts((items) => ({ ...items, [row.id]: { sourceText: items[row.id]?.sourceText ?? row.sourceText, targetCode: code } }))} />;
            } },
            { title: '操作', width: 150, render: (_, row) => <Space><Button size="small" onClick={() => setActiveAlias({ id: row.id, mappingKind: row.mappingKind, sourceText: row.sourceText })}>检查修改</Button><Button size="small" onClick={() => void updateAlias(row)}>保存</Button><Button size="small" danger onClick={() => deleteAlias(row)}>删除</Button></Space> },
          ] as ColumnsType<CleaningAlias>}
        />}
      </Card>
      {suspectedRows.length > 0 && <Card size="small" title="疑似小计、标题或备注行（默认不排除）">
        <Table rowKey={(row) => coordinateKey(row.sheetName, row.rowNumber)} size="small" pagination={{ pageSize: 8 }} dataSource={suspectedRows} columns={[
          { title: '排除', width: 70, render: (_, row) => <Checkbox checked={excludedRows.has(coordinateKey(row.sheetName, row.rowNumber))} onChange={(event) => {
            setExcludedRows((current) => { const next = new Set(current); const key = coordinateKey(row.sheetName, row.rowNumber); if (event.target.checked) next.add(key); else next.delete(key); return next; }); setAnalysisDirty(true);
          }} /> },
          { title: '位置', render: (_, row) => `${row.sheetName}!${row.rowNumber}` }, { title: '原因', dataIndex: 'suspectedReason' },
          { title: '组织 / 科目', render: (_, row) => `${row.sourceOrgText || '—'} / ${row.sourceAccountText || '—'}` }, { title: '源值', dataIndex: 'sourceValueText' },
        ]} />
      </Card>}
      {analysis.counts.excluded > 0 && <Alert type="info" showIcon message={`已排除 ${analysis.counts.excluded} 行`} description={analysis.exclusionSummary.amount
        ? `排除源金额合计：${centsToWan(analysis.exclusionSummary.amount.sourceAmountCents)} 万元`
        : <Space wrap>{analysis.exclusionSummary.quantity?.groups.map((group) => <Tag key={group.accountCode}>{group.accountCode}：{formatQuantity(group.quantityScaled, group.unit)}</Tag>)}</Space>} />}
      {analysis.counts.warnings > 0 && <Alert type="warning" showIcon message={`有 ${analysis.counts.warnings} 条非阻断警告`} description={analysis.warnings.slice(0, 5).map((item) => <div key={`${item.sheetName}:${item.row}:${item.code}`}>{item.sheetName}!{item.row}：{item.message}</div>)} />}
      {!analysis.counts.errors && !analysis.counts.unresolved && !analysisDirty && <Alert type="success" showIcon message="解析错误与未决映射均为 0，可以检查导入结果。" />}
    </Space>
  );

  const previewUnitLabel = !preview ? '' : preview.summary.valueKind === 'amount' ? (preview.summary.amountUnit === 'wan' ? '万元' : '元') : '数量';
  const previewColumns: ColumnsType<CleaningPreviewRow> = [
    { title: '位置', width: 120, render: (_, row) => `${row.sheet_name}!${row.row_number}` },
    { title: '源组织 / 科目', render: (_, row) => `${row.source_org_text || '—'} / ${row.source_account_text || '—'}` },
    { title: '目标组织 / 科目', render: (_, row) => `${row.target_org_code || '—'} / ${row.target_account_code || '—'}` },
    { title: '源值', dataIndex: 'source_value_text' }, { title: `转换后数值（${previewUnitLabel || '确认单位'}）`, dataIndex: 'normalized_value' },
    ...(preview?.summary.valueKind === 'amount'
      ? [{ title: '预计最终利润方向值（元）', dataIndex: 'expected_value_text' } as ColumnsType<CleaningPreviewRow>[number]]
      : []),
    { title: '动作', width: 100, render: (_, row) => <Tag color={ACTION_COLOR[row.action]}>{row.action === 'clear' ? clearActionLabel : ACTION_LABEL[row.action]}</Tag> },
    { title: '警告', dataIndex: 'warning' },
  ];

  const renderPreview = () => !preview ? <Empty /> : (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert type="info" showIcon message={`已创建待确认批次 #${preview.importBatchId}，这份预览已固定。`} description="确认只使用这份已固定的检查结果（只提交批次号）；如需修改映射或排除行，点击「修改导入配置」恢复原文件与配置后重新分析，无需重新上传有效原件。" />
      {/* UX-15:与标准/财务导入同一组核对问题,三种路径表达一致 */}
      <Descriptions size="small" bordered column={3}>
        <Descriptions.Item label="写入目标">{props.targetLabel}</Descriptions.Item>
        {props.targetKind === 'actual-current' && <Descriptions.Item label="期间 / 截止日">{props.year} 年 · 截止 {snapshotDate}</Descriptions.Item>}
        {props.targetKind === 'budget' && <Descriptions.Item label="期间 / 截止日">{props.year} 年预算草稿（无截止日）</Descriptions.Item>}
        <Descriptions.Item label="更新当前累计">{props.targetKind === 'actual-current' ? '是' : '否（写入预算草稿）'}</Descriptions.Item>
        <Descriptions.Item label="生成快照">{props.targetKind === 'actual-current' ? '是（确认时生成）' : '否'}</Descriptions.Item>
        <Descriptions.Item label="差异比较基线">{props.targetKind === 'actual-current' ? '当前累计实际数' : '预算版本明细（草稿当前内容）'}</Descriptions.Item>
        <Descriptions.Item label="结果位置">{props.targetKind === 'actual-current' ? '当前累计实际数，并生成对应年度快照' : '预算版本明细'}</Descriptions.Item>
      </Descriptions>
      <Space wrap size="middle">
        <Card size="small"><Statistic title="新增" value={preview.summary.actions.insert} /></Card>
        <Card size="small"><Statistic title="覆盖" value={preview.summary.actions.overwrite} /></Card>
        <Card size="small"><Statistic title="不变" value={preview.summary.actions.unchanged} /></Card>
        <Card size="small"><Statistic title={clearActionLabel} value={preview.summary.actions.clear} /></Card>
        <Card size="small"><Statistic title="排除" value={preview.summary.actions.excluded} /></Card>
      </Space>
      <Descriptions size="small" bordered column={3}>
        <Descriptions.Item label="范围">{preview.summary.scopeLabel}</Descriptions.Item>
        <Descriptions.Item label="单位">{preview.summary.valueKind === 'amount' ? preview.summary.amountUnit === 'wan' ? '万元' : '元' : '数量（最多四位小数）'}</Descriptions.Item>
        <Descriptions.Item label="负数口径">{preview.summary.valueKind === 'amount' ? preview.summary.signConvention === 'profit_signed' ? '利润方向' : '普通展示口径' : '不适用'}</Descriptions.Item>
        {preview.summary.amount && <>
          <Descriptions.Item label="导入前">{centsToWan(preview.summary.amount.beforeCents)} 万元</Descriptions.Item>
          <Descriptions.Item label="导入后">{centsToWan(preview.summary.amount.afterCents)} 万元</Descriptions.Item>
          <Descriptions.Item label="变化">{centsToWan(preview.summary.amount.changeCents)} 万元</Descriptions.Item>
        </>}
      </Descriptions>
      {preview.summary.quantity?.groups.map((group) => <Alert key={group.accountCode} type="info" message={`${group.accountCode} · ${group.unit || '未设置单位'} · 聚合 ${group.quantityAgg}`} description={group.quantityAgg === 'none' ? '该科目只展示逐单元格变化，不计算合计。' : `导入前 ${formatQuantity(group.beforeScaled, group.unit)}，导入后 ${formatQuantity(group.afterScaled, group.unit)}，变化 ${formatQuantity(group.changeScaled, group.unit)}`} />)}
      {preview.summary.amount?.changesByOrgAndRoot.length ? <Card size="small" title="按组织与一级科目变化（元，利润方向）">
        <Table rowKey={(row) => `${row.orgCode}:${row.rootAccountCode}`} size="small" pagination={{ pageSize: 8 }} dataSource={preview.summary.amount.changesByOrgAndRoot} columns={[
          { title: '组织', dataIndex: 'orgCode' },
          { title: '一级科目', dataIndex: 'rootAccountCode' },
          { title: '变化额（元）', dataIndex: 'changeCents', align: 'right', render: (value: number) => centsToYuan(value) },
        ]} />
      </Card> : null}
      {preview.summary.counts.warnings > 0 && <Alert type="warning" showIcon
        message={`有 ${preview.summary.counts.warnings} 条非阻断警告，请确认后继续`}
        description={preview.summary.warnings.length > 0
          ? preview.summary.warnings.slice(0, 8).map((item) => <div key={`${item.sheetName}:${item.row}:${item.code}`}>{item.sheetName ? `${item.sheetName}!${item.row}：` : ''}{item.message}</div>)
          : '可在下方勾选“仅看警告行”查看逐行明细。'} />}
      <Alert type="warning" showIcon message={preview.summary.clearSemantics} />
      <Space wrap>
        {/* UX-17:临确认修改配置——恢复服务取消旧预览并恢复原文件/计划/目标,重新分析生成全新预览 */}
        <Button onClick={requestReopen} loading={reopening} disabled={busy}>修改导入配置</Button>
        <Select allowClear placeholder="按动作筛选" style={{ width: 160 }} value={actionFilter} onChange={(value) => { setActionFilter(value); setPreviewPage(1); }} options={Object.entries(ACTION_LABEL).map(([value, label]) => ({ value, label: value === 'clear' ? clearActionLabel : label }))} />
        <Checkbox checked={warningOnly} onChange={(event) => { setWarningOnly(event.target.checked); setPreviewPage(1); }}>仅看警告行</Checkbox>
      </Space>
      <Table rowKey="id" size="small" dataSource={previewRows} columns={previewColumns} scroll={{ x: 1000, y: 400 }} pagination={{ current: previewPage, pageSize: 100, total: previewTotal, showSizeChanger: false, onChange: setPreviewPage }} />
    </Space>
  );

  const renderConfirm = () => !preview ? <Empty /> : (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Descriptions bordered size="small" column={2}>
        <Descriptions.Item label="批次">#{preview.importBatchId}</Descriptions.Item><Descriptions.Item label="目标">{props.targetLabel}</Descriptions.Item>
        <Descriptions.Item label="导入值">{preview.summary.valueKind === 'amount' ? `${preview.summary.amountUnit === 'wan' ? '万元' : '元'} / ${preview.summary.signConvention === 'profit_signed' ? '利润方向' : '普通展示口径'}` : '数量（负数表示冲销或更正）'}</Descriptions.Item>
        <Descriptions.Item label="影响">新增 {preview.summary.actions.insert} · 覆盖 {preview.summary.actions.overwrite} · {clearActionLabel} {preview.summary.actions.clear}</Descriptions.Item>
      </Descriptions>
      {props.targetKind === 'actual-current' && <Alert type="warning" showIcon message="确认后将更新当前累计实际数，并创建新的实际快照。" />}
      {preview.summary.signConvention === 'profit_signed' && <Alert type="warning" showIcon message="已确认文件采用利润方向；成本费用负数不会被当作普通正数再次反向。" />}
      {preview.summary.counts.warnings > 0 && <Alert type="warning" showIcon
        message={`本批次有 ${preview.summary.counts.warnings} 条非阻断警告`}
        description={preview.summary.warnings.length > 0
          ? preview.summary.warnings.slice(0, 8).map((item) => <div key={`${item.sheetName}:${item.row}:${item.code}`}>{item.sheetName ? `${item.sheetName}!${item.row}：` : ''}{item.message}</div>)
          : '警告不阻断写入；请返回差异预览查看警告行。'} />}
      {aiDiffers && <Alert type="info" showIcon message="本批次包含对 AI 结构建议的人工修改，最终配置已固化在批次计划中。" />}
      {preview.summary.actions.overwrite > 0 && <Checkbox checked={overwriteAccepted} onChange={(event) => setOverwriteAccepted(event.target.checked)}>我已查看本次将覆盖的 {preview.summary.actions.overwrite} 项数据</Checkbox>}
      {confirmIssue && (
        <Alert
          type={confirmIssue.kind === 'failed' ? 'error' : 'warning'}
          showIcon
          message={confirmIssue.kind === 'failed' ? '确认失败，预览已失效' : '确认结果未确认，可重试'}
          description={confirmIssue.message}
        />
      )}
      {!confirmed && confirmIssue?.kind !== 'failed' ? (() => {
        const needsOverwriteAccept = preview.summary.actions.overwrite > 0 && !overwriteAccepted;
        const confirmButton = (
          <Button type="primary" size="large" loading={busy} disabled={needsOverwriteAccept || reopening} onClick={() => void confirmBatch()}>
            确认写入 {preview.summary.actions.insert + preview.summary.actions.overwrite + preview.summary.actions.clear + preview.summary.actions.unchanged} 项 · 新增 {preview.summary.actions.insert} 项 · 覆盖 {preview.summary.actions.overwrite} 项 · {props.targetLabel}
          </Button>
        );
        return <Space wrap>
          {needsOverwriteAccept
            ? <Tooltip title={`本次将覆盖 ${preview.summary.actions.overwrite} 项已有数据，需先勾选上方「我已查看本次将覆盖的数据」`}><span>{confirmButton}</span></Tooltip>
            : confirmButton}
          {/* UX-17:临确认改配置不必重传有效原件;覆盖勾选不沿用到重新分析后的新差异 */}
          <Button onClick={requestReopen} loading={reopening} disabled={busy}>修改导入配置</Button>
        </Space>;
      })() : confirmed ? <>
        <Alert type="success" showIcon message={`批次 #${preview.importBatchId} 已成功写入`} />
        <Card size="small" title="可选：保存本次结构配置为导入模板">
          <Space wrap style={{ marginBottom: 12 }}><Button onClick={() => setTemplateDraftMode('create')}>检查另存模板</Button><Button disabled={!selectedTemplate} onClick={() => setTemplateDraftMode('update')}>检查更新模板</Button></Space>
          <Space wrap>
            <Space.Compact style={{ width: 520 }}><Input data-assistant-field="name" value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="新模板名称" /><Button icon={<i className="ri-save-3-line" aria-hidden />} disabled={!templateName.trim()} onClick={() => void saveTemplate()}>另存模板</Button></Space.Compact>
            <Button disabled={!templateId} onClick={() => void overwriteTemplate()}>用本次配置更新所选模板</Button>
          </Space>
        </Card>
        <Space><Button onClick={() => navigate('/data?tab=imports')}>查看导入批次</Button><Button type="primary" onClick={props.onClose}>完成</Button></Space>
      </> : (
        /* UX-17:确认失败时服务端已自动取消批次;经恢复服务取回计划与目标(原件仍在则一并恢复,失效则引导重传) */
        <Space wrap>
          <Button onClick={requestReopen} loading={reopening} disabled={busy}>恢复配置并重新导入</Button>
          <Button onClick={props.onClose}>关闭</Button>
        </Space>
      )}
    </Space>
  );

  const contents = [renderTargetFile, renderRegion, renderColumns, renderAnalyze, renderPreview, renderConfirm];
  return <Modal
    mask={false} open={props.open} width="min(1180px, 96vw)" title="导入非标准 Excel" onCancel={requestClose} maskClosable={false} destroyOnClose
    footer={<Space style={{ width: '100%', justifyContent: 'space-between' }}>
      <Button onClick={requestClose}>{preview && !confirmed && confirmIssue?.kind !== 'failed' ? '取消批次并关闭' : '关闭'}</Button>
      <Space>
        {step > 0 && step < 4 && <Button disabled={busy} onClick={() => setStep(step - 1)}>上一步</Button>}
        {step < 5 && <Button type="primary" loading={busy} onClick={() => void next()}>{step === 3 ? '检查导入结果' : step === 4 ? '进入确认' : '下一步'}</Button>}
      </Space>
    </Space>}
  >
    {props.open && workbook && <>
      <ConfigFormAssistant key={activeAlias && step === 3 ? 'alias' : 'cleaning'} kind={activeAlias && step === 3 ? 'alias_rule' : 'cleaning_template'} onLocateField={(field) => {
        if (activeAlias && step === 3) {
          const row = activeAlias.id != null ? document.querySelector<HTMLElement>('[data-assistant-alias-id="' + activeAlias.id + '"]') : document.querySelector<HTMLElement>('[data-assistant-field="mappings"]');
          row?.scrollIntoView({ block: 'nearest' });
          row?.querySelector<HTMLElement>('[data-assistant-field="' + field + '"] input, input[data-assistant-field="' + field + '"], input')?.focus();
          return;
        }
        const targetStep = field === 'name' ? 5 : ['sheets', 'headerRow', 'dataStartRow', 'dataEndRow', 'preferredSheetName'].includes(field) ? 1 : ['mappings', 'excludedRows'].includes(field) ? 3 : 2;
        setStep(targetStep);
        window.setTimeout(() => {
          const element = document.querySelector<HTMLElement>('[data-assistant-field="' + field + '"]');
          element?.scrollIntoView({ block: 'nearest' });
          if (element?.matches('input, button')) element.focus();
          else element?.querySelector<HTMLElement>('input, button, [tabindex]')?.focus();
        }, 0);
      }} />
      {activeAlias && <Button onClick={() => setActiveAlias(null)}>返回清洗计划</Button>}
    </>}
    <Steps current={step} size="small" items={['目标和文件', '工作表和区域', '列和口径', '名称和排除行', '差异预览', '确认和模板'].map((title) => ({ title }))} style={{ marginBottom: 20 }} />
    {/* UX-17:410 重传后指纹不一致——变化文件必须重新核对,持续提示到重新分析成功 */}
    {reuploadChanged && <Alert style={{ marginBottom: 12 }} type="warning" showIcon
      message="重新上传的文件与上次不同，请重新核对映射"
      description="工作表区域、列映射、金额单位与排除行都需要按新文件重新核对；确认无误后重新分析并检查导入结果。" />}
    <div style={{ minHeight: 520, maxHeight: '68vh', overflow: 'auto', padding: '0 2px' }}>{contents[step]()}</div>
  </Modal>;
}
