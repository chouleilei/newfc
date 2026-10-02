import type { Express } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import type { ObjectStore } from '../files/object-store';
import { memoryUpload, sendAttachment, uploadName } from '../files/http';
import { MAX_UPLOAD_BYTES } from '../io/import-limits';
import multer from 'multer';
import { id as idSchema } from '../../contracts/common';
import {
  contractAdvanceRequest, contractChangeRequest, contractCommandRequest, contractCreateRequest, contractDocumentForm, contractListQuery, contractPaymentRequest,
  contractPageQuery, contractPayRequest, contractReopenRequest, contractReviewSubmitRequest, contractUpdateRequest, decisionRequest,
} from '../../contracts/project-contract';
import { formFields, queryFields } from '../project-budget/routes';
import {
  addContractDocument, advanceContract, contractDocumentContent, contractSummary, createContract, decideContractChange, decideContractPayment, decideContractReview,
  getContractDetail, listContracts, listContractsPage, payContractPayment, reopenContract, submitContractChange, submitContractPayment, submitContractReview, terminateContract,
  updateContract, voidContract,
} from './contract.service';
import { confirmContractImport, getContractImport, previewContractImport } from './contract-import.service';

addRouteRules([
  { method: 'GET', pattern: /^\/contracts\/imports\/\d+$/, permission: 'contract:import' },
  { method: 'WRITE', pattern: /^\/contracts\/imports(\/\d+\/confirm)?$/, permission: 'contract:import' },
  { method: 'GET', pattern: /^\/contracts(\/|$)/, permission: 'contract:read' },
  { method: 'WRITE', pattern: /^\/contracts\/\d+\/(reviews|changes|payments)\/\d+\/decide$/, permission: 'contract:review' },
  { method: 'WRITE', pattern: /^\/contracts\/\d+\/reopen$/, permission: 'contract:review' },
  { method: 'WRITE', pattern: /^\/contracts(\/\d+(\/(advance|terminate|void|documents|reviews|changes|payments|payments\/\d+\/pay))?)?$/, permission: 'contract:write' },
]);

const id = (v: unknown) => parseInput(idSchema, v);
const confirmRequest = z.object({ planHash: z.string().regex(/^[0-9a-f]{64}$/, '计划哈希不合法') });

/** 合同文档:常见办公与图片格式。 */
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

/** AC-F16 合同生命周期 / AC-F04 合同导入。服务层按合同 org_id 裁剪范围,范围外 404。 */
export function registerContractRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  const tableUpload = memoryUpload(['.csv', '.xlsx']);
  app.post('/api/contracts/imports', tableUpload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw Errors.validation('请上传合同台账 .csv 或 .xlsx');
    res.status(201).json(await previewContractImport(db(), store(), req.file.buffer, uploadName(req.file.originalname)));
  }));
  app.get('/api/contracts/imports/:id', wrap((req, res) => { res.json(getContractImport(db(), id(req.params.id))); }));
  app.post('/api/contracts/imports/:id/confirm', wrap(async (req, res) => {
    res.json(await confirmContractImport(db(), store(), id(req.params.id), parseInput(confirmRequest, req.body).planHash));
  }));

  app.get('/api/contracts', wrap((req, res) => { res.json(listContracts(db(), parseInput(contractListQuery, queryFields(req)))); }));
  app.get('/api/contracts/page', wrap((req, res) => { res.json(listContractsPage(db(), parseInput(contractPageQuery, req.query))); }));
  app.get('/api/contracts/summary', wrap((req, res) => {
    const q = queryFields(req);
    res.json(contractSummary(db(), { orgId: q.orgId ? id(q.orgId) : undefined, projectId: q.projectId ? id(q.projectId) : undefined }));
  }));
  app.post('/api/contracts', wrap((req, res) => { res.status(201).json(createContract(db(), parseInput(contractCreateRequest, req.body))); }));
  app.get('/api/contracts/:id', wrap((req, res) => { res.json(getContractDetail(db(), id(req.params.id))); }));
  app.patch('/api/contracts/:id', wrap((req, res) => { res.json(updateContract(db(), id(req.params.id), parseInput(contractUpdateRequest, req.body))); }));
  app.post('/api/contracts/:id/advance', wrap((req, res) => {
    const b = parseInput(contractAdvanceRequest, req.body);
    res.json(advanceContract(db(), id(req.params.id), b.expectedVersion, b.toStage));
  }));
  app.post('/api/contracts/:id/terminate', wrap((req, res) => {
    const b = parseInput(contractCommandRequest, req.body);
    res.json(terminateContract(db(), id(req.params.id), b.expectedVersion, b.reason));
  }));
  app.post('/api/contracts/:id/void', wrap((req, res) => {
    const b = parseInput(contractCommandRequest, req.body);
    res.json(voidContract(db(), id(req.params.id), b.expectedVersion, b.reason));
  }));
  app.post('/api/contracts/:id/reopen', wrap((req, res) => {
    const b = parseInput(contractReopenRequest, req.body);
    res.json(reopenContract(db(), id(req.params.id), b.expectedVersion, b.reason, b.targetStage));
  }));
  app.post('/api/contracts/:id/documents', docUpload.single('file'), wrap((req, res) => {
    if (!req.file) throw Errors.validation('请选择要上传的文档');
    const form = parseInput(contractDocumentForm, formFields(req));
    res.status(201).json(addContractDocument(db(), store(), id(req.params.id), req.file.buffer, uploadName(req.file.originalname), form.docType, form.name));
  }));
  app.get('/api/contracts/:id/documents/:docId/content', wrap((req, res) => {
    const f = contractDocumentContent(db(), store(), id(req.params.id), id(req.params.docId));
    sendAttachment(res, f.fileName, f.contentType, f.content);
  }));
  app.post('/api/contracts/:id/reviews', wrap((req, res) => {
    const b = parseInput(contractReviewSubmitRequest, req.body);
    res.status(201).json(submitContractReview(db(), id(req.params.id), b.documentId, b.note));
  }));
  app.post('/api/contracts/:id/reviews/:rid/decide', wrap((req, res) => {
    res.json(decideContractReview(db(), id(req.params.id), id(req.params.rid), parseInput(decisionRequest, req.body)));
  }));
  app.post('/api/contracts/:id/changes', wrap((req, res) => { res.status(201).json(submitContractChange(db(), id(req.params.id), parseInput(contractChangeRequest, req.body))); }));
  app.post('/api/contracts/:id/changes/:cid/decide', wrap((req, res) => {
    res.json(decideContractChange(db(), id(req.params.id), id(req.params.cid), parseInput(decisionRequest, req.body)));
  }));
  app.post('/api/contracts/:id/payments', wrap((req, res) => { res.status(201).json(submitContractPayment(db(), id(req.params.id), parseInput(contractPaymentRequest, req.body))); }));
  app.post('/api/contracts/:id/payments/:pid/decide', wrap((req, res) => {
    res.json(decideContractPayment(db(), id(req.params.id), id(req.params.pid), parseInput(decisionRequest, req.body)));
  }));
  app.post('/api/contracts/:id/payments/:pid/pay', wrap((req, res) => {
    res.json(payContractPayment(db(), id(req.params.id), id(req.params.pid), parseInput(contractPayRequest, req.body)));
  }));
}
