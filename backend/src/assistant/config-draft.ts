/** 配置草稿只编排同源领域校验，不维护第二套业务规则。 */
import { centsToDecimalString, parseDecimalToCents } from '../core/decimal';
import { configFieldHelp } from '../contracts/config-fields';
import type { DB } from '../db/connection';
import type { DraftKind } from '../contracts/page-catalog';
import { AppError, Errors } from '../core/errors';
import { validateInput } from '../core/input';
import { suggestNextContractNo } from '../modules/contracts/prefix-map.service';
import { derivePlanApprovalBody } from '../modules/plan-execution/plan-issuance.service';
import { PLAN_ADJUST_TYPES, PLAN_ADJUST_TYPE_LABELS, PLAN_APPROVAL_BODY_LABELS, type PlanAdjustType } from '../contracts/plan-execution';
import { LEGAL_CATEGORIES, type LegalCategory } from '../contracts/contract-legal-review';
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
  /** UX-26 服务端只读派生的安全预填建议（仅含数据库规范编码、枚举与计算结果，不含客户端未保存自由文本）。 */
  suggestedFields?: Record<string, unknown>;
}

export function analyzeContractDraftFields(db: DB, fields: Record<string, unknown>): {
  issues: string[];
  explanation: string[];
  suggestedFields: Record<string, unknown>;
} {
  const issues: string[] = [];
  const explanation: string[] = [];
  const suggestedFields: Record<string, unknown> = {};

  const direction = fields.direction === 'income' ? 'income' : 'expense';
  suggestedFields.direction = direction;

  const legalCatRaw = typeof fields.legalCategory === 'string' && fields.legalCategory.trim() ? fields.legalCategory.trim() : null;
  const legalCategory = legalCatRaw && (LEGAL_CATEGORIES as readonly string[]).includes(legalCatRaw)
    ? (legalCatRaw as LegalCategory)
    : null;
  if (legalCatRaw && !legalCategory) {
    issues.push(`法审分类「${legalCatRaw}」不在合法枚举范围内`);
  }

  let amountCents: bigint | null = null;
  if (typeof fields.originalAmount === 'string' && fields.originalAmount.trim()) {
    try {
      amountCents = parseDecimalToCents(fields.originalAmount.trim(), { label: '合同金额' });
      if (amountCents < 0n) issues.push('常规新建合同初始金额不能为负数');
    } catch {
      issues.push('初始合同金额格式不合法，须为最多两位小数的十进制元字符串');
    }
  }

  const orgId = fields.orgId != null && fields.orgId !== '' ? Number(fields.orgId) : null;
  const coManagedOrgId = fields.coManagedOrgId != null && fields.coManagedOrgId !== '' ? Number(fields.coManagedOrgId) : null;
  const signingSubjectOrgId = fields.signingSubjectOrgId != null && fields.signingSubjectOrgId !== '' ? Number(fields.signingSubjectOrgId) : null;
  const signingEntityLevel = fields.signingEntityLevel === 'secondary_unit' ? 'secondary_unit' : 'company';

  if (orgId && Number.isSafeInteger(orgId) && orgId > 0) {
    try {
      const nextNo = suggestNextContractNo(db, {
        orgId,
        coManagedOrgId,
        signingSubjectOrgId,
        signingEntityLevel,
        category: typeof fields.contractType === 'string' ? fields.contractType : null,
        legalCategory,
        direction,
      });
      suggestedFields.contractNo = nextNo.suggestedNo;
      suggestedFields.canonicalPrefix = nextNo.canonicalPrefix;
      suggestedFields.signingSubjectOrgId = nextNo.legalEntityOrgId;
      explanation.push(
        `按母公司简码映射（前缀 ${nextNo.canonicalPrefix}，类别码 ${nextNo.yyCode}）只读推算建议编号为 ${nextNo.suggestedNo}，法定签约法人归属「${nextNo.legalEntityOrgName}」。`
      );
    } catch (err) {
      if (err instanceof AppError) issues.push(err.message);
    }
  } else {
    explanation.push('尚未选择承办组织，暂未推算母公司简码合同编号。');
  }

  const planItemId = fields.planItemId != null && fields.planItemId !== '' ? Number(fields.planItemId) : null;
  if (planItemId && Number.isSafeInteger(planItemId) && planItemId > 0) {
    const pi = db.prepare('SELECT id, sheet_code, item_name, project_id FROM plan_item WHERE id = ?').get(planItemId) as
      | { id: number; sheet_code: string; item_name: string; project_id: number | null }
      | undefined;
    if (pi) {
      const derivedBudgetType = fields.isEmergency
        ? 'emergency_unplanned'
        : ['five_expenses', 'mgmt_fee', 'mfg_fee'].includes(pi.sheet_code)
          ? 'lump_sum_pool'
          : 'single_listed';
      suggestedFields.budgetType = derivedBudgetType;
      suggestedFields.reportCategory = pi.sheet_code.startsWith('investment') || pi.sheet_code === 'maintenance'
        ? 'engineering'
        : pi.sheet_code === 'purchase'
          ? 'goods'
          : 'service';
      if (pi.project_id && !fields.projectId) {
        suggestedFields.projectId = pi.project_id;
      }
      const planAmtRow = db.prepare(
        `SELECT COALESCE(MAX(amount_cents), 0) AS plan_cents FROM plan_fact WHERE item_id = ? AND value_type = 'amount'`
      ).safeIntegers(true).get(pi.id) as { plan_cents: bigint };
      const usedRow = db.prepare(
        `SELECT COALESCE(SUM(original_cents + approved_change_cents), 0) AS used_cents FROM ct_contract WHERE plan_item_id = ? AND status <> 'voided' AND currency = '人民币'`
      ).safeIntegers(true).get(pi.id) as { used_cents: bigint };
      const planCents = BigInt(planAmtRow.plan_cents);
      const usedCents = BigInt(usedRow.used_cents);
      if (planCents > 0n) {
        const remainCents = planCents - usedCents;
        explanation.push(
          `已关联综合计划明细（${pi.sheet_code}），计划额度 ${centsToDecimalString(planCents)} 元，已挂接合同占用 ${centsToDecimalString(usedCents)} 元，剩余可用额度 ${centsToDecimalString(remainCents)} 元。`
        );
        if (amountCents !== null && amountCents > remainCents) {
          issues.push(`草稿金额 ${centsToDecimalString(amountCents)} 元超出关联计划项剩余额度 ${centsToDecimalString(remainCents)} 元，需先履行计划调整审批`);
        }
      }
    }
  }

  const depts = ['财务部', '法务合规', '业务归口部门'];
  if (legalCategory === 'construction' || legalCategory === 'small_construction') {
    depts.push('安全生产部');
  }
  if (amountCents !== null && amountCents >= 50_000_000n) {
    depts.push('招标采购办');
  }
  suggestedFields.countersignDepts = depts;
  explanation.push(`建议并联会签部门：${depts.join('、')}。草稿仅作预检与表单回填预览，不会自动写入合同台账。`);
  return { issues, explanation, suggestedFields };
}

