#!/usr/bin/env node
// cws (Node) acceptance test client — port of wsclient.py + codex scenarios.
// Usage: node wsclient.mjs [--url ws://127.0.0.1:8642/ws] [--config ./secrets.json]
//        [--token HEX] [--scenario all|basic|parallel|bash_deny|askq|stop|misc|codex_basic|codex_stop]
import fs from 'node:fs';
import WebSocket from 'ws';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const URL = arg('url', 'ws://127.0.0.1:8642/ws');
const CONFIG = arg('config', './secrets.json');
const SCENARIO = arg('scenario', 'all');
const TOKEN_ARG = arg('token', null);

let TOKEN = TOKEN_ARG;
if (!TOKEN) {
  try { TOKEN = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).token; } catch { TOKEN = ''; }
}

const RES = {};
function rec(name, ok, detail = '') {
  RES[name] = { ok: !!ok, detail: String(detail).slice(0, 600) };
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? '  | ' + String(detail).slice(0, 200) : ''));
}

class Client {
  constructor(url, token) {
    this.url = url + '?token=' + token;
    this.events = [];
    this.ws = null;
    this.nextEcho = 0;
    this.onAsk = null;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        let ev;
        try { ev = JSON.parse(data.toString()); } catch { return; }
        this.events.push(ev);
        if (ev.post_type === 'ask' && this.onAsk) Promise.resolve(this.onAsk(ev)).catch(() => {});
      });
    });
  }
  act(action, params = {}) {
    this.nextEcho += 1;
    const echo = 'e' + this.nextEcho;
    this.ws.send(JSON.stringify({ action, params, echo }));
    return echo;
  }
  async wait(pred, timeout = 180) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout * 1000) {
      for (const ev of this.events) if (pred(ev)) return ev;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }
  close() {
    try { this.ws.close(); } catch {}
  }
}

async function dropAll(c, sids) {
  for (const sid of sids) {
    try {
      const e = c.act('drop_session', { session_id: sid });
      await c.wait((ev) => ev.post_type === 'session_closed' && ev.echo === e, 20);
    } catch {}
  }
}

async function scBasic() {
  const c = new Client(URL, TOKEN);
  await c.connect();
  const sid = 'acc-basic-1';
  const e = c.act('new_session', { session_id: sid });
  let ev = await c.wait((x) => x.post_type === 'session_ready' && x.session_id === sid, 40);
  if (!ev) { rec('1.basic', false, 'no session_ready'); c.close(); return; }
  const e2 = c.act('send', { session_id: sid, text: '1+1只回答数字' });
  ev = await c.wait((x) => (x.post_type === 'final' || x.post_type === 'error') && x.echo === e2, 120);
  const ok = ev && ev.post_type === 'final' && /2/.test(ev.text || '');
  rec('1.basic', ok, ev ? 'final.text=' + JSON.stringify(ev.text) : 'timeout');
  await dropAll(c, [sid]);
  c.close();
}

async function scParallel() {
  const c = new Client(URL, TOKEN);
  await c.connect();
  const s1 = 'acc-par-1', s2 = 'acc-par-2';
  for (const sid of [s1, s2]) c.act('new_session', { session_id: sid });
  for (const sid of [s1, s2]) {
    const ev = await c.wait((x) => x.post_type === 'session_ready' && x.session_id === sid, 40);
    if (!ev) { rec('2.parallel', false, 'no ready ' + sid); c.close(); return; }
  }
  const e1 = c.act('send', { session_id: s1, text: '9+9只回答数字' });
  const e2 = c.act('send', { session_id: s2, text: '8+8只回答数字' });
  const f1 = await c.wait((x) => x.post_type === 'final' && x.echo === e1, 150);
  const f2 = await c.wait((x) => x.post_type === 'final' && x.echo === e2, 150);
  const ok = f1 && f2 && /18/.test(f1.text || '') && /16/.test(f2.text || '');
  rec('2.parallel', ok, 'f1=' + JSON.stringify(f1 && f1.text) + ' f2=' + JSON.stringify(f2 && f2.text));
  await dropAll(c, [s1, s2]);
  c.close();
}

