"""Loopback bridge between the Zhiyi App backend and its PyQt floating ball.

This server lives inside the Python child process. It is bound only to 127.0.0.1
on an ephemeral port and requires a per-process bearer token. It deliberately
implements only the App-owned Ask flow; it does not proxy to the legacy plugin.
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

MAX_BODY_BYTES = 64 * 1024
ASK_TTL_SECONDS = 600
# 朗读结果只在球还开着的时候有意义；超过这个时间没人来取就丢掉，不留旧音频线索。
VOICE_RESULT_TTL_SECONDS = 180
# 断联提醒的寿命。旧版插件有同样的 RESUME_TTL_MS=30 分钟，迁到 App 时漏了。
RESUME_NOTICE_TTL_MS = 30 * 60 * 1000
# 自动续接成功的闪报只要亮几秒；留太久球会在下一轮轮询里把它当新消息重放。
RESUME_FLASH_TTL_MS = 8 * 1000
STOP_ACK = "zhiyi-ball-stopping-ack"
PARENT_ACK_TIMEOUT_SECONDS = 1.0


def describe_ball_view(payload, *, now=None, previous=None):
    """把球主线程报上来的窗口状态整理成一条能查的记录。

    进程活着不等于球在桌面上有位置：全屏挡帘会把球收起来，面板也可能被压住。
    判定只写在这一处，免得 App 侧和球侧各猜一套。

    payload 由球侧主线程采集：
      visible             窗口 isVisible()
      hiddenForFullscreen 被全屏挡帘收起来了
      fullscreenBusy      前台全屏且 popupOnTop 关着，面板弹不出来
      askable             球侧算好的综合结论

    返回 None 表示这份 payload 不能用（调用方保留上一份，等它自然过期）。
    """
    if not isinstance(payload, dict):
        return None
    stamp = time.time() if now is None else float(now)
    seq = int((previous or {}).get("seq") or 0) + 1
    visible = payload.get("visible") is True
    hidden = payload.get("hiddenForFullscreen") is True
    busy = payload.get("fullscreenBusy") is True
    return {
        "visible": visible,
        "askable": bool(payload.get("askable") is True and visible and not hidden and not busy),
        "hiddenForFullscreen": hidden,
        "fullscreenBusy": busy,
        "updatedAt": stamp,
        "seq": seq,
    }


def shutdown_after_parent_ack(
    control_stdout,
    control_stdin,
    bridge,
    timeout_seconds=PARENT_ACK_TIMEOUT_SECONDS,
):
    print(json.dumps({"type": "zhiyi-ball-stopping"}), file=control_stdout, flush=True)
    acknowledged = threading.Event()

    def wait_for_ack():
        try:
            while True:
                line = control_stdin.readline()
                if not line or line.strip() == STOP_ACK:
                    return
        except (OSError, ValueError):
            pass
        finally:
            acknowledged.set()

    reader = threading.Thread(target=wait_for_ack, name="zhiyi-parent-ack", daemon=True)
    try:
        reader.start()
        acknowledged.wait(max(0.0, float(timeout_seconds)))
    finally:
        bridge.close()
    if acknowledged.is_set():
        reader.join(timeout=0.1)


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False


class AppBallBridge:
    def __init__(self):
        self.token = secrets.token_urlsafe(32)
        self._lock = threading.RLock()
        self._asks = {}
        # 球在桌面上看不看得见。还没报过的时候一律当成看不见：
        # 先走配方卡，也强过把题发到一个没人看得见的地方。
        self._ballView = {
            "visible": False,
            "askable": False,
            "hiddenForFullscreen": False,
            "fullscreenBusy": False,
            "updatedAt": 0.0,
            "seq": 0,
        }
        # 朗读链路：球不能回调 App，只能轮询这个桥。App 主动下发，球取。
        self._voice = {
            "readOpen": False,
            "selectedEntryId": "",
            "selectionSeq": 0,
            "sessionId": "",
            "agentId": "",
            "replies": [],
            "result": None,
            "resultSeq": 0,
            "resultAt": 0.0,
            # 球上换了目标时记一个时间戳：让 App 忽略推送缓存，重拉一次列表。
            # 以前是个「读到即清」的布尔信号，但球自己也读同一个接口（开窗、刷新都要 GET），
            # 它抢在 App 前面把信号消费掉，App 就一直不重拉，切了窗口还是旧列表（2026-10-22 实机）。
            "forcePushAt": 0.0,
            # 朗读稿：球上改过字再念，就把稿子随选择一起报上来（空串 = 按原文念）。
            "selectedText": "",
            # 改稿时要一次全文：球的列表只带前 1200 字，走这条请求/结果对取全文。
            "textRequest": None,
            "textSeq": 0,
            "textResult": None,
            # 语音收藏：挂在朗读这条已有的桥上，不另开通道。
            "fav": None,
            "favSeq": 0,
            "favResult": None,
            "notice": None,
            # 回复行上的「朗读」按钮：App 合成完把文件路径放这里，球轮询到就自己放。
            # 宿主的 new Audio(...).play() 在 Electron 里会被自动播放策略静默拦掉（前端还 catch 掉不报错），
            # 所以出声这步交给常驻的球，播放器不受浏览器那条限制。
            "play": None,
            "playSeq": 0,
            # 循环续接状态（App 推来）：active/text/total/done，主面板用来显示进度。
            "loop": None,
            "action": None,
            "actionSeq": 0,
            "flash": None,
            "resumeEnabled": False,
            "autoResume": False,
            "maxConsecutive": 3,
            "progress": [],
        }
        # 球内推荐与目标跟随：球不能回调 App，只能轮询这个桥。
        # 球→App 只放一个 request（刷新/固定/取消固定），App→球 推目标+候选+推荐。
        self._recommend = {
            "request": None,        # 最近一次球发来的请求：{kind, sessionId, seq}
            "requestSeq": 0,
            "push": None,           # App 推给球的快照
            "pushSeq": 0,
        }
        # 守门人（活都干完再关机）：App 定时推一份快照过来，球只管显示。
        # 球上不挂开关、不做判定：那一步只看 App 一个来源，免得两边各算一套。
        self._sleep = {
            "state": None,
            "stateSeq": 0,
            # 球 → App：球上一级按钮的意图。App 轮询看到新 seq 就执行。
            # bootId 标记这是「哪一只球」：球重启后 seq 从 0 开始，
            # App 靠它分辨「号变小了」是重启而不是倒流。
            "action": None,
            "actionSeq": 0,
            "bootId": int(time.time() * 1000),
        }
        # 行为开关（全屏时弹窗要不要也浮上来）：设置页改一下，球下一轮就拿到。
        self._settings = {"popupOnTop": False, "themeMode": ""}
        # 球上右键菜单也能翻这个开关：它写进来，App 轮询读到后存盘并回推。
        self._settingsToggle = {"seq": 0, "key": "", "value": None}
        # 润色弹窗在球上，App 的 /polish 路由球够不着；走同款请求/结果对。
        self._polish = {
            "request": None,        # {kind: polish|send, text, level, sessionId, seq}
            "requestSeq": 0,
            "result": None,         # App 推给球的回包
            "resultSeq": 0,
        }
        # 会话标题：球上点「生成新标题/还原」时，起名与写回都在 App 侧（session:update 只有 App 够得着）。
        self._title = {
            "request": None,        # {kind: rename|undo, sessionId, seq}
            "requestSeq": 0,
            "result": None,         # App 推给球的回包
            "resultSeq": 0,
        }
        # 排队话单：球上写一句/一串话 → 排进对话；App 把话单状态推回来给球显示。
        self._queue = {
            "request": None,        # {kind: queue|queue-cancel, text, rounds, sessionId, seq}
            "requestSeq": 0,
            "state": None,          # App 推给球的话单状态（排队中第 n/N 轮等）
            "stateSeq": 0,
        }
        bridge = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format, *_args):
                # Do not write request paths or credentials to stdout/stderr.
                return

            def _reply(self, status, payload):
                data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)

            def _authorized(self):
                supplied = self.headers.get("X-Zhiyi-Token", "")
                return bool(supplied) and hmac.compare_digest(supplied, bridge.token)

            def _body(self):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except (TypeError, ValueError):
                    return None, (400, {"ok": False, "error": "请求长度无效"})
                if length < 0 or length > MAX_BODY_BYTES:
                    return None, (413, {"ok": False, "error": "请求内容过大"})
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    value = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    return None, (400, {"ok": False, "error": "请求内容不是有效 JSON"})
                if not isinstance(value, dict):
                    return None, (400, {"ok": False, "error": "请求内容必须是对象"})
                return value, None

            def do_GET(self):
                if not self._authorized():
                    return self._reply(403, {"ok": False, "error": "本地通道未授权"})
                parsed = urlsplit(self.path)
                query = parse_qs(parsed.query)
                status, payload = bridge._get(parsed.path, query)
                self._reply(status, payload)

            def do_POST(self):
                if not self._authorized():
                    return self._reply(403, {"ok": False, "error": "本地通道未授权"})
                body, error = self._body()
                if error:
                    return self._reply(*error)
                parsed = urlsplit(self.path)
                status, payload = bridge._post(parsed.path, body)
                self._reply(status, payload)

        self._server = _Server(("127.0.0.1", 0), Handler)
        self._thread = None

    @property
    def port(self):
        return int(self._server.server_address[1])

    @property
    def base_url(self):
        return f"http://127.0.0.1:{self.port}"

    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(
                target=self._server.serve_forever,
                name="zhiyi-app-bridge",
                daemon=True,
            )
            self._thread.start()
        return {"baseUrl": self.base_url, "token": self.token}

    def close(self):
        if self._thread is not None:
            self._server.shutdown()
            self._thread.join(timeout=2)
            self._thread = None
        self._server.server_close()

    def _prune(self):
        now = time.time()
        for ask_id, item in list(self._asks.items()):
            if item["status"] == "pending" and now >= item["expiresAt"]:
                item["status"] = "timeout"
                item["updatedAt"] = now
            if item["status"] != "pending" and now - item["updatedAt"] > ASK_TTL_SECONDS:
                self._asks.pop(ask_id, None)

    def set_ball_view(self, payload):
        """球侧主线程每隔一轮把窗口状态写进来。

        写坏了就当没收到，保留上一份等它过期；不从别的线程读 Qt。
        """
        with self._lock:
            record = describe_ball_view(payload, previous=self._ballView)
            if record is None:
                return False
            self._ballView = record
            return True

    def ball_view(self):
        with self._lock:
            return dict(self._ballView)

    def _get(self, path, query):
        with self._lock:
            self._prune()
            if path == "/health":
                return 200, {"ok": True, "running": True}
            if path == "/config":
                return 200, {"ok": True, "config": {"action": "copy", "askFlower": {"enabled": False}}}
            if path == "/settings/state":
                return 200, {"ok": True, "settings": dict(self._settings), "toggle": dict(self._settingsToggle)}
            if path == "/ask/pending":
                pending = [
                    item["entry"]
                    for item in self._asks.values()
                    if item["status"] == "pending"
                ]
                return 200, {
                    "ok": True,
                    "pending": pending,
                    "resume": [],
                    "resumeAuto": False,
                    "resumeNotices": [],
                }
            if path == "/ask/result":
                ask_id = (query.get("askId") or [""])[0]
                item = self._asks.get(ask_id)
                if not item:
                    return 404, {"ok": False, "error": "提问不存在或已过期"}
                if item["status"] != "pending" and "answer" in item:
                    return 200, {
                        "ok": True,
                        "status": item["status"],
                        "answer": item["answer"],
                    }
                return 200, {"ok": True, "status": item["status"]}
            if path == "/voice/state":
                self._prune_voice()
                voice = self._voice
                # forcePushAt 不清：球与 App 都在读这个接口，清就变成“谁先读谁吃掉”。
                # App 那边按「这个时间戳比上次大」自己判断要不要重拉。
                return 200, {
                    "ok": True,
                    "readOpen": bool(voice["readOpen"]),
                    "selectedEntryId": voice["selectedEntryId"],
                    "selectionSeq": int(voice["selectionSeq"]),
                    "sessionId": voice["sessionId"],
                    "replies": voice["replies"],
                    "result": voice["result"],
                    "resultSeq": int(voice["resultSeq"]),
                    "fav": voice["fav"],
                    "favSeq": int(voice["favSeq"]),
                    "favResult": voice["favResult"],
                    "forcePushAt": float(voice.get("forcePushAt") or 0.0),
                    "selectedText": voice.get("selectedText") or "",
                    "textRequest": voice.get("textRequest"),
                    "textSeq": int(voice.get("textSeq") or 0),
                    "textResult": voice.get("textResult"),
                }
            if path == "/voice/play":
                # 球轮询这个：App 把「放哪个文件」放进来，seq 变大就是新任务。
                return 200, {
                    "ok": True,
                    "seq": int(self._voice.get("playSeq") or 0),
                    "play": self._voice.get("play"),
                }
            if path == "/resume/state":
                # 提醒有寿命：旧版是 RESUME_TTL_MS = 30 分钟，这里补上。
                # 少了它，那条「已经试了 N 次」能挂一整天，用户会对着一个早就
                # 聊完的窗口点「继续哈」，它就真插进去一句。
                notice = self._voice["notice"]
                if isinstance(notice, dict) and notice.get("at"):
                    if time.time() - float(notice["at"]) / 1000.0 > RESUME_NOTICE_TTL_MS:
                        self._voice["notice"] = notice = None
                flash = self._voice["flash"]
                if isinstance(flash, dict) and flash.get("at"):
                    if time.time() - float(flash["at"]) / 1000.0 > RESUME_FLASH_TTL_MS:
                        self._voice["flash"] = flash = None
                return 200, {
                    "ok": True,
                    "notice": notice,
                    "action": self._voice["action"],
                    "actionSeq": int(self._voice["actionSeq"]),
                    "flash": flash,
                    "loop": self._voice.get("loop"),
                    "enabled": self._voice["resumeEnabled"],
                    "autoResume": self._voice["autoResume"],
                    "maxConsecutive": self._voice["maxConsecutive"],
                    "progress": self._voice["progress"],
                    # 话单状态顺手搭这条车：球已经每隔一会儿读一次这里了，
                    # 不用再单开一个轮询。排队话单不属于断点续接，单独一个字段。
                    "queue": self._queue["state"],
                    "queueSeq": int(self._queue["stateSeq"]),
                }
            if path == "/sleep/state":
                return 200, {
                    "ok": True,
                    "state": self._sleep["state"],
                    "stateSeq": int(self._sleep["stateSeq"]),
                    "action": self._sleep["action"],
                    "actionSeq": int(self._sleep["actionSeq"]),
                    "bootId": int(self._sleep["bootId"]),
                }
            if path == "/polish/state":
                # 润色弹窗在球上，App 里的 /polish 路由球够不着，走这一对请求/结果。
                return 200, {
                    "ok": True,
                    "request": self._polish["request"],
                    "requestSeq": int(self._polish["requestSeq"]),
                    "result": self._polish["result"],
                    "resultSeq": int(self._polish["resultSeq"]),
                }
            if path == "/queue/state":
                # 排队话单：球发请求、App 排队与回推状态，两边都从这条读。
                return 200, {
                    "ok": True,
                    "request": self._queue["request"],
                    "requestSeq": int(self._queue["requestSeq"]),
                    "state": self._queue["state"],
                    "stateSeq": int(self._queue["stateSeq"]),
                }
            if path == "/title/state":
                # 会话标题：球发请求、App 起名与写回，结果从这条读回。
                return 200, {
                    "ok": True,
                    "request": self._title["request"],
                    "requestSeq": int(self._title["requestSeq"]),
                    "result": self._title["result"],
                    "resultSeq": int(self._title["resultSeq"]),
                }
            if path == "/recommend/state":
                # 球轮询：拿到自己上次请求的回执（App 已读到的 request）与 App 推来的最新快照。
                return 200, {
                    "ok": True,
                    "request": self._recommend["request"],
                    "push": self._recommend["push"],
                    "pushSeq": int(self._recommend["pushSeq"]),
                }
            return 404, {"ok": False, "error": "知意没有开放这个接口"}

    def _prune_voice(self):
        voice = self._voice
        if voice["result"] is not None and time.time() - voice["resultAt"] > VOICE_RESULT_TTL_SECONDS:
            voice["result"] = None

    def _post(self, path, body):
        with self._lock:
            self._prune()
            if path == "/ask/enqueue":
                ask_id = body.get("askId")
                title = body.get("title")
                question = body.get("question")
                options = body.get("options")
                if not isinstance(ask_id, str) or not ask_id or len(ask_id) > 100:
                    return 400, {"ok": False, "error": "提问编号无效"}
                if not isinstance(title, str) or not title.strip() or len(title) > 60:
                    return 400, {"ok": False, "error": "标题无效"}
                if not isinstance(question, str) or not question.strip() or len(question) > 5000:
                    return 400, {"ok": False, "error": "问题无效"}
                if not isinstance(options, list) or not 2 <= len(options) <= 5:
                    return 400, {"ok": False, "error": "选项数量无效"}
                selection_mode = body.get("selectionMode", "single")
                if selection_mode not in ("single", "multiple"):
                    return 400, {"ok": False, "error": "选择模式无效"}
                if selection_mode == "multiple":
                    min_selections = body.get("minSelections", 1)
                    max_selections = body.get("maxSelections", len(options))
                    if type(min_selections) is not int or not 1 <= min_selections <= len(options):
                        return 400, {"ok": False, "error": "多选最少选择数无效"}
                    if type(max_selections) is not int or not 1 <= max_selections <= len(options):
                        return 400, {"ok": False, "error": "多选最多选择数无效"}
                    if min_selections > max_selections:
                        return 400, {"ok": False, "error": "多选最少选择数不能超过最多选择数"}
                else:
                    single_min = body.get("minSelections", 1)
                    single_max = body.get("maxSelections", 1)
                    if type(single_min) is not int or single_min != 1 or type(single_max) is not int or single_max != 1:
                        return 400, {"ok": False, "error": "单选题的选择数必须为 1"}
                    min_selections = max_selections = 1
                labels = []
                normalized_options = []
                for option in options:
                    if not isinstance(option, dict):
                        return 400, {"ok": False, "error": "选项格式无效"}
                    label = option.get("label")
                    detail = option.get("detail", "")
                    if not isinstance(label, str) or not label.strip() or len(label) > 100:
                        return 400, {"ok": False, "error": "选项标题无效"}
                    if not isinstance(detail, str) or len(detail) > 240:
                        return 400, {"ok": False, "error": "选项说明无效"}
                    labels.append(label.strip().casefold())
                    normalized_options.append({
                        "label": label.strip(),
                        "description": detail.strip(),
                        "recommended": label == body.get("recommendation"),
                    })
                if len(set(labels)) != len(labels):
                    return 400, {"ok": False, "error": "选项不能重名"}
                if ask_id in self._asks:
                    return 200, {"ok": True, "askId": ask_id, "already": True}
                if any(item["status"] == "pending" for item in self._asks.values()):
                    return 409, {"ok": False, "error": "传音樱正在处理另一个提问"}
                now = time.time()
                entry = {
                    "askId": ask_id,
                    "header": title.strip(),
                    "question": question.strip(),
                    "background": str(body.get("background") or "").strip(),
                    "recommendation": str(body.get("recommendation") or "").strip(),
                    "reason": str(body.get("reason") or "").strip(),
                    "options": normalized_options,
                    "selectionMode": selection_mode,
                    "minSelections": min_selections,
                    "maxSelections": max_selections,
                    "sessionTitle": str(body.get("sessionTitle") or "").strip()[:120],
                    "agentName": str(body.get("agentName") or "").strip()[:40],
                    # 回传地址：App 重载后靠它把这道题认回来，不然用户答了也不知道送回哪。
                    "sessionId": str(body.get("sessionId") or "").strip(),
                }
                self._asks[ask_id] = {
                    "status": "pending",
                    "entry": entry,
                    "expiresAt": now + ASK_TTL_SECONDS,
                    "updatedAt": now,
                }
                # 顺手把球的窗口状态带回去：App 侧靠它决定这道题要不要留
                # （球在桌上看不见时会立刻撤回，改用配方卡）。
                return 200, {"ok": True, "askId": ask_id, "view": self.ball_view()}

            if path in ("/ask/respond", "/ask/dismiss"):
                ask_id = body.get("askId")
                item = self._asks.get(ask_id) if isinstance(ask_id, str) else None
                if not item or item["status"] != "pending":
                    return 409, {"ok": False, "error": "提问不存在、已作答或已过期"}
                if path == "/ask/dismiss" or body.get("mode") == "skip":
                    item["status"] = "aborted" if path == "/ask/dismiss" else "rejected"
                    item["answer"] = {"action": item["status"]}
                    item["updatedAt"] = time.time()
                    return 200, {"ok": True, "askId": ask_id, "mode": "skip", "choice": ""}

                mode = body.get("mode")
                choice = body.get("choice")
                if mode == "option":
                    # 选项和补充说明是两件事：说明不能顶掉选择，也不能因为没写就凭空多一个字段。
                    raw_note = body.get("note")
                    note = ""
                    if raw_note is not None:
                        if not isinstance(raw_note, str):
                            return 400, {"ok": False, "error": "补充说明格式无效"}
                        note = raw_note.strip()
                        if len(note) > 500:
                            return 400, {"ok": False, "error": "补充说明不能超过 500 个字符"}
                    allowed = {option["label"] for option in item["entry"]["options"]}
                    if item["entry"]["selectionMode"] == "multiple":
                        if not isinstance(choice, list) or any(not isinstance(value, str) for value in choice):
                            return 400, {"ok": False, "error": "多选答案格式无效"}
                        selected = [value.strip() for value in choice]
                        if any(not value for value in selected) or len(set(selected)) != len(selected):
                            return 400, {"ok": False, "error": "多选答案不能为空或重复"}
                        if not item["entry"]["minSelections"] <= len(selected) <= item["entry"]["maxSelections"]:
                            return 400, {"ok": False, "error": "多选答案数量不符合要求"}
                        if any(value not in allowed for value in selected):
                            return 400, {"ok": False, "error": "所选项目不在当前问题的选项中"}
                        choice = selected
                    elif not isinstance(choice, str) or choice not in allowed:
                        return 400, {"ok": False, "error": "所选项目不在当前问题的选项中"}
                    value = {"choice": choice}
                    if note:
                        value["note"] = note
                    answer = {"action": "confirmed", "value": value}
                elif mode == "custom":
                    if not isinstance(choice, str) or not choice.strip() or len(choice.strip()) > 500:
                        return 400, {"ok": False, "error": "自定义回答不能为空且不能超过 500 个字符"}
                    answer = {"action": "confirmed", "value": {"customChoice": choice.strip()}}
                else:
                    return 400, {"ok": False, "error": "回答模式无效"}
                item["status"] = "answered"
                item["answer"] = answer
                item["updatedAt"] = time.time()
                return 200, {"ok": True, "askId": ask_id, "mode": mode, "choice": choice}

            if path == "/action":
                return 200, {"ok": True, "message": "已切换"}
            if path == "/voice/state":
                self._voice["readOpen"] = bool(body.get("readOpen"))
                if not self._voice["readOpen"]:
                    self._voice["result"] = None
                if body.get("forcePush"):
                    # 球上换了目标：给一个新的时间戳，App 下一轮读状态时看到变大就重推列表。
                    self._voice["forcePushAt"] = time.time()
                return 200, {"ok": True, "readOpen": self._voice["readOpen"]}
            if path == "/voice/play":
                # App → 球：回复行朗读的音频已经落盘，请球播放。
                body = body if isinstance(body, dict) else {}
                target = str(body.get("path") or "").strip()
                if not target or not os.path.exists(target):
                    return 400, {"ok": False, "error": "音频文件不存在"}
                self._voice["playSeq"] = int(self._voice.get("playSeq") or 0) + 1
                self._voice["play"] = {
                    "path": target,
                    "format": "wav" if body.get("format") == "wav" else "mp3",
                    "seq": self._voice["playSeq"],
                }
                return 200, {"ok": True, "playSeq": self._voice["playSeq"]}
            if path == "/voice/fav":
                # 球 → App：把刚朗读完的那段存进语音收藏。
                body = body if isinstance(body, dict) else {}
                clip_id = str(body.get("clipId") or "").strip()
                if not clip_id:
                    return 400, {"ok": False, "error": "没有可收藏的音频"}
                self._voice["favSeq"] = int(self._voice["favSeq"]) + 1
                self._voice["fav"] = {
                    "clipId": clip_id,
                    "text": str(body.get("text") or "")[:600],
                    "format": "wav" if body.get("format") == "wav" else "mp3",
                    "voiceId": str(body.get("voiceId") or ""),
                    "agentId": str(body.get("agentId") or ""),
                    "agentName": str(body.get("agentName") or ""),
                    "seq": self._voice["favSeq"],
                }
                return 200, {"ok": True, "favSeq": self._voice["favSeq"]}
            if path == "/voice/fav-result":
                # App → 球：收藏结果。
                body = body if isinstance(body, dict) else {}
                self._voice["favResult"] = body
                return 200, {"ok": True}
            if path == "/voice/select":
                entry_id = str(body.get("entryId") or "").strip()
                if not entry_id:
                    return 400, {"ok": False, "error": "没有选中要朗读的回复"}
                # 改过稿就带上稿子：App 那边走文字通道（不再拿 entryId 去拼原文）。
                draft_text = str(body.get("text") or "")
                self._voice["selectedEntryId"] = entry_id
                self._voice["selectedText"] = draft_text
                self._voice["selectionSeq"] = int(self._voice["selectionSeq"]) + 1
                self._voice["result"] = None
                return 200, {"ok": True, "entryId": entry_id, "selectionSeq": self._voice["selectionSeq"]}
            if path == "/voice/text-request":
                # 球点「改稿」时先要全文：列表里的 text 只到 1200 字，不能就让它在编辑器里缺后半截。
                entry_id = str(body.get("entryId") or "").strip()
                if not entry_id:
                    return 400, {"ok": False, "error": "没有要读哪一条"}
                self._voice["textSeq"] = int(self._voice["textSeq"]) + 1
                self._voice["textRequest"] = {
                    "seq": self._voice["textSeq"],
                    "entryId": entry_id,
                    "sessionId": self._voice["sessionId"],
                }
                self._voice["textResult"] = None
                return 200, {"ok": True, "textSeq": self._voice["textSeq"]}
            if path == "/voice/text-result":
                # App → 桥：全文回包。seq 对不上就丢，不能让旧回包顶掉新请求。
                body = body if isinstance(body, dict) else {}
                request = self._voice.get("textRequest")
                if isinstance(request, dict) and int(body.get("seq") or 0) == int(request.get("seq") or 0):
                    self._voice["textResult"] = {
                        "seq": int(body.get("seq") or 0),
                        "text": str(body.get("text") or ""),
                        "chars": int(body.get("chars") or 0),
                        "error": str(body.get("error") or ""),
                    }
                return 200, {"ok": True}
            if path == "/voice/push":
                replies = body.get("replies")
                if not isinstance(replies, list):
                    return 400, {"ok": False, "error": "回复列表格式不对"}
                self._voice["replies"] = [item for item in replies if isinstance(item, dict)][:12]
                self._voice["sessionId"] = str(body.get("sessionId") or "").strip()
                self._voice["agentId"] = str(body.get("agentId") or "").strip()
                return 200, {"ok": True, "count": len(self._voice["replies"])}
            if path == "/voice/result":
                self._voice["result"] = body
                self._voice["resultAt"] = time.time()
                self._voice["resultSeq"] = int(self._voice["resultSeq"]) + 1
                return 200, {"ok": True, "resultSeq": self._voice["resultSeq"]}
            if path == "/resume/progress":
                enabled = body.get("enabled", False)
                auto_resume = body.get("autoResume", False)
                maximum = body.get("maxConsecutive", 3)
                items = body.get("items", [])
                if type(enabled) is not bool or type(auto_resume) is not bool:
                    return 400, {"ok": False, "error": "续接开关格式无效"}
                if type(maximum) is not int or not 1 <= maximum <= 10:
                    return 400, {"ok": False, "error": "续接上限须为 1 到 10 次"}
                if not isinstance(items, list) or any(
                    not isinstance(item, dict) or not isinstance(item.get("sessionId"), str)
                    or not item["sessionId"] or item.get("status") not in ("waiting", "failed", "limit")
                    or type(item.get("attempt")) is not int or item["attempt"] < 0
                    or type(item.get("maxConsecutive")) is not int or not 1 <= item["maxConsecutive"] <= 10
                    for item in items
                ):
                    return 400, {"ok": False, "error": "续接进度格式无效"}
                self._voice.update({"resumeEnabled": enabled, "autoResume": auto_resume,
                                    "maxConsecutive": maximum, "progress": [dict(item) for item in items] if enabled else []})
                if not enabled:
                    if (self._voice.get("notice") or {}).get("source") != "loop_confirm":
                        self._voice["notice"] = None
                    self._voice["flash"] = None
                    action = self._voice.get("action") or {}
                    if action.get("action") in ("continue", "dismiss", "auto", "config"):
                        self._voice["action"] = None
                return 200, {"ok": True}
            if path == "/resume/notice":
                # App → 球：断联续接的小条（提醒落点，用户定的方案）。
                # at 由 App 写入；桥只做寿命判定，不自己造时间。
                body = body if isinstance(body, dict) else {}
                allowed = self._voice["resumeEnabled"] or body.get("source") == "loop_confirm"
                self._voice["notice"] = ({**body, "at": body.get("at") or time.time() * 1000.0}) if body and allowed else None
                return 200, {"ok": True, "hasNotice": self._voice["notice"] is not None}
            if path == "/resume/loop":
                # App → 球：循环续接的当前状态（主面板靠它显示进度和停止按钮）。
                body = body if isinstance(body, dict) else {}
                self._voice["loop"] = body or None
                return 200, {"ok": True}
            if path == "/resume/flash":
                # 自动续接成功的短暂反馈：只亮几秒，不占常驻小条。
                body = body if isinstance(body, dict) else {}
                self._voice["flash"] = ({**body, "at": body.get("at") or time.time() * 1000.0}) if body and self._voice["resumeEnabled"] else None
                return 200, {"ok": True}
            if path == "/resume/action":
                # 球 → App：用户点了「继续哈 / 不用管 / 自动续接开关 / 循环相关」。
                action = str(body.get("action") or "").strip()
                if action not in ("continue", "dismiss", "auto", "config", "loop-stop", "loop-resume", "loop-finish"):
                    return 400, {"ok": False, "error": "操作类型无效"}
                config = body.get("config")
                if action == "config" and (not isinstance(config, dict) or not config
                        or set(config) - {"autoResume", "maxConsecutive"}
                        or ("autoResume" in config and type(config["autoResume"]) is not bool)
                        or ("maxConsecutive" in config and (type(config["maxConsecutive"]) is not int
                            or not 1 <= config["maxConsecutive"] <= 10))):
                    return 400, {"ok": False, "error": "续接配置格式无效"}
                self._voice["action"] = {
                    "action": action,
                    "sessionId": str(body.get("sessionId") or ""),
                    "enabled": body.get("enabled"),
                    "rounds": body.get("rounds"),
                    **({"config": dict(config)} if action == "config" else {}),
                }
                self._voice["actionSeq"] = int(self._voice["actionSeq"]) + 1
                return 200, {"ok": True, "actionSeq": self._voice["actionSeq"]}
            if path == "/settings/toggle":
                # 球 → 桥：右键菜单里翻了开关。本地先认下来（球立刻生效），
                # 同时记一笔序号，App 轮询到之后存盘并回推，两边不会打架。
                body = body if isinstance(body, dict) else {}
                key = str(body.get("key") or "")
                if key not in ("popupOnTop",):
                    return 400, {"ok": False, "error": "不认识的开关"}
                value = body.get("value") is True
                self._settings[key] = value
                self._settingsToggle = {
                    "seq": int(self._settingsToggle["seq"]) + 1,
                    "key": key,
                    "value": value,
                }
                return 200, {"ok": True, "seq": self._settingsToggle["seq"]}
            if path == "/settings/push":
                # App → 桥：设置页改了行为开关，存下来给球下一轮轮询拿。
                body = body if isinstance(body, dict) else {}
                if "popupOnTop" in body:
                    self._settings["popupOnTop"] = body.get("popupOnTop") is True
                if body.get("themeMode") in ("dark", "light"):
                    self._settings["themeMode"] = body.get("themeMode")
                return 200, {"ok": True, "settings": dict(self._settings)}
            if path == "/polish/request":
                # 球 → App：请 ta 捋一捋 / 问还能往哪儿改 / 把捋好的发进对话。
                body = body if isinstance(body, dict) else {}
                kind = str(body.get("kind") or "").strip()
                if kind not in ("polish", "suggest", "send"):
                    return 400, {"ok": False, "error": "请求类型无效"}
                if not str(body.get("text") or "").strip():
                    return 400, {"ok": False, "error": "没有要处理的话"}
                self._polish["requestSeq"] = int(self._polish["requestSeq"]) + 1
                self._polish["request"] = {
                    "kind": kind,
                    "text": str(body.get("text") or ""),
                    "level": str(body.get("level") or "standard"),
                    "sessionId": str(body.get("sessionId") or ""),
                    # 原文锚点：最初那版原话。安全校验永远对着它，不跟着上一版漂。
                    "source": str(body.get("source") or ""),
                    # 上一版结果：有这个才走“只改点名处”的迭代。
                    "previous": str(body.get("previous") or ""),
                    # 用户这次额外提的整理方向（单行短句）。
                    "instruction": str(body.get("instruction") or ""),
                    # 发送时机：followUp 等这一轮说完再发，steer 立刻插话。
                    "deliverAs": "followUp" if str(body.get("deliverAs") or "") == "followUp" else "steer",
                    "seq": self._polish["requestSeq"],
                }
                return 200, {"ok": True, "seq": self._polish["requestSeq"]}
            if path == "/polish/push":
                # App → 球：结果。
                body = body if isinstance(body, dict) else {}
                self._polish["result"] = body
                self._polish["resultSeq"] = int(self._polish["resultSeq"]) + 1
                return 200, {"ok": True}
            if path == "/queue/request":
                # 球 → App：排一句（或一串话）进对话，或把话单停掉。
                body = body if isinstance(body, dict) else {}
                kind = str(body.get("kind") or "").strip()
                if kind not in ("queue", "queue-cancel"):
                    return 400, {"ok": False, "error": "请求类型无效"}
                if kind == "queue" and not str(body.get("text") or "").strip():
                    return 400, {"ok": False, "error": "没有要排的话"}
                try:
                    rounds = int(body.get("rounds") or 1)
                except (TypeError, ValueError):
                    rounds = 1
                self._queue["requestSeq"] = int(self._queue["requestSeq"]) + 1
                self._queue["request"] = {
                    "kind": kind,
                    "text": str(body.get("text") or ""),
                    "rounds": max(1, min(50, rounds)),
                    "sessionId": str(body.get("sessionId") or ""),
                    "agentName": str(body.get("agentName") or ""),
                    "title": str(body.get("title") or ""),
                    "seq": self._queue["requestSeq"],
                }
                return 200, {"ok": True, "seq": self._queue["requestSeq"]}
            if path == "/queue/push":
                # App → 球：话单状态（排队中第 n/N 轮）或这次请求的回执。
                body = body if isinstance(body, dict) else {}
                self._queue["state"] = body or None
                self._queue["stateSeq"] = int(self._queue["stateSeq"]) + 1
                return 200, {"ok": True}
            if path == "/title/request":
                # 球 → App：请 ta 给指定对话起名，或把上一次改的标题还原。
                body = body if isinstance(body, dict) else {}
                kind = str(body.get("kind") or "").strip()
                if kind not in ("rename", "undo"):
                    return 400, {"ok": False, "error": "请求类型无效"}
                self._title["requestSeq"] = int(self._title["requestSeq"]) + 1
                self._title["request"] = {
                    "kind": kind,
                    "sessionId": str(body.get("sessionId") or ""),
                    "seq": self._title["requestSeq"],
                }
                return 200, {"ok": True, "seq": self._title["requestSeq"]}
            if path == "/title/push":
                # App → 球：起名/还原的结果。
                body = body if isinstance(body, dict) else {}
                self._title["result"] = body
                self._title["resultSeq"] = int(self._title["resultSeq"]) + 1
                return 200, {"ok": True}
            if path == "/recommend/request":
                # 球 → App：请求刷新推荐、清空当前列表、固定某段对话或取消固定回跟随。
                kind = str(body.get("kind") or "").strip()
                if kind not in ("refresh", "pin", "auto", "clear"):
                    return 400, {"ok": False, "error": "请求类型无效"}
                session_id = str(body.get("sessionId") or "").strip()
                if kind == "pin" and not session_id:
                    return 400, {"ok": False, "error": "没有指定要固定的对话"}
                self._recommend["requestSeq"] = int(self._recommend["requestSeq"]) + 1
                self._recommend["request"] = {
                    "kind": kind,
                    "sessionId": session_id,
                    "seq": self._recommend["requestSeq"],
                }
                return 200, {"ok": True, "seq": self._recommend["requestSeq"]}
            if path == "/recommend/push":
                # App → 球：当前目标、最近候选与推荐列表（生成中时 suggestions 为空）。
                target = body.get("target")
                candidates = body.get("candidates")
                suggestions = body.get("suggestions")
                self._recommend["push"] = {
                    "target": target if isinstance(target, dict) else None,
                    "candidates": [item for item in candidates if isinstance(item, dict)][:5] if isinstance(candidates, list) else [],
                    "suggestions": [item for item in suggestions if isinstance(item, dict)][:4] if isinstance(suggestions, list) else [],
                    "notice": str(body.get("notice") or "")[:200],
                    "generating": bool(body.get("generating")),
                    "ackSeq": int(body.get("ackSeq") or 0),
                }
                self._recommend["pushSeq"] = int(self._recommend["pushSeq"]) + 1
                return 200, {"ok": True, "pushSeq": self._recommend["pushSeq"]}
            if path == "/sleep/state":
                # App → 球：守门人的当前快照，字段直接照搬，球不改写也不判定。
                payload = body if isinstance(body, dict) else {}
                self._sleep["state"] = {
                    "armed": bool(payload.get("armed")),
                    "status": str(payload.get("status") or "idle")[:24],
                    "idleSeconds": int(payload.get("idleSeconds") or 0),
                    "needSeconds": int(payload.get("needSeconds") or 0),
                    "countdownSeconds": int(payload.get("countdownSeconds") or 0),
                    "realEnabled": bool(payload.get("realEnabled")),
                    "busyCount": int(payload.get("busyCount") or 0),
                    "updatedAt": int(time.time() * 1000),
                }
                self._sleep["stateSeq"] = int(self._sleep["stateSeq"]) + 1
                return 200, {"ok": True, "stateSeq": self._sleep["stateSeq"]}
            if path == "/sleep/action":
                # 球 → App：一级按钮按下去的意图（arm / cancel）。
                # 球不做判定也不执行，只把 «人按了」 这件事交给 App。
                kind = str(body.get("kind") or "").strip().lower()
                if kind not in ("arm", "cancel"):
                    return 400, {"ok": False, "error": "只认 arm 和 cancel"}
                self._sleep["actionSeq"] = int(self._sleep["actionSeq"]) + 1
                self._sleep["action"] = {"kind": kind, "seq": self._sleep["actionSeq"]}
                return 200, {"ok": True, "actionSeq": self._sleep["actionSeq"]}
            return 404, {"ok": False, "error": "知意没有开放这个接口"}
