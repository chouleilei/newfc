/**
 * 财务实际数转换模块的助手只读视图。
 *
 * 背景(实测发现的盲区)：助手原来没有任何 finance-import 工具，问「上次财务转换为什么失败、
 * 映射有没有漏科目」时模型只能在导入批次和操作日志里绕，最后给出「未检测到遗漏或未映射的科目」
 * 这类**它根本看不到的模块的肯定结论**。这里把转换批次、映射版本、校验闸门与并行试运行的
 * 结论以有界摘要的形式暴露出来，让回答有据可依。
 *
 * 边界：
 * - 只读。不解析原件、不重算金额、不触发转换；所有结论都取自转换时已固化的 `validation_json`
 *   与映射校验器，与页面上看到的完全一致。
 * - 有界。errors/warnings/守恒明细/勾稽明细/差异明细都截断，并显式给出隐藏条数，
 *   避免把几万行明细塞进模型上下文。
 * - 不输出原件二进制与标准化中间结果(`publicConversion` 已剥离)，只保留 SHA-256 供追溯。
 */
import type { DB } from '../db/connection';
import * as profiles from '../modules/finance-import/source-profile.service';
import * as mappings from '../modules/finance-import/mapping/mapping.service';
import { validateMappingVersion } from '../modules/finance-import/mapping/mapping-validator';
import * as conversions from '../modules/finance-import/conversion/conversion-batch.service';
import * as parallel from '../modules/finance-import/conversion/parallel-trial.service';
import type { FinanceValidationReport, ValidationIssue } from '../modules/finance-import/finance.types';

/** 明细截断上限：够定位问题，又不会撑爆模型上下文。 */
const ISSUE_LIMIT = 20;
const DETAIL_LIMIT = 10;

interface Bounded<T> { shown: T[]; total: number; hidden: number }

function bound<T>(rows: readonly T[] | undefined, limit: number): Bounded<T> {
  const all = rows ?? [];
  return { shown: all.slice(0, limit), total: all.length, hidden: Math.max(0, all.length - limit) };
}

function issue(row: ValidationIssue) {
  return {
    gate: row.gate,
    code: row.code,
    message: row.message,
    ...(row.sourceSheet ? { sourceSheet: row.sourceSheet } : {}),
    ...(row.sourceRow == null ? {} : { sourceRow: row.sourceRow }),
  };
}

function parseValidation(raw: unknown): FinanceValidationReport | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value as FinanceValidationReport : null;
  } catch { return null; }
}

/** 守恒分组里没通过的项(按差异绝对值降序)，通过的项只给计数。 */
function failedGroups(group: Record<string, { sourceCents: number; allocatedCents: number; differenceCents: number; passed: boolean }> | undefined) {
  const entries = Object.entries(group ?? {});
  const failed = entries
    .filter(([, value]) => !value.passed || value.differenceCents !== 0)
    .sort((a, b) => Math.abs(b[1].differenceCents) - Math.abs(a[1].differenceCents))
    .map(([key, value]) => ({ key, ...value }));
  return { groupCount: entries.length, failed: bound(failed, DETAIL_LIMIT) };
}

/** 批次列表：状态、期间、闸门结论与下游导入批次，一屏能看懂「上一次转换成不成功」。 */
export function financeConversionList(db: DB, limit = 20) {
  const rows = conversions.listConversions(db, Math.min(100, Math.max(1, limit))) as any[];
  return {
    count: rows.length,
    batches: rows.map((row) => {
      const validation = row.validation as FinanceValidationReport | undefined;
      return {
        id: row.id,
        status: row.status,
        year: row.year,
        snapshotDate: row.snapshot_date,
        sourceProfileId: row.source_profile_id,
        mappingVersionId: row.mapping_version_id,
        revisionOfId: row.revision_of_id ?? null,
        importBatchId: row.import_batch_id ?? null,
        passed: validation?.passed ?? null,
        errorCount: validation?.errors?.length ?? 0,
        warningCount: validation?.warnings?.length ?? 0,
        /** 失败时最关键的一条：闸门是「任一失败即关闭」，第一条错误就是阻断原因 */
        firstError: validation?.errors?.length ? issue(validation.errors[0]) : null,
        outputRows: validation?.counts?.outputRows ?? null,
        journalProvided: validation?.journalVerification?.provided ?? false,
        journalPassed: validation?.journalVerification?.passed ?? null,
        createdAt: row.created_at,
        importedAt: row.imported_at ?? null,
        cancelledAt: row.cancelled_at ?? null,
      };
    }),
  };
}

