import { z } from 'zod';
import { expectedVersion, id, optionalText, type MoneyString } from './common';

/**
 * 风险闭环契约(T-5,AC-F17)。事件键 = 规则:对象类型:对象ID[:子项];状态机见 specs/implementation.md「风险闭环」。
 */

export const RISK_STATUSES = ['open', 'confirmed', 'rectifying', 'rectified', 'closed', 'false_positive'] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];
export const RISK_STATUS_LABELS: Record<RiskStatus, string> = {
  open: '待确认', confirmed: '已确认', rectifying: '整改中', rectified: '待复核', closed: '已关闭', false_positive: '误报',
};
export const RISK_LEVELS = ['high', 'medium', 'low'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = { high: '高', medium: '中', low: '低' };
export const RISK_SOURCES = ['project_budget', 'plan', 'contract', 'investment_control', 'feasibility', 'eas'] as const;
export type RiskSource = (typeof RISK_SOURCES)[number];

/** 页面可发起的处理动作;detect/redetect/reopen/suppressed 只由扫描写入。 */
export const RISK_COMMANDS = ['confirm', 'start', 'submit', 'approve', 'return', 'false_positive', 'comment'] as const;
export type RiskCommand = (typeof RISK_COMMANDS)[number];
export const RISK_ACTION_LABELS: Record<string, string> = {
  detect: '发现', redetect: '再次命中', reopen: '重开', suppressed: '误报再次命中', confirm: '确认', start: '开始整改', submit: '提交复核',
  approve: '复核通过', return: '复核退回', false_positive: '认定误报', comment: '备注',
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

export const riskListQuery = z.object({
  status: z.enum(RISK_STATUSES).optional(),
  level: z.enum(RISK_LEVELS).optional(),
  source: z.enum(RISK_SOURCES).optional(),
  ruleCode: z.string().trim().max(64).optional(),
  orgId: id.optional(),
  projectId: id.optional(),
  lastScanHit: z.enum(['0', '1']).optional(),
  keyword: z.string().trim().max(100).optional(),
  open: z.enum(['1']).optional(),
}).strict();
export type RiskListQuery = z.infer<typeof riskListQuery>;

export const riskScanRequest = z.object({ orgId: id.optional() }).strict();

/** multipart 表单字段(附件可选,字段 file)。 */
export const riskActionForm = z.object({
  action: z.enum(RISK_COMMANDS),
  expectedVersion,
  comment: optionalText(2000),
  handlerUserId: id.optional(),
  deadline: date.optional(),
  exceptionReason: optionalText(500),
}).strict();
export type RiskActionForm = z.infer<typeof riskActionForm>;

/** 阈值按计算器类型解释:ratio 为 0～1 比率,amount 为元(十进制字符串);具体范围由服务端按计算器校验。 */
const thresholdText = z.string().trim().regex(/^\d{1,13}(\.\d{1,6})?$/, '阈值应为非负数字,最多 6 位小数');

export const riskRuleUpdate = z.object({
  expectedVersion,
  enabled: z.boolean().optional(),
  level: z.enum(RISK_LEVELS).optional(),
  threshold: thresholdText.nullable().optional(),
  suggestion: z.string().trim().max(500).optional(),
  name: z.string().trim().min(2).max(60).optional(),
}).strict();
export type RiskRuleUpdate = z.infer<typeof riskRuleUpdate>;

/** 自定义规则:复用某个内置计算器,只改名称/等级/阈值/建议,可限定组织(含下级)。 */
export const riskRuleCreate = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,47}$/, '编码只能用大写字母、数字与下划线,以字母开头,3～48 位'),
  name: z.string().trim().min(2).max(60),
  detector: z.string().trim().regex(/^[A-Z][A-Z0-9_]{2,47}$/),
  level: z.enum(RISK_LEVELS),
  threshold: thresholdText.nullable().optional(),
  suggestion: z.string().trim().max(500).optional(),
  orgId: id.nullable().optional(),
}).strict();
export type RiskRuleCreate = z.infer<typeof riskRuleCreate>;

export type RiskThresholdKind = 'ratio' | 'amount';

export interface RiskRuleDto {
  code: string; name: string; source: RiskSource; level: RiskLevel; threshold: string | null; thresholdApplies: boolean; enabled: boolean;
  suggestion: string; version: number; updatedAt: string | null;
  /** 命中计算器;内置规则等于自身编码。 */
  detector: string; detectorName: string; builtin: boolean; orgId: number | null; orgName: string | null;
  thresholdKind: RiskThresholdKind | null; thresholdLabel: string | null;
}

/** 风险解释(确定性模板 + 可选模型改写,只追加)。 */
export interface RiskExplanationDto {
  id: number; eventId: number; content: string; source: 'template' | 'model'; model: string; promptVersion: string; eventVersion: number;
  createdBy: string | null; createdAt: string;
}

/** 整改清单:按风险来源与当前事实确定性生成,不写库。 */
export interface RiskChecklistItemDto {
  key: string; question: string; required: boolean; done: boolean | null; hint: string; refs: { label: string; path: string }[];
}
export interface RiskChecklistDto {
  eventId: number; eventVersion: number; status: RiskStatus; items: RiskChecklistItemDto[];
  missingMaterials: { key: string; label: string }[]; suggestedNextStatus: RiskStatus | null; generatedAt: string;
}
export interface RiskEventDto {
  id: number; eventKey: string; ruleCode: string; ruleName: string; source: RiskSource; level: RiskLevel; orgId: number; orgName: string | null;
  projectId: number | null; projectCode: string | null; projectName: string | null; subjectType: string; subjectId: number;
  title: string; description: string; amount: MoneyString | null; metric: string | null; evidence: Record<string, unknown>;
  status: RiskStatus; occurrenceCount: number; firstDetectedAt: string; lastDetectedAt: string; lastScanId: number | null; lastScanHit: boolean;
  handlerUserId: number | null; handlerName: string | null; deadline: string | null; overdue: boolean; rectifyNote: string | null;
  submittedByUserId: number | null; reviewedByUserId: number | null; closedAt: string | null; reopenedCount: number; version: number;
  suggestion: string; createdAt: string; updatedAt: string;
}
export interface RiskActionDto {
  id: number; action: string; actionLabel: string; fromStatus: RiskStatus | null; toStatus: RiskStatus | null; comment: string;
  attachmentName: string | null; hasAttachment: boolean; scanId: number | null; exceptionReason: string | null; actorUserId: number | null; actorName: string | null; createdAt: string;
}
export interface RiskEventDetailDto extends RiskEventDto { actions: RiskActionDto[]; allowed: RiskCommand[]; explanations: RiskExplanationDto[] }
export interface RiskScanDto {
  id: number; scope: Record<string, unknown>; createdCount: number; updatedCount: number; reopenedCount: number; suppressedCount: number; clearedCount: number;
  hitCount: number; createdByUserId: number | null; createdAt: string;
}
export interface RiskSummaryDto {
  total: number; openCount: number; openAmount: MoneyString;
  byStatus: Record<RiskStatus, number>; byLevel: Record<RiskLevel, number>;
  byRule: { ruleCode: string; ruleName: string; count: number }[];
  pendingConfirm: number; pendingReview: number; overdue: number;
}
