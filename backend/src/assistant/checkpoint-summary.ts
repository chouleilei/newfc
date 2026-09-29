/**
 * 编制记录点「本轮修改小结」(AI 功能增强计划 §四.阶段六.3–4)。
 *
 * - 记录点创建路径(含 lockVersion 同事务自动创建)只写确定性内容;
 *   小结在事务外按 checkpoint id 异步生成、尽力而为,失败不影响记录点本身。
 * - 异步管道只用一张任务表(assistant_narrative_task)+ 轮询,不引入消息队列。
 * - 可靠性(V33):
 *   · 抢占是原子的——claim 用带 status/started_at/attempts 条件的 UPDATE,
 *     changes=1 才算抢到,并发调用同一任务不会重复调用模型;
 *   · 活动任务唯一性由 partial unique index 保证,不依赖应用层先查后插;
 *   · 失败按 attempts 自动重试(默认 3 次,指数退避),用尽后停在 failed
 *     并给出可人工恢复的提示,重新调度会新建任务行;
 *   · 崩溃遗留的 running(started_at 超过 stale 窗口)在启动恢复与再次 claim 时回收。
 * - 生成方式:先由确定性模板聚合 changes_json(金额符号按后端约定在模板层还原,
 *   数量按 ×10⁴ 还原),模型仅改写并过 narrativeNumbersIntact;
 *   模型不直接消费带符号分与缩放整数。
 * - 后台生成额度走服务级叙述桶(tryConsumeNarrativeBudget),不与聊天共用配额;
 *   额度用尽时仍产出确定性模板稿。
 * - provenance 同时落在任务行与 budget_compilation_checkpoint 的 summary_* 列。
 */
import type { DB } from '../db/connection';
import type { AccountType } from '../core/money';
import { centsToWanText as coreCentsToWanText, scaledToQuantityString } from '../core/money';
import { Errors } from '../core/errors';
import { loadSnapshotNodes } from '../modules/tree/snapshot';
import { getVersion, getCompilationCheckpoint, type BudgetCompilationCheckpoint } from '../modules/budget/budget.service';
import { rewriteTemplateNarrative } from './narrative';
import { checkpointSummaryAiEnabled } from './feature-flags';
import { modelConfigured } from './model';
import { tryConsumeNarrativeBudget } from './rate-limit';
import { CHECKPOINT_SUMMARY_REWRITE_TASK, PROMPT_VERSION } from './prompts';

const TASK_KIND = 'checkpoint_summary';
const MAX_LINES = 5;
/** 失败重试上限(含首次尝试);用尽后停在 failed,由用户重新触发。 */
export const MAX_TASK_ATTEMPTS = 3;
/** 服务级叙述配额的桶键:后台小结生成独立计数。 */
const NARRATIVE_BUDGET_KEY = 'narrative:checkpoint_summary';

/**
 * running 超过该时长即视为崩溃遗留,可被回收重排(可用 AI_NARRATIVE_TASK_STALE_MS 覆盖)。
 * 下限放到 10ms 是为了让测试能在毫秒级验证回收路径;生产默认 5 分钟,
 * 误配成极小值的后果只是同一任务可能被重复生成一次(结果幂等覆盖同一条小结)。
 */
export function taskStaleMs(): number {
  const raw = Number(process.env.AI_NARRATIVE_TASK_STALE_MS ?? 300_000);
  if (!Number.isFinite(raw) || raw <= 0) return 300_000;
  return Math.min(3_600_000, Math.max(10, Math.trunc(raw)));
}

/** 第 n 次失败后的重试延迟(指数退避,测试可用 AI_NARRATIVE_TASK_RETRY_MS 压到毫秒级)。 */
function retryDelayMs(attempts: number): number {
  const base = Number(process.env.AI_NARRATIVE_TASK_RETRY_MS ?? 2_000);
  const bounded = Number.isFinite(base) ? Math.min(60_000, Math.max(1, Math.trunc(base))) : 2_000;
  return bounded * Math.max(1, 2 ** (attempts - 1));
}

export interface CheckpointSummaryTask {
  id: number;
  checkpointId: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  source: string;
  model: string;
  promptVersion: string;
  guardOk: boolean | null;
  error: string;
  attempts: number;
  updatedAt: string;
}

