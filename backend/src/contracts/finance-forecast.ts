import { z } from 'zod';
import { expectedVersion, id, optionalText } from './common';

/**
 * 财务预测契约(T-5,AC-F11)。工作簿 JSON:工作表 → 单元格(公式 f / 数值 n / 文本 s / 逻辑 b / 错误 e);
 * 数值一律十进制字符串。参数/输出映射引用 “工作表!单元格”。
 */

const decimal = z.string().trim().regex(/^-?\d{1,15}(\.\d{1,12})?$/, '应为十进制数(最多 12 位小数)');
const cellRef = z.string().trim().min(3).max(200).regex(/^(?:'(?:[^']|'')+'|[^!]+)!\$?[A-Za-z]{1,3}\$?\d+$/, '单元格应写成 工作表!A1');
const rowRef = z.string().trim().min(3).max(200)
  .regex(/^(?:'(?:[^']|'')+'|[^!]+)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/, '输出应写成 工作表!B5 或 工作表!B5:F5(一行)');
/** 模型目录(lishui 模型文件夹):'/' 分隔的路径,空串为根目录。 */
const modelFolder = z.string().trim().max(120).regex(/^[^/]+(\/[^/]+)*$|^$/, '目录用 / 分隔,不能以 / 开头或结尾');
const mapKey = z.string().trim().regex(/^[a-z][a-z0-9_]{0,63}$/, '编码只能用小写字母、数字和下划线,字母开头');

export const ERROR_VALUES = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#NULL!'] as const;
export const cellInput = z.union([
  z.object({ f: z.string().min(2).max(8000).regex(/^=/, '公式须以 = 开头') }).strict(),
  z.object({ n: decimal }).strict(),
  z.object({ s: z.string().max(2000) }).strict(),
  z.object({ b: z.boolean() }).strict(),
  z.object({ e: z.enum(ERROR_VALUES) }).strict(),
]);
export const workbookJson = z.object({
  sheets: z.array(z.object({
    name: z.string().trim().min(1).max(31),
    cells: z.record(z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/, '单元格地址应为 A1 形式(大写)'), cellInput),
  }).strict()).min(1).max(50),
}).strict();

export const forecastParam = z.object({
  key: mapKey,
  name: z.string().trim().min(1).max(64),
  cell: cellRef,
  unit: z.string().trim().max(16).default(''),
  min: decimal.nullish(),
  max: decimal.nullish(),
}).strict();
export const forecastOutput = z.object({
  key: mapKey,
  name: z.string().trim().min(1).max(64),
  ref: rowRef,
  unit: z.string().trim().max(16).default(''),
}).strict();

export const ffModelCreate = z.object({
  name: z.string().trim().min(1).max(128),
  orgId: id,
  baseYear: z.number().int().min(2000).max(2100),
  horizonYears: z.number().int().min(1).max(30),
  description: optionalText(1000),
  folder: modelFolder.optional(),
}).strict();
export const ffModelUpdate = z.object({
  expectedVersion,
  name: z.string().trim().min(1).max(128).optional(),
  description: optionalText(1000),
  status: z.enum(['active', 'archived']).optional(),
  folder: modelFolder.optional(),
}).strict();
export const ffModelListQuery = z.object({
  orgId: id.optional(),
  /** 目录前缀:含子目录 */
  folder: modelFolder.optional(),
  status: z.enum(['active', 'archived']).optional(),
  keyword: z.string().trim().max(100).optional(),
}).strict();

export const ffVersionCreate = z.object({
  workbook: workbookJson,
  params: z.array(forecastParam).max(200).default([]),
  outputs: z.array(forecastOutput).max(200).default([]),
  note: optionalText(500),
}).strict();
export const ffVersionUpdate = z.object({
  expectedVersion,
  /** 逐单元格修改:值为 null 表示清空 */
  cells: z.array(z.object({ sheet: z.string().trim().min(1).max(31), cell: z.string().regex(/^[A-Z]{1,3}[1-9]\d{0,6}$/), value: cellInput.nullable() }).strict()).max(5000).optional(),
  params: z.array(forecastParam).max(200).optional(),
  outputs: z.array(forecastOutput).max(200).optional(),
  note: optionalText(500),
}).strict();
export const ffVersionCommand = z.object({ expectedVersion }).strict();
export const ffImportForm = z.object({ note: optionalText(500) }).strict();

export const ffRunRequest = z.object({
  kind: z.enum(['baseline', 'scenario']),
  scenarioName: z.string().trim().max(64).optional(),
  params: z.record(mapKey, decimal).default({}),
}).strict().superRefine((v, ctx) => {
  if (v.kind === 'baseline' && Object.keys(v.params).length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '基准运行不能覆盖参数' });
  if (v.kind === 'scenario' && !v.scenarioName) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '情景运行必须填写方案名' });
  if (v.kind === 'scenario' && !Object.keys(v.params).length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '情景运行至少覆盖一个参数' });
});

export type WorkbookJsonInput = z.infer<typeof workbookJson>;
export type ForecastParam = z.infer<typeof forecastParam>;
export type ForecastOutput = z.infer<typeof forecastOutput>;
export interface ForecastDiagnostic { severity: 'error' | 'warning'; code: string; cell: string | null; message: string }

/* ---------------- T-7:版本复核、运行发布、基准时间线、洞察 ---------------- */

export const ffVersionReview = z.object({
  expectedVersion,
  decision: z.enum(['approve', 'return']),
  comment: optionalText(1000),
  exceptionReason: optionalText(500),
}).strict().superRefine((v, ctx) => {
  if (v.decision === 'return' && !v.comment?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '退回须填写意见', path: ['comment'] });
});
export const ffRunPublish = z.object({ title: z.string().trim().min(1).max(128).optional(), note: optionalText(1000) }).strict();
export const ffPublicationWithdraw = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const ffPublicationListQuery = z.object({
  orgId: id.optional(),
  modelId: id.optional(),
  includeWithdrawn: z.enum(['0', '1']).optional(),
}).strict();

/** 冻结版本的复核状态:冻结即提交复核(pending);复核只有一次,退回后复制为新草稿再冻结。 */
export type FfReviewStatus = 'pending' | 'approved' | 'returned';
export interface FfVersionReviewDto {
  decision: 'approve' | 'return'; comment: string; exceptionReason: string | null; selfReview: boolean; reviewer: string | null; createdAt: string;
}
export interface FfPublicationDto {
  id: number; runId: number; modelId: number; modelName: string; orgId: number; orgName: string; folder: string;
  versionId: number; versionNo: number; kind: 'baseline' | 'scenario'; scenarioName: string; params: Record<string, string>;
  title: string; note: string; publishedAt: string; publishedBy: string | null;
  withdrawnAt: string | null; withdrawnBy: string | null; withdrawReason: string | null;
  outputs: { key: string; name: string; unit: string; values: string[] }[];
}
export interface FfBaselineTimelineDto {
  modelId: number;
  items: {
    versionId: number; versionNo: number; reviewStatus: FfReviewStatus; frozenAt: string | null; runId: number; finishedAt: string | null;
    outputs: { key: string; name: string; unit: string; total: string; previousTotal: string | null; change: string | null; changeRate: string | null }[];
  }[];
}
export interface FfInsightDto {
  id: number; runId: number; content: string; source: 'template' | 'model'; model: string; promptVersion: string; createdBy: string | null; createdAt: string;
}
