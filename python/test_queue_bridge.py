"""排队话单的桥端点测试。

球上写一句话 → 桥收下 → App 读走排队 → 状态再推回来给球显示。
这条通道独立于润色/起名那两对，所以单独一个测试文件。
"""

import unittest

from app_bridge import AppBallBridge


class QueueBridgeTests(unittest.TestCase):
    def setUp(self):
        self.bridge = AppBallBridge()

    def tearDown(self):
        self.bridge.close()

    def test_queue_request_keeps_text_rounds_and_session(self):
        status, created = self.bridge._post("/queue/request", {
            "kind": "queue",
            "text": "第一句\n第二句",
            "rounds": 3,
            "sessionId": "sess_abc",
        })
        self.assertEqual(status, 200)
        self.assertEqual(created["seq"], 1)
        _, state = self.bridge._get("/queue/state", {})
        request = state["request"]
        self.assertEqual(request["kind"], "queue")
        self.assertEqual(request["text"], "第一句\n第二句")
        self.assertEqual(request["rounds"], 3)
        self.assertEqual(request["sessionId"], "sess_abc")
        self.assertEqual(request["seq"], 1)

    def test_queue_request_rejects_unknown_kind(self):
        status, body = self.bridge._post("/queue/request", {"kind": "wat", "text": "x"})
        self.assertEqual(status, 400)
        self.assertFalse(body["ok"])

    def test_queue_request_without_text_is_rejected(self):
        status, body = self.bridge._post("/queue/request", {"kind": "queue", "text": "   "})
        self.assertEqual(status, 400)

    def test_queue_cancel_needs_no_text(self):
        status, _ = self.bridge._post("/queue/request", {"kind": "queue-cancel", "sessionId": "sess_abc"})
        self.assertEqual(status, 200)
        _, state = self.bridge._get("/queue/state", {})
        self.assertEqual(state["request"]["kind"], "queue-cancel")

    def test_rounds_are_clamped_to_1_50(self):
        self.bridge._post("/queue/request", {"kind": "queue", "text": "x", "rounds": 999})
        _, state = self.bridge._get("/queue/state", {})
        self.assertEqual(state["request"]["rounds"], 50)
        self.bridge._post("/queue/request", {"kind": "queue", "text": "x", "rounds": 0})
        _, state = self.bridge._get("/queue/state", {})
        self.assertEqual(state["request"]["rounds"], 1)

    def test_state_push_is_visible_to_the_ball(self):
        self.bridge._post("/queue/push", {"active": True, "text": "排队中 第 2/5 轮", "done": 2, "total": 5})
        _, state = self.bridge._get("/queue/state", {})
        self.assertEqual(state["state"]["text"], "排队中 第 2/5 轮")
        self.assertEqual(state["state"]["done"], 2)
        self.assertEqual(state["stateSeq"], 1)

    def test_resume_state_carries_the_queue_snapshot(self):
        self.bridge._post("/queue/push", {"active": True, "text": "排队中 第 1/3 轮"})
        _, resume = self.bridge._get("/resume/state", {})
        self.assertEqual(resume["queue"]["text"], "排队中 第 1/3 轮")

    def test_request_seq_increases_so_the_ball_can_tell_new_from_old(self):
        _, first = self.bridge._post("/queue/request", {"kind": "queue", "text": "一句"})
        _, second = self.bridge._post("/queue/request", {"kind": "queue", "text": "另一句"})
        self.assertEqual(first["seq"], 1)
        self.assertEqual(second["seq"], 2)


if __name__ == "__main__":
    unittest.main()
