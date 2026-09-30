import fs from 'fs';
import path from 'path';
import { statementWorkbook } from '../tests/t3-statement-sample';

/** 生成 E2E 用财务报表四表样本(与后端 t3 测试同一布局与金额):tests/fixtures/statements/statement-sample.xlsx。 */
void (async () => {
  const dir = path.join(process.cwd(), 'tests', 'fixtures', 'statements');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'statement-sample.xlsx');
  fs.writeFileSync(file, await statementWorkbook());
  console.log(file);
})();
