/** 页面字段帮助和服务端认可的说明；不接收客户端自报标签或约束。 */
import type { DraftKind } from './page-catalog';
export type ConfigFormKind = Exclude<DraftKind, 'budget_grid' | 'actual_grid'>;
const identity = { code: '编码全局唯一；已有组织、科目和指标编码不可修改。', name: '名称必填；用于当前配置显示。', sortOrder: '排序必须为安全整数。', parentId: '上级不能是自身或后代；被存量明细引用的叶子不能直接变为父节点。', status: '启用或停用只影响当前配置，已有快照和存量数据保留。' };
export const CONFIG_FIELD_HELP: Record<ConfigFormKind, Readonly<Record<string, string>>> = {
  org_form: {
    ...identity,
    orgKind: '组织主体分类：存续法人、本部部门、直属非法人或历史关停主体。',
    creditCode: '统一社会信用代码须为空或 18 位大写字母数字。',
    planIssuanceRootId: '综合计划与预算归口的一级下达单元组织 ID，留空表示自身即一级单元。',
    isPlanExcluded: '开启后不单独生成综合计划下达通知，仅纳入集团合并汇总。',
    contractPrefixCode: '本主体新签合同规范前缀（沿用母公司规则的子法人填写母公司简码）。',
    isDirectStation: '制度明确规定的直属水电站政策标志（与直属非法人属性正交独立）。',
    reportFullName: '用于监管报送与标准报表的层级全称。',
  },
  account_form: { ...identity, type: '收入、成本、费用、数量四类；父子科目类型必须一致。', unit: '数量科目必须提供计量单位，金额科目不设置数量单位。', quantityAgg: 'sum 可加总，none 不汇总；指标引用中的数量不能改为不可汇总。', budgetRequired: '仅末级科目可要求预算必填。', basisRequired: '仅末级科目可要求测算依据。', rootCodes: '表格按所选科目根的子树取数；至少一个有效科目根。', collapsedCodes: '表格中折叠显示的汇总科目；编码须有效且不重复。' },
  metric_formula: { code: identity.code, name: identity.name, status: identity.status, displayOrder: identity.sortOrder, kind: '线性指标按带符号金额求和；比率必须恰好一个分子和一个分母。', direction: '比率可配置越高越好或越低越好。', displayFormat: '比率按百分比或数值显示，不改变计算口径。', displaySign: '金额展示可乘 +1 或 -1，存储仍为利润方向。', unit: '数值型比率的展示单位。', terms: '来源为金额科目或线性指标，系数只能 ±1；完整依赖图不能有循环。', numerator: '比率分子可用金额或可加总数量；比率指标不能被引用。', denominator: '比率分母为零显示 N/A；不可汇总数量不能作为范围合计。' },
  calculation_rule: { code: '规则编码唯一，可用字母、数字、下划线、点和横线。', name: identity.name, ruleType: '量价输入必须是数量叶子，输出为金额叶子；乘法保留有效叶子引用，当前试算只计算数量输入。', sheetCode: '优先使用的表格；实际试算按版本绑定科目快照。', config: '按规则类型校验输入、输出与税率；给定草稿预算版本时才可试算。', quantityAccountCode: '数量输入科目编码，必须有效且为数量叶子。', priceAccountCode: '单价输入科目编码，必须有效且为数量叶子。', taxAccountCode: '可选税率数量科目；未录值时采用缺省税率。', defaultTaxRate: '百分数税率按四位定点数计算，必须大于 -100% 且不超过 100%。', leftAccountCode: '乘数一，有效叶子科目；当前试算只计算数量输入。', rightAccountCode: '乘数二，有效叶子科目；当前试算只计算数量输入。', outputAccountCode: '输出金额叶子科目，按收入/成本/费用方向存储。', status: identity.status, sortOrder: identity.sortOrder, enabled: identity.status },
  cleaning_template: { name: '长期模板名称必填；当前清洗分析不会自动保存模板。', targetKind: '预算或当前实际，须与有权文件及导入目标一致。', config: '模板只保存结构和口径；绝对结束行、排除行和批次数据不写入长期模板。', sheets: '所选工作表和数据区域须存在，总行数受导入上限约束。', columns: '组织、科目和值列必须映射；金额和数量只能选择一个。', valueKind: '金额和数量隔离，数量按科目单位与汇总方式处理。', amountUnit: '元或万元，按整数定点口径转换为分。', signConvention: '展示正数或利润方向；收入正、成本费用负。', mappings: '本次名称映射仅影响当前导入；保存为别名需要页面显式操作。', excludedRows: '排除行仅作用于本次导入，不进入长期模板。', headerRow: '表头行须位于数据开始行之前。', dataStartRow: '数据区域开始行。', dataEndRow: '本次绝对结束行，不保存为模板。', clearBlankNotes: '显式决定空白备注是否覆盖已有备注。', preferredSheetName: '模板优先匹配的工作表名称。' },
  alias_rule: { targetKind: '预算、当前实际或财务转换；别名按目标隔离。', mappingKind: '目标为组织或科目。', sourceText: '来源文本先按同源规则规范化，相同规范化文本不能重复映射。', targetCode: '目标编码必须存在并启用；长期别名在正式保存后影响后续导入。' },
  plan_issuance_draft: {
    year: '计划下达年度（如 2026）；助手只校验并建议编号与审批层级，不自动创建周期。',
    issuanceStage: '下达阶段：年初预安排、正式方案、正式批复下达或年中调整。',
    cycleCode: '下达周期编码，唯一标识本轮 8 单元合一下达版本。',
    title: '综合计划与预算合一下达公文标题。',
    cycleId: '关联的已发布综合计划下达周期 ID。',
    unitPackId: '申请调整的一级下达单元数据包 ID。',
    unitOrgId: '申请调整的下达单元组织 ID，须在当前登录用户授权范围内。',
    adjustType: '6 类法定计划调整类型；服务端按制度矩阵权威推导审批主体 approvalBody。',
    approvalBody: '服务端按单位性质与调整类型推导的法定决策机构（如董事会、总办会、联审后报批）。',
    emergencyStartDate: '应急抢险先实施日期；须在实施后 5 个工作日内补报备案。',
    decisionDocNo: '决策纪要或批复文号。',
    reason: '计划预算调整事由说明；草稿仅在浏览器内存预填，确认提交前不写库。',
    lines: '调整明细行（目标附表、项目、调整前后金额或指标值）。',
  },
  contract_draft: {
    orgId: '合同承办组织 ID（须在当前授权范围内且非历史关停主体）；用于匹配母公司合同简码。',
    coManagedOrgId: '本部统筹代办时对应的被统筹单位组织 ID，编号向被统筹单位取号。',
    signingSubjectOrgId: '实际名义签约主体组织 ID，用于核定独立法人或集团母公司授权。',
    signingEntityLevel: '对外签约层级（集团/母公司 或 二级单位）。',
    contractNo: '规范合同编号；助手可根据 ct_prefix_org_map 与类别推算建议编号，确认保存前不占用流水。',
    name: '合同名称；草稿内容仅在当前请求内存做规则预检，绝不落库或外发。',
    direction: '收支方向：支出合同（expense）或收入合同（income）。',
    contractType: '业务合同类型描述（如施工、货物采购、技术服务）。',
    legalCategory: '智能法审分类枚举（决定适用的正式范本与必检红线条款）。',
    reportCategory: '月报与监管统计分类。',
    projectId: '关联工程项目主数据 ID。',
    planItemId: '关联综合计划明细项 ID；用于核验计划内立项与可用投资/费用额度。',
    supplierId: '签约相对方客商主数据 ID。',
    counterpartyName: '签约相对方名称。',
    originalAmount: '初始含税合同金额（十进制元字符串，整数分定点核验）。',
    budgetType: '预算归口类型（固定资产投资、安全生产、研发或经营成本）。',
    procurementMethod: '采购方式（公开招标、询比、谈判、竞价、直接采购或小额直接报销）。',
    countersignDepts: '建议多部门会签清单（财务、法务、业务归口、安全等）。',
  },
};
export function configFieldHelp(formKind: string, field: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_FIELD_HELP, formKind)) return null;
  const fields = CONFIG_FIELD_HELP[formKind as ConfigFormKind];
  return Object.prototype.hasOwnProperty.call(fields, field) ? fields[field] : null;
}
