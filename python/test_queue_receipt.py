"""排队回包的认领测试。

球发一次排队请求 → App 收下并推回状态 → 球要认出「这份回包是我的」。
认错有两种，后果都不轻：
  ① 把别人的状态当成自己的：球以为排上了，其实没排。
  ② 把自己的状态当成没收到：明明排上了，弹窗却报一句「知意那边没回话」。

2026-10-22 实机踩的就是 ②：App 推来的状态里没带 ok，球那边一直当成失败。
"""

import os
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("ZHIYI_APP_MODE", "ask-only")
_DATA_DIR = tempfile.TemporaryDirectory(prefix="zhiyi-queue-receipt-")
os.environ["ZHIYI_APP_DATA_DIR"] = _DATA_DIR.name

from zhujian_app import queue_receipt_matches


class QueueReceiptTests(unittest.TestCase):
    def test_state_carrying_our_request_seq_is_ours(self):
        """状态里回声带着我们这次请求的号：最准的一种，认下来。"""
        state = {
            "ok": True,
            "stateSeq": 1,
            "state": {"requestSeq": 7, "ok": True, "text": "排队中 第 2/2 轮"},
        }
        pushed = queue_receipt_matches(state, 7, 0)
        self.assertIsNotNone(pushed)
        self.assertEqual(pushed["text"], "排队中 第 2/2 轮")

    def test_another_requests_push_is_not_ours(self):
        """别的请求推来的状态不算数——哪怕状态序号涨了。"""
        state = {
            "ok": True,
            "stateSeq": 9,
            "state": {"requestSeq": 3, "ok": True, "text": "排队中 第 1/5 轮"},
        }
        self.assertIsNone(queue_receipt_matches(state, 7, 1))

    def test_state_seq_alone_is_enough_when_the_push_has_no_seq(self):
        """状态没带请求号时，看状态序号有没有涨过我们发请求那一刻。"""
        state = {"ok": True, "stateSeq": 2, "state": {"ok": True, "text": "排队中 第 2/2 轮"}}
        self.assertIsNotNone(queue_receipt_matches(state, 7, 1))

    def test_coarse_path_is_off_when_the_baseline_is_unknown(self):
        """预读失败时基线是 0，粗判据会恒真——那时候宁可不认。"""
        state = {"ok": True, "stateSeq": 0, "state": {"ok": True, "text": "很旧的状态"}}
        self.assertIsNone(queue_receipt_matches(state, 7, 0, False))

    def test_exact_match_works_even_when_the_baseline_is_unknown(self):
        """预读失败也不影响按请求号认。"""
        state = {"ok": True, "stateSeq": 0, "state": {"requestSeq": 7, "ok": True}}
        self.assertIsNotNone(queue_receipt_matches(state, 7, 0, False))

    def test_a_state_that_has_not_moved_is_not_ours(self):
        """序号没涨、号也对不上：还没轮到我们这份。"""
        state = {"ok": True, "stateSeq": 1, "state": {"ok": True}}
        self.assertIsNone(queue_receipt_matches(state, 7, 1))

    def test_broken_payloads_are_not_matched(self):
        """认不出来就当没认出来，不能硬凑。"""
        self.assertIsNone(queue_receipt_matches(None, 1, 0))
        self.assertIsNone(queue_receipt_matches({"ok": False, "state": {}}, 1, 0))
        self.assertIsNone(queue_receipt_matches({"ok": True, "state": None}, 1, 0))
        self.assertIsNone(queue_receipt_matches({"ok": True, "state": "排队中"}, 1, 0))
        self.assertIsNone(queue_receipt_matches({"ok": True, "state": {}}, 1, 0))

    def test_bad_numbers_do_not_crash(self):
        """号和序号都不是数字时也不该抛，认不出来就算了。"""
        state = {"ok": True, "stateSeq": "x", "state": {"requestSeq": "y"}}
        self.assertIsNone(queue_receipt_matches(state, "z", "w"))


if __name__ == "__main__":
    unittest.main()
