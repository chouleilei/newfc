import type { EvidenceKind, LegalCategory, LegalMetadata, ProcurementTier } from '@contracts/contract-legal-review';
import type {
  ChangeApprovalTier, ChangeKind,
  ContractAcquisitionMethod, ContractArchiveStatus, ContractBudgetType, ContractCurrency, ContractDecisionMethod,
  ContractDirection, ContractDistributionStatus, ContractFundingSource, ContractMeetingType, ContractPaymentApprovalTier,
  ContractPaymentType, ContractPricingMode, ContractReportCategory, ContractTenderBodyType, ContractTermType, SettlementKind,
  DisputeStage, GuaranteeDirection, GuaranteeStatus, GuaranteeType, WarrantyConclusion,
} from '@contracts/contract-lifecycle';

// UI labels and bigint previews stay local; authoritative validation and tier derivation run on the server.
export const LEGAL_LABELS: Record<LegalCategory, string> = {
  goods_procurement: '物资采购', small_construction: '小型维修改造施工', tech_service: '技术服务（试验）',
  general_service: '一般服务', construction: '建设工程', income_sales: '产品销售服务',
  important_special: '复杂重要合同', other: '其他 / 普通历史合同',
};
export const ROLE_LABELS: Record<LegalMetadata['partyRole'], string> = {
  buyer: '买方', seller: '卖方', employer: '发包人', contractor: '承包人', client: '委托方', provider: '服务方', other: '其他',
};
export const METHOD_LABELS: Record<NonNullable<LegalMetadata['procurementMethod']>, string> = {
  public_tender: '公开招标', invited_tender: '邀请招标', negotiation: '谈判采购', inquiry: '询比采购',
  bidding: '竞价采购', direct: '直接采购', direct_reimburse: '直接发票报账（须核实适用条件）',
};
export const TIER_LABELS: Record<ProcurementTier, string> = {
  tier_1: '一级采购', tier_2: '二级采购', tier_3: '三级采购', exempt_small: '3 万元以内直接报账待核实', non_procurement: '非采购',
};
export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  procurement_scheme_approval: '采购方案审批',
  bid_award_approval: '定标审批',
  award_notice: '中标 / 成交通知书',
  evaluation_report: '评审报告',
  company_approval: '公司批准文件 / 主要领导批示',
  client_written_offer: '相对方书面邀约',
  legal_opinion: '法律顾问意见',
  triple_major_decision: '三重一大决策',
  tech_spec: '技术规格书',
  safety_protocol: '安全协议',
  supplier_qualification: '供应商资信 / 资格审查',
  our_signatory_auth: '我方签署人授权委托书',
  counterparty_signatory_auth: '对方签署人授权委托书',
  change_decision: '变更 / 索赔决策批件',
  change_agreement: '补充 / 变更协议文本',
  guarantor_consent: '担保单位书面同意函',
  termination_agreement: '解除协议及清算方案',
  warranty_release_visa: '质保金支付签证表',
  payment_approval_form: '大额 / 分级付款审批单',
  out_of_plan_approval: '计划外项目审批凭据',
  tech_special_audit: '技术归口专项复核意见',
  funding_feasibility: '大额资金可行性论证',
  boq_quantity_settlement: '工程量结算书',
  boq_price_settlement: '工程价款结算书',
  other: '其他依据',
};

export const LEGAL_CATEGORIES = Object.keys(LEGAL_LABELS) as LegalCategory[];
export const PARTY_ROLES = Object.keys(ROLE_LABELS) as LegalMetadata['partyRole'][];
export const PROCUREMENT_METHODS = Object.keys(METHOD_LABELS) as NonNullable<LegalMetadata['procurementMethod']>[];
export const EVIDENCE_KINDS = Object.keys(EVIDENCE_LABELS) as EvidenceKind[];

export const CONTRACT_CURRENCIES: readonly ContractCurrency[] = [
  '人民币', '美元', '加元', '澳元', '欧元', '英镑', '港币', '韩元', '日元', '印度卢比',
  '朝鲜元', '澳门元', '新西兰元', '俄罗斯卢布', '瑞典克朗', '新加坡元', '泰铢', '新台币', '南非兰特', '越南盾',
];

