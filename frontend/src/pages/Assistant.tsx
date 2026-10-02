import { pageDefinition } from '@contracts/page-catalog';
/**
 * AI 助手页面(方案《AI助手完整方案》4.1/4.2/4.3 的前端入口)。
 *
 * 职责边界:只做展示、交互和调用。所有金额、汇总、完成率、版本状态与快照口径
 * 都来自后端事实;写操作一律「预览 → 确认」,前端不绕过任何业务校验。
 *
 * 聊天核心(会话、流式、世代号、上下文合并)住在 `src/assistant/AssistantProvider.tsx`,
 * 与全局悬浮小窗「财务助手」共享同一份状态;本页只保留页面特有的重功能:
 * 会话列表、保存的洞察、归因/报告/导入/口径抽屉、操作预览卡与新建操作弹窗。
 *
 * 布局:桌面端是一块撑满视口高度的三栏工作区(可折叠/可拖拽调宽的侧栏 + 聊天区),
 * 聊天区内部再分「固定工具行 / 独立滚动的消息区 / 固定输入器」三层,窄屏回退成上下堆叠。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, Button, Card, Descriptions, Drawer, Grid, Input, List, Modal, Popconfirm,
  Select, Space, Spin, Switch, Tabs, Tag, Tooltip, Typography, message, theme,
} from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { ApiError, can } from '../api/client';
import { DOMAIN_PROMPTS } from '../assistant/domainContext';
import { PAGE_CATALOG, pagePath } from '@contracts/page-catalog';
import type { PageId } from '@contracts/page-catalog';
import {
  assistantApi, previewIdempotencyKey,
  type AssistantAction, type InsightKind,
} from '../api/assistant';
import { useAssistant, type ChatTurn } from '../assistant/AssistantProvider';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { READ_INTENT_LABEL } from '../assistant/labels';

import { isTurnOriginStale } from '../assistant/scopeDisplay';
import { Markdown } from '../components/assistant/Markdown';
import { CitationList, FactsPanel, factLabel } from '../components/assistant/FactsPanel';
import {
  AssistantMark, Composer, Disclaimer, EvidenceFold, RecommendList, SectionLabel, SkillCards,
} from '../components/assistant/AssistantPanelKit';
import { ActionPreviewCard } from '../components/assistant/ActionPreviewCard';
import { AssistantScopeBar } from '../components/assistant/AssistantScopeBar';
import { NewActionModal } from '../components/assistant/NewActionModal';
import { AttributionDrawer } from '../components/assistant/AttributionDrawer';
import { ReportDrawer } from '../components/assistant/ReportDrawer';
import { ImportHelpDrawer } from '../components/assistant/ImportHelpDrawer';
import { relativeTime, shortTime } from '../utils/relativeTime';
import { FinanceEmpty } from '../components/FinanceEmpty';
import type { AssistantContext } from '../api/assistant';

/** 独立页的通用快捷提问(抽屉里按当前页面另有一套，见 assistant/pageContext.ts) */
const QUICK_PROMPTS = [
  '列出本年度预算版本和当前生效版本',
  '分析本年度预算执行情况与完成率',
  '哪个组织亏得最多',
  '费用超支了没，进度是不是太快',
  '检查本年度预算异常与质量问题',
  '解释完成率、金额方向和万元换算口径',
  '本年度利润为什么低于预算，按组织和科目给出归因',
  '生成本年度预算执行月报',
  '打开年度执行分析页面',
];

import { INSIGHT_KINDS } from './assistantShared/insightKinds';
import { InsightKindPicker } from '../components/InsightKindPicker';

/** 空状态欢迎区的能力卡:独立页有整块空间，给四张而不是抽屉里的两张。 */
const WELCOME_SKILLS = [
  { key: 'attribution', icon: 'insight' as const, title: '差异归因', desc: '按组织与科目逐层拆解预算差异', prompt: '本年度利润为什么低于预算，按组织和科目给出归因' },
  { key: 'execution', icon: 'insight' as const, title: '执行速览', desc: '完成率、时间进度与节奏差一次说清', prompt: '分析本年度预算执行情况与完成率' },
  { key: 'anomaly', icon: 'alert' as const, title: '异常与质量检查', desc: '空值、反向、离群与口径问题', prompt: '检查本年度预算异常与质量问题' },
  { key: 'report', icon: 'trend' as const, title: '执行月报', desc: '生成可导出、带引用的报告草稿', prompt: '生成本年度预算执行月报' },
];

/**
 * 判断这一轮回答是否包含「宽内容」(结构化事实表、Markdown 表格)。
 * 宽内容所在的回答块允许突破到 960px,纯文本回答与输入框保持 760px 收窄列。
 */
function hasWideContent(turn: ChatTurn): boolean {
  if (turn.response?.facts?.length) return true;
  return /\n\|[^\n]*\|\n\|[ :\-|]+\|/.test(turn.text);
}

/**
 * 空状态欢迎区。
 * 完整页的空白比抽屉大得多,只放两张能力卡会显得空;这里用「标识 + 一句定位 + 2×2 能力网格 +
 * 双列推荐」把首屏填满,用户不用滚动就知道能问什么。
 */
