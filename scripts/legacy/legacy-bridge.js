#!/usr/bin/env node
'use strict';
/**
 * dsh 公网访问桥接代理
 *
 * 背景：
 *   - dsh 官方主动拒绝绑定 0.0.0.0（防止 RCE 暴露到网络），只肯监听 127.0.0.1。
 *   - 但沙箱的公网映射要求服务监听 0.0.0.0（至少能接受同容器/网卡层的连接）。
 *   本代理在 0.0.0.0:$PORT 上接收请求，转发给 127.0.0.1:$DSH_PORT 的 dsh。
 *
 * 同时把 Host 头规范化为 dsh 期望的值，并通过启动 dsh 时传入
 * --trusted-host <公网域名> 让 /api 的 browser-trust 校验放行。
 *
 * 用法：node bridge.js
 *   环境变量：
 *     PORT          对外监听端口（默认 3000，发布平台会注入）
 *     DSH_PORT      dsh 实际监听端口（默认 3080）
 *     DSH_PUBLIC_HOST  公网域名（用于日志展示）
 */

const http = require('http');

const LISTEN_PORT = parseInt(process.env.PORT || '3000', 10);
const DSH_PORT = parseInt(process.env.DSH_PORT || '13080', 10);
const DSH_HOST = '127.0.0.1';
const PUBLIC_HOST = process.env.DSH_PUBLIC_HOST || '';

const server = http.createServer((req, res) => {
  // 规范化 Host：dsh 的 browser-trust 以 Host 判定来源
  const headers = { ...req.headers };
  headers.host = `${DSH_HOST}:${DSH_PORT}`;
  // 保留原始来源，便于 dsh 侧日志排查
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;

  const proxyReq = http.request(
    { hostname: DSH_HOST, port: DSH_PORT, path: req.url, method: req.method, headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`bridge error: ${err.message}\n`);
  });

  req.pipe(proxyReq);
});

// WebSocket 升级转发（dsh 前端重度依赖 WS）
server.on('upgrade', (req, socket, head) => {
  const headers = { ...req.headers };
  headers.host = `${DSH_HOST}:${DSH_PORT}`;
  if (req.headers.host) headers['x-forwarded-host'] = req.headers.host;

  const proxyReq = http.request({
    hostname: DSH_HOST, port: DSH_PORT, path: req.url, method: req.method, headers,
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
      '\r\n\r\n',
    );
    if (proxyHead && proxyHead.length) socket.unshift(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);
  });

  proxyReq.on('error', () => socket.destroy());
  proxyReq.end();
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  // 立即打印就绪关键词：发布脚本按关键词判定启动状态，必须在探测窗口内出现
  console.log(`bridge listening on 0.0.0.0:${LISTEN_PORT}`);
  console.log(`serving http on port ${LISTEN_PORT}`);
  if (PUBLIC_HOST) console.log(`listening on https://${PUBLIC_HOST}/`);
});
