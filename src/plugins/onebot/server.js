// server.js — OneBot v11 反向 WS 端点：NapCat 作为客户端连入本插件。
// 接入/鉴权/连接管理/动作调用/回声去重的完整规则见文件头设计注释与 README.md。
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { safeEqual, sleep } from '../../util.js';
import { log } from '../../util.js';
import { normalizeEvent, makeErrorResponse, segmentsToText } from './protocol.js';

const HEARTBEAT_DEFAULT_MS = 30_000;

/** 回声比对文本：buildSendSegments 发出的 at/reply 段恒在头部，回声渲染后
 *  是「@某人[回复]正文」，而登记的是裸正文——剥掉前导 at/reply 再比对，
 *  否则群回复（恒带 at 段）永远去重失败、自己的话二次入档。 */
function echoTextOf(ev) {
  const segs = [...(ev.segments || [])];
  while (segs.length && (segs[0].type === 'reply' || segs[0].type === 'at')) segs.shift();
  return segmentsToText(segs);
}

export class OnebotServer {
  /** @param cfg loadPluginConfig 产物（用 .token）
   *  @param store L0 数据层（连接态落 state.json） */
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    this.wss = new WebSocketServer({ noServer: true });
    this.conn = null;          // 当前唯一 NapCat 连接（新的顶替旧的）
    this.selfId = 0;
    this.nickname = '';
    this.online = false;
    this.lastFrameAt = 0;
    this.heartbeatMs = HEARTBEAT_DEFAULT_MS;
    this.pending = new Map();        // echo -> {resolve, reject, timer}
    this.pendingSelfSent = new Map(); // scope -> [{text, ts}] 发送登记（回声去重）
    this.onEvent = null;             // index.js 装配时赋值：(ev) => {}
    this.watchdog = setInterval(() => this._watchdog(), 30_000);
    this.watchdog.unref?.();
    this.echoSweep = setInterval(() => this._sweepSelfSent(), 60_000);
    this.echoSweep.unref?.();
  }

  /** WS 升级入口（桥 server.js 经 registerUpgrade('/onebot/', …) 分发过来）。
   *  鉴权：Authorization: Bearer 优先，兜底 ?access_token=；失败 401 拆连接
   *  （只记 IP，永不记 token 本体）。 */
  handleUpgrade(req, socket, head) {
    const url = new URL(req.url || '/', 'http://ob.local');
    const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const given = bearer || String(url.searchParams.get('access_token') || '');
    if (!given || !safeEqual(given, this.cfg.token)) {
      log('ob_auth_fail', { ip: req.socket.remoteAddress || '' });
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this._onConn(ws));
  }

  _onConn(ws) {
    // 单连接策略：新连接顶替旧连接（僵尸连接不能共存——liveai BRIDGE_NOT_READY 教训）
    if (this.conn) {
      log('ob_replace', {});
      try { this.conn.close(1000, 'replaced'); } catch { /* ignore */ }
    }
    this.conn = ws;
    this.online = true;
    this.lastFrameAt = Date.now();
    log('ob_connect', {});
    this.store.updateState({ connected_at: Date.now() / 1000 });
    // 主动探测身份（等 lifecycle 不可靠）；失败 5s 后再试一次，仍败则从事件帧学
    this._probeIdentity().catch(() => {});
    ws.on('message', (data) => {
      this.lastFrameAt = Date.now();
      let f;
      try { f = JSON.parse(data.toString()); } catch {
        log('ob_bad_frame', { head: String(data).slice(0, 100) });
        return;
      }
      this._onFrame(f).catch((e) => log('ob_frame_err', { err: String(e) }));
    });
    ws.on('close', () => {
      if (this.conn === ws) {
        this.conn = null;
        this.online = false;
        this.store.updateState({ connected_at: this.store.getState().connected_at || 0, online: false });
        log('ob_offline', {});
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('ob_offline'));
        }
        this.pending.clear();
      }
    });
    ws.on('error', () => { /* close 事件随后必到 */ });
  }

  async _probeIdentity() {
    for (let i = 0; i < 2; i++) {
      try {
        const r = await this.callAction('get_login_info', {}, 10_000);
        const d = (r && r.data) || {};
        if (d.user_id) {
          this.selfId = Number(d.user_id);
          this.nickname = String(d.nickname || '');
          this.store.updateState({ self_id: this.selfId, nickname: this.nickname, online: true });
          log('ob_identity', { self_id: this.selfId, chars: this.nickname.length });
          return;
        }
      } catch { /* 重试 */ }
      await sleep(5000);
      if (this.conn === null) return; // 连接已死，等下一条连接
    }
  }

  async _onFrame(f) {
    if (!f || typeof f !== 'object') return;
    // 身份学习：任何帧带 self_id 都可补认（get_login_info 探测失败的兜底）
    if (!this.selfId && Number(f.self_id)) {
      this.selfId = Number(f.self_id);
      this.store.updateState({ self_id: this.selfId });
    }
    // 动作响应：echo 配对
    if (f.echo !== undefined && f.echo !== null && !f.post_type) {
      const p = this.pending.get(f.echo);
      if (p) {
        this.pending.delete(f.echo);
        clearTimeout(p.timer);
        p.resolve(f);
      }
      return;
    }
    // 反向动作（NapCat 调我们——协议上不该发生，保险 1404；get_version_info 礼貌应答）
    if (f.action && !f.post_type) {
      if (f.action === 'get_version_info') {
        this._rawSend({ status: 'ok', retcode: 0, data: { app_name: 'cws-onebot', version: '0.1.0' }, echo: f.echo });
      } else {
        this._rawSend(makeErrorResponse(f.echo, 1404, 'unsupported action'));
      }
      return;
    }
    // 心跳喂狗
    if (f.post_type === 'meta_event' && f.meta_event_type === 'heartbeat' && Number(f.interval)) {
      this.heartbeatMs = Math.max(HEARTBEAT_DEFAULT_MS, Number(f.interval) * 3);
    }
    // 事件归一化 → 回声去重 → 管线
    const ev = normalizeEvent(f, this.selfId);
    if (!ev) return;
    if (ev.kind === 'message_sent' && ev.fromSelfDevice && this._takeSelfEcho(ev.scope, echoTextOf(ev))) {
      log('ob_echo_dedup', { scope: ev.scope, chars: ev.text.length });
      return; // 本插件自己发的回声：历史里已有 role=self，不再进管线
    }
    if (this.onEvent) await this.onEvent(ev);
  }

  _watchdog() {
    if (!this.conn || !this.online) return;
    if (Date.now() - this.lastFrameAt > this.heartbeatMs + 15_000) {
      this.online = false; // 不主动断，等 TCP 层或 NapCat 自重连
      this.store.updateState({ online: false });
      log('ob_heartbeat_lost', { silent_ms: Date.now() - this.lastFrameAt });
    }
  }

  _rawSend(obj) {
    if (!this.conn || this.conn.readyState !== 1) return false;
    try { this.conn.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  /** 动作调用：echo 配对，超时 reject，断连时全部 pending 立即 reject。 */
  callAction(action, params = {}, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      if (!this.conn || this.conn.readyState !== 1) {
        reject(new Error('ob_offline'));
        return;
      }
      const echo = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error('ob_action_timeout: ' + action));
      }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      if (!this._rawSend({ action, params, echo })) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new Error('ob_offline'));
      }
    });
  }

  /** scope → 动作分发发送。返回 message_id。 */
  async sendToScope(scope, segments) {
    const m = scope.match(/^(group|private)_([1-9][0-9]{4,})$/);
    if (!m) throw new Error('bad_scope');
    const action = m[1] === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = m[1] === 'group'
      ? { group_id: Number(m[2]), message: segments, auto_escape: false }
      : { user_id: Number(m[2]), message: segments, auto_escape: false };
    const r = await this.callAction(action, params, 20_000);
    if (r.retcode !== 0) throw new Error('send_failed: retcode=' + r.retcode + ' ' + String(r.message || '').slice(0, 120));
    return Number(r.data && r.data.message_id) || 0;
  }

  /** 发送登记（发送前调，防回声竞态）；发送失败须 unmarkSelfSent。 */
  markSelfSent(scope, text) {
    if (!text) return;
    let arr = this.pendingSelfSent.get(scope);
    if (!arr) { arr = []; this.pendingSelfSent.set(scope, arr); }
    arr.push({ text, ts: Date.now() });
    if (arr.length > 50) arr.shift();
  }

  unmarkSelfSent(scope, text) {
    const arr = this.pendingSelfSent.get(scope);
    if (!arr) return;
    const i = arr.findIndex((e) => e.text === text);
    if (i >= 0) arr.splice(i, 1);
  }

  _takeSelfEcho(scope, text) {
    const arr = this.pendingSelfSent.get(scope);
    if (!arr) return false;
    const i = arr.findIndex((e) => e.text === text);
    if (i < 0) return false;
    arr.splice(i, 1);
    return true;
  }

  _sweepSelfSent() {
    const cut = Date.now() - 60_000;
    for (const [scope, arr] of this.pendingSelfSent) {
      const keep = arr.filter((e) => e.ts > cut);
      if (keep.length) this.pendingSelfSent.set(scope, keep);
      else this.pendingSelfSent.delete(scope);
    }
  }

  status() {
    return {
      online: this.online, self_id: this.selfId || null, nickname: this.nickname || '',
      has_conn: !!this.conn,
      connected_at: this.store.getState().connected_at || null,
    };
  }

  async close() {
    clearInterval(this.watchdog);
    clearInterval(this.echoSweep);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('ob_shutdown')); }
    this.pending.clear();
    if (this.conn) { try { this.conn.close(1001, 'going away'); } catch { /* ignore */ } }
    // wss 无常驻客户端（conn 已逐个关），close 仅释放内部资源
    try { await new Promise((res) => this.wss.close(res)); } catch { /* ignore */ }
  }
}
