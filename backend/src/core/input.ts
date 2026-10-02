import { z } from 'zod';
import { AppError } from './errors';

/** 领域写入和请求内分析共用的严格 DTO 校验。 */
export function validateInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('VALIDATION_FAILED', result.error.issues.map((issue) => `${issue.path.join('.') || '表单'}: ${issue.code === 'unrecognized_keys' ? '当前操作不允许这些字段' : issue.message}`).join('；'), 400, undefined, { fields: result.error.issues.flatMap((issue) => issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.')]) });
  return result.data;
}
export const positiveId = z.number().int().positive().safe();
export const sortOrder = z.number().int().safe();
export const nodeStatus = z.enum(['active', 'inactive']);
