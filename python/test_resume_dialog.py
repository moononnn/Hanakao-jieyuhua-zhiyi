"""Offscreen resume-view tests; no desktop ball, real data, model or network."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ["QT_QPA_PLATFORM"] = "offscreen"
os.environ["ZHIYI_APP_MODE"] = "ask-only"
_DATA = tempfile.TemporaryDirectory(prefix="zhiyi-resume-ui-")
os.environ["ZHIYI_APP_DATA_DIR"] = _DATA.name

from PyQt6.QtCore import QPoint
from PyQt6.QtGui import QFont, QFontDatabase, QFontMetrics
from PyQt6.QtWidgets import QApplication, QWidget
import zhujian_app as ui


class FixtureBall(QWidget):
    theme_mode = "light"
    target_mode = "auto"
    action = "copy"
    target_name = ""
    target_title = ""
    target_session_id = ""
    pinned_target = None
    cached = None
    ask_flower_enabled = False
    polish_panel = None

    def __init__(self):
        super().__init__()
        self.state = {}

    def _set_fusion_panel_state(self, state):
        pass

    def set_recommend_candidates(self, candidates):
        pass


NOTICE = {"sessionId": "fixture-only", "title": "测试窗口", "agentName": "测试伙伴",
          "reason": "这一轮回复停在半路，需要你决定是否接着说。", "attempt": 2}


class ResumeDialogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        # 仅测试渲染环境注册本机字体，不修改产品字体策略。
        candidates = []
        explicit = os.environ.get("ZHIYI_UI_TEST_FONT")
        if explicit:
            candidates.append(Path(explicit))
        for directory in (Path("C:/Windows/Fonts"),
                          Path.home() / "AppData/Local/Microsoft/Windows/Fonts"):
            if directory.is_dir():
                candidates.extend(p for p in directory.iterdir()
                                  if "wenkai" in p.name.lower() and p.suffix.lower() in (".ttf", ".otf", ".ttc"))
        candidates.append(Path("C:/Windows/Fonts/msyh.ttc"))
        for candidate in candidates:
            if not candidate.is_file():
                continue
            font_id = QFontDatabase.addApplicationFont(str(candidate))
            families = QFontDatabase.applicationFontFamilies(font_id) if font_id >= 0 else []
            if families:
                cls.preview_font = QFont(families[0], 10)
                metrics = QFontMetrics(cls.preview_font)
                if all(metrics.inFontUcs4(ord(char)) for char in "断点续接测试伙伴窗口"):
                    cls.app.setFont(cls.preview_font)
                    cls.preview_font_family = families[0]
                    break
        else:
            raise RuntimeError("离屏UI测试缺少可用中文字体，请设置 ZHIYI_UI_TEST_FONT")

    def setUp(self):
        self.guards = [patch.object(ui, "api_get", side_effect=AssertionError("no network")),
                       patch.object(ui, "api_post", side_effect=AssertionError("no network")),
                       patch.object(ui, "save_state"),
                       patch.object(ui.ZhujianMenu, "start_resume_polling"),
                       patch.object(ui.ZhujianMenu, "start_recommend_polling")]
        for guard in self.guards:
            guard.start()
        self.ball = FixtureBall()
        self.menu = ui.ZhujianMenu(self.ball)
        self.menu._resume_enabled = True  # 普通用例显式启用；缺省关闭另有独立验证。
        # 离屏平台的系统字体回退不可靠，fixture 显式指定已注册字体。
        self.menu.setStyleSheet(self.menu.styleSheet() +
                               f'\nQWidget {{ font-family: "{self.preview_font_family}"; }}')
        self.menu.show()
        self.pump()

    def tearDown(self):
        self.menu._closed = True
        self.menu.close()
        self.ball.close()
        self.pump()
        for guard in reversed(self.guards):
            guard.stop()

    def pump(self):
        for _ in range(6):
            self.app.processEvents()

    def open_notice(self, **updates):
        self.menu.show_resume_strip(dict(NOTICE, **updates))
        self.pump()

    def test_scroll_background_is_transparent_and_font_has_chinese_glyphs(self):
        self.open_notice()
        m = self.menu
        self.assertFalse(m.resume_scroll.autoFillBackground())
        self.assertFalse(m.resume_scroll.viewport().autoFillBackground())
        self.assertFalse(m.resume_scroll.widget().autoFillBackground())
        metrics = QFontMetrics(m.lbl_resume_heading.font())
        self.assertTrue(all(metrics.inFontUcs4(ord(char)) for char in "断点续接"))

    def test_entry_and_empty_state(self):
        m = self.menu
        m._apply_resume_state({"ok": True})
        self.pump()
        self.assertFalse(m._resume_enabled)
        self.assertFalse(m.btn_resume_entry.isVisible())
        self.assertFalse(m.resume_progress_scroll.isVisible())
        m.open_resume_view()
        self.assertFalse(m.resume_view.isVisible())
        m.show_resume_strip(NOTICE)
        self.assertIsNone(m._resume_notice)

    def test_notice_opens_dedicated_view(self):
        self.open_notice()
        m = self.menu
        self.assertTrue(m.resume_view.isVisible())
        for widget in (m.recommend_body, m.say_tool, m.polish_tool, m.ask_scroll):
            self.assertFalse(widget.isVisible())
        self.assertIn("测试伙伴", m.lbl_resume_from.text())
        self.assertIn(NOTICE["title"], m.lbl_resume_from.text())
        # 2026-10-23 产品决定：球上只提醒「这个窗口连续几轮都没接上」，设置项全在设置页。
        self.assertIn("连续 2 轮都没接上", m.lbl_resume_reason.text())
        self.assertFalse(m.resume_settings.isVisible())
        self.assertTrue(m.btn_resume_continue.isVisible())
        self.assertTrue(m.btn_resume_dismiss.isVisible())
        self.assertLessEqual(m.height(), 560)
        # 「继续哈」是主角：它吃掉多余宽度，「不用管」固定窄宽。
        self.assertGreater(m.btn_resume_continue.width(), m.btn_resume_dismiss.width())
        self.assertEqual(m.btn_resume_close.text(), "✕")
        self.assertEqual(m.btn_resume_close.objectName(), "resumeCloseBtn")
        body = m.resume_body.layout()
        self.assertLess(body.indexOf(m.lbl_resume_from), body.indexOf(m.lbl_resume_status), "来源应在可能很长的失败状态前面")

    def test_leaving_resume_view_keeps_notice_and_same_poll_does_not_force_page(self):
        self.open_notice()
        m = self.menu
        # 返回按钮已经删了，但退路本身还在：内部其他路径仍会调 close_resume_view。
        m.close_resume_view()
        m.show_resume_strip(NOTICE)
        self.pump()
        self.assertFalse(m.resume_view.isVisible())
        self.assertTrue(m.main_view.isVisible())
        self.assertIn("有待接", m.btn_resume_entry.text())
        m.btn_resume_entry.click()
        self.assertEqual(m._resume_notice, NOTICE)

    def test_settings_keep_defaults_and_sync_existing_configuration(self):
        self.open_notice()
        m = self.menu
        self.assertFalse(m._resume_auto)
        # 「继续后自动循环」那套勾选与轮数步进已删（2026-10-23）：不留看不见的死控件。
        self.assertFalse(hasattr(m, "chk_loop_after_resume"))
        self.assertFalse(hasattr(m, "lbl_loop_value"))
        self.assertFalse(hasattr(m, "loop_controls"))
        m._apply_loop_state({"active": True, "sessionId": "sess-1", "text": "正在续 第 1/3 轮"})
        self.pump()
        # 设置项搬到知意设置页之后，球上不再露这些控件。
        self.assertFalse(m.btn_resume_auto.isVisible())

    def test_long_source_error_does_not_move_actions(self):
        self.open_notice()
        m = self.menu
        before = m.btn_resume_continue.mapTo(m, QPoint(0, 0))
        self.open_notice(title="很长的窗口标题" * 100, reason="错误详情" * 200)
        m._after_resume_continue(False, "送达失败详情" * 200)
        self.pump()
        self.assertEqual(m.btn_resume_continue.mapTo(m, QPoint(0, 0)), before)
        self.assertTrue(m.rect().contains(m.btn_resume_continue.mapTo(m, m.btn_resume_continue.rect().bottomRight())))
        self.assertGreater(m.resume_scroll.verticalScrollBar().maximum(), 0)
        self.assertTrue(m.btn_resume_close.isVisible())

    def test_continue_failure_stays_and_retries_without_duplicates(self):
        self.open_notice()
        m = self.menu
        calls = []
        m._post_resume_action = lambda payload, on_done=None: calls.append((payload, on_done))
        m.btn_resume_continue.click()
        m._resume_send_continue()
        self.assertEqual(len(calls), 1)
        self.assertIn("提交", m.lbl_resume_status.text())
        calls[-1][1](False, "连接超时")
        self.assertTrue(m.resume_view.isVisible())
        self.assertEqual(m._resume_notice, NOTICE)
        self.assertIn("连接超时", m.lbl_resume_status.text())
        m.btn_resume_continue.click()
        self.assertEqual(len(calls), 2)
        calls[-1][1](True, "")
        self.assertIn("已提交续接请求，等待确认", m.lbl_resume_status.text())
        self.assertNotIn("已发送", m.lbl_resume_status.text())

    def test_dismiss_failure_keeps_source_and_retry(self):
        self.open_notice()
        m = self.menu
        calls = []
        m._post_resume_action = lambda payload, on_done=None: calls.append((payload, on_done))
        m.btn_resume_dismiss.click()
        calls[-1][1](False, "暂未送达")
        self.assertEqual(m._resume_notice, NOTICE)
        self.assertIn("暂未送达", m.lbl_resume_status.text())
        m.btn_resume_dismiss.click()
        calls[-1][1](True, "")
        self.assertIsNone(m._resume_notice)
        self.assertFalse(m.resume_view.isVisible())

    def test_dismiss_restores_main_width_after_hidden_target_update(self):
        m = self.menu
        self.open_notice()
        # 主区隐藏时仍可能收到目标标题快照；长标题不能扩大滚动内容的最小宽度。
        title = '修复一级弹窗并恢复旧版目标选择样式' * 4
        self.ball.target_title = title
        self.ball.target_name = '测试伙伴'
        m._update_target()
        m._flash('已改为：' + title)
        self.pump()
        m._post_resume_action = lambda payload, on_done=None: on_done(True, '')
        m.btn_resume_dismiss.click()
        self.pump()
        self.assertFalse(m.resume_view.isVisible())
        self.assertTrue(m.main_scroll.isVisible())
        self.assertLessEqual(m.main_view.width(), m.main_scroll.viewport().width())
        self.assertIn(title, m.lbl_target_info.toolTip())
        self.assertEqual(m.lbl_feedback.toolTip(), '已改为：' + title)
        self.assertIn('…', m.lbl_target_info.text())
        self.assertIn('…', m.lbl_feedback.text())
        # 工具行默认在折叠的「对话工具」里，展开后才能量真实宽度。
        m.tools_body.setVisible(True)
        m.tools_expanded = True
        self.pump()
        for tool in (m.say_tool, m.rename_tool, m.polish_tool):
            self.assertLessEqual(tool.geometry().right(), m.main_scroll.viewport().width())

    def test_long_rename_feedback_alone_cannot_widen_main_page(self):
        m = self.menu
        feedback = '已改为：' + '这是很长的会话标题' * 12
        m._flash(feedback)
        self.pump()
        self.assertEqual(m.lbl_feedback.toolTip(), feedback)
        self.assertLessEqual(m.main_view.width(), m.main_scroll.viewport().width())
        self.open_notice()
        m._post_resume_action = lambda payload, on_done=None: on_done(True, '')
        m.btn_resume_dismiss.click()
        self.pump()
        self.assertLessEqual(m.main_view.width(), m.main_scroll.viewport().width())
        self.assertEqual(m.lbl_feedback.toolTip(), feedback)

    def test_poll_clear_keeps_page_and_shows_empty(self):
        self.open_notice()
        self.menu._apply_resume_state({"ok": True, "enabled": True, "notice": None})
        self.assertFalse(self.menu.resume_view.isVisible())
        self.assertFalse(self.menu.btn_resume_entry.isVisible())
        self.assertFalse(self.menu.resume_progress_scroll.isVisible())

    def test_ask_priority_keeps_options_note_and_heading(self):
        self.open_notice()
        m = self.menu
        m.show_ask({"askId": "fixture-ask", "agentName": "测试伙伴", "sessionTitle": "测试窗口",
                    "question": "哪些保留？", "selectionMode": "multiple",
                    "options": [{"label": "A"}, {"label": "B"}]})
        m._toggle_ask_option(0)
        m.ask_input.setText("保留说明")
        m.show_resume_strip(dict(NOTICE, reason="新原因"))
        m.open_resume_view()
        self.assertFalse(m.resume_view.isVisible())
        self.assertEqual(m.lbl_head.text(), "测试伙伴 ·「测试窗口」")
        self.assertEqual(m._ask_selected_indices, [0])
        self.assertEqual(m.ask_input.text(), "保留说明")
        m._ask_entry = None
        m._set_ask_mode(False)
        m.open_resume_view()
        self.assertTrue(m.resume_view.isVisible())

    def test_recommend_refresh_and_app_mode_cannot_leak_into_resume(self):
        self.open_notice()
        m = self.menu
        status = m.lbl_resume_status.text()
        m._apply_recommend_push({"target": {"sessionId": "other", "title": "别的对话"},
                                 "candidates": [], "suggestions": [], "notice": "会话名单超时"})
        m._apply_recommend_request_failure({"ok": False, "error": "会话名单超时"})
        m._configure_app_mode()
        m.prepare_for_show()
        self.pump()
        self.assertTrue(m.resume_view.isVisible())
        for widget in (m.recommend_body, m.say_tool, m.polish_tool, m.lbl_feedback):
            self.assertFalse(widget.isVisible())
        self.assertEqual(m.lbl_resume_status.text(), status)

    def test_loop_confirmation_keeps_finish_and_stop_capability(self):
        self.open_notice(source="loop_confirm")
        m = self.menu
        self.assertEqual(m.btn_resume_continue.text(), "接着来")
        self.assertTrue(m.btn_loop_finish.isVisible())
        self.assertFalse(m.btn_resume_dismiss.isVisible())
        m._apply_loop_state({"active": True, "sessionId": "fixture-only", "text": "正在接第2轮"})
        self.assertFalse(m.btn_loop_stop.isVisible())
        m.close_resume_view()
        self.assertTrue(m.btn_loop_stop.isVisible())

    def test_close_defers_same_notice_without_losing_it(self):
        self.open_notice()
        m = self.menu
        m.btn_resume_close.click()
        self.assertFalse(m.isVisible())
        m._apply_resume_state({"ok": True, "enabled": True, "notice": NOTICE})
        self.assertFalse(m.isVisible())
        self.assertEqual(m._resume_notice, NOTICE)

    def test_close_button_returns_to_main_panel_instead_of_reopening_dedicated_view(self):
        # 返回按钮删掉后，✕ 是专页唯一的出口；只 hide 面板会让人下次点球又撞回这张专页。
        self.open_notice()
        m = self.menu
        m.btn_resume_close.click()
        # 面板整体被 hide 了，isVisible() 会跟着父级变 False，这里看控件自己的 hidden 标志。
        self.assertTrue(m.resume_view.isHidden())
        self.assertFalse(m.main_view.isHidden())
        self.assertFalse(m._resume_view_active)
        # 提醒没丢：一级面板上的入口还在，想看还能再进去。
        self.assertFalse(m.btn_resume_entry.isHidden())
        m.btn_resume_entry.click()
        self.pump()
        self.assertFalse(m.resume_view.isHidden())
        self.assertEqual(m._resume_notice, NOTICE)

    def test_internal_close_keeps_dedicated_view_active(self):
        # 程序内部的收起（开子弹窗、答完题）不算用户放弃，不该把人退回一级。
        self.open_notice()
        m = self.menu
        m.close_menu(user_dismissed=False)
        self.assertTrue(m._resume_view_active)

    def test_empty_after_loop_confirmation_keeps_resume_view_state(self):
        # 「继续后自动循环」那套勾选与轮数步进已删（2026-10-23）：不留看不见的死控件。
        self.open_notice(source="loop_confirm")
        m = self.menu
        m.collapse_resume_strip()
        self.pump()
        self.assertFalse(hasattr(m, "chk_loop_after_resume"))
        self.assertFalse(hasattr(m, "loop_controls"))
        self.assertFalse(hasattr(m, "lbl_loop_value"))

    def test_poll_worker_preserves_loop_snapshot_and_emits_signal(self):
        m = self.menu
        snapshot = {"ok": True, "enabled": True, "notice": NOTICE,
                    "loop": {"active": True, "sessionId": "sess-1", "text": "正在续 第 1/3 轮"}}
        with patch.object(ui, "api_get", return_value=snapshot), patch.object(ui.threading, "Thread") as thread:
            thread.return_value.start.side_effect = lambda: thread.call_args.kwargs["target"]()
            m._poll_resume_async()
        self.assertEqual((m._loop_state or {}).get("text"), "正在续 第 1/3 轮")
        self.assertTrue(m._resume_view_active)

    def test_progress_does_not_open_panel_and_keeps_multiple_sources_compact(self):
        m = self.menu
        m.hide()
        items = [{"sessionId": f"fixture-{i}", "agentName": f"测试伙伴{i}", "title": "测试窗口" * 80,
                  "attempt": 1, "maxConsecutive": 3, "status": "waiting"} for i in range(6)]
        m._apply_resume_state({"ok": True, "enabled": True, "autoResume": True, "progress": items})
        self.pump()
        self.assertFalse(m.isVisible())
        self.assertFalse(m._resume_view_active)
        self.assertIsNone(m._resume_notice)
        self.assertIn("测试伙伴0", m.lbl_resume_progress.text())
        self.assertIn("测试伙伴5", m.lbl_resume_progress.text())
        self.assertIn("已发送继续哈 1/3", m.lbl_resume_progress.text())
        self.assertLessEqual(m.resume_progress_scroll.height(), 120)
        self.assertLess(len(m.lbl_resume_progress.text()), 400)
        m.show()
        self.pump()
        self.assertTrue(m.resume_progress_scroll.isVisible())
        # 朗读入口已搬到每条回复的操作行，球里这一排收起来了。
        self.assertFalse(m.say_tool.isVisible())
        self.assertFalse(m.btn_resume_entry.isVisible())
        m._apply_resume_state({"ok": True, "enabled": True, "progress": []})
        self.assertFalse(m.resume_progress_scroll.isVisible())

    def test_total_off_clears_resume_without_touching_ask_or_loop(self):
        self.open_notice()
        m = self.menu
        m.show_ask({"askId": "keep-ask", "question": "测试问题", "options": [{"label": "A"}, {"label": "B"}]})
        m._toggle_ask_option(0)
        m.ask_input.setText("测试补充")
        m._apply_resume_state({"ok": True, "enabled": False,
                               "loop": {"active": True, "sessionId": "normal-loop", "text": "正常对话循环中"}})
        self.assertTrue(m.is_ask_open())
        self.assertEqual(m._ask_selected_indices, [0])
        self.assertEqual(m.ask_input.text(), "测试补充")
        self.assertIsNone(m._resume_notice)
        self.assertIsNotNone(m._loop_state)

    def test_total_off_closes_dedicated_page_and_does_not_replay_stale_action(self):
        self.open_notice()
        m = self.menu
        m._resume_seq_adopted = True
        calls = []
        m._post_resume_action = lambda *args, **kwargs: calls.append(args)
        m._apply_resume_state({"ok": True, "enabled": False, "notice": NOTICE,
                               "progress": [dict(NOTICE, status="waiting", maxConsecutive=3)],
                               "action": {"action": "continue", "sessionId": "fixture-only"}, "actionSeq": 100})
        self.assertFalse(m.resume_view.isVisible())
        self.assertFalse(m.btn_resume_entry.isVisible())
        self.assertFalse(m.resume_progress_scroll.isVisible())
        self.assertEqual(m._resume_progress, [])
        self.assertEqual(calls, [])

    def test_disabled_resume_still_accepts_independent_loop_confirmation(self):
        m = self.menu
        m._apply_resume_state({"ok": True, "enabled": False, "notice": dict(NOTICE, source="loop_confirm")})
        self.assertTrue(m._resume_view_active)
        self.assertEqual(m.btn_resume_continue.text(), "接着来")
        self.assertFalse(m.btn_resume_auto.isEnabled())

    def test_global_auto_action_and_max_config_preserve_resume_settings(self):
        self.open_notice()
        m = self.menu
        calls = []
        m._post_resume_action = lambda payload, on_done=None: calls.append((payload, on_done))
        m.btn_resume_auto.click()
        self.assertEqual(calls[-1][0], {"action": "auto", "enabled": True})
        self.assertFalse(m.btn_resume_auto.isEnabled())
        calls[-1][1](True, "")
        m._step_resume_max(1)
        self.assertEqual(calls[-1][0], {"action": "config", "config": {"maxConsecutive": 4}})
        calls[-1][1](False, "测试失败")
        self.assertEqual(m._resume_max_consecutive, 3)
        self.assertIn("测试失败", m.lbl_resume_status.text())
        m._resume_max_consecutive = 10
        m._render_resume_auto()
        self.assertFalse(m.btn_resume_max_plus.isEnabled())
        m._resume_max_consecutive = 1
        m._render_resume_auto()
        self.assertFalse(m.btn_resume_max_minus.isEnabled())

    def test_auto_switch_background_and_text_remain_readable_in_all_states(self):
        self.open_notice()
        m = self.menu
        colors = ui.THEME_COLORS["light"]
        for checked, enabled, key in ((False, True, "surface"), (True, True, "accent_deep"),
                                      (True, False, "surface_alt")):
            with self.subTest(checked=checked, enabled=enabled):
                m._resume_auto = checked
                m._resume_enabled = enabled
                m._render_resume_auto()
                self.pump()
                image = m.btn_resume_auto.grab().toImage()
                matching = sum(image.pixelColor(x, y).name() == colors[key]
                               for y in range(image.height()) for x in range(image.width()))
                self.assertGreater(matching, image.width() * image.height() // 2,
                                   "透明内容层不能覆盖按钮自己的开/关/禁用底色")
        # 开启态白字落在深薄荷底；不把产品字体/配色策略扩到其他控件。
        def luminance(hex_color):
            channels = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
            linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in channels]
            return sum(v * weight for v, weight in zip(linear, (0.2126, 0.7152, 0.0722)))
        light, dark = sorted((luminance(colors["accent_text"]), luminance(colors["accent_deep"])), reverse=True)
        self.assertGreaterEqual((light + 0.05) / (dark + 0.05), 4.5)

    def test_render_requested_previews(self):
        directory = os.environ.get("ZHIYI_RESUME_PREVIEW_DIR")
        if not directory:
            self.skipTest("preview directory not requested")
        target = Path(directory)
        target.mkdir(parents=True, exist_ok=True)
        m = self.menu
        def capture(filename):
            self.pump()
            self.assertTrue(m.grab().save(str(target / filename)))
            if filename.startswith("resume-switch-"):
                # 独立留开关实物图，避免整页滚动位置遮住待验文字。
                control_name = filename.removesuffix(".png") + "-control.png"
                self.assertTrue(m.btn_resume_auto.grab().save(str(target / control_name)))
        m._apply_resume_state({"ok": True, "enabled": False})
        capture("resume-empty-hidden.png")
        item = {"sessionId": "fixture-only", "title": "继续完善今天的计划", "agentName": "测试伙伴",
                "attempt": 1, "maxConsecutive": 3, "status": "waiting"}
        m._apply_resume_state({"ok": True, "enabled": True, "autoResume": True, "maxConsecutive": 3, "progress": [item]})
        capture("resume-auto-1-of-3.png")
        m._apply_resume_state({"ok": True, "enabled": True, "autoResume": False, "maxConsecutive": 3,
                               "notice": dict(NOTICE, title="继续完善今天的计划", attempt=0, maxConsecutive=3)})
        capture("resume-manual.png")
        capture("resume-normal.png")
        self.open_notice(title="继续完善今天的计划", attempt=3, maxConsecutive=3,
                         reason="连续续接后仍未恢复，已达到本窗口上限。", autoResume=True)
        capture("resume-limit-3-of-3.png")
        m._resume_auto = True
        m._render_resume_auto()
        capture("resume-switch-on.png")
        m._resume_auto = False
        m._render_resume_auto()
        capture("resume-switch-off.png")
        m._resume_enabled = False
        m._render_resume_auto()
        capture("resume-switch-disabled.png")
        m._resume_enabled = True
        self.open_notice(title="继续完善今天的计划，整理尚未完成的步骤与后续安排。" * 12)
        m._after_resume_continue(False, "连接暂时中断，请保留当前页面并重试。" * 14)
        capture("resume-long-failure.png")


    def test_notice_arriving_during_ask_is_shown_after_ask_closes(self):
        """提问期间到的断点提醒不能跟着提问一起沉底（2026-10-23 实机）。

        提问开着时小条让位是规矩，但那条提醒当时已被记成"旧的"，提问一关就再也没人提起它。"""
        m = self.menu
        m._ask_entry = {"askId": "ask-1"}
        m._ask_finished = False
        self.open_notice()  # 提问期间到达
        self.assertFalse(m._resume_view_active, "提问期间不该抢台面")
        self.assertIsNotNone(m._resume_ask_pending_sig, "提问期间的提醒要记下来")
        # 提问结束（作答、隐式跳过、过期都走这条路）
        m._ask_entry = None
        m._ask_finished = False
        with patch.object(ui.ZhujianMenu, "_raise_resume_panel") as raise_panel:
            m._flush_resume_after_ask()
            self.pump()
        self.assertTrue(m._resume_view_active, "提问一结束就该把提醒补上")
        raise_panel.assert_called_once()
        self.assertIsNone(m._resume_ask_pending_sig, "补完就清掉，不重复补")

    def test_notice_dismissed_by_user_is_not_replayed_after_ask(self):
        """用户点过「不用管」的那一条，提问结束后也不该再打回脸上。"""
        m = self.menu
        m._ask_entry = {"askId": "ask-2"}
        m._ask_finished = False
        self.open_notice()
        m._resume_hidden_sig = m._resume_notice_sig(m._resume_notice)
        m._ask_entry = None
        m._ask_finished = False
        with patch.object(ui.ZhujianMenu, "_raise_resume_panel") as raise_panel:
            m._flush_resume_after_ask()
            self.pump()
        self.assertFalse(m._resume_view_active, "用户说不用管，就真不用管")
        raise_panel.assert_not_called()


    def test_progress_line_shows_sent_over_planned_rounds(self):
        """一级面板那一行只讲一件事：已发几句 / 计划几轮。

        以前那里写「已发送继续哈 0/3」——0 是手动时恒为零的失败计数，3 是全局重试上限，
        跟用户选的「连着接几轮」没关系，看着像已经失败三次。"""
        m = self.menu
        base = {"sessionId": "sess_p", "agentName": "小花", "title": "哈喽小花", "status": "waiting"}
        m._apply_resume_state({"ok": True, "enabled": True, "autoResume": False, "maxConsecutive": 3,
                               "progress": [dict(base, sent=1, total=2)]})
        text = m.lbl_resume_progress.text()
        self.assertIn("1/2", text)
        self.assertNotIn("0/3", text)
        # 连发跑完：显示已连着接
        m._apply_resume_state({"ok": True, "enabled": True, "autoResume": False, "maxConsecutive": 3,
                               "progress": [dict(base, sent=2, total=2, status="done")]})
        self.assertIn("已连着接 2/2", m.lbl_resume_progress.text())
        # 手动只发一句：没有计划轮数，就不摆分数
        m._apply_resume_state({"ok": True, "enabled": True, "autoResume": False, "maxConsecutive": 3,
                               "progress": [dict(base, sent=1, total=0)]})
        text = m.lbl_resume_progress.text()
        self.assertNotIn("0/3", text)
        self.assertIn("正在等回应", text)

    def test_resume_rounds_stepper_bounds_and_button_text(self):
        """「这次接几轮」：1~10 之间，步进到头就停，按钮上直接写出这次要接几轮。"""
        m = self.menu
        self.open_notice()
        self.assertEqual(m._resume_rounds, 1)
        self.assertEqual(m.btn_resume_continue.text(), "继续哈")
        m._step_resume_rounds(1)
        m._step_resume_rounds(1)
        self.assertEqual(m._resume_rounds, 3)
        self.assertEqual(m.btn_resume_continue.text(), "接 3 轮")
        for _ in range(20):
            m._step_resume_rounds(1)
        self.assertEqual(m._resume_rounds, 10, "上限 10")
        for _ in range(20):
            m._step_resume_rounds(-1)
        self.assertEqual(m._resume_rounds, 1, "下限 1")
        self.assertEqual(m.btn_resume_continue.text(), "继续哈")

    def test_continue_action_carries_rounds(self):
        """点「继续哈」要把这次接几轮一起发回去，App 才知道要不要接着往下接。"""
        m = self.menu
        self.open_notice()
        m._step_resume_rounds(1)
        captured = {}

        def fake_post(payload, on_done=None):
            captured.update(payload)

        with patch.object(ui.ZhujianMenu, "_post_resume_action", side_effect=fake_post):
            m._resume_send_continue()
        self.assertEqual(captured.get("action"), "continue")
        self.assertEqual(captured.get("rounds"), 2)
        self.assertTrue(captured.get("sessionId"))


if __name__ == "__main__":
    unittest.main()

    def test_auto_popup_brings_the_ball_along(self):
        """实机缺过「只看得到一张断点续接窗，找不到传音樱」：自动弹面板要先把球带出来、贴过去。"""
        m = self.menu
        m.hide()
        self.pump()
        moved = []
        original = m.move_to_ball

        def tracked():
            moved.append(True)
            original()

        m.move_to_ball = tracked
        m._apply_resume_state({
            "ok": True, "enabled": True, "autoResume": False, "maxConsecutive": 3,
            "progress": [], "notice": dict(NOTICE),
        })
        self.pump()
        self.assertTrue(m.isVisible(), "新提醒要把面板叫出来")
        self.assertTrue(moved, "弹面板前要先贴到球旁边，球和窗口不能各在各的位置")
