"""Offscreen smoke test for the Ask panel; never starts the desktop ball."""
import os
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("ZHIYI_APP_MODE", "ask-only")
_DATA_DIR = tempfile.TemporaryDirectory(prefix="zhiyi-ask-ui-")
os.environ["ZHIYI_APP_DATA_DIR"] = _DATA_DIR.name

from PyQt6.QtWidgets import QApplication, QWidget
from zhujian_app import SendModeMenu, ZhujianMenu


class FakeBall(QWidget):
    theme_mode = "light"
    target_mode = "auto"

    def __init__(self):
        super().__init__()
        self.state = {}
        self.ask_flower_enabled = False
        self._ask_emitting = False
        self.polish_panel = None
        self.closed_by_menu = False

    def _close_menu(self):
        self.closed_by_menu = True

    def _set_fusion_panel_state(self, _state):
        pass


class AskDialogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_right_click_menu_offers_only_close_and_uses_exit_action(self):
        ball = FakeBall()
        menu = SendModeMenu(ball)
        try:
            menu.show()
            self.assertTrue(menu.btn_close.isVisible())
            self.assertEqual(menu.btn_close.text(), "关闭传音樱")
            self.assertFalse(menu.btn_send.isVisible())
            self.assertFalse(menu.btn_copy.isVisible())
            menu.btn_close.click()
            self.assertTrue(ball.closed_by_menu)
        finally:
            menu.close()
            ball.close()

    def test_multiple_selection_waits_for_confirm_and_enforces_limits(self):
        ball = FakeBall()
        menu = ZhujianMenu(ball)
        responses = []
        try:
            menu.show_ask({
                "askId": "smoke-multi", "header": "偏好组合", "question": "哪些功能都需要？",
                "selectionMode": "multiple", "minSelections": 2, "maxSelections": 2,
                "options": [
                    {"label": "同步", "description": "多设备", "recommended": False},
                    {"label": "加密", "description": "本地保护", "recommended": False},
                    {"label": "导出", "description": "方便迁移", "recommended": False},
                ],
            })
            menu._respond_ask = lambda mode, choice: responses.append((mode, choice))
            self.assertEqual(menu.btn_ask_send.text(), "确认选择")
            self.assertIn("至少 2 项，最多 2 项", menu.lbl_ask_select_hint.text())
            menu.ask_input.setText("自定义路线")
            self.assertEqual(menu.btn_ask_send.text(), "用我的答案")
            self.assertIn("会替代勾选项", menu.lbl_ask_select_hint.text())
            menu.ask_input.clear()
            self.assertEqual(menu.btn_ask_send.text(), "确认选择")
            menu._toggle_ask_option(0)
            self.assertEqual(responses, [])
            menu._toggle_ask_option(1)
            menu._toggle_ask_option(2)
            self.assertEqual(menu._ask_selected_indices, [0, 1])
            menu.ask_input.clear()
            menu._send_custom_ask()
            self.assertEqual(responses, [("option", ["同步", "加密"])])
        finally:
            menu.close()
            ball.close()

    def test_single_selection_still_submits_immediately(self):
        ball = FakeBall()
        menu = ZhujianMenu(ball)
        responses = []
        try:
            menu.show_ask({
                "askId": "smoke-single", "question": "选哪个？", "selectionMode": "single",
                "options": [{"label": "A"}, {"label": "B"}],
            })
            menu._respond_ask = lambda mode, choice: responses.append((mode, choice))
            menu._toggle_ask_option(1)
            self.assertEqual(responses, [("option", "B")])
        finally:
            menu.close()
            ball.close()

    def test_structured_question_is_visible_without_duplicate_context(self):
        ball = FakeBall()
        menu = ZhujianMenu(ball)
        try:
            menu.show_ask({
                "askId": "smoke-1", "header": "迁移方式", "question": "先迁移哪一块？",
                "background": "旧界面已经在用。", "recommendation": "先迁移通信层",
                "reason": "可保留现有交互。", "selectionMode": "single",
                "options": [
                    {"label": "先迁移通信层", "description": "改动较小", "recommended": True},
                    {"label": "重写界面", "description": "需要重新验收", "recommended": False},
                ],
            })
            self.assertEqual(menu.lbl_ask_question.text(), "先迁移哪一块？")
            self.assertTrue(menu.btn_ask_close.isVisibleTo(menu))
            self.assertTrue(menu.lbl_ask_background.isVisibleTo(menu))
            self.assertIn("旧界面已经在用", menu.lbl_ask_background.text())
            self.assertIn("可保留现有交互", menu.lbl_ask_recommendation.text())
            self.assertEqual(len(menu._ask_option_frames), 2)
            self.assertEqual(menu._ask_option_frames[0].choice_label.text(), "先迁移通信层")
            self.assertIsNotNone(menu._ask_option_frames[0].findChild(QWidget, "askRecommended"))
            self.assertIsNone(menu._ask_option_frames[1].findChild(QWidget, "askRecommended"))
            menu.btn_ask_close.click()
            self.assertTrue(menu._ask_user_hidden)
            self.assertTrue(menu.is_ask_open())
        finally:
            menu.close()
            ball.close()


if __name__ == "__main__":
    unittest.main()
