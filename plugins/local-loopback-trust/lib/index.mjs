/**
 * dsh-local-loopback-trust — 反向代理场景下的 Host 信任声明（默认关闭）
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────
 *
 * `@deepseek-ai/dsh-client-ui-settings` 在浏览器侧这样决定 settings 的持久化模式：
 *
 *     // dsh-client-ui-settings/lib/client.js:1345
 *     const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";
 *
 * 而 `isLoopback` 的来源是：
 *
 *     // dsh-client-connection/lib/client.js:6344
 *     isLoopback: transport?.ownsHost === true
 *              || pageLocation === void 0
 *              || isLoopbackHostname(pageLocation.hostname),
 *
 * `isLoopbackHostname` 只承认 `localhost` / `[::1]` / `127.x.x.x`
 * （同文件 6273 行）。因此当页面通过一个**非 loopback 域名**访问时
 * （例如平台分配的公网 HTTPS 域名，经 TLS 终止 + 反向代理回落到本机端口），
 * `isLoopback` 为 false → `persistence` 取 `"memory"` →
 * `SettingsDescribeMirror` 以 `status:"unavailable"` 起步，且
 * `load()` / `ensure()` 在 `"memory"` 分支直接 `return Promise.resolve()`，
 * **一个请求都不会发出去**。表现形式就是 Settings → Models 面板报：
 *
 *     加载提供方目录失败: settings are unavailable in this browser
 *
 * 这是 dsh 官方**有意**的设计，见 `dsh-client-ui-settings/README.zh.md:97`：
 *
 *   > 非 loopback 页面没有持久化设置：本 Client 在那里禁用 Host 持久化，
 *   > 因此 scope 以 `unavailable` 起步且从不跨线路。
 *
 * ── 它为什么能生效 ────────────────────────────────────────────────────────
 *
 * `isLoopback` 的第一个分支读的是页面全局 `globalThis.__DSH_TRANSPORT__`
 * （`dsh-client-connection/lib/client.js:6307`）。该对象在官方类型里叫
 * `ClientTransportHooks`，其中 `ownsHost` 的文档语义是：
 *
 *   > 传输层所有者声明本页面完全拥有 Host：Host 就跑在这个页面派生的 worker 里，
 *   > 没有第三方能触达它，因此"操作者本机"这个 loopback 代称在这里是空的。
 *
 * 本插件通过**官方注入管线**投放这个全局，而不是改写前端产物：
 * `@deepseek-ai/dsh-host-webserver` 暴露 `webserver/index-inject` 事件收集
 * 注入行，其中 `{ kind: 'global', name, value }` 的渲染结果正是
 * `<script>globalThis["__DSH_TRANSPORT__"] = {...}</script>`，且该行被插在
 * `<head>` 开头、先于前端 module bundle 执行；紧随其后的 `__DSH_BOOT_READY__`
 * 尾脚本又保证了客户端入口会等待注入表就绪。因此时序由 dsh 自身担保。
 *
 * 由于 `createWebConnectionRpc(transport?.fetch, transport?.openStream)`
 * 只消费 `fetch` / `openStream` 两个可选字段，本插件只写 `ownsHost`
 * 时二者保持 undefined，RPC 传输回落到 `globalThis.fetch` 与既有 WebSocket 路径，
 * **不改变任何网络行为**。
 *
 * ── 安全边界（务必阅读）──────────────────────────────────────────────────
 *
 * `ownsHost: true` 的原始语义是"Host 只被本页面触达"。反向代理 / 公网暴露场景下
 * 该前提**并不成立**：任何持有访问凭据的人都能连上这个页面。开启本插件等于
 * 把"settings 文档可读写"这一特权面暴露给所有能访问该 URL 的人，其中包含：
 *
 *   - Settings → General：修改默认模型、默认工作区等（SettingsDocumentStore）；
 *   - Settings → Models：读取与写入提供方配置、API Key 等凭据字段；
 *   - 其他一切以 `remote.$host.isLoopback` 为守门的客户端插件。
 *
 * 这确实是绕过一道有意的安全边界。因此本插件**默认关闭**，且只在显式配置
 * `enabled: true`（或环境变量 `DSH_TRUST_PROXY_PAGE=1`）时才注入。
 * 请确保该 URL 的访问控制（如 dsh 自身的 browser-auth token/cookie、
 * 网关鉴权、内网限制）确实可靠，再开启它。
 *
 * ── 关闭方式 ──────────────────────────────────────────────────────────────
 *
 * 把 `cordis.patch.yml` 里的 `enabled` 改为 `false`，或移除该 insert 条目。
 * 改动后 dsh 会热重载 profile 层（`patchReload: live`）；若未生效，
 * 重启 dsh 进程即可。
 *
 * @module dsh-local-loopback-trust
 */

