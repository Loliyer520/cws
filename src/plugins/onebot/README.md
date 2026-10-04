# onebot 插件 — OneBot v11 服务端 + 多级 agent 管线

> 状态：**M1-M3 已实现，离线 E2E 37/37 全过**（2026-10-04，`scripts/test-onebot.mjs`；
> 生产配置干跑 `scripts/onebot-dryrun.mjs`）。M4（收图视觉/印象/WebUI 面板/用量统计）未做。
> 各文件头部注释保留设计依据；与实现冲突以实现为准。

## 目标

桥充当 **OneBot v11 反向 WS 服务端**，NapCat（第二个 QQ 号，独立 NapCat 实例）作为
客户端连入。卡西（桥内建助手）因此能：

1. **看**——全量消息入档，主人随时问"刚才 XX 群在聊什么"；
2. **代回**——私聊/被@的群消息由执行体 agent 自动应答；
3. **摘要**——高音量群滚动摘要，重要内容 digest 推给主人。

与 liveai（/my/pro/bot，砂糖号）的关系：**架构借鉴者，非替代**。liveai 照跑。
本插件是它的精简重装：没有人格扮演、没有面板、没有插件市场，但管线骨架
（门控/攒批/scope agent/摘要/总控）同源。

## 已定决策（2026-10-04 主人拍板）

| 决策点 | 结论 |
|---|---|
| 端点形态 | 同桥端口路径 `ws://<host>:7810/onebot/`，不开新端口 |
| 默认模式 | 群 = watch（只看不回，摘要照做）；私聊 = auto（自动回复） |
| 模型分配 | L3 执行体 ds/deepseek-flash；L4 摘要同 ds；L5 卡西保持桥默认（glm） |
| NapCat 部署 | 插件外事项，只留接口约定（见下文「对端配置」） |

## 管线总览

```
NapCat ──WS──▶ server.js（端点/鉴权/动作调用）
                 │ 事件
                 ▼
        protocol.js（归一化：CQ 段→内部事件；防环标记）
                 │
   ┌─────────────┴──────────────┐
   ▼                            ▼
store.js（L0 收纳：archive + 历史窗口）   gate.js（L1 门控：模式/名单/触发词/速率）
                                             │ pass
                                             ▼
                                  mailbox.js（L2 攒批：防抖窗合并，静默批次折叠）
                                             │ flush = 一个回合
                              ┌──────────────┴───────────────┐
                              ▼                              ▼
              主人私聊 scope                    普通 scope
              overseer.js（L5 卡西总控）        agent.js（L3 执行体：小工具集回合循环）
                     ▲                              │
                     └──── escalate_to_kaxi ────────┘
   watch 群 ──▶ summary.js（L4 摘要器：滚动摘要 → digest 推主人）
```

L0/L1 是纯数据与规则，不过模型；L3/L4/L5 才调模型。模型一律走桥渠道
（`bridge.callLLM`，复用 channels.json，不自带 key）。

## 文件地图

