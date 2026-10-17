"""Loopback bridge between the Zhiyi App backend and its PyQt floating ball.

This server lives inside the Python child process. It is bound only to 127.0.0.1
on an ephemeral port and requires a per-process bearer token. It deliberately
implements only the App-owned Ask flow; it does not proxy to the legacy plugin.
"""
from __future__ import annotations

import hmac
import json
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
STOP_ACK = "zhiyi-ball-stopping-ack"
PARENT_ACK_TIMEOUT_SECONDS = 1.0


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
            "notice": None,
            "action": None,
            "actionSeq": 0,
        }
        # 球内推荐与目标跟随：球不能回调 App，只能轮询这个桥。
        # 球→App 只放一个 request（刷新/固定/取消固定），App→球 推目标+候选+推荐。
        self._recommend = {
            "request": None,        # 最近一次球发来的请求：{kind, sessionId, seq}
            "requestSeq": 0,
            "push": None,           # App 推给球的快照
            "pushSeq": 0,
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

    def _get(self, path, query):
        with self._lock:
            self._prune()
            if path == "/health":
                return 200, {"ok": True, "running": True}
            if path == "/config":
                return 200, {"ok": True, "config": {"action": "copy", "askFlower": {"enabled": False}}}
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
                return 200, {
                    "ok": True,
                    "readOpen": bool(voice["readOpen"]),
                    "selectedEntryId": voice["selectedEntryId"],
                    "selectionSeq": int(voice["selectionSeq"]),
                    "sessionId": voice["sessionId"],
                    "replies": voice["replies"],
                    "result": voice["result"],
                    "resultSeq": int(voice["resultSeq"]),
                }
            if path == "/resume/state":
                return 200, {
                    "ok": True,
                    "notice": self._voice["notice"],
                    "action": self._voice["action"],
                    "actionSeq": int(self._voice["actionSeq"]),
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
                    "sessionTitle": "知意关键提问",
                    "agentName": "",
                }
                self._asks[ask_id] = {
                    "status": "pending",
                    "entry": entry,
                    "expiresAt": now + ASK_TTL_SECONDS,
                    "updatedAt": now,
                }
                return 200, {"ok": True, "askId": ask_id}

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
                    answer = {"action": "confirmed", "value": {"choice": choice}}
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
                return 200, {"ok": True, "readOpen": self._voice["readOpen"]}
            if path == "/voice/select":
                entry_id = str(body.get("entryId") or "").strip()
                if not entry_id:
                    return 400, {"ok": False, "error": "没有选中要朗读的回复"}
                self._voice["selectedEntryId"] = entry_id
                self._voice["selectionSeq"] = int(self._voice["selectionSeq"]) + 1
                self._voice["result"] = None
                return 200, {"ok": True, "entryId": entry_id, "selectionSeq": self._voice["selectionSeq"]}
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
            if path == "/resume/notice":
                # App → 球：断联续接的小条（提醒落点，用户定的方案）。
                self._voice["notice"] = body if isinstance(body, dict) and body else None
                return 200, {"ok": True, "hasNotice": self._voice["notice"] is not None}
            if path == "/resume/action":
                # 球 → App：用户点了「继续哈 / 不用管 / 自动续接开关」。
                action = str(body.get("action") or "").strip()
                if action not in ("continue", "dismiss", "auto"):
                    return 400, {"ok": False, "error": "操作类型无效"}
                self._voice["action"] = {
                    "action": action,
                    "sessionId": str(body.get("sessionId") or ""),
                    "enabled": body.get("enabled"),
                }
                self._voice["actionSeq"] = int(self._voice["actionSeq"]) + 1
                return 200, {"ok": True, "actionSeq": self._voice["actionSeq"]}
            if path == "/recommend/request":
                # 球 → App：请求刷新推荐、固定某段对话或取消固定回跟随。
                kind = str(body.get("kind") or "").strip()
                if kind not in ("refresh", "pin", "auto"):
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
            return 404, {"ok": False, "error": "知意没有开放这个接口"}
