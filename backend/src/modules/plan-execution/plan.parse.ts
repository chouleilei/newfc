/**
 * 综合计划与计划执行模板解析（AC-F15 / GAP-09）：支持 16 类标准计划与附表、.xls/.xlsx 及容缺提醒。
 *
 * - 识别 16 类 PlanSheetCode，历史完成对照表/目录表/空白辅助表自动归入 ignoredSheets；
 * - 支持无「项目编码」列或单元格缺失时输出 MISSING_PROJECT_CODE 提醒并结合承办/分部上下文解析；
 * - 滞后表头年份（如 2025年计划金额）在多表综合计划或非主投资表降级为 STALE_YEAR_HEADER 提醒；
 * - 精确识别罗马数字（Ⅰ/Ⅱ）、中文序号（一/（一））与父级点分序号（2 -> 2.1），防止小计/节头重复累加。
 */
import type { RowError } from '../../core/errors';
import { formatScaled } from '../../core/decimal';
import { normalizeHeaderText, sheetTable, type MatrixRow, type ReadSheet } from '../io/table-reader';
import {
  amountCents, CellError, findHeader, headerKey, headerUnit, quantityScaled, ratioScaledCell, type AmountUnit, QUANTITY_SCALE,
} from '../io/cell-values';
import { PLAN_SHEET_LABELS, type PlanMeasure, type PlanSheetCode, type PlanWarningDto } from '../../contracts/plan-execution';

export type PlanValueType = 'amount' | 'quantity' | 'ratio' | 'text';
export interface FieldDef { key: string; label: string; aliases: readonly string[]; measure: PlanMeasure; type: PlanValueType }

export interface UnitFormulaMatcher {
  key: string;
  label: string;
  tokens: string[];
}

function excelColToIndex(colLetters: string): number {
  let idx = 0;
  for (const ch of colLetters.toUpperCase()) {
    idx = idx * 26 + (ch.charCodeAt(0) - 64);
  }
  return idx - 1;
}

function matchOrgUnit(text: string, matchers: UnitFormulaMatcher[]): UnitFormulaMatcher | null {
  const cleaned = text
    .replace(/^\[\d+\]/, '')
    .replace(/(利润总表|利润预算表|利润表|五项费用预算表|五项费用|管理类费用预算表|管理费用预算表|管理费用|制造费用预算表|制造费用|运行维护费|运维明细|预算表|计划表|汇总表)/g, '')
    .replace(/[0-9.\-_()\s（）]/g, '')
    .trim();
  if (!cleaned) return null;
  let best: { m: UnitFormulaMatcher; len: number } | null = null;
  for (const m of matchers) {
    for (const rawTok of m.tokens) {
      const tok = rawTok.trim();
      if (tok.length < 2) continue;
      if (cleaned.includes(tok) || text.includes(tok)) {
        if (!best || tok.length > best.len) best = { m, len: tok.length };
      }
    }
  }
  return best?.m ?? null;
}

/**
 * 扫描工作簿跨单位单元格错列公式引用（CROSS_UNIT_CELL_REF）：
 * 1) 同簿多单位分表引用同一汇总表时，基于各分表主引用列亲和度（Dominant Column Affinity）识别串列错引（如分表主引 GW 列而单格误引他表专属 FA 列）；
 * 2) 分表直接跨表引用另一归口单位分表单元格；
 * 3) 分表引用同簿汇总表中表头归属另一单位的列。
 */
