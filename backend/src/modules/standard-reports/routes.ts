import type { Express } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import { sendAttachment } from '../files/http';
import { id as idSchema } from '../../contracts/common';
import { STD_REPORT_TYPES, stdReportGenerate, stdReportReview } from '../../contracts/standard-reports';
import { exportReport, generateReport, getReport, listReports, reviewReport } from './standard-report.service';

/* /report/ 已是继承的分析接口(analysis:read),标准报表使用独立前缀。 */
addRouteRules([
  { method: 'GET', pattern: /^\/standard-reports(\/|$)/, permission: 'report:read' },
  { method: 'WRITE', pattern: /^\/standard-reports\/\d+\/review$/, permission: 'report:approve' },
  { method: 'WRITE', pattern: /^\/standard-reports$/, permission: 'report:write' },
]);

const id = (value: unknown) => parseInput(idSchema, value);

/** AC-F19 标准报表。服务层按 AuthContext 裁剪组织范围。 */
export function registerStandardReportRoutes(app: Express, db: () => DB, wrap: Wrap): void {
  app.get('/api/standard-reports', wrap((req, res) => {
    const type = req.query.reportType;
    if (type !== undefined && type !== '' && !STD_REPORT_TYPES.includes(type as never)) throw Errors.validation('查询参数不合法');
    const status = req.query.status;
    if (status !== undefined && status !== '' && status !== 'generated' && status !== 'reviewed') throw Errors.validation('查询参数不合法');
    const period = typeof req.query.period === 'string' && req.query.period ? String(req.query.period) : undefined;
    if (period && !/^\d{4}(-\d{2})?$/.test(period)) throw Errors.validation('期间格式应为 YYYY 或 YYYY-MM');
    res.json(listReports(db(), { reportType: (type || undefined) as never, status: (status || undefined) as string | undefined, period }));
  }));
  app.get('/api/standard-reports/:id', wrap((req, res) => { res.json(getReport(db(), id(req.params.id))); }));
  app.get('/api/standard-reports/:id/export', wrap(async (req, res) => {
    const f = await exportReport(db(), id(req.params.id));
    sendAttachment(res, f.fileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', f.buffer);
  }));
  app.post('/api/standard-reports', wrap((req, res) => { res.status(201).json(generateReport(db(), parseInput(stdReportGenerate, req.body ?? {}))); }));
  app.post('/api/standard-reports/:id/review', wrap((req, res) => { res.json(reviewReport(db(), id(req.params.id), parseInput(stdReportReview, req.body ?? {}))); }));
}
