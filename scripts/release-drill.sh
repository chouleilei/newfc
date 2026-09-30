#!/usr/bin/env bash
# newfc 发布与回退演练(AC-X08):在临时副本中用真实 deploy.sh / rollback.sh 依次验证
#   1. 基线发布成功并就绪;
#   2. 构建失败:dist 不变、服务不停;
#   3. 迁移失败:不替换产物、库版本不变(迁移事务回滚),可按手册启动旧版本;
#   4. schema 变化的发布成功:dist.old 保留上一版;
#   5. 回退:库 schema 高于旧代码时拒绝;恢复 pre-migrate 备份时列出备份后的写入,
#      未加 --accept-data-loss 拒绝;确认后换回旧产物、库回到旧版本并就绪。
# 副本只含仓库文件(git ls-files),依赖以符号链接引用本仓库 node_modules(不安装、不改动);
# 服务由演练用的伪 systemctl 以 pid 文件管理,只控制副本进程,不触碰任何真实服务。
#
# 用法: scripts/release-drill.sh [演练目录(须不存在或为空)]   端口: DRILL_PORT(默认 3769)
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRILL="${1:-$(mktemp -d /tmp/newfc-release-drill-XXXXXX)}"
PORT="${DRILL_PORT:-3769}"
NODE_VERSION="$(cat "$SRC/.nvmrc")"
export PATH="${NEWFC_NODE_BIN:-/root/.nvm/versions/node/v${NODE_VERSION}/bin}:$PATH"

case "$DRILL" in *newbd*|*lishui*) echo "拒绝:演练目录不能指向 newbd/lishui" >&2; exit 1 ;; esac
case "$PORT" in 3748|3760) echo "拒绝:演练端口不能使用运行服务端口 $PORT" >&2; exit 1 ;; esac
mkdir -p "$DRILL"
[[ -z "$(ls -A "$DRILL")" ]] || { echo "演练目录必须为空: $DRILL" >&2; exit 1; }
if curl -fsS "http://127.0.0.1:$PORT/api/health/live" >/dev/null 2>&1; then echo "端口 $PORT 已被占用" >&2; exit 1; fi

ROOT="$DRILL/root"; DATA="$DRILL/data"; STATE="$DRILL/state"; LOG="$DRILL/drill.log"
mkdir -p "$ROOT" "$DATA" "$STATE" "$DRILL/bin"
T0=$(date +%s)
FAILS=0
step() { echo; echo "== $*" | tee -a "$LOG"; }
check() { local desc="$1"; shift; if "$@"; then echo "  ✓ $desc" | tee -a "$LOG"; else echo "  ✗ $desc" | tee -a "$LOG"; FAILS=$((FAILS + 1)); fi; }
not() { ! "$@"; }

# 副本:仓库文件 + 依赖符号链接(node_modules 为本地目录,缓存写在副本内)
(cd "$SRC" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -xf - -C "$ROOT"
for d in backend frontend; do
  mkdir -p "$ROOT/$d/node_modules"
  for e in "$SRC/$d/node_modules/"* "$SRC/$d/node_modules/".[!.]*; do
    [[ -e "$e" ]] || continue
    case "$(basename "$e")" in .tmp|.vite|.cache|.newfc-lock.sha256) continue ;; esac
    ln -s "$e" "$ROOT/$d/node_modules/$(basename "$e")"
  done
done

