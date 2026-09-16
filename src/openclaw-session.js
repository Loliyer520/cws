// cc-bridge (Node) — OpenclawSession: remote OpenClaw Gateway backend.
// Drives a remote gateway session over the official @openclaw/gateway-client
// (Gateway WS protocol v4): chat.send / chat.history / sessions.abort /
// approval.resolve / sessions.patch, with 'chat' delta-final event streaming.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { BaseSession } from './base-session.js';
import { GATEWAYS, gatewayByName, PERMISSION_MODE } from './config.js';
import { getGateway, onGatewayEvent } from './gateway.js';
import { log } from './util.js';

const OPENCLAW_PERMISSIONS = ['read-only', 'guarded', 'workspace', 'full'];

export class OpenclawSession extends BaseSession {
  constructor(bridge, sid, ws, opts = {}) {
    super(bridge, sid, ws, opts);
    const meta = this._loadSessMeta();
    this.gatewayName = opts.gateway || meta.gateway || 'openclaw';
    if (!gatewayByName(this.gatewayName)) {
      // 老会话存的网关名已不在配置里（默认名 'openclaw' 漂移/网关改名）：
      // 只配了一个网关时回退到它——否则 resume 即 unknown gateway，会话变砖
      const names = Object.keys(GATEWAYS).filter((n) => GATEWAYS[n] && typeof GATEWAYS[n] === 'object');
      if (names.length === 1) {
        log('openclaw_gw_fallback', { session_id: this.id, from: this.gatewayName, to: names[0] });
        this.gatewayName = names[0];
      }
    }
    // 网关配置里的 agent 是默认归属：多 agent 网关上 create 不带 agentId 会被拒
    const gwCfg = gatewayByName(this.gatewayName) || {};
    this.agentId = opts.agentId || gwCfg.agent || null;
    // 模型完全归网关侧配置管：桥的渠道/模型体系是 claude 后端概念，
    // 不继承默认渠道/meta 残留，也不随 create/set_model 下发
    this.channel = null;
    this.model_name = null;
    this.remoteKey = opts.remoteKey || meta.remote_key || null;
    this.remoteSessionId = meta.remote_session_id || null;
    this._off = null;
    this._gwReady = false;
    this._turnRunId = null;
    // 每轮重置（_writeTurn）：agent 流去重状态
    this._agentItems = new Map(); // assistant itemId -> 已转发的累计字符数
    this._seenTools = new Set();  // 已播报的 toolCallId
    this._sawAgentText = false;   // 见过 agent assistant 流后忽略 chat delta（同源双发）
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
    // BaseSession 构造器里的虚调用（super() 期间）：gatewayName 还没赋值，
    // 写出去会把盘上 remote_key/gateway 抹掉——半初始化状态一律不落盘
    if (this.gatewayName === undefined) return;
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
          remark: this.remark || '',
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
      let res;
      try {
        res = await gw.client.request('sessions.create', {
          agentId: this.agentId || undefined,
          label: 'cws:' + this.id,
        });
      } catch (e) {
        // 远端已有同 label 会话（本地 remote_key 曾丢失/被清）：按 label 认领
        // 回来续用，而不是把会话打死——transcript 还在远端
        const adopted = await this._findByLabel(gw, 'cws:' + this.id);
        if (!adopted) throw e;
        res = { key: adopted.key, sessionId: adopted.sessionId || null };
        log('openclaw_label_adopt', { session_id: this.id, remote_key: res.key });
      }
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

  /** 按 label 在网关会话列表里找回远端会话（remote_key 丢失后的自愈路径）。 */
  async _findByLabel(gw, label) {
    try {
      const res = await gw.client.request('sessions.list', {
        agentId: this.agentId || undefined,
      }, { timeoutMs: 8000 });
      const items = (res && (res.sessions || res.items)) || [];
      for (const s of items) {
        if (s && s.label === label) {
          return { key: s.key || s.sessionKey || null, sessionId: s.sessionId || null };
        }
      }
    } catch { /* fallthrough */ }
    return null;
  }

  async _writeTurn(text) {
    const gw = await getGateway(this.gatewayName);
    this._turnRunId = null;
    this._agentItems = new Map();
    this._seenTools = new Set();
    this._sawAgentText = false;
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
    if (ev.event === 'agent') return this._handleAgent(p);
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
    // 同一远端会话可能有并发写入者（网关 agent 心跳 cron、dashboard 直连等），
    // 互相 supersede 时输家会广播 aborted。chat.send 返回的 runId 就是我们传的
    // idempotencyKey——只认自己这一轮的事件，别人/上一轮的 aborted 不能杀本地轮
    if (!this._turnRunId || !p.runId || p.runId !== this._turnRunId) return;
    if (p.state === 'delta') {
      // agent assistant 流是同一文本的源：见过它之后 chat delta 是纯重复
      if (p.deltaText && !this._sawAgentText) {
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

  /**
   * agent 结构化流：assistant 文本项（含间隙文本）、工具调用、思考。
   * 与 chat 事件同样按 _turnRunId 甄别——别的写入者的流不串台。
   */
  async _handleAgent(p) {
    if (!this._isMine(p)) return;
    if (!this._turnRunId || !p.runId || p.runId !== this._turnRunId) return;
    const d = p.data || {};
    if (p.stream === 'assistant') {
      // text 是该 item 的累计全文：按 itemId 记已发长度，只发增量。
      // 间隙文本（工具之间的 assistant 段）也走这里，工具播报时封口落盘。
      const itemId = d.itemId || '_';
      const text = typeof d.text === 'string' ? d.text : '';
      const prev = this._agentItems.get(itemId) || 0;
      let part = '';
      if (text.length > prev) {
        part = text.slice(prev);
        this._agentItems.set(itemId, text.length);
      } else if (!text && typeof d.delta === 'string' && d.delta && prev <= 0) {
        part = d.delta; // 只给 delta 不给累计 text 的提供者（-1 = 已进入 delta 模式）
        this._agentItems.set(itemId, -1);
      }
      if (part) {
        this._sawAgentText = true;
        this.text_buf.push(part);
        this.last_activity = Date.now() / 1000;
        await this.sendWs({ post_type: 'delta', session_id: this.id, text: part });
      }
    } else if (p.stream === 'item' && d.kind === 'tool') {
      const id = d.toolCallId || d.itemId;
      if (!id || this._seenTools.has(id)) return;
      this._seenTools.add(id);
      this.last_activity = Date.now() / 1000;
      // 与 claude 后端同构：工具前把已积文本封口成 cc_msg，再播报工具步骤
      const sealed = this._flushTextLog();
      if (sealed) {
        await this.sendWs({ post_type: 'cc_msg', session_id: this.id, mid: sealed.id, text: sealed.text });
      }
      const brief = String(d.meta || d.title || '').slice(0, 120);
      const tEntry = this._logTurn('tool', `${d.name || 'tool'}：${brief}`);
      await this.sendWs({
        post_type: 'tool_activity', session_id: this.id,
        tool: d.name || 'tool', brief, mid: (tEntry || {}).id,
      });
    } else if (p.stream === 'thinking') {
      // 只转发开场思考段：工具/正文出现后继续转，前端 onThinking 会为每个
      // 思考段新开一个带 "● OpenClaw" 头的空 cc 块——工具行看起来像条条
      // 都带 openclaw 标签（k3 每次工具调用前都思考，一轮几十个）
      if (this._seenTools.size > 0 || this._sawAgentText) return;
      const delta = typeof d.delta === 'string' ? d.delta : '';
      if (!delta) return;
      this.thinking_chars += delta.length;
      await this.sendWs({
        post_type: 'thinking', session_id: this.id,
        tokens: Math.max(1, Math.round(this.thinking_chars / 4)),
      });
    }
  }

  async _handleSessionMessage(p) {
    if (!this._isMine(p)) return;
    // 消息记录会回显用户自己那条（role:user）：只把 assistant 记录当输出，
    // 且别的写入者的消息不串台（__openclaw.runId 对不上就跳过）
    const m = p.message || {};
    if (m.role && m.role !== 'assistant') return;
    // 外部写入者串台根治（与 chat/agent 对称）：别的客户端/CLI 直接向这个
    // 共享 remoteKey 发消息时，其 session.message 事件的 message 里根本没有
    // __openclaw.runId 字段（payload keys 只有 sessionKey/message/...）。旧守卫
    // 「rid 和 _turnRunId 都有值且不匹配才 return」对此形同虚设——rid 恒缺、
    // _turnRunId 为 null/旧值时放行，把别人那轮的"收到"广播成 delta（笔端弹
    // 通知+未读，但本地无此会话、列表空白、未读永远清不掉）。
    // 只认本桥正在跑的轮：没跑轮/记录无 runId/runId 不匹配，一律不广播。
    const rid = m.__openclaw && m.__openclaw.runId;
    if (!this._turnRunId || !rid || rid !== this._turnRunId) return;
    if (this._sawAgentText) return; // assistant 记录与 agent 流同源，不双发
    const text = p.text || m.text || '';
    if (text && p.state !== 'delta') {
      this.text_buf.push(text);
      await this.sendWs({ post_type: 'delta', session_id: this.id, text });
    }
  }

  async _finishTurn(p) {
    if (!this.turn_active) return;
    this.turn_active = false;
    this._turnRunId = null;
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
      this._turnRunId = null;
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
    // openclaw 会话：模型由网关侧配置管理，桥不接收渠道/模型切换，
    // 一律回 applied:false（前端据此提示「网关管理」）
    await this.sendWs({
      post_type: 'model_ack', session_id: this.id,
      channel: null, model: null, applied: false, echo,
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

