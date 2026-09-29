import type { DB } from '../src/db/connection';
import { runWithContext, systemContext } from '../src/core/request-context';
import { bootstrapAdmin, ensureBuiltinRoles } from '../src/modules/security/security.service';

/**
 * E2E 夹具专用账号:只写入一次性测试库(data/finance-e2e、data/e2e-simulation),
 * 与 frontend/tests/e2e/access.ts 共用默认值。生产库没有任何内置账号,须 admin:create 初始化。
 */
export const E2E_USER = process.env.NEWFC_E2E_USER || 'e2e';
export const E2E_PASSWORD = process.env.NEWFC_E2E_PASSWORD || 'Vt9-playwright-local-pw';

export function seedE2eUser(db: DB): void {
  ensureBuiltinRoles(db);
  runWithContext(systemContext('cli'), () => bootstrapAdmin(db, E2E_USER, E2E_PASSWORD, 'E2E 管理员'));
}
