// DeepSeek Harness 公网发布常驻进程
//
// 设计背景（三条硬约束，缺一即失败）：
//  1) dsh 官方禁止 --host 0.0.0.0（"would expose remote code execution to the network"），
//     只能绑 127.0.0.1，故由本进程在 0.0.0.0:PORT 承接外部流量。
//  2) 平台只代理「自启动命令直接子进程」监听的端口，脚本内 `&` fork 的后台进程不被代理，
//     因此本进程必须前台常驻，dsh 作为它的子进程。
//  3) 必须原样透传 Host 头。dsh 的 browser-session cookie 以 Host（authority）绑定，
//     若改写为 127.0.0.1:xxx，公网域名下的 cookie 永远校验失败 → 401 死循环。
//
// 平台链路：公网域名（CLB 做 TLS 终止）→ 沙箱网关 → 本地端口。
// 网关转发时会把 Host 改写成沙箱内部域名：
//     <PORT>-<SPACE_KEY>.e2b.<REGION>.sandbox.cloudstudio.club
// dsh 的 /api 有一道 browser-trust fence，按 Host 比对 trustedHosts，不匹配直接 403。
// 该 SPACE_KEY 与进程环境变量 X_IDE_SPACE_KEY 并不一致（平台可能注入预热实例的 ID），
// 因此无法静态推导 —— 改为运行时从首个到达的请求上学习。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 对外端口：平台自启动时会注入 PORT=8089，但该端口已被沙箱内置的 sync_server 占用，
// 绑定必然 EADDRINUSE。因此这里忽略平台注入的 PORT，固定使用 3000
// （发布时 --port 也声明为 3000，网关按 <port>-<SPACE_KEY> 子域名路由，两者必须一致）。
const PORT = parseInt(process.env.DSH_PUBLIC_PORT || '3000', 10);
const DSH_PORT = parseInt(process.env.DSH_INNER_PORT || '13080', 10);
const DSH_HOST = '127.0.0.1';

// ── Node 运行时定位 ───────────────────────────────────────────────────────
// ⚠️ 实测踩坑：dsh 内部使用 `import.meta.main`，该 API 在 **Node v22.13.x 下为
//    undefined**，会导致 dsh CLI **静默失效**（不报错、不输出，看起来像卡死）；
//    在 v24.20.0 下为 true，正常工作。
// 因此这里不能盲信 PATH 里的 node，而要：
//   ① 优先用 DSH_NODE_BIN 显式指定
//   ② 否则在常见安装路径里找 v24/v22.19+ 的 node
//   ③ 找不到时打印明确提示（而不是让 dsh 莫名静默）
function resolveNodeBin() {
  const explicit = process.env.DSH_NODE_BIN;
  if (explicit && fs.existsSync(path.join(explicit, 'node'))) return explicit;

  const candidates = [];
  // nvm 安装的各个版本
  const nvmRoot = process.env.NVM_DIR || path.join(process.env.HOME || '/root', '.nvm');
  const nvmVersions = path.join(nvmRoot, 'versions', 'node');
  try {
    for (const v of fs.readdirSync(nvmVersions)) {
      // 只接受 v22.19+ 或 v23+（import.meta.main 可用）
      const m = /^v(\d+)\.(\d+)\./.exec(v);
      if (!m) continue;
      const major = +m[1], minor = +m[2];
      if (major > 22 || (major === 22 && minor >= 19)) {
        candidates.push(path.join(nvmVersions, v, 'bin'));
      }
    }
  } catch { /* 没有 nvm 目录，属正常 */ }

  // 常见系统路径
  candidates.push('/usr/local/bin', '/usr/bin');
  candidates.sort((a, b) => {
    const va = (/v(\d+)\./.exec(a) || [])[1] || '0';
    const vb = (/v(\d+)\./.exec(b) || [])[1] || '0';
    return +vb - +va;   // 版本高的优先
  });

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node')) && fs.existsSync(path.join(dir, 'dsh'))) {
      return dir;
    }
  }
  // 退一步：只要 node 也行（dsh 可能装在别处，由 PATH 兜底）
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'node'))) return dir;
  }
  return null;   // 交给 PATH
}

