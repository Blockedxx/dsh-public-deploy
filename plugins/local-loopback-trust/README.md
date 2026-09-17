# dsh-local-loopback-trust

反向代理场景下的 Host 信任声明插件（**默认关闭**）。让 `Connection.isLoopback`
在非 loopback 页面上报告 `true`，从而恢复 Settings（含 Settings → Models）在
公网域名下的可用性。

## 解决什么问题

通过反向代理（TLS 终止 + 域名）访问 dsh Web UI 时，Settings → Models 面板会报：

```
加载提供方目录失败: settings are unavailable in this browser
```

根因是一条确定性的客户端分支：

| 环节 | 公网域名 | `127.0.0.1` |
| --- | --- | --- |
| `isLoopbackHostname(location.hostname)` | `false` | `true` |
| `ctx.remote.$host.isLoopback` | `false` | `true` |
| `persistence` | `"memory"` | `"host"` |
| `SettingsDescribeMirror` 初态 | `unavailable` | `idle` |
| `load()` / `ensure()` | 直接 return，**不发请求** | 正常发 `settings/describe` |

来源：

```js
// @deepseek-ai/dsh-client-ui-settings/lib/client.js:1345
const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";

// @deepseek-ai/dsh-client-connection/lib/client.js:6344
isLoopback: transport?.ownsHost === true
         || pageLocation === void 0
         || isLoopbackHostname(pageLocation.hostname),
```

`isLoopbackHostname` 只承认 `localhost` / `[::1]` / `127.x.x.x`。

**这是 dsh 官方有意的设计**，见 `dsh-client-ui-settings/README.zh.md:97`：

> 非 loopback 页面没有持久化设置：本 Client 在那里禁用 Host 持久化，因此 scope
> 以 `unavailable` 起步且从不跨线路。

## 工作原理

`isLoopback` 的第一个分支读页面全局 `globalThis.__DSH_TRANSPORT__`。本插件通过
dsh 官方的 index 注入管线投放它——与 `@deepseek-ai/dsh-client-connection` 投放
`__DSH_CONNECTION_RECOVERY__` 用的是同一机制：

```js
ctx.inject(['webServer'], (webCtx) => {
  webCtx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_TRANSPORT__', value: { ownsHost: true } });
  });
});
```

`kind: 'global'` 渲染为 `<script>globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}</script>`，
插在 `<head>` 开头、先于前端 module bundle 执行；紧随其后的 `__DSH_BOOT_READY__`
尾脚本保证客户端入口会等待注入表就绪。**时序由 dsh 自身担保，且不修改任何
DSH 源码或前端构建产物。**

只写 `ownsHost` 时，`transport.fetch` / `transport.openStream` 保持 `undefined`，
RPC 回落到 `globalThis.fetch` 与既有 WebSocket 路径，**不改变任何网络行为**。

## 安全边界

`ownsHost: true` 的原始语义是「Host 只被本页面触达」。反向代理 / 公网暴露场景下
该前提**并不成立**——任何持有访问凭据的人都能连上这个页面。开启后，settings
文档（含凭据字段）对所有能访问该 URL 的人可读写，影响范围包括：

- Settings → General：默认模型、默认工作区等（`SettingsDocumentStore`）
- Settings → Models：提供方配置与 API Key 等凭据字段
- 其他一切以 `remote.$host.isLoopback` 为守门的客户端插件

这确实是绕过一道有意的安全边界。因此本插件默认关闭，请确认访问控制
（dsh 自身的 browser-auth token/cookie、网关鉴权、内网限制等）可靠后再开启。

## 配置

```yaml
- insert:
    - id: local-loopback-trust
      name: dsh-local-loopback-trust
      config:
        enabled: true      # 默认 false
        payload:
          ownsHost: true
        verbose: false     # true 时打印每次注入内容
```

也可用环境变量临时启用：`DSH_TRUST_PROXY_PAGE=1`。

## 关闭方式

把 `enabled` 改为 `false`，或从 `cordis.patch.yml` 移除该 insert 条目。
改动后 dsh 会热重载该 profile 层（`patchReload: live`）；未生效则重启 dsh 进程。

## 许可

MIT
