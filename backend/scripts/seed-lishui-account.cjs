/**
 * 澧水集团预算科目树初始化(完整适配 · 第二步)
 *
 * 依据用户预算模板:收入成本表 / 发电收入 / 非电收入 / 非电营业成本 / 管理费用 / 人工成本表
 * 建成三类科目森林:I=income 收入 / C=cost 成本 / E=expense 费用
 * 并配置利润表指标(P01~P07)。
 *
 * 归一化口径(与模板差异,详见 docs/澧水预算科目编码.md):
 *  - 各子公司清单中的"营业外收入/营业外支出/政府补助/所得税/资产减值损失"归位到主分类节点;
 *  - "资产减值损失"并入主表"信用减值损失(处置损益)"科目;
 *  - 非金额行(上网电量/电价/税率/职工人数等)留待数量型科目扩展,本步不建;
 *  - 管理费用表"一~五"汇总类目不建节点(模板未定义归集口径),"人工成本"子树按人工成本表展开;
 *  - 模板序号错乱(人工成本表两个"五"等)按语义修正编号。
 *
 * 用法: node scripts/seed-lishui-account.cjs   (在 backend 目录下运行)
 * 幂等: 已存在的编码跳过并校验名称一致;存在外来编码则中止。
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const BASE = 'http://127.0.0.1:3748';
const TEMPLATE = '/tmp/budget-template.xlsx';

/* ============ 科目树定义 ============ */
/* 节点:[编码, 名称, 子节点?];根节点第 4 位为类型,子节点继承 */
const TREE = [
  ['I1', '营业收入', 'income', [
    ['I11', '发电产业收入', [
      ['I1101', '上网电量收入'],
      ['I1103', '两项细则奖励'],
    ]],
    ['I12', '非电产业收入', [
      ['I1201', '炉慈高速永久占地补偿'],
      ['I1202', '炉慈高速公路临时用地（水域）合同'],
      ['I1203', '武汉办事处房屋处置收入'],
      ['I1204', '酒店租赁'],
      ['I1205', '租赁及销售'],
      ['I1206', '收取泽通公司电费'],
      ['I1207', '资源利用补偿（皂市）'],
      ['I1208', '香樟路多功能综合楼确认收入'],
      ['I1209', '城镇供水'],
      ['I1210', '门票收入'],
      ['I1211', '其他'],
      ['I1212', '管理服务费收入'],
      ['I1213', '提供澧水公司服务人员费用'],
      ['I1214', '安全监测及内外观'],
      ['I1215', '毛俊工程建设管理'],
      ['I1216', '技术服务'],
      ['I1217', '海外项目'],
      ['I1218', '水工程院额外创收（保证收支平衡）'],
      ['I1219', '闲置资产租赁'],
      ['I1220', '西洞庭沙河治理工程运维服务费'],
      ['I1221', '档案管理'],
      ['I1222', '食堂管理'],
      ['I1223', '西洞庭项目劳务收入'],
      ['I1224', '信息中心管理服务合同'],
      ['I1225', '市场部创收'],
      ['I1226', '篮球馆收入'],
      ['I1227', '江垭、皂市水库库区管理服务'],
      ['I1228', '办公楼装修及景观绿化改造'],
      ['I1229', '皂市水电站物业管理'],
      ['I1230', '十家坪场地平整'],
      ['I1231', '水务服务'],
      ['I1232', '办公楼装修'],
      ['I1233', '温泉收入'],
      ['I1234', '商场收入'],
      ['I1235', '客房收入'],
      ['I1236', '餐厅收入'],
      ['I1237', '电站食堂收入'],
      ['I1238', '物业管理'],
      ['I1239', '灌装水'],
      ['I1240', '皂市电站物业收入'],
      ['I1241', '长沙基地物业收入'],
      ['I1242', '江垭电站物业收入'],
      ['I1243', '外部物业收入'],
      ['I1244', '澧水家园物业收入'],
      ['I1245', '驾驶员服务收入'],
      ['I1246', '检修收入'],
      ['I1247', '充电桩收入', [
        ['I12471', '福湘酒店'],
        ['I12472', '药监局项目'],
        ['I12473', '雷公岭项目'],
        ['I12474', '001充电桩'],
        ['I12475', '002充电桩'],
      ]],
      ['I1248', '售电业务'],
      ['I1249', '委托电力营销'],
      ['I1250', '防汛调度'],
      ['I1251', '借调人员服务费'],
      ['I1252', '增值税销项税'],
    ]],
  ]],
  ['I2', '投资收益', 'income'],
  ['I3', '营业外收入', 'income', [
    ['I301', '政府补助'],
    ['I302', '非流动资产处置利得'],
    ['I303', '其他'],
  ]],

  ['C1', '营业成本', 'cost', [
    ['C11', '发电产业成本', [
      ['C1101', '制造费用'],
      ['C1102', '运行检修与更新改造费'],
      ['C1103', '财产保险费'],
      ['C1104', '固定资产折旧费'],
      ['C1105', '无形资产摊销费'],
      ['C1106', '水资源费'],
      ['C1107', '库区基金'],
      ['C1108', '水利建设基金'],
      ['C1109', '下网电量电费'],
      ['C1110', '其他'],
    ]],
    ['C12', '非电产业成本', [
      ['C1201', '其他'],
      ['C1202', '运行维护费'],
      ['C1203', '折旧'],
      ['C1204', '政府补助'],
      ['C1205', '项目公司本部'],
      ['C1206', '水工程公司'],
      ['C1207', '酒店租赁使用费'],
      ['C1208', '职工食堂服务合同款'],
      ['C1209', '皂市电站物业费'],
      ['C1210', '江垭租赁使用费'],
      ['C1211', '皂市食堂食材采购费'],
      ['C1212', '档案技术服务费'],
      ['C1213', '福湘公司长期待摊费用'],
      ['C1214', '十家坪营地闲置土地平整项目剩余待摊费用'],
      ['C1215', '温泉成本'],
      ['C1216', '客房成本'],
      ['C1217', '餐厅成本'],
      ['C1218', '电站食堂'],
      ['C1219', '罐装水'],
      ['C1220', '物业管理'],
      ['C1221', '管理类费用'],
      ['C1222', '充电桩电费'],
      ['C1223', '保险'],
      ['C1224', '运维'],
    ]],
  ]],
  ['C2', '增值税', 'cost'],
  ['C3', '税金及附加', 'cost', [
    ['C301', '其他'],
    ['C302', '城市维护建设税'],
    ['C303', '教育费附加'],
    ['C304', '房产税'],
    ['C305', '土地使用税'],
    ['C306', '印花税'],
    ['C307', '水利建设基金'],
    ['C308', '残保基金'],
  ]],
  ['C4', '信用减值损失（处置损益）', 'cost'],
  ['C5', '营业外支出', 'cost', [
    ['C501', '非流动资产处置损失'],
    ['C502', '公益性捐赠支出'],
    ['C503', '其他'],
  ]],
  ['C6', '所得税费用', 'cost'],

  ['E1', '销售费用', 'expense'],
  ['E2', '管理费用', 'expense', [
    ['E201', '人工成本', [
      ['E2011', '工作人员工资', [
        ['E20111', '在编职工'],
        ['E20112', '编外职工', [
          ['E201121', '合同工'],
          ['E201122', '劳务派遣'],
          ['E201123', '辞退补偿金'],
        ]],
      ]],
      ['E2012', '工会经费'],
      ['E2013', '职工福利费', [
        ['E20131', '职工工作服', [
          ['E201311', '传统节日（7个节）', [
            ['E2013111', '在编职工'],
            ['E2013112', '退休职工'],
            ['E2013113', '编外职工'],
          ]],
          ['E201312', '春节值班慰问费', [
            ['E2013121', '在编职工'],
            ['E2013122', '编外职工'],
          ]],
        ]],
        ['E20132', '独生子女费'],
        ['E20133', '煤气补贴', [
          ['E201331', '在编职工'],
          ['E201332', '退休职工'],
        ]],
        ['E20134', '职工体检费', [
          ['E201341', '在编职工'],
          ['E201342', '退休职工'],
          ['E201343', '编外职工'],
        ]],
        ['E20135', '职工工作餐', [
          ['E201351', '工作餐补贴'],
          ['E201352', '值班用餐'],
          ['E201353', '检修用餐'],
          ['E201354', '食堂管理费'],
          ['E201355', '食堂其他费用'],
        ]],
        ['E20136', '退休人员费用'],
        ['E20137', '疫情防控专项资金'],
        ['E20138', '其他'],
      ]],
      ['E2014', '劳动保护费', [
        ['E20141', '劳保用品'],
        ['E20142', '防暑保暖费', [
          ['E201421', '在编职工'],
          ['E201422', '编外职工'],
        ]],
        ['E20143', '管理用工作服'],
        ['E20144', '生产用工作服', [
          ['E201441', '在编职工'],
          ['E201442', '编外职工'],
        ]],
        ['E20145', '生产用劳保用品', [
          ['E201451', '在编职工'],
          ['E201452', '编外职工'],
        ]],
      ]],
      ['E2015', '社会保险费', [
        ['E20151', '在编职工'],
        ['E20152', '编外职工'],
      ]],
      ['E2016', '职工教育经费'],
    ]],
    ['E202', '办公费', [
      ['E2021', '报刊杂志费'],
      ['E2022', '个人业务电话费'],
      ['E2023', '办公用品等（含座机话费）'],
      ['E2024', '公司文印室费用'],
    ]],
    ['E203', '差旅费'],
    ['E204', '会议费'],
    ['E205', '车船使用费'],
    ['E206', '市内交通费'],
    ['E207', '业务应酬费', [
      ['E2071', '公务招待费'],
      ['E2072', '商务招待费'],
    ]],
    ['E208', '技术图纸资料费'],
    ['E209', '固定资产折旧'],
    ['E210', '党组织工作经费', [
      ['E2101', '公司统一组织活动'],
      ['E2102', '部门活动'],
      ['E2103', '其他'],
    ]],
    ['E211', '文明单位创建'],
    ['E212', '后勤服务费', [
      ['E2121', '公司机关', [
        ['E21211', '长沙基地运行维护费'],
        ['E21212', '水电费'],
      ]],
      ['E2122', '直属电站和分子公司', [
        ['E21221', '物业管理'],
        ['E21222', '治安保卫'],
        ['E21223', '绿化费'],
        ['E21224', '电视收视费'],
        ['E21225', '房屋租赁'],
        ['E21226', '垃圾清运费'],
        ['E21227', '节日布置费'],
        ['E21228', '网络使用费'],
      ]],
    ]],
    ['E213', '广告宣传费'],
    ['E214', '社会团体会费'],
    ['E215', '中介机构费'],
    ['E216', '律师代理费'],
    ['E217', '市场开发费/研究开发费'],
    ['E218', '无形资产摊销'],
    ['E219', '财产保险费'],
    ['E220', '出国考察费'],
    ['E221', '其他', [
      ['E2211', '职工食堂'],
      ['E2212', '司机服务费'],
      ['E2213', '老干经费'],
      ['E2214', '招待所费用'],
      ['E2215', '档案及保密费用'],
      ['E2216', '新职工办公用家电'],
      ['E2217', '其他'],
    ]],
  ]],
  ['E3', '财务费用', 'expense', [
    ['E301', '利息支出'],
    ['E302', '金融机构手续费'],
    ['E303', '汇兑损益'],
    ['E304', '利息收入'],
  ]],
];

