import type { DB } from '../src/db/connection';
import { saveBusinessSettings } from '../src/modules/settings/business-settings';

/** 既有正向场景的外部审批摘录。缺字段反例单独使用原始请求。 */
export const SIGNATORIES = { ourSignatoryName: '测试法人', ourSignatoryTitle: '法定代表人', ourSignatoryIsLegalRep: true, counterpartySignatoryIsLegalRep: true };
export const PAYMENT_APPROVAL = { approvalTier: 'finance_vp', approverName: '财务副总', approverTitle: '分管财务副总经理' };
export const CHANGE_GOVERNANCE = { changeMatter: '合同条款调整', decisionMethod: 'approval', finalApproverName: '总经理', finalApproverTitle: '总经理', actualApprovalTier: 'management_board' };
export function seedNetAssets(db: DB) {
  const orgs = db.prepare('SELECT id FROM org WHERE parent_id IS NULL').all() as { id: number }[];
  saveBusinessSettings(db, { 'contract.prior_year_net_assets': JSON.stringify(orgs.flatMap(o => [2025, 2026, 2027].map(year => ({ orgId: o.id, year, amount: '10000000000.00' })))) });
}
