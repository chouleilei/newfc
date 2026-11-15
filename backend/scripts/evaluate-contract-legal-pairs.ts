/** 显式离线输入，不读业务库、不调用模型，仅输出匿名编号、摘要和统计。 */
import fs from 'node:fs';
import path from 'node:path';
import { evaluateLegalPairs } from '../src/modules/contracts/legal-paired-evaluation';
function argument(name: string): string { const i = process.argv.indexOf(name); if (i < 0 || !process.argv[i + 1]) throw new Error(`必须显式传入 ${name}`); return path.resolve(process.argv[i + 1]); }
export function runPairedEvaluationCli(manifestArgument = '--manifest'): void {
const input = argument(manifestArgument); const output = argument('--output');
if (input === output) throw new Error('输出不能覆盖标注清单');
const actual = fs.realpathSync(input);
const actualOutput = fs.existsSync(output) ? fs.realpathSync(output) : path.join(fs.realpathSync(path.dirname(output)), path.basename(output));
if (actual === actualOutput) throw new Error('输出不能覆盖标注清单');
if ([actual, actualOutput].some((file) => /^\/(?:root|data)\/newbd(?:\/|$)/.test(file))) throw new Error('禁止访问来源项目运行目录');
if (fs.statSync(actual).size > 10 * 1024 * 1024) throw new Error('标注清单超过10MB上限');
const result = evaluateLegalPairs(JSON.parse(fs.readFileSync(actual, 'utf8')));
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
console.log(`配对 ${result.rows.length} 组；正式历史覆盖 ${8 - result.missingCategories.length}/8；红线漏检 ${result.rows.reduce((n,r) => n+r.fn,0)} 项`);
if (!result.evidenceComplete || !result.redlineRecallPassed) process.exitCode = 2;

}
if (require.main === module) runPairedEvaluationCli();
