/**
 * dsh-mobile-polish —— 会话列表点击后自动收回侧栏（#5 修复）
 * ============================================================================
 *
 * 为什么需要这个补丁
 * ----------------------------------------------------------------------------
 * dsh-mobile 插件**本意**就支持这个行为，它在 mobile-layout.js:357 写了：
 *
 *   const closeDrawerAfterSessionAction = (event) => {
 *     if (viewportIsWide()) return;
 *     const row = event.target.closest("[role=\"treeitem\"][aria-selected]");
 *     ...
 *     props.controller.closeSidebar();
 *   };
 *   ... onClickCapture: closeDrawerAfterSessionAction
 *
 * 但这个 handler 挂在 `<aside className="dshm-drawer">` 上，而**该元素
 * 在当前 dsh 版本里从未被渲染**。实测：
 *
 *   document.querySelectorAll('.dshm-drawer').length  ===  0
 *
 * 侧栏实际由 dsh 原生组件渲染：
 *
 *   <div data-dsh-mobile-sidebar data-open="true|false">
 *     <div class="hHd-Xa_root" data-dsh-mobile-sidebar-root>   ← 宽 335 / 收起 20
 *       ...
 *       <div class="pI_x6G_sidebarCol" data-open="true|false"> ← 状态在这里
 *
 * 结论：handler 没绑上 → 点会话只切会话，侧栏不动。这就是 #5。
 *
 * 另一个关键发现（决定了本补丁的写法）
 * ----------------------------------------------------------------------------
 * 原生的「点遮罩关闭」是**好的**。实测点击 .dsh-native-mobile-backdrop 右缘：
 *
 *   点击前: {rootW: 335, hostOpen: "true"}
 *   点击后: {rootW:  20, hostOpen: "false"}     ← 正常关闭
 *
 * 所以关闭通路存在，只是「点会话行」这条捷径没人接。因此本补丁**不自己
 * 去改 React 状态**（那样容易和 React 打架），而是复用原生遮罩的点击效果。
 *
 * 实现策略
 * ----------------------------------------------------------------------------
 *   1. 捕获阶段监听 document 上的 click（capture=true）
 *   2. 判断目标是否落在「会话行」里 —— 用 role=treeitem + aria-selected，
 *      这与 dsh-mobile 原生判定保持一致
 *   3. 命中后用 **原生 backdrop 的 click()** 触发关闭（等价于用户点遮罩），
 *      而不是去点某个内部按钮（内部按钮的位置/存在性会随版本变）
 *   4. 兜底：若 backdrop 不存在或点了没反应，则直接操作 data-open="false"
 *
 * 为什么放在 capture 阶段
 * ----------------------------------------------------------------------------
 * 会话行是先被 React 处理再切换的；capture 阶段能保证我们在**行自己的
 * onClick 之前**先记录意图，避免两者竞争。实际收侧栏用 setTimeout(0)
 * 推迟到本次事件循环之后，让 React 先完成会话切换再收回侧栏 —— 否则可能
 * 出现「侧栏收了但会话没切」的观感。
 *
 * 安全性
 * ----------------------------------------------------------------------------
 * - 只读 DOM，不改任何 dsh 内部状态对象
 * - 全部包在 try/catch 里，任何异常都不会影响页面主流程
 * - 由 config.closeDrawerOnSessionPick 独立开关，关掉即回滚
 * ============================================================================
 */

/** 窄屏判定：与 dsh-mobile 的 viewportIsWide() 保持同一断点（600px）。 */
const WIDE_BREAKPOINT = 600;

export function buildDrawerAutocloseScript({ verbose = false } = {}) {
  // 注意：整段脚本必须自包含，不引用外部变量 —— 它会被投放到页面 <head>。
  return `(function () {
  'use strict';
  if (window.__dshmPolishDrawerPatched) return;
  window.__dshmPolishDrawerPatched = true;

  var VERBOSE = ${verbose ? 'true' : 'false'};
  var WIDE = ${WIDE_BREAKPOINT};
  var log = function () {
    if (VERBOSE && window.console) console.log.apply(console, ['[mobile-polish]'].concat([].slice.call(arguments)));
  };

  function viewportIsWide() {
    return window.innerWidth > WIDE;
  }

  function sidebarRoot() {
    return document.querySelector('[data-dsh-mobile-sidebar-root]');
  }

  /** 侧栏当前是否展开 —— 以原生 data-open 为准。 */
  function isSidebarOpen() {
    var host = document.querySelector('[data-dsh-mobile-sidebar]');
    if (host && host.getAttribute('data-open') === 'true') return true;
    var root = sidebarRoot();
    if (!root) return false;
    return root.getBoundingClientRect().width > 40;
  }

  function closeSidebar() {
    if (!isSidebarOpen()) { log('侧栏已收起，跳过'); return; }

    // 首选：点原生遮罩，走官方关闭通路（和用户手点遮罩完全等价）。
    var backdrop = document.querySelector('.dsh-native-mobile-backdrop');
    if (backdrop && !backdrop.hasAttribute('hidden')) {
      try {
        backdrop.click();
        log('已通过原生遮罩关闭侧栏');
        // 给 React 一帧时间；若没生效则走兜底。
        window.setTimeout(function () { if (isSidebarOpen()) fallbackClose(); }, 120);
        return;
      } catch (err) { log('backdrop.click() 抛错，转兜底:', err); }
    }
    fallbackClose();
  }

  /**
   * 兜底：直接改 data-open。
   * 这不是首选 —— 直接改 DOM 属性绕过 React，下次 React 重渲染可能被覆盖。
   * 但作为「遮罩不可用」时的降级手段，比什么都不做要好。
   */
  function fallbackClose() {
    var host = document.querySelector('[data-dsh-mobile-sidebar]');
    var col = document.querySelector('[class*="sidebarCol"]');
    var changed = false;
    if (host && host.getAttribute('data-open') === 'true') {
      host.setAttribute('data-open', 'false'); changed = true;
    }
    if (col && col.getAttribute('data-open') === 'true') {
      col.setAttribute('data-open', 'false'); changed = true;
    }
    log(changed ? '已通过 data-open 兜底收起' : '兜底未找到可改的节点');
  }

  document.addEventListener('click', function (event) {
    try {
      if (viewportIsWide()) return;
      if (!isSidebarOpen()) return;

      var target = event.target;
      if (!(target instanceof Element)) return;

      // 与 dsh-mobile 原生判定一致：会话行带 role=treeitem + aria-selected。
      var row = target.closest('[role="treeitem"][aria-selected]');
      if (row === null) return;

      // 行内的「操作按钮」（重命名/删除等）不应触发收回 —— 与原生同款规则：
      // 若命中了 row 内部的 button，且这个 button 不是 row 本身，则不收。
      var action = target.closest('button,[role="button"]');
      if (action !== null && action !== row) {
        log('命中行内按钮，不收侧栏');
        return;
      }

      log('命中会话行，准备收回侧栏:', (row.innerText || '').slice(0, 24));
      // 推迟到 React 完成会话切换之后再收，避免观感错位。
      window.setTimeout(closeSidebar, 0);
    } catch (err) {
      if (window.console) console.warn('[mobile-polish] 会话行收起处理异常:', err);
    }
  }, true);

  log('抽屉自动收回补丁已装载');
})();`;
}
