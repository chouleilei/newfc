import fs from 'node:fs';
export default function teardown() {
  const dir = process.env.NEWFC_T9_E2E_DIR;
  if (dir && /^\/tmp\/newfc-t9-e2e-[^/]+$/.test(dir))
    fs.rmSync(dir, { recursive: true, force: true });
}
