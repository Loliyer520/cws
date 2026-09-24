// api.ts —— 桥 WS 传输层：连接 / 断线重连 / action 发送。
// 帧内容解析与状态机在 store.ts。

export type Frame = Record<string, any>;

export class Api {
  private ws: WebSocket | null = null;
  private echo = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private token = "";
  /** 首次 open 前失败（多为 token 错）时置 true，供登录页提示 */
  everConnected = false;
  stopped = false;

  constructor(
    private onFrame: (f: Frame) => void,
    private onStatus: (connected: boolean, everConnected: boolean) => void,
  ) {}

  connect(token: string) {
    this.token = token;
    this.stopped = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(proto + "//" + location.host + "/ws?token=" + encodeURIComponent(token));
    this.ws = ws;
    ws.onopen = () => {
      this.everConnected = true;
      this.onStatus(true, true);
    };
    ws.onmessage = (ev) => {
      let frame: Frame;
      try { frame = JSON.parse(ev.data as string); } catch { return; }
      this.onFrame(frame);
    };
    ws.onclose = () => {
      const wasEver = this.everConnected;
      this.onStatus(false, wasEver);
      if (this.stopped) return;
      this.timer = setTimeout(() => this.connect(this.token), 5000);
    };
    ws.onerror = () => { /* onclose 会跟着来 */ };
  }

  get ready() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** 发送 action；返回 echo 标签（连接未就绪时返回 null） */
  send(action: string, params: Frame = {}): string | null {
    if (!this.ready) return null;
    this.echo += 1;
    const echo = "e" + this.echo;
    this.ws!.send(JSON.stringify({ action, params, echo }));
    return echo;
  }

  /** 造一个 new: 前缀的 echo（创建会话后自动打开的约定，bridge 会原样回传） */
  newEcho(): string {
    this.echo += 1;
    return "new:" + this.echo;
  }

  /** 普通 echo（kx.chat 等一问一答动作的应答关联） */
  rawEcho(): string {
    this.echo += 1;
    return "q" + this.echo;
  }

  destroy() {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
  }
}
