import { describe, expect, it } from 'vitest';
import { TOOL_REGISTRY, executeTool, toolDefinitions, toolPolicy } from '../src/assistant/tools';
import { toolAllowed } from '../src/assistant/tool-policy';
import { testDb, buildFixture } from './helpers';
import { runWithContext } from '../src/core/request-context';
import { createScopedUser } from './http-helpers';
import { loadAuthContext } from '../src/modules/security/security.service';

describe('T-8.2 tool schema and authorization (AC-T8-02/03)', () => {
  it('rejects unknown tools and parameters before any service reads', () => {
    const db = testDb();
    expect(() => executeTool(db, 'nonexistent', {})).toThrow(/未知工具/);
    for (const name of Object.keys(TOOL_REGISTRY)) expect(() => executeTool(db, name, { unknown: 'not a parameter' })).toThrow(/工具参数无效/);
    expect(() => executeTool(db, 'list_budget_versions', { year: '2026' })).toThrow(/year/);
    expect(() => executeTool(db, 'get_budget_matrix', {})).toThrow(/versionId/);
    expect(() => executeTool(db, 'get_budget_matrix', { versionId: 0 })).toThrow(/versionId/);
    expect(() => executeTool(db, 'eas_period_status', { period: '2026' })).toThrow(/period/);
    expect(() => executeTool(db, 'cross_search', { q: 'x'.repeat(65) })).toThrow(/q/);
    expect(() => executeTool(db, 'list_cleaning_aliases', { targetKind: 'invalid' })).toThrow(/targetKind/);
    db.close();
  });
  it('derives model constraints from the executable Zod definitions', () => {
    const declaration = toolDefinitions.find((d) => d.function.name === 'get_budget_matrix')!;
    expect(declaration.function.parameters).toMatchObject({ required: ['versionId'], additionalProperties: false, properties: { versionId: { type: 'integer', minimum: 1 } } });
    const search = toolDefinitions.find((d) => d.function.name === 'cross_search')!;
    expect(search.function.parameters).toMatchObject({ properties: { q: { minLength: 1, maxLength: 64 } } });
  });
  it('multi-domain tool visibility and execution use the parsed kind permission', () => {
    const db = testDb(); buildFixture(db);
    const user = createScopedUser(db, { username: 't8-expense', roleCodes: [], allOrgs: true });
    const auth = loadAuthContext(db, user.userId)!;
    auth.permissions = new Set(['assistant:use', 'expense:read']);
    runWithContext({ requestId: 't8-kind', source: 'http', auth }, () => {
      expect(toolAllowed('domain_ledger')).toBe(true);
      expect(toolPolicy('domain_ledger', { kind: 'expense' })?.permission).toBe('expense:read');
      expect(() => executeTool(db, 'domain_ledger', { kind: 'contracts' })).toThrow(/contract:read/);
      expect(executeTool(db, 'domain_ledger', { kind: 'expense' }).items).toEqual([]);
      expect(() => executeTool(db, 'domain_batch_read', { kind: 'statement', batchId: 1 })).toThrow(/statements:read/);
    });
    db.close();
  });
});