/* ============ 数量型科目树(模板非金额行) ============ */
const QTREE = [
  { code: 'Q1', name: '电量指标', unit: '万度', agg: 'sum', children: [
    { code: 'Q101', name: '上网电量', unit: '万度', agg: 'sum' },
    { code: 'Q103', name: '发电量', unit: '万度', agg: 'sum' },
  ]},
  { code: 'Q2', name: '含增值税上网电价', unit: '元/度', agg: 'none' },
  { code: 'Q3', name: '增值税税率', unit: '%', agg: 'none' },
  { code: 'Q4', name: '职工人数（平均）', unit: '人', agg: 'none', children: [
    { code: 'Q401', name: '在编职工', unit: '人', agg: 'sum', children: [
      { code: 'Q4011', name: '已在编职工', unit: '人', agg: 'sum' },
      { code: 'Q4012', name: '新进职工', unit: '人', agg: 'sum' },
    ]},
    { code: 'Q402', name: '退休职工', unit: '人', agg: 'none' },
    { code: 'Q403', name: '编外职工', unit: '人', agg: 'sum', children: [
      { code: 'Q4031', name: '合同工', unit: '人', agg: 'sum' },
      { code: 'Q4032', name: '劳务派遣', unit: '人', agg: 'sum' },
    ]},
  ]},
];

