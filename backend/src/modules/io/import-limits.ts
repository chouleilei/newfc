/** 标准 Excel 与非标准清洗导入共用的资源上限。 */

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw ?? fallback);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

export const MAX_IMPORT_ROWS = boundedInteger(process.env.BUDGET_MAX_IMPORT_ROWS, 20_000, 100, 100_000);
export const MAX_IMPORT_ERRORS = boundedInteger(process.env.BUDGET_MAX_IMPORT_ERRORS, 200, 20, 2_000);
export const MAX_UPLOAD_BYTES = boundedInteger(process.env.BUDGET_MAX_UPLOAD_BYTES, 10 * 1024 * 1024, 1024, 100 * 1024 * 1024);
export const MAX_CLEANING_SHEETS = 20;
export const MAX_CLEANING_COLUMNS = 100;
export const CLEANING_AI_ENABLED = process.env.BUDGET_CLEANING_AI !== '0';
export const CLEANING_UPLOAD_TTL_MS = boundedInteger(
  process.env.BUDGET_CLEANING_UPLOAD_TTL_MS,
  24 * 60 * 60 * 1000,
  60 * 1000,
  30 * 24 * 60 * 60 * 1000,
);
export const CLEANING_UPLOAD_CAPACITY_BYTES = boundedInteger(
  process.env.BUDGET_CLEANING_UPLOAD_CAPACITY_BYTES,
  200 * 1024 * 1024,
  MAX_UPLOAD_BYTES,
  2 * 1024 * 1024 * 1024,
);