export const DIRECTION_LABELS: Record<ContractDirection, string> = { expense: '支出合同', income: '收入合同' };
export const PRICING_MODE_LABELS: Record<ContractPricingMode, string> = { lump_sum: '总价合同', unit_price: '单价合同' };
export const REPORT_CATEGORY_LABELS: Record<ContractReportCategory, string> = {
  engineering: '工程', goods: '货物', service: '服务', other: '其他',
};
export const BUDGET_TYPE_LABELS: Record<ContractBudgetType, string> = {
  single_listed: '计划单列', lump_sum_pool: '生产经营总额包干', emergency_unplanned: '应急计划外',
};
export const FUNDING_SOURCE_LABELS: Record<ContractFundingSource, string> = {
  fiscal: '财政拨款', income_contract: '收入合同（以收定支）', self_owned_other: '其他（自有资金等）',
};
export const DECISION_METHOD_LABELS: Record<ContractDecisionMethod, string> = {
  meeting: '会议', approval: '审批', other: '其他',
};
export const MEETING_TYPE_LABELS: Record<ContractMeetingType, string> = {
  party_committee: '党委（组）会', admin_office: '事业（企业）单位行政办公会',
  board: '企业董事会', gm_office: '总经理（厂长）办公会', other: '其他',
};
export const ACQUISITION_METHOD_LABELS: Record<ContractAcquisitionMethod, string> = {
  tender: '投标', negotiation: '项目洽谈', other: '其他',
};
export const TENDER_BODY_LABELS: Record<ContractTenderBodyType, string> = {
  consortium: '联合体投标', single: '单一投标',
};
export const TERM_TYPE_LABELS: Record<ContractTermType, string> = {
  fixed: '固定期限', conditional: '条件期限', unspecified: '未约定',
};
export const DISTRIBUTION_STATUS_LABELS: Record<ContractDistributionStatus, string> = {
  pending: '待分发备案', completed: '已完成分发备案',
};
export const ARCHIVE_STATUS_LABELS: Record<ContractArchiveStatus, string> = {
  collecting: '收集中', checked: '完整性已核验', transferred: '已移交档案室',
};
export const SETTLEMENT_KIND_LABELS: Record<SettlementKind, string> = {
  progress: '进度结算', final: '竣工 / 最终结算',
};
export const PAYMENT_TYPE_LABELS: Record<ContractPaymentType, string> = {
  prepayment: '预付款', progress: '进度款', final: '结算款', warranty_release: '质保金退还 / 尾款', other: '其他',
};
export const PAYMENT_APPROVAL_TIER_LABELS: Record<ContractPaymentApprovalTier, string> = {
  secondary_unit_head: '二级单位主要负责人', finance_vp: '公司分管财务副总经理',
  general_manager: '公司总经理（主要负责人）', collective_decision: '大额资金集体决策',
};

export const CHANGE_KIND_LABELS: Record<ChangeKind, string> = {
  change: '合同变更',
  claim_by_contractor: '承包人索赔',
  counter_claim: '发包人反索赔',
  suspend: '合同中止',
  terminate: '合同解除',
};

export const CHANGE_APPROVAL_TIER_LABELS: Record<ChangeApprovalTier, string> = {
  undertaker_unit: '承办单位自行审批（报技术归口与企管部备案）',
  undertaker_vp: '承办单位分管副总审批',
  tech_and_undertaker_vp: '技术归口审查 + 承办单位分管副总审批',
  dual_vp: '承办单位分管副总 + 合同归口分管副总审批',
  general_manager: '公司总经理审批',
  management_board: '公司经营层审批',
};

export const CHANGE_TIER_RANK: Record<ChangeApprovalTier, number> = {
  undertaker_unit: 1,
  undertaker_vp: 2,
  tech_and_undertaker_vp: 3,
  dual_vp: 4,
  general_manager: 5,
  management_board: 6,
};

export const GUARANTEE_TYPE_LABELS: Record<GuaranteeType, string> = {
  bid_bond: '投标保证金 / 保函',
  prepayment_guarantee: '预付款保函',
  performance_guarantee: '履约保函 / 保证金',
  warranty_guarantee: '质量保证金保函',
  engineering_insurance: '工程保险',
};

export const GUARANTEE_DIRECTION_LABELS: Record<GuaranteeDirection, string> = {
  inbound: '收受对方保函 / 保证金',
  outbound: '我方对外开立',
};

export const GUARANTEE_STATUS_LABELS: Record<GuaranteeStatus, { text: string; color: string }> = {
  active: { text: '有效 / 在押', color: 'processing' },
  expired: { text: '已到期', color: 'warning' },
  claimed: { text: '已索赔 / 冻结', color: 'error' },
  returned: { text: '已退还 / 清理', color: 'success' },
};

export const WARRANTY_CONCLUSION_LABELS: Record<WarrantyConclusion, { text: string; color: string }> = {
  passed: { text: '期满验收通过', color: 'success' },
  rectifying: { text: '存在缺陷整改中', color: 'warning' },
};

export const DISPUTE_STAGE_LABELS: Record<DisputeStage, { text: string; color: string }> = {
  negotiation: { text: '协商谈判', color: 'default' },
  mediation: { text: '调解中', color: 'processing' },
  arbitration: { text: '仲裁中', color: 'warning' },
  litigation_1st: { text: '一审诉讼', color: 'warning' },
  litigation_2nd: { text: '二审诉讼', color: 'error' },
  execution: { text: '执行中', color: 'purple' },
  closed: { text: '已结案', color: 'success' },
};

export const EVALUATION_RECOMMENDATION_LABELS: Record<'preferred' | 'normal' | 'restricted' | 'blacklisted', { text: string; color: string }> = {
  preferred: { text: '优先选用', color: 'success' },
  normal: { text: '正常合作', color: 'processing' },
  restricted: { text: '限制合作', color: 'warning' },
  blacklisted: { text: '禁用 / 列入黑名单', color: 'error' },
};

