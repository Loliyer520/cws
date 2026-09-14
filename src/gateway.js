// cc-bridge (Node) — remote OpenClaw gateway connection manager.
// One shared GatewayClient per configured gateway (control-plane connection);
// events are fanned out to per-session handlers by sessionKey.
// 多网关管理（2026-09-14）：
//  - 事件 handler 存独立注册表（按网关名），与连接生命周期解耦：客户端重建后自动接上
//  - getGateway 校验配置指纹（url+token）：改配置即弃旧连接重连，不必重启桥
//  - 连接失败即清缓存条目（旧实现 rejected promise 被永久缓存，失败一次该网关
//    就毒死到重启）；下次 getGateway 全新重试
//  - dropGateway()：backends.save 删除网关时主动停连
import { GatewayClient } from '@openclaw/gateway-client';
import { gatewayByName } from './config.js';
import { log } from './util.js';

const clients = new Map(); // name -> { client, ready, fp }
const handlers = new Map(); // name -> Set(fn)，与客户端生命周期解耦

function handlerSet(name) {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  return set;
}

/** Stop and forget a gateway's live connection (session close 会自行退订 handler). */
export function dropGateway(name) {
  const entry = clients.get(name);
  if (!entry) return;
  clients.delete(name);
  try {
    entry.client.stop();
  } catch (e) {
    log('gateway_stop_err', { gateway: name, err: String(e) });
  }
}

export async function getGateway(name) {
  const gw = gatewayByName(name);
  if (!gw) {
    dropGateway(name); // 配置已删但连接还挂着：顺手停掉
    throw new Error('unknown gateway: ' + name);
  }
  const fp = String(gw.url || '') + '\n' + String(gw.token || '');
  let entry = clients.get(name);
  if (entry && entry.fp !== fp) {
    log('gateway_reconfig', { gateway: name });
    dropGateway(name); // 旧连接作废；handler 在外部注册表，新连接自动接上
    entry = null;
  }
  if (!entry) {
    entry = { client: null, ready: null, fp };
    let resolveReady;
    let rejectReady;
    entry.ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    const client = new GatewayClient({
      url: gw.url,
      token: gw.token,
      minProtocol: 4,
      maxProtocol: 4,
      onHelloOk: () => {
        log('gateway_connected', { gateway: name, url: gw.url });
        resolveReady();
      },
      onConnectError: (err) => {
        log('gateway_connect_err', { gateway: name, err: String(err) });
        rejectReady(err instanceof Error ? err : new Error(String(err)));
      },
      onEvent: (ev) => {
        if (clients.get(name) !== entry) return; // 已重建/已停掉的旧连接：事件作废
        for (const h of handlerSet(name)) {
          try { h(ev); } catch (e) { log('gateway_event_err', { gateway: name, err: String(e) }); }
        }
      },
    });
    entry.client = client;
    clients.set(name, entry);
    client.start();
  }
  try {
    await entry.ready;
  } catch (e) {
    // 失败即弃缓存：下次 getGateway 重试全新连接
    if (clients.get(name) === entry) clients.delete(name);
    throw e;
  }
  return entry;
}

/** Subscribe to all events for a gateway; returns an unsubscribe fn. */
export function onGatewayEvent(name, fn) {
  const set = handlerSet(name);
  set.add(fn);
  return () => set.delete(fn);
}