/* ============ 利润表指标 ============ */
/* 管理口径：总收入含投资及营业外收入；总成本含营业外支出和所得税，不含增值税。 */
const METRICS = [
  { code: 'P01', name: '营业总收入', displayOrder: 1, terms: [{ code: 'I1' }] },
  { code: 'P02', name: '营业总成本', displayOrder: 2, displaySign: -1, terms: [{ code: 'C1' }, { code: 'C3' }, { code: 'C4' }, { code: 'E1' }, { code: 'E2' }, { code: 'E3' }] },
  { code: 'P03', name: '营业利润', displayOrder: 3, terms: [{ metric: 'P01' }, { metric: 'P02' }, { code: 'I2' }] },
  { code: 'P07', name: '总收入', displayOrder: 6, terms: [{ metric: 'P01' }, { code: 'I2' }, { code: 'I3' }] },
  { code: 'P06', name: '总成本', displayOrder: 7, displaySign: -1, terms: [{ metric: 'P02' }, { code: 'C5' }, { code: 'C6' }] },
  { code: 'P05', name: '净利润', displayOrder: 5, terms: [{ metric: 'P07' }, { metric: 'P06' }] },
  { code: 'P04', name: '利润总额', displayOrder: 4, terms: [{ metric: 'P05' }, { code: 'C6', coefficient: -1 }] },
  { code: 'R01', name: '营业利润率', displayOrder: 101, kind: 'ratio', direction: 'higher_better', displayFormat: 'percent', terms: [{ metric: 'P03', role: 'numerator' }, { metric: 'P01', role: 'denominator' }] },
  { code: 'R02', name: '净利率', displayOrder: 102, kind: 'ratio', direction: 'higher_better', displayFormat: 'percent', terms: [{ metric: 'P05', role: 'numerator' }, { metric: 'P07', role: 'denominator' }] },
  { code: 'R03', name: '管理费用率', displayOrder: 103, kind: 'ratio', direction: 'lower_better', displayFormat: 'percent', terms: [{ code: 'E2', coefficient: -1, role: 'numerator' }, { code: 'I1', role: 'denominator' }] },
  { code: 'R04', name: '平均上网电价', displayOrder: 104, kind: 'ratio', direction: 'higher_better', displayFormat: 'number', unit: '元/万度', terms: [{ code: 'I1101', role: 'numerator' }, { code: 'Q101', role: 'denominator' }] },
  { code: 'R05', name: '度电营业成本', displayOrder: 105, kind: 'ratio', direction: 'lower_better', displayFormat: 'number', unit: '元/万度', terms: [{ code: 'C1', coefficient: -1, role: 'numerator' }, { code: 'Q101', role: 'denominator' }] },
];

