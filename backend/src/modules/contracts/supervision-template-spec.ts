/**
 * 上级《纪巡财审合同导入》6 张官方模板与公司每月 28 日 5 表月报内建结构规范。
 * 运行时不读取 docs/private/，所有表头、列序、合并与枚举校验规则均固化于此。
 */
import type {
  ChangeKind, ContractAcquisitionMethod, ContractDecisionMethod, ContractFundingSource,
  ContractMeetingType, ContractPricingMode, ContractReportCategory, ContractTenderBodyType, ContractTermType,
} from '../../contracts/project-contract';
import { CONTRACT_CURRENCIES } from '../../contracts/contract-lifecycle';
import type { LegalMetadata } from '../../contracts/contract-legal-review';
type ProcurementMethod = LegalMetadata['procurementMethod'];

export const SUPERVISION_CURRENCIES = CONTRACT_CURRENCIES;

export const YES_NO_OPTIONS = ['是', '否'] as const;
export const PRICING_OPTIONS = ['总价', '单价'] as const;
export const FUNDING_OPTIONS = ['财政拨款', '收入合同', '其他'] as const;
export const DECISION_OPTIONS = ['会议', '审批', '其他'] as const;
export const MEETING_OPTIONS = [
  '党委（组）会', '事业（企业）单位行政办公会', '企业董事会', '总经理（厂长）办公会', '其他',
] as const;
export const EXPENSE_PROCUREMENT_OPTIONS = [
  '公开招标', '邀请招标', '竞争性谈判', '竞争性磋商', '单一来源采购', '询价', '直接委托（采购）', '其他方式',
] as const;
export const CONTRACT_CATEGORY_OPTIONS = ['工程', '货物', '服务', '其他'] as const;
export const TERM_TYPE_OPTIONS = ['固定期限', '条件期限', '未约定'] as const;
export const EXEC_STATUS_OPTIONS = ['执行中', '未完成已中止', '未完成已终止', '已完成'] as const;
export const ACQUISITION_OPTIONS = ['投标', '项目洽谈', '其他'] as const;
export const TENDER_BODY_OPTIONS = ['联合体投标', '单一投标'] as const;
export const CHANGE_KIND_OPTIONS = ['变更', '中止', '解除'] as const;

export const PRICING_TO_LABEL: Record<ContractPricingMode, string> = { lump_sum: '总价', unit_price: '单价' };
export const LABEL_TO_PRICING: Record<string, ContractPricingMode> = { 总价: 'lump_sum', 单价: 'unit_price' };

export const FUNDING_TO_LABEL: Record<ContractFundingSource, string> = {
  fiscal: '财政拨款', income_contract: '收入合同', self_owned_other: '其他',
};
export const LABEL_TO_FUNDING: Record<string, ContractFundingSource> = {
  财政拨款: 'fiscal', 收入合同: 'income_contract', 其他: 'self_owned_other',
};

export const DECISION_TO_LABEL: Record<ContractDecisionMethod, string> = {
  meeting: '会议', approval: '审批', other: '其他',
};
export const LABEL_TO_DECISION: Record<string, ContractDecisionMethod> = {
  会议: 'meeting', 审批: 'approval', 其他: 'other',
};

export const MEETING_TO_LABEL: Record<ContractMeetingType, string> = {
  party_committee: '党委（组）会',
  admin_office: '事业（企业）单位行政办公会',
  board: '企业董事会',
  gm_office: '总经理（厂长）办公会',
  other: '其他',
};
export const LABEL_TO_MEETING: Record<string, ContractMeetingType> = {
  '党委（组）会': 'party_committee',
  '党委(组)会': 'party_committee',
  '党组会': 'party_committee',
  '党委会': 'party_committee',
  '事业（企业）单位行政办公会': 'admin_office',
  '事业(企业)单位行政办公会': 'admin_office',
  '企业董事会': 'board',
  '董事会': 'board',
  '总经理（厂长）办公会': 'gm_office',
  '总经理(厂长)办公会': 'gm_office',
  '总经理办公会': 'gm_office',
  '其他': 'other',
};

