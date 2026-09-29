#!/usr/bin/env bash
# newfc 发布脚本:锁定依赖 → 测试 → 构建到 dist.new → 停服 → 备份+显式迁移 → 替换产物 → 启动 → 就绪检查。
# - 构建或测试失败时不触碰正在服务的 dist,也不停服。
# - 普通 systemctl restart 不会安装依赖或重新构建(ExecStart 直接运行 dist)。
# - 只操作本仓库目录与 NEWFC_DATA_DIR;不触碰 newbd/lishui。
#
# 用法: scripts/deploy.sh [--skip-tests] [--no-restart]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION="$(cat "$ROOT/.nvmrc")"
NODE_BIN="${NEWFC_NODE_BIN:-/root/.nvm/versions/node/v${NODE_VERSION}/bin}"
DATA_DIR="${NEWFC_DATA_DIR:-/data/newfc-data}"
SERVICE="newfc.service"
PORT="${NEWFC_PORT:-3760}"
SKIP_TESTS=0
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --no-restart) RESTART=0 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

export PATH="$NODE_BIN:$PATH"
actual="$(node -v)"
if [[ "$actual" != "v$NODE_VERSION" ]]; then
  echo "Node 版本不符: 需要 v$NODE_VERSION(.nvmrc),实际 $actual" >&2
  exit 1
fi
case "$DATA_DIR" in
  /data/newbd*|/root/newbd*|/root/lishui-finance-ai*) echo "拒绝:数据目录指向原项目 $DATA_DIR" >&2; exit 1 ;;
esac

# 仅在锁文件变化时重新安装,避免每次发布都替换运行中的 node_modules。
install_if_changed() {
  local dir="$1" stamp="$1/node_modules/.newfc-lock.sha256"
  local sum; sum="$(sha256sum "$dir/package-lock.json" | cut -d' ' -f1)"
  if [[ -f "$stamp" && "$(cat "$stamp")" == "$sum" ]]; then return 0; fi
  echo "[deploy] 安装锁定依赖: $dir"
  (cd "$dir" && npm ci --no-audit --no-fund)
  echo "$sum" > "$stamp"
}
install_if_changed "$ROOT/backend"
install_if_changed "$ROOT/frontend"

if [[ $SKIP_TESTS -eq 0 ]]; then
  echo "[deploy] 运行测试"
  (cd "$ROOT/backend" && npx tsc --noEmit && npx vitest run)
  (cd "$ROOT/frontend" && npx vitest run)
fi

echo "[deploy] 构建到 dist.new"
rm -rf "$ROOT/backend/dist.new" "$ROOT/frontend/dist.new"
(cd "$ROOT/backend" && npx tsc --outDir dist.new --noEmitOnError)
(cd "$ROOT/frontend" && npx tsc -b && npx vite build --outDir dist.new --emptyOutDir)
[[ -f "$ROOT/backend/dist.new/index.js" && -f "$ROOT/frontend/dist.new/index.html" ]] || { echo "构建产物不完整,中止" >&2; exit 1; }

if [[ $RESTART -eq 1 ]] && systemctl is-active --quiet "$SERVICE"; then
  echo "[deploy] 停止 $SERVICE"
  systemctl stop "$SERVICE"
fi

echo "[deploy] 迁移(先备份) $DATA_DIR"
if ! (cd "$ROOT/backend" && NEWFC_DATA_DIR="$DATA_DIR" node dist.new/db/migrate-cli.js); then
  echo "迁移失败:运行产物未替换。请按 docs/operations-runbook.md 从迁移前备份恢复后再启动旧版本。" >&2
  exit 1
fi

swap() {
  local dir="$1"
  rm -rf "$dir/dist.old"
  [[ -d "$dir/dist" ]] && mv "$dir/dist" "$dir/dist.old"
  mv "$dir/dist.new" "$dir/dist"
}
swap "$ROOT/backend"
swap "$ROOT/frontend"
echo "[deploy] 产物已替换(上一版保留在 dist.old,可用于代码回退)"

if [[ $RESTART -eq 1 ]]; then
  systemctl start "$SERVICE"
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health/ready" >/dev/null 2>&1; then
      echo "[deploy] 就绪检查通过"
      exit 0
    fi
    sleep 1
  done
  echo "[deploy] 30 秒内未就绪,请检查: journalctl -u $SERVICE -n 100" >&2
  exit 1
fi
