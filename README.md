# 在 WorkBuddy 沙箱里部署 DeepSeek Harness（公网 HTTPS 可访问）

把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh`）
从零装好，跑成**手机能直接打开的 HTTPS 服务**，并附带一套**可回滚的移动端排版优化**。

跟着做，约 30 分钟，你会得到一个和作者环境完全一致的 dsh。

### 起因：原本以为只要三步

在 WorkBuddy 沙箱里暴露一个服务，**通用做法**确实只要三步：

> 1. 起个本地服务，监听 `:3000`（Node、Python、Java，甚至静态文件服务器都行）
> 2. 找到公网域名 `<沙箱ID>.app.workbuddy.host`（在沙箱信息或任务面板里）
> 3. 拼上 `https://` 直接访问 —— CLB 卸载 HTTPS，`sandbox-proxy` 把请求送到你本地 `:3000`

**但 `dsh` 是个例外**：它出于安全考虑**主动拒绝绑定 `0.0.0.0`**
（因为它能执行任意 shell 命令，暴露到网络等于暴露 RCE），只肯监听 `127.0.0.1`。
于是第 1 步走不通 —— 平台代理够不着，公网访问必然失败。

这就是本仓库存在的原因：**给 dsh 补一个桥接层**，让它在一个「一切皆插件 + 拒绝外网绑定」
的设计下，仍然能被公网访问。

> 如果你要暴露的不是 dsh，而是**你自己写的服务**，
> 那让服务直接监听 `0.0.0.0:3000` 即可，**不需要本仓库的任何东西**。

```
手机 / 电脑
    │  HTTPS
    ▼
┌──────────────────────────────────────────────┐
│  WorkBuddy 平台（TLS 终止 + 网关，无需自建）  │
│  ① <容器ID>.app.workbuddy.host   ← 主入口     │
│  ② <PORT>-<SPACE_KEY>.e2b...     ← 按端口映射 │
└──────────────────┬───────────────────────────┘
                   │ 反代到沙箱内某个端口
                   ▼
        ┌────────────────────────┐
        │  桥接进程  0.0.0.0:3000 │  ← 本仓库提供
        └───────────┬────────────┘
                    │ 127.0.0.1:13080
                    ▼
        ┌────────────────────────┐
        │  dsh web（官方拒绝绑     │
        │  0.0.0.0，只能本地监听） │
        └────────────────────────┘
```

---

## 目录