function WelcomePanel({ onPick }: { onPick: (prompt: string) => void }) {
  const [domain, setDomain] = useState('all');
  const available = Object.entries(DOMAIN_PROMPTS).map(([k, prompts]) => [k, { ...PAGE_CATALOG[k as PageId], path: pagePath(k as PageId), prompts }] as const).filter(([k, p]) => can(p.permission) && !['security', 'project_profile', 'contract_import', 'business_settings', 'jobs', 'search'].includes(k));
  const selected = available.find(([k]) => k === domain)?.[1];
  const prompts = domain === 'budget' ? QUICK_PROMPTS : selected ? selected.prompts : available.flatMap(([, p]) => p.prompts.slice(0, 1)).slice(0, 8);
  const skills = domain === 'budget' ? WELCOME_SKILLS : (selected ? [[domain, selected] as const] : available.filter(([k]) => ['contracts', 'expense', 'risk', 'statements'].includes(k))).map(([k, p]) => ({ key: k, icon: 'insight' as const, title: p.label, desc: p.prompts[0], prompt: p.prompts[0] }));
  return (
    <div className="newfc-assistant-welcome">
      <AssistantMark size={44} />
      {/* 眉题:等宽字体编辑感小字,空状态作为品牌展示区的定位语 */}
      <p className="newfc-eyebrow" style={{ margin: '4px 0 0' }}>AI ASSISTANT</p>
      <h2 className="newfc-assistant-welcome-title">你好，我是财务助手</h2>
      <p className="newfc-assistant-welcome-sub">
        查询预算、财报、合同、费用、风险与投资，核对来源和业务口径。
        <strong>正式写入由页面预览或业务流程显式确认</strong>
      </p>
      <div style={{ width: '100%', maxWidth: 680, margin: '0 auto' }}>
        <Select aria-label="提问业务范围" value={domain} onChange={setDomain} style={{ width: '100%', marginBottom: 16 }} options={[{ value: 'all', label: '综合查询' }, ...(can('analysis:read') ? [{ value: 'budget', label: '经营预算' }] : []), ...available.map(([k, p]) => ({ value: k, label: p.label }))]} />
        <SkillCards items={skills} columns={2} onPick={(item) => onPick(item.prompt)} />
        <div style={{ marginTop: 24 }}>
          <SectionLabel>你是否想问</SectionLabel>
          <RecommendList prompts={prompts} columns={2} onPick={onPick} />
        </div>
      </div>
    </div>
  );
}

/**
 * 一轮回答。
 *
 * 元信息分三档,但**三档都默认可见**——路由来源、模型降级、口径 chips、引用来源与
 * 后端提示是「答案可信度」的证据,藏进折叠区会让护栏形同虚设;降噪靠的是排版
 * (11px、无边框、统一收进气泡底部的元信息区),不是靠隐藏。
 */
const metricsHint = (metrics: NonNullable<ChatTurn['response']>['metrics']) => {
  if (!metrics) return null;
  return `总耗时 ${(metrics.durationMs / 1000).toFixed(1)}s`
    + (metrics.modelCalls > 0
      ? `，模型请求 ${metrics.modelCalls} 次 / ${(metrics.modelMs / 1000).toFixed(1)}s，只读工具 ${metrics.toolCalls} 次`
      : '，本轮未调用模型');
};

