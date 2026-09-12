// cc-bridge (Node) — 3-layer config: config.json ← channels.json ← secrets.json.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { BASE, loadJsonFile, writeJsonFile, log } from './util.js';

const CONFIG_PATH = path.join(BASE, 'config.json');
const SECRETS_PATH = path.join(BASE, 'secrets.json');
const CHANNELS_PATH = path.join(BASE, 'channels.json');
export const WORKSPACES = path.join(BASE, 'workspaces');

/** Normalize a user-typed base URL (full-width chars, stray punctuation, scheme). */
export function normalizeBaseUrl(raw) {
  let base = String(raw || '').trim();
  base = base.replace(/[．。.,;；，?？!！）)]+\s*$/, '').trim();
  base = base.replace(/：/g, ':').replace(/／/g, '/').replace(/．/g, '.').replace(/。/g, '.');
  base = base.replace(/\s+/g, '');
  if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
  return base.replace(/\/+$/, '');
}

export function isValidChannelName(name) {
  return /^[A-Za-z0-9_-]{1,32}$/.test(String(name || ''));
}

export function loadConfig() {
  const cfg = loadJsonFile(CONFIG_PATH, {});
  const secrets = loadJsonFile(SECRETS_PATH, {});
  const channels = loadJsonFile(CHANNELS_PATH, null);

  for (const key of ['token', 'one_time_tokens']) {
    if (secrets[key] !== undefined) cfg[key] = secrets[key];
  }

  if (channels !== null) {
    cfg.api_channels = channels.api_channels || [];
    if (channels.default_channel !== undefined) cfg.default_channel = channels.default_channel;
  }

  // channel api_key: inline > secrets.json api_keys[name] > env[api_key_env]
  const secretKeys = secrets.api_keys || {};
  for (const ch of cfg.api_channels || []) {
    if (!ch || typeof ch !== 'object') continue;
    if (ch.api_key) continue;
    const name = ch.name || '';
    if (secretKeys[name]) {
      ch.api_key = secretKeys[name];
      continue;
    }
    const envName = ch.api_key_env;
    if (envName && process.env[envName]) ch.api_key = process.env[envName];
  }
  return cfg;
}

// ---- mutable runtime store (persisted on channel changes) ----
const cfg = loadConfig();

export const CFG = cfg;
export const TOKEN = String(cfg.token || '');
export const ONE_TIME_TOKENS = new Set(cfg.one_time_tokens || []);
export const PORT = Number(cfg.port || 8642);
export const CLAUDE_BIN = cfg.claude_bin || '/usr/local/bin/claude';
export const CODEX_BIN = cfg.codex_bin || 'codex';
export const DEFAULT_BACKEND = cfg.default_backend === 'codex' ? 'codex' : 'claude';
export const MAX_ACTIVE = Number(cfg.max_active_sessions ?? 3);
export const QUEUE_MAX = Number(cfg.queue_max ?? 5);
export const TURN_TIMEOUT = Number(cfg.turn_timeout ?? 300);
export const ASK_TIMEOUT = Number(cfg.ask_timeout ?? 120);
export const MIN_TURN_INTERVAL = Number(cfg.min_turn_interval ?? 2);
export const IDLE_TIMEOUT = Number(cfg.idle_timeout_s ?? 1800);
export const ALLOWED_TOOLS = cfg.allowed_tools || 'Read,Grep,Glob,AskUserQuestion';
export const PERMISSION_MODE = cfg.permission_mode || 'default';
export const WEBUI_CFG = {
  enabled: (cfg.webui && cfg.webui.enabled) !== false,
  dir: (cfg.webui && cfg.webui.dir) || 'webui',
};

export let API_CHANNELS = Array.isArray(cfg.api_channels) ? cfg.api_channels : [];
// mutable default-channel holder (ESM import bindings are read-only; mutate state, not bindings)
export const channelState = { defaultChannel: cfg.default_channel || '' };
export function setDefaultChannel(name) {
  channelState.defaultChannel = name;
}

export function channelByName(name) {
  if (!name) return null;
  for (const ch of API_CHANNELS) {
    if (ch && typeof ch === 'object' && ch.name === name) return ch;
  }
  return null;
}

export function persistOneTimeTokens() {
  try {
    const c = loadJsonFile(SECRETS_PATH, {});
    c.one_time_tokens = [...ONE_TIME_TOKENS].sort();
    writeJsonFile(SECRETS_PATH, c, 0o600);
  } catch (e) {
    log('persist_otp_err', { err: String(e) });
  }
}

export function persistChannels() {
  try {
    const secretKeys = {};
    const channelsOut = [];
    for (const ch of API_CHANNELS) {
      if (!ch || typeof ch !== 'object') continue;
      const entry = { ...ch };
      delete entry.api_key;
      if (ch.api_key && !ch.api_key_env) secretKeys[ch.name || ''] = ch.api_key;
      channelsOut.push(entry);
    }
    const c = { api_channels: channelsOut, default_channel: channelState.defaultChannel };
    writeJsonFile(CHANNELS_PATH, c);
    const s = loadJsonFile(SECRETS_PATH, {});
    s.api_keys = secretKeys;
    writeJsonFile(SECRETS_PATH, s, 0o600);
    if (!fs.existsSync(SECRETS_PATH)) fs.chmodSync(SECRETS_PATH, 0o600);
  } catch (e) {
    log('persist_channels_err', { err: String(e) });
  }
}