1. [先搞清楚：WorkBuddy 给了你什么](#1-先搞清楚workbuddy-给了你什么)
2. [环境要求](#2-环境要求)
3. [第 1 步：装 dsh](#3-第-1-步装-dsh)
4. [第 2 步：装移动端插件](#4-第-2-步装移动端插件)
5. [第 3 步：拿到你的公网域名](#5-第-3-步拿到你的公网域名)
6. [第 4 步：启动服务](#6-第-4-步启动服务)
7. [第 5 步：验证](#7-第-5-步验证)
8. [日常使用](#8-日常使用)
9. [为什么必须要有「桥接层」](#9-为什么必须要有桥接层)
10. [移动端排版优化](#10-移动端排版优化)
11. [仓库结构](#11-仓库结构)
12. [常见坑（12 个）](#12-常见坑)
13. [回滚](#13-回滚)
14. [附录：WorkBuddy 沙箱环境全景](#14-附录workbuddy-沙箱环境全景)

---

## 1. 先搞清楚：WorkBuddy 给了你什么

这一步很重要，**不理解这层，后面的域名问题会卡死你**。

WorkBuddy 的沙箱（CloudStudio 底座）会**自动**为你提供公网映射，你不需要：

- ❌ 自建 nginx
- ❌ 配反向代理
- ❌ 申请 SSL 证书

平台在腾讯云 CLB 层做 TLS 终止，再由沙箱内置的 `sandbox-proxy` 反代到你的端口。

### 你会拿到两个域名，它们是两套独立机制

| | 域名形态 | 怎么来 | 映射规则 | 生命周期 |
|---|---|---|---|---|
| **① 主入口** | `<容器ID>.app.workbuddy.host` | 平台按容器分配 | 固定指向**一个**端口 | 长期（容器重建后仍有效） |
| **② 端口网关** | `<PORT>-<SPACE_KEY>.e2b.<REGION>.sandbox.cloudstudio.club` | 由环境变量拼出 | **任意端口各自独立映射** | 跟沙箱会话 |

**实测证据**（作者环境）：

```
① https://a62504992fd8ed07c.app.workbuddy.host/          -> 401 ✅
② https://3000-<SPACE_KEY>.e2b.bj7.sandbox.cloudstudio.club/ -> 401 ✅
   https://3001-<SPACE_KEY>.e2b.bj7.sandbox.cloudstudio.club/ -> 500（该端口无服务）
   https://8081-<SPACE_KEY>.e2b.bj7.sandbox.cloudstudio.club/ -> 返回 8081 上服务的内容
```

> **关键结论**：`app.workbuddy.host` **不跟随端口变化**，它固定映射到一个端口。
> 实测：另起一个 8081 服务后，`app.workbuddy.host` 仍返回 3000 端口上的 dsh。
> 所以**你要把服务跑在那个固定端口上** —— 本仓库默认用 **3000**。
>
> 主入口前缀是**平台侧的容器标识**，与 `X_IDE_SPACE_KEY`、
> 以及容器内的 `hostname` 都**不相同**，**不要试图自己拼**（详见 [3.1 节](#31-主入口域名推荐用这个)）。

### 关于端口，记住三条

1. **必须监听 `0.0.0.0`**，不能只听 `127.0.0.1`（否则网关够不着）
2. **不要用平台注入的 `PORT` 变量** —— 实测它可能是 `8089`，而该端口被沙箱内置的
   `sync_server` 占用，绑定必然 `EADDRINUSE`。**自己写死 3000**
3. 端口号要和你在控制台/网关用的保持一致

---

## 2. 环境要求

### 硬件（沙箱默认给的）

| 项 | 作者实测值 | 说明 |
|---|---|---|
| CPU | `X_IDE_CPU_LIMIT=4` | 4 核 |
| 内存 | `X_IDE_MEMORY_LIMIT=8G` | **8G**，不是 32G。dsh 峰值约 500MB~1GB，够用 |
| 磁盘 | `X_IDE_DISK_QUOTA=50G` | |

### 软件

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22.19.0，强烈建议 v24.20.0** | 见下方警告 |
| npm | 11+ | 注意 `--allow-scripts` 问题 |
| OS | Linux（作者环境 Ubuntu 22.04） | |

> ### ⚠️ Node 版本是硬门槛，必须先处理
>
> `dsh` 内部用了 `import.meta.main` 这个较新的 API：
>
> | Node 版本 | `import.meta.main` | 结果 |
> |---|---|---|
> | v22.13.1 | `undefined` | ❌ dsh CLI **静默失效** |
> | v24.20.0 | `true` | ✅ 正常 |
>
> **「静默失效」的意思是：不报错、不输出、不退出，看起来像卡死。**
> 你会以为是别的问题，排查很久。
>
> 沙箱自带的 Node 常常就是 v22.13.x，所以**先升级**：
>
> ```bash
> node -v   # 如果是 v22.13.x，继续往下
>
> # 装 nvm（如果还没有）
> curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
> export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh"
>
> # 装 v24
> nvm install 24
> nvm use 24
> nvm alias default 24
> node -v   # 应为 v24.x.x
> ```
>
> 本仓库的桥接脚本会**自动探测**可用的 Node（优先 v22.19+/v23+），
> 但 `dsh` 本身还是需要你装好并让 PATH 指向正确的版本。

---

## 3. 第 1 步：装 dsh

```bash
# 确认 Node 版本
node -v   # 必须 >= v22.19，建议 v24.x

# 安装（注意 --allow-scripts，这不是可选项）
npm i -g @deepseek-ai/dsh \
  --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs
```

**为什么必须加 `--allow-scripts`**：

npm 11+ 默认**拦截**依赖的安装脚本（安全策略）。而 dsh 的原生依赖
（`koffi`、`node-pty` 等）需要编译脚本才能装好。不加这个参数，装完会缺少原生模块。

验证装好了：

```bash
dsh --version
```

---

## 4. 第 2 步：装移动端插件

> 这步可选，但**强烈建议做** —— 官方前端没有任何移动端适配，
> 不装的话手机上看着会很难受。

```bash
# 先装官方社区插件（提供移动端布局骨架）
# 注意：dsh plugin 必须带 --profile，它内部把参数转发给 pnpm
dsh plugin --profile web add dsh-mobile

# 确认装上了
dsh plugin --profile web list
# 应输出：dsh-mobile 0.4.x
```

然后克隆本仓库，用自带的脚本装上排版优化插件：

```bash
git clone https://github.com/Blockedxx/dsh-public-deploy.git
cd dsh-public-deploy
chmod +x scripts/*.sh

./scripts/polish.sh on      # 启用排版优化
./scripts/polish.sh status  # 查看状态
```

看到这样的输出就对了：

```
── dsh-mobile-polish 状态 ──────────────────────
  插件目录   : 已部署
  开关       : true
  断点       : 720px
  bundle注册 : 是
────────────────────────────────────────────────
```

详见 [第 10 节](#10-移动端排版优化)。

---

## 5. 第 3 步：拿到你的公网域名

**这一步最容易卡住，看清楚。**

### 3.1 主入口域名（推荐用这个）

去 **WorkBuddy 控制台**找你的应用访问域名，形如：

```
https://<容器ID>.app.workbuddy.host
```

**这个前缀是平台分配给你的容器标识**，纯小写十六进制（作者环境为 `a62504992fd8ed07c`，16 位）。

> ### ⚠️ 不要试图自己拼这个域名
>
> 作者实测：**用当前容器的 hostname 拼出来的域名是 404**。
>
> | 域名 | 结果 |
> |---|---|
> | `a62504992fd8ed07c.app.workbuddy.host`（控制台给的） | **401** ✅ 指向服务 |
> | `a70a5a91533d.app.workbuddy.host`（容器内 `hostname` 的值） | **404** ❌ 不存在 |
>
> 两个标识看着像（都是十六进制），但**不是一回事**：
>
> - `a70a5a91533d` = 容器内的 `hostname`，**重启会变**，拼域名没用
> - `a62504992fd8ed07c` = 平台侧的稳定容器标识，**容器重建后仍然有效**
>   （实测：域名从 9/16 就在用，而当前容器 9/17 23:45 才启动，域名依然通）
>
> **结论：去控制台复制，别自己拼。**

拿到后写进配置文件：

```bash
cd dsh-public-deploy
cp .env.public.example .env.public

# 把你的域名填进去（不要带 https:// 和末尾斜杠）
echo 'DSH_PUBLIC_HOST=你的ID.app.workbuddy.host' > .env.public
```

### 3.2 或者：用端口网关域名

如果你想自己拼，用这个规则（**任意端口都自动映射**）：

```bash
# 从环境变量读
echo "https://3000-${X_IDE_SPACE_KEY}.e2b.${X_IDE_SPACE_REGION}.sandbox.cloudstudio.club/"
```

作者环境实测值：

```
X_IDE_SPACE_KEY    = 9b99622e67154aa9b8593c570ed9ab43
X_IDE_SPACE_REGION = bj7
→ https://3000-9b99622e67154aa9b8593c570ed9ab43.e2b.bj7.sandbox.cloudstudio.club/
```

**两种域名都能用**，选一个即可。区别是：

- 主入口更短、更稳定 → **推荐**
- 端口网关不依赖你在控制台的配置，适合临时调试

### 3.3 实在不知道域名？

桥接进程支持**运行时学习**：先不设 `DSH_PUBLIC_HOST` 启动，
然后用任意域名访问一次，它会从请求头里学到并落盘：

```
learned gateway host: 3000-9b99622e...e2b.bj7.sandbox.cloudstudio.club
```

下次重启会自动读取。

---

## 6. 第 4 步：启动服务

```bash
cd dsh-public-deploy
./scripts/restart.sh
```

预期输出：

```
==> 公网域名：a62504992fd8ed07c.app.workbuddy.host
==> 同步 local-loopback-trust 插件到 profile
    已同步到 /root/.dsh/profiles/web/node_modules/dsh-local-loopback-trust
    profile bundles: @deepseek-ai/dsh-base, @deepseek-ai/dsh-web-app, dsh-mobile, ...
==> 停止现有服务
==> 启动桥接进程
==> 等待就绪（约 15 秒）
    本地 3000 已响应：HTTP 200
==> 验证 __DSH_TRANSPORT__ 注入是否生效
    ✅ 已注入 globalThis.__DSH_TRANSPORT__（Settings 在公网域名下可用）
==> 完成。访问地址见 /workspace/dsh-公网访问地址.txt
```

访问地址会写到 `/workspace/dsh-公网访问地址.txt`：

```
DeepSeek Harness —— 访问地址

访问链接（首次打开用于换取会话 Cookie）：
https://<你的域名>/?token=xxxxxxxxxxxx
```

**把这个链接在浏览器里打开一次** —— 它会用 token 换取一个 30 天有效的 Cookie，
之后直接访问域名即可，不用再带 token。

---

## 7. 第 5 步：验证

按顺序跑，全绿就算成功：

```bash
# 1. 本地桥接是否活着（401 是正常的，说明鉴权生效了）
curl -s -o /dev/null -w "本地     -> %{http_code}\n" http://127.0.0.1:3000/

# 2. 公网是否可达
curl -s -o /dev/null -w "公网裸访 -> %{http_code}\n" https://<你的域名>/
#   期望 401

# 3. 带 token 是否换到 Cookie（303）
TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' /workspace/dsh-公网访问地址.txt | head -1 | cut -d= -f2)
curl -s -o /dev/null -w "带token  -> %{http_code}\n" -c /tmp/ck.txt \
  "https://<你的域名>/?token=$TOKEN"
#   期望 303

# 4. 带 Cookie 是否能打开页面（200）
curl -s -o /dev/null -w "带cookie -> %{http_code}\n" -b /tmp/ck.txt \
  "https://<你的域名>/"
#   期望 200

# 5. 关键注入是否生效
curl -s -b /tmp/ck.txt "https://<你的域名>/" | grep -o '__DSH_TRANSPORT__"\] = {[^}]*}'
#   期望 __DSH_TRANSPORT__"] = {"ownsHost":true}
```

作者实测结果（全部通过）：

| 检查项 | 结果 |
|---|---|
| 本地桥接 | 401 ✅ |
| 公网裸访 | 401 ✅ |
| 带 token | 303 ✅ |
| 带 cookie | 200 ✅ |
| `__DSH_TRANSPORT__` | `{"ownsHost":true}` ✅ |
| mobile-polish CSS | 已注入 ✅ |

最后用手机打开那个链接，确认能用。

---

## 8. 日常使用

```bash
# 重启服务（改了配置后）
./scripts/restart.sh

# 看状态
./scripts/polish.sh status

# 关掉排版优化（保留文件，回到原生样式）
./scripts/polish.sh off

# 彻底回滚
./scripts/polish.sh revert

# 停止服务
pkill -f dsh-public-bridge.js
pkill -f "dsh web"
```

**重启后域名会变吗？** 不会。但 **token 每次重启都会重新生成**，
所以要重新看 `/workspace/dsh-公网访问地址.txt`。
已经换到 Cookie 的浏览器不受影响（Cookie 有效期 30 天）。

---

## 9. 为什么必须要有「桥接层」

回到开头说的通用三步法：**起服务 → 拿域名 → 加 `https://` 打开**。
对绝大多数服务来说这就够了，但 dsh 在**第 1 步就会卡住**。

`dsh` 出于安全考虑**主动拒绝绑定 `0.0.0.0`**：

```bash
$ dsh web --host 0.0.0.0
error: --host 0.0.0.0 is intentionally not supported yet for safety:
       it would expose remote code execution to the network; use 127.0.0.1 instead
```

这个设计是对的（dsh 能执行任意 shell 命令，暴露到网络 = 暴露 RCE），
但意味着**你没法直接从手机访问**。

桥接层做的事：**在不破坏这个安全约束的前提下**（dsh 仍然只听 `127.0.0.1`），
用一个中间进程接住公网流量并转发进去。

每一层都对应一个真实踩过的坑：

| 层 | 做什么 | 不这么做会怎样 |
|---|---|---|
| **桥接进程 :3000** | 监听 `0.0.0.0:3000`，转发到 `127.0.0.1:13080` | dsh 拒绝绑 `0.0.0.0`，公网够不着 |
| **Host 头规范化** | 把网关 Host 改成 dsh 期望的域 | dsh 的 `isTrustedApiRequest` 校验失败 → **401 死循环** |
| **`--trusted-host` 注入** | 启动 dsh 时带上公网域名 | `/api` 的 `sec-fetch-site` / `origin` 校验拒绝 → **403** |
| **`__DSH_TRANSPORT__` 注入** | 页面里补一个全局变量 | 前端判定 `isLoopback=false` → **「settings are unavailable in this browser」** |

### 鉴权是怎么工作的

桥接层**完整保留**了 dsh 的原始鉴权，没有做任何绕过：

```
裸访问          → 401  dsh web authentication required;
带 ?token=xxx   → 303  换取 Cookie（有效期 30 天，HttpOnly + SameSite=Strict）
带 Cookie       → 200  正常使用
```

---

## 10. 移动端排版优化

### 为什么需要

`dsh` 官方前端**没有任何响应式断点**（实测主 CSS 里 `@media max-width` 数量为 **0**），
手机上看到的是「桌面布局被压缩」，而不是真正的移动端重排。

官方社区插件 `dsh-mobile` 提供了移动端布局骨架，但排版细节仍偏松散。
本仓库的 `plugins/mobile-polish/` 在其之上做了一层**纯 CSS 排版优化**：

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

### 设计原则：完全可回滚

插件**从不修改 dsh 源码**。启用时自动备份 `profile/package.json`，
`revert` 优先从备份恢复。

回滚验证（实测 7/7 通过）：

| 指标 | 插件态 | 回滚后（原生） |
|---|---|---|
| 表格高 | 75px | 129px |
| 行内代码高 | 17px | 21px |
| 标题间距 | 11/5px | 32/16px |
| 消息列 gap | 4px | 10px |

完整的 12 轮迭代踩坑记录见
[`plugins/mobile-polish/README.md`](plugins/mobile-polish/README.md)。

---

## 11. 仓库结构

```
dsh-public-deploy/
├── README.md                  ← 你正在看的：部署操作手册
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
│   ├── GitHub连接快速参考.md   30 秒修复指南（速查用）
│   └── 安装说明.md            本地安装 dsh 的注意事项
└── icons/                     open-in-app 图标补全资源
```

---

## 12. 常见坑

按踩坑顺序排列，每条都有实测证据。完整版见 [`docs/部署说明.md`](docs/部署说明.md)。

<details>
<summary><b>1. Node v22.13.x 导致 dsh CLI 静默失效</b></summary>

`import.meta.main` 在 v22.13.1 下为 `undefined`，v24.20.0 下为 `true`。
表现是**不报错、不输出**，看起来像卡死。

→ 升级到 Node v24。见[第 2 节](#2-环境要求)。
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

见[第 9 节](#9-为什么必须要有桥接层)。
</details>

<details>
<summary><b>4. 平台注入的 PORT 已被占用</b></summary>

平台会注入 `PORT`（实测为 `8089`），但该端口已被沙箱内置的 `sync_server` 占用，
绑定必然 `EADDRINUSE`。

→ 桥接进程**忽略** `process.env.PORT`，固定用 **3000**。
</details>

<details>
<summary><b>5. 公网 404 / 401 / 403 —— 多层根因</b></summary>

依次排查出：进程模型（平台只代理**直接子进程**监听的端口）、
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
<summary><b>8. 公网域名丢失，链接退化成 127.0.0.1</b></summary>

`restart.sh` 启动桥接时若没传 `DSH_PUBLIC_HOST`，
访问地址会退化成 `http://127.0.0.1:13080/?token=...`（本地链接，手机打不开）。

→ 写进 `.env.public` 即可，重启时自动加载。见[第 5 节](#5-第-3-步拿到你的公网域名)。
</details>

<details>
<summary><b>9. 端口被占用时桥接裸崩溃</b></summary>

`EADDRINUSE` 会抛未捕获的 error 事件，栈信息里只有底层细节，无从下手。

→ 现在会明确告知原因和清理命令：`fuser -k 3000/tcp`
</details>

<details>
<summary><b>10. 沙箱内 GitHub 连不上（DNS 被劫持）</b></summary>

`github.com` / `api.github.com` / `raw.githubusercontent.com` 等**全部**被解析到
`198.18.x.x`（RFC 2544 基准测试保留段，非真实地址）。
向 5 个公共 DNS 直接查询 53 端口返回的也是同一个虚假 IP → **网络层透明劫持**。

**最坑的一点**：此时 `gh auth status` 会报
`The token in GH_TOKEN is invalid.` —— 但 **token 是好的**，
是网络不可达被 `gh` 误报成了认证失败。别急着重发 token。

```bash
./scripts/fix-github-dns.sh          # 一键修复
./scripts/fix-github-dns.sh check    # 检查状态
```

详见 [`docs/沙箱内连接GitHub.md`](docs/沙箱内连接GitHub.md)。
</details>

<details>
<summary><b>11. 重启后 /etc/hosts 被还原</b></summary>

沙箱启动会重置 `/etc/hosts`。官方给的持久化路径 `~/.user_hosts`
在本环境**静默失效**（沙箱默认 `awk` 是 mawk 1.3.4，解析合并用的
嵌套正则直接 panic `ERR_7`，且不中断 init 脚本）。

→ 重启后重新执行 `./scripts/fix-github-dns.sh`。
可挂到 `~/.bashrc.d/` 做自动检查。
</details>

<details>
<summary><b>12. hosts 修好后 curl 通、git 却仍握手失败</b></summary>

`curl https://github.com/` 返回 200，但 `git clone` 报
`gnutls_handshake() failed` —— git 的 TLS 栈比 curl 敏感得多。

→ 必须 `git config --global http.version HTTP/1.1`
（`fix-github-dns.sh` 会自动设置）
</details>

---

## 13. 回滚

**任何改动都可回滚**，这是本仓库的设计原则。

```bash
./scripts/polish.sh revert    # 移动端插件：完全卸载，恢复原生
./scripts/fix-github-dns.sh revert   # 移除 GitHub DNS 修复
```

停止服务：

```bash
pkill -f dsh-public-bridge.js
pkill -f "dsh web"
```

---

## 14. 附录：WorkBuddy 沙箱环境全景

作者实测的环境信息，供对照（**你的值会不同**）：

### 平台身份

| 变量 | 作者环境的值 | 用途 |
|---|---|---|
| `X_IDE_SPACE_KEY` | `9b99622e67154aa9b8593c570ed9ab43` | 网关子域名路由键 |
| `X_IDE_SPACE_REGION` | `bj7` | 区域 |
| `X_IDE_SPACE_HOST` | `sandbox.cloudstudio.club` | 网关主域 |
| `X_IDE_PREVIEW_DOMAIN` | `bj7.sandbox.cloudstudio.club` | 预览域名 |
| `IDE_APP_ACCESS_URL_DOMAIN` | `preview.cloudstudio.work` | 应用访问域 |
| `WORKSPACE_NAMESPACE` | `cs-spacelet-v2-headless...` | K8s 命名空间 |
| `IDE_WORKSPACE_CUSTOM_HOSTS` | `enabled` | 允许自定义 hosts |

### 容器标识（三个值互不相同，别搞混）

| 名称 | 作者环境的值 | 特征 |
|---|---|---|
| **容器内 `hostname`** | `a70a5a91533d`（12 位） | 进程可见，**重启会变**，拼域名会 404 |
| **主入口域名前缀** | `a62504992fd8ed07c`（16 位） | 平台侧稳定标识，**容器重建后仍有效** |
| **`X_IDE_SPACE_KEY`** | `9b99622e67154aa9b8593c570ed9ab43` | 只用于网关子域名路由 |

### 资源

| 变量 | 值 |
|---|---|
| `X_IDE_CPU_LIMIT` | `4` |
| `X_IDE_MEMORY_LIMIT` | `8G` |
| `X_IDE_DISK_QUOTA` | `50G` |
| `X_IDE_GPU_TYPE` | （空） |

### 端口

| 端口 | 占用者 |
|---|---|
| `8089` | 沙箱内置 `sync_server`（**别用**） |
| `65210` | IDE Editor Server |
| `3000` | ← 我们的桥接（**默认**） |
| `13080` | ← dsh 本体（仅 127.0.0.1） |

### 网络

- DNS：`183.60.83.19` / `183.60.82.98`（腾讯云）
- `/etc/hosts` 顺序：`files dns`（files 优先，所以 hosts 覆写有效）
- 内置代理：`SPACE_PROXY_ENDPOINT`、`X_IDE_AUTH_PROXY`
- **GitHub 全域名段被劫持到 `198.18.x.x`**（见坑 10）

---

## 致谢与许可

- **DeepSeek Harness** 版权归 DeepSeek 所有，本仓库仅为部署实践记录，不包含其源码。
- **`dsh-mobile`** 为官方社区插件，本仓库的 `mobile-polish` 是其**补充**而非替代。
- 本仓库内容以 **MIT** 许可发布，可自由使用/修改/分发。

> ⚠️ **安全提醒**：`dsh` 能执行任意 shell 命令。暴露到公网前请确保：
> ① 访问地址带 token 鉴权；② 不要长期开启无鉴权访问；③ 沙箱本身是隔离环境。
> 本仓库的桥接层**完整保留**了 dsh 的原始鉴权逻辑，未做任何绕过。
