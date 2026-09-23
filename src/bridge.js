// cc-bridge (Node) — Bridge: WS routing, queue, rate limits, channel management.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BaseSession } from './base-session.js';
import { ClaudeSession } from './claude-session.js';
import { CodexSession } from './codex-session.js';
import { OpenclawSession } from './openclaw-session.js';
import {
  TOKEN, ONE_TIME_TOKENS, WORKSPACES, MAX_ACTIVE, QUEUE_MAX, MIN_TURN_INTERVAL,
  IDLE_TIMEOUT, WS_RETENTION_S, API_CHANNELS, channelState, setDefaultChannel, channelByName,
  persistOneTimeTokens, persistChannels, normalizeBaseUrl, isValidChannelName,
  CLAUDE_BIN, CODEX_BIN, DEFAULT_BACKEND, GATEWAYS, gatewayByName,
  setClaudeBin, setCodexBin, setDefaultBackend, setGateways, persistBackends,
} from './config.js';
import { log, now, isValidSid, safeEqual, sleep, briefOf, procAlive } from './util.js';

/** Session factory: backend from explicit param → sess.json → config default. */
export function makeSession(bridge, sid, ws, opts = {}) {
  const backend = opts.backend || null;
  if (backend === 'codex') return new CodexSession(bridge, sid, ws, opts);
  if (backend === 'openclaw') return new OpenclawSession(bridge, sid, ws, opts);
  if (backend === 'claude') return new ClaudeSession(bridge, sid, ws, opts);
  // revive: read backend from sess.json meta
  const meta = loadSessMetaRaw(sid);
  if (meta.backend === 'codex') return new CodexSession(bridge, sid, ws, opts);
  if (meta.backend === 'openclaw') return new OpenclawSession(bridge, sid, ws, opts);
  return new ClaudeSession(bridge, sid, ws, opts);
}

