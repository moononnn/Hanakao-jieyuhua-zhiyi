"""排队弹窗的「鼠标进出就淡出」行为测试。

她要的行为：鼠标在面板上 → 实体；鼠标离开 → 过一会儿半透明；移回来 → 立刻恢复。
这个窗在这两件事上都出过问题：
  ① 背景画不实，整块看着一直半透明（透明窗口 + 样式表 background）；
  ② 漏接 enterEvent/leaveEvent，不看鼠标在哪儿，过一会儿就淡；
  ③ 接上了以后又被「输入框有焦点就不淡出」挡住，鼠标移出去也不淡。
所以这三条都钉在这里。
"""

import os
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("ZHIYI_APP_MODE", "ask-only")
_DATA_DIR = tempfile.TemporaryDirectory(prefix="zhiyi-queue-ui-")
os.environ["ZHIYI_APP_DATA_DIR"] = _DATA_DIR.name

from PyQt6.QtCore import QEvent, QPointF
from PyQt6.QtGui import QEnterEvent
from PyQt6.QtWidgets import QApplication, QWidget

from zhujian_app import QueueInsertPanel


class FakeBall(QWidget):
    theme_mode = "light"
    target_mode = "auto"
    target_name = ""
    target_title = ""
    target_session_id = ""
    pinned_target = None

    def __init__(self):
        super().__init__()
        self.state = {}
        self.queue_panel = None

    def _set_fusion_panel_state(self, _state):
        pass

    def _reset_drag_motion(self):
        pass

    def _record_drag_motion(self):
        pass


class QueuePanelFadeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def _panel(self):
        ball = FakeBall()
        panel = QueueInsertPanel(ball)
        self.addCleanup(panel.close)
        self.addCleanup(ball.close)
        return panel

    def test_panel_opens_solid(self):
        """背景要实：开窗就是不透明的，不能整块像蒙了一层。"""
        panel = self._panel()
        panel.show()
        self.assertEqual(panel.windowOpacity(), 1.0)

    def test_mouse_leave_schedules_the_fade(self):
        """鼠标移出去 → 排期淡出（不是不管鼠标在哪儿都淡）。"""
        panel = self._panel()
        panel.show()
        panel.leaveEvent(QEvent(QEvent.Type.Leave))
        self.assertTrue(panel._fade_out_timer.isActive(), "鼠标离开后应当排期淡出")

    def test_mouse_enter_cancels_the_fade_and_restores_solid(self):
        """鼠标移回来 → 立刻恢复实体，不再半透明。"""
        panel = self._panel()
        panel.show()
        panel.leaveEvent(QEvent(QEvent.Type.Leave))
        panel.enterEvent(QEnterEvent(QPointF(1, 1), QPointF(1, 1), QPointF(1, 1)))
        self.assertFalse(panel._fade_out_timer.isActive(), "鼠标进来应当把淡出排期撤掉")
        self.assertEqual(panel.windowOpacity(), 1.0)

    def test_fade_is_decided_by_the_mouse_not_by_the_input_focus(self):
        """输入框有没有焦点不作数：她要的是「鼠标在面板上才实体」。"""
        panel = self._panel()
        panel.input.setFocus()
        self.assertTrue(panel._fade_allowed(), "输入框有焦点时也要允许淡出")

    def test_sending_keeps_the_panel_solid(self):
        """正在发送时别淡：那一刻她要盯着回执。"""
        panel = self._panel()
        panel._sending = True
        self.assertFalse(panel._fade_allowed())

    def test_a_state_without_ok_is_still_treated_as_queued(self):
        """App 推来的状态没带 ok 时，弹窗不能报「知意那边没回话」——它已经排上了。

        2026-10-22 实机踩的坑：App 推话单状态时忘了带 ok，球这边照着 ok 判，
        明明排上了也在弹窗里报一句假失败。
        """
        panel = self._panel()
        panel._apply_queue_result({"message": "已发出，ta 这轮说完就接下一句", "total": 2})
        self.assertEqual(panel.lbl_status.text(), "已发出，ta 这轮说完就接下一句")

    def test_a_real_failure_still_shows_the_error(self):
        """真失败还是要报出来，不能被上面那条盖住。"""
        panel = self._panel()
        panel._apply_queue_result({"ok": False, "error": "知意那边没回话，再点一次试试"})
        self.assertEqual(panel.lbl_status.text(), "知意那边没回话，再点一次试试")


if __name__ == "__main__":
    unittest.main()
