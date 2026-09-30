import type { Express } from 'express';
import type { DB } from '../../db/connection';
import { addRouteRules } from '../security/route-rules';
import { parseInput } from '../../core/validate';
import type { Wrap } from '../security/http';
import { queryFields } from '../project-budget/routes';
import { searchQuery, searchSuggestQuery } from '../../contracts/search';
import { crossDomainSearch, searchSuggestions } from './search.service';

/** 跨域检索(AC-F26):路由只要求登录,逐类型的读权限与组织范围由 service 按 AuthContext 判断。 */
addRouteRules([{ method: 'GET', pattern: /^\/search(\/suggestions)?$/, permission: 'search:use' }]);

export function registerSearchRoutes(app: Express, db: () => DB, wrap: Wrap): void {
  app.get('/api/search', wrap((req, res) => { res.json(crossDomainSearch(db(), parseInput(searchQuery, queryFields(req)))); }));
  app.get('/api/search/suggestions', wrap((req, res) => { res.json(searchSuggestions(db(), parseInput(searchSuggestQuery, queryFields(req)))); }));
}