/** 单批次详情：逐闸门结论 + 截断后的失败明细，回答「为什么失败」。 */
export function financeConversionDetail(db: DB, conversionId: number) {
  const row = conversions.publicConversion(conversions.getConversion(db, conversionId)) as any;
  const validation = row.validation as FinanceValidationReport | undefined;
  const reconciliations = validation?.reconciliations ?? [];
  const failedReconciliations = reconciliations.filter((item) => !item.passed);
  const journal = validation?.journalVerification;
  return {
    id: row.id,
    status: row.status,
    year: row.year,
    snapshotDate: row.snapshot_date,
    sourceProfileId: row.source_profile_id,
    mappingVersionId: row.mapping_version_id,
    revisionOfId: row.revision_of_id ?? null,
    importBatchId: row.import_batch_id ?? null,
    createdAt: row.created_at,
    importedAt: row.imported_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    files: {
      balanceName: row.balance_name,
      profitName: row.profit_name,
      journalName: row.journal_name ?? null,
      balanceSha256: row.balance_sha256,
      profitSha256: row.profit_sha256,
      journalSha256: row.journal_sha256 ?? null,
      outputSha256: row.output_sha256 ?? null,
    },
    passed: validation?.passed ?? null,
    counts: validation?.counts ?? null,
    /** 闸门逐项结论：任何一项 false 都会阻断创建导入预览 */
    gates: {
      parse: !(validation?.errors ?? []).some((e) => e.gate === 'parse'),
      mapping: !(validation?.errors ?? []).some((e) => e.gate === 'mapping'),
      conservation: validation?.conservation?.passed ?? null,
      reconciliation: reconciliations.length ? failedReconciliations.length === 0 : null,
      journal: journal?.provided ? journal.passed : null,
    },
    errors: bound((validation?.errors ?? []).map(issue), ISSUE_LIMIT),
    warnings: bound((validation?.warnings ?? []).map(issue), ISSUE_LIMIT),
    conservation: validation?.conservation
      ? {
        sourceCents: validation.conservation.sourceCents,
        allocatedCents: validation.conservation.allocatedCents,
        differenceCents: validation.conservation.differenceCents,
        passed: validation.conservation.passed,
        byCategory: failedGroups(validation.conservation.byCategory),
        bySourceAccount: failedGroups(validation.conservation.bySourceAccount),
        bySourceOrganization: failedGroups(validation.conservation.bySourceOrganization),
      }
      : null,
    reconciliation: {
      ruleCount: reconciliations.length,
      failedCount: failedReconciliations.length,
      failed: bound(failedReconciliations, ISSUE_LIMIT),
    },
    journalVerification: journal
      ? {
        provided: journal.provided,
        passed: journal.passed,
        sourceRows: journal.sourceRows,
        includedRows: journal.includedRows,
        accountCount: journal.accountCount,
        matchedCount: journal.matchedCount,
        mismatchCount: journal.mismatchCount,
        toleranceCents: journal.toleranceCents,
        differences: bound(journal.differences, DETAIL_LIMIT),
      }
      : { provided: false },
    systemMetrics: validation?.systemMetrics ?? null,
  };
}

/** 映射版本列表：状态与锁定信息，回答「现在能用哪个映射」。 */
export function financeMappingVersionList(db: DB, sourceProfileId?: number) {
  const rows = mappings.listMappingVersions(db, sourceProfileId) as any[];
  const profileNames = new Map((profiles.listSourceProfiles(db) as any[]).map((row) => [row.id, row.name]));
  return {
    count: rows.length,
    versions: rows.map((row) => ({
      id: row.id,
      sourceProfileId: row.source_profile_id,
      sourceProfileName: profileNames.get(row.source_profile_id) ?? null,
      versionNo: row.version_no,
      name: row.name,
      status: row.status,
      parentVersionId: row.parent_version_id ?? null,
      reviewedBy: row.reviewed_by ?? null,
      lockedAt: row.locked_at ?? null,
      createdAt: row.created_at,
      treeSnapshotIds: { org: row.org_tree_snapshot_id, account: row.account_tree_snapshot_id },
    })),
  };
}

