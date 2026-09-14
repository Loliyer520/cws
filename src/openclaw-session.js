// cc-bridge (Node) — OpenclawSession: remote OpenClaw Gateway backend.
// Drives a remote gateway session over the official @openclaw/gateway-client
// (Gateway WS protocol v4): chat.send / chat.history / sessions.abort /
// approval.resolve / sessions.patch, with 'chat' delta-final event streaming.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { BaseSession } from './base-session.js';
import { gatewayByName, PERMISSION_MODE } from './config.js';
import { getGateway, onGatewayEvent } from './gateway.js';
import { log } from './util.js';

const OPENCLAW_PERMISSIONS = ['read-only', 'guarded', 'workspace', 'full'];

export class OpenclawSession extends BaseSession {
  constructor(bridge, sid, ws, opts = {}) {
    super(bridge, sid, ws, opts);
    const meta = this._loadSessMeta();
    this.gatewayName = opts.gateway || meta.gateway || 'openclaw';
    // 网关配置里的 agent 是默认归属：多 agent 网关上 create 不带 agentId 会被拒
    const gwCfg = gatewayByName(this.gatewayName) || {};
    this.agentId = opts.agentId || gwCfg.agent || null;
    this.remoteKey = opts.remoteKey || meta.remote_key || null;
    this.remoteSessionId = meta.remote_session_id || null;
    this._off = null;
    this._gwReady = false;
    this._turnRunId = null;
    if (!OPENCLAW_PERMISSIONS.includes(this.permission_mode)) {
      this.permission_mode = 'read-only';
      this.launch_mode = 'read-only';
    }
    this._saveSessMeta();
  }

  holdsSlot() { return false; }

  _loadSessMeta() {
    const m = super._loadSessMeta();
    return m && typeof m === 'object' ? m : {};
  }

  _saveSessMeta() {
    try {
      fs.writeFileSync(
        this._sessMetaPath(),
        JSON.stringify({
          permission_mode: this.launch_mode,
          channel: (this.channel || {}).name || '',
          model: this.model_name || '',
          backend: this.backend,
          thread_id: this.thread_id || '',
          gateway: this.gatewayName,
          agent_id: this.agentId || '',
          remote_key: this.remoteKey || '',
          remote_session_id: this.remoteSessionId || '',
        }),
      );
    } catch { /* ignore */ }
  }

  async _ensureProcess() {
    if (this._gwReady) return;
    const gw = await getGateway(this.gatewayName);
    if (!this._off) {
      this._off = onGatewayEvent(this.gatewayName, (ev) => this._handleEvent(ev));
    }
    if (!this.remoteKey) {
      const res = await gw.client.request('sessions.create', {
        agentId: this.agentId || undefined,
        label: 'cws:' + this.id,
        model: this.model_name || undefined,
      });
      this.remoteKey = res.key;
      this.remoteSessionId = res.sessionId || null;
      log('openclaw_session_created', { session_id: this.id, remote_key: this.remoteKey });
    }
    try {
      await gw.client.request('sessions.messages.subscribe', {
        key: this.remoteKey,
        agentId: this.agentId || undefined,
        includeApprovals: true,
      });
    } catch (e) {
      log('openclaw_subscribe_err', { session_id: this.id, err: String(e) });
    }
    this._saveSessMeta();
    this._gwReady = true;
  }

  async _writeTurn(text) {
    const gw = await getGateway(this.gatewayName);
    this._turnRunId = null;
    const res = await gw.client.request('chat.send', {
      sessionKey: this.remoteKey,
      agentId: this.agentId || undefined,
      message: text,
      idempotencyKey: crypto.randomUUID(),
    });
    if (res && res.runId) this._turnRunId = res.runId;
    log('openclaw_turn_start', { session_id: this.id, remote_key: this.remoteKey, run_id: this._turnRunId });
  }

  _handleEvent(ev) {
    const p = ev.payload || {};
    if (ev.event === 'chat') return this._handleChat(p);
    if (ev.event === 'session.message') return this._handleSessionMessage(p);
    if (ev.event === 'session.approval') return this._handleApproval(p);
  }

  _isMine(p) {
    return p && (p.sessionKey === this.remoteKey || p.sourceSessionKey === this.remoteKey);
  }