async function scBashDeny() {
  const c = new Client(URL, TOKEN);
  await c.connect();
  const sid = 'acc-bash-1';
  c.act('new_session', { session_id: sid });
  const ev = await c.wait((x) => x.post_type === 'session_ready' && x.session_id === sid, 40);
  if (!ev) { rec('3.bash_deny', false, 'no session_ready'); c.close(); return; }
  let askSeen = null;
  c.onAsk = async (aev) => {
    askSeen = aev;
    c.act('ask_reply', { session_id: sid, ask_id: aev.ask_id, behavior: 'deny' });
  };
  const e = c.act('send', { session_id: sid, text: '用bash创建一个文件 p4test.txt（内容随意），然后告诉我结果' });
  const fin = await c.wait((x) => (x.post_type === 'final' || x.post_type === 'error') && x.echo === e, 150);
  const ok = !!askSeen && fin && fin.post_type === 'final';
  rec('3.bash_deny', ok, 'ask.tool=' + (askSeen && askSeen.tool_name) + ' kind=' + (askSeen && askSeen.kind) + ' final=' + JSON.stringify(fin && fin.text));
  await dropAll(c, [sid]);
  c.close();
}

async function scAskq() {
  const c = new Client(URL, TOKEN);
  await c.connect();
  const sid = 'acc-askq-1';
  c.act('new_session', { session_id: sid });
  const ev = await c.wait((x) => x.post_type === 'session_ready' && x.session_id === sid, 40);
  if (!ev) { rec('4.ask_user_question', false, 'no session_ready'); c.close(); return; }
  let qAsk = null;
  c.onAsk = async (aev) => {
    if (aev.kind === 'question' && !qAsk) {
      qAsk = aev;
      const q = (aev.input.questions || [])[0];
      const updatedInput = { ...aev.input, answers: { [q.question]: q.options[1].label } };
      c.act('ask_reply', { session_id: sid, ask_id: aev.ask_id, behavior: 'allow', updatedInput });
    }
  };
  const e = c.act('send', { session_id: sid, text: '问我最喜欢哪个颜色（选项红/蓝/绿），等我回答后再告诉我我选的颜色' });
  const fin = await c.wait((x) => x.post_type === 'final' && x.echo === e, 150);
  rec('4.ask_user_question', !!fin && !!qAsk, 'q=' + JSON.stringify(qAsk && (qAsk.input.questions || [])[0] && qAsk.input.questions[0].question) + ' final=' + JSON.stringify(fin && fin.text));
  await dropAll(c, [sid]);
  c.close();
}

async function scStopResume() {
  const c = new Client(URL, TOKEN);
  await c.connect();
  const sid = 'acc-stop-1';
  c.act('new_session', { session_id: sid });
  const ev = await c.wait((x) => x.post_type === 'session_ready' && x.session_id === sid, 40);
  if (!ev) { rec('5.stop_resume', false, 'no session_ready'); c.close(); return; }
  const e = c.act('send', { session_id: sid, text: '从1数到300，每个数单独一行输出，不要省略' });
  const d = await c.wait((x) => x.post_type === 'delta' && x.session_id === sid, 120);
  if (!d) { rec('5.stop_resume', false, 'no delta'); c.close(); return; }
  await new Promise((r) => setTimeout(r, 1500));
  c.act('stop', { session_id: sid });
  const ab = await c.wait((x) => x.post_type === 'turn_aborted' && x.session_id === sid, 30);
  if (!ab) { rec('5.stop_resume', false, 'no turn_aborted'); c.close(); return; }
  const e2 = c.act('send', { session_id: sid, text: '刚才你数到几就被打断了？一句话回答' });
  const fin = await c.wait((x) => (x.post_type === 'final' || x.post_type === 'error') && x.echo === e2, 150);
  rec('5.stop_resume', !!fin && fin.post_type === 'final' && !!fin.text, 'abort.reason=' + ab.reason + ' resume_final=' + JSON.stringify(fin && fin.text));
  await dropAll(c, [sid]);
  c.close();
}

async function scMisc() {
  const c = new Client(URL, TOKEN);
  await c.connect();
  const e = c.act('ping');
  const p = await c.wait((x) => x.post_type === 'pong' && x.echo === e, 15);
  const e2 = c.act('sessions.list');
  const sl = await c.wait((x) => x.post_type === 'sessions' && x.echo === e2, 15);
  rec('6a.ping_list', !!p && !!sl, 'pong=' + !!p + ' sessions=' + (sl ? sl.sessions.length : -1));
  c.close();
  // bad token must fail handshake
  try {
    await new Promise((resolve) => {
      const ws = new WebSocket(URL + '?token=deadbeefdeadbeef');
      const timer = setTimeout(() => { rec('6b.bad_token_401', false, 'timeout'); resolve(); }, 5000);
      ws.on('open', () => { clearTimeout(timer); rec('6b.bad_token_401', false, 'handshake unexpectedly succeeded'); ws.close(); resolve(); });
      ws.on('error', () => { clearTimeout(timer); rec('6b.bad_token_401', true, 'handshake rejected'); resolve(); });
    });
  } catch { rec('6b.bad_token_401', true, 'handshake rejected'); }
}

