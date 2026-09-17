#!/usr/bin/env bash
#
# whereami.sh —— 告诉你这个沙箱的公网域名是什么
#
# 用法：
#   ./scripts/whereami.sh              # 列出所有可用域名
#   ./scripts/whereami.sh --write      # 把推荐的域名写进 .env.public
#   ./scripts/whereami.sh --port 3000  # 指定端口（默认 3000）
#
# 域名来源（按优先级）：
#   ① 发布接口分配：<appName>.app.workbuddy.host
#      读 /root/.workbuddy-sandbox-publish/state.json
#   ② 端口网关：<port>-${X_IDE_SPACE_KEY}.e2b.${X_IDE_SPACE_REGION}.sandbox.cloudstudio.club
#      环境变量直接拼，不依赖任何发布动作
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PORT="${DSH_PUBLIC_PORT:-3000}"
WRITE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --write) WRITE=1; shift ;;
    --port)  PORT="${2:-3000}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 1 ;;
  esac
done

c_ok()   { printf '\033[32m%s\033[0m\n' "$1"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$1"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$1"; }
c_dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

echo "────────────────────────────────────────────────"
echo " 沙箱公网域名"
echo "────────────────────────────────────────────────"

FRIENDLY=""
UUID=""
GATEWAY=""

# ── ① 发布状态文件 ─────────────────────────────────────────
STATE_FILE="/root/.workbuddy-sandbox-publish/state.json"
if [ -f "$STATE_FILE" ]; then
  APPNAME="$(python3 -c "import json;print(json.load(open('$STATE_FILE')).get('appName',''))" 2>/dev/null || true)"
  RUNTIMEID="$(python3 -c "import json;print(json.load(open('$STATE_FILE')).get('runtimeId',''))" 2>/dev/null || true)"

  [ -n "$APPNAME" ]   && FRIENDLY="${APPNAME}.app.workbuddy.host"
  [ -n "$RUNTIMEID" ] && UUID="${RUNTIMEID}.app.workbuddy.host"
else
  c_warn "  ⚠ 未找到发布状态文件：$STATE_FILE"
  c_dim  "    （说明本沙箱还没执行过「发布」动作，主入口域名不存在）"
fi

# ── ② 端口网关（环境变量拼） ───────────────────────────────
if [ -n "${X_IDE_SPACE_KEY:-}" ] && [ -n "${X_IDE_SPACE_REGION:-}" ]; then
  GATEWAY="${PORT}-${X_IDE_SPACE_KEY}.e2b.${X_IDE_SPACE_REGION}.sandbox.cloudstudio.club"
else
  c_warn "  ⚠ 缺少 X_IDE_SPACE_KEY / X_IDE_SPACE_REGION，拼不出端口网关域名"
fi

# ── 连通性探测 ────────────────────────────────────────────
probe() {
  local host="$1"
  [ -z "$host" ] && return
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${host}/" 2>/dev/null || echo '000')"
  local mark
  case "$code" in
    401) mark="$(c_ok '✅ 通（服务在线，返回鉴权门）')" ;;
    200) mark="$(c_ok '✅ 通（服务在线）')" ;;
    000) mark="$(c_err '❌ 不可达')" ;;
    *)   mark="$(c_warn "⚠ 返回 ${code}（域名存在，但该端口/路由可能没服务）")" ;;
  esac
  printf '  %-72s %s\n' "https://${host}/" "$mark"
}

if [ -n "$FRIENDLY" ] || [ -n "$UUID" ] || [ -n "$GATEWAY" ]; then
  echo
  echo "【① 主入口域名】发布接口分配，长期有效"
  [ -n "$FRIENDLY" ] && probe "$FRIENDLY"
  [ -n "$UUID" ]     && probe "$UUID"
  [ -z "$FRIENDLY" ] && [ -z "$UUID" ] && c_dim "  （无）"

  echo
  echo "【② 端口网关域名】${PORT} 端口，环境变量拼出"
  [ -n "$GATEWAY" ] && probe "$GATEWAY"
  [ -z "$GATEWAY" ] && c_dim "  （无）"
fi

# ── 推荐 ─────────────────────────────────────────────────
RECOMMEND=""
if [ -n "$FRIENDLY" ]; then
  RECOMMEND="$FRIENDLY"
elif [ -n "$GATEWAY" ]; then
  RECOMMEND="$GATEWAY"
fi

echo
echo "────────────────────────────────────────────────"
if [ -n "$RECOMMEND" ]; then
  echo " 推荐使用："
  echo "   https://${RECOMMEND}/"
  echo
  c_dim " 完整访问链接（首次打开换取 Cookie）见 /workspace/dsh-公网访问地址.txt"
else
  c_err " 没有可用的公网域名。"
  echo " 可能原因："
  echo "   · 沙箱未执行发布动作（没有 state.json）"
  echo "   · 缺少 X_IDE_SPACE_KEY / X_IDE_SPACE_REGION 环境变量"
fi
echo "────────────────────────────────────────────────"

# ── 写入配置 ─────────────────────────────────────────────
if [ "$WRITE" = "1" ]; then
  if [ -z "$RECOMMEND" ]; then
    c_err "无可写域名，跳过。"
    exit 1
  fi
  ENV_FILE="${REPO_ROOT}/.env.public"
  TMP="$(mktemp)"
  # 保留其他已有的配置项，只覆盖 DSH_PUBLIC_HOST
  if [ -f "$ENV_FILE" ]; then
    grep -v '^[[:space:]]*DSH_PUBLIC_HOST=' "$ENV_FILE" > "$TMP" 2>/dev/null || true
  fi
  echo "DSH_PUBLIC_HOST=${RECOMMEND}" >> "$TMP"
  mv "$TMP" "$ENV_FILE"
  echo
  c_ok "✅ 已写入 ${ENV_FILE}："
  echo "   DSH_PUBLIC_HOST=${RECOMMEND}"
  echo
  c_dim " 下一步：./scripts/restart.sh"
fi