export function analyzePlanIssuanceDraftFields(db: DB, fields: Record<string, unknown>): {
  issues: string[];
  explanation: string[];
  suggestedFields: Record<string, unknown>;
} {
  const issues: string[] = [];
  const explanation: string[] = [];
  const suggestedFields: Record<string, unknown> = {};

  const adjustTypeRaw = typeof fields.adjustType === 'string' && fields.adjustType.trim() ? fields.adjustType.trim() : null;
  if (adjustTypeRaw) {
    if (!(PLAN_ADJUST_TYPES as readonly string[]).includes(adjustTypeRaw)) {
      issues.push(`调整类型「${adjustTypeRaw}」不合法`);
    } else {
      const adjustType = adjustTypeRaw as PlanAdjustType;
      let unitOrgId = fields.unitOrgId != null && fields.unitOrgId !== '' ? Number(fields.unitOrgId) : null;
      if (!unitOrgId && fields.unitPackId != null && fields.unitPackId !== '') {
        const pk = db.prepare('SELECT unit_org_id FROM plan_issuance_unit_pack WHERE id = ?').get(Number(fields.unitPackId)) as { unit_org_id: number } | undefined;
        unitOrgId = pk?.unit_org_id ?? null;
      }
      if (unitOrgId) {
        const orgRow = db.prepare(
          'SELECT id, parent_id, code, name, org_kind, is_direct_station, plan_issuance_root_id, is_plan_excluded FROM org WHERE id = ?'
        ).get(unitOrgId) as {
          id: number; parent_id: number | null; code: string; name: string; org_kind: string;
          is_direct_station: number; plan_issuance_root_id: number | null; is_plan_excluded: number;
        } | undefined;
        if (orgRow) {
          const approvalBody = derivePlanApprovalBody(orgRow as any, adjustType, Boolean(fields.exceedsOverallTarget));
          suggestedFields.approvalBody = approvalBody;
          suggestedFields.approvalBodyLabel = PLAN_APPROVAL_BODY_LABELS[approvalBody];
          suggestedFields.unitOrgId = orgRow.id;
          explanation.push(
            `调整类型「${PLAN_ADJUST_TYPE_LABELS[adjustType]}」按制度权限矩阵自动核定审批层级为「${PLAN_APPROVAL_BODY_LABELS[approvalBody]}」（${approvalBody}）。`
          );
        }
      }
      if (adjustType === 'emergency_retroactive' && !fields.emergencyStartDate) {
        issues.push('应急抢险事后补报类型须填写应急启动日期（实施后 5 个工作日内补报备案）');
      }
    }
  } else {
    const year = fields.year != null ? Number(fields.year) : Number(new Date().toISOString().slice(0, 4));
    const stage = typeof fields.issuanceStage === 'string' && fields.issuanceStage ? fields.issuanceStage : 'official';
    const stageTag = stage === 'pre_arrangement' ? 'PRE' : stage === 'formal_draft' ? 'DRF' : stage === 'adjusted' ? 'ADJ' : 'OFF';
    const cnt = (db.prepare('SELECT COUNT(*) AS c FROM plan_issuance_cycle WHERE year = ?').get(year) as { c: number }).c;
    const suggestedCode = `${year}-${stageTag}-V${cnt + 1}`;
    suggestedFields.cycleCode = suggestedCode;
    suggestedFields.year = year;
    suggestedFields.issuanceStage = stage;
    explanation.push(`建议综合计划下达周期编码为 ${suggestedCode}；草稿仅预填页面表单，须人工点击确认后方可建档。`);
  }
  return { issues, explanation, suggestedFields };
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
      case 'contract_draft': {
        if (operation !== 'create' && operation !== 'update') throw Errors.validation('合同草稿仅支持 create 或 update 预检');
        const out = analyzeContractDraftFields(db, fields as Record<string, unknown>);
        result.issues.push(...out.issues);
        result.explanation.push(...out.explanation);
        result.suggestedFields = out.suggestedFields;
        break;
      }
      case 'plan_issuance_draft': {
        if (!['create', 'update', 'adjust'].includes(operation)) throw Errors.validation('计划下达草稿操作不支持');
        const out = analyzePlanIssuanceDraftFields(db, fields as Record<string, unknown>);
        result.issues.push(...out.issues);
        result.explanation.push(...out.explanation);
        result.suggestedFields = out.suggestedFields;
        break;
      }
      default: throw Errors.validation('不支持的配置草稿');
    }
  } catch (error) {
    if (!(error instanceof AppError) || !['VALIDATION_FAILED', 'CONFLICT', 'NOT_FOUND'].includes(error.code)) throw error;
    result.issues.push(error.message.slice(0, 2000));
    const defaultField: Partial<Record<DraftKind, string>> = {
      org_form: operation === 'move' ? 'parentId' : operation === 'status' ? 'status' : 'name',
      account_form: operation === 'move' ? 'parentId' : operation === 'status' ? 'status' : operation.startsWith('sheet_') ? 'rootCodes' : 'unit',
      metric_formula: 'terms',
      calculation_rule: 'config',
      cleaning_template: 'columns',
      alias_rule: 'sourceText',
      contract_draft: 'contractNo',
      plan_issuance_draft: 'adjustType',
    };
    const details = error.details as { fields?: string[] } | undefined;
    const keys = (details?.fields?.length ? details.fields : Object.keys(fields as object)).map((key) => key.split('.')[0]).filter((key) => configFieldHelp(kind, key) != null);
    result.fieldIssues = [...new Set(keys.length ? keys : [defaultField[kind] ?? 'name'])].map((field) => ({ field, message: error.message.slice(0, 2000) }));
  }
  return result;
}
