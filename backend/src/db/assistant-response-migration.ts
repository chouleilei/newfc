/** V66 的一次性数据转换。运行时助手不引用本模块。 */
import type { DB } from './connection';
import { isPageId } from '../contracts/page-catalog';
import { DOMAIN_ID_FIELDS } from '../contracts/assistant';

const numericFields = new Set<string>([...DOMAIN_ID_FIELDS, 'year', 'budgetVersionId', 'targetVersionId', 'actualSnapshotId', 'importBatchId', 'orgScopeId', 'accountScopeId', 'metricId', 'insightId', 'conversionId', 'mappingVersionId', 'templateId', 'baseVersionId', 'compareVersionId']);
const textFields = new Set(['period', 'periodFrom', 'periodTo', 'periodStart', 'periodEnd', 'asOfDate', 'statementScope', 'pageLabel']);
const names: Record<string, string> = { orgId: 'orgScopeId', accountId: 'accountScopeId', page: 'pageKey' };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function normalizeAssistantResponses(db: DB): void {
  const rows = db.prepare("SELECT id,response_json FROM ai_message WHERE role='assistant' ORDER BY id").all() as { id: number; response_json: string }[];
  const update = db.prepare('UPDATE ai_message SET response_json=? WHERE id=?');
  for (const row of rows) {
    let response: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.response_json);
      if (!object(parsed)) throw new Error('响应不是对象');
      response = parsed;
    } catch (error) {
      throw new Error(`V66 ai_message #${row.id} 的 response_json 无法安全迁移：${error instanceof Error ? error.message : '无效 JSON'}`);
    }
    const raw = response.effectiveContext ?? response.resolvedContext;
    const normalized: Record<string, unknown> = { historical: true, reusable: true };
    let reusable = object(raw) && Object.keys(raw).length > 0;
    if (object(raw)) for (const [oldKey, value] of Object.entries(raw)) {
      const key = names[oldKey] ?? oldKey;
      if (value == null) continue;
      if (numericFields.has(key) && typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && (key !== 'year' || value >= 1900 && value <= 9999)) normalized[key] = value;
      else if (textFields.has(key) && typeof value === 'string') {
        const valid = key === 'statementScope' ? ['parent', 'subsidiary', 'consolidated'].includes(value) : key === 'pageLabel' ? true : key === 'period' ? /^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(value) : ['periodFrom', 'periodTo'].includes(key) ? /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value) : /^\d{4}-\d{2}-\d{2}$/.test(value);
        if (valid) normalized[key] = value; else reusable = false;
      }
      else if (key === 'pageKey' && typeof value === 'string' && isPageId(value)) normalized[key] = value;
      else if (key === 'view' && object(value)) normalized[key] = value;
      else if (key !== 'historical' && key !== 'reusable') reusable = false;
    }
    normalized.reusable = reusable;
    if (!reusable) normalized.historicalRange = raw ?? null;
    response.effectiveContext = normalized;
    const trace = object(response.contextTrace) ? response.contextTrace : {};
    const used = Array.isArray(trace.used) ? trace.used : Array.isArray(response.resolution) ? response.resolution : [];
    response.contextTrace = {
      ...trace,
      used: used.map((entry: unknown) => object(entry) ? { ...entry, field: names[String(entry.field)] ?? entry.field } : entry),
      overrides: Array.isArray(trace.overrides) ? trace.overrides.map((entry: unknown) => object(entry) ? { ...entry, field: names[String(entry.field)] ?? entry.field } : entry) : [],
      warnings: [...(Array.isArray(trace.warnings) ? trace.warnings : []), reusable ? '历史回答范围；追问时按当前权限重新核验。' : '历史范围无法确定，请在追问中明确范围。'],
    };
    delete response.resolvedContext;
    delete response.resolution;
    update.run(JSON.stringify(response), row.id);
  }
}
