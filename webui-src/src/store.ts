// store.ts —— 桥协议状态机：所有下行帧在此消化为响应式状态。
// 行为对齐旧版 webui/app.js（水位线增量同步、mid 去重、ask 双类卡片、
// new:echo 创建即打开、applied:false 提示等），并补全后台会话消息留存。

import { useSyncExternalStore } from "react";
import { Api, type Frame } from "./api";
import type {
  AppState, AskFrame, Backend, Channel, ImgAttachment, ModalState,
  SessionInfo, SessionState, Toast, UpdateState,
} from "./types";

export const PERM_OPTIONS: Record<Backend, [string, string][]> = {
  claude: [["default", "默认 · 按需询问"], ["acceptEdits", "接受编辑"], ["bypassPermissions", "完全允许"], ["plan", "只读规划"]],
  codex: [["read-only", "只读"], ["workspace-write", "工作区可写"], ["full-auto", "绕过审批与沙箱"], ["danger-full-access", "完全访问"]],
  openclaw: [["read-only", "只读"], ["guarded", "守护"], ["workspace", "工作区"], ["full", "完全"]],
};

export const BACKEND_LETTER: Record<Backend, string> = { claude: "C", codex: "X", openclaw: "O" };

function emptyInfo(sid: string): SessionInfo {
  return {
    session_id: sid, alive: false, turn_active: false, channel: null, model: null,
    backend: "claude", permission_mode: "default", title: "", queued: false,
  };
}