# 伪 systemctl:只管理副本进程
cat > "$DRILL/bin/systemctl" <<SH
#!/usr/bin/env bash
pidf="$STATE/service.pid"
alive() { [[ -f "\$pidf" ]] && kill -0 "\$(cat "\$pidf")" 2>/dev/null; }
echo "\$1" >> "$STATE/calls"
case "\$1" in
  is-active) alive ;;
  stop) if alive; then kill "\$(cat "\$pidf")"; for _ in \$(seq 1 50); do alive || break; sleep 0.2; done; fi; rm -f "\$pidf" ;;
  start) cd "$ROOT/backend" || exit 1
         # 直接后台运行 node(nohup exec),\$! 即服务进程本身,stop 才能真正停掉它
         NEWFC_DATA_DIR="$DATA" NEWFC_PORT="$PORT" AI_BASE_URL= AI_API_KEY= AI_MODEL= OPENAI_API_KEY= OPENAI_BASE_URL= \
           nohup node dist/index.js >> "$STATE/service.log" 2>&1 &
         echo \$! > "\$pidf" ;;
  *) exit 2 ;;
esac
SH
chmod +x "$DRILL/bin/systemctl"
touch "$STATE/calls"
trap '"$DRILL/bin/systemctl" stop >/dev/null 2>&1 || true' EXIT

export NEWFC_ROOT="$ROOT" NEWFC_DATA_DIR="$DATA" NEWFC_PORT="$PORT" NEWFC_SERVICE="newfc-drill.service" \
  NEWFC_SYSTEMCTL="$DRILL/bin/systemctl" NEWFC_SKIP_INSTALL=1
DEPLOY="$ROOT/scripts/deploy.sh"; ROLLBACK="$ROOT/scripts/rollback.sh"
active() { "$DRILL/bin/systemctl" is-active; }
ready() { curl -fsS "http://127.0.0.1:$PORT/api/health/ready" >/dev/null 2>&1; }
dist_sum() { cat "$ROOT/backend/dist/index.js" "$ROOT/backend/dist/db/migrations-newfc.js" "$ROOT/frontend/dist/index.html" | sha256sum | cut -d' ' -f1; }
sql() { (cd "$ROOT/backend" && node -e 'const D=require("better-sqlite3");const d=new D(process.argv[1]);const r=d.prepare(process.argv[2]);console.log(JSON.stringify(r.reader?r.all():r.run()));d.close()' "$DATA/newfc.sqlite" "$1"); }
db_version() { sql 'SELECT MAX(version) AS v FROM schema_migration' | sed -E 's/.*"v":([0-9]+).*/\1/'; }
has_probe() { [[ "$(sql "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'drill_probe'")" == '[{"n":1}]' ]]; }
ready_with() { ready && [[ "$(dist_sum)" == "$1" ]]; }
calls_since() { tail -n +"$1" "$STATE/calls" 2>/dev/null | grep -c "^$2\$" || true; }
MIG="$ROOT/backend/src/db/migrations-newfc.ts"
cp "$MIG" "$DRILL/migrations-newfc.ts.orig"
add_migration() {  # $1 版本 $2 名称 $3 SQL
  python3 - "$MIG" "$1" "$2" "$3" <<'PY'
import sys
p, v, n, sql = sys.argv[1:]
s = open(p, encoding='utf8').read()
i = s.rstrip().rfind('];')
s = s[:i] + "  { version: %s, name: '%s', sql: `%s` },\n" % (v, n, sql) + s[i:]
open(p, 'w', encoding='utf8').write(s)
PY
}

step "1. 基线发布"
t=$(date +%s)
set +e; "$DEPLOY" --skip-tests >> "$LOG" 2>&1; rc=$?; set -e
check "基线发布成功(退出码 $rc,$(( $(date +%s) - t ))s)" test $rc -eq 0
check "服务就绪" ready
BASE_SUM=$(dist_sum); BASE_VER=$(db_version)
echo "  基线 schema V$BASE_VER" | tee -a "$LOG"

step "2. 构建失败:dist 不变、服务不停"
cp "$ROOT/backend/src/index.ts" "$DRILL/index.ts.orig"
echo "export const drillBroken: number = 'not-a-number';" >> "$ROOT/backend/src/index.ts"
n=$(( $(wc -l < "$STATE/calls") + 1 ))
set +e; "$DEPLOY" --skip-tests >> "$LOG" 2>&1; rc=$?; set -e
cp "$DRILL/index.ts.orig" "$ROOT/backend/src/index.ts"
check "发布失败(退出码 $rc)" test $rc -ne 0
check "dist 未变" test "$(dist_sum)" == "$BASE_SUM"
check "未停服" test "$(calls_since "$n" stop)" -eq 0
check "服务仍就绪" ready

