import { currentAuth } from '../../core/request-context';
import { listLegalPolicies,listLegalTemplates,publishLegalPolicy,publishLegalTemplate,changeLegalCatalog,attachLegalSource,legalCatalogSource } from './legal-catalog.service';
import { listLegalReviews,getLegalReview,submitLegalReview } from './legal-review-run';
import { catalogReasonRequest, LEGAL_CATEGORIES, type LegalCategory } from '../../contracts/contract-legal-review';
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
  contractArchiveStatusRequest, contractDistributionRequest, contractHandoverRequest, contractResumeRequest, contractSuspendRequest,
  contractChangeFilingRequest, contractReceiptCreateRequest, contractReceiptReceiveRequest, contractSettlementCreateRequest,
  contractDisputeCreateRequest, contractDisputeUpdateRequest, contractGuaranteeCreateRequest, contractGuaranteeUpdateRequest, contractWarrantyUpsertRequest,
  contractEvaluationRequest,
  contractPrefixMapCreateRequest, contractPrefixMapPatchRequest, CONTRACT_IMPORT_KINDS, PREFIX_ENTITY_STATUSES, SUPERVISION_EXPORT_PURPOSES,
  type ContractImportKind, type PrefixEntityStatus, type SupervisionExportPurpose,
} from '../../contracts/project-contract';
import { formFields, queryFields } from '../project-budget/routes';
import { requirePermission } from '../security/scope';
import {
  addContractDocument, advanceContract, contractDocumentContent, contractSummary, createContract, decideContractReview,
  getContractDetail, listContracts, listContractsPage, reopenContract, submitContractReview, terminateContract,
  updateContract, voidContract,
  handoverUndertaker, resumeContract, suspendContract, updateContractArchiveStatus, updateContractDistribution,
} from './contract.service';
import { decideContractChange, submitContractChange, updateContractChangeFiling } from './contract-change.service';
import {
  decideContractPayment, decideContractReceipt, decideContractSettlement, listContractReceipts, listContractSettlements,
  payContractPayment, receiveContractReceipt, submitContractPayment, submitContractReceipt, submitContractSettlement,
} from './contract-settlement.service';
import {
  createContractDispute, createContractGuarantee, getContractWarranty, listContractDisputes, listContractGuarantees,
  updateContractDispute, updateContractGuarantee, upsertContractEvaluation, upsertContractWarranty,
} from './contract-safeguard.service';
import {
  exportMonthlyLedgerXlsx, exportSupervisionPackageZip, getSupervisionPortal, listSupervisionExportLogs, preflightSupervisionExport,
} from './contract-export.service';
import {
  confirmContractImport, generateContractImportTemplate, getContractImport, listContractImports, previewContractImport,
} from './contract-import.service';
import { createPrefixMap, listPrefixMaps, patchPrefixMap, suggestNextContractNo } from './prefix-map.service';

