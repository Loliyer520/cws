// cws WebUI — vanilla SPA over the bridge WS protocol (v0.2 + backend extensions).
'use strict';

const $ = (id) => document.getElementById(id);
const state = {
  ws: null,
  echo: 0,
  token: sessionStorage.getItem('cws_token') || '',
  sessions: new Map(),   // sid -> session info
  current: null,         // current sid
  marks: JSON.parse(localStorage.getItem('cws_marks') || '{}'), // sid -> last mid
  seenMids: new Map(),   // sid -> Set(mid)
  channels: [],
  defaultChannel: '',
  streaming: null,       // current streaming cc element
  thinking: null,        // thinking indicator element
  asks: new Map(),       // ask_id -> card element
  chanModal: { editing: null },
};

const PERM_OPTIONS = {
  claude: [['default', '默认（按需询问）'], ['acceptEdits', '接受编辑'], ['bypassPermissions', '完全允许'], ['plan', '只读规划']],
  codex: [['read-only', '只读'], ['workspace-write', '工作区可写'], ['full-auto', '绕过审批与沙箱'], ['danger-full-access', '完全访问']],
};

// ---------- helpers ----------
function toast(text, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 5000);
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

function send(action, params = {}) {
  if (!state.ws || state.ws.readyState !== 1) return null;
  state.echo += 1;
  const echo = 'e' + state.echo;
  state.ws.send(JSON.stringify({ action, params, echo }));
  return echo;
}

