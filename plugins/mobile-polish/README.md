# dsh-mobile-polish

DeepSeek Harness Web 端的**移动端排版优化插件**（主题适配层：CSS 注入 + 一处事件补丁）。

- 类型：`webserver/index-inject` 注入插件
- 注入内容：一条 `kind: "style"`（排版样式） + 一条 `kind: "script"`（会话行点击收侧栏，v8 新增）
- 影响范围：**仅前端视觉与一处交互**，不改任何业务逻辑、不改后端、不写数据库
- 断点：默认 `max-width: 720px`（可配置）
- 默认状态：**关闭**（需显式 `enabled: true`）
- 反向开关：环境变量 `DSH_MOBILE_POLISH=0` 可在配置为 `true` 时强制禁用
- 单项开关：`closeDrawerOnSessionPick: false` 或 `DSH_MOBILE_POLISH_DRAWER=0` 只关 JS 补丁
- 当前版本：**v9**（字号 12px / 行高 −2px / 顶栏压缩）

---

## 1. 它解决什么问题

dsh 官方 Web 界面是为**桌面宽屏**设计的，在 381×741 的手机视口下（真机复刻）有几处明显不适配：

| 问题 | 原生表现 | 优化后 |
|---|---|---|
| 消息之间间距过大 | `margin-top: var(--dsh-chat-flow-gap, 16px)` | 变量覆盖为 `6px` |
| **代码被切断** | `word-break: break-all` 把 `list[int]` 切成 `list[in`+`t]` | `white-space: pre` + 横向滚动 |
| **表格溢出** | 宽 389px > 视口 381px，无滚动容器 | 改为可横向滚动 |
| **用户消息块高达 134px** | `dsh-mobile` 插件把时间戳设成 `flex:1 1 100%`+`order:2`，操作行 `flex-wrap:wrap`+`padding:9px` | 覆盖为 `0 0 auto`+`order:0`，操作行 74px→**34px**，整块 134px→**94px** |
| 模型回复无身份标识 | 裸 `<p>`，与用户消息视觉上难以区分 | 左侧 2px 竖线 + 10px 缩进 |
| 气泡过肥 | `padding: 10px 16px` / `border-radius: 22px` | `padding: 8px 14px` / `border-radius: 18px` |
| "Thought for a while" 占位过高 | `margin-bottom` + `padding-bottom` 双重 8px | 收敛为 `padding-bottom: 2px` |
| 操作按钮在触屏上偏小 | 28×28px | 34×34px，圆角 17px |
| 折叠头高度塌陷 | 部分 `flowItem` 计算高度为 0 | `height: auto` 强制撑开 |
| **底部输入区太空旷（v8）** | `composerSeat` 高 **141px**，占 741px 视口 19% | 压到 **125px**，回收 16px |
| **底部统计文字被截断（v8）** | `1 turns 3 steps·86 tok/s` 宽 93 / 内容 116 → 被 ellipsis 吃掉 | **完整显示**（116/116） |
| **点会话后抽屉不收回（v8）** | 会话切换成功但侧栏仍 335px 宽，遮挡内容 | 自动收回至 20px |
| **正文字号偏大（v9）** | 14px（`--dsh-content-font-size`） | **12px** |
| **行高偏松（v9）** | 正文 24px / 气泡 21px | **22px / 19px**（各 −2px） |
| **顶部导航栏过高（v9）** | `header` 76px，占视口 **10%** | **56px**，回收 20px |

---

## 1.1 字号与字体（v9 实测值）

**字体**：系统字体栈，**无自定义字体、不加载任何 webfont**

```
-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
"Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue",
Helvetica, Arial, sans-serif
```

即跟随手机系统字体（Android → Roboto / 思源黑体，iOS → SF Pro + 苹方）。

**字号**（v9 调整后）：

| 位置 | v8 | v9 | 行高 v8 → v9 |
|---|---|---|---|
| 模型回复正文 / markdown | 14px | **12px** | 24 → **22px** |
| 段落 / 列表 / 表格 | 14px | **12px** | 24 → **22px** |
| 用户气泡 | 14px | **12px** | 21 → **19px** |
| 输入框 | 14px | **12px** | 24 → **22px** |
| 代码块 | 12.5px | **12px** | 1.55 → **19px** |
| h1 / h2 / h3 | — | **18 / 16 / 14px** | 26 / 24 / 22px |
| 时间戳 | 11px | 11px（不变） | — |
| 底部统计 | 10px | 10px（不变） | — |

> **注意**：12px 在手机上偏小（iOS/Android 正文舒适区间多为 14~16px）。
> 觉得吃力就把 `--dsh-content-font-size` 改成 `13px`（行高相应改 23px）。

### v9 踩坑：变量定义在 `body` 而不是 `:root`

```js
document.documentElement.getPropertyValue('--dsh-content-font-size')  // → ""（空）
document.body.getPropertyValue('--dsh-content-font-size')             // → "14px"
```

所以**只在 `:root` 设置变量无效** —— `body` 自己有定义，会盖过继承值。
必须 `:root, body` 同时覆盖。

另外行高 `line-height: 24px` 是**硬编码**的、不走变量，必须单独用选择器覆盖。

---

## 2. 安装

```bash
cd /workspace/dsh-public-deploy
./polish.sh on
```

脚本会：

1. 备份 `/root/.dsh/profiles/web/package.json` → `package.json.polish-backup-<时间戳>`
2. 把插件目录同步到 `/root/.dsh/profiles/web/node_modules/dsh-mobile-polish`
3. 幂等注册 `dsh.profile.bundles` 与 `dependencies`
4. 重启 dsh 服务
5. 校验 `__DSH_TRANSPORT__` 注入是否仍然生效

---

## 3. 回滚

**这是本插件最重要的特性 —— 任何一步出错都能一键还原。**

```bash
cd /workspace/dsh-public-deploy

./polish.sh off      # 暂时关闭（保留文件，改 cordis.patch.yml 的 enabled: false）
./polish.sh on       # 重新启用
./polish.sh revert   # 彻底回滚：从最近备份恢复 package.json + 删除插件目录 + 重启
./polish.sh status   # 查看当前状态与备份列表
./polish.sh backup   # 手动打一个备份
```

三层回滚保障：

| 层级 | 手段 | 命令 |
|---|---|---|
| 1. 开关级 | 只改 `enabled: false`，文件全保留 | `./polish.sh off` |
| 2. 配置级 | 从 `package.json.polish-backup-*` 恢复 | `./polish.sh revert` |
| 3. 工作区级 | 插件源码独立在 `plugins/mobile-polish/`，删了 profile 里的副本也不丢 | 手工 `cp` |

`revert` 的实现优先级：**先找最近一次的 `package.json.polish-backup-*` 备份恢复**；若一个备份都没有（理论上不该发生），才退化为"安全摘除"模式（只删 `bundles`/`dependencies` 里的两项，不动其它内容）。

---

## 4. 配置

`cordis.patch.yml`：

```yaml
- insert:
    - id: mobile-polish
      name: dsh-mobile-polish
      config:
        enabled: true      # 总开关
        maxWidth: 720      # 媒体查询断点（px）
        verbose: false     # 是否打印注入日志
```

修改 `maxWidth` 时插件会做字符串替换：把 CSS 里的 `max-width: 720px` 全部换成你的值。

环境变量覆盖（优先级高于配置）：