export function scanWorkbookCrossUnitFormulas(
  sheets: ReadSheet[],
  unitMatchers: UnitFormulaMatcher[] = [],
): PlanWarningDto[] {
  const warnings: PlanWarningDto[] = [];
  const seen = new Set<string>();
  const refRegex = /(?:(?:'([^']+)'|([A-Za-z0-9_\u4e00-\u9fa5[\].-]+))!)(\$?[A-Z]{1,3})\$?(\d+)/g;
  const cleanTargetName = (raw: string) => raw.replace(/^\[\d+\]/, '').trim();
  const bySheetName = new Map(sheets.map((s) => [s.name.trim(), s]));

  // Pass 1: 统计每张分表对每个目标表的数据列（排除 A/B 序号与名称列）引用频次，建立列亲和度映射
  const sheetTargetColCounts = new Map<string, Map<string, Map<string, number>>>();
  for (const s of sheets) {
    if (!s.formulas?.length) continue;
    const byTarget = new Map<string, Map<string, number>>();
    for (const fc of s.formulas) {
      refRegex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = refRegex.exec(fc.formula)) !== null) {
        const targetSheet = cleanTargetName(m[1] ?? m[2] ?? '');
        const colLetters = (m[3] ?? '').replace(/\$/g, '').toUpperCase();
        if (!targetSheet || !colLetters || targetSheet === s.name) continue;
        if (colLetters === 'A' || colLetters === 'B') continue;
        let colMap = byTarget.get(targetSheet);
        if (!colMap) {
          colMap = new Map();
          byTarget.set(targetSheet, colMap);
        }
        colMap.set(colLetters, (colMap.get(colLetters) ?? 0) + 1);
      }
    }
    if (byTarget.size > 0) sheetTargetColCounts.set(s.name, byTarget);
  }

  const dominantColBySheetTarget = new Map<string, string>();
  const colOwnerSheet = new Map<string, string>();
  for (const [sheetName, byTarget] of sheetTargetColCounts.entries()) {
    for (const [targetSheet, colMap] of byTarget.entries()) {
      let total = 0;
      let topCol = '';
      let topCount = 0;
      for (const [col, cnt] of colMap.entries()) {
        total += cnt;
        if (cnt > topCount) {
          topCount = cnt;
          topCol = col;
        }
      }
      if (topCount >= 2 && topCount * 2 > total) {
        dominantColBySheetTarget.set(`${sheetName}::${targetSheet}`, topCol);
        const ownerKey = `${targetSheet}::${topCol}`;
        if (!colOwnerSheet.has(ownerKey)) colOwnerSheet.set(ownerKey, sheetName);
      }
    }
  }

  // Pass 2: 逐格核验跨单位串表或串列引用
  for (const s of sheets) {
    if (!s.formulas?.length) continue;
    const selfUnit = unitMatchers.length > 0 ? matchOrgUnit(s.name, unitMatchers) : null;
    for (const fc of s.formulas) {
      refRegex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = refRegex.exec(fc.formula)) !== null) {
        const rawTarget = m[1] ?? m[2] ?? '';
        const targetSheet = cleanTargetName(rawTarget);
        const rawCol = m[3] ?? '';
        const colLetters = rawCol.replace(/\$/g, '').toUpperCase();
        const refRow = m[4] ?? '';
        if (!targetSheet || !colLetters || targetSheet === s.name) continue;

        const dominant = dominantColBySheetTarget.get(`${s.name}::${targetSheet}`);
        if (colLetters !== 'A' && colLetters !== 'B' && dominant && colLetters !== dominant) {
          const peerOwner = colOwnerSheet.get(`${targetSheet}::${colLetters}`);
          const dedupKey = `${s.name}:${fc.address}:${targetSheet}:${colLetters}${refRow}`;
          if (!seen.has(dedupKey)) {
            seen.add(dedupKey);
            warnings.push({
              code: 'CROSS_UNIT_CELL_REF',
              sheet: s.name,
              row: fc.rowNo,
              message: `工作表“${s.name}”单元格 ${fc.address} 公式（=${fc.formula}）跨列引用了 ${targetSheet}!${rawCol}${refRow}${peerOwner ? `（该列归属“${peerOwner}”）` : ''}，与本表主数据列 ${dominant} 不一致`,
            });
          }
          continue;
        }

        if (selfUnit) {
          const targetUnit = matchOrgUnit(targetSheet, unitMatchers);
          if (targetUnit && targetUnit.key !== selfUnit.key) {
            const dedupKey = `${s.name}:${fc.address}:${targetSheet}:${colLetters}${refRow}`;
            if (!seen.has(dedupKey)) {
              seen.add(dedupKey);
              warnings.push({
                code: 'CROSS_UNIT_CELL_REF',
                sheet: s.name,
                row: fc.rowNo,
                message: `归属“${selfUnit.label}”的工作表“${s.name}”单元格 ${fc.address} 公式（=${fc.formula}）跨单位引用了归属“${targetUnit.label}”的工作表“${targetSheet}”`,
              });
            }
            continue;
          }
          const inWbTarget = bySheetName.get(targetSheet);
          if (inWbTarget && !targetUnit && colLetters !== 'A' && colLetters !== 'B') {
            const colIdx = excelColToIndex(colLetters);
            for (const headerRow of inWbTarget.rows.slice(0, 5)) {
              const headerCell = headerRow.cells[colIdx] ?? '';
              if (!headerCell) continue;
              const colUnit = matchOrgUnit(headerCell, unitMatchers);
              if (colUnit && colUnit.key !== selfUnit.key) {
                const dedupKey = `${s.name}:${fc.address}:${targetSheet}:${colLetters}${refRow}`;
                if (!seen.has(dedupKey)) {
                  seen.add(dedupKey);
                  warnings.push({
                    code: 'CROSS_UNIT_CELL_REF',
                    sheet: s.name,
                    row: fc.rowNo,
                    message: `归属“${selfUnit.label}”的工作表“${s.name}”单元格 ${fc.address} 公式（=${fc.formula}）引用了汇总表“${targetSheet}”归属“${colUnit.label}”的列 ${colLetters}`,
                  });
                }
                break;
              }
            }
          }
        }
      }
    }
  }
  return warnings;
}

const IGNORED_SHEET_PATTERNS = [
  /^目录/,
  /^sheet\d+$/i,
  /^\d{4}年?投资完成情况$/,
  /^20\d{2}\s*[-~至]\s*20\d{2}/,
  /运维\+更新改造/,
  /^填表说明$/,
];

