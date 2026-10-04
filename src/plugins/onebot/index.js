// onebot 插件入口 — 组装端点与多级 agent 管线（L0-L5）。
// 接线顺序/命令清单/关停顺序的完整设计见同目录 README.md。
import path from 'node:path';
import { BASE, log } from '../../util.js';
import { loadPluginConfig, roleCallOpts } from './config.js';
import { Store } from './store.js';
import { OnebotServer } from './server.js';
import { Gate } from './gate.js';
import { Mailbox } from './mailbox.js';
import { ScopeAgent } from './agent.js';
import { Summarizer } from './summary.js';
import { Overseer, QQ_TOOLS } from './overseer.js';
import { buildSendSegments } from './protocol.js';

// 插件命令 ctx 不含内部对象——走模块级单例，init 时赋值，命令闭包引用
let rt = null; // runtime: { cfg, store, endpoint, gate, mailbox, agent, summary, overseer }

export const commands = {
  'onebot.status': async (ctx, params, echo) => {
    if (!rt) return ctx.reply({ post_type: 'error', code: 'onebot_down', message: '插件未就绪', echo });
    const scopes = rt.store.listScopes();
    const agg = scopes.reduce((a, s) => ({
      received: a.received + (s.stats.received || 0),
      sent: a.sent + (s.stats.sent || 0),
      turns: a.turns + (s.stats.turns || 0),
    }), { received: 0, sent: 0, turns: 0 });
    ctx.reply({
      post_type: 'onebot_status', ok: true, conn: rt.endpoint.status(),
      scopes: scopes.length,
      totals: agg,
      modes: scopes.reduce((m, s) => { m[s.mode] = (m[s.mode] || 0) + 1; return m; }, {}),
      master_scope: rt.overseer.masterScope,
      echo,
    });
  },

  'onebot.scopes': async (ctx, params, echo) => {
    if (!rt) return ctx.reply({ post_type: 'error', code: 'onebot_down', message: '插件未就绪', echo });
    ctx.reply({ post_type: 'onebot_scopes', ok: true, scopes: rt.store.listScopes(), echo });
  },

  'onebot.set_mode': async (ctx, params, echo) => {
    if (!rt) return ctx.reply({ post_type: 'error', code: 'onebot_down', message: '插件未就绪', echo });
    const scope = String(params.scope || '');
    const mode = String(params.mode || '');
    if (!/^((group|private)_[1-9][0-9]{4,})$/.test(scope)) {
      return ctx.reply({ post_type: 'error', code: 'bad_scope', scope, echo });
    }
    if (!['off', 'watch', 'auto'].includes(mode)) {
      return ctx.reply({ post_type: 'error', code: 'bad_mode', mode, echo });
    }
    if (scope === rt.overseer.masterScope && mode === 'off') {
      return ctx.reply({ post_type: 'error', code: 'master_protected', message: '主人私聊禁止 off', echo });
    }
    rt.store.saveScope(scope, { mode });
    log('ob_mode_set', { scope, mode, by: 'ws' });
    ctx.reply({ post_type: 'onebot_mode', ok: true, scope, mode, echo });
  },

  'onebot.read': async (ctx, params, echo) => {
    if (!rt) return ctx.reply({ post_type: 'error', code: 'onebot_down', message: '插件未就绪', echo });
    const scope = String(params.scope || '');
    if (!/^((group|private)_[1-9][0-9]{4,})$/.test(scope)) {
      return ctx.reply({ post_type: 'error', code: 'bad_scope', scope, echo });
    }
    const n = Math.max(1, Math.min(100, Number(params.n) || 20));
    ctx.reply({
      post_type: 'onebot_read', ok: true, scope,
      summary: rt.store.getScope(scope)?.summary?.text || '',
      messages: rt.store.getHistory(scope, n),
      echo,
    });
  },

  'onebot.send': async (ctx, params, echo) => {
    if (!rt) return ctx.reply({ post_type: 'error', code: 'onebot_down', message: '插件未就绪', echo });
    const scope = String(params.scope || '');
    const text = String(params.text || '').trim();
    if (!/^((group|private)_[1-9][0-9]{4,})$/.test(scope)) {
      return ctx.reply({ post_type: 'error', code: 'bad_scope', scope, echo });
    }
    if (scope === rt.overseer.masterScope) {
      return ctx.reply({ post_type: 'error', code: 'self_send', message: '不能代发给自己', echo });
    }
    if (!text) return ctx.reply({ post_type: 'error', code: 'empty_text', echo });
    if (!rt.endpoint.online) return ctx.reply({ post_type: 'error', code: 'ob_offline', message: 'NapCat 未连接', echo });
    rt.endpoint.markSelfSent(scope, text);
    try {
      const msgId = await rt.endpoint.sendToScope(scope, buildSendSegments({ text }));
      rt.store.appendSent(scope, text, msgId);
      ctx.reply({ post_type: 'onebot_sent', ok: true, scope, message_id: msgId, echo });
    } catch (e) {
      rt.endpoint.unmarkSelfSent(scope, text);
      ctx.reply({ post_type: 'error', code: 'send_failed', message: String(e.message || e).slice(0, 160), echo });
    }
  },
};

