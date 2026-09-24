// Panels.tsx —— 模态面板：新建会话 / 渠道管理 / 后端与网关 / 会话备注。
// 布局沿用 kawork 的 overlay + panel 结构。
import { useEffect, useState } from "react";
import { PERM_OPTIONS, store, useStore } from "../store";
import type { Backend, Channel } from "../types";
import { IconX } from "../icons";

export function Shell({ title, onClose, children, wide }: {
  title: string; onClose: () => void; children: React.ReactNode; wide?: boolean;
}) {
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={"panel" + (wide ? " wide" : "")}>
        <div className="panel-head">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose}><IconX size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------- 新建会话 ----------
export function NewSessionPanel() {
  const st = useStore();
  const [sid, setSid] = useState("");
  const [backend, setBackend] = useState<Backend>("claude");
  const [channel, setChannel] = useState("");
  const [model, setModel] = useState("");
  const [perm, setPerm] = useState("default");
  const [gateway, setGateway] = useState(
    st.backends?.gateways[0]?.name || "openclaw");
  const [remote, setRemote] = useState("");

  useEffect(() => {
    setPerm((PERM_OPTIONS[backend] || PERM_OPTIONS.claude)[0][0]);
    setChannel("");
  }, [backend]);

  const chans = store.channelsForBackend(backend);

  return (
    <Shell title="新建会话" onClose={() => store.setModal(null)}>
      <label>会话 ID（留空自动生成）<input value={sid} onChange={(e) => setSid(e.target.value)} placeholder="mychat" /></label>
      <label>后端
        <select value={backend} onChange={(e) => setBackend(e.target.value as Backend)}>
          <option value="claude">claude CLI · 本地</option>
          <option value="codex">codex CLI · 本地</option>
          <option value="openclaw">openclaw · 远程 OpenClaw 网关</option>
        </select>
      </label>
      {backend === "openclaw" && (
        <>
          <label>网关（config.json 的 gateways）
            <select value={gateway} onChange={(e) => setGateway(e.target.value)}>
              {(st.backends?.gateways || []).map((g) => <option key={g.name} value={g.name}>{g.name}</option>)}
              {!st.backends?.gateways.length && <option value="openclaw">openclaw</option>}
            </select>
          </label>
          <label>远程会话 key（留空 = 新建/自动）<input value={remote} onChange={(e) => setRemote(e.target.value)} placeholder="如 agent:main:xxx" /></label>
        </>
      )}
      <label>渠道
        {backend === "openclaw" ? (
          <select disabled><option value="">（不适用，模型填裸名）</option></select>
        ) : (
          <select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="">（默认渠道）</option>
            {chans.map((c) => <option key={c.name} value={c.name}>{c.label || c.name}</option>)}
            {!chans.length && <option value="" disabled>无兼容渠道（可留空用机器默认）</option>}
          </select>
        )}
      </label>
      <label>模型（留空 = 渠道默认）<input value={model} onChange={(e) => setModel(e.target.value)} placeholder="如 glm-5.3-flash / openclaw/default" /></label>
      <label>权限
        <select value={perm} onChange={(e) => setPerm(e.target.value)}>
          {(PERM_OPTIONS[backend] || PERM_OPTIONS.claude).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </label>
      <div className="panel-actions">
        <button className="ghost" onClick={() => store.setModal(null)}>取消</button>
        <button className="primary" onClick={() => store.createSession({
          session_id: sid, backend, channel, model, permission_mode: perm, gateway, remote_key: remote,
        })}>创建</button>
      </div>
    </Shell>
  );
}

// ---------- 渠道管理 ----------
interface ChanDraft {
  name: string; label: string; base_url: string; protocol: string; wire_api: string; model: string; api_key: string;
}

const emptyDraft: ChanDraft = {
  name: "", label: "", base_url: "", protocol: "auto", wire_api: "responses", model: "", api_key: "",
};

export function ChannelsPanel() {
  const st = useStore();
  const [editing, setEditing] = useState<string | null>(null); // null = 关闭表单；'' = 新增；其他 = 编辑名
  const [draft, setDraft] = useState<ChanDraft>(emptyDraft);

  const openForm = (c?: Channel) => {
    setEditing(c ? c.name : "");
    setDraft(c ? {
      name: c.name, label: c.label || "", base_url: c.base_url || "",
      protocol: c.protocol || "auto", wire_api: c.wire_api || "responses",
      model: c.model || "", api_key: "",
    } : emptyDraft);
  };

  const formChannel = editing || draft.name.trim();

  const save = () => {
    if (!draft.name.trim()) { store.toast("请填写渠道名称", "err"); return; }
    store.send("channels.save", {
      name: draft.name.trim(), label: draft.label.trim(), base_url: draft.base_url.trim(),
      protocol: draft.protocol, wire_api: draft.wire_api, model: draft.model.trim(),
      api_key: draft.api_key.trim(), // 留空 = 保留
    });
  };

  return (
    <Shell title="上游渠道与模型" onClose={() => store.setModal(null)} wide>
      <div className="chan-list">
        {st.channels.map((c) => (
          <div className="chan-item" key={c.name}>
            <div className="grow">
              <div className="name">
                {c.label || c.name}
                <span className="tag gray">{c.name}</span>
                {c.default ? <span className="tag">默认</span> : null}
              </div>
              <div className="detail">
                {c.base_url} · {c.protocol}/{c.wire_api || "responses"}
                {c.model ? " · " + c.model : ""}
                {c.key_tail ? " · key…" + c.key_tail : " · 无key"}
                {" · models:" + ((c.models || []).length || "-")}
              </div>
            </div>
            <button className="ghost" onClick={() => store.send("channels.set_default", { channel: c.name })}>默认</button>
            <button className="ghost" onClick={() => store.send("channel.test", { channel: c.name, model: c.model })}>测试</button>
            <button className="ghost" onClick={() => openForm(c)}>编辑</button>
            <button className="ghost chan-del" onClick={() => {
              if (confirm("删除渠道 " + c.name + "？")) store.send("channels.delete", { channel: c.name });
            }}>删</button>
          </div>
        ))}
        {!st.channels.length && <div className="panel-tip">还没有渠道，点下方新增。</div>}
      </div>
      {editing === null ? (
        <button className="ghost" onClick={() => openForm()}>＋ 新增渠道</button>
      ) : (
        <div className="subform">
          <div className="subform-title">{editing ? "编辑渠道：" + editing : "新增渠道"}</div>
          <div className="form-grid">
            <label>名称<input value={draft.name} disabled={!!editing} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label>显示名<input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
            <label>Base URL<input value={draft.base_url} onChange={(e) => setDraft({ ...draft, base_url: e.target.value })} placeholder="https://api.xxx.com/v1" /></label>
            <label>协议
              <select value={draft.protocol} onChange={(e) => setDraft({ ...draft, protocol: e.target.value })}>
                <option value="anthropic">anthropic · /v1/messages（claude 后端）</option>
                <option value="openai">openai · /v1/responses（codex 后端）</option>
                <option value="auto">auto · 双协议</option>
              </select>
            </label>
            <label>wire API
              <select value={draft.wire_api} onChange={(e) => setDraft({ ...draft, wire_api: e.target.value })}>
                <option value="responses">responses（推荐，codex ≥0.135 必选）</option>
                <option value="chat">chat（旧版 codex / 其他兼容端）</option>
              </select>
            </label>
            <label>默认模型<input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} /></label>
            <label>API Key
              <input
                type="password" value={draft.api_key}
                onChange={(e) => setDraft({ ...draft, api_key: e.target.value })}
                placeholder={editing && st.channels.find((c) => c.name === editing)?.key_tail
                  ? "已配置（尾号" + st.channels.find((c) => c.name === editing)?.key_tail + "），留空保留"
                  : "API Key"}
              />
            </label>
          </div>
          <div className="panel-actions">
            <button className="ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="ghost" onClick={() => formChannel && store.send("channel.test", { channel: formChannel, model: draft.model })}>测试连通</button>
            <button className="ghost" onClick={() => formChannel && store.send("channel.models", { channel: formChannel })}>拉取模型</button>
            <button className="primary" onClick={save}>保存</button>
          </div>
        </div>
      )}
    </Shell>
  );
}

