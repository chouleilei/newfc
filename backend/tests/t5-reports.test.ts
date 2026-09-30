import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { boot, get, json, post, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject } from './t4-helpers';
import { standardBudgetVersion } from './helpers';
import { docxParagraphs, pdfParagraphs } from '../src/modules/analysis-reports/render';
import { redactText } from '../src/modules/analysis-reports/report.service';

/**
 * T-5 分析报告(AC-F18):生成 → 编辑 → 提交 → 同人审批被拒(管理员带例外原因可以)→ 审批后编辑被拒 → 发布;
 * DOCX/PDF 段落文本一致、重复下载字节一致、快照脱敏;修订生成修订号 2 的草稿,新修订发布后旧版 superseded;范围隔离。
 */

const now = '2026-06-30T00:00:00.000Z';

function seedRisk(db: DB, projectId: number, orgId: number) {
  const fo = Number(db.prepare("INSERT INTO file_object (sha256, size_bytes, original_name, created_at) VALUES (?, 1, 'pb.xlsx', ?)").run('b'.repeat(64), now).lastInsertRowid);
  const batch = Number(db.prepare(`INSERT INTO pb_batch (year, period, name, file_object_id, file_sha256, file_name, is_current, row_count, created_at)
    VALUES (2026, '2026-06', 'pb', ?, 'sha', 'pb.xlsx', 1, 1, ?)`).run(fo, now).lastInsertRowid);
  db.prepare(`INSERT INTO pb_entry (batch_id, row_no, project_id, project_code, project_name, org_id, fund_source, budget_cents, executed_cents, exec_month)
    VALUES (?, 2, ?, 'P-SH-01', '上海泵站改造', ?, '自有资金', 100000, 300000, '2026-06')`).run(batch, projectId, orgId);
}

const patchJson = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function waitJob(base: string, s: Session, jobId: number) {
  let job = await json(get(base, s, `/api/jobs/${jobId}`));
  for (let i = 0; i < 200 && !['succeeded', 'failed', 'cancelled'].includes(job.status); i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    job = await json(get(base, s, `/api/jobs/${jobId}`));
  }
  return job;
}

async function download(base: string, s: Session, id: number, format: 'docx' | 'pdf') {
  const res = await get(base, s, `/api/analysis-reports/${id}/export?format=${format}`);
  expect(res.status).toBe(200);
  return Buffer.from(await res.arrayBuffer());
}

