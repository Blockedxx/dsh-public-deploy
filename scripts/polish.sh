#!/usr/bin/env bash
# =============================================================================
# dsh-mobile-polish 部署 / 回滚脚本
# -----------------------------------------------------------------------------
# 用法：
#   ./polish.sh on      启用移动端排版优化
#   ./polish.sh off     关闭（保留文件，回到原生样式）
#   ./polish.sh status  查看当前状态
#   ./polish.sh revert  彻底回滚（摘除 bundle + 删除插件目录 + 恢复 profile 备份）
#   ./polish.sh backup  仅备份当前 profile package.json
#
# 可回滚设计：
#   - 修改 profile/package.json 前自动备份为 package.json.polish-backup-<时间戳>
#   - revert 会优先从最近的备份恢复，找不到备份则做「安全摘除」（只删本插件条目）
#   - 插件自身从不修改 dsh 源码，因此删除文件即等于完全还原
# =============================================================================
set -euo pipefail

# 脚本自身所在目录的上一级 = 仓库根（可移植，不依赖绝对路径）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

PROFILE_DIR="${DSH_PROFILE_DIR:-/root/.dsh/profiles/web}"
PLUGIN_NAME="dsh-mobile-polish"
SRC_DIR="${SCRIPT_DIR}/../plugins/mobile-polish"
DST_DIR="${PROFILE_DIR}/node_modules/${PLUGIN_NAME}"
PROFILE_PKG="${PROFILE_DIR}/package.json"
BACKUP_GLOB="${PROFILE_PKG}.polish-backup-*"

c_ok()   { printf '\033[32m%s\033[0m\n' "$*"; }
c_warn() { printf '\033[33m%s\033[0m\n' "$*"; }
c_err()  { printf '\033[31m%s\033[0m\n' "$*"; }

need_profile() {
  [ -f "$PROFILE_PKG" ] || { c_err "找不到 profile: $PROFILE_PKG"; exit 1; }
}

# 备份 profile/package.json。
# 关键：只有在「当前 profile 尚未注册本插件」时才值得备份 —— 否则备份出来的
# 仍然是一份「含本插件」的配置，revert 时恢复它等于没恢复。
do_backup() {
  need_profile
  if grep -q "\"${PLUGIN_NAME}\"" "$PROFILE_PKG" 2>/dev/null; then
    c_warn "profile 已含 ${PLUGIN_NAME}，跳过备份（避免备份出「已污染」的配置）"
    return 0
  fi
  local ts; ts=$(date +%Y%m%d-%H%M%S)
  cp -f "$PROFILE_PKG" "${PROFILE_PKG}.polish-backup-${ts}"
  c_ok "已备份 profile → package.json.polish-backup-${ts}"
}

# 找到第一份「不含本插件」的干净备份
find_clean_backup() {
  local f
  for f in $(ls -1t $BACKUP_GLOB 2>/dev/null); do
    if ! grep -q "\"${PLUGIN_NAME}\"" "$f" 2>/dev/null; then
      echo "$f"; return 0
    fi
  done
  return 1
}

