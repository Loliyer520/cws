// cws WebUI — vanilla SPA over the bridge WS protocol (v0.2 + backend extensions).
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  ws: null,
  echo: 0,
  token: sessionStorage.getItem('cws_token') || '',
  sessions: new Map(),   // sid -> session info
  current: null,
  marks: JSON.parse(localStorage.getItem('cws_marks') || '{}'), // sid -> last mid
  seenMids: new Map(),   // sid -> Set(mid)
  channels: [],
  defaultChannel: '',
  streaming: null,
  thinking: null,
  asks: new Map(),
  chanModal: { editing: null },
};

const PERM_OPTIONS = {
  claude: [['default', '默认 · 按需询问'], ['acceptEdits', '接受编辑'], ['bypassPermissions', '完全允许'], ['plan', '只读规划']],
  codex: [['read-only', '只读'], ['workspace-write', '工作区可写'], ['full-auto', '绕过审批与沙箱'], ['danger-full-access', '完全访问']],
};

const BACKEND_LETTER = { claude: 'C', codex: 'X' };

// ---------- helpers ----------
function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 5200);
}

function seenMidsOf(sid) {
  if (!state.seenMids.has(sid)) state.seenMids.set(sid, new Set());
  return state.seenMids.get(sid);
}

function markSeen(sid, mid) {
  if (!mid) return;
  seenMidsOf(sid).add(mid);
  state.marks[sid] = mid;
  try { localStorage.setItem('cws_marks', JSON.stringify(state.marks)); } catch {}
}

function sessionOf(sid) {
  if (!state.sessions.has(sid)) {
    state.sessions.set(sid, { session_id: sid, alive: false, turn_active: false, channel: null, model: null, backend: 'claude', permission_mode: 'default', title: '', queued: false });
  }
  return state.sessions.get(sid);
}

function send(action, params) {
  if (!state.ws || state.ws.readyState !== 1) return null;
  state.echo += 1;
  const echo = 'e' + state.echo;
  state.ws.send(JSON.stringify({ action, params: params || {}, echo }));
  return echo;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

// ---------- connection ----------
function connect() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws?token=' + encodeURIComponent(state.token));
  state.ws = ws;
  ws.onopen = () => {
    $('conn-pill').classList.add('on');
    $('conn-pill').classList.remove('off');
    $('conn-text').textContent = '已连接';
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    sessionStorage.setItem('cws_token', state.token);
    send('channels.list');
    send('sessions.list');
    send('sessions.sync', { marks: state.marks, attach: state.current || undefined });
    // 直达会话：?sid=xxx 自动打开该会话
    const qp2 = new URLSearchParams(location.search);
    const sid = qp2.get('sid');
    if (sid && !state.current) openChat(sid);
  };
  ws.onmessage = (ev) => {
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    handle(frame);
  };
  ws.onclose = () => {
    $('conn-pill').classList.remove('on');
    $('conn-pill').classList.add('off');
    $('conn-text').textContent = '重连中…';
    setTimeout(connect, 5000);
  };
  ws.onerror = () => {};
}

$('login-btn').onclick = () => {
  state.token = $('token-input').value.trim();
  if (!state.token) { $('login-err').textContent = '请输入 Token'; $('login-err').classList.remove('hidden'); return; }
  connect();
};

