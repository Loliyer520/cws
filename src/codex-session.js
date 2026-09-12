// cc-bridge (Node) — CodexSession: per-turn `codex exec --json` JSONL adapter.
// No resident process: each turn spawns a fresh codex exec (resume <thread_id>
// keeps conversation context). Verified against openai/codex source (exec_events.rs).
import readline from 'node:readline';
import process from 'node:process';
import { BaseSession } from './base-session.js';
import { CODEX_BIN } from './config.js';
import {
  log, briefOf, spawnDetached, killProcGroup, killProcGroupForce, waitProc, procAlive,
} from './util.js';

// permission_mode → codex exec flags (verified against codex 0.154.0)
const SANDBOX_FLAGS = {
  'read-only': [],
  'workspace-write': ['--sandbox', 'workspace-write'],
  'danger-full-access': ['--sandbox', 'danger-full-access'],
  'full-auto': ['--dangerously-bypass-approvals-and-sandbox'],
};

function _procEnv(channel) {
  const env = { ...process.env, IS_SANDBOX: '1' };
  if (channel !== null) {
    // channel's env_key governs auth; drop the default key so it can't leak
    delete env.CODEX_API_KEY;
    const envName = channel.api_key_env || ('CWS_APIKEY_' + String(channel.name || '').toUpperCase());
    env[envName] = channel.api_key || '';
  }
  return env;
}

export class CodexSession extends BaseSession {
  constructor(bridge, sid, ws, opts = {}) {
    super(bridge, sid, ws, opts);
    if (this.permission_mode === 'default' || this.permission_mode === 'plan'
        || this.permission_mode === 'acceptEdits' || this.permission_mode === 'bypassPermissions') {
      // translate claude-style levels to codex sandbox levels
      this.permission_mode = this.permission_mode === 'bypassPermissions'
        ? 'danger-full-access'
        : this.permission_mode === 'acceptEdits' ? 'workspace-write' : 'read-only';
      this.launch_mode = this.permission_mode;
      this._saveSessMeta();
    }
    this._itemText = new Map(); // item_id -> accumulated text (agent_message/reasoning)
    this.turn_started_at = null;
    this._lastAgentText = '';
  }

  holdsSlot() {
    // codex spawns per turn: only a running turn occupies a slot
    return !!this.turn_active;
  }

  _buildArgs(text) {
    const args = [CODEX_BIN, 'exec', '--json', '--color', 'never', '--skip-git-repo-check'];
    args.push(...(SANDBOX_FLAGS[this.permission_mode] || []));
    if (this.channel !== null) {
      const ch = this.channel;
      const pid = String(ch.name || '').replace(/[^A-Za-z0-9_.-]/g, '_') || 'custom';
      const envKey = ch.api_key_env || ('CWS_APIKEY_' + pid.toUpperCase());
      args.push(
        '-c', `model_provider=${pid}`,
        '-c', `model_providers.${pid}.name=${ch.label || ch.name || pid}`,
        '-c', `model_providers.${pid}.base_url=${ch.base_url || ''}`,
        '-c', `model_providers.${pid}.env_key=${envKey}`,
        '-c', `model_providers.${pid}.wire_api=chat`,
      );
    }
    if (this.model_name) args.push('--model', this.model_name);
    if (this.thread_id) {
      args.push('resume', this.thread_id, text);
    } else {
      args.push(text);
    }
    return args;
  }

  async _ensureProcess() { /* per-turn spawn; nothing resident */ }

