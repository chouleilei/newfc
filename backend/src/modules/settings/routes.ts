import type { Express } from 'express';
import { z } from 'zod';
import type { DB } from '../../db/connection';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { addRouteRules } from '../security/route-rules';
import { id as idSchema } from '../../contracts/common';
import {
  CUSTOM_FIELD_DOMAINS, IMPORT_ALIAS_DATA_TYPES, customFieldCreate, customFieldUpdate, importAliasCreate, importAliasUpdate, promptSupplementSave,
} from '../../contracts/system-settings';
import { createCustomField, listCustomFields, updateCustomField } from './custom-fields.service';
import { createImportAlias, importTargetCatalog, listImportAliases, updateImportAlias } from './import-aliases.service';
import { listPromptSupplements, savePromptSupplement } from './prompt-supplements.service';

// /settings/* 由继承规则按 settings:read / settings:manage 控制;表单渲染用的有效字段定义对主数据读者开放。
addRouteRules([{ method: 'GET', pattern: /^\/master\/custom-fields$/, permission: 'master:read' }]);

const id = (value: unknown) => parseInput(idSchema, value);
const domainQuery = z.object({ domain: z.enum(CUSTOM_FIELD_DOMAINS).optional(), activeOnly: z.enum(['true', 'false']).optional() });
const aliasQuery = z.object({ dataType: z.enum(IMPORT_ALIAS_DATA_TYPES).optional() });

/** T-7 系统设置补齐(AC-F23):自定义字段、导入字段模板、AI 提示补充。 */
export function registerSystemSettingsRoutes(app: Express, db: () => DB, wrap: Wrap): void {
  app.get('/api/master/custom-fields', wrap((req, res) => {
    res.json({ items: listCustomFields(db(), { domain: parseInput(domainQuery, req.query).domain, activeOnly: true }) });
  }));
  app.get('/api/settings/custom-fields', wrap((req, res) => {
    const q = parseInput(domainQuery, req.query);
    res.json({ items: listCustomFields(db(), { domain: q.domain, activeOnly: q.activeOnly === 'true' }) });
  }));
  app.post('/api/settings/custom-fields', wrap((req, res) => { res.status(201).json(createCustomField(db(), parseInput(customFieldCreate, req.body))); }));
  app.patch('/api/settings/custom-fields/:id', wrap((req, res) => { res.json(updateCustomField(db(), id(req.params.id), parseInput(customFieldUpdate, req.body))); }));

  app.get('/api/settings/import-field-targets', wrap((_req, res) => { res.json({ items: importTargetCatalog() }); }));
  app.get('/api/settings/import-field-aliases', wrap((req, res) => { res.json({ items: listImportAliases(db(), parseInput(aliasQuery, req.query)) }); }));
  app.post('/api/settings/import-field-aliases', wrap((req, res) => { res.status(201).json(createImportAlias(db(), parseInput(importAliasCreate, req.body))); }));
  app.patch('/api/settings/import-field-aliases/:id', wrap((req, res) => { res.json(updateImportAlias(db(), id(req.params.id), parseInput(importAliasUpdate, req.body))); }));

  app.get('/api/settings/ai-prompt-supplements', wrap((_req, res) => { res.json({ items: listPromptSupplements(db()) }); }));
  app.put('/api/settings/ai-prompt-supplements/:task', wrap((req, res) => { res.json(savePromptSupplement(db(), String(req.params.task), parseInput(promptSupplementSave, req.body))); }));
}
