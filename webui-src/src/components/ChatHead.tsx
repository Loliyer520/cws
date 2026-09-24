// ChatHead.tsx —— 单排顶栏：汉堡 / 品牌 / 会话标题 / 停止·齿轮·删除 / 新建。
// 权限/渠道/模型收进齿轮展开的设置卡片（卡内首行是后端元信息）。
import { useEffect, useState } from "react";
import { PERM_OPTIONS, store, useStore } from "../store";
import { IconBridge, IconGear, IconMenu, IconPlus, IconStop, IconTrash } from "../icons";

export default function ChatHead({ onNav }: { onNav: () => void }) {
  const st = useStore();
  const s = st.current ? st.sessions.get(st.current) : null;
  const info = s?.info;
  const [model, setModel] = useState("");
  const [setOpen, setSetOpen] = useState(false);

  useEffect(() => { setModel(info?.model || ""); }, [st.current, info?.model]);

  const meta = info
    ? info.backend + (info.channel ? " · " + info.channel : "") + (info.model ? " / " + info.model : "")
      + (info.queued ? ` · 排队 #${info.queue_position ?? "…"}` : info.turn_active ? " · 运行中" : "")
    : "";

  return (
    <>
      <div className="topbar">
        <button className="hamburger" onClick={onNav}><IconMenu size={17} /></button>
        <div className="brand">
          <span className="brand-mark"><IconBridge size={17} /></span>
          {!info && <span className="brand-word">cws</span>}
          <span className={"dot" + (st.connected ? " on" : "")} title={st.connected ? "已连接" : "重连中…"} />
        </div>
        {info ? (
          <>
            <div className="tb-title" title={meta || undefined}>
              {info.remark ? <span className="ch-remark">{"#" + info.remark}</span> : null}
              <span className="tb-text">{info.title || "会话 " + info.session_id.slice(0, 12)}</span>
            </div>
            <div className="tb-sess">
              {info.turn_active && (
                <button className="stop-btn" onClick={() => store.stop()}>
                  <IconStop size={13} /> 停止
                </button>
              )}
              <button
                className={"ghost ch-icon" + (setOpen ? " on" : "")}
                title={"会话设置 · " + meta}
                onClick={() => setSetOpen((v) => !v)}
              >
                <IconGear size={15} />
              </button>
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
          </>
        ) : null}
        <div className="actions">
          <button className="ghost" onClick={() => store.setModal("new")}><IconPlus size={14} /> 新建</button>
        </div>
      </div>
      {setOpen && s && info ? (
        <div className="session-set">
          <div className="ch-meta set-meta">{meta}</div>
          <div className="set-grid">
            <div className="set-field">
              <span className="set-label">权限模式</span>
              <select
                className="ctrl"
                title="权限等级"
                value={info.permission_mode}
                onChange={(e) => store.setPermission(info.session_id, e.target.value)}
              >
                {(PERM_OPTIONS[info.backend] || PERM_OPTIONS.claude).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="set-field">
              <span className="set-label">上游渠道</span>
              <select
                className="ctrl"
                title="渠道"
                value={info.channel || ""}
                onChange={(e) => store.applyModel(info.session_id, e.target.value, model)}
              >
                {(info.backend === "openclaw"
                  ? [["", "不适用"]]
                  : [["", "机器默认"]]
                ).concat(
                  store.channelsForBackend(info.backend).map((c) => [c.name, c.label || c.name] as [string, string]),
                ).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="set-field model">
              <span className="set-label">模型</span>
              <div className="set-row">
                <input
                  className="ctrl ch-model"
                  placeholder="模型"
                  title={model || "模型"}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") store.applyModel(info.session_id, info.channel || "", model); }}
                />
                <button className="ghost" onClick={() => store.applyModel(info.session_id, info.channel || "", model)}>应用</button>
              </div>
            </div>
          </div>
          <div className="set-hint">权限改动即时下发；切换渠道或改模型会合并为一次 set_model 应用到当前会话。</div>
        </div>
      ) : null}
    </>
  );
}