addRouteRules([
  {method:'GET',pattern:/^\/contracts\/legal-catalog(\/|$)/,permission:'contract:read'},
  {method:'WRITE',pattern:/^\/contracts\/legal-catalog(\/|$)/,permission:'knowledge:manage',allOrgs:true},
  {method:'WRITE',pattern:/^\/contracts\/\d+\/legal-reviews\/run$/,permission:['contract:write','contract:review']},
  { method: 'GET', pattern: /^\/contracts\/prefix-map$/, permission: ['contract:read', 'master:read'] },
  { method: 'WRITE', pattern: /^\/contracts\/prefix-map(\/\d+)?$/, permission: 'master:write', allOrgs: true },
  { method: 'GET', pattern: /^\/contracts\/next-no$/, permission: 'contract:read' },
  { method: 'GET', pattern: /^\/contracts\/imports(\/\d+|\/templates?\/[a-z_]+)?$/, permission: ['contract:import', 'contract:migrate'] },
  { method: 'WRITE', pattern: /^\/contracts\/imports(\/\d+\/confirm)?$/, permission: ['contract:import', 'contract:migrate'] },
  { method: 'GET', pattern: /^\/contracts\/exports\/monthly-ledger$/, permission: 'analysis:export' },
  { method: 'GET', pattern: /^\/contracts\/exports\/supervision\/preflight$/, permission: 'contract:read' },
  { method: 'GET', pattern: /^\/contracts\/exports\/logs$/, permission: 'contract:read' },
  { method: 'WRITE', pattern: /^\/contracts\/exports\/supervision\/package$/, permission: 'analysis:export' },
  { method: 'GET', pattern: /^\/contracts\/supervision-portal\/(full|incremental)$/, permission: 'contract:read' },
  { method: 'GET', pattern: /^\/contracts(\/|$)/, permission: 'contract:read' },
  { method: 'WRITE', pattern: /^\/contracts\/\d+\/(reviews|changes|settlements|payments|receipts)\/\d+\/decide$/, permission: 'contract:review' },
  { method: 'WRITE', pattern: /^\/contracts\/\d+\/reopen$/, permission: 'contract:review' },
  { method: 'WRITE', pattern: /^\/contracts\/\d+\/archive-status$/, permission: 'contract:review' },
  { method: 'WRITE', pattern: /^\/contracts\/\d+\/evaluation$/, permission: 'contract:review' },
  { method: 'WRITE', pattern: /^\/contracts\/\d+\/warranty$/, permission: ['contract:write', 'contract:review'] },
  { method: 'WRITE', pattern: /^\/contracts(\/\d+(\/(advance|terminate|void|suspend|resume|distribution|undertaker-handover|documents|reviews|changes|changes\/\d+\/filing|settlements|payments|payments\/\d+\/pay|receipts|receipts\/\d+\/receive|guarantees(\/\d+)?|disputes(\/\d+)?))?)?$/, permission: 'contract:write' },
]);

const id = (v: unknown) => parseInput(idSchema, v);
const confirmRequest = z.object({ planHash: z.string().regex(/^[0-9a-f]{64}$/, '计划哈希不合法') });
const supervisionExportBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  orgId: idSchema.optional(),
  scopeMode: z.enum(['changed', 'all_active']).optional(),
  exportPurpose: z.enum(SUPERVISION_EXPORT_PURPOSES).optional(),
});

/** 合同文档:常见办公与图片格式。 */
const docUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });

