**T-10～T-12 合同全生命周期独立复核记录（2026-11-13）**

结论：功能页面、数据库表和主要流程已经搭建，迁移与常规流程测试有实际价值；但关键业务门禁、币种一致性、报送真实性存在可重复触发的缺陷，**不能认可当前“AC-CLM-01～14 全部通过”的整体结论**。建议先修复本记录中的 P1 问题，再重新开展业务验收。无需推倒重写，但目前不宜依赖系统自动保证合同合规与报送准确。

本次仅新增复核记录，没有修改产品代码、原验收记录、生产数据库或正式构建产物，也没有部署、提交或推送。

**复核范围与证据**

- 依据：`specs/contract-lifecycle.md`、`specs/contract-lifecycle-plan.md`、受控参考资料总索引，以及本地六份《纪巡财审》官方模板的表头与校验规则。原件没有复制到公开目录。
- 基线：Git HEAD 为 `71dc393`；T-9～T-12 实现仍在未提交工作区。验收记录记载生产为 V70；本地 `backend/dist` 的迁移最高版本确为 V70，源码最高版本为 V71。V71 联动补充的待发布状态见 [原记录](/root/newfc/docs/acceptance-records.md:725)。本次没有连接生产运行库，也没有重新核验线上进程与产物摘要。
- 对**当前源码及本地 V70 发布产物分别执行了 19 个复核场景**，以下不符合预期的结果在两者中均出现。复核使用新建临时库、合成合同与本机随机端口；为定位具体阶段，部分夹具通过 SQL 设置起始阶段，随后被测操作均走真实 HTTP、Cookie 和 CSRF。管理员同人复核填写例外原因，并未跳过接口校验。
- 固定 Node 24.22.1。后端源码类型检查通过，T-9/T-10/T-11/T-12 与合同导入相关 **8 文件 / 91 项测试通过**；前端 **52 文件 / 484 项测试通过**，前端类型检查通过；前后端独立构建成功。
- 使用本次独立构建和临时库复跑 T-10/T-11/T-12 浏览器用例，**3/3 通过**。首次启动因复核脚本在编译结束前启动服务而失败；等待构建完成后完整重跑通过，此项属于复核启动顺序问题。
- 本次未重复后端全站全量测试、完整备份恢复演练、512 MiB 峰值内存测量、真实 OA 或上级平台导入联调；不把既有记录当成本次执行结果。

本地证据：`/tmp/newfc-review/` 内的 `probe.cjs`、`extra.cjs`、`results-src.json`、`results-dist.json`、`extra-results-src.json`、`extra-results-dist.json`、`template-comparison.json`、`e2e-final.log`、`frontend-tests.log`、`frontend-types.log` 和构建日志；后端聚焦测试日志为 `/tmp/newfc-review-contract-tests.log`，源码类型日志为 `/tmp/newfc-review-backend-types.log`。临时业务库执行后清理；导出的 ZIP 仅含合成数据。以下 R 编号对应复核脚本输出，不是新增业务验收编号。

**需要优先修复的问题**

1. **[P1] 未结算、未付款、未完成归档仍可关闭合同；已有有效结算仍可作废。**

   位置：[阶段门禁](/root/newfc/backend/src/modules/contracts/contract.service.ts:291)、[作废命令](/root/newfc/backend/src/modules/contracts/contract.service.ts:936)。对应 AC-CLM-01/06。

   R01：100 万元、无质保合同处于 `settlement`，只有验收附件，`finalAccepted=false`、`archiveStatus=collecting`、结算单 0 笔、已付 0 元，调用 `advance → closed` 返回 200 并关闭。代码检查待处理记录和是否超付，却没有要求批准的最终结算、最终验收标记、归档完整及款项结清。

   R19：已批准净结算 100 元、尚未付款的合同，调用 `void` 返回 200。作废门禁没有排除已生效结算。

   应按计划 §3.1 逐条补齐关闭条件；作废必须检查已批准结算。质保保留金大于零时也应触发质保义务，不能只依赖可编辑的 `hasWarranty` 开关。

2. **[P1] 质保期没有真正约束期满验收和关闭。**

   位置：[质保签证](/root/newfc/backend/src/modules/contracts/contract-safeguard.service.ts:164)、[质保关闭检查](/root/newfc/backend/src/modules/contracts/contract.service.ts:325)、[尾款申请](/root/newfc/backend/src/modules/contracts/contract-settlement.service.ts:345)。对应 AC-CLM-01/10。

   R04：质保结束日期设为 `2030-12-31`，验收日期为本次复核日，提交“验收通过”及签证附件返回 200，随后关闭也返回 200。服务只比较起止日期，没有验证验收日与当前日期是否已到期。

   此外，未创建 `ct_warranty` 时，关闭检查允许仅凭一份 `warranty_release_visa` 附件通过，绕过期满登记与复核。应统一核验质保记录、实际期满、验收结论及尾款清结，并在付款与关闭处重新检查。

