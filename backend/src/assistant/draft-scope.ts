/** UX-26 页面草稿与只读工具共用的组织范围校验；不读取任何越权业务事实。 */
import type { DB } from '../db/connection';
import type { DraftKind } from '../contracts/page-catalog';
import { AppError } from '../core/errors';
import { currentOrgScope, orgInScope } from '../modules/security/scope';
function invalid(message: string): never { throw new AppError('CONTEXT_INVALID', message, 400); }

export function assertScopedDraftAccess(db: DB, kind: DraftKind, fields: Record<string, unknown>, targetId: number | null): void {
  if (kind !== 'contract_draft' && kind !== 'plan_issuance_draft') return;
  const scope = currentOrgScope(db);
  function denyScope(what: string): never {
    throw new AppError('SCOPE_RESTRICTED', `${what}超出当前账号授权组织范围`, 403);
  }
  const checkOrgId = (raw: unknown, label: string) => {
    if (raw == null || raw === '') return;
    const oid = Number(raw);
    if (!Number.isSafeInteger(oid) || oid <= 0) invalid(`${label} 必须是正整数`);
    const exists = db.prepare('SELECT id FROM org WHERE id = ?').get(oid);
    if (!exists) invalid(`${label} #${oid} 不存在`);
    if (!orgInScope(scope, oid)) denyScope(label);
  };
  const checkPlanItem = (raw: unknown) => {
    if (raw == null || raw === '') return;
    const iid = Number(raw);
    if (!Number.isSafeInteger(iid) || iid <= 0) invalid('planItemId 必须是正整数');
    const pi = db.prepare('SELECT org_id, project_id FROM plan_item WHERE id = ?').get(iid) as { org_id: number | null; project_id: number | null } | undefined;
    if (!pi || (!scope.all && (pi.org_id === null || !orgInScope(scope, pi.org_id)))) denyScope('关联综合计划项');
    if (pi.project_id !== null) {
      const project = db.prepare('SELECT org_id FROM md_project WHERE id = ?').get(pi.project_id) as { org_id: number } | undefined;
      if (!project || !orgInScope(scope, project.org_id)) denyScope('计划关联项目');
    }
  };
  if (kind === 'contract_draft') {
    if (targetId != null) {
      const row = db.prepare('SELECT org_id FROM ct_contract WHERE id = ?').get(targetId) as { org_id: number } | undefined;
      if (row && !orgInScope(scope, row.org_id)) denyScope('合同');
    }
    checkOrgId(fields.orgId, '承办组织');
    checkOrgId(fields.coManagedOrgId, '被统筹组织');
    if (fields.projectId != null && fields.projectId !== '') {
      const pid = Number(fields.projectId);
      if (!Number.isSafeInteger(pid) || pid <= 0) invalid('projectId 必须是正整数');
      const p = db.prepare('SELECT org_id FROM md_project WHERE id = ?').get(pid) as { org_id: number } | undefined;
      if (!p) invalid(`项目 #${pid} 不存在`);
      if (!orgInScope(scope, p.org_id)) denyScope('关联项目');
    }
    checkPlanItem(fields.planItemId);
  }
  if (kind === 'plan_issuance_draft') {
    const cycleId = targetId ?? (fields.cycleId == null || fields.cycleId === '' ? null : Number(fields.cycleId));
    if (cycleId !== null) {
      if (!Number.isSafeInteger(cycleId) || cycleId <= 0) invalid('cycleId 必须是正整数');
      const cycle = db.prepare('SELECT status FROM plan_issuance_cycle WHERE id = ?').get(cycleId) as { status: string } | undefined;
      const packs = db.prepare('SELECT unit_org_id FROM plan_issuance_unit_pack WHERE cycle_id = ?').all(cycleId) as { unit_org_id: number }[];
      if (!cycle || (!scope.all && (cycle.status === 'draft' || !packs.some((p) => orgInScope(scope, p.unit_org_id))))) denyScope('下达周期');
    }
    checkOrgId(fields.orgId, '下达组织');
    checkOrgId(fields.unitOrgId, '申请调整单位');
    if (fields.unitPackId != null && fields.unitPackId !== '') {
      const packId = Number(fields.unitPackId);
      if (!Number.isSafeInteger(packId) || packId <= 0) invalid('unitPackId 必须是正整数');
      const pk = db.prepare('SELECT unit_org_id, cycle_id FROM plan_issuance_unit_pack WHERE id = ?').get(packId) as { unit_org_id: number; cycle_id: number } | undefined;
      if (!pk) invalid(`单元下达包 #${packId} 不存在`);
      if (!orgInScope(scope, pk.unit_org_id)) denyScope('单元下达包');
      if (cycleId !== null && pk.cycle_id !== cycleId) invalid('下达包不属于所选周期');
    }
    if (Array.isArray(fields.lines)) for (const line of fields.lines) {
      if (line && typeof line === 'object') checkPlanItem((line as Record<string, unknown>).planItemId);
    }
  }
}

