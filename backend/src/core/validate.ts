import type { ZodType, ZodTypeDef } from 'zod';
import { AppError } from './errors';

/**
 * 新接口的运行时校验(architecture「新 API 以运行时 schema 校验」)。
 * schema 定义在 src/contracts,只依赖 zod;前端以 import type 取同一类型。
 * 校验失败统一为 VALIDATION_FAILED(400),消息列出字段路径,不回显原始输入。
 */
export function parseInput<T>(schema: ZodType<T, ZodTypeDef, unknown>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '请求体'}: ${i.message}`);
  throw new AppError('VALIDATION_FAILED', `请求参数不合法 — ${issues.join(';')}`, 400);
}