/** 映射版本详情：规则计数 + 校验器结论，回答「映射有没有漏的科目/冲突」。 */
export function financeMappingVersionDetail(db: DB, mappingVersionId: number) {
  const version = mappings.getMappingVersion(db, mappingVersionId) as any;
  const orgRules = mappings.listOrgMappings(db, mappingVersionId) as any[];
  const accountRules = mappings.listAccountMappings(db, mappingVersionId) as any[];
  const reconciliationRules = mappings.listReconciliationRules(db, mappingVersionId) as any[];
  const report = validateMappingVersion(db, mappingVersionId);
  return {
    id: version.id,
    sourceProfileId: version.source_profile_id,
    versionNo: version.version_no,
    name: version.name,
    status: version.status,
    reviewedBy: version.reviewed_by ?? null,
    lockedAt: version.locked_at ?? null,
    treeSnapshotIds: { org: version.org_tree_snapshot_id, account: version.account_tree_snapshot_id },
    counts: {
      orgRules: orgRules.length,
      accountRules: accountRules.length,
      activeAccountRules: accountRules.filter((row) => row.status === 'active').length,
      inactiveAccountRules: accountRules.filter((row) => row.status !== 'active').length,
      reconciliationRules: reconciliationRules.length,
      /** 权重拆分：一个源科目拆到多个目标时会出现多条同源规则 */
      splitSourceAccounts: new Set(
        accountRules
          .filter((row) => row.status === 'active' && row.allocation_method === 'fixed_ratio')
          .map((row) => String(row.source_account_code)),
      ).size,
    },
    /** 校验器结论：passed=false 时锁定会被拒绝，errors 就是必须先修的项 */
    validation: { passed: report.passed, errorCount: report.errors.length, errors: bound(report.errors.map(issue), ISSUE_LIMIT) },
    sampleAccountRules: accountRules.slice(0, DETAIL_LIMIT).map((row) => ({
      sourceAccountCode: row.source_account_code,
      sourceAccountName: row.source_account_name,
      targetAccountCode: row.target_account_code ?? null,
      targetAccountName: row.target_account_name ?? null,
      amountRule: row.amount_rule,
      allocationMethod: row.allocation_method,
      allocationWeight: row.allocation_weight,
      status: row.status,
    })),
  };
}

/** 并行试运行：与原手工结果的逐组合比较结论，回答「转换数和手工数对得上吗」。 */
export function financeParallelTrialList(db: DB, conversionId?: number) {
  const rows = parallel.listParallelTrials(db, conversionId) as any[];
  return {
    count: rows.length,
    trials: rows.map((row) => {
      const comparison = row.comparison ?? {};
      const mismatches = (comparison.differences ?? []).filter((item: any) => Number(item?.differenceCents ?? 0) !== 0);
      return {
        id: row.id,
        conversionBatchId: row.conversion_batch_id,
        status: row.status,
        reviewedBy: row.reviewed_by ?? null,
        reviewedAt: row.reviewed_at ?? null,
        manualName: row.manual_name,
        manualSha256: row.manual_sha256,
        snapshotDate: comparison.snapshotDate ?? null,
        totalCombinations: comparison.totalCombinations ?? null,
        mismatchCount: comparison.mismatchCount ?? mismatches.length,
        absoluteDifferenceCents: comparison.absoluteDifferenceCents ?? null,
        explainedCount: (row.explanations ?? []).length,
        differences: bound(mismatches, DETAIL_LIMIT),
      };
    }),
  };
}

/** 数据源列表：拥有范围与适配器配置的关键项，回答「哪些组织科目由财务系统接管」。 */
export function financeSourceProfileList(db: DB) {
  const rows = profiles.listSourceProfiles(db) as any[];
  return {
    count: rows.length,
    profiles: rows.map((row) => {
      let config: any = {};
      try { config = JSON.parse(row.config_json || '{}'); } catch { config = { invalidJson: true }; }
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        adapterType: row.adapter_type,
        status: row.status,
        ownedOrgCodes: Array.isArray(config.ownedOrgCodes) ? config.ownedOrgCodes : [],
        ownedAccountCodes: Array.isArray(config.ownedAccountCodes) ? config.ownedAccountCodes : [],
        sourceAccountIncludePrefixes: Array.isArray(config.sourceAccountIncludePrefixes) ? config.sourceAccountIncludePrefixes : [],
        amountUnit: config.amountUnit ?? 'yuan',
        balanceLayout: config.balanceLayout ?? 'single_header',
        journalRequired: Boolean(config.journalRequired),
        updatedAt: row.updated_at,
      };
    }),
  };
}