3. **[P1] 签署人信息留空能够绕过授权门禁。**

   位置：[签署推进检查](/root/newfc/backend/src/modules/contracts/contract.service.ts:277)。对应 AC-CLM-03。

   R18：一般合同完成正文审核并上传盖章件后，我方姓名为空、双方法定代表人标记均为 `null`，`approval → performance` 仍返回 200。当前仅在标记严格等于 `0` 时要求授权附件；“未确认身份”被当作可以放行。

   应先要求适用方签署人身份已确认，再判断是否需要授权书；前端必填不能替代服务端检查。

4. **[P1] 公司 50 万元及以下付款不填审批层级反而能通过。**

   位置：[付款分级门禁](/root/newfc/backend/src/modules/contracts/contract-settlement.service.ts:164)。对应 AC-CLM-07。

   R02：公司合同申请 `500000.00` 元预付款，省略审批层级、姓名和职务，提交返回 201；复核及登记支付均返回 200，最终已付为 50 万元。`finance_vp` 最低层级只在 `tier !== null` 时生效。

   应由合同主体和金额确定必需层级，然后检查输入，不应由“用户是否填写”决定是否启用门禁。源码也尚未体现“大额资金按上年净资产 1% 与 500 万元孰低”的计算路径，不能将固定阈值测试等同于全部大额资金规则验收。

5. **[P1] 无估算上限的单价收入合同存在无上限收款路径。**

   位置：[收款限额](/root/newfc/backend/src/modules/contracts/contract-settlement.service.ts:477)。对应 AC-CLM-02/07。

   R03：初始总价 0、无估算上限的单价收入合同，批准结算 100 元；不传 `settlementId`，申请并登记收款 10,000 元，全程成功。代码只检查“至少存在一张批准结算单”，随后因合同金额上限为 `null` 直接返回。

   应始终比较已收、已批准未收与本次申请之和，和累计已批准净应收额；关联单据不是启用总额控制的开关。

6. **[P1] 变更审批与技术专项复核可通过省略新增字段绕过。**

   位置：[变更提交](/root/newfc/backend/src/modules/contracts/contract-change.service.ts:222)。对应 AC-CLM-08。

   R06：100 万元合同增加 20 万元，只提供原有的 `delta/reason/evidenceDocumentId`，提交和批准均成功。记录里要求层级为 `management_board`，实际层级为 `null`，技术专项复核附件也为空。

   原因是实际层级仅在非空时比较，专项复核又受 `hasT11Governance` 条件控制。旧格式输入可以兼容解析，但正式写入必须执行当前业务规则，不能兼容性放行。

7. **[P1] 变更批准时没有重算累计门槛。**

   位置：[变更复核](/root/newfc/backend/src/modules/contracts/contract-change.service.ts:283)。对应 AC-CLM-08。

   R07：1,000 万元合同，先同时提交六张各增加 20 万元的变更，均填“承办单位审批”，然后依次批准。第六张批准前历史已批增加额已达 100 万元（10%），本应升级经营层审批并要求累计超 10% 专项复核，实际仍返回 200，保持原层级。

   复核函数只重查已收付款约束，没有重新计算审批层级、计划额度、技术专项复核及担保条件。应在批准事务内基于最新事实重算；事后风险扫描也不能替代该门禁。

8. **[P1] 直接“终止”入口绕过了解除审批和书面协议要求。**

   位置：[直接终止命令](/root/newfc/backend/src/modules/contracts/contract.service.ts:926)、[页面调用](/root/newfc/frontend/src/pages/project/Contracts.tsx:76)。对应 AC-CLM-09。

   R05：履约中合同仅提交版本号和原因，未给总经理批准层级、解除协议及清算方案，返回 200 并变为 `terminated`。这也是页面顶部“终止”按钮使用的调用方式。

   `changes(changeKind=terminate)` 的较严格检查没有覆盖该入口。应统一两条路径的解除门禁。另经静态检查，直接命令与变更提交均使用 `assertActive`，已经 `suspended` 的合同无法按设计直接转解除，需要一并处理。

9. **[P1] 任意本合同附件可以充当担保方书面同意。**

   位置：[担保同意验证](/root/newfc/backend/src/modules/contracts/contract-change.service.ts:129)。对应 AC-CLM-09。

   R08：存在有效履约保函的合同，把发票附件 ID 填入 `guarantorConsentDocumentId`，变更提交返回 201。该参数只检查附件属于本合同，未检查 `evidence_kind=guarantor_consent`；另一个备用参数路径反而有分类检查。

   应统一检查归属、依据分类及适用关系，批准时再次确认。付款审批、质保签证等指定附件 ID 的路径也应按同一原则检查。

