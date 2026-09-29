import { z } from 'zod';

/** 共享契约基元(T-3 起的新接口)。只依赖 zod;前端通过 @contracts/* 以 import type 使用推导类型。 */

export const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const period = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '期间格式应为 YYYY-MM');
export const reason = z.string().trim().min(1, '必须填写原因').max(500);
export const optionalText = (max = 500) => z.string().trim().max(max).optional();
export const expectedVersion = z.coerce.number().int().positive();
/** 金额:十进制字符串(元,最多两位小数);服务端再做 64 位定点解析。 */
export const moneyString = z.string().trim().regex(/^-?\d{1,16}(\.\d{1,2})?$/, '金额应为最多两位小数的十进制字符串');

/** 金额在响应中一律为十进制字符串(元)。 */
export type MoneyString = string;
/** 比率为 6 位小数的十进制字符串;分母为 0 时为 null。 */
export type RatioString = string | null;
