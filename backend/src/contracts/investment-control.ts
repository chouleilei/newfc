import { z } from 'zod';
import { expectedVersion, id, moneyString, optionalText, reason, type MoneyString, type RatioString } from './common';

/**
 * 投资控制(四算对比)契约(T-5,AC-F13)。金额以元十进制字符串传输,库内整数分;
 * 比率为 6 位小数字符串。
 */

export const IC_VERSION_TYPES = ['estimate', 'design_estimate', 'adjusted_estimate', 'construction_budget', 'settlement', 'final_account'] as const;
export type IcVersionType = (typeof IC_VERSION_TYPES)[number];
export const IC_VERSION_TYPE_LABELS: Record<IcVersionType, string> = {
  estimate: '投资估算', design_estimate: '设计概算', adjusted_estimate: '调整概算',
  construction_budget: '施工图预算', settlement: '竣工结算', final_account: '竣工决算',
};

const nonNegativeMoney = moneyString.refine((v) => !v.startsWith('-'), '金额不能为负');
const ratio = z.string().trim().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, '阈值应为 0~1 的小数,最多 6 位');

export const icProjectCreate = z.object({
  mdProjectId: id,
  approvedAmount: nonNegativeMoney.nullish(),
  approvalDocNo: optionalText(128),
}).strict();
export const icProjectUpdate = z.object({
  expectedVersion,
  approvedAmount: nonNegativeMoney.nullish(),
  approvalDocNo: optionalText(128),
  status: z.enum(['active', 'archived']).optional(),
}).strict();
export const icProjectListQuery = z.object({
  orgId: id.optional(),
  status: z.enum(['active', 'archived']).optional(),
  keyword: z.string().trim().max(100).optional(),
}).strict();

/** 导入表单(multipart 字段)。 */
export const icImportForm = z.object({
  versionType: z.enum(IC_VERSION_TYPES),
  name: optionalText(128),
  approvalDocNo: optionalText(128),
  approvalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '批复日期格式应为 YYYY-MM-DD').optional(),
}).strict();
export const icImportConfirm = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();

export const icMappingUpdate = z.object({
  expectedVersion,
  items: z.array(z.object({
    itemId: id,
    action: z.enum(['map', 'ignore', 'reset']),
    canonicalCode: z.string().trim().regex(/^\d+(\.\d+)*$/, '规范科目编码格式不正确').optional(),
  }).strict().refine((v) => v.action !== 'map' || !!v.canonicalCode, '映射时必须选择规范科目')).min(1).max(2000),
}).strict();
export const icVersionConfirm = z.object({ expectedVersion }).strict();
export const icVersionVoid = z.object({ expectedVersion, reason }).strict();

export const icThresholds = z.object({ normal: ratio, attention: ratio, warning: ratio }).strict()
  .refine((t) => Number(t.normal) <= Number(t.attention) && Number(t.attention) <= Number(t.warning), '阈值须满足 normal ≤ attention ≤ warning');
export const icCompareRequest = z.object({
  baseVersionId: id,
  targetVersionId: id,
  thresholds: icThresholds.optional(),
}).strict().refine((v) => v.baseVersionId !== v.targetVersionId, '基准与目标版本不能相同');

export type IcLevel = 'normal' | 'attention' | 'warning' | 'exceed';
export type IcRowStatus = 'compared' | 'new_item' | 'removed_or_zero';
export type IcChainStatus = 'budget_over_estimate' | 'settlement_over_budget' | 'over_redline';

export interface IcComparisonRowDto {
  canonicalCode: string;
  name: string;
  level: number;
  baseStatic: MoneyString;
  targetStatic: MoneyString;
  baseDynamic: MoneyString;
  targetDynamic: MoneyString;
  deviation: MoneyString;
  deviationRate: RatioString;
  dynamicDeviation: MoneyString;
  status: IcRowStatus;
  alertLevel: IcLevel | null;
}
export interface IcChainItemDto {
  status: IcChainStatus;
  message: string;
  subjectVersionId: number;
  referenceVersionId: number;
  subjectAmount: MoneyString;
  referenceAmount: MoneyString;
}
export interface IcComparisonSummaryDto {
  baseTotalStatic: MoneyString;
  targetTotalStatic: MoneyString;
  baseTotalDynamic: MoneyString;
  targetTotalDynamic: MoneyString;
  totalDeviation: MoneyString;
  totalDeviationRate: RatioString;
  totalLevel: IcLevel | null;
  levelCounts: Record<IcLevel, number>;
  exceedCount: number;
  newItemCount: number;
  removedCount: number;
  redlineVersionId: number | null;
  redlineAmount: MoneyString | null;
  controlChain: IcChainItemDto[];
}
