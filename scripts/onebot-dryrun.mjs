// onebot 生产配置干跑：用真实 config.json+secrets.json 的合并形状走 init→shutdown，
// 验证装载链路（渠道校验/目录创建/端点注册），不连真 NapCat、不碰桥进程。
// 用法：node scripts/onebot-dryrun.mjs
import fs from 'node:fs';
import path from 'node:path';
import { BASE } from '../src/util.js';
import { loadPluginConfig } from '../src/plugins/onebot/config.js';
import { init, shutdown } from '../src/plugins/onebot/index.js';

const j = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const cfgFile = j(path.join(BASE, 'config.json'));
const secrets = j(path.join(BASE, 'secrets.json'));
const merged = {
  ...(cfgFile.plugins?.onebot || {}),
  ...(secrets.plugins?.onebot || {}),
};
const cfg = loadPluginConfig(merged); // 抛错即配置不合法，插件上线也会装载失败
let registered = null;
const kaxiTools = [];
await init({
  cfg: merged,
  registerUpgrade: (prefix, handler) => { registered = { prefix, handler }; },
  registerKaxiTool: (def, fn) => { kaxiTools.push(def.name); return true; },
  callLLM: async () => ({ ok: false, error: 'dryrun' }),
  kxTurn: async () => ({ ok: false, error: 'dryrun' }),
  kaxiSystemPrompt: (x) => x, kaxiTools: [], kaxiExec: async () => ({ ok: true }),
});
if (!registered || registered.prefix !== '/onebot/') throw new Error('端点未注册');
console.log('DRYRUN_OK', JSON.stringify({
  master: cfg.masterQq,
  group_mode: cfg.defaultGroupMode, private_mode: cfg.defaultPrivateMode,
  roles: {
    scope_agent: cfg.roles.scopeAgent.channel + '/' + cfg.roles.scopeAgent.model,
    summary: cfg.roles.summary.channel + '/' + cfg.roles.summary.model,
    kaxi: cfg.roles.kaxi.channel || '(桥默认)',
  },
  data_dir: cfg.dataDir || 'BASE/data/onebot',
  token_tail: cfg.token.slice(-4),
  kaxi_tools: kaxiTools,
}));
await shutdown();
