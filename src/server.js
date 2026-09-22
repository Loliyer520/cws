// cc-bridge (Node) — entry: HTTP static WebUI + /ws upgrade + graceful shutdown.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Bridge } from './bridge.js';
import {
  TOKEN, ONE_TIME_TOKENS, PORT, WEBUI_CFG, persistOneTimeTokens, gatewayByName,
} from './config.js';
import { BASE, log, safeEqual } from './util.js';

const bridge = new Bridge();
const wss = new WebSocketServer({ noServer: true });

/**
 * OpenClaw 媒体代理：/oc-media/<gw>/<direction>/<sess>/<id>/<size>?sig=…
 * 网关 /api/chat/media/ 要 Bearer token 且端口不出公网，笔端直连够不到——
 * openclaw-session 把图片块改写成带 HMAC 签名的本端相对 URL，这里验签后
 * 用网关 token 取回。sig = HMAC-SHA256(桥token, gw + '\n' + path) 前 16 hex；
 * 路径白名单死守，只放行媒体形态，变形一律 403。
 */
const OC_MEDIA_RE = /^[a-z]+\/[A-Za-z0-9%_.\-]+\/[A-Za-z0-9%_.\-]+\/[A-Za-z0-9_\-]+$/;
async function serveOcMedia(req, res, urlPath, query) {
  const m = urlPath.match(/^\/oc-media\/([^/]+)\/(.+)$/);
  if (!m) { res.writeHead(404).end('not found'); return; }
  const gwName = decodeURIComponent(m[1]);
  const rest = m[2];
  if (!OC_MEDIA_RE.test(rest)) { res.writeHead(403).end('forbidden'); return; }
  const expect = crypto.createHmac('sha256', TOKEN).update(m[1] + '\n' + rest).digest('hex').slice(0, 16);
  if (!safeEqual(String(query.get('sig') || ''), expect)) { res.writeHead(403).end('forbidden'); return; }
  const gw = gatewayByName(gwName);
  if (!gw || !gw.url) { res.writeHead(404).end('unknown gateway'); return; }
  const upstream = String(gw.url).replace(/^ws/i, 'http') + '/api/chat/media/' + rest;
  try {
    const r = await fetch(upstream, { headers: { authorization: 'Bearer ' + String(gw.token || '') } });
    if (!r.ok) { res.writeHead(r.status).end('upstream ' + r.status); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(200, {
      'content-type': r.headers.get('content-type') || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'private, max-age=86400',
    });
    res.end(buf);
  } catch (e) {
    log('oc_media_err', { err: String(e) });
    if (!res.headersSent) res.writeHead(502);
    res.end('bad gateway');
  }
}

function serveStatic(req, res) {
  const webuiRoot = path.resolve(BASE, WEBUI_CFG.dir);
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.resolve(webuiRoot, '.' + urlPath);
  if (!filePath.startsWith(webuiRoot + path.sep) && filePath !== webuiRoot) {
    res.writeHead(403).end('forbidden');
    return;
  }
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json',
  };
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': mime[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // access log: never log query strings (tokens live there)
  let rawPath = (req.url || '/').split('?')[0];
  // 前缀化部署的媒体路由：LoliAPP rccws 从 rcWsUrl(wss://host/cws-ws/ws) 推导出
  // 带 /cws-ws 前缀的图片地址。nginx 对 /cws-ws/oc-media/ 用无 URI 部分的
  // proxy_pass 原样透传（%3A 一字不动），这里在原始编码形态上剥前缀再验签——
  // 白名单正则与 HMAC 都按编码后的路径算，任何解码都会 403。
  if (rawPath.startsWith('/cws-ws/oc-media/')) rawPath = rawPath.slice('/cws-ws'.length);
  log('http', { method: req.method, path: rawPath });
  if (rawPath.startsWith('/oc-media/')) {
    const query = new URL(req.url || '/', 'http://bridge.local').searchParams;
    serveOcMedia(req, res, rawPath, query);
    return;
  }
  if (WEBUI_CFG.enabled) {
    serveStatic(req, res);
  } else {
    res.writeHead(404).end('not found');
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://bridge.local');
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('token') || '';
  let authorized = safeEqual(token, TOKEN);
  if (!authorized && ONE_TIME_TOKENS.has(token)) {
    ONE_TIME_TOKENS.delete(token);
    persistOneTimeTokens();
    authorized = true;
    log('otp_consumed', {});
  }
  if (!authorized) {
    log('auth_fail', {});
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => bridge.handleConn(ws));

server.listen(PORT, '0.0.0.0', () => {
  log('start', {
    port: PORT, max_active: bridge.maxActive, webui: WEBUI_CFG.enabled,
    claude_bin_present: false, // informational only
  });
});

async function shutdown(sig) {
  log('shutdown', { signal: sig });
  await bridge.shutdown();
  wss.clients.forEach((c) => c.terminate());
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
