# cws Node v2 验收实测记录（2026-09-12）

环境：WSL2 Ubuntu（/mnt/c/Users/loliyc/Documents/Code/cws），Node v22.23.2，
codex CLI 0.154.0（npm @openai/codex）。本地验证用 scripts/mock-claude.mjs /
scripts/mock-codex.mjs 全协议 mock（免 key），真实 codex 只做无鉴权冒烟。

## 一、协议验收（mock CLI，8/8 PASS → SUMMARY_OK）

| # | 场景 | 结果 | 证据 |
|---|------|------|------|
| 1 | claude new_session+send "1+1" | OK | final.text="2" |
| 2 | claude 两会话并行 | OK | f1="18" f2="16" |
| 3 | claude Bash 写文件→ask→deny | OK | ask(tool=Bash,kind=permission)→final"工具调用被拒绝" |
| 4 | claude AskUserQuestion | OK | questions 结构完整→answers 按问题原文回填→final"你选了蓝" |
| 5 | claude stop→turn_aborted(user)→send 续聊 | OK | abort.reason=user，续轮 final 正常 |
| 6 | ping/sessions.list/错 token 401 | OK | pong 回显 echo；401 拒绝握手 |
| 7 | codex new_session(backend=codex)+send | OK | final.text="2"（JSONL→v0.2 帧映射正确） |
| 8 | codex 流式中途 stop | OK | turn_aborted(reason=user) |

## 二、真实 codex CLI 冒烟（0.154.0）

- codex exec --help 实测确认：--json、--skip-git-repo-check、--color、
  -c/--config（支持点路径）、-s/--sandbox（read-only/workspace-write/
  danger-full-access）、resume <SESSION_ID> [PROMPT] 子命令；**0.154.0 已移除
  --full-auto**（适配器 full-auto 档改为 --dangerously-bypass-approvals-and-sandbox）。
- 桥内真实起 codex exec --json：收到 thread.started(uuid)、turn.started、
  error 事件（本机无外网/未登录 → "Reconnecting... request timed out"）→
  桥正确产出 final{is_error:true, subtype:error_during_execution}。
  事件结构与 openai/codex 源码 codex-rs/exec/src/exec_events.rs 一致
  （ThreadItem 用 type 字段，snake_case：agent_message/reasoning/
  command_execution/file_change/mcp_tool_call/web_search/todo_list）。
- 结论：适配器与真实 CLI 的参数/事件协议对齐；实弹出活需渠道 key 或 CODEX_API_KEY。

## 三、WebUI / 渠道管理

- 静态服务：/ →200、/app.js →200、/style.css →200；路径穿越 /../config.json →404。
- 渠道 roundtrip：channels.list(4 渠道,含 longxia protocol=auto) →
  set_default(longxia) → save(tmptest) → delete(tmptest) → 默认回落清空 OK；
  persist 后 secrets.json 无残留 key、channels.json 正确。

## 四、重构中踩掉的坑（Node 特有，Python 版无）

1. **SIGTERM 后 exitCode 为 null**：Node 子进程被信号杀死时 exitCode===null
   且 signalCode==='SIGTERM'——所有存活判断必须同时看两者（util.procAlive），
   否则 stop 后的下一次 send 会向死进程写 stdin（EPIPE 异步触发，write 不抛错），
   turn 静默挂起。
2. **ESM import 绑定只读**：跨模块对 DEFAULT_CHANNEL 赋值在运行时抛
   "Assignment to constant variable"（node --check 不报）→ 改为 channelState 可变持有者。
3. **abort 时序**：杀进程后若先等退出再发 turn_aborted，reader 的 close 事件会抢先
   以 reason=process_exited 发帧 → abort 必须先置 aborted_sent+发帧，再后台等退出收敛。
4. **pkill -f 自匹配**：模式字符串出现在自身命令行里会杀掉自己的 shell（Python 版
   ACCEPTANCE 同款教训）→ 用 pgrep 列 PID 逐个 kill 并排除自身，
   restart 脚本内用 server[.]js 括号技巧。

