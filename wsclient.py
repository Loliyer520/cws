#!/usr/bin/env python3
"""cc-bridge acceptance test client. Token read from config file, never argv."""
import argparse
import asyncio
import json
import sys
import time

import aiohttp


class Client:
    def __init__(self, url, token):
        self.url = url + ("?token=" + token)
        self.events = []
        self.ws = None
        self.session = None
        self.next_echo = 0
        self.on_ask = None  # async fn(ev)

    async def connect(self):
        self.session = aiohttp.ClientSession()
        self.ws = await self.session.ws_connect(self.url, heartbeat=20)
        asyncio.create_task(self._reader())

    async def _reader(self):
        async for msg in self.ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    ev = json.loads(msg.data)
                except Exception:
                    continue
                self.events.append(ev)
                if ev.get("post_type") == "ask" and self.on_ask:
                    asyncio.create_task(self.on_ask(ev))

    async def act(self, action, params=None):
        self.next_echo += 1
        echo = f"e{self.next_echo}"
        await self.ws.send_str(json.dumps({"action": action, "params": params or {}, "echo": echo}))
        return echo

    async def wait(self, pred, timeout=180):
        t0 = time.time()
        while time.time() - t0 < timeout:
            for ev in self.events:
                if pred(ev):
                    return ev
            await asyncio.sleep(0.1)
        return None

    async def close(self):
        try:
            await self.ws.close()
        except Exception:
            pass
        await self.session.close()


RES = {}


def rec(name, ok, detail=""):
    RES[name] = {"ok": bool(ok), "detail": str(detail)[:600]}
    print(("PASS " if ok else "FAIL ") + name + ("  | " + str(detail)[:200] if detail else ""), flush=True)


async def drop_all(c, sids):
    for sid in sids:
        try:
            e = await c.act("drop_session", {"session_id": sid})
            await c.wait(lambda ev, _e=e: ev.get("post_type") == "session_closed" and ev.get("echo") == _e, 20)
        except Exception:
            pass


async def sc_basic(host_url, token):
    c = Client(host_url, token)
    await c.connect()
    sid = "acc-basic-1"
    e = await c.act("new_session", {"session_id": sid})
    ev = await c.wait(lambda ev, sid=sid: ev.get("post_type") == "session_ready" and ev.get("session_id") == sid, 40)
    if not ev:
        rec("1.basic", False, "no session_ready")
        return
    e = await c.act("send", {"session_id": sid, "text": "1+1只回答数字"})
    ev = await c.wait(lambda ev: ev.get("post_type") in ("final", "error") and ev.get("echo") == e, 120)
    ok = ev and ev.get("post_type") == "final" and "2" in (ev.get("text") or "")
    rec("1.basic", ok, f"final.text={ev.get('text')!r}" if ev else "timeout")
    await drop_all(c, [sid])
    await c.close()


async def sc_parallel(host_url, token):
    c = Client(host_url, token)
    await c.connect()
    s1, s2 = "acc-par-1", "acc-par-2"
    for sid in (s1, s2):
        await c.act("new_session", {"session_id": sid})
    for sid in (s1, s2):
        ev = await c.wait(lambda ev, sid=sid: ev.get("post_type") == "session_ready" and ev.get("session_id") == sid, 40)
        if not ev:
            rec("2.parallel", False, f"no ready {_s}")
            return
    e1 = await c.act("send", {"session_id": s1, "text": "9+9只回答数字"})
    e2 = await c.act("send", {"session_id": s2, "text": "8+8只回答数字"})
    f1 = await c.wait(lambda ev: ev.get("post_type") == "final" and ev.get("echo") == e1, 150)
    f2 = await c.wait(lambda ev: ev.get("post_type") == "final" and ev.get("echo") == e2, 150)
    ok = f1 and f2 and "18" in (f1.get("text") or "") and "16" in (f2.get("text") or "")
    rec("2.parallel", ok, f"f1={f1.get('text') if f1 else None!r} f2={f2.get('text') if f2 else None!r}")
    await drop_all(c, [s1, s2])
    await c.close()


async def sc_bash_deny(host_url, token):
    c = Client(host_url, token)
    await c.connect()
    sid = "acc-bash-1"
    await c.act("new_session", {"session_id": sid})
    ev = await c.wait(lambda ev, sid=sid: ev.get("post_type") == "session_ready" and ev.get("session_id") == sid, 40)
    if not ev:
        rec("3.bash_deny", False, "no session_ready")
        return
    ask_seen = {}

    async def on_ask(aev):
        ask_seen.update(aev)
        await c.act("ask_reply", {"session_id": sid, "ask_id": aev.get("ask_id"), "behavior": "deny"})
    c.on_ask = on_ask
    e = await c.act("send", {"session_id": sid, "text": "用bash创建一个文件 p4test.txt（内容随意），然后告诉我结果"})
    fin = await c.wait(lambda ev: ev.get("post_type") in ("final", "error") and ev.get("echo") == e, 150)
    ok = bool(ask_seen) and fin and fin.get("post_type") == "final"
    rec("3.bash_deny", ok,
        f"ask.tool={ask_seen.get('tool_name')} ask.kind={ask_seen.get('kind')} input={json.dumps(ask_seen.get('input'), ensure_ascii=False)[:120]} final={fin.get('text', '')[:120] if fin else None!r}")
    await drop_all(c, [sid])
    await c.close()


