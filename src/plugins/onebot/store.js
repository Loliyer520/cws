// store.js — L0 数据层：state.json / archive jsonl / scopes 持久化与历史窗口。
// 设计（目录布局/scope 文件形状/写盘纪律/保留策略）见本文件原设计注释与 README.md。
import fs from 'node:fs';
import path from 'node:path';
import { loadJsonFile, writeJsonFile, log } from '../../util.js';

const nowS = () => Date.now() / 1000;
const ARCHIVE_ROTATE_BYTES = 32 * 1024 * 1024;

function emptyScope(scope) {
  const type = scope.startsWith('group_') ? 'group' : 'private';
  return {
    scope,
    type,
    mode: null, // null = 未定，ingest/set_mode 时按 cfg 默认落定
    trigger_words: [],
    history: [],
    summary: { text: '', upto_ts: 0, pending: 0 },
    stats: { received: 0, sent: 0, turns: 0, last_active: 0 },
    notes: '',
  };
}

export class Store {
  /** @param dir 数据根目录（BASE/data/onebot）
   *  @param defaults {groupMode, privateMode, historyWindow, historyEvictChunk} */
  constructor(dir, defaults) {
    this.dir = dir;
    this.defaults = defaults;
    this.meta = new Map();      // scope -> scope 文件对象（history 懒加载：init 只载元信息）
    this.dirty = new Set();     // 待落盘 scope（2s 防抖）
    this.chains = new Map();    // scope -> promise（同 scope 写串行）
    this.flushTimer = null;
    this.closed = false;
  }

  async init() {
    fs.mkdirSync(path.join(this.dir, 'scopes'), { recursive: true });
    fs.mkdirSync(path.join(this.dir, 'archive'), { recursive: true });
    this.state = loadJsonFile(path.join(this.dir, 'state.json'), {});
    let names = [];
    try {
      names = fs.readdirSync(path.join(this.dir, 'scopes')).filter((f) => f.endsWith('.json'));
    } catch { /* 首次启动无目录 */ }
    for (const f of names) {
      const s = loadJsonFile(path.join(this.dir, 'scopes', f), null);
      if (s && s.scope) this.meta.set(s.scope, s);
    }
    log('ob_store_init', { scopes: this.meta.size });
  }

  scopePath(scope) { return path.join(this.dir, 'scopes', scope + '.json'); }
  archivePath(scope) { return path.join(this.dir, 'archive', scope + '.jsonl'); }

  /** scope 元信息（不存在则按默认建空壳；mode 未定时落默认）。不落盘。 */
  getScope(scope) {
    if (!/^((group|private)_[1-9][0-9]{4,})$/.test(scope)) return null;
    let s = this.meta.get(scope);
    if (!s) {
      s = emptyScope(scope);
      this.meta.set(scope, s);
    }
    if (!s.mode) {
      s.mode = s.type === 'group' ? this.defaults.groupMode : this.defaults.privateMode;
    }
    return s;
  }

  /** 有 history 的完整加载（懒加载元信息时补读 history）。 */
  ensureLoaded(scope) {
    const s = this.getScope(scope);
    if (!s || s._loaded) return s;
    const full = loadJsonFile(this.scopePath(scope), s);
    if (full && Array.isArray(full.history)) Object.assign(s, full, { _loaded: true });
    else s._loaded = true;
    this.meta.set(scope, s);
    return s;
  }