// ---------- frame handler ----------
function handle(f) {
  switch (f.post_type) {
    case 'pong': break;
    case 'session_ready': onSessionReady(f); break;
    case 'session_queued': {
      const s = sessionOf(f.session_id);
      s.queued = true;
      s.title = '排队中 #' + f.position;
      renderSessionList();
      break;
    }
    case 'sessions': {
      for (const it of f.sessions) Object.assign(sessionOf(it.session_id), it);
      renderSessionList();
      break;
    }
    case 'history': onHistory(f); break;
    case 'sync_done': break;
    case 'user_msg': onUserMsg(f); break;
    case 'cc_msg': onCcMsg(f); break;
    case 'delta': onDelta(f); break;
    case 'thinking': onThinking(f); break;
    case 'tool_activity': onTool(f); break;
    case 'ask': onAsk(f); break;
    case 'ask_replied': onAskReplied(f); break;
    case 'final': onFinal(f); break;
    case 'turn_aborted': onAborted(f); break;
    case 'session_closed': {
      const s = sessionOf(f.session_id);
      s.alive = false; s.closed = true;
      renderSessionList();
      if (state.current === f.session_id) appendSys(f.session_id, '会话已关闭：' + f.reason);
      break;
    }
    case 'channels': {
      state.channels = f.channels || [];
      state.defaultChannel = f.default_channel || '';
      renderChannelOptions();
      renderChannelList();
      break;
    }
    case 'channels_saved': toast('渠道已保存：' + f.channel, 'ok'); send('channels.list'); hideChanForm(); break;
    case 'channels_deleted': toast('渠道已删除：' + f.channel); send('channels.list'); break;
    case 'channels_default': toast('默认渠道：' + (f.channel || '（机器默认）'), 'ok'); send('channels.list'); break;
    case 'channel_test': onChannelTest(f); break;
    case 'channel_models': {
      if (f.models && f.models.length) toast('模型列表：' + f.models.join('、'), 'ok');
      else toast('拉取失败：' + (f.error || '空'), 'err');
      break;
    }
    case 'permission_ack': onPermissionAck(f); break;
    case 'model_ack': {
      const s = sessionOf(f.session_id);
      s.channel = f.channel || null;
      s.model = f.model || null;
      renderSessionList(); refreshHead();
      toast(f.applied ? '模型/渠道已切换' : '已记录，下次生效', 'ok');
      break;
    }
    case 'send_ack': case 'stop_ack': break;
    case 'error': onError(f); break;
    default: console.log('unhandled', f);
  }
}

// ---------- session & messages ----------
function onSessionReady(f) {
  const s = sessionOf(f.session_id);
  Object.assign(s, {
    alive: true, turn_active: !!f.turn_active,
    channel: f.channel || null, model: f.model || null,
    backend: f.backend || s.backend || 'claude',
    permission_mode: f.permission_mode || s.permission_mode || 'default',
    queued: false,
  });
  if (!s.title) s.title = '会话 ' + f.session_id.slice(0, 12);
  renderSessionList();
  if (f.echo && f.echo.startsWith('new:')) {
    state.current = f.session_id;
    renderSessionList();
    openChat(f.session_id);
  }
}

function openChat(sid) {
  state.current = sid;
  const s = sessionOf(sid);
  closeStreaming();
  $('empty-hint').classList.add('hidden');
  $('messages').classList.remove('hidden');
  $('chat-head').classList.remove('hidden');
  $('chat-input').classList.remove('hidden');
  $('messages').innerHTML = '';
  refreshHead();
  const echo = send('new_session', { session_id: sid, permission_mode: s.permission_mode });
  state.attachEcho = echo;
}

function refreshHead() {
  const s = state.current ? state.sessions.get(state.current) : null;
  if (!s) return;
  $('chat-title').textContent = s.title || ('会话 ' + s.session_id.slice(0, 12));
  $('chat-meta').textContent = (s.backend === 'codex' ? 'codex' : 'claude') +
    ' · ' + (s.channel || '机器默认') + (s.model ? ' / ' + s.model : '') +
    (s.turn_active ? ' · 运行中' : '');
  const opts = PERM_OPTIONS[s.backend === 'codex' ? 'codex' : 'claude'];
  $('perm-select').innerHTML = opts.map((o) =>
    '<option value="' + o[0] + '"' + (o[0] === s.permission_mode ? ' selected' : '') + '>' + o[1] + '</option>').join('');
  const chans = [['', '机器默认']].concat(state.channels.map((c) => [c.name, c.label || c.name]));
  $('chan-select').innerHTML = chans.map((o) =>
    '<option value="' + o[0] + '"' + (o[0] === (s.channel || '') ? ' selected' : '') + '>' + o[1] + '</option>').join('');
  $('model-input').value = s.model || '';
  $('stop-btn').classList.toggle('hidden', !s.turn_active);
  $('send-btn').disabled = !!s.turn_active;
}