/** 附件 5 变更/索赔审批层级实时预览（与服务端 computeChangeApprovalTier 保持一致，全部 bigint 分计算） */
export function changeApprovalTierPreview(params: {
  originalCents: bigint;
  estimatedCeilingCents?: bigint | null;
  priorApprovedPositiveCents: bigint;
  deltaCents: bigint;
  changeKind: ChangeKind;
  procurementTier: ProcurementTier | null;
  involvesBizOrEntityChange: boolean;
  involvesTechChange: boolean;
  orMode?: 'min' | 'max';
}): {
  tier: ChangeApprovalTier;
  requireTechSpecialAudit: boolean;
  requireDisciplineFiling: boolean;
} {
  const baseCents = params.originalCents > 0n ? params.originalCents : (params.estimatedCeilingCents ?? 0n);
  const orMode = params.orMode ?? 'min';
  if (params.changeKind === 'terminate') {
    return { tier: 'general_manager', requireTechSpecialAudit: false, requireDisciplineFiling: false };
  }
  if (params.changeKind === 'suspend') {
    return {
      tier: params.involvesTechChange ? 'tech_and_undertaker_vp' : 'undertaker_vp',
      requireTechSpecialAudit: false,
      requireDisciplineFiling: false,
    };
  }
  if (params.changeKind === 'counter_claim') {
    return {
      tier: params.involvesTechChange ? 'tech_and_undertaker_vp' : 'undertaker_unit',
      requireTechSpecialAudit: false,
      requireDisciplineFiling: false,
    };
  }
  if (params.deltaCents <= 0n) {
    if (params.involvesTechChange) {
      return { tier: 'dual_vp', requireTechSpecialAudit: false, requireDisciplineFiling: false };
    }
    if (params.involvesBizOrEntityChange && (params.procurementTier === 'tier_1' || params.procurementTier === 'tier_2')) {
      return { tier: 'undertaker_vp', requireTechSpecialAudit: false, requireDisciplineFiling: false };
    }
    return { tier: 'undertaker_unit', requireTechSpecialAudit: false, requireDisciplineFiling: false };
  }

  const requireTechSpecialAudit = baseCents > 0n && (
    params.deltaCents * 10n > baseCents ||
    (params.priorApprovedPositiveCents + params.deltaCents) * 10n > baseCents
  );
  const requireDisciplineFiling = true;

  const hitCumulativeThreshold = params.priorApprovedPositiveCents >= 500_000_000n ||
    (baseCents > 0n && params.priorApprovedPositiveCents * 10n >= baseCents);
  if (hitCumulativeThreshold) {
    return { tier: 'management_board', requireTechSpecialAudit, requireDisciplineFiling };
  }

  const fits = (pct: bigint, fixedCents: bigint): boolean => {
    if (baseCents <= 0n) return params.deltaCents <= fixedCents;
    const pctOk = params.deltaCents * 100n <= baseCents * pct;
    const fixedOk = params.deltaCents <= fixedCents;
    return orMode === 'min' ? (pctOk && fixedOk) : (pctOk || fixedOk);
  };

  let tier: ChangeApprovalTier;
  if (fits(2n, 20_000_000n)) {
    tier = params.involvesTechChange ? 'tech_and_undertaker_vp' : 'undertaker_unit';
  } else if (fits(4n, 50_000_000n)) {
    tier = 'dual_vp';
  } else if (fits(6n, 100_000_000n)) {
    tier = 'general_manager';
  } else {
    tier = 'management_board';
  }

  return { tier, requireTechSpecialAudit, requireDisciplineFiling };
}

export function procurementTierPreview(procurement: boolean, target: string | null, amount: bigint, method: string | null): ProcurementTier | null {
  if (!procurement) return 'non_procurement';
  if (!target) return null;
  if (method === 'direct_reimburse' && amount <= 3000000n) return 'exempt_small';
  const limits = target === 'construction' ? [300000000n, 100000000n]
    : target === 'goods' ? [150000000n, 50000000n] : [100000000n, 30000000n];
  return amount >= limits[0] ? 'tier_1' : amount >= limits[1] ? 'tier_2' : 'tier_3';
}

/** 支付分级审批要求预览（单位：分，零浮点计算） */
export function paymentApprovalTierPreview(signingEntityLevel: 'company' | 'secondary_unit', amountCents: bigint): ContractPaymentApprovalTier {
  if (amountCents >= 500_000_000n) return 'collective_decision';
  if (signingEntityLevel === 'company') {
    return amountCents > 50_000_000n ? 'general_manager' : 'finance_vp';
  }
  return 'secondary_unit_head';
}

export function parseMoneyToCentsPreview(v: unknown): bigint | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return 0n;
  const m = s.match(/^(-)?(\d{1,13})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const neg = m[1] === '-';
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return neg ? -cents : cents;
}

export function formatCentsPreview(cents: bigint): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const yuan = abs / 100n;
  const fen = String(abs % 100n).padStart(2, '0');
  return `${neg ? '-' : ''}${yuan}.${fen}`;
}
