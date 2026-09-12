# OpenClaw（龙虾）协议研究报告

> 调研日期 2026-09-12。信息来源:docs.openclaw.ai / docs2.openclaw.ai(llms.txt 全量索引)、
> github.com/openclaw/openclaw 源码(codex-rs 对照)、clawbrain.dev 官方文档。

## 0. 结论先行

**龙虾 = OpenClaw**,一个开源(Node.js/TypeScript 单仓)的**自托管 AI Agent 网关**:
把 Discord/Telegram/WhatsApp/Slack/iMessage 等 IM 渠道接到 AI 编程 Agent
(Claude Code、Codex、ACP agents),自带 ClawHub、Control UI、WebChat 等界面。
**ClawBrain(clawbrain.dev)是它的托管商业版**(owl- 开头 key、模型如 claude-sonnet)。

cws 的对接定位(最终落地方案):

- **OpenClaw = 平级后端**。cws 用官方 `@openclaw/gateway-client` 走 **Gateway WS
  协议 v4** 直连远程网关,遥控其会话:chat.send 发消息、chat 事件流(delta/final)、
  session.approval → approval.resolve 审批、sessions.patch 切模型/权限、chat.history
  拉历史。**已用本地 mock 网关端到端实测通过(9.openclaw_basic)。**
- 原「上游模型路径」(codex → OpenClaw /v1/responses)仍可用作把 OpenClaw 当模型端点,
  但那不是「遥控」,仅作参考,见 §1。

## 1. HTTP API(上游模型路径用这层)

Gateway 在自身端口(默认 18789)上多路复用 HTTP:

| 端点 | 说明 | 默认 |
|---|---|---|
| POST /v1/chat/completions | OpenAI 兼容(SSE 流式、function tools 子集) | 关闭,配置开启 |
| POST /v1/responses | OpenResponses 兼容(SSE 流式) | 关闭,配置开启 |
| GET /v1/models · GET /v1/models/{id} | 列出 agent 目标(非后端模型) | 随上述端点 |
| POST /v1/embeddings | 嵌入 | 随上述端点 |
| POST /tools/invoke | 直接调用单个 Gateway 工具 | 始终开启 |

配置示例(openclaw.json5):

```json5
{
  gateway: { http: { endpoints: {
    chatCompletions: { enabled: true },
    responses: { enabled: true },
  } } },
}
```

### 鉴权

- gateway.auth.mode="token"|"password" → Authorization: Bearer <token>
  (OPENCLAW_GATEWAY_TOKEN / OPENCLAW_GATEWAY_PASSWORD)
- "trusted-proxy" → 身份代理注入头;"none" → 仅私网无鉴权
- 共享密钥持有者 = **全量 operator 权限**(等价 owner 凭据),只应绑 loopback/私网

### Agent-first 模型契约(重要)

model 字段不是上游模型 id,而是 **agent 目标**:

| model 值 | 路由 |
|---|---|
| openclaw / openclaw/default | 默认 agent |
| openclaw/<agentId> / agent:<agentId> | 指定 agent |

后端模型覆盖用请求头 x-openclaw-model: <provider/model>;
x-openclaw-agent-id 选 agent;x-openclaw-session-key 指定会话(保留命名空间
subagent:/cron:/acp: 拒绝);x-openclaw-message-channel 设定合成入口渠道。

### 会话

- 默认每请求无状态;**请求体 user 字段派生出稳定会话 key**,同值复用即续聊
- x-openclaw-session-key 显式路由(需 operator.admin)
- OpenResponses: previous_response_id 复用上一响应会话

### 流式(SSE)

- stream:true → text/event-stream,每行 data: <json>,结束 data: [DONE]
- chat completions: assistant role delta → content delta → delta.tool_calls
  增量 → finish_reason chunk;stream_options.include_usage 给用量
- responses: response.created / response.output_item.added /
  response.output_text.delta / response.output_item.done / response.completed
  (事件结构已按 openai/codex 源码 codex-api/src/sse/responses.rs 逐字段核对)
- 断开客户端 = 取消该次 agent run

### 限制

- 请求体 20MB、每消息 8 张图、20MB 累计图片;图片 URL 默认拒绝(allowUrl=false)
- max_completion_tokens/max_tokens/temperature/top_p/stop/seed 等
  best-effort 转发;越界 400

## 2. Gateway WS 协议 v4(原生控制面,深度对接用)

WebSocket 文本帧 JSON。npm 包:@openclaw/gateway-protocol(TypeBox schema)、
@openclaw/gateway-client(参考客户端,含 browser 入口)。