```bash
DSH_MOBILE_POLISH=0   # 强制禁用（即使 config.enabled: true）
```

---

## 5. 实测数据

**测试环境很重要** —— 早期用 iPhone 390×844 测，漏掉了真机 Android 的问题。以真机复刻视口（**381×741，DPR 2.8375**）为准。

### 5.1 消息间距（v4 修复的核心）

| 指标 | 原生 / 修复前 | 修复后 |
|---|---|---|
| `--dsh-chat-flow-gap` | `16px` | **`10px`** |
| 9 条消息的间距合计 | 128px | **70px**（省 58px） |
| `_scroll` 左右 padding | `16px` | **`12px`** |
| 横向内容宽度 | 315px | **327px** |

### 5.2 代码块（v5 修复）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `white-space` | `pre-wrap` | **`pre`** |
| `word-break` | `break-all` | **`normal`** |
| `overflow-wrap` | `anywhere` | **`normal`** |
| 横向滚动 | 无（内容已折行） | **`scrollW 407 > clientW 315`** |
| 字号 | 11px | **12.5px** |
| padding | 16px | **12px** |
| 代码块高度 | 203px | **179px** |

### 5.3 用户消息区

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 时间戳 flex | `1 1 100%` | **`0 0 auto`** |
| 时间戳 order | `2` | **`0`** |
| 时间戳宽度 | 309 px | **28 px** |
| 操作行高度 | 74 px | **34 px** |
| 操作行 padding | `9px 0` | **`0`** |
| 用户消息块总高 | 134 px | **94 px**（省 40px） |
| 气泡 padding | `10px 16px` | **`8px 14px`** |
| 气泡圆角 | 22px | **`18px`** |

### 5.4 其它

| 指标 | 结果 |
|---|---|
| JS 异常 | 0 |
| 折叠项塌陷（`_flowItem` 高度 0） | 已修复 |
| 表格横向溢出（389px > 381px） | 已改为可滚动 |

---

## 5.5 【重要】测试方法论的教训

前三个版本反复出现「我测是好的、用户说没变」的情况，根因是**测试环境与真实环境不一致**：

| 维度 | 我的早期测试 | 用户真机 | 后果 |
|---|---|---|---|
| 视口 | 390×844 | **381×741** | 布局分支不同 |
| DPR | 2.0 | **2.8375** | 字体渲染差异大 |
| 浏览器 | 无头 Chromium | **Chrome/Android** | flex 计算呈现可能不同 |
| 页面状态 | 侧栏布局（`_column` 宽 260px） | **聊天主体（327px）** | 测的根本不是同一个 DOM |

**教训**：

1. **必须复刻用户的真实视口**（宽度、高度、DPR、UA 全部对齐）。
2. **必须确认测量的是同一个 DOM 状态** —— 我一度测的是移动端侧栏而不是聊天区。
3. **不要相信「computed 值变了就是生效了」** —— 要拉取框架的**原始 CSS** 确认规则来源。
4. **最可靠的验证是让用户看一眼截图**，而不是只贴数字。

获取框架原始 CSS 的方法：

```bash
# 1. 从页面 HTML 里找插件 URL
curl -s -b cookie.txt https://<域名>/ | grep -o '/plugins/[^"]*'

# 2. 拉取 chat 插件的 client.js，里面内嵌了 CSS modules 的源串
curl -s -b cookie.txt 'https://<域名>/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&rev=<rev>' -o chat.js

# 3. 搜索目标类名的原始规则
grep -o 'EvIC1a_column{[^}]*}' chat.js
grep -o '\-\-dsh-chat-[a-z-]*' chat.js | sort -u
```

---

## 6. 实现原理

dsh 的 Web 前端由 `dsh-host-webserver` 提供页面骨架，它在生成 HTML 时会广播 `webserver/index-inject` 事件，插件往里推一条注入记录即可：

```js
ctx.inject(['webServer'], (webCtx) => {
  webCtx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'style', text: css });   // → <style>...</style> 插进 <head>
  });
});
```

支持的 `kind`：`global` / `script` / `script-src` / `script-preload` / `style` / `html`。

本插件只用 `style`，**不注入任何 JavaScript**，因此：

- 不会有 JS 运行时副作用
- 不会与其它插件的事件监听冲突
- 关掉后页面立即恢复原样（刷新即可）

### 6.1 【重要】间距的正确控制方式：覆盖官方 CSS 变量

**这是 v4 才搞明白的事，前三个版本都错了。**

早期版本认为消息间距来自 `_column` 的 `gap`，于是写 `[class*="_column"] { gap: 0 !important }`。在无头 Chromium 下读到 computed `row-gap = 0px`，误以为生效；但真机 Chrome/Android 上用户实测仍是 `gap: 10px`、页面明显空旷。

拉取 `dsh-client-ui-chat/client.js` 里的原始 CSS 后才看清真相：

```css
.EvIC1a_column {
  flex-direction: column; display: flex; width: 100%;
  max-width: var(--dsh-chat-content-width); margin: 0 auto;
}
/* ↑ 这条规则里根本没有 gap */

.EvIC1a_column > :not([hidden]):not(.EvIC1a_flowItem:empty)
               ~ :not([hidden]):not(.EvIC1a_flowItem:empty) {
  margin-top: var(--dsh-chat-flow-gap, 16px);
}
/* ↑ 这才是真正撑开间距的规则：相邻兄弟选择器链 + CSS 变量，默认 16px */
```

**两个结论**：

1. 间距来源是 **`margin-top` + CSS 变量**，不是 `gap`。控制台里看到的 `10px` 是 flex 容器在特定尺寸下的计算呈现，不是可控样式。
2. 那条兄弟选择器优先级高达 `(0,2,2)` 且带多个 `:not`，普通子串选择器打不过它。

**正确做法是直接覆盖官方暴露的语义化变量**，零优先级之争：

```css
:root {
  --dsh-chat-flow-gap: 10px;   /* 原生 16px */
}
```

官方刻意把它做成变量，说明就是留给定制用的。已确认存在的相关变量：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `--dsh-chat-flow-gap` | `16px`（回答段 `8px`） | 消息之间的间距 |
| `--dsh-chat-content-width` | — | 消息列最大宽度 |
| `--dsh-content-font-size` | `14px` | 正文字号 |
| `--dsh-content-font-delta` | `0px` | 字号增量 |

### 6.2 代码块：为什么必须禁用 `break-all`

原生代码块带 `word-break: break-all` + `overflow-wrap: anywhere`。这是「不想出现横向滚动」的妥协，但在 381px 视口下代价太大 —— 它把标识符切碎：

```
def quicksort(arr: list[int]) -> list[in
t]:
    pivot = arr[len(arr) // 2]
                ↓
left = [x for x in arr if x < pivot]
mid  = [x for x in arr if x == pivo
t]
```

v5 改为标准做法：`white-space: pre`（只按 `\n` 换行）+ 容器 `overflow-x: auto`，长行改为可横向滑动，标识符保持完整。同时字号 `11px → 12.5px`、`padding: 16px → 12px`。

**反直觉的结果**：字号加大后代码块**反而更矮了**（203px → 179px），因为不再有硬折行产生的额外行。

### 6.3 【最坑的一个】与 `dsh-mobile` 插件的优先级之争

如果你也装了官方 `dsh-mobile` 插件（移动端适配），**它会和本插件争夺同一批元素**。