function loadSessMetaRaw(sid) {
  try {
    return JSON.parse(fs.readFileSync(path.join(WORKSPACES, sid, 'sess.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** openclaw 会话被销毁时删远端网关记录（会话不在内存也要删，lazy 路径）。
 *  异步执行不阻塞回帧；失败只记日志（本地已删，远端残留仅影响网关侧）。 */
async function remoteDeleteOpenclaw(meta, sid) {
  try {
    const { getGateway } = await import('./gateway.js');
    const gw = await getGateway(meta.gateway || 'openclaw');
    await gw.client.request('sessions.delete', {
      key: meta.remote_key,
      agentId: meta.agent_id || undefined,
      deleteTranscript: true,
    });
    log('openclaw_remote_deleted', { session_id: sid, remote_key: meta.remote_key, lazy: true });
  } catch (e) {
    log('openclaw_remote_delete_err', { session_id: sid, lazy: true, err: String(e) });
  }
}

function sidecarMode(sid) {
  const meta = loadSessMetaRaw(sid);
  return (meta && meta.permission_mode) || null;
}

export class Bridge {
  constructor() {
    this.sessions = new Map(); // sid -> session
    this.queue = []; // [{sid, ws, echo, ts, permissionMode, channel, model, backend}]
    this.conns = new Set();
    this.gateLock = Promise.resolve();
    this.last_turn_start = 0.0;
    this.maxActive = MAX_ACTIVE;
    this.maxQueue = QUEUE_MAX;
    this.reaperTimer = setInterval(() => { this.idleReap().catch(() => {}); }, 60_000);
    // 磁盘清扫：启动后 15s 先跑一次，之后每小时一次
    this.sweepTimer = setInterval(() => { try { this.sweepWorkspaces(); } catch {} }, 3600_000);
    setTimeout(() => { try { this.sweepWorkspaces(); } catch {} }, 15_000);
  }

  // ---------- capacity / gating ----------
  activeCount() {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.holdsSlot ? s.holdsSlot() : (s.started_once && (!s.proc || procAlive(s.proc)))) n += 1;
    }
    return n;
  }

  async turnGate() {
    let release;
    const prev = this.gateLock;
    this.gateLock = new Promise((res) => { release = res; });
    await prev;
    try {
      const wait = MIN_TURN_INTERVAL - (now() - this.last_turn_start);
      if (wait > 0) await sleep(wait * 1000);
      this.last_turn_start = now();
    } finally {
      release();
    }
  }

  notifyCapacityChange() {
    this._promoteQueue().catch(() => {});
  }

  async _promoteQueue() {
    while (this.queue.length && this.activeCount() < this.maxActive) {
      const item = this.queue.shift();
      const { sid, ws, echo } = item;
      if (ws.readyState !== ws.OPEN || this.sessions.has(sid)) continue;
      const s = makeSession(this, sid, ws, {
        permissionMode: item.permissionMode, channel: item.channel,
        model: item.model, backend: item.backend,
      });
      this.sessions.set(sid, s);
      s.pending_echo = echo;
      try {
        if (s.backend !== 'claude') {
          await this._announceReady(s, echo);
        } else {
          await s.start();
        }
      } catch (e) {
        await this._wsSend(ws, {
          post_type: 'error', session_id: sid, code: 'spawn_failed', message: String(e), echo,
        });
        this.sessions.delete(sid);
        continue;
      }
      if (s.turn_log.length) {
        await this._sendHistory(ws, sid, s._replayMessages(), echo);
      }
    }
  }

  async _announceReady(s, echo) {
    s.ready_announced = true;
    await s.sendWs({
      post_type: 'session_ready', session_id: s.id,
      model: s.model_name, channel: (s.channel || {}).name,
      turn_active: s.turn_active, permission_mode: s.permission_mode,
      backend: s.backend, gateway: s.gatewayName || null, echo,
    });
  }

  // ---------- ws plumbing ----------
  async _wsSend(ws, obj) {
    if (!ws || ws.readyState !== ws.OPEN) return;
    if (obj.post_type === 'error') {
      log('error_reply', {
        code: obj.code, session_id: obj.session_id, action_echo: obj.echo,
      });
    }
    try {
      ws.send(JSON.stringify(obj));
    } catch { /* ignore */ }
  }

  async _sendHistory(ws, sid, entries, echo = null) {
    await this._wsSend(ws, {
      post_type: 'history', session_id: sid,
      messages: entries,
      last_ts: entries.length ? entries[entries.length - 1].ts : null,
      last_mid: entries.length ? entries[entries.length - 1].id : null,
      echo,
    });
  }

  handleConn(ws) {
    this.conns.add(ws);
    log('conn_open', {});
    ws.on('message', async (data) => {
      let frame;
      try {
        frame = JSON.parse(data.toString());
      } catch {
        await this._wsSend(ws, { post_type: 'error', code: 'bad_json' });
        return;
      }
      await this.route(ws, frame).catch((e) => {
        log('route_err', { err: String(e) });
        this._wsSend(ws, { post_type: 'error', code: 'internal', message: String(e) }).catch(() => {});
      });
    });
    ws.on('close', async () => {
      this.conns.delete(ws);
      log('conn_close', {});
      await this.onWsClosed(ws);
    });
  }

  async onWsClosed(ws) {
    for (const s of this.sessions.values()) {
      if (s.ws === ws && !s.closed) {
        s.detached = true;
        s.ws = null;
        if (!s.turn_active && procAlive(s.proc)) {
          if (s._killpg) s._killpg();
        }
      }
    }
    this.queue = this.queue.filter((q) => q.ws !== ws);
    this.notifyCapacityChange();
  }

  async idleReap() {
    if (IDLE_TIMEOUT <= 0) return;
    const cut = now() - IDLE_TIMEOUT;
    for (const [sid, s] of [...this.sessions.entries()]) {
      if (!s.closed && !s.turn_active && s.last_activity < cut) {
        await s.close('idle_timeout');
        this.sessions.delete(sid);
      }
    }
    const stale = this.queue.filter((q) => q.ts <= cut);
    if (stale.length) {
      this.queue = this.queue.filter((q) => q.ts > cut);
      for (const q of stale) {
        await this._wsSend(q.ws, {
          post_type: 'error', session_id: q.sid, code: 'queue_timeout', echo: q.echo,
        });
      }
    }
    this.notifyCapacityChange();
  }

  /** 磁盘 workspace 清扫：注册表里不存在的目录，mtime 超过保留期(WS_RETENTION_S)才删。
   *  近期关闭的会话目录仍在保留期内，可按 sid revive（sess.json 还在）。 */
  sweepWorkspaces() {
    if (WS_RETENTION_S <= 0) return;
    const cutMs = (now() - WS_RETENTION_S) * 1000;
    let ents;
    try {
      ents = fs.readdirSync(WORKSPACES, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of ents) {
      const sid = ent.name;
      if (!ent.isDirectory() || !isValidSid(sid)) continue;
      if (this.sessions.has(sid)) continue;
      const dir = path.join(WORKSPACES, sid);
      let st;
      try {
        st = fs.statSync(dir);
      } catch {
        continue;
      }
      if (Math.max(st.mtimeMs, st.atimeMs || 0) >= cutMs) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        log('ws_swept', { session_id: sid, age_days: Math.round((Date.now() - Math.max(st.mtimeMs, st.atimeMs || 0)) / 86400000) });
      } catch { /* ignore */ }
    }
  }

  shutdown() {
    clearInterval(this.reaperTimer);
    clearInterval(this.sweepTimer);
    const jobs = [];
    for (const s of this.sessions.values()) jobs.push(s.close('bridge_shutdown', false));
    return Promise.all(jobs);
  }

  // ---------- routing ----------
  async route(ws, frame) {
    const action = frame.action;
    const params = frame.params || {};
    const echo = frame.echo;
    switch (action) {
      case 'ping':
        await this._wsSend(ws, { post_type: 'pong', ts: now(), echo });
        break;
      case 'kx.chat':
        await this.kxChat(ws, params, echo);
        break;
      case 'new_session':
        await this.newSession(ws, params, echo);
        break;
      case 'sessions.sync':
        await this.sessionsSync(ws, params, echo);
        break;
      case 'send':
        await this.onSend(ws, params, echo);
        break;
      case 'stop': {
        const s = this.sessions.get(params.session_id);
        if (!s || s.closed) {
          await this._wsSend(ws, {
            post_type: 'error', code: 'unknown_session', session_id: params.session_id, echo,
          });
        } else {
          await s.abort('user');
          await this._wsSend(ws, { post_type: 'stop_ack', session_id: params.session_id, echo });
        }
        break;
      }
      case 'drop_session': {
        const sid = params.session_id;
        if (!isValidSid(sid)) {
          await this._wsSend(ws, { post_type: 'error', code: 'bad_session_id', echo });
          break;
        }
        const s = this.sessions.get(sid);
        if (s) this.sessions.delete(sid);
        this.queue = this.queue.filter((q) => q.sid !== sid);
        // 销毁=盘上记录一并删除：内存会话和已回收的 lazy 会话统一处理，
        // 否则闲置回收过的会话只回帧不删盘，换个端 sync 又能复活
        const meta = s ? null : loadSessMetaRaw(sid); // 内存会话由 close() 里删远端
        try {
          fs.rmSync(path.join(WORKSPACES, sid), { recursive: true, force: true });
        } catch { /* ignore */ }
        if (meta && meta.backend === 'openclaw' && meta.remote_key) {
          remoteDeleteOpenclaw(meta, sid).catch(() => {});
        }
        if (s && !s.closed) {
          await s.close('dropped', true, echo);
        } else {
          await this._wsSend(ws, { post_type: 'session_closed', session_id: sid, reason: 'dropped', echo });
        }
        this.notifyCapacityChange();
        break;
      }
      case 'sessions.list': {
        const out = [];
        for (const s of this.sessions.values()) {
          out.push({
            session_id: s.id,
            alive: procAlive(s.proc),
            turn_active: s.turn_active,
            created_at: s.created_at,
            last_turn_at: s.last_turn_at,
            last_msg_ts: s.turn_log.length ? s.turn_log[s.turn_log.length - 1].ts : null,
            last_mid: s.turn_log.length ? s.turn_log[s.turn_log.length - 1].id : null,
            channel: (s.channel || {}).name,
            model: s.model_name,
            backend: s.backend,
            gateway: s.gatewayName || null,
            permission_mode: s.permission_mode,
            title: s.turnTitle(),
            remark: s.remark || '',
          });
        }
        for (const q of this.queue) {
          out.push({
            session_id: q.sid, alive: false, turn_active: false,
            queued: true, queue_position: this.queue.indexOf(q) + 1,
          });
        }
        // 盘上 lazy 会话一并列出：idle 回收/桥重启后内存是空的，但 turnlog
        // 还在盘上——清单若只报内存会话，客户端重启后服务端列表为空，
        // 会话就像"丢了"（客户端孤儿剪枝还会误剪它们的状态条目）。
        // 只读 sess.json + turnlog 还原展示字段，不登记进内存（注册会让
        // idle reaper 反复 reap/注册循环，还会重复广播 session_closed）
        const seen = new Set(out.map((e) => e.session_id));
        let diskEnts = [];
        try {
          diskEnts = fs.readdirSync(WORKSPACES, { withFileTypes: true });
        } catch { /* ignore */ }
        for (const ent of diskEnts) {
          if (!ent.isDirectory() || !isValidSid(ent.name) || seen.has(ent.name)) continue;
          const dir = path.join(WORKSPACES, ent.name);
          let lines;
          try {
            lines = fs.readFileSync(path.join(dir, 'turnlog.jsonl'), 'utf8').split('\n').filter(Boolean);
          } catch {
            continue; // 没有 turnlog = 不是可恢复会话（懒恢复判据同 sessionsSync）
          }
          const meta = loadSessMetaRaw(ent.name);
          let last = null;
          let title = '';
          for (let i = lines.length - 1; i >= 0; i--) {
            let rec;
            try { rec = JSON.parse(lines[i]); } catch { continue; }
            if (!last) last = rec;
            if (rec.role === 'user' && !title) {
              title = String(rec.text || '').trim().split('\n')[0].trim().slice(0, 24);
            }
            if (last && title) break; // 尾条 + 标题都有了；turnlog 有上限，扫全量也廉价
          }
          out.push({
            session_id: ent.name,
            alive: false,
            turn_active: false,
            lazy: true,
            created_at: null,
            last_turn_at: last ? (last.ts || null) : null,
            last_msg_ts: last ? (last.ts || null) : null,
            last_mid: last ? (last.id || null) : null,
            channel: meta.channel || null,
            model: meta.model || null,
            backend: meta.backend || 'claude',
            gateway: meta.gateway || null,
            permission_mode: meta.permission_mode || null,
            title,
            remark: meta.remark || '',
          });
        }
        await this._wsSend(ws, { post_type: 'sessions', sessions: out, echo });
        break;
      }
      case 'channels.list': {
        const chans = [];
        for (const ch of API_CHANNELS) {
          if (!ch || typeof ch !== 'object') continue;
          const key = String(ch.api_key || '');
          chans.push({
            name: ch.name, label: ch.label || ch.name,
            base_url: ch.base_url || '', protocol: ch.protocol || 'anthropic',
            wire_api: ch.wire_api || 'responses', http_headers: ch.http_headers || {},
            model: ch.model || '', models: ch.models || [],
            key_tail: key.slice(-4),
            default: ch.name === channelState.defaultChannel,
          });
        }
        await this._wsSend(ws, { post_type: 'channels', channels: chans, default_channel: channelState.defaultChannel, echo });
        break;
      }
      case 'channels.save':
        await this.channelsSave(ws, params, echo);
        break;
      case 'channels.delete':
        await this.channelsDelete(ws, params, echo);
        break;
      case 'channels.set_default': {
        const name = String(params.channel || '').trim();
        if (name && !channelByName(name)) {
          await this._wsSend(ws, { post_type: 'error', code: 'bad_channel', channel: name, echo });
          break;
        }
        setDefaultChannel(name);
        persistChannels();
        log('default_channel', { channel: name });
        await this._wsSend(ws, { post_type: 'channels_default', channel: name, echo });
        break;
      }
      case 'channel.test':
        await this.channelTest(ws, params, echo);
        break;
      case 'channel.models':
        await this.channelModels(ws, params, echo);
        break;
      case 'set_model':
        await this.setModel(ws, params, echo);
        break;
      case 'ask_reply': {
        const s = this.sessions.get(params.session_id);
        if (!s || s.closed) {
          await this._wsSend(ws, { post_type: 'error', code: 'unknown_session', echo });
        } else {
          await s.askReply(params.ask_id, params.behavior, params.message, params.updatedInput, echo);
        }
        break;
      }
      case 'set_permission': {
        const s = this.sessions.get(params.session_id);
        if (!s || s.closed) {
          await this._wsSend(ws, {
            post_type: 'error', code: 'unknown_session', session_id: params.session_id, echo,
          });
        } else {
          await s.setPermission(params.mode, echo);
        }
        break;
      }
      case 'session.remark': {
        // 会话备注上云：跨设备共享的落点是 sess.json（桥重启/idle 回收后仍在）。
        // 内存会话走 _saveSessMeta 白名单；lazy 会话（不在内存）不能为一条
        // 备注拉起整个会话对象——原样合并进盘上 sess.json
        const sid = params.session_id;
        const remark = String(params.remark || '').trim().slice(0, 60);
        if (!isValidSid(sid)) {
          await this._wsSend(ws, { post_type: 'error', code: 'bad_session_id', echo });
          break;
        }
        const rs = this.sessions.get(sid);
        if (rs && !rs.closed) {
          rs.remark = remark;
          rs._saveSessMeta();
        } else if (fs.existsSync(path.join(WORKSPACES, sid, 'turnlog.jsonl'))) {
          try {
            const meta = loadSessMetaRaw(sid);
            meta.remark = remark;
            fs.writeFileSync(path.join(WORKSPACES, sid, 'sess.json'), JSON.stringify(meta));
          } catch {
            await this._wsSend(ws, {
              post_type: 'error', code: 'remark_save_failed', session_id: sid, echo,
            });
            break;
          }
        } else {
          await this._wsSend(ws, {
            post_type: 'error', code: 'unknown_session', session_id: sid, echo,
          });
          break;
        }
        await this._wsSend(ws, { post_type: 'session_remark', session_id: sid, remark, echo });
        break;
      }
      case 'backends.list':
        await this.backendsList(ws, echo);
        break;
      case 'backends.save':
        await this.backendsSave(ws, params, echo);
        break;
      case 'backends.test':
        await this.backendsTest(ws, params, echo);
        break;
      default:
        await this._wsSend(ws, { post_type: 'error', code: 'unknown_action', action, echo });
    }
  }

  async onSend(ws, params, echo) {
    const sid = params.session_id;
    let s = this.sessions.get(sid);
    if (!s || s.closed) {
      // lazy revive: turnlog on disk means the session exists server-side
      if (isValidSid(sid) && fs.existsSync(path.join(WORKSPACES, sid, 'turnlog.jsonl'))) {
        s = makeSession(this, sid, null, {
          resume: true, permissionMode: params.permission_mode,
        });
        s.ready_announced = true;
        this.sessions.set(sid, s);
        log('revive_on_send', { session_id: sid });
      } else {
        s = null;
      }
    }
    if (!s) {
      await this._wsSend(ws, {
        post_type: 'error', code: 'unknown_session', session_id: sid, echo,
      });
      return;
    }
    s.ws = ws;
    // global permission switch from the sending client
    const hint = params.permission_mode;
    if (hint && hint !== s.permission_mode) {
      s.launch_mode = hint;
      s.permission_mode = hint;
      s.pending_mode = hint;
      s._saveSessMeta();
      log('send_mode_sync', { session_id: sid, permission_mode: hint });
    }
    if (!s.turn_active) {
      await this._wsSend(ws, { post_type: 'send_ack', session_id: sid, echo });
    }
    await s.startTurn(params.text || '', echo, params.images);
  }

  async newSession(ws, params, echo) {
    const sid = params.session_id || crypto.randomBytes(16).toString('hex');
    if (!isValidSid(sid)) {
      await this._wsSend(ws, { post_type: 'error', code: 'bad_session_id', echo });
      return;
    }
    // 客户端自带的 new: 标记回传：session_ready 原先只回外层 echo，webui/手表
    // 按 new: 前缀匹配"创建后自动进会话"的路径从未触发过（都靠手点列表兜底）
    if (params.echo) echo = params.echo;
    // explicit channel must exist; default channel applies only to brand-new sessions
    let channel = null;
    if (params.channel) {
      channel = channelByName(params.channel);
      if (!channel) {
        await this._wsSend(ws, { post_type: 'error', code: 'bad_channel', channel: params.channel, echo });
        return;
      }
    }
    const model = params.model || null;
    const backend = params.backend === 'codex' ? 'codex'
      : (params.backend === 'openclaw' ? 'openclaw'
        : (params.backend === 'claude' ? 'claude' : null));
    const existing = this.sessions.get(sid);
    if (existing && !existing.closed) {
      // same-name reconnect = takeover: rebind ws, resync identity, never restart
      existing.ws = ws;
      existing.detached = false;
      const procAliveNow = procAlive(existing.proc);
      let changed = false;
      if (channel && channel.name !== (existing.channel || {}).name) {
        existing.channel = channel;
        existing.model_name = model || channel.model || null;
        changed = true;
        log('takeover_sync', { session_id: sid, channel: channel.name, model: existing.model_name, deferred: procAliveNow });
      } else if (model && model !== existing.model_name) {
        existing.model_name = model;
        changed = true;
        log('takeover_sync', { session_id: sid, model, deferred: procAliveNow });
      }
      const wantMode = params.permission_mode;
      if (wantMode && existing.permission_mode !== wantMode) {
        existing.launch_mode = wantMode;
        existing.permission_mode = wantMode;
        if (procAliveNow) {
          if (existing.turn_active) existing.pending_mode = wantMode;
          else existing._deferSwitchMode && existing._deferSwitchMode(wantMode);
        }
        changed = true;
        log('takeover_sync', { session_id: sid, permission_mode: wantMode, deferred: procAliveNow });
      }
      if (changed) existing._saveSessMeta();
      for (const entry of existing.pending_asks.values()) {
        if (entry.ask_frame) await this._wsSend(ws, entry.ask_frame);
      }
      await this._sendHistory(ws, sid, existing._replayMessages(), echo);
      await this._wsSend(ws, {
        post_type: 'session_ready', session_id: sid,
        model: existing.model_name,
        channel: (existing.channel || {}).name,
        turn_active: existing.turn_active,
        permission_mode: existing.permission_mode,
        backend: existing.backend,
        gateway: existing.gatewayName || null,
        echo,
      });
      log('takeover', {
        session_id: sid, replay: existing.turn_log.length,
        pending_asks: existing.pending_asks.size, turn_active: existing.turn_active,
      });
      if (!existing.turn_active && !procAliveNow && existing.turn_log.length
          && this.activeCount() < this.maxActive && existing.backend === 'claude') {
        existing._warmStart().catch(() => {});
      }
      return;
    }
    if (this.queue.some((q) => q.sid === sid)) {
      await this._wsSend(ws, { post_type: 'error', session_id: sid, code: 'exists', message: 'session already queued', echo });
      return;
    }
    if (!channel && channelState.defaultChannel) channel = channelByName(channelState.defaultChannel);
    // 后端-渠道协议校验：anthropic 渠道只配 claude，openai 渠道只配 codex
    if (channel && !this._channelProtocolOk(backend, channel)) {
      await this._wsSend(ws, {
        post_type: 'error', code: 'bad_backend_channel', channel: channel.name,
        message: (backend === 'codex'
          ? 'codex 后端不能使用 anthropic 协议渠道 ' + channel.name + '（glm/kimi），请选 openai 协议渠道或机器默认'
          : 'claude 后端不能使用 openai 协议渠道 ' + channel.name + '，请选 anthropic 协议渠道'),
        echo,
      });
      return;
    }
    if (params.resume) {
      const s = makeSession(this, sid, ws, {
        resume: true, permissionMode: params.permission_mode,
        channel, model, backend,
        gateway: params.gateway, remoteKey: params.remote_key, agentId: params.agent,
      });
      this.sessions.set(sid, s);
      s.ready_announced = true;
      const replay = s._replayMessages();
      if (replay.length) await this._sendHistory(ws, sid, replay, echo);
      await this._wsSend(ws, {
        post_type: 'session_ready', session_id: sid,
        model: s.model_name, channel: (s.channel || {}).name,
        turn_active: s.turn_active, permission_mode: s.permission_mode,
        backend: s.backend, gateway: s.gatewayName || null, echo,
      });
      const warm = replay.length && this.activeCount() < this.maxActive && s.backend === 'claude';
      if (warm) s._warmStart().catch(() => {});
      log('resume_lazy', { session_id: sid, replay: replay.length, warm });
      return;
    }
    if (this.activeCount() >= this.maxActive) {
      if (this.queue.length >= this.maxQueue) {
        await this._wsSend(ws, {
          post_type: 'error', code: 'queue_full', message: 'session queue is full', echo,
        });
        return;
      }
      this.queue.push({
        sid, ws, echo, ts: now(),
        permissionMode: params.permission_mode, channel, model, backend,
      });
      await this._wsSend(ws, {
        post_type: 'session_queued', session_id: sid, position: this.queue.length, echo,
      });
      log('queued', { session_id: sid, position: this.queue.length });
      return;
    }
    const s = makeSession(this, sid, ws, {
      permissionMode: params.permission_mode, channel, model, backend,
      gateway: params.gateway, remoteKey: params.remote_key, agentId: params.agent,
    });
    this.sessions.set(sid, s);
    s.pending_echo = echo;
    try {
      if (s.backend !== 'claude') {
        await this._announceReady(s, echo);
        s.pending_echo = null;
      } else {
        await s.start();
      }
    } catch (e) {
      await this._wsSend(ws, {
        post_type: 'error', session_id: sid, code: 'spawn_failed', message: String(e), echo,
      });
      this.sessions.delete(sid);
      return;
    }
    if (s.turn_log.length) {
      await this._sendHistory(ws, sid, s._replayMessages(), echo);
    }
  }

  async sessionsSync(ws, params, echo) {
    let marks = params.marks || {};
    if (typeof marks !== 'object' || Array.isArray(marks)) marks = {};
    const attach = params.attach;
    const sids = [...this.sessions.keys(), ...Object.keys(marks).filter((sid) => !this.sessions.has(sid))];
    let count = 0;
    for (const sid of sids) {
      if (!isValidSid(sid)) continue;
      let s = this.sessions.get(sid);
      if (!s || s.closed) {
        if (!fs.existsSync(path.join(WORKSPACES, sid, 'turnlog.jsonl'))) continue;
        s = makeSession(this, sid, null, {
          resume: true,
          permissionMode: sidecarMode(sid) || params.permission_mode,
        });
        s.ready_announced = true;
        this.sessions.set(sid, s);
      }
      const rep = s._replayAfter(marks[sid]);
      if (rep.length) {
        await this._sendHistory(ws, sid, rep, echo);
        count += 1;
      }
      for (const entry of s.pending_asks.values()) {
        if (entry.ask_frame) await this._wsSend(ws, entry.ask_frame);
      }
      if (sid === attach && !s.closed) {
        s.ws = ws;
        s.detached = false;
        await this._wsSend(ws, {
          post_type: 'session_ready', session_id: sid,
          model: s.model_name, channel: (s.channel || {}).name,
          turn_active: s.turn_active, permission_mode: s.permission_mode,
          backend: s.backend, gateway: s.gatewayName || null, echo,
        });
        log('sync_attach', { session_id: sid, turn_active: s.turn_active });
      }
    }
    await this._wsSend(ws, { post_type: 'sync_done', count, echo });
    log('sessions_sync', { peer_sessions: sids.length, pushed: count, attach });
  }

  // ---------- channels ----------
  async channelsSave(ws, params, echo) {
    const name = String(params.name || '').trim();
    if (!isValidChannelName(name)) {
      await this._wsSend(ws, {
        post_type: 'error', code: 'bad_channel_name', message: '渠道名限英文/数字/连字符', echo,
      });
      return;
    }
    let baseUrl = normalizeBaseUrl(params.base_url);
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
      await this._wsSend(ws, {
        post_type: 'error', code: 'bad_channel', message: '端点必须以 http(s):// 开头', echo,
      });
      return;
    }
    const protocol = ['anthropic', 'openai', 'auto'].includes(params.protocol)
      ? params.protocol : 'auto';
    const entry = {
      name,
      label: String(params.label || '').trim() || name,
      base_url: baseUrl,
      protocol,
      wire_api: params.wire_api === 'chat' ? 'chat' : 'responses',
      api_key: String(params.api_key || '').trim(),
      model: String(params.model || '').trim(),
    };
    if (params.http_headers && typeof params.http_headers === 'object') {
      entry.http_headers = params.http_headers;
    }
    if (params.api_key_env) entry.api_key_env = String(params.api_key_env).trim();
    let found = false;
    for (let i = 0; i < API_CHANNELS.length; i++) {
      const ch = API_CHANNELS[i];
      if (ch && ch.name === name) {
        if (!entry.api_key && ch.api_key) entry.api_key = ch.api_key;
        if (entry.api_key) {
          // 显式填了 key：以本地 secrets.json 为准，清掉环境变量引用
          delete entry.api_key_env;
        } else if (ch.api_key_env) {
          entry.api_key_env = ch.api_key_env;
        }
        if (!params.wire_api && ch.wire_api) entry.wire_api = ch.wire_api;
        if (!entry.http_headers && ch.http_headers) entry.http_headers = ch.http_headers;
        API_CHANNELS[i] = entry;
        found = true;
        break;
      }
    }
    if (!found) API_CHANNELS.push(entry);
    persistChannels();
    log('channel_saved', { channel: name });
    await this._wsSend(ws, { post_type: 'channels_saved', channel: name, echo });
  }

  async channelsDelete(ws, params, echo) {
    const name = String(params.channel || '').trim();
    const before = API_CHANNELS.length;
    const next = API_CHANNELS.filter((ch) => !(ch && ch.name === name));
    const removed = before - next.length;
    API_CHANNELS.length = 0;
    API_CHANNELS.push(...next);
    if (channelState.defaultChannel === name) {
      setDefaultChannel('');
      persistChannels();
    }
    if (removed) {
      persistChannels();
      log('channel_deleted', { channel: name });
    }
    await this._wsSend(ws, { post_type: 'channels_deleted', channel: name, removed, echo });
  }

  /** Channel base_url may or may not include the trailing /v1 (anthropic
   * convention omits it; OpenAI/OpenClaw convention includes it). Append the
   * subpath accordingly: endsWith('/v1') ? base+sub : base+'/v1'+sub. */
  _apiPath(base, sub) {
    return base.replace(/\/+$/, '') + (base.replace(/\/+$/, '').endsWith('/v1') ? sub : '/v1' + sub);
  }

  /** One minimal probe request; returns {ok, status, latencyMs, error}. */
  async _probeOnce(baseUrl, subpath, { method = 'POST', headers, body }) {
    const url = this._apiPath(baseUrl.replace(/\/+$/, ''), subpath);
    const t0 = now();
    try {
      const resp = await fetch(url, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
      const text = await resp.text();
      return {
        ok: resp.status === 200, status: resp.status,
        latencyMs: Math.round((now() - t0) * 1000),
        error: resp.status === 200 ? '' : ('HTTP ' + resp.status + ': ' + text.slice(0, 200)),
      };
    } catch (e) {
      return { ok: false, status: 0, latencyMs: 0, error: String(e).slice(0, 200) };
    }
  }

  async channelTest(ws, params, echo) {
    let ch = params.channel ? channelByName(params.channel) : null;
    if (!ch && channelState.defaultChannel) ch = channelByName(channelState.defaultChannel);
    const model = params.model || (ch && ch.model) || '';
    const name = (ch && ch.name) || '';
    if (!ch || !ch.base_url || !ch.api_key) {
      await this._wsSend(ws, {
        post_type: 'channel_test', ok: false, channel: name,
        error: '该渠道无独立端点/密钥（机器默认走 CLI 登录态），无法直测', echo,
      });
      return;
    }
    const base = ch.base_url.replace(/\/+$/, '');
    const proto = ch.protocol || 'auto';
    // OpenAI-protocol probe (chat completions) — OpenClaw gateway has no /v1/messages
    const openaiProbe = () => this._probeOnce(base, '/chat/completions', {
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ch.api_key },
      body: { model: model || 'ping', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] },
    });
    // Anthropic-protocol probe
    const anthropicProbe = () => this._probeOnce(base, '/messages', {
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': ch.api_key,
        authorization: 'Bearer ' + ch.api_key,
      },
      body: { model: model || 'ping', max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] },
    });
    let result;
    if (proto === 'anthropic') {
      result = await anthropicProbe();
    } else if (proto === 'openai') {
      result = await openaiProbe();
    } else {
      // auto: OpenAI first, fall back to Anthropic on 404/405
      result = await openaiProbe();
      if (!result.ok && (result.status === 404 || result.status === 405)) {
        result = await anthropicProbe();
      }
    }
    await this._wsSend(ws, {
      post_type: 'channel_test', ok: result.ok,
      channel: name, model, status: result.status,
      latency_ms: result.latencyMs,
      error: result.error, echo,
    });
  }

  async channelModels(ws, params, echo) {
    const ch = params.channel ? channelByName(params.channel) : null;
    const name = (ch && ch.name) || '';
    if (!ch || !ch.base_url || !ch.api_key) {
      await this._wsSend(ws, {
        post_type: 'channel_models', channel: name, models: [],
        error: '该渠道无独立端点/密钥（机器默认走 CLI 登录态），无法拉取', echo,
      });
      return;
    }
    const url = this._apiPath(ch.base_url.replace(/\/+$/, ''), '/models');
    const proto = ch.protocol || 'auto';
    const headers = { authorization: 'Bearer ' + ch.api_key };
    if (proto !== 'openai') {
      headers['anthropic-version'] = '2023-06-01';
      headers['x-api-key'] = ch.api_key;
    }
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
      const body = await resp.text();
      if (resp.status !== 200) {
        await this._wsSend(ws, {
          post_type: 'channel_models', channel: name, models: [],
          error: 'HTTP ' + resp.status + ': ' + body.slice(0, 200), echo,
        });
        return;
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        data = {};
      }
      const items = data && data.data && Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
      const models = [];
      for (const it of items) {
        const mid = String((it && typeof it === 'object' ? it.id : it) || '').trim();
        if (mid && !models.includes(mid)) models.push(mid);
      }
      await this._wsSend(ws, {
        post_type: 'channel_models', channel: name, models,
        error: models.length ? '' : '上游返回空列表', echo,
      });
    } catch (e) {
      await this._wsSend(ws, {
        post_type: 'channel_models', channel: name, models: [],
        error: String(e).slice(0, 200), echo,
      });
    }
  }

  // ---------- 卡西（手表助手）LLM 代理 ----------
  // 密钥留在服务端：手表只发 openai 风格 messages + 工具定义（tools 用
  // {name,description,parameters} 简写），渠道是 anthropic 协议时在此转换。
  // 回 kx_reply：content 文本 + tool_calls[{id,name,arguments(对象)}]。
  async kxChat(ws, params, echo) {
    const ch = (params.channel && channelByName(params.channel))
      || (channelState.defaultChannel && channelByName(channelState.defaultChannel))
      || API_CHANNELS.find((c) => c && c.base_url && c.api_key);
    const fail = (error) => this._wsSend(ws, { post_type: 'kx_reply', ok: false, error, echo });
    if (!ch || !ch.base_url || !ch.api_key) {
      await fail('没有可直连的渠道（需配 base_url + api_key）');
      return;
    }
    const model = String(params.model || ch.model || '');
    const messages = Array.isArray(params.messages) ? params.messages : [];
    const tools = Array.isArray(params.tools) ? params.tools : [];
    // 下限 2048：思考型模型（glm-5.3 等）思考块与正文共用 max_tokens，
    // 手表给的 1024 会被思考吃光 → 正文被掐成空轮
    const maxTokens = Math.max(2048, Number(params.max_tokens) || 1024);
    const base = ch.base_url.replace(/\/+$/, '');
    try {
      let content = '';
      let think = '';
      const toolCalls = [];
      if (ch.protocol === 'openai') {
        const body = { model, max_tokens: maxTokens, messages };
        if (tools.length) {
          body.tools = tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } },
          }));
          body.tool_choice = 'auto';
        }
        const resp = await fetch(this._apiPath(base, '/chat/completions'), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ch.api_key },
          body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
        });
        const text = await resp.text();
        if (resp.status !== 200) { await fail('HTTP ' + resp.status + ': ' + text.slice(0, 200)); return; }
        const data = JSON.parse(text);
        const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
        content = typeof msg.content === 'string' ? msg.content : '';
        for (const tc of msg.tool_calls || []) {
          let args = {};
          try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch { /* 上游参数非 JSON 时按空对象 */ }
          toolCalls.push({ id: tc.id, name: tc.function && tc.function.name, arguments: args });
        }
        // 深度思考渠道正文为空时回退 reasoning_content，同 anthropic 的思考块兜底
        if (!content && !toolCalls.length && msg.reasoning_content) content = String(msg.reasoning_content);
      } else {
        // anthropic 协议：openai 风格消息 → 块结构（tool 消息并入下一条 user 的 tool_result 块）
        const sys = [];
        const amsg = [];
        for (const m of messages) {
          if (m.role === 'system') { if (m.content) sys.push(String(m.content)); continue; }
          if (m.role === 'tool') {
            const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content || '') };
            const last = amsg[amsg.length - 1];
            if (last && last.role === 'user' && Array.isArray(last.content)) last.content.push(block);
            else amsg.push({ role: 'user', content: [block] });
            continue;
          }
          if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            const blocks = [];
            if (m.content) blocks.push({ type: 'text', text: String(m.content) });
            for (const tc of m.tool_calls) blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.arguments || {} });
            amsg.push({ role: 'assistant', content: blocks });
            continue;
          }
          amsg.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
        }
        // 显式关思考：glm-5.3 思考块与正文共用 max_tokens，且偶发把答案全写进
        // 思考块/长篇思维链被兜底放出（手表上 7 千字思维链正文就是这么来的）
        const body = { model, max_tokens: maxTokens, messages: amsg, thinking: { type: 'disabled' } };
        if (sys.length) body.system = sys.join('\n\n');
        if (tools.length) {
          body.tools = tools.map((t) => ({
            name: t.name, description: t.description || '',
            input_schema: t.parameters || { type: 'object', properties: {} },
          }));
        }
        const resp = await fetch(this._apiPath(base, '/messages'), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'anthropic-version': '2023-06-01',
            'x-api-key': ch.api_key,
            authorization: 'Bearer ' + ch.api_key,
          },
          body: JSON.stringify(body), signal: AbortSignal.timeout(90000),
        });
        const text = await resp.text();
        if (resp.status !== 200) { await fail('HTTP ' + resp.status + ': ' + text.slice(0, 200)); return; }
        const data = JSON.parse(text);
        for (const b of data.content || []) {
          if (b.type === 'text' && b.text) content += b.text;
          else if (b.type === 'thinking' && b.thinking) think += b.thinking;
          else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, arguments: b.input || {} });
        }
        // glm-5.3 偶发把答案全写进思考块就收轮（无 text 无 tool_use）→
        // 回退取思考内容当回复，否则手表那轮什么都不显示（"说话断断续续"的空轮）
        if (!content && !toolCalls.length && think) content = think;
      }
      await this._wsSend(ws, { post_type: 'kx_reply', ok: true, channel: ch.name, model, content, tool_calls: toolCalls, echo });
      log('kx_chat', { channel: ch.name, model, tools: toolCalls.length, chars: content.length });
    } catch (e) {
      await fail(String((e && e.message) || e).slice(0, 200));
    }
  }

  /** 后端-渠道协议兼容性：auto 通用；anthropic 只配 claude；openai 只配 codex。 */
  _channelProtocolOk(backend, ch) {
    if (!ch) return true;
    const proto = ch.protocol || 'auto';
    if (proto === 'auto' || backend === 'openclaw') return true;
    if (backend === 'codex') return proto !== 'anthropic';
    if (backend === 'claude') return proto !== 'openai';
    return true;
  }

  async setModel(ws, params, echo) {
    const s = this.sessions.get(params.session_id);
    if (!s || s.closed) {
      await this._wsSend(ws, {
        post_type: 'error', code: 'unknown_session', session_id: params.session_id, echo,
      });
      return;
    }
    let chan = params.channel ? channelByName(params.channel) : null;
    if (params.channel && !chan) {
      await this._wsSend(ws, { post_type: 'error', code: 'bad_channel', channel: params.channel, echo });
      return;
    }
    if (chan && !this._channelProtocolOk(s.backend, chan)) {
      await this._wsSend(ws, {
        post_type: 'error', code: 'bad_backend_channel', channel: chan.name,
        message: s.backend + ' 后端不能使用 ' + (chan.protocol || 'auto') + ' 协议渠道 ' + chan.name,
        echo,
      });
      return;
    }
    if ('channel' in params && !params.channel) {
      await s.setChannel(null, params.model, echo, true);
      return;
    }
    await s.setChannel(chan, params.model, echo);
  }

  // ---------- backends (claude/codex/openclaw gateway) config ----------
  async backendsList(ws, echo) {
    const gateways = [];
    for (const [name, g] of Object.entries(GATEWAYS)) {
      if (!g || typeof g !== 'object') continue;
      const tok = String(g.token || '');
      gateways.push({ name, url: g.url || '', agent: g.agent || 'main', token_tail: tok.slice(-4) });
    }
    await this._wsSend(ws, {
      post_type: 'backends', claude_bin: CLAUDE_BIN, codex_bin: CODEX_BIN,
      default_backend: DEFAULT_BACKEND, gateways, echo,
    });
  }

  async backendsSave(ws, params, echo) {
    if (params.claude_bin !== undefined) setClaudeBin(String(params.claude_bin || '').trim() || '/usr/local/bin/claude');
    if (params.codex_bin !== undefined) setCodexBin(String(params.codex_bin || '').trim() || 'codex');
    if (params.default_backend !== undefined) setDefaultBackend(params.default_backend);
    if (Array.isArray(params.gateways)) {
      const next = {};
      for (const g of params.gateways) {
        if (!g || typeof g !== 'object' || !g.name) continue;
        const name = String(g.name).trim();
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name)) continue;
        const prev = GATEWAYS[name] || {};
        next[name] = {
          url: String(g.url || '').trim(),
          agent: String(g.agent || '').trim() || 'main',
          token: g.token ? String(g.token) : (prev.token || ''),
        };
      }
      const oldNames = Object.keys(GATEWAYS);
      setGateways(next);
      // 被删掉的网关：停掉仍在跑的连接（改配置的不用管——getGateway 按指纹懒重建）
      const { dropGateway } = await import('./gateway.js');
      for (const n of oldNames) {
        if (!next[n]) dropGateway(n);
      }
    }
    persistBackends();
    log('backends_saved', { default_backend: DEFAULT_BACKEND, gateways: Object.keys(GATEWAYS) });
    await this._wsSend(ws, { post_type: 'backends_saved', echo });
    await this.backendsList(ws, echo);
  }

  async backendsTest(ws, params, echo) {
    const target = String(params.target || '');
    const t0 = now();
    const reply = (ok, detail) => this._wsSend(ws, {
      post_type: 'backend_test', target, ok, detail, latency_ms: Math.round((now() - t0) * 1000), echo,
    });
    if (target === 'claude' || target === 'codex') {
      const bin = target === 'claude' ? CLAUDE_BIN : CODEX_BIN;
      try {
        const { spawn } = await import('node:child_process');
        const out = await new Promise((resolve) => {
          const p = spawn(bin, ['--version'], { timeout: 15000 });
          let s = ''; p.stdout && p.stdout.on('data', (d) => { s += d; });
          p.on('error', (e) => resolve('ERR:' + e.message));
          p.on('close', () => resolve(s.trim().slice(0, 80) || '(no output)'));
        });
        await reply(!String(out).startsWith('ERR:'), out);
      } catch (e) {
        await reply(false, String(e));
      }
      return;
    }
    if (target.startsWith('openclaw')) {
      const name = target.includes(':') ? target.split(':')[1] : 'openclaw';
      try {
        const { getGateway } = await import('./gateway.js');
        await Promise.race([
          getGateway(name),
          new Promise((_, rej) => setTimeout(() => rej(new Error('connect timeout')), 15000)),
        ]);
        await reply(true, 'connected');
      } catch (e) {
        await reply(false, String(e && e.message ? e.message : e));
      }
      return;
    }
    await reply(false, 'unknown target');
  }
}