10. **[P1] 合同币种与收付流水可以不一致，直接污染汇总。**

    位置：[合同币种修改](/root/newfc/backend/src/modules/contracts/contract.service.ts:800)、[导入币种校验](/root/newfc/backend/src/modules/contracts/contract-import-templates.ts:586)、[导入累计金额](/root/newfc/backend/src/modules/contracts/contract-import.service.ts:414)。对应 AC-CLM-02/11。

    R09：已登记人民币付款 100 元后，修改合同币种为美元返回 200，原流水仍为人民币。管理会计等查询按主合同币种过滤，历史人民币付款因此会从人民币统计中消失。

    R16：向人民币合同导入一笔 100 美元实际付款，预览错误数为 0，确认返回 200，主合同 `paidAmount=100.00`。代码只验证币种是否在枚举内，未验证与合同一致，然后直接相加。

    应冻结已有金融事实合同的币种；导入必须采用与页面收付相同的币种一致性规则。月报和冻结台账还需要显式保留币种，不能把外币金额无标识地列入“万元”列。

11. **[P1] 选择历史月份导出，实际生成当前月份报表。**

    位置：[公司月报](/root/newfc/backend/src/modules/contracts/contract-export-monthly.ts:160)、[监督报送筛选](/root/newfc/backend/src/modules/contracts/contract-export.service.ts:35)。对应 AC-CLM-12/13。

    R11：请求 `period=2025-03`，返回文件名和月度统计标题均为 `2026-11`。两个函数把正则写成 `/^d{4}-d{2}$/`，缺少数字字符转义，合法月份全部走当前月回退。

    应修正并共用月份校验，增加历史月份及跨年测试，同时验证数据期间，不只验证文件名。月报当前还按最新累计数、`updated_at` 判定完结月份，后补备案可能改变完结月份，历史报表应使用明确的业务发生日期和截止口径。

12. **[P1] 监督报送包没有满足“完整、准确、官方格式”的验收条件。**

    位置：[预检](/root/newfc/backend/src/modules/contracts/contract-export.service.ts:67)、[模板构建](/root/newfc/backend/src/modules/contracts/contract-export.service.ts:141)、[未签署状态转换](/root/newfc/backend/src/modules/contracts/contract-export.service.ts:214)、[收入填表说明](/root/newfc/backend/src/modules/contracts/contract-export.service.ts:245)。对应 AC-CLM-13。

    R12：离线逐格对照六份官方模板，8 张 Sheet 的序号、字段标题行一致，但说明行共 **92 个单元格不同**；原件 31 组下拉校验规则，导出仅 4 组；导出存在 21 个合并区域。收入基本信息的整行说明被替换为“按官方模板规范填写”。规范对表头合并描述存在需要统一之处；即使最终允许保留表头合并，说明与校验规则缺失仍是确定缺口。

    R13：没有签署日期、处于 `drafting` 的合同被写进执行报送表，并强行将“未签署”转成“执行中”。这与“未签署合同不纳入已签执行报送”直接冲突。

    R17：决策方式、最终审批人姓名和身份均为空，预检仍返回 `ready=true`。官方模板相应列并非仅在勾选三重一大时才必填。预检对已批准变更也仅检查部分字段，没有逐项核验对应变更决策/协议附件槽位。

    应从官方模板固化完整字段与条件必填规则，预检和生成器共用同一契约；明确只选取符合报送范围的合同。附件打包还应选取最新有效盖章件，当前循环会打包所有匹配签署附件。

13. **[P2] 有风险的合同在 OA 门户及公司月报显示为无风险。**

    位置：[门户风险查询](/root/newfc/backend/src/modules/contracts/contract-export-monthly.ts:355)、[月报风险查询](/root/newfc/backend/src/modules/contracts/contract-export-monthly.ts:172)。对应 AC-CLM-12/14。

    R14：通过风险扫描生成同一合同的 2 条未处理风险，数据库 `subject_type='contract'`，门户该合同 `openRiskCount=0`。两个报表查询却使用 `subject_type='ct_contract'`。

    应统一对象类型，并明确变更、保函、纠纷风险如何归集至主合同；只核对全局风险总数无法发现逐合同漏报。

14. **[P2] OA 增量接口不会通知合同作废，接收端将长期保留旧记录。**

    位置：[全量共用筛选](/root/newfc/backend/src/modules/contracts/contract-export-monthly.ts:89)、[增量接口](/root/newfc/backend/src/modules/contracts/contract-export-monthly.ts:338)。对应 AC-CLM-14。

    R10：全量接口已读到一份合同，记录游标后将合同作废，再按该游标获取增量，返回空数组。因为作废数据在比较更新时间之前已被过滤，接口也没有删除标记。

    应让增量返回作废/撤销记录或删除事件，保持组织范围校验。另需为只改变风险状态而不修改合同 `updated_at` 的事件设计增量通知，否则修复风险计数查询后仍可能同步不及时。