const NODE_BIN = resolveNodeBin();

const ACCESS_URL_FILE = process.env.DSH_ACCESS_URL_FILE || '/workspace/dsh-公网访问地址.txt';

// ── 公网域名解析与校验 ────────────────────────────────────────────────────
// ⚠️ 实测踩坑：dsh 对 --trusted-host 有强校验：
//    client-connection: trustedHosts entry "xxx" is not a bare host[:port] authority
// 即必须是「纯 host[:port]」，**不能带尖括号、scheme、路径、空格**。
// 一旦写错，dsh 会直接退出（code=1），表现为「服务起不来」且报错栈很深、不易定位。
// 因此这里在启动 dsh 之前先校验并给出可读的提示。
const BARE_AUTHORITY_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:[0-9]{1,5})?$/;

function isValidAuthority(host) {
  if (typeof host !== 'string' || host === '') return false;
  if (host.includes('<') || host.includes('>')) return false;   // 占位符没替换
  if (/^https?:\/\//i.test(host)) return false;                 // 误带 scheme
  if (host.includes('/') || host.includes(' ') || host.includes('?')) return false;
  return BARE_AUTHORITY_RE.test(host);
}

const RAW_PUBLIC_HOST = process.env.DSH_PUBLIC_HOST || '';
const PUBLIC_HOST = RAW_PUBLIC_HOST;

if (PUBLIC_HOST && !isValidAuthority(PUBLIC_HOST)) {
  console.error('');
  console.error('  ❌ DSH_PUBLIC_HOST 不是合法的 host[:port]：' + JSON.stringify(PUBLIC_HOST));
  console.error('');
  console.error('  dsh 要求 --trusted-host 必须是「纯 host[:port]」，不能带：');
  console.error('    · 尖括号占位符  <YOUR-SANDBOX-ID>.app.workbuddy.host   ❌');
  console.error('    · 协议前缀      https://abc.app.workbuddy.host        ❌');
  console.error('    · 路径/查询串   abc.app.workbuddy.host/?token=x       ❌');
  console.error('');
  console.error('  正确写法示例：');
  console.error('    export DSH_PUBLIC_HOST=abc123.app.workbuddy.host       ✅');
  console.error('');
  console.error('  如果不确定自己的域名，可以先不设置该变量：');
  console.error('  桥接进程支持运行时学习 —— 用公网域名访问一次即可自动识别。');
  console.error('');
  process.exit(1);
}

// 等待「首个外部请求」以学习网关 Host 的上限；超时后用已知候选值兜底启动
const LEARN_TIMEOUT_MS = parseInt(process.env.DSH_LEARN_TIMEOUT_MS || '2500', 10);

// 已知网关 Host 的持久化文件。
// 网关 authority 在同一沙箱内是稳定的，落盘后下次启动可直接带上，
// 从而把「重启 dsh 以纳入新 Host」这件事限制在首次，避免反复抖动。
const KNOWN_HOSTS_FILE = process.env.DSH_KNOWN_HOSTS_FILE || path.join(__dirname, '..', '.known-hosts.json');

function loadKnownHosts() {
  try {
    const raw = fs.readFileSync(KNOWN_HOSTS_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.filter((h) => typeof h === 'string' && h !== '');
  } catch { /* 首次运行没有该文件，属正常 */ }
  return [];
}

function saveKnownHosts() {
  try {
    fs.writeFileSync(KNOWN_HOSTS_FILE, JSON.stringify([...learnedHosts], null, 2), 'utf8');
  } catch { /* 持久化失败不影响主链路 */ }
}

const learnedHosts = new Set(loadKnownHosts());
// dsh 当前实际生效的信任列表（重启后重置）
const activeTrusted = new Set();
let dshProcess = null;
let restarting = false;

// ── open-in-app 图标补全 ──────────────────────────────────────────────────
//
// 背景：dsh 的 open-in-app 插件在 Linux 上按应用探测启动器，并从系统 .desktop
// 文件**提取**真实图标。沙箱是无桌面环境，`filemanager`（依赖 xdg-open）能探测到
// 启动器、`/open-in-app/apps` 会返回 {"apps":["filemanager"]}，但图标提取失败，
// 上游主动返回 404（{"code":"not-found","message":"no icon for filemanager"}）。
//
// 上游源码注释写明这是既定语义："a 404 here means detection didn't find that launcher"。
// 图标在客户端只用于 <img src>（见 @deepseek-ai/dsh-client-ui-open-in-app 的
// iconUrl()），是纯装饰性资源，缺失不影响按钮点击（launch 走 /open-in-app/open）。
// 这里补一个语义对应的文件夹图标，避免浏览器 console 报错。
//
// 注意：仅对**确认可用的应用**补图标。若某应用已从 /open-in-app/apps 消失，
// 说明启动器也没探测到，此时继续 404 才是正确语义。
const ICON_DIR = process.env.DSH_ICON_DIR || path.join(__dirname, '..', 'icons');

function handleOpenInAppIcon(req, res) {
  const id = req.url.split('?')[0].slice('/open-in-app/icon/'.length);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return false;
  const file = require('path').join(ICON_DIR, `${id}.png`);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return false; // 没有该图标 → 交给上游，保持其原本的 404 语义
  }
  res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': bytes.length,
    'cache-control': 'public, max-age=3600',
  });
  res.end(bytes);
  return true;
}

