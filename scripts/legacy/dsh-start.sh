#!/usr/bin/env bash
# DeepSeek Harness (dsh) 启动脚本
# 用法: ./dsh-start.sh [端口] [工作区目录]
# 说明: dsh 每次启动会随机生成访问 token，本脚本自动提取并打印带 token 的完整 URL。

set -euo pipefail

PORT="${1:-3080}"
WORKSPACE="${2:-/workspace/dsh-workspace}"
LOG="/tmp/dsh-web.log"

# Node 24.20.0 是 dsh 的运行要求 (>=22.19.0，且需要 import.meta.main 支持)
export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm use 24.20.0 >/dev/null

if ! command -v dsh >/dev/null 2>&1; then
  echo "错误: 未找到 dsh 命令。请先执行: npm install -g @deepseek-ai/dsh" >&2
  exit 1
fi

mkdir -p "$WORKSPACE"

# 若端口已被占用，先报告
if ss -lnt 2>/dev/null | grep -q ":${PORT} "; then
  echo "端口 ${PORT} 已被占用，请换个端口或先停止旧进程。"
  echo "当前占用: $(ss -lntp 2>/dev/null | grep ":${PORT} " || true)"
  exit 1
fi

echo "正在启动 DeepSeek Harness (端口 ${PORT}) ..."
cd "$WORKSPACE"
nohup dsh web --no-open --port "$PORT" >"$LOG" 2>&1 &
DSH_PID=$!

# 等待服务就绪并抓取 token URL
URL=""
for _ in $(seq 1 40); do
  sleep 0.5
  URL="$(grep -oE 'http://[^[:space:]]+token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | head -1 || true)"
  [ -n "$URL" ] && break
done

if [ -z "$URL" ]; then
  echo "启动失败，日志如下：" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

echo
echo "DeepSeek Harness 已启动"
echo "  PID      : ${DSH_PID}"
echo "  工作区   : ${WORKSPACE}"
echo "  日志     : ${LOG}"
echo "  访问地址 : ${URL}"
echo
echo "  注意: 该 URL 含一次性认证 token，首次打开后浏览器会置入 session cookie；"
echo "        之后直接访问 http://127.0.0.1:${PORT}/ 即可。"
echo "  停止服务: kill ${DSH_PID}"
