#!/usr/bin/env bash
# DeepSeek Harness 公网服务：重启脚本
# 用途：手动重启桥接进程（平台自启动失败、或需要重新生成 token 时使用）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BRIDGE="${SCRIPT_DIR}/dsh-public-bridge.js"
PUBLIC_PORT="${DSH_PUBLIC_PORT:-3000}"
DSH_PORT="${DSH_INNER_PORT:-13080}"

PROFILE="${DSH_PROFILE_DIR:-/root/.dsh/profiles/web}"
PLUGIN_SRC="${SCRIPT_DIR}/../plugins/local-loopback-trust"
PLUGIN_DST="$PROFILE/node_modules/dsh-local-loopback-trust"

# ── 公网域名解析（三级优先级）────────────────────────────────────────────
#   1. 已 export 的 DSH_PUBLIC_HOST（最高优先级）
#   2. 仓库根目录的 .env.public（持久化，推荐）
#   3. 桥接进程之前运行时学习并落盘的 .known-hosts.json（最后兜底）
# 这样 `polish.sh on/off/revert` 触发的重启也能带上正确的公网域名，
# 不会退化成 http://127.0.0.1:13080/?token=... 这种本地链接。
ENV_FILE="${DSH_ENV_FILE:-${REPO_ROOT}/.env.public}"
if [ -z "${DSH_PUBLIC_HOST:-}" ] && [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
fi
if [ -z "${DSH_PUBLIC_HOST:-}" ] && [ -f "${REPO_ROOT}/.known-hosts.json" ]; then
  DSH_PUBLIC_HOST="$(node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const hosts = Array.isArray(d) ? d : (d.hosts || []);
      const pick = hosts.find((h) => /app\.workbuddy\.host$/.test(h)) || hosts[0];
      if (pick) process.stdout.write(String(pick));
    } catch {}
  ' "${REPO_ROOT}/.known-hosts.json" 2>/dev/null || true)"
fi
export DSH_PUBLIC_HOST="${DSH_PUBLIC_HOST:-}"
if [ -n "$DSH_PUBLIC_HOST" ]; then
  echo "==> 公网域名：$DSH_PUBLIC_HOST"
else
  echo "==> 公网域名：未设置（将退化为本地链接）"
  echo "    设置方式：echo 'DSH_PUBLIC_HOST=你的域名' > ${ENV_FILE}"
fi

echo "==> 同步 local-loopback-trust 插件到 profile"
if [ -d "$PLUGIN_SRC" ]; then
  mkdir -p "$PLUGIN_DST/lib"
  cp -f "$PLUGIN_SRC/package.json"      "$PLUGIN_DST/package.json"
  cp -f "$PLUGIN_SRC/cordis.patch.yml"  "$PLUGIN_DST/cordis.patch.yml"
  cp -f "$PLUGIN_SRC/README.md"         "$PLUGIN_DST/README.md"
  cp -f "$PLUGIN_SRC/lib/index.mjs"     "$PLUGIN_DST/lib/index.mjs"
  echo "    已同步到 $PLUGIN_DST"

  # 确保 profile manifest 把插件注册为 bundle 层（幂等）
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    m.dependencies ??= {};
    m.dsh ??= { profile: {} };
    m.dsh.profile ??= {};
    m.dsh.profile.bundles ??= [];
    const NAME = "dsh-local-loopback-trust";
    m.dependencies[NAME] = "file:./node_modules/dsh-local-loopback-trust";
    if (!m.dsh.profile.bundles.includes(NAME)) m.dsh.profile.bundles.push(NAME);
    m.dsh.profile.patchReload ??= "live";
    fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
    console.log("    profile bundles:", m.dsh.profile.bundles.join(", "));
  ' "$PROFILE/package.json"
else
  echo "    ⚠️  未找到 $PLUGIN_SRC，跳过（Settings 在公网域名下将不可用）"
fi

