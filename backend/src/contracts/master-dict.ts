import { z } from 'zod';
import { expectedVersion } from './common';

/** 主数据字典项(T-7,AC-F07):类型/取值创建后不可改,停用代替删除。 */
export const dictType = z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/, '字典类型只能是小写字母开头的字母、数字、下划线(2~64 位)');
const itemValue = z.string().trim().min(1, '取值不能为空').max(128);
const itemLabel = z.string().trim().min(1, '显示名不能为空').max(128);
const sortOrder = z.coerce.number().int().min(-9999).max(9999);

export const dictItemCreate = z.object({ dictType, itemValue, itemLabel, sortOrder: sortOrder.optional() }).strict();
export type DictItemCreate = z.infer<typeof dictItemCreate>;
export const dictItemUpdate = z.object({
  expectedVersion, itemLabel: itemLabel.optional(), sortOrder: sortOrder.optional(), status: z.enum(['active', 'inactive']).optional(),
}).strict();
export type DictItemUpdate = z.infer<typeof dictItemUpdate>;
export const dictItemListQuery = z.object({ dictType: dictType.optional(), status: z.enum(['active', 'inactive']).optional() });

export interface DictItemDto {
  id: number; dictType: string; itemValue: string; itemLabel: string; sortOrder: number; status: 'active' | 'inactive';
  version: number; createdAt: string; updatedAt: string;
}
export interface DictTypeDto { dictType: string; itemCount: number; activeCount: number }