const SHEET_ALIASES: Record<PlanSheetCode, readonly string[]> = {
  investment_tech_renovation: ['资本化更新改造', '更新改造资本化', '更新改造投资', '技改投资计划'],
  investment_info: ['信息化投资', '信息化建设计划', '信息化项目投资'],
  investment_other: ['其他投资', '其他固定资产投资', '小型基建投资'],
  investment: ['固定资产投资计划', '固定资产投资', '大中型基建及项目投资', '大中型基建与项目投资', '投资计划'],
  purchase: ['固定资产购置审核', '固定购置审核', '固定资产购置计划', '固定资产购置', '购置计划'],
  pre_work: ['前期工作费', '项目前期', '前期工作计划', '前期费'],
  capacity_add: ['新增生产能力', '新增产能计划'],
  tech_renovation_exp: ['更新改造费用化', '费用化更新改造', '更新改造（费用化）', '更新改造(费用化)'],
  maintenance: ['运行维护费', '运行维护费计划', '运行维护', '运维费'],
  safety_input: ['安全生产投入', '安全投入', '安全费用计划', '安全生产费用'],
  five_expenses: ['五项费用', '五项管理费用', '五项费用预算'],
  mgmt_fee: ['管理类费用', '管理费用', '管理费用预算'],
  mfg_fee: ['制造费用', '生产制造费用'],
  responsibility_kpi: ['经营目标责任指标', '目标责任指标', '目标责任书指标', '各单位经营指标'],
  profit_budget: ['利润预算明细', '利润预算', '利润表', '损益预算', '非电收入预算表'],
  annual_kpi: ['主要指标', '汇总表', '综合计划主要指标', '电力生产计划'],
};

export const PLAN_ID_COLUMNS = {
  seq: ['序号'],
  projectCode: ['项目编码', '项目代码', '项目编号'],
  name: ['项目名称', '名称', '资产名称', '设备名称', '费用项目', '费用名称', '指标名称', '项目', '公司', '单位名称'],
  // 不收“单位”:购置表的“单位”是计量单位(台/套)
  orgName: ['承办单位', '责任单位', '实施单位', '归口单位'],
} as const;

const COMMON_COST_FIELDS: readonly FieldDef[] = [
  { key: 'total_investment', label: '总费用', aliases: ['总费用', '总投资', '项目总投资', '预算总额'], measure: 'total', type: 'amount' },
  { key: 'completed_investment', label: '已完成金额', aliases: ['已完成金额', '已完成投资', '累计完成'], measure: 'cumulative', type: 'amount' },
  { key: 'submitted_amount', label: '申报金额', aliases: ['申报金额', '上报金额', '审前金额'], measure: 'annual_plan', type: 'amount' },
  { key: 'annual_plan', label: '年度计划', aliases: ['年度计划', '本年计划', '年度预算', '年度计划金额', '本年计划金额', '审定金额', '批复金额'], measure: 'annual_plan', type: 'amount' },
  { key: 'annual_actual', label: '年度实际', aliases: ['年度实际', '本年实际', '本年累计实际', '年度实际发生', '年度实际完成'], measure: 'annual_actual_ytd', type: 'amount' },
];

const INVEST_SUB_FIELDS: readonly FieldDef[] = [
  { key: 'approved_budget', label: '批复概算', aliases: ['批复概算', '概算', '可研概算'], measure: 'total', type: 'amount' },
  { key: 'total_investment', label: '总投资', aliases: ['总投资', '项目总投资'], measure: 'total', type: 'amount' },
  { key: 'completed_investment', label: '开工累计已完成投资', aliases: ['开工累计已完成投资', '累计完成投资', '已完成投资'], measure: 'cumulative', type: 'amount' },
  { key: 'paid_cumulative', label: '累计已付款', aliases: ['累计已付款', '已付款'], measure: 'cumulative', type: 'amount' },
  { key: 'annual_plan', label: '本年计划投资', aliases: ['本年计划投资', '年度计划投资', '年度计划', '本年计划'], measure: 'annual_plan', type: 'amount' },
  { key: 'annual_actual', label: '本年实际完成投资', aliases: ['本年实际完成投资', '年度实际完成投资', '本年完成投资', '年度实际', '本年实际'], measure: 'annual_actual_ytd', type: 'amount' },
  { key: 'physical_progress', label: '形象进度', aliases: ['形象进度'], measure: 'snapshot', type: 'ratio' },
  { key: 'progress_note', label: '形象进度说明', aliases: ['形象进度说明', '进度说明', '计划完成内容'], measure: 'snapshot', type: 'text' },
];