# ── 同步 mobile-polish（仅在已部署时）────────────────────────────────────
# ⚠️ 实测踩坑：polish.sh 用通配符同步 lib/*.mjs 与 lib/*.css，逻辑本身正确；
#    但 restart.sh 原先**只同步 local-loopback-trust**，不同步 mobile-polish。
#    结果：新增源文件（如 drawer-autoclose.mjs）之后若只跑 restart.sh，
#    profile 里的旧副本会一直缺该文件，而 index.mjs 在 import 阶段就抛
#    ERR_MODULE_NOT_FOUND，dsh 直接退出 code=1 —— 表现为「服务起不来」。
#    典型触发场景：沙箱重启后服务全停，此时跑 restart.sh 无法自愈。
# 因此这里补齐：只要 profile 里已部署该插件，就顺手全量同步一次（幂等）。
POLISH_SRC="${SCRIPT_DIR}/../plugins/mobile-polish"
POLISH_DST="$PROFILE/node_modules/dsh-mobile-polish"
if [ -d "$POLISH_SRC" ] && [ -d "$POLISH_DST" ]; then
  mkdir -p "$POLISH_DST/lib"
  cp -f "${POLISH_SRC}/package.json"       "${POLISH_DST}/package.json"       2>/dev/null || true
  cp -f "${POLISH_SRC}/cordis.patch.yml"   "${POLISH_DST}/cordis.patch.yml"   2>/dev/null || true
  [ -f "${POLISH_SRC}/README.md" ] && cp -f "${POLISH_SRC}/README.md" "${POLISH_DST}/README.md"
  for f in "${POLISH_SRC}"/lib/*.mjs "${POLISH_SRC}"/lib/*.css; do
    [ -e "$f" ] || continue
    cp -f "$f" "${POLISH_DST}/lib/$(basename "$f")"
  done
  echo "==> 同步 mobile-polish 插件文件"
  ls -1 "$POLISH_DST/lib" | sed 's/^/    · /'
elif [ -d "$POLISH_SRC" ] && [ ! -d "$POLISH_DST" ]; then
  echo "==> mobile-polish 未部署（如需启用：./scripts/polish.sh on）"
fi

echo "==> 停止现有服务"
for port in "$PUBLIC_PORT" "$DSH_PORT"; do
  pids="$(ss -lntp 2>/dev/null | grep ":${port} " | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)"
  for pid in $pids; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
done
sleep 2

echo "==> 启动桥接进程"
DSH_PUBLIC_PORT="$PUBLIC_PORT" DSH_INNER_PORT="$DSH_PORT" DSH_PUBLIC_HOST="$DSH_PUBLIC_HOST" \
  setsid nohup node "$BRIDGE" >> /tmp/dsh-bridge.out 2>&1 < /dev/null &

echo "==> 等待就绪（约 15 秒）"
for _ in $(seq 1 15); do
  sleep 1
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:${PUBLIC_PORT}/" || echo 000)"
  if [ "$code" != "000" ]; then
    echo "    本地 ${PUBLIC_PORT} 已响应：HTTP ${code}"
    break
  fi
done

echo "==> 验证 __DSH_TRANSPORT__ 注入是否生效"
CK="$(mktemp)"
ok=0; token=""
# dsh 子进程启动约需 20s，且 token 由 dsh 启动后写入。
# 因此每轮都重新读取 token 文件，避免用上一轮的过期 token 去验证。
for _ in $(seq 1 45); do
  sleep 1
  token="$(grep -oE 'token=[A-Za-z0-9_-]+' ${DSH_ACCESS_URL_FILE:-/workspace/dsh-公网访问地址.txt} 2>/dev/null | head -1 | cut -d= -f2 || true)"
  [ -z "$token" ] && continue
  curl -s "http://127.0.0.1:${DSH_PORT}/?token=${token}" -c "$CK" -o /dev/null 2>/dev/null || true
  if curl -s -b "$CK" "http://127.0.0.1:${DSH_PORT}/" 2>/dev/null | grep -q '__DSH_TRANSPORT__'; then
    ok=1
    break
  fi
done
rm -f "$CK"
if [ "$ok" = "1" ]; then
  echo "    ✅ 已注入 globalThis.__DSH_TRANSPORT__（Settings 在公网域名下可用）"
else
  echo "    ❌ 未检测到注入！请检查 profile bundles 与插件是否加载"
fi

echo "==> 完成。访问地址见 ${DSH_ACCESS_URL_FILE:-/workspace/dsh-公网访问地址.txt}"
tail -6 /tmp/dsh-bridge.out 2>/dev/null || true
