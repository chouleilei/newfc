/**
 * CSV 单元格编码。
 *
 * 字符串字段属于文本，即使内容长得像负数也不应交给桌面表格软件当公式执行；
 * 真正的 number 值则保留数值语义（尤其是负金额）。前置单引号是 Excel /
 * LibreOffice 均识别的文本标记。
 */
export function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  const text = typeof value === 'string' && /^[\u0000-\u0020]*[=+\-@]/.test(raw)
    ? `'${raw}`
    : raw;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