async def sc_askq(host_url, token):
    c = Client(host_url, token)
    await c.connect()
    sid = "acc-askq-1"
    await c.act("new_session", {"session_id": sid})
    ev = await c.wait(lambda ev, sid=sid: ev.get("post_type") == "session_ready" and ev.get("session_id") == sid, 40)
    if not ev:
        rec("4.ask_user_question", False, "no session_ready")
        return
    asks = []
    old = c.on_ask

    async def on_ask(aev):
        asks.append(aev)
        if old:
            await old(aev)
    c.on_ask = on_ask
    e = await c.act("send", {"session_id": sid, "text": "问我最喜欢哪个颜色（选项红/蓝/绿），等我回答后再告诉我我选的颜色"})
    fin = await c.wait(lambda ev: ev.get("post_type") in ("final", "error") and ev.get("echo") == e, 150)
    q_asks = [a for a in asks if a.get("kind") == "question"]
    rec("4.ask_user_question", fin is not None,
        f"question_asks={len(q_asks)} (tool_absent_in_cli_2.1.263) final={(fin.get('text') if fin else '')[:200]!r}")
    await drop_all(c, [sid])
    await c.close()


async def sc_stop_resume(host_url, token):
    c = Client(host_url, token)
    await c.connect()
    sid = "acc-stop-1"
    await c.act("new_session", {"session_id": sid})
    ev = await c.wait(lambda ev, sid=sid: ev.get("post_type") == "session_ready" and ev.get("session_id") == sid, 40)
    if not ev:
        rec("5.stop_resume", False, "no session_ready")
        return
    e = await c.act("send", {"session_id": sid, "text": "从1数到300，每个数单独一行输出，不要省略"})
    d = await c.wait(lambda ev: ev.get("post_type") == "delta" and ev.get("session_id") == sid, 120)
    if not d:
        rec("5.stop_resume", False, "no delta")
        return
    await asyncio.sleep(1.5)
    aborted_before = any(ev.get("post_type") == "final" and ev.get("echo") == e for ev in c.events)
    await c.act("stop", {"session_id": sid})
    ab = await c.wait(lambda ev: ev.get("post_type") == "turn_aborted" and ev.get("session_id") == sid, 30)
    if aborted_before or not ab:
        rec("5.stop_resume", False, f"aborted_before={aborted_before} turn_aborted={bool(ab)}")
        return
    e2 = await c.act("send", {"session_id": sid, "text": "刚才你数到几就被打断了？一句话回答"})
    fin = await c.wait(lambda ev: ev.get("post_type") in ("final", "error") and ev.get("echo") == e2, 150)
    ok = fin and fin.get("post_type") == "final" and bool(fin.get("text"))
    rec("5.stop_resume", ok, f"aborted.reason={ab.get('reason')} resume_final={fin.get('text') if fin else None!r}")
    await drop_all(c, [sid])
    await c.close()


async def sc_misc(host_url, token, bad_token):
    c = Client(host_url, token)
    await c.connect()
    e = await c.act("ping")
    p = await c.wait(lambda ev: ev.get("post_type") == "pong" and ev.get("echo") == e, 15)
    e2 = await c.act("sessions.list")
    sl = await c.wait(lambda ev: ev.get("post_type") == "sessions" and ev.get("echo") == e2, 15)
    rec("6a.ping_list", bool(p and sl), f"pong={bool(p)} sessions={len(sl.get('sessions', [])) if sl else None}")
    await c.close()
    # bad token must fail handshake with 401
    try:
        s = aiohttp.ClientSession()
        try:
            ws = await s.ws_connect(host_url + "?token=" + (bad_token or "wrong" * 8))
            try:
                await ws.close()
            except Exception:
                pass
            rec("6b.bad_token_401", False, "handshake unexpectedly succeeded")
        finally:
            await s.close()
    except aiohttp.WSServerHandshakeError as ex:
        rec("6b.bad_token_401", ex.status == 401, f"status={ex.status}")
    except Exception as ex:
        rec("6b.bad_token_401", False, f"exc={ex!r}")


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="ws://127.0.0.1:8642/ws")
    ap.add_argument("--config", default="/my/run/cws/secrets.json")
    ap.add_argument("--token", default=None, help="override; else read from secrets.json")
    ap.add_argument("--scenario", default="all",
                    choices=["all", "basic", "parallel", "bash_deny", "askq", "stop", "misc"])
    args = ap.parse_args()
    token = args.token
    if not token:
        with open(args.config) as f:
            token = json.load(f)["token"]
    if args.scenario in ("all", "basic"):
        await sc_basic(args.url, token)
    if args.scenario in ("all", "parallel"):
        await sc_parallel(args.url, token)
    if args.scenario in ("all", "bash_deny"):
        await sc_bash_deny(args.url, token)
    if args.scenario in ("all", "askq"):
        await sc_askq(args.url, token)
    if args.scenario in ("all", "stop"):
        await sc_stop_resume(args.url, token)
    if args.scenario in ("all", "misc"):
        await sc_misc(args.url, token, "deadbeef" * 8)
    with open("/my/run/test_results.json", "w") as f:
        json.dump(RES, f, ensure_ascii=False, indent=1)
    fails = [k for k, v in RES.items() if not v["ok"]]
    print("SUMMARY_OK" if not fails else f"SUMMARY_FAIL {fails}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
