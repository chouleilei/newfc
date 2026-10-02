import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { boot, get, post, upload, type Session } from './t3-helpers';
import { createScopedUser } from './http-helpers';

/** AC-F22：首版制度六类阈值与材料命中规则；来源与兼容编码见 docs/source-provenance.md。 */

const SAMPLE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../deploy/expense-policy-v1.json'), 'utf8')) as {
  clauses: { clauseNo: string; requiredKeywords: string[]; keywordMinMatches?: number }[];
};

async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const body = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function waitRun(base: string, s: Session, claimId: number) {
  for (let i = 0; i < 100; i += 1) {
    const c = await ok(get(base, s, `/api/expense/claims/${claimId}`));
    if (c.runs.length >= 1 && c.status !== 'submitted') return c.runs[0];
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`报销单 ${claimId} 未在期限内产生审核运行`);
}

const codes = (run: { findings: { code: string }[] }) => run.findings.map((f) => f.code).sort();

describe('OPEN-05 lishui 首版费用预审规则', () => {
  it('样本制度可发布;超阈值、材料至少命中两项、无材料要求的类型与 lishui 结论一致', async () => {
    const t = await boot('newfc-t6-exl-');
    const maker = createScopedUser(t.db, { username: 'exl-maker', roleCodes: ['data_maintainer'], orgIds: [t.fx.orgIds.east] }).session;
    const policy = await ok(post(t.base, t.admin, '/api/expense/policies', SAMPLE), 201);
    expect(policy).toMatchObject({ code: 'LISHUI-EXPENSE-V1', version: 1, status: 'active' });
    expect(policy.clauses.map((c: { keywordMinMatches: number | null }) => c.keywordMinMatches)).toEqual([2, 2, 2, 2, null, 2]);

    // 至少命中数不能大于关键词数
    const tooMany = { ...SAMPLE, code: 'LISHUI-BAD', clauses: [{ ...SAMPLE.clauses[0], keywordMinMatches: 5 }] };
    const r = await post(t.base, t.admin, '/api/expense/policies', tooMany);
    expect(r.status).toBe(400);

    const submit = async (expenseType: string, amount: string, files: string[]) => {
      const claim = await ok(post(t.base, maker, '/api/expense/claims', {
        orgId: t.fx.orgIds.shanghai, applicant: '李四', department: '工程部', expenseType, amount, occurredDate: '2026-05-10', description: 'lishui 口径核对',
        lines: [{ expenseType, amount, invoiceNo: `INV-${expenseType}-${amount}`, invoiceDate: '2026-05-10', description: expenseType }],
      }), 201);
      for (const f of files) await ok(upload(t.base, maker, `/api/expense/claims/${claim.id}/attachments`, Buffer.from(`${f}-内容`), f), 201);
      const cur = await ok(get(t.base, maker, `/api/expense/claims/${claim.id}`));
      await ok(post(t.base, maker, `/api/expense/claims/${claim.id}/submit`, { expectedReviewVersion: cur.reviewVersion }));
      return waitRun(t.base, maker, claim.id);
    };

    // 住宿 2,000 > 1,500;附件命中“住宿”“发票”两项 → 只有超阈值
    const hotel = await submit('住宿费', '2000.00', ['住宿发票.pdf']);
    expect(codes(hotel)).toEqual(['LIMIT_EXCEEDED', 'MODEL_UNAVAILABLE', 'OCR_UNAVAILABLE']);
    expect(hotel.findings.find((f: { code: string }) => f.code === 'LIMIT_EXCEEDED').clauseLabel).toBe('LISHUI-EXPENSE-V1 v1 第 2 条');

    // 差旅 4,000 ≤ 5,000;只命中“发票”一项 → 一条材料不足,列出识别到的材料
    const travel = await submit('差旅费', '4000.00', ['发票.jpg']);
    expect(codes(travel)).toEqual(['MATERIAL_MISSING', 'MODEL_UNAVAILABLE', 'OCR_UNAVAILABLE']);
    const material = travel.findings.find((f: { code: string }) => f.code === 'MATERIAL_MISSING');
    expect(material.message).toContain('至少 2 项');
    expect(material.message).toContain('「发票」');

    // 差旅命中“行程”“水单”两项 → 齐套
    const travelOk = await submit('差旅', '1200.00', ['行程单.pdf', '酒店水单.png']);
    expect(codes(travelOk)).toEqual(['MODEL_UNAVAILABLE', 'OCR_UNAVAILABLE']);

    // 办公费无材料要求:8,000 ≤ 10,000 无规则发现;无附件时不产生 OCR 发现
    const office = await submit('办公费', '8000.00', []);
    expect(codes(office).filter((c) => !['MODEL_UNAVAILABLE', 'OCR_UNAVAILABLE'].includes(c))).toEqual([]);
  });
});
