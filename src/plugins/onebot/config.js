// onebot 插件配置视图 — 默认值、校验、角色→渠道/模型解析。
// 设计见同目录 README.md；配置示例在文件尾注释。
import { channelByName } from '../../config.js';

const MODES = ['off', 'watch', 'auto'];
const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * 规整并校验合并后的插件配置（config.json + secrets.json 的 plugins.onebot）。
 * 校验失败抛错 → init 中止，插件不装载（宁可不跑不可错跑）。
 */
export function loadPluginConfig(raw = {}) {
  const masterQq = Number(raw.master_qq);
  if (!Number.isInteger(masterQq) || masterQq <= 10000) {
    throw new Error('onebot: master_qq 必须是真实 QQ 号（config.json plugins.onebot.master_qq）');
  }
  const token = String(raw.token || '').trim();
  if (!token) {
    throw new Error('onebot: token 必填（secrets.json plugins.onebot.token，NapCat accessToken）');
  }
  const mode = (v, dflt) => (MODES.includes(v) ? v : dflt);
  const role = (r = {}) => {
    const out = {
      channel: r.channel ? String(r.channel) : '',
      model: r.model ? String(r.model) : '',
      thinking_disabled: r.thinking_disabled === true,
    };
    if (out.channel && !channelByName(out.channel)) {
      throw new Error(`onebot: roles 渠道 ${out.channel} 不在 channels.json 里`);
    }
    return out;
  };
  return {
    token,
    masterQq,
    dataDir: raw.data_dir ? String(raw.data_dir) : '', // 测试/多实例注入；缺省 BASE/data/onebot
    defaultGroupMode: mode(raw.default_group_mode, 'watch'),
    defaultPrivateMode: mode(raw.default_private_mode, 'auto'),
    roles: {
      scopeAgent: role(raw.roles && raw.roles.scope_agent),
      summary: role(raw.roles && raw.roles.summary),
      kaxi: role(raw.roles && raw.roles.kaxi),
    },
    debounceMs: clamp(raw.debounce_ms, 3000, 60_000, 8000),
    debounceMaxMs: clamp(raw.debounce_max_ms, 10_000, 300_000, 30_000),
    burstFlush: clamp(raw.burst_flush, 3, 50, 12),
    historyWindow: clamp(raw.history_window, 20, 500, 100),
    historyEvictChunk: clamp(raw.history_evict_chunk, 5, 200, 20),
    summaryEveryMsgs: clamp(raw.summary_every_msgs, 10, 1000, 80),
    summaryEveryMs: clamp(raw.summary_every_ms, 300_000, 86_400_000, 1_800_000),
    scopeMinIntervalS: clamp(raw.scope_min_interval_s, 0, 600, 10),
    scopeHourlyTurnCap: clamp(raw.scope_hourly_turn_cap, 1, 1000, 60),
    escalateHourlyCap: clamp(raw.escalate_hourly_cap, 1, 100, 10),
  };
}

/**
 * 角色名 → callLLM/kxTurn 入参。
 * scopeAgent/summary 带 thinking_disabled 透传；kaxi 空配置 = 桥默认渠道。
 */
export function roleCallOpts(cfg, roleName) {
  const r = cfg.roles[roleName] || {};
  return { channel: r.channel || null, model: r.model || null, thinkingDisabled: r.thinking_disabled === true };
}

// 完整配置示例——config.json 侧：
//   "plugins": {
//     "onebot": {
//       "enabled": true,
//       "master_qq": 241898129,
//       "default_group_mode": "watch",
//       "default_private_mode": "auto",
//       "roles": {
//         "scope_agent": { "channel": "ds", "model": "DeepSeek-V4-Flash-0731", "thinking_disabled": true },
//         "summary":     { "channel": "ds", "model": "DeepSeek-V4-Flash-0731", "thinking_disabled": true },
//         "kaxi":        {}
//       }
//     }
//   }
// secrets.json 侧：
//   "plugins": { "onebot": { "token": "<NapCat accessToken>" } }
// 数值字段（debounce_ms/history_window/…）见 loadPluginConfig 的 clamp 默认值。