**现象**：v6 明明写了正确的规则，运行时却完全不生效 —— 时间戳仍是 `flex: 1 1 100%`、`order: 2`，操作行仍是 `flex-wrap: wrap` + `padding: 9px`。

**误判**：我一度以为那些值来自 dsh 原生样式，去翻 `dsh-client-ui-chat/client.js` 找，结果**一条都找不到**。白花了很多时间。

**真相**：用 CSSOM 扫描才知道，那些规则来自 `dsh-mobile` 插件：

```css
[data-dsh-mobile-center] [class*="_timeStart"] {
  flex: 1 1 100% !important;      /* 优先级 (0,2,0) */
  order: 2 !important;
}
[data-dsh-mobile-center] [class*="_actions"]:has(> [class*="_timeStart"]) {
  flex-wrap: wrap !important;     /* 优先级 (0,2,1) */
  min-height: 28px !important;
}
```

而我的 `[class*="timeStart"]` 只有 **(0,1,0)**。**`!important` 只在同优先级内比大小**，所以我即使写了 `!important` 也压不过它。

**解法**：给自己的选择器加上同样的 `[data-dsh-mobile-center]` 前缀，把优先级提到同一档，靠**加载顺序靠后**取胜：

```css
/* 目标优先级 (0,3,0) > dsh-mobile 的 (0,2,0) */
[data-dsh-mobile-center] [class*="_timeStart"][class],
[data-dsh-mobile-center] [class*="_timeEnd"][class] { ... }
```

**修复效果**：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 时间戳 `flex` | `1 1 100%` | **`0 0 auto`** |
| 时间戳 `order` | `2` | **`0`** |
| 时间戳宽度 | 309px | **28px** |
| `actions` 高度 | 74px | **34px** |
| `userRow` 高度 | 134px | **94px** |
| 单条用户消息 | — | **省 40px** |

> **排查 CSS 覆盖问题的正确姿势**：不要只看 `getComputedStyle`，要**扫遍 CSSOM 找出所有命中该元素的规则及其来源文件**。否则会误判成"原生样式"而把力气花在错误方向 —— 这个坑我踩了整整 4 个版本。

### 6.3.1 【v8 又踩一次】`@media` 与非 `@media` 的 `!important` 平手规则

v8 修 #1（composer 太占高度）时，**同一个坑以更隐蔽的形式又出现了一次**，值得单独记一笔。

**第 1 版**：只写 `[class*="composerStack"] { padding: 0 0 2px 0 !important }`
→ `gap` 生效、`padding` 纹丝不动。原因同 6.3：(0,1,0) 输给 (0,2,0)。

**第 2 版**：加 `[data-dsh-mobile-center]` 前缀，达到 (0,2,0)，理论上平手后靠顺序胜。
用 CDP 的 `CSS.getMatchedStylesForNode` 查看，我的规则**确实排在最后**：

```
[data-dsh-mobile-center] [class*="composerStack"], ...    ← 我的，排最后
    padding-top=0 !important; padding-bottom=2px !important
[data-dsh-mobile-center] [class*="_composer"]
    padding-bottom=max(8px, env(safe-area-inset-bottom)) !important
```

看起来赢定了 —— **但实测 padding 仍是 8px**，`clientHeight === offsetHeight === 133`，说明规则根本没进层叠。

**真正的原因**：

| | 我的规则 | 对手规则 |
|---|---|---|
| 优先级 | (0,2,0) | (0,2,0) |
| `!important` | 是 | 是 |
| **是否在 `@media` 内** | **是** | **否** |

两条**同优先级且都 `!important`** 时，**非 `@media` 的那条胜**（媒体查询不增加优先级，但在层叠排序中 `@media` 内的规则被视为更早）。所以我的规则即使写在最后也翻不过去。

**第 3 版（最终）**：再加一个属性选择器 `[class]`，把优先级抬到 **(0,3,0)**，直接跨过这一档，不再依赖 media / 源码顺序：

```css
[data-dsh-mobile-center] [class*="composerStack"][class],
[data-dsh-mobile-center] [class*="composerSeat"][class] {
  padding: 0 4px !important;
  gap: 2px !important;
}
```

**修复效果**：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| `composerSeat` 高度 | 141px（占视口 19%） | **125px（17%）** |
| `composerSeat` padding | `0px 8px 8px` | **`0px 4px`** |

> **教训升级版**：`CSS.getMatchedStylesForNode` 只回答"**哪些规则匹配了这个元素**"，**不回答"最终谁赢了"**。判断胜负还是得看 `getComputedStyle` + 实际布局尺寸。另外，**`@media` 包裹的 `!important` 规则在平手时是弱势方** —— 这是 6.3 那条教训的补充。

### 6.3.2 【v8 #2】"去掉 ellipsis" 反而更糟：截断不总是由 `text-overflow` 造成

修底部统计文字截断时，第一反应是去掉 `overflow:hidden` + `text-overflow:ellipsis`。结果：

```
修复前: label 宽 93 / 内容 116 → 显示 "1 turns 3 steps ⋯"
错误修复后: overflow:visible, text-overflow:clip → 宽 99 / 内容 116
         → 文字被【静默裁掉】，连省略号都没有了，比原来更糟
```

**真正的根因**：label 是 `flex: 0 1 auto`（**允许收缩**）。容器一行放不下时，它被压缩，而压缩后内容就溢出/被裁。

**正确解法**：让它**拒绝收缩** —— 这才是要害，`overflow` 那些都是表象：

```css
[class*="bOPqQW_label"] {
  flex: 0 0 auto !important;        /* ← 真正生效的一条 */
  min-width: max-content !important;
}
```

**效果**：`93/116` → **`116/116`**；`98/123` → **`123/123`**，两条都完整显示。

> **教训**：看到文字被截断，先问"**是谁在压缩它**"，而不是急着改 `text-overflow`。Flex 容器里答案通常是 `flex-shrink`。

### 6.4 为什么用 `[class*="_bubble"]` 这类子串选择器

dsh 前端用 CSS Modules，类名形如 `Sixlwa_bubble`、`EvIC1a_flowItem` —— **hash 前缀随每次构建变化**（`Sixlwa` → 下次构建可能是别的）。所以只能用属性子串匹配：

```css
[class*="_bubble"] { ... }        /* ✅ 稳定 */
.Sixlwa_bubble { ... }            /* ❌ 下次构建就失效 */
```

代价是选择器优先级较低，因此这些规则都带 `!important`。

> **但注意**：凡是能用 CSS 变量的地方（如间距），优先用变量，不要硬怼选择器 —— 见 6.1。

---

## 6.6 【v9】字号改 12px / 行高 −2px / 顶栏压缩

### 变量在 `body` 不在 `:root`（第一个坑）

```js
document.documentElement → "--dsh-content-font-size" = ""      ← 空
document.body            → "--dsh-content-font-size" = "14px"
```

**只在 `:root` 设变量是无效的** —— `body` 自己有定义，会盖过继承值。必须两个都写：

```css
:root, body {
  --dsh-content-font-size: 12px;
  --dsh-content-font-delta: calc(12px - 14px);   /* delta 也要跟着改 */
}
```

行高 `line-height: 24px` 是**硬编码**、不走变量，必须单独用选择器覆盖。

### 顶栏压缩：又是 `dsh-mobile` 的 `[data-dsh-mobile-header]` 前缀（第二个坑）

**第一版失败**：只写 `[class*="wSkVaW_titleRow"]` (0,1,0)，顶栏只从 76 掉到 65px。
CDP 查出对手：