function renderSessionList() {
  const box = $('session-list');
  box.innerHTML = '';
  const items = Array.from(state.sessions.values()).sort((a, b) => (b.last_msg_ts || b.created_at || 0) - (a.last_msg_ts || a.created_at || 0));
  for (const s of items) {
    const row = el('div', 'sess' + (s.session_id === state.current ? ' active' : ''));
    const dot = el('div', 'dot' + (s.backend === 'codex' ? ' codex' : ''), BACKEND_LETTER[s.backend] || 'C');
    const info = el('div', 'info');
    const t = el('div', 't', s.title || ('会话 ' + s.session_id.slice(0, 12)));
    const m = el('div', 'm');
    if (s.queued) m.appendChild(el('span', null, '排队中'));
    else if (s.turn_active) m.appendChild(el('span', 'run', ''));
    m.appendChild(el('span', null, s.model || s.channel || ''));
    info.appendChild(t); info.appendChild(m);
    row.appendChild(dot); row.appendChild(info);
    row.onclick = () => { if (state.current !== s.session_id) openChat(s.session_id); };
    box.appendChild(row);
  }
}

function appendBlock(sid, role, text) {
  const box = $('messages');
  if (state.current !== sid) return null;
  const wrap = el('div', 'msg-wrap ' + role);
  const m = el('div', 'msg ' + role, text);
  wrap.appendChild(m);
  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  return m;
}

function appendSys(sid, text) {
  if (state.current !== sid) return;
  const wrap = el('div', 'msg-wrap sys');
  wrap.appendChild(el('div', 'msg sys', text));
  $('messages').appendChild(wrap);
}

function closeStreaming() {
  if (state.streaming) { state.streaming.classList.remove('streaming'); state.streaming = null; }
  if (state.thinking) { state.thinking.remove(); state.thinking = null; }
}

function onUserMsg(f) {
  const seen = seenMidsOf(f.session_id);
  if (seen.has(f.mid)) return;
  markSeen(f.session_id, f.mid);
  closeStreaming();
  appendBlock(f.session_id, 'user', f.text);
  const s = sessionOf(f.session_id);
  s.title = f.text.split('\n')[0].slice(0, 24);
  s.turn_active = true;
  renderSessionList(); refreshHead();
}

function onCcMsg(f) {
  const seen = seenMidsOf(f.session_id);
  if (seen.has(f.mid)) return;
  markSeen(f.session_id, f.mid);
  closeStreaming();
  appendBlock(f.session_id, 'cc', f.text);
}

function onDelta(f) {
  if (state.current !== f.session_id) return;
  if (!state.streaming) {
    const wrap = el('div', 'msg-wrap cc');
    state.streaming = el('div', 'msg cc streaming');
    wrap.appendChild(state.streaming);
    $('messages').appendChild(wrap);
  }
  state.streaming.textContent += f.text;
  $('messages').scrollTop = $('messages').scrollHeight;
}

function onThinking(f) {
  if (state.current !== f.session_id) return;
  if (!state.thinking) {
    state.thinking = el('div', 'thinking');
    const dots = el('span', 'dots');
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    dots.appendChild(el('i'));
    state.thinking.appendChild(dots);
    state.thinking.appendChild(el('span', 'tk-text'));
    $('messages').appendChild(state.thinking);
  }
  state.thinking.querySelector('.tk-text').textContent = '思考中 · ' + f.tokens + ' tokens';
  $('messages').scrollTop = $('messages').scrollHeight;
}

function onTool(f) {
  markSeen(f.session_id, f.mid);
  closeStreaming();
  appendBlock(f.session_id, 'tool', f.tool + '：' + (f.brief || ''));
}

function onHistory(f) {
  const seen = seenMidsOf(f.session_id);
  for (const e of f.messages || []) {
    if (e.id && seen.has(e.id)) continue;
    if (e.id) markSeen(f.session_id, e.id);
    if (e.role === 'user') appendBlock(f.session_id, 'user', e.text);
    else if (e.role === 'cc') appendBlock(f.session_id, 'cc', e.text);
    else if (e.role === 'tool') appendBlock(f.session_id, 'tool', e.text);
    else if (e.role === 'sys') appendSys(f.session_id, e.text);
  }
  if (f.last_mid) markSeen(f.session_id, f.last_mid);
}