/* ============ 模板中"不是科目"的名称(汇总行/数量行/组织行/口径归位),交叉校验白名单 ============ */
const TEMPLATE_EXCEPTIONS = new Set([
  // 表头/汇总行
  '序号', '项目', '汇总', '总收入', '总成本', '利润总额', '减：所得税费用', '净利润', '期间费用',
  '管理类费用合计', '一、人工成本', '二、五项费用', '三、其他可控费用', '四、税费折旧摊销等不可控费用', '五、可控费用',
  // 数量/单价/税率行(待数量型科目扩展)
  '上网电量', '直供电量', '发电量', '含增值税上网电价', '增值税税率', '上网电量（万度）', '职工人数（平均）', '新进职工', '已在编职工',
  // 归一化更名(科目存在但名称不同)
  '发电产业', '发电产业收入', '发电收入', '水力发电收入', '资产减值损失', '增值税', '所得税', '其中：折旧', '社会保险费（劳保支出）',
  // 组织/电站维度(对应组织树,非科目)
  '澧水公司总部', '索溪分公司', '彩石公司', '澧能公司', '项目公司', '泽通公司', '泽通公司汇总', '泽通公司本部',
  '江垭温泉', '博弘物业', '机电公司', '水力发电', '风力发电', '光伏发电',
  '江垭电站', '皂市电站', '大熊山', '倪家洞', '六字界', '六字界风电场', '白竹', '白竹风电场', '磨子岭', '磨子岭风电场', '天子山',
  '银腾光伏项目', '长沙基地光伏项目', '国检光伏项目',
]);

function fail(msg) { console.error('FATAL: ' + msg); process.exit(1); }
const TYPE_BY_PREFIX = { I: 'income', C: 'cost', E: 'expense' };

