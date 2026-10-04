// gate.js — L1 门控：纯规则，不过模型，每条消息毫秒级出判决。
// 判决短路顺序/速率闸降级语义/总控恒过，见文件头设计注释与 README.md。
import { log } from '../../util.js';

const nowS = () => Date.now() / 1000;

export class Gate {
  /** @param cfg loadPluginConfig 产物
   *  @param store L0（读 scope.mode / trigger_words） */
  constructor(cfg, store) {
    this.cfg = cfg;
    this.store = store;
    this.rate = new Map(); // scope -> {lastTurnAt, hourBucket, hourlyCount}
  }

  decide(ev) {
    const drop = (reason, countToSummary = false) => ({ pass: false, silent: false, countToSummary, reason });
    // 1. 非 message 类
    if (ev.kind === 'message_sent') {
      if (ev.fromSelfDevice) {
        const selfId = Number(this.store.getState().self_id) || 0;
        // 自会话=总控台（master_qq=self_id 的部署形态，liveai「我的电脑」同款）：
        // 主人手机发自聊天 → 当作 master 输入开回合。插件自己发的回声已在
        // server 层 dedup，到这里的一定是主人亲手发的。
        if (selfId && ev.scope === 'private_' + selfId && Number(this.cfg.masterQq) === selfId) {
          return { pass: true, silent: false, countToSummary: false, reason: 'master_selfchat' };
        }
        // 自我会话（发给自己，非 master 形态）：连历史都不进（liveai 既有规矩）
        if (selfId && ev.scope === 'private_' + selfId) return drop('self_chat');
        // 本人其他设备：进上下文不触发（静默头守卫）
        return { pass: true, silent: true, countToSummary: false, reason: 'self_device' };
      }
      return drop('sent');
    }
    if (ev.kind !== 'message') return drop('non_message');
    // 主人私聊恒过（防总控失联——模式护栏只拦 qq_set_mode，这里再兜一层：
    // 哪怕 scope 被误设成 watch/off，主人的消息也必须到达 L5）
    if (ev.scope === 'private_' + this.cfg.masterQq) {
      return { pass: true, silent: false, countToSummary: false, reason: 'master' };
    }
    const s = this.store.getScope(ev.scope);
    if (!s) return drop('bad_scope');
    // 2. off 只 archive（ingest 已按模式处理 history；这里拒绝进管线）
    if (s.mode === 'off') return drop('off');
    // 3. watch：只看不回，全部计摘要
    if (s.mode === 'watch') return drop('no_trigger', true);
    // 4. auto
    if (s.type === 'private') {
      return { pass: true, silent: false, countToSummary: true, reason: 'private' };
    }
    const hitWord = (s.trigger_words || []).some((w) => w && ev.text.toLowerCase().includes(String(w).toLowerCase()));
    if (!ev.atMe && !hitWord) return drop('no_trigger', true);
    // 5. 量闸：不过闸降级 silent（消息仍进上下文，随下次正常 flush 带走）
    const r = this.rate.get(ev.scope) || { lastTurnAt: 0, hourBucket: 0, hourlyCount: 0 };
    const bucket = Math.floor(Date.now() / 3_600_000);
    if (r.hourBucket !== bucket) { r.hourBucket = bucket; r.hourlyCount = 0; }
    const tooSoon = this.cfg.scopeMinIntervalS > 0 && nowS() - r.lastTurnAt < this.cfg.scopeMinIntervalS;
    const overCap = r.hourlyCount >= this.cfg.scopeHourlyTurnCap;
    if (tooSoon || overCap) {
      log('ob_gate_cap', { scope: ev.scope, why: overCap ? 'cap' : 'rate' });
      return { pass: true, silent: true, countToSummary: true, reason: overCap ? 'cap' : 'rate' };
    }
    // 6. 通过：记 lastTurnAt 由 mailbox.flush 回填（flushTurned）
    return { pass: true, silent: false, countToSummary: true, reason: 'ok' };
  }

  /** mailbox flush 开出真回合时回填（gate 无需知道回合成功与否）。 */
  flushTurned(scope) {
    const r = this.rate.get(scope) || { lastTurnAt: 0, hourBucket: 0, hourlyCount: 0 };
    r.lastTurnAt = nowS();
    const bucket = Math.floor(Date.now() / 3_600_000);
    if (r.hourBucket !== bucket) { r.hourBucket = bucket; r.hourlyCount = 0; }
    r.hourlyCount += 1;
    this.rate.set(scope, r);
  }
}