  async _writeTurn(text) {
    this._itemText.clear();
    this.turn_started_at = Date.now();
    this.proc = spawnDetached(CODEX_BIN, this._buildArgs(text), {
      cwd: this.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: _procEnv(this.channel),
    });
    this.proc.stderr.on('data', () => {}); // keep stderr from blocking the pipe
    this._startReader();
    log('codex_turn_start', { session_id: this.id, pid: this.proc.pid, resume: !!this.thread_id });
  }

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
        log('codex_dispatch_err', { session_id: this.id, err: String(e) });
      });
    });
    rl.on('close', async () => {
      if (proc.exitCode !== null) log('codex_proc_exit', { session_id: this.id, code: proc.exitCode });
      if (this.turn_active && !this.aborted_sent) {
        this.turn_active = false;
        this._cancelTurnTimer();
        await this.sendWs({
          post_type: 'turn_aborted', session_id: this.id,
          reason: 'process_exited', echo: this.turn_echo,
        });
      }
      this.bridge.notifyCapacityChange();
    });
  }

  async _dispatch(obj) {
    const t = obj.type;
    const item = obj.item || {};
    const itemType = item.type || item.item_type; // source uses "type"; older docs "item_type"
    const itemId = item.id || '';

    if (t === 'thread.started') {
      this.thread_id = obj.thread_id;
      this._saveSessMeta();
      log('codex_thread', { session_id: this.id, thread_id: this.thread_id });
    } else if (t === 'turn.started') {
      this.last_activity = Date.now() / 1000;
    } else if (t === 'item.started') {
      if (itemType === 'command_execution') {
        const cmd = String(item.command || '');
        const entry = this._logTurn('tool', 'bash：' + briefOf(cmd));
        await this.sendWs({
          post_type: 'tool_activity', session_id: this.id,
          tool: 'bash', brief: briefOf(cmd), mid: (entry || {}).id,
        });
      } else if (itemType === 'mcp_tool_call') {
        const brief = String(item.title || item.name || 'mcp tool');
        await this.sendWs({ post_type: 'tool_activity', session_id: this.id, tool: 'mcp', brief });
      } else if (itemType === 'web_search') {
        const brief = String(item.query || 'web search');
        await this.sendWs({ post_type: 'tool_activity', session_id: this.id, tool: 'web_search', brief });
      }
      if (item.text !== undefined && this._itemText.get(itemId) === undefined) {
        this._itemText.set(itemId, item.text || '');
      }
    } else if (t === 'item.updated') {
      const prev = this._itemText.get(itemId);
      const text = item.text || '';
      if (prev !== undefined && text.length > prev.length) {
        const delta = text.slice(prev.length);
        this._itemText.set(itemId, text);
        if (itemType === 'agent_message') {
          this.text_buf.push(delta);
          await this.sendWs({ post_type: 'delta', session_id: this.id, text: delta });
        } else if (itemType === 'reasoning') {
          this.last_activity = Date.now() / 1000;
          this.thinking_chars += delta.length;
          await this.sendWs({
            post_type: 'thinking', session_id: this.id,
            tokens: Math.max(1, Math.round(this.thinking_chars / 4)),
          });
        }
      } else if (prev === undefined && text) {
        this._itemText.set(itemId, text);
        if (itemType === 'agent_message' && text) {
          this.text_buf.push(text);
          await this.sendWs({ post_type: 'delta', session_id: this.id, text });
        }
      }
    } else if (t === 'item.completed') {
      if (itemType === 'file_change') {
        const paths = ((item.changes || []).map((c) => c.path)).filter(Boolean).join(', ');
        if (paths) {
          const entry = this._logTurn('tool', 'Edit：' + briefOf(paths));
          await this.sendWs({
            post_type: 'tool_activity', session_id: this.id,
            tool: 'Edit', brief: briefOf(paths), mid: (entry || {}).id,
          });
        }
      } else if (itemType === 'command_execution' && (item.status === 'failed' || item.status === 'declined')) {
        const cmd = String(item.command || '');
        await this.sendWs({
          post_type: 'tool_activity', session_id: this.id,
          tool: 'bash', brief: briefOf(cmd) + ' [' + item.status + ']',
        });
      }
    } else if (t === 'turn.completed') {
      await this._handleTurnCompleted(obj.usage || {});
    } else if (t === 'turn.failed') {
      const msg = (obj.error && obj.error.message) || 'turn failed';
      await this._finishTurn({ text: msg, is_error: true, subtype: 'error_during_execution', usage: {} });
    } else if (t === 'error') {
      const msg = obj.message || 'codex error';
      await this._finishTurn({ text: msg, is_error: true, subtype: 'error_during_execution', usage: {} });
    }
  }

  async _handleTurnCompleted(usage) {
    let finalText = this.text_buf.join('');
    // prefer the last agent_message item's full text
    for (const [id, text] of this._itemText) {
      if (text && text.trim()) finalText = text;
    }
    await this._finishTurn({ text: finalText, is_error: false, subtype: 'success', usage });
  }

  async _finishTurn({ text, is_error, subtype, usage }) {
    if (!this.turn_active) return; // already aborted/closed
    this.turn_active = false;
    this._cancelTurnTimer();
    this.last_activity = Date.now() / 1000;
    const durationMs = this.turn_started_at ? Date.now() - this.turn_started_at : undefined;
    const sealed = this._flushTextLog();
    let finalMid = (sealed || {}).id;
    if (!sealed && text && text.trim()) {
      finalMid = (this._logTurn('cc', text) || {}).id;
    }
    await this.sendWs({
      post_type: 'final', session_id: this.id,
      text: text || '',
      mid: finalMid,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_input_tokens: usage.cached_input_tokens,
        reasoning_tokens: usage.reasoning_output_tokens,
      },
      cost_usd: undefined,
      duration_ms: durationMs,
      num_turns: 1,
      is_error,
      subtype,
      echo: this.turn_echo,
    });
    log('codex_turn_end', {
      session_id: this.id, dur_ms: durationMs,
      out_tokens: usage.output_tokens, is_error,
    });
  }

  // ---------- permission / channel: next-turn semantics, no restart needed ----------
  async setPermission(mode, echo = null) {
    if (!mode || mode === 'default') mode = 'read-only';
    if (mode === 'bypassPermissions') mode = 'danger-full-access';
    if (mode === 'acceptEdits') mode = 'full-auto';
    this.launch_mode = mode;
    this.permission_mode = mode;
    this.pending_mode = null;
    this._saveSessMeta();
    await this.sendWs({
      post_type: 'permission_ack', session_id: this.id, mode,
      applied: !this.turn_active, echo,
    });
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
    if (channel !== null && model) channel = { ...channel, model };
    this.channel = channel;
    this.model_name = channel === null ? (model || null) : (channel.model || null);
    this._saveSessMeta();
    const chanName = (channel || {}).name;
    if (this.turn_active) {
      await this.sendWs({
        post_type: 'error', session_id: this.id, code: 'busy',
        message: 'cannot switch model during turn', echo,
      });
      return;
    }
    log('codex_channel_set', { session_id: this.id, channel: chanName, model: this.model_name });
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
    killProcGroup(this.proc);
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

  async _killProcess() {
    if (procAlive(this.proc)) {
      killProcGroup(this.proc);
      await waitProc(this.proc, 5000);
      killProcGroupForce(this.proc);
    }
  }
}
