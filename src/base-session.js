// cc-bridge (Node) — BaseSession: shared state for claude/codex backends.
import fs from 'node:fs';
import path from 'node:path';
import {
  WORKSPACES, PERMISSION_MODE, DEFAULT_BACKEND, TURN_TIMEOUT, channelByName,
} from './config.js';
import { uuid5, UUID_NAMESPACE_URL, now, loadJsonFile, log } from './util.js';

/** Frames broadcast to every authenticated connection (QQ multi-client model). */
export const STREAM_POST_TYPES = new Set([
  'delta', 'thinking', 'tool_activity', 'final', 'cc_msg', 'user_msg',
  'turn_aborted', 'ask', 'ask_replied', 'session_closed',
]);

export class BaseSession {
  constructor(bridge, sid, ws, opts = {}) {
    this.bridge = bridge;
    this.id = sid;
    // CLI requires a valid UUID for session ids; external id is free-form
    this.cli_uuid = uuid5(UUID_NAMESPACE_URL, 'cc-bridge:' + sid);
    this.ws = ws;
    this.pending_echo = null;
    this.cwd = path.join(WORKSPACES, sid);
    fs.mkdirSync(this.cwd, { recursive: true });
    this.proc = null;
    this.turn_active = false;
    this.turn_echo = null;
    this.turn_timer = null;
    this.aborted_sent = false;
    this.started_once = false;
    this.resume_flag = !!opts.resume;
    this.ready_announced = false;
    this.text_buf = [];
    this.pending_asks = new Map(); // ask_id -> {request_id, tool_name, ask_frame, timer}
    this.created_at = now();
    const meta = this._loadSessMeta();
    // permission level: launch_mode = process start param; permission_mode = live value
    this.launch_mode = opts.permissionMode || meta.permission_mode || PERMISSION_MODE;
    this.permission_mode = this.launch_mode;
    // channel/model identity: None = inherit machine default
    let channel = opts.channel ?? null;
    if (!channel && meta.channel) {
      const ch = channelByName(meta.channel);
      if (ch) channel = ch;
    }
    this.channel = channel;
    this.model_name = opts.model || (channel && channel.model) || meta.model || null;
    this.backend = opts.backend || meta.backend || DEFAULT_BACKEND;
    this.thread_id = meta.thread_id || null; // codex exec resume id
    this.pending_mode = null; // deferred permission switch before next send
    this.last_activity = now();
    this.last_turn_at = null;
    this.closed = false;
    // offline accumulation: turn products land in turn_log, replayed on reconnect
    this.detached = false;
    this.turn_log = []; // [{id, ts, role: user|cc|tool|sys, text}]
    this.TURN_LOG_MAX = 200;
    this._msg_seq = 0;
    this._disk_log_count = 0;
    this._loadTurnDisk();
    this.thinking_chars = 0; // server-side dedup thinking count
    this._saveSessMeta(); // identity persisted immediately (revive path is idempotent)
  }

  // ---------- turn_log persistence ----------
  _turnlogPath() {
    return path.join(this.cwd, 'turnlog.jsonl');
  }

  _sessMetaPath() {
    return path.join(this.cwd, 'sess.json');
  }

  _logTurn(role, text) {
    if (!['user', 'cc', 'tool', 'sys'].includes(role)) return null;
    this._msg_seq += 1;
    const entry = { id: `${this.id}-${this._msg_seq}`, ts: now(), role, text };
    this.turn_log.push(entry);
    if (this.turn_log.length > this.TURN_LOG_MAX) {
      this.turn_log = this.turn_log.slice(-this.TURN_LOG_MAX);
    }
    this._logTurnDisk(entry);
    return entry;
  }

  _logTurnDisk(entry) {
    try {
      fs.appendFileSync(this._turnlogPath(), JSON.stringify(entry) + '\n');
      this._disk_log_count += 1;
      if (this._disk_log_count > this.TURN_LOG_MAX * 2) this._compactTurnDisk();
    } catch { /* disk is best-effort */ }
  }

  _compactTurnDisk() {
    try {
      const lines = fs.readFileSync(this._turnlogPath(), 'utf8').split('\n').filter((l) => l.trim());
      const keep = lines.slice(-this.TURN_LOG_MAX);
      fs.writeFileSync(this._turnlogPath(), keep.map((l) => l + '\n').join(''));
      this._disk_log_count = keep.length;
    } catch { /* ignore */ }
  }

  _loadTurnDisk() {
    try {
      if (!fs.existsSync(this._turnlogPath())) return;
      const lines = fs.readFileSync(this._turnlogPath(), 'utf8').split('\n').filter((l) => l.trim());
      const out = [];
      let maxSeq = 0;
      let backfilled = 0;
      for (const line of lines.slice(-this.TURN_LOG_MAX)) {
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        if (!obj || typeof obj !== 'object' || !['user', 'cc', 'tool', 'sys'].includes(obj.role)) continue;
        const ts = Number(obj.ts) || 0;
        const entry = { ts, role: obj.role, text: String(obj.text || '') };
        const mid = String(obj.id || '');
        if (mid.startsWith(this.id + '-')) {
          entry.id = mid;
          const n = Number(mid.split('-').pop());
          if (Number.isFinite(n)) maxSeq = Math.max(maxSeq, n);
        } else {
          backfilled += 1;
        }
        out.push(entry);
      }
      // backfill ids after maxSeq (never reuse existing numbers)
      let seq = maxSeq;
      for (const e of out) {
        if (!e.id) {
          seq += 1;
          e.id = `${this.id}-${seq}`;
        }
      }
      this._msg_seq = Math.max(this._msg_seq, maxSeq, seq);
      this.turn_log = out;
      this._disk_log_count = lines.length;
      if (backfilled) this._rewriteTurnDisk(out);
    } catch { /* ignore */ }
  }

