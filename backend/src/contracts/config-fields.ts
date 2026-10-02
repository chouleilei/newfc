/** 页面字段帮助和服务端认可的说明；不接收客户端自报标签或约束。 */
import type { DraftKind } from './page-catalog';
export type ConfigFormKind = Exclude<DraftKind, 'budget_grid' | 'actual_grid'>;
const identity = { code: '编码全局唯一；已有组织、科目和指标编码不可修改。', name: '名称必填；用于当前配置显示。', sortOrder: '排序必须为安全整数。', parentId: '上级不能是自身或后代；被存量明细引用的叶子不能直接变为父节点。', status: '启用或停用只影响当前配置，已有快照和存量数据保留。' };
export const CONFIG_FIELD_HELP: Record<ConfigFormKind, Readonly<Record<string, string>>> = {
  org_form: identity,
  account_form: { ...identity, type: '收入、成本、费用、数量四类；父子科目类型必须一致。', unit: '数量科目必须提供计量单位，金额科目不设置数量单位。', quantityAgg: 'sum 可加总，none 不汇总；指标引用中的数量不能改为不可汇总。', budgetRequired: '仅末级科目可要求预算必填。', basisRequired: '仅末级科目可要求测算依据。', rootCodes: '表格按所选科目根的子树取数；至少一个有效科目根。', collapsedCodes: '表格中折叠显示的汇总科目；编码须有效且不重复。' },
  metric_formula: { code: identity.code, name: identity.name, status: identity.status, displayOrder: identity.sortOrder, kind: '线性指标按带符号金额求和；比率必须恰好一个分子和一个分母。', direction: '比率可配置越高越好或越低越好。', displayFormat: '比率按百分比或数值显示，不改变计算口径。', displaySign: '金额展示可乘 +1 或 -1，存储仍为利润方向。', unit: '数值型比率的展示单位。', terms: '来源为金额科目或线性指标，系数只能 ±1；完整依赖图不能有循环。', numerator: '比率分子可用金额或可加总数量；比率指标不能被引用。', denominator: '比率分母为零显示 N/A；不可汇总数量不能作为范围合计。' },
  calculation_rule: { code: '规则编码唯一，可用字母、数字、下划线、点和横线。', name: identity.name, ruleType: '量价输入必须是数量叶子，输出为金额叶子；乘法保留有效叶子引用，当前试算只计算数量输入。', sheetCode: '优先使用的表格；实际试算按版本绑定科目快照。', config: '按规则类型校验输入、输出与税率；给定草稿预算版本时才可试算。', quantityAccountCode: '数量输入科目编码，必须有效且为数量叶子。', priceAccountCode: '单价输入科目编码，必须有效且为数量叶子。', taxAccountCode: '可选税率数量科目；未录值时采用缺省税率。', defaultTaxRate: '百分数税率按四位定点数计算，必须大于 -100% 且不超过 100%。', leftAccountCode: '乘数一，有效叶子科目；当前试算只计算数量输入。', rightAccountCode: '乘数二，有效叶子科目；当前试算只计算数量输入。', outputAccountCode: '输出金额叶子科目，按收入/成本/费用方向存储。', status: identity.status, sortOrder: identity.sortOrder, enabled: identity.status },
  cleaning_template: { name: '长期模板名称必填；当前清洗分析不会自动保存模板。', targetKind: '预算或当前实际，须与有权文件及导入目标一致。', config: '模板只保存结构和口径；绝对结束行、排除行和批次数据不写入长期模板。', sheets: '所选工作表和数据区域须存在，总行数受导入上限约束。', columns: '组织、科目和值列必须映射；金额和数量只能选择一个。', valueKind: '金额和数量隔离，数量按科目单位与汇总方式处理。', amountUnit: '元或万元，按整数定点口径转换为分。', signConvention: '展示正数或利润方向；收入正、成本费用负。', mappings: '本次名称映射仅影响当前导入；保存为别名需要页面显式操作。', excludedRows: '排除行仅作用于本次导入，不进入长期模板。', headerRow: '表头行须位于数据开始行之前。', dataStartRow: '数据区域开始行。', dataEndRow: '本次绝对结束行，不保存为模板。', clearBlankNotes: '显式决定空白备注是否覆盖已有备注。', preferredSheetName: '模板优先匹配的工作表名称。' },
  alias_rule: { targetKind: '预算、当前实际或财务转换；别名按目标隔离。', mappingKind: '目标为组织或科目。', sourceText: '来源文本先按同源规则规范化，相同规范化文本不能重复映射。', targetCode: '目标编码必须存在并启用；长期别名在正式保存后影响后续导入。' },
};
export function configFieldHelp(formKind: string, field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_FIELD_HELP, formKind)) return null;
  const fields = CONFIG_FIELD_HELP[formKind as ConfigFormKind];
  return Object.prototype.hasOwnProperty.call(fields, field) ? fields[field] : null;
}