  markDirty(scope) {
    if (this.closed) return;
    this.dirty.add(scope);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flushDirty().catch(() => {}); }, 2000);
      this.flushTimer.unref?.();
    }
  }

  /** 同 scope 一切写串行（写链保序，liveai 教训）。 */
  _chain(scope, job) {
    const prev = this.chains.get(scope) || Promise.resolve();
    const next = prev.then(job, job);
    this.chains.set(scope, next.catch(() => {}));
    return next;
  }

  async flushDirty() {
    const scopes = [...this.dirty];
    this.dirty.clear();
    await Promise.all(scopes.map((scope) => this._chain(scope, () => this._writeScope(scope))));
  }

  _writeScope(scope) {
    const s = this.meta.get(scope);
    if (!s) return;
    const out = { ...s };
    delete out._loaded;
    try {
      writeJsonFile(this.scopePath(scope), out);
    } catch (e) {
      log('ob_scope_write_err', { scope, err: String(e) });
    }
  }

  /** L0 主入口：archive 追加 + 按模式决定是否入 history。所有模式都过这里。 */
  ingest(ev) {
    // archive 永记（排障唯一入口）；正文进数据文件但不进 stdout 日志
    this._chain('_archive:' + (ev.scope || '_'), () => this._appendArchive(ev)).catch(() => {});
    if (!ev.scope || (ev.kind !== 'message' && ev.kind !== 'message_sent')) return;
    const s = this.ensureLoaded(ev.scope);
    if (!s) return;
    if (s.mode === 'off') return; // off 只 archive
    const role = ev.kind === 'message_sent' ? (ev.fromSelfDevice ? 'self_device' : 'self') : 'user';
    s.history.push({
      ts: ev.ts, role,
      user_id: ev.userId || 0, nickname: ev.nickname || '',
      text: ev.text || '', msg_id: ev.msgId || 0,
    });
    this._evict(s);
    s.stats.received += 1;
    s.stats.last_active = ev.ts;
    this.markDirty(ev.scope);
  }

  _evict(s) {
    const over = s.history.length - this.defaults.historyWindow;
    if (over > 0) s.history.splice(0, Math.max(this.defaults.historyEvictChunk, over));
  }

  async _appendArchive(ev) {
    const rec = {
      ts: ev.ts, dir: ev.kind === 'message_sent' ? 'out' : 'in',
      kind: ev.kind, scope: ev.scope || '', user_id: ev.userId || 0,
      nickname: ev.nickname || '', chars: (ev.text || '').length, msg_id: ev.msgId || 0,
      at_me: !!ev.atMe, silent: !!ev.fromSelfDevice,
      text: ev.text || '',
    };
    const p = this.archivePath(ev.scope || '_meta');
    try {
      // 32MB 滚档：当前 → .1，旧 .1 → .2，最老 .2 丢弃（共留 3 代）
      try {
        const st = fs.statSync(p);
        if (st.size > ARCHIVE_ROTATE_BYTES) {
          const p1 = p.replace(/\.jsonl$/, '.1.jsonl');
          const p2 = p.replace(/\.jsonl$/, '.2.jsonl');
          if (fs.existsSync(p2)) fs.rmSync(p2, { force: true });
          if (fs.existsSync(p1)) fs.renameSync(p1, p2);
          fs.renameSync(p, p1);
        }
      } catch { /* 无文件 */ }
      fs.appendFileSync(p, JSON.stringify(rec) + '\n');
    } catch (e) {
      log('ob_archive_err', { scope: ev.scope || '_', err: String(e) });
    }
  }

  foldSilent(scope) {
    const s = this.getScope(scope);
    if (s) { s.stats.last_active = nowS(); this.markDirty(scope); }
  }

  getHistory(scope, n = 20) {
    const s = this.ensureLoaded(scope);
    if (!s) return [];
    return s.history.slice(-Math.max(1, Math.min(100, n)));
  }

  /** 摘要器用：upto_ts 之后的消息转写行。 */
  historySince(scope, uptoTs) {
    const s = this.ensureLoaded(scope);
    if (!s) return [];
    return s.history.filter((h) => h.ts > uptoTs);
  }

  /** 插件成功发出后登记 role=self（历史即含自己的话，模型下轮能看到）。 */
  appendSent(scope, text, msgId = 0) {
    const s = this.ensureLoaded(scope);
    if (!s) return;
    s.history.push({ ts: nowS(), role: 'self', user_id: 0, nickname: '', text, msg_id: msgId });
    this._evict(s);
    s.stats.sent += 1;
    s.stats.last_active = nowS();
    this.markDirty(scope);
  }

  getScopeInfo(scope) {
    const s = this.getScope(scope);
    if (!s) return null;
    return {
      scope: s.scope, type: s.type, mode: s.mode,
      trigger_words: s.trigger_words, notes: s.notes,
      history_len: s.history.length, window: this.defaults.historyWindow,
      summary_chars: (s.summary.text || '').length,
      summary_upto: s.summary.upto_ts, pending: s.summary.pending || 0,
      stats: s.stats,
    };
  }

  listScopes() {
    return [...this.meta.keys()].map((sc) => this.getScopeInfo(sc)).filter(Boolean);
  }

  saveScope(scope, patch) {
    const s = this.getScope(scope);
    if (!s) return null;
    Object.assign(s, patch);
    // mode/trigger_words/notes 属立即落盘项（防抖会丢用户刚下的指令）
    this._chain(scope, () => this._writeScope(scope)).catch(() => {});
    return s;
  }

  /** L4 写回：滚动摘要替换 + pending 清零（按 upto_ts 之前的计数）。 */
  markSummary(scope, text, uptoTs) {
    const s = this.ensureLoaded(scope);
    if (!s) return;
    s.summary.text = String(text || '');
    s.summary.upto_ts = uptoTs;
    s.summary.pending = this.historySince(scope, uptoTs).length;
    this.markDirty(scope);
  }

  bumpPending(scope, n = 1) {
    const s = this.getScope(scope);
    if (!s) return;
    s.summary.pending = (s.summary.pending || 0) + n;
    this.markDirty(scope);
  }

  updateState(patch) {
    this.state = { ...(this.state || {}), ...patch };
    try { writeJsonFile(path.join(this.dir, 'state.json'), this.state); } catch { /* 尽力而为 */ }
  }

  getState() { return { ...(this.state || {}) }; }

  async flushAll() {
    this.closed = true;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    await this.flushDirty();
  }
}
