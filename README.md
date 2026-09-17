# 在 WorkBuddy 沙箱里部署 DeepSeek Harness（公网 HTTPS 可访问）

把 [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh)（`dsh`）
从零装好，跑成**手机能直接打开的 HTTPS 服务**，并附带一套**可回滚的移动端排版优化**。

跟着做，约 30 分钟，你会得到一个和作者环境完全一致的 dsh。

### 起因：原本以为只要三步

在 WorkBuddy 沙箱里暴露一个服务，**通用做法**确实只要三步：

> 1. 起个本地服务，监听 `:3000`（Node、Python、Java，甚至静态文件服务器都行）
> 2. 找到公网域名 `<容器ID>.app.workbuddy.host`
> 3. 拼上 `https://` 直接访问 —— CLB 卸载 HTTPS，`sandbox-proxy` 把请求送到你本地 `:3000`

> **关于第 2 步「怎么找域名」**：网上流传的说法是「在沙箱信息或任务面板里能看到」。
> 作者的实际情况是**从未在任何面板里找过它**——当时是让 AI 助手完成部署，
> 域名是它自己弄出来的。所以本文不写没验证过的 UI 路径，
> 只写**在沙箱内实测可复现**的方法（见 [3.1](#31-主入口域名发布接口分配前缀来自-appname) / [3.2](#32-端口网关域名沙箱内可直接算出)）。
> 下面给出的是**在沙箱内实测可复现**的方法，不依赖任何 UI 入口。

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
│  ① <容器ID>.app.workbuddy.host   ← 前缀推不出 │
│  ② 3000-<SPACE_KEY>.e2b...       ← 环境变量拼 │
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
5. [第 3 步：拿到你的公网域名](#5-第-3-步拿到你的公网域名) ← **最容易卡住的一步，已给出实测方法**
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
| **① 主入口** | `<容器ID>.app.workbuddy.host` | 平台按容器自动分配，**沙箱内推不出前缀** | 固定指向**一个**端口 | 长期（容器重建后仍有效） |
| **② 端口网关** | `<PORT>-<SPACE_KEY>.e2b.<REGION>.sandbox.cloudstudio.club` | **环境变量直接拼**（沙箱内可算出） | **任意端口各自独立映射** | 跟沙箱会话 |

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
> **而端口网关（②）恰好相反**：端口写进子域名里，`3000-` 和 `8081-` 各走各的。
> 这也是为什么**本仓库推荐用 ②**：它在沙箱内就能自己算出来，不需要去任何地方"找"。

> ### 📌 两个域名的前缀，只有一个是你能自己算出来的
>
> | 域名 | 前缀能自己推吗 | 从哪来 |
> |---|---|---|
> | ① `a62504992fd8ed07c.app.workbuddy.host` | ❌ **不能** | 平台侧分配，沙箱环境变量里**没有**它 |
> | ② `3000-9b99622e....e2b.bj7.sandbox.cloudstudio.club` | ✅ **能**，`${X_IDE_SPACE_KEY}` 就在环境变量里 | 直接拼 |
>
> **所以：想让别人照着这篇文档复现，就不要依赖 ①。** 详见 [3.1](#31-主入口域名发布接口分配前缀来自-appname)。

### 关于端口，记住三条

1. **必须监听 `0.0.0.0`**，不能只听 `127.0.0.1`（否则网关够不着）
2. **不要用平台注入的 `PORT` 变量** —— 实测它可能是 `8089`，而该端口被沙箱内置的
   `sync_server` 占用，绑定必然 `EADDRINUSE`。**自己写死 3000**
3. **端口号要和域名里的端口号一致** —— 用端口网关域名时，`3000-xxx.e2b.xxx`
   里的 `3000` 就是你服务监听的端口；用主入口域名时，则必须是它固定映射的那个端口

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

### 最快的办法：一条命令

```bash
cd dsh-public-deploy
./scripts/whereami.sh
```

它会**把三条域名都列出来并实时探测连通性**，作者环境实测输出：

```
────────────────────────────────────────────────
 沙箱公网域名
────────────────────────────────────────────────

【① 主入口域名】发布接口分配，长期有效
  https://a62504992fd8ed07c.app.workbuddy.host/     ✅ 通（服务在线，返回鉴权门）
  https://2100167863587786752.app.workbuddy.host/   ✅ 通（服务在线，返回鉴权门）

【② 端口网关域名】3000 端口，环境变量拼出
  https://3000-9b99622e...e2b.bj7.sandbox.cloudstudio.club/ ✅ 通（服务在线，返回鉴权门）

────────────────────────────────────────────────
 推荐使用：
   https://a62504992fd8ed07c.app.workbuddy.host/
────────────────────────────────────────────────
```

**直接写进配置**（不用手工编辑）：

```bash
./scripts/whereami.sh --write   # 把推荐域名写入 .env.public
./scripts/restart.sh            # 重启让配置生效
```

> 脚本默认按 **3000** 端口探测，换端口用 `./scripts/whereami.sh --port 8080`。

下面解释这两个域名分别是怎么来的，以及**为什么你之前找不到**。

| | 方法 | 怎么拿 | 推荐度 |
|---|---|---|---|
| **3.1** | 主入口域名 `<appName>.app.workbuddy.host` | 读 `/root/.workbuddy-sandbox-publish/state.json` | ⭐⭐⭐⭐ 正式用 |
| **3.2** | 端口网关域名 `<端口>-${X_IDE_SPACE_KEY}.e2b.${X_IDE_SPACE_REGION}.sandbox.cloudstudio.club` | **环境变量一条 `echo`** | ⭐⭐⭐⭐⭐ 调试/兜底 |

---

### 3.1 主入口域名（发布接口分配，前缀来自 `appName`）

形如：

```
https://<appName>.app.workbuddy.host          ← friendly 域名（好记）
https://<runtimeId>.app.workbuddy.host        ← uuid 域名（纯数字，平台自动给）
```

作者环境实测**两个都通**：

```
https://a62504992fd8ed07c.app.workbuddy.host/        -> 401 ✅
https://2100167863587786752.app.workbuddy.host/     -> 401 ✅
```

#### 这个前缀到底从哪来

**不是平台随机分配的，是你发布时自己传的 `appName`。**

沙箱里有个状态文件记录了这一切：

```bash
cat /root/.workbuddy-sandbox-publish/state.json
```

```json
{
  "runtimeId": "2100167863587786752",
  "appName": "a62504992fd8ed07c",
  "lastReleaseId": "1789558190322827706",
  "createdAt": 1789555606223
}
```

对应关系：

| 字段 | 对应域名 |
|---|---|
| `appName` | `a62504992fd8ed07c.app.workbuddy.host`（friendly，发布时可选自定义） |
| `runtimeId` | `2100167863587786752.app.workbuddy.host`（uuid，平台自动生成） |

> ### 📌 所以「域名从哪来」的完整答案是
>
> **平台有一个发布动作**，发布时你可以指定 `appName`（不指定就随机生成一个
> 16 位十六进制串），平台据此在网关层绑定域名。发布结果落在
> `/root/.workbuddy-sandbox-publish/state.json` 里。
>
> 调用的是沙箱内部接口 `artifact-releases`（见本文档附录）。
> **该接口从沙箱外部访问会被拒（`403 path not allowed`）**，只能在发布流程里用。
>
> 换句话说：**`a62504992fd8ed07c` 这个前缀，在环境变量里当然找不到——
> 它是发布参数，不是环境变量。** 它被记在 `state.json` 里。

> ### ⚠️ `hostname` / `X_IDE_SPACE_KEY` 拼不出这个域名
>
> | 猜法 | 实测 |
> |---|---|
> | `a70a5a91533d.app.workbuddy.host`（容器内 `hostname`，12 位） | **404** ❌ |
> | `9b99622e67154aa9b8593c570ed9ab43.app.workbuddy.host`（`X_IDE_SPACE_KEY`） | **404** ❌ |
> | `cs-spacelet-v2-cpu-5cdddf685f-sghl8.app.workbuddy.host`（`POD_NAME`） | **404** ❌ |
>
> `X_IDE_SPACE_KEY` **只用于端口网关域名**（见 3.2），两者是不同子系统。

**拿到域名后写进配置文件**：

```bash
cd dsh-public-deploy
./scripts/whereami.sh --write    # 自动读 state.json 并写入 .env.public
```

或者手工来：

```bash
cp .env.public.example .env.public
APPNAME=$(python3 -c "import json;print(json.load(open('/root/.workbuddy-sandbox-publish/state.json'))['appName'])")
echo "DSH_PUBLIC_HOST=${APPNAME}.app.workbuddy.host" > .env.public
cat .env.public
```

---

### 3.2 端口网关域名（沙箱内可直接算出）

这条规则是**实测确认**的：域名里带端口号，**任意端口各自独立映射**。

```bash
# 一条命令直接算出你的公网域名（假设服务监听 3000）
echo "https://3000-${X_IDE_SPACE_KEY}.e2b.${X_IDE_SPACE_REGION}.sandbox.cloudstudio.club/"
```

作者环境实测：

```
X_IDE_SPACE_KEY    = 9b99622e67154aa9b8593c570ed9ab43
X_IDE_SPACE_REGION = bj7

→ https://3000-9b99622e67154aa9b8593c570ed9ab43.e2b.bj7.sandbox.cloudstudio.club/
→ HTTP 401 ✅（服务已就绪，返回鉴权门）
```

拿到后写进配置：

```bash
cd dsh-public-deploy
cp .env.public.example .env.public

# 注意：只填 host 部分，不含 https:// 和末尾斜杠
echo 'DSH_PUBLIC_HOST=3000-9b99622e67154aa9b8593c570ed9ab43.e2b.bj7.sandbox.cloudstudio.club' > .env.public
```

> **为什么推荐这条**：它**不依赖发布动作**，也不需要任何 UI 入口，
> 沙箱内 `echo` 一下就有。适合临时调试、或发布接口不可用时兜底。

**验证映射是否真的打到了你的服务**：

```bash
# 你的服务在 3000 —— 期望 401
curl -s -o /dev/null -w "3000 -> %{http_code}\n" \
  "https://3000-${X_IDE_SPACE_KEY}.e2b.${X_IDE_SPACE_REGION}.sandbox.cloudstudio.club/"

# 换个没有服务的端口 —— 期望 500/502/404，总之不是 401
curl -s -o /dev/null -w "3001 -> %{http_code}\n" \
  "https://3001-${X_IDE_SPACE_KEY}.e2b.${X_IDE_SPACE_REGION}.sandbox.cloudstudio.club/"
```

#### 两条路的区别

| | 主入口（3.1） | 端口网关（3.2） |
|---|---|---|
| 域名 | `<appName>.app.workbuddy.host` | `<端口>-<SPACE_KEY>.e2b.<REGION>...` |
| 端口 | **固定映射**（写死在发布配置里） | **任意端口各自独立** |
| 依赖 | 需要发布动作 | 不需要，环境变量直接拼 |
| 稳定性 | 长期有效（容器重建仍在） | 跟沙箱会话 |
| 适用 | 正式长期使用 | 调试 / 快速验证 |

---

### 3.3 桥接进程也会自己学

桥接进程支持**运行时学习**：先**不设** `DSH_PUBLIC_HOST` 启动，
然后用任意域名访问它一次，它会把请求头里的 `Host` 记下来并落盘：

```
learned gateway host: 3000-9b99622e...e2b.bj7.sandbox.cloudstudio.club
```

下次 `./scripts/restart.sh` 会自动从 `.known-hosts.json` 里读出来。

> **注意**：这条路需要你**先知道域名才能访问**，所以它只解决「忘了填配置」，
> 不解决「不知道域名」。真要不知道，用 3.1（读 `state.json`）或 3.2（环境变量拼）。

---

## 6. 第 4 步：启动服务

```bash
cd dsh-public-deploy
./scripts/restart.sh
```

> 启动前确认 `.env.public` 里的 `DSH_PUBLIC_HOST` 已经填好（见 [第 5 节](#5-第-3-步拿到你的公网域名)），
> 否则输出的访问链接会退化成 `http://127.0.0.1:13080/...`，手机打不开。

预期输出：

```
==> 公网域名：3000-9b99622e67154aa9b8593c570ed9ab43.e2b.bj7.sandbox.cloudstudio.club
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

> ### 📌 Cookie 是按域名签发的，两个域名互不相通
>
> 实测拿到的 Cookie 内容里写着当前域名：
>
> ```
> set-cookie: dsh-auth-xxxx=...; Max-Age=2592000; HttpOnly; SameSite=Strict
>             └─ payload: {"authority":"3000-9b99622e....e2b.bj7.sandbox.cloudstudio.club"}
> ```
>
> 也就是说：**你在 `a62504992fd8ed07c.app.workbuddy.host` 登录过，
> 不代表 `3000-xxx.e2b.xxx` 也登录了**——后者要再换一次 token。
>
> 作者一开始就被这个绊了一下：拿 A 域名的 Cookie 去打 B 域名，
> 返回的是鉴权页（`mobile-polish` 出现 0 次），一度以为两条链路不等价。
> **用各自域名的 Cookie 重测，两边都是 4 次注入，完全一致。**
>
> 好消息：**token 是同一个**，所以换个域名只是把同一个 `?token=` 链接再打开一次。

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
│   ├── whereami.sh            ★ 找出你的公网域名（并探测连通性）
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

### 容器标识（四个值互不相同，别搞混）

| 名称 | 作者环境的值 | 特征 |
|---|---|---|
| **容器内 `hostname`** | `a70a5a91533d`（12 位） | 进程可见，**重启会变**，拼域名会 404 |
| **主入口域名前缀（`appName`）** | `a62504992fd8ed07c`（16 位） | **发布时指定的参数**，记在 `state.json`，容器重建后仍有效 |
| **`runtimeId`** | `2100167863587786752`（19 位纯数字） | 平台生成的发布 ID，对应 uuid 域名 |
| **`X_IDE_SPACE_KEY`** | `9b99622e67154aa9b8593c570ed9ab43` | 只用于**端口网关子域名**路由，**不用于** `app.workbuddy.host` |
| **`POD_NAME`** | `cs-spacelet-v2-cpu-5cdddf685f-sghl8` | K8s Pod 名，**和上面都无关** |

**这些值互相推不出来**——这是本节最值得记住的一句话。

### 域名来源速查

| 域名 | 沙箱内能否自主获得 | 方法 |
|---|---|---|
| `<appName>.app.workbuddy.host` | ✅ **能** | 读 `/root/.workbuddy-sandbox-publish/state.json` 的 `appName` |
| `<runtimeId>.app.workbuddy.host` | ✅ **能** | 同上文件的 `runtimeId` |
| `3000-<SPACE_KEY>.e2b.<REGION>.sandbox.cloudstudio.club` | ✅ **能** | `echo "https://3000-${X_IDE_SPACE_KEY}.e2b.${X_IDE_SPACE_REGION}.sandbox.cloudstudio.club/"` |
| `preview.cloudstudio.work` 系列 | ⚠️ 能解析，但**未验证能否映射到服务** | 环境变量 `IDE_APP_ACCESS_URL_DOMAIN` 指向它 |
| 平台 API `codingcorp.cloudstudio.net/api` | ❌ 走不通 | 根路径 404，其余 302 跳登录，**无公开查询接口** |

### 发布接口：域名是怎么被绑定的

平台的发布动作会调用沙箱内部接口：

```
POST http://codebuddy.auth-proxy.local/v2/agentos/artifact-releases
```

关键请求字段：

| 字段 | 说明 |
|---|---|
| `runtimeId` | 19 位大整数，**超过 JS `Number.MAX_SAFE_INTEGER`，必须手工拼字符串**，用 `JSON.stringify` 会丢精度 |
| `port` | 要暴露的端口（本仓库用 `3000`） |
| `appName` | **域名前缀就是它**（配合 `useAppNameAsDomain: true`） |
| `persistent` | `true` = 长期有效 |
| `expire` | 有效期（秒），示例 `157680000` ≈ 5 年 |

返回体里域名有两组：

```json
"data": {
  "releaseUrl": "https://<appName>.app.workbuddy.host/",
  "domains": {
    "friendlyDomains": ["<appName>.app.workbuddy.host"],
    "uuidDomains":     ["<runtimeId>.app.workbuddy.host"]
  }
}
```

> ### ⚠️ 这个接口**从沙箱里直接调不通**
>
> 实测 GET / POST 都返回：
>
> ```json
> {"error":{"message":"path not allowed","type":"forbidden","code":403}}
> ```
>
> 它只允许发布流程内部调用。**但发布结果落在**
> `/root/.workbuddy-sandbox-publish/state.json`，**该文件随时可读**——
> 这就是沙箱内获取域名的可靠来源。

### 沙箱出网实测对照

| 域名 | 结果 | 说明 |
|---|---|---|
| `github.com`（修复前） | **198.18.x.x** ❌ | 被劫持，见坑 10 |
| `github.com`（修复后） | 200 ✅ | hosts 覆写后正常 |
| `www.baidu.com` | 200 ✅ | 正常 |
| `mirrors.tencent.com` | 200 ✅ | 正常 |
| `registry.npmjs.org` | 000 ❌ | 不通 |
| `pypi.org` | 000 ❌ | 不通 |
| `codingcorp.cloudstudio.net` | 404 / 302 ⚠️ | DNS 通，无公开接口 |

> 沙箱出网**不是全通**，装依赖优先用国内镜像。


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