export const PLAN_FIELDS: Record<PlanSheetCode, readonly FieldDef[]> = {
  investment: INVEST_SUB_FIELDS,
  investment_tech_renovation: INVEST_SUB_FIELDS,
  investment_info: INVEST_SUB_FIELDS,
  investment_other: INVEST_SUB_FIELDS,
  purchase: [
    { key: 'quantity', label: '数量', aliases: ['数量'], measure: 'total', type: 'quantity' },
    { key: 'unit_price', label: '单价', aliases: ['单价'], measure: 'total', type: 'amount' },
    { key: 'total_price', label: '合价', aliases: ['合价', '总价', '申报合价'], measure: 'total', type: 'amount' },
    { key: 'annual_plan', label: '年度计划', aliases: ['年度计划', '本年计划', '年度计划金额', '审核金额', '审定金额'], measure: 'annual_plan', type: 'amount' },
    { key: 'annual_actual', label: '年度实际', aliases: ['年度实际', '本年实际', '年度实际完成', '本年完成'], measure: 'annual_actual_ytd', type: 'amount' },
  ],
  pre_work: COMMON_COST_FIELDS,
  capacity_add: [
    { key: 'equity_ratio', label: '权益比例', aliases: ['权益比例'], measure: 'snapshot', type: 'quantity' },
    { key: 'annual_plan', label: '新增容量', aliases: ['新增容量', '本年新增容量', '年度计划', '本年计划'], measure: 'annual_plan', type: 'quantity' },
    { key: 'unit_capacity', label: '单机容量', aliases: ['单机容量'], measure: 'total', type: 'quantity' },
    { key: 'unit_count', label: '台数', aliases: ['台数'], measure: 'total', type: 'quantity' },
    { key: 'annual_actual', label: '实际新增容量', aliases: ['实际新增容量', '年度实际', '本年实际'], measure: 'annual_actual_ytd', type: 'quantity' },
  ],
  tech_renovation_exp: COMMON_COST_FIELDS,
  maintenance: COMMON_COST_FIELDS,
  safety_input: COMMON_COST_FIELDS,
  five_expenses: COMMON_COST_FIELDS,
  mgmt_fee: COMMON_COST_FIELDS,
  mfg_fee: COMMON_COST_FIELDS,
  annual_kpi: [
    { key: 'annual_plan', label: '本年计划', aliases: ['年度计划', '本年计划', '计划值'], measure: 'annual_plan', type: 'amount' },
    { key: 'annual_actual', label: '本年实际', aliases: ['年度实际', '本年实际', '实际值'], measure: 'annual_actual_ytd', type: 'amount' },
  ],
  profit_budget: [
    { key: 'annual_plan', label: '本年预算', aliases: ['年度计划', '本年计划', '本年预算', '预算数', '合并预算'], measure: 'annual_plan', type: 'amount' },
    { key: 'annual_actual', label: '本年实际', aliases: ['年度实际', '本年实际', '实际数'], measure: 'annual_actual_ytd', type: 'amount' },
  ],
  responsibility_kpi: [
    { key: 'annual_plan', label: '责任目标值', aliases: ['年度计划', '本年计划', '目标值', '考核目标', '计划总收入'], measure: 'annual_plan', type: 'amount' },
    { key: 'net_profit_plan', label: '计划净利润', aliases: ['计划净利润', '净利润目标'], measure: 'total', type: 'amount' },
    { key: 'annual_actual', label: '实际完成值', aliases: ['年度实际', '本年实际', '实际完成', '实际总收入'], measure: 'annual_actual_ytd', type: 'amount' },
  ],
};

export interface ParsedPlanFact { fieldKey: string; measure: PlanMeasure; valueType: PlanValueType; amount: bigint | null; scaled: bigint | null; text: string | null; sourceCell: string }
export interface ParsedPlanItem {
  sheetCode: PlanSheetCode; rowNo: number; seqNo: string; itemName: string; itemType: 'detail' | 'category' | 'subtotal'; path: string;
  projectCode: string; orgText: string; sectionOrgHint: string;
  submittedCents: bigint | null; approvedCents: bigint | null;
  costNature: '' | 'capitalized' | 'expensed' | 'recurrent' | 'special';
  fundingChannel: '' | 'equity_capital' | 'debt_financing' | 'self_owned' | 'fiscal';
  warnings: PlanWarningDto[];
  facts: ParsedPlanFact[];
}
export interface ParsedPlanSheet { code: PlanSheetCode; sourceName: string; unit: AmountUnit; items: ParsedPlanItem[] }
export interface ParsedPlanWorkbook { sheets: ParsedPlanSheet[]; ignoredSheets: string[]; errors: RowError[]; warnings: PlanWarningDto[] }

function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const ROMAN_SEQ = /^[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫIVX]+[、.．]?$/i;
const CHINESE_TOP_SEQ = /^[一二三四五六七八九十百]+[、.．]?$/;
const CHINESE_PAREN_SEQ = /^[（(]\s*[一二三四五六七八九十百]+\s*[）)]$/;
const SUBTOTAL_NAME = /(合计|小计|总计)/;
const ASSET_SUMMARY_NAME = /^(生产性固定资产|非生产性固定资产|固定资产购置)$/;
const NIL_CELL = /^(-+|—+|\/|无)$/;

