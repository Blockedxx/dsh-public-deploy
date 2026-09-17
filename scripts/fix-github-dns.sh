#!/usr/bin/env bash
# ============================================================================
# fix-github-dns.sh —— 沙箱内 GitHub 连接修复
#
# 问题：沙箱 DNS 对 GitHub 全域名段做透明劫持，全部解析到 198.18.x.x
#       （RFC 2544 基准测试保留段，非真实地址），导致：
#         · git clone / git push 失败
#         · gh auth status 误报 "The token in GH_TOKEN is invalid"
#         · curl https://api.github.com 超时（000）
#       注意：token 本身是好的，是网络不可达被 gh 误报成认证失败。
#
# 解法：/etc/hosts 写死真实 IP，绕过被劫持的 DNS。
#       依赖 nsswitch.conf 的 `hosts: files dns`（files 优先于 dns）。
#
# 用法：
#   ./fix-github-dns.sh          # 应用修复
#   ./fix-github-dns.sh check    # 只检查当前状态
#   ./fix-github-dns.sh revert   # 移除修复
# ============================================================================
set -uo pipefail

MARKER_BEGIN="# >>> fix-github-dns >>>"
MARKER_END="# <<< fix-github-dns <<<"
HOSTS_FILE="${HOSTS_FILE:-/etc/hosts}"

# GitHub 真实 IP。这些地址相对稳定，但若某天失效，
# 可用 `check` 子命令确认，再替换成可达的地址。
#   140.82.x.x  = GitHub 主站/API（美区）
#   185.199.x.x = GitHub Pages / raw 内容 CDN
GITHUB_ENTRIES=(
  "140.82.121.6   api.github.com"
  "140.82.121.6   codeload.github.com"
  "140.82.121.3   github.com"
  "140.82.121.3   www.github.com"
  "140.82.121.3   gist.github.com"
  "185.199.108.133 raw.githubusercontent.com"
  "185.199.108.133 objects.githubusercontent.com"
  "185.199.108.133 avatars.githubusercontent.com"
)

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_info() { printf '\033[36m%s\033[0m\n' "$*"; }

strip_block() {
  # 删除标记块（含标记行本身）
  python3 - "$HOSTS_FILE" "$MARKER_BEGIN" "$MARKER_END" <<'PY'
import sys
path, begin, end = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    lines = open(path, encoding='utf-8').read().splitlines()
except FileNotFoundError:
    sys.exit(0)
out, inside = [], False
for ln in lines:
    if ln.strip() == begin:
        inside = True
        continue
    if ln.strip() == end:
        inside = False
        continue
    if not inside:
        out.append(ln)
# 顺带清掉之前手工加的无标记 GitHub 行，避免与标记块重复
out = [ln for ln in out
       if not (ln.split() and ln.split()[0].startswith(('140.82.', '185.199.')))]
open(path, 'w', encoding='utf-8').write('\n'.join(out).rstrip('\n') + '\n')
PY
}

apply_fix() {
  c_info "==> 应用 GitHub DNS 修复"
  strip_block
  {
    echo "$MARKER_BEGIN"
    echo "# 绕过沙箱 DNS 劫持（198.18.x.x 虚假 IP）。移除请执行 fix-github-dns.sh revert"
    for e in "${GITHUB_ENTRIES[@]}"; do echo "$e"; done
    echo "$MARKER_END"
  } >> "$HOSTS_FILE"
  c_ok "    已写入 ${#GITHUB_ENTRIES[@]} 条记录到 $HOSTS_FILE"

  # git 的 TLS 栈比 curl 敏感：即使 hosts 已正确，
  # 不加 http.version=HTTP/1.1 仍会 GnuTLS 握手失败。
  # 顺手固化到全局配置（幂等）。
  git config --global http.version HTTP/1.1 2>/dev/null \
    && c_ok "    已设置 git http.version=HTTP/1.1"
  git config --global http.postBuffer 524288000 2>/dev/null \
    && c_ok "    已设置 git http.postBuffer=524288000"
  echo
  check_status
}

revert_fix() {
  c_info "==> 移除 GitHub DNS 修复"
  strip_block
  c_ok "    已移除标记块"
}

check_status() {
  c_info "── 解析状态 ────────────────────────────────"
  local all_ok=1
  for d in github.com api.github.com raw.githubusercontent.com; do
    local ip
    ip="$(getent hosts "$d" 2>/dev/null | awk '{print $1}' | head -1)"
    if [ -z "$ip" ]; then
      c_err "    $d -> (无解析)"; all_ok=0
    elif [[ "$ip" == 198.18.* ]]; then
      c_err "    $d -> $ip  ❌ 仍是被劫持的虚假 IP"; all_ok=0
    else
      c_ok  "    $d -> $ip"
    fi
  done
  echo
  c_info "── 连通性 ──────────────────────────────────"
  for u in https://github.com/ https://api.github.com/; do
    local code
    code="$(timeout 10 curl -s -o /dev/null -w '%{http_code}' "$u" 2>/dev/null || echo 000)"
    if [ "$code" = "200" ]; then c_ok "    $u -> $code"
    else c_err "    $u -> $code"; all_ok=0; fi
  done
  echo
  if [ "$all_ok" = "1" ]; then
    c_ok "✅ GitHub 连接正常"
  else
    c_warn "⚠️  GitHub 连接异常。排查建议："
    echo "     1. 换一个真实 IP：curl -s --resolve github.com:443:<IP> -o /dev/null -w '%{http_code}\\n' https://github.com/"
    echo "        候选：140.82.121.3 / 140.82.112.3 / 140.82.116.3 / 20.205.243.166"
    echo "     2. 修改本脚本 GITHUB_ENTRIES 后重新执行"
  fi
}

case "${1:-apply}" in
  apply|"") apply_fix ;;
  check)    check_status ;;
  revert)   revert_fix ;;
  *) echo "用法: $0 [apply|check|revert]"; exit 1 ;;
esac
