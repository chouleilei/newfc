import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { SIGNATORIES } from './contract-review-fixtures';
import { boot, get, json, post } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { createProject } from './t4-helpers';

/**
 * T-15 / GAP-21（AC-T15-03 & AC-T15-04）：
 * 1. ProjectProfile 计划明细 <-> 合同（份数/精确金额/planItemId/planItemName）<-> 风险事件关联 ID 与 OrgScope 裁剪；
 * 2. UX-26 智能助手受控草稿（contract_draft & plan_issuance_draft）：
 *    - 二级单位范围用户同源权限校验（范围内放行、范围外 403 SCOPE_RESTRICTED）；
 *    - 母公司简码映射取号建议、综合计划剩余额度预检、计划调整 5 类法定审批主体推导；
 *    - 客户端未保存私密文本绝不外发至模型请求体，且确认前数据库零写入。
 */

const servers: Server[] = [];
afterEach(async () => {
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;
  delete process.env.AI_MODEL;
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

let fileSeq = 0;
function seedFileObject(db: DB): number {
  fileSeq += 1;
  const sha = `c9${String(fileSeq).padStart(4, '0')}`.padEnd(64, '0');
  return Number(
    db.prepare('INSERT INTO file_object (sha256, size_bytes, original_name, created_at) VALUES (?, 32, ?, ?)')
      .run(sha, `f-${fileSeq}.xlsx`, '2026-06-30T00:00:00.000Z').lastInsertRowid
  );
}

describe('T-15 / GAP-21 项目全景双向直联与智能助手 UX-26 受控草稿（AC-T15-03, AC-T15-04）', () => {
  it('AC-T15-03：getProjectProfile 返回计划项挂接合同份数/金额、合同 planItemId/planItemName 与风险关联合同且遵守 OrgScope', async () => {
    const { base, db, admin, fx } = await boot('newfc-t15-profile-');
    const sh = fx.orgIds.shanghai;
    const hz = fx.orgIds.hangzhou;
    const projectId = await createProject(base, admin, 'PRJ-PROF-15', '区域水闸现代化改造项目', sh);

    const planBatchId = Number(
      db.prepare(
        `INSERT INTO plan_batch (year, actual_period, file_object_id, file_sha256, file_name, amount_unit, is_current, item_count, fact_count, created_at)
         VALUES (2026, '2026-06', ?, 'sha-prof-plan15', 'plan2026.xlsx', 'yuan', 1, 2, 2, '2026-06-30T00:00:00Z')`
      ).run(seedFileObject(db)).lastInsertRowid
    );
    const planItem1 = Number(
      db.prepare(
        `INSERT INTO plan_item (batch_id, sheet_code, row_no, item_name, item_type, item_key, project_id, org_id)
         VALUES (?, 'investment', 3, '主水闸机电设备更新', 'detail', 'pi-15-1', ?, ?)`
      ).run(planBatchId, projectId, sh).lastInsertRowid
    );
    const planItem2 = Number(
      db.prepare(
        `INSERT INTO plan_item (batch_id, sheet_code, row_no, item_name, item_type, item_key, project_id, org_id)
         VALUES (?, 'investment', 4, '启闭机房安全加固', 'detail', 'pi-15-2', ?, ?)`
      ).run(planBatchId, projectId, sh).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO plan_fact (batch_id, item_id, field_key, measure, value_type, amount_cents, scaled_value, source_cell)
       VALUES (?, ?, 'annual_plan', 'annual_plan', 'amount', 100000000, NULL, 'E3')`
    ).run(planBatchId, planItem1);

    const ct1Res = await post(base, admin, '/api/contracts', {
      ...SIGNATORIES,
      contractNo: 'HT-PROF-15-01',
      externalNoExempt: true,
      name: '主水闸控制柜采购合同',
      orgId: sh,
      projectId,
      planItemId: planItem1,
      originalAmount: '320000.50',
    });
    const ct1 = await json(ct1Res);
    expect(ct1Res.status, JSON.stringify(ct1)).toBe(201);
    // 跨下属单位协作合同（挂接同一项目与计划明细，用于验证上海单组织范围自动裁剪）
    db.prepare(
      `INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, project_id, plan_item_id, original_cents, stage, status, direction, currency, created_at, updated_at)
       VALUES ('HT-PROF-15-02', 'HT-PROF-15-02', '主水闸跨单位配套安装合同', ?, ?, ?, 18000025, 'performance', 'active', 'expense', '人民币', '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z')`
    ).run(hz, projectId, planItem1);

    // 插入一条指向 ct1 的合同风险事件
    db.prepare(
      `INSERT INTO risk_event (
         event_key, rule_code, source, level, org_id, project_id, subject_type, subject_id,
         title, description, amount_cents, evidence_json, evidence_status,
         first_detected_at, last_detected_at, created_at, updated_at
       ) VALUES (?, 'CW_01', 'contract', 'medium', ?, ?, 'contract', ?, '合同履约进度提醒', '测试风险跳转', 32000050, '{}', 'confirmed_hit', '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z', '2026-06-30T00:00:00Z')`
    ).run(`CW_01:contract:${ct1.id}`, sh, projectId, ct1.id);

    const fullProf = await json(get(base, admin, `/api/master/projects/${projectId}/profile`));
    const item1Dto = fullProf.plan.items.find((i: any) => i.itemId === planItem1);
    const item2Dto = fullProf.plan.items.find((i: any) => i.itemId === planItem2);
    expect(item1Dto).toMatchObject({
      itemId: planItem1,
      linkedContractCount: 2,
      linkedContractAmount: '500000.75',
    });
    expect(item2Dto).toMatchObject({
      itemId: planItem2,
      linkedContractCount: 0,
      linkedContractAmount: '0.00',
    });
    expect(fullProf.contracts.rows.find((r: any) => r.id === ct1.id)).toMatchObject({
      planItemId: planItem1,
      planItemName: '主水闸机电设备更新',
    });
    expect(fullProf.risks.rows.find((r: any) => r.ruleCode === 'CW_01')).toMatchObject({
      subjectType: 'contract',
      subjectId: ct1.id,
      contractId: ct1.id,
    });

    // 上海单组织受限用户只统计可见合同（不含杭州组织承担的 180,000.25 元合同）
    const shViewer = createScopedUser(db, { username: 't15-sh-viewer', roleCodes: ['viewer'], orgIds: [sh] }).session;
    const scopedProf = await json(get(base, shViewer, `/api/master/projects/${projectId}/profile`));
    const scopedItem1 = scopedProf.plan.items.find((i: any) => i.itemId === planItem1);
    expect(scopedItem1).toMatchObject({
      linkedContractCount: 1,
      linkedContractAmount: '320000.50',
    });
  });

  it('AC-T15-04：UX-26 contract_draft 与 plan_issuance_draft 按母公司简码和权限矩阵只读生成预填建议、严守范围门禁且零写库零外泄', async () => {
    const { base, db, admin, fx } = await boot('newfc-t15-ux26-');
    const sh = fx.orgIds.shanghai;
    const west = fx.orgIds.west;

    // 为上海组织配置规范合同前缀映射（模拟沿用母公司简码 GRP）
    const pfxRes = await post(base, admin, '/api/contracts/prefix-map', {
      rawPrefix: 'SH-SUB',
      canonicalPrefix: 'GRP',
      signingOrgId: sh,
      legalEntityOrgId: 1,
      entityStatus: 'active_legal',
      prefixKind: 'internal_prefix',
      allowNewContract: true,
      note: '测试二级法人沿用母公司前缀',
    });
    expect(pfxRes.status).toBe(201);
    // 设置上海组织为独立二级法人，西部组织为直属电站以校验审批主体矩阵差异
    db.prepare("UPDATE org SET org_kind = 'legal_entity', is_direct_station = 0 WHERE id = ?").run(sh);
    db.prepare("UPDATE org SET org_kind = 'direct_unit', is_direct_station = 1 WHERE id = ?").run(west);

    const projectId = await createProject(base, admin, 'PRJ-UX26', '智慧调度技术改造', sh);
    const planBatchId = Number(
      db.prepare(
        `INSERT INTO plan_batch (year, actual_period, file_object_id, file_sha256, file_name, amount_unit, is_current, item_count, fact_count, created_at)
         VALUES (2026, '2026-06', ?, 'sha-ux26-plan', 'plan-ux26.xlsx', 'yuan', 1, 1, 1, '2026-06-30T00:00:00Z')`
      ).run(seedFileObject(db)).lastInsertRowid
    );
    const planItemId = Number(
      db.prepare(
        `INSERT INTO plan_item (batch_id, sheet_code, row_no, item_name, item_type, item_key, project_id, org_id)
         VALUES (?, 'investment_tech_renovation', 2, '调度平台升级技改', 'detail', 'ux26-item-1', ?, ?)`
      ).run(planBatchId, projectId, sh).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO plan_fact (batch_id, item_id, field_key, measure, value_type, amount_cents, scaled_value, source_cell)
       VALUES (?, ?, 'annual_plan', 'annual_plan', 'amount', 50000000, NULL, 'E2')`
    ).run(planBatchId, planItemId);

    // 启动本地受控 Mock 模型捕获所有外发请求体，验证未保存私密文本不出网
    const outboundBodies: string[] = [];
    const mockLlm = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += String(chunk); });
      req.on('end', () => {
        outboundBodies.push(raw);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: '已核对当前草稿预检结果，请确认后回填表单。' } }] }));
      });
    }).listen(0);
    servers.push(mockLlm);
    process.env.AI_BASE_URL = `http://127.0.0.1:${(mockLlm.address() as { port: number }).port}/v1`;
    process.env.AI_API_KEY = 'ux26-mock-key';
    process.env.AI_MODEL = 'ux26-mock-model';

    const shScoped = createScopedUser(db, {
      username: 't15-sh-maker',
      roleCodes: ['data_maintainer'],
      orgIds: [sh],
    }).session;

    const beforeCtCount = (db.prepare('SELECT COUNT(*) AS c FROM ct_contract').get() as { c: number }).c;
    const clientSecret = 'UNSAVED_COUNTERPARTY_PRIVATE_NOTE_998877';

    // 1) 受限二级单位用户在自身授权 orgId 内发起 contract_draft 预检 -> 200 且生成 GRP 母公司前缀建议编号
    const chatRes = await post(base, shScoped, '/api/assistant/chat', {
      message: '请检查当前新建合同草稿并给出预填建议',
      pageContext: {
        schemaVersion: 2,
        snapshotId: randomUUID(),
        pageKey: 'contracts',
        routeInstanceId: randomUUID(),
        contextVersion: 1,
        scope: { orgScopeId: sh },
        draft: {
          kind: 'contract_draft',
          base: { operation: 'create', clientKey: 'ct-new-1' },
          changes: {
            orgId: sh,
            direction: 'expense',
            legalCategory: 'construction',
            contractType: '工程施工',
            planItemId,
            originalAmount: '600000.00', // 超出计划额度 500,000.00 元，应给出额度预警
            name: clientSecret,
          },
        },
      },
    });
    expect(chatRes.status).toBe(200);
    const chatBody = await json(chatRes);
    const draftFact = chatBody.facts.find((f: any) => f.type === 'draft_validation');
    expect(draftFact).toBeTruthy();
    expect(draftFact.data.analysis.suggestedFields).toMatchObject({
      canonicalPrefix: 'GRP',
      budgetType: 'single_listed',
      reportCategory: 'engineering',
      projectId,
      countersignDepts: expect.arrayContaining(['财务部', '法务合规', '安全生产部']),
    });
    expect(String(draftFact.data.analysis.suggestedFields.contractNo)).toMatch(/^GRP-[A-Z]{2}-001\/\d{4}-001$/);
    expect(draftFact.data.analysis.issues.join(' ')).toContain('超出关联计划项剩余额度');

    // 无效枚举也可能包含未保存私密文本：当次页面可见诊断，模型与会话持久化只留摘要。
    const invalidDraft = await post(base, shScoped, '/api/assistant/chat', {
      message: '核对未保存字段格式',
      pageContext: {
        schemaVersion: 2, snapshotId: randomUUID(), pageKey: 'contracts', routeInstanceId: randomUUID(), contextVersion: 1,
        draft: { kind: 'contract_draft', base: { operation: 'create', clientKey: 'private-invalid-field' },
          changes: { orgId: sh, legalCategory: clientSecret, originalAmount: '123456.78' } },
      },
    });
    expect(invalidDraft.status).toBe(200);
    expect(outboundBodies.join('\n')).not.toContain(clientSecret);
    const storedMessages = db.prepare('SELECT content, response_json FROM ai_message').all();
    expect(JSON.stringify(storedMessages)).not.toContain(clientSecret);
    expect(JSON.stringify(storedMessages)).not.toContain('123456.78');

    // 验证私密未保存字段绝未外发到模型，且数据库 ct_contract 零新增行！
    expect(outboundBodies.join('\n')).not.toContain(clientSecret);
    const afterCtCount = (db.prepare('SELECT COUNT(*) AS c FROM ct_contract').get() as { c: number }).c;
    expect(afterCtCount).toBe(beforeCtCount);

    // 2) 受限用户尝试为范围外组织（west）生成 contract_draft -> 403 SCOPE_RESTRICTED
    const crossOrgRes = await post(base, shScoped, '/api/assistant/chat', {
      message: '测试越权合同草稿',
      pageContext: {
        schemaVersion: 2,
        snapshotId: randomUUID(),
        pageKey: 'contracts',
        routeInstanceId: randomUUID(),
        contextVersion: 2,
        draft: {
          kind: 'contract_draft',
          base: { operation: 'create', clientKey: 'ct-cross-1' },
          changes: { orgId: west, direction: 'expense', originalAmount: '10000.00' },
        },
      },
    });
    expect(crossOrgRes.status).toBe(403);
    expect((await json(crossOrgRes)).code).toBe('SCOPE_RESTRICTED');

    // 3) plan_issuance_draft：未提供可核实年度上限的子公司调整保守走 company_approval；应急调整缺日期告警；零写库
    const beforeAdjCount = (db.prepare('SELECT COUNT(*) AS c FROM plan_adjustment').get() as { c: number }).c;
    const planChatRes = await post(base, shScoped, '/api/assistant/chat', {
      message: '请核验当前计划调整草稿的法定审批主体',
      pageContext: {
        schemaVersion: 2,
        snapshotId: randomUUID(),
        pageKey: 'plan',
        routeInstanceId: randomUUID(),
        contextVersion: 1,
        scope: { orgScopeId: sh },
        draft: {
          kind: 'plan_issuance_draft',
          base: { operation: 'adjust', clientKey: 'plan-adj-1' },
          changes: {
            unitOrgId: sh,
            adjustType: 'unplanned_subsidiary_within_cap',
            reason: clientSecret,
          },
        },
      },
    });
    expect(planChatRes.status).toBe(200);
    const planChatBody = await json(planChatRes);
    const planFact = planChatBody.facts.find((f: any) => f.type === 'draft_validation');
    expect(planFact.data.analysis.suggestedFields).toMatchObject({
      approvalBody: 'company_approval',
      unitOrgId: sh,
    });

    // 直属水电站同类调整必须走联审报公司批准（joint_review_company）
    const stationChatRes = await post(base, admin, '/api/assistant/chat', {
      message: '核验直属电站调整审批层级',
      pageContext: {
        schemaVersion: 2,
        snapshotId: randomUUID(),
        pageKey: 'plan',
        routeInstanceId: randomUUID(),
        contextVersion: 1,
        draft: {
          kind: 'plan_issuance_draft',
          base: { operation: 'adjust', clientKey: 'plan-adj-2' },
          changes: {
            unitOrgId: west,
            adjustType: 'unplanned_subsidiary_within_cap',
          },
        },
      },
    });
    expect(stationChatRes.status).toBe(200);
    const stationFact = (await json(stationChatRes)).facts.find((f: any) => f.type === 'draft_validation');
    expect(stationFact.data.analysis.suggestedFields.approvalBody).toBe('joint_review_company');

    expect(outboundBodies.join('\n')).not.toContain(clientSecret);
    expect((db.prepare('SELECT COUNT(*) AS c FROM plan_adjustment').get() as { c: number }).c).toBe(beforeAdjCount);
  });
});