/** 纯十进制字符串四舍五入截断（避免 Excel 公式 /1.06 产生 >6 位无限循环小数阻断解析，零浮点运算）。 */
function roundDecimalHalfUpText(raw: string, maxDecimals: number): string {
  const trimmed = raw.replace(/,/g, '').trim();
  const m = /^([+-]?)(\d+)\.(\d+)$/.exec(trimmed);
  if (!m) return raw;
  const [, sign, intPart, fracPart] = m;
  if (fracPart.length <= maxDecimals) return raw;
  const keep = fracPart.slice(0, maxDecimals);
  const nextDigit = Number(fracPart[maxDecimals]);
  const scale = 10n ** BigInt(maxDecimals);
  let scaled = BigInt(intPart) * scale + (maxDecimals > 0 ? BigInt(keep) : 0n);
  if (nextDigit >= 5) scaled += 1n;
  const nextInt = scaled / scale;
  const nextFrac = maxDecimals > 0 ? String(scaled % scale).padStart(maxDecimals, '0') : '';
  return maxDecimals > 0 ? `${sign}${nextInt}.${nextFrac}` : `${sign}${nextInt}`;
}

export function sheetCodeOf(name: string): PlanSheetCode | null {
  const key = name.replace(/\s+/g, '');
  if (IGNORED_SHEET_PATTERNS.some((re) => re.test(key))) return null;
  for (const [code, aliases] of Object.entries(SHEET_ALIASES) as [PlanSheetCode, readonly string[]][]) {
    if (aliases.some((a) => key === a || key.includes(a))) return code;
  }
  return null;
}

/** 设置页维护的导入字段别名:表 → 字段 key(含标识列 seq/projectCode/name/orgName)→ 追加别名。 */
export type PlanExtraAliases = Partial<Record<PlanSheetCode, Readonly<Record<string, readonly string[]>>>>;
const withExtra = (aliases: readonly string[], extra: readonly string[] | undefined) => (extra?.length ? [...new Set([...aliases, ...extra])] : aliases);

/** 构造带年份的动态计划列别名（如 "公司2026年计划投资"、"2026年计划金额"、"2026年计划"）。 */
function yearPlanAliases(year: number): string[] {
  return [
    `${year}年计划投资`,
    `公司${year}年计划投资`,
    `${year}年计划金额`,
    `${year}年计划`,
    `${year}年预算`,
    `${year}年度计划`,
  ];
}

function yearActualAliases(year: number): string[] {
  return [
    `${year}年实际完成投资`,
    `${year}年实际金额`,
    `${year}年实际`,
    `${year}年累计实际`,
  ];
}

/** 合并两行复合表头（如各单位经营指标“2026年计划 -> 总收入/净利润”或新增生产能力“新增装机情况 -> 单机容量/台数”）。 */
function flattenTwoRowHeaderIfNeeded(rows: MatrixRow[], year: number): MatrixRow[] {
  for (let i = 0; i < Math.min(rows.length - 1, 10); i++) {
    const top = rows[i].cells.map(normalizeHeaderText);
    const sub = rows[i + 1].cells.map(normalizeHeaderText);
    const hasCompanyCol = top[0] === '公司' || top[0] === '单位名称';
    const hasCapacityGroup = top.includes('新增装机情况') && (sub.includes('单机容量') || sub.includes('台数'));
    if (!hasCompanyCol && !hasCapacityGroup) continue;
    const merged: string[] = [];
    let groupLabel = '';
    const maxLen = Math.max(top.length, sub.length);
    for (let c = 0; c < maxLen; c++) {
      if (top[c]) groupLabel = top[c];
      const s = sub[c] ?? '';
      if (hasCompanyCol && s && groupLabel) {
        if (groupLabel.includes(`${year}年计划`) && s === '总收入') merged.push('计划总收入');
        else if (groupLabel.includes(`${year}年计划`) && s === '净利润') merged.push('计划净利润');
        else if (groupLabel.includes(`${year - 1}年计划`) && s === '总收入' && !top.some((t) => t.includes(`${year}年计划`))) merged.push(`${year - 1}年计划总收入`);
        else merged.push(`${groupLabel}_${s}`);
      } else if (hasCapacityGroup && s && (!top[c] || top[c] === '新增装机情况' || top[c] === '投产时间')) {
        merged.push(s);
      } else {
        merged.push(top[c] || s);
      }
    }
    const clone = rows.slice();
    clone[i] = { rowNo: rows[i].rowNo, cells: merged };
    clone.splice(i + 1, 1);
    return clone;
  }
  return rows;
}

function inferCostNature(code: PlanSheetCode, path: string, itemName: string): ParsedPlanItem['costNature'] {
  if (code === 'investment' || code === 'investment_tech_renovation' || code === 'investment_info' || code === 'investment_other' || code === 'purchase') {
    return 'capitalized';
  }
  if (code === 'tech_renovation_exp') return 'expensed';
  const combined = `${path}/${itemName}`;
  if (combined.includes('经常性')) return 'recurrent';
  if (combined.includes('专项')) return 'special';
  return '';
}

