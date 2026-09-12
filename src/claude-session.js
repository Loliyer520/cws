// cc-bridge (Node) — ClaudeSession: one resident `claude -p` stream-json subprocess.
// Verified against claude 2.1.263 (see ACCEPTANCE.md history).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { BaseSession } from './base-session.js';
import {
  CLAUDE_BIN, ALLOWED_TOOLS, PERMISSION_MODE, ASK_TIMEOUT, channelByName,
} from './config.js';
import {
  log, briefOf, spawnDetached, killProcGroup, killProcGroupForce, waitProc, procAlive,
} from './util.js';

function _procEnv(channel) {
  const env = { ...process.env, IS_SANDBOX: '1' };
  if (channel !== null) {
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  return env;
}

export class ClaudeSession extends BaseSession {
  constructor(bridge, sid, ws, opts = {}) {
    super(bridge, sid, ws, opts);
    this.readerTask = null;
    this._spawnLock = Promise.resolve();
    this._ctlFutures = new Map(); // request_id -> {resolve}
    this.ready = this._makeReady();
  }

  _makeReady() {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    return { promise, resolve, done: false };
  }

  _historyPath() {
    // claude stores per-session history under ~/.claude/projects/<munged-cwd>/<uuid>.jsonl
    const proj = path.resolve(this.cwd).replace(/\//g, '-').replace(/\./g, '-');
    return path.join(os.homedir(), '.claude', 'projects', proj, this.cli_uuid + '.jsonl');
  }

  _hasHistory() {
    return fs.existsSync(this._historyPath());
  }

  _buildArgs() {
    const useResume = (this.resume_flag || this.started_once) && this._hasHistory();
    const args = [
      CLAUDE_BIN, '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode', this.launch_mode,
      '--allowed-tools', ...ALLOWED_TOOLS.split(','),
      '--permission-prompt-tool', 'stdio',
      '--allow-dangerously-skip-permissions',
    ];
    if (this.channel !== null) {
      const envObj = {
        env: {
          ANTHROPIC_BASE_URL: this.channel.base_url || '',
          ANTHROPIC_AUTH_TOKEN: this.channel.api_key || '',
        },
      };
      if (this.model_name) envObj.model = this.model_name;
      args.push('--settings', JSON.stringify(envObj));
    }
    if (this.model_name) args.push('--model', this.model_name);
    if (useResume) args.push('--resume', this.cli_uuid);
    else args.push('--session-id', this.cli_uuid);
    return args;
  }

  async start() {
    const prev = this._spawnLock;
    let release;
    this._spawnLock = new Promise((res) => { release = res; });
    await prev;
    try {
      if (procAlive(this.proc)) return;
      this.started_once = true;
      this.aborted_sent = false;
      this.ready = this._makeReady();
      this.proc = spawnDetached(CLAUDE_BIN, this._buildArgs(), {
        cwd: this.cwd,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: _procEnv(this.channel),
      });
      // swallow async EPIPE on stdin after process death (Node emits 'error'
      // asynchronously instead of throwing on write)
      this.proc.stdin.on('error', () => {});
      this._startReader();
      log('proc_start', { session_id: this.id, pid: this.proc.pid, resume: this.resume_flag });
      // SDK handshake: required for can_use_tool prompts on stdout
      try {
        await this._writeLine({
          type: 'control_request',
          request_id: 'init-' + crypto.randomBytes(4).toString('hex'),
          request: { subtype: 'initialize' },
        });
      } catch (e) {
        log('handshake_err', { session_id: this.id, err: String(e) });
      }
    } finally {
      release();
    }
  }

  async _warmStart() {
    try {
      if (this.bridge.activeCount() >= this.bridge.maxActive) return;
      await this.start();
    } catch (e) {
      log('warm_start_err', { session_id: this.id, err: String(e) });
    }
  }

  async _ensureProcess() {
    if (!procAlive(this.proc)) {
      await this.start();
    }
    // give the CLI a moment to finish init before first write
    await Promise.race([this.ready.promise, new Promise((res) => setTimeout(res, 10000))]);
    // deferred permission switch (pending_mode): CLI just answered the handshake
    if (this.pending_mode) {
      const mode = this.pending_mode;
      this.pending_mode = null;
      if (procAlive(this.proc)) {
        await this._switchProcMode(mode, 4);
      }
    }
  }

  async _writeTurn(text) {
    await this._writeLine({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: this.cli_uuid,
    });
    log('turn_start', { session_id: this.id });
  }

  async _writeLine(obj) {
    if (!(procAlive(this.proc) && !this.proc.stdin.destroyed)) {
      throw new Error('process_dead');
    }
    const line = JSON.stringify(obj) + '\n';
    this.proc.stdin.write(line);
  }

  // ---------- stdout reader ----------
  _startReader() {
    const proc = this.proc;
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      line = line.trim();
      if (!line) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      this._dispatch(obj).catch((e) => {
        log('dispatch_err', { session_id: this.id, err: String(e) });
      });
    });
    rl.on('close', async () => {
      const code = proc.exitCode;
      log('proc_exit', { session_id: this.id, code });
      if (this.turn_active && !this.aborted_sent) {
        this.turn_active = false;
        this._cancelTurnTimer();
        await this.sendWs({
          post_type: 'turn_aborted', session_id: this.id,
          reason: 'process_exited', echo: this.turn_echo,
        });
      }
      await this._expireAllAsks();
      this.bridge.notifyCapacityChange();
    });
    this.readerTask = rl;
  }

  async _dispatch(obj) {
    const t = obj.type;
    if (t === 'system') {
      if (obj.subtype === 'init') await this._announceReady(obj.model);
    } else if (t === 'control_response') {
      const fut = this._ctlFutures.get(obj.request_id);
      if (fut) {
        this._ctlFutures.delete(obj.request_id);
        fut.resolve(obj.response || {});
      }
      // stdio mode: CLI answers the initialize handshake before any system init
      if (!this.ready.done) {
        this.ready.done = true;
        this.ready.resolve();
      }
      this.last_activity = Date.now() / 1000;
      await this._announceReady(null);
    } else if (t === 'stream_event') {
      const ev = obj.event || {};
      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && d.text) {
          this.text_buf.push(d.text);
          await this.sendWs({ post_type: 'delta', session_id: this.id, text: d.text });
        } else if (d.type === 'thinking_delta' && d.thinking) {
          this.last_activity = Date.now() / 1000;
          this.thinking_chars += d.thinking.length;
          await this.sendWs({
            post_type: 'thinking', session_id: this.id,
            tokens: Math.max(1, Math.round(this.thinking_chars / 4)),
          });
        }
      }
    } else if (t === 'assistant') {
      const blocks = (obj.message && obj.message.content) || [];
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          this.text_buf.push(b.text);
        } else if (b.type === 'tool_use') {
          this.last_activity = Date.now() / 1000;
          const sealed = this._flushTextLog();
          if (sealed) {
            await this.sendWs({ post_type: 'cc_msg', session_id: this.id, mid: sealed.id, text: sealed.text });
          }
          const brief = briefOf(b.input || {});
          const tEntry = this._logTurn('tool', `${b.name}：${brief}`);
          await this.sendWs({
            post_type: 'tool_activity', session_id: this.id,
            tool: b.name, brief, mid: (tEntry || {}).id,
          });
        }
      }
    } else if (t === 'control_request') {
      await this._handleControlRequest(obj);
    } else if (t === 'result') {
      await this._handleResult(obj);
    }
    // 'user' frames (tool_result) are ignored
  }

  async _announceReady(model) {
    if (this.ready_announced) {
      // lazy-revived sessions already sent session_ready: just sync the real model
      if (model) this.model_name = model;
      return;
    }
    this.ready_announced = true;
    if (!this.ready.done) {
      this.ready.done = true;
      this.ready.resolve();
    }
    this.last_activity = Date.now() / 1000;
    if (model) this.model_name = model;
    await this.sendWs({
      post_type: 'session_ready', session_id: this.id,
      model: this.model_name,
      channel: (this.channel || {}).name,
      permission_mode: this.permission_mode,
      backend: this.backend,
      echo: this.pending_echo,
    });
    this.pending_echo = null;
    log('session_ready', { session_id: this.id });
  }

  async _handleResult(obj) {
    this.turn_active = false;
    this._cancelTurnTimer();
    this.last_activity = Date.now() / 1000;
    const usage = obj.usage || {};
    const finalText = obj.result || this.text_buf.join('');
    const sealed = this._flushTextLog();
    let finalMid = (sealed || {}).id;
    // rounds with no delta but text only in result: log it or replay loses it
    if (!sealed && finalText.trim()) {
      finalMid = (this._logTurn('cc', finalText) || {}).id;
    }
    await this.sendWs({
      post_type: 'final', session_id: this.id,
      text: finalText,
      mid: finalMid,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
        reasoning_tokens: usage.reasoning_tokens,
      },
      cost_usd: obj.total_cost_usd,
      duration_ms: obj.duration_ms,
      num_turns: obj.num_turns,
      is_error: !!obj.is_error,
      subtype: obj.subtype,
      echo: this.turn_echo,
    });
    if (this.detached) this._killpg();
    log('turn_end', {
      session_id: this.id, dur_ms: obj.duration_ms,
      out_tokens: usage.output_tokens, is_error: obj.is_error,
    });
  }

  // ---------- permission / ask ----------
  async _handleControlRequest(obj) {
    const requestId = obj.request_id;
    const req = obj.request || {};
    if (req.subtype === 'can_use_tool') {
      const sealed = this._flushTextLog();
      if (sealed) {
        await this.sendWs({ post_type: 'cc_msg', session_id: this.id, mid: sealed.id, text: sealed.text });
      }
      const toolName = req.tool_name;
      const askId = crypto.randomBytes(16).toString('hex');
      const kind = toolName === 'AskUserQuestion' ? 'question' : 'permission';
      const askFrame = {
        post_type: 'ask', session_id: this.id, ask_id: askId, kind,
        tool_name: toolName, input: req.input || {},
      };
      const entry = { request_id: requestId, tool_name: toolName, ask_frame: askFrame };
      entry.timer = setTimeout(() => { this._askTimeout(askId).catch(() => {}); }, ASK_TIMEOUT * 1000);
      this.pending_asks.set(askId, entry);
      this.last_activity = Date.now() / 1000;
      await this.sendWs(askFrame);
      log('ask', { session_id: this.id, tool: toolName, kind });
    } else {
      await this._writeLine({
        type: 'control_response',
        response: {
          subtype: 'success', request_id: requestId,
          response: { behavior: 'deny', message: 'unsupported control request' },
        },
      });
    }
  }

  async _askTimeout(askId) {
    const entry = this.pending_asks.get(askId);
    if (!entry) return;
    this.pending_asks.delete(askId);
    log('ask_timeout', { session_id: this.id, tool: (entry.ask_frame || {}).tool_name });
    try {
      await this._writeLine({
        type: 'control_response',
        response: {
          subtype: 'success', request_id: entry.request_id,
          response: { behavior: 'deny', message: 'ask timeout, denied by bridge' },
        },
      });
    } catch { /* process gone */ }
    await this.sendWs({
      post_type: 'error', session_id: this.id, code: 'ask_timeout', ask_id: askId,
    });
  }

  async askReply(askId, behavior, message = null, updatedInput = null, echo = null) {
    const entry = this.pending_asks.get(askId);
    if (!entry) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'unknown_ask', ask_id: askId, echo,
      });
      return;
    }
    this.pending_asks.delete(askId);
    if (entry.timer) clearTimeout(entry.timer);
    let resp;
    if (behavior === 'allow') {
      resp = { behavior: 'allow' };
      if (updatedInput !== null && updatedInput !== undefined) resp.updatedInput = updatedInput;
    } else {
      resp = { behavior: 'deny', message: message || 'denied by user' };
    }
    try {
      await this._writeLine({
        type: 'control_response',
        response: { subtype: 'success', request_id: entry.request_id, response: resp },
      });
    } catch (e) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'ask_reply_failed', message: String(e), echo,
      });
      return;
    }
    await this.sendWs({
      post_type: 'ask_replied', session_id: this.id, ask_id: askId, behavior, echo,
    });
  }

  async setPermission(mode, echo = null) {
    if (!mode) mode = PERMISSION_MODE;
    this.launch_mode = mode;
    this._saveSessMeta();
    if (!procAlive(this.proc)) {
      this.permission_mode = mode;
      await this.sendWs({ post_type: 'permission_ack', session_id: this.id, mode, applied: false, echo });
      return;
    }
    if (await this._switchProcMode(mode)) {
      await this.sendWs({ post_type: 'permission_ack', session_id: this.id, mode, applied: true, echo });
      return;
    }
    if (this.turn_active) {
      this.pending_mode = mode;
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'busy',
        message: 'cannot switch permission during turn', echo,
      });
      return;
    }
    await this._restartForMode(mode, echo);
  }

  _switchProcMode(mode, timeout = 8) {
    const reqId = 'spm-' + crypto.randomBytes(4).toString('hex');
    const promise = new Promise((resolve) => {
      this._ctlFutures.set(reqId, { resolve });
    });
    return (async () => {
      try {
        await this._writeLine({
          type: 'control_request', request_id: reqId,
          request: { subtype: 'set_permission_mode', mode },
        });
      } catch (e) {
        this._ctlFutures.delete(reqId);
        log('perm_switch_err', { session_id: this.id, err: String(e) });
        return false;
      }
      let resp = null;
      try {
        resp = await Promise.race([promise, new Promise((res) => setTimeout(() => res(null), timeout * 1000))]);
      } catch { /* ignore */ }
      this._ctlFutures.delete(reqId);
      if (resp && resp.subtype === 'success') {
        this.permission_mode = mode;
        log('permission_mode', { session_id: this.id, mode });
        return true;
      }
      log('perm_switch_failed', { session_id: this.id, mode });
      return false;
    })();
  }

  async _deferSwitchMode(mode) {
    if (!(await this._switchProcMode(mode))) this.pending_mode = mode;
  }

  async _restartForMode(mode, echo = null) {
    this.launch_mode = mode;
    this.permission_mode = mode;
    this.pending_mode = null;
    log('permission_restart', { session_id: this.id, mode });
    this._killpg();
    await waitProc(this.proc, 5000);
    killProcGroupForce(this.proc);
    try {
      await this.start();
    } catch (e) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'set_permission_failed', message: String(e), echo,
      });
      return;
    }
    this.ready_announced = false;
    await this.sendWs({ post_type: 'permission_ack', session_id: this.id, mode, applied: true, echo });
  }

  async setChannel(channel, model = null, echo = null, clear = false) {
    if (channel === null && model === null && !clear) {
      await this.sendWs({
        post_type: 'model_ack', session_id: this.id,
        channel: (this.channel || {}).name, model: this.model_name, applied: false, echo,
      });
      return;
    }
    if (channel === null && model && !clear && this.channel !== null) {
      channel = { ...this.channel };
    }
    if (channel !== null && model) {
      channel = { ...channel, model };
    }
    this.channel = channel;
    if (channel === null) {
      this.model_name = model || null;
    } else {
      this.model_name = channel.model || null;
    }
    this._saveSessMeta();
    const chanName = (channel || {}).name;
    if (this.turn_active) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'busy',
        message: 'cannot switch model during turn', echo,
      });
      return;
    }
    if (!procAlive(this.proc)) {
      await this.sendWs({
        post_type: 'model_ack', session_id: this.id,
        channel: chanName, model: this.model_name, applied: false, echo,
      });
      return;
    }
    log('channel_restart', { session_id: this.id, channel: chanName, model: this.model_name });
    this._killpg();
    await waitProc(this.proc, 5000);
    killProcGroupForce(this.proc);
    try {
      await this.start();
    } catch (e) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'set_channel_failed', message: String(e), echo,
      });
      return;
    }
    this.ready_announced = false;
    await this.sendWs({
      post_type: 'model_ack', session_id: this.id,
      channel: chanName, model: this.model_name, applied: true, echo,
    });
  }

  // ---------- stop / teardown ----------
  async abort(reason = 'user') {
    if (!this.turn_active) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'not_running', message: 'no active turn',
      });
      return;
    }
    this._killpg();
    if (!this.aborted_sent) {
      this.aborted_sent = true;
      this.turn_active = false;
      this._cancelTurnTimer();
      const sealed = this._flushTextLog();
      if (sealed) {
        await this.sendWs({ post_type: 'cc_msg', session_id: this.id, mid: sealed.id, text: sealed.text });
      }
      await this.sendWs({
        post_type: 'turn_aborted', session_id: this.id, reason, echo: this.turn_echo,
      });
    }
    // settle exitCode so the next send sees a dead proc and respawns
    await waitProc(this.proc, 2000);
  }

  _killpg() {
    killProcGroup(this.proc);
  }

  async _killProcess() {
    if (procAlive(this.proc)) {
      this._killpg();
      await waitProc(this.proc, 5000);
      killProcGroupForce(this.proc);
    }
  }
}
