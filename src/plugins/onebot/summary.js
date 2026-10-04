// summary.js — L4 摘要器：watch 群的滚动摘要与 digest 推送。
// 触发条件/摘要协议/digest 频闸/故障降级见文件头设计注释与 README.md。
import { log } from '../../util.js';

const SUMMARY_SYSTEM = [
  '你是群聊摘要器。输入是某群的消息转写（可能带一段旧摘要），输出两部分：',
  '第一部分：新的滚动摘要（≤500 字，合并旧摘要与新增内容后整体重写——是重写不是追加；保留：在聊的话题、悬而未决的问答、约定的时间地点、重要人物动向）。',
  '第二部分（可选，仅在确有值得号主注意的事时输出）：以「信号：」开头的要点列表（每行一条），只收：@号主/提到号主昵称、问答悬而未决、约定时间地点、激烈争论。没有就完全不输出第二部分。',
].join('\n');

const nowS = () => Date.now() / 1000;

export class Summarizer {
  /** @param cfg 插件配置 @param store L0 @param endpoint OnebotServer
   *  @param callLLM 桥公开入口 @param role roleCallOpts(cfg,'summary')
   *  @param notifyMaster overseer.notifyMaster(text) */
  constructor(cfg, store, endpoint, callLLM, role, notifyMaster) {
    this.cfg = cfg;
    this.store = store;
    this.endpoint = endpoint;
    this.callLLM = callLLM;
    this.role = role;
    this.notifyMaster = notifyMaster;
    this.digestAt = new Map();     // scope -> ts（同 scope digest 2h 频闸）
    this.digestHour = { bucket: 0, n: 0 };
    this.failStreak = new Map();   // scope -> 连续失败次数（3 次当日停）
    this.failDay = new Map();      // scope -> 停用日（YYYY-MM-DD）
    this.timer = setInterval(() => this.sweep().catch(() => {}), 5 * 60_000);
    this.timer.unref?.();
  }

  /** gate 判 countToSummary 的消息进来计数（阈值触达立即跑）。 */
  feed(ev) {
    this.store.bumpPending(ev.scope);
    const s = this.store.getScope(ev.scope);
    if (!s) return;
    if ((s.summary.pending || 0) >= this.cfg.summaryEveryMsgs) {
      this.run(ev.scope).catch((e) => log('ob_summary_err', { scope: ev.scope, err: String(e).slice(0, 160) }));
    }
  }

  /** 5min 扫描：低频群兜底（每 30min 且 pending≥10）。 */
  async sweep() {
    for (const info of this.store.listScopes()) {
      if ((info.pending || 0) < 10) continue;
      const s = this.store.getScope(info.scope);
      if (!s) continue;
      if (nowS() - (s.summary.upto_ts || 0) < this.cfg.summaryEveryMs / 1000) continue;
      await this.run(info.scope).catch(() => {});
    }
  }

  async run(scope) {
    if (this._stoppedToday(scope)) return false;
    const s = this.store.getScope(scope);
    if (!s) return false;
    const entries = this.store.historySince(scope, s.summary.upto_ts || 0);
    if (!entries.length) return false;
    const t0 = Date.now();
    // 转写超 6000 字截中段保首尾
    let lines = entries.map((h) => `${h.nickname || h.user_id}: ${h.text}`);
    let transcript = lines.join('\n');
    if (transcript.length > 6000) {
      const head = lines.slice(0, Math.ceil(lines.length / 3)).join('\n');
      const tail = lines.slice(-Math.ceil(lines.length / 3)).join('\n');
      transcript = head + '\n…（中段截断）…\n' + tail;
    }
    const userMsg = (s.summary.text ? `【旧摘要】\n${s.summary.text}\n\n` : '') + `【新增消息 ${entries.length} 条】\n` + transcript;
    const r = await this.callLLM(this.role.channel, this.role.model, [
      { role: 'system', content: SUMMARY_SYSTEM },
      { role: 'user', content: userMsg },
    ], [], { maxTokens: 1024, thinkingDisabled: this.role.thinkingDisabled });
    if (!r.ok || !(r.content || '').trim()) {
      const n = (this.failStreak.get(scope) || 0) + 1;
      this.failStreak.set(scope, n);
      log('ob_summary_err', { scope, attempt: n, err: r.error || '空回复' });
      if (n >= 3) {
        // 连续 3 次失败：当日停该 scope + 告知主人（摘要器故障只对主人可见）
        this.failDay.set(scope, new Date().toISOString().slice(0, 10));
        this.notifyMaster(`⚠️ ${scope} 摘要器连续失败已当日停用（${r.error || '空回复'}）`).catch(() => {});
      }
      return false; // pending 不清零，下轮重试
    }
    this.failStreak.delete(scope);
    const upto = entries[entries.length - 1].ts;
    const out = r.content.trim();
    const splitAt = out.indexOf('信号：');
    const newSummary = splitAt > 0 ? out.slice(0, splitAt).trim() : out;
    const signals = splitAt > 0 ? out.slice(splitAt).split('\n').filter((l) => l.trim()).slice(0, 8) : [];
    this.store.markSummary(scope, newSummary, upto);
    log('ob_summary_run', { scope, pending: entries.length, chars: newSummary.length, ms: Date.now() - t0 });
    // digest 推送：有信号 + 过频闸
    if (signals.length) this._maybeDigest(scope, s, signals, newSummary);
    return true;
  }

  _stoppedToday(scope) {
    const day = this.failDay.get(scope);
    return !!day && day === new Date().toISOString().slice(0, 10);
  }

  _maybeDigest(scope, s, signals, newSummary) {
    const now = Date.now();
    const last = this.digestAt.get(scope) || 0;
    if (now - last < 2 * 3600_000) return; // 同 scope 2h 一次
    const bucket = Math.floor(now / 3600_000);
    if (this.digestHour.bucket !== bucket) { this.digestHour = { bucket, n: 0 }; }
    if (this.digestHour.n >= 6) return;    // 全局每小时 ≤6
    this.digestAt.set(scope, now);
    this.digestHour.n += 1;
    const name = s.scope.replace('group_', '群');
    const body = `📋 ${name}：\n${signals.join('\n')}`;
    this.notifyMaster(body).catch(() => {});
    log('ob_summary_digest', { scope, signals: signals.length });
  }

  /** L5 强制立即摘要（qq_summarize_now）。忽略 pending 阈值与当日停用（总控明示）。 */
  async force(scope) {
    this.failDay.delete(scope);
    this.failStreak.delete(scope);
    return this.run(scope);
  }

  close() { clearInterval(this.timer); }
}
