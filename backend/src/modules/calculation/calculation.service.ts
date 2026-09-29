import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { computeLeafIds } from '../../core/tree';
import { isAccountVisibleForScope } from '../../core/accountScope';
import { quantityStringToScaled, signOfType } from '../../core/money';
import { getVersion } from '../budget/budget.service';
import { loadSnapshotNodes } from '../tree/snapshot';
import { writeLog } from '../audit/log';

export type CalculationRuleType = 'quantity_price_net_tax' | 'multiply';

export interface CalculationRuleRow {
  id: number;
  code: string;
  name: string;
  rule_type: CalculationRuleType;
  sheet_code: string;
  config_json: string;
  status: 'active' | 'inactive';
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface RuleConfig {
  quantityAccountCode?: string;
  priceAccountCode?: string;
  taxAccountCode?: string;
  defaultTaxRate?: string;
  leftAccountCode?: string;
  rightAccountCode?: string;
  outputAccountCode?: string;
}

export interface CalculationPreviewItem {
  orgId: number;
  outputAccountId: number;
  outputAccountCode: string;
  amountCents: number;
  displayAmountCents: number;
  formula: string;
  note: string;
  inputs: { accountId: number; accountCode: string; scaledValue: number }[];
}

export function listRules(db: DB, includeInactive = false): CalculationRuleRow[] {
  const where = includeInactive ? '' : "WHERE status = 'active'";
  return db.prepare(`SELECT * FROM budget_calculation_rule ${where} ORDER BY sort_order, id`).all() as CalculationRuleRow[];
}

export function getRule(db: DB, id: number): CalculationRuleRow {
  const row = db.prepare('SELECT * FROM budget_calculation_rule WHERE id = ?').get(id) as CalculationRuleRow | undefined;
  if (!row) throw Errors.notFound('测算模板');
  return row;
}

function parseConfig(raw: string, ruleType?: CalculationRuleType): RuleConfig {
  let config: RuleConfig;
  try { config = JSON.parse(raw) as RuleConfig; } catch { throw Errors.validation('测算模板配置 JSON 格式错误'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Errors.validation('测算模板配置必须是 JSON 对象');
  if (!config.outputAccountCode?.trim()) throw Errors.validation('测算模板缺少输出科目编码');
  if (ruleType === 'quantity_price_net_tax') {
    if (!config.quantityAccountCode?.trim() || !config.priceAccountCode?.trim()) {
      throw Errors.validation('量价测算模板必须配置数量科目和价格科目');
    }
    let taxScaled: number;
    try {
      taxScaled = quantityStringToScaled(config.defaultTaxRate ?? '0');
    } catch {
      throw Errors.validation('缺省税率格式不正确，最多四位小数');
    }
    if (taxScaled <= -1_000_000) throw Errors.validation('缺省税率必须大于 -100%');
  } else if (ruleType === 'multiply') {
    if (!config.leftAccountCode?.trim() || !config.rightAccountCode?.trim()) {
      throw Errors.validation('乘法测算模板必须配置两个输入科目');
    }
  }
  return config;
}

export function saveRule(
  db: DB,
  input: { id?: number; code: string; name: string; ruleType: CalculationRuleType; sheetCode?: string; config: RuleConfig; status?: 'active' | 'inactive'; sortOrder?: number },
): CalculationRuleRow {
  if (!input.code?.trim() || !/^[A-Za-z0-9_.-]{1,80}$/.test(input.code.trim())) throw Errors.validation('测算模板编码格式不正确');
  if (!input.name?.trim()) throw Errors.validation('测算模板名称不能为空');
  if (!['quantity_price_net_tax', 'multiply'].includes(input.ruleType)) throw Errors.validation('不支持的测算模板类型');
  const configJson = JSON.stringify(input.config ?? {});
  parseConfig(configJson, input.ruleType);
  const now = new Date().toISOString();
  let id = input.id;
  db.transaction(() => {
    if (id == null) {
      const info = db.prepare(
        `INSERT INTO budget_calculation_rule
          (code, name, rule_type, sheet_code, config_json, status, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(input.code.trim(), input.name.trim(), input.ruleType, input.sheetCode?.trim() ?? '', configJson, input.status ?? 'active', input.sortOrder ?? 0, now, now);
      id = Number(info.lastInsertRowid);
    } else {
      getRule(db, id);
      db.prepare(
        `UPDATE budget_calculation_rule
         SET code = ?, name = ?, rule_type = ?, sheet_code = ?, config_json = ?, status = ?, sort_order = ?, updated_at = ?
         WHERE id = ?`,
      ).run(input.code.trim(), input.name.trim(), input.ruleType, input.sheetCode?.trim() ?? '', configJson, input.status ?? 'active', input.sortOrder ?? 0, now, id);
    }
    writeLog(db, 'calculation_rule.save', 'budget_calculation_rule', id!, { code: input.code.trim(), ruleType: input.ruleType });
  })();
  return getRule(db, id!);
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n;
  const abs = negative ? -numerator : numerator;
  const rounded = (abs + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

function safeNumber(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw Errors.validation('测算结果超出金额安全范围');
  return n;
}

export function previewRule(db: DB, versionId: number, ruleId: number): {
  rule: CalculationRuleRow;
  items: CalculationPreviewItem[];
  skipped: { orgId: number; reason: string }[];
} {
  const version = getVersion(db, versionId);
  if (version.status !== 'draft') throw Errors.conflict('只有草稿版本可以执行测算');
  const rule = getRule(db, ruleId);
  if (rule.status !== 'active') throw Errors.conflict('测算模板已停用');
  const config = parseConfig(rule.config_json, rule.rule_type);
  const orgRows = loadSnapshotNodes(db, version.org_tree_snapshot_id);
  const accRows = loadSnapshotNodes(db, version.account_tree_snapshot_id);
  const leafOrgIds = [...computeLeafIds(orgRows)];
  const accByCode = new Map(accRows.map((row) => [row.code, row]));
  const output = accByCode.get(config.outputAccountCode!);
  if (!output || !computeLeafIds(accRows).has(output.id)) throw Errors.validation(`输出科目 ${config.outputAccountCode} 不存在或不是叶子科目`);
  if (output.type === 'quantity') throw Errors.validation('当前测算模板只支持输出金额科目');
  const entries = db.prepare(
    'SELECT org_id, account_id, quantity FROM budget_entry WHERE version_id = ?',
  ).all(versionId) as { org_id: number; account_id: number; quantity: number | null }[];
  const quantityByKey = new Map(entries.filter((e) => e.quantity != null).map((e) => [`${e.org_id}:${e.account_id}`, e.quantity! ]));
  const items: CalculationPreviewItem[] = [];
  const skipped: { orgId: number; reason: string }[] = [];
  const orgById = new Map(orgRows.map((row) => [row.id, row]));

  for (const orgId of leafOrgIds) {
    const org = orgById.get(orgId)!;
    if (!isAccountVisibleForScope(output.code, new Set([org.code]))) {
      skipped.push({ orgId, reason: `输出科目 ${output.code} 不适用于该组织` });
      continue;
    }
    let businessCents: bigint;
    let formula: string;
    const inputs: { accountId: number; accountCode: string; scaledValue: number }[] = [];
    if (rule.rule_type === 'quantity_price_net_tax') {
      const quantityAcc = accByCode.get(config.quantityAccountCode ?? '');
      const priceAcc = accByCode.get(config.priceAccountCode ?? '');
      const taxAcc = config.taxAccountCode ? accByCode.get(config.taxAccountCode) : undefined;
      if (!quantityAcc || !priceAcc) throw Errors.validation('量价测算模板的电量或价格科目不存在');
      const quantity = quantityByKey.get(`${orgId}:${quantityAcc.id}`);
      const price = quantityByKey.get(`${orgId}:${priceAcc.id}`);
      const tax = taxAcc
        ? quantityByKey.get(`${orgId}:${taxAcc.id}`) ?? quantityStringToScaled(config.defaultTaxRate ?? '0')
        : quantityStringToScaled(config.defaultTaxRate ?? '0');
      if (quantity == null || price == null || quantity === 0 || price === 0) {
        skipped.push({ orgId, reason: '缺少非零数量或价格' });
        continue;
      }
      inputs.push({ accountId: quantityAcc.id, accountCode: quantityAcc.code, scaledValue: quantity });
      inputs.push({ accountId: priceAcc.id, accountCode: priceAcc.code, scaledValue: price });
      if (taxAcc) inputs.push({ accountId: taxAcc.id, accountCode: taxAcc.code, scaledValue: tax });
      const taxDenominator = 1_000_000n + BigInt(tax);
      // 税率科目值与模板缺省值遵守同一定义域。小于 -100% 虽不再除零，
      // 但会把含税系数变成负数，同样不是该业务公式的合法输入。
      if (taxDenominator <= 0n) throw Errors.validation('税率必须大于 -100%，量价测算含税系数必须为正数');
      /* 税率是 10^4 缩放的小数(0.13 → 1300 表示 13%)。定义域只挡了 -100% 下限,
         没挡超大正值:若用户按百分数(13)而非小数(0.13)录入,tax=130000 即 1300%,
         含税系数被放大到荒谬量级而无任何提示。按业务常识给上界(±100%)。 */
      if (tax > 1_000_000) throw Errors.validation('税率超出合理范围(上限 100%);请按小数录入(如 13% 录 0.13),当前值会被解释为超过 100% 的税率');
      // 数量(万单位)×单价(元/单位)=万元；数量与单价各按 10^4 缩放，最终精确舍入到分。
      businessCents = roundDivide(BigInt(quantity) * BigInt(price) * 1_000_000n, 100n * taxDenominator);
      formula = `${quantityAcc.code}*${priceAcc.code}/(1+${taxAcc?.code ?? config.defaultTaxRate ?? '0'}%)`;
    } else {
      const left = accByCode.get(config.leftAccountCode ?? '');
      const right = accByCode.get(config.rightAccountCode ?? '');
      if (!left || !right) throw Errors.validation('乘法测算模板的两个输入科目不存在');
      const leftValue = quantityByKey.get(`${orgId}:${left.id}`);
      const rightValue = quantityByKey.get(`${orgId}:${right.id}`);
      if (leftValue == null || rightValue == null || leftValue === 0 || rightValue === 0) {
        skipped.push({ orgId, reason: '缺少非零乘数' });
        continue;
      }
      inputs.push({ accountId: left.id, accountCode: left.code, scaledValue: leftValue });
      inputs.push({ accountId: right.id, accountCode: right.code, scaledValue: rightValue });
      businessCents = roundDivide(BigInt(leftValue) * BigInt(rightValue), 100n);
      formula = `${left.code}*${right.code}`;
    }
    const displayAmountCents = safeNumber(businessCents);
    const amountCents = displayAmountCents * signOfType(output.type);
    items.push({
      orgId,
      outputAccountId: output.id,
      outputAccountCode: output.code,
      amountCents,
      displayAmountCents,
      formula: `=${formula}`,
      note: `由测算模板「${rule.name}」生成`,
      inputs,
    });
  }
  return { rule, items, skipped };
}