interface TaskDbRow {
  id: number;
  ref_id: number;
  status: CheckpointSummaryTask['status'];
  source: string;
  model: string;
  prompt_version: string;
  guard_ok: number | null;
  error: string;
  attempts: number;
  started_at: string;
  updated_at: string;
}

/* 金额/数量格式化直接复用 core/money 的确定性整数口径:
   本地曾各写一套浮点实现(cents/1e6.toFixed(2)、quantity/1e4.toFixed(4)),
   在 >2^53 或百元/万分位尾数边界与 core/money 结果不一致,违反单一口径约束。 */
function centsToWanText(cents: number): string {
  return `${coreCentsToWanText(cents)} 万元`;
}

function quantityText(quantity: number | null): string {
  if (quantity == null) return '0';
  return scaledToQuantityString(quantity);
}

/**
 * 确定性小结草稿:全部事实来自 changes_json 聚合与版本树快照的编码/名称/类型。
 * 金额在模板层按科目利润方向还原符号并以万元展示;数量按 ×10⁴ 缩放还原。
 *
 * 同时产出 factTerms:模板里出现的中文专名(记录点标题、组织/科目名称)。
 * 事实 token 正则只认数字与字母编码,不声明专名的话模型可以把「上海公司」
 * 改写成「杭州公司」而守卫仍然通过。
 */
export function checkpointSummaryDraft(db: DB, checkpoint: BudgetCompilationCheckpoint): { template: string; factTerms: string[] } {
  const version = getVersion(db, checkpoint.versionId);
  const orgRows = loadSnapshotNodes(db, version.org_tree_snapshot_id);
  const accRows = loadSnapshotNodes(db, version.account_tree_snapshot_id);
  const orgById = new Map(orgRows.map((row) => [row.id, row]));
  const accById = new Map(accRows.map((row) => [row.id, row]));
  const terms = new Set<string>([checkpoint.title]);

  const kindCount: Record<string, number> = { amount: 0, quantity: 0, formula: 0, note: 0, mixed: 0 };
  const orgCount = new Map<number, number>();
  const accCount = new Map<number, number>();
  let signedDeltaCents = 0;
  let increasedCells = 0;
  let decreasedCells = 0;
  let noteAdded = 0;
  let noteCleared = 0;
  let noteEdited = 0;

  for (const change of checkpoint.changes) {
    kindCount[change.kind] += 1;
    orgCount.set(change.orgId, (orgCount.get(change.orgId) ?? 0) + 1);
    accCount.set(change.accountId, (accCount.get(change.accountId) ?? 0) + 1);
    const type = accById.get(change.accountId)?.type as AccountType | undefined;
    // 存储值已是利润方向符号(cost/expense 为负),净方向直接用存储差值;符号还原只用于展示
    if (change.before.amountCents !== change.after.amountCents && type && type !== 'quantity') {
      const delta = change.after.amountCents - change.before.amountCents;
      signedDeltaCents += delta;
      if (delta > 0) increasedCells++;
      else if (delta < 0) decreasedCells++;
    }
    if (change.before.note !== change.after.note) {
      if (!change.before.note) noteAdded++;
      else if (!change.after.note) noteCleared++;
      else noteEdited++;
    }
  }

  const orgLabel = (id: number) => {
    const org = orgById.get(id);
    if (!org) return `#${id}`;
    terms.add(org.name);
    return `${org.code} ${org.name}`;
  };
  const accLabel = (id: number) => {
    const acc = accById.get(id);
    if (!acc) return `#${id}`;
    terms.add(acc.name);
    return `${acc.code} ${acc.name}`;
  };
  const topOrgs = [...orgCount.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_LINES);
  const topAccounts = [...accCount.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_LINES);

  const lines: string[] = ['# 本轮修改小结', ''];
  lines.push(`- 记录点「${checkpoint.title}」(第 ${checkpoint.sequenceNo} 次,共 ${checkpoint.changeCount} 处变化)。`);
  lines.push(`- 变化构成:金额 ${kindCount.amount} 处,数量 ${kindCount.quantity} 处,公式 ${kindCount.formula} 处,附注 ${kindCount.note} 处,多维混合 ${kindCount.mixed} 处。`);
  if (increasedCells + decreasedCells > 0) {
    const direction = signedDeltaCents > 0
      ? `净增加 ${centsToWanText(signedDeltaCents)}`
      : signedDeltaCents < 0
        ? `净减少 ${centsToWanText(-signedDeltaCents)}`
        : '增减相抵';
    lines.push(`- 金额方向(按利润方向还原):调增 ${increasedCells} 格,调减 ${decreasedCells} 格,${direction}。`);
  }
  if (noteAdded + noteCleared + noteEdited > 0) {
    lines.push(`- 附注:新增 ${noteAdded} 处,修改 ${noteEdited} 处,清空 ${noteCleared} 处。`);
  }
  if (topOrgs.length > 0) {
    lines.push('', '## 变化集中的组织');
    topOrgs.forEach(([id, count]) => lines.push(`- ${orgLabel(id)}:${count} 处`));
  }
  if (topAccounts.length > 0) {
    lines.push('', '## 变化集中的科目');
    topAccounts.forEach(([id, count]) => lines.push(`- ${accLabel(id)}:${count} 处`));
  }
  // 数量变化单列,不与金额混合
  const quantityChanges = checkpoint.changes.filter((change) => change.before.quantity !== change.after.quantity);
  if (quantityChanges.length > 0) {
    lines.push('', '## 数量变化');
    for (const change of quantityChanges.slice(0, MAX_LINES)) {
      lines.push(`- ${orgLabel(change.orgId)} / ${accLabel(change.accountId)}:${quantityText(change.before.quantity)} → ${quantityText(change.after.quantity)}`);
    }
  }
  const template = lines.join('\n');
  const factTerms = [...terms]
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && template.includes(term));
  return { template, factTerms };
}

