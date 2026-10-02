import { z } from 'zod';
import { expectedVersion } from './common';

/** system_settings(T-7,AC-F23):自定义字段、导入字段模板(表头别名)、AI 提示补充。 */

export const CUSTOM_FIELD_DOMAINS = ['project', 'supplier'] as const;
export type CustomFieldDomain = (typeof CUSTOM_FIELD_DOMAINS)[number];
export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

const fieldName = z.string().trim().min(1, '字段名称不能为空').max(64);
const sortOrder = z.coerce.number().int().min(-9999).max(9999);
const description = z.string().trim().max(200);

export const customFieldCreate = z.object({
  domain: z.enum(CUSTOM_FIELD_DOMAINS),
  fieldCode: z.string().trim().regex(/^[a-z][a-z0-9_]{1,39}$/, '字段编码只能是小写字母开头的字母、数字、下划线(2~40 位)'),
  fieldName,
  fieldType: z.enum(CUSTOM_FIELD_TYPES),
  required: z.boolean().optional(),
  dictType: z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/, '字典类型不合法').optional(),
  description: description.optional(),
  sortOrder: sortOrder.optional(),
}).strict().refine((v) => (v.fieldType === 'select') === !!v.dictType, { message: '下拉字段必须选择字典类型,其他类型不能设置字典类型', path: ['dictType'] });
export type CustomFieldCreate = z.infer<typeof customFieldCreate>;
export const customFieldUpdate = z.object({
  expectedVersion, fieldName: fieldName.optional(), required: z.boolean().optional(), description: description.optional(),
  sortOrder: sortOrder.optional(), status: z.enum(['active', 'inactive']).optional(),
}).strict();
export type CustomFieldUpdate = z.infer<typeof customFieldUpdate>;

export interface CustomFieldDto {
  id: number; domain: CustomFieldDomain; fieldCode: string; fieldName: string; fieldType: CustomFieldType; required: boolean;
  dictType: string | null; description: string; sortOrder: number; status: 'active' | 'inactive'; version: number;
  /** select 字段的有效选项(按字典排序)。 */
  options?: { value: string; label: string }[];
  createdAt: string; updatedAt: string;
}

export const IMPORT_ALIAS_DATA_TYPES = ['eas_voucher', 'eas_balance', 'eas_auxiliary', 'plan_investment', 'plan_purchase', 'plan_maintenance'] as const;
export type ImportAliasDataType = (typeof IMPORT_ALIAS_DATA_TYPES)[number];

export const importAliasCreate = z.object({
  dataType: z.enum(IMPORT_ALIAS_DATA_TYPES),
  targetField: z.string().trim().min(1).max(64),
  sourceAlias: z.string().trim().min(1, '表头别名不能为空').max(64),
  note: z.string().trim().max(200).optional(),
}).strict();
export type ImportAliasCreate = z.infer<typeof importAliasCreate>;
export const importAliasUpdate = z.object({ expectedVersion, note: z.string().trim().max(200).optional(), status: z.enum(['active', 'inactive']).optional() }).strict();
export type ImportAliasUpdate = z.infer<typeof importAliasUpdate>;

export interface ImportAliasDto {
  id: number; dataType: ImportAliasDataType; targetField: string; targetLabel: string; sourceAlias: string; note: string;
  status: 'active' | 'inactive'; version: number; createdAt: string; updatedAt: string;
}
export interface ImportTargetCatalogDto {
  dataType: ImportAliasDataType; label: string;
  fields: { key: string; label: string; required: boolean; builtinAliases: string[] }[];
}

export const PROMPT_SUPPLEMENT_MAX = 1000;
export const promptSupplementSave = z.object({
  content: z.string().max(PROMPT_SUPPLEMENT_MAX, `补充说明不能超过 ${PROMPT_SUPPLEMENT_MAX} 字`),
  expectedVersion: z.coerce.number().int().min(0),
}).strict();
export type PromptSupplementSave = z.infer<typeof promptSupplementSave>;
export interface PromptSupplementDto {
  taskKey: string; label: string; basePromptVersion: string; effectivePromptVersion: string; content: string;
  /** 0 表示从未保存。 */
  version: number; updatedBy: string | null; updatedAt: string | null;
}
