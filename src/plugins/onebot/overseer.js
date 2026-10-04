// overseer.js — L5 卡西总控：主人私聊会话 + L3 升级受理 + 跨 scope 管控。
// QQ 域工具/硬护栏/升级受理/主动开口合并，见文件头设计注释与 README.md。
import { log } from '../../util.js';
import { buildSendSegments } from './protocol.js';

const QQ_PATCH = [
  '除桥管理工具外，你还可用 qq_* 系列工具管理号主的 QQ 会话：看会话/改模式/增删触发词/代发消息/读历史/强制摘要。',
  '主人私聊 scope 禁止 off（防总控失联）；auto 群触发词不许删空。',
  '本部署监视的就是号主本人的账号：主人在自会话（手机上「发给自己的聊天」）里说话就是对你的指令，历史里显示为 [本人其他设备] 前缀；你的回复会出现在同一个自会话里。',
  '升级受理：收到「[升级]」标记时，qq_read 看上下文、qq_send 代回或忽略，处置完简短告知主人。',
].join('\n');

export const QQ_TOOLS = [
  { name: 'qq_scopes', description: '列出全部 QQ 会话（scope/模式/最近活跃/统计）', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'qq_scope_get', description: '单会话详情：滚动摘要 + 最近 10 条', parameters: { type: 'object', properties: { scope: { type: 'string', description: 'group_<群号> / private_<QQ号>' } }, required: ['scope'] } },
  { name: 'qq_set_mode', description: '改会话模式：off(不看不回)/watch(只看+摘要)/auto(自动应答)', parameters: { type: 'object', properties: { scope: { type: 'string' }, mode: { type: 'string', description: 'off | watch | auto' } }, required: ['scope', 'mode'] } },
  { name: 'qq_trigger_words', description: '增删会话触发词（auto 群无@时命中词触发）', parameters: { type: 'object', properties: { scope: { type: 'string' }, add: { type: 'string' }, remove: { type: 'string' } }, required: ['scope'] } },
  { name: 'qq_send', description: '以本号身份代发消息到任意会话（主人明示的代发）', parameters: { type: 'object', properties: { scope: { type: 'string' }, text: { type: 'string' } }, required: ['scope', 'text'] } },
  { name: 'qq_read', description: '读某会话最近 n 条消息（默认 20，上限 100）', parameters: { type: 'object', properties: { scope: { type: 'string' }, n: { type: 'number' } }, required: ['scope'] } },
  { name: 'qq_summarize_now', description: '强制立即生成某会话滚动摘要，返回全文', parameters: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'] } },
];

const nowS = () => Date.now() / 1000;

export class Overseer {
  /** @param cfg 插件配置 @param store L0 @param endpoint OnebotServer
   *  @param deps { kxTurn, kaxiSystemPrompt, kaxiTools, kaxiExec, callLLM }
   *  @param gate L1（flushTurned 回填） */
  constructor(cfg, store, endpoint, deps, gate) {
    this.cfg = cfg;
    this.store = store;
    this.endpoint = endpoint;
    this.deps = deps;      // 桥注入的通用能力（index.js 从 ctx 取）
    this.gate = gate;
    this.chain = Promise.resolve(); // 总控回合全局串行（一人操作，无需并发）
    this.notifyBuf = [];   // 主动开口合并缓冲（30s）
    this.notifyTimer = null;
    this.summaryRef = null; // index.js 回填（qq_summarize_now 用）
  }

  get masterScope() { return 'private_' + this.cfg.masterQq; }

  /** mailbox flush 入口：master scope 的对话回合。 */
  turn(scope, batch) {
    this.chain = this.chain.then(() => this._runTurn(scope, batch)).catch((e) => {
      log('ob_overseer_err', { scope, err: String(e).slice(0, 200) });
    });
    return this.chain;
  }

  async _runTurn(scope, batch) {
    const t0 = Date.now();
    const msgs = this._buildMessages(scope);
    const tools = [...this.deps.kaxiTools, ...QQ_TOOLS];
    const r = await this.deps.kxTurn({
      channel: this.cfg.roles.kaxi.channel || null,
      model: this.cfg.roles.kaxi.model || null,
      system: this.deps.kaxiSystemPrompt(QQ_PATCH),
      messages: msgs,
      tools,
      execTool: (name, a) => this._execTool(scope, name, a),
      maxRounds: 10, budgetMs: 300_000, maxTokens: 4096,
    });
    if (!r.ok) {
      log('ob_overseer_llm_err', { err: r.error });
      await this._sendMaster('（卡西这轮出错了：' + String(r.error).slice(0, 100) + '）');
      return;
    }
    log('ob_overseer_turn', { rounds: r.steps.length, tools: r.steps.map((s) => s.name).join(','), ms: Date.now() - t0 });
    if ((r.content || '').trim()) await this._sendMaster(r.content.trim());
  }

  _buildMessages(scope) {
    const s = this.store.getScope(scope);
    const out = [];
    for (const h of (s ? s.history : [])) {
      if (h.role === 'user') out.push({ role: 'user', content: (h.nickname ? h.nickname + ': ' : '') + h.text });
      else if (h.role === 'self') out.push({ role: 'assistant', content: h.text });
      else if (h.role === 'self_device') out.push({ role: 'user', content: '[本人其他设备] ' + h.text });
      else if (h.role === 'sys') out.push({ role: 'user', content: h.text });
    }
    // 尾钉：当前时间（易变上下文钉尾部，前缀缓存友好）
    if (out.length && out[out.length - 1].role === 'user') {
      const last = out[out.length - 1];
      last.content += `\n[当前] ${new Date().toLocaleString('zh-CN', { hour12: false })}；可用 qq_* 工具管 QQ 会话`;
    }
    return out;
  }

  async _execTool(scope, name, a) {
    if (name.startsWith('qq_')) return this._execQqTool(name, a);
    return this.deps.kaxiExec(name, a); // 桥管理工具全量可用（ws=null 不发状态帧）
  }

  async _execQqTool(name, a) {
    const scope = String(a.scope || '').trim();
    const validScope = (sc) => /^((group|private)_[1-9][0-9]{4,})$/.test(sc);
    switch (name) {
      case 'qq_scopes': {
        const list = this.store.listScopes().map((x) => ({
          scope: x.scope, type: x.type, mode: x.mode,
          last_active: x.stats.last_active, received: x.stats.received, sent: x.stats.sent,
        }));
        return { ok: true, brief: list.length + ' 个会话', scopes: list };
      }
      case 'qq_scope_get': {
        if (!validScope(scope)) return { ok: false, error: 'bad scope' };
        const info = this.store.getScopeInfo(scope);
        if (!info) return { ok: false, error: 'unknown_scope' };
        return {
          ok: true, brief: info.mode + ' · ' + info.history_len + ' 条', info,
          summary: this.store.getScope(scope).summary.text || '',
          recent: this.store.getHistory(scope, 10).map((h) => `[${h.role}] ${h.nickname}: ${h.text}`.slice(0, 200)),
        };
      }
      case 'qq_set_mode': {
        if (!validScope(scope)) return { ok: false, error: 'bad scope' };
        const mode = String(a.mode || '');
        if (!['off', 'watch', 'auto'].includes(mode)) return { ok: false, error: 'mode 只能 off/watch/auto' };
        // 硬护栏：主人私聊禁 off（防总控失联）
        if (scope === this.masterScope && mode === 'off') return { ok: false, error: '主人私聊禁止 off（总控通道）' };
        this.store.saveScope(scope, { mode });
        log('ob_mode_set', { scope, mode, by: 'kaxi' });
        return { ok: true, brief: scope + ' → ' + mode };
      }
      case 'qq_trigger_words': {
        if (!validScope(scope)) return { ok: false, error: 'bad scope' };
        const s = this.store.getScope(scope);
        if (!s) return { ok: false, error: 'unknown_scope' };
        const words = [...(s.trigger_words || [])];
        const add = String(a.add || '').trim();
        const del = String(a.remove || '').trim();
        if (add && !words.includes(add)) words.push(add);
        const next = del ? words.filter((w) => w !== del) : words;
        // 硬护栏：auto 群触发词不许删空（裸奔）
        if (s.type === 'group' && s.mode === 'auto' && !next.length) {
          return { ok: false, error: 'auto 群触发词不许清空（先改 watch/off 或留一个词）' };
        }
        this.store.saveScope(scope, { trigger_words: next });
        return { ok: true, brief: `词表 ${next.length} 个`, words: next };
      }
      case 'qq_send': {
        if (!validScope(scope)) return { ok: false, error: 'bad scope' };
        if (scope === this.masterScope) return { ok: false, error: '不能代发给自己' };
        const text = String(a.text || '').trim();
        if (!text) return { ok: false, error: 'text 为空' };
        try {
          this.endpoint.markSelfSent(scope, text);
          const msgId = await this.endpoint.sendToScope(scope, buildSendSegments({ text }));
          this.store.appendSent(scope, text, msgId);
          return { ok: true, brief: '已代发到 ' + scope };
        } catch (e) {
          this.endpoint.unmarkSelfSent(scope, text);
          return { ok: false, error: String(e.message || e).slice(0, 160) };
        }
      }
      case 'qq_read': {
        if (!validScope(scope)) return { ok: false, error: 'bad scope' };
        const n = Math.max(1, Math.min(100, Number(a.n) || 20));
        return {
          ok: true, brief: '最近 ' + n + ' 条',
          messages: this.store.getHistory(scope, n).map((h) => `[${h.role}] ${h.nickname}: ${h.text}`.slice(0, 300)),
        };
      }
      case 'qq_summarize_now': {
        if (!validScope(scope)) return { ok: false, error: 'bad scope' };
        if (!this.summaryRef) return { ok: false, error: '摘要器未就绪' };
        const ok = await this.summaryRef.force(scope);
        return ok
          ? { ok: true, brief: '已更新', summary: this.store.getScope(scope).summary.text }
          : { ok: false, error: '摘要失败（见日志）' };
      }
      default:
        return { ok: false, error: 'unknown_tool: ' + name };
    }
  }

  /** L3 升级受理：不等主人说话，主动注入系统报告并开回合。 */
  async escalate(fromScope, reason, brief) {
    // 频次闸（全局每小时）
    const r = this._escRate || { bucket: 0, n: 0 };
    const bucket = Math.floor(Date.now() / 3600_000);
    if (r.bucket !== bucket) { r.bucket = bucket; r.n = 0; }
    this._escRate = r;
    if (r.n >= this.cfg.escalateHourlyCap) {
      log('ob_overseer_escalate', { from: fromScope, reason, dropped: 'cap' });
      return false;
    }
    r.n += 1;
    log('ob_overseer_escalate', { from: fromScope, reason });
    const sysEv = {
      kind: 'message', scope: this.masterScope, ts: nowS(), msgId: 0, userId: 0,
      nickname: '[升级]', atMe: false, replyTo: null, fromSelfDevice: false,
      text: `[升级] 来自 ${fromScope}：${brief || '（无概要）'}（原因：${reason}）。可 qq_read 看上下文、qq_send 代回、或忽略。`,
    };
    // 系统报告先入档再开回合（进历史，模型才能看到）
    this.store.ingest(sysEv);
    this.turn(this.masterScope, [sysEv]);
    return true;
  }

  /** 主动开口统一出口（digest/升级处置/故障告警）：30s 窗口合并发送。 */
  notifyMaster(text) {
    const t = String(text || '').trim();
    if (t) this.notifyBuf.push(t);
    if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null;
        const body = this.notifyBuf.join('\n───\n');
        this.notifyBuf = [];
        if (body) {
          log('ob_overseer_notify', { chars: body.length, merged: body.split('───').length });
          this._sendMaster(body).catch(() => {});
        }
      }, 30_000);
      this.notifyTimer.unref?.();
    }
    return Promise.resolve();
  }

  async _sendMaster(text) {
    // 长回复 4000 字分条
    for (let i = 0; i < Math.max(1, Math.ceil(text.length / 4000)); i++) {
      const part = text.slice(i * 4000, (i + 1) * 4000);
      this.endpoint.markSelfSent(this.masterScope, part);
      try {
        const msgId = await this.endpoint.sendToScope(this.masterScope, buildSendSegments({ text: part }));
        this.store.appendSent(this.masterScope, part, msgId);
      } catch (e) {
        this.endpoint.unmarkSelfSent(this.masterScope, part);
        log('ob_overseer_send_err', { err: String(e.message || e).slice(0, 120) });
      }
    }
  }

  close() {
    if (this.notifyTimer) { clearTimeout(this.notifyTimer); this.notifyTimer = null; }
    // 缓冲里的未发通知落日志（不硬发——shutdown 时端点正在关）
    if (this.notifyBuf.length) log('ob_overseer_notify_dropped', { n: this.notifyBuf.length });
    this.notifyBuf = [];
  }
}
