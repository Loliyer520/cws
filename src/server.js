// cc-bridge (Node) — entry: HTTP static WebUI + /ws upgrade + graceful shutdown.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Bridge } from './bridge.js';
import {
  TOKEN, ONE_TIME_TOKENS, PORT, WEBUI_CFG, persistOneTimeTokens,
} from './config.js';
import { BASE, log, safeEqual } from './util.js';

const bridge = new Bridge();
const wss = new WebSocketServer({ noServer: true });

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
  log('http', { method: req.method, path: (req.url || '').split('?')[0] });
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
