# DeepSeek Harness 公网部署 + 移动端优化

在**云沙箱**里把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh`）
跑成**公网 HTTPS 可访问**，并附带一套**可回滚的移动端排版优化插件**。

照着做，30 分钟内你能得到一个和作者环境一致的、能在手机上顺滑使用的 dsh。

```
公网 HTTPS  ──►  云平台 TLS  ──►  网关  ──►  桥接进程:3000  ──►  dsh:13080 (仅 127.0.0.1)
                                              ↑
                                   本仓库提供（dsh 官方拒绝绑 0.0.0.0）
```

---

## 目录

- [这个仓库解决什么问题](#这个仓库解决什么问题)
- [快速开始](#快速开始)
- [为什么需要「桥接」](#为什么需要桥接)
- [移动端优化插件](#移动端优化插件)
- [仓库结构](#仓库结构)
- [常见坑](#常见坑)
- [回滚](#回滚)
- [致谢与许可](#致谢与许可)

---

## 这个仓库解决什么问题

`dsh` 是个能执行任意 shell 命令的 AI 编码代理。它的 Web UI 出于安全考虑
**主动拒绝绑定 `0.0.0.0`**，只肯监听 `127.0.0.1`：

```bash
$ dsh web --host 0.0.0.0
error: --host 0.0.0.0 is intentionally not supported yet for safety:
       it would expose remote code execution to the network; use 127.0.0.1 instead
```

这很对，但也意味着**你没法直接从手机访问它**。

本仓库做的事，就是在不破坏这个安全约束的前提下（dsh 仍然只听 `127.0.0.1`），
用一个桥接进程把它的流量接到沙箱的公网映射上，并顺手解决了
**鉴权、Host 校验、settings 不可用**等一系列踩坑。

---

## 快速开始

### 前置条件

| 项 | 要求 |
|---|---|
| 运行环境 | 云沙箱 / 容器（有公网映射能力） |
| Node.js | **≥ 22.19.0，建议 v24.20.0** |
| 平台注入的环境变量 | `X_IDE_SPACE_KEY`、`X_IDE_SPACE_REGION`（沙箱一般自动提供） |
| 公网域名 | 形如 `<YOUR-SANDBOX-ID>.app.workbuddy.host` |

> ⚠️ **Node 版本是硬门槛**：`dsh` 内部用了 `import.meta.main`，
> 而该 API 在 **v22.13.x 下返回 `undefined`**，会导致 dsh CLI **静默失效**
> （不报错、不输出，看起来像卡死）。必须 v22.19.0+ 或 v24 系列。

### 三步走

```bash
# 1. 克隆
git clone https://github.com/Blockedxx/dsh-public-deploy.git
cd dsh-public-deploy

# 2. 装 dsh（注意 --allow-scripts，npm 11+ 默认拦截依赖安装脚本）
npm i -g @deepseek-ai/dsh --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs

# 3. 起服务（首次运行会引导你填公网域名）
chmod +x scripts/*.sh
./scripts/restart.sh
```

启动成功后会输出：

```
==> 启动桥接进程
==> 等待就绪（约 15 秒）
    本地 3000 已响应：HTTP 200
==> 验证 __DSH_TRANSPORT__ 注入是否生效
    ✅ 已注入 globalThis.__DSH_TRANSPORT__（Settings 在公网域名下可用）
==> 完成。访问地址见 /workspace/dsh-公网访问地址.txt
```

访问输出的 URL（第一次打开用于换取 Cookie），即可在手机/电脑上使用。

### 配置公网域名

桥接进程通过 `DSH_PUBLIC_HOST` 识别你的公网域名。**推荐写进配置文件**：

```bash
cp .env.public.example .env.public
# 编辑 .env.public，填入你的域名
echo 'DSH_PUBLIC_HOST=abc123.app.workbuddy.host' > .env.public
```

之后 `restart.sh` / `polish.sh on|off|revert` 触发的**任何一次重启都会自动带上**该域名，
不会退化成 `http://127.0.0.1:13080/?token=...` 这种本地链接。

优先级（高 → 低）：

| 来源 | 说明 |
|---|---|
| 已 `export` 的 `DSH_PUBLIC_HOST` | 临时覆盖用 |
| `.env.public` | 持久化，**推荐** |
| `.known-hosts.json` | 桥接进程运行时学习的兜底 |

> 不知道自己的域名？**先不带该变量启动**，然后用公网域名访问一次，
> 桥接进程会自动从首个请求的 Host 头学到并落盘（`learned gateway host: ...`）。
> 下次重启就会自动读取。

---

## 为什么需要「桥接」

下面是踩完全部坑之后收敛出的架构。每一层都对应一个真实问题：

| 层 | 做什么 | 不这么做会怎样 |
|---|---|---|
| **平台 TLS + 网关** | 公网 HTTPS 终止、反代到容器 | 自己配 nginx/证书没必要，平台已处理 |
| **桥接进程 :3000** | 监听 `0.0.0.0:3000`，转发到 `127.0.0.1:13080` | dsh 拒绝绑 `0.0.0.0`，公网够不着 |
| **Host 头规范化** | 把网关 Host 改成 dsh 期望的域 | dsh 的 `isTrustedApiRequest` 校验失败 → **401** |
| **`--trusted-host` 注入** | 启动 dsh 时带上公网域名 | `/api` 的 `sec-fetch-site` / `origin` 校验拒绝 → **403** |
| **`__DSH_TRANSPORT__` 注入** | 在页面里补一个全局变量 | 前端判定 `isLoopback=false` → **「settings are unavailable in this browser」** |

### 关键文件

| 文件 | 作用 |
|---|---|
| `scripts/dsh-public-bridge.js` | **核心**。公网桥接 + Host 学习/规范化 + dsh 子进程管理 + `__DSH_TRANSPORT__` 注入 |
| `scripts/restart.sh` | 一键重启：同步插件 → 杀旧进程 → 起桥接 → 健康检查 |
| `scripts/polish.sh` | 移动端优化插件的启用/关闭/回滚 |
| `plugins/local-loopback-trust/` | dsh 插件，修「settings 在公网域名下不可用」 |
| `plugins/mobile-polish/` | dsh 插件，移动端排版优化（**可回滚**） |

---

## 移动端优化插件

`dsh` 官方前端**没有任何响应式断点**（实测主 CSS 里 `@media max-width` 数量为 **0**），
所以在手机上看到的是「桌面布局被压缩」，而不是真正的移动端重排。
官方社区插件 `dsh-mobile` 提供了移动端布局，但排版细节仍偏松散。

本仓库的 `plugins/mobile-polish/` 在其之上做了一层**纯 CSS 排版优化**（+1 个 JS 补丁），
把「太空旷」的问题逐项压紧：

| 指标 | 原生 | 优化后 | 说明 |
|---|---|---|---|
| 正文字号 / 行高 | 14px / 24px | **12px / 18px** | 手机上更易读 |
| 消息列 gap | 10px | **4px** | |
| 段落块间距 | 16px | **3px** | 最大的「空旷感」来源 |
| 标题间距 | 32 / 16px | **11 / 5px** | |
| 行内代码高 | 23px | **17px** | 原生撑高整行，导致标点孤字 |
| 表格行高 | 43px | **25px** | |
| 操作栏内部行数 | 3 行 | **1 行** | 时间戳不再独占一行 |
| 输入区高度 | 141px | **105px** | |

### 用法

```bash
./scripts/polish.sh on       # 启用
./scripts/polish.sh status   # 查看状态
./scripts/polish.sh off      # 关闭（保留文件，回到原生样式）
./scripts/polish.sh revert   # 彻底回滚（摘除 bundle + 删插件目录 + 恢复 profile 备份）
```

**设计要点：完全可回滚。** 插件从不修改 dsh 源码，
启用时自动备份 `profile/package.json`，`revert` 优先从备份恢复。

完整的技术细节、12 轮迭代的踩坑记录见
[`plugins/mobile-polish/README.md`](plugins/mobile-polish/README.md)。

---

## 仓库结构

```
dsh-public-deploy/
├── README.md                  ← 你正在看的
├── .env.public.example        公网域名配置样例（复制为 .env.public）
├── scripts/
│   ├── dsh-public-bridge.js   ★ 公网桥接核心
│   ├── restart.sh             ★ 一键重启（自动加载 .env.public）
│   ├── polish.sh              ★ 移动端插件开关/回滚
│   ├── fix-github-dns.sh      修沙箱内 GitHub DNS 劫持
│   └── legacy/                早期脚本（已弃用，历史参考）
├── plugins/
│   ├── mobile-polish/         ★ 移动端排版优化（含 12 轮迭代踩坑记录）
│   └── local-loopback-trust/  修「settings 在公网下不可用」
├── docs/
│   ├── 部署说明.md            ★ 完整部署文档（含全部踩坑与证据）
│   ├── 沙箱内连接GitHub.md     沙箱里 clone/push GitHub 失败的完整解法
│   └── 安装说明.md            本地安装 dsh 的注意事项
└── icons/                     open-in-app 图标补全资源
```

---

## 常见坑

按踩坑顺序排列，每条都有实测证据。完整版见 [`docs/部署说明.md`](docs/部署说明.md)。

<details>
<summary><b>1. Node v22.13.x 导致 dsh CLI 静默失效</b></summary>

`import.meta.main` 在 v22.13.1 下为 `undefined`，v24.20.0 下为 `true`。
表现是**不报错、不输出**，看起来像卡死。

→ 升级到 Node v24.20.0。
</details>

<details>
<summary><b>2. npm 11+ 默认拦截依赖安装脚本</b></summary>

`dsh` 的原生依赖（`koffi`、`node-pty` 等）需要编译脚本才能装好。

```bash
npm i -g @deepseek-ai/dsh --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs
```
</details>

<details>
<summary><b>3. dsh 拒绝绑定 0.0.0.0</b></summary>

官方**刻意**这么设计（防止 RCE 暴露）。解法是桥接进程，dsh 仍只听 `127.0.0.1:13080`。
</details>

<details>
<summary><b>4. 平台注入的 PORT 已被占用</b></summary>

平台会注入 `PORT=8089`，但该端口已被沙箱内置的 `sync_server` 占用，绑定必然 `EADDRINUSE`。

→ 桥接进程**忽略** `process.env.PORT`，固定用 3000（发布时 `--port` 也声明 3000，
网关按 `<port>-<SPACE_KEY>` 子域名路由，两者必须一致）。
</details>

<details>
<summary><b>5. 公网 404 —— 多层根因</b></summary>

依次排查出：进程模型（平台只代理自启动命令的**直接子进程**）、
Host 改写导致 401、`/api` 403、边缘 CDN 缓存、路由同步延迟。
</details>

<details>
<summary><b>6. 「settings are unavailable in this browser」</b></summary>

前端据此判断是否走本地环回：`isLoopback = transport?.ownsHost === true || ...`

公网访问时 `isLoopback=false` → `persistence="memory"` → `load()`/`ensure()` 短路
→ 所有 settings 读写失效。

→ 通过 dsh 官方的 `webserver/index-inject` 管线注入 `globalThis.__DSH_TRANSPORT__`。
</details>

<details>
<summary><b>7. 插件缺 <code>dsh.bundle.patch</code> 会导致 dsh 启动即崩</b></summary>

自研 dsh 插件时，`package.json` 里**必须**有 `dsh.bundle.patch` 字段，否则 dsh 起不来。
</details>

<details>
<summary><b>8. mobile-polish 的 12 轮踩坑（选摘）</b></summary>

- **CSS Modules hash 后缀**：类名形如 `EvIC1a_column`，必须用 `[class*="_column"]` 子串匹配
- **`dsh-mobile` 属性前缀坑（复发 5 次）**：只要目标区域 dsh-mobile 也管，
  必须加同前缀 + `[class]` 抬优先级，否则被压制
- **flex `gap` 对零高子项照样生效**：3 个 `height:0` 的 spacer 白吃 40px 间隙（反直觉）
- **`display: inline` 反而比 `inline-flex` 更差**：盒子塌陷后宽度撑满整行

详见 [`plugins/mobile-polish/README.md`](plugins/mobile-polish/README.md)。
</details>

<details>
<summary><b>9. 沙箱内 GitHub 连不上（DNS 被劫持）</b></summary>

`github.com` / `api.github.com` / `raw.githubusercontent.com` 等**全部**被解析到
`198.18.x.x`（RFC 2544 基准测试保留段，非真实地址）。
向 5 个公共 DNS 直接查询 53 端口返回的也是同一个虚假 IP → **网络层透明劫持**，
改 `resolv.conf` 无效，只能用 `/etc/hosts` 覆写。

**最坑的一点**：此时 `gh auth status` 会报
`The token in GH_TOKEN is invalid.` —— 但 **token 是好的**，
是网络不可达被 `gh` 误报成了认证失败。别急着重发 token。

```bash
./scripts/fix-github-dns.sh          # 一键修复
./scripts/fix-github-dns.sh check    # 检查状态
```

另外两个坑：
- **`/etc/hosts` 重启后被还原**。官方给的持久化路径 `~/.user_hosts`
  在本环境**静默失效**（沙箱默认 `awk` 是 mawk 1.3.4，解析合并用的
  嵌套正则直接 panic `ERR_7`）→ 重启后需重新执行一次脚本
- **hosts 修好后 `curl` 能通、`git` 却仍报 `gnutls_handshake() failed`**
  → git 的 TLS 栈更敏感，必须 `git config --global http.version HTTP/1.1`

脚本会把这两件事**一起办掉**，所以直接跑它就行，不用手动补参数。

详见 [`docs/沙箱内连接GitHub.md`](docs/沙箱内连接GitHub.md)。
</details>

---

## 回滚

**任何改动都可回滚**，这是本仓库的设计原则。

```bash
./scripts/polish.sh revert    # 移动端插件：完全卸载，恢复原生
```

回滚后逐项验证（实测 7/7 通过）：

| 指标 | 插件态 | 回滚后（原生） |
|---|---|---|
| 表格高 | 75px | 129px |
| 行内代码高 | 17px | 21px |
| 标题间距 | 11/5px | 32/16px |
| 消息列 gap | 4px | 10px |

桥接层如需停止：

```bash
pkill -f dsh-public-bridge.js
pkill -f "dsh web"
```

---

## 致谢与许可

- **DeepSeek Harness** 版权归 DeepSeek 所有，本仓库仅为部署实践记录，不包含其源码。
- **`dsh-mobile`** 为官方社区插件，本仓库的 `mobile-polish` 是其**补充**而非替代。
- 本仓库内容以 **MIT** 许可发布，可自由使用/修改/分发。

> ⚠️ **安全提醒**：`dsh` 能执行任意 shell 命令。暴露到公网前请确保：
> ① 访问地址带 token 鉴权；② 不要长期开启无鉴权访问；③ 沙箱本身是隔离环境。
> 本仓库的桥接层**完整保留**了 dsh 的原始鉴权逻辑，未做任何绕过。