// ── dsh-mobile 资源补全 ───────────────────────────────────────────────────
//
// 背景：dsh-mobile 0.4.1 把静态资源（/mobile-access/*）挂在它自己的「独立网关」上，
// 该网关配置为 listenHost=127.0.0.1、listenPort=0（随机）、allowedCidrs=127.0.0.0/8，
// 且 initiallyEnabled=false —— 即它只服务 loopback 上的手机 App/局域网场景，
// 永远不会出现在面向公网的主 web 服务端口上。
// 因此 web 前端加载时会拿到 404，并在 console 留下 4 条报错。
//
// 客户端对 404 本就有完整降级分支（handleMissingExtensionManifest），所以不修也不影响功能；
// 但为了让公网访问「零报错」，这里按插件**自身的语义**补齐这几个响应：
// 内容取自插件源码中的 CUSTOM_STYLE_FALLBACK / CUSTOM_SCRIPT_FALLBACK 常量，
// manifest 按插件 protocol 1 的结构返回（extensions 为空数组，因未装任何扩展）。
// 这不是伪造数据 —— 与插件独立网关在未配置自定义内容时的响应完全等价。
const MOBILE_FALLBACK_CSS = '/* Add mobile overrides in the DSH home mobile-access/mobile.css file. */\n';
const MOBILE_FALLBACK_JS = 'window.dshMobile?.register(() => undefined)\n';

function sha256hex(text) {
  return require('crypto').createHash('sha256').update(text).digest('hex');
}