// ---------- connection ----------
function connect() {
  if (state.ws) { try { state.ws.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(proto + '//' + location.host + '/ws?token=' + encodeURIComponent(state.token));
  state.ws = ws;
  ws.onopen = () => {
    $('conn-dot').classList.add('on');
    $('conn-text').textContent = '已连接';
    $('login').classList.add('hidden');
    $('app').classList.remove('hidden');
    sessionStorage.setItem('cws_token', state.token);
    send('channels.list');
    send('sessions.list');
    send('sessions.sync', { marks: state.marks, attach: state.current || undefined });
  };
  ws.onmessage = (ev) => {
    let frame;
    try { frame = JSON.parse(ev.data); } catch { return; }
    handle(frame);
  };
  ws.onclose = () => {
    $('conn-dot').classList.remove('on');
    $('conn-text').textContent = '已断开，5s 后重连…';
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
      for (const it of f.sessions) {
        const s = sessionOf(it.session_id);
        Object.assign(s, it);
      }
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
    // created via UI: switch to it
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
  // (re)attach via takeover; server replies history + session_ready
  const echo = send('new_session', {
    session_id: sid,
    permission_mode: s.permission_mode,
  });
  // remember this echo → the session_ready from takeover is for us
  state.attachEcho = echo;
}

function refreshHead() {
  const s = state.current ? state.sessions.get(state.current) : null;
  if (!s) return;
  $('chat-title').textContent = s.title || ('会话 ' + s.session_id.slice(0, 12));
  $('chat-meta').textContent = (s.backend === 'codex' ? 'codex' : 'claude') +
    ' · ' + (s.channel || '机器默认') + (s.model ? ' / ' + s.model : '') +
    (s.turn_active ? ' · 运行中' : '');
  // permission select
  const opts = PERM_OPTIONS[s.backend === 'codex' ? 'codex' : 'claude'];
  $('perm-select').innerHTML = opts.map(([v, l]) =>
    '<option value="' + v + '"' + (v === s.permission_mode ? ' selected' : '') + '>' + l + '</option>').join('');
  // channel select
  const chans = [['', '机器默认'], ...state.channels.map((c) => [c.name, c.label || c.name])];
  $('chan-select').innerHTML = chans.map(([v, l]) =>
    '<option value="' + v + '"' + (v === (s.channel || '') ? ' selected' : '') + '>' + l + '</option>').join('');
  $('model-input').value = s.model || '';
  $('stop-btn').classList.toggle('hidden', !s.turn_active);
  $('send-btn').disabled = !!s.turn_active;
}

function renderSessionList() {
  const box = $('session-list');
  box.innerHTML = '';
  const items = [...state.sessions.values()].sort((a, b) => (b.last_msg_ts || b.created_at || 0) - (a.last_msg_ts || a.created_at || 0));
  for (const s of items) {
    const el = document.createElement('div');
    el.className = 'session-item' + (s.session_id === state.current ? ' active' : '');
    const t = document.createElement('div');
    t.className = 't';
    t.textContent = s.title || ('会话 ' + s.session_id.slice(0, 12));
    const m = document.createElement('div');
    m.className = 'm';
    const b1 = document.createElement('span');
    b1.className = 'badge' + (s.backend === 'codex' ? ' codex' : '');
    b1.textContent = s.backend === 'codex' ? 'codex' : 'claude';
    m.appendChild(b1);
    if (s.queued) {
      const bq = document.createElement('span');
      bq.className = 'badge run';
      bq.textContent = '排队中';
      m.appendChild(bq);
    } else if (s.turn_active) {
      const br = document.createElement('span');
      br.className = 'badge run';
      br.textContent = '运行中';
      m.appendChild(br);
    }
    const bm = document.createElement('span');
    bm.className = 'muted';
    bm.textContent = s.model || s.channel || '';
    m.appendChild(bm);
    el.appendChild(t); el.appendChild(m);
    el.onclick = () => {
      if (state.current !== s.session_id) openChat(s.session_id);
    };
    box.appendChild(el);
  }
}

function appendBlock(sid, role, text) {
  const box = $('messages');
  if (state.current !== sid) return null;
  const el = document.createElement('div');
  el.className = 'msg ' + role;
  el.textContent = text;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  return el;
}

function appendSys(sid, text) {
  if (state.current !== sid) return;
  const el = document.createElement('div');
  el.className = 'msg sys';
  el.textContent = text;
  $('messages').appendChild(el);
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
  s.title = f.text.split('\\n')[0].slice(0, 24);
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
    state.streaming = document.createElement('div');
    state.streaming.className = 'msg cc streaming';
    $('messages').appendChild(state.streaming);
  }
  state.streaming.textContent += f.text;
  $('messages').scrollTop = $('messages').scrollHeight;
}

function onThinking(f) {
  if (state.current !== f.session_id) return;
  if (!state.thinking) {
    state.thinking = document.createElement('div');
    state.thinking.className = 'thinking';
    $('messages').appendChild(state.thinking);
  }
  state.thinking.textContent = '🤔 思考中… ' + f.tokens + ' tokens';
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
function onAsk(f) {
  if (state.current !== f.session_id) return;
  const card = document.createElement('div');
  card.className = 'ask-card';
  card.dataset.askId = f.ask_id;
  const h = document.createElement('h4');
  h.textContent = f.kind === 'question' ? '❓ 需要你回答' : '🔐 权限请求：' + f.tool_name;
  card.appendChild(h);
  if (f.kind === 'permission') {
    const pre = document.createElement('div');
    pre.className = 'pre';
    pre.textContent = JSON.stringify(f.input, null, 1);
    card.appendChild(pre);
  }
  const actions = document.createElement('div');
  actions.className = 'ask-actions';
  if (f.kind === 'question') {
    // build answer UI: questions[{question, header, options[{label,description}], multiSelect}]
    const answers = {};
    const qs = (f.input && f.input.questions) || [];
    qs.forEach((q, qi) => {
      const w = document.createElement('div');
      w.className = 'ask-q';
      const qt = document.createElement('div');
      qt.className = 'qtext';
      qt.textContent = (q.header ? q.header + ' — ' : '') + (q.question || '');
      w.appendChild(qt);
      q.options.forEach((o) => {
        const lab = document.createElement('label');
        const inp = document.createElement('input');
        inp.type = q.multiSelect ? 'checkbox' : 'radio';
        inp.name = 'askq-' + f.ask_id + '-' + qi;
        inp.value = o.label;
        inp.onchange = () => {
          const picked = [...w.querySelectorAll('input:checked')].map((x) => x.value);
          if (q.multiSelect) answers[q.question] = picked;
          else if (picked.length) answers[q.question] = picked[0];
        };
        lab.appendChild(inp);
        lab.appendChild(document.createTextNode(o.label + (o.description ? ' — ' + o.description : '')));
        w.appendChild(lab);
      });
      card.appendChild(w);
    });
    const ok = document.createElement('button');
    ok.className = 'primary';
    ok.textContent = '提交回答';
    ok.onclick = () => {
      if (!Object.keys(answers).length) { toast('请先选择答案', 'err'); return; }
      const updatedInput = { ...f.input, answers };
      send('ask_reply', { session_id: f.session_id, ask_id: f.ask_id, behavior: 'allow', updatedInput });
      markAskAnswered(card);
    };
    actions.appendChild(ok);
    const later = document.createElement('button');
    later.className = 'ghost';
    later.textContent = '拒绝（模型转纯文本）';
    later.onclick = () => {
      send('ask_reply', { session_id: f.session_id, ask_id: f.ask_id, behavior: 'deny', message: 'denied by user' });
      markAskAnswered(card);
    };
    actions.appendChild(later);
  } else {
    const allow = document.createElement('button');
    allow.className = 'primary';
    allow.textContent = '允许';
    allow.onclick = () => {
      send('ask_reply', { session_id: f.session_id, ask_id: f.ask_id, behavior: 'allow' });
      markAskAnswered(card);
    };
    actions.appendChild(allow);
    const deny = document.createElement('button');
    deny.className = 'danger';
    deny.textContent = '拒绝';
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
  card.querySelectorAll('button, input').forEach((x) => (x.disabled = true));
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
  send('send', { session_id: state.current, text, permission_mode: s.permission_mode });
}

$('send-btn').onclick = doSend;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  else if (e.key === 'Enter') {
    // allow newline via Shift+Enter naturally
  }
});
$('stop-btn').onclick = () => {
  if (state.current) send('stop', { session_id: state.current });
};
$('drop-btn').onclick = () => {
  if (!state.current) return;
  if (!confirm('删除会话 ' + state.current + '？（本地历史保留，服务端记录清除）')) return;
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
  const channel = $('chan-select').value;
  const model = $('model-input').value.trim();
  send('set_model', { session_id: state.current, channel, model });
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
  $('nm-perm').innerHTML = opts.map(([v, l]) => '<option value="' + v + '">' + l + '</option>').join('');
}
$('nm-cancel').onclick = () => $('new-modal').classList.add('hidden');
$('nm-ok').onclick = () => {
  const sid = $('nm-sid').value.trim();
  const backend = $('nm-backend').value;
  const channel = $('nm-channel').value;
  const model = $('nm-model').value.trim();
  const permission_mode = $('nm-perm').value;
  state.echo += 1;
  const echo = 'new:' + state.echo;
  $('new-modal').classList.add('hidden');
  if (sid) {
    // may be a takeover of an existing session (same semantics)
    sessionOf(sid);
  }
  send('new_session', { session_id: sid || undefined, backend, channel, model, permission_mode, echo });
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
    const item = document.createElement('div');
    item.className = 'chan-item';
    const grow = document.createElement('div');
    grow.className = 'grow';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = (c.label || c.name) + ' (' + c.name + ')';
    if (c.default) {
      const tag = document.createElement('span');
      tag.className = 'tag-default';
      tag.textContent = '默认';
      name.appendChild(document.createTextNode(' '));
      name.appendChild(tag);
    }
    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.textContent = c.base_url + ' · ' + c.protocol + (c.model ? ' · ' + c.model : '') +
      (c.key_tail ? ' · key尾号' + c.key_tail : ' · 无key') + ' · models:' + ((c.models || []).length || '-');
    grow.appendChild(name); grow.appendChild(detail);
    item.appendChild(grow);
    const mk = (label, fn, cls = 'ghost') => {
      const b = document.createElement('button');
      b.className = cls;
      b.textContent = label;
      b.onclick = fn;
      item.appendChild(b);
    };
    mk('设为默认', () => send('channels.set_default', { channel: c.name }));
    mk('测试', () => send('channel.test', { channel: c.name, model: c.model }));
    mk('编辑', () => openChanForm(c));
    mk('删除', () => { if (confirm('删除渠道 ' + c.name + '？')) send('channels.delete', { channel: c.name }); }, 'danger');
    box.appendChild(item);
  }
}

function openChanForm(c = null) {
  state.chanModal.editing = c ? c.name : null;
  $('chan-form-title').textContent = c ? '编辑渠道：' + c.name : '新增渠道';
  $('cf-name').value = c ? c.name : '';
  $('cf-name').disabled = !!c;
  $('cf-label').value = c ? (c.label || '') : '';
  $('cf-base').value = c ? (c.base_url || '') : '';
  $('cf-protocol').value = c ? (c.protocol || 'auto') : 'auto';
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
  if (f.ok) toast('渠道 ' + f.channel + ' 连通 ✓ ' + f.model + ' ' + f.latency_ms + 'ms', 'ok');
  else toast('渠道 ' + f.channel + ' 测试失败：' + f.error, 'err');
}

// ---------- init ----------
(function init() {
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
