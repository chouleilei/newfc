/**
 * 助手面板的视觉零件,抽屉(AssistantDock)与完整页(pages/Assistant)共用一套。
 *
 * 视觉语言参考火山方舟控制台的助手面板:
 * - 能力卡「我能帮您做」:AI 生成型能力用紫调渐变卡,确定性查询用灰底卡;
 * - 推荐问题「您是否想问」:一个描边容器里若干行,行尾 chevron,悬停整行变主色;
 * - 输入器:文本域与工具条包在同一个圆角框里,发送键是圆形图标键(不是一整块蓝按钮)。
 *
 * 样式都落在 index.css 的 .newfc-ai-* 类里,这里只组装结构与无障碍属性。
 */
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Alert, Button, Input, Space, Tag, Tooltip, Typography } from 'antd';
import type { TextAreaRef } from 'antd/es/input/TextArea';
import type { AssistantChatResponse } from '../../api/assistant';
import type { ChatTurn } from '../../assistant/AssistantProvider';
import { RESOLUTION_FIELD_LABEL, RESOLUTION_ORIGIN_LABEL } from '../../assistant/labels';
import { CitationList, FactsPanel } from './FactsPanel';
import { pageSkills, type PageSkill, type SkillIcon } from '../../assistant/pageContext';

/* 全站图标统一为 Remix Icon(方案《AI助手体验升级与界面格调提升方案》四.3) */
const SKILL_ICON: Record<SkillIcon, ReactNode> = {
  insight: <i className="ri-lightbulb-line" aria-hidden />,
  alert: <i className="ri-alarm-warning-line" aria-hidden />,
  diff: <i className="ri-node-tree" aria-hidden />,
  quality: <i className="ri-shield-check-line" aria-hidden />,
  trend: <i className="ri-line-chart-line" aria-hidden />,
  import: <i className="ri-import-line" aria-hidden />,
  glossary: <i className="ri-book-2-line" aria-hidden />,
  search: <i className="ri-search-line" aria-hidden />,
};

/** 助手标识:品牌渐变圆角方块 + 闪电,全站只在 AI 语境出现 */
export function AssistantMark({ size = 24 }: { size?: number }) {
  return (
    <span
     aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
        width: size,
        height: size,
        borderRadius: Math.round(size / 3),
        color: '#fff',
        fontSize: Math.round(size * 0.56),
        background: 'linear-gradient(135deg, var(--newfc-ai-primary), var(--newfc-ai-primary-deep))',
      }}
    >
      <i className="ri-flashlight-line" aria-hidden />
    </span>
  );
}

/** 分区小标题:「我能帮您做」「您是否想问」 */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="newfc-ai-section-label">{children}</p>;
}

/**
 * 能力卡组。
 *
 * 两种用法:
 * - 不传 items:按当前页面取该页的能力卡(抽屉用);
 * - 传 items:调用方自带条目(完整页欢迎区用四张)。
 *
 * columns=1 时第一条渲染成主推卡(紫调渐变),多列网格时不再有主推位——
 * 网格里每张卡面积相同,给其中一张上渐变会破坏网格的均衡感。
 */
