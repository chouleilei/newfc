import {
  parseDecimalToCents,
  centsToDecimalString,
  parseScaled,
  INT64_MAX,
} from '../../core/decimal';
import type {
  LegalFinding,
  PolicyDto,
} from '../../contracts/contract-legal-review';
import type { ParsedDocument, Paragraph } from './document-parser';
import type { ContractRow } from './contract.service';
import { currentCents } from './contract.service';
import { procurementTier, dateSequenceConflict } from './legal-context';
export const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, '');
/** Chinese financial uppercase amount -> cents, no IEEE-754 arithmetic. Reject unknown/ambiguous input. */
export function uppercaseCents(input: string): bigint {
  const digits: Record<string, bigint> = {
    零: 0n,
    壹: 1n,
    贰: 2n,
    貳: 2n,
    叁: 3n,
    參: 3n,
    肆: 4n,
    伍: 5n,
    陆: 6n,
    陸: 6n,
    柒: 7n,
    捌: 8n,
    玖: 9n,
  };
  const units: Record<string, bigint> = { 拾: 10n, 佰: 100n, 仟: 1000n };
  const s = norm(input)
    .replace(/^人民币/, '')
    .replace(/圆/g, '元');
  if (
    !/^[零壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万亿]+元(?:整|正|[零壹贰貳叁參肆伍陆陸柒捌玖角分]+)$/.test(
      s,
    )
  )
    throw new Error('大写金额无法解析');
  const [whole, fraction] = s.split('元');
  if (
    !/^(?:整|正|[零壹贰貳叁參肆伍陆陸柒捌玖]角(?:[零壹贰貳叁參肆伍陆陸柒捌玖]分)?|零?[壹贰貳叁參肆伍陆陸柒捌玖]分)$/.test(
      fraction,
    ) ||
    /[壹贰貳叁參肆伍陆陸柒捌玖]{2}|零零|拾拾|佰佰|仟仟|万万|亿亿/.test(whole)
  )
    throw new Error('大写金额格式错误');
  let total = 0n,
    section = 0n,
    num = 0n,
    lastUnit = 10000n;
  let pendingDigit = false,
    afterZero = false;
  for (const ch of whole) {
    if (ch in digits) {
      num = digits[ch];
      pendingDigit = num !== 0n;
      afterZero = num === 0n;
    } else if (ch in units) {
      if (
        units[ch] >= lastUnit ||
        afterZero ||
        (!pendingDigit && !(ch === '拾' && section === 0n))
      )
        throw new Error('大写金额单位顺序错误');
      section += (num || 1n) * units[ch];
      num = 0n;
      pendingDigit = false;
      lastUnit = units[ch];
    } else if (ch === '万') {
      section = (section + num) * 10000n;
      num = 0n;
      lastUnit = 10000n;
      pendingDigit = false;
      afterZero = false;
    } else if (ch === '亿') {
      total = (total + section + num) * 100000000n;
      section = 0n;
      num = 0n;
      lastUnit = 10000n;
      pendingDigit = false;
      afterZero = false;
    }
  }
  let cents = (total + section + num) * 100n;
  if (!['整', '正'].includes(fraction)) {
    const j = fraction.match(/([零壹贰貳叁參肆伍陆陸柒捌玖])角/);
    const f = fraction.match(/([零壹贰貳叁參肆伍陆陸柒捌玖])分/);
    if (j) cents += digits[j[1]] * 10n;
    if (f) cents += digits[f[1]];
  }
  if (cents > INT64_MAX) throw new Error('金额超出 64 位范围');
  return cents;
}
export interface RuleInput {
  c: ContractRow;
  parsed: ParsedDocument;
  evidence: string[];
  policies: PolicyDto[];
  orgName: string;
  supplierName: string | null;
  allowedPrefixes?: string[];
  isDirectStation?: boolean;
}
export function legalRules(input: RuleInput): {
  findings: LegalFinding[];
  elements: Record<string, string | string[]>;
} {
  const { c, parsed, evidence, policies } = input;
  const text = norm(parsed.text);
  const findings = [...parsed.findings];
  const elements: Record<string, string | string[]> = {};
  const policy = (tag: string) =>
    policies.flatMap((p) => p.clauses).find((c) => c.ruleTags.includes(tag))
      ?.id ?? null;
  const locate = (pattern: RegExp): Paragraph | undefined =>
    parsed.paragraphs.find((p) => pattern.test(norm(p.text)));
  const add = (
    code: string,
    title: string,
    pattern?: RegExp,
    tag = 'elements',
    severity: LegalFinding['severity'] = 'high',
    blocking = true,
    expectedText = title,
  ) => {
    const p = pattern ? locate(pattern) : undefined;
    findings.push({
      source: 'rule',
      code,
      severity,
      blocking,
      title,
      message: title,
      locationRef: p
        ? `${p.heading || '正文'} / P${p.index} / 第${p.page}页${p.table ? ` / 表${p.table}行${p.row}列${p.cell}` : ''}`
        : '全文（缺失要素）',
      excerpt: p?.text ?? '',
      expectedText,
      suggestedText: `请核对并补齐：${expectedText}`,
      policyClauseId: policy(tag),
      templateClauseId: null,
    });
  };
  if (parsed.status !== 'ok' || text.length < 80)
    add(
      'TEXT_EMPTY_OR_UNREADABLE',
      '正文完整性或可读性不足，需人工核对',
      undefined,
      'elements',
      'medium',
      false,
    );
  if (!text) return { findings, elements };
  if (/【[^】]*】|_{3,}/.test(text))
    add('PLACEHOLDER_UNFILLED', '正文含未填写占位项', /【|_{3,}/);
  if (/《(?:中华人民共和国)?合同法》/.test(text))
    add('OBSOLETE_LAW_BASIS', '仍引用已废止的合同法', /合同法/);
  const no = c.contract_no.normalize('NFKC').toUpperCase();
  const prefixPattern =
    input.allowedPrefixes && input.allowedPrefixes.length > 0
      ? input.allowedPrefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
      : '[A-Z]{2,4}';
  if (
    !Number(c.external_no_exempt ?? 0) &&
    c.migration_mode !== 'legacy_tolerant' &&
    !new RegExp(
      `^(?:${prefixPattern})[-－/](?:JG|SG|SJ|CW|TH|XF|QT)[-－]\\d+(?:[（(]补\\d+[）)])?[/／]\\d{4}[-－]\\d+$`,
    ).test(no)
  ) {
    const pending = new RegExp(
      `^(?:${prefixPattern})[-－/](?:JG|SG|SJ|CW|TH|XF|QT)[-－]\\d+(?:[（(]补\\d+[）)])?[/／-]\\d{4}[-－]?$`,
    ).test(no);
    add(
      'CONTRACT_NO_FORMAT',
      pending
        ? '流水号待赋号，请在签署前补齐'
        : '合同编号单位码、类别码或格式不符',
      /合同编号/,
      'number',
      pending ? 'info' : 'medium',
      !pending,
    );
  }
  const essentials: [string, RegExp][] = [
    ['合同名称', /合同|协议/],
    ['双方主体', /(甲方|买方|委托方)[：:].+(乙方|卖方|受托方)[：:]/],
    ['标的或工作范围', /标的|供货|工作范围|服务内容|施工内容|工程内容/],
    ['价款', /总价|总金额|合同价|合同金额/],
    ['付款安排', /付款|支付|价款结算/],
    ['履行期限', /交付|交货|工期|履行期限|完工|服务期限/],
    ['验收', /验收/],
    ['违约责任', /违约/],
    ['争议解决', /争议|纠纷/],
    ['解除及善后', /解除[\s\S]*(善后|结算|返还|移交|清算)/],
    ['签署要素', /(签字|签章|盖章)[\s\S]*(日期|年月日|年.*月.*日)/],
  ];
  for (const [name, rx] of essentials)
    if (!rx.test(text))
      add(
        'ESSENTIAL_CLAUSE_MISSING',
        `缺少${name}`,
        undefined,
        name === '解除及善后' ? 'termination' : 'elements',
      );
  if (
    !/(未签署|未签订|签署前)[\s\S]{0,30}(未生效|生效前)[\s\S]{0,25}(不得|禁止)[\s\S]{0,10}(实质履行|施工|供货|履行)/.test(
      text,
    ) ||
    /(未生效|签署前|签订前).{0,12}(先行|应当|应|可以).{0,8}(施工|供货|履行)/.test(
      text,
    )
  )
    add(
      'SUBSTANTIVE_PERF_BEFORE_EFFECTIVE',
      '未明确禁止未签署或未生效前实质履行，或存在先履行约定',
      /未生效|先行|生效/,
      'effective',
    );
  const dispute = parsed.paragraphs
    .filter((p) => /争议|仲裁|诉讼|起诉/.test(p.text))
    .map((p) => p.text)
    .join('');
  if (
    (/仲裁/.test(dispute) && /起诉|诉讼|人民法院/.test(dispute)) ||
    /当地仲裁|有关仲裁|某仲裁|仲裁委员会[【_]/.test(dispute)
  )
    add('DISPUTE_DUAL_CONFLICT', '争议解决约定冲突或机构不明确', /仲裁|起诉/);
  const amountLines = parsed.paragraphs.filter((p) =>
    /总价|总金额|合同金额|合同价款/.test(p.text),
  );
  const amountText = norm(amountLines.map((p) => p.text).join(' '));
  const lower = amountText.match(
    /(?:[¥￥]|小写[：:]?|总价(?:为|[：:])?|合同金额(?:为|[：:])?)([\d,]+(?:\.\d{1,2})?)(万元|元)?(?![\d.])/,
  );
  const upper = amountText.match(
    /([零壹贰貳叁參肆伍陆陸柒捌玖拾佰仟万亿元圆角分整正]+[元圆](?:整|正|[零壹贰貳叁參肆伍陆陸柒捌玖角分]+))/,
  );
  const variable = /单价据实|据实结算|暂估|暂定|固定单价|最高限价/.test(text);
  const isUnitPriceZero = c.pricing_mode === 'unit_price' && currentCents(c) === 0n;
  elements.totalAmount = isUnitPriceZero
    ? (c.estimated_ceiling_cents != null ? `上限 ${centsToDecimalString(BigInt(c.estimated_ceiling_cents))}` : '单价据实结算')
    : centsToDecimalString(currentCents(c));
  elements.amountUppercase = upper?.[1] ?? '';
  if (isUnitPriceZero) {
    elements.unitPriceDesc = c.unit_price_desc ?? '';
    if (!/单价|计价标准|费率|结算标准|据实结算/.test(text)) {
      add('UNIT_PRICE_TERMS_MISSING', '单价合同须在正文中明确单价标准及计量结算方式', /价款|计价|单价/);
    }
    if (c.estimated_ceiling_cents == null && !/最高限价|上限|估算总额|控制价|调价|价格调整/.test(text)) {
      add('VARIABLE_PRICE_REQUIRES_CHECK', '单价或暂估合同需人工核对计量单价、调价及上限条款', /单价|计价|上限/, 'elements', 'medium', false);
    }
  } else {
    try {
      if (!lower || !upper) throw new Error('金额无法识别');
      const lc =
        parseDecimalToCents(lower[1].replace(/,/g, '')) *
        (lower[2] === '万元' ? 10000n : 1n);
      const uc = uppercaseCents(upper[1]);
      if (lc > INT64_MAX) throw new Error('金额越界');
      if (lc !== uc || lc !== currentCents(c))
        add(
          'AMOUNT_UPPER_LOWER_MISMATCH',
          '大小写金额或台账金额不一致',
          /总价|总金额|合同金额/,
          'elements',
          variable ? 'medium' : 'high',
          !variable,
        );
      if (variable)
        add(
          'VARIABLE_PRICE_REQUIRES_CHECK',
          '单价或暂估合同需人工核对数量、单价及上限',
          /单价|暂估|暂定/,
          'elements',
          'medium',
          false,
        );
    } catch {
      add(
        'AMOUNT_UNPARSEABLE',
        '大小写金额无法可靠解析，请人工核验',
        /总价|合同金额/,
        'elements',
        'medium',
        false,
      );
    }
  }
  const payments = parsed.paragraphs.filter(
    (p) =>
      /付款|支付|款：|质保金|保证金|预付款/.test(p.text) &&
      !/(税率|违约金)/.test(p.text),
  );
  const ratios = payments.flatMap((p) =>
    [...norm(p.text).matchAll(/(\d+(?:\.\d{1,6})?)%/g)].map((m) => m[1]),
  );
  elements.paymentRatios = ratios;
  try {
    let sum = 0n;
    for (const p of payments)
      for (const m of norm(p.text).matchAll(/(\d+(?:\.\d{1,6})?)%/g)) {
        const value = parseScaled(m[1], 6);
        const cumulative = /支付至|累计[^。；]*$/.test(
          norm(p.text).slice(0, m.index),
        );
        if (cumulative) {
          if (value < sum)
            add('PAYMENT_RATIO_SUM_INVALID', '累计付款比例倒置', /支付/);
          sum = value;
        } else sum += value;
      }
    if (ratios.length && sum !== 100000000n) {
      if (
        ratios.length === 1 &&
        /余款|剩余款|尾款/.test(payments.map((p) => p.text).join(''))
      )
        add(
          'PAYMENT_SCHEDULE_UNVERIFIED',
          '分期付款含未量化余款，需人工核验',
          /余款|剩余款|尾款/,
          'elements',
          'medium',
          false,
        );
      else
        add(
          'PAYMENT_RATIO_SUM_INVALID',
          '分期付款比例合计不等于 100%',
          /付款|支付|质保金/,
        );
    }
  } catch {
    add('PAYMENT_RATIO_SUM_INVALID', '付款比例无法精确解析', /支付/);
  }
  try {
    const installments = payments.flatMap((p) =>
      [
        ...norm(p.text).matchAll(
          /(?:本期支付|分期金额|支付人民币)(\d+(?:\.\d{1,2})?)元/g,
        ),
      ].map((m) => parseDecimalToCents(m[1])),
    );
    if (
      !isUnitPriceZero &&
      installments.length > 1 &&
      installments.reduce((s, v) => s + v, 0n) !== currentCents(c)
    )
      add('PAYMENT_RATIO_SUM_INVALID', '分期金额之和不等于合同总价', /支付/);
  } catch {
    add(
      'AMOUNT_UNPARSEABLE',
      '分期金额超出有效范围或无法解析，请人工核验',
      /支付/,
      'elements',
      'medium',
      false,
    );
  }
  if (
    !/(含税|不含税)/.test(text) ||
    !/税率.{0,10}\d+(?:\.\d+)?%/.test(text) ||
    !/(增值税专用|增值税普通|普通发票|专用发票)/.test(text)
  )
    add(
      'TAX_INVOICE_UNCLEAR',
      '含税口径、增值税率或发票类型未明确',
      /税|发票/,
      'elements',
      'medium',
    );
  const tierAmount = isUnitPriceZero && c.estimated_ceiling_cents != null
    ? BigInt(c.estimated_ceiling_cents)
    : currentCents(c);
  const tier = procurementTier(
    !!Number(c.is_procurement),
    c.procurement_target,
    tierAmount,
    c.procurement_method,
  );
  elements.procurementTier = tier ?? '未填采购对象';
  const required =
    c.legal_category === 'income_sales' || c.direction === 'income'
      ? ['client_written_offer']
      : !Number(c.is_procurement)
        ? ['company_approval']
        : tier === 'exempt_small'
          ? []
          : tier === 'tier_1' || tier === 'tier_2'
            ? [
                'procurement_scheme_approval',
                'bid_award_approval',
                'award_notice',
                'evaluation_report',
              ]
            : ['bid_award_approval'];
  const missing = required.filter((k) => !evidence.includes(k));
  if (
    (Number(c.is_procurement) &&
      (!c.procurement_target || !c.procurement_method)) ||
    missing.length
  )
    add(
      'PROCUREMENT_TIER_EVIDENCE_MISSING',
      `签订依据不足：${missing.join('、') || '采购对象/方式未填'}`,
      undefined,
      'signing',
    );
  if (currentCents(c) <= 3000000n && Number(c.is_procurement))
    add(
      'SMALL_DIRECT_REIMBURSE_HINT',
      '3 万元以内且内容单一、无后续服务时，可核实直接发票报账适用性',
      undefined,
      'procurement',
      'info',
      false,
    );
  if (
    (c.direction === 'income' || c.legal_category === 'income_sales') &&
    Boolean(input.isDirectStation) &&
    c.signing_entity_level !== 'company'
  ) {
    add('DIRECT_STATION_INCOME_ENTITY', '直属水电站资金进项合同须以公司名义签订', /甲方|乙方|签署/, 'signing');
  }
  if (
    Number(c.is_important) ||
    /股权|对外担保|借贷融资|并购|合资合作/.test(text)
  ) {
    if (
      !evidence.includes('legal_opinion') ||
      !evidence.includes('triple_major_decision')
    )
      add(
        'IMPORTANT_CONTRACT_GATE',
        '重要合同缺法律顾问意见或“三重一大”决策材料',
        undefined,
        'important',
      );
    add(
      'IMPORTANT_CONTRACT_MANUAL',
      '重要合同须由法律顾问及主管部门完成实质审查',
      undefined,
      'important',
      'medium',
      false,
    );
  }
  if (dateSequenceConflict(c, text))
    add(
      'DATE_SEQUENCE_CONFLICT',
      '签订、生效、交付、验收或质保日期顺序冲突',
      /日期|交付|完工/,
    );
  const partyA =
    text.match(
      /(?:甲方|买方|委托方)[（(]?(?:甲方)?[）)]?[：:]([^，。；\n]+?)(?=乙方|卖方|受托方|签订日期|根据|$)/,
    )?.[1] ?? '';
  const partyB =
    text.match(
      /(?:乙方|卖方|受托方)[（(]?(?:乙方)?[）)]?[：:]([^，。；\n]+?)(?=签订日期|根据|第一条|$)/,
    )?.[1] ?? '';
  elements.partyA = partyA;
  elements.partyB = partyB;
  const supplierIsA = ['seller', 'contractor', 'provider'].includes(
    c.party_role,
  );
  if (
    (input.supplierName &&
      !(supplierIsA ? partyA : partyB).includes(norm(input.supplierName))) ||
    (input.orgName &&
      !(supplierIsA ? partyB : partyA).includes(norm(input.orgName)))
  )
    add(
      'PARTY_SUPPLIER_MISMATCH',
      '正文签约主体或相对方与台账不一致',
      /甲方|乙方|买方|卖方/,
    );
  for (const [key, rx] of [
    ['subject', /标的|供货|服务内容|工程内容/],
    ['term', /工期|交付日期|服务期限|到货时间/],
    ['warranty', /质保期|保修期/],
    ['liability', /违约金|赔偿/],
    ['dispute', /争议|仲裁|起诉/],
    ['tax', /税率/],
  ] as const) {
    const p = parsed.paragraphs.find(
      (p) =>
        rx.test(norm(p.text)) &&
        !/^(甲方|乙方|买方|卖方|委托方|受托方)[：:]/.test(p.text) &&
        !/^第[^\s]+[条章节]\s*[^，。；：:]{0,16}$/.test(p.text) &&
        !(key === 'warranty' && /^质保金/.test(p.text)),
    );
    elements[key] = p?.text ?? '';
  }
  return { findings, elements };
}
