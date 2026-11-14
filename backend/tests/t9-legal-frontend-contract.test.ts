import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { LEGAL_CATEGORIES, PARTY_ROLES, PROCUREMENT_METHODS, EVIDENCE_KINDS, procurementTier } from '../src/contracts/contract-legal-review';
import { computeChangeApprovalTier } from '../src/modules/contracts/contract-change.service';
import * as ui from '../../frontend/src/pages/project/contractLegalOptions';
import * as contractUi from '../../frontend/src/pages/project/contractOptions';

describe('T-9 前端契约边界', () => {
  it('前端法审选项完整且预览在采购阈值、直接报账边界与大额时和服务端一致', () => {
    expect(ui.LEGAL_CATEGORIES).toEqual([...LEGAL_CATEGORIES]);
    expect(ui.PARTY_ROLES).toEqual([...PARTY_ROLES]);
    expect(ui.PROCUREMENT_METHODS).toEqual([...PROCUREMENT_METHODS]);
    expect(ui.EVIDENCE_KINDS).toEqual([...EVIDENCE_KINDS]);
    for (const target of [null, 'goods', 'construction', 'service']) {
      for (const amount of [0n, 2999999n, 3000000n, 3000001n, 29999999n, 30000000n, 49999999n, 50000000n, 99999999n, 100000000n, 149999999n, 150000000n, 299999999n, 300000000n, 9007199254740993n]) {
        for (const procurement of [false, true]) {
          for (const method of [null, 'inquiry', 'direct_reimburse']) {
            expect(ui.procurementTierPreview(procurement, target, amount, method)).toBe(procurementTier(procurement, target, amount, method));
          }
        }
      }
    }
  });
  it('前端附件 5 变更分级预览与服务端 computeChangeApprovalTier 一致', () => {
    const orig = 2_000_000_000n;
    for (const prior of [0n, 200_000_000n, 500_000_000n]) {
      for (const delta of [0n, 20_000_000n, 20_000_001n, 50_000_001n, 100_000_001n, -100_000n]) {
        for (const kind of ['change', 'claim_by_contractor', 'counter_claim', 'suspend', 'terminate'] as const) {
          for (const tech of [false, true]) {
            const input = {
              originalCents: orig, priorApprovedPositiveCents: prior, deltaCents: delta,
              changeKind: kind, procurementTier: 'tier_1' as const, involvesBizOrEntityChange: true, involvesTechChange: tech, orMode: 'min' as const,
            };
            expect(contractUi.changeApprovalTierPreview(input)).toEqual(computeChangeApprovalTier(input));
          }
        }
      }
    }
  });
  it('合同法审前端组件与选项模块只以类型方式依赖后端契约', () => {
    for (const name of ['Contracts.tsx', 'ContractBaseFormModal.tsx', 'ContractSettlementTab.tsx', 'ContractChangeTab.tsx', 'ContractSafeguardTab.tsx', 'ContractExportModal.tsx', 'ContractLegalPanel.tsx', 'ContractLegalCatalog.tsx', 'ContractLegalPublishForm.tsx', 'contractLegalOptions.ts', 'contractOptions.ts']) {
      const file = path.join(__dirname, '../../frontend/src/pages/project', name);
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.startsWith('@contracts/')) {
          expect(statement.importClause?.isTypeOnly, `${name}: ${statement.moduleSpecifier.text}`).toBe(true);
        }
      }
    }
  });
});