export function SkillCards({ page, items, columns = 1, onPick }: {
  page?: string;
  items?: PageSkill[];
  columns?: 1 | 2;
  onPick: (skill: PageSkill) => void;
}) {
  const list = items ?? pageSkills(page ?? 'assistant');
  if (columns === 2) {
    return (
      <div className="newfc-ai-skill-grid">
        {list.map((item, index) => (
          <button
            key={item.key}
            type="button"
            className="newfc-ai-skill newfc-ai-skill-grid-item newfc-ghost-host"
            data-testid={`assistant-skill-${item.key}`}
            onClick={() => onPick(item)}
          >
            {/* 2×2 网格卡的角落幽灵编号(小号 40px,右上角),给网格一点编辑感 */}
            <span className="newfc-ghost-num newfc-ghost-num-sm" aria-hidden>{index + 1}</span>
            <span className="newfc-ai-skill-icon">{SKILL_ICON[item.icon]}</span>
            <span style={{ minWidth: 0 }}>
              <span className="newfc-ai-skill-title" style={{ display: 'block' }}>{item.title}</span>
              <span className="newfc-ai-skill-desc" style={{ display: 'block' }}>{item.desc}</span>
            </span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {list.map((item, index) => (
        <button
          key={item.key}
          type="button"
          className={`newfc-ai-skill${index === 0 ? ' newfc-ai-skill-primary' : ''}`}
          data-testid={`assistant-skill-${item.key}`}
          onClick={() => onPick(item)}
        >
          <span className="newfc-ai-skill-icon">{SKILL_ICON[item.icon]}</span>
          <span style={{ minWidth: 0 }}>
            <span className="newfc-ai-skill-title" style={{ display: 'block' }}>{item.title}</span>
            <span className="newfc-ai-skill-desc" style={{ display: 'block' }}>{item.desc}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * 推荐问题列表:整行可点,单行省略(窄面板换行会把容器撑成阶梯状)。
 * columns=2 是完整页欢迎区的两列排布——那里横向空间充裕,一行一条会拖得太长。
 */
export function RecommendList({ prompts, columns = 1, onPick }: {
  prompts: string[];
  columns?: 1 | 2;
  onPick: (prompt: string) => void;
}) {
  return (
    <div className={columns === 2 ? 'newfc-ai-recommend newfc-ai-recommend-two' : 'newfc-ai-recommend'}>
      {prompts.map((prompt) => (
        <button
          key={prompt}
          type="button"
          className="newfc-ai-recommend-row"
          title={prompt}
          onClick={() => onPick(prompt)}
        >
          <span>{prompt}</span>
          <i className="ri-arrow-right-line" aria-hidden />
        </button>
      ))}
    </div>
  );
}

interface ComposerProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  sending: boolean;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
  /** 工具条左侧的说明或筛选芯片 */
  hint?: ReactNode;
  /**
   * 由父级持有的输入框引用。空状态里的能力卡/推荐问题点完就整块卸载,
   * 焦点会掉到 <body>;父级拿到这个 ref 才能在任意发送路径后把焦点收回面板内。
   */
  inputRef?: RefObject<TextAreaRef>;
  inputTestId?: string;
  sendTestId?: string;
  stopTestId?: string;
}

/**
 * 一体化输入器。
 *
 * 发送/停止键是**图标键**,无障碍名分别固定为「发送」「停止生成」:
 * E2E 用 getByRole('button', { name: '发送' }) 定位它,aria-label 必须保住这个名字。
 */
export function Composer({
  value, onChange, onSubmit, onStop, sending,
  placeholder, minRows = 2, maxRows = 5, hint,
  inputRef, inputTestId, sendTestId, stopTestId,
}: ComposerProps) {
  const ownRef = useRef<TextAreaRef>(null);
  const ref = inputRef ?? ownRef;
  const empty = value.trim().length === 0;

  /**
   * 发送后把焦点交回输入框。除了「连续追问不用再点一次输入框」这个便利,
   * 它还修掉一个真实缺陷:发送会清空草稿,发送键随之变成 disabled,
   * 浏览器会把焦点从这个被禁用的按钮甩回 <body>;而抽屉的 Esc 关闭是
   * rc-drawer 挂在**面板元素**上的 keydown,焦点一旦离开面板,Esc 就失效了。
   */
  const fire = () => {
    onSubmit();
    ref.current?.focus();
  };

  return (
    <div className="newfc-ai-composer">
      <Input.TextArea
        ref={ref}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoSize={{ minRows, maxRows }}
        variant="borderless"
        data-testid={inputTestId}
        onPressEnter={(event) => {
          if (event.shiftKey) return;
          event.preventDefault();
          fire();
        }}
      />
      <div className="newfc-ai-composer-toolbar">
        <span style={{ minWidth: 0, fontSize: 12, color: 'var(--newfc-text-tertiary)' }}>{hint}</span>
        {sending ? (
          <Tooltip title="停止生成">
            <button
              type="button"
              className="newfc-ai-send newfc-ai-send-stop"
              aria-label="停止生成"
              data-testid={stopTestId}
              onClick={onStop}
            >
              <i className="ri-stop-fill" aria-hidden />
            </button>
          </Tooltip>
        ) : (
          <Tooltip title={empty ? '请先输入问题' : '发送（Enter）'}>
            <button
              type="button"
              className="newfc-ai-send"
              aria-label="发送"
              disabled={empty}
              data-testid={sendTestId}
              onClick={fire}
            >
              <i className="ri-arrow-up-line" aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

/** 底部免责声明:一行小灰字,替代旧版那三行说明文 */
export function Disclaimer({ children }: { children?: ReactNode }) {
  return (
    <p className="newfc-ai-disclaimer">
      {children ?? '数字来自后端事实，行文由 AI 生成，仅供参考'}
    </p>
  );
}

/** 把数值核对结果折算成一条「正文之外」的警告条;null 表示无警告可收 */
export function numberCheckAlert(response: AssistantChatResponse): { message: string; description?: string } | null {
  const check = response.numberCheck;
  if (!check) return null;
  if (check.status === 'unverified') {
    return {
      message: `正文有 ${check.unverified.length} 个数值无法由本轮后端事实推导：${check.unverified.join('、')}`,
      description: check.note,
    };
  }
  return null;
}

/**
 * 「引用与依据」折叠条:完整页与全局小窗共用同一套(体验升级方案一.3 的补齐)。
 *
 * 收进去的是回答的「附带证据层」:
 * - 黄色警告(模型降级原因/后端确定性提示/数值核对未通过)——正文之外的原样提示,
 *   藏进折叠区后靠折叠条上的橙色警示图标与计数兜底,护栏不会无迹可寻;
 * - 口径 chips(含「采用这些筛选」)、引用来源、结构化事实。
 *
 * 展开状态归每轮回答各自记忆(默认收起);两处调用方只传 turn 与回调,
 * 预览等常显护栏(写操作意图/导航)不在这里,仍留在气泡正文中。
 */
export function EvidenceFold({ turn, onAdoptContext, testId, hideFacts = false }: {
  turn: ChatTurn;
  onAdoptContext?: (context: AssistantChatResponse['resolvedContext']) => void;
  testId?: string;
  /** 小窗(400px)里事实明细表放不下:计数仍进摘要,表本体留在完整页(hideFacts=true) */
  hideFacts?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const response = turn.response;
  if (!response) return null;
  const warning = numberCheckAlert(response);
  const warnings: { message: string; description?: string }[] = [
    ...(response.modelError ? [{ message: `模型不可用，已使用后端确定性结果：${response.modelError}` }] : []),
    ...(response.notices ?? []).map((notice) => ({ message: notice })),
    ...(warning ? [warning] : []),
  ];
  const hasEvidence = Boolean(response.resolution?.length || response.citations?.length || response.facts?.length);
  if (!warnings.length && !hasEvidence) return null;
  const summary = [
    warnings.length ? `提示 ${warnings.length}` : null,
    response.resolution?.length ? `口径 ${response.resolution.length}` : null,
    response.citations?.length ? `引用 ${response.citations.length}` : null,
    response.facts?.length ? `事实 ${response.facts.length}` : null,
  ].filter(Boolean).join(' · ');
  return (
    <div className={`newfc-ai-evidence${warnings.length ? ' newfc-ai-evidence-warn' : ''}`}>
      <button
        type="button"
        className="newfc-ai-evidence-toggle"
        data-testid={testId}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <i className={open ? 'ri-arrow-down-s-line' : 'ri-arrow-right-s-line'} aria-hidden />
        {warnings.length ? (
          <Tooltip title="本轮回答带有模型降级、后端提示或数值核对警告，展开查看">
            <i className="ri-error-warning-line newfc-ai-evidence-warn-icon" aria-hidden />
          </Tooltip>
        ) : null}
        <span>引用与依据</span>
        <span className="newfc-ai-evidence-summary">{summary}</span>
      </button>
      {open ? (
        <div className="newfc-ai-evidence-panel">
          {warnings.length ? (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {response.modelError ? (
                <Alert type="warning" showIcon message={`模型不可用，已使用后端确定性结果：${response.modelError}`} />
              ) : null}
              {(response.notices ?? []).map((notice, index) => (
                <Alert key={`notice-${index}`} type="warning" showIcon message={notice} />
              ))}
              {warning ? (
                <Alert type="warning" showIcon message={warning.message} description={warning.description} />
              ) : null}
            </Space>
          ) : null}
          {response.resolution?.length ? (
            <Space size={[6, 6]} wrap>
              <span className="newfc-ai-scope-key">口径</span>
              {response.resolution.map((item, index) => {
                const origin = RESOLUTION_ORIGIN_LABEL[item.origin] ?? { text: item.origin };
                return (
                  <Tooltip key={`${item.field}-${index}`} title={item.reason}>
                    <Tag bordered={false} className="newfc-ai-meta" color={origin.color}>
                      {RESOLUTION_FIELD_LABEL[item.field] ?? item.field}：{item.label ?? item.value}
                      <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 4 }}>{origin.text}</Typography.Text>
                    </Tag>
                  </Tooltip>
                );
              })}
              {onAdoptContext && response.resolvedContext ? (
                <Button size="small" type="link" onClick={() => onAdoptContext(response.resolvedContext!)}>采用这些筛选</Button>
              ) : null}
            </Space>
          ) : null}
          {response.citations?.length ? (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12, marginRight: 6 }}>引用来源</Typography.Text>
              <CitationList citations={response.citations} />
            </div>
          ) : null}
          {hideFacts ? null : (response.facts?.length ? <FactsPanel facts={response.facts} /> : null)}
        </div>
      ) : null}
    </div>
  );
}
