/**
 * 全局悬浮助手「小澧助手」:右下悬浮球 + 400×600 小窗。
 *
 * 形态参考火山在线咨询/火山方舟控制台助手:紫蓝渐变圆形入口常驻视口右下,
 * 点击后从按钮位置 morphing 展开为右下角锚定的浮层面板(250~300ms 缓出),
 * 关闭时反向收回;prefers-reduced-motion 时退化为简单淡入淡出。
 *
 * 与独立页 /assistant 的分工(方案《AI助手体验升级与界面格调提升方案》二.4):
 * - 小窗只做随手快问快答:Markdown 回答、路由/口径/数值核对标签、引用来源、建议、导航;
 * - 写操作(action)在这里**绝不创建预览**,只给「去完整页处理」;重功能同理;
 * - 会话状态来自 AssistantProvider,与独立页是同一份(含进行中的 SSE 流),
 *   小窗里发的消息切到完整页自动置顶(会话按最后活跃排序)。
 *
 * 空状态(无消息、输入框未聚焦)时输入框边框有一条旋转流光做引导,
 * 聚焦或发出首条消息后淡出——这是「禁止循环动画」约束的唯一破例,且仅引导态生效。
 *
 * 测试锚点统一用 assistant-dock- 前缀,避免 E2E 同时命中独立页的 assistant-answer 等。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, Grid, Space, Spin, Tag, Tooltip, Typography } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import { useAssistant, type ChatTurn } from '../../assistant/AssistantProvider';
import { PAGE_LABEL, PAGE_PROMPTS } from '../../assistant/pageContext';
import { isTurnOriginStale } from '../../assistant/scopeDisplay';
import { READ_INTENT_LABEL } from '../../assistant/labels';
import { Markdown } from './Markdown';
import { AssistantMark, Composer, Disclaimer, EvidenceFold, RecommendList, SectionLabel, SkillCards } from './AssistantPanelKit';
import { AssistantScopeBar } from './AssistantScopeBar';

/** 需要重界面(抽屉/弹窗/大表)的建议：小窗不做，改为引导到完整页。 */
function isHeavySuggestion(text: string): boolean {
  return ['归因', '月报', '复盘', '导入错误', '未匹配', '洞察'].some((keyword) => text.includes(keyword));
}