| 文件 | 层 | 职责 |
|---|---|---|
| `index.js` | — | 插件入口：`commands` 导出 + `init`/`shutdown` 生命周期；组装各模块 |
| `config.js` | — | 插件配置视图：默认值、校验、角色→渠道/模型解析 |
| `server.js` | 接入 | OneBot 反向 WS 端点：鉴权、连接注册、动作调用（echo 配对） |
| `protocol.js` | 接入 | OneBot v11 编解码：事件归一化、消息段解析/构造、动作响应 |
| `store.js` | L0 | 数据层：state.json / archive jsonl / scopes/*.json，写链保序 |
| `gate.js` | L1 | 门控：off/watch/auto、名单、@与触发词、速率上限 |
| `mailbox.js` | L2 | 攒批：每 scope 防抖窗、连发合并、静默批次 |
| `agent.js` | L3 | 执行体 scope agent：回合循环、工具集、回声去重 |
| `summary.js` | L4 | 摘要器：滚动摘要、关键词嗅探、digest 推送 |
| `overseer.js` | L5 | 卡西总控：主人私聊接 kxTurn、QQ 域工具、升级受理 |

## 对桥本体的三处契约扩展（已实施）

1. **插件契约 v2**：`export async function init(ctx)` / `shutdown()`；
   ctx 提供 `registerUpgrade(path, handler)` / `registerHttp(path, handler)` /
   `callLLM` / `kxTurn` / `kaxiSystemPrompt` / `kaxiTools` / `kaxiExec`。
   装载器先试 `plugins/<name>/index.js` 再试 `<name>.js`（bridge.js `_loadPlugins`）。
2. **server.js 分发**：upgrade 与 HTTP 都先查插件注册表（含 `/cws-ws` 前缀剥离重试），
   再落到 `/ws` 与静态服务。插件路径自理鉴权，与桥 token 隔离。
3. **kxAgent 重构**：`_kxCallLLM` 公开化为 `bridge.callLLM(渠道名, model, msgs, tools, opts)`
   （180s 超时、opts.thinkingDisabled、空壳重试 ×3、超时不重试）；循环体抽为
   `bridge.kxTurn({ch|channel, model, system, messages, tools, execTool, onStep, …})`，
   kxAgent 变薄壳，kx_step/kx_reply 帧形状不变。

### 实现与原设计的偏差

- 配置支持 `data_dir` 注入（测试/多实例），缺省 `BASE/data/onebot`。
- 装配顺序 overseer 先于 agent（escalate 回调需要）。
- L3 上下文直接用整窗口（batch 入档后），不做「批次单独拼接」。
- escalate 的处置结果经 L5 回合回复推主人，不经 30s 合并缓冲；30s 缓冲只管
  digest/故障告警（notifyMaster）。

## 对端（NapCat）配置约定

- 反向 WS 地址：`ws://<桥host>:7810/onebot/`（前缀化部署时 `wss://host/cws-ws/onebot/`，
  nginx 按现有 `/cws-ws` 无 URI proxy_pass 规则原样透传即可）
- token：`secrets.json` 的 `plugins.onebot.token`（NapCat 里填 accessToken）
- messageFormat：**array**（string 形态本插件只做最低限度容错，不保证）
- reportSelfMessage：开（需要 message_sent 做本人其他设备识别）

## liveai 教训清单（实现时必须内建）

- 模型 fetch 180s 硬超时（中转挂连接永久卡死事故）
- thinking_disabled 按渠道开关（glm/deepseek 思考块吃光 max_tokens 返回空壳）
- 空壳回复重试 ×3，耗尽落盘 debug 样本
- 历史窗口**整块淘汰**（逐条淘汰毁前缀缓存）；易变上下文钉在触发消息尾部
- 同 scope 写盘串行（写链保序）；坏 JSON 留 .bak 不覆盖
- 发送回声去重（pendingSelfSent：private+selfId+内容）；纯静默批次不跑模型
- 弱模型+大散文上下文=协议失效 → modeHint 钉消息尾部，不只靠 system

## 分期

| 期 | 内容 | 状态 |
|---|---|---|
| M1 | 契约扩展 + server/protocol/store + `onebot.*` 管理动作 | ✅ 已实现（E2E 覆盖） |
| M2 | gate/mailbox/agent + overseer | ✅ 已实现（E2E 覆盖） |
| M3 | summary + digest 推送 | ✅ 已实现（触发/频闸/降级，E2E 覆盖计数与旁路） |
| M4 | 收图走视觉、印象、WebUI 面板、用量统计 | 未做 |

上线步骤：NapCat 二实例部署（宿主侧，另议）→ 反向 WS 指向本桥 `/onebot/`、
accessToken 填 secrets 里的 token → 重启桥（detached 定时器手法，见 cws-bridge-ops 记忆）→
`onebot.status` 看 conn.online。
