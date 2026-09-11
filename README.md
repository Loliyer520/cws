# cc-bridge — Claude Code 多会话 WebSocket 桥（协议 v0.2）

基于 Claude Code CLI（`claude -p` stream-json 模式）的多会话 WebSocket 桥服务。
按 claude 2.1.263 实测帧结构实现（2026-09-07，<your-server>）。

## 部署（64 服务器）

- 目录：`/my/run/cws/`（bridge.py / config.json / channels.json / secrets.json(600) / workspaces/ / venv/）
- 服务：`/etc/systemd/system/cws.service`，`systemctl start cws`
- 端口：`0.0.0.0:8642`，WS 路径 `/ws`（UFW 已放行 8642/tcp）
- 鉴权：query 参数 `?token=<hex>`，token 在 `/my/run/cws/secrets.json`（600 权限）
- 桥自带 access log 屏蔽（请求行带 token，永不落日志）

```bash
ssh root@<your-server>
cat /my/run/cws/secrets.json       # 查看 token（600 仅 root）
systemctl status cws
journalctl -u cws -f               # 日志（不含消息正文与 token）
```

## 配置文件（三层拆分，开源友好）

| 文件 | 内容 | 是否提交 |
|---|---|---|
| `config.json` | 非机密运行参数 | 可提交（本仓库以 `config.example.json` 提供模板） |
| `channels.json` | 渠道列表（name/label/base_url/model + `api_key_env`），**不含 key** | 可提交 |
| `secrets.json` | 机密：`token` / `one_time_tokens` / 各渠道 `api_keys` | **gitignore，0600** |

加载顺序：`config.json` ← `channels.json` ← `secrets.json`（后者覆盖前者）。
渠道 `api_key` 解析优先级：内联 `api_key` > `secrets.json` 的 `api_keys[name]` >
环境变量（渠道里 `api_key_env` 指定的变量名）。

### config.json

```json
{
  "port": 8642,
  "claude_bin": "/usr/local/bin/claude",
  "max_active_sessions": 3,
  "queue_max": 5,
  "turn_timeout": 300,
  "ask_timeout": 120,
  "min_turn_interval": 2,
  "idle_timeout_s": 1800,
  "allowed_tools": "Read,Grep,Glob,AskUserQuestion",
  "permission_mode": "default"
}
```

### channels.json

```json
{
  "api_channels": [
    {
      "name": "glm",
      "label": "GLM-5.3",
      "base_url": "https://open.bigmodel.cn/api/anthropic",
      "model": "glm-5.3",
      "api_key_env": "CWS_APIKEY_GLM"
    }
  ],
  "default_channel": "glm"
}
```

### secrets.json（参照 secrets.example.json，0600）

```json
{
  "token": "<32+ hex，随机生成>",
  "one_time_tokens": [],
  "api_keys": { "glm": "sk-..." }
}
```

运行期变更（一次性 token 消费、渠道增删改）会自动写回对应文件；
从环境变量解析的 key 永远不会落盘。

限流（智谱 coding plan 友好）：全局活跃 claude 进程 ≤ `max_active_sessions`；
全局 turn 启动间隔 ≥ `min_turn_interval` 秒；单 session 并发 1（busy 报错）；
超限 new_session 排队（上限 `queue_max`，回 `session_queued`）。

## 连接

```
ws://<your-server>:8642/ws?token=<hex>
```

## 帧协议

客户端→桥（JSON，每帧一个对象）：

```json
{"action": "new_session", "params": {"session_id": "可选,字母数字-_", "resume": false}, "echo": "e1"}
{"action": "send",  "params": {"session_id": "s1", "text": "你好"}, "echo": "e2"}
{"action": "stop",  "params": {"session_id": "s1"}, "echo": "e3"}
{"action": "drop_session", "params": {"session_id": "s1"}, "echo": "e4"}
{"action": "sessions.list", "params": {}, "echo": "e5"}
{"action": "ask_reply", "params": {"session_id": "s1", "ask_id": "<来自ask事件>", "behavior": "allow|deny", "message": "deny时可附原因", "updatedInput": {"...": "allow时可选,替换工具输入"}}, "echo": "e6"}
{"action": "ping", "params": {}, "echo": "e7"}
```

桥→客户端（`post_type` 区分）：

| post_type | 说明 | 关键字段 |
|---|---|---|
| `session_ready` | claude 进程 init 完成 | session_id, model |
| `session_queued` | 排队中 | session_id, position |
| `delta` | assistant 文本增量（stream_event text_delta） | text |
| `tool_activity` | 工具调用开始 | tool, brief(输入摘要≤80字) |
| `final` | turn 结束（result 帧） | text, usage{input_tokens,output_tokens,cache_read_input_tokens}, cost_usd, duration_ms, num_turns, is_error, subtype |
| `turn_aborted` | stop/超时/进程退出 | reason(user/timeout/process_exited) |
| `ask` | 权限请求（can_use_tool） | ask_id, kind(permission/question), tool_name, input |
| `error` | 错误 | code(busy/unknown_session/ask_timeout/queue_full/...), message |
| `session_closed` | 会话关闭 | reason(dropped/owner_disconnected/idle_timeout) |
| `pong` | ping 应答 | ts |

echo 原样回传，用于请求-响应关联。

## 会话生命周期

- `new_session` 启动常驻 `claude` 子进程（独立进程组，工作目录
  `/my/run/cws/workspaces/<session_id>/`）。对外 session_id 任意（字母数字-_），
  对内映射为固定 UUID（uuid5）传给 CLI。