function onFinal(f) {
  if (f.mid) {
    const seen = seenMidsOf(f.session_id);
    if (!seen.has(f.mid)) {
      markSeen(f.session_id, f.mid);
      closeStreaming();
      if (f.text) appendBlock(f.session_id, 'cc', f.text);
    }
  } else {
    closeStreaming();
    if (f.text) appendBlock(f.session_id, 'cc', f.text);
  }
  const s = sessionOf(f.session_id);
  s.turn_active = false;
  renderSessionList(); refreshHead();
  if (f.is_error) appendSys(f.session_id, '⚠ 本轮错误结束');
}

function onAborted(f) {
  const s = sessionOf(f.session_id);
  s.turn_active = false;
  closeStreaming();
  appendSys(f.session_id, '已中断：' + f.reason);
  renderSessionList(); refreshHead();
}

// ---------- ask cards ----------
const ICON_LOCK = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>';
const ICON_QUESTION = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6 6a2 2 0 1 1 3 1.5c-.8.5-1 .9-1 1.7M8 12.2v.1"/></svg>';

function onAsk(f) {
  if (state.current !== f.session_id) return;
  const card = el('div', 'ask-card');
  card.dataset.askId = f.ask_id;
  const h = el('h4');
  h.innerHTML = (f.kind === 'question' ? ICON_QUESTION : ICON_LOCK) + '<span></span>';
  h.querySelector('span').textContent = f.kind === 'question' ? '需要你回答' : '权限请求 · ' + f.tool_name;
  card.appendChild(h);
  if (f.kind === 'permission') {
    card.appendChild(el('div', 'pre', JSON.stringify(f.input, null, 1)));
  }
  const actions = el('div', 'ask-actions');
  if (f.kind === 'question') {
    const answers = {};
    const qs = (f.input && f.input.questions) || [];
    qs.forEach((q, qi) => {
      const w = el('div', 'ask-q');
      w.appendChild(el('div', 'qtext', (q.header ? q.header + ' — ' : '') + (q.question || '')));
      (q.options || []).forEach((o) => {
        const lab = el('label');
        const inp = document.createElement('input');
        inp.type = q.multiSelect ? 'checkbox' : 'radio';
        inp.name = 'askq-' + f.ask_id + '-' + qi;
        inp.value = o.label;
        inp.onchange = () => {
          const picked = Array.from(w.querySelectorAll('input:checked')).map((x) => x.value);
          if (q.multiSelect) answers[q.question] = picked;
          else if (picked.length) answers[q.question] = picked[0];
        };
        lab.appendChild(inp);
        lab.appendChild(document.createTextNode(o.label + (o.description ? ' — ' + o.description : '')));
        w.appendChild(lab);
      });
      card.appendChild(w);
    });
    const ok = el('button', 'btn primary', '提交回答');
    ok.onclick = () => {
      if (!Object.keys(answers).length) { toast('请先选择答案', 'err'); return; }
      const updatedInput = Object.assign({}, f.input, { answers });
      send('ask_reply', { session_id: f.session_id, ask_id: f.ask_id, behavior: 'allow', updatedInput });
      markAskAnswered(card);
    };
    actions.appendChild(ok);
    const later = el('button', 'btn ghost', '拒绝');
    later.onclick = () => {
      send('ask_reply', { session_id: f.session_id, ask_id: f.ask_id, behavior: 'deny', message: 'denied by user' });
      markAskAnswered(card);
    };
    actions.appendChild(later);
  } else {
    const allow = el('button', 'btn primary', '允许');
    allow.onclick = () => {
      send('ask_reply', { session_id: f.session_id, ask_id: f.ask_id, behavior: 'allow' });
      markAskAnswered(card);
    };
    actions.appendChild(allow);
    const deny = el('button', 'btn ghost', '拒绝');
    deny.onclick = () => {
      send('ask_reply', { session_id: f.session_id, ask_id: f.ask_id, behavior: 'deny', message: 'denied by user' });
      markAskAnswered(card);
    };
    actions.appendChild(deny);
  }
  card.appendChild(actions);
  state.asks.set(f.ask_id, card);
  $('messages').appendChild(card);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function markAskAnswered(card) {
  card.classList.add('ask-answered');
  card.querySelectorAll('button, input').forEach((x) => { x.disabled = true; });
  state.asks.delete(card.dataset.askId);
}

function onAskReplied(f) {
  const card = state.asks.get(f.ask_id);
  if (card) markAskAnswered(card);
}

function onPermissionAck(f) {
  const s = sessionOf(f.session_id);
  s.permission_mode = f.mode;
  renderSessionList(); refreshHead();
  toast('权限已切换：' + f.mode + (f.applied ? '' : '（下次生效）'), 'ok');
}

function onError(f) {
  if (f.code === 'busy') { toast(f.session_id + ' 正在运行，请稍候', 'err'); return; }
  toast((f.code || 'error') + (f.message ? ': ' + f.message : ''), 'err');
}

// ---------- chat input ----------
function doSend() {
  if (!state.current) return;
  const text = $('input').value.trim();
  if (!text) return;
  const s = sessionOf(state.current);
  $('input').value = '';
  autoGrow();
  send('send', { session_id: state.current, text, permission_mode: s.permission_mode });
}

function autoGrow() {
  const ta = $('input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
}

$('send-btn').onclick = doSend;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
});
$('input').addEventListener('input', autoGrow);
$('stop-btn').onclick = () => {
  if (state.current) send('stop', { session_id: state.current });
};
$('drop-btn').onclick = () => {
  if (!state.current) return;
  if (!confirm('删除会话 ' + state.current + '？（服务端记录清除）')) return;
  const sid = state.current;
  send('drop_session', { session_id: sid });
  state.sessions.delete(sid);
  delete state.marks[sid];
  try { localStorage.setItem('cws_marks', JSON.stringify(state.marks)); } catch {}
  state.current = null;
  closeStreaming();
  $('messages').classList.add('hidden');
  $('chat-head').classList.add('hidden');
  $('chat-input').classList.add('hidden');
  $('empty-hint').classList.remove('hidden');
  renderSessionList();
};
$('perm-select').onchange = () => {
  if (!state.current) return;
  send('set_permission', { session_id: state.current, mode: $('perm-select').value });
};
$('apply-model-btn').onclick = () => {
  if (!state.current) return;
  send('set_model', { session_id: state.current, channel: $('chan-select').value, model: $('model-input').value.trim() });
};