帧形状:

```jsonc
{"type":"req","id":"…","method":"connect","params":{…}}   // 请求
{"type":"res","id":"…","ok":true,"payload":{…}}           // 响应
{"type":"event","event":"…","payload":{…},"seq":…}       // 事件
```

握手:Gateway 先发 connect.challenge{nonce,ts} → 客户端发
connect{minProtocol,maxProtocol,client,role,scopes,caps,auth,device} →
回 hello-ok{protocol,server,features,snapshot,auth{role,scopes,deviceToken},
policy{maxPayload,maxBufferedBytes,…}}。当前协议版本 4,N-1 兼容窗口。

角色/作用域:operator / node;作用域如 operator.admin、operator.approvals、
operator.read、operator.write、operator.pairing、operator.talk.secrets。
缺 scope → FORBIDDEN + MISSING_SCOPE 结构化 details。

RPC 方法族(见 docs llms.txt 全表):system/identity、models/usage、
channels/login、chat/talk、sessions(含 bootstrap/events)、config(热更新/写入冲突守卫)、
agents、nodes/pairing、approvals、ledgers(审计/任务)、operator 辅助方法。
副作用方法要求幂等键。WS ping/pong 保活;permessage-deflate 可选。

鉴权路径:共享密钥(token/password 任一字段)→ 配对后下发 **device token**
(带角色+授权 scope,客户端持久化复用);支持 TLS 指纹 pinning、setup-code bootstrap。

## 3. 与 CLI 生态的关系

- OpenClaw 自带 **CLI 后端**机制(claude-cli 插件默认注册):把本机
  claude/codex 之类 CLI 当文本兜底/降级路径,JSONL 流式、会话、图片透传。
  模型名形如 claude-cli/claude-sonnet-5。
- 完整 harness 场景走 **ACP agents**(会话控制、后台任务、线程绑定)。
- 也就是说 OpenClaw 自己在做与 cws 部分重叠的事;两者关系是
  **cws(细粒度多会话桥) ↔ OpenClaw(IM 渠道+编排网关)**,cws 可作其
  上游模型供给,也可作其 Gateway client 界面。

## 4. cws 已实现的对接(实测记录)

渠道(channels.json 内置):

```json
{ "name": "openclaw", "label": "OpenClaw 龙虾（自建 Gateway）",
  "base_url": "http://127.0.0.1:18789/v1", "protocol": "openai",
  "wire_api": "responses", "model": "openclaw/default",
  "models": ["openclaw", "openclaw/default"],
  "api_key_env": "CWS_APIKEY_OPENCLAW",
  "http_headers": { "x-openclaw-session-key": "{session_id}" } }
```

- codex 适配器按 wire_api 生成 provider 配置;{session_id} 占位符在 spawn
  时替换为会话 uuid5 → 每次 codex exec 带同一 x-openclaw-session-key,
  OpenClaw 侧会话跨轮延续。
- **实测关键**:codex 0.154.0 已移除 wire_api="chat"(报错
  "wire_api = chat is no longer supported"→ 必须 responses)——恰好与 OpenClaw
  的 /v1/responses 对齐;适配器默认值已改为 responses。
- 渠道探测(channel.test/channel.models)已按 protocol 分流:
  openai→/v1/chat/completions+/v1/models(Bearer),anthropic→/v1/messages;
  base_url 带/不带尾部 /v1 两种约定自动适配。
- **端到端验收**:真实 codex 0.154.0 + 桥(codex 后端、openclaw 渠道)→
  OpenResponses SSE mock → delta="2" → final.text="2",is_error=false。
  期间按 codex 源码修正了两处:(a) codex 只发 item.completed(无 started/
  updated)时文本提取;(b) SSE 事件序列需含带 role 的 output_item.added
  与 output_item.done。

ClawBrain 托管版(channels.json 的 longxia)同样走 responses(模型如
claude-sonnet,key 形如 owl-…);base_url https://api.clawbrain.dev/v1。

## 5. 后续可做(未实现)

- **Gateway client 适配器**:cws 以 @openclaw/gateway-client 语义实现
  connect/hello-ok + sessions/talk/approvals RPC,把 OpenClaw 会话镜像进
  cws WebUI(或反向:把 cws 会话暴露成 OpenClaw 的一个 channel)。
- chat completions 后端:若不想经 codex,可让 cws 直接调
  /v1/chat/completions(SSE)自建 OpenClaw 适配器。
- device-token 持久化与配对流程(移动端友好)。