/** AC-F16 合同生命周期 / AC-F04 合同导入。服务层按合同 org_id 裁剪范围,范围外 404。 */
export function registerContractRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  for(const kind of ['policies','templates'] as const) {
    const path=`/api/contracts/legal-catalog/${kind}`;
    app.get(path,wrap((_req,res)=>res.json(kind==='policies'?listLegalPolicies(db()):listLegalTemplates(db()))));
    app.post(path,wrap((req,res)=>res.status(201).json(kind==='policies'?publishLegalPolicy(db(),req.body):publishLegalTemplate(db(),req.body))));
    for(const action of (kind==='templates'?['retire','promote']:['retire']) as ('retire'|'promote')[]) app.post(`${path}/:cid/${action}`,wrap((req,res)=>{changeLegalCatalog(db(),kind,id(req.params.cid),action,parseInput(catalogReasonRequest,req.body).reason);res.json({ok:true});}));
    app.post(`${path}/:cid/source`,docUpload.single('file'),wrap((req,res)=>{if(!req.file)throw Errors.validation('请上传原件');attachLegalSource(db(),store(),kind,id(req.params.cid),req.file.buffer,uploadName(req.file.originalname));res.json({ok:true});}));
    app.get(`${path}/:cid/source`,wrap((req,res)=>{const f=legalCatalogSource(db(),store(),kind,id(req.params.cid));sendAttachment(res,f.fileName,f.contentType,f.content);}));
  }
  app.post('/api/contracts/:id/legal-reviews/run',wrap((req,res)=>{const {done,...result}=submitLegalReview(db,store,id(req.params.id),currentAuth());res.status(202).json(result);}));
  app.get('/api/contracts/:id/legal-reviews',wrap((req,res)=>res.json(listLegalReviews(db(),id(req.params.id)))));
  app.get('/api/contracts/:id/legal-reviews/:rid',wrap((req,res)=>res.json(getLegalReview(db(),id(req.params.id),id(req.params.rid)))));

  app.get('/api/contracts/prefix-map', wrap((req, res) => {
    const q = queryFields(req);
    const entityStatus = q.entityStatus && (PREFIX_ENTITY_STATUSES as readonly string[]).includes(q.entityStatus)
      ? (q.entityStatus as PrefixEntityStatus)
      : undefined;
    const allowNewOnly = q.allowNewOnly === '1' || q.allowNewOnly === 'true';
    res.json(listPrefixMaps(db(), { keyword: q.keyword, entityStatus, allowNewOnly }));
  }));
  app.post('/api/contracts/prefix-map', wrap((req, res) => {
    res.status(201).json(createPrefixMap(db(), parseInput(contractPrefixMapCreateRequest, req.body)));
  }));
  app.patch('/api/contracts/prefix-map/:pid', wrap((req, res) => {
    res.json(patchPrefixMap(db(), id(req.params.pid), parseInput(contractPrefixMapPatchRequest, req.body)));
  }));
  app.get('/api/contracts/next-no', wrap((req, res) => {
    const q = queryFields(req);
    if (!q.orgId) throw Errors.validation('请提供 orgId');
    const legalCategory = q.legalCategory && (LEGAL_CATEGORIES as readonly string[]).includes(q.legalCategory)
      ? (q.legalCategory as LegalCategory)
      : undefined;
    res.json(suggestNextContractNo(db(), {
      orgId: id(q.orgId),
      coManagedOrgId: q.coManagedOrgId ? id(q.coManagedOrgId) : undefined,
      signingSubjectOrgId: q.signingSubjectOrgId ? id(q.signingSubjectOrgId) : undefined,
      signingEntityLevel: q.signingEntityLevel === 'secondary_unit' ? 'secondary_unit' : q.signingEntityLevel === 'company' ? 'company' : undefined,
      category: q.category,
      legalCategory,
      direction: q.direction === 'income' ? 'income' : q.direction === 'expense' ? 'expense' : undefined,
      year: q.year ? Number(q.year) : undefined,
    }));
  }));

  const tableUpload = memoryUpload(['.csv', '.xlsx', '.xls'], 40);
  app.get('/api/contracts/imports', wrap((req, res) => {
    const q = queryFields(req);
    const importMode = q.importMode === 'legacy_tolerant' ? 'legacy_tolerant' : q.importMode === 'standard' ? 'standard' : undefined;
    const status = q.status === 'confirmed' ? 'confirmed' : q.status === 'previewed' ? 'previewed' : undefined;
    const limit = q.limit ? Number(q.limit) : undefined;
    res.json(listContractImports(db(), { importMode, status, limit }));
  }));
  for (const tplPath of ['/api/contracts/imports/templates/:kind', '/api/contracts/imports/template/:kind']) {
    app.get(tplPath, wrap(async (req, res) => {
      const kindRaw = String(req.params.kind ?? '');
      if (!(CONTRACT_IMPORT_KINDS as readonly string[]).includes(kindRaw)) {
        throw Errors.validation(`不支持的合同导入模板类型: ${kindRaw}`);
      }
      const out = await generateContractImportTemplate(kindRaw as ContractImportKind);
      sendAttachment(res, out.fileName, out.contentType, out.content);
    }));
  }
  app.post('/api/contracts/imports', tableUpload.any(), wrap(async (req, res) => {
    const uploaded = Array.isArray(req.files) ? req.files : (req.file ? [req.file] : []);
    if (!uploaded.length) throw Errors.validation('请上传合同台账 .csv、.xlsx 或 .xls');
    const fields = formFields(req);
    const defaultOrgId = fields.orgId ? id(fields.orgId) : undefined;
    const importMode = fields.importMode === 'legacy_tolerant' ? 'legacy_tolerant' : 'standard';
    const auth = currentAuth();
    if (importMode === 'standard' && auth && !auth.permissions.has('contract:import')) {
      requirePermission(auth, 'contract:import');
    }
    if (importMode === 'standard' && uploaded.length > 1) {
      throw Errors.validation('标准台账导入单次仅支持上传 1 个文件');
    }
    const [first, ...rest] = uploaded;
    res.status(201).json(await previewContractImport(
      db(),
      store(),
      first.buffer,
      uploadName(first.originalname),
      defaultOrgId,
      {
        importMode,
        batchGroup: fields.batchGroup,
        asOfDate: fields.asOfDate || null,
        extraFiles: rest.map((f) => ({
          buffer: f.buffer,
          fileName: uploadName(f.originalname),
          batchGroup: fields.batchGroup,
          asOfDate: fields.asOfDate || null,
        })),
      },
    ));
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
  app.get('/api/contracts/exports/monthly-ledger', wrap(async (req, res) => {
    const auth = currentAuth();
    if (auth) requirePermission(auth, 'contract:read');
    const q = queryFields(req);
    const out = await exportMonthlyLedgerXlsx(db(), { period: q.period, orgId: q.orgId ? id(q.orgId) : undefined });
    sendAttachment(res, out.fileName, out.contentType, out.content);
  }));
  app.get('/api/contracts/exports/supervision/preflight', wrap((req, res) => {
    const q = queryFields(req);
    const scopeMode = q.scopeMode === 'changed' ? 'changed' : 'all_active';
    const exportPurpose: SupervisionExportPurpose = q.exportPurpose === 'internal_archive' ? 'internal_archive' : 'supervision_submit';
    res.json(preflightSupervisionExport(db(), { period: q.period, orgId: q.orgId ? id(q.orgId) : undefined, scopeMode, exportPurpose }));
  }));
  app.get('/api/contracts/exports/logs', wrap((_req, res) => {
    res.json(listSupervisionExportLogs(db()));
  }));
  app.post('/api/contracts/exports/supervision/package', wrap(async (req, res) => {
    const auth = currentAuth();
    if (auth) requirePermission(auth, 'contract:read');
    const b = parseInput(supervisionExportBody, req.body ?? {});
    const out = await exportSupervisionPackageZip(db(), store(), b);
    sendAttachment(res, out.fileName, out.contentType, out.content);
  }));
  app.get('/api/contracts/supervision-portal/full', wrap((req, res) => {
    const q = queryFields(req);
    res.json(getSupervisionPortal(db(), { mode: 'full', orgId: q.orgId ? id(q.orgId) : undefined }));
  }));
  app.get('/api/contracts/supervision-portal/incremental', wrap((req, res) => {
    const q = queryFields(req);
    res.json(getSupervisionPortal(db(), {
      mode: 'incremental',
      since: q.since,
      cursorId: q.cursorId ? id(q.cursorId) : undefined,
      orgId: q.orgId ? id(q.orgId) : undefined,
    }));
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
    res.json(terminateContract(db(), id(req.params.id), b.expectedVersion, b.reason, b));
  }));
  app.post('/api/contracts/:id/void', wrap((req, res) => {
    const b = parseInput(contractCommandRequest, req.body);
    res.json(voidContract(db(), id(req.params.id), b.expectedVersion, b.reason));
  }));
  app.post('/api/contracts/:id/reopen', wrap((req, res) => {
    const b = parseInput(contractReopenRequest, req.body);
    res.json(reopenContract(db(), id(req.params.id), b.expectedVersion, b.reason, b.targetStage));
  }));
  app.post('/api/contracts/:id/suspend', wrap((req, res) => {
    const b = parseInput(contractSuspendRequest, req.body);
    res.json(suspendContract(db(), id(req.params.id), b.expectedVersion, b.reason, b.guarantorConsentDocumentId));
  }));
  app.post('/api/contracts/:id/resume', wrap((req, res) => {
    const b = parseInput(contractResumeRequest, req.body);
    res.json(resumeContract(db(), id(req.params.id), b.expectedVersion, b.reason));
  }));
  app.post('/api/contracts/:id/distribution', wrap((req, res) => {
    const b = parseInput(contractDistributionRequest, req.body);
    res.json(updateContractDistribution(db(), id(req.params.id), b));
  }));
  app.post('/api/contracts/:id/archive-status', wrap((req, res) => {
    const b = parseInput(contractArchiveStatusRequest, req.body);
    res.json(updateContractArchiveStatus(db(), id(req.params.id), b));
  }));
  app.post('/api/contracts/:id/undertaker-handover', wrap((req, res) => {
    const b = parseInput(contractHandoverRequest, req.body);
    res.json(handoverUndertaker(db(), id(req.params.id), b));
  }));
  app.post('/api/contracts/:id/documents', docUpload.single('file'), wrap((req, res) => {
    if (!req.file) throw Errors.validation('请选择要上传的文档');
    const form = parseInput(contractDocumentForm, formFields(req));
    res.status(201).json(addContractDocument(db(), store(), id(req.params.id), req.file.buffer, uploadName(req.file.originalname), form.docType, form.name, form.evidenceKind, form.changeId));
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
  app.patch('/api/contracts/:id/changes/:cid/filing', wrap((req, res) => {
    res.json(updateContractChangeFiling(db(), id(req.params.id), id(req.params.cid), parseInput(contractChangeFilingRequest, req.body)));
  }));
  app.get('/api/contracts/:id/settlements', wrap((req, res) => { res.json(listContractSettlements(db(), id(req.params.id))); }));
  app.post('/api/contracts/:id/settlements', wrap((req, res) => {
    res.status(201).json(submitContractSettlement(db(), id(req.params.id), parseInput(contractSettlementCreateRequest, req.body)));
  }));
  app.post('/api/contracts/:id/settlements/:sid/decide', wrap((req, res) => {
    res.json(decideContractSettlement(db(), id(req.params.id), id(req.params.sid), parseInput(decisionRequest, req.body)));
  }));
  app.post('/api/contracts/:id/payments', wrap((req, res) => { res.status(201).json(submitContractPayment(db(), id(req.params.id), parseInput(contractPaymentRequest, req.body))); }));
  app.post('/api/contracts/:id/payments/:pid/decide', wrap((req, res) => {
    res.json(decideContractPayment(db(), id(req.params.id), id(req.params.pid), parseInput(decisionRequest, req.body)));
  }));
  app.post('/api/contracts/:id/payments/:pid/pay', wrap((req, res) => {
    res.json(payContractPayment(db(), id(req.params.id), id(req.params.pid), parseInput(contractPayRequest, req.body)));
  }));
  app.get('/api/contracts/:id/receipts', wrap((req, res) => { res.json(listContractReceipts(db(), id(req.params.id))); }));
  app.post('/api/contracts/:id/receipts', wrap((req, res) => {
    res.status(201).json(submitContractReceipt(db(), id(req.params.id), parseInput(contractReceiptCreateRequest, req.body)));
  }));
  app.post('/api/contracts/:id/receipts/:rid/decide', wrap((req, res) => {
    res.json(decideContractReceipt(db(), id(req.params.id), id(req.params.rid), parseInput(decisionRequest, req.body)));
  }));
  app.post('/api/contracts/:id/receipts/:rid/receive', wrap((req, res) => {
    res.json(receiveContractReceipt(db(), id(req.params.id), id(req.params.rid), parseInput(contractReceiptReceiveRequest, req.body)));
  }));
  app.get('/api/contracts/:id/guarantees', wrap((req, res) => { res.json(listContractGuarantees(db(), id(req.params.id))); }));
  app.post('/api/contracts/:id/guarantees', wrap((req, res) => {
    res.status(201).json(createContractGuarantee(db(), id(req.params.id), parseInput(contractGuaranteeCreateRequest, req.body)));
  }));
  app.patch('/api/contracts/:id/guarantees/:gid', wrap((req, res) => {
    res.json(updateContractGuarantee(db(), id(req.params.id), id(req.params.gid), parseInput(contractGuaranteeUpdateRequest, req.body)));
  }));
  app.get('/api/contracts/:id/warranty', wrap((req, res) => { res.json(getContractWarranty(db(), id(req.params.id))); }));
  app.put('/api/contracts/:id/warranty', wrap((req, res) => {
    res.json(upsertContractWarranty(db(), id(req.params.id), parseInput(contractWarrantyUpsertRequest, req.body)));
  }));
  app.get('/api/contracts/:id/disputes', wrap((req, res) => { res.json(listContractDisputes(db(), id(req.params.id))); }));
  app.post('/api/contracts/:id/disputes', wrap((req, res) => {
    res.status(201).json(createContractDispute(db(), id(req.params.id), parseInput(contractDisputeCreateRequest, req.body)));
  }));
  app.patch('/api/contracts/:id/disputes/:did', wrap((req, res) => {
    res.json(updateContractDispute(db(), id(req.params.id), id(req.params.did), parseInput(contractDisputeUpdateRequest, req.body)));
  }));
  app.put('/api/contracts/:id/evaluation', wrap((req, res) => {
    res.json(upsertContractEvaluation(db(), id(req.params.id), parseInput(contractEvaluationRequest, req.body)));
  }));
}