// ---------- new session modal ----------
function renderChannelOptions() {
  const sel = $('nm-channel');
  sel.innerHTML = '<option value="">（默认渠道）</option>' +
    state.channels.map((c) => '<option value="' + c.name + '">' + (c.label || c.name) + '</option>').join('');
}

$('new-session-btn').onclick = () => {
  $('nm-sid').value = '';
  $('nm-model').value = '';
  renderChannelOptions();
  refreshNewPerm();
  $('new-modal').classList.remove('hidden');
};
$('nm-backend').onchange = refreshNewPerm;
function refreshNewPerm() {
  const opts = PERM_OPTIONS[$('nm-backend').value === 'codex' ? 'codex' : 'claude'];
  $('nm-perm').innerHTML = opts.map((o) => '<option value="' + o[0] + '">' + o[1] + '</option>').join('');
}
$('nm-cancel').onclick = () => $('new-modal').classList.add('hidden');
$('nm-ok').onclick = () => {
  const sid = $('nm-sid').value.trim();
  state.echo += 1;
  const echo = 'new:' + state.echo;
  $('new-modal').classList.add('hidden');
  if (sid) sessionOf(sid);
  send('new_session', {
    session_id: sid || undefined,
    backend: $('nm-backend').value,
    channel: $('nm-channel').value,
    model: $('nm-model').value.trim(),
    permission_mode: $('nm-perm').value,
    echo,
  });
  if (sid) openChat(sid);
};

// ---------- channels modal ----------
$('channels-btn').onclick = () => {
  hideChanForm();
  send('channels.list');
  $('chan-modal').classList.remove('hidden');
};
$('chan-close').onclick = () => $('chan-modal').classList.add('hidden');

