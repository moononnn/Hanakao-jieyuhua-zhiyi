"""Offscreen smoke test for the Ask panel; never starts the desktop ball."""
import os
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("ZHIYI_APP_MODE", "ask-only")
_DATA_DIR = tempfile.TemporaryDirectory(prefix="zhiyi-ask-ui-")
os.environ["ZHIYI_APP_DATA_DIR"] = _DATA_DIR.name

from PyQt6.QtCore import Qt, QObject, QEvent, QPointF
from PyQt6.QtGui import QImage, QPainter, QMouseEvent
from PyQt6.QtWidgets import QApplication, QWidget, QLabel
from zhujian_app import SendModeMenu, ZhujianBall, ZhujianMenu, merge_polish_result
import zhujian_app as zhujian_module


class FakeBall(QWidget):
    theme_mode = "light"
    target_mode = "auto"
    action = "copy"
    target_name = ""
    target_title = ""
    target_session_id = ""
    pinned_target = None
    cached = None

    def __init__(self):
        super().__init__()
        self.state = {}
        self.ask_flower_enabled = False
        self._ask_emitting = False
        self.polish_panel = None
        self.queue_panel = None
        self.closed_by_menu = False

    def _close_menu(self):
        self.closed_by_menu = True

    def _set_fusion_panel_state(self, _state):
        pass

    def set_recommend_candidates(self, candidates):
        pass


class AskDialogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])

    def test_sakura_sprig_is_drawn_on_transparent_ball_canvas(self):
        ball = ZhujianBall()
        try:
            for timer in (ball.ask_poll_timer, ball.tick_timer, ball.theme_timer):
                timer.stop()
            self.assertTrue(ball.sprig_ready)
            canvas = QImage(ball.size(), QImage.Format.Format_ARGB32_Premultiplied)
            canvas.fill(Qt.GlobalColor.transparent)
            painter = QPainter(canvas)
            ball.render(painter)
            painter.end()
            visible_pixels = sum(
                canvas.pixelColor(x, y).alpha() > 0
                for y in range(canvas.height())
                for x in range(canvas.width())
            )
            self.assertGreater(visible_pixels, 500)
        finally:
            ball.close()

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

    def test_ask_heading_identifies_source_window_and_keeps_question_title_separate(self):
        ball = FakeBall()
        menu = ZhujianMenu(ball)
        try:
            menu.show_ask({
                "askId": "source-heading", "header": "本题题名", "question": "测试问题",
                "sessionTitle": "来源对话标题", "agentName": "测试伙伴",
                "options": [{"label": "选项一"}, {"label": "选项二"}],
            })
            self.assertEqual(menu.lbl_head.text(), "测试伙伴 ·「来源对话标题」")
            self.assertIn("本题题名", menu.lbl_ask_from.text())
            self.assertNotIn("来源对话标题", menu.lbl_ask_from.text())
        finally:
            menu.close()
            ball.close()

    def test_ask_heading_handles_missing_source_fields(self):
        ball = FakeBall()
        menu = ZhujianMenu(ball)
        try:
            for title, agent, expected in [
                ("来源标题", "", "「来源标题」"),
                ("", "测试伙伴", "测试伙伴"),
                ("", "", "来源对话未命名"),
            ]:
                with self.subTest(title=title, agent=agent):
                    menu.show_ask({
                        "askId": f"heading-fallback-{title}-{agent}", "header": "本题题名", "question": "测试问题",
                        "sessionTitle": title, "agentName": agent,
                        "options": [{"label": "选项一"}, {"label": "选项二"}],
                    })
                    self.assertEqual(menu.lbl_head.text(), expected)
        finally:
            menu.close()
            ball.close()

    def test_clicking_option_body_selects_it(self):
        """整条选项都可点：点说明、点留白也算选中，不再只有大字才行。"""
        ball = FakeBall()
        menu = ZhujianMenu(ball)
        try:
            menu.show_ask({
                "askId": "smoke-body", "header": "发送范围", "question": "发给谁？",
                "selectionMode": "single",
                "options": [
                    {"label": "只发这一条", "description": "其他分支不动"},
                    {"label": "整段对话", "description": "从头补上"},
                ],
            })
            menu._respond_ask = lambda mode, choice, note="": None
            frame = menu._ask_option_frames[1]
            detail = frame.findChild(QLabel, "askDescription")
            self.assertIsNotNone(detail)
            # 说明文字把鼠标事件让给整条，事件才不会停在 label 上
            self.assertTrue(detail.testAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents))
            press = QMouseEvent(
                QEvent.Type.MouseButtonPress, QPointF(3.0, 3.0), QPointF(3.0, 3.0),
                Qt.MouseButton.LeftButton, Qt.MouseButton.LeftButton,
                Qt.KeyboardModifier.NoModifier,
            )
            frame.mousePressEvent(press)
            self.assertEqual(menu._ask_selected_indices, [1])
            self.assertTrue(frame.selected)
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
            menu._respond_ask = lambda mode, choice, note="": responses.append((mode, choice, note))
            self.assertEqual(menu.btn_ask_send.text(), "确认发送")
            self.assertIn("已选 0/2", menu.lbl_ask_select_hint.text())
            menu.ask_input.setText("补充路线")
            self.assertNotIn("替代", menu.lbl_ask_select_hint.text())
            self.assertEqual(menu.btn_ask_send.text(), "确认发送")
            menu.ask_input.clear()
            menu._toggle_ask_option(0)
            self.assertEqual(responses, [])
            menu._toggle_ask_option(1)
            menu._toggle_ask_option(2)
            self.assertEqual(menu._ask_selected_indices, [0, 1])
            menu.ask_input.clear()
            menu._send_custom_ask()
            self.assertEqual(responses, [("option", ["同步", "加密"], "")])
        finally:
            menu.close()
            ball.close()

    def test_single_selection_waits_for_confirmation_and_allows_note(self):
        ball = FakeBall()
        menu = ZhujianMenu(ball)
        responses = []
        try:
            menu.show_ask({
                "askId": "smoke-single", "question": "选哪个？", "selectionMode": "single",
                "options": [{"label": "A"}, {"label": "B"}],
            })
            menu._respond_ask = lambda mode, choice, note="": responses.append((mode, choice, note))
            menu._toggle_ask_option(0)
            self.assertEqual(responses, [])
            menu._toggle_ask_option(1)
            self.assertEqual(menu._ask_selected_indices, [1])
            menu.ask_input.setText("但只在本地处理")
            menu._send_custom_ask()
            self.assertEqual(responses, [("option", "B", "但只在本地处理")])
        finally:
            menu.close()
            ball.close()

    def test_multiple_selection_keeps_note_and_does_not_bypass_minimum(self):
        ball = FakeBall()
        menu = ZhujianMenu(ball)
        responses = []
        try:
            menu.show_ask({
                "askId": "multi-note", "question": "需要哪些？", "selectionMode": "multiple",
                "minSelections": 2, "maxSelections": 2,
                "options": [{"label": "A"}, {"label": "B"}],
            })
            menu._respond_ask = lambda mode, choice, note="": responses.append((mode, choice, note))
            menu.ask_input.setText("附加限制")
            menu._toggle_ask_option(0)
            menu._send_custom_ask()
            self.assertEqual(responses, [], "有补充说明也不能跳过已勾选项的数量校验")
            menu._toggle_ask_option(1)
            menu._send_custom_ask()
            self.assertEqual(responses, [("option", ["A", "B"], "附加限制")])
        finally:
            menu.close()
            ball.close()

    def test_text_only_answer_is_still_allowed_for_both_modes(self):
        for mode in ("single", "multiple"):
            with self.subTest(mode=mode):
                ball = FakeBall()
                menu = ZhujianMenu(ball)
                responses = []
                try:
                    menu.show_ask({"askId": "text-only-" + mode, "question": "怎么做？",
                                   "selectionMode": mode, "options": [{"label": "A"}, {"label": "B"}]})
                    menu._respond_ask = lambda kind, choice, note="": responses.append((kind, choice, note))
                    menu.ask_input.setText("另一个方案")
                    menu._send_custom_ask()
                    self.assertEqual(responses, [("custom", "另一个方案", "")])
                finally:
                    menu.close()
                    ball.close()

    def test_choice_and_note_cross_http_boundary_and_survive_failure(self):
        for mode in ("single", "multiple"):
            with self.subTest(mode=mode):
                ball = FakeBall()
                menu = ZhujianMenu(ball)
                try:
                    menu.show_ask({"askId": "http-note-" + mode, "question": "怎么做？",
                                   "selectionMode": mode, "options": [{"label": "A"}, {"label": "B"}]})
                    menu._toggle_ask_option(0)
                    menu.ask_input.setText("必须保留的说明")
                    with patch.object(zhujian_module, "api_post", return_value={"ok": False, "error": "暂未送达"}) as post, \
                         patch.object(zhujian_module.threading, "Thread") as thread:
                        thread.return_value.start.side_effect = lambda: thread.call_args.kwargs["target"]()
                        menu._send_custom_ask()
                    body = post.call_args.args[1]
                    self.assertEqual(body["mode"], "option")
                    self.assertEqual(body["choice"], ["A"] if mode == "multiple" else "A")
                    self.assertEqual(body["note"], "必须保留的说明")
                    self.assertEqual(menu._ask_selected_indices, [0])
                    self.assertEqual(menu.ask_input.text(), "必须保留的说明")
                    self.assertFalse(menu._ask_responding)
                    self.assertFalse(menu._ask_finished)
                    self.assertTrue(menu.btn_ask_send.isEnabled())
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

    def test_bridge_result_keeps_local_request_seq(self):
        # 桥回包里带的是 App 侧编号；盖掉本地序号会让 _apply_polish_result
        # 把真回包当成过期回包丢掉，界面就永远停在「正在捋…」。
        payload = {"ok": False, "error": "知意那边没回话，再点一次试试", "seq": 7}
        merged = merge_polish_result(payload, {"ok": True, "text": "捋好了", "seq": 3})
        self.assertEqual(merged["seq"], 7)
        self.assertEqual(merged["text"], "捋好了")
        self.assertTrue(merged["ok"])
        # 回包是 None 时不动本地 payload
        self.assertEqual(merge_polish_result({"seq": 2, "ok": False}, None)["seq"], 2)

    def test_recommend_polling_survives_while_only_subpanel_is_open(self):
        # 退回过的坑：主面板一收起就 stop 轮询，而打开朗读窗/捋一捋窗必须
        # 先收起主面板，于是二级弹窗期间根本收不到目标快照，切窗口像没反应。
        ball = FakeBall()
        menu = ZhujianMenu(ball)
        sub = QWidget()
        try:
            ball.menu = menu
            sub.show()
            ball.polish_panel = sub
            menu.hide()
            menu.start_recommend_polling()
            menu._sync_recommend_polling()
            self.assertTrue(menu._recommend_timer.isActive(), "子弹窗开着时轮询不能停")
            self.assertEqual(menu._recommend_timer.interval(), 2000)
            sub.hide()
            menu._sync_recommend_polling()
            self.assertFalse(menu._recommend_timer.isActive(), "谁都看不见时应该真停")
        finally:
            menu.close()
            sub.close()
            ball.close()

    def test_clear_button_hides_when_there_is_nothing_to_clear(self):
        ball = FakeBall()
        menu = ZhujianMenu(ball)
        try:
            menu.request_recommend = lambda *a, **k: None
            # 一上来就没有推荐：按钮不该占位
            self.assertFalse(menu.btn_clear_recommend.isVisibleTo(menu))
            # 空状态、出错、加载中同样不显示
            menu._render_empty()
            self.assertFalse(menu.btn_clear_recommend.isVisibleTo(menu))
            menu._render_error("boom")
            self.assertFalse(menu.btn_clear_recommend.isVisibleTo(menu))
            # 真渲染出条目才出现，并且用的是窄一档的 clearBtn 样式
            ball.cached = {"items": [{"text": "先说结论"}], "rid": "smoke", "ts": 0}
            menu._render_items([{"text": "先说结论"}])
            self.assertTrue(menu.btn_clear_recommend.isVisibleTo(menu))
            self.assertEqual(menu.btn_clear_recommend.objectName(), "clearBtn")
            # 点清空后回到空状态，按钮跟着退场
            menu.clear_recommend()
            self.assertFalse(menu.btn_clear_recommend.isVisibleTo(menu))
        finally:
            menu.close()
            ball.close()

    # ── 会话标题那一行：位置、面板高度、点下去要立刻有动静 ──

    def _shown_menu(self, ball):
        menu = ZhujianMenu(ball)
        menu.show()
        menu._configure_app_mode()
        self.app.processEvents()
        return menu

    def test_undo_button_sits_in_the_same_row_as_rename(self):
        """还原只能在生成新标题左边同一行里，不能另起一行掉到虚线框外。"""
        ball = FakeBall()
        menu = self._shown_menu(ball)
        try:
            # 「对话工具」默认折叠，里面的工具行不可见；要量位置得先展开。
            menu.tools_body.setVisible(True)
            menu.tools_expanded = True
            menu._set_undo_available(True)
            self.app.processEvents()
            self.assertTrue(menu.btn_undo.isVisible())
            rename = menu.btn_rename.geometry()
            undo = menu.btn_undo.geometry()
            self.assertEqual(undo.top(), rename.top())
            self.assertLess(undo.right(), rename.left())
            self.assertLessEqual(undo.bottom(), menu.rename_tool.height())
        finally:
            menu.close()
            ball.close()

    def test_panel_grows_to_fit_content_when_undo_appears(self):
        """还原一亮出来，面板不能还停在旧高度把行压皱。"""
        ball = FakeBall()
        menu = self._shown_menu(ball)
        try:
            before = menu.height()
            menu._set_undo_available(True)
            menu._sync_size()
            self.app.processEvents()
            need = menu.main_view.layout().sizeHint().height()
            margins = menu.layout().contentsMargins()
            self.assertGreaterEqual(menu.height(), need + margins.top() + margins.bottom())
            self.assertGreater(menu.height(), before)
        finally:
            menu.close()
            ball.close()

    def test_rename_shows_progress_before_the_result_arrives(self):
        """点了生成新标题，得当场说自己正在干，不是等改完才出声。"""
        import threading
        import time
        ball = FakeBall()
        menu = self._shown_menu(ball)
        gate = threading.Event()
        try:
            menu._bridge_title_call = lambda *a, **k: (gate.wait(5), {"ok": False, "error": "没接上"})[1]
            menu.rename_async()
            self.app.processEvents()
            self.assertEqual(menu.btn_rename.text(), "总结中…")
            self.assertEqual(menu.lbl_rename_desc.text(), zhujian_module.RENAME_DESC_BUSY)
            gate.set()
            for _ in range(100):
                self.app.processEvents()
                if not menu._renaming:
                    break
                time.sleep(0.02)
            self.assertEqual(menu.btn_rename.text(), "生成新标题")
            self.assertEqual(menu.lbl_rename_desc.text(), zhujian_module.RENAME_DESC_IDLE)
            self.assertEqual(menu.lbl_feedback.text(), "没接上")
        finally:
            gate.set()
            menu.close()
            ball.close()

    def test_undo_shows_busy_text_while_asking(self):
        """退回也要当场出声，并且忙碌时点不动第二下。"""
        import threading
        import time
        ball = FakeBall()
        menu = self._shown_menu(ball)
        gate = threading.Event()
        try:
            menu._set_undo_available(True)
            menu._bridge_title_call = lambda *a, **k: (gate.wait(5), {"ok": False, "error": "没接上"})[1]
            menu.undo_async()
            self.app.processEvents()
            self.assertEqual(menu.btn_undo.text(), "退回中…")
            self.assertFalse(menu.btn_undo.isEnabled())
            gate.set()
            for _ in range(100):
                self.app.processEvents()
                if not menu._renaming:
                    break
                time.sleep(0.02)
            self.assertEqual(menu.btn_undo.text(), "还原")
            self.assertEqual(menu.lbl_feedback.text(), "没接上")
        finally:
            gate.set()
            menu.close()
            ball.close()

    # ── 旧版内嵌目标选择：向下展开、候选不挤压 ──

    def _open_fixed_target_menu(self, menu, ball):
        ball._recommend_candidates = [
            {"sessionId": f"s{i}", "title": f"第{i}段对话", "modified": 1760000000000 + i}
            for i in range(1, 6)
        ]
        menu._open_target_menu()
        menu.target_menu._show_fixed()
        self.app.processEvents()
        return menu.target_menu

    def test_target_menu_uses_original_inline_layout_and_theme(self):
        """旧版内嵌展开，实心选中模式与实线候选，不覆盖后面的内容。"""
        ball = FakeBall()
        menu = self._shown_menu(ball)
        try:
            tm = self._open_fixed_target_menu(menu, ball)
            self._settle_target_layout(menu)
            layout = menu.main_view.layout()
            index = layout.indexOf(tm)
            self.assertGreaterEqual(index, 0)
            self.assertTrue(tm.isVisible())
            for i in range(index + 1, layout.count()):
                widget = layout.itemAt(i).widget()
                if widget is not None and widget.isVisible():
                    self.assertGreater(widget.geometry().top(), tm.geometry().bottom())
                    break
            qss = tm.styleSheet()
            self.assertIn('min-height: 32px', qss)
            self.assertNotIn('dashed', qss)
            colors = zhujian_module.THEME_COLORS[ball.theme_mode]
            self.assertIn(f"color: {colors['accent_text']}; background: {colors['accent']}", qss)
            menu._set_target_selector_visible(False)
            self._settle_target_layout(menu)
            self.assertTrue(tm.isHidden())
        finally:
            menu.close()
            ball.close()

    def _settle_target_layout(self, menu):
        for _ in range(5):
            self.app.processEvents()
            menu._sync_size()

    def test_unchanged_panel_sync_does_not_resize_or_flash_scrollbar(self):
        class ResizeWatch(QObject):
            def __init__(self):
                super().__init__()
                self.events = []

            def eventFilter(self, obj, event):
                if event.type() == QEvent.Type.Resize:
                    self.events.append(('resize', event.size().width(), event.size().height()))
                elif event.type() in (QEvent.Type.Show, QEvent.Type.Hide):
                    self.events.append(('visibility', event.type().name))
                return False

        ball = FakeBall()
        menu = self._shown_menu(ball)
        try:
            self._settle_target_layout(menu)
            self.app.processEvents()
            watch = ResizeWatch()
            menu.installEventFilter(watch)
            menu.main_scroll.viewport().installEventFilter(watch)
            menu.main_scroll.verticalScrollBar().installEventFilter(watch)
            before = menu.height()
            for _ in range(3):
                menu._sync_size()
                self.app.processEvents()
            self.assertEqual(menu.height(), before)
            self.assertEqual(watch.events, [], 'unchanged content must not shrink then grow')
            self.assertFalse(menu.main_scroll.verticalScrollBar().isVisible())
        finally:
            menu.close()
            ball.close()

    def test_long_inline_menu_keeps_real_scrollbar_and_stable_height(self):
        ball = FakeBall()
        menu = self._shown_menu(ball)
        try:
            menu.setMaximumHeight(420)
            tm = self._open_fixed_target_menu(menu, ball)
            self._settle_target_layout(menu)
            self.app.processEvents()
            self.assertLessEqual(menu.height(), 420)
            self.assertGreater(menu.main_view.height(), menu.main_scroll.viewport().height())
            self.assertTrue(menu.main_scroll.verticalScrollBar().isVisible())
            height = menu.height()
            for _ in range(3):
                menu._sync_size()
                self.app.processEvents()
            self.assertEqual(menu.height(), height)
            self.assertTrue(menu.main_scroll.verticalScrollBar().isVisible())
            self.assertGreater(menu.recommend_body.y(), tm.geometry().bottom())
        finally:
            menu.close()
            ball.close()

    def test_original_target_selector_keeps_auto_and_pin_actions(self):
        ball = FakeBall()
        menu = self._shown_menu(ball)
        try:
            tm = self._open_fixed_target_menu(menu, ball)
            self._settle_target_layout(menu)
            with patch.object(tm, '_request_recommend') as request:
                tm._pick(tm.sessions[0])
                self._settle_target_layout(menu)
                request.assert_called_with('pin', 's1')
                self.assertEqual(ball.target_session_id, 's1')
                self.assertTrue(tm.isHidden())
                menu._open_target_menu()
                self._settle_target_layout(menu)
                self.assertTrue(tm.list_host.isVisible())
                tm._pick_auto()
                self._settle_target_layout(menu)
                request.assert_called_with('auto')
                self.assertEqual(ball.target_mode, 'auto')
                self.assertIsNone(ball.pinned_target)
                self.assertTrue(tm.isHidden())
                menu._open_target_menu()
                self._settle_target_layout(menu)
                self.assertTrue(tm.list_host.isHidden())
                auto_height = tm.height()
                tm._show_fixed()
                self._settle_target_layout(menu)
                self.assertGreater(tm.height(), auto_height)
                self.assertGreater(menu.recommend_body.y(), tm.geometry().bottom())
        finally:
            menu.close()
            ball.close()

    def test_each_target_candidate_keeps_its_own_row(self):
        """五段对话各自一行、彼此不重叠，也不会被压成细条。"""
        ball = FakeBall()
        menu = self._shown_menu(ball)
        try:
            tm = self._open_fixed_target_menu(menu, ball)
            self._settle_target_layout(menu)
            rows = []
            for i in range(tm.list_box.count()):
                w = tm.list_box.itemAt(i).widget()
                if w is not None:
                    rows.append(w)
            self.assertEqual(len(rows), 5)
            last_bottom = None
            for row in rows:
                geo = row.geometry()
                self.assertGreaterEqual(geo.height(), 24)
                if last_bottom is not None:
                    self.assertGreaterEqual(geo.top(), last_bottom)
                last_bottom = geo.bottom()
                # 每一行都要落在列表区里，列表区又要在浮签里
                self.assertLessEqual(last_bottom, tm.list_host.height())
            self.assertLessEqual(tm.list_host.y() + tm.list_host.height(), tm.height())
        finally:
            menu.close()
            ball.close()

    def test_target_menu_stays_inside_the_panel(self):
        ball = FakeBall()
        menu = self._shown_menu(ball)
        try:
            tm = self._open_fixed_target_menu(menu, ball)
            self._settle_target_layout(menu)
            geo = tm.geometry()
            self.assertGreaterEqual(geo.top(), 0)
            self.assertGreaterEqual(geo.left(), 0)
            self.assertLessEqual(geo.right(), menu.main_view.width())
            self.assertLessEqual(geo.bottom(), menu.main_view.height())
        finally:
            menu.close()
            ball.close()


if __name__ == "__main__":
    unittest.main()
