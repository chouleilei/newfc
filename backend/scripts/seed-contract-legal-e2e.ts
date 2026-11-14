import { saveBusinessSettings } from '../src/modules/settings/business-settings';
/** Disposable T-9 browser fixture. Refuse any directory outside /tmp/newfc-t9-e2e-*. */
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { bootstrapAdmin } from '../src/modules/security/security.service';
import { createOrg } from '../src/modules/org/org.service';
import { runWithContext, systemContext } from '../src/core/request-context';
import { importLegalSeed } from '../src/modules/contracts/legal-catalog.service';
const dir = process.env.NEWFC_DATA_DIR ?? '';
if (!/^\/tmp\/newfc-t9-e2e-[^/]+$/.test(dir))
  throw new Error('T-9 E2E 只能使用指定临时目录');
fs.mkdirSync(dir, { recursive: true });
const db = openDatabase(path.join(dir, 'newfc.sqlite'));
try {
  applyMigrations(db);
  runWithContext(systemContext('cli'), () => {
    bootstrapAdmin(db, 'e2e', 'Vt9-playwright-local-pw');
    const group = createOrg(db, {
      parentId: null,
      code: 'GROUP',
      name: '集团',
    });
    saveBusinessSettings(db, { 'contract.prior_year_net_assets': JSON.stringify([2025,2026,2027].map(year => ({ orgId: group.id, year, amount: '10000000000.00' }))) });
    const east = createOrg(db, {
      parentId: group.id,
      code: 'EAST',
      name: '华东',
    });
    createOrg(db, { parentId: east.id, code: 'SH', name: '上海公司' });
    importLegalSeed(
      db,
      JSON.parse(
        fs.readFileSync(
          path.join(__dirname, '../../deploy/contract-legal-seed-v1.json'),
          'utf8',
        ),
      ),
    );
  });
} finally {
  db.close();
}