function renderChannelList() {
  const box = $('chan-list');
  box.innerHTML = '';
  for (const c of state.channels) {
    const item = el('div', 'chan-item');
    const grow = el('div', 'grow');
    const name = el('div', 'name');
    name.appendChild(document.createTextNode((c.label || c.name)));
    const tagName = el('span', 'tag gray', c.name);
    name.appendChild(tagName);
    if (c.default) name.appendChild(el('span', 'tag', '默认'));
    const detail = el('div', 'detail',
      c.base_url + ' · ' + c.protocol + '/' + (c.wire_api || 'responses') + (c.model ? ' · ' + c.model : '') +
      (c.key_tail ? ' · key…' + c.key_tail : ' · 无key') + ' · models:' + ((c.models || []).length || '-'));
    grow.appendChild(name); grow.appendChild(detail);
    item.appendChild(grow);
    const mk = (label, fn, cls) => {
      const b = el('button', 'btn ' + (cls || 'ghost'), label);
      b.onclick = fn;
      item.appendChild(b);
    };
    mk('默认', () => send('channels.set_default', { channel: c.name }));
    mk('测试', () => send('channel.test', { channel: c.name, model: c.model }));
    mk('编辑', () => openChanForm(c));
    mk('删', () => { if (confirm('删除渠道 ' + c.name + '？')) send('channels.delete', { channel: c.name }); }, 'danger');
    box.appendChild(item);
  }
}

function openChanForm(c) {
  c = c || null;
  state.chanModal.editing = c ? c.name : null;
  $('chan-form-title').textContent = c ? '编辑渠道：' + c.name : '新增渠道';
  $('cf-name').value = c ? c.name : '';
  $('cf-name').disabled = !!c;
  $('cf-label').value = c ? (c.label || '') : '';
  $('cf-base').value = c ? (c.base_url || '') : '';
  $('cf-protocol').value = c ? (c.protocol || 'auto') : 'auto';
  $('cf-wire').value = c ? (c.wire_api || 'responses') : 'responses';
  $('cf-model').value = c ? (c.model || '') : '';
  $('cf-key').value = '';
  $('cf-key').placeholder = c && c.key_tail ? '已配置（尾号' + c.key_tail + '），留空保留' : 'API Key';
  $('cf-env').value = '';
  $('chan-form').classList.remove('hidden');
}
function hideChanForm() {
  state.chanModal.editing = null;
  $('chan-form').classList.add('hidden');
}
$('chan-add').onclick = () => openChanForm(null);
$('cf-cancel').onclick = hideChanForm;
$('cf-save').onclick = () => {
  const name = $('cf-name').value.trim();
  if (!name) { toast('请填写渠道名称', 'err'); return; }
  send('channels.save', {
    name,
    label: $('cf-label').value.trim(),
    base_url: $('cf-base').value.trim(),
    protocol: $('cf-protocol').value,
    wire_api: $('cf-wire').value,
    model: $('cf-model').value.trim(),
    api_key: $('cf-key').value.trim(),
    api_key_env: $('cf-env').value.trim(),
  });
};
$('cf-test').onclick = () => {
  send('channel.test', {
    channel: state.chanModal.editing || $('cf-name').value.trim(),
    model: $('cf-model').value.trim(),
  });
};
$('cf-models').onclick = () => {
  send('channel.models', { channel: state.chanModal.editing || $('cf-name').value.trim() });
};
function onChannelTest(f) {
  if (f.ok) toast('渠道 ' + f.channel + ' 连通 ✓ ' + (f.model || '') + ' ' + f.latency_ms + 'ms', 'ok');
  else toast('渠道 ' + f.channel + ' 测试失败：' + f.error, 'err');
}

// ---------- init ----------
(function init() {
  // 可分享的直达链接：http://host/?token=... 直接进入控制台
  const qp = new URLSearchParams(location.search);
  if (qp.get('token')) state.token = qp.get('token');
  if (state.token) {
    $('token-input').value = state.token;
    connect();
  } else {
    $('login').classList.remove('hidden');
  }
  $('token-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('login-btn').click();
  });
})();
