// Sidebar.tsx —— 会话列表 + 面板入口（kawork 布局：新建按钮 / 滚动列表 / 底部入口）
import { BACKEND_LETTER, store, useStore } from "../store";
import type { SessionState } from "../types";
import { IconGear, IconNote, IconStack, IconTrash } from "../icons";

function sortedSessions(map: Map<string, SessionState>): SessionState[] {
  return Array.from(map.values()).sort((a, b) =>
    (b.info.last_msg_ts || b.info.created_at || 0) - (a.info.last_msg_ts || a.info.created_at || 0));
}

export default function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const st = useStore();
  const items = sortedSessions(st.sessions);

  return (
    <div className="sidebar">
      <div className="side-pad">
        <button className="new-btn full" onClick={() => store.setModal("new")}>＋ 新建会话</button>
      </div>

      <div className="sess-list">
        {items.length === 0 && <div className="sess-empty">还没有会话</div>}
        {items.map(({ info }) => {
          const letter = BACKEND_LETTER[info.backend] || "C";
          const title = info.remark || info.title || "会话 " + info.session_id.slice(0, 12);
          return (
            <div
              key={info.session_id}
              className={"sess-item" + (info.session_id === st.current ? " active" : "")}
              onClick={() => { store.openChat(info.session_id); onNavigate?.(); }}
            >
              <div className="sess-top">
                <span className={"be-dot be-" + info.backend}>{letter}</span>
                <span className="sess-title">
                  {info.remark ? <IconNote size={12} className="sess-note" /> : null}
                  {title}
                </span>
                <span className="sess-badges">
                  {info.queued
                    ? <span className="badge queued">排队 #{info.queue_position ?? "…"}</span>
                    : info.turn_active ? <span className="badge running">运行中</span> : null}
                </span>
                <span className="sess-ops" onClick={(e) => e.stopPropagation()}>
                  <button title="备注" onClick={() => store.setModal({ kind: "remark", sid: info.session_id })}>
                    <IconNote size={14} />
                  </button>
                  <button
                    title="删除会话"
                    onClick={() => {
                      if (confirm("删除会话 " + info.session_id + "？（服务端记录清除）")) {
                        store.dropSession(info.session_id);
                      }
                    }}
                  >
                    <IconTrash size={14} />
                  </button>
                </span>
              </div>
              <div className="sess-sub">
                {info.model || info.channel || info.backend}
                {info.closed ? " · 已关闭" : info.lazy ? " · 待唤醒" : ""}
              </div>
            </div>
          );
        })}
      </div>

      <div className="side-bottom">
        <button onClick={() => { store.send("backends.list"); store.setModal("backends"); }}>
          <IconStack size={15} /> 后端与网关
        </button>
        <button onClick={() => { store.send("channels.list"); store.setModal("channels"); }}>
          <IconGear size={15} /> 上游渠道与模型
        </button>
      </div>
    </div>
  );
}
