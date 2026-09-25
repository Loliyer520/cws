// ChatView.tsx —— 消息流：用户/助手气泡（markdown）、单行工具行、ask 审批卡、
// 轮次折叠分割线（每轮结束只留最后一条 AI 总结，工具与中间文本自动收起）、
// 思考指示、系统行、用量小字；近底部时自动跟随滚动。
import { memo, useEffect, useRef, useState } from "react";
import { store, useStore } from "../store";
import { md } from "../markdown";
import type { AskFrame, Msg, SessionState } from "../types";
import { IconCheck, IconChevron, IconFile, IconPencil, IconTerminal } from "../icons";

function ToolIcon({ name }: { name: string }) {
  const n = name.toLowerCase();
  if (n.includes("edit") || n.includes("write") || n.includes("notebook")) return <IconPencil size={12} />;
  if (n.includes("read") || n.includes("file") || n.includes("grep") || n.includes("glob") || n.includes("search")) return <IconFile size={12} />;
  return <IconTerminal size={12} />;
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

/** 单行工具行：图标 + 名字 + 摘要截断；运行中亮警示边与呼吸点 */
function ToolLine({ m }: { m: Extract<Msg, { kind: "tool" }> }) {
  const { name, brief } = splitTool(m.text);
  return (
    <div className={"tool-line" + (m.run ? " running" : "")}>
      <span className="t-ico"><ToolIcon name={name} /></span>
      <span className="t-name">{name}</span>
      {brief ? <span className="t-brief" title={brief}>{brief}</span> : null}
      {m.run ? <span className="t-run" /> : null}
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
  if (m.kind !== "ask") return null;
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

// ---------- 轮次折叠 ----------
/** 一轮的折叠计划：hide=收起的下标集，at=分割线插入处，key 带会话前缀防串 */
type FoldPlan = { key: string; hide: Set<number>; at: number; tools: number; texts: number };

/**
 * 逐轮计算折叠：user 消息到本轮最后一条 cc 之间的 tool / cc（中间文本）收起，
 * 只留最后一条 cc 当总结；没有 cc 的轮（中断/纯工具）也收工具。
 * 最后一轮仍在跑（turn_active / 流式 / 思考 / running 工具）时不折叠，保持实时可见。
 */
function foldPlans(sid: string, s: SessionState, msgs: Msg[]): FoldPlan[] {
  const lastRunning = !!s.info.turn_active || !!s.streaming || s.thinking != null
    || msgs.some((m) => m.kind === "tool" && m.run);
  const plans: FoldPlan[] = [];
  // 各轮边界：user 下标（-1 开头的散段跳过——没有锚点不好归轮）
  const anchors: number[] = [];
  msgs.forEach((m, i) => { if (m.kind === "user") anchors.push(i); });
  anchors.forEach((anchor, t) => {
    const end0 = t + 1 < anchors.length ? anchors[t + 1] : msgs.length;
    if (t === anchors.length - 1 && lastRunning) return; // 进行中不折
    let lastCc = -1;
    for (let i = end0 - 1; i > anchor; i--) {
      if (msgs[i].kind === "cc") { lastCc = i; break; }
    }
    const end = lastCc >= 0 ? lastCc : end0;
    const hide = new Set<number>();
    let at = -1, tools = 0, texts = 0;
    for (let i = anchor + 1; i < end; i++) {
      const k = msgs[i].kind;
      if (k === "tool" || k === "cc") {
        hide.add(i);
        if (at < 0) at = i;
        if (k === "tool") tools++; else texts++;
      }
    }
    if (!hide.size) return;
    const um = msgs[anchor] as Extract<Msg, { kind: "user" }>;
    plans.push({ key: sid + ":" + (um.mid || "u" + anchor), hide, at, tools, texts });
  });
  return plans;
}

function FoldLine({ plan, open, onClick }: { plan: FoldPlan; open: boolean; onClick: () => void }) {
  const parts: string[] = [];
  if (plan.tools) parts.push(plan.tools + " 个工具");
  if (plan.texts) parts.push(plan.texts + " 条过程文本");
  return (
    <button className={"fold" + (open ? " open" : "")} onClick={onClick} title={open ? "收起" : "展开中间过程"}>
      <span className="fold-label">
        <IconChevron size={11} />
        {open ? "收起中间过程" : "已折叠 " + parts.join(" · ")}
      </span>
    </button>
  );
}

function msgKey(m: Msg, i: number): string {
  if (m.kind === "ask") return "ask:" + m.ask.ask_id;
  if (m.kind === "sys" || m.kind === "stat") return "i" + i;
  return m.mid || "i" + i;
}

export default function ChatView() {
  const st = useStore();
  const sid = st.current;
  const s = sid ? st.sessions.get(sid) : undefined;
  const boxRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  /** 已点开的轮次 key 集（默认全部收起） */
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(new Set());

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

  // 组装渲染块：折叠线 / 连续工具行聚成一组 / 其余单条
  const plans = foldPlans(sid || "", s, msgs);
  const planAt = new Map<number, FoldPlan>();
  const hideOf = new Map<number, FoldPlan>();
  plans.forEach((p) => {
    planAt.set(p.at, p);
    p.hide.forEach((i) => hideOf.set(i, p));
  });
  const toggle = (key: string) => setOpenFolds((prev) => {
    const n = new Set(prev);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  type Block =
    | { t: "msg"; m: Msg; key: string }
    | { t: "fold"; p: FoldPlan; key: string; open: boolean }
    | { t: "tools"; ms: Extract<Msg, { kind: "tool" }>[]; key: string };
  const blocks: Block[] = [];
  let cluster: Extract<Msg, { kind: "tool" }>[] = [];
  const flush = () => {
    if (cluster.length) { blocks.push({ t: "tools", ms: cluster, key: "g" + blocks.length }); cluster = []; }
  };
  msgs.forEach((m, i) => {
    const p = planAt.get(i);
    if (p) {
      flush();
      blocks.push({ t: "fold", p, key: "fold:" + p.key, open: openFolds.has(p.key) });
    }
    const hp = hideOf.get(i);
    if (hp && !openFolds.has(hp.key)) return; // 已折叠：跳过
    if (m.kind === "tool") { cluster.push(m); return; }
    flush();
    blocks.push({ t: "msg", m, key: msgKey(m, i) });
  });
  flush();

  return (
    <div className="scroll" ref={boxRef} onScroll={onScroll}>
      <div className="messages">
        {quiet && <div className="chat-hint">输入消息开始对话</div>}
        {blocks.map((b) => {
          if (b.t === "fold") return <FoldLine key={b.key} plan={b.p} open={b.open} onClick={() => toggle(b.p.key)} />;
          if (b.t === "tools") {
            return (
              <div className="tool-group" key={b.key}>
                {b.ms.map((m, i) => <ToolLine key={m.mid || "i" + i} m={m} />)}
              </div>
            );
          }
          return <MsgItem key={b.key} m={b.m} />;
        })}
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
