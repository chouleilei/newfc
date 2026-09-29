import type { Express } from 'express';
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import type { Wrap } from '../security/http';
import {
  createProject, createSupplier, getProject, getSupplier, listMappings, listProjects, listSuppliers, resolvePreview,
  retireMapping, updateProject, updateSupplier, upsertMapping, type MasterEntityType,
} from './master.service';

function id(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw Errors.validation('id 不合法');
  return n;
}

function q(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 200) throw Errors.validation('查询参数不合法');
  return value;
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Errors.validation('请求体必须是对象');
  return value as Record<string, unknown>;
}

/** 主数据(AC-F07):项目按组织范围裁剪;供应商与映射为全局主数据,映射写入需全组织用户(路由表)。 */
export function registerMasterRoutes(app: Express, db: () => DB, wrap: Wrap): void {
  app.get('/api/master/projects', wrap((req, res) => {
    const orgId = q(req.query.orgId);
    res.json(listProjects(db(), { status: q(req.query.status), keyword: q(req.query.keyword), orgId: orgId ? id(orgId) : undefined }));
  }));
  app.get('/api/master/projects/:id', wrap((req, res) => { res.json(getProject(db(), id(req.params.id))); }));
  app.post('/api/master/projects', wrap((req, res) => { res.status(201).json(createProject(db(), body(req.body))); }));
  app.patch('/api/master/projects/:id', wrap((req, res) => { res.json(updateProject(db(), id(req.params.id), body(req.body))); }));

  app.get('/api/master/suppliers', wrap((req, res) => { res.json(listSuppliers(db(), { status: q(req.query.status), keyword: q(req.query.keyword) })); }));
  app.get('/api/master/suppliers/:id', wrap((req, res) => { res.json(getSupplier(db(), id(req.params.id))); }));
  app.post('/api/master/suppliers', wrap((req, res) => { res.status(201).json(createSupplier(db(), body(req.body))); }));
  app.patch('/api/master/suppliers/:id', wrap((req, res) => { res.json(updateSupplier(db(), id(req.params.id), body(req.body))); }));

  app.get('/api/master/mappings', wrap((req, res) => {
    res.json(listMappings(db(), { sourceSystem: q(req.query.sourceSystem), entityType: q(req.query.entityType), includeRetired: req.query.includeRetired === '1' }));
  }));
  app.post('/api/master/mappings', wrap((req, res) => { res.status(201).json(upsertMapping(db(), body(req.body))); }));
  app.post('/api/master/mappings/:id/retire', wrap((req, res) => { res.json(retireMapping(db(), id(req.params.id))); }));

  /** 只读解析预览:不写库,导入前核对“外部编码/名称 → 规范实体”。 */
  app.post('/api/master/resolve', wrap((req, res) => {
    const b = body(req.body);
    const type = b.entityType as MasterEntityType;
    if (!['org', 'account', 'project', 'supplier'].includes(type)) throw Errors.validation('实体类型只能是 org/account/project/supplier');
    const items = Array.isArray(b.items) ? b.items.map((it) => {
      const o = body(it);
      return { code: typeof o.code === 'string' ? o.code : undefined, name: typeof o.name === 'string' ? o.name : undefined };
    }) : [];
    res.json(resolvePreview(db(), type, items, {
      sourceSystem: typeof b.sourceSystem === 'string' ? b.sourceSystem : undefined,
      asOf: typeof b.asOf === 'string' && !Number.isNaN(Date.parse(b.asOf)) ? b.asOf : undefined,
    }));
  }));
}
