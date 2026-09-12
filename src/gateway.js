// cc-bridge (Node) — remote OpenClaw gateway connection manager.
// One shared GatewayClient per configured gateway (control-plane connection);
// events are fanned out to per-session handlers by sessionKey.
import { GatewayClient } from '@openclaw/gateway-client';
import { gatewayByName } from './config.js';
import { log } from './util.js';

const clients = new Map(); // name -> { client, ready, handlers:Set }

export async function getGateway(name) {
  const gw = gatewayByName(name);
  if (!gw) throw new Error('unknown gateway: ' + name);
  let entry = clients.get(name);
  if (!entry) {
    entry = { client: null, ready: null, handlers: new Set() };
    clients.set(name, entry);
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
        for (const h of entry.handlers) {
          try { h(ev); } catch (e) { log('gateway_event_err', { gateway: name, err: String(e) }); }
        }
      },
    });
    entry.client = client;
    client.start();
  }
  await entry.ready;
  return entry;
}

/** Subscribe to all events for a gateway; returns an unsubscribe fn. */
export function onGatewayEvent(name, fn) {
  const entry = clients.get(name);
  if (!entry) return () => {};
  entry.handlers.add(fn);
  return () => entry.handlers.delete(fn);
}