export const PROCUREMENT_TO_LABEL: Record<Exclude<ProcurementMethod, null>, string> = {
  public_tender: '公开招标',
  invited_tender: '邀请招标',
  negotiation: '竞争性谈判',
  inquiry: '询价',
  bidding: '其他方式',
  direct: '直接委托（采购）',
  direct_reimburse: '直接委托（采购）',
};
export const LABEL_TO_PROCUREMENT: Record<string, ProcurementMethod> = {
  公开招标: 'public_tender',
  邀请招标: 'invited_tender',
  竞争性谈判: 'negotiation',
  竞争性磋商: 'negotiation',
  谈判采购: 'negotiation',
  单一来源采购: 'direct',
  直接采购: 'direct',
  '直接委托（采购）': 'direct',
  '直接委托(采购)': 'direct',
  询价: 'inquiry',
  询比采购: 'inquiry',
  竞价采购: 'bidding',
  其他方式: null,
  其他: null,
};

export const CATEGORY_TO_LABEL: Record<ContractReportCategory, string> = {
  engineering: '工程', goods: '货物', service: '服务', other: '其他',
};
export const LABEL_TO_CATEGORY: Record<string, ContractReportCategory> = {
  工程: 'engineering', 施工: 'engineering', 工程施工: 'engineering', 建设工程: 'engineering',
  货物: 'goods', 物资: 'goods', 设备采购: 'goods', 采购: 'goods',
  服务: 'service', 技术服务: 'service', 咨询: 'service',
  其他: 'other',
};

export const TERM_TYPE_TO_LABEL: Record<ContractTermType, string> = {
  fixed: '固定期限', conditional: '条件期限', unspecified: '未约定',
};
export const LABEL_TO_TERM_TYPE: Record<string, ContractTermType> = {
  固定期限: 'fixed', 条件期限: 'conditional', 未约定: 'unspecified',
};

export const ACQUISITION_TO_LABEL: Record<ContractAcquisitionMethod, string> = {
  tender: '投标', negotiation: '项目洽谈', other: '其他',
};
export const LABEL_TO_ACQUISITION: Record<string, ContractAcquisitionMethod> = {
  投标: 'tender', 项目洽谈: 'negotiation', 其他: 'other',
};

export const TENDER_BODY_TO_LABEL: Record<ContractTenderBodyType, string> = {
  consortium: '联合体投标', single: '单一投标',
};
export const LABEL_TO_TENDER_BODY: Record<string, ContractTenderBodyType> = {
  联合体投标: 'consortium', 单一投标: 'single',
};

export const CHANGE_KIND_TO_SUPERVISION: Record<ChangeKind, string> = {
  change: '变更',
  claim_by_contractor: '变更',
  counter_claim: '变更',
  suspend: '中止',
  terminate: '解除',
};
export const LABEL_TO_CHANGE_KIND: Record<string, ChangeKind> = {
  变更: 'change', 中止: 'suspend', 解除: 'terminate',
};

/**
 * 合同编号与补充协议附件目录统一转义（标签项说明 1.5.1 / 1.5.2）：
 * / -> %, \ -> @, | -> $, 其余 Windows 非法路径符 (: * ? " < >) -> _
 */
