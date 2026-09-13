// cc-bridge (Node) — shared utilities.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function now() {
  return Date.now() / 1000;
}

/** Structured JSON log line (no tokens, no message bodies). */
export function log(ev, fields = {}) {
  const line = { ts: new Date().toISOString(), ev, ...fields };
  try {
    process.stdout.write(JSON.stringify(line, jsonReplacer) + '\n');
  } catch {
    /* never let logging kill the bridge */
  }
}

function jsonReplacer(_k, v) {
  if (typeof v === 'bigint') return Number(v);
  return v;
}

/** Compact human-safe summary of a tool input object. */
export function briefOf(inputObj, limit = 80) {
  let s;
  try {
    s = JSON.stringify(inputObj);
  } catch {
    s = String(inputObj);
  }
  s = s ?? '';
  return s.length <= limit ? s : s.slice(0, limit) + '…';
}

/** External session ids: 1..64 chars of [A-Za-z0-9_-]. */
export function isValidSid(sid) {
  return typeof sid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(sid);
}

/** uuid5 (deterministic) — CLI requires a real UUID for session ids.
 * namespace must be a UUID (hex with dashes); hashed as 16 raw bytes so the
 * derivation matches Python's uuid.uuid5 — v1 bridges used NAMESPACE_URL with
 * the "cc-bridge:" name prefix, and --resume continuity depends on byte equality. */
export const UUID_NAMESPACE_URL = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
/** 与 v1 bridge.py 的 uuid.uuid5(uuid.NAMESPACE_URL, 'cc-bridge:'+sid) 保持字节一致。 */
export function uuid5(namespace, name) {
  const ns = Buffer.from((namespace || UUID_NAMESPACE_URL).replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(ns).update(Buffer.from(name, 'utf8')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC4122 variant
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function loadJsonFile(pathStr, fallback) {
  try {
    return JSON.parse(fs.readFileSync(pathStr, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic-ish write: tmp file + rename; chmod 600 for secrets. */
export function writeJsonFile(pathStr, value, mode = null) {
  const tmp = pathStr + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  if (mode !== null) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, pathStr);
}

export function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

/** Constant-time token compare. */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // still burn comparable time on length mismatch
    crypto.timingSafeEqual(ba, ba);
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

/** Spawn CLI with a fresh process group so stop kills only it. */
export function spawnDetached(cmd, args, opts = {}) {
  return spawn(cmd, args, { ...opts, detached: true });
}

/** True when the child process is genuinely running (not yet exited, not signal-killed). */
export function procAlive(proc) {
  return !!(proc && proc.exitCode === null && proc.signalCode === null);
}

export function killProcGroup(proc) {
  if (proc && proc.pid && proc.exitCode === null && proc.signalCode === null) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function killProcGroupForce(proc) {
  if (proc && proc.pid && proc.exitCode === null && proc.signalCode === null) {
    try {
      process.kill(-proc.pid, 'SIGKILL');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function waitProc(proc, timeoutMs = 5000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const done = new Promise((res) => {
    proc.once('exit', res);
  });
  let timer;
  const timeout = new Promise((res) => {
    timer = setTimeout(res, timeoutMs);
  });
  await Promise.race([done, timeout]);
  clearTimeout(timer);
}
