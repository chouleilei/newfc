import type { Express } from 'express';
import type { DB } from '../../db/connection';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import type { ObjectStore } from '../files/object-store';
import { sendAttachment } from '../files/http';
import { id as idSchema } from '../../contracts/common';
import { rptApprove, rptCommand, rptExportQuery, rptGenerate, rptListQuery, rptReturn, rptSectionUpdate } from '../../contracts/analysis-reports';
import { queryFields } from '../project-budget/routes';
import {
  approveAnalysisReport, deleteAnalysisDraft, exportAnalysisReport, generateAnalysisReport, getAnalysisReport, listAnalysisReports, listReportRevisions,
  listSectionEdits, publishAnalysisReport, returnAnalysisReport, reviseAnalysisReport, submitAnalysisReport, updateReportSection,
} from './report.service';

/* /report/ 是继承的分析接口,/standard-reports 是标准报表;分析报告使用独立前缀。 */
addRouteRules([
  { method: 'GET', pattern: /^\/analysis-reports(\/|$)/, permission: 'report:read' },
  { method: 'WRITE', pattern: /^\/analysis-reports\/\d+\/(approve|return)$/, permission: 'report:approve' },
  { method: 'WRITE', pattern: /^\/analysis-reports\/\d+\/publish$/, permission: 'report:publish' },
  { method: 'WRITE', pattern: /^\/analysis-reports(\/\d+(\/(sections\/\d+|submit|revise))?)?$/, permission: 'report:write' },
]);

const id = (v: unknown) => parseInput(idSchema, v);

/** AC-F18 分析报告。服务层按报告 org_id 裁剪范围(无组织的集团报告只对全组织用户可见),范围外 404。 */
export function registerAnalysisReportRoutes(app: Express, db: () => DB, wrap: Wrap, store: () => ObjectStore): void {
  const base = '/api/analysis-reports';
  app.get(base, wrap((req, res) => { res.json(listAnalysisReports(db(), parseInput(rptListQuery, queryFields(req)))); }));
  app.post(base, wrap(async (req, res) => { res.status(201).json(await generateAnalysisReport(db(), parseInput(rptGenerate, req.body ?? {}))); }));
  app.get(`${base}/:id`, wrap((req, res) => { res.json(getAnalysisReport(db(), id(req.params.id))); }));
  app.delete(`${base}/:id`, wrap((req, res) => {
    deleteAnalysisDraft(db(), id(req.params.id), parseInput(rptCommand, queryFields(req)).expectedVersion);
    res.status(204).end();
  }));
  app.get(`${base}/:id/revisions`, wrap((req, res) => { res.json(listReportRevisions(db(), id(req.params.id))); }));
  app.get(`${base}/:id/edits`, wrap((req, res) => { res.json(listSectionEdits(db(), id(req.params.id))); }));
  app.patch(`${base}/:id/sections/:sectionId`, wrap((req, res) => {
    res.json(updateReportSection(db(), id(req.params.id), id(req.params.sectionId), parseInput(rptSectionUpdate, req.body ?? {})));
  }));
  app.post(`${base}/:id/submit`, wrap((req, res) => { res.json(submitAnalysisReport(db(), id(req.params.id), parseInput(rptCommand, req.body ?? {}).expectedVersion)); }));
  app.post(`${base}/:id/return`, wrap((req, res) => { res.json(returnAnalysisReport(db(), id(req.params.id), parseInput(rptReturn, req.body ?? {}))); }));
  app.post(`${base}/:id/approve`, wrap((req, res) => { res.json(approveAnalysisReport(db(), id(req.params.id), parseInput(rptApprove, req.body ?? {}))); }));
  app.post(`${base}/:id/publish`, wrap((req, res) => {
    const { jobId } = publishAnalysisReport(db, store(), id(req.params.id), parseInput(rptCommand, req.body ?? {}).expectedVersion);
    res.status(202).json({ jobId });
  }));
  app.post(`${base}/:id/revise`, wrap((req, res) => { res.status(201).json(reviseAnalysisReport(db(), id(req.params.id), parseInput(rptCommand, req.body ?? {}).expectedVersion)); }));
  app.get(`${base}/:id/export`, wrap(async (req, res) => {
    const f = await exportAnalysisReport(db(), store(), id(req.params.id), parseInput(rptExportQuery, queryFields(req)).format);
    sendAttachment(res, f.fileName, f.contentType, f.buffer);
  }));
}
