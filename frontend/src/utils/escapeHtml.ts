/**
 * HTML 转义:组织名、科目名等用户可控文本进入 ECharts tooltip HTML 前必须转义。
 *
 * ECharts 函数型 formatter 的返回值直接赋给 el.innerHTML(不做转义),
 * 名称含 `<script>`/`onerror=` 等内容时即构成存储型 XSS。
 * 名称可经组织/科目维护写入(后端仅 trim+非空校验),也可经备份恢复整库带入。
 */
const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  "'": '&#39;',
  '"': '&quot;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ESCAPE_MAP[char]!);
}