step "3. 迁移失败:不替换产物、库版本不变"
NEXT=$((BASE_VER + 1))
add_migration "$NEXT" drill_broken "CREATE TABLE drill_probe (id INTEGER PRIMARY KEY); INSERT INTO drill_no_such_table VALUES (1);"
set +e; "$DEPLOY" --skip-tests >> "$LOG" 2>&1; rc=$?; set -e
check "发布失败(退出码 $rc)" test $rc -ne 0
check "dist 未变" test "$(dist_sum)" == "$BASE_SUM"
check "库版本仍为 V$BASE_VER" test "$(db_version)" == "$BASE_VER"
check "失败迁移的表已回滚" not has_probe
"$DRILL/bin/systemctl" start
for _ in $(seq 1 30); do ready && break; sleep 1; done
check "按手册启动旧版本后就绪" ready

step "4. schema 变化的发布成功,dist.old 保留上一版"
cp "$DRILL/migrations-newfc.ts.orig" "$MIG"
add_migration "$NEXT" drill_probe "CREATE TABLE drill_probe (id INTEGER PRIMARY KEY, note TEXT);"
t=$(date +%s)
set +e; "$DEPLOY" --skip-tests >> "$LOG" 2>&1; rc=$?; set -e
check "发布成功(退出码 $rc,$(( $(date +%s) - t ))s)" test $rc -eq 0
check "服务就绪" ready
check "库升级到 V$NEXT" test "$(db_version)" == "$NEXT"
check "dist.old 存在" test -d "$ROOT/backend/dist.old" -a -d "$ROOT/frontend/dist.old"
NEW_SUM=$(dist_sum)
PRE=$(ls -t "$DATA/backups"/pre-migrate*.sqlite | head -1)
check "迁移前备份存在: $(basename "$PRE")" test -f "$PRE"

step "5. 回退"
set +e; "$ROLLBACK" >> "$LOG" 2>&1; rc=$?; set -e
check "schema 高于旧代码时拒绝(退出码 $rc)" test $rc -eq 4
check "拒绝时未停服、产物未换" ready_with "$NEW_SUM"
sql "INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at) VALUES ('drill.write', 'drill', '1', '{}', '$(date -u +%FT%TZ)')" > /dev/null
set +e; "$ROLLBACK" --restore-backup "$(basename "$PRE")" >> "$LOG" 2>&1; rc=$?; set -e
check "备份后有写入且未确认时拒绝(退出码 $rc)" test $rc -eq 3
check "日志列出 drill.write" grep -q 'drill.write × 1' "$LOG"
check "拒绝后产物未换、服务恢复就绪" ready_with "$NEW_SUM"
t=$(date +%s)
set +e; "$ROLLBACK" --restore-backup "$(basename "$PRE")" --accept-data-loss >> "$LOG" 2>&1; rc=$?; set -e
check "确认后回退成功(退出码 $rc,$(( $(date +%s) - t ))s)" test $rc -eq 0
check "产物换回基线" test "$(dist_sum)" == "$BASE_SUM"
check "库回到 V$BASE_VER" test "$(db_version)" == "$BASE_VER"
check "新表已不存在" not has_probe
check "当前库已留 pre-rollback 备份" bash -c "ls '$DATA/backups'/pre-rollback*.sqlite >/dev/null 2>&1"
check "服务就绪" ready

echo | tee -a "$LOG"
echo "演练目录: $DRILL  总耗时: $(( $(date +%s) - T0 ))s  失败项: $FAILS" | tee -a "$LOG"
[[ $FAILS -eq 0 ]]
