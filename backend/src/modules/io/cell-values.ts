/**
 * 新领域导入的单元格取值(T-4 起):表头别名、金额单位换算、比率、数量、月份与日期。
 * 规则见 specs/implementation.md T-4「公共约定 · 金额与数值」:
 * - 金额按整数分;万元 ×10000 精确换算,折合超过分(万元超过 6 位小数)时报错,不静默舍入。
 * - 比率 6 位小数;“45%”或 0～1 的小数,大于 1 且没有 % 时报错(requirePercent 时必须带 %)。
 * - 数量 4 位小数。空单元格即缺失(null),不当 0。
 */
import { AppError } from '../../core/errors';
import { formatScaled, parseScaled, RATIO_SCALE } from '../../core/decimal';

export type AmountUnit = 'yuan' | 'wan';
export const QUANTITY_SCALE = 4;

export class CellError extends Error {
  constructor(message: string) { super(message); }
}

/** 表头去空白、去括注单位,便于按别名匹配;单位另由 headerUnit 取。 */
export function headerKey(header: string): string {
  return header.replace(/\s+/g, '').replace(/[（(][^）)]*[）)]/g, '').replace(/[*＊:：]/g, '').trim();
}

export function headerUnit(header: string): AmountUnit | null {
  const m = /[（(]\s*(万元|元)\s*[）)]/.exec(header);
  return m ? (m[1] === '万元' ? 'wan' : 'yuan') : null;
}

/** 按别名在表头中找列;返回原表头(TableRow.values 的键)。 */
export function findHeader(headers: string[], aliases: readonly string[]): string | null {
  for (const alias of aliases) {
    const hit = headers.find((h) => headerKey(h) === alias);
    if (hit) return hit;
  }
  return null;
}

/** 金额文本 → 分。unit=wan 时 ×10000,仍须精确到分。 */
export function amountCents(text: string, unit: AmountUnit, label: string): bigint | null {
  const raw = text.replace(/[\s¥￥]/g, '');
  if (raw === '' || raw === '-' || raw === '—') return null;
  try {
    // 1 万元 = 1,000,000 分:万元按 6 位小数定点解析即得分,超过 6 位小数(不足一分)时拒绝
    return parseScaled(raw, unit === 'yuan' ? 2 : 6, { label });
  } catch (e) {
    if (e instanceof AppError) throw new CellError(unit === 'wan' ? `${label}「${text}」不是合法万元金额(最多 6 位小数,折合到分)` : `${label}「${text}」不是合法金额(最多 2 位小数)`);
    throw e;
  }
}

/** 比率文本 → 6 位缩放整数。 */
export function ratioScaledCell(text: string, label: string, opts: { requirePercent?: boolean; max?: bigint } = {}): bigint | null {
  const raw = text.replace(/\s+/g, '');
  if (raw === '') return null;
  const percent = raw.endsWith('%') || raw.endsWith('%');
  const body = percent ? raw.slice(0, -1) : raw;
  if (opts.requirePercent && !percent) throw new CellError(`${label}「${text}」须带 %(例如 50%),不带 % 的数字有歧义`);
  let v: bigint;
  try {
    v = parseScaled(body, percent ? RATIO_SCALE - 2 : RATIO_SCALE, { label });
  } catch {
    throw new CellError(`${label}「${text}」不是合法比例`);
  }
  if (v < 0n) throw new CellError(`${label}不能为负`);
  const max = opts.max ?? 1_000_000n;
  if (!percent && v > 1_000_000n) throw new CellError(`${label}「${text}」大于 1 且没有 %,请写成百分比(如 45%)或 0～1 的小数`);
  if (v > max) throw new CellError(`${label}「${text}」超出允许范围`);
  return v;
}

export function quantityScaled(text: string, label: string): bigint | null {
  const raw = text.replace(/[\s,]/g, '');
  if (raw === '') return null;
  try {
    return parseScaled(raw, QUANTITY_SCALE, { label });
  } catch {
    throw new CellError(`${label}「${text}」不是合法数量(最多 4 位小数)`);
  }
}

export const ratioText = (scaled: bigint | number | null | undefined) => (scaled == null ? null : formatScaled(BigInt(scaled), RATIO_SCALE));
export const quantityText = (scaled: bigint | number | null | undefined) => (scaled == null ? null : formatScaled(BigInt(scaled), QUANTITY_SCALE, false));

/** 月份:2026-05、2026/5、2026年5月、202605、2026-05-01 → 2026-05。 */
export function monthCell(text: string, label: string): string | null {
  const raw = text.replace(/\s+/g, '');
  if (raw === '') return null;
  const m = /^(\d{4})(?:[-/.年](\d{1,2})月?(?:[-/.](\d{1,2})日?)?|(\d{2}))$/.exec(raw);
  const month = m ? Number(m[2] ?? m[4]) : NaN;
  if (!m || !(month >= 1 && month <= 12)) throw new CellError(`${label}「${text}」不是合法月份(YYYY-MM)`);
  return `${m[1]}-${String(month).padStart(2, '0')}`;
}

/** 日期:2026-05-03、2026/5/3、2026年5月3日 → 2026-05-03(校验真实日期)。 */
export function dateCell(text: string, label: string): string | null {
  const raw = text.replace(/\s+/g, '');
  if (raw === '') return null;
  const m = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(raw);
  if (!m) throw new CellError(`${label}「${text}」不是合法日期(YYYY-MM-DD)`);
  const iso = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new CellError(`${label}「${text}」不是真实日期`);
  return iso;
}
