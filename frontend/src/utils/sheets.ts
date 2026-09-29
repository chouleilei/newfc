import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

/**
 * 预设表(模板表格)定义:统一入口。
 * - 数据库注册表 /api/sheets:可自助增删改(收入成本表/发电收入/非电收入/非电营业成本/管理费用/人工成本表…);
 * - 前端内置特殊视图(special,不可编辑):利润表(指标行)、一级汇总(全部一级科目各一行)、全部科目。
 * collapsed 的科目在该表内显示为单行汇总,明细在专属表录入(与模板各表层级一致)。
 */

export interface SheetDef {
  key: string;
  name: string;
  roots: string[];
  collapsed?: string[];
  metric?: boolean;
  special?: boolean;
}

export interface SheetDto {
  id: number;
  code: string;
  name: string;
  rootCodes: string[];
  collapsedCodes: string[];
  sortOrder: number;
  status: string;
}

export const SPECIAL_SHEETS: SheetDef[] = [
  { key: 'profit', name: '利润表', roots: [], metric: true, special: true },
  { key: 'overview', name: '一级汇总', roots: [], collapsed: [], special: true },
  { key: 'all', name: '全部科目', roots: [], special: true },
];

/**
 * 利润表行布局:与预算模板「利润表」sheet 逐行对应(15 行)。
 * metric 行 = 报表指标自动计算(P01~P05);account 行 = 科目子树带符号汇总取数(只读)。
 * 模板"资产减值损失"行对应科目 C4 信用减值损失(处置损益)。
 * P06 总成本属管理口径（含营业外支出和所得税费用、不含增值税）,不在法定利润表行内展示。
 */
export interface ProfitRowDef {
  kind: 'metric' | 'account';
  code: string;
  label: string;
  indent: number; // 0=一/二/三/四/五级小计行 1=其中/加/减 2=明细项
  bold: boolean;  // 小计行加粗
}
export const PROFIT_ROWS: ProfitRowDef[] = [
  { kind: 'metric', code: 'P01', label: '一、营业总收入', indent: 0, bold: true },
  { kind: 'metric', code: 'P02', label: '二、营业总成本', indent: 0, bold: true },
  { kind: 'account', code: 'C1', label: '其中：营业成本', indent: 1, bold: false },
  { kind: 'account', code: 'C3', label: '税金及附加', indent: 2, bold: false },
  { kind: 'account', code: 'E1', label: '销售费用', indent: 2, bold: false },
  { kind: 'account', code: 'E2', label: '管理费用', indent: 2, bold: false },
  { kind: 'account', code: 'E3', label: '财务费用', indent: 2, bold: false },
  { kind: 'account', code: 'C4', label: '资产减值损失', indent: 2, bold: false },
  { kind: 'account', code: 'I2', label: '加：投资收益', indent: 1, bold: false },
  { kind: 'metric', code: 'P03', label: '三、营业利润', indent: 0, bold: true },
  { kind: 'account', code: 'I3', label: '加：营业外收入', indent: 1, bold: false },
  { kind: 'account', code: 'C5', label: '减：营业外支出', indent: 1, bold: false },
  { kind: 'metric', code: 'P04', label: '四、利润总额', indent: 0, bold: true },
  { kind: 'account', code: 'C6', label: '减：所得税费用', indent: 1, bold: false },
  { kind: 'metric', code: 'P05', label: '五、净利润', indent: 0, bold: true },
];

/**
 * 各预设表的计算行(模板中的汇总计算行,如收入成本表的总收入/总成本/利润总额/净利润)。
 * metric 行按指标公式自动计算,插入位置锚定在根科目之前(beforeRoot);省略 beforeRoot 则排在表末尾。
 * 仅收入成本表(master)有计算行;各明细表的"合计/汇总"行即其根科目汇总行,无需另设。
 */
export interface SheetMetricRowDef {
  metricCode: string;
  label: string;
  beforeRoot?: string;
}
export const SHEET_METRIC_ROWS: Record<string, SheetMetricRowDef[]> = {
  master: [
    { metricCode: 'P07', label: '总收入', beforeRoot: 'I1' },
    { metricCode: 'P06', label: '总成本', beforeRoot: 'C1' },
    { metricCode: 'P04', label: '利润总额', beforeRoot: 'C6' },
    { metricCode: 'P05', label: '净利润' },
  ],
};

/**
 * 水电与风电等生产现场电站组织编码:
 * 010102 江垭电站 (LS_JY)
 * 010103 皂市电站 (LS_ZS)
 * 010402 新化大熊山 (LN_XHDXS)
 * 010403 双牌湘澧 (LN_SPXL)
 * 01040401 六字界风电场
 * 01040402 白竹风电场
 * 01040403 磨子岭风电场
 * 010404 全州优能 (LN_QZYN)
 * 这些电站生产现场发生的「管理类费用」在会计与预算上全部归集计入「C1101 制造费用(营业成本)」，其余非电/总部主体计入「E2 管理费用」。
 */
export const POWER_STATION_ORG_CODES = new Set([
  '010102',
  '010103',
  '010402',
  '010403',
  '010404',
  '01040401',
  '01040402',
  '01040403',
]);

export function useSheets() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['sheets'], queryFn: () => api.get<{ items: SheetDto[] }>('/sheets') });
  const sheets = useMemo<SheetDef[]>(() => (data?.items ?? []).map((s) => ({
    key: s.code,
    name: s.name,
    roots: s.rootCodes,
    collapsed: s.collapsedCodes,
  })), [data]);
  return {
    sheets,
    loading: isLoading,
    /** 预设表变更后刷新 */
    refresh: () => qc.invalidateQueries({ queryKey: ['sheets'] }),
  };
}

/** 在「内置特殊视图 + 数据库预设表」合并列表中查找 */
export function findSheet(key: string, dbSheets: SheetDef[]): SheetDef | undefined {
  return [...SPECIAL_SHEETS, ...dbSheets].find((s) => s.key === key);
}

/**
 * 该表是否存在可直接录入的单元格。
 * 预设表(收入成本表/发电收入/…)按根科目展开到末级,可录入;
 * 利润表(指标计算行)、一级汇总与全部科目是只读汇总视图,根科目清单为空。
 */
export function isWritableSheet(sheet: SheetDef | undefined): boolean {
  return sheet != null && sheet.metric !== true && sheet.roots.length > 0;
}

/**
 * 首选「可填写」预设表:实际录入页首次进入的落点。
 * dbSheets 由后端按 sort_order 返回,故第一张即可填写的主表。
 * 无预设表时返回 null:调用方保持当前视图并给出切换引导,不落在一张没有输入格的表上。
 */
export function pickWritableSheet(dbSheets: SheetDef[]): string | null {
  return dbSheets.find((s) => isWritableSheet(s))?.key ?? null;
}
