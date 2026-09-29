import type { NormalizedFinanceRow, NormalizedProfitRow, FinanceProfileConfig, JournalVerificationResult } from '../finance.types';

export interface FinanceParseContext { year: number; snapshotDate: string; config: FinanceProfileConfig }
export interface FinanceAdapter {
  parseBalance(buffer: Buffer, context: FinanceParseContext): Promise<NormalizedFinanceRow[]>;
  parseProfit(buffer: Buffer, context: FinanceParseContext): Promise<NormalizedProfitRow[]>;
  verifyJournal?(buffer: Buffer, balance: NormalizedFinanceRow[], context: FinanceParseContext): Promise<JournalVerificationResult>;
}
