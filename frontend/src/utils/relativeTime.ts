/**
 * 时间显示助手(会话列表等场景共用)。
 *
 * shortTime:后端 ISO 时间戳(带 Z)按本地时区显示到分钟——直接印原文会出现
 * 「2026-08-28T16:36:43.083Z」这种既带 T/Z 又是 UTC 的读数。
 * relativeTime:列表里的相对时间,标题才是主角,精确时间退到 tooltip 里。
 */
export function shortTime(value: string | null | undefined): string {
  if (!value) return '';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return '';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const minutes = Math.round((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return at.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}