function handleMobileAccess(req, res) {
  const path = req.url.split('?')[0];

  if (path === '/mobile-access/custom.css') {
    const body = Buffer.from(MOBILE_FALLBACK_CSS, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/css; charset=utf-8',
      'content-length': body.length,
      etag: `"${sha256hex(MOBILE_FALLBACK_CSS)}"`,
      'cache-control': 'no-store',
    });
    return res.end(body);
  }

  if (path === '/mobile-access/custom.js') {
    const body = Buffer.from(MOBILE_FALLBACK_JS, 'utf8');
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': body.length,
      etag: `"${sha256hex(MOBILE_FALLBACK_JS)}"`,
      'cache-control': 'no-store',
    });
    return res.end(body);
  }

  if (path === '/mobile-access/extensions/manifest') {
    // 与插件一致：protocol 1 + extensions 列表 + legacy 修订号
    const payload = {
      protocol: 1,
      extensions: [],
      legacy: {
        scriptRevision: sha256hex(MOBILE_FALLBACK_JS),
        styleRevision: sha256hex(MOBILE_FALLBACK_CSS),
      },
    };
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const etag = `"${sha256hex(body.toString('utf8'))}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag });
      return res.end();
    }
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': body.length,
      etag,
      'cache-control': 'no-store',
    });
    return res.end(body);
  }

  if (path === '/mobile-access/extensions/events') {
    // 插件用 SSE 推送扩展变更；此处维持一条长连接并按同格式发送初始帧
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('id: 1\nevent: extensions-changed\ndata: {"revision":1}\n\n');
    const keepAlive = setInterval(() => {
      if (res.writableEnded || res.destroyed) return clearInterval(keepAlive);
      res.write(': keep-alive\n\n');
    }, 25000);
    req.on('close', () => clearInterval(keepAlive));
    return;
  }

  return false;
}

// ── 转发 ──────────────────────────────────────────────────────────────────

// 原样透传 Host（仅缺失时兜底），并补 X-Forwarded-* 供上游识别真实来源
//
// ⚠️ Origin / Referer 必须归一化到与 Host 同一 authority。
// 网关会把入站 Host 改写成内部域名（<PORT>-<SPACE_KEY>.e2b.<REGION>...），
// 但浏览器发出的 Origin 仍是用户实际访问的公网域名，二者 authority 不等。
// dsh 的 isTrustedApiRequest 判定为：
//     origin === undefined ? true : new URL(origin).host === hostUrl.host
// 一旦不等即对整个 /api 返回 403。浏览器必然发送 Origin，所以这里必须把
// Origin/Referer 重写为上游看到的 Host，让三者在上游侧自洽。
function forwardHeaders(req) {
  const headers = { ...req.headers };
  if (!headers.host) headers.host = `${DSH_HOST}:${DSH_PORT}`;
  const authority = headers.host;

  if (headers.origin) headers.origin = `https://${authority}`;
  if (headers.referer) {
    try {
      const ref = new URL(headers.referer);
      headers.referer = `https://${authority}${ref.pathname}${ref.search}`;
    } catch {
      headers.referer = `https://${authority}/`;
    }
  }

  headers['x-forwarded-host'] = authority;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  return headers;
}

// dsh 的 303 重定向 Location 是相对路径（"/"），本身没问题；
// 但若上游返回绝对 Location 指向内部 authority，需改写回公网域名。
function rewriteLocation(headersObj, authority) {
  const loc = headersObj.location;
  if (!loc || !/^https?:\/\//i.test(loc)) return;
  try {
    const u = new URL(loc);
    if (u.host === authority) return;
    headersObj.location = `https://${authority}${u.pathname}${u.search}`;
  } catch { /* 非法 Location 不处理 */ }
}

function pickHost(req) {
  const host = req.headers.host;
  if (!host) return;
  traceReq(req);
  // 平台自身探测走 loopback，无学习价值
  if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return;
  if (learnedHosts.has(host)) return;
  learnedHosts.add(host);
  saveKnownHosts();
  console.log(`learned gateway host: ${host}`);
  // 若该 authority 不在 dsh 已生效的信任列表里，热重启让它生效
  if (dshProcess !== null && !activeTrusted.has(host)) restartDshWithNewHost();
}

// 诊断：记录网关实际送达的请求头（用于定位 /api 403）
const TRACE_FILE = process.env.DSH_TRACE_FILE || '/tmp/dsh-bridge-trace.log';
function traceReq(req) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    m: req.method,
    url: req.url,
    host: req.headers.host,
    origin: req.headers.origin,
    xfh: req.headers['x-forwarded-host'],
    xfp: req.headers['x-forwarded-proto'],
    sfs: req.headers['sec-fetch-site'],
  });
  try {
    fs.appendFileSync(TRACE_FILE, line + '\n');
  } catch { /* 诊断失败不影响主链路 */ }
}

