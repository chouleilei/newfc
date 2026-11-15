/** 离线编译正式下达公文；输出供管理员核对后传入 decisionDocMeta，不打开业务库。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseCsvObjects } from '../src/db/cli-guard';
import { parseLegacyDoc, parseDocx, MAX_DOC_CONVERT_BYTES } from '../src/modules/contracts/document-parser';
import { compileIssuanceSourceAttachments, type IssuanceSourceDocument } from '../src/modules/plan-execution/issuance-source-attachments';

async function main() {
  const argument = (name:string) => { const i=process.argv.indexOf(name); if(i<0 || !process.argv[i+1]) throw new Error(`必须显式传入 ${name}`); return path.resolve(process.argv[i+1]); };
  const manifest = fs.realpathSync(argument('--manifest'));
  const directory = fs.realpathSync(argument('--documents'));
  const mapping = fs.realpathSync(argument('--unit-map'));
  const output = argument('--output');
  const actualOutput = fs.existsSync(output) ? fs.realpathSync(output) : path.join(fs.realpathSync(path.dirname(output)),path.basename(output));
  const forbidden = (f:string) => /^\/(?:root|data)\/newbd(?:\/|$)/.test(f);
  if ([manifest,directory,mapping,actualOutput].some(forbidden) || [manifest,mapping].includes(actualOutput) || actualOutput.startsWith(directory+path.sep)) throw new Error('输入输出目录不安全，禁止覆盖材料');
  if(fs.statSync(mapping).size > 64*1024) throw new Error('单位映射超过64KB上限');
  if(fs.statSync(manifest).size > 2*1024*1024) throw new Error('清单超过2MB上限');
  const rows = parseCsvObjects(fs.readFileSync(manifest,'utf8'));
  if(rows.length>200) throw new Error('清单超过200项');
  const docs:Record<string,IssuanceSourceDocument> = Object.create(null);
  for(const file of [...new Set(rows.map((r)=>r.doc_filename))]) {
    if(!file || path.basename(file)!==file || !/\.docx?$/i.test(file)) throw new Error('材料必须为目录内的 DOC/DOCX 文件');
    const actual = fs.realpathSync(path.join(directory,file));
    if(!actual.startsWith(directory+path.sep) || forbidden(actual) || fs.statSync(actual).size>MAX_DOC_CONVERT_BYTES) throw new Error('材料路径或体积无效');
    const content=fs.readFileSync(actual);
    const parsed=await (/\.docx$/i.test(file) ? parseDocx(content) : parseLegacyDoc(content));
    docs[file]={...parsed,sha256:crypto.createHash('sha256').update(content).digest('hex')};
  }
  const compiled=compileIssuanceSourceAttachments(rows,docs,JSON.parse(fs.readFileSync(mapping,'utf8')));
  fs.writeFileSync(output,JSON.stringify({unitAttachments:compiled.unitAttachments,unitMetrics:compiled.unitMetrics,issuanceSourceDocuments:compiled.sourceDocuments},null,2)+'\n',{mode:0o600});
  fs.chmodSync(output,0o600);
  console.log(`正式公文 ${compiled.sourceDocuments.length} 份；逻辑附表 ${Object.values(compiled.unitAttachments).reduce((n,a)=>n+a.length,0)} 张；未写入业务库`);
}
main().catch((e)=>{ console.error(e.message); process.exitCode=1; });