15. **[P2] 标准报表中的“月度合同5表台账”实际上只冻结、导出一张表。**

    位置：[冻结内容](/root/newfc/backend/src/modules/standard-reports/standard-report.service.ts:214)、[统一导出](/root/newfc/backend/src/modules/standard-reports/standard-report.service.ts:395)。对应 AC-CLM-12。

    R15：生成 `contract_monthly_pack` 后导出，只得到 1 张 Sheet“月度合同5表台账”。合同页面的实时导出有五张 Sheet，但标准报表只冻结一份总台账行，无法复核、重现当时的五表报送内容。

    应冻结五张表各自的内容与摘要，并保证复核后的下载使用冻结结果；不能仅用名称代表五表快照。

**完成度与验收意见**

| 阶段 | 已看到并验证的成果 | 当前结论 |
|---|---|---|
| T-10.1～T-10.5 | V68 表重建、状态与 DTO、正向收款、结算勾稽、法审兼容、基础页面；相关迁移测试通过 | 主要结构完成；关闭、签署、付款分级、单价收款与币种门禁不合格 |
| T-11.1～T-11.5 | V69、定级纯函数、0 金额变更、担保/质保/纠纷表单与审计、浏览器流程 | 主要流程完成；审批可绕过、批准未重算、解除入口不一致、质保日期门禁缺失 |
| T-12.1～T-12.5 | 多模板预览与原子确认、真实日期流水、六表 ZIP、公司月报入口、风险检测器、OA 与只读助手 | 能生成和展示；导入币种、历史期间、官方格式、预检、风险归集、增量撤销与五表冻结未达要求 |

| 验收项 | 本次意见 |
|---|---|
| AC-CLM-01/02/03/07/08/09/10/11/12/13/14 | 存在上述可复现反例，不能维持整体通过 |
| AC-CLM-04 | 日期链与直属电站主体测试通过；初签/结算对计划、项目预算、四算概算 90%/100% 的联动未见完整实现，不能用“变更超计划”测试代替该项 |
| AC-CLM-05 | 本次法审及契约边界回归通过，未发现新增快照失效问题；不扩展为真实法审样本业务验收结论 |
| AC-CLM-06 | 结算三栏勾稽及部分上限测试通过；仍需与变更、收付和最终关闭的约束一起复验 |

静态复核还发现几项未完整交付的计划内容：初签与支付未接入完整的预算/概算额度校验；`ct_evaluation` 目前只保存合同评价并关联供应商 ID，没有写入或展示在供应商主数据评价记录；补充协议唯一性使用合同 `org_id` 作为 `org_root_id`，未解析“法人单位”边界；组织报送全称为空时仅回退本级名称，没有按组织祖先链拼接；工作日算法仅排除周六、周日，没有法定节假日和调休配置。这些属于独立于上述 19 个动态场景的静态发现，业务落地前需要补齐或明确记录实际范围。

**为什么现有测试全部通过仍会有这些问题**

测试覆盖了不少正常流程，但对缺字段、跨阶段、重复待审、外币导入和历史期间等反例覆盖不足；部分测试还把弱化的行为写成了期望。例如 [T-10 测试](/root/newfc/backend/tests/t10-contract-lifecycle.test.ts:269) 没有登记最终结算和质保起止记录，仅补传签证附件就期望关闭成功。T-12 测试请求历史月份但只检查 Sheet 名和几个金额，没有核对返回月份、完整官方说明行、下拉校验和风险逐行值。现有浏览器用例同样主要证明页面能完成预设操作。

因此，保留现有回归测试是必要的，但应把上述反例改写成“必须拒绝/必须保持一致”的正式验收测试，并修正与 specs 冲突的旧断言。不能仅再跑一次全绿测试就宣布复验通过。

建议修复顺序：先处理金额/币种与状态门禁（问题 1～10），再统一导入导出及监督接口（问题 11～15），补齐跨模块范围，最后在临时库开展 V67 非空业务迁移、反例回归、五表冻结前后一致性及官方模板联调。后续数据库修复仍须追加迁移，不能修改已发布 V68～V70。发布时建立可追溯提交与产物标识，并追加新的复验记录，保留历史验收记录的当时事实。

后续处理：用户已授权按本报告完整修复，逐项实现及新的验证证据见[修复记录](contract-lifecycle-repair-2026-11-13.md)。以上内容保留为独立复核当时的发现，不改写历史结论。