async function main() {
  /* ---------- 登录 ---------- */
  const cfg = {
    username: process.env.NEWFC_ACCESS_USER,
    password: process.env.NEWFC_ACCESS_PASSWORD,
  };
  if (!cfg.username || !cfg.password) fail('请先设置 NEWFC_ACCESS_USER 和 NEWFC_ACCESS_PASSWORD');
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cfg),
  });
  if (!loginRes.ok) fail('登录失败: ' + (await loginRes.text()));
  const { token } = await loginRes.json();
  const H = { 'content-type': 'application/json', 'x-access-token': token };
  console.log('[0] API 登录成功');

  /* ---------- 外来数据守卫 ---------- */
  const acct = await (await fetch(`${BASE}/api/account/tree`, { headers: H })).json();
  const existing = new Map(acct.rows.map(r => [r.code, r]));
  const treeCodes = new Set();
  const walk = ns => ns.forEach(([c, , third, fourth] ) => {
    treeCodes.add(c);
    const children = Array.isArray(third) ? third : (Array.isArray(fourth) ? fourth : undefined);
    if (children) walk(children);
  });
  walk(TREE);
  const walkQ = ns => ns.forEach(n => {
    treeCodes.add(n.code);
    if (n.children) walkQ(n.children);
  });
  walkQ(QTREE);
  for (const code of existing.keys()) if (!treeCodes.has(code)) fail(`科目表存在外来编码 ${code},为避免冲突已中止(请人工确认)`);

  /* ---------- 递归创建(幂等) ---------- */
  let created = 0, reused = 0, sortOrder = 0;
  const idByCode = new Map(existing.size ? acct.rows.map(r => [r.code, r.id]) : []);
  const createNode = async (node, parentId, type) => {
    const [code, name, third, fourth] = node;
    /* 根节点:[code, name, type, children];普通节点:[code, name, children] */
    const children = Array.isArray(third) ? third : (Array.isArray(fourth) ? fourth : undefined);
    sortOrder += 1;
    if (existing.has(code)) {
      const row = existing.get(code);
      if (row.name !== name || row.type !== type) fail(`编码 ${code} 已存在但名称/类型不一致: 库内=${row.name}/${row.type}, 脚本=${name}/${type}`);
      reused += 1;
    } else {
      const res = await fetch(`${BASE}/api/account`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ parentId, code, name, type, sortOrder }),
      });
      if (!res.ok) fail(`创建 ${code} ${name} 失败: ${await res.text()}`);
      const row = await res.json();
      idByCode.set(code, row.id);
      created += 1;
    }
    const myId = idByCode.get(code);
    if (children) for (const ch of children) await createNode(ch, myId, type);
  };
  const createQuantityNode = async (node, parentId) => {
    sortOrder += 1;
    if (existing.has(node.code)) {
      const row = existing.get(node.code);
      if (row.name !== node.name || row.type !== 'quantity') fail(`编码 ${node.code} 已存在但名称/类型不一致: 库内=${row.name}/${row.type}`);
      reused += 1;
    } else {
      const res = await fetch(`${BASE}/api/account`, {
        method: 'POST', headers: H,
        body: JSON.stringify({ parentId, code: node.code, name: node.name, type: 'quantity', unit: node.unit, quantityAgg: node.agg, sortOrder }),
      });
      if (!res.ok) fail(`创建数量科目 ${node.code} ${node.name} 失败: ${await res.text()}`);
      const row = await res.json();
      idByCode.set(node.code, row.id);
      created += 1;
    }
    const myId = idByCode.get(node.code);
    if (node.children) for (const ch of node.children) await createQuantityNode(ch, myId);
  };
  for (const root of TREE) {
    const type = TYPE_BY_PREFIX[root[0][0]];
    await createNode(root, null, type);
  }
  for (const qroot of QTREE) await createQuantityNode(qroot, null);
  console.log(`[1] 科目创建完成: 新建 ${created} 个, 复用 ${reused} 个, 合计 ${treeCodes.size} 个`);

  /* ---------- 结构检查 ---------- */
  const check = await (await fetch(`${BASE}/api/account/check`, { headers: H })).json();
  if (!check.ok) fail('科目结构检查未通过: ' + JSON.stringify(check.problems));
  const after = await (await fetch(`${BASE}/api/account/tree`, { headers: H })).json();
  const leaves = after.rows.filter(r => !after.rows.some(x => x.parent_id === r.id));
  const typeCount = { income: 0, cost: 0, expense: 0 };
  after.rows.forEach(r => typeCount[r.type] += 1);
  console.log(`[2] 结构检查通过: 总数 ${after.rows.length}(收入 ${typeCount.income}/成本 ${typeCount.cost}/费用 ${typeCount.expense}), 叶子 ${leaves.length} 个`);

  /* ---------- 利润表指标(幂等) ---------- */
  const metricList = await (await fetch(`${BASE}/api/metrics`, { headers: H })).json();
  const metricByCode = new Map(metricList.items.map(m => [m.code, m]));
  let metricCreated = 0, metricUpdated = 0;
  for (const m of METRICS) {
    const terms = m.terms.map((t, i) => t.code
      ? { sourceType: 'account', sourceAccountId: idByCode.get(t.code), sourceMetricId: null, coefficient: t.coefficient ?? 1, sortOrder: i + 1, role: t.role ?? 'term' }
      : { sourceType: 'metric', sourceAccountId: null, sourceMetricId: metricByCode.get(t.metric)?.id, coefficient: t.coefficient ?? 1, sortOrder: i + 1, role: t.role ?? 'term' });
    if (terms.some(t => t.sourceType === 'account' && !t.sourceAccountId)) fail(`指标 ${m.code} 引用了不存在的科目`);
    if (terms.some(t => t.sourceType === 'metric' && !t.sourceMetricId)) fail(`指标 ${m.code} 引用了未创建的指标(顺序错误)`);
    const existingMetric = metricByCode.get(m.code);
    const res = await fetch(existingMetric ? `${BASE}/api/metrics/${existingMetric.id}` : `${BASE}/api/metrics`, {
      method: existingMetric ? 'PATCH' : 'POST', headers: H,
      body: JSON.stringify({
        code: m.code,
        name: m.name,
        displayOrder: m.displayOrder,
        status: 'active',
        kind: m.kind ?? 'linear',
        direction: m.direction ?? 'higher_better',
        displayFormat: m.displayFormat ?? 'percent',
        unit: m.unit ?? '',
        displaySign: m.displaySign ?? 1,
        terms,
      }),
    });
    if (!res.ok) fail(`${existingMetric ? '更新' : '创建'}指标 ${m.code} ${m.name} 失败: ${await res.text()}`);
    const row = await res.json();
    metricByCode.set(m.code, row);
    if (existingMetric) metricUpdated += 1; else metricCreated += 1;
    console.log(`    ${existingMetric ? '=' : '+'} ${m.code}  ${m.name}  (${m.terms.map(t => `${t.coefficient === -1 ? '-' : ''}${t.code || t.metric}`).join(' + ')})`);
  }
  console.log(`[3] 利润表指标: 新建 ${metricCreated} 个, 更新 ${metricUpdated} 个, 共 ${METRICS.length} 个`);

  /* ---------- 与模板逐名交叉校验 ---------- */
  if (!fs.existsSync(TEMPLATE)) fail('模板文件不存在: ' + TEMPLATE);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(TEMPLATE);
  const accountNames = new Set(after.rows.map(r => r.name));
  const review = [];
  for (const ws of wb.worksheets) {
    if (ws.name === '利润表') continue; // 利润表 = 指标,非科目
    ws.eachRow({ includeEmpty: false }, row => {
      const c = row.getCell(2);
      const v = c.value;
      if (v == null || typeof v !== 'string') return;
      const name = v.trim();
      if (!name || name === '项目') return;
      if (!accountNames.has(name) && !TEMPLATE_EXCEPTIONS.has(name)) review.push(`${ws.name}: ${name}`);
    });
  }
  if (review.length) {
    console.error('[4] 模板交叉校验发现未覆盖名称:');
    review.forEach(r => console.error('    ?? ' + r));
    fail('存在模板名称未建成科目且不在白名单,请核对后重跑');
  }
  console.log('[4] 模板交叉校验通过: 模板全部明细名称均已覆盖(或属于白名单的汇总/数量/组织行)');

  /* ---------- 汇总输出 ---------- */
  const roots = after.tree;
  console.log('[5] 科目森林根节点:');
  for (const r of roots) {
    const cnt = (function count(n) { return 1 + (n.children || []).reduce((s, c) => s + count(c), 0); })(r);
    console.log(`    ${r.code}  ${r.name}  (${r.type}, ${cnt} 节点)`);
  }
  console.log('DONE: 澧水集团科目森林 + 利润表指标初始化完成');
}

/* 科目森林与利润表指标定义对外可复用(E2E 夹具构建脚本按同一份主数据建库),
   但「登录 → 调 API 建科目 → 模板交叉校验」的运维流程只在直接执行本脚本时才跑。 */
module.exports = { TREE, QTREE, METRICS, TYPE_BY_PREFIX };

if (require.main === module) main().catch(e => fail(e.stack || String(e)));
