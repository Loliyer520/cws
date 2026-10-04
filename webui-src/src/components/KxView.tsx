// KxView.tsx —— 卡西管理台（置顶一等视图）：整条桥的自动管理助手。
// 对话流水在桥端持久化（kxlog），两端共享：启动拉 kx.history 全量，之后吃
// kx_log 广播增量（手表的自转/工具行也在这里出现）。发消息走 kx.chat agent
// 形态，服务端入流水并广播，本端不本地追加——kx_reply 只管 ok/error 清忙。
import { useEffect, useRef, useState } from "react";
import { store, useStore } from "../store";
import { md } from "../markdown";
import type { KxLogEntry } from "../types";
import { IconSend, IconWatch } from "../icons";

const QUICK = ["桥现在什么状态？", "有哪些会话？", "检查更新", "渠道体检"];

function Entry({ e }: { e: KxLogEntry }) {
  if (e.role === "user") {
    return (
      <div className="msg user">
        <div className="msg-body"><div className="bubble">{e.text}</div></div>
      </div>
    );
  }
  if (e.role === "kx") {
    return (
      <div className="msg assistant">
        <div className="avatar kx-ava"><IconWatch size={13} /></div>
        <div className="bubble md" dangerouslySetInnerHTML={{ __html: md(e.text) }} />
      </div>
    );
  }
  if (e.role === "tool") {
    return (
      <div className="tool-group">
        <div className="tool-line"><span className="t-brief kx-tool-text">{e.text}</span></div>
      </div>
    );
  }
  if (e.role === "trigger") {
    return <div className="kx-trig" title={e.prompt || undefined}>{e.text}</div>;
  }
  return <div className="sys">{e.text}</div>;
}

export default function KxView() {
  const st = useStore();
  const firstChan = st.channels[0]?.name || "";
  const [channel, setChannel] = useState(st.defaultChannel || firstChan);
  const [model, setModel] = useState(
    st.channels.find((c) => c.name === (st.defaultChannel || firstChan))?.model || "");
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
    setBusy(true);
    const r = await store.kxCall({
      agent: true, text: t,
      channel: channel || undefined,
      model: model.trim() || undefined,
    });
    setBusy(false);
    if (!r.ok) store.toast("卡西失败：" + (r.error || ""), "err");
  };

  return (
    <>
      <div className="scroll" ref={boxRef} onScroll={onScroll}>
        <div className="messages kx-messages">
          {st.kxLog.length === 0 ? (
            <div className="empty kx-empty">
              <div className="empty-kicker">KX · AUTO OPS</div>
              <h1>卡西</h1>
              <p>桥的自动管理助手——查状态、开会话、测渠道、拉更新，<br />说一句话，剩下的交给它。</p>
            </div>
          ) : null}
          {st.kxLog.map((e, i) => <Entry key={e.eid || "i" + i} e={e} />)}
          {busy ? (
            <div className="thinking kx-busy">
              <span className="dots"><i /><i /><i /></span>
              卡西执行中…
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
            ? "流水与手表端同步 · 卡西在服务端执行桥管理工具，破坏性操作它会先确认"
            : "连接已断开，正在重连…"}
        </div>
      </div>
    </>
  );
}