```css
[data-dsh-mobile-header] [class*="_titleRow"] {   /* (0,2,0) */
  min-height: 32px !important; height: 32px !important;
}
[data-dsh-mobile-header] [class*="_tabs"] {       /* (0,2,0) */
  min-height: 28px !important; height: 28px !important;
}
```

**修法**：加同样前缀 + `[class]` 抬到 **(0,3,0)**，稳赢不依赖顺序：

```css
[data-dsh-mobile-header] [class*="wSkVaW_titleRow"][class],
[data-dsh-mobile-header] [class*="_titleRow"][class] { min-height: 26px !important; height: 26px !important; }
```

> 这是**第三次**踩 `dsh-mobile` 的 `[data-dsh-mobile-*]` 前缀坑（v7 的 `-center`、
> v8 的 `-center`、v9 的 `-header`）。规律：**只要 dsh-mobile 也管这块，它必然用
> 属性前缀把优先级抬到 (0,2,0)**。看到"我写了规则但不生效"，先去 CSSOM / CDP
> 找 `[data-dsh-mobile-` 开头的选择器。

### 还有一个「自己撞自己」

气泡行高实测 18px 而不是设的 19px —— 因为本插件**自己**在另一处写了
`[class*="_bubble"] { line-height: 1.5 }`，12 × 1.5 = 18px，和 v9 的 19px 打架。
已删掉那条，让 v9 独家掌管。

> **教训**：改样式前先 `grep` 自己文件里有没有同族规则，别只盯着外部竞争者。

### 效果

| 指标 | v8 | v9 |
|---|---|---|
| 正文字号 | 14px | **12px** |
| 正文行高 | 24px | **22px** |
| 气泡行高 | 21px | **19px** |
| 输入框行高 | 24px | **22px** |
| `header` 高度 | 76px | **56px** |
| `titleRow` | 32px | **26px** |
| `tabs` | 28px | **24px** |
| 内容可视区 | 665px | **685px（+20px）** |

---

## 6.7 【v10】块间距 16px → 6px —— 一个被忽略了两轮的真正元凶

用户反馈原话：

> 这个行间距怎么这么大？？？？？？现在行间距是多少

### 排查：先量，别猜

第一反应是"行高 22px 太大"（v9 刚改过）。但实测下来发现**行高不是主因**：

```
正文 markdown    字号 12px  行高 22px   比值 1.83
段落 p           字号 12px  行高 22px
列表 li          字号 12px  行高 22px
```

真正的问题在另一处 —— 量兄弟元素间隙：

```
p/当前系统状态摘要  →  p/运行时长        16px
p/运行时长          →  ul/已运行约 2 小时  16px
ul/已运行约 2 小时   →  p/磁盘           16px
p/磁盘              →  ul/根分区         16px
...共 11 处，全部 16px
```

**段落本身只有 22px 高，前后各留 16px。间隙占了行高的 73%。**

### 根因：只压了"消息之间"，没压"消息内部"

回顾 v4 起的做法 —— 一直在覆盖官方变量：

```css
:root, body {
  --dsh-chat-flow-gap: 16px → 6px;   /* 消息与消息之间 */
}
```

从 16px 压到 6px，看着挺彻底。但 `--dsh-chat-flow-gap` **只管 `_flowItem` 之间的节奏**，管不到 `_flowItem` **内部** markdown 段落的 `margin`。

而 markdown 段落间距是 dsh 原生硬编码的 **16px**，两轮迭代（v7、v9）都没人碰过它。

> 教训：**压间距要区分"块间"和"块内"**。只压外层 gap，内层 margin 一点没动，视觉上照样空旷。

### 为什么必须同时改 mt 和 mb

原生用的是**长手**写法：

```css
.md p { margin-top: 16px; margin-bottom: 16px; }
```

相邻两块会触发 **margin collapse（外边距折叠）**，结果是 `max(16, 16) = 16px`，**不是 32px**。

所以如果只改 `margin-top: 6px` 而留 `margin-bottom: 16px`，折叠结果取较大者 **16px** —— 白改。必须两条同时改成 6px，折叠后才是 6px。

### 修法

```css
/* 直接子元素，避免误伤列表项内部嵌套的 p/ul */
[class*="_markdown_"] > * {
  margin-top: 6px !important;
  margin-bottom: 6px !important;
}
/* 首尾不留外部空隙，否则会与 flowItem 的 gap 叠加 */
[class*="_markdown_"] > :first-child { margin-top: 0 !important; }
[class*="_markdown_"] > :last-child  { margin-bottom: 0 !important; }

/* 标题比正文略松以便分段，但远小于原生 16px */
[class*="_markdown_"] h1, ... h6 {
  margin-top: 10px !important;
  margin-bottom: 4px !important;
}
```

### 顺带收行高

虽然行高不是主因，但 12px 字号配 22px（比值 1.83）确实偏松。中文正文舒适区是 1.4~1.6：

| 位置 | v9 | v10 |
|---|---|---|
| 正文行高 | 22px | **18px**（比值 1.50）|
| 气泡行高 | 19px | **16px** |
| 输入框行高 | 22px | **18px** |
| 代码块行高 | 19px | **17px** |
| 消息间距 | 6px | **4px** |

### 实测收益

拿同一段真实内容（12 个块 / 17 行）对比：

| | 计算 | 合计 |
|---|---|---|
| 推算 v9 | 17 行 × 22px + 11 处 × 16px | **550px** |
| 实测 v10 | 17 行 × 18px + 块间距 | **321px** |
| **节省** | | **229px（41.6%）** |

---

## 6.8 【v10 又踩】同文件自己打自己 —— 一个 CSS 反复踩的坑

v10 第一版改完，块间距 11 处全部 6px ✅，但 `hWmORq_body` 行高死活停在 22px ❌。

原因：**同一文件里有两处声明同一个属性**。

```css
/* 文件开头（v10 新增） */
[class*="hWmORq_body"] { line-height: 18px !important; }

/* 文件第 532 行（v9 遗留） */
[class*="hWmORq_body"] { line-height: 22px !important; }   /* ← 后写者胜 */
```

两条选择器**完全相同**、优先级都是 (0,1,0)、都在 `@media` 内 —— **后写的那条赢**。所以开头那条白写。

这是本插件第三次"自己打自己"：

| 版本 | 冲突点 | 表现 |
|---|---|---|
| v9 | `_bubble` 前段 `line-height: 19px` vs 后段 `1.5`（算出 18px）| 气泡行高实测 18px |
| v9 | `hWmORq_body` 前段 vs 后段 22px | 行高不对 |
| v10 | `hWmORq_body` 再次复发 | 开头改的 18px 不生效 |

**定性结论：同一个属性，全文件只能有一处声明。** 跨版本迭代时尤其危险 —— 新规则加在文件开头，老规则还躺在文件中间，两边都以为自己在管。

修法：把文件后段所有 v9 遗留的行高声明全部删掉，只留开头 v10 那一段（标题/代码块除外，因为它们只声明一次）。同时在注释里写明"此属性由 X 段独家掌管"，防止下次又加回来。

> 配套经验：`grep -n "line-height" mobile-polish.css` 可以在改完后 30 秒内发现这类重复。改完行高一定跑一次。

---

## 6.9 【v11】全域压缩 —— 以及一次"压过头"的教训

用户反馈：

