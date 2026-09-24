// App.tsx —— 壳：启动画面 / 登录 / 主布局 / 模态路由。
// 布局与视觉语言移植自 kawork（纸墨风），功能对齐 cws 桥协议。
import { useEffect, useState } from "react";
import { store, useStore } from "./store";
import { IconBridge } from "./icons";
import Sidebar from "./components/Sidebar";
import ChatHead from "./components/ChatHead";
import ChatView from "./components/ChatView";
import Composer from "./components/Composer";
import Toasts from "./components/Toasts";
import { BackendsPanel, ChannelsPanel, NewSessionPanel, RemarkPanel } from "./components/Panels";
import KxPanel from "./components/KxPanel";
import UpdatePanel from "./components/UpdatePanel";

function Splash({ out }: { out: boolean }) {
  return (
    <div className={"splash" + (out ? " out" : "")}>
      <div className="splash-inner">
        <div className="splash-mark"><IconBridge size={44} /></div>
        <div className="splash-line">cws</div>
        <div className="splash-sub">Console · 多会话桥</div>
      </div>
    </div>
  );
}

function Login() {
  const st = useStore();
  const [token, setToken] = useState(sessionStorage.getItem("cws_token") || "");
  return (
    <div className="overlay">
      <div className="panel login-panel">
        <div className="login-mark"><IconBridge size={34} /></div>
        <h2>cws 控制台</h2>
        <p className="panel-tip">多会话 WebSocket 桥 · Claude Code / Codex / OpenClaw</p>
        <input
          type="password"
          autoFocus
          placeholder="访问 Token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && token.trim()) store.login(token.trim()); }}
        />
        <div className="panel-actions">
          <button className="primary" disabled={!token.trim()} onClick={() => store.login(token.trim())}>进入控制台</button>
        </div>
        {st.loginErr ? <div className="login-err">{st.loginErr}</div> : null}
      </div>
    </div>
  );
}

function Main() {
  const st = useStore();
  const [drawer, setDrawer] = useState(false);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("cws_sidebar") === "collapsed");

  const toggleNav = () => {
    if (window.matchMedia("(max-width: 720px)").matches) setDrawer((v) => !v);
    else {
      setCollapsed((v) => {
        localStorage.setItem("cws_sidebar", v ? "open" : "collapsed");
        return !v;
      });
    }
  };

  return (
    <div className="app">
      <div className={"sidebar-wrap" + (drawer ? " open" : "") + (collapsed ? " collapsed" : "")}>
        {drawer ? <div className="backdrop" onClick={() => setDrawer(false)} /> : null}
        <Sidebar onNavigate={() => setDrawer(false)} />
      </div>
      <div className="main-col">
        <ChatHead onNav={toggleNav} />
        {st.current ? <ChatView /> : (
          <div className="scroll">
            <div className="empty">
              <div className="empty-kicker">CWS CONSOLE</div>
              <h1>今天聊点什么？</h1>
              <p>claude / codex / openclaw 三后端 · 权限审批 · 渠道统一管理</p>
              <button className="primary" onClick={() => store.setModal("new")}>＋ 新建会话</button>
            </div>
          </div>
        )}
        {st.current ? <Composer /> : null}
      </div>
    </div>
  );
}

export default function App() {
  const st = useStore();
  const [splashOut, setSplashOut] = useState(false);
  const [splashGone, setSplashGone] = useState(false);

  useEffect(() => {
    store.boot();
    const t1 = setTimeout(() => setSplashOut(true), 2400);
    const t2 = setTimeout(() => setSplashGone(true), 3000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, []);

  return (
    <>
      {!splashGone && <Splash out={splashOut} />}
      {st.entered ? <Main /> : <Login />}
      {st.modal === "new" && <NewSessionPanel />}
      {st.modal === "channels" && <ChannelsPanel />}
      {st.modal === "backends" && <BackendsPanel />}
      {st.modal === "kx" && <KxPanel />}
      {st.modal === "update" && <UpdatePanel />}
      {(() => {
        const m = st.modal;
        return m !== null && typeof m === "object" && m.kind === "remark" ? <RemarkPanel sid={m.sid} /> : null;
      })()}
      <Toasts />
    </>
  );
}
