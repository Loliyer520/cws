#!/usr/bin/env python3
"""cc-bridge: multi-session WebSocket bridge over Claude Code CLI (stream-json).

Protocol v0.2. See README.md.

Verified against claude 2.1.263 (2026-09-07, <your-server>):
- stream-json frames: system(init/status) / assistant / user(tool_result) /
  stream_event(content_block_delta text_delta) / result / control_request /
  control_response.
- Permission prompts reach stdout only with `--permission-prompt-tool stdio`
  plus an `initialize` control_request handshake; reply with control_response
  {subtype:success,request_id,response:{behavior:allow|deny,...}}.
- Read-only ops (Read/Grep/Glob in --allowed-tools, read-only Bash like ls)
  never prompt; writes / non-listed tools prompt via can_use_tool.
- SIGTERM the process group mid-turn, then `--resume <sid>` in a fresh process
  (no --session-id) restores context. Interrupt via control_request yields
  result subtype error_during_execution.
"""
import asyncio
import aiohttp
from aiohttp import web
import hmac
import json
import logging
import os
import secrets
import re
import signal
import time
import uuid

BASE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE, "config.json")
SECRETS_PATH = os.path.join(BASE, "secrets.json")
CHANNELS_PATH = os.path.join(BASE, "channels.json")
WORKSPACES = os.path.join(BASE, "workspaces")

log = logging.getLogger("ccbridge")