> 还是太空旷，在全部压缩

### 做法：先审计，再压

这次不猜了 —— 写了个审计脚本，扫**所有**元素的 `padding / margin / gap / line-height`，
按"占纵向空间"排序：

```
位置                      v10     可压到
─────────────────────────────────────────
段落块间距                 6px  →   3px     11 处 × 6px
标题上间距                10px  →   6px     截图里 5 个标题
用户气泡 padding-y         8px  →   5px     32 → 26px
回复操作行                36px  →  30px
折叠头「N tool calls」     33px  →  24px     竖向堆叠改横向
折叠头「System prompt」    40px  →  26px     min-height 硬撑
输入区整体               125px  → 105px
底部状态行                19px  →  19px
```

### 结果

| 位置 | v10 | v11 | 省 |
|---|---|---|---|
| 段落块间距 | 6px | **3px** | |
| 标题上/下间距 | 10/4px | **6/2px** | |
| 列表缩进 | 18px | **15px** | |
| 正文行高 | 18px | 18px | 已到底 |
| 气泡行高 | 16px | **15px** | |
| 气泡 padding | 8px 14px | **5px 12px** | 7px |
| 顶栏 | 56px | 56px | — |
| 「System prompt」 | 40px | **26px** | 14px |
| 「N tool calls」 | 33px | **24px** | 9px |
| **输入区** | 125px | **105px** | **20px** |
| 消息间距 | 4px | **2px** | |
| **消息列总高** | 1369px | **1082px** | **287px** |

同一段内容（12 块 / 17 行）：**v9 550px → v10 372px → v11 321px**，累计 **−41.6%**。

### ⚠️ 采坑：压过头了 —— "按钮跑到左侧浮空"

v11 中间版本给操作按钮加了一组夹逼：

```css
[class*="xzv4MW_action"] {
  flex: 0 0 28px !important;
  min-width: 28px !important; max-width: 28px !important;
  width: 28px !important; ...
}
```

尺寸确实从 34px 压到 28px 了，但**整排按钮（👍👎🔗）从右侧跑到屏幕左侧浮空**
（截图能明显看到图标散落在左边）。

**根因**：这一排不是普通 flex 子项。它依赖两组**必须配对**的属性：

```css
/* 父容器（第 6 节） */
[class*="xzv4MW_actions"] { justify-content: flex-end !important; flex-wrap: nowrap !important; }
/* 按钮（第 6 节） */
[class*="xzv4MW_action"] { flex: 0 0 auto !important; width: 34px !important; }
```

`justify-content: flex-end` 负责"靠右"，`flex: 0 0 auto` 负责"不伸缩"。
我在 v11 段又插了一层 `flex: 0 0 28px`，`flex-basis` 覆盖了 `width`，
但**父容器的 `flex-end` 因为子项 basis 变化而算错偏移** → 按钮组整体左移。

**修法：整体回滚按钮尺寸的改动，收益让给稳定性。**

```css
/* v11 段最终只留这一层 —— 不碰任何尺寸/flex/对齐属性 */
[class*="TS9iAW_root"] {
  min-height: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}
```

> **教训：压缩布局时，"改尺寸"和"改对齐"是两件事。**
> 只压尺寸不动对齐，通常安全；一旦动了 flex 基准（`flex` / `flex-basis` /
> `justify-content`），就可能把原生的对齐契约打破。
> **判据：改完必须看截图，不能只看数字。** 这次数字全对（28×28 ✅），
> 但视觉是坏的 —— 如果只信 `getBoundingClientRect` 就会漏掉。

### 又一例：探测脚本自身的坑

排查时 `check-layout.py` 报"按钮 x=16（左侧）"，而 `probe-btn.py` 报"x=321（右侧）"。
**两者都没错** —— 前者遍历了页面上全部 flowItem，包括**滚动到屏幕外**的那些，
抓到了不可见元素；后者只查了第一个 `xzv4MW_actions`。

**修法**：过滤条件补上 `if (r.bottom < 0 || r.top > vh) continue;`。

> **教训：DOM 查询要限定"可见视口内"**，否则会拿到假阳性。
> 同理，之前测「底部文字截断」时也踩过 —— 页面滚到底部前的元素宽度不可信。

---

## 6.10 【v12】零高占位块的白吃间隙 —— "工具调用"与"回复正文"之间那块空洞

### 现场

v11 之后用户又发来一张真机截图，圈了两处：

1. **「工具调用」块和「回复正文」之间空了一大块**（视觉上约 40~50px）
2. **时间戳 `01:49` 单独占了一行**，看着很浪费

同时问："我能用 32g？容器内存应该没有这么大吧"（截图里工具调用头显示 `32g`）。

### 第一步：审计脚本又漏了

沿用 v11 的审计脚本（按纵向占位排序），结果里**根本没有异常项** —— 所有显式间距
都已经压到 2~3px。于是换了思路，写 `diag-gap.py` 直接量：

- 消息列里 14 个 `flowItem` 各自前面的**真实间隙**（相邻块 rect 相减）
- 用户消息内部的子块结构
- 「工具调用」块到「回复正文」块之间的**净空**

结果第一条线索出来了：14 个 `flowItem` 的前间隙**从 10px 到 18px 不等**，
而 CSS 里我明明把 `--dsh-chat-flow-gap` 设成了 `2px`。

### 第二步：找"谁在吃间距"

写 `probe-zeroh.py`，把消息列直接子元素**逐个打印**（不按高度筛）。
这才看到真相 —— 消息列里夹着 **3 个高度为 0 的块**：

```
flowItem  h=0   cls=EvIC1a_spacer / EvIC1a_flowItem  margin-top=0 margin-bottom=0
flowItem  h=0   cls=EvIC1a_spacer / EvIC1a_flowItem  margin-top=0 margin-bottom=0
flowItem  h=0   cls=EvIC1a_spacer / EvIC1a_flowItem  margin-top=0 margin-bottom=0
```

**它们的 `margin` 全是 0** —— 我最初的判断（"零高块白吃 margin"）是错的。

我上一轮之所以两遍都漏掉它们，是因为审计脚本有个过滤条件 `if (height > 30)`。
**零高节点被整体过滤，从未进入视野。**

再查父容器：

```js
getComputedStyle(column)  // { display: "flex", flexDirection: "column", gap: "10px" }
```

### 第三步：真凶 = flex `gap`，且它对零高子项照样生效

```css
[data-dsh-mobile-message-column] { gap: 10px; }   /* dsh-mobile 原生 */
```

`column-gap`/`gap` 在 flex 布局里是**按子项数量**分配空隙的，**跟子项高度无关**。
所以 3 个零高块 → 夹出 4 道间隙 → 4 × 10px = **40px 纯浪费的空洞**。

> **反直觉点**：`height: 0` 的元素在 flex 容器里**不是隐形的**。
> 只要它是 flex item，就照样触发一道 `gap`。
> 想通过"给零高块设 margin: 0"来省空间 —— 无效，因为 gap 跟 margin 不是一个机制。

### 第四步：又踩 `dsh-mobile` 属性前缀坑（第 5 次）

第一版改法：

```css
[class*="EvIC1a_column"] { gap: 4px !important; }
```

**没生效**。用 CDP `CSS.getMatchedStylesForNode` 查：

```
[data-dsh-mobile-message-column] { gap: 10px }     ← 胜出
[class*="EvIC1a_column"]         { gap: 4px !important }
```