async function scCodexBasic() {
  const c = new Client(URL, TOKEN);
  await c.connect();
  const sid = 'acc-codex-1';
  const e = c.act('new_session', { session_id: sid, backend: 'codex' });
  let ev = await c.wait((x) => x.post_type === 'session_ready' && x.session_id === sid, 40);
  if (!ev) { rec('7.codex_basic', false, 'no session_ready'); c.close(); return; }
  const e2 = c.act('send', { session_id: sid, text: '1+1只回答数字' });
  ev = await c.wait((x) => (x.post_type === 'final' || x.post_type === 'error') && x.echo === e2, 120);
  const ok = ev && ev.post_type === 'final' && /2/.test(ev.text || '');
  rec('7.codex_basic', ok, ev ? 'final.text=' + JSON.stringify(ev.text) : 'timeout');
  await dropAll(c, [sid]);
  c.close();
}

async function scCodexStop() {
  const c = new Client(URL, TOKEN);
  await c.connect();
  const sid = 'acc-codex-2';
  c.act('new_session', { session_id: sid, backend: 'codex' });
  const ev = await c.wait((x) => x.post_type === 'session_ready' && x.session_id === sid, 40);
  if (!ev) { rec('8.codex_stop', false, 'no session_ready'); c.close(); return; }
  const e = c.act('send', { session_id: sid, text: '从1数到300' });
  const d = await c.wait((x) => x.post_type === 'delta' && x.session_id === sid, 120);
  if (!d) { rec('8.codex_stop', false, 'no delta'); c.close(); return; }
  await new Promise((r) => setTimeout(r, 1200));
  c.act('stop', { session_id: sid });
  const ab = await c.wait((x) => x.post_type === 'turn_aborted' && x.session_id === sid, 30);
  rec('8.codex_stop', !!ab, 'abort.reason=' + (ab && ab.reason));
  await dropAll(c, [sid]);
  c.close();
}

async function scOpenclaw() {
  const c = new Client(URL, TOKEN);
  await c.connect();
  const sid = 'acc-openclaw-1';
  c.act('new_session', { session_id: sid, backend: 'openclaw', gateway: 'openclaw' });
  let ev = await c.wait((x) => x.post_type === 'session_ready' && x.session_id === sid, 40);
  if (!ev) { rec('9.openclaw_basic', false, 'no session_ready'); c.close(); return; }
  const e2 = c.act('send', { session_id: sid, text: '1+1只回答数字' });
  ev = await c.wait((x) => (x.post_type === 'final' || x.post_type === 'error') && x.echo === e2, 120);
  const ok = ev && ev.post_type === 'final' && /2/.test(ev.text || '');
  rec('9.openclaw_basic', ok, ev ? 'final.text=' + JSON.stringify(ev.text) : 'timeout');
  await dropAll(c, [sid]);
  c.close();
}

const SCENARIOS = {
  all: [scBasic, scParallel, scBashDeny, scAskq, scStopResume, scMisc, scCodexBasic, scCodexStop, scOpenclaw],
  basic: [scBasic], parallel: [scParallel], bash_deny: [scBashDeny], askq: [scAskq],
  stop: [scStopResume], misc: [scMisc], codex_basic: [scCodexBasic], codex_stop: [scCodexStop],
  openclaw: [scOpenclaw],
};

(async () => {
  const list = SCENARIOS[SCENARIO] || SCENARIOS.all;
  for (const fn of list) {
    try { await fn(); } catch (e) { console.log('EXC in', fn.name, String(e)); }
  }
  fs.writeFileSync('test_results.json', JSON.stringify(RES, null, 1));
  const fails = Object.keys(RES).filter((k) => !RES[k].ok);
  console.log(fails.length ? 'SUMMARY_FAIL ' + fails.join(',') : 'SUMMARY_OK');
  process.exit(0);
})();
