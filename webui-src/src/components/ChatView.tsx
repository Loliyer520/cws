// ChatView.tsx —— 消息流：用户/助手气泡（markdown）、工具卡、ask 审批卡、
// 思考指示、系统行、用量小字；近底部时自动跟随滚动。
import { memo, useEffect, useRef, useState } from "react";
import { store, useStore } from "../store";
import { md } from "../markdown";
import type { AskFrame, Msg } from "../types";
import { IconCheck, IconFile, IconPencil, IconTerminal } from "../icons";

function ToolIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  if (n.includes("edit") || n.includes("write") || n.includes("notebook")) return <IconPencil size={13} />;
  if (n.includes("read") || n.includes("file") || n.includes("grep") || n.includes("glob") || n.includes("search")) return <IconFile size={13} />;
  return <IconTerminal size={13} />;
}

/** "工具：摘要" 拆出名称与摘要 */
function splitTool(text: string): { name: string; brief: string } {
  const i = text.indexOf("：");
  if (i < 0) return { name: text, brief: "" };
  return { name: text.slice(0, i), brief: text.slice(i + 1) };
}

function ImageRow({ images }: { images?: { media_type: string; data: string }[] }) {
  if (!images || !images.length) return null;
  return (
    <div className="bubble-imgs">
      {images.map((im, i) => (
        <img key={i} className="bubble-img" src={`data:${im.media_type};base64,${im.data}`} alt="" loading="lazy" />
      ))}
    </div>
  );
}

const MsgItem = memo(function MsgItem({ m }: { m: Msg }) {
  if (m.kind === "sys") return <div className="sys">{m.text}</div>;
  if (m.kind === "stat") return <div className="stat">{m.text}</div>;
  if (m.kind === "user") {
    return (
      <div className="msg user">
        <div className="msg-body">
          {m.images?.length ? <ImageRow images={m.images} /> : null}
          {m.text ? <div className="bubble">{m.text}</div> : null}
        </div>
      </div>
    );
  }
  if (m.kind === "cc") {
    return (
      <div className="msg assistant">
        <div className="avatar"><IconTerminal size={13} /></div>
        <div className="bubble md" dangerouslySetInnerHTML={{ __html: md(m.text) }} />
      </div>
    );
  }
  if (m.kind === "tool") {
    const { name, brief } = splitTool(m.text);
    return (
      <div className="msg assistant">
        <div className="avatar tool-ava"><ToolIcon name={name} /></div>
        <div className="msg-body">
          <div className={"tool-card" + (m.run ? " running" : " done")}>
            <div className="tool-head">
              <ToolIcon name={name} />
              <span className="tool-name">{name}</span>
              <span className="tool-status">{m.run ? "运行中" : "完成"}</span>
            </div>
            {brief ? <div className="tool-brief">{brief}</div> : null}
          </div>
        </div>
      </div>
    );
  }
  return <AskCard ask={m.ask} answered={m.answered} sid={m.ask.session_id} />;
});

function AskCard({ ask, answered, sid }: { ask: AskFrame; answered: null | "allow" | "deny"; sid: string }) {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const isQ = ask.kind === "question";
  const cls = "tool-card ask"
    + (answered === null ? " pending" : answered === "allow" ? " done" : " denied");

  const allow = () => {
    if (isQ) {
      if (!Object.keys(answers).length) { store.toast("请先选择答案", "err"); return; }
      store.replyAsk(sid, ask.ask_id, "allow", undefined,
        { ...(ask.input || {}), answers });
    } else {
      store.replyAsk(sid, ask.ask_id, "allow");
    }
  };
  const deny = () => store.replyAsk(sid, ask.ask_id, "deny", "denied by user");

  const answeredText = answered === "allow" ? (isQ ? "已提交回答" : "已允许") : "已拒绝";

  return (
    <div className="msg assistant">
      <div className="avatar ask-ava">{isQ ? <b>?</b> : <IconCheck size={13} />}</div>
      <div className="msg-body">
        <div className={cls}>
          <div className="tool-head">
            {isQ ? <b>？</b> : <IconCheck size={13} />}
            <span className="tool-name">{isQ ? "需要你回答" : "权限请求 · " + (ask.tool_name || "工具")}</span>
            <span className="tool-status">{answered ? answeredText : "等待处理"}</span>
          </div>
          {!isQ && ask.input != null && (
            <div className="tool-result">{JSON.stringify(ask.input, null, 1)}</div>
          )}
          {isQ && ((ask.input?.questions) || []).map((q, qi) => (
            <div className="ask-q" key={qi}>
              <div className="qtext">{(q.header ? q.header + " — " : "") + (q.question || "")}</div>
              {(q.options || []).map((o) => (
                <label className="q-opt" key={o.label}>
                  <input
                    type={q.multiSelect ? "checkbox" : "radio"}
                    name={`askq-${ask.ask_id}-${qi}`}
                    disabled={!!answered}
                    onChange={(e) => {
                      const box = e.currentTarget;
                      const wrap = box.closest(".ask-q") as HTMLElement | null;
                      if (!wrap) return;
                      const picked = Array.from(wrap.querySelectorAll("input:checked")).map((x) => (x as HTMLInputElement).value);
                      setAnswers((prev) => ({
                        ...prev,
                        [q.question]: q.multiSelect ? picked : picked[0] ?? "",
                      }));
                    }}
                  />
                  <span className="q-label">
                    {o.label}
                    {o.description ? <em> — {o.description}</em> : null}
                  </span>
                </label>
              ))}
            </div>
          ))}
          <div className="tool-actions">
            <button className="tool-allow" disabled={!!answered} onClick={allow}>
              {isQ ? "提交回答" : "允许"}
            </button>
            <button className="tool-deny" disabled={!!answered} onClick={deny}>拒绝</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function msgKey(m: Msg, i: number): string {
  if (m.kind === "ask") return "ask:" + m.ask.ask_id;
  if (m.kind === "sys" || m.kind === "stat") return "i" + i;
  return m.mid || "i" + i;
}

export default function ChatView() {
  const st = useStore();
  const s = st.current ? st.sessions.get(st.current) : undefined;
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

  if (!s) return null;
  const msgs = s.msgs;
  const quiet = !msgs.length && !s.streaming && s.thinking == null;

  return (
    <div className="scroll" ref={boxRef} onScroll={onScroll}>
      <div className="messages">
        {quiet && <div className="chat-hint">输入消息开始对话</div>}
        {msgs.map((m, i) => (
          <MsgItem key={msgKey(m, i)} m={m} />
        ))}
        {s.streaming ? (
          <div className="msg assistant">
            <div className="avatar"><IconTerminal size={13} /></div>
            <div className="bubble md" dangerouslySetInnerHTML={{ __html: md(s.streaming) }} />
          </div>
        ) : null}
        {s.thinking != null ? (
          <div className="msg assistant">
            <div className="avatar"><IconTerminal size={13} /></div>
            <div className="thinking">
              <span className="dots"><i /><i /><i /></span>
              思考中 · {s.thinking} tokens
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
