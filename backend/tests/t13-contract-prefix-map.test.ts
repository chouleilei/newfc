import { describe, expect, it } from 'vitest';
import { seedOrgsFromCsv } from '../src/modules/org/seed-org-cli';
import { seedPrefixMapFromCsv } from '../src/modules/contracts/seed-prefix-map-cli';
import {
  matchContractPrefix,
  suggestNextContractNo,
  validateNewContractNoWithPrefixMap,
} from '../src/modules/contracts/prefix-map.service';
import { deriveContractSixDim } from '../src/modules/contracts/contract-controls';
import { scanRisks } from '../src/modules/risk/risk.service';
import { boot, get, json, post } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';

const SYNTHETIC_ORG_CSV = [
  'code,parent_code,name,short_name,report_full_name,credit_code,org_kind,contract_prefix_code,plan_issuance_root_code,is_plan_excluded,is_direct_station,status,sort_order',
  'GRP,,集团母公司,母公司,集团母公司,91000000000000001A,legal_entity,GRP,GRP,0,0,active,10',
  'HQ_MGMT,GRP,企业管理部,企管部,集团母公司/企业管理部,,hq_dept,GRP,GRP,0,0,active,20',
  'STA,GRP,甲水电站,甲站,集团母公司/甲水电站,,direct_unit,STA,STA,0,1,active,30',
  'STB,GRP,乙水电站,乙站,集团母公司/乙水电站,,direct_unit,STB,STB,0,1,active,40',
  'BRC,GRP,丙直属分公司,丙分,集团母公司/丙直属分公司,,direct_unit,BRC,BRC,0,0,active,50',
  'SBE,GRP,戊能源子公司,戊能,戊能源子公司,91000000000000002B,legal_entity,SBE,SBE,0,0,active,60',
  'SBF,SBE,己风电公司,己风,己风电公司,91000000000000003C,legal_entity,SBE,SBE,0,0,active,70',
  'SBX,GRP,庚独立水电公司,庚司,庚独立水电公司,91000000000000004D,legal_entity,SBX,GRP,1,0,active,80',
  'HIST_H,SBX,辛历史关停电站,辛站,辛历史关停电站,,closed_history,SBX,GRP,1,0,inactive,90',
].join('\n');

const SYNTHETIC_PREFIX_CSV = [
  'raw_prefix,canonical_prefix,legal_entity_code,signing_org_code,signing_org_name,parent_canonical_prefix,entity_status,allow_new_contract,prefix_kind,sample_contract_no,occurrence_count,备注',
  'GRP,GRP,GRP,GRP,集团母公司,,active,1,internal_prefix,GRP-SG-001/2026-001,100,集团母公司规范码',
  'CJ,GRP,GRP,GRP,基地核算,,active,1,internal_prefix,CJ-SG-001/2026-002,20,基地核算规范码',
  'STA,STA,GRP,STA,甲水电站,GRP,active,1,internal_prefix,STA-SG-001/2026-001,50,直属电站1',
  'STB,STB,GRP,STB,乙水电站,GRP,active,1,internal_prefix,STB-SG-001/2026-001,40,直属电站2',
  'BRC,BRC,GRP,BRC,丙直属分公司,GRP,active,1,internal_prefix,BRC-XF-001/2026-001,30,非电站直属分支',
  'SBE,SBE,SBE,SBE,戊能源子公司,GRP,active,1,internal_prefix,SBE-JG-001/2026-001,60,一级子法人',
  'SBF,SBE,SBF,SBF,己风电公司,SBE,active,0,internal_prefix,SBF-SG-001/2023-001,25,未单设码子法人沿用母公司SBE',
  'SBX,SBX,SBX,SBX,庚独立水电公司,GRP,active,1,internal_prefix,SBX-SG-001/2026-001,10,存续独立子法人',
  'HST,SBX,SBX,HIST_H,辛历史关停电站,SBX,inactive,0,internal_prefix,HST-SG-001/2018-001,12,已吸收注销历史主体',
  '乙方SBE,SBE,SBE,SBE,戊能源子公司,GRP,active,0,role_prefix,乙方SBE-XF-001/2024-001,5,角色前缀',
  'EXTGRID,EXT,EXT,,外部电网编号,,external,0,external_counterparty,EXTGRID2025001,8,外部相对方编码',
  '例子,IGNORE,IGNORE,,模板示例行,,ignore,0,noise_header_filter,例子,2,表头示例过滤',
].join('\n');