export function escapeSupervisionNoFolderName(no: string): string {
  return no
    .trim()
    .replace(/\|/g, '$')
    .replace(/\//g, '%')
    .replace(/\\/g, '@')
    .replace(/[:*?"<>]/g, '_');
}

export const escapeSupplementFolderName = escapeSupervisionNoFolderName;

export function sanitizeFolderSegment(name: string): string {
  return name.trim().replace(/[/\\:*?"<>|]/g, '_');
}

export const EXPENSE_BASE_HEADERS = [
  '合同编号', '合同名称', '计价方式', '合同币种', '合同总价', '合同单价', '合同付款方', '合同收款方', '合同主要内容',
  '资金来源', '其他来源', '收入合同编号', '收入合同名称', '备注',
  '委托理由', "是否达到'三重一大'决策限额", '决策方式', '会议形式', '其他决策方式', '其他会议形式', '最终审批人姓名', '最终审批人身份',
  '是否政府采购', '采购方式', '其他采购方式', '采购计划', '开始实施采购时间', '供应商确定时间', '响应文件是否完整', '是否展开资信调查',
  '承办人姓名', '承办部门审核人姓名', '涉及的相关管理部门名称', '相关管理部门审核人姓名', '单位审批人姓名', '单位审批人身份',
  '合同类型', '其他合同类型', '合同签署日期', '履约期限', '履约开始日期', '履约结束日期',
  '付款方合同签署人姓名', '付款方合同签署人身份', '付款方合同签署人是否是单位法定代表人', '收款方合同签署人是否是单位法定代表人',
] as const;

export const EXPENSE_BASE_NOTES = [
  '（1）同一法人单位的合同编号不允许重复；\n（2）必填。\n要求：第1-5行不许调整和删除',
  '（1）必填',
  '（1）只允许选择“总价”、“单价”；\n（2）必填',
  '（1）只允许选择下拉选项中的币种；\n（2）必填',
  '（1）仅支持数字、英文小数点.输入；禁止汉字、字母、逗号、空格、正负号及其他特殊符号。若币种是人民币，此处金额单位为元；\n（2）C列计价方式选择总价时，必填',
  '（1）手动输入单价金额和单位；\n（2）C列计价方式选择单价时，必填',
  '（1）填写付款方单位全称；\n（2）必填',
  '（1）若收款方为联合体，单位之间用英文逗号隔开；\n（2）必填',
  '（1）填写合同的主要内容，不超过1000字；\n（2）必填',
  '（1）只允许选择“财政拨款”、“收入合同”、“其他”；\n（2）必填',
  '（1）当J列选择“其他”时，必填',
  '（1）当J列选择“收入合同”时，必填已登记收入合同编号',
  '（1）当J列选择“收入合同”时，必填已登记收入合同名称',
  '（1）非必填，不超过500字',
  '（1）填写委托理由，不超过1000字；\n（2）必填',
  '（1）只允许选择“是”或者“否”；\n（2）必填',
  '（1）只允许选择“会议”、“审批”或者“其他”；\n（2）必填',
  '（1）Q列选择“会议”时必填',
  '（1）Q列选择“其他”时必填',
  '（1）R列选择“其他”时必填',
  '（1）填写审批链最高审批层级对应的审批人姓名；\n（2）P列选择“是”时必填',
  '（1）填写最高审批层级审批人身份',
  '（1）只允许选择“是”、“否”；\n（2）必填',
  '（1）只允许选择官方8种采购方式；\n（2）必填',
  '（1）X列选择“其他方式”时必填',
  '（1）填写合同的采购计划，不超过1000字；\n（2）必填',
  '（1）格式 YYYY-MM-DD；\n（2）必填',
  '（1）格式 YYYY-MM-DD；\n（2）必填',
  '（1）只允许选择“是”、“否”；\n（2）必填',
  '（1）只允许选择“是”、“否”；\n（2）必填',
  '（1）必填', '（1）必填', '（1）必填', '（1）必填', '（1）必填', '（1）必填',
  '（1）只允许选择“工程”、“货物”、“服务”、“其他”；\n（2）必填',
  '（1）AK列选择“其他”时必填',
  '（1）格式 YYYY-MM-DD；\n（2）必填',
  '（1）只允许选择“固定期限”、“条件期限”、“未约定”；\n（2）必填',
  '（1）格式 YYYY-MM-DD；AN列选择固定期限或条件期限时必填',
  '（1）AN列选择固定期限时填 YYYY-MM-DD；选择条件期限时填条件文本(<=50字)',
  '（1）填写合同付款方签署人的姓名；\n（2）必填',
  '（1）填写合同付款方签署人的身份；\n（2）必填',
  '（1）只允许选择“是”或“否”；\n（2）必填',
  '（1）只允许选择“是”、“否”；\n（2）必填',
] as const;

export const EXPENSE_EXEC_HEADERS = ['合同编号', '合同名称', '合同执行状态', '是否按照约定提交成果', '是否最终验收'] as const;
export const EXPENSE_EXEC_PAY_HEADERS = ['合同编号', '合同名称', '实际支付时间', '付款币种', '实际支付金额', '资金支付审批人姓名', '资金支付审批人身份'] as const;
export const EXPENSE_CHANGE_HEADERS = ['原合同编号', '原合同名称', '变动类型', '变更主要事项', '变更原因', '变更决策方式', '会议形式', '变更最终审批人姓名', '变更补充协议编号', '是否产生合同纠纷'] as const;

export const INCOME_BASE_HEADERS = [
  '合同编号', '合同名称', '计价方式', '合同币种', '合同总价', '合同单价', '合同付款方', '合同收款方', '合同主要内容', '备注',
  '是否进行业主资信调查', "是否达到'三重一大'决策限额", '决策方式', '会议形式', '其他决策方式', '其他会议形式', '最终审批人姓名', '最终审批人身份',
  '合同取得方式', '其他取得方式', '投标主体', '联合体投标',
  '合同签署日期', '履约期限', '履约开始日期', '履约结束日期', '收款方合同签署人姓名', '收款方合同签署人身份', '收款方合同签署人是否是单位法定代表人',
] as const;

export const INCOME_EXEC_HEADERS = ['合同编号', '合同名称', '合同执行状态', '是否验收'] as const;
export const INCOME_EXEC_RECEIVE_HEADERS = ['合同编号', '合同名称', '实际收款时间', '收款币种', '实际收款金额'] as const;
export const INCOME_CHANGE_HEADERS = ['原合同编号', '原合同名称', '变动类型', '变更主要事项', '变更原因', '变更最终审批人姓名', '变更补充协议编号', '是否产生合同纠纷'] as const;

export const SUPERVISION_ATTACHMENT_SLOTS = {
  expenseContract: [
    { dir: '01决策附件', evidenceKinds: ['triple_major_decision', 'company_approval', 'out_of_plan_approval', 'procurement_scheme_approval', 'bid_award_approval', 'legal_opinion'], docTypes: [] as string[] },
    { dir: '02供应商资格审查', evidenceKinds: ['supplier_qualification', 'award_notice', 'evaluation_report'], docTypes: ['qualification', 'procurement'] },
    { dir: '03合同文本', evidenceKinds: [], docTypes: ['signed', 'contract_text'] },
    { dir: '04付款方合同签署人授权附件', evidenceKinds: ['our_signatory_auth'], docTypes: [] as string[] },
    { dir: '05收款方合同签署人授权附件', evidenceKinds: ['counterparty_signatory_auth'], docTypes: [] as string[] },
  ],
  incomeContract: [
    { dir: '01决策附件', evidenceKinds: ['triple_major_decision', 'company_approval', 'legal_opinion'], docTypes: [] as string[] },
    { dir: '02合同文本', evidenceKinds: ['client_written_offer'], docTypes: ['signed', 'contract_text'] },
    { dir: '03收款方合同签署人授权附件', evidenceKinds: ['our_signatory_auth'], docTypes: [] as string[] },
  ],
  expenseChange: [
    { dir: '01变更决策附件', evidenceKinds: ['change_decision', 'guarantor_consent'], docTypes: [] as string[] },
    { dir: '02变更协议文本', evidenceKinds: ['change_agreement', 'termination_agreement'], docTypes: ['change'] },
  ],
  incomeChange: [
    { dir: '01变更协议文本', evidenceKinds: ['change_agreement', 'termination_agreement', 'change_decision'], docTypes: ['change'] },
  ],
} as const;