  /** OpenClaw 消息文本在 message.content[]（[{type:'text',text}]），兼容纯字符串。 */
  _contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let out = '';
    for (const b of content) {
      if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') out += b.text;
    }
    return out;
  }

  async _handleChat(p) {
    if (!this._isMine(p)) return;
    if (p.state === 'delta') {
      if (p.deltaText) {
        this.text_buf.push(p.deltaText);
        await this.sendWs({ post_type: 'delta', session_id: this.id, text: p.deltaText });
      }
    } else if (p.state === 'final') {
      await this._finishTurn(p);
    } else if (p.state === 'aborted') {
      await this._abortTurn(p.stopReason || p.errorMessage || 'aborted');
    } else if (p.state === 'error') {
      await this._finishTurn(Object.assign({}, p, { isError: true }));
    }
  }

  async _handleSessionMessage(p) {
    if (!this._isMine(p)) return;
    const text = p.text || (p.message && p.message.text) || '';
    if (text && p.state !== 'delta') {
      this.text_buf.push(text);
      await this.sendWs({ post_type: 'delta', session_id: this.id, text });
    }
  }

  async _finishTurn(p) {
    if (!this.turn_active) return;
    this.turn_active = false;
    this._cancelTurnTimer();
    this.last_activity = Date.now() / 1000;
    const message = p.message || {};
    const finalText = typeof message === 'string' ? message
      : (message.text || this._contentText(message.content) || this.text_buf.join(''));
    const sealed = this._flushTextLog();
    let finalMid = (sealed || {}).id;
    if (!sealed && finalText && finalText.trim()) {
      finalMid = (this._logTurn('cc', finalText) || {}).id;
    }
    const usage = p.usage || {};
    await this.sendWs({
      post_type: 'final', session_id: this.id,
      text: finalText || '', mid: finalMid,
      usage: { input_tokens: usage.inputTokens || usage.input_tokens, output_tokens: usage.outputTokens || usage.output_tokens },
      cost_usd: usage.costUsd,
      duration_ms: p.durationMs,
      num_turns: 1,
      is_error: !!p.isError,
      subtype: p.isError ? 'error_during_execution' : 'success',
      echo: this.turn_echo,
    });
    log('openclaw_turn_end', { session_id: this.id, is_error: !!p.isError });
  }

  async _abortTurn(reason) {
    if (!this.turn_active) return;
    if (!this.aborted_sent) {
      this.aborted_sent = true;
      this.turn_active = false;
      this._cancelTurnTimer();
      const sealed = this._flushTextLog();
      if (sealed) {
        await this.sendWs({ post_type: 'cc_msg', session_id: this.id, mid: sealed.id, text: sealed.text });
      }
      await this.sendWs({ post_type: 'turn_aborted', session_id: this.id, reason, echo: this.turn_echo });
    }
  }

  _handleApproval(p) {
    if (p.phase !== 'pending') return;
    if (p.sessionKey !== this.remoteKey && p.sourceSessionKey !== this.remoteKey) return;
    const a = p.approval || {};
    const pres = a.presentation || {};
    const kind = pres.kind || a.kind || 'exec';
    const askId = 'oc-' + a.id;
    if (this.pending_asks.has(askId)) return;
    const askFrame = {
      post_type: 'ask', session_id: this.id, ask_id: askId,
      kind: 'permission', tool_name: kind,
      input: pres.commandText ? { command: pres.commandText } : pres,
    };
    this.pending_asks.set(askId, { request_id: a.id, kind, ask_frame: askFrame });
    this.last_activity = Date.now() / 1000;
    this.sendWs(askFrame).catch(() => {});
    log('openclaw_ask', { session_id: this.id, approval_id: a.id, kind });
  }

  async askReply(askId, behavior, message = null, updatedInput = null, echo = null) {
    const entry = this.pending_asks.get(askId);
    if (!entry) {
      await this.sendWs({ post_type: 'error', session_id: this.id, code: 'unknown_ask', ask_id: askId, echo });
      return;
    }
    this.pending_asks.delete(askId);
    try {
      const gw = await getGateway(this.gatewayName);
      await gw.client.request('approval.resolve', {
        id: entry.request_id, kind: entry.kind,
        decision: behavior === 'allow' ? 'allow-once' : 'deny',
      });
    } catch (e) {
      await this.sendWs({ post_type: 'error', session_id: this.id, code: 'ask_reply_failed', message: String(e), echo });
      return;
    }
    await this.sendWs({ post_type: 'ask_replied', session_id: this.id, ask_id: askId, behavior, echo });
  }

  async loadHistory(echo) {
    try {
      await this._ensureProcess();
      const gw = await getGateway(this.gatewayName);
      const res = await gw.client.request('chat.history', { sessionKey: this.remoteKey, limit: 200 });
      const msgs = res.messages || res.items || [];
      const entries = [];
      for (const m of msgs) {
        const role = (m.role === 'user' || m.author === 'user' || m.from === 'user') ? 'user' : 'cc';
        const text = m.text || this._contentText(m.content) || this._contentText(m.message && m.message.content) || '';
        if (typeof text === 'string' && text.trim()) entries.push(this._logTurn(role, text));
      }
      return entries;
    } catch (e) {
      log('openclaw_history_err', { session_id: this.id, err: String(e) });
      return [];
    }
  }

  async abort(reason = 'user') {
    if (!this.turn_active) {
      await this.sendWs({ post_type: 'error', session_id: this.id, code: 'not_running', message: 'no active turn' });
      return;
    }
    try {
      const gw = await getGateway(this.gatewayName);
      await gw.client.request('sessions.abort', { key: this.remoteKey });
    } catch (e) {
      log('openclaw_abort_err', { session_id: this.id, err: String(e) });
    }
    await this._abortTurn(reason);
  }

  async setPermission(mode, echo = null) {
    if (!mode || !OPENCLAW_PERMISSIONS.includes(mode)) {
      await this.sendWs({ post_type: 'error', session_id: this.id, code: 'bad_permission', message: 'invalid openclaw permission mode', echo });
      return;
    }
    this.launch_mode = mode;
    this.permission_mode = mode;
    this._saveSessMeta();
    if (this._gwReady && this.remoteKey) {
      try {
        const gw = await getGateway(this.gatewayName);
        await gw.client.request('sessions.patch', { key: this.remoteKey, permissionMode: mode });
      } catch (e) { /* applied next turn */ }
    }
    await this.sendWs({ post_type: 'permission_ack', session_id: this.id, mode, applied: this._gwReady, echo });
  }

  async setChannel(channel, model = null, echo = null, clear = false) {
    if (channel === null && model === null && !clear) {
      await this.sendWs({
        post_type: 'model_ack', session_id: this.id,
        channel: (this.channel || {}).name, model: this.model_name, applied: false, echo,
      });
      return;
    }
    if (channel === null && model && !clear && this.channel !== null) channel = Object.assign({}, this.channel);
    if (channel !== null && model) channel = Object.assign({}, channel, { model });
    this.channel = channel;
    this.model_name = channel === null ? (model || null) : (channel.model || model || null);
    this._saveSessMeta();
    if (this._gwReady && this.remoteKey) {
      try {
        const gw = await getGateway(this.gatewayName);
        await gw.client.request('sessions.patch', { key: this.remoteKey, model: this.model_name || undefined });
      } catch (e) { /* ignore */ }
    }
    await this.sendWs({
      post_type: 'model_ack', session_id: this.id,
      channel: (channel || {}).name, model: this.model_name, applied: true, echo,
    });
  }

  async _killProcess() { /* remote session persists; nothing to kill */ }

  async close(reason = 'dropped', notify = true, echo = null) {
    if (this._off) { this._off(); this._off = null; }
    // 用户销毁：远端网关的会话+transcript 一并删（别的关闭原因不动远端）
    if (reason === 'dropped' && this.remoteKey) {
      try {
        const gw = await getGateway(this.gatewayName);
        await gw.client.request('sessions.delete', {
          key: this.remoteKey,
          agentId: this.agentId || undefined,
          deleteTranscript: true,
        });
        log('openclaw_remote_deleted', { session_id: this.id, remote_key: this.remoteKey });
      } catch (e) {
        log('openclaw_remote_delete_err', { session_id: this.id, err: String(e) });
      }
    }
    await super.close(reason, notify, echo);
  }
}

