import path from 'path';

const FORBIDDEN_DATA_DIRS = [
  '/data/newfc-data',
  '/data/newbd',
  '/root/newbd',
  '/root/newfc/backend/data',
];

/**
 * CLI 数据目录安全门禁：
 * 强制要求显式指定 NEWFC_DATA_DIR，拒绝默认落入 <cwd>/data 或触碰生产/禁入目录。
 */
export function requireSafeCliDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.NEWFC_DATA_DIR ?? '').trim();
  if (!raw) {
    throw new Error('安全门禁：必须显式设置环境变量 NEWFC_DATA_DIR 指向独立数据目录（禁止缺省使用 <cwd>/data）');
  }
  const resolved = path.resolve(raw);
  const cwdData = path.resolve(process.cwd(), 'data');
  if (resolved === cwdData) {
    throw new Error(`安全门禁：NEWFC_DATA_DIR 禁止指向工作区默认目录 ${cwdData}，请使用独立临时目录`);
  }
  for (const forbidden of FORBIDDEN_DATA_DIRS) {
    const norm = path.resolve(forbidden);
    if (resolved === norm || resolved.startsWith(`${norm}${path.sep}`)) {
      throw new Error(`安全门禁：严禁 CLI 访问受保护目录 ${norm}`);
    }
  }
  return resolved;
}

/** 解析标准 RFC4180 CSV（自动剥离 UTF-8 BOM，支持双引号包裹逗号与转义双引号）。 */
export function parseCsvMatrix(csvText: string): string[][] {
  const text = csvText.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let curRow: string[] = [];
  let curField = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          curField += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        curField += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      curRow.push(curField);
      curField = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      curRow.push(curField);
      curField = '';
      if (curRow.some((cell) => cell.trim() !== '')) {
        rows.push(curRow);
      }
      curRow = [];
    } else {
      curField += ch;
    }
  }
  if (curField.length > 0 || curRow.length > 0) {
    curRow.push(curField);
    if (curRow.some((cell) => cell.trim() !== '')) {
      rows.push(curRow);
    }
  }
  return rows;
}

export function parseCsvObjects(csvText: string): Record<string, string>[] {
  const matrix = parseCsvMatrix(csvText);
  if (matrix.length < 2) return [];
  const headers = matrix[0].map((h) => h.trim());
  return matrix.slice(1).map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      if (h) obj[h] = (cells[idx] ?? '').trim();
    });
    return obj;
  });
}

export function parseCliArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 2) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        out[arg.slice(2)] = argv[++i];
      } else {
        out[arg.slice(2)] = 'true';
      }
    }
  }
  return out;
}
