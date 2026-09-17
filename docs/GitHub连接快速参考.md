# 沙箱内 GitHub 连接修复 —— 快速参考

> **一句话**：沙箱把 GitHub 全域名段解析到 `198.18.x.x`（虚假 IP），
> 导致 clone/push 全挂，且 `gh auth` 会**误报 token 无效**。跑下面的脚本即可。

## 30 秒修复

```bash
../scripts/fix-github-dns.sh
```

它做两件事（**都必要**）：

1. 把 GitHub 真实 IP 写进 `/etc/hosts`（绕过 DNS 劫持）
2. 设置 `git config --global http.version HTTP/1.1`（绕开 TLS 握手失败）

## 常用命令

| 命令 | 作用 |
|---|---|
| `../scripts/fix-github-dns.sh` | 应用修复 + 自动验证 |
| `../scripts/fix-github-dns.sh check` | 只看状态 |
| `../scripts/fix-github-dns.sh revert` | 移除修复 |

## 三个必须知道的坑

### 坑 1：`gh auth` 说 token 无效，但 token 是好的

```bash
gh auth status
# X The token in GH_TOKEN is invalid.   ← 这是假象！
```

网络不可达被 `gh` 误报成了认证失败。**判别方法**：

```bash
curl -s --resolve api.github.com:443:140.82.121.6 \
  -H "Authorization: Bearer <你的token>" \
  -H "User-Agent: curl" \
  https://api.github.com/user | head -5
```

返回带 `"login": "..."` 的 JSON → **token 有效，别重发**。

### 坑 2：`/etc/hosts` 重启后会被还原

沙箱启动时会重置 `/etc/hosts`。官方给的持久化路径是 `~/.user_hosts`，
但**在本环境静默失效** —— 沙箱默认 `awk` 是 mawk 1.3.4，
解析合并用的嵌套正则直接 panic，且不中断 init 脚本：

```
REcompile() - panic:  parser returns ERR_7
```

→ 重启后需要**重新执行一次** `fix-github-dns.sh`。

已挂自动检查到 `~/.bashrc.d/55-fix-github-dns`，交互式 shell 会自动修复。

### 坑 3：curl 通了但 git 还是握手失败

```
gnutls_handshake() failed: The TLS connection was non-properly terminated.
```

git 的 GnuTLS 栈比 curl 敏感。必须：

```bash
git config --global http.version HTTP/1.1
git config --global http.postBuffer 524288000
```

## IP 会漂移

GitHub 的 IP 并非恒定。批量探测当前可用地址：

```bash
for ip in 140.82.121.3 140.82.112.3 140.82.113.3 140.82.116.3 20.205.243.166; do
  r=$(timeout 6 curl -s -o /dev/null -w "%{http_code}" --resolve github.com:443:$ip https://github.com/)
  echo "  $ip -> $r"
done
```

挑返回 `200` 的，改到 `fix-github-dns.sh` 的 `GITHUB_ENTRIES` 里。

## 当前生效的 IP（2026-09-18 实测）

```
140.82.121.6    api.github.com  codeload.github.com
140.82.121.3    github.com  www.github.com  gist.github.com
185.199.108.133 raw.githubusercontent.com  objects.githubusercontent.com  avatars.githubusercontent.com
```

## 安全提醒

**任何在对话、日志、截图里出现过的 token，都应视为已泄露。**
用完后去 GitHub → Settings → Developer settings → Personal access tokens
吊销并重新生成。

推送时不要用 `https://<TOKEN>@github.com/...` 这种形式（token 会留在命令历史里）。
推完清掉：

```bash
git remote set-url origin https://github.com/<USER>/<REPO>.git
history -c 2>/dev/null
```

## 完整文档

- [`沙箱内连接GitHub.md`](沙箱内连接GitHub.md) —— 完整证据链与排查清单
- 脚本源码：`../scripts/fix-github-dns.sh`