import z from '@deepseek-ai/schemastery';

/** 稳定插件名。 */
export const name = 'local-loopback-trust';

/**
 * 依赖服务通过 `ctx.inject(['webServer'], ...)` 在 apply 内部等待，
 * 因此这里不导出顶层 `inject` —— 与官方 `dsh-client-ui-theme` 的做法一致，
 * 好处是 webServer 缺失时插件仍能正常加载而不是加载失败。
 */

/** 配置 schema —— 与其他 dsh 插件保持同一约定（导出一个 schemastery 对象）。 */
export const Config = z.object({
  /**
   * 是否启用注入。默认 false —— 这是一个需要显式确认的安全边界放宽。
   */
  enabled: z.boolean().default(false),
  /**
   * 覆盖注入到 `globalThis.__DSH_TRANSPORT__` 的载荷。
   * 默认 `{ ownsHost: true }`，即让 `Connection.isLoopback` 报告 true。
   *
   * 注意：写入的字段会**整体替换**该全局对象。除 `ownsHost` 外只允许
   * 声明 `fetch` / `openStream` / `loadBundle` 三个可选传输钩子；
   * 留空即沿用 dsh 默认的浏览器 fetch 与 WebSocket 路径。
   */
  payload: z.dict(z.any()).default({ ownsHost: true }),
  /** 调试开关：为 true 时在 Host 日志里打印每次渲染的注入内容。 */
  verbose: z.boolean().default(false),
});

/** 环境变量开关：`DSH_TRUST_PROXY_PAGE=1` 可替代配置项（便于临时启用）。 */
function envEnabled() {
  const raw = process.env.DSH_TRUST_PROXY_PAGE;
  if (raw === undefined) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * 插件主体。
 *
 * 订阅 `webserver/index-inject`，在被调用时把一行 `kind:'global'` 推入注入表。
 * 该事件的订阅者会收到一个数组（`table`），往里 push 即完成贡献；
 * 表格每次渲染 index 都重新收集，因此读到的是订阅者当下状态。
 *
 * @param ctx - host 侧 cordis 上下文。
 * @param config - 已校验的插件配置。
 */
export function apply(ctx, config) {
  const enabled = config.enabled === true || envEnabled();
  if (!enabled) {
    ctx.logger.info(
      '[local-loopback-trust] disabled — set `enabled: true` (or DSH_TRUST_PROXY_PAGE=1) to inject __DSH_TRANSPORT__.ownsHost',
    );
    return;
  }

  const payload = config.payload ?? { ownsHost: true };
  const verbose = config.verbose === true;

  ctx.logger.warn(
    '[local-loopback-trust] ENABLED — injecting globalThis.__DSH_TRANSPORT__ so Connection.isLoopback reports true on non-loopback pages; settings（含模型提供方与凭据字段）将对所有可访问该 URL 的人可读写',
  );

  // 与官方 dsh-client-connection 投放 __DSH_CONNECTION_RECOVERY__ 的写法一致：
  // 先等到 webServer 就绪，再在其上下文里订阅注入表。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table) => {
      if (!Array.isArray(table)) return;
      table.push({
        kind: 'global',
        name: '__DSH_TRANSPORT__',
        value: payload,
      });
      if (verbose) {
        ctx.logger.info(
          `[local-loopback-trust] injected __DSH_TRANSPORT__ = ${JSON.stringify(payload)}`,
        );
      }
    });
  });
}