export async function init(pluginCtx) {
  const cfg = loadPluginConfig(pluginCtx.cfg);
  const store = new Store(cfg.dataDir || path.join(BASE, 'data', 'onebot'), {
    groupMode: cfg.defaultGroupMode,
    privateMode: cfg.defaultPrivateMode,
    historyWindow: cfg.historyWindow,
    historyEvictChunk: cfg.historyEvictChunk,
  });
  await store.init();

  const endpoint = new OnebotServer(cfg, store);
  pluginCtx.registerUpgrade('/onebot/', (req, socket, head) => endpoint.handleUpgrade(req, socket, head));

  const gate = new Gate(cfg, store);
  const overseer = new Overseer(cfg, store, endpoint, {
    kxTurn: pluginCtx.kxTurn,
    kaxiSystemPrompt: pluginCtx.kaxiSystemPrompt,
    kaxiTools: pluginCtx.kaxiTools,
    kaxiExec: pluginCtx.kaxiExec,
  }, gate);
  const agent = new ScopeAgent(cfg, store, endpoint, pluginCtx.callLLM,
    (from, reason, brief) => overseer.escalate(from, reason, brief),
    roleCallOpts(cfg, 'scopeAgent'));
  const summary = new Summarizer(cfg, store, endpoint, pluginCtx.callLLM,
    roleCallOpts(cfg, 'summary'),
    (text) => overseer.notifyMaster(text));
  overseer.summaryRef = summary;

  // QQ 工具同时注册进桥卡西的工具表（app/手表端 kx.chat 与 QQ 端 L5 同一份
  // 执行器）——两端卡西都能管机器人，不再各说各话
  if (pluginCtx.registerKaxiTool) {
    for (const def of QQ_TOOLS) {
      pluginCtx.registerKaxiTool(def, (name, a) => overseer._execQqTool(name, a));
    }
  }

  // 管线接线：L0 收纳 → L1 门控 → L2 攒批 → 分发（master→L5，其余→L3，静默→折叠）
  endpoint.onEvent = (ev) => {
    store.ingest(ev); // L0：archive + 历史窗口（off 只 archive；ingest 内读模式）
    const v = gate.decide(ev); // L1
    if (!v.pass) {
      if (v.countToSummary && (ev.kind === 'message')) summary.feed(ev); // watch 群/auto 未触发 → L4
      if (v.reason !== 'non_message' && v.reason !== 'off') {
        log('ob_gate', { scope: ev.scope, reason: v.reason });
      }
      return;
    }
    if (v.silent) {
      // 静默批次：本人其他设备消息——上下文已入档，不跑模型
      rt.mailbox.push(ev.scope, ev, true);
      return;
    }
    rt.mailbox.push(ev.scope, ev, false); // L2
  };

  const mailbox = new Mailbox(cfg, (scope, batch, silent) => {
    if (silent) { store.foldSilent(scope); return; }
    gate.flushTurned(scope);
    const s = store.getScope(scope);
    if (s && s.scope === overseer.masterScope) overseer.turn(scope, batch); // L5
    else if (s && s.mode === 'auto') agent.turn(scope, batch); // L3（watch 在 gate 已拦，双保险）
  });

  rt = { cfg, store, endpoint, gate, mailbox, agent, summary, overseer };
  log('onebot_init', { master: cfg.masterQq, group_mode: cfg.defaultGroupMode, private_mode: cfg.defaultPrivateMode });
}

export async function shutdown() {
  if (!rt) return;
  try { rt.mailbox.close(); } catch { /* ignore */ }   // pending 批次不开回合
  try { rt.summary.close(); } catch { /* ignore */ }
  try { rt.overseer.close(); } catch { /* ignore */ }
  try { await rt.endpoint.close(); } catch { /* ignore */ } // 1001 going away
  try { await rt.store.flushAll(); } catch { /* ignore */ } // 写链全部落盘
  rt = null;
  log('onebot_shutdown', {});
}
