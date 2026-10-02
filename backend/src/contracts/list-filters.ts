import { z } from 'zod';
export const metricFilterSchema = z.object({ search: z.string().max(200).optional(), kind: z.enum(['linear', 'ratio']).optional(), status: z.enum(['active', 'inactive']).optional() }).strict();
export const aliasFilterSchema = z.object({ search: z.string().max(200).optional(), targetKind: z.enum(['budget', 'actual-current', 'finance']).optional(), mappingKind: z.enum(['org', 'account']).optional() }).strict();
export type MetricFilter = z.infer<typeof metricFilterSchema>;
export type AliasFilter = z.infer<typeof aliasFilterSchema>;