describe('T-13 GAP-11 合同母公司简码映射、六维法人解耦与配置化校验', () => {
  it('种子初始化与六维推导：沿用母公司代码、历史关停双轨冻结、直属电站与分支机构分流', async () => {
    const { db, base, admin } = await boot('newfc-t13-prefix-');
    {
      const orgSeed = seedOrgsFromCsv(db, SYNTHETIC_ORG_CSV, 'confirm');
      expect(orgSeed.errors).toEqual([]);
      const pfxSeed = seedPrefixMapFromCsv(db, SYNTHETIC_PREFIX_CSV, 'confirm');
      expect(pfxSeed.errors).toEqual([]);
      expect(pfxSeed.byStatus).toEqual({
        active_legal: 5,
        direct_unit: 3,
        inherited_child: 1,
        closed_history: 1,
        external: 1,
        ignore: 1,
      });
      // 仅 GRP, CJ, STA, STB, BRC, SBE, SBX 允许新签，SBF(inherited_child) 与 HST(closed_history) 自动置 0
      expect(pfxSeed.allowNewCount).toBe(7);

      const orgIdByCode = (code: string) =>
        (db.prepare('SELECT id FROM org WHERE code = ?').get(code) as { id: number }).id;
      const grpId = orgIdByCode('GRP');
      const hqMgmtId = orgIdByCode('HQ_MGMT');
      const staId = orgIdByCode('STA');
      const brcId = orgIdByCode('BRC');
      const sbeId = orgIdByCode('SBE');
      const sbfId = orgIdByCode('SBF');
      const sbxId = orgIdByCode('SBX');
      const histId = orgIdByCode('HIST_H');

      // 1) 未单设简码的二级子公司 SUB_F 自动沿用母公司 SBE 取号，但以自身名义签约时法人归属 SUB_F
      const sugChild = suggestNextContractNo(db, {
        orgId: sbfId,
        signingEntityLevel: 'secondary_unit',
        category: 'SG',
        year: 2026,
      });
      expect(sugChild.canonicalPrefix).toBe('SBE');
      expect(sugChild.suggestedNo).toBe('SBE-SG-001/2026-001');
      expect(sugChild.legalEntityOrgId).toBe(sbfId);

      // 2) 子公司承办但以母公司 GRP 名义签署：法人主体精确绑定 GRP
      const sixParentSigned = deriveContractSixDim(db, {
        orgId: sbfId,
        signingSubjectOrgId: grpId,
        signingLevel: 'company',
      });
      expect(sixParentSigned.legalEntityOrgId).toBe(grpId);
      expect(sixParentSigned.signingSubjectOrgId).toBe(grpId);

      // 3) 统筹部门代办下属单位合同时向被统筹单位取号
      const sugCoManaged = suggestNextContractNo(db, {
        orgId: hqMgmtId,
        coManagedOrgId: staId,
        category: 'JG',
        year: 2026,
      });
      expect(sugCoManaged.canonicalPrefix).toBe('STA');
      expect(sugCoManaged.suggestedNo).toBe('STA-JG-001/2026-001');
      expect(sugCoManaged.isDirectStation).toBe(true);

      // 4) 历史关停主体禁新签，历史合同同时冻结签约时点主体与现行承接法人
      expect(() => suggestNextContractNo(db, { orgId: histId, year: 2026 })).toThrow(/历史关停/);
      const hstMatch = matchContractPrefix(db, 'HST-SG-005/2018-012');
      expect(hstMatch?.row.entity_status).toBe('closed_history');
      const sixClosed = deriveContractSixDim(db, {
        orgId: sbxId,
        signingOrgId: histId,
        prefixLegalEntityOrgId: hstMatch?.row.legal_entity_org_id,
        prefixSuccessorOrgId: hstMatch?.row.successor_org_id,
      });
      expect(sixClosed.historicalLegalEntityOrgId).toBe(histId);
      expect(sixClosed.legalEntityOrgId).toBe(sbxId);

      // 5) 新签编号校验拒绝历史前缀 SBF/HST 及外部前缀 EXTGRID，放行规范母公司前缀 SBE
      expect(() =>
        validateNewContractNoWithPrefixMap(db, { contractNo: 'SBF-SG-001/2026-001', orgId: sbfId }),
      ).toThrow(/SBE/);
      expect(() =>
        validateNewContractNoWithPrefixMap(db, { contractNo: 'EXTGRID-2026-001', orgId: grpId }),
      ).toThrow(/外部相对方/);
      expect(
        validateNewContractNoWithPrefixMap(db, { contractNo: 'SBE-SG-001/2026-001', orgId: sbfId }).canonicalPrefix,
      ).toBe('SBE');

      // 6) 直属水电站 (is_direct_station=1: ST_A) 资金进项合同强制以母公司名义签订；
      //    非电站直属分支 (is_direct_station=0: BR_C) 可用分支名义签订，超10工作日未报备触发 CW-32，内部关联交易免报备
      const badStationInc = await post(base, admin, '/api/contracts', {
        contractNo: 'STA-XF-001/2026-001',
        name: '直属电站进项违规签约测试',
        orgId: staId,
        direction: 'income',
        signingEntityLevel: 'secondary_unit',
        originalAmount: '100000.00',
        signDate: '2026-01-10',
      });
      expect(badStationInc.status).toBe(409);

      const okStationInc = await post(base, admin, '/api/contracts', {
        contractNo: 'STA-XF-001/2026-001',
        name: '直属电站母公司名义进项合同',
        orgId: staId,
        direction: 'income',
        signingEntityLevel: 'company',
        originalAmount: '100000.00',
        signDate: '2026-01-10',
      });
      expect(okStationInc.status).toBe(201);

      const branchIncResp = await post(base, admin, '/api/contracts', {
        contractNo: 'BRC-XF-001/2026-001',
        name: '直属分支外部进项合同',
        orgId: brcId,
        direction: 'income',
        signingEntityLevel: 'secondary_unit',
        originalAmount: '80000.00',
        signDate: '2026-01-05',
      });
      expect(branchIncResp.status).toBe(201);
      const branchInc = await json(branchIncResp);
      expect(branchInc.legalEntityOrgId).toBe(grpId);

      const internalSubIncResp = await post(base, admin, '/api/contracts', {
        contractNo: 'SBE-XF-002/2026-002',
        name: '集团内部关联服务协议',
        orgId: sbeId,
        direction: 'income',
        signingEntityLevel: 'secondary_unit',
        originalAmount: '60000.00',
        signDate: '2026-01-05',
      });
      expect(internalSubIncResp.status).toBe(201);
      const internalSubInc = await json(internalSubIncResp);
      db.prepare("UPDATE ct_contract SET distribution_status = 'completed' WHERE id IN (?, ?)").run(branchInc.id, internalSubInc.id);
      db.prepare('UPDATE ct_contract SET is_internal_group_tx = 1 WHERE id = ?').run(internalSubInc.id);

      scanRisks(db);
      const overdueEvents = db
        .prepare("SELECT subject_id, evidence_json FROM risk_event WHERE rule_code = 'CONTRACT_DISTRIBUTION_OVERDUE'")
        .all() as { subject_id: number; evidence_json: string }[];
      const hitIds = new Set(overdueEvents.map((e) => e.subject_id));
      expect(hitIds.has(branchInc.id)).toBe(true);
      expect(hitIds.has(internalSubInc.id)).toBe(false);

      // 7) HTTP 路由 CRUD 与权限校验
      const listAll = await json(get(base, admin, '/api/contracts/prefix-map?allowNewOnly=1'));
      expect(listAll.length).toBe(7);

      const nextNoHttp = await json(get(base, admin, `/api/contracts/next-no?orgId=${sbfId}&category=SG&year=2026`));
      expect(nextNoHttp.canonicalPrefix).toBe('SBE');

      const scopedMaintainer = createScopedUser(db, {
        username: 'scoped_maint',
        roleCodes: ['data_maintainer'],
        orgIds: [sbeId],
      }).session;
      const forbiddenWrite = await fetchAs(scopedMaintainer, `${base}/api/contracts/prefix-map`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          rawPrefix: 'NEWP',
          canonicalPrefix: 'SBE',
          legalEntityOrgId: sbeId,
          entityStatus: 'active_legal',
          allowNewContract: false,
          prefixKind: 'internal_prefix',
        }),
      });
      expect(forbiddenWrite.status).toBe(403);
    }
  });
});
