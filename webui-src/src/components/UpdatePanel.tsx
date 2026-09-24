// UpdatePanel.tsx —— GitHub 自更新面板：检查远端 / 查看落后提交 / 一键拉取。
import { store, useStore } from "../store";
import { Shell } from "./Panels";

export default function UpdatePanel() {
  const st = useStore();
  const u = st.update;

  return (
    <Shell title="系统更新" onClose={() => store.setModal(null)} wide>
      <div className="upd-line mono">
        分支 {u.branch || "—"} · 本地 {u.current || "…"} → 远端 {u.remote || "…"}
      </div>
      {u.error ? <div className="panel-tip upd-err">{u.error}</div> : null}
      {u.behind > 0 ? (
        <>
          <div className="panel-tip">落后 {u.behind} 个提交，拉取后：</div>
          <div className="kx-log">
            {u.commits.map((c) => <div className="mono" key={c}>{c}</div>)}
          </div>
        </>
      ) : u.lastCheck ? (
        <div className="panel-tip">已是最新（{new Date(u.lastCheck).toLocaleTimeString()} 检查过）。</div>
      ) : (
        <div className="panel-tip">还没有检查结果。</div>
      )}
      {u.dirty.length ? (
        <div className="panel-tip">本地改动（拉取时 autostash 自动保住）：{u.dirty.join("、")}</div>
      ) : null}
      <div className="panel-actions">
        <button className="ghost" disabled={u.checking} onClick={() => store.checkUpdate()}>
          {u.checking ? "检查中…" : "检查更新"}
        </button>
        <button className="primary" disabled={u.applying || !u.behind} onClick={() => store.applyUpdate()}>
          {u.applying ? "拉取中…" : "拉取更新"}
        </button>
      </div>
      <p className="panel-tip">前端产物随仓库走，拉取后刷新页面即生效；src/ 后端代码改动需重启 node 进程。已连接时每 30 分钟自动检查一次，有新版本侧栏会出现红点。</p>
    </Shell>
  );
}