function TurnView({ turn, currentPage, onAdoptContext, onNavigate, onSuggestion, onCreatePreview, onOpenNewAction }: {
  turn: ChatTurn;
  /** 当前页面 pageKey：回答发起页与当前页不同时标注「基于原页面范围」(UX-26) */
  currentPage: string;
  onAdoptContext: (context: AssistantContext) => void;
  onNavigate: (path: string) => void;
  onSuggestion: (text: string) => void;
  onCreatePreview: (action: { type: string; params: Record<string, unknown> }) => void;
  onOpenNewAction: () => void;
}) {
  const response = turn.response;
  if (turn.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <div className="newfc-ai-bubble-user" style={{ maxWidth: '80%' }}>{turn.text}</div>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', gap: 10, marginBottom: 18 }}>
      <AssistantMark size={24} />
      <div className="newfc-ai-bubble-ai" style={{ flex: '1 1 auto', minWidth: 0 }}>
        <Space size={4} style={{ marginBottom: 8 }} wrap>
          {response?.routing && (
            <Tooltip title={response.routing === 'model'
              ? '模型自主调用只读工具取数，数字仍来自后端'
              : '模型不可用或未调用工具，已按关键词兜底路由到确定性查询'}>
              <Tag bordered={false} className="newfc-ai-meta" color={response.routing === 'model' ? 'blue' : undefined}>
                {response.routing === 'model' ? '模型路由' : '关键词兜底'}
              </Tag>
            </Tooltip>
          )}
          {turn.model && (
            <Tag bordered={false} className="newfc-ai-meta">
              {turn.model === 'template' ? (
                <Tooltip title="模型不可用,已回退确定性模板;可在「系统 → AI 渠道设置」配置渠道">
                  <Link to="/settings/ai" style={{ color: 'inherit' }}>模板降级(模型不可用)</Link>
                </Tooltip>
              ) : turn.model}
            </Tag>
          )}
        {response?.intents?.inheritedRead?.length ? (
          <Tooltip title="本轮没有重述话题，助手沿用了上一轮的分析方向与筛选范围">
            <Tag bordered={false} className="newfc-ai-meta" color="cyan">
              追问·沿用{response.intents.inheritedRead.map((intent) => READ_INTENT_LABEL[intent] ?? intent).join('、')}
            </Tag>
          </Tooltip>
        ) : null}
        {turn.createdAt && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{shortTime(turn.createdAt)}</Typography.Text>}
        {isTurnOriginStale(turn.origin?.pageKey, currentPage) && (
          <Tooltip title="这条回答的范围以发起时所在页面为准，与当前页面不同，不代表你正在看的对象">
            <Tag bordered={false} className="newfc-ai-meta" color="gold" data-testid="assistant-turn-origin">
              基于「{pageDefinition(turn.origin!.pageKey)?.label ?? turn.origin!.pageKey}」当时的范围
            </Tag>
          </Tooltip>
        )}
        </Space>
        {turn.pending && !turn.text ? (
          <Space size={8}>
            <Spin size="small" />
            <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="assistant-progress">
              {turn.progress ? `${turn.progress.label}${turn.progress.detail ? `（${turn.progress.detail}）` : ''}…` : '正在处理…'}
            </Typography.Text>
          </Space>
        ) : (
          <div data-testid="assistant-answer" style={{ marginBottom: 6 }}>
            <Markdown text={turn.text} />
          </div>
        )}
        {turn.pending && turn.text && turn.progress ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{turn.progress.label}…</Typography.Text>
        ) : null}
        {turn.stopped ? <Tag bordered={false} className="newfc-ai-meta">已停止生成</Tag> : null}
        {/* 回答范围摘要(§10.1):发送后由后端给出权威口径,用户问题覆盖页面范围时附覆盖说明。
            历史会话直接读当时响应里的 contextSummary,不按当前页面重新解释。 */}
        {response?.contextSummary ? (
          <Space size={4} wrap style={{ marginBottom: 6 }} data-testid="assistant-context-summary">
            <Tooltip title={response.contextTrace?.overrides?.length
              ? response.contextTrace.overrides.map((o) => o.reason).join('；')
              : '本轮回答采用的业务范围'}>
              <Tag
                bordered={false} className="newfc-ai-meta"
                color={response.contextStatus === 'explicit_override' ? 'gold' : 'green'}
              >
                {response.contextStatus === 'explicit_override' ? '范围已被问题覆盖' : response.contextStatus === 'aligned' ? '已对齐' : '回答范围'} · {response.contextSummary}
              </Tag>
            </Tooltip>
            {response.draftApplied ? (
              <Tooltip title={`助手在本轮分析中纳入了页面未保存修改的影响；草稿不写入库。基线：${response.draftApplied.baseline}`}>
                <Tag bordered={false} className="newfc-ai-meta" color="orange">
                  含草稿 · {response.draftApplied.changeCount} 项修改{response.draftApplied.issueCount > 0 ? ` · ${response.draftApplied.issueCount} 项校验问题` : ''}
                </Tag>
              </Tooltip>
            ) : null}
          </Space>
        ) : null}
        {response?.numberCheck?.status === 'ok' ? (
          <Tooltip title={response.numberCheck.note}>
            <Tag bordered={false} className="newfc-ai-meta" color="green" data-testid="assistant-number-check">数值已核对 {response.numberCheck.checked} 处</Tag>
          </Tooltip>
        ) : null}

        {/* ── 附带信息三层:建议(展开) → 引用与依据(折叠,含黄色警告) → 耗时(右对齐灰字) ── */}
        {/* 第一层:建议 chips —— 可点击的追问引导,默认展开 */}
        {response?.suggestions?.length ? (
          <Space size={[6, 6]} wrap className="newfc-ai-suggestions">
            <span className="newfc-ai-scope-key newfc-ai-scope-key-accent">建议</span>
            {response.suggestions.map((suggestion) => (
              <Button key={suggestion} size="small" shape="round" onClick={() => onSuggestion(suggestion)}>{suggestion}</Button>
            ))}
          </Space>
        ) : null}
        {/* 写操作意图:预览入口是唯一会改数据的按钮,保持常显 */}
        {response?.action && (
          <Space size={6} wrap className="newfc-ai-action-row">
            <span className="newfc-ai-scope-key newfc-ai-scope-key-accent">操作</span>
            <Typography.Text style={{ fontSize: 12 }}>识别到 {response.action.type} 意图</Typography.Text>
            {response.action.inherited ? (
              <Tooltip title="本轮没有重述写请求，助手沿用了上一轮的参数建议，并已重新校验可用性">
                <Tag bordered={false} className="newfc-ai-meta" color="cyan">沿用上一轮</Tag>
              </Tooltip>
            ) : null}
            <Tooltip title={response.action.source === 'model'
              ? '参数由模型从你的原话抽取，已通过后端校验'
              : '模型未参与，参数由关键词规则推断'}>
              <Tag bordered={false} className="newfc-ai-meta" color={response.action.source === 'model' ? 'blue' : undefined}>
                {response.action.source === 'model' ? '模型抽参' : '规则推断'}
              </Tag>
            </Tooltip>
            {response.action.reason && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{response.action.reason}</Typography.Text>
            )}
            {response.action.previewable ? (
              <Button size="small" type="primary" ghost onClick={() => onCreatePreview(response.action!)}>创建预览</Button>
            ) : (
              <Tooltip title={response.action.validationMessage || '参数不完整'}>
                <Space size={4}>
                  <Tag bordered={false} className="newfc-ai-meta" color="red">参数不完整</Tag>
                  <Button size="small" onClick={onOpenNewAction}>手动补全参数</Button>
                </Space>
              </Tooltip>
            )}
          </Space>
        )}
        {/* 导航建议:单行常显 */}
        {response?.navigation && (
          <Space size={6} wrap className="newfc-ai-action-row">
            <span className="newfc-ai-scope-key">导航</span>
            <Button size="small" type="link" onClick={() => onNavigate(response.navigation!.path)}>
              打开「{response.navigation.label}」（{response.navigation.path}）
            </Button>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{response.navigation.reason}</Typography.Text>
          </Space>
        )}
        {/* 第二层:引用与依据 —— 黄色警告(降级/提示/数值核对)/口径/引用/事实默认收起,
            一行摘要(含警示计数)点开看全部;小窗用同一套组件 */}
        {response ? (
          <EvidenceFold turn={turn} onAdoptContext={onAdoptContext} testId="assistant-evidence-toggle" />
        ) : null}
        {/* 第三层:耗时/模型次数 —— 12px 灰字,右对齐放消息末尾 */}
        {response?.metrics ? (
          <div className="newfc-ai-turn-metrics-row">
            <Tooltip title={metricsHint(response.metrics)}>
              <span className="newfc-ai-turn-metrics">
                {(response.metrics.durationMs / 1000).toFixed(1)}s
                {response.metrics.modelCalls > 0 ? ` · 模型 ${response.metrics.modelCalls} 次` : ' · 未调用模型'}
              </span>
            </Tooltip>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 助手筛选器的初始值与聊天核心都在 AssistantProvider 里（与全局抽屉共用），
 * 本页只订阅它。
 */
export default function Assistant() {
  /** 预览结果合并:幂等命中不再回确认令牌(防可预测幂等键枚举令牌),
   *  本地已有同一 action 的令牌时保留,避免双击重试后令牌丢失无法确认。 */
  const mergeAction = (prev: AssistantAction[], action: AssistantAction): AssistantAction[] => {
    const existing = prev.find((row) => row.id === action.id);
    const merged = action.confirmationToken == null && existing?.confirmationToken != null
      ? { ...action, confirmationToken: existing.confirmationToken }
      : action;
    return [merged, ...prev.filter((row) => row.id !== action.id)];
  };
  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  /* 口径选择器有固定像素宽度(280/240),手机上比卡片可用宽度还宽,Space 的 wrap 也救不了单个超宽项 */
  const narrowScreen = screens.md === false;
  /* 侧栏只在 lg 以上常驻:更窄的屏幕改成上下堆叠,拖拽手柄一并隐藏 */
  const stacked = screens.lg === false;
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const {
    turns, conversationId, sending, send, stopGenerating, openConversation, startNewConversation,
    useStream, setUseStream, manualContext, patchManualContext, adoptResolvedContext, merged,
    versions, batches, conversations, insights, refetchConversations, refetchInsights, routeInfo,
  } = useAssistant();
  /** 本页发送用的上下文：/assistant 没有路由推导值，因此与手动筛选等价 */
  const context = merged.context;

  /**
   * /assistant 页把自身筛选器登记为页面 scope(§6)：
   * 它不读取其他页面的残留筛选，筛选状态即本页的真实取数口径。
   */
  useAssistantPageContext({
    pageKey: 'assistant',
    ready: true,
    scope: {
      year: manualContext.year,
      budgetVersionId: manualContext.budgetVersionId,
      targetVersionId: manualContext.targetVersionId,
      actualSnapshotId: manualContext.actualSnapshotId,
      orgScopeId: manualContext.orgId,
      accountScopeId: manualContext.accountId,
    },
    view: {},
  });
  const [draft, setDraft] = useState('');
  const [actions, setActions] = useState<AssistantAction[]>([]);
  const [actionModalOpen, setActionModalOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [attributionOpen, setAttributionOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [importHelpOpen, setImportHelpOpen] = useState(false);
  const [insightOpen, setInsightOpen] = useState(false);
  const [insightKind, setInsightKind] = useState<InsightKind>('execution');
  const [insightTitle, setInsightTitle] = useState('');
  const [insightDetailId, setInsightDetailId] = useState<number | null>(null);
  const [historyDrawerOpen, setHistoryDrawerOpen] = useState(false);
  const [searchHistory, setSearchHistory] = useState('');
  /** 口径筛选器默认折叠:问题里明确说的范围优先于它,全不提时后端也有兜底,多数对话用不到 */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<TextAreaRef>(null);
  /** 正在创建预览的幂等键：拦住同一份参数的并发重复提交 */
  const previewInFlightRef = useRef<Set<string>>(new Set());
  const [renameTarget, setRenameTarget] = useState<{ id: number; title: string } | null>(null);
  const filteredConversations = useMemo(() => {
    if (!searchHistory.trim()) return conversations;
    const q = searchHistory.trim().toLowerCase();
    return conversations.filter((c) => (c.title || `会话 #${c.id}`).toLowerCase().includes(q));
  }, [conversations, searchHistory]);

  useEffect(() => { if (turns.length) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [turns]);

  /**
   * 侧栏带过来的跳转意图 / 全局自定义事件联动:
   * - openConversationId:直接加载该会话;
   * - expandConversations:打开历史会话抽屉;
   * - newConversation:开启新会话。
   * 消费后立刻清空 state,避免刷新/返回时重复触发。
   */
  useEffect(() => {
    const state = location.state as {
      openConversationId?: number;
      expandConversations?: boolean;
      newConversation?: boolean;
    } | null;
    if (!state) return;
    if (state.newConversation) {
      newConversation();
    }
    if (state.expandConversations) {
      setHistoryDrawerOpen(true);
    }
    if (state.openConversationId != null) {
      setActions([]);
      void openConversation(state.openConversationId);
    }
    navigate(location.pathname, { replace: true, state: null });
  }, [location.state, openConversation, navigate, location.pathname]);

  useEffect(() => {
    const onNew = () => newConversation();
    const onOpenHistory = () => setHistoryDrawerOpen(true);
    const onOpenConv = (e: Event) => {
      const convId = (e as CustomEvent<{ conversationId?: number }>).detail?.conversationId;
      if (convId != null) switchConversation(convId);
    };
    window.addEventListener('newfc:new-assistant-conversation', onNew);
    window.addEventListener('newfc:open-assistant-history', onOpenHistory);
    window.addEventListener('newfc:open-assistant-conversation', onOpenConv as EventListener);
    return () => {
      window.removeEventListener('newfc:new-assistant-conversation', onNew);
      window.removeEventListener('newfc:open-assistant-history', onOpenHistory);
      window.removeEventListener('newfc:open-assistant-conversation', onOpenConv as EventListener);
    };
  }, []);

  const { data: glossary } = useQuery({
    queryKey: ['assistant-glossary'],
    queryFn: () => assistantApi.glossary(''),
    enabled: glossaryOpen,
  });
  const { data: insightDetail } = useQuery({
    queryKey: ['assistant-insight', insightDetailId],
    queryFn: () => assistantApi.insight(insightDetailId as number),
    enabled: insightDetailId != null,
  });

  const yearOptions = useMemo(() => {
    const current = new Date().getFullYear();
    const years = new Set<number>([current, current - 1, current + 1, ...versions.map((v) => v.year)]);
    if (manualContext.year != null) years.add(manualContext.year);
    return [...years].sort((a, b) => b - a).map((year) => ({ value: year, label: `${year} 年` }));
  }, [versions, manualContext.year]);

  const versionOptions = useMemo(() => versions
    .filter((v) => manualContext.year == null || v.year === manualContext.year)
    .map((v) => ({ value: v.id, label: `#${v.id} ${v.name}（${v.kind === 'forecast' ? '预测' : '预算'}/${v.status}${v.is_current ? '/当前生效' : ''}）` })), [versions, manualContext.year]);

  const batchOptions = useMemo(() => batches
    .map((b) => ({ value: b.id, label: `#${b.id} ${b.snapshot_date} rev${b.revision}（${b.status}）` })), [batches]);

  const patchContext = patchManualContext;

  /**
   * 会话切换的本页收尾：操作预览卡属于「当前这轮对话」的临时产物，
   * 切会话/新会话时必须一起清掉，否则新会话下面挂着上一个会话的预览。
   */
  const newConversation = () => { startNewConversation(); setActions([]); };
  const switchConversation = (id: number) => { setActions([]); void openConversation(id); };

  /** 从输入框发送：草稿是本页状态(抽屉有自己的草稿)，先清再交给全局 send。 */
  const submitDraft = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setDraft('');
    void send(trimmed);
    /* 能力卡/推荐问题点完就整块卸载,把焦点收回输入框,方便直接继续追问 */
    inputRef.current?.focus();
  };

  const renameConversation = async (id: number, title: string) => {
    try {
      await assistantApi.renameConversation(id, title);
      message.success('会话已重命名');
      setRenameTarget(null);
      refetchConversations();
    } catch (err) {
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '重命名失败');
    }
  };

  const deleteConversation = async (id: number) => {
    try {
      const result = await assistantApi.deleteConversation(id);
      message.success(`会话已删除（${result.messageCount} 条消息）；已保存的洞察与已确认操作保留`);
      if (id === conversationId) newConversation();
      refetchConversations();
    } catch (err) {
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '删除失败');
    }
  };

  const deleteInsight = async (id: number) => {
    try {
      await assistantApi.deleteInsight(id);
      message.success('洞察已删除');
      if (insightDetailId === id) setInsightDetailId(null);
      refetchInsights();
      void queryClient.invalidateQueries({ queryKey: ['assistant-insights'] });
    } catch (err) {
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '删除失败');
    }
  };

  const createPreviewFromAction = async (action: { type: string; params: Record<string, unknown> }) => {
    // 幂等键按参数派生(不再含时间戳)，并拦住同一份参数的并发重复点击：
    // 否则连点两次会生成两条 pending 预览和两个确认令牌。
    const idempotencyKey = previewIdempotencyKey('chat', action.type, action.params, conversationId);
    if (previewInFlightRef.current.has(idempotencyKey)) return;
    previewInFlightRef.current.add(idempotencyKey);
    try {
      const created = await assistantApi.preview({ type: action.type, params: action.params, conversationId, idempotencyKey });
      setActions((prev) => mergeAction(prev, created));
      if (created.status === 'pending') message.success('预览已创建，确认后才会写入数据');
      else message.info(`该操作已存在（#${created.id}，${created.status}），未重复创建`);
    } catch (err) {
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '创建预览失败');
    } finally {
      previewInFlightRef.current.delete(idempotencyKey);
    }
  };

  /** 建议点击:能直接对应到确定性入口的就打开抽屉,其余回填到输入框 */
  const applySuggestion = (suggestion: string) => {
    if (suggestion.includes('归因')) { setAttributionOpen(true); return; }
    if (suggestion.includes('月报') || suggestion.includes('复盘')) { setReportOpen(true); return; }
    if (suggestion.includes('导入错误') || suggestion.includes('未匹配')) { setImportHelpOpen(true); return; }
    if (suggestion.includes('洞察')) { setInsightOpen(true); return; }
    setDraft(suggestion);
  };

  /** 抽屉直接保存洞察:数字仍由后端按参数重新计算 */
  const saveInsightDirect = async (kind: InsightKind, params: Record<string, unknown>, title: string) => {
    try {
      const saved = await assistantApi.saveInsight({ conversationId, kind, params, title: title.slice(0, 200) });
      message.success(`洞察已保存 #${saved.id}，数字由后端重新计算并附引用`);
      void refetchInsights();
      void queryClient.invalidateQueries({ queryKey: ['assistant-insights'] });
    } catch (err) {
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '保存洞察失败');
    }
  };

  const saveInsight = async () => {
    const config = INSIGHT_KINDS.find((row) => row.value === insightKind)!;
    const params: Record<string, unknown> = {};
    if (config.needs === 'version' && context.budgetVersionId == null) { message.error('请先在上下文中选择预算版本'); return; }
    if (config.needs === 'year' && context.year == null) { message.error('请先在上下文中选择年度'); return; }
    if (config.needs === 'compare' && (context.budgetVersionId == null || context.targetVersionId == null)) { message.error('版本对比需要同时选择预算版本与对比版本'); return; }
    if (config.needs === 'version') {
      params.versionId = context.budgetVersionId;
      if (context.actualSnapshotId != null) params.batchId = context.actualSnapshotId;
      if (context.orgId != null) params.orgScopeId = context.orgId;
      if (context.accountId != null) params.accountScopeId = context.accountId;
    }
    if (config.needs === 'year') params.year = context.year;
    if (config.needs === 'compare') { params.baseVersionId = context.budgetVersionId; params.targetVersionId = context.targetVersionId; }
    try {
      const saved = await assistantApi.saveInsight({
        conversationId, kind: insightKind, params,
        title: insightTitle.trim() || `${config.label}（${new Date().toLocaleString('zh-CN')}）`,
      });
      message.success(`洞察已保存 #${saved.id}，数字由后端重新计算并附引用`);
      setInsightOpen(false);
      setInsightTitle('');
      void refetchInsights();
      void queryClient.invalidateQueries({ queryKey: ['assistant-insights'] });
    } catch (err) {
      message.error(err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '保存洞察失败');
    }
  };

  /**
   * 工具行:默认折叠的口径筛选器 + 流式开关。
   * 四个筛选器只是兜底口径——问题里明确提到的年度/版本/快照优先于这里的选择,
   * 全不提时后端按「当前年度 · 当前生效版本 · 当前累计」取数,所以默认收成一行摘要;
   * 归因/报告/洞察这些没有问句可解析的抽屉才需要展开来选。
   * 展开后选择器顺序不能动 —— E2E 用「第一个 combobox」取年度、「第一个 switch」取流式。
   */
  const versionNameById = (id: number | undefined) =>
    (id != null ? versions.find((v) => v.id === id)?.name : undefined);
  const batchNameById = (id: number | undefined) => {
    const row = id != null ? batches.find((b) => b.id === id) : undefined;
    return row ? `${row.snapshot_date} rev${row.revision}` : undefined;
  };
  const scopeSummary = [
    manualContext.year != null ? `${manualContext.year} 年` : null,
    versionNameById(manualContext.budgetVersionId),
    manualContext.targetVersionId != null ? `对比 ${versionNameById(manualContext.targetVersionId) ?? `#${manualContext.targetVersionId}`}` : null,
    batchNameById(manualContext.actualSnapshotId),
  ].filter(Boolean).join(' · ');

  const toolbar = (
    <div className="newfc-ai-toolbar">
      {filtersOpen ? (
        <Space size={8} wrap className="newfc-ai-toolbar-filters">
          <Select
            aria-label="默认年度"
            style={{ width: narrowScreen ? 104 : 120 }} placeholder="年度" allowClear value={manualContext.year}
            onChange={(value) => patchContext({ year: value ?? undefined, budgetVersionId: undefined, targetVersionId: undefined, actualSnapshotId: undefined })}
            options={yearOptions}
          />
          <Select
            aria-label="默认预算版本"
            style={{ width: narrowScreen ? 200 : 240 }} placeholder="预算/预测版本" allowClear showSearch optionFilterProp="label"
            value={manualContext.budgetVersionId} onChange={(value) => patchContext({ budgetVersionId: value ?? undefined })}
            options={versionOptions}
          />
          <Select
            aria-label="默认对比版本"
            style={{ width: narrowScreen ? 200 : 220 }} placeholder="对比版本" allowClear showSearch optionFilterProp="label"
            value={manualContext.targetVersionId} onChange={(value) => patchContext({ targetVersionId: value ?? undefined })}
            options={versionOptions}
          />
          <Select
            aria-label="默认实际快照"
            style={{ width: narrowScreen ? 200 : 220 }} placeholder="实际快照(默认当前累计)" allowClear
            value={manualContext.actualSnapshotId} onChange={(value) => patchContext({ actualSnapshotId: value ?? undefined })}
            options={batchOptions}
          />
          <Button size="small" type="text" icon={<i className="ri-arrow-up-s-line" aria-hidden />} data-testid="assistant-filters-collapse" onClick={() => setFiltersOpen(false)}>
            收起
          </Button>
        </Space>
      ) : (
        <Tooltip title="可不选：问题里明确提到的年度/版本/快照优先；都不提时按当前年度、当前生效版本、当前累计取数。差异归因、报告生成等抽屉使用这里的选择">
          <button type="button" className="newfc-ai-toolbar-summary" data-testid="assistant-filters-toggle" onClick={() => setFiltersOpen(true)}>
            <i className="ri-filter-3-line" aria-hidden />
            <span>默认口径：{scopeSummary || '按提问内容自动判断'}</span>
            <i className="ri-arrow-down-s-line" aria-hidden />
          </button>
        </Tooltip>
      )}
      <Space size={10} wrap className="newfc-ai-toolbar-side">
        <Tooltip title="流式输出使用 SSE;关闭后改为一次性返回">
          <Space size={4}>
            <Switch size="small" checked={useStream} onChange={setUseStream} />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>流式</Typography.Text>
          </Space>
        </Tooltip>
      </Space>
    </div>
  );

  const activeConversation = useMemo(() => {
    return conversations.find((c) => c.id === conversationId);
  }, [conversations, conversationId]);

  const historyDrawer = (
    <Drawer
      open={historyDrawerOpen}
      onClose={() => setHistoryDrawerOpen(false)}
      title={
        <Space>
          <i className="ri-history-line" style={{ color: 'var(--newfc-primary)' }} aria-hidden />
          <span>全部历史会话 ({conversations.length})</span>
        </Space>
      }
      width={400}
      extra={
        <Button
          size="small"
          type="primary"
          icon={<i className="ri-add-line" aria-hidden />}
          onClick={() => {
            newConversation();
            setHistoryDrawerOpen(false);
          }}
        >
          新建对话
        </Button>
      }
    >
      <div style={{ marginBottom: 12 }}>
        <Input.Search
          allowClear
          placeholder="搜索历史会话..."
          value={searchHistory}
          onChange={(e) => setSearchHistory(e.target.value)}
        />
      </div>
      <List
        size="small"
        dataSource={filteredConversations}
        locale={{ emptyText: <FinanceEmpty kind="chat" description="暂无历史会话" /> }}
        renderItem={(item) => (
          <List.Item
            className={`newfc-ai-list-row${item.id === conversationId ? ' newfc-ai-list-row-active' : ''}`}
            style={{
              background: item.id === conversationId ? token.colorPrimaryBg : undefined,
              borderRadius: 6,
              marginBottom: 4,
              cursor: 'pointer',
              padding: '8px 12px',
            }}
            onClick={() => {
              switchConversation(item.id);
              setHistoryDrawerOpen(false);
            }}
            role="button"
            tabIndex={0}
            extra={
              <Space size={0} className="newfc-ai-list-actions" onClick={(e) => e.stopPropagation()}>
                <Tooltip title="重命名">
                  <Button
                    type="text"
                    size="small"
                    icon={<i className="ri-edit-line" aria-hidden />}
                    aria-label="重命名会话"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameTarget({ id: item.id, title: item.title || '' });
                    }}
                  />
                </Tooltip>
                <Popconfirm
                  title="删除该会话？"
                  description="消息会一起删除；已保存的洞察和已确认的操作保留。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={(e) => {
                    e?.stopPropagation();
                    void deleteConversation(item.id);
                  }}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<i className="ri-delete-bin-line" aria-hidden />}
                    aria-label="删除会话"
                    onClick={(e) => e.stopPropagation()}
                  />
                </Popconfirm>
              </Space>
            }
          >
            <List.Item.Meta
              title={
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {item.id === conversationId && (
                    <Tag color="blue" bordered={false} style={{ margin: 0, fontSize: 11, lineHeight: '18px', padding: '0 4px' }}>
                      当前
                    </Tag>
                  )}
                  <Typography.Text ellipsis style={{ fontSize: 13, fontWeight: item.id === conversationId ? 600 : 400 }}>
                    {item.title || `会话 #${item.id}`}
                  </Typography.Text>
                </div>
              }
              description={
                <Tooltip title={shortTime(item.updated_at)}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {relativeTime(item.updated_at)}
                  </Typography.Text>
                </Tooltip>
              }
            />
          </List.Item>
        )}
      />
    </Drawer>
  );

  return (
    <div className={`newfc-assistant-page${stacked ? ' newfc-assistant-page-stacked' : ''}`}>
      <div className="newfc-assistant-body">
        <div className="newfc-assistant-main">
          <Card
            size="small"
            className="newfc-assistant-chat-card"
            styles={{ body: { display: 'flex', flexDirection: 'column', flex: '1 1 auto', minHeight: 0, padding: '10px 16px 12px' } }}
            title={
              <Space size={8}>
                <AssistantMark size={22} />
                <Typography.Text type="secondary" style={{ fontSize: 13, fontWeight: 500, color: token.colorText }}>
                  {conversationId ? (activeConversation?.title || `会话 #${conversationId}`) : '新会话'}
                </Typography.Text>
                {conversationId != null && (
                  <Space size={2}>
                    <Tooltip title="重命名当前会话">
                      <Button
                        size="small"
                        type="text"
                        icon={<i className="ri-edit-line" aria-hidden />}
                        aria-label="重命名当前会话"
                        onClick={() => setRenameTarget({ id: conversationId, title: activeConversation?.title || '' })}
                      />
                    </Tooltip>
                    <Popconfirm
                      title="删除当前会话？"
                      description="消息会一起删除；已保存的洞察和已确认的操作保留。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => void deleteConversation(conversationId)}
                    >
                      <Tooltip title="删除当前会话">
                        <Button size="small" type="text" danger icon={<i className="ri-delete-bin-line" aria-hidden />} aria-label="删除当前会话" />
                      </Tooltip>
                    </Popconfirm>
                  </Space>
                )}
              </Space>
            }
            extra={(
              <Space size={4}>
                {/* 唯一会写数据的入口,给主按钮;其余工具收成图标键,头部不再五条文字按钮平铺 */}
                <Tooltip title="新建一个写操作(先预览再确认)">
                  <Button size="small" type="primary" icon={<i className="ri-flashlight-line" aria-hidden />} onClick={() => setActionModalOpen(true)}>
                    {narrowScreen ? null : '新建操作'}
                  </Button>
                </Tooltip>
                <span className="newfc-assistant-tools">
                  <Tooltip title="新建对话">
                    <Button size="small" type="text" icon={<i className="ri-add-line" aria-hidden />} aria-label="新建对话" onClick={newConversation} />
                  </Tooltip>
                  <Tooltip title="历史会话">
                    <Button size="small" type="text" icon={<i className="ri-history-line" aria-hidden />} aria-label="历史会话" onClick={() => setHistoryDrawerOpen(true)} />
                  </Tooltip>
                  <Tooltip title="差异归因(逐层展开)">
                    <Button size="small" type="text" icon={<i className="ri-node-tree" aria-hidden />} aria-label="差异归因" onClick={() => setAttributionOpen(true)} />
                  </Tooltip>
                  <Tooltip title="报告生成">
                    <Button size="small" type="text" icon={<i className="ri-file-text-line" aria-hidden />} aria-label="报告生成" onClick={() => setReportOpen(true)} />
                  </Tooltip>
                  <Tooltip title="保存分析洞察">
                    <Button size="small" type="text" icon={<i className="ri-save-3-line" aria-hidden />} aria-label="保存分析洞察" onClick={() => setInsightOpen(true)} />
                  </Tooltip>
                  <Tooltip title="导入辅助">
                    <Button size="small" type="text" icon={<i className="ri-import-line" aria-hidden />} aria-label="导入辅助" onClick={() => setImportHelpOpen(true)} />
                  </Tooltip>
                  <Tooltip title="业务口径">
                    <Button size="small" type="text" icon={<i className="ri-book-open-line" aria-hidden />} aria-label="业务口径" onClick={() => setGlossaryOpen(true)} />
                  </Tooltip>
                </span>
              </Space>
            )}
          >
            {/* 对话列收窄居中:文本列 760px,含表格/事实的回答块放宽到 960px(见 hasWideContent) */}
            <div className="newfc-assistant-col">{toolbar}</div>

            <div className="newfc-assistant-messages">
              {turns.length === 0 ? (
                <div className="newfc-assistant-col">
                  <WelcomePanel onPick={submitDraft} />
                </div>
              ) : (
                turns.map((turn) => (
                  <div key={turn.key} className={hasWideContent(turn) ? 'newfc-assistant-col newfc-assistant-col-wide' : 'newfc-assistant-col'}>
                    <TurnView
                      turn={turn}
                      currentPage={routeInfo.page}
                      onAdoptContext={adoptResolvedContext}
                      onNavigate={(path) => navigate(path)}
                      onSuggestion={applySuggestion}
                      onCreatePreview={(action) => void createPreviewFromAction(action)}
                      onOpenNewAction={() => setActionModalOpen(true)}
                    />
                  </div>
                ))
              )}
              <div ref={bottomRef} />
            </div>

            <div className="newfc-assistant-col">
              <div className="newfc-assistant-composer">
                <AssistantScopeBar />
                <Composer
                  value={draft}
                  onChange={setDraft}
                  onSubmit={() => submitDraft(draft)}
                  onStop={stopGenerating}
                  sending={sending}
                  placeholder="例如：当前合同金额与已付款是多少？财报的净利润和来源是什么？"
                  minRows={2}
                  maxRows={6}
                  hint="Enter 发送 · Shift+Enter 换行"
                  inputRef={inputRef}
                />
                <Disclaimer>数字来自后端事实，行文由 AI 生成；未确认的操作不会修改任何数据</Disclaimer>
              </div>
            </div>
          </Card>

          {actions.length > 0 && (
            <Card size="small" title={<Space><i className="ri-lightbulb-line" aria-hidden />待处理与已完成操作</Space>} style={{ marginTop: 12 }}>
              {actions.map((action) => (
                <ActionPreviewCard
                  key={action.id}
                  action={action}
                  onChanged={(next) => setActions((prev) => prev.map((row) => (row.id === next.id ? next : row)))}
                />
              ))}
            </Card>
          )}
        </div>
      </div>

      <NewActionModal
        open={actionModalOpen}
        onClose={() => setActionModalOpen(false)}
        context={context}
        conversationId={conversationId}
        onCreated={(action) => setActions((prev) => mergeAction(prev, action))}
      />

      <AttributionDrawer
        open={attributionOpen}
        onClose={() => setAttributionOpen(false)}
        context={context}
        onSaveInsight={(params) => void saveInsightDirect('attribution', params, `差异归因（${new Date().toLocaleString('zh-CN')}）`)}
      />

      <ReportDrawer
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        context={context}
        onSaveInsight={(params, title) => void saveInsightDirect('report', params, title)}
      />

      <ImportHelpDrawer
        open={importHelpOpen}
        onClose={() => setImportHelpOpen(false)}
        defaultBatchId={context.importBatchId}
      />

      {historyDrawer}

      <Drawer open={glossaryOpen} onClose={() => setGlossaryOpen(false)} width="min(560px, 94vw)" title="业务口径与字段解释">
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="以下口径由后端固化，模型不可用时助手也会给出同样的解释。" />
        {glossary?.catalog?.length ? (
          <List
            size="small"
            dataSource={glossary.catalog}
            renderItem={(item) => (
              <List.Item>
                <Space direction="vertical" size={0}>
                  <Space size={6}><Typography.Text strong>{item.term}</Typography.Text><Tag>{item.category}</Tag></Space>
                  <Typography.Link style={{ fontSize: 12 }} onClick={() => { setGlossaryOpen(false); void send(`解释 ${item.term}`); }}>让助手解释这一项</Typography.Link>
                </Space>
              </List.Item>
            )}
          />
        ) : <Spin />}
      </Drawer>

      <Modal
        open={insightOpen} onCancel={() => setInsightOpen(false)} onOk={() => void saveInsight()}
        okText="保存洞察" title="保存分析洞察"
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="洞察内容由后端按当前上下文重新计算并附结构化引用，不保存前端传入的数字。" />
        <Space direction="vertical" style={{ width: '100%' }}>
          <InsightKindPicker value={insightKind} onChange={setInsightKind} />
          <Input value={insightTitle} onChange={(event) => setInsightTitle(event.target.value)} placeholder="洞察标题(可留空自动生成)" maxLength={200} />
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="年度">{context.year ?? '未选择'}</Descriptions.Item>
            <Descriptions.Item label="预算版本">{context.budgetVersionId ?? '未选择'}</Descriptions.Item>
            <Descriptions.Item label="对比版本">{context.targetVersionId ?? '未选择'}</Descriptions.Item>
            <Descriptions.Item label="实际快照">{context.actualSnapshotId ?? '默认当前累计'}</Descriptions.Item>
          </Descriptions>
        </Space>
      </Modal>

      <Drawer
        open={insightDetailId != null} onClose={() => setInsightDetailId(null)} width="min(720px, 94vw)"
        title={insightDetail ? insightDetail.title : '洞察详情'}
        extra={(
          <Space>
            {insightDetailId != null && (
              <Popconfirm
                title="删除该洞察？" okText="删除" cancelText="取消" okButtonProps={{ danger: true }}
                onConfirm={() => void deleteInsight(insightDetailId)}
              >
                <Button size="small" danger icon={<i className="ri-delete-bin-line" aria-hidden />}>删除</Button>
              </Popconfirm>
            )}
            <Button size="small" onClick={() => setInsightDetailId(null)}>关闭</Button>
          </Space>
        )}
      >
        {!insightDetail ? <Spin /> : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="类型">{factLabel(`insight:${insightDetail.result?.kind}`)}</Descriptions.Item>
              <Descriptions.Item label="生成时间">{insightDetail.result?.generatedAt ?? insightDetail.created_at}</Descriptions.Item>
              <Descriptions.Item label="参数"><Typography.Text code style={{ fontSize: 12 }}>{JSON.stringify(insightDetail.result?.params ?? {})}</Typography.Text></Descriptions.Item>
            </Descriptions>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>引用来源</Typography.Text>
              <CitationList citations={insightDetail.citations ?? []} />
            </div>
            <FactsPanel facts={[{ type: `insight:${insightDetail.result?.kind}`, data: insightDetail.result?.summary, source: {} }]} />
          </Space>
        )}
      </Drawer>
      <Modal
        open={renameTarget != null}
        title="重命名会话"
        okText="保存"
        onCancel={() => setRenameTarget(null)}
        onOk={() => renameTarget && void renameConversation(renameTarget.id, renameTarget.title)}
      >
        <Input
          value={renameTarget?.title ?? ''}
          maxLength={200}
          placeholder="留空则显示为「会话 #编号」"
          onChange={(event) => setRenameTarget((prev) => (prev ? { ...prev, title: event.target.value } : prev))}
          onPressEnter={() => renameTarget && void renameConversation(renameTarget.id, renameTarget.title)}
        />
      </Modal>
    </div>
  );
}
