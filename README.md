# cws — 多会话 WebSocket 桥（Node.js）

把 Claude Code / Codex CLI 包成多会话 WebSocket 服务：QQ 机器人、WebUI、任意客户端都能
在线创建/接管会话、流式对话、审批权限、统一切换上游模型。协议 v0.2（与 Python 版
cc-bridge 完全兼容），新增 codex 后端、龙虾(ClawBrain)渠道与内置 WebUI。

## 相对 Python 版的变化

| | Python cc-bridge | Node cws v2 |
|---|---|---|
| 后端 | claude CLI | claude CLI + **codex CLI**(按会话可选) |
| 渠道 | glm/kimi | glm/kimi + **龙虾 ClawBrain**(双协议) |
| WebUI | 无 | **内置**（/ 静态页） |
| 协议 | v0.2 | v0.2 兼容，新增 backend 字段、channels.set_default |

旧 Python 实现保留在 `legacy-py/`（含原始验收记录），协议帧语义经
[ACCEPTANCE.md](ACCEPTANCE.md) 实测对齐。

## 快速开始

```bash
npm install
cp config.example.json config.json      # 端口/路径/限流/webui 开关
cp secrets.example.json secrets.json    # token + 渠道 key（chmod 600）
# channels.json 已内置 glm/kimi/龙虾 渠道模板，按需增删
node src/server.js
# 浏览器打开 http://<host>:8642/  → 输入 token 即可在线使用
```

Node ≥ 18，仅一个运行时依赖（ws）。claude 后端需要 `claude` CLI 已登录；
codex 后端需要 `codex` CLI（`npm i -g @openai/codex`，或 `CODEX_API_KEY` 环境变量）。

## 配置文件（三层拆分，开源友好）

| 文件 | 内容 | 是否提交 |
|---|---|---|
| `config.json` | 端口/CLI 路径/默认后端/限流/超时/工具白名单/webui | 可提交(模板) |
| `channels.json` | 渠道列表（name/label/base_url/**protocol**/model/api_key_env），不含 key | 可提交 |
| `secrets.json` | `token` / `one_time_tokens` / 渠道 `api_keys` | gitignore，0600 |

加载顺序 config ← channels ← secrets；渠道 key 优先级：内联 > secrets.api_keys[name] >
环境变量(api_key_env)。运行期渠道增删改与一次性 token 消费自动写回磁盘。

### 渠道 protocol 字段

| 值 | 用途 |
|---|---|
| `anthropic` | claude 后端（/v1/messages） |
| `openai` | codex 后端（/v1/chat/completions） |
| `auto` | 双协议（如龙虾），两个后端都可选 |

### 对接龙虾（ClawBrain OpenClaw）

`channels.json` 已内置：

```json
{ "name": "longxia", "label": "龙虾 (ClawBrain)",
  "base_url": "https://api.clawbrain.dev/v1", "protocol": "auto",
  "model": "", "models": [], "api_key_env": "CWS_APIKEY_LONGXIA" }
```

把你的 key 放进 `secrets.json` 的 `api_keys.longxia`（或导出 `CWS_APIKEY_LONGXIA`），
然后在 WebUI「上游渠道」里点「测试」验证连通、「拉取模型列表」拿到可用模型。
龙虾兼容 OpenAI/Anthropic 双协议：claude 会话走 /v1/messages，codex 会话走
/chat/completions，同一把 key 两后端通用。

## Codex 后端适配要点

- 每轮启动一次 `codex exec --json --skip-git-repo-check`（首轮）/
  `codex exec resume <thread_id>`（续轮），解析 JSONL 事件
  （thread.started / turn.started / item.{started,updated,completed} /
  turn.{completed,failed} / error），映射为 v0.2 帧（delta/tool_activity/final…）。
- thread_id 随会话落盘 sess.json，桥重启后续轮仍可 resume。
- 渠道经 `-c model_provider=…`、`-c model_providers.<名>.{name,base_url,env_key,wire_api}`
  下发（不写 ~/.codex/config.toml），密钥经渠道 env_key 环境变量注入子进程。
- 权限等级 = sandbox 级别：read-only（默认）/ workspace-write /
  danger-full-access / full-auto(绕过审批与沙箱)；codex exec 没有
  can_use_tool 式交互审批，故 codex 会话无 ask 卡片，只有等级开关。
- 已对 openai/codex 源码 exec_events.rs 与真实 CLI 0.154.0 实测（见 ACCEPTANCE.md）。

## WebUI

- **登录**：token（支持一次性 token 消费）。
- **会话**：新建（选后端/渠道/模型/权限）、列表、接管切换、删除；多端实时同步
  （history + user_msg/cc_msg/tool_activity/delta 流 + 水位增量补推）。
- **审批**：claude 会话的权限请求卡片（允许/拒绝）、AskUserQuestion 选项卡片
  （answers 按问题原文回填）。
- **统一管理上游模型**：渠道增删改、设默认、连通测试（延迟）、拉取上游模型列表、
  每会话渠道/模型热切换。

## 帧协议（v0.2 + 扩展）

客户端→桥：`ping / new_session / sessions.sync / send / stop / drop_session /
sessions.list / ask_reply / set_permission / set_model / channels.list / channels.save /
channels.delete / channels.set_default / channel.test / channel.models`（均带 echo 回传）。

桥→客户端 post_type：`session_ready / session_queued / send_ack / stop_ack /
user_msg / cc_msg / delta / thinking / tool_activity / ask / ask_replied / final /
turn_aborted / session_closed / history / sessions / sync_done / pong / error /
channels / channels_saved / channels_deleted / channels_default / channel_test /
channel_models / permission_ack / model_ack`。

扩展字段：new_session 参数加 `backend: "claude"|"codex"`；session_ready /
sessions.list 带 `backend`；channels.list 渠道带 `protocol`。旧客户端零改动。

## 部署（systemd）

```bash
sudo cp cws.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now cws
# 端口 0.0.0.0:8642，UFW 放行 8642/tcp；热重启 ./restart_bridge.sh [delay]
```

## 开发与验收

- `node wsclient.mjs --url ws://127.0.0.1:8642/ws --scenario all` — 8 场景验收客户端
  （claude 基本/并行/权限拒绝/提问/中断续聊/杂项 + codex 基本/中断）。
- `scripts/mock-claude.mjs` / `scripts/mock-codex.mjs` — 免 key 的全协议 mock CLI，
  把 config.json 的 claude_bin/codex_bin 指向它们即可离线跑通全链路。
- 实弹切换：claude_bin 指向真实 `claude`、codex_bin 指向真实 `codex`，配好渠道 key。

## 安全

- token 只走 query 或 WebUI 登录框；日志/访问日志永不打印 token 与消息正文。
- 每会话独立工作目录 `workspaces/<sid>/`；进程以独立进程组运行（stop 只杀自己）。
- secrets.json 0600；从环境变量解析的 key 永不落盘。
- WebUI 静态服务带路径穿越防护（403/404）。