两条都是 (0,1,0)，**我又是后写者却输了** —— 原因是 `dsh-mobile` 插在更靠后的
样式表位置（第 5 次栽在同一个坑上：v7 / v8 / v9 / v11 / v12）。

**修法**：加同前缀 + `[class]` 抬到 (0,2,0)。

```css
/* 【v12-1】零高占位块：真凶是 flex gap，不是 margin */
[data-dsh-mobile-message-column] [class*="EvIC1a_column"][class],
[data-dsh-mobile-message-column] [class*="_column"][class],
[class*="EvIC1a_column"][class],
[class*="_column"][class] {
  gap: 4px !important;
}
```

复测：`{"gap": "4px", "rowGap": "4px", "display": "flex"}`，
14 个 `flowItem` 前间隙**统一 4px**。

### 第五步：顺手清掉零高块自身的 margin

虽然实测是 0，但上游若变了就白吃，所以显式归零兜底：

```css
[class*="EvIC1a_column"] > [class*="EvIC1a_flowItem"],
[class*="_column"] > [class*="_flowItem"] {
  margin-top: 0 !important;
  margin-bottom: 0 !important;
}
/* 【v12-2】正文块 mt 归零 */
[class*="_flowItem"][data-turn-process-answer],
[class*="_flowItem"]:has([class*="hWmORq_root"]) {
  margin-top: 0 !important;
}
```

### 第六步：时间戳那行 —— 它其实是"操作栏的搭便车乘客"

关于"`01:49` 为什么单独占一行"，答案在 DOM 结构里：

```
flowItem  h=36px    ← 助手回复底部的「操作栏」flowItem
  ├── xzv4MW_timeStart   28 × 11px   ← 时间戳（搭便车）
  └── xzv4MW_actions     34px 高     ← 👍👎🔗 三个按钮
```

也就是说，**这一行的高度由 34px 的操作按钮决定，不是时间戳撑的**。
时间戳（11px）只是一个瘦小的兄弟节点挤在 36px 行里。
把它拿出来渲染成独立小行，反而**更省**（11px < 36px），但那是结构性改动，收益不稳，
所以本次只做去 `margin-top`：

```css
/* 【v12-3】底部时间戳块 */
[class*="TS9iAW_root"],
[class*="xzv4MW_root"] {
  margin-top: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}
[class*="xzv4MW_timeStart"],
[class*="xzv4MW_timeEnd"] {
  align-self: center !important;
  line-height: 1 !important;
}
```

> 关于 `32g`：那是**宿主机总内存**的显示值（dsh 状态栏读的是 `/proc/meminfo`），
> 容器 cgroup 限额远小于此。属显示口径问题，非布局问题。

### 结果

| 指标 | v11 | v12 | 省 |
|---|---|---|---|
| 消息列 gap | 10px | **4px** | 6px × 4 道 |
| 「工具调用 → 正文」空档 | 约 48px | **约 20px** | **≈28px** |
| 14 个 flowItem 前间隙 | 10~18px 不等 | **统一 4px** | 收敛 |
| 操作栏 `margin-top` | 2px | 0 | 2px |

### 回归 + 回滚

```
列 gap    : 4px
侧栏宽    : 20px          ✅
抽屉补丁  : true          ✅
底部 label: 116/116       ✅
块间距    : [3,3,3,3]     ✅
输入区    : 105px         ✅
JS 异常   : 0             ✅
```

`./polish.sh revert` 回滚验证 **5/5 通过**（列 gap 回 10px / 行高回 24px /
块间距回 16px / 折叠头回 40px / 插件痕迹清零），随后 `./polish.sh on` 重新启用。

> **教训三则**：
> 1. **按高度筛元素会漏掉零高但有副作用的节点** —— 审计脚本必须"打印全部子元素"，
>    而不是"打印够大的子元素"。
> 2. **flex `gap` 与子项高度无关** —— 零高 flex item 照样吃 gap，这是排查空洞时
>    最容易被忽略的一条。
> 3. **`dsh-mobile` 前缀坑第 5 次复发** —— 只要目标区域 dsh-mobile 也管，
>    无脑加 `[data-dsh-mobile-*] ` + `[class]`，别再赌优先级。

---

## 6.11 【v13-B】时间戳不再独占一行 —— 一次"只看容器高、没看内部行数"的误判

### 现场

v12 汇报后用户追问：

> **那你这时间还是另外占用了一行啊**

我在 v12 的解释是：

> 这一行的高度由 34px 的操作按钮决定，不是时间戳撑的。时间戳（11px）
> 只是一个瘦小的兄弟节点挤在 36px 行里。

**这个解释不完整，漏掉了最关键的一点：容器内部其实折成了 3 行。**

### 真正的结构

量 `xzv4MW_actions` 容器内部**每个子项的 y 坐标**（不是只看容器高度）：

```
xzv4MW_actions   w=327px   display:flex   flex-wrap:wrap   justify-content:flex-end
  ├─ 按钮 ×6    34×34   y=576   ← 第 1 行
  ├─ Q51KRG     34×34   y=576   ← 第 1 行
  └─ timeEnd    28×11   y=588   ← 第 3 行   ★ 被 flex 折行挤下来的
实际行数 = 3
```

**6 个 34px 按钮（204px）+ 间距（30px）+ 时间戳（28px）在 327px 里装不下**，
`flex-wrap: wrap` 把时间戳挤到了独立的一行 —— 这才是"时间占一行"的真因。

另外 `TS9iAW_root` 上还有个 `gap: 16px`，但它只有 1 个真实子元素，纯冗余。

> **教训：判断"某元素占了多少空间"，不能只看它的 `height`，
> 必须看它内部子项的 y 坐标分布（即真实行数）。**
> v12 就是栽在"容器 36px → 按钮 34px → 得出结论"这条推理链上，
> 漏掉了"容器内部折行"这个维度。

### 方案 B（用户选定）：只让时间戳归位，不碰按钮尺寸

用户明确选择保按钮 34px 触摸区不动：

```css
/* 1. 禁止折行 —— 时间戳不再被挤到下一行（关键） */
[class*="xzv4MW_actions"], [class*="TS9iAW_actions"] {
  flex-wrap: nowrap !important;
}
/* 2. root 冗余 gap 归零 */
[class*="TS9iAW_root"], [class*="xzv4MW_root"] {
  gap: 0 !important; margin-top: 0 !important;
  padding-top: 0 !important; padding-bottom: 0 !important;
}
/* 3. 时间戳移到最左 + margin-right:auto 撑出左右分区 */
[class*="timeStart"], [class*="timeEnd"] {
  order: -1 !important;
  margin-right: auto !important;
  flex: 0 0 auto !important;
  align-self: center !important;
}
```

### 实测结果

| 指标 | 改前 | 改后 |
|---|---|---|
| 内部**实际行数** | **3 行** | **1 行** ✅ |
| 时间戳位置 | x=315（独立行） | **x=16（最左）** ✅ |
| 时间戳 `order` | `0` | **`-1`** ✅ |
| 时间戳 `margin-right` | `0px` | **`59.47px`** ✅ |
| 按钮尺寸 | 34×34 | **34×34（未变）** ✅ |
| 按钮最左 / 最右 | — | 109 / **343（仍靠右）** ✅ |
| 操作栏高度 | 36px | 36px（方案 B 不压高度） |

### ⚠️ 与 v11「按钮跑到左侧浮空」的区别

