#!/usr/bin/env bash
# dsh 应用发布包装脚本
# 发布平台要求：监听 $PORT 环境变量 + 绑定 0.0.0.0
# 用法（由 publish.js 调用）：bash dsh-publish.sh

set -uo pipefail

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm use 24.20.0 >/dev/null 2>&1 || true

# 发布平台注入 PORT；本地调试回退 3080
APPPORT="${PORT:-3080}"
# dsh 启动时所在目录即默认文件系统位置
WORKSPACE="${DSH_PUBLISH_WORKSPACE:-/workspace}"

mkdir -p "$WORKSPACE"
cd "$WORKSPACE" || exit 1

# --trusted-host 让反代域名通过 /api 的 browser-trust 校验
exec dsh web --no-open --host 0.0.0.0 --port "$APPPORT"
