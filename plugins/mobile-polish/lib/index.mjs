/**
 * dsh-mobile-polish —— 移动端聊天页排版优化（可回滚）
 * ============================================================================
 *
 * 背景
 * ----------------------------------------------------------------------------
 * DeepSeek Harness 的 Web UI 在 iPhone（390×844）上排版偏松散：
 *   - 时间戳独占一行、且用户消息与回复各出现一次，纯占高度
 *   - `System prompt` / `Context injection` 等调试信息与正文同等视觉权重，
 *     且折叠项容器高度塌陷（实测 0px 容器内塞 56px 内容）
 *   - 模型回复是裸文本，无身份标识，与右侧蓝色用户气泡权重失衡
 *   - `_column` 的 gap 与 flowItem 的 margin 双重叠加，间距不可控
 *
 * 本插件做什么
 * ----------------------------------------------------------------------------
 * 通过官方注入管线 `webserver/index-inject` 投放：
 *   - 一条 `kind: "style"` —— 移动端排版优化样式（主体）
 *   - 一条 `kind: "script"` —— 会话行点击后收侧栏（v8 新增，独立开关）
 *
 * **它不修改 dsh 任何源码文件，也不改变前端构建产物** —— 只覆盖样式 +
 * 补一个原生缺失的事件绑定，属于非侵入式适配层。
 *
 * 为什么可回滚
 * ----------------------------------------------------------------------------
 * 三层保险：
 *   1. 运行期开关：config.enabled / 环境变量 DSH_MOBILE_POLISH=0，重启即失效
 *   2. 插件卸载：从 profile 的 dsh.profile.bundles 摘掉本包，重启即彻底消失
 *   3. 文件删除：删掉 node_modules/dsh-mobile-polish 目录即可
 * 任一层生效后，页面回到 dsh 原生样式 —— 因为本插件从未改动过原生文件。
 *
 * ⚠️ 选择器稳定性
 * ----------------------------------------------------------------------------
 * dsh 前端用 CSS Modules，类名形如 `Sixlwa_bubble` / `xzv4MW_actions`，
 * 其中 hash 后缀随构建变化。因此本插件一律使用 `[class*="_bubble"]`
 * 这类「子串匹配」，避免绑定具体 hash。升级 dsh 后若某条规则失效，
 * 通常是这个原因 —— 重新抓一次 DOM 类名即可。
 *
 * 参考实现（官方订阅范例）：
 *   dsh-client-connection/lib/index.js  —— webserver/index-inject 订阅
 *   dsh-client-ui-theme/lib/index.js    —— ctx.inject(['webServer'], ...)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import z from '@deepseek-ai/schemastery';

import { buildDrawerAutocloseScript } from './drawer-autoclose.mjs';

export const name = 'dsh-mobile-polish';

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_FILE = join(HERE, 'mobile-polish.css');

/**
 * 配置项。
 *
 * schemastery 的约定：导出 `Config` 作为 Config 对象（非函数），
 * 由 dsh 依据 cordis.patch.yml 里 `config:` 字段做校验与填充。
 */
export const Config = z.object({
  /** 总开关。关闭后完全不注入任何样式。 */
  enabled: z.boolean().default(false),

  /** 最大生效宽度（px）。超过此宽度的视口不受影响，避免干扰桌面端。 */
  maxWidth: z.number().default(720),

  /**
   * 【v8 #5】点会话行后自动收回侧栏。
   *
   * 这是本插件唯一的 JS 注入项，独立开关，关掉即回滚（只影响这一条，
   * 样式优化照常生效）。详见 lib/drawer-autoclose.mjs 头部注释。
   */
  closeDrawerOnSessionPick: z.boolean().default(true),

  /** 打印注入日志，便于排查。 */
  verbose: z.boolean().default(false),
});

/** 环境变量兜底开关：DSH_MOBILE_POLISH=0 可强制关闭（优先级最高）。 */
function envDisabled() {
  const raw = process.env.DSH_MOBILE_POLISH;
  if (raw === undefined) return false;
  return /^(0|false|no|off)$/i.test(raw.trim());
}

/** JS 补丁的独立环境变量兜底：DSH_MOBILE_POLISH_DRAWER=0 可单独关掉它。 */
function envDrawerDisabled() {
  const raw = process.env.DSH_MOBILE_POLISH_DRAWER;
  if (raw === undefined) return false;
  return /^(0|false|no|off)$/i.test(raw.trim());
}

/** 读取 CSS 文件；失败时返回 null 并告警，绝不让插件崩掉整个 dsh。 */
function loadCss(logger) {
  try {
    return readFileSync(CSS_FILE, 'utf8');
  } catch (err) {
    logger.error(
      `[mobile-polish] 无法读取样式文件 ${CSS_FILE}：${err?.message ?? err}`,
    );
    return null;
  }
}

/**
 * 若配置了 maxWidth，把 CSS 里的 `max-width: 720px` 替换成实际值。
 * 这样调 config.maxWidth 就能改断点，无需改 CSS 文件。
 */
function applyMaxWidth(css, maxWidth) {
  if (typeof maxWidth !== 'number' || !Number.isFinite(maxWidth)) return css;
  return css.replaceAll('max-width: 720px', `max-width: ${Math.round(maxWidth)}px`);
}

export function apply(ctx, config) {
  const enabled = config.enabled === true && !envDisabled();

  if (!enabled) {
    ctx.logger.info(
      '[mobile-polish] 已禁用 —— 将 config.enabled 设为 true（或移除 DSH_MOBILE_POLISH=0）以启用',
    );
    return;
  }

  const css = loadCss(ctx.logger);
  if (css === null) return;

  const finalCss = applyMaxWidth(css, config.maxWidth);
  const verbose = config.verbose === true;

  // 【v8 #5】抽屉自动收回 —— 唯一的 JS 注入项，独立开关。
  const drawerEnabled =
    config.closeDrawerOnSessionPick === true && !envDrawerDisabled();
  const drawerJs = drawerEnabled
    ? buildDrawerAutocloseScript({ verbose })
    : null;

  // 注意：不在文件顶层导出 `inject`，而是用 ctx.inject(['webServer'], ...)
  // 延迟到 webServer 服务就绪后再订阅（对齐官方 dsh-client-ui-theme 写法）。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return;
      table.push({ kind: 'style', text: finalCss });
      if (drawerJs !== null) {
        table.push({ kind: 'script', text: drawerJs });
      }
      if (verbose) {
        ctx.logger.info(
          `[mobile-polish] 已注入样式 ${finalCss.length} 字节（断点 ${config.maxWidth}px）` +
            (drawerJs === null
              ? '；抽屉自动收回：已关闭'
              : `；抽屉自动收回：已开启（${drawerJs.length} 字节）`),
        );
      }
    });

    ctx.logger.warn(
      `[mobile-polish] 已启用 —— 移动端排版优化生效（断点 ${config.maxWidth}px）` +
        `；抽屉自动收回 ${drawerEnabled ? '开启' : '关闭'}。` +
        '如需回滚：把 cordis.patch.yml 的 enabled 改为 false，或设 DSH_MOBILE_POLISH=0。',
    );
  });
}