同样动了 flex 相关属性，为什么这次没坏？

| | v11（失败） | v13-B（成功） |
|---|---|---|
| 改了什么 | 按钮加 `flex: 0 0 28px` | 容器加 `nowrap` + 时间戳 `order/margin` |
| 后果 | `flex-basis` 覆盖 `width`，父容器 `flex-end` 算错偏移 → 按钮组左移 | 按钮属性未动，对齐契约完好 |
| 判据 | **动了子项的 `flex` 基准** | **只动容器的换行策略 + 排序** |

> **结论：动子项的 `flex`/`flex-basis` 会破坏与父容器 `justify-content` 的配对；
> 动容器的 `flex-wrap` + 子项的 `order` 则安全。**

### 一处"自己打自己"的预防

第 6 节原有一条时间戳声明写了 `order: 0 !important`，优先级 (0,3,0)，
**必然压过**我在 v13-B 段新写的 (0,1,0) 规则。这不是 bug 而是必然的覆盖关系，
所以**直接把第 6 节的 `order` 改成 `-1`**，并在 v13-B 段加注释标明声明分工：

```
· root 的 gap / margin / padding   → v13-B 段（唯一声明点）
· actions 的 flex-wrap: nowrap     → v13-B 段（唯一声明点）
· 时间戳的 order / flex / margin   → 第 6 节（唯一声明点）
```

> 这是"同文件重复声明"坑的**预防性处理** —— 前 5 次都是事后才发现覆盖关系，
> 这次先查了优先级再动手。

### 回归 + 回滚

```
列gap 4px ✅ | 侧栏宽 20px ✅ | 抽屉补丁 true ✅
底部 label 116/116 ✅ | 块间距 [3,3,3,3] ✅ | 输入区 105px ✅ | JS 异常 0 ✅
```

`./polish.sh revert` 回滚验证 **6/6 通过**，全部恢复到 dsh 原生值：

| 指标 | 插件态 | 回滚后（原生） |
|---|---|---|
| 操作栏高 | 36px | 54px |
| 时间戳 `order` | −1 | 2 |
| 时间戳宽 | 28px | 351px（`flex:1 1 100%` 独占一行） |
| 时间戳同行 | true | false |
| 按钮尺寸 | 34×34 | 28×28 |
| 列 gap | 4px | 10px |
| 消息列块高 | [26,61,24,…] | [40,98,41,…] |

---

## 6.12 【v14】markdown 正文排版优化 —— 一次 `display: inline` 反而更差的教训

### 现场

用户：「md 回复正文格式能不能优化，这个格式好丑」。

造了一篇含全要素（h1~h3 / 有序无序列表 / 加粗斜体 / 行内代码 / 代码块 /
引用块 / 表格 / 分割线）的回复，实测出 6 处问题：

| 元素 | 改前实测 | 问题 |
|---|---|---|
| H3 标题 | lh20，mt6 mb2 | 与正文仅隔 2px → **像加粗正文，无层级感** |
| **行内 code** | **`display:inline-flex`，h=23px**，lh19px | **比正文行高 18px 还高 → 撑高整行、把句号挤下去成孤字** |
| 代码块容器 | 128px，其中 header 占 **46px** | header 空档过大 |
| 代码块 pre | lh **19.375px** | 非整数行高，渲染发虚 |
| blockquote | pl 14px | 比列表缩进小，不统一 |
| 表格行 | h **39px** | 行高过大，表格很空 |

### 最有价值的一处：行内代码

**关键发现**：原生行内 `code` 是 `display: inline-flex`，**高 23px**，
而正文行高只有 18px —— 它把整行撑高，导致末尾的「。」被挤到下一行形成孤字。

**A/B/C 三方案隔离实测**（每轮独立开 context，避免互相污染）：

| 方案 | 代码高 | 代码宽 | 判定 |
|---|---|---|---|
| 改前 `inline-flex` | 23px | 81px | ← 撑高整行 |
| A: `display: inline` | **34px** | **296px** | ❌ **更差！** |
| **B: `inline-block` + `vertical-align: middle`** | **17px** | **83px** | ✅ **最优** |
| C: `inline` + `padding: 0` | 32px | 296px | ❌ 更差 |

> **为什么 A/C 反而更差**：`display: inline` 会让元素变成匿名行内盒，
> **盒子塌陷后宽度变成整行 296px（撑满）**，高度算成内容盒 34px。
> **只有 `display: inline-block` 能同时约束宽高。**
>
> **教训：`inline` 和 `inline-block` 在 flex 语境下行为完全不同，别想当然。**
> 我第一版就是直接写 `display: inline`，结果盒子塌陷撑满整行，
> 比原生还难看 —— 如果不是做了三方案对比，就会把「优化」做成「劣化」。

### 其余 5 处

```css
/* ① 标题层级感：mt6/mb2 → mt11/mb5 */
[class*="_markdown_"] h1, … h6 { margin: 11px 0 5px !important; }

/* ② 代码块 header 瘦身 + pre 行高取整 */
[class*="md-code-block"] { padding: 0 !important; overflow: hidden !important; }
[class*="md-code-block"] > div:first-child:not([class*="content"]) {
  padding: 4px 10px !important; min-height: 0 !important;
}
[class*="_markdown_"] pre { padding: 8px 10px !important; border-radius: 0 !important; }
[class*="_markdown_"] pre code { font-size: 11.5px !important; line-height: 18px !important; }

/* ③ 列表缩进 15 → 18px */
/* ④ 引用块 padding 3px 0 3px 10px */
/* ⑤ 表格 th/td：padding 4px 8px，行高 39 → 25px */
```

### 结果

| 指标 | 改前 | 改后 | 省 |
|---|---|---|---|
| 行内代码高 | 23px | **17px** | 6px |
| 行内代码行高 | 19px | **13px** | 6px |
| 代码块高 | 128px | **126px** | 2px |
| 代码块 pre 行高 | 19.375px | **18px** | 渲染更锐利 |
| **表格高** | **117px** | **75px** | **42px** |
| 表格行高 | 39px | **25px** | 14px |
| H3 间距 | 6/2px | **11/5px** | −8px（**刻意加回**） |

> **注意**：标题间距是**唯一一处主动加大的** —— v11 曾把它压到 mb2，
> 结果标题和下文糊在一起。**该省的是段落之间的冗余，不是标题的呼吸空间。**
> 所以 md 总高从 670px 略增到 680px，这是**有意的取舍**。

### 回归 + 回滚

```
列gap 4px ✅ | 侧栏宽 20px ✅ | 抽屉补丁 true ✅
底部 label 116/116 ✅ | 输入区 105px ✅ | JS 异常 0 ✅
```

（「块间距」由 [3,3,3,3] 变为 [11,5,11,5] —— 探针扫到的是 h3，
这正是 v14-1 的预期改动，非回归。）

`./polish.sh revert` 回滚验证 **7/7 通过**：

| 指标 | v14 态 | 回滚后（原生） |
|---|---|---|
| 代码块高 | 126px | 125px |
| 表格高 | 75px | **129px** |
| 表首行高 | 25px | **43px** |
| 行内代码高 | 17px | **21px** |
| 行内代码行高 | 13px | **19px** |
| H3 间距 | 11/5px | **32/16px** |
| md 总高 | 680px | **1054px** |

---

## 7. 已知限制

