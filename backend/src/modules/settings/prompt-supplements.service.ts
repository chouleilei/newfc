/**
 * AI 提示补充(T-7,AC-F23):
 * newfc 的提示词集中在 assistant/prompts.ts 并随版本号审阅,不开放整段替换;设置页只能为每个改写任务追加
 * 业务补充说明(风格、关注点),附在硬约束之后,数字守卫不变;非空时 prompt 版本带内容哈希,生成物 provenance 可追溯。
 */
import { createHash } from 'crypto';
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { writeLog } from '../audit/log';
import { PROMPT_VERSION } from '../../assistant/prompts';
import { effectivePromptVersion } from '../../assistant/narrative';
import type { PromptSupplementDto, PromptSupplementSave } from '../../contracts/system-settings';

export const PROMPT_SUPPLEMENT_TASKS = {
  reportRewrite: '报告草稿改写(执行月报、分析报告)',
  qualityAdvice: '定稿质量门禁建议',
  trendNarrative: '年度节奏对比叙述',
  checkpointSummary: '编制记录点修改小结',
  riskExplain: '风险解释与整改建议',
  forecastInsight: '财务预测运行洞察',
  feasibilityReport: '投资可行性分析报告',
} as const satisfies Partial<Record<keyof typeof PROMPT_VERSION, string>>;
export type PromptSupplementTask = keyof typeof PROMPT_SUPPLEMENT_TASKS;

/** 改写调用处读取:未配置或为空返回 undefined。 */
export function promptSupplement(db: DB, task: PromptSupplementTask): string | undefined {
  const r = db.prepare('SELECT content FROM ai_prompt_supplement WHERE task_key = ?').get(task) as { content: string } | undefined;
  return r?.content.trim() || undefined;
}

interface Row { task_key: string; content: string; version: number; updated_by_user_id: number | null; updated_at: string }

export function listPromptSupplements(db: DB): PromptSupplementDto[] {
  const rows = new Map((db.prepare('SELECT * FROM ai_prompt_supplement').all() as Row[]).map((r) => [r.task_key, r]));
  return (Object.keys(PROMPT_SUPPLEMENT_TASKS) as PromptSupplementTask[]).map((k) => {
    const r = rows.get(k);
    const user = r?.updated_by_user_id ? db.prepare('SELECT display_name, username FROM app_user WHERE id = ?').get(r.updated_by_user_id) as { display_name: string | null; username: string } | undefined : undefined;
    return {
      taskKey: k, label: PROMPT_SUPPLEMENT_TASKS[k], basePromptVersion: PROMPT_VERSION[k], effectivePromptVersion: effectivePromptVersion(PROMPT_VERSION[k], r?.content),
      content: r?.content ?? '', version: r?.version ?? 0, updatedBy: user ? (user.display_name || user.username) : null, updatedAt: r?.updated_at ?? null,
    };
  });
}

export function savePromptSupplement(db: DB, task: string, input: PromptSupplementSave): PromptSupplementDto {
  if (!(task in PROMPT_SUPPLEMENT_TASKS)) throw Errors.notFound('改写任务');
  const key = task as PromptSupplementTask;
  const content = input.content.trim();
  db.transaction(() => {
    const r = db.prepare('SELECT version, content FROM ai_prompt_supplement WHERE task_key = ?').get(key) as { version: number; content: string } | undefined;
    const current = r?.version ?? 0;
    if (current !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', '补充说明已被其他人更新,请刷新后重试', 409, undefined, { currentVersion: current });
    if (r && r.content === content) return;
    const now = new Date().toISOString();
    const userId = currentAuth()?.userId ?? null;
    if (r) db.prepare('UPDATE ai_prompt_supplement SET content = ?, version = version + 1, updated_by_user_id = ?, updated_at = ? WHERE task_key = ?').run(content, userId, now, key);
    else db.prepare('INSERT INTO ai_prompt_supplement (task_key, content, version, updated_by_user_id, updated_at) VALUES (?, ?, 1, ?, ?)').run(key, content, userId, now);
    writeLog(db, content ? 'settings.prompt_supplement.save' : 'settings.prompt_supplement.clear', 'ai_prompt_supplement', key, {
      chars: content.length, sha256: content ? createHash('sha256').update(content).digest('hex') : null, promptVersion: effectivePromptVersion(PROMPT_VERSION[key], content),
    });
  })();
  return listPromptSupplements(db).find((d) => d.taskKey === key)!;
}