/** 确定性模板稿(仅正文)。 */
export function checkpointSummaryTemplate(db: DB, checkpoint: BudgetCompilationCheckpoint): string {
  return checkpointSummaryDraft(db, checkpoint).template;
}

/**
 * 原子抢占任务。可抢占的状态:
 * - pending:正常排队;
 * - running 且 started_at 早于 stale 窗口:上次进程崩溃遗留,回收重排。
 * attempts 在抢占时自增并作为上限判据,changes=1 才算抢到——并发调用中只有一个胜出。
 */
function claimTask(db: DB, taskId: number): TaskDbRow | null {
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - taskStaleMs()).toISOString();
  const info = db.prepare(
    `UPDATE assistant_narrative_task
        SET status = 'running', started_at = ?, updated_at = ?, attempts = attempts + 1
      WHERE id = ?
        AND attempts < ?
        AND (status = 'pending' OR (status = 'running' AND (started_at = '' OR started_at < ?)))`,
  ).run(now, now, taskId, MAX_TASK_ATTEMPTS, staleBefore);
  if (info.changes !== 1) return null;
  return db.prepare('SELECT * FROM assistant_narrative_task WHERE id = ?').get(taskId) as TaskDbRow;
}

/** 失败落库:未用尽重试次数则回到 pending 并延迟重排,用尽则停在 failed 等人工重新触发。 */
function failTask(db: DB, task: TaskDbRow, error: unknown): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 400);
  const now = new Date().toISOString();
  const exhausted = task.attempts >= MAX_TASK_ATTEMPTS;
  if (exhausted) {
    db.prepare("UPDATE assistant_narrative_task SET status = 'failed', started_at = '', error = ?, updated_at = ? WHERE id = ?")
      .run(`${message}(已重试 ${task.attempts}/${MAX_TASK_ATTEMPTS} 次,不再自动重试;可在记录点上重新生成小结)`, now, task.id);
    return;
  }
  db.prepare("UPDATE assistant_narrative_task SET status = 'pending', started_at = '', error = ?, updated_at = ? WHERE id = ?")
    .run(`${message}(第 ${task.attempts} 次尝试失败,将自动重试)`, now, task.id);
  const delay = retryDelayMs(task.attempts);
  const timer = setTimeout(() => { void runCheckpointSummaryTask(db, task.id).catch(() => undefined); }, delay);
  // 重试定时器不应拖住进程退出(单元测试与 CLI 都会等事件循环空)
  timer.unref?.();
}

