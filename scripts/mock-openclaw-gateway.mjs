#!/usr/bin/env node
// mock OpenClaw Gateway: minimal Gateway WS protocol v4 for cws openclaw-backend tests.
// connect.challenge -> connect -> hello-ok; then sessions.* / chat.* / approval.* RPCs.
import { WebSocketServer } from 'ws';

const PORT = 18789;
const sessions = new Map(); // key -> { key, sessionId, messages: [], pendingApproval }
let seq = 0;

function res(ws, id, payload) { ws.send(JSON.stringify({ type: 'res', id, ok: true, payload })); }
function resErr(ws, id, code, message) { ws.send(JSON.stringify({ type: 'res', id, ok: false, error: { code, message } })); }
function event(ws, ev, payload) { ws.send(JSON.stringify({ type: 'event', event: ev, payload })); }

const wss = new WebSocketServer({ port: PORT });
wss.on('connection', (ws) => {
  event(ws, 'connect.challenge', { nonce: 'n' + Math.random().toString(16).slice(2), ts: Date.now() });
  ws.on('message', (data) => {
    let f;
    try { f = JSON.parse(data.toString()); } catch { return; }
    if (f.type !== 'req') return;
    const id = f.id, method = f.method, p = f.params || {};
    handle(ws, id, method, p);
  });
});

function handle(ws, id, method, p) {
  switch (method) {
    case 'connect':
      res(ws, id, {
        type: 'hello-ok', protocol: 4,
        server: { version: 'mock', connId: 'mock-conn' },
        features: { methods: [], events: [] },
        snapshot: {},
        auth: { role: 'operator', scopes: ['operator.admin', 'operator.approvals', 'operator.read', 'operator.write'] },
        policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 15000 },
      });
      return;
    case 'sessions.create': {
      let key = p.key || ('cws-' + Math.random().toString(16).slice(2, 8));
      let s = sessions.get(key);
      if (!s) { s = { key, sessionId: 'sid-' + Math.random().toString(16).slice(2, 10), messages: [] }; sessions.set(key, s); }
      res(ws, id, { ok: true, key: s.key, sessionId: s.sessionId });
      return;
    }
    case 'sessions.messages.subscribe':
      res(ws, id, { subscribed: true });
      return;
    case 'chat.history': {
      const s = sessions.get(p.sessionKey);
      res(ws, id, { messages: s ? s.messages : [], deltaCursor: null });
      return;
    }
    case 'chat.send': {
      const s = sessions.get(p.sessionKey);
      if (!s) { resErr(ws, id, 'not_found', 'session not found'); return; }
      const runId = 'run-' + (++seq);
      s.messages.push({ role: 'user', text: p.message, id: 'm' + (++seq) });
      res(ws, id, { status: 'started', runStarted: true, runId });
      const text = p.message;
      const answer = /(\d+)\s*\+\s*(\d+)/.test(text)
        ? String(Number(RegExp.$1) + Number(RegExp.$2))
        : 'mock-openclaw 收到：' + text.slice(0, 30);
      const emitRun = () => {
        // stream deltas
        const half = Math.ceil(answer.length / 2);
        event(ws, 'chat', { runId, sessionKey: s.key, seq: ++seq, state: 'delta', deltaText: answer.slice(0, half) });
        setTimeout(() => {
          event(ws, 'chat', { runId, sessionKey: s.key, seq: ++seq, state: 'delta', deltaText: answer.slice(half) });
          s.messages.push({ role: 'assistant', text: answer, id: 'm' + (++seq) });
          event(ws, 'chat', { runId, sessionKey: s.key, seq: ++seq, state: 'final', message: { role: 'assistant', text: answer }, usage: { inputTokens: 5, outputTokens: 2 } });
        }, 150);
      };
      if (text.includes('bash')) {
        // approval flow
        const aid = 'appr-' + (++seq);
        s.pendingApproval = { id: aid, runId, emitRun };
        event(ws, 'session.approval', {
          sessionKey: s.key, phase: 'pending', updatedAtMs: Date.now(),
          approval: {
            id: aid, urlPath: '/approvals/' + aid, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60000,
            presentation: { kind: 'exec', commandText: 'rm -rf /tmp/important', allowedDecisions: ['allow-once', 'deny'] },
            status: 'pending',
          },
        });
      } else {
        emitRun();
      }
      return;
    }
    case 'approval.resolve': {
      let matched = null;
      for (const s of sessions.values()) {
        if (s.pendingApproval && s.pendingApproval.id === p.id) { matched = s; break; }
      }
      if (!matched) { resErr(ws, id, 'not_found', 'approval not found'); return; }
      res(ws, id, { resolved: true, decision: p.decision });
      const ap = matched.pendingApproval;
      matched.pendingApproval = null;
      const answer = p.decision === 'deny' ? '工具调用被拒绝（denied by user）' : '工具已执行';
      matched.messages.push({ role: 'assistant', text: answer, id: 'm' + (++seq) });
      event(ws, 'chat', { runId: ap.runId, sessionKey: matched.key, seq: ++seq, state: 'delta', deltaText: answer });
      event(ws, 'chat', { runId: ap.runId, sessionKey: matched.key, seq: ++seq, state: 'final', message: { role: 'assistant', text: answer }, usage: { inputTokens: 5, outputTokens: 1 } });
      return;
    }
    case 'sessions.abort': {
      const s = sessions.get(p.key);
      if (s) event(ws, 'chat', { runId: 'run-abort', sessionKey: s.key, seq: ++seq, state: 'aborted', stopReason: 'user' });
      res(ws, id, { ok: true });
      return;
    }
    case 'sessions.patch':
      res(ws, id, { ok: true });
      return;
    default:
      res(ws, id, { ok: true });
  }
}

process.stdout.write('mock-openclaw-gateway listening on ' + PORT + '\n');

