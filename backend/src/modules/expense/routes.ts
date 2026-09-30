import type { Express } from 'express';
import multer from 'multer';
import path from 'node:path';
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import type { ObjectStore } from '../files/object-store';
import { sendAttachment, uploadName } from '../files/http';
import { MAX_UPLOAD_BYTES } from '../io/import-limits';
import { id as idSchema } from '../../contracts/common';
import {
  claimAttachmentForm, claimCreateRequest, claimListQuery, claimReviewRequest, claimSubmitRequest, claimUpdateRequest, policyCreateRequest, policyRetireRequest,
} from '../../contracts/expense';
import { formFields, queryFields } from '../project-budget/routes';
import {
  addClaimAttachment, ATTACHMENT_EXTENSIONS, attachPolicySource, claimAttachmentContent, createClaim, createPolicy, expenseQueue, getClaimDetail, getPolicy,
  listClaims, listPolicies, policySourceContent, removeClaimAttachment, retirePolicy, reviewClaim, submitClaim, updateClaim,
} from './expense.service';
import { startClaimAudit } from './audit-run';

addRouteRules([
  { method: 'GET', pattern: /^\/expense(\/|$)/, permission: 'expense:read' },
  { method: 'WRITE', pattern: /^\/expense\/policies(\/\d+\/(retire|source))?$/, permission: 'expense:review' },
  { method: 'WRITE', pattern: /^\/expense\/claims\/\d+\/(review|audit)$/, permission: 'expense:review' },
  { method: 'WRITE', pattern: /^\/expense\/claims(\/\d+(\/(submit|attachments|attachments\/\d+))?)?$/, permission: 'expense:submit' },
]);

const id = (v: unknown) => parseInput(idSchema, v);

const fileUpload = (extensions: string[]) => multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (extensions.includes(path.extname(uploadName(file.originalname)).toLowerCase())) cb(null, true);
    else cb(new AppError('VALIDATION_FAILED', `仅支持 ${extensions.join(' / ')} 文件`, 400));
  },
});

/** AC-F22 费用审核。服务层按报销单 org_id 裁剪范围,范围外 404;制度依据维护要求全组织范围。 */
export function registerExpenseRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  const attachmentUpload = fileUpload(ATTACHMENT_EXTENSIONS);
  const sourceUpload = fileUpload(['.pdf', '.docx', '.txt', '.ofd']);

  app.get('/api/expense/policies', wrap((req, res) => { res.json(listPolicies(db(), { includeRetired: queryFields(req).includeRetired === '1' })); }));
  app.post('/api/expense/policies', wrap((req, res) => { res.status(201).json(createPolicy(db(), parseInput(policyCreateRequest, req.body))); }));
  app.get('/api/expense/policies/:id', wrap((req, res) => { res.json(getPolicy(db(), id(req.params.id))); }));
  app.post('/api/expense/policies/:id/retire', wrap((req, res) => { res.json(retirePolicy(db(), id(req.params.id), parseInput(policyRetireRequest, req.body).reason)); }));
  app.post('/api/expense/policies/:id/source', sourceUpload.single('file'), wrap((req, res) => {
    if (!req.file) throw Errors.validation('请选择制度原件');
    res.json(attachPolicySource(db(), store(), id(req.params.id), req.file.buffer, uploadName(req.file.originalname)));
  }));
  app.get('/api/expense/policies/:id/source', wrap((req, res) => {
    const f = policySourceContent(db(), store(), id(req.params.id));
    sendAttachment(res, f.fileName, f.contentType, f.content);
  }));

  app.get('/api/expense/queue', wrap((req, res) => {
    const q = queryFields(req);
    res.json(expenseQueue(db(), { orgId: q.orgId ? id(q.orgId) : undefined }));
  }));
  app.get('/api/expense/claims', wrap((req, res) => { res.json(listClaims(db(), parseInput(claimListQuery, queryFields(req)))); }));
  app.post('/api/expense/claims', wrap((req, res) => { res.status(201).json(createClaim(db(), parseInput(claimCreateRequest, req.body))); }));
  app.get('/api/expense/claims/:id', wrap((req, res) => { res.json(getClaimDetail(db(), id(req.params.id))); }));
  app.put('/api/expense/claims/:id', wrap((req, res) => { res.json(updateClaim(db(), id(req.params.id), parseInput(claimUpdateRequest, req.body))); }));
  app.post('/api/expense/claims/:id/attachments', attachmentUpload.single('file'), wrap((req, res) => {
    if (!req.file) throw Errors.validation('请选择要上传的附件');
    const form = parseInput(claimAttachmentForm, formFields(req));
    res.status(201).json(addClaimAttachment(db(), store(), id(req.params.id), req.file.buffer, uploadName(req.file.originalname), form.kindHint, form.name));
  }));
  app.delete('/api/expense/claims/:id/attachments/:aid', wrap((req, res) => { res.json(removeClaimAttachment(db(), id(req.params.id), id(req.params.aid))); }));
  app.get('/api/expense/claims/:id/attachments/:aid/content', wrap((req, res) => {
    const f = claimAttachmentContent(db(), store(), id(req.params.id), id(req.params.aid));
    sendAttachment(res, f.fileName, f.contentType, f.content);
  }));
  /** 提交后立即以后台任务启动审核运行;响应带 jobId,页面轮询报销单或任务状态。 */
  app.post('/api/expense/claims/:id/submit', wrap((req, res) => {
    const claimId = id(req.params.id);
    submitClaim(db(), claimId, parseInput(claimSubmitRequest, req.body).expectedReviewVersion);
    const { jobId } = startClaimAudit(db, store, claimId, 'submit');
    res.json({ claim: getClaimDetail(db(), claimId), jobId });
  }));
  /** 复核人重跑审核(如配置 OCR/模型后);新运行成为复核依据。 */
  app.post('/api/expense/claims/:id/audit', wrap((req, res) => {
    const claimId = id(req.params.id);
    const { jobId } = startClaimAudit(db, store, claimId, 'rerun');
    res.status(202).json({ claim: getClaimDetail(db(), claimId), jobId });
  }));
  app.post('/api/expense/claims/:id/review', wrap((req, res) => { res.json(reviewClaim(db(), id(req.params.id), parseInput(claimReviewRequest, req.body))); }));
}
