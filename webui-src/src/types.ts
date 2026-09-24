// cws 桥协议（v0.2 + backend extensions）前端类型定义。
// 帧形状以 src/bridge.js / src/base-session.js 为准。

export type Backend = "claude" | "codex" | "openclaw";

export interface Channel {
  name: string;
  label?: string;
  base_url?: string;
  protocol?: string; // anthropic | openai | auto
  wire_api?: string; // responses | chat
  model?: string;
  models?: string[];
  key_tail?: string;
  default?: boolean;
}

export interface Gateway {
  name: string;
  url: string;
  agent?: string;
  token_tail?: string;
}

export interface BackendsInfo {
  claude_bin: string;
  codex_bin: string;
  default_backend: Backend;
  gateways: Gateway[];
}

/** send.images / user_msg.images：base64 裸数据（不带 data: 前缀） */
export interface ImgAttachment {
  media_type: string;
  data: string;
}

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: AskQuestionOption[];
}

export interface AskFrame {
  session_id: string;
  ask_id: string;
  kind: "permission" | "question";
  tool_name?: string;
  input?: {
    questions?: AskQuestion[];
    [k: string]: unknown;
  };
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  reasoning_tokens?: number;
}

export interface FinalFrame {
  post_type: "final";
  session_id: string;
  text?: string;
  mid?: string;
  usage?: Usage;
  cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  is_error?: boolean;
  subtype?: string;
}

export interface SessionInfo {
  session_id: string;
  alive: boolean;
  turn_active?: boolean;
  created_at?: number;
  last_turn_at?: number;
  last_msg_ts?: number;
  last_mid?: string;
  channel?: string | null;
  model?: string | null;
  backend: Backend;
  gateway?: string | null;
  permission_mode: string;
  title?: string;
  remark?: string;
  queued?: boolean;
  queue_position?: number;
  closed?: boolean;
  lazy?: boolean;
}

export type Msg =
  | { kind: "user"; mid?: string; text: string; images?: ImgAttachment[] }
  | { kind: "cc"; mid?: string; text: string }
  | { kind: "tool"; mid?: string; text: string; run?: boolean }
  | { kind: "sys"; text: string }
  | { kind: "stat"; text: string }
  | { kind: "ask"; ask: AskFrame; answered: null | "allow" | "deny" };

export interface SessionState {
  info: SessionInfo;
  msgs: Msg[];
  /** 当前轮 delta 累积缓冲（未封口） */
  streaming: string;
  /** thinking 帧的 tokens 估算；null = 未在思考 */
  thinking: number | null;
  /** 本连接生命周期内已见 ask_id */
  asked: Set<string>;
}

export interface Toast {
  id: number;
  text: string;
  kind: "" | "ok" | "err";
}

export type ModalState =
  | null
  | "new"
  | "channels"
  | "backends"
  | { kind: "remark"; sid: string };

export interface AppState {
  connected: boolean;
  /** 首次成功连接后置 true，此后断线仍停留在主界面（重连中） */
  entered: boolean;
  loginErr: string;
  sessions: Map<string, SessionState>;
  current: string | null;
  channels: Channel[];
  defaultChannel: string;
  backends: BackendsInfo | null;
  modal: ModalState;
  toasts: Toast[];
}
