// ChatHead.tsx —— 当前会话的标题/元信息 + 权限/渠道/模型控制 + 停止/删除
import { useEffect, useState } from "react";
import { PERM_OPTIONS, store, useStore } from "../store";
import { IconStop, IconTrash } from "../icons";

export default function ChatHead() {
  const st = useStore();
  const s = st.current ? st.sessions.get(st.current) : null;
  const [model, setModel] = useState("");

  const info = s?.info;
  useEffect(() => { setModel(info?.model || ""); }, [st.current, info?.model]);

  if (!s || !info) return null;
  const permOpts = PERM_OPTIONS[info.backend] || PERM_OPTIONS.claude;
  const chanBase = info.backend === "openclaw"
    ? [["", "不适用"]]
    : [["", "机器默认"]];
  const chans = chanBase.concat(
    store.channelsForBackend(info.backend).map((c) => [c.name, c.label || c.name] as [string, string]));

  return (
    <header className="chat-head">
      <div className="ch-row ch-title-row">
        <div className="ch-title" title={info.remark || info.title}>
          {info.remark ? <span className="ch-remark">{"#" + info.remark}</span> : null}
          {info.title || "会话 " + info.session_id.slice(0, 12)}
        </div>
        <div className="ch-actions">
          {info.turn_active && (
            <button className="stop-btn" onClick={() => store.stop()}>
              <IconStop size={13} /> 停止
            </button>
          )}
          <button
            className="ghost ch-icon"
            title="删除会话"
            onClick={() => {
              if (confirm("删除会话 " + info.session_id + "？（服务端记录清除）")) {
                store.dropSession(info.session_id);
              }
            }}
          >
            <IconTrash size={15} />
          </button>
        </div>
      </div>
      <div className="ch-row ch-ctrl-row">
        <span className="ch-meta">
          {info.backend}
          {info.channel ? " · " + info.channel : ""}
          {info.model ? " / " + info.model : ""}
          {info.queued ? ` · 排队 #${info.queue_position ?? "…"}` : info.turn_active ? " · 运行中" : ""}
        </span>
        <div className="ch-ctrls">
          <select
            className="ctrl"
            title="权限等级"
            value={info.permission_mode}
            onChange={(e) => store.setPermission(info.session_id, e.target.value)}
          >
            {permOpts.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <select
            className="ctrl"
            title="渠道"
            value={info.channel || ""}
            onChange={(e) => store.applyModel(info.session_id, e.target.value, model)}
          >
            {chans.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <input
            className="ctrl ch-model"
            placeholder="模型"
            title={model || "模型"}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") store.applyModel(info.session_id, s.info.channel || "", model); }}
          />
          <button className="ghost" onClick={() => store.applyModel(info.session_id, s.info.channel || "", model)}>应用</button>
        </div>
      </div>
    </header>
  );
}