1. **只覆盖了聊天消息区 + 底部输入区**。侧边栏、设置面板、插件面板等未做移动端适配。
2. **不改变布局结构**。原生把时间戳和时间放在 `xzv4MW_actions` 容器里，只能靠 flex 顺序调整（`order: -1`）让它出现在气泡左侧，无法真正"移进气泡内"。
3. **依赖 hash 类名的子串**。若上游大改类名命名规则（例如去掉下划线前缀），选择器会失配 —— 此时样式**静默失效**，不会报错，页面回落到原生样式。
4. **`color-mix()` 需要较新浏览器**。Safari < 16.2 / Chrome < 111 不支持，竖线颜色会回落到默认（不影响布局）。
5. **v8 的 JS 补丁依赖 dsh 原生侧栏结构**。见 6.5 —— 若上游改成渲染 `.dshm-drawer`，补丁会自动让位（它检测到侧栏已收起就不动作），但届时原生 handler 本就生效，无需本补丁。
6. **不处理 `xdg-open` 相关功能**（打开文件 / 打开配置文件）。沙箱无桌面环境，属环境限制，非前端问题。
7. **【v12 新发现】滚动到底部时，悬浮的「⌄ 回到底部」按钮会与输入框、时间戳视觉重叠**。该按钮是原生绝对定位元素，此前被宽松的行间距"藏"住了；v12 压紧间距后它显露出来。属原生层级/z-index 设计问题，本插件不改结构，暂不处理。

---

## 6.5 【v8 #5】会话列表点击后抽屉不收回 —— 一个"handler 从未挂载"的 bug

这是本插件唯一的 JS 注入，也是最有意思的一个排查。

### 现象

点侧栏里的会话 → **会话确实切换了**，但侧栏不收回，仍占 335px 宽，把内容挡住。必须再点一次遮罩才能关。

### 排查过程

**第一步：确认真的没收回**（不是视觉错觉）

```js
// 展开侧栏 → 真实点击第 1 行会话
展开后 : {w: 335, collapsed: false, selected: "New Session"}
点击后 : {w: 335, collapsed: false, selected: "编写快速排序函数"}
//                              ↑ 会话切了     ↑ 宽度没变 = 确认复现
```

**第二步：找 dsh-mobile 的意图实现** —— 它**本来就写了**这个功能：

```js
// dsh-mobile/lib/mobile-layout.js:357
const closeDrawerAfterSessionAction = (event) => {
  if (viewportIsWide()) return;
  const row = event.target.closest('[role="treeitem"][aria-selected]');
  ...
  props.controller.closeSidebar();
};
// 挂在：<aside className="dshm-drawer" onClickCapture={closeDrawerAfterSessionAction}>
```

**第三步：为什么没生效？** 探测那个宿主的渲染数量：

```js
document.querySelectorAll('.dshm-drawer').length   // → 0
```

**关键发现：`.dshm-drawer` 在 DOM 中从未渲染。** handler 绑在一个不存在的元素上，等于没绑。

侧栏实际由 dsh 原生组件渲染，dsh-mobile 只负责**改样式**：

```html
<div data-dsh-mobile-sidebar data-open="true|false">     ← 原生控制状态
  <div class="hHd-Xa_root" data-dsh-mobile-sidebar-root>  ← 宽 335 / 收起 20
```

**第四步：确认关闭通路本身是好的** —— 点原生遮罩是有效的：

```js
// 点击 .dsh-native-mobile-backdrop 右缘
点击前: {rootW: 335, hostOpen: "true"}
点击后: {rootW:  20, hostOpen: "false"}    // ✅ 正常关闭
```

所以**不是关闭坏了，而是"点会话行"这条捷径没人接**。

### 解法

**不去自己改 React 状态**（容易和 React 打架），而是**复用原生遮罩的点击效果**：

```js
document.addEventListener('click', (event) => {
  if (viewportIsWide()) return;                    // 宽屏不管
  if (!isSidebarOpen()) return;
  const row = event.target.closest('[role="treeitem"][aria-selected]');
  if (row === null) return;                        // 与原生判定一致
  const action = event.target.closest('button,[role="button"]');
  if (action !== null && action !== row) return;   // 行内按钮不触发
  setTimeout(closeSidebar, 0);                     // 让 React 先切会话
}, true);                                          // capture 阶段

function closeSidebar() {
  const backdrop = document.querySelector('.dsh-native-mobile-backdrop');
  if (backdrop && !backdrop.hasAttribute('hidden')) {
    backdrop.click();                              // 首选：走官方通路
    setTimeout(() => { if (isSidebarOpen()) fallbackClose(); }, 120);
    return;
  }
  fallbackClose();                                 // 兜底：直接改 data-open
}
```

几个设计取舍：

| 决定 | 原因 |
|---|---|
| 用 capture 阶段 | 保证在行自己的 `onClick` 之前记录意图，避免竞争 |
| `setTimeout(0)` 再收 | 让 React 先完成会话切换，否则会出现"侧栏收了但会话没切" |
| 首选 `backdrop.click()` | 等价于用户手点遮罩，走 React 官方通路，不会状态错乱 |
| 保留 `data-open` 兜底 | 万一遮罩 DOM 变了，至少还能降级生效；直接改 DOM 是次优但比不做好 |
| 整段 `try/catch` | 任何异常都不该影响页面主流程 |
| 幂等守卫 `__dshmPolishDrawerPatched` | 防止重复注入时绑多份监听 |

### 验证结果

```
展开后 : {"宽": 335, "hostOpen": "true",  "补丁已装": true}
点击后 : {"宽":  20, "hostOpen": "false", "补丁已装": true}   ✅
```

### 回滚

```yaml
# cordis.patch.yml
closeDrawerOnSessionPick: false     # 只关这一项，样式优化不受影响
```

或临时：`DSH_MOBILE_POLISH_DRAWER=0`

---

## 8. 验证是否生效

浏览器控制台：

```js
// 1. 样式是否注入
[...document.querySelectorAll('style')]
  .filter(s => s.textContent.includes('_flowItem'))
  .map(s => s.textContent.length);        // 应输出 [21168] 左右

// 2. 时间戳是否被压扁
getComputedStyle(document.querySelector('[class*="timeStart"]')).flex;
// → "0 0 auto"   （原生是 "0 1 auto"，桌面宽屏下是 "1 1 100%"）

// 3. 消息列 gap 是否归零
getComputedStyle(document.querySelector('[class*="_column"]')).rowGap;
// → "0px"

// 4. 【v8】底部统计文字是否完整（不应有截断）
[...document.querySelectorAll('[class*="bOPqQW_label"]')]
  .map(e => ({文字: e.innerText, 宽: Math.round(e.getBoundingClientRect().width),
              内容: e.scrollWidth, 完整: e.scrollWidth <= e.getBoundingClientRect().width + 1}));
// → 每项 完整: true

// 5. 【v8】底部输入区高度（应 <= 130）
Math.round(document.querySelector('[class*="composerSeat"]').getBoundingClientRect().height);

// 6. 【v8】JS 补丁是否装载
window.__dshmPolishDrawerPatched;   // → true
```

命令行整体自检：

```bash
cd /workspace/dsh-public-deploy && ./scripts/polish.sh status
```

---

## 9. 卸载

```bash
cd /workspace/dsh-public-deploy && ./scripts/polish.sh revert
```

插件源码目录 `plugins/mobile-polish/` 不会被删除，需要彻底清理时手动 `rm -rf`。
