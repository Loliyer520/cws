// KxPanel.tsx —— 卡西（手表助手）调试台：直接调后端 kx.chat 代理，
// 验证渠道/模型/工具编排；手表端走同一 WS action，协议同形。
import { useState } from "react";
import { store, useStore } from "../store";
import { Shell } from "./Panels";
import { IconSend } from "../icons";

type KxToolCall = { id?: string; name: string; arguments: Record<string, unknown> };
type KxMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls: KxToolCall[] }
  | { role: "tool"; tool_call_id?: string; content: string };

const TOOLS_PLACEHOLDER = '[{"name":"get_time","description":"取当前时间","parameters":{"type":"object","properties":{},"required":[]}}]';

export default function KxPanel() {
  const st = useStore();
  const firstChan = st.channels[0]?.name || "";
  const [channel, setChannel] = useState(st.defaultChannel || firstChan);
  const [model, setModel] = useState(
    st.channels.find((c) => c.name === (st.defaultChannel || firstChan))?.model || "");
  const [sys, setSys] = useState("");
  const [toolsText, setToolsText] = useState("");
  const [msgs, setMsgs] = useState<KxMsg[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const pickChannel = (name: string) => {
    setChannel(name);
    setModel(st.channels.find((c) => c.name === name)?.model || "");
  };

  const call = async (base: KxMsg[], extra: KxMsg[]) => {
    const next = [...base, ...extra];
    let tools: unknown[] | undefined;
    if (toolsText.trim()) {
      try {
        tools = JSON.parse(toolsText);
        if (!Array.isArray(tools)) throw new Error("not array");
      } catch {
        store.toast("工具定义不是 JSON 数组", "err");
        return;
      }
    }
    setMsgs(next);
    setBusy(true);
    const out = [...next];
    if (sys.trim()) out.unshift({ role: "system", content: sys.trim() });
    const r = await store.kxCall({
      channel: channel || undefined,
      model: model.trim() || undefined,
      messages: out,
      ...(tools ? { tools } : {}),
    });
    setBusy(false);
    if (!r.ok) { store.toast("卡西失败：" + (r.error || ""), "err"); return; }
    const tc = ((r.tool_calls || []) as KxToolCall[]);
    setMsgs((m) => [...m, { role: "assistant", content: r.content || "", tool_calls: tc }]);
    if (tc.length) {
      const d: Record<string, string> = {};
      tc.forEach((c, i) => { d[c.id || "t" + i] = JSON.stringify({ ok: true }, null, 2); });
      setDrafts((p) => ({ ...p, ...d }));
    }
  };

  const send = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void call(msgs, [{ role: "user", content: text }]);
  };

  const replyTool = (c: KxToolCall, idx: number) => {
    if (busy) return;
    const key = c.id || "t" + idx;
    void call(msgs, [{ role: "tool", tool_call_id: c.id, content: drafts[key] ?? "" }]);
  };

  return (
    <Shell title="卡西 · 手表助手" onClose={() => store.setModal(null)} wide>
      <div className="set-grid kx-grid">
        <div className="set-field">
          <span className="set-label">渠道</span>
          <select className="ctrl" value={channel} onChange={(e) => pickChannel(e.target.value)}>
            <option value="">（服务端默认）</option>
            {st.channels.map((c) => <option key={c.name} value={c.name}>{c.label || c.name}</option>)}
          </select>
        </div>
        <div className="set-field model">
          <span className="set-label">模型（留空 = 渠道默认）</span>
          <input className="ctrl ch-model" value={model} onChange={(e) => setModel(e.target.value)}
            placeholder="如 glm-5.3-flash" />
        </div>
      </div>
      <label className="kx-field">
        <span className="set-label">System（可选）</span>
        <textarea className="kx-ta" rows={2} value={sys} onChange={(e) => setSys(e.target.value)}
          placeholder="你是手表上的助手，回复要短。" />
      </label>
      <label className="kx-field">
        <span className="set-label">Tools（可选，JSON 数组）</span>
        <textarea className="kx-ta mono" rows={3} value={toolsText} onChange={(e) => setToolsText(e.target.value)}
          placeholder={TOOLS_PLACEHOLDER} />
      </label>

      <div className="kx-log">
        {msgs.length === 0 && <div className="kx-empty">还没有对话。发一条消息试试代理链路。</div>}
        {msgs.map((m, i) => {
          if (m.role === "user") {
            return <div className="kx-row user" key={i}>{m.content}</div>;
          }
          if (m.role === "tool") {
            return (
              <div className="kx-row tool" key={i}>
                <span className="kx-tag">tool → {m.tool_call_id || "?"}</span>
                <pre>{m.content || "（空）"}</pre>
              </div>
            );
          }
          if (m.role !== "assistant") return null;
          return (
            <div className="kx-row assistant" key={i}>
              {m.content ? <div className="kx-text">{m.content}</div> : null}
              {m.tool_calls.map((c, j) => {
                const key = c.id || "t" + j;
                return (
                  <div className="kx-tc" key={key}>
                    <div className="kx-tc-head">
                      <span className="kx-tag">🛠 {c.name}</span>
                      {drafts[key] !== undefined && !busy ? (
                        <button className="ghost" onClick={() => replyTool(c, j)}>回传并发送</button>
                      ) : null}
                    </div>
                    <pre>{JSON.stringify(c.arguments, null, 2)}</pre>
                    {drafts[key] !== undefined ? (
                      <textarea className="kx-ta mono" rows={3} value={drafts[key]}
                        onChange={(e) => setDrafts((p) => ({ ...p, [key]: e.target.value }))}
                        placeholder='工具结果（JSON 或纯文本）' />
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
        {busy && <div className="kx-empty">代理请求中…（上限 90s）</div>}
      </div>

      <div className="kx-input">
        <textarea className="kx-ta" rows={2} value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="用户消息（Enter 发送，Shift+Enter 换行）" />
        <div className="kx-btns">
          <button className="ghost" onClick={() => { setMsgs([]); setDrafts({}); }}>清空</button>
          <button className="primary send-btn2" disabled={!input.trim() || busy} onClick={send}>
            <IconSend size={14} /> 发送
          </button>
        </div>
      </div>
      <p className="panel-tip">手表端同形协议：WS action <code>kx.chat</code>，params {"{channel?, model?, messages, tools?}"}（tools 用简写），回 <code>kx_reply</code> 带 <code>content</code> 与 <code>{"tool_calls[{id,name,arguments}]"}</code>；密钥只在服务端。</p>
    </Shell>
  );
}