export function parsePlanWorkbook(
  sheets: ReadSheet[],
  year: number,
  extraAliases: PlanExtraAliases = {},
  opts: { isLegacyXls?: boolean; unitMatchers?: UnitFormulaMatcher[] } = {}
): ParsedPlanWorkbook {
  const errors: RowError[] = [];
  const crossFormulaWarnings = scanWorkbookCrossUnitFormulas(sheets, opts.unitMatchers ?? []);
  const warnings: PlanWarningDto[] = [...crossFormulaWarnings];
  const out: ParsedPlanSheet[] = [];
  const ignored: string[] = [];
  const seen = new Set<PlanSheetCode>();

  const candidateCount = sheets.filter((s) => sheetCodeOf(s.name) !== null).length;
  const multiDomainMode = Boolean(opts.isLegacyXls) || candidateCount >= 4;

  for (const sheet of sheets) {
    const code = sheetCodeOf(sheet.name);
    if (!code || seen.has(code)) { ignored.push(sheet.name); continue; }

    // 略过仅写“见财务报表”或无实质表头的空壳附表（如 02-2.非电收入预算表）
    const nonEmptyRows = sheet.rows.filter((r) => r.cells.some((c) => c.trim() !== ''));
    const flatText = nonEmptyRows.flatMap((r) => r.cells).join(' ');
    if (nonEmptyRows.length <= 3 && (flatText.includes('见财务报表') || nonEmptyRows.length < 2)) {
      ignored.push(sheet.name);
      warnings.push({
        code: 'PLACEHOLDER_SHEET_SKIPPED',
        sheet: sheet.name,
        row: nonEmptyRows[0]?.rowNo ?? 1,
        message: `工作表“${sheet.name}”为引用说明或空表（“见财务报表”），已自动略过`,
      });
      continue;
    }

    seen.add(code);
    const label = PLAN_SHEET_LABELS[code];
    const extra = extraAliases[code] ?? {};
    const dynPlanAliases = yearPlanAliases(year);
    const dynActualAliases = yearActualAliases(year);
    const fields = PLAN_FIELDS[code].map((f) => ({
      ...f,
      aliases: f.key === 'annual_plan'
        ? withExtra([...f.aliases, ...dynPlanAliases], extra[f.key])
        : f.key === 'annual_actual'
          ? withExtra([...f.aliases, ...dynActualAliases], extra[f.key])
          : withExtra(f.aliases, extra[f.key]),
    }));
    const idColumns = Object.fromEntries(Object.entries(PLAN_ID_COLUMNS).map(([k, a]) => [k, withExtra(a, extra[k])])) as Record<keyof typeof PLAN_ID_COLUMNS, readonly string[]>;
    const annualPlan = fields.find((f) => f.key === 'annual_plan')!;
    const normalizedSheet: ReadSheet = { ...sheet, rows: flattenTwoRowHeaderIfNeeded(sheet.rows, year) };

    let staleHeaderYear: string | null = null;
    let table;
    try {
      table = sheetTable(normalizedSheet, {
        label: `${label}表头(名称列与年度计划列)`,
        allowDuplicateHeaders: true,
        isHeader: (cells) => {
          const keys = cells.map(headerKey);
          const hasName = idColumns.name.some((a) => keys.includes(a));
          if (!hasName) return false;
          if (annualPlan.aliases.some((a) => keys.includes(a))) return true;
          // 兼容购置表仅有“合价”无“年度计划/审核金额”列，或滞后年份列头（如 2025年计划金额）
          if (code === 'purchase' && keys.includes('合价')) return true;
          const staleHit = keys.find((k) => /^(\d{4})年计划(金额|投资|总收入)?$/.test(k));
          if (staleHit) {
            const m = /^(\d{4})年/.exec(staleHit);
            if (m && Number(m[1]) !== year) staleHeaderYear = m[1];
            return true;
          }
          return false;
        },
      });
    } catch (e) {
      errors.push({ row: 0, field: label, message: (e as Error).message });
      continue;
    }
    const headerRowNo = table.headerRowNo!;
    const above = normalizedSheet.rows.filter((r) => r.rowNo < headerRowNo).flatMap((r) => r.cells).join(' ');
    const yearHit = /(\d{4})\s*年/.exec(above);
    if (yearHit && Number(yearHit[1]) !== year) {
      if (multiDomainMode || code !== 'investment') {
        warnings.push({
          code: 'STALE_YEAR_HEADER',
          sheet: sheet.name,
          row: headerRowNo,
          headerYearRaw: `${yearHit[1]}年`,
          message: `${label}标题年份为 ${yearHit[1]}年（上传年度 ${year}），已按容缺提示保留`,
        });
      } else {
        errors.push({ row: headerRowNo, field: label, message: `表头年度 ${yearHit[1]} 与上传年度 ${year} 不一致` });
        continue;
      }
    }
    if (staleHeaderYear) {
      warnings.push({
        code: 'STALE_YEAR_HEADER',
        sheet: sheet.name,
        row: headerRowNo,
        headerYearRaw: `${staleHeaderYear}年`,
        message: `${label}列头留存滞后年份“${staleHeaderYear}年计划”，已自动映射至本年计划并记录提醒`,
      });
    }

    const sheetUnit: AmountUnit = /单位[:：]?\s*元/.test(above) && !/单位[:：]?\s*万元/.test(above) ? 'yuan' : 'wan';
    const headerRow = normalizedSheet.rows.find((r) => r.rowNo === headerRowNo)!;
    const colIndex = new Map(headerRow.cells.map((c, i) => [normalizeHeaderText(c), i] as const));
    const idCol = Object.fromEntries(Object.entries(idColumns).map(([k, a]) => [k, findHeader(table.headers, a)])) as Record<keyof typeof PLAN_ID_COLUMNS, string | null>;
    const unitMeasureHeader = findHeader(table.headers, ['计量单位', '单位']);

    const fieldCols = fields.map((f) => {
      let header = findHeader(table.headers, f.aliases);
      if (!header && f.key === 'annual_plan') {
        if (code === 'purchase') header = findHeader(table.headers, ['合价']);
        if (!header && staleHeaderYear) {
          header = findHeader(table.headers, [`${staleHeaderYear}年计划金额`, `${staleHeaderYear}年计划投资`, `${staleHeaderYear}年计划`, `${staleHeaderYear}年计划总收入`]);
        }
      }
      return { def: f, header };
    }).filter((f) => f.header);

    // 预扫描点分序号父行（如 seq="2" 后紧跟 "2.1"，则 "2" 为分类汇总行，防止与子明细重复加总）
    const parentSeqRowNos = new Set<number>();
    for (let idx = 0; idx < table.rows.length - 1; idx++) {
      const curSeq = idCol.seq ? (table.rows[idx].values[idCol.seq] ?? '').trim() : '';
      if (!/^\d+(\.\d+)*$/.test(curSeq)) continue;
      for (let nextIdx = idx + 1; nextIdx < Math.min(idx + 5, table.rows.length); nextIdx++) {
        const nextSeq = idCol.seq ? (table.rows[nextIdx].values[idCol.seq] ?? '').trim() : '';
        if (!nextSeq) continue;
        if (nextSeq.startsWith(`${curSeq}.`)) parentSeqRowNos.add(table.rows[idx].rowNo);
        break;
      }
    }

    const items: ParsedPlanItem[] = [];
    const categories: string[] = [];
    let sectionOrgHint = '';
    let seenFooterTotal = false;

    for (const r of table.rows) {
      const v = (h: string | null) => (h ? r.values[h] ?? '' : '');
      const name = v(idCol.name);
      const seqNo = v(idCol.seq).trim();
      const rowErr = (field: string, message: string) => errors.push({ row: r.rowNo, field: `${label}·${field}`, message });
      if (!name) {
        if (seenFooterTotal) continue;
        if (fieldCols.some((f) => v(f.header)) || v(idCol.projectCode)) rowErr('名称', '名称为空');
        continue;
      }

      const isRoman = ROMAN_SEQ.test(seqNo);
      const isChineseTop = CHINESE_TOP_SEQ.test(seqNo);
      const isChineseParen = CHINESE_PAREN_SEQ.test(seqNo);
      const isSubtotal = SUBTOTAL_NAME.test(name) || SUBTOTAL_NAME.test(seqNo) || seenFooterTotal;
      if (SUBTOTAL_NAME.test(seqNo) || /^(合计|总计)$/.test(name)) {
        seenFooterTotal = true;
      }
      const isAssetSection = seqNo === '' && ASSET_SUMMARY_NAME.test(name);
      const isDottedParent = parentSeqRowNos.has(r.rowNo);

      const itemType: ParsedPlanItem['itemType'] = isSubtotal
        ? 'subtotal'
        : isRoman || isChineseTop || isChineseParen || isAssetSection || isDottedParent
          ? 'category'
          : 'detail';

      if (itemType === 'category') {
        if (isRoman) {
          categories.splice(0);
          sectionOrgHint = name;
        } else if (isChineseTop) {
          categories.splice(categories.length > 0 && ROMAN_SEQ.test(items.find((it) => it.itemName === categories[0])?.seqNo ?? '') ? 1 : 0);
          if (!ASSET_SUMMARY_NAME.test(name) && /(总部|公司|电站|分公司|风电场|中心|部|基地)/.test(name)) {
            sectionOrgHint = v(idCol.orgName) || name;
          }
        } else if (isChineseParen) {
          categories.splice(Math.min(categories.length, 2));
          if (/(本部|公司|电站|分公司|风电场|中心|部)/.test(name)) {
            sectionOrgHint = v(idCol.orgName) || name;
          }
        } else if (isDottedParent) {
          categories.splice(Math.min(categories.length, 3));
        }
        categories.push(name);
      }

      const rowUnitText = unitMeasureHeader ? v(unitMeasureHeader).trim() : '';
      const facts: ParsedPlanFact[] = [];
      let submittedCents: bigint | null = null;
      let approvedCents: bigint | null = null;

      for (const { def, header } of fieldCols) {
        const text = v(header).trim();
        if (text === '' || NIL_CELL.test(text)) continue;
        const sourceCell = `${label}!${columnLetter(colIndex.get(normalizeHeaderText(header!)) ?? 0)}${r.rowNo}`;
        try {
          // 主要指标/电力计划行带“计量单位”列时按实际量纲分流（万千瓦/万千瓦时/% 不误按金额折算）
          let effectiveType: PlanValueType = def.type;
          if (def.type === 'amount' && (code === 'annual_kpi' || code === 'capacity_add') && rowUnitText) {
            if (rowUnitText === '%' || text.endsWith('%')) effectiveType = 'ratio';
            else if (!rowUnitText.includes('元')) effectiveType = 'quantity';
          }

          if (effectiveType === 'amount') {
            const unit = headerUnit(header!) ?? (rowUnitText === '元' ? 'yuan' : rowUnitText === '万元' ? 'wan' : sheetUnit);
            const normalizedText = multiDomainMode ? roundDecimalHalfUpText(text, unit === 'wan' ? 6 : 2) : text;
            const amount = amountCents(normalizedText, unit, def.label);
            if (amount !== null) {
              facts.push({ fieldKey: def.key, measure: def.measure, valueType: 'amount', amount, scaled: null, text: null, sourceCell });
              if (def.key === 'total_price' || def.key === 'submitted_amount') submittedCents = amount;
              if (def.key === 'annual_plan') approvedCents = amount;
            }
          } else if (effectiveType === 'quantity') {
            const normalizedText = multiDomainMode ? roundDecimalHalfUpText(text, QUANTITY_SCALE) : text;
            const q = quantityScaled(normalizedText, def.label);
            if (q !== null) facts.push({ fieldKey: def.key, measure: def.measure, valueType: 'quantity', amount: null, scaled: q, text: null, sourceCell });
          } else if (effectiveType === 'ratio') {
            const normalizedText = multiDomainMode && !text.endsWith('%') ? roundDecimalHalfUpText(text, 6) : text;
            const ratio = ratioScaledCell(normalizedText, def.label);
            if (ratio !== null) facts.push({ fieldKey: def.key, measure: def.measure, valueType: 'ratio', amount: null, scaled: ratio, text: null, sourceCell });
          } else {
            facts.push({ fieldKey: def.key, measure: def.measure, valueType: 'text', amount: null, scaled: null, text: text.slice(0, 500), sourceCell });
          }
        } catch (e) {
          if (e instanceof CellError) rowErr(def.label, e.message); else throw e;
        }
      }

      const projectCode = v(idCol.projectCode);
      const orgText = v(idCol.orgName) || (code === 'responsibility_kpi' ? name : '');
      const rowWarnings: PlanWarningDto[] = [];

      if (itemType === 'detail') {
        if (code === 'investment' && !projectCode) {
          if (idCol.projectCode && !orgText && !sectionOrgHint && !multiDomainMode) {
            rowErr('项目编码', '投资明细行缺项目编码');
          } else {
            const w: PlanWarningDto = {
              code: 'MISSING_PROJECT_CODE',
              sheet: sheet.name,
              row: r.rowNo,
              message: `第 ${r.rowNo} 行“${name}”未提供项目编码，已按组织+路径+名称生成确定性 item_key`,
            };
            rowWarnings.push(w);
            warnings.push(w);
          }
        } else if (
          code !== 'investment' &&
          code !== 'annual_kpi' &&
          code !== 'capacity_add' &&
          code !== 'profit_budget' &&
          !projectCode &&
          !orgText &&
          !sectionOrgHint
        ) {
          rowErr('承办单位', '明细行缺承办单位(或项目编码)');
        }
      }

      const pathStr = itemType === 'category' ? categories.slice(0, -1).join('/') : categories.join('/');
      for (const cw of crossFormulaWarnings) {
        if (cw.sheet === sheet.name && cw.row === r.rowNo) {
          rowWarnings.push(cw);
        }
      }
      items.push({
        sheetCode: code, rowNo: r.rowNo, seqNo: seqNo.slice(0, 20), itemName: name.slice(0, 200), itemType,
        path: pathStr,
        projectCode,
        orgText,
        sectionOrgHint,
        submittedCents,
        approvedCents,
        costNature: inferCostNature(code, pathStr, name),
        fundingChannel: '',
        warnings: rowWarnings,
        facts,
      });
    }
    out.push({ code, sourceName: sheet.name, unit: sheetUnit, items });
  }
  if (out.length === 0 && errors.length === 0) {
    errors.push({ row: 0, field: '工作簿', message: `未找到计划执行工作表(${Object.values(PLAN_SHEET_LABELS).join('、')})` });
  }
  return { sheets: out, ignoredSheets: ignored, errors, warnings };
}

export function factValueText(f: { valueType: PlanValueType; amount: bigint | null; scaled: bigint | null; text: string | null }): string {
  if (f.valueType === 'amount') return formatScaled(f.amount!, 2);
  if (f.valueType === 'quantity') return formatScaled(f.scaled!, QUANTITY_SCALE, false);
  if (f.valueType === 'ratio') return formatScaled(f.scaled!, 6);
  return f.text ?? '';
}

export function fieldLabel(sheet: PlanSheetCode, key: string): string {
  return PLAN_FIELDS[sheet].find((f) => f.key === key)?.label ?? key;
}
