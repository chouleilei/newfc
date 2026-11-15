import { describe, expect, it } from 'vitest';
import { CHANGE_GOVERNANCE, SIGNATORIES } from './contract-review-fixtures';
import { boot, get, json, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';

const put = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('T-GAP-14 / AC-T14-06 多部门结构化会签、指纹失效重签、越权代签拦截与包干池总额控制', () => {
  it('自动派生 7 类职能会签部门、配置 due_date(0 vs 5天)、拦截跨部门代签、金额或正文变更自动置 superseded 并升轮次', async () => {
    const { base, admin, db, fx } = await boot('newfc-t14-countersign-');
    const orgId = fx.orgIds.shanghai;
    const projectId = await createProject(base, admin, 'P-CS-01', '调度通信自动化工程项目', orgId);
    const supplierId = await createSupplier(base, admin, 'S-CS-01', '合成数智通信设备有限公司');

    // 建立职能会签部门组织节点
    const makeDeptOrg = async (code: string, name: string) =>
      (
        await json(
          post(base, admin, '/api/org', {
            parentId: 1,
            code,
            name,
            orgKind: 'hq_dept',
          }),
        )
      ).id as number;

    const anjiOrgId = await makeDeptOrg('HQ_ANJI', '安全技术管理部');
    const jianguanOrgId = await makeDeptOrg('HQ_JIANGUAN', '工程建设管理部');
    const diaoxinOrgId = await makeDeptOrg('HQ_DIAOXIN', '调度通信中心');
    const qiguanOrgId = await makeDeptOrg('HQ_QIGUAN', '企业管理与法务部');
    const caiwuOrgId = await makeDeptOrg('HQ_CAIWU', '财务资产部');
    const jiesuanOrgId = await makeDeptOrg('HQ_JIESUAN', '财务结算中心');
    const jishenOrgId = await makeDeptOrg('HQ_JISHEN', '纪检审计部');

    const anjiReviewer = createScopedUser(db, {
      username: 'rev-anji',
      roleCodes: ['business_reviewer'],
      orgIds: [orgId, anjiOrgId],
    });
    const caiwuReviewer = createScopedUser(db, {
      username: 'rev-caiwu',
      roleCodes: ['business_reviewer'],
      orgIds: [orgId, caiwuOrgId],
    });
    const allDeptReviewer = createScopedUser(db, {
      username: 'rev-all-depts',
      roleCodes: ['business_reviewer'],
      orgIds: [orgId, anjiOrgId, jianguanOrgId, diaoxinOrgId, qiguanOrgId, caiwuOrgId, jiesuanOrgId, jishenOrgId],
    });

    // 聚焦测试会签与包干池逻辑，先关闭智能法审门禁
    await put(base, admin, '/api/settings/business', {
      'contract.legal_review_categories': '',
    });

    // 1. 默认 countersign_due_days = 0 -> dueDate === null；并验证表单补齐字段持久化
    const created = await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'GRP-CS-2026-001',
        name: '水电站调度通信监控软件建设工程合同',
        direction: 'expense',
        contractType: '工程施工',
        category: '工程施工',
        legalCategory: 'construction',
        reportCategory: 'engineering',
        orgId,
        projectId,
        supplierId,
        budgetType: 'single_listed',
        originalAmount: '3500000.00',
        signDate: '2026-07-06',
        termStartDate: '2026-07-06',
        termEndDate: '2026-12-31',
        isProcurement: true,
        procurementTarget: 'construction',
        procurementMethod: 'public_tender',
        isImportant: true,
        isTripleMajor: true,
        farmerWageAccount: '6222000099998888',
        procurementPlanText: '纳入2026年信息化与基建重点采购计划第3项',
        responseDocsComplete: true,
        creditChecked: true,
        relatedMgmtReviewers: '张工、李工',
        unitApproverTitle: '分管副总经理',
        ...SIGNATORIES,
      }),
    );
    expect(created.procurementPlanText).toBe('纳入2026年信息化与基建重点采购计划第3项');
    expect(created.responseDocsComplete).toBe(true);
    expect(created.creditChecked).toBe(true);
    expect(created.relatedMgmtReviewers).toBe('张工、李工');
    expect(created.unitApproverTitle).toBe('分管副总经理');

    // 自动触发全部 7 个职能部门会签且 dueDate === null
    const csList1 = await json(get(base, admin, `/api/contracts/${created.id}/countersigns`));
    expect(csList1.map((x: any) => x.deptCode)).toEqual([
      'ANJI',
      'JIANGUAN',
      'DIAOXIN',
      'QIGUAN',
      'CAIWU',
      'JIESUAN',
      'JISHEN',
    ]);
    expect(csList1.every((x: any) => x.dueDate === null && x.roundNo === 1)).toBe(true);

    // 2. 越权代签拦截：财务部审查人尝试签署安技部会签 -> 403 COUNTERSIGN_DEPT_FORBIDDEN
    const anjiRow = csList1.find((x: any) => x.deptCode === 'ANJI');
    const forbiddenDecide = await post(
      base,
      caiwuReviewer.session,
      `/api/contracts/${created.id}/countersigns/${anjiRow.id}/decide`,
      { decision: 'approved', opinion: '财务代签安技意见' },
    );
    expect(forbiddenDecide.status).toBe(403);
    expect((await json(forbiddenDecide)).code).toBe('COUNTERSIGN_DEPT_FORBIDDEN');

    // 安技部本部门审查人签署通过
    const anjiDecided = await json(
      post(base, anjiReviewer.session, `/api/contracts/${created.id}/countersigns/${anjiRow.id}/decide`, {
        decision: 'approved',
        opinion: '安全施工与技术规范符合规程要求，同意会签。',
      }),
    );
    expect(anjiDecided.find((x: any) => x.id === anjiRow.id).status).toBe('approved');

    // 3. 配置 countersign_due_days = 5 后修改合同金额 -> 原第 1 轮自动置 superseded，自动生成第 2 轮且带非空 dueDate
    await put(base, admin, '/api/settings/business', {
      'contract.countersign_due_days': 5,
    });
    const detailBeforePatch = await json(get(base, admin, `/api/contracts/${created.id}`));
    await json(
      patch(base, admin, `/api/contracts/${created.id}`, {
        expectedVersion: detailBeforePatch.version,
        originalAmount: '3600000.00',
      }),
    );

    const csListAfterPatch = await json(get(base, admin, `/api/contracts/${created.id}/countersigns`));
    const round1Rows = csListAfterPatch.filter((x: any) => x.roundNo === 1);
    const round2Rows = csListAfterPatch.filter((x: any) => x.roundNo === 2);
    expect(round1Rows.every((x: any) => x.status === 'superseded')).toBe(true);
    expect(round2Rows).toHaveLength(7);
    expect(round2Rows.every((x: any) => x.status === 'pending' && typeof x.dueDate === 'string' && x.dueDate.length === 10)).toBe(true);

    // 将合同推进至 approval 阶段（initiation -> procurement -> drafting -> approval），验证未完成会签时 blockers 含 COUNTERSIGN_PENDING 且推进 performance 被 409 拦截
    const docTextInit = await json(
      upload(base, admin, `/api/contracts/${created.id}/documents`, Buffer.from('主合同正文初版'), 'body-v1.pdf', {
        docType: 'contract_text',
      }),
    );
    await upload(base, admin, `/api/contracts/${created.id}/documents`, Buffer.from('中标通知书'), 'award.pdf', {
      docType: 'procurement',
    });
    let curDetail = await json(get(base, admin, `/api/contracts/${created.id}`));
    expect((await post(base, admin, `/api/contracts/${created.id}/advance`, { expectedVersion: curDetail.version, toStage: 'procurement' })).status).toBe(200);
    curDetail = await json(get(base, admin, `/api/contracts/${created.id}`));
    expect((await post(base, admin, `/api/contracts/${created.id}/advance`, { expectedVersion: curDetail.version, toStage: 'drafting' })).status).toBe(200);
    curDetail = await json(get(base, admin, `/api/contracts/${created.id}`));
    expect((await post(base, admin, `/api/contracts/${created.id}/advance`, { expectedVersion: curDetail.version, toStage: 'approval' })).status).toBe(200);
    const revInit = await json(post(base, admin, `/api/contracts/${created.id}/reviews`, { documentId: docTextInit.id, note: '送审' }));
    await json(post(base, allDeptReviewer.session, `/api/contracts/${created.id}/reviews/${revInit.id}/decide`, { decision: 'approve', comment: '通过' }));
    await upload(base, admin, `/api/contracts/${created.id}/documents`, Buffer.from('签署件'), 'signed-v1.pdf', { docType: 'signed' });

    const csCurrent = await json(get(base, admin, `/api/contracts/${created.id}/countersigns`));
    const activeRound = Math.max(...csCurrent.map((x: any) => x.roundNo));
    const pendingActiveRows = csCurrent.filter((x: any) => x.roundNo === activeRound);
    const signingBlocked = await json(get(base, admin, `/api/contracts/${created.id}`));
    expect(signingBlocked.blockers.some((b: any) => b.code === 'COUNTERSIGN_PENDING')).toBe(true);
    const advBlockedRes = await post(base, admin, `/api/contracts/${created.id}/advance`, {
      expectedVersion: signingBlocked.version,
      toStage: 'performance',
    });
    expect(advBlockedRes.status).toBe(409);

    // 全职能部门审查人逐一完成当前轮次会签 -> COUNTERSIGN_PENDING 解除
    for (const r2 of pendingActiveRows) {
      const res = await post(base, allDeptReviewer.session, `/api/contracts/${created.id}/countersigns/${r2.id}/decide`, {
        decision: 'approved',
        opinion: `${r2.deptName}复核第2轮无异议`,
      });
      expect(res.status).toBe(200);
    }
    const detailAfterAllCs = await json(get(base, admin, `/api/contracts/${created.id}`));
    expect(detailAfterAllCs.blockers.some((b: any) => b.code.startsWith('COUNTERSIGN_'))).toBe(false);

    // 再上传新的主合同正文 contract_text -> doc_fingerprint 变化自动触发第 3 轮重签
    await upload(
      base,
      admin,
      `/api/contracts/${created.id}/documents`,
      Buffer.from('修订版主合同正文V2'),
      'contract-v2.pdf',
      { docType: 'contract_text', name: '主合同正文修订版' },
    );
    const detailAfterNewDoc = await json(get(base, admin, `/api/contracts/${created.id}`));
    expect(detailAfterNewDoc.blockers.some((b: any) => b.code === 'COUNTERSIGN_PENDING' || b.code === 'COUNTERSIGN_OUTDATED')).toBe(true);
  });

  it('生产经营总额包干池 lump_sum_pool 跨合同累计占用校验：600,000 + 500,000 > 1,000,000 精准拦截 BUDGET_POOL_EXCEEDED', async () => {
    const { base, admin, db, fx } = await boot('newfc-t14-lumpsum-');
    const orgId = fx.orgIds.shanghai;
    const supplierId = await createSupplier(base, admin, 'S-POOL-01', '合成物业维保服务有限公司');
    const reviewer = createScopedUser(db, {
      username: 'pool-reviewer',
      roleCodes: ['business_reviewer'],
      orgIds: [orgId],
    });

    // 建立 2026 年度经营预算科目总额包干池 1,000,000.00 元（expense 按利润方向存为 -100,000,000 分）
    const poolAccountId = Number(
      db.prepare(
        `INSERT INTO account (code, name, type, status, sort_order, created_at, updated_at)
         VALUES ('POOL_MAINT_01', '厂区物业与零星维保包干池', 'expense', 'active', 10, datetime('now'), datetime('now'))`,
      ).run().lastInsertRowid,
    );
    const bv = await json(post(base, admin, '/api/versions', { year: 2026, name: '2026包干预算版', kind: 'budget' }));
    db.prepare(
      `INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, updated_at) VALUES (?, ?, ?, ?, datetime('now'))`,
    ).run(bv.id, orgId, poolAccountId, -100_000_000);

    // 关闭智能法审强制门禁（聚焦测试包干池拦截），仅保留常规合同复核与签署件推进
    await put(base, admin, '/api/settings/business', {
      'contract.legal_review_categories': '',
    });

    const advanceToPerformance = async (cid: number) => {
      const docText = await json(
        upload(base, admin, `/api/contracts/${cid}/documents`, Buffer.from('合同正文内容'), 'body.pdf', {
          docType: 'contract_text',
        }),
      );
      await upload(base, admin, `/api/contracts/${cid}/documents`, Buffer.from('招采成交通知'), 'proc.pdf', {
        docType: 'procurement',
      });
      let d = await json(get(base, admin, `/api/contracts/${cid}`));
      expect((await post(base, admin, `/api/contracts/${cid}/advance`, { expectedVersion: d.version, toStage: 'procurement' })).status).toBe(200);
      d = await json(get(base, admin, `/api/contracts/${cid}`));
      expect((await post(base, admin, `/api/contracts/${cid}/advance`, { expectedVersion: d.version, toStage: 'drafting' })).status).toBe(200);
      d = await json(get(base, admin, `/api/contracts/${cid}`));
      expect((await post(base, admin, `/api/contracts/${cid}/advance`, { expectedVersion: d.version, toStage: 'approval' })).status).toBe(200);
      const rev = await json(post(base, admin, `/api/contracts/${cid}/reviews`, { documentId: docText.id, note: '提请合同审核' }));
      await json(
        post(base, reviewer.session, `/api/contracts/${cid}/reviews/${rev.id}/decide`, {
          decision: 'approve',
          comment: '同意签署',
        }),
      );
      await upload(base, admin, `/api/contracts/${cid}/documents`, Buffer.from('双方法定签章扫描件'), 'signed.pdf', {
        docType: 'signed',
      });
      d = await json(get(base, admin, `/api/contracts/${cid}`));
      return post(base, admin, `/api/contracts/${cid}/advance`, { expectedVersion: d.version, toStage: 'performance' });
    };

    // 第 1 份合同占用 600,000.00 元 -> 推进 performance 成功，实时回显剩余包干池余额 400,000.00 元
    const c1 = await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'GRP-POOL-2026-001',
        name: '上半年厂区保洁绿化服务包干合同',
        direction: 'expense',
        contractType: '综合服务',
        category: '综合服务',
        legalCategory: 'other',
        orgId,
        supplierId,
        budgetType: 'lump_sum_pool',
        budgetPoolAccountId: poolAccountId,
        originalAmount: '600000.00',
        signDate: '2026-07-01',
        effectiveDate: '2026-07-01',
        termStartDate: '2026-07-01',
        termEndDate: '2026-12-31',
        isProcurement: true,
        procurementTarget: 'service',
        procurementMethod: 'inquiry',
        ...SIGNATORIES,
      }),
    );
    expect(c1.budgetPoolCapAmount).toBe('1000000.00');
    expect(c1.budgetPoolRemainingAmount).toBe('400000.00');

    const adv1 = await advanceToPerformance(c1.id);
    expect(adv1.status).toBe(200);

    // 第 2 份合同同组织同包干池申报 500,000.00 元（累计 1,100,000.00 > 1,000,000.00）：草稿可建档并实时回显负余额 -100,000.00，推进履约时精准拦截 409 BUDGET_POOL_EXCEEDED
    const c2 = await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'GRP-POOL-2026-002',
        name: '下半年厂区零星设施维修包干合同',
        direction: 'expense',
        contractType: '综合服务',
        category: '综合服务',
        legalCategory: 'other',
        orgId,
        supplierId,
        budgetType: 'lump_sum_pool',
        budgetPoolAccountId: poolAccountId,
        originalAmount: '500000.00',
        signDate: '2026-07-10',
        effectiveDate: '2026-07-10',
        termStartDate: '2026-07-10',
        termEndDate: '2026-12-31',
        isProcurement: true,
        procurementTarget: 'service',
        procurementMethod: 'inquiry',
        ...SIGNATORIES,
      }),
    );
    expect(c2.budgetPoolUsedAmount).toBe('1100000.00');
    expect(c2.budgetPoolRemainingAmount).toBe('-100000.00');

    const adv2 = await advanceToPerformance(c2.id);
    expect(adv2.status).toBe(409);
    const adv2Err = await json(adv2);
    expect(adv2Err.code).toBe('CONTRACT_STAGE_BLOCKED');
    expect(adv2Err.details.blockers.map((b: any) => b.code)).toContain('BUDGET_POOL_EXCEEDED');

    // 在已履约的 c1 上申请调增 +50,000.00 元（池累计超 1,000,000.00 元）直接抛 409 BUDGET_POOL_EXCEEDED
    const chgDoc = await json(
      upload(base, admin, `/api/contracts/${c1.id}/documents`, Buffer.from('变更申请依据'), 'chg.pdf', {
        docType: 'change',
        evidenceKind: 'change_decision',
      }),
    );
    const chgOverRes = await post(base, admin, `/api/contracts/${c1.id}/changes`, {
      ...CHANGE_GOVERNANCE,
      delta: '50000.00',
      reason: '超包干池增补测试',
      evidenceDocumentId: chgDoc.id,
    });
    expect(chgOverRes.status).toBe(409);
    expect((await json(chgOverRes)).code).toBe('BUDGET_POOL_EXCEEDED');
  });
});