sync_files() {
  [ -d "$SRC_DIR" ] || { c_err "找不到插件源码: $SRC_DIR"; exit 1; }
  mkdir -p "$DST_DIR/lib"
  cp -f "${SRC_DIR}/package.json"          "${DST_DIR}/package.json"
  cp -f "${SRC_DIR}/cordis.patch.yml"      "${DST_DIR}/cordis.patch.yml"
  # lib 下所有 .mjs / .css 全量同步 —— 新增文件（如 drawer-autoclose.mjs）
  # 若漏拷，index.mjs 会在 import 阶段直接抛错，导致 dsh 启动失败。
  local f
  for f in "${SRC_DIR}"/lib/*.mjs "${SRC_DIR}"/lib/*.css; do
    [ -e "$f" ] || continue
    cp -f "$f" "${DST_DIR}/lib/$(basename "$f")"
  done
  [ -f "${SRC_DIR}/README.md" ] && cp -f "${SRC_DIR}/README.md" "${DST_DIR}/README.md"
  c_ok "插件文件已同步 → ${DST_DIR}"
  ls -1 "$DST_DIR/lib" | sed 's/^/    · /'
}

# 幂等注册/摘除 bundle：只动本插件条目，保留其它配置不变
register_bundle() {
  node -e "
    const fs=require('fs');
    const p='${PROFILE_PKG}';
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    j.dsh=j.dsh||{}; j.dsh.profile=j.dsh.profile||{};
    const b=j.dsh.profile.bundles=j.dsh.profile.bundles||[];
    if(!b.includes('${PLUGIN_NAME}')) b.push('${PLUGIN_NAME}');
    j.dependencies=j.dependencies||{};
    j.dependencies['${PLUGIN_NAME}']='file:./node_modules/${PLUGIN_NAME}';
    fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
  "
  c_ok "bundle 已注册: ${PLUGIN_NAME}"
}

unregister_bundle() {
  node -e "
    const fs=require('fs');
    const p='${PROFILE_PKG}';
    const j=JSON.parse(fs.readFileSync(p,'utf8'));
    if(j.dsh&&j.dsh.profile&&Array.isArray(j.dsh.profile.bundles)){
      j.dsh.profile.bundles=j.dsh.profile.bundles.filter(x=>x!=='${PLUGIN_NAME}');
    }
    if(j.dependencies) delete j.dependencies['${PLUGIN_NAME}'];
    fs.writeFileSync(p, JSON.stringify(j,null,2)+'\n');
  "
  c_ok "bundle 已摘除: ${PLUGIN_NAME}"
}

set_enabled() {
  local val="$1"
  node -e "
    const fs=require('fs');
    const p='${DST_DIR}/cordis.patch.yml';
    if(!fs.existsSync(p)){ console.error('插件未部署'); process.exit(1); }
    let s=fs.readFileSync(p,'utf8');
    s=s.replace(/enabled:\s*(true|false)/, 'enabled: ${val}');
    fs.writeFileSync(p,s);
  "
  # 同步回工作区源码，保证 restart.sh 不会覆盖掉开关状态
  if [ -f "${SRC_DIR}/cordis.patch.yml" ]; then
    node -e "
      const fs=require('fs');
      const p='${SRC_DIR}/cordis.patch.yml';
      let s=fs.readFileSync(p,'utf8');
      s=s.replace(/enabled:\s*(true|false)/, 'enabled: ${val}');
      fs.writeFileSync(p,s);
    "
  fi
  c_ok "enabled → ${val}"
}

restart_service() {
  if [ -x "${SCRIPT_DIR}/restart.sh" ]; then
    c_warn "重启服务以生效 ..."
    (cd "${SCRIPT_DIR}" && ./restart.sh) || c_err "restart.sh 返回非零"
  else
    c_warn "未找到 restart.sh，请手动重启桥接服务"
  fi
}

case "${1:-status}" in
  on)
    need_profile; do_backup; sync_files; register_bundle; set_enabled true
    restart_service
    c_ok "✅ 已启用 dsh-mobile-polish"
    ;;
  off)
    if [ -f "${DST_DIR}/cordis.patch.yml" ]; then
      set_enabled false
    else
      c_warn "插件未部署，无需关闭"
    fi
    restart_service
    c_ok "⏸  已关闭 dsh-mobile-polish（文件保留）"
    ;;
  revert)
    need_profile
    c_warn "开始彻底回滚 ..."
    # 回滚顺序至关重要：必须先让 profile 不再引用本插件，最后才删文件。
    # 若先删文件，dsh 会因「声明了 bundle 但目录不存在」直接崩溃（exit=1）。
    latest=$(find_clean_backup || true)
    if [ -n "$latest" ]; then
      cp -f "$latest" "$PROFILE_PKG"
      c_ok "已从干净备份恢复 profile: $(basename "$latest")"
    else
      c_warn "未找到不含本插件的干净备份，改用安全摘除"
    fi
    # 无论是否恢复备份，都再执行一次幂等摘除，确保 profile 里绝不残留引用
    unregister_bundle
    rm -rf "$DST_DIR"
    c_ok "已删除插件目录: $DST_DIR"
    restart_service
    if grep -q "\"${PLUGIN_NAME}\"" "$PROFILE_PKG" 2>/dev/null; then
      c_err "⚠️  profile 中仍残留 ${PLUGIN_NAME} 引用，请手工检查 $PROFILE_PKG"
      exit 1
    fi
    c_ok "✅ 已彻底回滚，页面恢复 dsh 原生样式"
    ;;
  backup)
    do_backup
    ;;
  status)
    echo "── dsh-mobile-polish 状态 ──────────────────────"
    if [ -d "$DST_DIR" ]; then echo "  插件目录   : 已部署"; else echo "  插件目录   : 未部署"; fi
    if [ -f "${DST_DIR}/cordis.patch.yml" ]; then
      echo "  开关       : $(grep -oE 'enabled:\s*(true|false)' "${DST_DIR}/cordis.patch.yml" | head -1 | awk '{print $2}')"
    else
      echo "  开关       : -"
    fi
    echo "  断点       : $(grep -oE 'maxWidth:\s*[0-9]+' "${DST_DIR}/cordis.patch.yml" 2>/dev/null | head -1 | awk '{print $2}')px"
    echo "  环境覆盖   : DSH_MOBILE_POLISH=${DSH_MOBILE_POLISH:-<未设置>}"
    if grep -q "\"${PLUGIN_NAME}\"" "$PROFILE_PKG" 2>/dev/null; then
      if [ -d "$DST_DIR" ]; then
        echo "  bundle注册 : 是"
      else
        c_err "  bundle注册 : ⚠️  是（但插件目录不存在 → dsh 会启动失败！）"
      fi
    else
      echo "  bundle注册 : 否"
    fi
    clean_cnt=$(ls -1 $BACKUP_GLOB 2>/dev/null | while read -r f; do grep -q "\"${PLUGIN_NAME}\"" "$f" 2>/dev/null || echo x; done | wc -l)
    echo "  profile备份: $(ls -1 $BACKUP_GLOB 2>/dev/null | wc -l) 个（其中干净可用 ${clean_cnt} 个）"
    echo "────────────────────────────────────────────────"
    ;;
  *)
    echo "用法: $0 {on|off|revert|status|backup}"
    exit 1
    ;;
esac
