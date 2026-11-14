/**
 * 轻量 CSV / JSON 表格解析与 CSV 模板下载辅助（供组织树与用户范围批量导入复用）。
 */

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

export function parseCsvOrJsonRecords(
  rawText: string,
  headerAliases: Record<string, string> = {},
): Record<string, unknown>[] {
  const trimmed = rawText.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (Array.isArray(obj.rows)) return obj.rows as Record<string, unknown>[];
      if (Array.isArray(obj.items)) return obj.items as Record<string, unknown>[];
    }
    throw new Error('JSON 须为对象数组，或包含 rows / items 数组的对象');
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error('CSV 至少需要包含表头行和 1 行数据');
  }
  const headers = splitCsvLine(lines[0]).map((h) => headerAliases[h] ?? h);
  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    const rec: Record<string, unknown> = {};
    headers.forEach((h, idx) => {
      if (h) rec[h] = cols[idx] ?? '';
    });
    return rec;
  });
}

export function downloadCsvTemplate(filename: string, csvContent: string): void {
  const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