// ---------- 后端与网关 ----------
interface GwDraft { name: string; url: string; agent: string; token: string; token_tail?: string }

export function BackendsPanel() {
  const st = useStore();
  const [claudeBin, setClaudeBin] = useState("");
  const [codexBin, setCodexBin] = useState("");
  const [defaultBackend, setDefaultBackend] = useState<Backend>("claude");
  const [gws, setGws] = useState<GwDraft[]>([]);
  const [gwForm, setGwForm] = useState<GwDraft | null>(null);

  // 打开时 / backends 帧到达时：以服务端为准重播本地可编辑副本
  useEffect(() => {
    if (!st.backends) return;
    setClaudeBin(st.backends.claude_bin);
    setCodexBin(st.backends.codex_bin);
    setDefaultBackend(st.backends.default_backend);
    setGws(st.backends.gateways.map((g) => ({
      name: g.name, url: g.url, agent: g.agent || "main", token: "", token_tail: g.token_tail,
    })));
  }, [st.backends]);

  const saveGwForm = () => {
    if (!gwForm) return;
    if (!gwForm.name.trim()) { store.toast("请填写网关名称", "err"); return; }
    const entry: GwDraft = {
      ...gwForm,
      name: gwForm.name.trim(), url: gwForm.url.trim(),
      agent: gwForm.agent.trim() || "main",
    };
    setGws((prev) => {
      const i = prev.findIndex((g) => g.name === entry.name);
      if (i >= 0) {
        const next = [...prev];
        // 编辑已有网关时未填新 token = 保留旧的（发送空串，服务端 keep）
        next[i] = { ...entry, token: entry.token || "" };
        return next;
      }
      return [...prev, entry];
    });
    setGwForm(null);
  };

  const saveAll = () => {
    store.send("backends.save", {
      claude_bin: claudeBin.trim(),
      codex_bin: codexBin.trim(),
      default_backend: defaultBackend,
      gateways: gws.map((g) => ({ name: g.name, url: g.url, agent: g.agent, token: g.token || "" })),
    });
  };

  return (
    <Shell title="后端与网关" onClose={() => store.setModal(null)} wide>
      <h3 className="group-title">本地 CLI 后端</h3>
      <div className="form-grid">
        <label>claude CLI 路径<input value={claudeBin} onChange={(e) => setClaudeBin(e.target.value)} placeholder="/usr/local/bin/claude" /></label>
        <label>codex CLI 路径<input value={codexBin} onChange={(e) => setCodexBin(e.target.value)} placeholder="codex" /></label>
        <label>默认后端
          <select value={defaultBackend} onChange={(e) => setDefaultBackend(e.target.value as Backend)}>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
            <option value="openclaw">openclaw</option>
          </select>
        </label>
      </div>
      <div className="panel-actions left">
        <button className="ghost" onClick={() => store.send("backends.test", { target: "claude" })}>测试 claude</button>
        <button className="ghost" onClick={() => store.send("backends.test", { target: "codex" })}>测试 codex</button>
      </div>

      <h3 className="group-title">远程网关（OpenClaw）</h3>
      <div className="chan-list">
        {gws.map((g) => (
          <div className="chan-item" key={g.name}>
            <div className="grow">
              <div className="name">{g.name}</div>
              <div className="detail">
                {g.url} · agent:{g.agent}
                {g.token_tail ? " · token…" + g.token_tail : " · 无token"}
              </div>
            </div>
            <button className="ghost" onClick={() => store.send("backends.test", { target: "openclaw:" + g.name })}>测试</button>
            <button className="ghost" onClick={() => setGwForm({ ...g, token: "" })}>编辑</button>
            <button className="ghost chan-del" onClick={() => setGws((prev) => prev.filter((x) => x.name !== g.name))}>删</button>
          </div>
        ))}
        {!gws.length && <div className="panel-tip">还没有网关。</div>}
      </div>
      {gwForm === null ? (
        <button className="ghost" onClick={() => setGwForm({ name: "", url: "", agent: "main", token: "" })}>＋ 新增网关</button>
      ) : (
        <div className="subform">
          <div className="form-grid">
            <label>名称<input value={gwForm.name} disabled={!!gws.find((g) => g.name === gwForm.name)} onChange={(e) => setGwForm({ ...gwForm, name: e.target.value })} placeholder="openclaw" /></label>
            <label>URL<input value={gwForm.url} onChange={(e) => setGwForm({ ...gwForm, url: e.target.value })} placeholder="ws://host:18789" /></label>
            <label>Agent<input value={gwForm.agent} onChange={(e) => setGwForm({ ...gwForm, agent: e.target.value })} placeholder="main" /></label>
            <label>Token
              <input
                type="password" value={gwForm.token}
                onChange={(e) => setGwForm({ ...gwForm, token: e.target.value })}
                placeholder={gwForm.token_tail ? "已配置（尾号" + gwForm.token_tail + "），留空保留" : "Token"}
              />
            </label>
          </div>
          <div className="panel-actions">
            <button className="ghost" onClick={() => setGwForm(null)}>取消</button>
            <button className="ghost" onClick={() => gwForm.name.trim() && store.send("backends.test", { target: "openclaw:" + gwForm.name.trim() })}>测试连接</button>
            <button className="primary" onClick={saveGwForm}>保存网关</button>
          </div>
        </div>
      )}

      <div className="panel-actions">
        <button className="ghost" onClick={() => store.setModal(null)}>关闭</button>
        <button className="primary" onClick={saveAll}>保存全部</button>
      </div>
    </Shell>
  );
}

// ---------- 会话备注 ----------
export function RemarkPanel({ sid }: { sid: string }) {
  const st = useStore();
  const info = st.sessions.get(sid)?.info;
  const [text, setText] = useState(info?.remark || "");
  useEffect(() => { setText(info?.remark || ""); }, [sid]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Shell title="会话备注" onClose={() => store.setModal(null)}>
      <p className="panel-tip">备注显示在会话列表里（最长 60 字），不进入模型上下文。</p>
      <input
        value={text}
        maxLength={60}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { store.setRemark(sid, text); store.setModal(null); } }}
        placeholder="如：手表专用 / 跑构建的那个"
      />
      <div className="panel-actions">
        <button className="ghost" onClick={() => store.setModal(null)}>取消</button>
        <button className="primary" onClick={() => { store.setRemark(sid, text); store.setModal(null); }}>保存</button>
      </div>
    </Shell>
  );
}