def _load_json_file(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def load_config():
    """三层合并，机密与渠道独立于主配置，便于开源：
    - config.json   非机密运行参数（port/超时/工具白名单等），可提交；
    - channels.json 渠道列表（name/label/base_url/model + api_key_env），可提交；
    - secrets.json  机密（token / one_time_tokens / 各渠道 api_key），gitignore。
    兼容旧版单文件：config.json 里残留的机密字段仍然生效（secrets.json 优先），
    渠道的 api_key 也支持内联直写（不开源自用时可不抽离）。"""
    cfg = _load_json_file(CONFIG_PATH, {})
    secrets = _load_json_file(SECRETS_PATH, {})
    channels = _load_json_file(CHANNELS_PATH, None)

    for key in ("token", "one_time_tokens"):
        if secrets.get(key) is not None:
            cfg[key] = secrets[key]

    if channels is not None:
        cfg["api_channels"] = channels.get("api_channels") or []
        if channels.get("default_channel") is not None:
            cfg["default_channel"] = channels["default_channel"]

    # 渠道 api_key：内联值 > secrets.json > 环境变量（api_key_env 指定变量名）
    secret_keys = secrets.get("api_keys") or {}
    for ch in cfg.get("api_channels") or []:
        if ch.get("api_key"):
            continue
        name = ch.get("name") or ""
        if secret_keys.get(name):
            ch["api_key"] = secret_keys[name]
            continue
        env_name = ch.get("api_key_env")
        if env_name and os.environ.get(env_name):
            ch["api_key"] = os.environ[env_name]

    return cfg


CFG = load_config()
TOKEN = CFG["token"]
ONE_TIME_TOKENS = set(CFG.get("one_time_tokens") or [])

def persist_one_time_tokens():
    """把剩余的 one_time_tokens 写回 secrets.json（消费后调用）。"""
    try:
        c = _load_json_file(SECRETS_PATH, {})
        c["one_time_tokens"] = sorted(ONE_TIME_TOKENS)
        with open(SECRETS_PATH, "w") as f:
            json.dump(c, f, ensure_ascii=False, indent=2)
        os.chmod(SECRETS_PATH, 0o600)
    except Exception:
        log.exception("persist_one_time_tokens")


def persist_channels():
    """渠道增删改后写回 channels.json + secrets.json。
    API_CHANNELS 原地修改（channel_by_name 每次现查，新会话即刻可用）；
    已存活会话的渠道是创建时捕获的，不受影响。
    落盘前剥离 api_key：解析自环境变量的 key 绝不能固化进可提交的 channels.json。"""
    try:
        secret_keys = {}
        channels_out = []
        for ch in API_CHANNELS:
            entry = {k: v for k, v in ch.items() if k != "api_key"}
            if ch.get("api_key") and not ch.get("api_key_env"):
                secret_keys[ch.get("name") or ""] = ch["api_key"]
            channels_out.append(entry)
        c = {"api_channels": channels_out, "default_channel": DEFAULT_CHANNEL}
        with open(CHANNELS_PATH, "w") as f:
            json.dump(c, f, ensure_ascii=False, indent=2)
        s = _load_json_file(SECRETS_PATH, {})
        s["api_keys"] = secret_keys
        with open(SECRETS_PATH, "w") as f:
            json.dump(s, f, ensure_ascii=False, indent=2)
        os.chmod(SECRETS_PATH, 0o600)
    except Exception:
        log.exception("persist_channels")

PORT = int(CFG.get("port", 8642))
CLAUDE_BIN = CFG.get("claude_bin", "/www/server/nodejs/v24.20.0/bin/claude")
MAX_ACTIVE = int(CFG.get("max_active_sessions", 2))
QUEUE_MAX = int(CFG.get("queue_max", 5))
TURN_TIMEOUT = float(CFG.get("turn_timeout", 300))
ASK_TIMEOUT = float(CFG.get("ask_timeout", 600))
MIN_TURN_INTERVAL = float(CFG.get("min_turn_interval", 2))
ALLOWED_TOOLS = CFG.get("allowed_tools", "Read,Grep,Glob,AskUserQuestion")
PERMISSION_MODE = CFG.get("permission_mode", "default")
IDLE_TIMEOUT = float(CFG.get("idle_timeout_s", 1800))
# API 渠道：显式渠道经 --settings（命令行级，优先级最高）下发 env/model，
# 能覆盖 ~/.claude/settings.json 的同名配置（实测）。空 base_url/key = 中和
# 继承的端点走 CLI 登录态；channel 为 None = 完全继承机器现状。
API_CHANNELS = CFG.get("api_channels") or []
DEFAULT_CHANNEL = CFG.get("default_channel") or ""


def channel_by_name(name):
    if not name:
        return None
    for ch in API_CHANNELS:
        if isinstance(ch, dict) and ch.get("name") == name:
            return ch
    return None


def _sidecar_mode(sid):
    """读会话 sidecar（sess.json）里持久化的权限等级；没有或损坏返回 None。"""
    try:
        with open(os.path.join(WORKSPACES, sid, "sess.json"), encoding="utf-8") as f:
            meta = json.load(f)
        return (meta.get("permission_mode") if isinstance(meta, dict) else "") or None
    except Exception:
        return None


def _proc_env(channel):
    """CLI 子进程环境。显式渠道时清掉继承的端点变量——端点/密钥只由
    --settings 决定（避免进程环境与渠道配置互相打架）。"""
    env = {**os.environ, "IS_SANDBOX": "1"}
    if channel is not None:
        env.pop("ANTHROPIC_BASE_URL", None)
        env.pop("ANTHROPIC_AUTH_TOKEN", None)
    return env


def now():
    return time.time()


def brief_of(input_obj, limit=80):
    try:
        s = json.dumps(input_obj, ensure_ascii=False)
    except Exception:
        s = str(input_obj)
    return s if len(s) <= limit else s[:limit] + "…"


class Session:
    """One claude CLI subprocess (resident between turns; resumed after kills)."""

    def __init__(self, bridge, sid, ws, resume=False, permission_mode=None, channel=None, model=None):
        self.bridge = bridge
        self.id = sid
        # CLI requires a valid UUID for --session-id/--resume; external id is free-form
        self.cli_uuid = str(uuid.uuid5(uuid.NAMESPACE_URL, "cc-bridge:" + sid))
        self.ws = ws
        # new_session 的 echo：直连/排队转正的 session_ready 由 CLI init 触发
        # （_announce_ready），那时拿不到请求上下文——先存这里，首发时带上。
        # 不带的话客户端 rcSend 的请求定时器永远等不到回执，6 分钟后弹
        # 「new_session 请求超时」假提示
        self.pending_echo = None
        self.cwd = os.path.join(WORKSPACES, sid)
        os.makedirs(self.cwd, exist_ok=True)
        self.proc = None
        self._spawn_lock = asyncio.Lock()  # warm 预热与 send 首发可能并发拉起：防双开
        self.reader_task = None
        self.turn_active = False
        self.turn_echo = None
        self.turn_timer = None
        self.aborted_sent = False
        self.started_once = False
        self.resume_flag = resume
        self.ready = asyncio.Event()
        self.ready_announced = False
        self.text_buf = []
        self.pending_asks = {}  # ask_id -> {request_id, tool_name, timer}
        self.stdin_lock = asyncio.Lock()
        self.created_at = now()
        # 会话身份（权限/渠道/模型）随会话落盘 sess.json：闲置回收、桥重启后
        # revive_on_send / 懒登记重建 Session 时不带任何参数，没有它就回落
        # config 的 default——前端开关还停在「完全允许」，CLI 实际逐条弹权限
        meta = self._load_sess_meta()
        # 权限等级：launch_mode 是进程启动参数；permission_mode 是运行时实际值
        # （set_permission_mode 控制请求可免重启切换，见 set_permission）。
        # 优先级：显式入参 > 盘上记录 > config 默认
        self.launch_mode = permission_mode or meta.get("permission_mode") or PERMISSION_MODE
        self.permission_mode = self.launch_mode
        # API 渠道/模型：None = 继承机器现状（settings.json / 登录态）；
        # dict = 显式渠道（--settings 下发，见 _build_args），切换需重启进程。
        # model 独立入参：客户端绑定的模型优先于渠道配置值（机器默认时走 --model）。
        # 盘上渠道名解析回渠道对象（渠道已被删则忽略，回落机器默认）
        if channel is None and meta.get("channel"):
            ch = channel_by_name(meta.get("channel"))
            if ch is not None:
                channel = ch
        self.channel = channel
        self.model_name = model or (channel or {}).get("model") or meta.get("model") or None
        self._ctl_futures = {}  # request_id -> Future（等待 CLI control_response）
        self.pending_mode = None  # 轮中暂存的权限等级：下次 send 前静默补切
        self.last_activity = now()
        self.last_turn_at = None
        self.closed = False
        # 离线累计消息：owner 断线后不销毁，turn 产物写 turn_log，重连 resume 时推 history
        self.detached = False
        self.turn_log = []  # [{id, ts, role: user|cc|tool|sys, text}] 上限 200
        self.TURN_LOG_MAX = 200
        self._msg_seq = 0  # 消息 id 序号（id = "<sid>-<seq>"，跨重启单调递增）
        # 同步落盘（turnlog.jsonl，有界），重启后 _load_turn_disk 恢复
        self._load_turn_disk()
        self.thinking_chars = 0  # 思考字符累计（服务端去重计数，客户端直接显示）
        self._save_sess_meta()  # 会话身份即刻落盘；revive 路径是幂等回写

    # ---------- process ----------
    def _history_path(self):
        # claude stores per-session history under ~/.claude/projects/<munged-cwd>/<uuid>.jsonl
        import pathlib
        proj = str(pathlib.Path(self.cwd).resolve()).replace("/", "-").replace(".", "-")
        return os.path.expanduser(f"~/.claude/projects/{proj}/{self.cli_uuid}.jsonl")

    def _has_history(self):
        return os.path.exists(self._history_path())

    def _build_args(self):
        # resume_flag 只是客户端的意愿；CLI 盘上没有这段历史时 --resume 会
        # 直接报"No conversation found"退出(exit 1)。典型场景：点了列表里
        # 排队未启动过/CLI 历史已被清的会话。此时按全新会话拉起
        use_resume = (self.resume_flag or self.started_once) and self._has_history()
        args = [CLAUDE_BIN, "-p",
                "--input-format", "stream-json",
                "--output-format", "stream-json",
                "--include-partial-messages",
                "--verbose",
                "--permission-mode", self.launch_mode,
                "--allowed-tools"] + ALLOWED_TOOLS.split(",") + \
            ["--permission-prompt-tool", "stdio",
             # 只解锁不启用：运行时可用 set_permission_mode 切到 bypassPermissions
             # （免重启；真正启用与否由 permission-mode / set_permission 决定）
             "--allow-dangerously-skip-permissions"]
        if self.channel is not None:
            # 显式渠道经 --settings（命令行级，优先级最高）覆盖用户级
            # settings.json 的 env/model；空串 = 中和该端点走 CLI 登录态
            env_obj = {"env": {"ANTHROPIC_BASE_URL": self.channel.get("base_url") or "",
                               "ANTHROPIC_AUTH_TOKEN": self.channel.get("api_key") or ""}}
            if self.model_name:
                env_obj["model"] = self.model_name
            args += ["--settings", json.dumps(env_obj)]
        if self.model_name:
            args += ["--model", self.model_name]
        if use_resume:
            # --resume works even after SIGTERM; --session-id refuses a reused id
            # ("Session ID ... is already in use") once history exists on disk
            args += ["--resume", self.cli_uuid]
        else:
            args += ["--session-id", self.cli_uuid]
        return args

    async def start(self):
        async with self._spawn_lock:
            if self.proc and self.proc.returncode is None:
                return
            # 进 exec 前就置位：create_subprocess_exec 返回前的窗口里也计入
            # active_count，否则并发的名额检查全穿透、超卖 MAX_ACTIVE（实测
            # 4 个 warm + 1 个直连同时拉起 = 5 个 CLI 存活）
            self.started_once = True
            self.aborted_sent = False
            self.ready.clear()
            self.proc = await asyncio.create_subprocess_exec(
                *self._build_args(),
                cwd=self.cwd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,  # own process group: stop kills only claude
                # CLI 单行 JSON 帧（含 partial 大 delta）可超 asyncio 默认 64KB 行上限，
                # 超限会炸 reader（"chunk is longer than limit"）→ 伪 process_exited 中断 turn
                limit=2 ** 24,  # 16MB
                # root 下启用 bypass 权限等级需要此变量（容器/无沙箱场景自担风险）
                env={**_proc_env(self.channel)},
            )
            self.reader_task = asyncio.ensure_future(self._reader())
            log.info(json.dumps({"ev": "proc_start", "session_id": self.id,
                                 "pid": self.proc.pid, "resume": self.resume_flag}))
            # SDK handshake: required for can_use_tool prompts on stdout
            try:
                await self._write_line({"type": "control_request",
                                        "request_id": "init-" + secrets.token_hex(4),
                                        "request": {"subtype": "initialize"}})
            except Exception as e:
                log.info(json.dumps({"ev": "handshake_err", "session_id": self.id, "err": str(e)}))

    async def _warm_start(self):
        """后台预热（懒恢复后）：拉起 CLI 但不产生任何帧；失败静默——
        send() 里仍会按需重试 spawn。任务真正跑起来时名额可能已被占满，
        再复核一次（注册到任务启动之间有穿透窗口）。"""
        try:
            if self.bridge.active_count() >= MAX_ACTIVE:
                return
            await self.start()
        except Exception as e:
            log.info(json.dumps({"ev": "warm_start_err", "session_id": self.id, "err": str(e)}))

    async def _write_line(self, obj):
        if not (self.proc and self.proc.returncode is None):
            raise RuntimeError("process_dead")
        line = json.dumps(obj, ensure_ascii=False) + "\n"
        async with self.stdin_lock:
            self.proc.stdin.write(line.encode())
            await self.proc.stdin.drain()

    def _log_turn(self, role, text):
        """记一条 turn 产物，返回带唯一 id 的条目（id = "<sid>-<seq>"，单调递增）。
        id 随条目落盘/随实时帧广播，客户端以 id 去重与对水位，不再靠文本对齐。"""
        if role in ("user", "cc", "tool", "sys"):
            self._msg_seq += 1
            entry = {"id": f"{self.id}-{self._msg_seq}", "ts": now(),
                     "role": role, "text": text}
            self.turn_log.append(entry)
            if len(self.turn_log) > self.TURN_LOG_MAX:
                self.turn_log = self.turn_log[-self.TURN_LOG_MAX:]
            self._log_turn_disk(entry)
            return entry
        return None

    # ---------- turn_log 落盘（断线期间的消息不随 bridge 重启丢失）----------
    def _turnlog_path(self):
        return os.path.join(self.cwd, "turnlog.jsonl")

    def _log_turn_disk(self, entry):
        """有界追加：超过 2x 上限时压实回上限，文件永不无限增长。"""
        try:
            with open(self._turnlog_path(), "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
            self._disk_log_count += 1
            if self._disk_log_count > self.TURN_LOG_MAX * 2:
                self._compact_turn_disk()
        except Exception:
            pass

    def _compact_turn_disk(self):
        try:
            with open(self._turnlog_path(), encoding="utf-8") as f:
                lines = [l for l in f.read().splitlines() if l.strip()]
            keep = lines[-self.TURN_LOG_MAX:]
            with open(self._turnlog_path(), "w", encoding="utf-8") as f:
                f.write("".join(l + "\n" for l in keep))
            self._disk_log_count = len(keep)
        except Exception:
            pass

    def _load_turn_disk(self):
        """构造时从盘上恢复 turn_log：bridge 重启后 resume/重连仍能补推
        断线期间的消息（客户端按 id/内容对齐去重，不会重复渲染）。
        旧格式行没有 id：按序补上 id 并把整个文件重写一遍（一次性迁移，
        之后 id 稳定落盘，不再变号）。"""
        self._disk_log_count = 0
        try:
            if not os.path.exists(self._turnlog_path()):
                return
            with open(self._turnlog_path(), encoding="utf-8") as f:
                lines = [l for l in f.read().splitlines() if l.strip()]
            out = []
            max_seq = 0
            backfilled = 0
            for l in lines[-self.TURN_LOG_MAX:]:
                try:
                    obj = json.loads(l)
                except Exception:
                    continue
                if not (isinstance(obj, dict) and obj.get("role") in ("user", "cc", "tool", "sys")):
                    continue
                try:
                    ts = float(obj.get("ts") or 0)
                except (TypeError, ValueError):
                    ts = 0.0
                entry = {"ts": ts, "role": obj["role"], "text": str(obj.get("text") or "")}
                mid = str(obj.get("id") or "")
                if mid.startswith(self.id + "-"):
                    entry["id"] = mid
                    try:
                        max_seq = max(max_seq, int(mid.rsplit("-", 1)[1]))
                    except (IndexError, ValueError):
                        pass
                else:
                    backfilled += 1
                out.append(entry)
            # 补号：从 max_seq 之后继续编（老文件整体后移，绝不复用已有号）
            seq = max_seq
            for e in out:
                if "id" not in e:
                    seq += 1
                    e["id"] = f"{self.id}-{seq}"
            self._msg_seq = max(self._msg_seq, max(max_seq, seq))
            self.turn_log = out
            self._disk_log_count = len(lines)
            if backfilled:
                self._rewrite_turn_disk(out)
        except Exception:
            pass

    def _rewrite_turn_disk(self, entries):
        """迁移用：把带 id 的条目整体重写回 turnlog.jsonl。"""
        try:
            with open(self._turnlog_path(), "w", encoding="utf-8") as f:
                f.write("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries))
            self._disk_log_count = len(entries)
        except Exception:
            pass

    def forget_turnlog(self):
        """销毁会话时清掉盘上 turn_log（本地历史仍在客户端，不受影响）。"""
        for path in (self._turnlog_path(), self._sess_meta_path()):
            try:
                os.remove(path)
            except OSError:
                pass

    # ---------- 会话身份（权限/渠道/模型）落盘 ----------
    def _sess_meta_path(self):
        return os.path.join(self.cwd, "sess.json")

    def _load_sess_meta(self):
        try:
            with open(self._sess_meta_path(), encoding="utf-8") as f:
                meta = json.load(f)
            return meta if isinstance(meta, dict) else {}
        except Exception:
            return {}

    def _save_sess_meta(self):
        """权限/渠道/模型写 sess.json：会话被回收或桥重启后，revive/懒登记
        重建 Session 才能还原身份（turnlog 只有消息，不含这些）。"""
        try:
            with open(self._sess_meta_path(), "w", encoding="utf-8") as f:
                json.dump({"permission_mode": self.launch_mode,
                           "channel": (self.channel or {}).get("name") or "",
                           "model": self.model_name or ""}, f, ensure_ascii=False)
        except Exception:
            pass

    def _replay_messages(self):
        """重放（history 帧）用的 turn_log 视图：压掉相邻的同文本 cc 条目。
        历史版本曾把整轮 result 和增量正文各记一条（相邻 cc 完全重复），
        原样重放会让客户端对齐失败——多出的一条被当成「离线缺条」反复补推。
        相邻去重对对齐无损：本地多出来的重复条不参与追加，只是被跳过。
        非相邻的相同文本是不同轮的合法重复，不动。"""
        out = []
        prev = None
        for e in self.turn_log:
            if e.get("role") == "cc" and prev == ("cc", e.get("text")):
                continue
            prev = (e.get("role"), e.get("text"))
            out.append(e)
        return out

    def turn_title(self):
        """会话列表标题：turn_log 里最后一条用户消息（单行截断）。

        客户端已本地化标题（最后一轮对话），这里只兜底其它客户端创建、
        本地无记录的会话。从尾部倒扫：最新消息总在末尾，turn_log 压缩不影响。"""
        for e in reversed(self.turn_log):
            if not isinstance(e, dict) or e.get("role") != "user":
                continue
            text = str(e.get("text") or "").strip()
            if not text:
                continue
            return text.splitlines()[0].strip()[:24]
        return ""

    def _flush_text_log(self):
        """把已累计的正文作为一个 cc 条目写入 turn_log。返回写入的条目（没写返回 None）。

        客户端按「工具活动」分段渲染正文（delta 进同一块，tool_activity 来时封口），
        turn_log 必须用同样的边界记录，takeover 补推才能与本地逐条对齐不重复。
        封口边界共四处：工具活动、ask、中断、收尾——少一处就分块错位。
        """
        if not self.text_buf:
            return None
        joined = "".join(self.text_buf)
        entry = None
        if joined.strip():
            entry = self._log_turn("cc", joined)
        self.text_buf = []
        return entry

    def _replay_after(self, mark):
        """增量重放视图：mark = 客户端已同步到的最后消息 id（或旧版 ts 水位）。
        命中日志里的 id → 只取其后；ts 水位 → 只取更新条目；都没命中 → 全量，
        由客户端按 id/内容对齐去重。切片后同样做相邻 cc 去重。"""
        entries = self.turn_log
        if mark:
            hit = False
            for i, e in enumerate(entries):
                if e.get("id") == str(mark):
                    entries = entries[i + 1:]
                    hit = True
                    break
            if not hit:
                try:
                    mts = float(mark)
                except (TypeError, ValueError):
                    mts = 0.0
                if mts > 0:
                    entries = [e for e in entries if (e.get("ts") or 0) > mts + 1e-6]
        out = []
        prev = None
        for e in entries:
            if e.get("role") == "cc" and prev == ("cc", e.get("text")):
                continue
            prev = (e.get("role"), e.get("text"))
            out.append(e)
        return out

    # ---------- reading ----------
    async def _reader(self):
        proc = self.proc
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                await self._dispatch(obj)
        except Exception as e:
            log.info(json.dumps({"ev": "reader_err", "session_id": self.id, "err": str(e)}))
        code = proc.returncode
        log.info(json.dumps({"ev": "proc_exit", "session_id": self.id, "code": code}))
        if self.turn_active and not self.aborted_sent:
            self.turn_active = False
            self._cancel_turn_timer()
            await self._send_ws({"post_type": "turn_aborted", "session_id": self.id,
                                 "reason": "process_exited", "echo": self.turn_echo})
        await self._expire_all_asks()
        self.bridge.notify_capacity_change()

    async def _dispatch(self, obj):
        t = obj.get("type")
        if t == "system":
            if obj.get("subtype") == "init":
                await self._announce_ready(obj.get("model"))
        elif t == "control_response":
            # resolve pending set_permission_mode / other ctl calls first
            fut = self._ctl_futures.pop(obj.get("request_id"), None)
            if fut is not None and not fut.done():
                fut.set_result(obj.get("response") or {})
            # with --permission-prompt-tool stdio the CLI answers the initialize
            # handshake before any system init frame; that response means "alive"
            self.ready.set()
            self.last_activity = now()
            await self._announce_ready(None)
        elif t == "stream_event":
            ev = obj.get("event") or {}
            if ev.get("type") == "content_block_delta":
                d = ev.get("delta") or {}
                if d.get("type") == "text_delta" and d.get("text"):
                    self.last_activity = now()
                    await self._send_ws({"post_type": "delta", "session_id": self.id,
                                         "text": d["text"]})
                elif d.get("type") == "thinking_delta" and d.get("thinking"):
                    # 思考增量：服务端累计字符后发累计 token 粗估（字符/4），
                    # 客户端直接显示不再累加（修重复计数导致的"无限增长"）
                    self.last_activity = now()
                    self.thinking_chars += len(d["thinking"])
                    await self._send_ws({"post_type": "thinking", "session_id": self.id,
                                         "tokens": max(1, round(self.thinking_chars / 4))})
        elif t == "assistant":
            for b in (obj.get("message") or {}).get("content") or []:
                if b.get("type") == "text" and b.get("text"):
                    self.text_buf.append(b["text"])
                elif b.get("type") == "tool_use":
                    self.last_activity = now()
                    # 工具出现 = 客户端正文块封口：先落正文并广播封口条目（cc_msg），
                    # 再广播工具行——帧序与日志序一致，非观看端按 id 实时记账
                    sealed = self._flush_text_log()
                    if sealed:
                        await self._send_ws({"post_type": "cc_msg", "session_id": self.id,
                                             "mid": sealed["id"], "text": sealed["text"]})
                    brief = brief_of(b.get("input") or {})
                    t_entry = self._log_turn("tool", f"{b.get('name')}：{brief}")
                    await self._send_ws({"post_type": "tool_activity", "session_id": self.id,
                                         "tool": b.get("name"),
                                         "brief": brief,
                                         "mid": (t_entry or {}).get("id")})
        elif t == "control_request":
            await self._handle_control_request(obj)
        elif t == "result":
            await self._handle_result(obj)

    # ---------- turn ----------
    async def send(self, text, echo=None):
        if self.turn_active:
            await self._send_ws({"post_type": "error", "session_id": self.id,
                                 "code": "busy", "message": "turn in progress", "echo": echo})
            return
        if not (self.proc and self.proc.returncode is None):
            # 懒恢复的会话在这里首次拉起 CLI；spawn 失败要回给请求方，
            # 不能让异常散出 route 打断连接的消息循环
            try:
                await self.start()
            except Exception as e:
                await self._send_ws({"post_type": "error", "session_id": self.id,
                                     "code": "spawn_failed", "message": str(e), "echo": echo})
                return
        # give the CLI a moment to finish init before first write
        try:
            await asyncio.wait_for(self.ready.wait(), timeout=10)
        except asyncio.TimeoutError:
            pass
        # 补切暂存的权限等级（轮中接管/set_permission busy 暂存）：此刻 CLI
        # 刚应答过握手，控制请求必达；4s 短超时防拖慢本轮，失败留给下次 spawn
        if self.pending_mode:
            mode, self.pending_mode = self.pending_mode, None
            if self.proc and self.proc.returncode is None:
                await self._switch_proc_mode(mode, timeout=4)
        self.text_buf = []
        self.thinking_chars = 0
        self.turn_active = True
        self.aborted_sent = False
        self.turn_echo = echo
        self.last_activity = now()
        self.last_turn_at = self.last_activity
        u_entry = self._log_turn("user", text)
        if u_entry:
            # 用户消息也广播（带 id）：其它端/其它客户端实时记账，切换零补推
            await self._send_ws({"post_type": "user_msg", "session_id": self.id,
                                 "mid": u_entry["id"], "text": text})
        self._arm_turn_timer()
        await self.bridge.turn_gate()
        try:
            await self._write_line({"type": "user",
                                    "message": {"role": "user",
                                                "content": [{"type": "text", "text": text}]},
                                    "parent_tool_use_id": None,
                                    "session_id": self.cli_uuid})
            log.info(json.dumps({"ev": "turn_start", "session_id": self.id}))
        except Exception as e:
            self.turn_active = False
            self._cancel_turn_timer()
            await self._send_ws({"post_type": "error", "session_id": self.id,
                                 "code": "send_failed", "message": str(e), "echo": echo})

    def _arm_turn_timer(self):
        if TURN_TIMEOUT <= 0:
            return  # turn_timeout <= 0 = 不限时
        self._cancel_turn_timer()
        self.turn_timer = asyncio.get_event_loop().call_later(
            TURN_TIMEOUT, lambda: asyncio.ensure_future(self._turn_timeout()))

    def _cancel_turn_timer(self):
        if self.turn_timer:
            self.turn_timer.cancel()
            self.turn_timer = None

    async def _turn_timeout(self):
        if not self.turn_active:
            return
        log.info(json.dumps({"ev": "turn_timeout", "session_id": self.id}))
        await self.abort(reason="timeout")

    async def abort(self, reason="user"):
        """stop: SIGTERM the process group; next send resumes via --resume."""
        if not self.turn_active:
            await self._send_ws({"post_type": "error", "session_id": self.id,
                                 "code": "not_running", "message": "no active turn"})
            return
        self._killpg()
        if not self.aborted_sent:
            self.aborted_sent = True
            self.turn_active = False
            self._cancel_turn_timer()
            sealed = self._flush_text_log()  # 中断前已出的正文也记入 turn_log，补推时不丢
            if sealed:
                await self._send_ws({"post_type": "cc_msg", "session_id": self.id,
                                     "mid": sealed["id"], "text": sealed["text"]})
            await self._send_ws({"post_type": "turn_aborted", "session_id": self.id,
                                 "reason": reason, "echo": self.turn_echo})

    def _killpg(self):
        if self.proc and self.proc.returncode is None:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass

    async def _announce_ready(self, model):
        if self.ready_announced:
            # 懒恢复的会话已即时发过 session_ready：这里只静默同步 CLI
            # 上报的实际模型（sessions.list / 后续帧保持准确），不再重发帧——
            # 它会落在第一轮生成中间，客户端误判为接管截断
            if model:
                self.model_name = model
            return
        self.ready_announced = True
        self.ready.set()
        self.last_activity = now()
        if model:
            self.model_name = model
        await self._send_ws({"post_type": "session_ready", "session_id": self.id,
                             "model": self.model_name,
                             "channel": (self.channel or {}).get("name"),
                             "permission_mode": self.permission_mode,
                             "echo": self.pending_echo})
        self.pending_echo = None  # 只随首次就绪回一次，之后的重发不带旧 echo
        log.info(json.dumps({"ev": "session_ready", "session_id": self.id}))

    async def _handle_result(self, obj):
        self.turn_active = False
        self._cancel_turn_timer()
        self.last_activity = now()
        usage = obj.get("usage") or {}
        final_text = obj.get("result") or "".join(self.text_buf)
        # 收尾落正文（与客户端 final 封口同边界）；不再用 result 整轮记一条，
        # 否则 turn_log 里同一轮正文出现两遍，takeover 补推就重复渲染。
        # 是否写过以 flush 返回值为准——turnlog 顶着 200 上限时写入+裁剪长度
        # 不变，按 len 前后判断会失明，result 整文被再记一遍（同秒 twins）
        sealed = self._flush_text_log()
        final_mid = (sealed or {}).get("id")
        # 全轮无 delta、正文只在 result 里的轮（如纯静默跑工具后直接出结果）：
        # 不补记的话 turn_log 缺这轮回答，跨端 resume 补推就丢这条
        if not sealed and final_text.strip():
            final_mid = (self._log_turn("cc", final_text) or {}).get("id")
        await self._send_ws({"post_type": "final", "session_id": self.id,
                             "text": final_text,
                             "mid": final_mid,
                             "usage": {"input_tokens": usage.get("input_tokens"),
                                       "output_tokens": usage.get("output_tokens"),
                                       "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
                                       "reasoning_tokens": usage.get("reasoning_tokens")},
                             "cost_usd": obj.get("total_cost_usd"),
                             "duration_ms": obj.get("duration_ms"),
                             "num_turns": obj.get("num_turns"),
                             "is_error": obj.get("is_error", False),
                             "subtype": obj.get("subtype"),
                             "echo": self.turn_echo})
        # turn done: if owner is gone, release the claude process slot now
        # (turn_log stays in memory for offline replay; resume restarts via --resume)
        if self.detached:
            self._killpg()
        log.info(json.dumps({"ev": "turn_end", "session_id": self.id,
                             "dur_ms": obj.get("duration_ms"),
                             "out_tokens": usage.get("output_tokens"),
                             "is_error": obj.get("is_error")}))

    # ---------- permission / ask ----------
    async def _handle_control_request(self, obj):
        request_id = obj.get("request_id")
        req = obj.get("request") or {}
        if req.get("subtype") == "can_use_tool":
            # 客户端在 ask 处封口正文块，turn_log 必须用同一边界落盘：
            # 否则补推时服务端一条(ask前+ask后)对不上本地两条，整段重复补推
            sealed = self._flush_text_log()
            if sealed:
                await self._send_ws({"post_type": "cc_msg", "session_id": self.id,
                                     "mid": sealed["id"], "text": sealed["text"]})
            tool_name = req.get("tool_name")
            ask_id = uuid.uuid4().hex
            kind = "question" if tool_name == "AskUserQuestion" else "permission"
            ask_frame = {"post_type": "ask", "session_id": self.id,
                         "ask_id": ask_id, "kind": kind,
                         "tool_name": tool_name,
                         "input": req.get("input") or {}}
            entry = {"request_id": request_id, "tool_name": tool_name,
                     "ask_frame": ask_frame}
            loop = asyncio.get_event_loop()
            entry["timer"] = loop.call_later(
                ASK_TIMEOUT, lambda: asyncio.ensure_future(self._ask_timeout(ask_id)))
            self.pending_asks[ask_id] = entry
            self.last_activity = now()
            await self._send_ws(ask_frame)
            log.info(json.dumps({"ev": "ask", "session_id": self.id,
                                 "tool": tool_name, "kind": kind}))
        else:
            await self._write_line({"type": "control_response",
                                    "response": {"subtype": "success", "request_id": request_id,
                                                 "response": {"behavior": "deny",
                                                              "message": "unsupported control request"}}})

    async def _ask_timeout(self, ask_id):
        entry = self.pending_asks.pop(ask_id, None)
        if not entry:
            return
        # 超时事件留痕：之前完全无日志，排查只能靠 ask 反复出现反推
        log.info(json.dumps({"ev": "ask_timeout", "session_id": self.id,
                             "tool": (entry.get("ask_frame") or {}).get("tool_name")}))
        try:
            await self._write_line({"type": "control_response",
                                    "response": {"subtype": "success",
                                                 "request_id": entry["request_id"],
                                                 "response": {"behavior": "deny",
                                                              "message": "ask timeout, denied by bridge"}}})
        except Exception:
            pass
        await self._send_ws({"post_type": "error", "session_id": self.id,
                             "code": "ask_timeout", "ask_id": ask_id})

    async def _expire_all_asks(self):
        for ask_id in list(self.pending_asks):
            await self._ask_timeout(ask_id)

    async def ask_reply(self, ask_id, behavior, message=None, updated_input=None, echo=None):
        entry = self.pending_asks.pop(ask_id, None)
        if not entry:
            await self._send_ws({"post_type": "error", "session_id": self.id,
                                 "code": "unknown_ask", "ask_id": ask_id, "echo": echo})
            return
        if entry.get("timer"):
            entry["timer"].cancel()
        if behavior == "allow":
            resp = {"behavior": "allow"}
            if updated_input is not None:
                resp["updatedInput"] = updated_input
        else:
            resp = {"behavior": "deny", "message": message or "denied by user"}
        try:
            await self._write_line({"type": "control_response",
                                    "response": {"subtype": "success",
                                                 "request_id": entry["request_id"],
                                                 "response": resp}})
        except Exception as e:
            await self._send_ws({"post_type": "error", "session_id": self.id,
                                 "code": "ask_reply_failed", "message": str(e), "echo": echo})
            return
        # ack with the client's echo: rcSend() arms a request timer that only
        # clears when a frame carrying that echo returns; without this ack
        # every successful ask_reply pseudo-times out on the client
        await self._send_ws({"post_type": "ask_replied", "session_id": self.id,
                             "ask_id": ask_id, "behavior": behavior, "echo": echo})

    async def set_permission(self, mode, echo=None):
        """切换权限等级：运行时经 set_permission_mode 控制请求直达 CLI（免重启、
        免逐条前端审批）。进程未起时只记参数，下次 start 按新模式拉起。
        mode 透传给 CLI（default / acceptEdits / bypassPermissions / plan …），
        非法值由 CLI 报错经 set_permission_failed 返回。"""
        if not mode:
            mode = PERMISSION_MODE
        self.launch_mode = mode  # 之后任何重启/恢复都按新模式拉起
        self._save_sess_meta()  # 身份落盘：回收/重启后 revive 仍保持该等级
        if not (self.proc and self.proc.returncode is None):
            self.permission_mode = mode
            await self._send_ws({"post_type": "permission_ack", "session_id": self.id,
                                 "mode": mode, "applied": False, "echo": echo})
            return
        # 8s：turn 之前 CLI 应答在 1-2s 内；带工具调用的 turn 之后控制请求
        # 常常彻底不应答（实测 30s+ 无回包），超时即走重启兜底，不再干等
        if await self._switch_proc_mode(mode):
            await self._send_ws({"post_type": "permission_ack", "session_id": self.id,
                                 "mode": mode, "applied": True, "echo": echo})
            return
        # 控制请求失败（不应答 / CLI 报错）：turn 空闲时按新模式重启进程兜底，
        # --resume 保留历史；turn 进行中则暂存 pending_mode，下次 send 前补切
        if self.turn_active:
            self.pending_mode = mode
            await self._send_ws({"post_type": "error", "session_id": self.id,
                                 "code": "busy", "message": "cannot switch permission during turn",
                                 "echo": echo})
            return
        await self._restart_for_mode(mode, echo)

    async def _switch_proc_mode(self, mode, timeout=8.0):
        """运行时静默切权限：只发 set_permission_mode 控制请求，成功即同步
        permission_mode；失败只留日志，不重启不报错——launch_mode 已记账，
        下次 spawn 自然按新模式拉起。接管同步 / send 前补切共用。"""
        req_id = "spm-" + secrets.token_hex(4)
        fut = asyncio.get_event_loop().create_future()
        self._ctl_futures[req_id] = fut
        try:
            await self._write_line({"type": "control_request", "request_id": req_id,
                                    "request": {"subtype": "set_permission_mode", "mode": mode}})
        except Exception as e:
            self._ctl_futures.pop(req_id, None)
            log.info(json.dumps({"ev": "perm_switch_err", "session_id": self.id, "err": str(e)}))
            return False
        try:
            resp = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self._ctl_futures.pop(req_id, None)
            resp = None
        if resp is not None and resp.get("subtype") == "success":
            self.permission_mode = mode
            log.info(json.dumps({"ev": "permission_mode", "session_id": self.id, "mode": mode}))
            return True
        log.info(json.dumps({"ev": "perm_switch_failed", "session_id": self.id, "mode": mode}))
        return False

    async def _defer_switch_mode(self, mode):
        """接管同步触发的后台切权：失败不重启（接管不能杀进程），暂存
        pending_mode 交由下次 send 前补切——那时 CLI 刚应答过握手，
        控制请求必达（轮刚结束/工具密集轮之后常彻底不应答）。"""
        if not await self._switch_proc_mode(mode):
            self.pending_mode = mode

    async def _restart_for_mode(self, mode, echo=None):
        self.launch_mode = mode
        self.permission_mode = mode
        self.pending_mode = None  # 重启即按新模式拉起，暂存作废
        log.info(json.dumps({"ev": "permission_restart", "session_id": self.id, "mode": mode}))
        self._killpg()
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            await self.start()
        except Exception as e:
            await self._send_ws({"post_type": "error", "session_id": self.id,
                                 "code": "set_permission_failed", "message": str(e), "echo": echo})
            return
        self.ready_announced = False
        await self._send_ws({"post_type": "permission_ack", "session_id": self.id,
                             "mode": mode, "applied": True, "echo": echo})

    async def set_channel(self, channel, model=None, echo=None, clear=False):
        """切换 API 渠道/模型。环境变量与 --settings 都属于进程启动参数，
        必须重启 CLI 才生效：turn 空闲 → 重启（--resume 保留历史）；
        进程没起 → 只记参数下次 start 生效；turn 进行中 → busy。
        clear=True 且 channel=None：显式清除会话上的渠道/模型绑定，
        回到机器默认（完全继承环境/登录态）。"""
        if channel is None and model is None and not clear:
            # 什么都没指定：无事可做（防误清当前渠道绑定）
            await self._send_ws({"post_type": "model_ack", "session_id": self.id,
                                 "channel": (self.channel or {}).get("name"),
                                 "model": self.model_name, "applied": False, "echo": echo})
            return
        if channel is None and model and not clear and self.channel is not None:
            channel = dict(self.channel)  # 只改模型：在当前显式渠道上覆盖
        if channel is not None and model:
            channel = dict(channel)
            channel["model"] = model
        self.channel = channel
        if channel is None:
            # 机器默认：渠道清空（继承端点/登录态），模型可独立经 --model 指定
            self.model_name = model or None
        else:
            self.model_name = channel.get("model") or None
        self._save_sess_meta()  # 渠道/模型也是会话身份：随权限一起落盘
        chan_name = (channel or {}).get("name")
        if self.turn_active:
            await self._send_ws({"post_type": "error", "session_id": self.id,
                                 "code": "busy", "message": "cannot switch model during turn",
                                 "echo": echo})
            return
        if not (self.proc and self.proc.returncode is None):
            await self._send_ws({"post_type": "model_ack", "session_id": self.id,
                                 "channel": chan_name, "model": self.model_name,
                                 "applied": False, "echo": echo})
            return
        log.info(json.dumps({"ev": "channel_restart", "session_id": self.id,
                             "channel": chan_name, "model": self.model_name}))
        self._killpg()
        try:
            await asyncio.wait_for(self.proc.wait(), timeout=5)
        except asyncio.TimeoutError:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            await self.start()
        except Exception as e:
            await self._send_ws({"post_type": "error", "session_id": self.id,
                                 "code": "set_channel_failed", "message": str(e), "echo": echo})
            return
        self.ready_announced = False
        await self._send_ws({"post_type": "model_ack", "session_id": self.id,
                             "channel": chan_name, "model": self.model_name,
                             "applied": True, "echo": echo})

    # ---------- teardown ----------
    async def close(self, reason="dropped", notify=True, echo=None):
        if self.closed:
            return
        self.closed = True
        self._cancel_turn_timer()
        if self.proc and self.proc.returncode is None:
            self._killpg()
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                try:
                    os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
        await self._expire_all_asks()
        if notify:
            await self._send_ws({"post_type": "session_closed", "session_id": self.id,
                                 "reason": reason, "echo": echo})
        log.info(json.dumps({"ev": "session_closed", "session_id": self.id, "reason": reason}))

    # 会话事件流帧：广播给所有已认证连接（QQ 多会话模型——客户端按
    # session_id 路由：当前会话进消息区，其余实时记账进各会话本地仓）。
    # 其余帧（history/session_ready/各类 echo 回执）是请求-应答，只发触发方。
    # user_msg/cc_msg = 带唯一 id 的成品条目（用户消息/封口正文段）：
    # 不观看该会话的端凭它们实时落仓，切换时零补推。
    STREAM_POST_TYPES = {"delta", "thinking", "tool_activity", "final",
                         "cc_msg", "user_msg", "turn_aborted", "ask",
                         "ask_replied", "session_closed"}

    async def _send_ws(self, obj):
        t = obj.get("post_type")
        # 无 echo 的 error（如 ask_timeout）是会话事件同样广播；带 echo 的是请求回执
        broadcast = t in self.STREAM_POST_TYPES or (t == "error" and not obj.get("echo"))
        data = json.dumps(obj, ensure_ascii=False)
        if broadcast:
            targets = [c for c in self.bridge.conns if not c.closed]
        else:
            targets = [self.ws] if (self.ws and not self.ws.closed) else []
        for c in targets:
            try:
                await c.send_str(data)
            except Exception:
                pass


class Bridge:
    def __init__(self):
        self.sessions = {}  # sid -> Session
        self.queue = []     # [{sid, ws, echo}]
        self.conns = set()  # 所有已认证 WS 连接：会话事件流广播的目标
        self.last_turn_start = 0.0
        self.gate_lock = asyncio.Lock()

    async def turn_gate(self):
        async with self.gate_lock:
            wait = MIN_TURN_INTERVAL - (now() - self.last_turn_start)
            if wait > 0:
                await asyncio.sleep(wait)
            self.last_turn_start = now()

    def active_count(self):
        # started_once but proc is None (mid-start) must count as active: otherwise
        # two concurrent _promote_queue runs can both see a free slot and
        # oversubscribe MAX_ACTIVE. 懒恢复注册的会话（从未 spawn，started_once
        # 仍为 False）不占名额——它们只是登记了 turn_log，没有进程开销
        return sum(1 for s in self.sessions.values()
                   if not s.closed and (
                       (s.proc is not None and s.proc.returncode is None)
                       or (s.proc is None and s.started_once)))

    def notify_capacity_change(self):
        asyncio.ensure_future(self._promote_queue())

    async def _send_history(self, ws, sid, entries, echo=None):
        """history 帧统一出口：带上末条 id（last_mid），客户端以此对水位。"""
        await self._ws_send(ws, {"post_type": "history", "session_id": sid,
                                 "messages": entries,
                                 "last_ts": (entries[-1].get("ts") if entries else None),
                                 "last_mid": (entries[-1].get("id") if entries else None),
                                 "echo": echo})

    async def sessions_sync(self, ws, params, echo):
        """连接时的一次性增量同步（QQ 模型）：客户端上报各会话已同步到的
        消息 id 水位（marks: {sid: mid|ts}），服务端只回各会话水位之后的
        增量 history。同时：服务端有而客户端没报的会话（别的端建的）全量
        推一次；所有挂起 ask 重发（卡片在客户端落仓，切换也能答）；
        attach 指定的会话接管绑定 ws + 回 session_ready（替代切换时 resume）。
        之后连接期间全靠广播实时推送，切换会话零网络往返。"""
        marks = params.get("marks") or {}
        if not isinstance(marks, dict):
            marks = {}
        attach = params.get("attach")
        # 同步集合 = 服务端全部 ∪ 客户端上报：报了水位的走增量（_replay_after），
        # 没报的全量；两头都有的会话也必须处理（重连的当前会话——
        # 增量补推 + 挂起 ask 重发 + attach 接管都靠这一轮）
        sids = list(self.sessions) + [sid for sid in marks if sid not in self.sessions]
        count = 0
        for sid in sids:
            if not (isinstance(sid, str) and 1 <= len(sid) <= 64
                    and all(c.isalnum() or c in "-_" for c in sid)):
                continue
            s = self.sessions.get(sid)
            if s is None or s.closed:
                # 懒登记：只读盘上 turnlog，不占名额不拉进程；没有记录的跳过
                if not os.path.exists(os.path.join(WORKSPACES, sid, "turnlog.jsonl")):
                    continue
                # 权限来源：盘上 sess.json 优先（别的端显式设过的等级），
                # 没有才用本次上报的全局开关（存量旧会话的自愈入口）
                s = Session(self, sid, None, resume=True,
                            permission_mode=_sidecar_mode(sid) or params.get("permission_mode"))
                s.ready_announced = True  # 懒登记不产 session_ready 帧
                self.sessions[sid] = s
            rep = s._replay_after(marks.get(sid))
            if rep:
                await self._send_history(ws, sid, rep)
                count += 1
            # 挂起的提问重发：卡片在客户端实时仓里，切过去就能答
            for ask_id, entry in list(s.pending_asks.items()):
                frame = dict(entry.get("ask_frame") or {})
                if frame:
                    await self._ws_send(ws, frame)
            if sid == attach and not s.closed:
                s.ws = ws
                s.detached = False
                await self._ws_send(ws, {"post_type": "session_ready", "session_id": sid,
                                         "model": s.model_name,
                                         "channel": (s.channel or {}).get("name"),
                                         "turn_active": s.turn_active,
                                         "permission_mode": s.permission_mode,
                                         "echo": echo})
                log.info(json.dumps({"ev": "sync_attach", "session_id": sid,
                                     "turn_active": s.turn_active}))
        await self._ws_send(ws, {"post_type": "sync_done", "count": count, "echo": echo})
        log.info(json.dumps({"ev": "sessions_sync", "peer_sessions": len(sids),
                             "pushed": count, "attach": attach}))

    async def _promote_queue(self):
        while self.queue and self.active_count() < MAX_ACTIVE:
            item = self.queue.pop(0)
            sid, ws, echo = item["sid"], item["ws"], item["echo"]
            if ws.closed or sid in self.sessions:
                continue
            s = Session(self, sid, ws, permission_mode=item.get("permission_mode"),
                        channel=item.get("channel"), model=item.get("model"))
            self.sessions[sid] = s
            s.pending_echo = echo
            try:
                await s.start()
            except Exception as e:
                await self._ws_send(ws, {"post_type": "error", "session_id": sid,
                                         "code": "spawn_failed", "message": str(e), "echo": echo})
                self.sessions.pop(sid, None)
                continue
            # 排队转正同样补推（客户端对齐去重）
            if s.turn_log:
                await self._send_history(ws, sid, s._replay_messages(), echo)

    async def new_session(self, ws, params, echo):
        sid = params.get("session_id") or uuid.uuid4().hex
        if not (1 <= len(sid) <= 64) or not all(c.isalnum() or c in "-_" for c in sid):
            await self._ws_send(ws, {"post_type": "error", "code": "bad_session_id", "echo": echo})
            return
        # 显式指定的渠道先校验。默认渠道只用于新建会话——接管已有会话时
        # 不强行套默认渠道（避免把别的客户端建好的会话撬到别的端点上）
        channel = None
        if params.get("channel"):
            channel = channel_by_name(params.get("channel"))
            if channel is None:
                await self._ws_send(ws, {"post_type": "error", "code": "bad_channel",
                                         "channel": params.get("channel"), "echo": echo})
                return
        # 客户端绑定的模型：随会话创建/接管下发（优先于渠道配置值）
        model = params.get("model") or None
        existing = self.sessions.get(sid)
        if existing and not existing.closed:
            # 同名重连一律接管（修半开连接残留导致的"连不上"）：
            # 重新绑 ws、清 detached、重发未答复 ask、同步 turn 状态，不再报 exists
            existing.ws = ws
            existing.detached = False
            # 接管同步渠道/模型/权限：只记账、绝不重启进程。turn_active 不可靠
            # ——前台 result 先到、后台子代理仍在跑（或提问挂起）时它已是 False，
            # 此时 killpg 会把整轮产物杀在半路，切换补推的历史断在工具条上、
            # 总结永久丢失（实测：探索轮 00:08 result、00:13 才出总结，切换即被杀）。
            # 直接赋值即可：活进程用旧端点跑完本轮，下次自然 spawn 换新值；
            # 用户显式要求立即切换仍走 set_model 路由（主动操作、重启可见）
            sync_channel = channel is not None and channel.get("name") != (existing.channel or {}).get("name")
            sync_model = bool(model) and model != getattr(existing, "model_name", None)
            want_mode = params.get("permission_mode")
            sync_mode = bool(want_mode) and existing.permission_mode != want_mode
            proc_alive = bool(existing.proc and existing.proc.returncode is None)
            if sync_channel:
                existing.channel = channel
                existing.model_name = (model or channel.get("model")) or None
                log.info(json.dumps({"ev": "takeover_sync", "session_id": sid,
                                     "channel": channel.get("name"), "model": existing.model_name,
                                     "deferred": proc_alive}))
            elif sync_model:
                existing.model_name = model
                log.info(json.dumps({"ev": "takeover_sync", "session_id": sid,
                                     "model": model, "deferred": proc_alive}))
            if sync_mode:
                # 权限必须真切换，不能只改账面：launch_mode（之后 spawn 用）+
                # 活进程发 set_permission_mode 控制请求 + 落盘 sess.json。
                # 只改 permission_mode 的话，session_ready 回报新模式、CLI 还
                # 跑旧模式——前端显示「完全允许」却照旧逐条弹权限。轮在跑时
                # 控制请求常不应答，暂存 pending_mode 由下次 send 前补切，
                # 绝不在这里重启进程（接管杀进程会丢在跑的轮）
                existing.launch_mode = want_mode
                existing.permission_mode = want_mode
                if proc_alive:
                    if existing.turn_active:
                        existing.pending_mode = want_mode
                    else:
                        asyncio.ensure_future(existing._defer_switch_mode(want_mode))
                log.info(json.dumps({"ev": "takeover_sync", "session_id": sid,
                                     "permission_mode": want_mode, "deferred": proc_alive}))
            if sync_channel or sync_model or sync_mode:
                existing._save_sess_meta()
            for ask_id, entry in list(existing.pending_asks.items()):
                frame = dict(entry.get("ask_frame") or {})
                if frame:
                    await self._ws_send(ws, frame)
            await self._send_history(ws, sid, existing._replay_messages(), echo)
            await self._ws_send(ws, {"post_type": "session_ready", "session_id": sid,
                                     "model": getattr(existing, "model_name", None),
                                     "channel": (existing.channel or {}).get("name"),
                                     "turn_active": existing.turn_active,
                                     "permission_mode": existing.permission_mode,
                                     "echo": echo})
            log.info(json.dumps({"ev": "takeover", "session_id": sid,
                                 "replay": len(existing.turn_log),
                                 "pending_asks": len(existing.pending_asks),
                                 "turn_active": existing.turn_active}))
            # 进程已死但有历史的接管同样预热（懒恢复同款）：重连/切换后
            # 首发消息不用等冷启动；满载或轮在跑则不拉
            if not existing.turn_active \
                    and not (existing.proc and existing.proc.returncode is None) \
                    and existing.turn_log and self.active_count() < MAX_ACTIVE:
                asyncio.ensure_future(existing._warm_start())
            return
        if any(q["sid"] == sid for q in self.queue):
            await self._ws_send(ws, {"post_type": "error", "session_id": sid,
                                     "code": "exists", "message": "session already queued", "echo": echo})
            return
        # 新建会话：未显式指定渠道时套默认渠道（若有）
        if channel is None and DEFAULT_CHANNEL:
            channel = channel_by_name(DEFAULT_CHANNEL)
        if params.get("resume"):
            s = Session(self, sid, ws, resume=True,
                        permission_mode=params.get("permission_mode"), channel=channel,
                        model=model)
            self.sessions[sid] = s
            # 懒恢复：不立即拉 CLI。--resume 在大会话（几 MB transcript）上冷启动
            # 是分钟级，而切换会话要的是历史记录不是进程——turn_log（构造时已从
            # 盘上恢复）重放 + session_ready 立即返回，CLI 等真正发消息时再由
            # send() 按需 spawn（--resume 保留上下文）。
            s.ready_announced = True
            replay = s._replay_messages()
            # resume 也补推 turn_log（含盘上恢复的断线期间产物）；
            # 客户端按序对齐去重，已有内容不会重复渲染
            if replay:
                await self._send_history(ws, sid, replay, echo)
            await self._ws_send(ws, {"post_type": "session_ready", "session_id": sid,
                                     "model": s.model_name,
                                     "channel": (s.channel or {}).get("name"),
                                     "turn_active": s.turn_active,
                                     "permission_mode": s.permission_mode,
                                     "echo": echo})
            # 有历史且有空位：后台预热 CLI（首发消息大概率已就绪，不用干等
            # 分钟级冷启动）；满载/无历史保持纯懒，send 时按需拉起
            warm = bool(replay) and self.active_count() < MAX_ACTIVE
            if warm:
                asyncio.ensure_future(s._warm_start())
            log.info(json.dumps({"ev": "resume_lazy", "session_id": sid,
                                 "replay": len(replay), "warm": warm}))
            return
        if self.active_count() >= MAX_ACTIVE:
            if len(self.queue) >= QUEUE_MAX:
                await self._ws_send(ws, {"post_type": "error", "code": "queue_full",
                                         "message": "session queue is full", "echo": echo})
                return
            self.queue.append({"sid": sid, "ws": ws, "echo": echo, "ts": now(),
                               "permission_mode": params.get("permission_mode"),
                               "channel": channel, "model": model})
            await self._ws_send(ws, {"post_type": "session_queued", "session_id": sid,
                                     "position": len(self.queue), "echo": echo})
            log.info(json.dumps({"ev": "queued", "session_id": sid, "position": len(self.queue)}))
            return
        s = Session(self, sid, ws, permission_mode=params.get("permission_mode"),
                    channel=channel, model=model)
        self.sessions[sid] = s
        s.pending_echo = echo
        try:
            await s.start()
        except Exception as e:
            await self._ws_send(ws, {"post_type": "error", "session_id": sid,
                                     "code": "spawn_failed", "message": str(e), "echo": echo})
            self.sessions.pop(sid, None)
            return
        # 直连新建同样补推（盘上可能残留历史，如 bridge 重启后首连）
        if s.turn_log:
            await self._send_history(ws, sid, s._replay_messages(), echo)

    async def on_ws_closed(self, ws):
        """Owner gone: detach owned sessions (keep process + turn_log for offline
        replay on resume) and drop owned queue entries. Idle reaper will reap
        detached sessions after idle_timeout_s."""
        for sid, s in list(self.sessions.items()):
            if s.ws is ws and not s.closed:
                s.detached = True
                s.ws = None
                if not s.turn_active:
                    # not mid-turn: free the claude process slot; replay data stays in memory
                    s._killpg()
        self.queue = [q for q in self.queue if q["ws"] is not ws]
        self.notify_capacity_change()

    async def idle_reaper(self):
        """Close sessions idle beyond idle_timeout_s (they can resume later)."""
        while True:
            await asyncio.sleep(60)
            if IDLE_TIMEOUT <= 0:
                continue
            cut = now() - IDLE_TIMEOUT
            for sid, s in list(self.sessions.items()):
                if not s.closed and not s.turn_active and s.last_activity < cut:
                    await s.close(reason="idle_timeout")
                    self.sessions.pop(sid, None)
            stale = [q for q in self.queue if q.get("ts", now()) <= cut]
            if stale:
                self.queue = [q for q in self.queue if q.get("ts", now()) > cut]
                for q in stale:
                    await self._ws_send(q["ws"], {"post_type": "error", "session_id": q["sid"],
                                                  "code": "queue_timeout", "echo": q.get("echo")})
            self.notify_capacity_change()

    async def channel_test(self, ws, params, echo):
        """渠道/模型连通性测试：直接向渠道端点发一条最小 /v1/messages 请求，
        不经过 CLI（不占会话名额、不重启进程）——测的是「这个渠道+模型现在能不能用」。
        未显式指定渠道时测 default_channel；两者皆无（机器默认走 CLI 登录态）则如实报不可测。"""
        ch = channel_by_name(params.get("channel")) if params.get("channel") else None
        if ch is None and DEFAULT_CHANNEL:
            ch = channel_by_name(DEFAULT_CHANNEL)
        model = params.get("model") or (ch or {}).get("model") or ""
        name = (ch or {}).get("name") or ""
        if not ch or not ch.get("base_url") or not ch.get("api_key"):
            await self._ws_send(ws, {"post_type": "channel_test", "ok": False,
                                     "channel": name,
                                     "error": "该渠道无独立端点/密钥（机器默认走 CLI 登录态），无法直测",
                                     "echo": echo})
            return
        url = ch["base_url"].rstrip("/") + "/v1/messages"
        headers = {"content-type": "application/json",
                   "anthropic-version": "2023-06-01",
                   # 官方端点认 x-api-key，多数中转认 Bearer——两派都带，各自取需
                   "x-api-key": ch["api_key"], "authorization": "Bearer " + ch["api_key"]}
        payload = {"model": model or "ping", "max_tokens": 8,
                   "messages": [{"role": "user", "content": "ping"}]}
        t0 = now()
        try:
            timeout = aiohttp.ClientTimeout(total=20)
            async with aiohttp.ClientSession(timeout=timeout) as http:
                async with http.post(url, json=payload, headers=headers) as resp:
                    body = await resp.text()
                    await self._ws_send(ws, {"post_type": "channel_test",
                                             "ok": resp.status == 200,
                                             "channel": name, "model": model,
                                             "status": resp.status,
                                             "latency_ms": int((now() - t0) * 1000),
                                             "error": "" if resp.status == 200
                                             else ("HTTP %s: %s" % (resp.status, body[:200])),
                                             "echo": echo})
        except Exception as e:
            await self._ws_send(ws, {"post_type": "channel_test", "ok": False,
                                     "channel": name, "model": model,
                                     "error": str(e)[:200], "echo": echo})

    async def channel_models(self, ws, params, echo):
        """拉取渠道上游的可用模型列表：GET {base_url}/v1/models（Anthropic 兼容
        端点，OpenAI 兼容的同路径响应同样归一）。密钥不出服务器，不经过 CLI。"""
        ch = channel_by_name(params.get("channel")) if params.get("channel") else None
        name = (ch or {}).get("name") or ""
        if not ch or not ch.get("base_url") or not ch.get("api_key"):
            await self._ws_send(ws, {"post_type": "channel_models", "channel": name,
                                     "models": [],
                                     "error": "该渠道无独立端点/密钥（机器默认走 CLI 登录态），无法拉取",
                                     "echo": echo})
            return
        url = ch["base_url"].rstrip("/") + "/v1/models"
        headers = {"anthropic-version": "2023-06-01",
                   "x-api-key": ch["api_key"], "authorization": "Bearer " + ch["api_key"]}
        try:
            timeout = aiohttp.ClientTimeout(total=15)
            async with aiohttp.ClientSession(timeout=timeout) as http:
                async with http.get(url, headers=headers) as resp:
                    body = await resp.text()
                    if resp.status != 200:
                        await self._ws_send(ws, {"post_type": "channel_models", "channel": name,
                                                 "models": [],
                                                 "error": "HTTP %s: %s" % (resp.status, body[:200]),
                                                 "echo": echo})
                        return
                    try:
                        data = json.loads(body)
                    except Exception:
                        data = {}
                    items = data.get("data") if isinstance(data, dict) else data
                    models = []
                    if isinstance(items, list):
                        for it in items:
                            mid = it.get("id") if isinstance(it, dict) else it
                            mid = str(mid or "").strip()
                            if mid and mid not in models:
                                models.append(mid)
                    await self._ws_send(ws, {"post_type": "channel_models", "channel": name,
                                             "models": models,
                                             "error": "" if models else "上游返回空列表",
                                             "echo": echo})
        except Exception as e:
            await self._ws_send(ws, {"post_type": "channel_models", "channel": name,
                                     "models": [], "error": str(e)[:200], "echo": echo})

    async def _ws_send(self, ws, obj):
        if ws is None or ws.closed:
            return
        if obj.get("post_type") == "error":
            # 错误回执统一留痕：否则 busy/unknown_session 之类在日志里完全
            # 隐形，远端排查只能靠猜（事故 #10/#11 的教训）
            log.info(json.dumps({"ev": "error_reply", "code": obj.get("code"),
                                 "session_id": obj.get("session_id"),
                                 "action_echo": obj.get("echo")}, ensure_ascii=False))
        try:
            await ws.send_str(json.dumps(obj, ensure_ascii=False))
        except Exception:
            pass

    # ---------- ws entry ----------
    async def handle_ws(self, request):
        token = request.query.get("token", "")
        if not hmac.compare_digest(token, TOKEN) and token not in ONE_TIME_TOKENS:
            log.info(json.dumps({"ev": "auth_fail", "peer": request.remote}))
            return web.Response(status=401, text="unauthorized")
        if token in ONE_TIME_TOKENS:
            ONE_TIME_TOKENS.discard(token)
            persist_one_time_tokens()
            log.info(json.dumps({"ev": "otp_consumed", "peer": request.remote}))
        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=2 * 1024 * 1024)
        await ws.prepare(request)
        self.conns.add(ws)
        peer = request.remote
        log.info(json.dumps({"ev": "conn_open", "peer": peer}))
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    frame = json.loads(msg.data)
                except Exception:
                    await self._ws_send(ws, {"post_type": "error", "code": "bad_json"})
                    continue
                await self.route(ws, frame)
        finally:
            self.conns.discard(ws)
            log.info(json.dumps({"ev": "conn_close", "peer": peer}))
            await self.on_ws_closed(ws)
        return ws

    async def route(self, ws, frame):
        global DEFAULT_CHANNEL
        action = frame.get("action")
        params = frame.get("params") or {}
        echo = frame.get("echo")
        if action == "ping":
            await self._ws_send(ws, {"post_type": "pong", "ts": now(), "echo": echo})
        elif action == "new_session":
            await self.new_session(ws, params, echo)
        elif action == "sessions.sync":
            await self.sessions_sync(ws, params, echo)
        elif action == "send":
            sid = params.get("session_id")
            s = self.sessions.get(sid)
            if s is None or s.closed:
                # 懒复活：会话被闲置回收/桥重启后盘上 turnlog 还在——send 原地
                # 复活再送。纯本地切换（零网络）的会话桥端并不知道，发送是
                # 唯一能让两边对上的时机；报 unknown_session 会让客户端走
                # 重建分支，那条消息就丢在半路了
                valid = (isinstance(sid, str) and 1 <= len(sid) <= 64
                         and all(c.isalnum() or c in "-_" for c in sid))
                if valid and os.path.exists(os.path.join(WORKSPACES, sid, "turnlog.jsonl")):
                    # 发送方随帧带了权限等级（客户端全局开关）：revive 即按它拉起，
                    # 没有（旧客户端）才回落 sess.json / config 默认
                    s = Session(self, sid, None, resume=True,
                                permission_mode=params.get("permission_mode"))
                    s.ready_announced = True  # 不产 session_ready，send_ack 直接管
                    self.sessions[sid] = s
                    log.info(json.dumps({"ev": "revive_on_send", "session_id": sid}))
                else:
                    s = None
            if s is None:
                await self._ws_send(ws, {"post_type": "error", "code": "unknown_session",
                                         "session_id": sid, "echo": echo})
            else:
                s.ws = ws  # reattach event stream to current connection
                # 发送方的权限等级（客户端全局开关）与会话当前值不一致时真切换：
                # launch_mode + 落盘 + pending_mode（send 写用户行之前同步补切，
                # 不与本轮工具竞争）。存量旧会话没有 sess.json，靠这里自愈
                hint = params.get("permission_mode")
                if hint and hint != s.permission_mode:
                    s.launch_mode = hint
                    s.permission_mode = hint
                    s.pending_mode = hint
                    s._save_sess_meta()
                    log.info(json.dumps({"ev": "send_mode_sync", "session_id": sid,
                                         "permission_mode": hint}))
                if not s.turn_active:
                    # 立即回执（同 stop_ack 模式）：send 的 echo 若只随 final 回（分钟级），
                    # 客户端请求定时器会在长轮上伪超时——封口消息+插中断线，伤生成中内容。
                    # 忙路（turn_active）会立刻收到带 echo 的 busy 错误，无需回执
                    await self._ws_send(ws, {"post_type": "send_ack",
                                             "session_id": params.get("session_id"), "echo": echo})
                await s.send(params.get("text") or "", echo)
        elif action == "stop":
            s = self.sessions.get(params.get("session_id"))
            if not s or s.closed:
                await self._ws_send(ws, {"post_type": "error", "code": "unknown_session",
                                         "session_id": params.get("session_id"), "echo": echo})
            else:
                await s.abort(reason="user")
                # turn_aborted carries no echo; ack here so the client's
                # request timer clears
                await self._ws_send(ws, {"post_type": "stop_ack",
                                         "session_id": params.get("session_id"), "echo": echo})
        elif action == "drop_session":
            sid = params.get("session_id")
            s = self.sessions.pop(sid, None)
            self.queue = [q for q in self.queue if q["sid"] != sid]
            if s:
                s.forget_turnlog()  # 销毁：盘上补推记录一并清掉（客户端本地历史保留）
            if s and not s.closed:
                await s.close(reason="dropped", echo=echo)
            else:
                await self._ws_send(ws, {"post_type": "session_closed", "session_id": sid,
                                         "reason": "dropped", "echo": echo})
            self.notify_capacity_change()
        elif action == "sessions.list":
            out = []
            for sid, s in self.sessions.items():
                out.append({"session_id": sid, "alive": bool(s.proc and s.proc.returncode is None),
                            "turn_active": s.turn_active, "created_at": s.created_at,
                            "last_turn_at": s.last_turn_at,
                            "last_msg_ts": (s.turn_log[-1]["ts"] if s.turn_log else None),
                            "last_mid": (s.turn_log[-1].get("id") if s.turn_log else None),
                            "channel": (s.channel or {}).get("name"),
                            "model": s.model_name,
                            "title": s.turn_title()})
            for i, q in enumerate(self.queue):
                out.append({"session_id": q["sid"], "alive": False, "turn_active": False,
                            "queued": True, "queue_position": i + 1})
            await self._ws_send(ws, {"post_type": "sessions", "sessions": out, "echo": echo})
        elif action == "channels.list":
            # 密钥不回传明文，只给尾 4 位供辨认
            chans = []
            for ch in API_CHANNELS:
                if not isinstance(ch, dict):
                    continue
                key = str(ch.get("api_key") or "")
                chans.append({"name": ch.get("name"), "label": ch.get("label") or ch.get("name"),
                              "base_url": ch.get("base_url") or "",
                              "model": ch.get("model") or "",
                              "models": ch.get("models") or [],
                              "key_tail": key[-4:] if key else "",
                              "default": ch.get("name") == DEFAULT_CHANNEL})
            await self._ws_send(ws, {"post_type": "channels", "channels": chans,
                                     "default_channel": DEFAULT_CHANNEL, "echo": echo})
        elif action == "channels.save":
            # 客户端渠道管理：新增/编辑上游（端点 + Key）。upsert 按名覆盖，
            # 写回 config.json 持久化；重启后 API_CHANNELS 从盘上加载
            name = str(params.get("name") or "").strip()
            # 只收 ASCII 字母/数字/连字符/下划线（str.isalnum 会放行中文）
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", name):
                await self._ws_send(ws, {"post_type": "error", "code": "bad_channel_name",
                                         "message": "渠道名限英文/数字/连字符", "echo": echo})
                return
            base_url = str(params.get("base_url") or "").strip()
            # 归一化（词典笔键盘常见输入坑）：先剥尾部中文标点（输入法顺手
            # 带出的句号等），再把全角冒号/斜杠/句点转半角、去内部空白；
            # 缺协议自动补 https://——避免「看起来填了却总被拒」
            base_url = base_url.rstrip("．。.,;；，?？!！）) ").strip()
            base_url = base_url.replace("：", ":").replace("／", "/") \
                               .replace("．", ".").replace("。", ".")
            base_url = re.sub(r"\s+", "", base_url)
            if base_url and not re.match(r"(?i)^https?://", base_url):
                base_url = "https://" + base_url
            base_url = base_url.rstrip("/")
            if not base_url.startswith(("http://", "https://")):
                await self._ws_send(ws, {"post_type": "error", "code": "bad_channel",
                                         "message": "端点必须以 http(s):// 开头", "echo": echo})
                return
            entry = {"name": name,
                     "label": str(params.get("label") or "").strip() or name,
                     "base_url": base_url,
                     "api_key": str(params.get("api_key") or "").strip(),
                     "model": str(params.get("model") or "").strip()}
            for i, ch in enumerate(API_CHANNELS):
                if isinstance(ch, dict) and ch.get("name") == name:
                    # 编辑时 Key 留空 = 保留原值（客户端不回传明文）
                    if not entry["api_key"] and ch.get("api_key"):
                        entry["api_key"] = ch["api_key"]
                    API_CHANNELS[i] = entry
                    break
            else:
                API_CHANNELS.append(entry)
            persist_channels()
            log.info(json.dumps({"ev": "channel_saved", "channel": name}))
            await self._ws_send(ws, {"post_type": "channels_saved", "channel": name, "echo": echo})
        elif action == "channels.delete":
            name = str(params.get("channel") or "").strip()
            before = len(API_CHANNELS)
            API_CHANNELS[:] = [ch for ch in API_CHANNELS
                               if not (isinstance(ch, dict) and ch.get("name") == name)]
            removed = before - len(API_CHANNELS)
            if DEFAULT_CHANNEL == name:
                DEFAULT_CHANNEL = ""
                persist_channels()
            if removed:
                persist_channels()
                log.info(json.dumps({"ev": "channel_deleted", "channel": name}))
            await self._ws_send(ws, {"post_type": "channels_deleted",
                                     "channel": name, "removed": removed, "echo": echo})
        elif action == "channel.test":
            await self.channel_test(ws, params, echo)
        elif action == "channel.models":
            await self.channel_models(ws, params, echo)
        elif action == "set_model":
            s = self.sessions.get(params.get("session_id"))
            if not s or s.closed:
                await self._ws_send(ws, {"post_type": "error", "code": "unknown_session",
                                         "session_id": params.get("session_id"), "echo": echo})
                return
            chan = channel_by_name(params.get("channel")) if params.get("channel") else None
            if params.get("channel") and chan is None:
                await self._ws_send(ws, {"post_type": "error", "code": "bad_channel",
                                         "channel": params.get("channel"), "echo": echo})
                return
            # 显式传了空渠道（channel:""）= 切回机器默认：清除会话的渠道绑定，
            # 而不是「没传渠道」的只改模型语义
            if "channel" in params and not params.get("channel"):
                await s.set_channel(None, model=params.get("model"), echo=echo, clear=True)
                return
            await s.set_channel(chan, model=params.get("model"), echo=echo)
        elif action == "ask_reply":
            s = self.sessions.get(params.get("session_id"))
            if not s or s.closed:
                await self._ws_send(ws, {"post_type": "error", "code": "unknown_session", "echo": echo})
            else:
                await s.ask_reply(params.get("ask_id"), params.get("behavior"),
                                  message=params.get("message"),
                                  updated_input=params.get("updatedInput"),
                                  echo=echo)
        elif action == "set_permission":
            s = self.sessions.get(params.get("session_id"))
            if not s or s.closed:
                await self._ws_send(ws, {"post_type": "error", "code": "unknown_session",
                                         "session_id": params.get("session_id"), "echo": echo})
            else:
                await s.set_permission(params.get("mode"), echo=echo)
        else:
            await self._ws_send(ws, {"post_type": "error", "code": "unknown_action",
                                     "action": action, "echo": echo})


def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    os.makedirs(WORKSPACES, exist_ok=True)
    bridge = Bridge()
    app = web.Application()
    app.router.add_get("/ws", bridge.handle_ws)
    log.info(json.dumps({"ev": "start", "port": PORT, "max_active": MAX_ACTIVE}))

    async def _on_startup(app):
        app["reaper"] = asyncio.create_task(bridge.idle_reaper())

    async def _on_cleanup(app):
        app["reaper"].cancel()
        # claude subprocesses run in their own process groups (start_new_session);
        # kill them here so a bridge restart does not leak resident processes
        await asyncio.gather(*(s.close(notify=False)
                               for s in bridge.sessions.values()),
                             return_exceptions=True)

    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)

    # access_log=None: request lines carry ?token= and must never be logged
    web.run_app(app, host="0.0.0.0", port=PORT, print=None, access_log=None)


if __name__ == "__main__":
    main()
