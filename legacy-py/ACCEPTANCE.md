# cc-bridge @64 验收实测记录（2026-09-07，Python 版）

环境：<your-server>，claude CLI 2.1.263，glm-5.3-flash（智谱 coding plan）
服务：cws.service（systemd），/my/run/cws/bridge.py，0.0.0.0:8642/ws，UFW 已放行 8642/tcp

## 验收结果（全部真实验证）

| # | 场景 | 结果 | 证据 |
|---|------|------|------|
| 1 | new_session+send "1+1" | PASS | final.text='2'（acc.log PASS 1.basic） |
| 2 | 两 session 并行 | PASS | f1='18' f2='16'，两进程并行 turn（journal dur 5084/6106ms） |
| 3 | Bash 写文件→deny | PASS | ask(kind=permission, tool=Bash, input=printf>p4test.txt)→deny→final 自述两次被拒 |
| 4 | AskUserQuestion | PASS+WARN | ask(kind=question, questions[{question,header,options,multiSelect}]) 结构完整；answers 按问题原文回填→模型答"蓝"（askq2.py VERDICT PASS）。WARN 该工具不在 init tools 列表，靠模型自发调用；120s 超时自动 deny 链路实测（模型转纯文本提问） |
| 5 | stop→turn_aborted→resume | PASS | 数到 300 中途 stop→turn_aborted(reason=user)→进程 143→自动 --resume→final"数到50被打断"上下文连续 |
| 6 | ping/sessions.list/错 token | PASS | pong 回显 echo；sessions 列表正常；错 token 401（本机+外网双验） |
| 7 | 外网可达（38→64:8642） | PASS | UFW 放行后：坏 token 401 / 好 token 101 + pong（38 裸 socket RFC6455 实测） |

## stream-json 帧结构实测摘要（2.1.263）

- 帧型：system(init/status) / stream_event(content_block_delta text_delta) /
  assistant(content blocks) / user(tool_result) / result / control_request(can_use_tool) /
  control_response
- **权限帧上 stdout 的两个必要条件**：--permission-prompt-tool stdio +
  首帧 initialize 握手。stdio 模式下 CLI 不再主动发 system init，握手
  response 即"进程就绪"。
- 只读放行：allowed-tools 白名单内 Read/Grep/Glob 及只读 Bash(ls) 不弹权限；
  写操作（Write/重定向写）必弹 can_use_tool。
- result.subtype：正常 success；中途 interrupt → error_during_execution(is_error)。
- SIGTERM 杀进程组（exit 143）→ --resume <uuid> 上下文完好（实测跨进程恢复）。
- **--session-id 复用限制**：磁盘已有该会话历史（~/.claude/projects/<munged-cwd>/<uuid>.jsonl）
  时再用 --session-id 报 "Session ID already in use"（exit 1）→ 必须 --resume。
  桥的对策：对外任意 session_id，对内 uuid5 固定映射，重启时检测历史文件自动切 --resume。
- AskUserQuestion 的 answers 约定（CLI 源码反编译证实）：call({answers}) 按
  answers[<question 原文>] 取值，值为所选 label。

## 限流参数（config.json 可调）

max_active_sessions=2（全局活跃 claude 进程上限）、queue_max=5（排队）、
min_turn_interval=2s（全局 turn 启动间隔）、单 session 并发 1（busy 报错）、
turn_timeout=300s、ask_timeout=120s、idle_timeout_s=1800。

## 坑与教训

1. systemd 环境缺 PATH → claude exit 1：service 里显式 Environment=PATH。
2. --permission-mode default 不在 2.1.263 的 choices 里（accepted but
   undocumented），实测不报错且行为=按需询问，沿用。
3. 探针 killpg 连坐自杀：子进程必须 start_new_session=True（桥已内置）。
4. aiohttp access log 默认打印请求行（带 ?token=）→ 桥内置 NoTokenAccessLogger 清空。
5. --resume 后 CLI 不发 system init（stdio 模式+握手），session_ready 要在
   握手 response 时发（幂等），否则客户端等不到。
6. 清理探针时 grep 模式匹配到 SSH 命令自身把会话断了（exit 255）——红线再现，
   清进程先列 PID 再逐个 kill。
7. GLM 速度注意：简单问答 2-7s/turn；"数到50"这种 5.5s 就完，stop 竞态要挑
   足够长的任务（验收用数到 300）。

## 客户端接入速查

    ws://<your-server>:8642/ws?token=<见 ssh root@<your-server> 'cat /my/run/cws/secrets.json'>
    首帧: {"action":"new_session","params":{"session_id":"mychat"},"echo":"e1"}
    等 session_ready → {"action":"send","params":{"session_id":"mychat","text":"..."},"echo":"e2"}
    收 delta* → final{...}；ask 事件→ ask_reply{session_id,ask_id,behavior,updatedInput?}
    停止: stop；关会话: drop_session（客户端断开会自动关掉名下会话）
