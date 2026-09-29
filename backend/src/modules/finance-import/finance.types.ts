export const FINANCE_WEIGHT_SCALE = 1_000_000;

export interface NormalizedFinanceRow {
  sourceSheet: string;
  sourceRow: number;
  bookCode: string;
  orgCode: string;
  orgName: string;
  accountCode: string;
  accountName: string;
  auxiliary: Record<string, string>;
  cumulativeDebitCents: number;
  cumulativeCreditCents: number;
  year: number;
  snapshotDate: string;
}

export interface NormalizedProfitRow {
  sourceSheet: string;
  sourceRow: number;
  item: string;
  amountCents: number;
  year: number;
  snapshotDate: string;
}

export interface FinanceProfileConfig {
  balanceSheetNames?: string[];
  profitSheetNames?: string[];
  journalSheetNames?: string[];
  balanceLayout?: 'single_header'|'two_row_cumulative';
  headerSearchRows?: number;
  balanceColumns?: Partial<Record<'bookCode'|'orgCode'|'orgName'|'accountCode'|'accountName'|'debit'|'credit'|'year'|'snapshotDate', string[]>>;
  profitColumns?: Partial<Record<'item'|'amount'|'year'|'snapshotDate', string[]>>;
  auxiliaryColumns?: Record<string, string[]>;
  /** 双层余额表没有这些列时，由数据源配置提供并随转换批次固化。 */
  fixedBookCode?: string;
  fixedOrgCode?: string;
  fixedOrgName?: string;
  /** 只进入预算转换的源科目前缀；范围外非零行保留审计计数，不静默参与金额。 */
  sourceAccountIncludePrefixes?: string[];
  journalCompanyName?: string;
  journalRequired?: boolean;
  journalToleranceCents?: number;
  ownedOrgCodes?: string[];
  ownedAccountCodes?: string[];
  amountUnit?: 'yuan'|'wan';
  maxRows?: number;
  maxOutputBytes?: number;
}

export interface ValidationIssue {
  gate: 'parse'|'mapping'|'conservation'|'reconciliation'|'journal'|'sequence'|'output';
  code: string;
  message: string;
  sourceSheet?: string;
  sourceRow?: number;
}

export interface ReconciliationResult {
  item: string;
  targetType: 'account'|'metric';
  targetCode: string;
  officialCents: number;
  mappedCents: number;
  differenceCents: number;
  toleranceCents: number;
  passed: boolean;
  /** optional 规则缺失/重复时留痕:未执行勾稽,不产生错误但必须在报告可见 */
  skipped?: 'missing'|'duplicate';
}

export interface ConvertedRow {
  year: number;
  snapshotDate: string;
  orgId: number;
  orgCode: string;
  accountId: number;
  accountCode: string;
  accountType: 'income'|'cost'|'expense';
  /** UI 输入口径:收入正、成本费用正；可为负数表示冲销。 */
  displayCents: number;
}

export interface FinanceValidationReport {
  passed: boolean;
  counts: { sourceRows: number; nonZeroRows: number; organizations: number; sourceAccounts: number; outputRows: number; excludedNonZeroRows?: number };
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  conservation: {
    sourceCents: number; allocatedCents: number; differenceCents: number; passed: boolean;
    byCategory?: Record<string, { sourceCents:number; allocatedCents:number; differenceCents:number; passed:boolean }>;
    bySourceAccount?: Record<string, { sourceCents:number; allocatedCents:number; differenceCents:number; passed:boolean }>;
    bySourceOrganization?: Record<string, { sourceCents:number; allocatedCents:number; differenceCents:number; passed:boolean }>;
  };
  reconciliations: ReconciliationResult[];
  journalVerification?: JournalVerificationResult;
  systemMetrics?: Record<string, number>;
  hashes: { balanceSha256: string; profitSha256: string; journalSha256?: string; outputSha256?: string };
}

export interface JournalDifference {
  accountCode: string;
  accountName: string;
  balanceDebitCents: number;
  journalDebitCents: number;
  debitDifferenceCents: number;
  balanceCreditCents: number;
  journalCreditCents: number;
  creditDifferenceCents: number;
}

export interface JournalVerificationResult {
  provided: boolean;
  passed: boolean;
  sourceRows: number;
  includedRows: number;
  ignoredOtherPeriodRows: number;
  ignoredUnpostedRows: number;
  /** 多公司序时簿中非配置公司的行数(留痕,不参与核验) */
  ignoredOtherCompanyRows: number;
  accountCount: number;
  matchedCount: number;
  mismatchCount: number;
  toleranceCents: number;
  differences: JournalDifference[];
}