- `send` 写入一行 user 消息；turn 期间再 send → `error busy`。
- `stop` → SIGTERM 进程组 → `turn_aborted`；**下次 send 自动用
  `--resume <uuid>` 重启续上下文**（磁盘有该会话历史文件时必须用 --resume，
  实测 --session-id 会报 "Session ID ... is already in use"；SIGTERM(143)
  后 --resume 上下文完好）。
- `drop_session` 杀进程并关闭会话。客户端断开 → 其名下会话全部关闭（不留孤儿）。
- 空闲 `idle_timeout_s`（默认 30 分钟）自动关闭（同样可 resume 恢复）。

## 权限/提问（实测 v2.1.263）

- CLI 需 `--permission-prompt-tool stdio` + 首帧 `initialize` 握手，
  `can_use_tool` 才会上 stdout（桥已处理，客户端无感）。注意：stdio 模式下
  CLI 不再主动发 system init 帧，握手 response 即视为进程就绪（桥发
  session_ready，之后 init 帧到达会补全 model 等字段语义）。
- **只读操作不弹权限**：--allowed-tools 白名单内的 Read/Grep/Glob，以及
  Bash 只读命令（如 ls）由 CLI 静态放行直接执行。
- 写文件 / 非白名单工具 → `ask` 事件（kind=permission）→ 客户端 `ask_reply`
  allow/deny。deny 后模型收到拒绝原因并继续 turn（final 会说明被拒）。
- **AskUserQuestion 实测可用**：stdio 模式下模型调用该工具会以
  `ask(kind=question)` 上报，`input.questions` 结构
  `[{question, header, options:[{label,description}], multiSelect}]`。
  答复：`ask_reply{behavior:"allow", updatedInput:<原input>,
  updatedInput.answers:{<question 原文>: <label>}}`——**answers 的 key 是
  问题原文而非 header**（CLI 源码 `call({answers})` 按 `answers[question]`
  取值，实测回填后模型正确说出所选颜色）。
- `ask` 120s 未答复按 deny 处理并回 `error ask_timeout`（实测：超时后
  模型转为纯文本提问，turn 正常结束）。
- AskUserQuestion 不在 system init 的 tools 列表里（CLI 工具表未注册），
  是否触发取决于模型自发调用；桥两侧（permission/question）都已接好。

## stream-json 帧结构（实测摘要）

```
system   {type:"system", subtype:"init", session_id, model, tools[...], ...}
         {type:"system", subtype:"status", status:"requesting"}
stream_event {type:"stream_event", event:{type:"content_block_delta",
             delta:{type:"text_delta", text:"..."}}}   -- --include-partial-messages
assistant {type:"assistant", message:{content:[{type:"text"|"tool_use"|"thinking",...}]}}
user      {type:"user", message:{content:[{type:"tool_result", tool_use_id, content}]}}
result    {type:"result", subtype:"success"|"error_during_execution", result,
           usage{...}, total_cost_usd, duration_ms, num_turns, is_error,
           permission_denials[...]}
```

补充实测：

- 中途 interrupt（CLI 收 `{type:"control_request",request:{subtype:"interrupt"}}`）
  → result `subtype=error_during_execution, is_error=true`；桥的 stop 不走
  interrupt，直接 SIGTERM 进程组更干净。
- 控制台 stderr：glm 模型名会触发 `[claude-code:unrecognized_model]`
  噪音（generate_session_title/query_source=sdk），不影响出活，桥直接丢弃 stderr。
- 无 HOME 环境下 claude 也能跑（systemd 默认环境即可），但必须保证 PATH
  里有 node（service 已内置 Environment=PATH=...）。
control_request {type:"control_request", request_id,
           request:{subtype:"can_use_tool", tool_name, input, ...}}
control_response（桥→CLI 回复）{type:"control_response", response:
           {subtype:"success", request_id, response:{behavior:"allow"|
           "deny", message?, updatedInput?}}}
```

写入 CLI：`{"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]},"parent_tool_use_id":null,"session_id":<sid>}`

打断：桥不主动用 interrupt（result 会变 error_during_execution）；stop 直接
SIGTERM 杀进程组，更干净（143 退出，--resume 后上下文完好）。

## 客户端示例（python）

```python
import asyncio, aiohttp, json

TOKEN = open("/my/run/cws/secrets.json").read()  # 或其他安全方式读取
TOKEN = json.loads(TOKEN)["token"]

async def main():
    ws = (await aiohttp.ClientSession().ws_connect(
        f"ws://<your-server>:8642/ws?token={TOKEN}"))
    await ws.send_str(json.dumps({"action":"new_session","params":{"session_id":"demo"},"echo":"e1"}))
    # 收 session_ready 后：
    await ws.send_str(json.dumps({"action":"send","params":{"session_id":"demo","text":"1+1只回答数字"},"echo":"e2"}))
    async for msg in ws:
        ev = json.loads(msg.data)
        print(ev["post_type"], ev)
        if ev["post_type"] == "final":
            break

asyncio.run(main())
```

完整验收客户端见 `wsclient.py`（6 个场景 + 汇总）。

## 安全

- token 600 权限存 secrets.json；日志/命令行/汇报不出现 token。
- 每会话独立工作目录；桥以 root 运行（claude 需读 /root/.claude/settings.json）。
- 日志只记会话/turn 元数据与错误，不含用户消息正文。