function proxyHttp(req, res) {
  const headers = forwardHeaders(req);
  const upstream = http.request(
    {
      hostname: DSH_HOST,
      port: DSH_PORT,
      path: req.url,
      method: req.method,
      headers,
    },
    (up) => {
      rewriteLocation(up.headers, headers.host);
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
      // 上游在响应中途断开（如流式响应被打断）时也必须收尾，
      // 否则客户端会一直挂着等一个永不结束的响应。
      up.on('error', () => { if (!res.writableEnded) res.end(); });
      up.on('aborted', () => { if (!res.writableEnded) res.end(); });
    },
  );

  // 上游连接层错误（含上游主动断开连接 → ECONNRESET / "socket hang up"）。
  //
  // ⚠️ 这里必须返回与网关一致的 JSON 错误体，而不是裸文本：
  // 平台网关期望 JSON，裸文本会被它二次包装成笼统的 {"code":502,"msg":"bad gateway"}，
  // 把真实原因（例如 dsh 路由报错后主动断开）丢掉，现场无从排查。
  // 返回结构化 JSON 后，前端能拿到可读的 message 与上游路径，便于定位。
  upstream.on('error', (err) => {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }
    const payload = JSON.stringify({
      code: 502,
      msg: 'bridge upstream error',
      data: {
        // 上游 host:port 与请求路径，便于一眼看出是哪个端点出的问题
        upstream: `${DSH_HOST}:${DSH_PORT}${req.url}`,
        reason: err.code || err.name || 'unknown',
        message: err.message,
      },
    });
    res.writeHead(502, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  });

  // 客户端提前断开（用户取消上传/关闭页面）时释放上游请求，避免连接泄漏
  req.on('aborted', () => upstream.destroy());

  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  pickHost(req);
  // open-in-app 图标：沙箱无桌面环境，上游提取不到，补本地图标
  if (req.url.startsWith('/open-in-app/icon/')) {
    if (handleOpenInAppIcon(req, res) !== false) return;
  }
  // dsh-mobile 的静态资源由插件独立网关提供，不在主 web 端口上；此处按插件语义补齐
  if (req.url.startsWith('/mobile-access/') || req.url === '/mobile-access') {
    if (handleMobileAccess(req, res) !== false) return;
  }
  proxyHttp(req, res);
});