  _rewriteTurnDisk(entries) {
    try {
      fs.writeFileSync(this._turnlogPath(), entries.map((e) => JSON.stringify(e) + '\n').join(''));
      this._disk_log_count = entries.length;
    } catch { /* ignore */ }
  }

  forgetTurnlog() {
    for (const p of [this._turnlogPath(), this._sessMetaPath()]) {
      try {
        fs.rmSync(p, { force: true });
      } catch { /* ignore */ }
    }
  }

  _loadSessMeta() {
    return loadJsonFile(this._sessMetaPath(), {});
  }

  _saveSessMeta() {
    try {
      fs.writeFileSync(
        this._sessMetaPath(),
        JSON.stringify({
          permission_mode: this.launch_mode,
          channel: (this.channel && this.channel.name) || '',
          model: this.model_name || '',
          backend: this.backend,
          thread_id: this.thread_id || '',
        }),
      );
    } catch { /* ignore */ }
  }

  _replayMessages() {
    // dedupe adjacent identical cc entries (historic double-log of result text)
    const out = [];
    let prev = null;
    for (const e of this.turn_log) {
      if (e.role === 'cc' && prev === 'cc:' + e.text) continue;
      prev = e.role === 'cc' ? 'cc:' + e.text : null;
      out.push(e);
    }
    return out;
  }

  turnTitle() {
    for (let i = this.turn_log.length - 1; i >= 0; i--) {
      const e = this.turn_log[i];
      if (e && e.role === 'user') {
        const text = String(e.text || '').trim();
        if (text) return text.split('\n')[0].trim().slice(0, 24);
      }
    }
    return '';
  }

  _flushTextLog() {
    if (!this.text_buf.length) return null;
    const joined = this.text_buf.join('');
    this.text_buf = [];
    let entry = null;
    if (joined.trim()) entry = this._logTurn('cc', joined);
    return entry;
  }

  _replayAfter(mark) {
    let entries = this.turn_log;
    if (mark) {
      let hit = false;
      for (let i = 0; i < entries.length; i++) {
        if (entries[i].id === String(mark)) {
          entries = entries.slice(i + 1);
          hit = true;
          break;
        }
      }
      if (!hit) {
        const mts = Number(mark);
        if (mts > 0) entries = entries.filter((e) => (e.ts || 0) > mts + 1e-6);
      }
    }
    const out = [];
    let prev = null;
    for (const e of entries) {
      if (e.role === 'cc' && prev === 'cc:' + e.text) continue;
      prev = e.role === 'cc' ? 'cc:' + e.text : null;
      out.push(e);
    }
    return out;
  }

  // ---------- timers ----------
  _armTurnTimer() {
    if (TURN_TIMEOUT <= 0) return; // <=0 = unlimited
    this._cancelTurnTimer();
    this.turn_timer = setTimeout(() => {
      this._turnTimeout().catch(() => {});
    }, TURN_TIMEOUT * 1000);
  }

  _cancelTurnTimer() {
    if (this.turn_timer) {
      clearTimeout(this.turn_timer);
      this.turn_timer = null;
    }
  }

  async _turnTimeout() {
    if (!this.turn_active) return;
    log('turn_timeout', { session_id: this.id });
    await this.abort('timeout');
  }

  // ---------- ws send (broadcast vs reply semantics) ----------
  async sendWs(obj) {
    const t = obj.post_type;
    const broadcast = STREAM_POST_TYPES.has(t) || (t === 'error' && !obj.echo);
    const data = JSON.stringify(obj);
    if (broadcast) {
      for (const c of this.bridge.conns) {
        if (c.readyState === c.OPEN) {
          try {
            c.send(data);
          } catch { /* ignore */ }
        }
      }
    } else if (this.ws && this.ws.readyState === this.ws.OPEN) {
      try {
        this.ws.send(data);
      } catch { /* ignore */ }
    }
  }

  // ---------- teardown (backend-specific bits below) ----------
  async close(reason = 'dropped', notify = true, echo = null) {
    if (this.closed) return;
    this.closed = true;
    this._cancelTurnTimer();
    await this._killProcess();
    await this._expireAllAsks();
    if (notify) {
      await this.sendWs({ post_type: 'session_closed', session_id: this.id, reason, echo });
    }
    log('session_closed', { session_id: this.id, reason });
  }

  async _killProcess() { /* overridden */ }
  async _expireAllAsks() {
    for (const askId of [...this.pending_asks.keys()]) {
      await this._askTimeout(askId);
    }
  }
  async _askTimeout() { /* overridden by claude */ }

  // ---------- turn entry (backend-specific: startTurn/abort) ----------
  async startTurn(text, echo) {
    if (this.turn_active) {
      await this.sendWs({ post_type: 'error', session_id: this.id, code: 'busy', message: 'turn in progress', echo });
      return;
    }
    await this._ensureProcess();
    this.text_buf = [];
    this.thinking_chars = 0;
    this.turn_active = true;
    this.aborted_sent = false;
    this.turn_echo = echo;
    this.last_activity = now();
    this.last_turn_at = this.last_activity;
    const uEntry = this._logTurn('user', text);
    if (uEntry) {
      await this.sendWs({ post_type: 'user_msg', session_id: this.id, mid: uEntry.id, text });
    }
    this._armTurnTimer();
    await this.bridge.turnGate();
    await this._writeTurn(text, echo);
  }

  async _ensureProcess() { /* overridden */ }
  async _writeTurn(text, echo) { /* overridden */ }
  async abort(reason = 'user') { /* overridden */ }
}
