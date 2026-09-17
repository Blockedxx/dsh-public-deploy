#!/usr/bin/env bash
# dsh 公网发布启动脚本（动态端口版）
#
# 链路：公网 HTTPS -> CLB(TLS) -> CloudStudio Gateway/sandbox-proxy
#        -> 0.0.0.0:$PORT -> 127.0.0.1:$DSH_PORT (dsh)
#
# 端口策略：
#   - 对外端口取平台注入的 $PORT；若被占用则向上退避找空闲端口。
#   - dsh 端口固定 13080（非标准，避开平台基础设施端口）。
#   - 先起 bridge 并立即打印就绪关键词（发布脚本探测窗口仅约 5s）。

set -o pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm use 24.20.0 >/dev/null 2>&1 || true

LOG=/tmp/dsh-serve.log
exec > >(tee -a "$LOG") 2>&1

PUBLIC_HOST="${DSH_PUBLIC_HOST:-<YOUR-SANDBOX-ID>.app.workbuddy.host}"
WORKSPACE="${DSH_WORKSPACE:-/workspace}"
DSH_PORT="${DSH_PORT:-13080}"

[ -z "$PUBLIC_HOST" ] && PUBLIC_HOST="<YOUR-SANDBOX-ID>.app.workbuddy.host"
[ -z "$DSH_PORT" ] && DSH_PORT=13080

# 平台占用的基础设施端口，绝不使用
RESERVED="8089 49983 52025 65310 65210 65213 65216 65225 9090 39099 18601 43501 45707"

port_free() {
  local p="$1"
  for r in $RESERVED; do [ "$p" = "$r" ] && return 1; done
  ss -lnt 2>/dev/null | grep -q ":${p} " && return 1
  return 0
}

# 对外端口：必须与 publish.js 的 --port 完全一致。
#
# 平台网关按「域名里的端口号」路由到本机同号端口：
#   实测响应头 Host = 3000-<SPACE_KEY>.e2b.bj7.sandbox.cloudstudio.club
# 即 <port>-<spaceKey>.e2b.<region>.sandbox.cloudstudio.club
# 因此服务监听端口 == 发布端口，否则网关 404。
#
# 注意：自启动阶段平台会注入 PORT=8089（已被 sync_server 占用），
# 该值不可采信，必须显式指定。
PUBLIC_PORT="${DSH_PUBLIC_PORT:-3000}"

if ! port_free "$PUBLIC_PORT"; then
  echo "port ${PUBLIC_PORT} is occupied:" >&2
  ss -lntp 2>/dev/null | grep ":${PUBLIC_PORT} " >&2
  exit 1
fi
PORT_FINAL="$PUBLIC_PORT"
echo "chosen public port: $PORT_FINAL (platform PORT=${PORT:-unset}, ignored)"

# ---- 1) 先起 bridge：即刻监听并打印就绪关键词 ----
PORT="$PORT_FINAL" DSH_PORT="$DSH_PORT" DSH_PUBLIC_HOST="$PUBLIC_HOST" \
  node /workspace/dsh-bridge.js &
BRIDGE_PID=$!

for _ in $(seq 1 20); do
  sleep 0.5
  kill -0 "$BRIDGE_PID" 2>/dev/null || break
  if ss -lnt 2>/dev/null | grep -q ":${PORT_FINAL} "; then
    echo "serving http on 0.0.0.0:${PORT_FINAL}"
    echo "listening on https://${PUBLIC_HOST}/"
    break
  fi
done

# ---- 2) 再起 dsh ----
cd "$WORKSPACE" || exit 1
dsh web --no-open --port "$DSH_PORT" --trusted-host "$PUBLIC_HOST" &
DSH_PID=$!
echo "dsh pid=$DSH_PID (127.0.0.1:${DSH_PORT})"

for _ in $(seq 1 60); do
  sleep 1
  kill -0 "$DSH_PID" 2>/dev/null || break
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:${DSH_PORT}/" 2>/dev/null)
  if [ -n "$code" ] && [ "$code" != "000" ]; then
    echo "dsh ready (HTTP $code)"
    break
  fi
done

# ---- 3) 保活 ----
while true; do
  sleep 5
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    echo "dsh exited"; kill "$BRIDGE_PID" 2>/dev/null; exit 1
  fi
  if ! kill -0 "$BRIDGE_PID" 2>/dev/null; then
    echo "bridge exited"; kill "$DSH_PID" 2>/dev/null; exit 1
  fi
done
