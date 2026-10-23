import json
import unittest
from io import StringIO
import threading
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app_bridge import AppBallBridge, STOP_ACK, shutdown_after_parent_ack


class AppBallBridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = AppBallBridge()

    def tearDown(self):
        self.bridge.close()

    @staticmethod
    def request(ask_id="a-1"):
        return {
            "askId": ask_id,
            "title": "选择迁移方式",
            "question": "采用哪种方式？",
            "options": [
                {"label": "直接迁移", "detail": "保留旧界面"},
                {"label": "重写界面", "detail": "使用 App 原生 UI"},
            ],
        }

    def test_enqueue_keeps_the_return_address_for_later_recovery(self):
        """App 重载后靠 pending 里的 sessionId 把题认回来，丢了这个字段就只能丢答案。"""
        request = self.request()
        request["sessionId"] = "sess_abc123"
        request["sessionTitle"] = "来源对话标题"
        request["agentName"] = "测试伙伴"
        status, _ = self.bridge._post("/ask/enqueue", request)
        self.assertEqual(status, 200)
        _, pending = self.bridge._get("/ask/pending", {})
        self.assertEqual(pending["pending"][0]["sessionId"], "sess_abc123")
        self.assertEqual(pending["pending"][0]["sessionTitle"], "来源对话标题")
        self.assertEqual(pending["pending"][0]["agentName"], "测试伙伴")
        self.assertEqual(pending["pending"][0]["header"], request["title"])

    def test_enqueue_without_session_id_still_works_but_leaves_it_empty(self):
        status, _ = self.bridge._post("/ask/enqueue", self.request())
        self.assertEqual(status, 200)
        _, pending = self.bridge._get("/ask/pending", {})
        self.assertEqual(pending["pending"][0]["sessionId"], "")
        self.assertEqual(pending["pending"][0]["sessionTitle"], "")
        self.assertEqual(pending["pending"][0]["agentName"], "")

    def test_enqueue_and_single_choice_returns_confirmed_answer(self):
        status, created = self.bridge._post("/ask/enqueue", self.request())
        self.assertEqual(status, 200)
        self.assertTrue(created["ok"])

        status, pending = self.bridge._get("/ask/pending", {})
        self.assertEqual(status, 200)
        self.assertEqual(pending["pending"][0]["askId"], "a-1")
        self.assertEqual(pending["pending"][0]["options"][0]["description"], "保留旧界面")

        status, response = self.bridge._post("/ask/respond", {
            "askId": "a-1", "mode": "option", "choice": "直接迁移",
        })
        self.assertEqual(status, 200)
        self.assertTrue(response["ok"])

        status, result = self.bridge._get("/ask/result", {"askId": ["a-1"]})
        self.assertEqual(status, 200)
        self.assertEqual(result["answer"], {
            "action": "confirmed", "value": {"choice": "直接迁移"},
        })

    def test_multiple_selection_is_bounded_and_returns_a_list(self):
        request = self.request()
        request.update({"selectionMode": "multiple", "minSelections": 2, "maxSelections": 2})
        status, created = self.bridge._post("/ask/enqueue", request)
        self.assertEqual(status, 200)
        self.assertTrue(created["ok"])
        _, pending = self.bridge._get("/ask/pending", {})
        self.assertEqual(pending["pending"][0]["selectionMode"], "multiple")
        self.assertEqual(pending["pending"][0]["minSelections"], 2)

        for invalid in (["直接迁移"], ["直接迁移", "直接迁移"], ["直接迁移", "不存在"]):
            status, response = self.bridge._post("/ask/respond", {
                "askId": "a-1", "mode": "option", "choice": invalid,
            })
            self.assertEqual(status, 400)
            self.assertFalse(response["ok"])
            self.assertEqual(self.bridge._get("/ask/result", {"askId": ["a-1"]})[1]["status"], "pending")

        status, response = self.bridge._post("/ask/respond", {
            "askId": "a-1", "mode": "option", "choice": ["直接迁移", "重写界面"],
        })
        self.assertEqual(status, 200)
        self.assertTrue(response["ok"])
        self.assertEqual(response["choice"], ["直接迁移", "重写界面"])
        _, result = self.bridge._get("/ask/result", {"askId": ["a-1"]})
        self.assertEqual(result["answer"], {
            "action": "confirmed", "value": {"choice": ["直接迁移", "重写界面"]},
        })

    def test_rejects_invalid_selection_ranges(self):
        request = self.request()
        request.update({"selectionMode": "multiple", "minSelections": 2, "maxSelections": 1})
        status, response = self.bridge._post("/ask/enqueue", request)
        self.assertEqual(status, 400)
        self.assertFalse(response["ok"])

    def test_pending_preserves_background_recommendation_and_reason_for_dialog(self):
        request = self.request()
        request.update({
            "background": "要保留已有页面。",
            "recommendation": "直接迁移",
            "reason": "改动较小。",
        })
        self.bridge._post("/ask/enqueue", request)
        _, pending = self.bridge._get("/ask/pending", {})
        entry = pending["pending"][0]
        self.assertEqual(entry["question"], "采用哪种方式？")
        self.assertEqual(entry["background"], "要保留已有页面。")
        self.assertEqual(entry["recommendation"], "直接迁移")
        self.assertEqual(entry["reason"], "改动较小。")
        self.assertTrue(entry["options"][0]["recommended"])
        self.assertFalse(entry["options"][1]["recommended"])

    def test_loopback_http_requires_token_and_round_trips_an_ask(self):
        bridge_info = self.bridge.start()
        endpoint = bridge_info["baseUrl"]
        try:
            urlopen(endpoint + "/health", timeout=2)
        except HTTPError as error:
            self.assertEqual(error.code, 403)
            error.close()
        else:
            self.fail("未带令牌的请求应被拒绝")

        payload = json.dumps(self.request()).encode("utf-8")
        request = Request(
            endpoint + "/ask/enqueue",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "X-Zhiyi-Token": bridge_info["token"],
            },
            method="POST",
        )
        with urlopen(request, timeout=2) as response:
            self.assertTrue(json.loads(response.read())["ok"])

        pending_request = Request(
            endpoint + "/ask/pending",
            headers={"X-Zhiyi-Token": bridge_info["token"]},
        )
        with urlopen(pending_request, timeout=2) as response:
            pending = json.loads(response.read())
        self.assertEqual(pending["pending"][0]["askId"], "a-1")

    def test_shutdown_waits_for_parent_ack_before_closing_bridge(self):
        class Bridge:
            closed = False

            def close(self):
                self.closed = True

        bridge = Bridge()

        class Input:
            lines = iter(["noise\n", STOP_ACK + "\n"])

            def readline(self):
                self_outer.assertFalse(bridge.closed)
                return next(self.lines)

        self_outer = self
        output = StringIO()
        shutdown_after_parent_ack(output, Input(), bridge)
        self.assertEqual(output.getvalue(), '{"type": "zhiyi-ball-stopping"}\n')
        self.assertTrue(bridge.closed)

    def test_shutdown_times_out_if_parent_stays_alive_without_ack(self):
        release_reader = threading.Event()
        reader_finished = threading.Event()

        class Bridge:
            closed = False

            def close(self):
                self.closed = True

        class SilentInput:
            def readline(self):
                release_reader.wait(1)
                reader_finished.set()
                return ""

        bridge = Bridge()
        started = time.monotonic()
        shutdown_after_parent_ack(
            StringIO(), SilentInput(), bridge, timeout_seconds=0.01,
        )
        self.assertTrue(bridge.closed)
        self.assertLess(time.monotonic() - started, 0.5)
        release_reader.set()
        self.assertTrue(reader_finished.wait(0.5))

    def test_single_choice_and_note_are_kept_together(self):
        """选了项又写了补充说明，两样都要留着；说明不能把选择顶掉。"""
        self.bridge._post("/ask/enqueue", self.request())
        status, response = self.bridge._post("/ask/respond", {
            "askId": "a-1", "mode": "option", "choice": "直接迁移", "note": "但保留旧配色",
        })
        self.assertEqual(status, 200)
        self.assertTrue(response["ok"])

        _, result = self.bridge._get("/ask/result", {"askId": ["a-1"]})
        self.assertEqual(result["answer"], {
            "action": "confirmed",
            "value": {"choice": "直接迁移", "note": "但保留旧配色"},
        })

    def test_multiple_choices_and_note_are_kept_together(self):
        request = self.request()
        request.update({"selectionMode": "multiple", "minSelections": 1, "maxSelections": 2})
        self.bridge._post("/ask/enqueue", request)
        status, _ = self.bridge._post("/ask/respond", {
            "askId": "a-1", "mode": "option",
            "choice": ["直接迁移", "重写界面"], "note": "先做迁移",
        })
        self.assertEqual(status, 200)

        _, result = self.bridge._get("/ask/result", {"askId": ["a-1"]})
        self.assertEqual(result["answer"]["value"]["choice"], ["直接迁移", "重写界面"])
        self.assertEqual(result["answer"]["value"]["note"], "先做迁移")

    def test_option_answer_without_note_stays_unchanged(self):
        """只选项不写说明的老用法不能变形，省略 note 时不要凭空多一个字段。"""
        self.bridge._post("/ask/enqueue", self.request())
        status, _ = self.bridge._post("/ask/respond", {
            "askId": "a-1", "mode": "option", "choice": "直接迁移",
        })
        self.assertEqual(status, 200)

        _, result = self.bridge._get("/ask/result", {"askId": ["a-1"]})
        self.assertEqual(result["answer"], {
            "action": "confirmed", "value": {"choice": "直接迁移"},
        })

    def test_note_that_is_not_a_string_is_rejected(self):
        self.bridge._post("/ask/enqueue", self.request())
        status, response = self.bridge._post("/ask/respond", {
            "askId": "a-1", "mode": "option", "choice": "直接迁移", "note": ["不是文本"],
        })
        self.assertEqual(status, 400)
        self.assertFalse(response["ok"])
        _, result = self.bridge._get("/ask/result", {"askId": ["a-1"]})
        self.assertEqual(result["status"], "pending")

    def test_note_longer_than_the_limit_is_rejected(self):
        self.bridge._post("/ask/enqueue", self.request())
        status, response = self.bridge._post("/ask/respond", {
            "askId": "a-1", "mode": "option", "choice": "直接迁移", "note": "字" * 501,
        })
        self.assertEqual(status, 400)
        self.assertFalse(response["ok"])
        _, result = self.bridge._get("/ask/result", {"askId": ["a-1"]})
        self.assertEqual(result["status"], "pending")

    def test_custom_answer_is_preserved_without_faking_an_option(self):
        self.bridge._post("/ask/enqueue", self.request())
        status, response = self.bridge._post("/ask/respond", {
            "askId": "a-1", "mode": "custom", "choice": "保留视觉，重写通信层",
        })
        self.assertEqual(status, 200)
        self.assertTrue(response["ok"])

        _, result = self.bridge._get("/ask/result", {"askId": ["a-1"]})
        self.assertEqual(result["answer"], {
            "action": "confirmed", "value": {"customChoice": "保留视觉，重写通信层"},
        })

    def test_invalid_option_does_not_complete_the_ask(self):
        self.bridge._post("/ask/enqueue", self.request())
        status, response = self.bridge._post("/ask/respond", {
            "askId": "a-1", "mode": "option", "choice": "随便编的答案",
        })
        self.assertEqual(status, 400)
        self.assertFalse(response["ok"])
        _, result = self.bridge._get("/ask/result", {"askId": ["a-1"]})
        self.assertEqual(result["status"], "pending")

    def test_only_one_pending_ask_is_shown_at_a_time(self):
        self.bridge._post("/ask/enqueue", self.request("a-1"))
        status, response = self.bridge._post("/ask/enqueue", self.request("a-2"))
        self.assertEqual(status, 409)
        self.assertFalse(response["ok"])

    def test_skip_and_dismiss_never_become_confirmed(self):
        self.bridge._post("/ask/enqueue", self.request("skip"))
        self.bridge._post("/ask/respond", {"askId": "skip", "mode": "skip"})
        _, skipped = self.bridge._get("/ask/result", {"askId": ["skip"]})
        self.assertEqual(skipped["status"], "rejected")
        self.assertEqual(skipped["answer"]["action"], "rejected")

        self.bridge._post("/ask/enqueue", self.request("dismiss"))
        self.bridge._post("/ask/dismiss", {"askId": "dismiss"})
        _, dismissed = self.bridge._get("/ask/result", {"askId": ["dismiss"]})
        self.assertEqual(dismissed["status"], "aborted")
        self.assertEqual(dismissed["answer"]["action"], "aborted")

    def test_expired_question_is_not_returned_as_pending(self):
        self.bridge._post("/ask/enqueue", self.request())
        self.bridge._asks["a-1"]["expiresAt"] = 0
        _, pending = self.bridge._get("/ask/pending", {})
        _, result = self.bridge._get("/ask/result", {"askId": ["a-1"]})
        self.assertEqual(pending["pending"], [])
        self.assertEqual(result["status"], "timeout")


    def test_voice_state_starts_closed_and_empty(self):
        status, state = self.bridge._get("/voice/state", {})
        self.assertEqual(status, 200)
        self.assertFalse(state["readOpen"])
        self.assertEqual(state["selectionSeq"], 0)
        self.assertEqual(state["replies"], [])
        self.assertIsNone(state["result"])

    def test_voice_select_bumps_sequence_and_clears_stale_result(self):
        self.bridge._post("/voice/result", {"ok": True, "entryId": "a-1", "clipId": "clip_old"})
        self.assertIsNotNone(self.bridge._get("/voice/state", {})[1]["result"])
        status, selected = self.bridge._post("/voice/select", {"entryId": "a-1"})
        self.assertEqual(status, 200)
        self.assertEqual(selected["selectionSeq"], 1)
        state = self.bridge._get("/voice/state", {})[1]
        self.assertEqual(state["selectedEntryId"], "a-1")
        self.assertIsNone(state["result"])
        self.bridge._post("/voice/select", {"entryId": "a-1"})
        self.assertEqual(self.bridge._get("/voice/state", {})[1]["selectionSeq"], 2)

    def test_voice_select_rejects_empty_entry(self):
        status, failed = self.bridge._post("/voice/select", {"entryId": "  "})
        self.assertEqual(status, 400)
        self.assertFalse(failed["ok"])

    def test_voice_push_stores_session_and_reply_list(self):
        status, pushed = self.bridge._post("/voice/push", {
            "sessionId": "sess-1",
            "agentId": "hanako",
            "replies": [{"entryId": "a-1", "preview": "念我", "chars": 2}, "坏数据"],
        })
        self.assertEqual(status, 200)
        self.assertEqual(pushed["count"], 1)
        state = self.bridge._get("/voice/state", {})[1]
        self.assertEqual(state["sessionId"], "sess-1")
        self.assertEqual(state["replies"][0]["entryId"], "a-1")
        status, failed = self.bridge._post("/voice/push", {"replies": "不是列表"})
        self.assertEqual(status, 400)

    def test_voice_force_push_survives_until_the_app_reads_it(self):
        # 球上换了目标要让 App 忽略推送缓存。以前是个「读到即清」的布尔，
        # 但球自己也读这个接口（开窗、刷新都 GET），抢先把信号吃掉，
        # App 永远看不到 → 切了窗口还是旧列表。现在改成时间戳，谁读都不清。
        self.bridge._post("/voice/state", {"readOpen": True, "forcePush": True})
        first = self.bridge._get("/voice/state", {})[1]["forcePushAt"]
        second = self.bridge._get("/voice/state", {})[1]["forcePushAt"]
        self.assertGreater(first, 0)
        self.assertEqual(first, second, "球多读一次不能把信号吃掉")

    def test_voice_draft_text_travels_with_selection(self):
        # 球改过稿就带着稿子来念：桥要把它存下，App 读状态时才看得到。
        self.bridge._post("/voice/select", {"entryId": "a-1", "text": "删改后的正文。"})
        state = self.bridge._get("/voice/state", {})[1]
        self.assertEqual(state["selectedText"], "删改后的正文。")
        self.assertEqual(state["selectedEntryId"], "a-1")  # 回包认领还要靠它

    def test_voice_full_text_request_and_result(self):
        # 球的列表只带前 1200 字，改稿时要一次全文，走这条请求/结果对。
        self.bridge._post("/voice/text-request", {"entryId": "a-1"})
        state = self.bridge._get("/voice/state", {})[1]
        seq = state["textSeq"]
        self.assertGreater(seq, 0)
        self.assertEqual(state["textRequest"]["entryId"], "a-1")
        # 序号对不上就不收，免得旧回包顶掉新请求。
        self.bridge._post("/voice/text-result", {"seq": seq - 1, "text": "旧的"})
        self.assertIsNone(self.bridge._get("/voice/state", {})[1]["textResult"])
        self.bridge._post("/voice/text-result", {"seq": seq, "text": "全文正文", "chars": 4})
        self.assertEqual(self.bridge._get("/voice/state", {})[1]["textResult"]["text"], "全文正文")

    def test_polish_request_keeps_delivery_timing(self):
        # 捋一捋窗有两个出口：「发送」是插话，「排队」是等这一轮说完再发。
        # 这个时机必须原样传给 App，不能在桥上丢掉。
        self.bridge._post("/polish/request", {"kind": "send", "text": "等你说完", "deliverAs": "followUp"})
        self.assertEqual(self.bridge._get("/polish/state", {})[1]["request"]["deliverAs"], "followUp")

    def test_polish_request_carries_anchor_and_instruction(self):
        # 接着改要三样东西：最初原文（锚）、上一版（基线）、这次的方向。
        # 桥上漏一个，「只改点名处」就退化成整篇重写。
        self.bridge._post("/polish/request", {
            "kind": "polish", "text": "上一版", "source": "最初原话",
            "previous": "上一版", "instruction": "收短一点",
        })
        req = self.bridge._get("/polish/state", {})[1]["request"]
        self.assertEqual(req["source"], "最初原话")
        self.assertEqual(req["previous"], "上一版")
        self.assertEqual(req["instruction"], "收短一点")

    def test_polish_request_accepts_suggest_kind(self):
        status, body = self.bridge._post("/polish/request", {"kind": "suggest", "text": "随便写点"})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])

    def test_polish_request_rejects_unknown_kind(self):
        status, _ = self.bridge._post("/polish/request", {"kind": "乱来", "text": "随便写点"})
        self.assertEqual(status, 400)
        self.bridge._post("/polish/request", {"kind": "send", "text": "插一句", "deliverAs": "steer"})
        self.assertEqual(self.bridge._get("/polish/state", {})[1]["request"]["deliverAs"], "steer")
        # 没带或认不出的值：保持老行为（插话），不静默改成排队
        self.bridge._post("/polish/request", {"kind": "send", "text": "默认"})
        self.assertEqual(self.bridge._get("/polish/state", {})[1]["request"]["deliverAs"], "steer")

    def test_closing_read_window_drops_the_pending_result(self):
        self.bridge._post("/voice/result", {"ok": True, "entryId": "a-1"})
        self.bridge._post("/voice/state", {"readOpen": False})
        state = self.bridge._get("/voice/state", {})[1]
        self.assertFalse(state["readOpen"])
        self.assertIsNone(state["result"])

    def test_stale_voice_result_expires(self):
        self.bridge._post("/voice/result", {"ok": True, "entryId": "a-1"})
        self.bridge._voice["resultAt"] = time.time() - 10_000
        self.assertIsNone(self.bridge._get("/voice/state", {})[1]["result"])


    def test_resume_notice_and_action_round_trip(self):
        status, empty = self.bridge._get("/resume/state", {})
        self.assertEqual(status, 200)
        self.assertIsNone(empty["notice"])
        self.assertIsNone(empty["action"])

        self.bridge._post("/resume/progress", {"enabled": True, "autoResume": False, "maxConsecutive": 3, "items": []})
        self.bridge._post("/resume/notice", {
            "sessionId": "sess-1", "reason": "这一轮停在半路了。", "attempt": 3,
            "maxConsecutive": 3, "autoResume": False,
        })
        state = self.bridge._get("/resume/state", {})[1]
        self.assertEqual(state["notice"]["sessionId"], "sess-1")

        self.bridge._post("/resume/action", {"action": "continue", "sessionId": "sess-1"})
        acted = self.bridge._get("/resume/state", {})[1]
        self.assertEqual(acted["action"]["action"], "continue")
        self.assertEqual(acted["actionSeq"], 1)

        status, bad = self.bridge._post("/resume/action", {"action": "删库"})
        self.assertEqual(status, 400)
        self.assertFalse(bad["ok"])
        self.assertEqual(self.bridge._get("/resume/state", {})[1]["actionSeq"], 1)


    def test_resume_progress_defaults_closed_and_replaces_full_list(self):
        _, initial = self.bridge._get("/resume/state", {})
        self.assertFalse(initial["enabled"])
        self.assertFalse(initial["autoResume"])
        self.assertEqual(initial["maxConsecutive"], 3)
        self.assertEqual(initial["progress"], [])
        items = [{"sessionId": f"test-{i}", "title": "测试窗口", "agentName": "测试伙伴",
                  "attempt": 1, "maxConsecutive": 3, "status": "waiting", "at": 123} for i in range(2)]
        status, _ = self.bridge._post("/resume/progress", {"enabled": True, "autoResume": True, "maxConsecutive": 3, "items": items})
        self.assertEqual(status, 200)
        state = self.bridge._get("/resume/state", {})[1]
        self.assertEqual(state["progress"], items)
        self.assertIsNone(state["notice"], "progress 不得生成 notice")
        self.bridge._post("/resume/progress", {"enabled": True, "maxConsecutive": 5, "items": []})
        state = self.bridge._get("/resume/state", {})[1]
        self.assertEqual(state["progress"], [])
        self.assertEqual(state["maxConsecutive"], 5)

    def test_resume_disabled_clears_stale_action_notice_and_flash_but_not_ask(self):
        self.bridge._post("/ask/enqueue", self.request())
        for action in ("continue", "dismiss", "auto", "config"):
            self.bridge._post("/resume/progress", {"enabled": True, "items": []})
            self.bridge._post("/resume/notice", {"sessionId": "test", "attempt": 1})
            self.bridge._post("/resume/flash", {"title": "测试窗口"})
            payload = {"action": action, "sessionId": "test", "enabled": True}
            if action == "config":
                payload["config"] = {"autoResume": True, "maxConsecutive": 3}
            self.bridge._post("/resume/action", payload)
            self.bridge._post("/resume/progress", {"enabled": False, "items": []})
            state = self.bridge._get("/resume/state", {})[1]
            self.assertIsNone(state["notice"])
            self.assertIsNone(state["flash"])
            self.assertIsNone(state["action"])
            self.assertEqual(state["progress"], [])
            self.assertEqual(len(self.bridge._get("/ask/pending", {})[1]["pending"]), 1)

    def test_resume_disabled_preserves_normal_chat_loop_confirmation_and_actions(self):
        self.bridge._post("/resume/notice", {"sessionId": "normal", "source": "loop_confirm"})
        self.bridge._post("/resume/loop", {"active": True, "sessionId": "normal"})
        for action in ("loop-stop", "loop-resume", "loop-finish"):
            self.bridge._post("/resume/action", {"action": action, "sessionId": "normal"})
            self.bridge._post("/resume/progress", {"enabled": False})
            state = self.bridge._get("/resume/state", {})[1]
            self.assertEqual(state["notice"]["source"], "loop_confirm")
            self.assertEqual(state["action"]["action"], action)
            self.assertTrue(state["loop"]["active"])

    def test_resume_config_action_keeps_bounded_settings_and_auto_intent(self):
        config = {"autoResume": True, "maxConsecutive": 10}
        status, result = self.bridge._post("/resume/action", {"action": "config", "config": config})
        self.assertEqual(status, 200)
        self.assertEqual(result["actionSeq"], 1)
        self.assertEqual(self.bridge._get("/resume/state", {})[1]["action"]["config"], config)
        for invalid in (0, 11, True, "3"):
            status, _ = self.bridge._post("/resume/action", {"action": "config", "config": {"autoResume": True, "maxConsecutive": invalid}})
            self.assertEqual(status, 400)
        for patch in ({"autoResume": False}, {"maxConsecutive": 4}):
            status, _ = self.bridge._post("/resume/action", {"action": "config", "config": patch})
            self.assertEqual(status, 200)
            self.assertEqual(self.bridge._get("/resume/state", {})[1]["action"]["config"], patch)
        for patch in ({}, {"enabled": True}, {"loopRounds": 10}, {"autoResume": "true"},
                      {"maxConsecutive": 4, "unknown": 1}):
            status, _ = self.bridge._post("/resume/action", {"action": "config", "config": patch})
            self.assertEqual(status, 400)
        self.bridge._post("/resume/action", {"action": "auto", "enabled": True})
        self.assertTrue(self.bridge._get("/resume/state", {})[1]["action"]["enabled"])

    def test_resume_progress_rejects_invalid_data_without_mutating_snapshot(self):
        for invalid in ({"enabled": "false"}, {"maxConsecutive": 0}, {"maxConsecutive": 11},
                        {"autoResume": 1}, {"items": "bad"}, {"items": [{"sessionId": "x", "status": "other"}]}):
            status, _ = self.bridge._post("/resume/progress", invalid)
            self.assertEqual(status, 400)
            self.assertFalse(self.bridge._get("/resume/state", {})[1]["enabled"])
        self.bridge._post("/resume/notice", {"sessionId": "disabled"})
        self.bridge._post("/resume/flash", {"title": "测试窗口"})
        state = self.bridge._get("/resume/state", {})[1]
        self.assertIsNone(state["notice"])
        self.assertIsNone(state["flash"])

    def test_resume_progress_http_requires_token(self):
        endpoint = self.bridge.start()["baseUrl"]
        request = Request(endpoint + "/resume/progress", data=b'{}', method="POST",
                          headers={"Content-Type": "application/json"})
        with self.assertRaises(HTTPError) as caught:
            urlopen(request, timeout=2)
        self.assertEqual(caught.exception.code, 403)
        caught.exception.close()

    def test_title_request_and_result_round_trip(self):
        status, empty = self.bridge._get("/title/state", {})
        self.assertEqual(status, 200)
        self.assertIsNone(empty["request"])
        self.assertIsNone(empty["result"])

        status, posted = self.bridge._post("/title/request", {"kind": "rename", "sessionId": "sess-1"})
        self.assertEqual(status, 200)
        self.assertEqual(posted["seq"], 1)
        state = self.bridge._get("/title/state", {})[1]
        self.assertEqual(state["request"]["kind"], "rename")
        self.assertEqual(state["request"]["sessionId"], "sess-1")
        self.assertEqual(state["requestSeq"], 1)

        status, bad = self.bridge._post("/title/request", {"kind": "删库"})
        self.assertEqual(status, 400)
        self.assertFalse(bad["ok"])
        self.assertEqual(self.bridge._get("/title/state", {})[1]["requestSeq"], 1)

        self.bridge._post("/title/push", {"ok": True, "kind": "rename", "title": "解语花调试", "seq": 1})
        state = self.bridge._get("/title/state", {})[1]
        self.assertEqual(state["result"]["title"], "解语花调试")
        self.assertEqual(state["resultSeq"], 1)

    def test_recommend_state_starts_empty(self):
        status, state = self.bridge._get("/recommend/state", {})
        self.assertEqual(status, 200)
        self.assertIsNone(state["request"])
        self.assertIsNone(state["push"])
        self.assertEqual(state["pushSeq"], 0)

    def test_recommend_request_bumps_sequence_and_rejects_unknown_kinds(self):
        status, first = self.bridge._post("/recommend/request", {"kind": "refresh"})
        self.assertEqual(status, 200)
        self.assertEqual(first["seq"], 1)
        self.assertEqual(self.bridge._get("/recommend/state", {})[1]["request"]["kind"], "refresh")

        status, pinned = self.bridge._post("/recommend/request", {"kind": "pin", "sessionId": "sess-9"})
        self.assertEqual(status, 200)
        self.assertEqual(pinned["seq"], 2)
        request = self.bridge._get("/recommend/state", {})[1]["request"]
        self.assertEqual(request["kind"], "pin")
        self.assertEqual(request["sessionId"], "sess-9")

        status, no_id = self.bridge._post("/recommend/request", {"kind": "pin"})
        self.assertEqual(status, 400)
        self.assertFalse(no_id["ok"])

        status, bad = self.bridge._post("/recommend/request", {"kind": "重装系统"})
        self.assertEqual(status, 400)
        self.assertFalse(bad["ok"])
        self.assertEqual(self.bridge._get("/recommend/state", {})[1]["request"]["seq"], 2)

    def test_recommend_push_stores_bounded_snapshot(self):
        status, pushed = self.bridge._post("/recommend/push", {
            "target": {"sessionId": "sess-1", "title": "今天", "agentName": "小花", "mode": "auto", "stale": False},
            "candidates": [{"sessionId": f"sess-{i}"} for i in range(8)],
            "suggestions": [{"text": f"建议{i}"} for i in range(6)],
            "notice": "" ,
            "generating": False,
            "ackSeq": 3,
        })
        self.assertEqual(status, 200)
        self.assertEqual(pushed["pushSeq"], 1)
        snapshot = self.bridge._get("/recommend/state", {})[1]["push"]
        self.assertEqual(snapshot["target"]["sessionId"], "sess-1")
        self.assertEqual(len(snapshot["candidates"]), 5)
        self.assertEqual(len(snapshot["suggestions"]), 4)
        self.assertEqual(snapshot["ackSeq"], 3)

        self.bridge._post("/recommend/push", {"target": None, "candidates": "坏数据", "suggestions": None})
        snapshot = self.bridge._get("/recommend/state", {})[1]["push"]
        self.assertIsNone(snapshot["target"])
        self.assertEqual(snapshot["candidates"], [])
        self.assertEqual(snapshot["suggestions"], [])

    def test_recommend_endpoints_require_token_over_http(self):
        bridge_info = self.bridge.start()
        endpoint = bridge_info["baseUrl"]
        try:
            urlopen(endpoint + "/recommend/state", timeout=2)
        except HTTPError as error:
            self.assertEqual(error.code, 403)
            error.close()
        else:
            self.fail("未带令牌的推荐接口请求应被拒绝")

        payload = json.dumps({"kind": "refresh"}).encode("utf-8")
        request = Request(
            endpoint + "/recommend/request",
            data=payload,
            headers={"Content-Type": "application/json", "X-Zhiyi-Token": bridge_info["token"]},
            method="POST",
        )
        with urlopen(request, timeout=2) as response:
            self.assertEqual(json.loads(response.read())["seq"], 1)


if __name__ == "__main__":
    unittest.main()