function fmtK(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

const listeners = new Set<() => void>();

class Store {
  update: UpdateState = { checking: false, applying: false, branch: "", current: "", remote: "", behind: 0, commits: [], dirty: [], error: "", lastCheck: 0 };

  state: AppState = {
    connected: false,
    entered: false,
    loginErr: "",
    view: "chat",
    sessions: new Map(),
    current: null,
    channels: [],
    defaultChannel: "",
    backends: null,
    modal: null,
    toasts: [],
    update: this.update,
    kxSteps: [],
  };

  api: Api | null = null;
  private toastSeq = 0;
  /** sid -> last mid（跨刷新持久化，键名与旧版一致以继承水位） */
  private marks: Record<string, string> = {};
  /** sid -> Set(mid)，本页面生命周期内去重 */
  private seen = new Map<string, Set<string>>();
  private pendingSid: string | null = null;
  /** echo -> kx.chat 应答回调（一问一答，超时自兜底） */
  private kxWaiters = new Map<string, (f: Frame) => void>();
  /** 自更新巡检定时器（登录一次即可） */
  private updTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    try { this.marks = JSON.parse(localStorage.getItem("cws_marks") || "{}"); } catch { this.marks = {}; }
  }

  // ---------- 响应式绑定 ----------
  subscribe = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
  getSnapshot = () => this.state;

  private touch() {
    this.state = { ...this.state };
    listeners.forEach((fn) => fn());
  }

  // ---------- 基础工具 ----------
  toast(text: string, kind: Toast["kind"] = "") {
    const id = ++this.toastSeq;
    this.state.toasts = [...this.state.toasts, { id, text, kind }];
    this.touch();
    setTimeout(() => {
      this.state.toasts = this.state.toasts.filter((t) => t.id !== id);
      this.touch();
    }, 5200);
  }

  sess(sid: string): SessionState {
    let s = this.state.sessions.get(sid);
    if (!s) {
      s = { info: emptyInfo(sid), msgs: [], streaming: "", thinking: null, asked: new Set() };
      this.state.sessions.set(sid, s);
    }
    return s;
  }

  currentSess(): SessionState | null {
    return this.state.current ? this.state.sessions.get(this.state.current) || null : null;
  }

  channelsForBackend(backend: string): Channel[] {
    if (backend === "openclaw") return [];
    return this.state.channels.filter((c) => {
      const p = c.protocol || "auto";
      if (p === "auto") return true;
      if (backend === "codex") return p !== "anthropic";
      if (backend === "claude") return p !== "openai";
      return false;
    });
  }

  private seenOf(sid: string): Set<string> {
    let set = this.seen.get(sid);
    if (!set) { set = new Set(); this.seen.set(sid, set); }
    return set;
  }

  private markSeen(sid: string, mid?: string) {
    if (!mid) return;
    this.seenOf(sid).add(mid);
    this.marks[sid] = mid;
    try { localStorage.setItem("cws_marks", JSON.stringify(this.marks)); } catch { /* ignore */ }
  }

  send(action: string, params: Frame = {}): string | null {
    return this.api ? this.api.send(action, params) : null;
  }

  setModal(m: ModalState) { this.state.modal = m; this.touch(); }

  /** 主区视图切换：卡西管理台 ↔ 会话聊天（进会话自动回聊天） */
  setView(v: "chat" | "kx") {
    if (this.state.view === v) return;
    this.state.view = v;
    this.touch();
  }

  // ---------- 连接生命周期 ----------
  boot() {
    const qp = new URLSearchParams(location.search);
    this.pendingSid = qp.get("sid");
    const qpToken = qp.get("token");
    const token = qpToken || sessionStorage.getItem("cws_token") || "";
    if (token) this.login(token);
  }

  login(token: string) {
    if (!token) return;
    sessionStorage.setItem("cws_token", token);
    if (!this.api) {
      this.api = new Api(
        (f) => this.handleFrame(f),
        (connected) => this.onStatus(connected),
      );
    }
    this.state.loginErr = "";
    this.api.connect(token);
  }

  private onStatus(connected: boolean) {
    this.state.connected = connected;
    if (connected) {
      this.state.entered = true;
      this.state.loginErr = "";
      this.send("channels.list");
      this.send("sessions.list");
      this.send("sessions.sync", { marks: this.marks, attach: this.state.current || undefined });
      // 直达会话：?sid=xxx 自动打开
      if (this.pendingSid && !this.state.current) {
        this.openChat(this.pendingSid);
      }
      this.pendingSid = null;
      // 自更新巡检：连接即查一次，此后每 30 分钟
      if (!this.updTimer) {
        this.send("update.check");
        this.updTimer = setInterval(() => this.send("update.check"), 30 * 60 * 1000);
      }
    } else if (!this.state.entered) {
      this.state.loginErr = "连接失败：Token 无效或服务不可达，将持续重试…";
    }
    this.touch();
  }

  // ---------- 会话动作 ----------
  openChat(sid: string) {
    this.state.view = "chat";
    if (this.state.current === sid) { this.touch(); return; }
    this.state.current = sid;
    const s = this.sess(sid);
    this.touch();
    // 已存在的会话：takeover（服务端会重绑连接并回放全量历史 + 悬挂 ask）
    this.send("new_session", { session_id: sid, permission_mode: s.info.permission_mode });
  }

  createSession(fields: {
    session_id?: string; backend: Backend; channel?: string; model?: string;
    permission_mode: string; gateway?: string; remote_key?: string;
  }) {
    if (!this.api) return;
    const echo = this.api.newEcho();
    const sid = fields.session_id?.trim() || undefined;
    if (sid) this.sess(sid); // 预建占位
    this.send("new_session", {
      session_id: sid, backend: fields.backend,
      channel: fields.channel || undefined, model: fields.model?.trim() || undefined,
      permission_mode: fields.permission_mode,
      gateway: fields.gateway?.trim() || undefined, remote_key: fields.remote_key?.trim() || undefined,
      echo,
    });
    // 指定 sid 的创建直接进入（session_ready 会带着 new:echo 再确认一次）
    if (sid) { this.state.current = sid; }
    this.state.view = "chat";
    this.state.modal = null;
    this.touch();
  }

  sendText(text: string, images?: ImgAttachment[]) {
    const sid = this.state.current;
    if (!sid || !text.trim()) return false;
    const s = this.sess(sid);
    if (images && images.length && s.info.backend !== "claude") {
      this.toast("仅 claude 后端支持发送图片", "err");
      return false;
    }
    this.send("send", {
      session_id: sid, text: text.trim(),
      permission_mode: s.info.permission_mode,
      ...(images && images.length ? { images } : {}),
    });
    return true;
  }

  stop(sid?: string) {
    const id = sid || this.state.current;
    if (id) this.send("stop", { session_id: id });
  }

  dropSession(sid: string) {
    this.send("drop_session", { session_id: sid });
    this.state.sessions.delete(sid);
    if (this.state.current === sid) this.state.current = null;
    delete this.marks[sid];
    this.seen.delete(sid);
    try { localStorage.setItem("cws_marks", JSON.stringify(this.marks)); } catch { /* ignore */ }
    this.touch();
  }

  setPermission(sid: string, mode: string) {
    this.send("set_permission", { session_id: sid, mode });
  }

  applyModel(sid: string, channel: string, model: string) {
    this.send("set_model", { session_id: sid, channel, model: model.trim() });
  }

  replyAsk(sid: string, askId: string, behavior: "allow" | "deny", message?: string, updatedInput?: unknown) {
    this.send("ask_reply", {
      session_id: sid, ask_id: askId, behavior,
      ...(message !== undefined ? { message } : {}),
      ...(updatedInput !== undefined ? { updatedInput } : {}),
    });
    // 乐观置为已处理，ask_replied 广播会再对齐一次
    const s = this.state.sessions.get(sid);
    if (s) {
      for (const m of s.msgs) {
        if (m.kind === "ask" && m.ask.ask_id === askId && m.answered === null) m.answered = behavior;
      }
    }
    this.touch();
  }

  setRemark(sid: string, remark: string) {
    this.send("session.remark", { session_id: sid, remark });
  }

  // ---------- 自更新 ----------
  checkUpdate() {
    if (!this.api?.ready || this.state.update.checking) return;
    this.state.update.checking = true;
    this.touch();
    this.send("update.check");
  }

  applyUpdate() {
    if (!this.api?.ready || this.state.update.applying) return;
    this.state.update.applying = true;
    this.touch();
    this.send("update.apply");
  }

  // ---------- 卡西（桥管理助手）代理 ----------
  /** 一问一答调用 kx.chat；透传 95s 兜底，agent 形态（服务端自跑循环）放宽到 timeoutMs */
  kxCall(params: Frame, timeoutMs = 95_000): Promise<Frame> {
    if (!this.api?.ready) return Promise.resolve({ ok: false, error: "未连接" });
    return new Promise((resolve) => {
      const echo = this.api!.rawEcho();
      this.kxWaiters.set(echo, resolve);
      this.send("kx.chat", { ...params, echo });
      setTimeout(() => {
        if (this.kxWaiters.delete(echo)) {
          this.state.kxSteps = [];
          resolve({ ok: false, error: "超时（" + Math.round(timeoutMs / 1000) + "s）" });
        }
      }, timeoutMs);
    });
  }

  // ---------- 下行帧处理 ----------
  handleFrame(f: Frame) {
    switch (f.post_type) {
      case "pong":
      case "sync_done":
      case "send_ack":
      case "stop_ack":
        break;
      case "session_ready": this.onSessionReady(f); break;
      case "session_queued": {
        const s = this.sess(f.session_id);
        s.info.queued = true;
        s.info.queue_position = f.position;
        this.touch();
        break;
      }
      case "sessions": {
        for (const it of (f.sessions || []) as SessionInfo[]) {
          const s = this.sess(it.session_id);
          Object.assign(s.info, it);
        }
        this.touch();
        break;
      }
      case "history": this.onHistory(f); break;
      case "user_msg": this.onUserMsg(f); break;
      case "cc_msg": this.onCcMsg(f); break;
      case "delta": {
        const s = this.sess(f.session_id);
        s.streaming += f.text || "";
        this.touch();
        break;
      }
      case "thinking": {
        const s = this.sess(f.session_id);
        s.thinking = f.tokens;
        this.touch();
        break;
      }
      case "tool_activity": this.onTool(f); break;
      case "ask": this.onAsk(f); break;
      case "ask_replied": {
        const s = this.state.sessions.get(f.session_id);
        if (s) {
          for (const m of s.msgs) {
            if (m.kind === "ask" && m.ask.ask_id === f.ask_id) m.answered = f.behavior;
          }
        }
        this.touch();
        break;
      }
      case "final": this.onFinal(f); break;
      case "turn_aborted": this.onAborted(f); break;
      case "session_closed": {
        const s = this.sess(f.session_id);
        s.info.alive = false;
        s.info.closed = true;
        s.info.queued = false;
        if (this.state.current === f.session_id) this.pushSys(s, "会话已关闭：" + (f.reason || ""));
        this.touch();
        break;
      }
      case "channels": {
        this.state.channels = f.channels || [];
        this.state.defaultChannel = f.default_channel || "";
        this.touch();
        break;
      }
      case "channels_saved":
        this.toast("渠道已保存：" + f.channel, "ok");
        this.send("channels.list");
        break;
      case "channels_deleted":
        this.toast("渠道已删除：" + f.channel);
        this.send("channels.list");
        break;
      case "channels_default":
        this.toast("默认渠道：" + (f.channel || "（机器默认）"), "ok");
        this.send("channels.list");
        break;
      case "channel_test":
        if (f.ok) this.toast(`渠道 ${f.channel} 连通 ✓ ${f.model || ""} ${f.latency_ms}ms`, "ok");
        else this.toast(`渠道 ${f.channel} 测试失败：${f.error}`, "err");
        break;
      case "channel_models":
        if (f.models && f.models.length) this.toast("模型列表：" + f.models.join("、"), "ok");
        else this.toast("拉取失败：" + (f.error || "空"), "err");
        break;
      case "permission_ack": {
        const s = this.sess(f.session_id);
        s.info.permission_mode = f.mode;
        this.toast("权限已切换：" + f.mode + (f.applied ? "" : "（下次生效）"), "ok");
        this.touch();
        break;
      }
      case "model_ack": {
        const s = this.sess(f.session_id);
        s.info.channel = f.channel || null;
        s.info.model = f.model || null;
        this.toast(f.applied ? "模型/渠道已切换" : "已记录，下次生效", "ok");
        this.touch();
        break;
      }
      case "backends": {
        this.state.backends = {
          claude_bin: f.claude_bin || "",
          codex_bin: f.codex_bin || "",
          default_backend: (f.default_backend || "claude") as Backend,
          gateways: (f.gateways || []).map((g: Frame) => ({
            name: g.name, url: g.url, agent: g.agent, token_tail: g.token_tail,
          })),
        };
        this.touch();
        break;
      }
      case "backends_saved":
        this.toast("后端配置已保存", "ok");
        this.send("backends.list");
        break;
      case "backend_test":
        this.toast(
          (f.target || "后端") + (f.ok ? ` ✓ ${(f.detail || "")} ${f.latency_ms}ms` : ` ✗ ${f.detail || ""}`),
          f.ok ? "ok" : "err",
        );
        break;
      case "session_remark": {
        const s = this.state.sessions.get(f.session_id);
        if (s) s.info.remark = f.remark || "";
        this.toast("备注已保存", "ok");
        this.touch();
        break;
      }
      case "update_state": {
        const u = this.state.update;
        const wasBehind = u.behind;
        if (f.ok) {
          Object.assign(u, {
            branch: f.branch || "", current: f.current || "", remote: f.remote || "",
            behind: f.behind || 0, commits: f.commits || [], dirty: f.dirty || [],
            error: "", lastCheck: Date.now(),
          });
        } else {
          u.error = f.error || "未知错误";
          u.lastCheck = Date.now();
        }
        u.checking = false;
        u.applying = false;
        this.touch();
        if (f.ok && f.phase === "check" && f.behind > 0 && wasBehind !== f.behind) {
          this.toast(`发现更新：落后 ${f.behind} 个提交（侧栏 · 系统更新）`);
        }
        if (f.ok && f.phase === "apply") {
          this.toast(f.behind ? "更新后仍落后 " + f.behind + " 个提交，请重试" : "已更新到 " + (f.current || "") + " · 前端刷新生效，后端重启生效", "ok");
        }
        break;
      }
      case "kx_step": {
        // 代理循环实时步骤：只上屏，不落对话历史（kx_reply.steps 会带回完整清单）
        this.state.kxSteps = [...this.state.kxSteps, { name: f.name || "", ok: !!f.ok, brief: f.brief || "" }];
        this.touch();
        break;
      }
      case "kx_reply": {
        const w = this.kxWaiters.get(f.echo);
        if (w) {
          this.kxWaiters.delete(f.echo);
          this.state.kxSteps = [];
          this.touch();
          w(f);
        } else if (!f.ok) this.toast("卡西请求失败：" + (f.error || ""), "err");
        break;
      }
      case "error": this.onError(f); break;
      default:
        console.log("unhandled", f);
    }
  }

  private onSessionReady(f: Frame) {
    const s = this.sess(f.session_id);
    Object.assign(s.info, {
      alive: true,
      turn_active: !!f.turn_active,
      channel: f.channel || null,
      model: f.model || null,
      backend: (f.backend || s.info.backend || "claude") as Backend,
      permission_mode: f.permission_mode || s.info.permission_mode || "default",
      queued: false,
      closed: false,
    });
    if (!s.info.title) s.info.title = "会话 " + f.session_id.slice(0, 12);
    // 创建即打开：new: 前缀 echo 是客户端约定（bridge 原样回传）
    if (typeof f.echo === "string" && f.echo.startsWith("new:")) {
      this.state.current = f.session_id;
    }
    this.touch();
  }

  private sealStreaming(s: SessionState) {
    s.streaming = "";
    s.thinking = null;
  }

  /** 本轮工具卡收尾：running -> done */
  private sealTools(s: SessionState) {
    for (const m of s.msgs) if (m.kind === "tool" && m.run) m.run = false;
  }

  private onUserMsg(f: Frame) {
    const s = this.sess(f.session_id);
    if (f.mid && this.seenOf(f.session_id).has(f.mid)) return;
    this.markSeen(f.session_id, f.mid);
    this.sealStreaming(s);
    s.msgs.push({ kind: "user", mid: f.mid, text: f.text || "", images: f.images });
    s.info.turn_active = true;
    s.info.queued = false;
    s.info.last_msg_ts = Date.now() / 1000;
    s.info.title = (f.text || "").split("\n")[0].slice(0, 24) || s.info.title;
    this.touch();
  }

  private onCcMsg(f: Frame) {
    const s = this.sess(f.session_id);
    if (f.mid && this.seenOf(f.session_id).has(f.mid)) return;
    this.markSeen(f.session_id, f.mid);
    this.sealStreaming(s);
    s.msgs.push({ kind: "cc", mid: f.mid, text: f.text || "" });
    this.touch();
  }

  private onTool(f: Frame) {
    const s = this.sess(f.session_id);
    this.markSeen(f.session_id, f.mid);
    this.sealStreaming(s);
    this.sealTools(s);
    s.msgs.push({ kind: "tool", mid: f.mid, text: `${f.tool}：${f.brief || ""}`, run: true });
    this.touch();
  }

  private onHistory(f: Frame) {
    const s = this.sess(f.session_id);
    const seen = this.seenOf(f.session_id);
    for (const e of (f.messages || []) as { id?: string; ts?: number; role: string; text: string }[]) {
      if (e.id && seen.has(e.id)) continue;
      if (e.id) this.markSeen(f.session_id, e.id);
      if (e.role === "user") s.msgs.push({ kind: "user", mid: e.id, text: e.text });
      else if (e.role === "cc") s.msgs.push({ kind: "cc", mid: e.id, text: e.text });
      else if (e.role === "tool") s.msgs.push({ kind: "tool", mid: e.id, text: e.text, run: false });
      else if (e.role === "sys") s.msgs.push({ kind: "sys", text: e.text });
    }
    if (f.last_mid) this.markSeen(f.session_id, f.last_mid);
    this.sealTools(s);
    this.touch();
  }

  private onFinal(f: Frame) {
    const s = this.sess(f.session_id);
    if (f.mid) {
      if (!this.seenOf(f.session_id).has(f.mid)) {
        this.markSeen(f.session_id, f.mid);
        this.sealStreaming(s);
        if (f.text) s.msgs.push({ kind: "cc", mid: f.mid, text: f.text });
      }
    } else {
      this.sealStreaming(s);
      if (f.text) s.msgs.push({ kind: "cc", text: f.text });
    }
    s.info.turn_active = false;
    this.sealTools(s);
    if (f.is_error) this.pushSys(s, "⚠ 本轮错误结束");
    // 用量小字：时长 / tokens / 花费 / 轮数
    const parts: string[] = [];
    if (f.duration_ms != null) parts.push((f.duration_ms / 1000).toFixed(1) + "s");
    const u = f.usage || {};
    const tin = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
    if (tin || u.output_tokens) parts.push(`↓${fmtK(tin)} ↑${fmtK(u.output_tokens || 0)} tok`);
    if (u.reasoning_tokens) parts.push(`思 ${fmtK(u.reasoning_tokens)}`);
    if (f.cost_usd != null) parts.push("$" + Number(f.cost_usd).toFixed(4));
    if (f.num_turns != null) parts.push(f.num_turns + " 轮");
    if (parts.length) s.msgs.push({ kind: "stat", text: parts.join(" · ") });
    this.touch();
  }

  private onAborted(f: Frame) {
    const s = this.sess(f.session_id);
    s.info.turn_active = false;
    this.sealStreaming(s);
    this.sealTools(s);
    this.pushSys(s, "已中断：" + (f.reason || ""));
    this.touch();
  }

  private pushSys(s: SessionState, text: string) {
    s.msgs.push({ kind: "sys", text });
  }

  private onAsk(f: Frame) {
    const s = this.sess(f.session_id);
    const ask = f as unknown as AskFrame;
    if (s.asked.has(f.ask_id)) {
      // takeover / 重连时服务端重发悬挂 ask：原位刷新
      for (const m of s.msgs) {
        if (m.kind === "ask" && m.ask.ask_id === f.ask_id) m.ask = ask;
      }
      this.touch();
      return;
    }
    s.asked.add(f.ask_id);
    s.msgs.push({ kind: "ask", ask, answered: null });
    this.touch();
  }

  private onError(f: Frame) {
    // 悬挂 ask 超时/失效：把卡片置为已处理
    if ((f.code === "ask_timeout" || f.code === "unknown_ask") && f.ask_id && f.session_id) {
      const s = this.state.sessions.get(f.session_id);
      if (s) {
        for (const m of s.msgs) {
          if (m.kind === "ask" && m.ask.ask_id === f.ask_id && m.answered === null) m.answered = "deny";
        }
      }
      if (f.code === "ask_timeout") { this.toast("询问已超时自动拒绝", "err"); this.touch(); return; }
    }
    if (f.code === "busy") { this.toast(f.session_id + " 正在运行，请稍候", "err"); return; }
    this.toast((f.code || "error") + (f.message ? "：" + f.message : ""), "err");
  }
}

export const store = new Store();

export function useStore(): AppState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