/** 一轮回答：只渲染该 turn 自身 response 里持久化的内容，路由切换后历史回答不重绘。 */
function DockTurn({ turn, currentPage, onOpenFullPage, onSuggestion, onNavigate }: {
  turn: ChatTurn;
  /** 当前页面 pageKey：回答发起页与当前页不同时标注「基于原页面范围」(UX-26) */
  currentPage: string;
  onOpenFullPage: () => void;
  onSuggestion: (text: string) => void;
  onNavigate: (path: string) => void;
}) {
  if (turn.role === 'user') {
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
        <div className="bd-ai-bubble-user">{turn.text}</div>
      </div>
    );
  }
  const response = turn.response;
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
      <AssistantMark size={22} />
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div className="bd-ai-bubble-ai">
          {/* 元信息行：路由方式与模型来源。压到 11px 无边框标签，别和正文抢注意力。 */}
          {(response?.routing || turn.model || response?.intents?.inheritedRead?.length) ? (
            <Space size={4} wrap style={{ marginBottom: 8 }}>
              {response?.routing && (
                <Tooltip title={response.routing === 'model'
                  ? '模型自主调用只读工具取数，数字仍来自后端'
                  : '模型不可用或未调用工具，已按关键词兜底路由到确定性查询'}>
                  <Tag bordered={false} className="bd-ai-meta" color={response.routing === 'model' ? 'blue' : undefined}>
                    {response.routing === 'model' ? '模型路由' : '关键词兜底'}
                  </Tag>
                </Tooltip>
              )}
              {turn.model && (
                <Tag bordered={false} className="bd-ai-meta">
                  {turn.model === 'template' ? (
                    <Tooltip title="模型不可用,已回退确定性模板;可在「系统 → AI 渠道设置」配置渠道">
                      <Link to="/settings/ai" style={{ color: 'inherit' }}>模板降级</Link>
                    </Tooltip>
                  ) : turn.model}
                </Tag>
              )}
              {response?.intents?.inheritedRead?.length ? (
                <Tag bordered={false} className="bd-ai-meta" color="cyan">
                  追问·沿用{response.intents.inheritedRead.map((intent) => READ_INTENT_LABEL[intent] ?? intent).join('、')}
                </Tag>
              ) : null}
              {isTurnOriginStale(turn.origin?.pageKey, currentPage) ? (
                <Tooltip title="这条回答的范围以发起时所在页面为准，与当前页面不同，不代表你正在看的对象">
                  <Tag bordered={false} className="bd-ai-meta" color="gold" data-testid="assistant-dock-turn-origin">
                    基于「{PAGE_LABEL[turn.origin!.pageKey] ?? turn.origin!.pageKey}」当时的范围
                  </Tag>
                </Tooltip>
              ) : null}
            </Space>
          ) : null}
          {/* 模型降级/后端提示(黄色警告)已与口径、引用一起收进「引用与依据」折叠条 */}
          {turn.pending && !turn.text ? (
            <Space size={8}>
              <Spin size="small" />
              <Typography.Text type="secondary" style={{ fontSize: 12 }} data-testid="assistant-dock-progress">
                {turn.progress ? `${turn.progress.label}${turn.progress.detail ? `（${turn.progress.detail}）` : ''}…` : '正在处理…'}
              </Typography.Text>
            </Space>
          ) : (
            <div data-testid="assistant-dock-answer" style={{ fontSize: 13 }}>
              <Markdown text={turn.text} />
            </div>
          )}
          {turn.pending && turn.text && turn.progress ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{turn.progress.label}…</Typography.Text>
          ) : null}
          {turn.stopped ? <Tag bordered={false} className="bd-ai-meta">已停止生成</Tag> : null}
          {/* 回答范围摘要(§10.1):历史会话直接读当时响应里的 contextSummary */}
          {response?.contextSummary ? (
            <div style={{ marginBottom: 6 }}>
              <Tooltip title={response.contextTrace?.overrides?.length
                ? response.contextTrace.overrides.map((o) => o.reason).join('；')
                : '本轮回答采用的业务范围'}>
                <Tag
                  bordered={false} className="bd-ai-meta"
                  color={response.contextStatus === 'explicit_override' ? 'gold' : 'green'}
                  data-testid="assistant-dock-context-summary"
                >
                  {response.contextStatus === 'explicit_override' ? '范围已被问题覆盖' : '回答范围'} · {response.contextSummary}
                </Tag>
              </Tooltip>
            </div>
          ) : null}
          {/* 数字核对通过时的绿色小标签常显;未通过的警告与降级/提示一起收进折叠条 */}
          {response?.numberCheck?.status === 'ok' ? (
            <Tooltip title={response.numberCheck.note}>
              <Tag bordered={false} className="bd-ai-meta" color="green" data-testid="assistant-dock-number-check">
                数值已核对 {response.numberCheck.checked} 处
              </Tag>
            </Tooltip>
          ) : null}
          {/* 引用与依据:黄色警告(降级/后端提示/数值核对未通过)/口径/引用收进折叠条,与完整页同一套组件。
              小窗不带「采用这些筛选」(筛选器在完整页工具行上),事实明细表也留在完整页。 */}
          <EvidenceFold turn={turn} testId="assistant-dock-evidence-toggle" hideFacts />
          {response?.navigation && (
            <div style={{ marginTop: 8 }}>
              <Button
                size="small" type="link" style={{ paddingInline: 0 }} icon={<i className="ri-arrow-right-line" aria-hidden />}
                data-testid="assistant-dock-navigate"
                onClick={() => onNavigate(response.navigation!.path)}
              >
                打开「{response.navigation.label}」
              </Button>
            </div>
          )}
          {/*
            识别到写操作：小窗**不创建预览**(不发 /assistant/preview)，
            逐行影响、确认令牌与倒计时都在完整页里核对，避免在窄面板上盲点确认。
          */}
          {response?.action && (
            <Alert
              type="info" showIcon style={{ marginTop: 8 }} data-testid="assistant-dock-action"
              message={`识别到「${response.action.type}」写操作意图`}
              description={
                <Space direction="vertical" size={4}>
                  <Typography.Text style={{ fontSize: 12 }}>写操作必须先预览逐行影响再确认，请到完整页处理。</Typography.Text>
                  <Button size="small" type="primary" ghost icon={<i className="ri-arrow-right-up-line" aria-hidden />} data-testid="assistant-dock-action-fullpage" onClick={onOpenFullPage}>
                    去完整页处理
                  </Button>
                </Space>
              }
            />
          )}
          {/* 事实表格、归因树这类重展示留在完整页 */}
          {response?.facts?.length ? (
            <Button size="small" type="link" style={{ paddingInline: 0 }} onClick={onOpenFullPage}>
              查看 {response.facts.length} 项结构化事实与明细表
            </Button>
          ) : null}
        </div>
        {/* 追问建议放在气泡外面，视觉上是「下一步」而不是回答的一部分 */}
        {response?.suggestions?.length ? (
          <Space size={[6, 6]} wrap style={{ marginTop: 8 }}>
            {response.suggestions.map((suggestion) => (
              <Button key={suggestion} size="small" shape="round" onClick={() => onSuggestion(suggestion)}>{suggestion}</Button>
            ))}
          </Space>
        ) : null}
      </div>
    </div>
  );
}

