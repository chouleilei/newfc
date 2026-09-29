import type { DB } from '../../db/connection';
import * as actual from '../actual/actual.service';
import { queryLogs } from '../audit/log';
import { accountStructureIssues, orgStructureIssues, structureCheckPayload } from '../check/master-data-health';

/**
 * 首页工作台总览(/api/dashboard 与助手 get_dashboard_overview 工具同源)。
 *
 * 原来这段计数与状态拼装内联在 server.ts 路由里，助手无法复用；抽成 service 后
 * 页面与工具看到的是同一份数字。`recentLogs` 只供已登录的页面展示；助手工具侧
 * 需要日志时应走 get_operation_log(带脱敏)，不要把本字段透传给模型。
 */
export function dashboardOverview(db: DB) {
  const count = (sql: string) => (db.prepare(sql).get() as { c: number }).c;
  const currentVersions = db.prepare("SELECT id, year, name FROM budget_version WHERE kind = 'budget' AND is_current = 1 ORDER BY year DESC").all();
  const years = actual.listYearStates(db);
  const lastBatch = db.prepare('SELECT year, snapshot_date, created_at FROM actual_snapshot_batch WHERE updates_current = 1 AND status = ? ORDER BY snapshot_date DESC, id DESC LIMIT 1').get('active') as { year: number; snapshot_date: string } | undefined;
  // 结构检查与 /api/org/check、/api/account/check 同一信号源(结构化 issues + {ok,problems} 兼容)
  const orgCheck = structureCheckPayload(orgStructureIssues(db));
  const accCheck = structureCheckPayload(accountStructureIssues(db));
  /* UX-24 首页「下一步」所需的后台事实(只读):
     - recentDraft:最近更新的草稿版本,供「继续编制」直接定位 /budget/:id;
     - pendingAdoption:有定稿版本但该年度该用途尚无当前采用版本的(year,kind)组合,
       归档版本不计入;只陈述事实,是否采用由用户决定;
     - yearActuals:各年度 active 快照的最大截止日与批次数,首页据此客观表述
       「尚无快照 / 最新快照截至 D」,不因月份过去断言漏报。 */
  const recentDraft = db.prepare(
    "SELECT id, year, name, kind, updated_at FROM budget_version WHERE status = 'draft' ORDER BY updated_at DESC, id DESC LIMIT 1",
  ).get() as { id: number; year: number; name: string; kind: string; updated_at: string } | undefined;
  const pendingAdoption = db.prepare(`
    SELECT v.year AS year, v.kind AS kind, COUNT(*) AS lockedCount,
      (SELECT l.name FROM budget_version l
        WHERE l.year = v.year AND l.kind = v.kind AND l.status = 'locked'
        ORDER BY l.locked_at DESC, l.id DESC LIMIT 1) AS latestLockedName
    FROM budget_version v
    WHERE v.status = 'locked'
      AND NOT EXISTS (
        SELECT 1 FROM budget_version c
        WHERE c.year = v.year AND c.kind = v.kind AND c.is_current = 1
      )
    GROUP BY v.year, v.kind
    ORDER BY v.year DESC, v.kind
  `).all() as { year: number; kind: string; lockedCount: number; latestLockedName: string | null }[];
  const yearActuals = db.prepare(`
    SELECT year, MAX(snapshot_date) AS latest_snapshot, COUNT(*) AS batch_count
    FROM actual_snapshot_batch
    WHERE status = 'active'
    GROUP BY year
    ORDER BY year DESC
  `).all() as { year: number; latest_snapshot: string; batch_count: number }[];
  return {
    counts: {
      orgs: count('SELECT COUNT(*) AS c FROM org'),
      accounts: count('SELECT COUNT(*) AS c FROM account'),
      metrics: count('SELECT COUNT(*) AS c FROM report_metric'),
      versions: count('SELECT COUNT(*) AS c FROM budget_version'),
      batches: count('SELECT COUNT(*) AS c FROM actual_snapshot_batch'),
    },
    currentVersions,
    years,
    lastActual: lastBatch ?? null,
    structure: { org: orgCheck, account: accCheck },
    workState: {
      recentDraft: recentDraft ?? null,
      pendingAdoption,
      yearActuals,
    },
    recentLogs: queryLogs(db, { pageSize: 10 }).items,
  };
}
