/**
 * dsh-mobile-polish —— 「Open configuration file」按钮重定向
 * ============================================================================
 *
 * 问题
 * ----------------------------------------------------------------------------
 * dsh 的 Settings → General 里有一个「Open configuration file」按钮。
 * 它调用服务端接口 `settings/openSettingsDocument`，服务端再执行：
 *
 *   xdg-open /root/.dsh/profiles/web/cordis.patch.yml
 *
 * 在沙箱里这必然失败，有两个原因叠加：
 *   1. 没有桌面环境 —— xdg-open 依次尝试 chromium / firefox / iceweasel，
 *      实测报 "Running as root without --no-sandbox" 和 "firefox: not found"；
 *   2. dsh 侧还报了 `[: 1: Syntax error: Unterminated quoted string`。
 * 前端于是只显示 "Could not open configuration file"。
 *
 * 这不是配置损坏，而是环境能力缺失。
 *
 * 本补丁做什么
 * ----------------------------------------------------------------------------
 * 在 **捕获阶段** 监听文档点击，命中该按钮时阻止原事件，
 * 改为在新标签页打开桥接层提供的 `/config` 只读页。
 *
 * 为什么用捕获阶段
 * ----------------------------------------------------------------------------
 * dsh 前端是 React，onClick 通过根容器做事件委托。
 * 在 `document` 上以 capture=true 监听，会先于 React 的委托处理器执行，
 * 因此 `stopImmediatePropagation()` 能可靠地取消原行为。
 *
 * 为什么只读
 * ----------------------------------------------------------------------------
 * 沙箱里没有编辑器，做成只读查看 + 复制是最小且安全的语义，
 * 不在浏览器里伪造写入能力（写配置仍走 Settings 界面）。
 */

const BUTTON_TEXT = /open configuration file|打开配置文件/i;

/**
 * @param {{verbose?: boolean, target?: string}} [options]
 * @returns {string} 可直接投放到页面的 IIFE
 */
export function buildConfigLinkScript(options = {}) {
  const verbose = options.verbose === true;
  const target = typeof options.target === 'string' && options.target
    ? options.target
    : '/config';

  return `(function () {
  'use strict';
  if (window.__dshmPolishConfigPatched) return;
  window.__dshmPolishConfigPatched = true;

  var TARGET = ${JSON.stringify(target)};
  var RE = ${BUTTON_TEXT.toString()};
  var VERBOSE = ${verbose ? 'true' : 'false'};
  var log = function () {
    if (VERBOSE && window.console) {
      console.log.apply(console, ['[mobile-polish:config]'].concat([].slice.call(arguments)));
    }
  };

  document.addEventListener('click', function (e) {
    var el = e.target;
    var depth = 0;
    while (el && el !== document.body && depth < 8) {
      var isButton = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button';
      if (isButton) {
        var text = (el.textContent || '').trim();
        if (RE.test(text)) {
          e.preventDefault();
          e.stopPropagation();
          if (e.stopImmediatePropagation) e.stopImmediatePropagation();
          log('拦截到配置按钮，改为打开', TARGET);
          var w = window.open(TARGET, '_blank');
          if (!w) {
            // 被弹窗拦截时退回当前页跳转
            window.location.href = TARGET;
          }
          return;
        }
      }
      el = el.parentElement;
      depth++;
    }
  }, true);
})();`;
}
