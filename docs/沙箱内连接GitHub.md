# 在沙箱内连接 GitHub

> 适用场景：在**云沙箱 / 容器**里 clone 或 push GitHub 仓库时失败。
> 本文档记录的是一个真实踩坑案例，包含完整证据链与可复用解法。

---

## TL;DR

```bash
cd dsh-public-deploy
./scripts/fix-github-dns.sh          # 一键修复
./scripts/fix-github-dns.sh check    # 检查状态
./scripts/fix-github-dns.sh revert   # 移除修复
```

如果 `git push` 仍报 TLS 错误，加上这两个参数：

```bash
git -c http.version=HTTP/1.1 -c http.postBuffer=524288000 push origin main
```

---

## 症状

在沙箱里执行 Git 操作时，可能出现以下**看似无关**的报错：

| 操作 | 报错 |
|---|---|
| `git clone` / `git push` | `fatal: unable to access '...': GnuTLS recv error (-110): The TLS connection was non-properly terminated` |
| `git push`（首次） | `fatal: could not read Username for 'https://github.com': No such device or address` |
| `gh auth status` | `The token in GH_TOKEN is invalid.` |
| `curl https://api.github.com` | 超时，`http_code=000` |

**最容易误判的一点**：`gh auth status` 说 token 无效，
但 **token 其实是好的** —— 是网络不可达，被 `gh` 误报成了认证失败。

> 怎么确认？用真实 IP 直连 API 试一次（见下文"诊断"第 3 步）。
> 如果返回 200 并带出你的用户名，token 就是有效的，别再重新生成。

---

## 根因

沙箱的 DNS 对 **GitHub 全域名段**做了透明劫持，全部解析到 `198.18.x.x`：

```
github.com                  -> 198.18.0.11
api.github.com              -> 198.18.0.25
codeload.github.com         -> 198.18.0.26
raw.githubusercontent.com   -> 198.18.0.21
objects.githubusercontent.com -> 198.18.0.27
ssh.github.com              -> 198.18.0.28
```

`198.18.0.0/15` 是 **RFC 2544 基准测试保留段**，不可能是 GitHub 的真实地址。

关键判断：**向多个公共 DNS 服务器直接查询 53 端口，返回的也是同一个虚假 IP**：

```
向 8.8.8.8        / 1.1.1.1        / 223.5.5.5
   / 114.114.114.114 / 119.29.29.29 查询 api.github.com
→ 全部返回 198.18.0.25
```

说明这是**网络层的透明劫持**，不是本地 DNS 配置问题——
所以改 `resolv.conf` 没有用，必须用 `/etc/hosts` 覆写。

---

## 诊断

按顺序执行，定位到底卡在哪一层：

**1. 看解析到哪**

```bash
getent hosts api.github.com
# 198.18.0.25  ← 虚假 IP，确认被劫持
```

**2. 排除本地 DNS 配置问题**

```bash
cat /etc/resolv.conf
# nameserver 183.60.83.19   ← 看起来正常，说明问题不在这一层
```

**3. 用真实 IP 直连，验证 token 是否真的有效**

```bash
curl -s --resolve api.github.com:443:140.82.121.6 \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "User-Agent: curl" \
  https://api.github.com/user | head -5
```

返回带 `"login": "..."` 的 JSON → **token 有效，纯网络问题**。

**4. 确认 hosts 优先级**

```bash
grep '^hosts' /etc/nsswitch.conf
# hosts: files dns   ← files 在前，说明改 /etc/hosts 能生效
```

---

## 解法

### 方案 A：`fix-github-dns.sh`（推荐）

仓库自带脚本，把真实 IP 写进 `/etc/hosts` 的**标记块**内（便于干净移除）：

```bash
./scripts/fix-github-dns.sh apply
```

脚本做的事：

1. 删除旧的标记块（幂等，可反复执行）
2. 写入 `# >>> fix-github-dns >>>` ... `# <<< fix-github-dns <<<` 包裹的 IP 映射
3. 自动跑一遍解析 + 连通性检查

写进去的记录：

```
140.82.121.6    api.github.com codeload.github.com
140.82.121.3    github.com www.github.com gist.github.com
185.199.108.133 raw.githubusercontent.com objects.githubusercontent.com avatars.githubusercontent.com
```

### 方案 B：手动写入

```bash
cat >> /etc/hosts <<'EOF'
140.82.121.6    api.github.com
140.82.121.3    github.com
185.199.108.133 raw.githubusercontent.com
EOF
```

---

## 坑：`/etc/hosts` 会在工作区重启后被还原