/**
 * 事务外生成并持久化小结(模板 + 可选模型改写),任务行与记录点 provenance 同事务落库。
 * 抢不到任务(已完成、正在运行、重试用尽)时直接返回,不做任何写入。
 */
export async function runCheckpointSummaryTask(db: DB, taskId: number): Promise<void> {
  const task = claimTask(db, taskId);
  if (!task) return;
  try {
    const checkpoint = getCompilationCheckpoint(db, task.ref_id);
    const { template, factTerms } = checkpointSummaryDraft(db, checkpoint);
    // 后台生成走服务级叙述配额:超限只出模板稿,不排队、不重试、不占聊天额度
    const wantModel = checkpointSummaryAiEnabled() && modelConfigured();
    const enabled = wantModel && tryConsumeNarrativeBudget(NARRATIVE_BUDGET_KEY);
    const rewrite = await rewriteTemplateNarrative({
      enabled,
      promptVersion: PROMPT_VERSION.checkpointSummary,
      task: CHECKPOINT_SUMMARY_REWRITE_TASK,
      template,
      factTerms,
      maxChars: 10_000,
      // 渠道绑定独立于 narrative:设置页「记录点小结」的绑定项必须真正生效
      feature: 'checkpoint_summary',
    });
    const finishedAt = new Date().toISOString();
    const guardOk = rewrite.guardFailure ? 0 : rewrite.source === 'model' ? 1 : null;
    const note = wantModel && !enabled ? '叙述生成配额已满,本次只产出确定性模板稿' : '';
    db.transaction(() => {
      db.prepare(
        `UPDATE budget_compilation_checkpoint
         SET summary = ?, summary_source = ?, summary_model = ?, summary_prompt_version = ?, summary_generated_at = ?, summary_guard_ok = ?
         WHERE id = ?`,
      ).run(rewrite.text, rewrite.source, rewrite.model, rewrite.promptVersion, finishedAt, guardOk, checkpoint.id);
      db.prepare(
        `UPDATE assistant_narrative_task
         SET status = 'done', started_at = '', payload_json = ?, source = ?, model = ?, prompt_version = ?, guard_ok = ?, error = ?, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify({ summary: rewrite.text, guardFailure: rewrite.guardFailure ?? null }), rewrite.source, rewrite.model, rewrite.promptVersion, guardOk, note, finishedAt, taskId);
    })();
  } catch (error) {
    failTask(db, task, error);
  }
}

/**
 * 记录点创建后在事务外调用:登记 pending 任务并异步触发生成(尽力而为)。
 * 同一记录点的活动任务唯一性由数据库 partial unique index 保证:
 * 并发调度时后到的 INSERT 触发唯一约束冲突,这里静默吞掉即为「已排队」。
 */
export function scheduleCheckpointSummary(db: DB, checkpointId: number): void {
  try {
    const now = new Date().toISOString();
    // 已有活动任务时不重复登记;唯一索引是最终保证,这次查询只是少一次异常
    const existing = db.prepare(
      "SELECT id FROM assistant_narrative_task WHERE kind = ? AND ref_id = ? AND status IN ('pending','running') LIMIT 1",
    ).get(TASK_KIND, checkpointId) as { id: number } | undefined;
    if (existing) return;
    const info = db.prepare(
      'INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run(TASK_KIND, checkpointId, 'pending', now, now);
    const taskId = Number(info.lastInsertRowid);
    // 异步触发:不在调用方(可能是路由同步路径)内等待模型;失败只落任务行。
    setImmediate(() => {
      void runCheckpointSummaryTask(db, taskId).catch(() => undefined);
    });
  } catch {
    // 小结是增强能力,调度失败(含唯一约束冲突)不影响记录点写入
  }
}

/**
 * 重新生成某个记录点的小结:已有活动任务时复用,否则新建一条(允许 failed 之后人工恢复)。
 * 返回任务 id,供轮询端点使用。
 */
export function requeueCheckpointSummary(db: DB, checkpointId: number): number {
  // 记录点必须存在:否则会留下永远失败的任务行
  getCompilationCheckpoint(db, checkpointId);
  const active = db.prepare(
    "SELECT id FROM assistant_narrative_task WHERE kind = ? AND ref_id = ? AND status IN ('pending','running') ORDER BY id DESC LIMIT 1",
  ).get(TASK_KIND, checkpointId) as { id: number } | undefined;
  if (active) {
    setImmediate(() => { void runCheckpointSummaryTask(db, active.id).catch(() => undefined); });
    return active.id;
  }
  const now = new Date().toISOString();
  const info = db.prepare(
    'INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(TASK_KIND, checkpointId, 'pending', now, now);
  const taskId = Number(info.lastInsertRowid);
  setImmediate(() => { void runCheckpointSummaryTask(db, taskId).catch(() => undefined); });
  return taskId;
}

/**
 * 服务启动后的任务恢复(§三.4)。进程崩溃/重启会留下两类残留:
 * - pending:登记了但 setImmediate 没跑到;
 * - running:抢占后进程退出,没有任何人会再推进它。
 *
 * 这里把 stale 的 running 归还 pending(重试次数用尽的直接判 failed),
 * 然后串行重排所有 pending 任务(串行是为了不让恢复瞬间打爆模型额度)。
 * 恢复本身失败不影响服务启动。
 */
export function recoverNarrativeTasks(db: DB): { requeued: number; abandoned: number } {
  try {
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - taskStaleMs()).toISOString();
    const abandoned = db.prepare(
      `UPDATE assistant_narrative_task
          SET status = 'failed', started_at = '', error = ?, updated_at = ?
        WHERE status = 'running' AND (started_at = '' OR started_at < ?) AND attempts >= ?`,
    ).run(`服务重启时发现该任务处于 running 且已用尽 ${MAX_TASK_ATTEMPTS} 次尝试,已放弃自动重试`, now, staleBefore, MAX_TASK_ATTEMPTS).changes;
    db.prepare(
      `UPDATE assistant_narrative_task
          SET status = 'pending', started_at = '', error = ?, updated_at = ?
        WHERE status = 'running' AND (started_at = '' OR started_at < ?) AND attempts < ?`,
    ).run('服务重启时回收的未完成任务,已重新排队', now, staleBefore, MAX_TASK_ATTEMPTS);
    const pending = db.prepare(
      "SELECT id FROM assistant_narrative_task WHERE status = 'pending' ORDER BY id",
    ).all() as { id: number }[];
    if (pending.length > 0) {
      setImmediate(() => {
        void (async () => {
          for (const task of pending) {
            await runCheckpointSummaryTask(db, task.id).catch(() => undefined);
          }
        })();
      });
    }
    return { requeued: pending.length, abandoned };
  } catch {
    return { requeued: 0, abandoned: 0 };
  }
}

/**
 * 轮询:记录点最新一次小结任务的状态 + 已持久化的小结内容。
 *
 * versionId 必须与记录点自己的版本一致:记录点 id 全局自增,只按 checkpointId 取数
 * 会让 /api/versions/{A}/checkpoints/{属于B的记录点}/summary 也返回 200,
 * 等于用任意版本路径读到别的版本的编制过程。
 */
export function checkpointSummaryStatus(db: DB, checkpointId: number, versionId?: number): {
  checkpointId: number;
  versionId: number;
  status: 'none' | CheckpointSummaryTask['status'];
  summary: string;
  source: '' | 'template' | 'model';
  model: string;
  promptVersion: string;
  generatedAt: string;
  guardOk: boolean | null;
  attempts: number;
  error: string;
} {
  const checkpoint = getCompilationCheckpoint(db, checkpointId);
  if (versionId != null && checkpoint.versionId !== versionId) throw Errors.notFound('记录点');
  const task = db.prepare(
    'SELECT * FROM assistant_narrative_task WHERE kind = ? AND ref_id = ? ORDER BY id DESC LIMIT 1',
  ).get(TASK_KIND, checkpointId) as TaskDbRow | undefined;
  return {
    checkpointId,
    versionId: checkpoint.versionId,
    status: task?.status ?? 'none',
    summary: checkpoint.summary,
    source: checkpoint.summarySource,
    model: checkpoint.summaryModel,
    promptVersion: checkpoint.summaryPromptVersion,
    generatedAt: checkpoint.summaryGeneratedAt,
    guardOk: checkpoint.summaryGuardOk,
    attempts: task?.attempts ?? 0,
    error: task?.error ?? '',
  };
}