// WebSocket / SSE 升级转发
server.on('upgrade', (req, socket) => {
  pickHost(req);
  const headers = forwardHeaders(req);
  const upstream = http.request({
    hostname: DSH_HOST,
    port: DSH_PORT,
    path: req.url,
    method: req.method,
    headers,
  });
  upstream.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (const [k, v] of Object.entries(upRes.headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead && upHead.length) socket.unshift(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
  });
  upstream.on('error', () => socket.destroy());
  upstream.end();
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

// ── dsh 子进程 ────────────────────────────────────────────────────────────

const TOKEN_RE = /dsh web:\s*\S*[?&]token=([A-Za-z0-9_-]+)/u;

function publishAccessUrl(token) {
  // PUBLIC_HOST 可能为空（未设置时靠运行时学习）。
  // 此时退化为「只给本地链接 + 提示」，避免输出 https:///?token= 这种坏 URL。
  const hasHost = PUBLIC_HOST !== '';
  const localUrl = `http://127.0.0.1:${DSH_PORT}/?token=${token}`;
  const publicUrl = hasHost ? `https://${PUBLIC_HOST}/?token=${token}` : null;

  const lines = ['DeepSeek Harness —— 访问地址', ''];
  lines.push('访问链接（首次打开用于换取会话 Cookie）：');
  lines.push(publicUrl || localUrl);
  lines.push('');
  if (hasHost) {
    lines.push(`公网域名：https://${PUBLIC_HOST}/`);
  } else {
    lines.push('公网域名：未设置（DSH_PUBLIC_HOST 为空）');
    lines.push('');
    lines.push('提示：把本文件里的链接换成你的公网域名即可，例如');
    lines.push(`      https://<你的域名>/?token=${token}`);
    lines.push('      或者设置 DSH_PUBLIC_HOST 后重启，会自动生成完整链接。');
  }
  lines.push(`生成时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  lines.push('');
  lines.push('说明：token 每次服务重启都会重新生成；打开一次上述链接后，');
  lines.push('浏览器会获得有效期约 30 天的会话 Cookie，此后直接访问域名即可。');
  lines.push('');

  const body = lines.join('\n');
  try {
    fs.writeFileSync(ACCESS_URL_FILE, body, 'utf8');
    console.log(`access url written to ${ACCESS_URL_FILE}`);
  } catch (err) {
    console.log(`failed to write access url file: ${err.message}`);
  }
  console.log(`public access url: ${publicUrl || localUrl}`);
}

function relay(stream, sink) {
  stream.setEncoding('utf8');
  let buf = '';
  stream.on('data', (chunk) => {
    sink.write(chunk);
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const m = TOKEN_RE.exec(line);
      if (m) publishAccessUrl(m[1]);
    }
    if (buf.length > 8192) buf = '';
  });
}

// 预填充候选信任域名。
// 网关把 Host 改写成 <PORT>-<SPACE_KEY>.e2b.<REGION>.sandbox.cloudstudio.club，
// 该 SPACE_KEY 通常等于环境变量 X_IDE_SPACE_KEY，但平台有时会注入预热实例的 ID，
// 因此这里只作为「候选」预填，真正的权威来源是运行时从请求上学习到的 Host。
function seedTrustedHosts() {
  const hosts = new Set();
  if (PUBLIC_HOST) hosts.add(PUBLIC_HOST);

  const spaceKey = process.env.X_IDE_SPACE_KEY;
  const region = process.env.X_IDE_SPACE_REGION || 'bj7';
  const spaceHost = process.env.X_IDE_SPACE_HOST || 'sandbox.cloudstudio.club';
  if (spaceKey) {
    hosts.add(`${PORT}-${spaceKey}.e2b.${region}.${spaceHost}`);
    hosts.add(`${PORT}-${spaceKey}.e2b.${spaceHost}`);
  }

  const explicit = process.env.DSH_TRUSTED_HOST;
  if (explicit) for (const h of explicit.split(',')) if (h.trim()) hosts.add(h.trim());

  return hosts;
}

function startDsh() {
  if (dshProcess !== null) return;

  const trusted = new Set([...seedTrustedHosts(), ...learnedHosts]);
  activeTrusted.clear();
  for (const h of trusted) activeTrusted.add(h);

  const dshArgs = ['web', '--no-open', '--port', String(DSH_PORT)];
  for (const h of trusted) dshArgs.push('--trusted-host', h);

  console.log(`node runtime: ${NODE_BIN || '(from PATH)'}`);
  console.log(`starting dsh with trusted hosts: ${[...trusted].join(' | ') || '(none)'}`);

  const dshBin = NODE_BIN ? `${NODE_BIN}/dsh` : 'dsh';
  const dshEnv = NODE_BIN
    ? { ...process.env, PATH: `${NODE_BIN}:${process.env.PATH}` }
    : { ...process.env };

  dshProcess = spawn(dshBin, dshArgs, {
    cwd: '/workspace',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: dshEnv,
  });

  relay(dshProcess.stdout, process.stdout);
  relay(dshProcess.stderr, process.stderr);

  dshProcess.on('exit', (code) => {
    if (restarting) return;
    console.log(`dsh exited code=${code}`);
    process.exit(1);
  });
}

// 学到新的网关 Host（且不在当前信任列表里）时，热重启 dsh 以纳入新 authority。
// 代价是一次数秒的重启，换来 /api browser-trust fence 永久放行。
function restartDshWithNewHost() {
  if (restarting || dshProcess === null) return;
  restarting = true;
  console.log('restarting dsh to adopt newly learned gateway host');
  const old = dshProcess;
  dshProcess = null;
  old.removeAllListeners('exit');
  old.on('exit', () => {
    restarting = false;
    startDsh();
  });
  old.kill('SIGTERM');
}

// 监听端口后先输出就绪日志（平台探测窗口约 5s），再等首个外部请求学习 Host
server.listen(PORT, '0.0.0.0', () => {
  console.log(`serving http on 0.0.0.0:${PORT}`);
  console.log(`listening on port ${PORT}`);

  let started = false;
  const kickoff = (reason) => {
    if (started) return;
    started = true;
    console.log(`starting dsh (${reason})`);
    startDsh();
  };

  // 一旦学到外部 Host 就立刻启动；否则超时兜底
  const poll = setInterval(() => {
    if (learnedHosts.size > 0) {
      clearInterval(poll);
      kickoff('learned gateway host');
    }
  }, 100);
  setTimeout(() => {
    clearInterval(poll);
    kickoff(`timeout after ${LEARN_TIMEOUT_MS}ms`);
  }, LEARN_TIMEOUT_MS);
});
