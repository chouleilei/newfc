import type { MoneyString, RatioString } from './common';

/**
 * 项目档案(360 视图):主数据 + 各域同源只读汇总。
 * 每个分区按该域读权限独立裁剪:无权限为 null(页面不展示),有权限无数据为空集合;组织范围与各域列表同口径。
 */

export interface ProjectProfileBudgetDto {
  /** 当前批次;没有当前批次时为 null,金额为 0。 */
  batch: { id: number; year: number; period: string } | null;
  budget: MoneyString; executed: MoneyString; rate: RatioString | null;
  rows: { fundSource: string; expenseCategory: string; orgName: string; execMonth: string; budget: MoneyString; executed: MoneyString }[];
}
export interface ProjectProfilePlanDto {
  batch: { id: number; year: number; actualPeriod: string } | null;
  items: { itemId: number; sheetCode: string; itemName: string; orgName: string; facts: { key: string; label: string; valueType: string; value: string }[] }[];
}
export interface ProjectProfileContractsDto {
  count: number; currentTotal: MoneyString; paidTotal: MoneyString; paidRate: RatioString | null;
  rows: {
    id: number; contractNo: string; name: string; supplierName: string | null; orgName: string; stage: string; status: string;
    current: MoneyString; paid: MoneyString; signDate: string | null; documents: Record<string, number>;
  }[];
  payments: { id: number; contractId: number; contractNo: string; nodeName: string; amount: MoneyString; status: string; paidDate: string | null; voucherNo: string | null }[];
}
export interface ProjectProfileVouchersDto {
  projectCodes: string[]; lineCount: number; debitTotal: MoneyString; creditTotal: MoneyString;
  lines: { batchId: number; period: string; orgName: string; voucherDate: string | null; voucherNo: string; accountCode: string; accountName: string; summary: string | null; debit: MoneyString; credit: MoneyString }[];
}
export interface ProjectProfileRisksDto {
  openCount: number; total: number;
  rows: { id: number; ruleCode: string; ruleName: string; level: string; status: string; title: string; amount: MoneyString | null; lastDetectedAt: string }[];
}
export interface ProjectProfileInvestmentDto {
  control: null | {
    id: number; approved: MoneyString | null; status: string;
    versions: { id: number; versionType: string; name: string; staticAmount: MoneyString; dynamicAmount: MoneyString; approvalDate: string | null }[];
    latestComparison: { id: number; createdAt: string; totalDeviation: MoneyString; totalDeviationRate: RatioString | null } | null;
  };
  feasibility: { id: number; code: string; name: string; status: string; scenarioCount: number }[];
}
export interface ProjectProfileReportDto { id: number; title: string; kind: string; year: number | null; status: string; orgName: string | null; updatedAt: string }
export interface ProjectProfileLogDto { id: number; action: string; entityType: string; entityId: string; actor: string | null; result: string; createdAt: string }

export interface ProjectProfileDto {
  project: {
    id: number; code: string; name: string; projectType: string; orgId: number; orgName: string; status: 'active' | 'inactive';
    extra: Record<string, unknown>; createdAt: string; updatedAt: string;
  };
  budget: ProjectProfileBudgetDto | null;
  plan: ProjectProfilePlanDto | null;
  contracts: ProjectProfileContractsDto | null;
  vouchers: ProjectProfileVouchersDto | null;
  risks: ProjectProfileRisksDto | null;
  investment: ProjectProfileInvestmentDto | null;
  reports: ProjectProfileReportDto[] | null;
  logs: ProjectProfileLogDto[] | null;
  generatedAt: string;
}