describe('T-5 分析报告', () => {
  it('脱敏:手机号与身份证号,金额与小数不误伤', () => {
    expect(redactText('联系 13812345678,身份证 110101199003074518,金额 13812345678.00 元')).toBe('联系 138****5678,身份证 110101********4518,金额 13812345678.00 元');
  });

  it('风险与投资专题:生成、编辑、提交、审批分离、发布、导出一致、修订与替代、范围隔离', async () => {
    const { base, db, admin, fx } = await boot('newfc-t5-report-');
    const p1 = await createProject(base, admin, 'P-SH-01', '上海泵站改造', fx.orgIds.shanghai);
    seedRisk(db, p1, fx.orgIds.shanghai);
    expect((await json(post(base, admin, '/api/risk/scans'))).createdCount).toBe(1);

    const analyst = createScopedUser(db, { username: 'rpt-analyst', roleCodes: ['finance_analyst'], allOrgs: true }).session;
    const reviewer = createScopedUser(db, { username: 'rpt-reviewer', roleCodes: ['business_reviewer'], allOrgs: true }).session;
    const sh = createScopedUser(db, { username: 'rpt-sh', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] }).session;

    expect((await post(base, reviewer, '/api/analysis-reports', { kind: 'risk_investment' })).status).toBe(403);
    const genRes = await post(base, analyst, '/api/analysis-reports', { kind: 'risk_investment', year: 2026 });
    expect(genRes.status).toBe(201);
    let r = await json(genRes);
    expect(r).toMatchObject({ status: 'draft', revisionNo: 1, kind: 'risk_investment', orgId: null, modelStatus: 'template', allowed: ['edit', 'submit', 'delete'] });
    expect(r.sections.map((s: { key: string }) => s.key)).toEqual(['risk_overview', 'risk_top', 'investment_control', 'feasibility']);
    expect(r.sections[0].body).toContain('未关闭 1 条');
    expect(r.sections[1].body).toContain('上海泵站改造');
    const [s1, s2] = r.sections;

    // 编辑:版本号校验;修改历史只追加
    expect((await json(patchJson(base, analyst, `/api/analysis-reports/${r.id}/sections/${s1.id}`, { expectedVersion: r.version + 1, body: 'x' }))).code).toBe('VERSION_CONFLICT');
    r = await json(patchJson(base, analyst, `/api/analysis-reports/${r.id}/sections/${s1.id}`, { expectedVersion: r.version, body: `${s1.body}\n- 联系人电话 13812345678,身份证 110101199003074518。` }));
    expect(r.sections[0]).toMatchObject({ edited: true });
    r = await json(patchJson(base, analyst, `/api/analysis-reports/${r.id}/sections/${s2.id}`, { expectedVersion: r.version, body: '  ' }));
    const edits = await json(get(base, analyst, `/api/analysis-reports/${r.id}/edits`));
    expect(edits).toHaveLength(2);
    expect(() => db.prepare('UPDATE rpt_section_edit SET after_body = ? WHERE id = ?').run('x', edits[0].id)).toThrow(/只追加/);

    // 空章节阻断提交
    const blocked = await json(post(base, analyst, `/api/analysis-reports/${r.id}/submit`, { expectedVersion: r.version }));
    expect(blocked).toMatchObject({ code: 'REPORT_INCONSISTENT', details: { emptySections: [expect.objectContaining({ key: 'risk_top' })] } });
    r = await json(patchJson(base, analyst, `/api/analysis-reports/${r.id}/sections/${s2.id}`, { expectedVersion: r.version, body: s2.body }));
    r = await json(post(base, analyst, `/api/analysis-reports/${r.id}/submit`, { expectedVersion: r.version }));
    expect(r.status).toBe('pending_approval');

    // 草稿/审批中导出:即时渲染带水印,DOCX 与 PDF 段落一致
    const draftDocx = await download(base, analyst, r.id, 'docx');
    const draftPdf = await download(base, analyst, r.id, 'pdf');
    expect(draftPdf.toString('latin1')).toContain('%W');
    expect((await docxParagraphs(draftDocx))).toEqual(pdfParagraphs(draftPdf));

    // 审批:分析员无权;退回需意见;审批后编辑被拒
    expect((await post(base, analyst, `/api/analysis-reports/${r.id}/approve`, { expectedVersion: r.version })).status).toBe(403);
    expect((await post(base, reviewer, `/api/analysis-reports/${r.id}/return`, { expectedVersion: r.version })).status).toBe(400);
    r = await json(post(base, reviewer, `/api/analysis-reports/${r.id}/return`, { expectedVersion: r.version, comment: '补充整改期限' }));
    expect(r).toMatchObject({ status: 'draft', returnComment: '补充整改期限' });
    r = await json(post(base, analyst, `/api/analysis-reports/${r.id}/submit`, { expectedVersion: r.version }));
    r = await json(post(base, reviewer, `/api/analysis-reports/${r.id}/approve`, { expectedVersion: r.version, comment: '同意' }));
    expect(r).toMatchObject({ status: 'approved', selfApproval: false, allowed: ['publish'] });
    expect((await json(patchJson(base, analyst, `/api/analysis-reports/${r.id}/sections/${s1.id}`, { expectedVersion: r.version, body: 'x' }))).code).toBe('REPORT_STATE');
    expect(() => db.prepare('UPDATE rpt_section SET body = ? WHERE id = ?').run('x', s1.id)).toThrow(/章节冻结/);

    // 发布:任务渲染并保存产物
    expect((await post(base, analyst, `/api/analysis-reports/${r.id}/publish`, { expectedVersion: r.version })).status).toBe(403);
    const pub = await post(base, reviewer, `/api/analysis-reports/${r.id}/publish`, { expectedVersion: r.version });
    expect(pub.status).toBe(202);
    expect((await waitJob(base, reviewer, (await json(pub)).jobId)).status).toBe('succeeded');
    r = await json(get(base, analyst, `/api/analysis-reports/${r.id}`));
    expect(r).toMatchObject({ status: 'published', publication: { snapshotSha256: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    const snap = db.prepare('SELECT snapshot_json FROM rpt_publication WHERE report_id = ?').get(r.id) as { snapshot_json: string };
    expect(snap.snapshot_json).toContain('138****5678');
    expect(snap.snapshot_json).not.toContain('13812345678');
    expect(snap.snapshot_json).not.toContain('110101199003074518');
    expect(() => db.prepare('UPDATE rpt_publication SET snapshot_sha256 = ?').run('x')).toThrow(/不可修改/);

    const docx1 = await download(base, analyst, r.id, 'docx');
    const docx2 = await download(base, reviewer, r.id, 'docx');
    const pdf1 = await download(base, analyst, r.id, 'pdf');
    const pdf2 = await download(base, analyst, r.id, 'pdf');
    expect(docx1.equals(docx2)).toBe(true);
    expect(pdf1.equals(pdf2)).toBe(true);
    const paras = await docxParagraphs(docx1);
    expect(paras).toEqual(pdfParagraphs(pdf1));
    expect(paras.join('\n')).toContain('联系人电话 138****5678,身份证 110101********4518');
    expect(pdf1.toString('latin1')).toContain('/BaseFont /STSong-Light /Encoding /UniGB-UCS2-H');
    expect(pdf1.toString('latin1')).not.toContain('%W');
    expect(pdf1.toString('latin1')).not.toContain('FontFile');

    // 修订:修订号 2 的草稿,原发布版不变;新修订发布后旧版 superseded
    const r2res = await post(base, analyst, `/api/analysis-reports/${r.id}/revise`, { expectedVersion: r.version });
    expect(r2res.status).toBe(201);
    let r2 = await json(r2res);
    expect(r2).toMatchObject({ status: 'draft', revisionNo: 2, seriesNo: r.seriesNo, previousReportId: r.id });
    expect((await json(post(base, analyst, `/api/analysis-reports/${r.id}/revise`, { expectedVersion: r.version }))).code).toBe('REPORT_STATE');
    expect((await json(get(base, analyst, `/api/analysis-reports/${r.id}`))).status).toBe('published');
    r2 = await json(post(base, analyst, `/api/analysis-reports/${r2.id}/submit`, { expectedVersion: r2.version }));
    r2 = await json(post(base, reviewer, `/api/analysis-reports/${r2.id}/approve`, { expectedVersion: r2.version }));
    expect((await waitJob(base, reviewer, (await json(post(base, reviewer, `/api/analysis-reports/${r2.id}/publish`, { expectedVersion: r2.version }))).jobId)).status).toBe('succeeded');
    const revs = await json(get(base, analyst, `/api/analysis-reports/${r2.id}/revisions`));
    expect(revs.map((x: { revisionNo: number; status: string }) => [x.revisionNo, x.status])).toEqual([[1, 'superseded'], [2, 'published']]);
    expect((await download(base, analyst, r.id, 'docx')).equals(docx1)).toBe(true);

    // 范围:集团报告(无组织)对受限用户不可见
    expect((await get(base, sh, `/api/analysis-reports/${r.id}`)).status).toBe(404);
    expect((await get(base, sh, `/api/analysis-reports/${r.id}/export?format=pdf`)).status).toBe(404);
    expect(await json(get(base, sh, '/api/analysis-reports'))).toEqual([]);
    // 受限用户只能生成本组织报告
    const shReport = await json(post(base, sh, '/api/analysis-reports', { kind: 'risk_investment' }));
    expect(shReport).toMatchObject({ orgId: fx.orgIds.shanghai, orgName: '上海公司' });
    expect((await post(base, sh, '/api/analysis-reports', { kind: 'risk_investment', orgId: fx.orgIds.hangzhou })).status).toBe(404);
    expect((await json(get(base, sh, '/api/analysis-reports'))).map((x: { id: number }) => x.id)).toEqual([shReport.id]);
  });

  it('执行月报沿用助手组稿;管理员同人审批须写例外原因;草稿可删除', async () => {
    const { base, db, admin, fx } = await boot('newfc-t5-report-monthly-');
    const v = standardBudgetVersion(fx);
    expect((await post(base, admin, '/api/analysis-reports', { kind: 'monthly_execution' })).status).toBe(400);
    let r = await json(post(base, admin, '/api/analysis-reports', { kind: 'monthly_execution', versionId: v.id }));
    expect(r).toMatchObject({ status: 'draft', kind: 'monthly_execution', year: 2026, modelStatus: 'template' });
    expect(r.sections.length).toBeGreaterThan(1);
    expect(r.sections.every((s: { body: string }) => s.body.trim().length > 0)).toBe(true);
    r = await json(post(base, admin, `/api/analysis-reports/${r.id}/submit`, { expectedVersion: r.version }));
    expect((await post(base, admin, `/api/analysis-reports/${r.id}/approve`, { expectedVersion: r.version })).status).toBe(400);
    r = await json(post(base, admin, `/api/analysis-reports/${r.id}/approve`, { expectedVersion: r.version, exceptionReason: '单人部署' }));
    expect(r).toMatchObject({ status: 'approved', selfApproval: true, exceptionReason: '单人部署' });

    const both = createScopedUser(db, { username: 'rpt-both', roleCodes: ['finance_analyst', 'business_reviewer'], allOrgs: true }).session;
    let d = await json(post(base, both, '/api/analysis-reports', { kind: 'monthly_execution', versionId: v.id }));
    d = await json(post(base, both, `/api/analysis-reports/${d.id}/submit`, { expectedVersion: d.version }));
    expect((await json(post(base, both, `/api/analysis-reports/${d.id}/approve`, { expectedVersion: d.version }))).code).toBe('SELF_REVIEW_FORBIDDEN');

    const draft = await json(post(base, both, '/api/analysis-reports', { kind: 'monthly_execution', versionId: v.id }));
    expect((await fetchAs(both, `${base}/api/analysis-reports/${draft.id}?expectedVersion=${draft.version}`, { method: 'DELETE' })).status).toBe(204);
    expect((await get(base, both, `/api/analysis-reports/${draft.id}`)).status).toBe(404);
    expect((await fetchAs(both, `${base}/api/analysis-reports/${d.id}?expectedVersion=${d.version}`, { method: 'DELETE' })).status).toBe(409);
  });
});
