// mailbox.js — L2 攒批：每 scope 一个邮箱，防抖窗合并连发，整批 flush 成一个回合。
// 防抖/上限/burst 强发/静默批次规则见文件头设计注释与 README.md。
import { log } from '../../util.js';

export class Mailbox {
  /** @param cfg loadPluginConfig 产物（debounce 三参数）
   *  @param onFlush (scope, batch, batchSilent) => Promise<void>，index.js 装配 */
  constructor(cfg, onFlush) {
    this.cfg = cfg;
    this.onFlush = onFlush;
    this.boxes = new Map(); // scope -> {items, silent, debounceTimer, maxTimer, firstAt, flushing}
  }

  push(scope, ev, silent) {
    let b = this.boxes.get(scope);
    if (!b) {
      b = { items: [], silent: false, debounceTimer: null, maxTimer: null, firstAt: 0, flushing: false };
      this.boxes.set(scope, b);
    }
    b.items.push(ev);
    if (b.items.length === 1) {
      // 首条定基调；后续任一非 silent 即整批非静默（混批按正常回合处理）
      b.silent = !!silent;
      b.firstAt = Date.now();
      b.maxTimer = setTimeout(() => this.flush(scope), this.cfg.debounceMaxMs);
      b.maxTimer.unref?.();
    } else if (!silent) {
      b.silent = false;
    }
    if (b.debounceTimer) clearTimeout(b.debounceTimer);
    if (b.items.length >= this.cfg.burstFlush) {
      this.flush(scope);
      return;
    }
    b.debounceTimer = setTimeout(() => this.flush(scope), this.cfg.debounceMs);
    b.debounceTimer.unref?.();
  }

  flush(scope) {
    const b = this.boxes.get(scope);
    if (!b || b.flushing || !b.items.length) return;
    b.flushing = true;
    if (b.debounceTimer) { clearTimeout(b.debounceTimer); b.debounceTimer = null; }
    if (b.maxTimer) { clearTimeout(b.maxTimer); b.maxTimer = null; }
    const items = b.items;
    const silent = b.silent;
    b.items = [];
    b.silent = false;
    const waited = Date.now() - b.firstAt;
    Promise.resolve()
      .then(() => this.onFlush(scope, items, silent))
      .catch((e) => log('ob_mailbox_flush_err', { scope, err: String(e) }))
      .finally(() => {
        b.flushing = false;
        // flush 期间又来的消息（新 debounceTimer 已在 push 时排上）自然走下一轮
      });
    log('ob_mailbox_flush', { scope, n: items.length, silent, waited_ms: waited });
  }

  flushAll() {
    for (const scope of [...this.boxes.keys()]) {
      const b = this.boxes.get(scope);
      if (b && b.items.length && !b.flushing) this.flush(scope);
    }
  }

  async close() {
    for (const b of this.boxes.values()) {
      if (b.debounceTimer) clearTimeout(b.debounceTimer);
      if (b.maxTimer) clearTimeout(b.maxTimer);
    }
    // shutdown 不开回合：pending 批次按设计标注丢弃（archive 已有原文）
    this.boxes.clear();
  }
}