沙箱的启动脚本会重置 `/etc/hosts`，并在文件末尾写入提示：

```
# Please note that the modification of this file will be automatically restored after the workspace restart
# If you need to keep it, please modify ~/.user_hosts at the same time
```

**官方设计的持久化路径是 `~/.user_hosts`** —— 启动时把它的内容合并进 `/etc/hosts`。

> ⚠️ **但这条路在我们的环境里走不通。**
>
> 合并逻辑依赖一段嵌套很深的 awk 正则：
>
> ```awk
> awk '/^'"$ipRegex"'/{{flag="true";for(i=2;i<=NF;i++){...}}}' ~/.user_hosts
> ```
>
> 而沙箱里 `awk` 指向 **mawk 1.3.4**，解析该正则直接 panic：
>
> ```
> REcompile() - panic:  parser returns ERR_7
> ```
>
> 实测：即使 `~/.user_hosts` 格式完全正确、行数与体积都在限制内
> （要求 `< 50` 行且 `< 10KB`），**条目依然不会被注入 `/etc/hosts`**，
> 而且失败是**静默的**（awk 报错但不中断 init 脚本）。

**所以**：重启后需要**重新执行一次** `fix-github-dns.sh`。

可以放进 `~/.bashrc` 做自动检查：

```bash
echo 'getent hosts github.com | grep -q 198.18 && /workspace/dsh-public-deploy/scripts/fix-github-dns.sh apply' >> ~/.bashrc
```

> `~/.user_hosts` 仍然建议按正确格式填一份（无害），
> 万一将来沙箱把 `awk` 换成 gawk，它就能自动生效了。

---

## 坑：push 时 TLS 连接被掐断

IP 写对之后，小请求（`git ls-remote`、`clone` 小仓库）往往正常，
但 `push` 体积稍大时可能报：

```
GnuTLS recv error (-110): The TLS connection was non-properly terminated
```

这是 git 默认的 HTTP/2 + 大 buffer 在受限网络下不稳导致的。对策：

```bash
git -c http.version=HTTP/1.1 -c http.postBuffer=524288000 push origin main
```

也可以写进 `.git/config` 固化：

```bash
git config http.version HTTP/1.1
git config http.postBuffer 524288000
```

---

## 坑：IP 会漂移，需要多备几个候选

GitHub 的 IP 并非恒定，实测同一时刻**不同 IP 的可用性也不同**：

```
140.82.121.3    -> 200 ✅
140.82.112.3    -> 200 ✅
140.82.116.3    -> 200 ✅
20.205.243.166  -> 200 ✅（但几分钟后变 000）
```

批量探测哪个可用：

```bash
for ip in 140.82.121.3 140.82.112.3 140.82.113.3 140.82.116.3 20.205.243.166; do
  r=$(timeout 6 curl -s -o /dev/null -w "%{http_code}" --resolve github.com:443:$ip https://github.com/ 2>&1)
  echo "  $ip -> $r"
done
```

挑一个返回 `200` 的，改到 `fix-github-dns.sh` 的 `GITHUB_ENTRIES` 里。

---

## 坑：推送用的 token 会留在 shell 历史里

用 `https://<TOKEN>@github.com/...` 这种形式推送时，
**token 会出现在命令历史、进程列表、`git remote -v` 里**。

```bash
# 推完立刻清掉
git remote set-url origin https://github.com/<USER>/<REPO>.git
history -c 2>/dev/null
```

更稳妥的做法是用 `gh` 或 credential helper，
让 token 不进入命令行参数：

```bash
git config credential.helper store
# 或
gh auth login
```

> **安全提醒**：任何在对话、日志、截图里出现过的 token，
> 都应视为**已泄露**，用完后去
> GitHub → Settings → Developer settings → Personal access tokens
> 吊销并重新生成。

---

## 快速排查清单

按顺序过一遍，通常三步内能定位：

| # | 检查 | 命令 | 期望 |
|---|---|---|---|
| 1 | 是否被劫持 | `getent hosts github.com` | 不是 `198.18.x.x` |
| 2 | hosts 是否生效 | `grep '^hosts' /etc/nsswitch.conf` | `files dns`（files 在前） |
| 3 | token 是否有效 | `curl --resolve api.github.com:443:<IP> -H "Authorization: Bearer $T" https://api.github.com/user` | 返回用户 JSON |
| 4 | IP 是否可用 | `curl -s -o /dev/null -w '%{http_code}' https://github.com/` | `200` |
| 5 | push 是否稳定 | 加 `-c http.version=HTTP/1.1` | 成功 |
