// KxView.tsx —— 卡西主视图（置顶一等视图）：整条桥的自动管理助手。
// 走 WS action kx.chat 的 agent 形态：服务端注入内置桥管理工具自跑
// "调用→执行→回填"循环，每步推 kx_step 实时上屏，收轮回 kx_reply（总结+步骤）。
import { useEffect, useRef, useState } from "react";
import { store, useStore } from "../store";
import { md } from "../markdown";
import type { Frame } from "../api";
import type { KxStep } from "../types";
import { IconSend, IconWatch } from "../icons";

type Item =
  | { t: "user"; text: string }
  | { t: "steps"; steps: KxStep[] }
  | { t: "ai"; text: string };

const QUICK = ["桥现在什么状态？", "有哪些会话？", "检查更新", "渠道体检"];

export default function KxView() {
  const st = useStore();
  const firstChan = st.channels[0]?.name || "";
  const [channel, setChannel] = useState(st.defaultChannel || firstChan);
  const [model, setModel] = useState(
    st.channels.find((c) => c.name === (st.defaultChannel || firstChan))?.model || "");
  const [items, setItems] = useState<Item[]>([]);
  /** 发给上游的对话（只含 user/assistant 文本；工具在服务端执行，不进前端历史） */
  const apiMsgs = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const onScroll = () => {
    const el = boxRef.current;
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

  const call = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    apiMsgs.current.push({ role: "user", content: t });
    setItems((p) => [...p, { t: "user", text: t }]);
    setBusy(true);
    const r: Frame = await store.kxCall({
      agent: true,
      channel: channel || undefined,
      model: model.trim() || undefined,
      messages: [...apiMsgs.current],
    }, 600_000);
    setBusy(false);
    if (!r.ok) {
      store.toast("卡西失败：" + (r.error || ""), "err");
      apiMsgs.current.pop(); // 失败这轮不进历史，重发即可
      setItems((p) => p.filter((it) => it.t !== "user" || it.text !== t));
      return;
    }
    const steps = (r.steps || []) as KxStep[];
    setItems((p) => [...p,
      ...(steps.length ? [{ t: "steps" as const, steps }] : []),
      { t: "ai" as const, text: r.content || "（空回复）" },
    ]);
    apiMsgs.current.push({ role: "assistant", content: r.content || "" });
  };

  return (
    <>
      <div className="scroll" ref={boxRef} onScroll={onScroll}>
        <div className="messages kx-messages">
          {items.length === 0 && !busy ? (
            <div className="empty kx-empty">
              <div className="empty-kicker">KX · AUTO OPS</div>
              <h1>卡西</h1>
              <p>桥的自动管理助手——查状态、开会话、测渠道、拉更新，<br />说一句话，剩下的交给它。</p>
            </div>
          ) : null}
          {items.map((it, i) => {
            if (it.t === "user") {
              return (
                <div className="msg user" key={i}>
                  <div className="msg-body"><div className="bubble">{it.text}</div></div>
                </div>
              );
            }
            if (it.t === "steps") {
              return (
                <div className="tool-group" key={i}>
                  {it.steps.map((s, j) => (
                    <div className={"tool-line" + (s.ok ? "" : " err")} key={j}>
                      <span className="t-name">{s.name}</span>
                      {s.brief ? <span className="t-brief">{s.brief}</span> : null}
                    </div>
                  ))}
                </div>
              );
            }
            return (
              <div className="msg assistant" key={i}>
                <div className="avatar kx-ava"><IconWatch size={13} /></div>
                <div className="bubble md" dangerouslySetInnerHTML={{ __html: md(it.text) }} />
              </div>
            );
          })}
          {busy ? (
            <div className="tool-group">
              {st.kxSteps.map((s, j) => (
                <div className={"tool-line running" + (s.ok ? "" : " err")} key={"live" + j}>
                  <span className="t-name">{s.name}</span>
                  {s.brief ? <span className="t-brief">{s.brief}</span> : null}
                  <span className="t-run" />
                </div>
              ))}
              <div className="thinking">
                <span className="dots"><i /><i /><i /></span>
                卡西执行中{st.kxSteps.length ? " · " + st.kxSteps.length + " 步" : ""}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="composer-wrap kx-compose">
        <div className="kx-bar">
          <select
            className="ctrl kx-ctrl"
            value={channel}
            onChange={(e) => {
              setChannel(e.target.value);
              setModel(st.channels.find((c) => c.name === e.target.value)?.model || "");
            }}
            title="卡西用哪个渠道思考"
          >
            <option value="">（服务端默认渠道）</option>
            {st.channels.map((c) => <option key={c.name} value={c.name}>{c.label || c.name}</option>)}
          </select>
          <input
            className="ctrl kx-ctrl kx-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="模型（留空 = 渠道默认）"
          />
          <div className="kx-quick">
            {QUICK.map((q) => (
              <button key={q} className="chip" disabled={busy} onClick={() => void call(q)}>{q}</button>
            ))}
          </div>
        </div>
        <div className="composer">
          <textarea
            rows={1}
            value={input}
            placeholder={busy ? "卡西执行中…" : "对卡西说：查状态 / 开个会话 / 测渠道 / 检查更新…"}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void call(input);
              }
            }}
          />
          <button className="send" disabled={busy || !input.trim()} title="发送" onClick={() => void call(input)}>
            <IconSend size={17} />
          </button>
        </div>
        <div className="hint">
          {st.connected
            ? "卡西在服务端执行桥管理工具 · 破坏性操作它会先向你确认"
            : "连接已断开，正在重连…"}
        </div>
      </div>
    </>
  );
}
