/**
 * 定稿质量门禁「解释 + 修复建议」(AI 功能增强计划 §四.阶段一.5–6)。
 *
 * 薄 AI 层:建议处理顺序与最小修复路径先由确定性模板生成
 * (阻断先于提醒、结构先于填报,归并统计来自 budgetQualityReport),
 * 模型仅重述与解释,数字守卫失败或模型不可用时回退模板稿。
 * 输入只含结构化 issue 列表与归并统计,不含金额明细。
 */
import { promptSupplement } from '../modules/settings/prompt-supplements.service';
import type { DB } from '../db/connection';
import { budgetQualityReport, BUDGET_QUALITY_HELP, type BudgetQualityGroup, type BudgetQualityIssue } from '../modules/check/budget-quality';
import { getVersion } from '../modules/budget/budget.service';
import { rewriteTemplateNarrative, type NarrativeRewrite } from './narrative';
import { qualityAdviceAiEnabled } from './feature-flags';
import { PROMPT_VERSION, QUALITY_ADVICE_REWRITE_TASK } from './prompts';

/** 处理顺序的确定性排序:阻断先于提醒;同级内结构问题先于填报类,提醒类规则无效先于未试算。 */
const ORDER: Record<string, number> = {
  STRUCTURE_INVALID: 0,
  REQUIRED_VALUE_MISSING: 1,
  BASIS_MISSING: 2,
  CALCULATION_RULE_INVALID: 3,
  CALCULATION_OUTPUT_MISSING: 4,
};

function fixAction(issue: BudgetQualityIssue): string {
  const help = BUDGET_QUALITY_HELP[issue.code];
  return help ? help.fix : '按问题描述逐条核实处理';
}

/** 确定性模板稿:问题概况 → 建议处理顺序 → 最小修复路径。 */
export function qualityAdviceTemplate(input: {
  versionName: string;
  versionStatus: string;
  canFinalize: boolean;
  blockingCount: number;
  warningCount: number;
  groups: BudgetQualityGroup[];
  issues: BudgetQualityIssue[];
}): string {
  const { canFinalize, blockingCount, warningCount, groups, issues } = input;
  const lines: string[] = ['# 定稿质量门禁处理建议', ''];
  lines.push('## 问题概况');
  lines.push(`- 阻断 ${blockingCount} 条,提醒 ${warningCount} 条;当前${canFinalize ? '可以定稿' : '不能定稿'}。`);
  for (const group of groups) {
    lines.push(`- ${group.code}:${group.summary}`);
  }
  if (issues.length === 0) {
    lines.push('- 本次检查没有命中任何问题。');
  }
  lines.push('', '## 建议处理顺序');
  if (issues.length === 0) {
    lines.push('1. 检查已通过,可直接定稿;定稿后版本不可修改。');
  } else {
    const sortedGroups = [...groups].sort((a, b) => (ORDER[a.code] ?? 99) - (ORDER[b.code] ?? 99) || b.count - a.count);
    sortedGroups.forEach((group, index) => {
      const sample = issues.find((issue) => issue.code === group.code);
      const action = sample ? fixAction(sample) : '逐条核实处理';
      lines.push(`${index + 1}. 先处理 ${group.code}(${group.severity === 'blocking' ? '阻断' : '提醒'},${group.count} 条):${group.summary}。处理方式:${action}。`);
    });
  }
  lines.push('', '## 最小修复路径');
  if (issues.length === 0) {
    lines.push('- 无需修复:检查通过,可在预算编制页直接定稿。');
  } else if (blockingCount === 0) {
    lines.push('- 当前没有阻断项,只有提醒项:可以直接定稿,提醒项建议在定稿后安排复核。');
    lines.push(`- 版本「${input.versionName}」状态为${input.versionStatus === 'draft' ? '草稿' : input.versionStatus},定稿后不可修改。`);
  } else {
    lines.push(`- 版本「${input.versionName}」状态为草稿:补齐 ${blockingCount} 条阻断项后即可定稿。`);
    lines.push('- 逐条定位:在「定稿体检」对话框中点击「定位」跳转到对应单元格处理。');
    lines.push('- 处理后重新打开定稿体检确认,全部阻断项清零再定稿。');
  }
  return lines.join('\n');
}

export interface QualityAdviceResult {
  versionId: number;
  canFinalize: boolean;
  blockingCount: number;
  warningCount: number;
  groups: BudgetQualityGroup[];
  /** 最终建议文本:模型改写稿或确定性模板稿。 */
  advice: string;
  source: NarrativeRewrite['source'];
  model: string;
  promptVersion: string;
  cached: boolean;
  guardFailure?: { extra: string[]; missing: string[] };
}

export async function qualityAdvice(db: DB, versionId: number): Promise<QualityAdviceResult> {
  const report = budgetQualityReport(db, versionId);
  const version = getVersion(db, versionId);
  const template = qualityAdviceTemplate({
    versionName: version.name,
    versionStatus: version.status,
    canFinalize: report.canFinalize,
    blockingCount: report.blockingCount,
    warningCount: report.warningCount,
    groups: report.groups,
    issues: report.issues,
  });
  const rewrite = await rewriteTemplateNarrative({
    enabled: qualityAdviceAiEnabled(),
    promptVersion: PROMPT_VERSION.qualityAdvice,
    supplement: promptSupplement(db, 'qualityAdvice'),
    task: QUALITY_ADVICE_REWRITE_TASK,
    template,
    // 模板里唯一的中文专名是版本名(问题概况用的是归并统计,不含组织/科目名称)
    factTerms: [version.name],
    maxChars: 20_000,
  });
  return {
    versionId,
    canFinalize: report.canFinalize,
    blockingCount: report.blockingCount,
    warningCount: report.warningCount,
    groups: report.groups,
    advice: rewrite.text,
    source: rewrite.source,
    model: rewrite.model,
    promptVersion: rewrite.promptVersion,
    cached: rewrite.cached,
    ...(rewrite.guardFailure ? { guardFailure: rewrite.guardFailure } : {}),
  };
}
