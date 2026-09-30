#!/usr/bin/env bash
# newfc 代码回退:把 dist.old(上一次发布前的产物)换回 dist 并重启。
# - 仅当 backend/frontend 的 dist.old 都存在时执行。
# - 当前库 schema 高于旧代码支持的版本时拒绝,提示从 pre-migrate 备份恢复(--restore-backup)。
# - 恢复会丢弃备份之后的写入:先列出(审计日志),须 --accept-data-loss 显式确认;当前库先备份为 pre-rollback。
# - 再次执行会换回新版本(dist 与 dist.old 互换)。
# 环境覆盖同 deploy.sh:NEWFC_ROOT、NEWFC_DATA_DIR、NEWFC_SERVICE、NEWFC_SYSTEMCTL、NEWFC_PORT。
#
# 用法: scripts/rollback.sh [--restore-backup <备份文件名>] [--accept-data-loss] [--no-restart]
set -euo pipefail

ROOT="${NEWFC_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
NODE_VERSION="$(cat "$ROOT/.nvmrc")"
NODE_BIN="${NEWFC_NODE_BIN:-/root/.nvm/versions/node/v${NODE_VERSION}/bin}"
DATA_DIR="${NEWFC_DATA_DIR:-/data/newfc-data}"
SERVICE="${NEWFC_SERVICE:-newfc.service}"
SYSTEMCTL="${NEWFC_SYSTEMCTL:-systemctl}"
PORT="${NEWFC_PORT:-3760}"
RESTORE_BACKUP=""
ACCEPT=()
RESTART=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restore-backup) RESTORE_BACKUP="${2:-}"; [[ -n "$RESTORE_BACKUP" ]] || { echo "--restore-backup 需要备份文件名" >&2; exit 2; }; shift ;;
    --accept-data-loss) ACCEPT=(--accept-data-loss) ;;
    --no-restart) RESTART=0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

export PATH="$NODE_BIN:$PATH"
case "$DATA_DIR" in
  /data/newbd*|/root/newbd*|/root/lishui-finance-ai*) echo "拒绝:数据目录指向原项目 $DATA_DIR" >&2; exit 1 ;;
esac
for d in backend frontend; do
  [[ -d "$ROOT/$d/dist.old" ]] || { echo "没有可回退的产物: $ROOT/$d/dist.old 不存在" >&2; exit 1; }
done
CLI="$ROOT/backend/dist/modules/backup/rollback-cli.js"
[[ -f "$CLI" ]] || { echo "当前产物缺少 $CLI" >&2; exit 1; }
DB="$DATA_DIR/newfc.sqlite"

start_and_wait() {
  [[ $RESTART -eq 1 ]] || return 0
  "$SYSTEMCTL" start "$SERVICE"
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health/ready" >/dev/null 2>&1; then
      echo "[rollback] 就绪检查通过"
      return 0
    fi
    sleep 1
  done
  echo "[rollback] 30 秒内未就绪,请检查服务日志" >&2
  return 1
}

# 1. schema 兼容性(服务运行中只读检查;不兼容且未指定备份时不停服直接拒绝)
if [[ -f "$DB" && -z "$RESTORE_BACKUP" ]]; then
  set +e
  (cd "$ROOT/backend" && node "$CLI" inspect --data-dir "$DATA_DIR" --old-dist dist.old)
  rc=$?
  set -e
  if [[ $rc -eq 4 ]]; then
    echo "拒绝回退:当前库 schema 高于旧代码支持的版本。请从上面列出的 pre-migrate 备份恢复:" >&2
    echo "  scripts/rollback.sh --restore-backup <pre-migrate-...sqlite>" >&2
    exit 4
  elif [[ $rc -ne 0 ]]; then
    exit "$rc"
  fi
fi

# 2. 停服
was_active=0
if "$SYSTEMCTL" is-active --quiet "$SERVICE"; then
  was_active=1
  echo "[rollback] 停止 $SERVICE"
  "$SYSTEMCTL" stop "$SERVICE"
fi

# 3. 需要时恢复迁移前备份(不迁移,保持旧 schema)
if [[ -n "$RESTORE_BACKUP" ]]; then
  set +e
  (cd "$ROOT/backend" && node "$CLI" restore --data-dir "$DATA_DIR" --old-dist dist.old --backup "$RESTORE_BACKUP" "${ACCEPT[@]}")
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    echo "[rollback] 未恢复数据,产物未交换" >&2
    if [[ $was_active -eq 1 ]]; then start_and_wait || true; fi
    exit "$rc"
  fi
fi

# 4. 交换产物
for d in backend frontend; do
  mv "$ROOT/$d/dist" "$ROOT/$d/dist.rollback-tmp"
  mv "$ROOT/$d/dist.old" "$ROOT/$d/dist"
  mv "$ROOT/$d/dist.rollback-tmp" "$ROOT/$d/dist.old"
done
echo "[rollback] 产物已换回上一版(被回退的版本保留在 dist.old)"
start_and_wait