## 五、未覆盖项（需生产环境/凭据）

- 真实 claude CLI 端到端：本机未安装；帧逻辑按已实测的 Python 版 1:1 移植
  （协议路径/时序/字段逐一对应），生产验证方式：把 config.json 的 claude_bin
  指向已登录机器上的 claude 跑 wsclient.mjs 即可复测。
- 龙虾(ClawBrain)实弹：需要用户 key；WebUI「测试连通/拉取模型列表」已就绪，
  claude 走 /v1/messages、codex 走 /v1/chat/completions（双协议）。
- codex 真实多轮 resume：需 API 可用时复测 thread_id 续轮（逻辑已按 exec.md
  与源码实现，thread_id 落盘 sess.json）。

## 六、OpenClaw(龙虾)协议研究与对接实测(2026-09-12 追加)

- 身份确认:龙虾 = OpenClaw(github.com/openclaw/openclaw),开源自托管 AI Agent
  网关;ClawBrain(clawbrain.dev,owl- key)为托管商业版。协议全文调研见
  docs/openclaw.md(llms.txt 全量索引 + 源码逐字段核对)。
- 三个协议层:Gateway WS 协议 v4(connect/hello-ok/req-res-event/RPC 族/device
  token)、OpenAI 兼容 HTTP API(/v1/chat/completions、/v1/responses、
  /v1/models、/v1/embeddings、/tools/invoke)、CLI 后端/ACP 机制。
- **关键实测发现:codex 0.154.0 已移除 wire_api=chat**(启动即报
  "wire_api = chat is no longer supported",必须 responses)→ cws 适配器与渠道
  默认全部改为 responses;OpenClaw 的 /v1/responses 恰好对齐。
- 渠道层协议感知落地:channel.test/channel.models 按 protocol 分流
  (openai→chat completions+models/Bearer,anthropic→/v1/messages),base_url
  尾部 /v1 有无两种约定自动适配;channels CRUD 支持 wire_api/http_headers 字段;
  codex 适配器支持 TOML http_headers 下发({session_id} 占位符→会话 uuid,
  用于 x-openclaw-session-key 维持 OpenClaw 侧会话)。
- 本地 mock OpenResponses 网关验收:openai/auto 渠道测试 200、
  /v1/models 拉取 openclaw+openclaw/default、真实 codex 0.154.0 端到端
  (桥 codex 后端+openclaw 渠道→SSE→delta="2"→final.text="2",is_error=false)。
- 期间按 codex 源码(codex-api/src/sse/responses.rs)修正两处:
  (a) codex 只发 item.completed(无 started/updated)时的文本提取;
  (b) SSE 事件序列须含带 role 的 output_item.added 与 output_item.done。
- 回归:mock 验收 8/8 SUMMARY_OK(上文一~五节场景,改动后复跑通过)。


## 七、OpenClaw 后端（远程网关遥控）实测（2026-09-12 追加）

- 架构纠正：OpenClaw 从「上游渠道」改为**平级后端**（本地 claude/codex + 远程 openclaw）。
- 实现：依赖官方 @openclaw/gateway-client（Gateway WS 协议 v4），新增
  src/gateway.js（共享连接管理）+ src/openclaw-session.js（会话后端）。
  精确字段取自 @openclaw/gateway-protocol 的 protocol.schema.json（965 定义）。
- 映射：chat.send→发消息；chat 事件(deltaText/state=delta|final|aborted|error)→
  cws delta/final/turn_aborted；session.approval(pending)+approval.resolve→ask 卡片；
  sessions.patch→模型/权限；chat.history→历史；sessions.abort→停止。
- mock 网关实测（scripts/mock-openclaw-gateway.mjs，最小 v4 协议）：
  new_session(backend=openclaw)→session_ready→send "1+1"→Δ2→final="2"；
  send "用bash…"→session.approval(pending,kind=exec)→ask→allow→approval.resolve→
  Δ"工具已执行"→final。全链路 PASS。
- 回归：claude/codex mock 验收 8/8 通过（wsclient.mjs 新增 9.openclaw_basic）。

