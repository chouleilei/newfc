/** 配置草稿只编排同源领域校验，不维护第二套业务规则。 */
import { centsToDecimalString } from '../core/decimal';
import { configFieldHelp } from '../contracts/config-fields';
import type { DB } from '../db/connection';
import type { DraftKind } from '../contracts/page-catalog';
import { AppError, Errors } from '../core/errors';
import { validateInput } from '../core/input';
import * as org from '../modules/org/org.service';
import * as account from '../modules/account/account.service';
import * as metric from '../modules/metric/metric.service';
import * as calculation from '../modules/calculation/calculation.service';
import * as template from '../modules/io/cleaning/template.service';
import * as alias from '../modules/io/cleaning/alias.service';
import * as sheet from '../modules/sheet/sheet.service';

export interface ConfigDraftAnalysis {
  issues: string[];
  explanation: string[];
  fieldIssues?: { field: string; message: string }[];
  affectedIds?: number[];
  affectedCount?: number;
  preview?: { itemCount: number; skippedCount: number; items: { orgId: number; outputAccountId: number; amount: string }[]; truncated: boolean };
}


export function analyzeConfigDraft(db: DB, kind: DraftKind, operation: string, fields: unknown, id: number | null, versionId?: number): ConfigDraftAnalysis {
  const result: ConfigDraftAnalysis = { issues: [], explanation: [] };
  const existing = () => { if (id == null) throw Errors.validation('此操作必须提供已有记录的基线'); return id; };
  try {
    switch (kind) {
      case 'org_form':
        switch (operation) {
          case 'create': org.validateCreateOrg(db, validateInput(org.createOrgSchema, fields)); break;
          case 'update': org.validateUpdateOrg(db, existing(), validateInput(org.updateOrgSchema, fields)); break;
          case 'move': org.validateMoveOrg(db, existing(), validateInput(org.moveInputSchema, fields).parentId); break;
          case 'status': org.validateSetOrgStatus(db, existing(), validateInput(org.statusInputSchema, fields).status); break;
          default: throw Errors.validation('组织操作不支持');
        }
        result.explanation.push('仅影响当前组织树；已有预算绑定的组织快照与存量数据保持原有口径。');
        break;
      case 'account_form':
        switch (operation) {
          case 'create': account.validateCreateAccount(db, validateInput(account.createAccountSchema, fields)); break;
          case 'update': account.validateUpdateAccount(db, existing(), validateInput(account.updateAccountSchema, fields)); break;
          case 'move': account.validateMoveAccount(db, existing(), validateInput(account.moveInputSchema, fields).parentId); break;
          case 'status': account.validateSetAccountStatus(db, existing(), validateInput(account.statusInputSchema, fields).status); break;
          case 'sheet_create': sheet.validateCreateSheet(db, validateInput(sheet.sheetInputSchema, fields)); break;
          case 'sheet_update': sheet.validateUpdateSheet(db, existing(), validateInput(sheet.sheetPatchSchema, fields)); break;
          default: throw Errors.validation('科目操作不支持');
        }
        result.explanation.push('当前树与表格归属用于当前页面取数；已有版本的树快照不会随本次修改重算。数量与金额分别处理。');
        break;
      case 'metric_formula': {
        if (operation !== 'create' && operation !== 'update') throw Errors.validation('指标操作不支持');
        const parsed = operation === 'create' ? validateInput(metric.createMetricSchema, fields) : validateInput(metric.updateMetricSchema, fields);
        if (operation === 'create') metric.validateCreateMetric(db, validateInput(metric.createMetricSchema, fields));
        else metric.validateUpdateMetric(db, existing(), validateInput(metric.updateMetricSchema, fields));
        const old = id == null ? null : metric.getMetric(db, id);
        const terms = parsed.terms ?? old!.terms.map((t) => ({ sourceType: t.source_type, sourceAccountId: t.source_account_id, sourceMetricId: t.source_metric_id, coefficient: t.coefficient, role: t.role }));
        const definitions = metric.listMetrics(db);
        if (definitions.length > 10000) throw Errors.validation('指标依赖图超过领域处理上限');
        const byId = new Map(definitions.map((m) => [m.id, m.terms.filter((t) => t.source_type === 'metric').map((t) => t.source_metric_id!)]));
        const targetId = id ?? -1;
        byId.set(targetId, terms.filter((t) => t.sourceType === 'metric').map((t) => t.sourceMetricId!));
        const dependencies = new Set<number>();
        const visit = (node: number) => { for (const dependency of byId.get(node) ?? []) { if (!dependencies.has(dependency)) { dependencies.add(dependency); visit(dependency); } } };
        visit(targetId);
        const affected = new Set<number>();
        if (id != null) {
          affected.add(id);
          let changed = true;
          while (changed) { changed = false; for (const [node, refs] of byId) if (!affected.has(node) && refs.some((ref) => affected.has(ref))) { affected.add(node); changed = true; } }
        }
        result.affectedCount = affected.size;
        result.affectedIds = [...affected].slice(0, 30);
        result.explanation.push(`完整依赖图已核验：${dependencies.size} 个依赖指标，${affected.size} 个当前指标受影响${affected.size > 30 ? '（详情只显示前 30 项）' : ''}。已有定稿快照不会重算。`);
        const kind = parsed.kind ?? old?.kind ?? 'linear';
        result.explanation.push(kind === 'ratio' ? '比率按分子÷分母计算，金额和可累计数量按自然单位换算；分母为零显示 N/A，有利方向来自配置。' : '线性公式按各来源的带符号金额×±1 求和，数量不参与金额相加。');
        result.explanation.push('未提供具体取数范围，本轮不计算指标金额。');
        break;
      }
      case 'calculation_rule': {
        if (operation !== 'create' && operation !== 'update') throw Errors.validation('测算操作不支持');
        const patch = validateInput(calculation.rulePatchSchema, fields);
        const old = id == null ? null : calculation.getRule(db, id);
        const merged = old ? { code: old.code, name: old.name, ruleType: old.rule_type, sheetCode: old.sheet_code, config: JSON.parse(old.config_json), status: old.status, sortOrder: old.sort_order, ...patch, id: old.id } : patch;
        const input = validateInput(calculation.ruleInputSchema, merged);
        const normalized = calculation.validateRuleInput(db, input);
        result.explanation.push(input.ruleType === 'multiply' ? '数量输入相乘时按定点计算并舍入到分，按输出科目方向存储；含金额输入的既有规则保留依据引用，当前试算不计算金额输入。' : '数量×单价÷含税系数，使用缩放整数和 bigint 计算，结果舍入到分。');
        if (versionId == null) result.explanation.push('未指定预算版本，仅解释规则，无法核实具体试算金额。');
        else {
          const preview = calculation.previewRuleDefinition(db, versionId, { id: id ?? -1, code: input.code, name: input.name, rule_type: input.ruleType, sheet_code: input.sheetCode ?? '', config_json: normalized.configJson, status: input.status ?? 'active', sort_order: input.sortOrder ?? 0, created_at: old?.created_at ?? '', updated_at: old?.updated_at ?? '' });
          if (preview.items.length + preview.skipped.length > 500) throw Errors.validation('试算范围超过 500 个组织，请缩小范围');
          result.preview = { itemCount: preview.items.length, skippedCount: preview.skipped.length, items: preview.items.slice(0, 30).map(({ orgId, outputAccountId, amountCents }) => ({ orgId, outputAccountId, amount: centsToDecimalString(BigInt(amountCents)) })), truncated: preview.items.length > 30 };
          result.explanation.push(`只读试算 ${preview.items.length} 个输出、${preview.skipped.length} 个组织跳过；未修改预算明细。`);
        }
        break;
      }
      case 'cleaning_template':
        if (operation !== 'create' && operation !== 'update') throw Errors.validation('模板操作不支持');
        template.validateTemplateInput(db, validateInput(template.templateInputSchema, fields), id ?? undefined);
        result.explanation.push('模板仅保存列映射和口径配置；未绑定有效文件或预览时，不能核实工作表、区域和覆盖差异。');
        break;
      case 'alias_rule':
        if (operation !== 'create' && operation !== 'update') throw Errors.validation('别名操作不支持');
        alias.validateAliasInput(db, validateInput(alias.aliasInputSchema, fields), id ?? undefined);
        result.explanation.push('来源名称按同源规则规范化后核对重名，目标已核验有效；长期别名仅在正式保存后影响后续导入，当前导入映射不等于已保存别名。');
        break;
      default: throw Errors.validation('不支持的配置草稿');
    }
  } catch (error) {
    if (!(error instanceof AppError) || !['VALIDATION_FAILED', 'CONFLICT', 'NOT_FOUND'].includes(error.code)) throw error;
    result.issues.push(error.message.slice(0, 2000));
    const defaultField: Partial<Record<DraftKind, string>> = { org_form: operation === 'move' ? 'parentId' : operation === 'status' ? 'status' : 'name', account_form: operation === 'move' ? 'parentId' : operation === 'status' ? 'status' : operation.startsWith('sheet_') ? 'rootCodes' : 'unit', metric_formula: 'terms', calculation_rule: 'config', cleaning_template: 'columns', alias_rule: 'sourceText' };
    const details = error.details as { fields?: string[] } | undefined;
    const keys = (details?.fields?.length ? details.fields : Object.keys(fields as object)).map((key) => key.split('.')[0]).filter((key) => configFieldHelp(kind, key) != null);
    result.fieldIssues = [...new Set(keys.length ? keys : [defaultField[kind] ?? 'name'])].map((field) => ({ field, message: error.message.slice(0, 2000) }));
  }
  return result;
}
