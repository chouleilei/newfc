#!/usr/bin/env bash
set -euo pipefail

# 预算管理系统启动脚本(公网访问模式)
# .env 统一由 backend/src/env.ts 解析；本脚本不再用 shell 二次解释口令。
# 也可以通过外部环境变量传入:
#   export BUDGET_ACCESS_USER="..."
#   export BUDGET_ACCESS_PASSWORD="..."
#   ./start.sh

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_ENTRY="$DIR/backend/dist/index.js"
FRONTEND_ENTRY="$DIR/frontend/dist/index.html"

# 固定用系统 Node 20:node_modules 里的 better-sqlite3 按它编译,nvm 的其他版本会加载失败。
export PATH="/usr/bin:$PATH"

# 源码比产物新(或产物缺失)时自动构建,部署只需 git pull + 重启服务。
# 先构建到 dist.new,成功后整体替换;构建失败时保留旧产物继续启动(旧版本在线好过服务宕机,
# 且 systemd Restart=always 下直接退出会无限重启)。
build_if_stale() {
  local name="$1" dir="$2" entry="$3" cmd="$4"
  if [[ -f "$entry" ]] && ! find "$dir/src" "$dir/package.json" "$dir/package-lock.json" -type f -newer "$entry" -print -quit | grep -q .; then
    return 0
  fi
  echo "[start] ${name}产物缺失或过期,自动构建..."
  rm -rf "$dir/dist.new"
  if (cd "$dir" && eval "$cmd") && [[ -e "$dir/dist.new/$(basename "$entry")" ]]; then
    rm -rf "$dir/dist.old"
    [[ -d "$dir/dist" ]] && mv "$dir/dist" "$dir/dist.old"
    mv "$dir/dist.new" "$dir/dist"
    rm -rf "$dir/dist.old"
    echo "[start] ${name}构建完成"
  elif [[ -f "$entry" ]]; then
    rm -rf "$dir/dist.new"
    echo "[start] 警告: ${name}构建失败,继续使用旧产物启动。请修复后重启服务。" >&2
  else
    echo "错误: ${name}构建失败且没有可用产物,无法启动。" >&2
    exit 1
  fi
}
build_if_stale "后端" "$DIR/backend" "$BACKEND_ENTRY" "npx tsc --outDir dist.new --noEmitOnError"
build_if_stale "前端" "$DIR/frontend" "$FRONTEND_ENTRY" "npx tsc -b && npx vite build --outDir dist.new --emptyOutDir"

# 仅监听本机回环地址，公网访问统一经由 nginx 反向代理 (newbd.tangdalei.com)
export BUDGET_HOST="${BUDGET_HOST:-127.0.0.1}"
export BUDGET_PORT="${BUDGET_PORT:-3748}"
export BUDGET_DATA_DIR="${BUDGET_DATA_DIR:-$DIR/backend/data}"
# 当前部署为单层 nginx；其他拓扑可在环境中显式覆盖实际可信跳数。
# 注意:信任跳数必须等于真实代理层数——若改为绕过 nginx 直连部署(尤其 BUDGET_HOST=0.0.0.0),
# 必须显式设置 BUDGET_TRUST_PROXY=0,否则客户端可伪造 X-Forwarded-For 轮换 IP 绕过限流与登录锁定。
export BUDGET_TRUST_PROXY="${BUDGET_TRUST_PROXY:-1}"

cd "$DIR/backend"
exec node "$BACKEND_ENTRY"