export function AssistantDock() {
  const {
    dockOpen, openDock, closeDock, turns, sending, send, stopGenerating, startNewConversation,
    conversationId, routeInfo,
  } = useAssistant();
  const navigate = useNavigate();
  const narrow = Grid.useBreakpoint().md === false;
  const [draft, setDraft] = useState('');
  /** 流光引导只放到第一次聚焦之前:见过一次就不再循环,避免每次空窗都闪 */
  const [glowOff, setGlowOff] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<TextAreaRef>(null);
  /**
   * 开合分两个状态:mounted 控制面板是否挂载,shown 控制开合类名。
   * 打开时先挂隐藏态、下一帧再切到展开态,morphing 动效才有起点;
   * 关闭时先切回隐藏态,等收回动效播完(320ms)再卸载。
   */
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (dockOpen) {
      setMounted(true);
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const timer = window.setTimeout(() => setMounted(false), 320);
    return () => window.clearTimeout(timer);
  }, [dockOpen]);

  /* Esc 关闭(原来是 rc-drawer 给的,自定义浮层自己挂);焦点还原由 Provider 的 closeDock 负责 */
  useEffect(() => {
    if (!dockOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      closeDock();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [dockOpen, closeDock]);

  /* 打开时把焦点放进输入框,键盘用户唤起后可以直接打字 */
  useEffect(() => {
    if (dockOpen) inputRef.current?.focus();
  }, [dockOpen]);

  useEffect(() => {
    if (dockOpen) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns, dockOpen]);

  const prompts = useMemo(() => (PAGE_PROMPTS[routeInfo.page] ?? PAGE_PROMPTS.assistant).slice(0, 4), [routeInfo.page]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setDraft('');
    setGlowOff(true);
    void send(trimmed);
    /**
     * 无论从哪条路径发出(输入框、能力卡、推荐问题、追问建议),都把焦点收回输入框。
     * 这些触发元素发完就被卸载或禁用,焦点会掉到 <body>。
     */
    inputRef.current?.focus();
  };

  /** 打开完整页：走 React Router 正常导航，编制/录入页的未保存拦截照常生效。 */
  const openFullPage = () => {
    closeDock();
    navigate('/assistant');
  };

  return (
    <>
      {/* 右下悬浮入口:全站常驻,z-index 低于 Drawer(1000) 高于内容 */}
      <Tooltip title={dockOpen ? '' : sending ? '小澧助手（正在生成回答）' : '小澧助手'} placement="left">
        <button
          type="button"
          className="bd-ai-fab"
          aria-label={dockOpen ? '收起小澧助手小窗' : '小澧助手'}
          aria-expanded={dockOpen}
          data-testid="assistant-dock-trigger"
          onClick={() => (dockOpen ? closeDock() : openDock())}
        >
          <i className={dockOpen ? 'ri-arrow-down-line' : 'ri-sparkling-2-fill'} aria-hidden />
        </button>
      </Tooltip>
      {mounted ? (
        <div
          className={`bd-assistant-dock bd-ai-float${shown ? '' : ' bd-ai-float-hidden'}${narrow ? ' bd-ai-float-narrow' : ''}`}
          role="dialog"
          aria-label="小澧助手"
        >
          <div className="bd-ai-float-head">
            <AssistantMark size={24} />
            <span className="bd-ai-float-title">小澧助手</span>
            <span className="bd-ai-float-conv">
              {conversationId ? `会话 #${conversationId}` : '新会话'}
            </span>
            <span style={{ flex: '1 1 auto' }} />
            <Tooltip title="新会话">
              <Button size="small" type="text" icon={<i className="ri-add-line" aria-hidden />} aria-label="新会话" data-testid="assistant-dock-new" onClick={startNewConversation} />
            </Tooltip>
            <button type="button" className="bd-ai-float-fullpage" data-testid="assistant-dock-fullpage" onClick={openFullPage}>
              进入完整助手 <i className="ri-arrow-right-line" aria-hidden />
            </button>
            <Tooltip title="关闭">
              <Button size="small" type="text" icon={<i className="ri-close-line" aria-hidden />} aria-label="关闭助手" onClick={closeDock} />
            </Tooltip>
          </div>
          <div className="bd-ai-float-body">
            <AssistantScopeBar />
            <div className="bd-ai-float-scroll">
              {turns.length === 0 ? (
                <div style={{ paddingTop: 8 }}>
                  <SectionLabel>我能帮你做</SectionLabel>
                  <SkillCards page={routeInfo.page} onPick={(item) => submit(item.prompt)} />
                  <div style={{ marginTop: 24 }}>
                    <SectionLabel>你是否想问</SectionLabel>
                    <RecommendList prompts={prompts} onPick={submit} />
                  </div>
                </div>
              ) : (
                turns.map((turn) => (
                  <DockTurn
                    key={turn.key}
                    turn={turn}
                    currentPage={routeInfo.page}
                    onOpenFullPage={openFullPage}
                    onNavigate={(path) => navigate(path)}
                    onSuggestion={(suggestion) => (isHeavySuggestion(suggestion) ? openFullPage() : submit(suggestion))}
                  />
                ))
              )}
              <div ref={bottomRef} />
            </div>
          </div>
          <div className="bd-ai-float-foot">
            <div
              className={`bd-ai-glow-wrap${turns.length === 0 && !glowOff ? ' bd-ai-glow-active' : ''}`}
              onFocusCapture={() => setGlowOff(true)}
            >
              <Composer
                value={draft}
                onChange={setDraft}
                onSubmit={() => submit(draft)}
                onStop={stopGenerating}
                sending={sending}
                placeholder={`就着「${routeInfo.label}」提问，例如：${prompts[0]}`}
                minRows={2}
                maxRows={4}
                hint="Enter 发送 · Shift+Enter 换行"
                inputRef={inputRef}
                inputTestId="assistant-dock-input"
                sendTestId="assistant-dock-send"
                stopTestId="assistant-dock-stop"
              />
            </div>
            <Disclaimer>数字来自后端事实，行文由 AI 生成；写操作一律到完整页预览确认</Disclaimer>
          </div>
        </div>
      ) : null}
    </>
  );
}
