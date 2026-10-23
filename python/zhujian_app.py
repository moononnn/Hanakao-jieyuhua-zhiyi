#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
解语花 · 传音樱
=====================
桌面悬浮「落樱」：一枝会呼吸、会受风的小樱花。
常态轻浮轻摆；悬停时零碎落瓣；按下时枝条蓄力弯曲，松手后快速回弹并洒落花瓣。

三态：
  ROLLED   （常态）  花枝微摆 + 旧版体量花朵
  PEEKING  （悬停）  入场阵风 + 一两枚碎瓣飘落
  CLICK    （按压）  枝条压弯蓄力 → 松手越界回弹 + 两次花瓣簇

渲染：三个完整 SVG → pixmap 高清缩放（细枝 / 花朵 / 跟随叶），
通过共同支点、弹簧阻尼和不同重量的相位差形成局部物理。

通信：由知意 App 启动的本地回环服务接管关键决策 Ask；不连接旧插件代理。
浮球状态与诊断文件只写入 App 显式传入的数据目录。

启动: 由知意 App 启动；单独运行不属于受支持用法。
环境变量:
  ZHIYI_APP_DATA_DIR  知意 App 的专属数据目录
"""

import sys
import os
import json
import traceback
import faulthandler
import math
import random
import re
import time
import base64
import datetime
import threading
import tempfile
import urllib.request
import urllib.error
import urllib.parse

from app_bridge import AppBallBridge, shutdown_after_parent_ack

from PyQt6.QtCore import Qt, QTimer, QPoint, QPointF, QBuffer, QByteArray, QUrl, QIODevice, pyqtSignal, QPropertyAnimation, QEvent
from PyQt6.QtGui import (
    QPixmap, QPainter, QColor, QFontMetrics, QCursor, QPalette,
)
from PyQt6.QtSvg import QSvgRenderer
from PyQt6.QtWidgets import (
    QApplication, QWidget, QPushButton, QLabel, QFrame, QLineEdit, QPlainTextEdit, QScrollArea, QCheckBox,
    QVBoxLayout, QHBoxLayout, QGridLayout, QSizePolicy,
)

# 语音朗读播放（PyQt6 自带 QtMultimedia；缺失时按钮给出提示，不硬崩）
try:
    from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput
    _HAS_QMULTIMEDIA = True
except Exception:
    _HAS_QMULTIMEDIA = False





# ── 可点击的推荐条目（QLabel + 点击信号，支持自动换行） ──
class RecLabel(QLabel):
    clicked = pyqtSignal(int)

    def __init__(self, text, index):
        super().__init__(text)
        self._idx = index
        self.setWordWrap(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAccessibleName(text)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setContentsMargins(12, 9, 12, 9)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self._idx)
        super().mousePressEvent(e)

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter, Qt.Key.Key_Space):
            self.clicked.emit(self._idx)
            e.accept()
            return
        super().keyPressEvent(e)


# ── 提问选项：复用推荐展板，不另开第二个窗口 ──
class AskChoiceLabel(QLabel):
    clicked = pyqtSignal()

    def __init__(self, text):
        super().__init__(text)
        self.setTextFormat(Qt.TextFormat.PlainText)
        self.setObjectName("askChoice")
        self.setWordWrap(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAccessibleName(text)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        self.setContentsMargins(10, 8, 10, 8)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self.isEnabled():
            self.clicked.emit()
        e.accept()

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter, Qt.Key.Key_Space) and self.isEnabled():
            self.clicked.emit()
            e.accept()
            return
        super().keyPressEvent(e)


class AskOptionFrame(QFrame):
    # 提问作答经知意 App 自有本地桥接直接回传；不能与普通推荐条的复制/发送动作混用。
    clicked = pyqtSignal()

    def __init__(self, label, description="", recommended=False, selection_mode="single"):
        super().__init__()
        self.setObjectName("askOption")
        self._label = label
        self._selection_mode = selection_mode if selection_mode == "multiple" else "single"
        self._selected = False
        # 整条可点：选项标题、说明、留白都算命中区域。以前只绑在标题 label 上，
        # 点下面的小字没反应，用户会以为这个选项点不中。
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setAccessibleName(label)
        # 垂直 Expanding：同排选项在 QGridLayout 里等高（行高取最高卡片），文字超了整排一起放大
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        head = QHBoxLayout()
        head.setContentsMargins(0, 0, 0, 0)
        head.setSpacing(3)
        self.choice_label = AskChoiceLabel(label)
        head.addWidget(self.choice_label, 1)
        if recommended:
            badge = QLabel("推荐")
            badge.setObjectName("askRecommended")
            # 徽标只是标注，点击要落到整条上
            badge.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
            head.addWidget(badge, 0, Qt.AlignmentFlag.AlignTop)
        layout.addLayout(head)
        if description:
            detail = QLabel(description)
            detail.setTextFormat(Qt.TextFormat.PlainText)
            detail.setObjectName("askDescription")
            detail.setWordWrap(True)
            detail.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
            detail.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
            layout.addWidget(detail)
        # 弹性吸收：等高拉伸后内容顶部对齐，底部空白均匀
        layout.addStretch(1)
        self.set_selected(False)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self.isEnabled():
            self.clicked.emit()
            e.accept()
            return
        super().mousePressEvent(e)

    def set_selected(self, selected):
        self._selected = bool(selected)
        if self._selection_mode == "multiple":
            prefix = "☑ " if self._selected else "□ "
            self.choice_label.setText(prefix + self._label)
            self.choice_label.setAccessibleName(("已选：" if self._selected else "未选：") + self._label)
        else:
            self.choice_label.setText(self._label)
            self.choice_label.setAccessibleName(self._label)
        self.setProperty("selected", "true" if self._selected else "false")
        self.style().unpolish(self)
        self.style().polish(self)
        self.update()

    @property
    def selected(self):
        return self._selected


def latest_ask_pending(pending):
    """只展示最新一条提问；旧提问留在服务端等过期/清理。"""
    if not isinstance(pending, list):
        return None
    valid = [item for item in pending if isinstance(item, dict) and item.get("askId")]
    if not valid:
        return None

    def timestamp(item):
        try:
            return int(item.get("ts") or 0)
        except (TypeError, ValueError):
            return 0

    return max(valid, key=timestamp)


def normalize_custom_answer(text):
    value = str(text or "").strip()
    return value if len(value) <= ASK_INPUT_MAX_LENGTH else ""


API_BASE = ""  # AppBallBridge 启动后设置为本进程随机回环端口
API_TOKEN = ""  # 每次启动随机生成，只在 App 与该子进程之间传递
APP_ONLY_ASK = os.environ.get("ZHIYI_APP_MODE") == "ask-only"
APP_DATA_DIR = os.environ.get("ZHIYI_APP_DATA_DIR", "").strip()
if not APP_DATA_DIR or not os.path.isabs(APP_DATA_DIR):
    raise RuntimeError("必须由知意 App 提供有效的专属数据目录")
STATE_PATH = os.path.join(APP_DATA_DIR, "zhujian-state.json")
HERE = os.path.dirname(os.path.abspath(__file__))
_LOCAL_API_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# ── 尺寸与渲染 ──
BALL_SIZE = 80            # 透明悬浮窗尺寸；给花枝与跟随叶留出完整摇摆空间
FLOWER_SIZE = 34          # 恢复旧版花朵体量；枝条、叶片与80px窗口保持新版结构
BRANCH_SIZE = 80          # 主枝横穿透明窗并在两侧被裁断，暗示树冠延伸到画面外
LEAF_SIZE = 56            # SVG 画布留白较多，放大后叶片本体约 18px
BALL_VISUAL_SCALE = 0.90  # 整体视觉缩小一档；保留透明窗口与交互定位不变
SVG_SIZE = 400            # SVG 输出基准尺寸
RENDER_SCALE = 3          # 高清渲染倍率
RENDER_SIZE = SVG_SIZE * RENDER_SCALE
FLOWER_CENTER = (50.0, 46.0)
LEAF_CENTER = (31.0, 21.0)   # 叶柄贴在主枝与细枝的分叉附近
BRANCH_PIVOT = (0.5, 31.5)   # 主枝从左边界进入，绕画外树身连接处轻摆

# ── 微风动效参数 ──
MIN_WIND_STRENGTH = 0.55
MAX_WIND_STRENGTH = 1.35
FULL_GUST_SPEED = 1100.0
HOVER_PETAL_INTERVAL = (0.26, 0.52)
PRESS_PETAL_COUNT = 11
RELEASE_PETAL_COUNT = 16
SWEEP_FADE_START = 24.0
SWEEP_MIN_SPEED = 45.0
SWEEP_PETAL_SPEED = 210.0
MAX_PETAL_PARTICLES = 48
# 拖动响应按窗口真实位移采样；原版与融合版共用同一组目标/弹簧语义。
DRAG_MAX_SPEED = 2400.0
DRAG_FILTER_TAU = 0.035
DRAG_STALE_AFTER = 0.055
DRAG_DECAY_TAU = 0.10

# ── 鼠标 hover 滞回 ──
EDGE_INSET = 16
HOVER_ENTER_MARGIN = 4
HOVER_EXIT_MARGIN = 12
HOVER_LEAVE_DELAY = 0.24

# ── 弹出窗垂直锚点（花朵中心位于弹出窗高度中的比例，0.5=居中） ──
PANEL_ANCHOR_RATIO = 0.38   # 左键推荐面板：花在面板上部，面板主体在花下方（实机确认）
MENU_ANCHOR_RATIO = 0.33    # 右键发送浮签：主体在花下方，与面板视觉呼应
TARGET_SESSION_LIMIT = 5    # 目标选择只展示最近活跃的 5 个窗口，避免面板过长
# 「会话标题」那一行的说明文字：平时写用途，正在总结时换成进度（同一行长度，不改变行高）
RENAME_DESC_IDLE = "按整段对话生成一个更贴切的名字"
RENAME_DESC_BUSY = "正在按这段对话想新标题…"
ASK_INPUT_MAX_LENGTH = 500  # 自定义回答上限，和 App 桥接校验保持一致
ASK_POLL_INTERVAL_MS = 1500
ASK_PANEL_MAX_HEIGHT = 600
RESUME_POLL_INTERVAL_MS = 800   # 续接小条轮询：只读桥上的 notice/action，比 App 读桥的 2 秒更快一步
SLEEP_POLL_INTERVAL_MS = 1500   # 守门状态：按钮按下去要看得见反应，太快也不值当
RECOMMEND_POLL_INTERVAL_MS = 1500  # 球内推荐/目标快照轮询：跟 App 侧桥的推送节奏对齐
# 主面板收起、只剩二级弹窗时用慢速继续听：朗读窗/理顺窗的目标行要靠这份快照更新，
# 彻底停掉的话推送永远送不到它们，切窗口就像没反应。
RECOMMEND_POLL_SLOW_MS = 2_000

# ── 弹窗鼠标离开自动半透明（左键面板 / 右键浮签共用） ──
FADE_OUT_OPACITY = 0.60      # 半透明下限：留存在感，鼠标也找得到窗口
FADE_OUT_DELAY_MS = 450      # 鼠标离开后的宽限，防止快速穿越边缘抖动
FADE_SHOW_GRACE_MS = 900     # 刚弹出时的缓冲：即使光标不在窗内也先全显，再开始判定
FADE_OUT_DURATION_MS = 420   # 淡出渐变时长（慢慢隐退）
FADE_IN_DURATION_MS = 180    # 恢复渐变时长（回来要快）

# ── 手帐风配色：保留落樱自己的薄荷绿与粉色，明暗随 Hana 切换 ──
DARK_THEME_IDS = {"midnight", "midnight-contrast"}
THEME_COLORS = {
    "light": {
        "panel": "#fbf8ef", "surface": "#fffdf7", "surface_alt": "#eef6f1",
        "border": "#b6d1c4", "ink": "#3e4b43", "sub": "#7f8e85", "sub_deep": "#6b7a71",
        "accent": "#5b9a82", "accent_deep": "#3f705d", "accent_text": "#ffffff",
        "pink": "#d893a6", "danger_bg": "#f9edf0", "shadow": "#526a60",
    },
    "dark": {
        "panel": "#384850", "surface": "#42545c", "surface_alt": "#465c5c",
        "border": "#6b877d", "ink": "#e7efeb", "sub": "#b5c4bd", "sub_deep": "#a4b4ac",
        "accent": "#86bba6", "accent_deep": "#cfe7dc", "accent_text": "#263a34",
        "pink": "#dda9b7", "danger_bg": "#51464d", "shadow": "#172126",
    },
}


# ── 工具函数 ──
def resolve_theme_mode(theme_id, system_dark=False):
    theme_id = str(theme_id or "warm-paper")
    if theme_id == "auto":
        return "dark" if system_dark else "light"
    return "dark" if theme_id in DARK_THEME_IDS else "light"


def read_hana_theme_mode():
    # 不读取 Hana 全局 preferences.json；App 可在以后提供自己的主题设置。
    theme_id = os.environ.get("ZHIYI_BALL_THEME", "auto")
    app = QApplication.instance()
    system_dark = False
    if app is not None:
        window_color = app.palette().color(QPalette.ColorRole.Window)
        system_dark = window_color.lightness() < 128
    return resolve_theme_mode(theme_id, system_dark)


# ── 分支列表时间显示：今天显时分，往年显日期 ──
def _opening_snippet(text, limit=16):
    """把对话开头那句压成 16 个字，给没有标题的提醒当身份证用。"""
    flat = " ".join(str(text or "").split())
    if not flat:
        return ""
    return flat[:limit] + "…" if len(flat) > limit else flat


def format_branch_time(ts):
    try:
        t = time.localtime(ts / 1000 if ts > 1e12 else ts)
        now = time.localtime()
        if (t.tm_year, t.tm_yday) == (now.tm_year, now.tm_yday):
            return time.strftime("%H:%M", t)
        if t.tm_year == now.tm_year:
            return time.strftime("%m-%d %H:%M", t)
        return time.strftime("%Y-%m-%d", t)
    except Exception:
        return ""


def clamp_pair_drag(dx, dy, first_rect, second_rect, bounds):
    """把两个窗口整体限位；bounds 为左/上闭区间、右/下开区间。"""
    left = min(first_rect[0], second_rect[0])
    top = min(first_rect[1], second_rect[1])
    right = max(first_rect[0] + first_rect[2], second_rect[0] + second_rect[2])
    bottom = max(first_rect[1] + first_rect[3], second_rect[1] + second_rect[3])
    screen_left, screen_top, screen_right, screen_bottom = bounds
    return (
        max(screen_left - left, min(int(dx), screen_right - right)),
        max(screen_top - top, min(int(dy), screen_bottom - bottom)),
    )


def popup_anchor_y(anchor_rect, popup_height, bounds, anchor_ratio):
    """垂直锚点：anchor_ratio 是花朵中心在弹出窗高度中的位置（0~1），
    0.5=垂直居中，>0.5 偏上，<0.5 偏下。返回 clamped 后的 y。"""
    ay, ah = anchor_rect[1], anchor_rect[3]
    _, top, _, bottom = bounds
    y = ay + ah // 2 - int(popup_height * anchor_ratio)
    return max(top, min(y, bottom - popup_height))


def position_popup_beside(anchor_rect, popup_size, bounds, gap=8, anchor_ratio=0.5):
    """优先放锚点右侧，放不下翻到左侧；垂直方向按 anchor_ratio 锚定。"""
    ax, ay, aw, ah = anchor_rect
    pw, ph = popup_size
    left, top, right, bottom = bounds
    right_x = ax + aw + gap
    left_x = ax - pw - gap
    x = right_x if right_x + pw <= right else left_x
    return (
        max(left, min(x, right - pw)),
        popup_anchor_y(anchor_rect, ph, bounds, anchor_ratio),
    )


def position_popup_left_first(anchor_rect, popup_size, bounds, gap=8, anchor_ratio=0.5):
    """优先放锚点左侧，左侧放不下才放右侧；返回 (x, y, side)。"""
    ax, _ay, aw, ah = anchor_rect
    pw, ph = popup_size
    left, top, right, bottom = bounds
    left_x = ax - pw - gap
    right_x = ax + aw + gap
    if left_x >= left:
        x, side = left_x, "left"
    else:
        x, side = right_x, "right"
    return (
        max(left, min(x, right - pw)),
        popup_anchor_y(anchor_rect, ph, bounds, anchor_ratio),
        side,
    )


def clamp_position(x, y, width, height, left, top, right, bottom, inset=EDGE_INSET):
    min_x = left + inset
    min_y = top + inset
    max_x = max(min_x, right - width - inset + 1)
    max_y = max(min_y, bottom - height - inset + 1)
    return (
        max(min_x, min(int(x), max_x)),
        max(min_y, min(int(y), max_y)),
    )


def point_in_flower_zone(x, y, margin=0.0):
    """只沿主枝、叶片和花朵附近响应，避免透明窗四角提前吃掉入场阵风。"""
    x = float(x)
    y = float(y)
    margin = max(0.0, float(margin))
    on_branch = -margin <= x <= BALL_SIZE + margin and 8.0 - margin <= y <= 36.0 + margin
    flower_rx = 19.0 + margin
    flower_ry = 18.0 + margin
    on_flower = (
        ((x - FLOWER_CENTER[0]) / flower_rx) ** 2
        + ((y - FLOWER_CENTER[1]) / flower_ry) ** 2
        <= 1.0
    )
    leaf_rx = 18.0 + margin
    leaf_ry = 14.0 + margin
    on_leaf = (
        ((x - LEAF_CENTER[0]) / leaf_rx) ** 2
        + ((y - LEAF_CENTER[1]) / leaf_ry) ** 2
        <= 1.0
    )
    return on_branch or on_flower or on_leaf


def segment_crosses_flower_zone(x1, y1, x2, y2, margin=0.0):
    """采样两帧间的整段轨迹，防止高速光标从区域外直接穿过花枝。"""
    distance = math.hypot(float(x2) - float(x1), float(y2) - float(y1))
    steps = max(1, min(int(math.ceil(distance / 3.0)), 48))
    for index in range(steps + 1):
        ratio = index / steps
        x = float(x1) + (float(x2) - float(x1)) * ratio
        y = float(y1) + (float(y2) - float(y1)) * ratio
        if point_in_flower_zone(x, y, margin):
            return True
    return False


def resolve_hover_state(hovered, x, y, outside_elapsed, frame_elapsed):
    """沿可见花枝做进出滞回和离开宽限，避免透明区提前触发。"""
    margin = HOVER_EXIT_MARGIN if hovered else HOVER_ENTER_MARGIN
    if point_in_flower_zone(x, y, margin):
        return True, 0.0
    if not hovered:
        return False, 0.0
    outside_elapsed += frame_elapsed
    if outside_elapsed >= HOVER_LEAVE_DELAY:
        return False, 0.0
    return True, outside_elapsed


def wind_strength_from_speed(speed):
    """把光标速度平滑映射成有限风力，慢慢靠近也有轻微回应。"""
    ratio = max(0.0, min(float(speed) / FULL_GUST_SPEED, 1.0))
    smooth = ratio * ratio * (3.0 - 2.0 * ratio)
    return MIN_WIND_STRENGTH + (MAX_WIND_STRENGTH - MIN_WIND_STRENGTH) * smooth


def sweep_strength_from_speed(speed):
    speed = max(0.0, float(speed))
    if speed <= SWEEP_FADE_START:
        return 0.0
    fade_ratio = max(0.0, min((speed - SWEEP_FADE_START) / (SWEEP_MIN_SPEED * 2.0), 1.0))
    fade = fade_ratio * fade_ratio * (3.0 - 2.0 * fade_ratio)
    return wind_strength_from_speed(speed) * fade


def calculate_entry_wind(previous_x, previous_y, current_x, current_y, elapsed, center_x):
    """进入风与连续风使用同一方向语义和渐入强度，避免刚进来先反向抽动。"""
    dx = float(current_x) - float(previous_x)
    dy = float(current_y) - float(previous_y)
    seconds = max(float(elapsed), 1.0 / 240.0)
    speed = math.hypot(dx, dy) / seconds
    if abs(dx) >= abs(dy) * 0.42 and abs(dx) >= 0.55:
        direction = -1.0 if dx > 0.0 else 1.0
    elif abs(dy) >= 0.55:
        direction = -1.0 if dy > 0.0 else 1.0
    else:
        direction = -1.0 if float(current_x) <= float(center_x) else 1.0
    return direction, sweep_strength_from_speed(speed)


def should_apply_cursor_sweep(cursor_hovered, pressed, dragging):
    return bool(cursor_hovered and not pressed and not dragging)


def calculate_cursor_sweep(previous_x, previous_y, current_x, current_y, elapsed):
    """连续读取掠过轨迹；风力从零渐入，避免阈值附近突然跳档。"""
    dx = float(current_x) - float(previous_x)
    dy = float(current_y) - float(previous_y)
    distance = math.hypot(dx, dy)
    seconds = max(float(elapsed), 1.0 / 240.0)
    speed = distance / seconds
    if speed < SWEEP_FADE_START or distance < 0.55:
        return 0.0, 0.0, speed, 0.0, 0.0
    if abs(dx) >= abs(dy) * 0.42:
        direction = -1.0 if dx > 0.0 else 1.0
    else:
        direction = -1.0 if dy > 0.0 else 1.0
    strength = sweep_strength_from_speed(speed)
    return direction, strength, speed, dx / seconds, dy / seconds


def sample_drag_velocity(
    previous_x,
    previous_y,
    previous_ts,
    previous_vx,
    previous_vy,
    current_x,
    current_y,
    current_ts,
):
    """从窗口真实位移估算平滑拖速；触边限位后不再凭鼠标继续加速。"""
    elapsed = max(float(current_ts) - float(previous_ts), 1.0 / 240.0)
    raw_vx = (float(current_x) - float(previous_x)) / elapsed
    raw_vy = (float(current_y) - float(previous_y)) / elapsed
    raw_speed = math.hypot(raw_vx, raw_vy)
    if raw_speed > DRAG_MAX_SPEED:
        scale = DRAG_MAX_SPEED / raw_speed
        raw_vx *= scale
        raw_vy *= scale
    alpha = 1.0 - math.exp(-min(elapsed, 0.12) / DRAG_FILTER_TAU)
    if math.hypot(float(previous_vx), float(previous_vy)) < 1.0:
        alpha = max(alpha, 0.62)
    vx = float(previous_vx) + (raw_vx - float(previous_vx)) * alpha
    vy = float(previous_vy) + (raw_vy - float(previous_vy)) * alpha
    return vx, vy, vx - float(previous_vx), vy - float(previous_vy), math.hypot(vx, vy)


def flower_drag_targets(velocity_x, velocity_y):
    """把拖速翻译成柔性层目标：根部最稳，花冠次之，轻叶拖尾最大。"""
    vx = float(velocity_x)
    vy = float(velocity_y)
    return (
        max(-7.2, min(-vx * 0.0048, 7.2)),
        max(-13.5, min(-vx * 0.0092, 13.5)),
        max(-19.0, min(-vx * 0.0130, 19.0)),
        max(-4.8, min(-vy * 0.0036, 4.8)),
    )


def flower_drag_impulses(delta_vx, delta_vy):
    """加速/急停产生的局部惯性，越轻的部件获得越大的速度变化。"""
    dvx = float(delta_vx)
    dvy = float(delta_vy)
    return (
        max(-18.0, min(-dvx * 0.018, 18.0)),
        max(-34.0, min(-dvx * 0.036, 34.0)),
        max(-50.0, min(-dvx * 0.055, 50.0)),
        max(-20.0, min(-dvy * 0.018, 20.0)),
    )


def advance_motion_spring(value, velocity, target, stiffness, damping, dt, limit):
    """可中断的局部弹簧；拖动反向时沿用现有速度，不重启动画。"""
    dt = max(0.0, min(float(dt), 0.05))
    acceleration = (
        (float(target) - float(value)) * float(stiffness)
        - float(velocity) * float(damping)
    )
    velocity = float(velocity) + acceleration * dt
    value = float(value) + velocity * dt
    value = max(-abs(float(limit)), min(value, abs(float(limit))))
    if abs(value) < 0.001 and abs(velocity) < 0.01 and abs(float(target)) < 0.001:
        return 0.0, 0.0
    return value, velocity


def petal_count_from_sweep_speed(speed):
    """掠风按速度落 3/5/7/9 枚，最高仍低于按下时的 11 枚。"""
    speed = max(0.0, float(speed))
    if speed < SWEEP_PETAL_SPEED:
        return 0
    if speed < 560.0:
        return 3
    if speed < 920.0:
        return 5
    if speed < 1500.0:
        return 7
    return 9


def cursor_wind_components(velocity_x, velocity_y, strength, direction):
    """左右掠过负责横摆，上下掠过负责花头升降，斜向则按比例混合。"""
    velocity_x = float(velocity_x)
    velocity_y = float(velocity_y)
    axis_total = max(abs(velocity_x) + abs(velocity_y), 1.0)
    horizontal = float(direction) * float(strength) * abs(velocity_x) / axis_total
    vertical_sign = 1.0 if velocity_y > 0.0 else -1.0 if velocity_y < 0.0 else 0.0
    vertical = vertical_sign * float(strength) * abs(velocity_y) / axis_total
    return horizontal, vertical


def component_motion(t, bloom, gust, direction, rebound_pulse=0.0):
    """花枝先受力，花朵随后，叶片拖尾；左右来风保持镜像。"""
    bloom = max(0.0, min(float(bloom), 1.0))
    gust = max(0.0, float(gust))
    direction = -1.0 if float(direction) < 0.0 else 1.0
    rebound_pulse = max(0.0, min(float(rebound_pulse), 1.0))
    branch = direction * gust * 1.15 + bloom * 0.45 * math.sin(float(t) * 3.1)
    flower = direction * gust * 0.72 + bloom * 0.78 * math.sin(float(t) * 3.8 + 0.48)
    leaf = direction * gust * 4.8 + bloom * 3.2 * math.sin(float(t) * 4.15 + 1.18)
    flower += direction * rebound_pulse * 1.25
    leaf += direction * rebound_pulse * 7.5
    return branch, flower, leaf


def advance_press_spring(amount, velocity, pressed, dt):
    """按住时蓄力下压，松开后快速越过原位并衰减回弹。"""
    dt = max(0.0, min(float(dt), 0.05))
    target = 1.0 if pressed else 0.0
    stiffness = 82.0 if pressed else 118.0
    damping = 16.0 if pressed else 10.5
    acceleration = (target - float(amount)) * stiffness - float(velocity) * damping
    velocity = float(velocity) + acceleration * dt
    amount = float(amount) + velocity * dt
    amount = max(-0.34, min(amount, 1.08))
    return amount, velocity


def rotate_point_around(x, y, pivot_x, pivot_y, angle_degrees):
    """把局部点绕枝条支点旋转，供粒子从真实花心附近生成。"""
    radians = math.radians(float(angle_degrees))
    dx = float(x) - float(pivot_x)
    dy = float(y) - float(pivot_y)
    cosine = math.cos(radians)
    sine = math.sin(radians)
    return (
        float(pivot_x) + dx * cosine - dy * sine,
        float(pivot_y) + dx * sine + dy * cosine,
    )


def _api_headers(extra=None):
    headers = dict(extra or {})
    if API_TOKEN:
        headers["X-Zhiyi-Token"] = API_TOKEN
    return headers


_CRASH_LOG = None


def _install_crash_log():
    """把崩溃现场写到数据目录（ball-crash.log）。

    球是独立进程，以前崩了以后 App 只看得到退出码，什么都查不了。
    faulthandler 接住 C 层致命错误，excepthook 接住未捕获异常。
    """
    global _CRASH_LOG
    try:
        os.makedirs(APP_DATA_DIR, exist_ok=True)
        path = os.path.join(APP_DATA_DIR, "ball-crash.log")
        if os.path.exists(path) and os.path.getsize(path) > 262144:
            os.remove(path)
        _CRASH_LOG = open(path, "a", encoding="utf-8", buffering=1)
        faulthandler.enable(file=_CRASH_LOG, all_threads=True)
    except Exception:
        return

    def _hook(exc_type, exc, tb):
        try:
            _CRASH_LOG.write(f"\n[{time.strftime('%Y-%m-%d %H:%M:%S')}] uncaught\n")
            _CRASH_LOG.write("".join(traceback.format_exception(exc_type, exc, tb)))
            _CRASH_LOG.flush()
        except Exception:
            pass
        sys.__excepthook__(exc_type, exc, tb)

    sys.excepthook = _hook


def _panel_diag(tag, **fields):
    """面板侧排障记录（panel-diag.log）。

    球是独立进程，平时不写日志，用户说“点了没反应”时只能靠猜。这里只记关键字段
    （目标、按钮文字、候选顺序、哪个弹窗），不记对话内容；文件超 256KB 重开。
    """
    if not APP_DATA_DIR:
        return
    try:
        path = os.path.join(APP_DATA_DIR, "panel-diag.log")
        if os.path.exists(path) and os.path.getsize(path) > 262144:
            os.remove(path)
        rec = {"at": time.strftime("%H:%M:%S"), "tag": tag}
        rec.update(fields)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _api_diag(tag, exc, path=""):
    """API 调用失败时把异常与环境信息落盘（zhujian-api-dbg.log），排查用。"""
    try:
        import json
        log_path = os.path.join(APP_DATA_DIR, "zhujian-api-dbg.log")
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {tag} {path}\n")
            f.write(f"  api_base={API_BASE!r} token_len={len(API_TOKEN)}\n")
            tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__)).replace("\n", "\n  ")
            f.write("  " + tb + "\n---\n")
    except Exception:
        pass


def api_get(path, timeout=5):
    try:
        req = urllib.request.Request(API_BASE + path, headers=_api_headers())
        with _LOCAL_API_OPENER.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        _api_diag("GET", e, path)
        raise


def api_post(path, payload, timeout=12):
    try:
        req = urllib.request.Request(
            API_BASE + path,
            data=json.dumps(payload).encode("utf-8"),
            headers=_api_headers({"Content-Type": "application/json"}),
        )
        with _LOCAL_API_OPENER.open(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        _api_diag("POST", e, path)
        raise


def load_state():
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    """原子保存位置与融合面板状态，避免协调器读到半截 JSON。"""
    temp_path = STATE_PATH + ".tmp"
    try:
        os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, STATE_PATH)
    except Exception as e:
        try:
            if os.path.exists(temp_path):
                os.unlink(temp_path)
        except Exception:
            pass
        print(f"[落樱] 保存状态失败: {e}", file=sys.stderr)


# ─────────────────────────────
#  弹窗鼠标离开自动半透明（mixin，不依赖 MRO，事件由子类显式调用）
# ─────────────────────────────
class FadeOnLeaveMixin:
    """鼠标离开弹窗 → 稍候缓慢半透明；鼠标移回 → 快速恢复不透明。

    弹窗是矩形窗口，enter/leave 事件可靠；但呼出时光标可能就不在窗内
    （点击花朵后鼠标停在旁边），没有离开事件可依，故 show 时主动检查一次。
    用法：子类 __init__ 末尾调 setup_fade_on_leave()，并在对应事件里调
    _reset_fade_on_show / _on_fade_enter / _on_fade_leave。
    """

    def setup_fade_on_leave(self):
        self._fade_out_timer = QTimer(self)
        self._fade_out_timer.setSingleShot(True)
        self._fade_out_timer.timeout.connect(self._begin_fade_out)
        self._fade_anim = QPropertyAnimation(self, b"windowOpacity", self)

    def _fade_allowed(self):
        """是否允许自动淡出；子类可覆写（如提问态保持实体）。"""
        return True

    def _reset_fade_on_show(self):
        """显示时：光标在窗内 → 全不透明且不排期；不在 → 给缓冲期后淡出。"""
        self.setWindowOpacity(1.0)
        self._fade_out_timer.stop()
        self._fade_anim.stop()
        if self._fade_allowed() and not self._cursor_inside():
            self._fade_out_timer.start(FADE_OUT_DELAY_MS + FADE_SHOW_GRACE_MS)

    def _on_fade_enter(self):
        self._fade_out_timer.stop()
        self._fade_to(1.0, FADE_IN_DURATION_MS)

    def _on_fade_leave(self):
        if self._fade_allowed():
            self._fade_out_timer.start(FADE_OUT_DELAY_MS)

    def _cancel_fade(self):
        if self._fade_out_timer is not None:
            self._fade_out_timer.stop()
        if self._fade_anim is not None:
            self._fade_anim.stop()

    def _cursor_inside(self):
        return self.rect().contains(self.mapFromGlobal(QCursor.pos()))

    def _begin_fade_out(self):
        self._fade_to(FADE_OUT_OPACITY, FADE_OUT_DURATION_MS)

    def _fade_to(self, target, duration_ms):
        self._fade_anim.stop()
        self._fade_anim.setStartValue(self.windowOpacity())
        self._fade_anim.setEndValue(target)
        self._fade_anim.setDuration(duration_ms)
        self._fade_anim.start()


# ─────────────────────────────
#  发送方式浮签（替代粗糙的系统 QMenu）
# ─────────────────────────────
class SendModeMenu(FadeOnLeaveMixin, QFrame):
    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("modeMenu")
        self.setFixedWidth(220)

        root = QVBoxLayout(self)
        root.setContentsMargins(14, 14, 14, 12)
        root.setSpacing(7)

        title = QLabel("知意传音樱" if APP_ONLY_ASK else "发送方式")
        title.setObjectName("menuTitle")
        root.addWidget(title)
        subtitle = QLabel("选择推荐语点下去后的动作")
        subtitle.setObjectName("menuSub")
        subtitle.setVisible(not APP_ONLY_ASK)
        root.addWidget(subtitle)

        self.btn_send = QPushButton()
        self.btn_send.setObjectName("modeChoice")
        self.btn_send.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_send.clicked.connect(lambda: self._choose("send"))
        root.addWidget(self.btn_send)

        self.btn_copy = QPushButton()
        self.btn_copy.setObjectName("modeChoice")
        self.btn_copy.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_copy.clicked.connect(lambda: self._choose("copy"))
        root.addWidget(self.btn_copy)

        divider = QFrame()
        divider.setObjectName("menuDivider")
        divider.setFixedHeight(1)
        divider.setVisible(not APP_ONLY_ASK)
        root.addWidget(divider)

        self.btn_close = QPushButton("关闭传音樱" if APP_ONLY_ASK else "关闭解语花")
        self.btn_close.setObjectName("closeBall")
        self.btn_close.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_close.clicked.connect(self._quit_ball)
        root.addWidget(self.btn_close)
        self.apply_theme()
        self.setup_fade_on_leave()

    def enterEvent(self, event):
        super().enterEvent(event)
        self._on_fade_enter()

    def leaveEvent(self, event):
        super().leaveEvent(event)
        self._on_fade_leave()

    def showEvent(self, event):
        super().showEvent(event)
        self._reset_fade_on_show()

    def hideEvent(self, event):
        super().hideEvent(event)
        self._cancel_fade()

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #modeMenu {{
                background: transparent; border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#menuTitle {{ font-size: 14px; font-weight: 700; color: {c['accent_deep']}; }}
            QLabel#menuSub {{ font-size: 10px; color: {c['sub']}; padding-bottom: 3px; }}
            QPushButton#modeChoice {{
                min-height: 32px; text-align: left; padding: 0 11px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px; font-size: 12px;
            }}
            QPushButton#modeChoice:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QFrame#menuDivider {{ background: {c['border']}; border: none; margin: 3px 5px; }}
            QPushButton#closeBall {{
                min-height: 28px; color: {c['pink']}; background: transparent;
                border: none; border-radius: 9px; font-size: 11px;
            }}
            QPushButton#closeBall:hover {{ background: {c['danger_bg']}; }}
        """)
        self.btn_send.setVisible(not APP_ONLY_ASK)
        self.btn_copy.setVisible(not APP_ONLY_ASK)
        self._sync_choices()

    def _sync_choices(self):
        if APP_ONLY_ASK:
            return
        send_on = self.ball.action == "send"
        self.btn_send.setText(("●  " if send_on else "○  ") + "直接发出")
        self.btn_copy.setText(("●  " if not send_on else "○  ") + "复制")

    def _choose(self, action):
        self.ball._set_action(action)
        self._sync_choices()
        self.close()

    def _quit_ball(self):
        self.ball._close_menu()
        self.close()
        QApplication.instance().quit()

    def show_at(self, global_pos):
        self.apply_theme()
        self.adjustSize()
        ball = self.ball
        screen = ball.screen() or QApplication.screenAt(global_pos) or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        # 右键点位只负责触发；浮签始终锚在花朵旁边，避免点在花心时彼此重叠。
        x, y = position_popup_beside(
            (ball.x(), ball.y(), ball.width(), ball.height()),
            (self.width(), self.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            gap=8,
            anchor_ratio=MENU_ANCHOR_RATIO,
        )
        self.move(x, y)
        self.show()
        self.raise_()

    def paintEvent(self, event):
        super().paintEvent(event)
        c = THEME_COLORS[self.ball.theme_mode]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor(c["border"]))
        painter.setBrush(QColor(c["panel"]))
        painter.drawRoundedRect(self.rect().adjusted(1, 1, -1, -1), 16, 16)
        painter.end()


# ─────────────────────────────
#  问问小花输入弹窗（右键浮签 → 问一个 Hana 使用问题，发到当前会话）
# ─────────────────────────────
class AskFlowerDialog(FadeOnLeaveMixin, QFrame):
    """输入 HanaAgent 使用问题，POST /ask-flower 发到当前活跃会话，
    由助手加载内置说明书 skill 回答。样式对齐右键浮签（手帐风、霞鹜文楷）。"""

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("askFlowerDialog")
        self.setFixedWidth(250)
        # 与朗读弹窗同一套双窗拖动：面板与花朵保持相对距离一起动；用户拖过后不再自动重新锚定
        self._drag_press = None
        self._drag_panel_start = None
        self._drag_ball_start = None
        self._drag_moved = False
        self._user_dragged = False
        self.side = "left"

        root = QVBoxLayout(self)
        root.setContentsMargins(14, 13, 14, 12)
        root.setSpacing(7)

        title = QLabel("❓ 问问小花")
        title.setObjectName("menuTitle")
        root.addWidget(title)
        subtitle = QLabel("想问 Hana 使用上的问题？点这里问问小花，基于 Hana 内置的 user-guide 说明书 skill，帮你更方便地解答")
        subtitle.setObjectName("menuSub")
        subtitle.setWordWrap(True)
        root.addWidget(subtitle)

        self.input = QLineEdit()
        self.input.setObjectName("askFlowerInput")
        self.input.setPlaceholderText("比如：怎么归档旧会话？")
        self.input.returnPressed.connect(self._send)
        # 输入框有焦点时保持不透明（用户可能鼠标不在窗内，但正在打字，不该淡出）
        self.input._ask_orig_focus_in = self.input.focusInEvent
        self.input._ask_orig_focus_out = self.input.focusOutEvent
        self.input.focusInEvent = self._on_input_focus_in
        self.input.focusOutEvent = self._on_input_focus_out
        root.addWidget(self.input)

        # 回答显示区（可滚动，支持长回答）
        self.answer_scroll = QScrollArea()
        self.answer_scroll.setObjectName("askFlowerAnswerScroll")
        self.answer_scroll.setWidgetResizable(True)
        self.answer_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.answer_scroll.setMaximumHeight(180)
        self.answer_scroll.hide()
        self.answer_body = QLabel("")
        self.answer_body.setObjectName("askFlowerAnswer")
        self.answer_body.setWordWrap(True)
        self.answer_body.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.answer_body.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.answer_scroll.setWidget(self.answer_body)
        root.addWidget(self.answer_scroll)

        btns = QHBoxLayout()
        btns.setSpacing(6)
        self.btn_cancel = QPushButton("取消")
        self.btn_cancel.setObjectName("askFlowerCancel")
        self.btn_cancel.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_cancel.clicked.connect(self.close)
        btns.addWidget(self.btn_cancel, 1)
        self.btn_send = QPushButton("提问")
        self.btn_send.setObjectName("askFlowerSend")
        self.btn_send.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_send.clicked.connect(self._send)
        btns.addWidget(self.btn_send, 1)
        root.addLayout(btns)

        self.lbl_status = QLabel("")
        self.lbl_status.setObjectName("menuSub")
        self.lbl_status.setWordWrap(True)
        self.lbl_status.hide()
        root.addWidget(self.lbl_status)

        self.apply_theme()
        self.setup_fade_on_leave()

    def enterEvent(self, event):
        super().enterEvent(event)
        self._on_fade_enter()

    def leaveEvent(self, event):
        super().leaveEvent(event)
        self._on_fade_leave()

    def _on_input_focus_in(self, event):
        # 聚焦输入框：立即恢复不透明并取消淡出排期
        self._fade_out_timer.stop()
        self._fade_to(1.0, FADE_IN_DURATION_MS)
        orig = getattr(self.input, "_ask_orig_focus_in", None)
        if orig is not None:
            orig(event)

    def _on_input_focus_out(self, event):
        # 失焦：恢复正常淡出判定（鼠标不在窗内则按排期淡出）
        if self._fade_allowed() and not self._cursor_inside():
            self._fade_out_timer.start(FADE_OUT_DELAY_MS)
        orig = getattr(self.input, "_ask_orig_focus_out", None)
        if orig is not None:
            orig(event)

    def _fade_allowed(self):
        # 输入框有焦点 = 用户正在打字，保持实体不淡出
        return not self.input.hasFocus()

    def showEvent(self, event):
        super().showEvent(event)
        self._reset_fade_on_show()
        self.input.setFocus()

    def hideEvent(self, event):
        super().hideEvent(event)
        self._cancel_fade()
        try:
            self.ball._set_fusion_panel_state("none")
        except Exception:
            pass

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #askFlowerDialog {{
                background: transparent; border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#menuTitle {{ font-size: 14px; font-weight: 700; color: {c['accent_deep']}; }}
            QLabel#menuSub {{ font-size: 10px; color: {c['sub']}; padding-bottom: 2px; }}
            QLineEdit#askFlowerInput {{
                min-height: 30px; padding: 0 10px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 9px; font-size: 12px;
            }}
            QLineEdit#askFlowerInput:focus {{ border-color: {c['accent']}; }}
            QScrollArea#askFlowerAnswerScroll {{ background: transparent; border: none; }}
            QScrollArea#askFlowerAnswerScroll > QWidget > QWidget {{ background: transparent; }}
            QScrollBar:vertical {{
                width: 8px; background: transparent; margin: 3px 0;
            }}
            QScrollBar::handle:vertical {{
                min-height: 26px; background: #c9dfd3; border-radius: 4px;
            }}
            QScrollBar::handle:vertical:hover {{ background: {c['accent']}; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
            QLabel#askFlowerAnswer {{
                background: {c['surface']}; color: {c['ink']};
                border: 1px solid {c['border']}; border-radius: 9px;
                padding: 8px 10px; font-size: 12px;
            }}
            QPushButton {{ min-height: 28px; border-radius: 9px; font-size: 11px; }}
            QPushButton#askFlowerCancel {{
                color: {c['sub']}; background: transparent; border: 1px solid {c['border']};
            }}
            QPushButton#askFlowerCancel:hover {{ background: {c['surface_alt']}; }}
            QPushButton#askFlowerSend {{
                color: {c['panel']}; background: {c['accent_deep']}; border: none; font-weight: 700;
            }}
            QPushButton#askFlowerSend:hover {{ background: {c['accent']}; }}
            QPushButton#askFlowerSend:disabled {{ background: {c['border']}; }}
        """)

    def show_near_ball(self):
        self.apply_theme()
        self.adjustSize()
        ball = self.ball
        screen = ball.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        x, y, side = position_popup_left_first(
            (ball.x(), ball.y(), ball.width(), ball.height()),
            (self.width(), self.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            gap=8,
            anchor_ratio=PANEL_ANCHOR_RATIO,
        )
        self.side = side
        self._user_dragged = False
        self.move(x, y)
        self.show()
        self.raise_()
        self.input.setFocus()

    def _reanchor(self):
        """回答区撑高后重新定位：没拖过按球锚定，拖过保持原位不跳。"""
        self.adjustSize()
        if self._user_dragged:
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry()
            x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
            y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
            self.move(x, y)
        else:
            self.show_near_ball()

    # ── 双窗拖动：按住空白处，面板与花朵保持相对距离一起动（与朗读弹窗一致） ──
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_press = e.globalPosition().toPoint()
            self._drag_panel_start = self.pos()
            self._drag_ball_start = self.ball.pos()
            self._drag_moved = False
            reset_motion = getattr(self.ball, "_reset_drag_motion", None)
            if callable(reset_motion):
                reset_motion()
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._drag_press is not None and (e.buttons() & Qt.MouseButton.LeftButton):
            cur = e.globalPosition().toPoint()
            delta = cur - self._drag_press
            if not self._drag_moved:
                if delta.manhattanLength() < QApplication.startDragDistance():
                    return
                self._drag_moved = True
                self._user_dragged = True
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry()
            dx = max(geo.left() - self._drag_panel_start.x(), min(delta.x(), geo.right() - self.width() + 1 - self._drag_panel_start.x()))
            dy = max(geo.top() - self._drag_panel_start.y(), min(delta.y(), geo.bottom() - self.height() + 1 - self._drag_panel_start.y()))
            self.move(self._drag_panel_start + QPoint(dx, dy))
            self.ball.move(self._drag_ball_start + QPoint(dx, dy))
            record_motion = getattr(self.ball, "_record_drag_motion", None)
            if callable(record_motion):
                record_motion()
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._drag_moved:
                release_motion = getattr(self.ball, "_release_drag_motion", None)
                if callable(release_motion):
                    release_motion()
                try:
                    self.ball._save_pos()
                except Exception:
                    pass
            self._drag_press = None
            self._drag_panel_start = None
            self._drag_ball_start = None
        super().mouseReleaseEvent(e)

    def _set_busy(self, busy):
        self.btn_send.setEnabled(not busy)
        self.btn_cancel.setEnabled(not busy)
        self.input.setEnabled(not busy)

    def _send(self):
        text = self.input.text().strip()
        if not text:
            self.lbl_status.setText("写点什么再问嘛～")
            self.lbl_status.show()
            return
        self._set_busy(True)
        # 提交新问题时先清掉上一次的答案：思考中只留「正在想答案…」，
        # 否则旧答案挂在上面，第一眼分不清第二个问题到底答了没
        self.answer_body.clear()
        self.answer_scroll.hide()
        self.lbl_status.setText("小花正在想答案…")
        self.lbl_status.show()
        self.adjustSize()
        self._reanchor()

        state = {"result": None, "done": False}

        def run():
            try:
                state["result"] = api_post("/ask-flower", {"text": text}, timeout=35)
            except urllib.error.HTTPError as e:
                # 读响应体里的 error 字段，把真实原因透出来（比「HTTP Error 400」有用得多）
                body = ""
                try:
                    body = e.read().decode("utf-8", "replace")
                except Exception:
                    body = ""
                detail = ""
                try:
                    parsed = json.loads(body)
                    detail = parsed.get("error") or ""
                except Exception:
                    detail = body[:120]
                state["result"] = {"ok": False, "error": detail or f"小花拒绝了（{e}）"}
            except Exception as e:
                state["result"] = {"ok": False, "error": f"连不上小花（{e}），看看传音樱还开着没"}
            state["done"] = True

        threading.Thread(target=run, daemon=True, name="ask-flower-worker").start()
        timer = QTimer(self)
        timer.setInterval(150)

        def tick():
            if not state["done"]:
                return
            timer.stop()
            self._set_busy(False)
            result = state["result"] or {}
            if result.get("ok"):
                # 就地显示回答，不关弹窗：看完可以继续问下一个
                answer = result.get("answer") or ""
                self.answer_body.setText(answer)
                self.answer_scroll.show()
                self.lbl_status.setText("")
                self.lbl_status.hide()
                self.input.clear()
                self.input.setFocus()
                self.adjustSize()
                self._reanchor()
            else:
                self.lbl_status.setText(result.get("error") or "发送失败，再试一次")
                self.lbl_status.setStyleSheet("")
                self.lbl_status.show()

        timer.timeout.connect(tick)
        timer.start()

    def paintEvent(self, event):
        super().paintEvent(event)
        c = THEME_COLORS[self.ball.theme_mode]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor(c["border"]))
        painter.setBrush(QColor(c["panel"]))
        painter.drawRoundedRect(self.rect().adjusted(1, 1, -1, -1), 16, 16)
        painter.end()


# ─────────────────────────────
#  推荐目标选择浮签（面板右上角下拉）
# ─────────────────────────────
class TargetMenu(QFrame):
    """最近对话（默认）/ 固定指定会话。
    数据来自代理 /sessions；选择通过 /pin 写入，重启后仍保持。"""

    sessions_ready = pyqtSignal(object)

    def __init__(self, panel):
        super().__init__(panel)
        self.panel = panel
        self.ball = panel.ball
        self.sessions = []
        self.loading_sessions = False
        self.sessions_error = ""
        self._request_seq = 0
        self.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
        self.sessions_ready.connect(self._apply_sessions)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("targetMenu")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 11, 12, 11)
        root.setSpacing(6)

        title = QLabel(getattr(self.panel, "target_menu_title", "推荐回复参考哪段对话？"))
        title.setObjectName("menuTitle")
        root.addWidget(title)

        mode_row = QHBoxLayout()
        mode_row.setSpacing(6)
        self.btn_auto = QPushButton("跟随最近")
        self.btn_auto.setObjectName("modeChoice")
        self.btn_auto.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_auto.clicked.connect(self._pick_auto)
        mode_row.addWidget(self.btn_auto)
        self.btn_fixed = QPushButton("自己选择")
        self.btn_fixed.setObjectName("modeChoice")
        self.btn_fixed.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_fixed.clicked.connect(self._show_fixed)
        mode_row.addWidget(self.btn_fixed)
        root.addLayout(mode_row)

        self.lbl_mode_hint = QLabel("")
        self.lbl_mode_hint.setObjectName("menuSub")
        self.lbl_mode_hint.setWordWrap(True)
        root.addWidget(self.lbl_mode_hint)

        self.list_host = QWidget(self)
        self.list_host.setObjectName("targetListHost")
        self.list_box = QVBoxLayout(self.list_host)
        self.list_box.setContentsMargins(0, 0, 0, 0)
        self.list_box.setSpacing(5)
        root.addWidget(self.list_host)
        self.apply_theme()

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #targetMenu {{ background: transparent; border: none; font-family: "LXGW WenKai", "Microsoft YaHei UI"; }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#menuTitle {{ font-size: 13px; font-weight: 700; color: {c['accent_deep']}; }}
            QLabel#menuSub {{ font-size: 10px; color: {c['sub']}; padding-bottom: 2px; }}
            QPushButton#modeChoice {{
                min-height: 32px; padding: 0 10px;
                color: {c['sub']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px; font-size: 12px;
            }}
            QPushButton#modeChoice:hover {{ color: {c['accent_deep']}; background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QPushButton#modeChoice[active="true"] {{
                color: {c['accent_text']}; background: {c['accent']};
                border-color: {c['accent']}; font-weight: 600;
            }}
            QWidget#targetListHost {{ background: transparent; border: none; }}
            QPushButton#sessionItem {{
                min-height: 30px; max-height: 30px; text-align: left; padding: 0 9px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px; font-size: 11px;
            }}
            QPushButton#sessionItem:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QPushButton#sessionItem[active="true"] {{
                color: {c['accent_deep']}; border-color: {c['accent']};
                background: {c['surface_alt']};
            }}
        """)
        self._sync_ui()

    def _clear_list(self):
        while self.list_box.count():
            item = self.list_box.takeAt(0)
            w = item.widget()
            if w:
                # 先藏再删：deleteLater 得等事件循环回收，中间那一瞬旧行还会浮在原位。
                w.hide()
                w.deleteLater()

    def _sync_ui(self):
        auto_on = self.view_mode == "auto"
        self.btn_auto.setProperty("active", "true" if auto_on else "false")
        self.btn_fixed.setProperty("active", "false" if auto_on else "true")
        self.btn_auto.style().unpolish(self.btn_auto)
        self.btn_auto.style().polish(self.btn_auto)
        self.btn_fixed.style().unpolish(self.btn_fixed)
        self.btn_fixed.style().polish(self.btn_fixed)
        self.lbl_mode_hint.setText(
            "跟随最近活跃的对话" if auto_on
            else "从下面最近活跃的 5 个对话中固定一个"
        )
        self.list_host.setVisible(not auto_on)
        self._clear_list()

        def add(widget):
            # 新建的子控件默认是隐藏的，要等布局跑一轮才显形；加进去后立即 show()，
            # 后面量高度时不会把它当成“没有这一行”。
            self.list_box.addWidget(widget)
            widget.show()
            return widget

        if self.loading_sessions:
            lbl = QLabel("正在读取对话列表…")
            lbl.setObjectName("menuSub")
            lbl.setStyleSheet(f"color: {THEME_COLORS[self.ball.theme_mode]['sub']}; font-size: 11px;")
            add(lbl)
            return
        if self.sessions_error:
            lbl = QLabel(self.sessions_error)
            lbl.setObjectName("menuSub")
            lbl.setWordWrap(True)
            lbl.setStyleSheet(f"color: {THEME_COLORS[self.ball.theme_mode]['sub']}; font-size: 11px;")
            add(lbl)
            retry = QPushButton("↻ 重新读取")
            retry.setObjectName("sessionItem")
            retry.setCursor(Qt.CursorShape.PointingHandCursor)
            retry.clicked.connect(lambda checked=False: self.refresh_sessions_async())
            add(retry)
            return
        if not self.sessions:
            lbl = QLabel("还没读取到可选对话")
            lbl.setObjectName("menuSub")
            lbl.setStyleSheet(f"color: {THEME_COLORS[self.ball.theme_mode]['sub']}; font-size: 11px;")
            add(lbl)
            return
        for s in self.sessions:
            title = (s.get("title") or "未命名对话").strip()
            # 旧链路给 lastUserTime，App 桥快照给 modified（毫秒）；两个都认。
            ts = s.get("lastUserTime") or s.get("modified") or 0
            when = time.strftime("%H:%M", time.localtime(ts / 1000)) if ts else ""
            btn = QPushButton()
            btn.setObjectName("sessionItem")
            # QSS 的 min-height 只管样式，布局一样能把它压矮；这里钉死行高，
            # 才能保证“五段对话就占五行”（2026-10-19：候选被压成一条条）。
            btn.setFixedHeight(30)
            # 跨助手混排，不再另起助手分类；列表只呈现对话标题和最近时间。
            btn.setText(btn.fontMetrics().elidedText(title, Qt.TextElideMode.ElideRight, 246))
            btn.setToolTip(f"{title}\n{when}" if when else title)
            btn.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            pinned = self.ball.pinned_target or {}
            # 固定标记按会话编号比（App 桥快照给的是 sessionId；旧链路带 sessionPath）。
            is_active = bool(pinned) and (
                (pinned.get("sessionId") and pinned.get("sessionId") == s.get("sessionId"))
                or (pinned.get("sessionPath") and pinned.get("sessionPath") == s.get("sessionPath"))
            )
            btn.setProperty("active", "true" if is_active else "false")
            btn.clicked.connect(lambda checked=False, s=s: self._pick(s))
            add(btn)
        self.list_box.addStretch(1)

    def _show_fixed(self):
        self.view_mode = "pinned"
        self._sync_ui()
        self.panel._resize_after_target_change()

    def set_candidates(self, sessions):
        """App 模式：由桥轮询推来的候选列表更新本地缓存（只存显示字段）。"""
        rows = [s for s in (sessions or []) if isinstance(s, dict) and s.get("sessionId")][:TARGET_SESSION_LIMIT]
        # 桥每 1.5 秒推一次，内容没变就别重建：以前每轮都 _clear_list() 再加回全部按钮，
        # 用户正在看的那条的 hover、键盘焦点、滚动位置全丢，还可能闪一帧。
        sig = tuple((str(s.get("sessionId") or ""), str(s.get("title") or ""), s.get("modified") or 0) for s in rows)
        if sig == getattr(self, "_candidates_sig", None):
            return
        self._candidates_sig = sig
        self.sessions = rows
        self.loading_sessions = False
        self.sessions_error = ""
        if self.isVisible():
            self.apply_theme()

    def render_from_cache(self):
        # 子弹窗里的 TargetMenu 可能还没被分发过；没数据就从球上那份取。
        if not self.sessions and self.ball is not None:
            cached = getattr(self.ball, "_recommend_candidates", None)
            if cached:
                self.set_candidates(cached)
        self.loading_sessions = False
        self.apply_theme()

    def _request_recommend(self, kind, session_id=""):
        """把请求转给拥有这条链路的面板。

        request_recommend 只定义在主面板（ZhujianMenu）上，而 TargetMenu 在
        朗读窗、润色窗里也各有一个实例。以前它们直接 self.panel.request_recommend(...)，
        在子弹窗里点一下就是 AttributeError——而且界面已经先弹了「已固定这段对话」，
        说的全是假的。这里改成回落到球的主面板。
        """
        requester = getattr(self.panel, "request_recommend", None)
        if not callable(requester):
            menu = getattr(self.ball, "menu", None)
            requester = getattr(menu, "request_recommend", None)
        if callable(requester):
            requester(kind, session_id)
            self._refresh_bubble_panels()
            return True
        return False

    def _refresh_bubble_panels(self):
        """切完目标，把二级弹窗也带上。

        朗读窗、润色窗各有自己的目标行，而它们以前只在开窗时打一次旧插件的
        /target（App 桥没有这条路由），所以球上目标变了，弹窗里那一行纹丝不动，
        看着就是“点了没反应”。这里直接拿球上已经更新的目标状态重绘。
        """
        for attr in ("read_panel", "polish_panel"):
            panel = getattr(self.ball, attr, None)
            updater = getattr(panel, "_update_target", None) if panel is not None else None
            if callable(updater):
                updater()
        # 朗读窗的回复列表按目标会话拉：App 侧推过之后有 60 秒缓存，不敲一下不会重推。
        # 以前这里另开线程 poke 一个 forcePush 信号，而 refresh 自己也 GET 同一个接口，
        # 两边抢着读，信号常常被吃掉（2026-10-22 实机：切了窗口还是旧列表）。
        # 现在 refresh 自己带 forcePush，不必再 poke。
        read_panel = getattr(self.ball, "read_panel", None)
        if read_panel is not None and read_panel.isVisible():
            refresh = getattr(read_panel, "refresh_replies_async", None)
            if callable(refresh):
                # reset_read：切了目标就把文字区也清掉。不带这个参数的话，
                # 文字区会留着上一段对话的预览，看着就像“切了窗口还是旧文字”。
                refresh(reset_read=True)

    def _pick_auto(self):
        if APP_ONLY_ASK:
            _panel_diag("pick_auto", panel=type(self.panel).__name__, mode=self.view_mode)
            # App 模式：不乐观改 ball 的目标状态，等 App 推回的快照为准（避免写盘失败后界面说谎）。
            # 但浮签自己的视图状态得立刻切回来：旧版这条路径会置 view_mode、重绘、再收起浮签
            # （旧源码 2240~2246 行）。少了这两步，按完「跟随最近」按钮还停在「自己选择」、
            # 列表也照旧摊在面板里。
            self.view_mode = "auto"
            # 跟固定一样：先就地清掉固定标记让按钮立刻变「跟随最近」，
            # 具体是哪段对话等推送回来填（不清标题会残留上一段的名字，更迷惑）。
            self.ball.target_mode = "auto"
            self.ball.pinned_target = None
            self.ball.target_title = ""
            self.ball.target_name = ""
            self.apply_theme()
            self.panel._flash("已改为跟随最近活跃的对话")
            self.panel._set_target_selector_visible(False)
            self._request_recommend("auto")
            return
        self._request_seq += 1
        self.panel.invalidate_target_sync()
        self.ball.target_revision = getattr(self.ball, "target_revision", 0) + 1
        try:
            result = api_post("/pin", {}, timeout=5)
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or "切换失败")
        except Exception:
            self.lbl_mode_hint.setText("切换失败，稍后再试")
            self.panel._flash("切换失败，原来的选择没有改变")
            return
        self.view_mode = "auto"
        self.ball.target_mode = "auto"
        self.ball.pinned_target = None
        self.ball.target_name = ""
        self.ball.target_title = ""
        self.panel._update_target()
        self.panel._flash("已改为跟随最近活跃的对话 ✓")
        self.panel._set_target_selector_visible(False)
        on_target_changed = getattr(self.panel, "_on_target_changed", None)
        if callable(on_target_changed):
            on_target_changed()
        else:
            self.panel._sync_target_state()

    def _pick(self, s):
        if APP_ONLY_ASK:
            session_id = s.get("sessionId") or ""
            _panel_diag("pick", panel=type(self.panel).__name__, sessionId=session_id, title=str(s.get("title") or ""), mode=self.view_mode)
            if not session_id:
                self.panel._flash("这段对话没有可用的编号，换一段试试")
                return
            # 先就地改一次显示：慢速轮询最多要两秒才拿到新快照，不这样点完得干等，
            # 用户以为没点上就再点一次（实测就是这样）。推送回来会再校准。
            self.ball.target_mode = "pinned"
            self.ball.target_name = s.get("agentName") or s.get("agentId") or ""
            self.ball.target_title = s.get("title") or ""
            self.ball.target_session_id = session_id
            self.ball.pinned_target = {"sessionId": session_id, "title": s.get("title") or ""}
            self.view_mode = "pinned"
            self.panel._flash("已固定这段对话")
            # 选完就收起：列表已经占掉半张面板，留着只会挡住推荐区。
            # 目标行按钮本身还在，想换随时点它再展开。
            self.panel._set_target_selector_visible(False)
            self._request_recommend("pin", session_id)
            return
        self._request_seq += 1
        self.panel.invalidate_target_sync()
        self.ball.target_revision = getattr(self.ball, "target_revision", 0) + 1
        try:
            result = api_post("/pin", {
                "sessionPath": s.get("sessionPath") or "",
                "agentId": s.get("agentId") or "",
                "title": s.get("title") or "",
            }, timeout=5)
            if not result.get("ok"):
                raise RuntimeError(result.get("error") or "固定失败")
        except Exception:
            self.lbl_mode_hint.setText("固定失败，原来的选择没有改变")
            self.panel._flash("固定失败，原来的选择没有改变")
            return
        self.view_mode = "pinned"
        self.ball.target_mode = "pinned"
        self.ball.pinned_target = {
            "sessionPath": s.get("sessionPath") or "",
            "title": s.get("title") or "",
            "agentId": s.get("agentId") or "",
            "agentName": s.get("agentName") or s.get("agentId") or "",
        }
        self.ball.target_name = s.get("agentName") or s.get("agentId") or ""
        self.ball.target_title = s.get("title") or ""
        self.panel._update_target()
        self.panel._flash("已固定这段对话 ✓")
        self.panel._set_target_selector_visible(False)
        on_target_changed = getattr(self.panel, "_on_target_changed", None)
        if callable(on_target_changed):
            on_target_changed()

    def refresh_sessions_async(self):
        self._request_seq += 1
        request_seq = self._request_seq
        target_revision = getattr(self.ball, "target_revision", 0)
        self.loading_sessions = True
        self.sessions_error = ""
        self._sync_ui()

        def worker():
            payload = {"seq": request_seq, "target_revision": target_revision, "sessions": [], "mode": self.ball.target_mode, "pinned": self.ball.pinned_target, "error": "读取失败，可以重新读取"}
            try:
                data = api_get("/sessions", timeout=5)
                if data.get("ok"):
                    payload = {
                        "seq": request_seq,
                        "target_revision": target_revision,
                        "sessions": data.get("sessions") or [],
                        "mode": "pinned" if data.get("mode") == "pinned" else "auto",
                        "pinned": data.get("pinned"),
                        "error": "",
                    }
            except Exception:
                pass
            try:
                self.sessions_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-targetlist").start()

    def _apply_sessions(self, payload):
        if payload.get("seq") != self._request_seq:
            return
        self.loading_sessions = False
        self.sessions_error = payload.get("error") or ""
        self.sessions = (payload.get("sessions") or [])[:TARGET_SESSION_LIMIT]
        target_state_current = payload.get("target_revision", getattr(self.ball, "target_revision", 0)) == getattr(self.ball, "target_revision", 0)
        if target_state_current:
            self.ball.target_mode = payload.get("mode") or "auto"
            self.ball.pinned_target = payload.get("pinned")
            if self.ball.target_mode == "pinned" and self.ball.pinned_target:
                pinned = self.ball.pinned_target
                self.ball.target_name = pinned.get("agentName") or pinned.get("name") or pinned.get("agentId") or self.ball.target_name
                self.ball.target_title = pinned.get("title") or self.ball.target_title
            self.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
        self.apply_theme()
        self.panel._update_target()
        self.panel._resize_after_target_change()

    def paintEvent(self, event):
        super().paintEvent(event)
        c = THEME_COLORS[self.ball.theme_mode]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setPen(QColor(c["border"]))
        painter.setBrush(QColor(c["panel"]))
        painter.drawRoundedRect(self.rect().adjusted(1, 1, -1, -1), 16, 16)
        painter.end()


# ─────────────────────────────
#  传音樱
# ─────────────────────────────
class ZhujianBall(QWidget):
    ask_ready = pyqtSignal(object)
    speak_ready = pyqtSignal(object)

    def __init__(self):
        super().__init__(None)
        self._closed = False
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setFixedSize(BALL_SIZE, BALL_SIZE)

        # 新版以透明底樱花枝条插画为整体主视觉；SVG 零件保留作资源缺失时的旧版回退。
        self.pix_sprig = QPixmap(os.path.join(HERE, "zhiyi-sakura-sprig.png"))
        self.sprig_ready = not self.pix_sprig.isNull()
        self.pix_branch = self._render_svg_to_pixmap("yinghua-branch.svg", RENDER_SIZE)
        self.pix_flower = self._render_svg_to_pixmap("yinghua-ball.svg", RENDER_SIZE)
        self.pix_leaf = self._render_svg_to_pixmap("yinghua-leaf.svg", RENDER_SIZE)
        self.layered_flower_ready = all(
            not pix.isNull() for pix in (self.pix_branch, self.pix_flower, self.pix_leaf)
        )
        if not self.layered_flower_ready:
            print("[落樱] 花枝/花朵/叶片资源渲染失败", file=sys.stderr)

        self._speak_player = None
        self._speak_out = None
        self._speak_seq = 0
        self._speak_timer = None
        self._speak_inflight = False
        self.speak_ready.connect(self._play_speak_job)
        self.state = load_state()
        # 只记录当前运行中的面板，进程重启后不把旧的打开状态冒充成可继承状态。
        self.state["fusionPanel"] = "none"
        save_state(self.state)
        self.action = self.state.get("action") or "copy"
        # 可选入口默认先隐藏；首次配置同步成功后再显示，配置读取失败时不误开放。
        self.ask_flower_enabled = False
        self.cached = None
        self.target_name = ""
        self.target_title = ""
        # 当前读取的那段对话的编号。固定时来自固定目标，跟随最近时来自 App 推回的推荐状态。
        # 起标题要指定改哪一段，就是这个字段。
        self.target_session_id = ""
        self.target_mode = "auto"    # auto=跟随最近 / pinned=固定指定会话
        self.target_revision = 0      # 跨主面板/朗读窗共享，丢弃旧目标状态回包
        self.pinned_target = None    # {sessionPath, agentId, title} 或 None
        self.theme_mode = read_hana_theme_mode()
        self.context_menu = None

        # 微风物理：花朵会随来风方向轻摆，移开后慢慢停稳
        self.angle = 0.0
        self.angular_velocity = 0.0
        self.hover_wind = 0.0
        self.gust = 0.0
        self.gust_direction = 1.0
        self.hover_strength = 1.0
        self.cursor_wind = 0.0
        self.cursor_lift = 0.0
        self.cursor_velocity = (0.0, 0.0)
        self.bloom = 0.0
        # 拖动时根部、花冠、叶片与纵向位移各有独立重量；释放后保留速度回弹。
        self.drag_branch_angle = 0.0
        self.drag_branch_velocity = 0.0
        self.drag_flower_angle = 0.0
        self.drag_flower_velocity = 0.0
        self.drag_leaf_angle = 0.0
        self.drag_leaf_velocity = 0.0
        self.drag_vertical = 0.0
        self.drag_vertical_velocity = 0.0

        # 三态
        self.mode = "rolled"
        self.hovered = False
        self._hover_exit_elapsed = 0.0

        # 按压弹簧 + 细碎花瓣。press_amount: 0=原位，1=压下，负值=松手后越界回弹。
        self.pressed = False
        self.press_amount = 0.0
        self.press_velocity = 0.0
        self.petal_particles = []
        self._petal_rng = random.Random()
        self._hover_petal_timer = self._petal_rng.uniform(*HOVER_PETAL_INTERVAL)
        self._sweep_petal_cooldown = 0.0
        # 提问挂起时持续散发细小花瓣（点击花朵同款放射簇，低密度）
        self._ask_emitting = False
        self._ask_petal_timer = 0.0
        self._ask_bounce_timer = 0.0

        # 总时长与光标轨迹
        self.t = 0.0
        self._last_ts = time.monotonic()
        cursor = QCursor.pos()
        self._cursor_sample = (cursor.x(), cursor.y(), self._last_ts)
        self._drag_motion_active = False
        self._drag_sample_x = 0.0
        self._drag_sample_y = 0.0
        self._drag_sample_ts = self._last_ts
        self._drag_velocity_x = 0.0
        self._drag_velocity_y = 0.0
        self._drag_motion_last_ts = self._last_ts

        # 交互
        self._drag = None
        self._press_global = None
        self._moved = False
        self._drag_menu_was_visible = False
        self._drag_read_was_visible = False
        self._drag_ask_was_visible = False
        self._drag_polish_was_visible = False
        self._drag_queue_was_visible = False
        self._drag_compaction_was_visible = False
        self._drag_menu_start = None
        self._drag_read_start = None
        self._drag_ask_start = None
        self._drag_polish_start = None
        self._drag_queue_start = None
        self._drag_compaction_start = None
        self._drag_ball_start = None
        self.menu = None
        self._recommend_candidates = []   # 桥推来的最近对话；主面板与子弹窗共用这一份
        self.read_panel = None        # 独立朗读窗口（由主面板「念给我听」打开）
        self.ask_flower_dialog = None  # 「问问小花」输入弹窗（右键浮签打开，懒创建）
        self.polish_panel = None      # 「把话理顺」弹窗（由主面板「理顺」打开，二级）
        self.queue_panel = None       # 「排队发送」弹窗（由主面板「排队」打开，二级）
        self.compaction_panel = None  # 「压缩档案」弹窗（由主面板打开，二级；只读）
        self._ask_poll_inflight = False
        self.ask_ready.connect(self._apply_ask_payload)
        # 右键浮签不再是 Popup（Popup 会抢在 toggle 前自动关闭，无法实现"再按一次右键收起"），
        # 由这里统一接管「点击外部关闭」：监听所有窗口的鼠标按下
        QApplication.instance().installEventFilter(self)

        self.ask_poll_timer = QTimer(self)
        self.ask_poll_timer.timeout.connect(self._poll_ask_async)
        self.ask_poll_timer.start(ASK_POLL_INTERVAL_MS)

        self.tick_timer = QTimer(self)
        self.tick_timer.timeout.connect(self._tick)
        self.tick_timer.start(16)

        self.theme_timer = QTimer(self)
        self.theme_timer.timeout.connect(self._sync_theme)
        self.theme_timer.start(1500)

        self._place_from_state()

    def set_recommend_candidates(self, candidates):
        """球级存一份最近对话，并分发给所有已经建出来的候选浮签。

        以前只有主面板自己的 TargetMenu 有人喂；朗读窗、润色窗里各有一个
        TargetMenu 实例，没有任何数据源，点开就只会看到「读取失败」或空列表。
        """
        rows = [c for c in (candidates or []) if isinstance(c, dict)]
        self._recommend_candidates = rows
        menus = []
        if self.menu is not None:
            menus.append(self.menu.target_menu)
        for panel in (self.read_panel, self.polish_panel, self.compaction_panel, self.queue_panel):
            if panel is not None:
                menus.append(getattr(panel, "target_menu", None))
        for target_menu in menus:
            if target_menu is not None:
                target_menu.set_candidates(rows)

    def closeEvent(self, event):
        # 关闭传音樱时先解除全局过滤器并停掉自身定时器；知意模式随后退出整个辅助进程。
        self._closed = True
        app = QApplication.instance()
        if app is not None:
            try:
                app.removeEventFilter(self)
            except RuntimeError:
                pass
        for timer in self.findChildren(QTimer):
            try:
                timer.stop()
            except RuntimeError:
                pass
        # 续接小条轮询的 QTimer 挂在菜单（顶层窗，不是球的子控件）上，
        # findChildren 找不到它，退出时单独停一下，别让线程池里还留着定时器。
        if self.menu is not None:
            try:
                self.menu.stop_resume_polling()
                self.menu.stop_recommend_polling()
                self.menu.stop_sleep_polling()
            except RuntimeError:
                pass
        super().closeEvent(event)
        if APP_ONLY_ASK and app is not None:
            QTimer.singleShot(0, app.quit)

    # ── 提问轮询：网络在线程，界面回主线程 ──
    def _poll_ask_async(self):
        if self._ask_poll_inflight:
            return
        self._ask_poll_inflight = True

        def worker():
            payload = {
                "ok": False,
                "pending": [],
                "resume": [],
                "resumeAuto": False,
                "resumeNotices": [],
                "ask_flower_enabled": None,
                "resumeState": None,
            }
            # 配置与提问共用本地代理轮询：设置页改完后无需重启即可同步到面板。
            try:
                config = api_get("/config", timeout=4)
                if config.get("ok"):
                    ask_config = config.get("config") or {}
                    ask_flower = ask_config.get("askFlower") or {}
                    payload["ask_flower_enabled"] = ask_flower.get("enabled") is True
            except Exception:
                pass
            try:
                data = api_get("/ask/pending", timeout=4)
                if data.get("ok"):
                    payload.update({
                        "ok": True,
                        "pending": data.get("pending") or [],
                        "resume": data.get("resume") or [],
                        "resumeAuto": bool(data.get("resumeAuto")),
                        "resumeNotices": data.get("resumeNotices") or [],
                    })
            except Exception:
                pass
            # 断联续接另走 /resume/state。以前只有面板 showEvent 才起这个轮询，
            # 于是球刚起来、用户还没手动点开过面板时，桥上已有的提醒一次都拉不到，
            # 提醒直接丢。旧版是搭提问轮询的便车，不存在这个冷启动缺口。
            try:
                resume_state = api_get("/resume/state", timeout=4)
                if resume_state.get("ok"):
                    payload["resumeState"] = resume_state
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.ask_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-ask-poll").start()

    # ── 回复行朗读：App 合成完把文件路径放桥上，球轮询到就自己放 ──
    # 为什么不靠宿主：Electron 里 `new Audio(...).play()` 会被自动播放策略静默拦掉，
    # 前端还把错误 catch 掉了，表现就是「点了没声音」。球的 QMediaPlayer 不受那条限制。
    def start_speak_polling(self):
        if not APP_ONLY_ASK or self._closed:
            return
        if self._speak_timer is None:
            self._speak_timer = QTimer(self)
            self._speak_timer.timeout.connect(self._poll_speak_async)
        self._speak_timer.start(1000)
        self._poll_speak_async()

    def _poll_speak_async(self):
        if self._speak_inflight or self._closed:
            return
        self._speak_inflight = True

        def worker():
            payload = None
            try:
                payload = api_get("/voice/play", timeout=3)
            except Exception:
                payload = None
            self._speak_inflight = False
            if self._closed:
                return
            try:
                self.speak_ready.emit(payload or {"ok": False})
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhiyi-speak-poll").start()

    def _ensure_speak_player(self):
        if self._speak_player is not None:
            return
        self._speak_player = QMediaPlayer(self)
        self._speak_out = QAudioOutput(self)
        self._speak_out.setVolume(1.0)
        self._speak_player.setAudioOutput(self._speak_out)

    def _play_speak_job(self, payload):
        if not isinstance(payload, dict) or not payload.get("ok"):
            return
        seq = int(payload.get("seq") or 0)
        job = payload.get("play") or {}
        if seq <= self._speak_seq:
            return
        self._speak_seq = seq
        target = str(job.get("path") or "")
        if not target or not os.path.exists(target):
            return
        try:
            self._ensure_speak_player()
            self._speak_player.setSource(QUrl.fromLocalFile(target))
            self._speak_player.play()
        except Exception as e:
            print(f"[朗读] 播放失败：{e}", file=sys.stderr)

    def _apply_ask_payload(self, payload):
        self._ask_poll_inflight = False
        if payload.get("ask_flower_enabled") is not None:
            self._apply_ask_flower_config(payload["ask_flower_enabled"])
        # 冷启动兼底：桥上有提醒就把面板叫出来，并把它自己的续接轮询接上。
        # 接上之后仍走菜单的指纹去重，重复应用是空操作。
        resume_state = payload.get("resumeState")
        if isinstance(resume_state, dict) and resume_state.get("ok"):
            if isinstance(resume_state.get("notice"), dict) or resume_state.get("flash"):
                if self.menu is None:
                    self.menu = ZhujianMenu(self)
                self.menu.start_resume_polling()
                self.menu._apply_resume_state(resume_state)
        if not payload.get("ok"):
            return
        # 自动续接成功的短暂提示（面板可见时显示）
        notices = payload.get("resumeNotices") or []
        if notices and self.menu is not None and self.menu.isVisible():
            self.menu.show_resume_notice(notices[-1])
        ask = latest_ask_pending(payload.get("pending"))
        if ask is not None:
            if self.menu is None:
                self.menu = ZhujianMenu(self)
            # 面板暂时收起不等于问题已放弃：同一个 ask 仍保留在内存里。
            # 但用户既然主动收起了，就不要被轮询自动重新打回脸上；手动点花朵时再展开原题。
            if (
                self.menu.is_ask_open()
                and self.menu._ask_user_hidden
                and ask.get("askId") == self.menu._ask_entry.get("askId")
            ):
                return
            if not self.menu.isVisible():
                # 已经在提问态时只重新显示原面板，不能先 prepare_for_show 把提问替换成推荐。
                # 互斥：自动弹面板前也先收右键浮签、朗读窗与润色窗，保证不并存
                if self.context_menu is not None:
                    self.context_menu.close()
                if self.read_panel is not None and self.read_panel.isVisible():
                    self.read_panel.close()
                if self.polish_panel is not None and self.polish_panel.isVisible():
                    self.polish_panel.close()
                if self.queue_panel is not None and self.queue_panel.isVisible():
                    self.queue_panel.close()
                if self.compaction_panel is not None and self.compaction_panel.isVisible():
                    self.compaction_panel.close()
                if not self.menu.is_ask_open():
                    self.menu.prepare_for_show()
                self.menu.move_to_ball()
                self.menu.show()
                self.menu.raise_()
                self.menu.activateWindow()
            self.menu.show_ask(ask)
            # 提问态需要持续留在前台供用户作答。
            self.menu.raise_()
            self._set_fusion_panel_state("ask")
            return
        # 断联续接已改走 /resume/state 轮询：/ask/pending 只负责提问，不再从它取续接待办。
        if self.menu is not None and self.menu.is_ask_open():
            # ask 消失（作答完成/隐式跳过/过期）后不弹推荐，直接收起面板回传音樱
            self.menu.finish_ask_and_collapse()

    def _apply_ask_flower_config(self, enabled):
        """把代理返回的可选入口开关同步到主面板与独立问答窗。"""
        enabled = bool(enabled)
        self.ask_flower_enabled = enabled
        if self.menu is not None:
            self.menu.set_ask_flower_enabled(enabled)
        if enabled:
            return
        dialog = self.ask_flower_dialog
        if dialog is not None and dialog.isVisible():
            dialog.close()
            if self.menu is None or not self.menu.is_ask_open():
                self._set_fusion_panel_state("none")

    def _sync_theme(self):
        mode = read_hana_theme_mode()
        if mode == self.theme_mode:
            return
        self.theme_mode = mode
        if self.menu is not None:
            self.menu.apply_theme()
            self.menu.update()
        if self.context_menu is not None:
            self.context_menu.apply_theme()
            self.context_menu.update()
        if self.read_panel is not None:
            self.read_panel.apply_theme()
            self.read_panel.update()
        if self.polish_panel is not None:
            self.polish_panel.apply_theme()
            self.polish_panel.update()
        if self.queue_panel is not None:
            self.queue_panel.apply_theme()
            self.queue_panel.update()
        if self.compaction_panel is not None:
            self.compaction_panel.apply_theme()
            self.compaction_panel.update()

    # ── SVG 渲染 ──
    def _render_svg_to_pixmap(self, name, size):
        path = os.path.join(HERE, name)
        pix = QPixmap(size, size)
        pix.fill(Qt.GlobalColor.transparent)
        try:
            renderer = QSvgRenderer(path)
            if not renderer.isValid():
                return QPixmap()
            painter = QPainter(pix)
            painter.setRenderHint(QPainter.RenderHint.Antialiasing)
            painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
            renderer.render(painter)
            painter.end()
        except Exception as e:
            print(f"[落樱] 渲染 SVG {name} 失败: {e}", file=sys.stderr)
            return QPixmap()
        return pix

    # ── 位置恢复与屏幕安全 ──
    def _place_from_state(self):
        x = self.state.get("x")
        y = self.state.get("y")
        if x is not None and y is not None:
            self.move(int(x), int(y))
        self._ensure_visible(save=True)

    def _ensure_visible(self, save=False):
        center = QPoint(self.x() + self.width() // 2, self.y() + self.height() // 2)
        screen = QApplication.screenAt(center) or QApplication.primaryScreen()
        if screen is None:
            return
        geo = screen.availableGeometry()
        x, y = clamp_position(
            self.x(), self.y(), self.width(), self.height(),
            geo.left(), geo.top(), geo.right(), geo.bottom(),
        )
        if x != self.x() or y != self.y():
            self.move(x, y)
            if save:
                self._save_pos()

    def _save_pos(self):
        pos = self.pos()
        self.state["x"] = pos.x()
        self.state["y"] = pos.y()
        save_state(self.state)

    def _set_fusion_panel_state(self, panel):
        if panel not in {"none", "menu", "ask", "read", "polish", "compaction"}:
            panel = "none"
        if self.state.get("fusionPanel") == panel:
            return
        self.state["fusionPanel"] = panel
        save_state(self.state)

    def _reset_drag_motion(self, now=None):
        now = time.monotonic() if now is None else float(now)
        pos = self.pos()
        self._drag_sample_x = float(pos.x())
        self._drag_sample_y = float(pos.y())
        self._drag_sample_ts = now
        self._drag_velocity_x = 0.0
        self._drag_velocity_y = 0.0
        self._drag_motion_last_ts = now
        self._drag_motion_active = False

    def _apply_drag_impulses(self, delta_vx, delta_vy):
        branch, flower, leaf, vertical = flower_drag_impulses(delta_vx, delta_vy)
        self.drag_branch_velocity += branch
        self.drag_flower_velocity += flower
        self.drag_leaf_velocity += leaf
        self.drag_vertical_velocity += vertical

    def _record_drag_motion(self, position=None, now=None):
        now = time.monotonic() if now is None else float(now)
        position = self.pos() if position is None else position
        vx, vy, dvx, dvy, _speed = sample_drag_velocity(
            self._drag_sample_x,
            self._drag_sample_y,
            self._drag_sample_ts,
            self._drag_velocity_x,
            self._drag_velocity_y,
            position.x(),
            position.y(),
            now,
        )
        self._drag_sample_x = float(position.x())
        self._drag_sample_y = float(position.y())
        self._drag_sample_ts = now
        self._drag_velocity_x = vx
        self._drag_velocity_y = vy
        self._drag_motion_last_ts = now
        self._drag_motion_active = True
        self._apply_drag_impulses(dvx, dvy)

    def _release_drag_motion(self):
        if self._drag_motion_active:
            # 极短 flick 也要留下滞后；急停冲量只抵消一部分起步冲量，剩余交给弹簧自然回正。
            self._apply_drag_impulses(
                -self._drag_velocity_x * 0.30,
                -self._drag_velocity_y * 0.30,
            )
        self._drag_velocity_x *= 0.25
        self._drag_velocity_y *= 0.25
        self._drag_motion_active = False
        self._drag_motion_last_ts = time.monotonic()

    def _decay_drag_motion(self, now, dt):
        fresh = (
            self._drag_motion_active
            and now - self._drag_motion_last_ts <= DRAG_STALE_AFTER
        )
        if fresh:
            return
        decay = math.exp(-dt / DRAG_DECAY_TAU)
        self._drag_velocity_x *= decay
        self._drag_velocity_y *= decay
        if math.hypot(self._drag_velocity_x, self._drag_velocity_y) < 0.5:
            self._drag_velocity_x = 0.0
            self._drag_velocity_y = 0.0

    def _cancel_press_for_drag(self):
        """越过拖动阈值后结束点击蓄力，不把拖拽松手误演成一次完整点击爆瓣。"""
        if not self.pressed:
            return
        self.pressed = False
        self.press_velocity = min(self.press_velocity, -3.4)

    # ── 动画帧 ──
    def _tick(self):
        now = time.monotonic()
        frame_elapsed = max(now - self._last_ts, 0.0)
        dt = min(frame_elapsed, 0.05)
        self._last_ts = now
        self.t += dt
        self._decay_drag_motion(now, dt)
        dragging = bool(
            self._drag_motion_active
            and now - self._drag_motion_last_ts <= 0.18
        )
        (
            drag_branch_target,
            drag_flower_target,
            drag_leaf_target,
            drag_vertical_target,
        ) = flower_drag_targets(self._drag_velocity_x, self._drag_velocity_y)
        self.drag_branch_angle, self.drag_branch_velocity = advance_motion_spring(
            self.drag_branch_angle,
            self.drag_branch_velocity,
            drag_branch_target,
            58.0,
            12.5,
            dt,
            7.5,
        )
        self.drag_flower_angle, self.drag_flower_velocity = advance_motion_spring(
            self.drag_flower_angle,
            self.drag_flower_velocity,
            drag_flower_target,
            40.0,
            8.0,
            dt,
            14.0,
        )
        self.drag_leaf_angle, self.drag_leaf_velocity = advance_motion_spring(
            self.drag_leaf_angle,
            self.drag_leaf_velocity,
            drag_leaf_target,
            30.0,
            6.8,
            dt,
            20.0,
        )
        self.drag_vertical, self.drag_vertical_velocity = advance_motion_spring(
            self.drag_vertical,
            self.drag_vertical_velocity,
            drag_vertical_target,
            52.0,
            11.0,
            dt,
            5.0,
        )

        # 透明异形窗可能漏 enter/leave，每帧读全局光标判定（滞回）
        cursor_global = QCursor.pos()
        cursor = self.mapFromGlobal(cursor_global)
        px, py, pts = self._cursor_sample
        previous_cursor = self.mapFromGlobal(QPoint(int(px), int(py)))
        cursor_hovered, self._hover_exit_elapsed = resolve_hover_state(
            self.hovered, cursor.x(), cursor.y(), self._hover_exit_elapsed, frame_elapsed,
        )
        crossed_visible = segment_crosses_flower_zone(
            previous_cursor.x(), previous_cursor.y(), cursor.x(), cursor.y(),
            HOVER_ENTER_MARGIN,
        )
        if crossed_visible:
            cursor_hovered = True
            self._hover_exit_elapsed = 0.0
        sample_elapsed = now - pts
        sweep_direction, sweep_strength, sweep_speed, sweep_vx, sweep_vy = calculate_cursor_sweep(
            px, py, cursor_global.x(), cursor_global.y(), sample_elapsed,
        )
        entered_now = cursor_hovered and not self.hovered
        if entered_now and not self.pressed and self._drag is None:
            direction, strength = calculate_entry_wind(
                px, py, cursor_global.x(), cursor_global.y(), sample_elapsed,
                self.mapToGlobal(QPoint(BALL_SIZE // 2, BALL_SIZE // 2)).x(),
            )
            self.gust_direction = direction
            self.hover_strength = strength
            self.gust = strength
            self.angular_velocity += 14.0 * direction * strength
            entry_petals = petal_count_from_sweep_speed(sweep_speed)
            entry_petals = 3 if entry_petals <= 0 else min(entry_petals, 7)
            self._spawn_petals(entry_petals, burst=False, wind=(sweep_vx, sweep_vy))
            self._sweep_petal_cooldown = 0.22

        allow_sweep = should_apply_cursor_sweep(
            cursor_hovered, self.pressed, self._drag is not None,
        )
        if allow_sweep and sweep_strength > 0.0:
            self.cursor_velocity = (sweep_vx, sweep_vy)
            target_cursor_wind, target_cursor_lift = cursor_wind_components(
                sweep_vx, sweep_vy, sweep_strength, sweep_direction,
            )
            blend = 1.0 - math.exp(-dt / 0.055)
            self.cursor_wind += (target_cursor_wind - self.cursor_wind) * blend
            self.cursor_lift += (target_cursor_lift - self.cursor_lift) * blend
            self.hover_strength += (sweep_strength - self.hover_strength) * blend
            if abs(self.cursor_wind) >= 0.08:
                self.gust_direction = -1.0 if self.cursor_wind < 0.0 else 1.0
            self.gust = max(self.gust, sweep_strength * 0.58)
            petal_count = petal_count_from_sweep_speed(sweep_speed)
            if petal_count > 0 and self._sweep_petal_cooldown <= 0.0:
                self._spawn_petals(petal_count, burst=False, wind=(sweep_vx, sweep_vy))
                self._sweep_petal_cooldown = 0.24
        else:
            self.cursor_wind *= math.exp(-dt / 0.16)
            self.cursor_lift *= math.exp(-dt / 0.16)
            self.cursor_velocity = (0.0, 0.0)
            resting_strength = (
                0.24
                if cursor_hovered and not self.pressed and not dragging
                else 0.0
            )
            self.hover_strength += (resting_strength - self.hover_strength) * (
                1.0 - math.exp(-dt / 0.30)
            )

        self.hovered = cursor_hovered
        self.mode = "peeking" if self.hovered else "rolled"
        self._cursor_sample = (cursor_global.x(), cursor_global.y(), now)
        self._sweep_petal_cooldown = max(0.0, self._sweep_petal_cooldown - dt)

        # 悬停风来得快、散得慢；和风铃一样保留一小段余韵
        wind_target = 0.12 if dragging else 1.0 if self.hovered else 0.0
        wind_tau = 0.14 if self.hovered else 1.10
        self.hover_wind += (wind_target - self.hover_wind) * (1.0 - math.exp(-dt / wind_tau))
        self.gust *= math.exp(-dt / 0.68)
        self.bloom += (self.hover_wind - self.bloom) * (1.0 - math.exp(-dt / 0.22))

        # 三段错拍微风 + 有方向的入场阵风；弹簧阻尼让花自然回正
        base_wind = (
            math.sin(self.t * 0.82)
            + 0.36 * math.sin(self.t * 1.67 + 0.9)
            + 0.14 * math.sin(self.t * 3.15 + 2.2)
        )
        hover_target = self.gust_direction * (
            0.65
            + self.hover_strength * 2.4 * math.sin(self.t * 4.2 + 0.35)
            + self.hover_strength * 0.62 * math.sin(self.t * 7.1 + 1.4)
        )
        target_angle = base_wind * 3.6 * (1.0 - self.hover_wind) + hover_target * self.hover_wind
        target_angle += (
            self.gust_direction * 3.2 * self.gust
            + self.cursor_wind * 5.4
            + self.cursor_lift * 3.6
        )
        if self.pressed:
            target_angle *= 0.18
        acceleration = (target_angle - self.angle) * 19.0 - self.angular_velocity * 6.2
        self.angular_velocity += acceleration * dt
        self.angle += self.angular_velocity * dt
        self.angle = max(-11.0, min(11.0, self.angle))

        # 按住时枝条蓄力下压；松开后快速越界，再衰减回到原位。
        self.press_amount, self.press_velocity = advance_press_spring(
            self.press_amount, self.press_velocity, self.pressed, dt,
        )
        if not self.pressed and abs(self.press_amount) < 0.002 and abs(self.press_velocity) < 0.03:
            self.press_amount = 0.0
            self.press_velocity = 0.0

        # 悬停只零碎落下一两枚小花瓣；按压与松手的较大花瓣簇由鼠标事件触发。
        if self.hovered and not self.pressed:
            self._hover_petal_timer -= dt
            if self._hover_petal_timer <= 0.0:
                self._spawn_petals(
                    self._petal_rng.randint(1, 2), burst=False, wind=self.cursor_velocity,
                )
                self._hover_petal_timer = self._petal_rng.uniform(*HOVER_PETAL_INTERVAL)
        else:
            self._hover_petal_timer = min(
                self._hover_petal_timer, HOVER_PETAL_INTERVAL[0],
            )
        # 提问挂起：花朵持续散发花瓣 + 周期性轻拨树枝（弹簧回弹，视觉上一直在晃）
        if self._ask_emitting:
            self._ask_petal_timer -= dt
            if self._ask_petal_timer <= 0.0:
                self._spawn_petals(self._petal_rng.randint(4, 6), burst=True, size_scale=1.8)
                self._ask_petal_timer = self._petal_rng.uniform(0.22, 0.38)
            if not self.pressed:
                self._ask_bounce_timer -= dt
                if self._ask_bounce_timer <= 0.0:
                    # 直接把枝条推到明显下压位再回弹，幅度才看得见（仅脉冲力度太小）
                    self.press_amount = max(self.press_amount, 0.6)
                    self.press_velocity = max(self.press_velocity, 2.2)
                    self._spawn_petals(self._petal_rng.randint(2, 3), burst=True, size_scale=1.4)
                    self._ask_bounce_timer = self._petal_rng.uniform(0.6, 1.1)
        self._update_petals(dt)

        self.update()

    def _branch_angle(self):
        rebound = max(0.0, -self.press_amount)
        motion_scale = 0.18 if self.pressed else 1.0
        effective_gust = max(self.gust, abs(self.cursor_wind) * 0.9) * motion_scale
        effective_direction = -1.0 if self.cursor_wind < -0.03 else 1.0 if self.cursor_wind > 0.03 else self.gust_direction
        branch_offset, _, _ = component_motion(
            self.t, self.bloom, effective_gust, effective_direction, rebound,
        )
        return (
            self.angle * 0.42
            + branch_offset * 0.55
            + self.press_amount * 4.8
            + self.drag_branch_angle
        )

    def _flower_origin(self):
        return rotate_point_around(
            FLOWER_CENTER[0], FLOWER_CENTER[1],
            BRANCH_PIVOT[0], BRANCH_PIVOT[1], self._branch_angle(),
        )

    def _spawn_petals(self, count, burst, wind=(0.0, 0.0), size_scale=1.0):
        """生成碎瓣；掠风是有方向的小簇，点击仍是更盛大的放射簇。
        size_scale 用于 ask 提醒场景把花瓣放大约 1.8 倍，更显眼。"""
        cx, cy = self._flower_origin()
        wind_x, wind_y = float(wind[0]), float(wind[1])
        source_wind_speed = math.hypot(wind_x, wind_y)
        swept = not burst and source_wind_speed > 0.0
        if swept:
            wind_scale = min(source_wind_speed * 0.024, 32.0) / source_wind_speed
            wind_x *= wind_scale
            wind_y *= wind_scale
        for _ in range(max(0, int(count))):
            size = self._petal_rng.uniform(0.82, 1.62 if burst else 1.28) * size_scale
            if burst:
                direction = self._petal_rng.uniform(0.0, math.tau)
                radius = self._petal_rng.uniform(10.0, 17.0)
                speed = self._petal_rng.uniform(15.0, 31.0)
                x = cx + math.cos(direction) * radius
                y = cy + math.sin(direction) * radius * 0.72
                vx = math.cos(direction) * speed
                vy = math.sin(direction) * speed * 0.68 - 2.0
                gravity = 15.0
                sway = 1.5
                life = self._petal_rng.uniform(0.82, 1.35)
                spin_limit = 150.0
            else:
                direction = self._petal_rng.uniform(0.0, math.tau)
                radius = self._petal_rng.uniform(11.0, 17.0)
                x = cx + math.cos(direction) * radius
                y = cy + math.sin(direction) * radius * 0.78
                vx = self._petal_rng.uniform(-5.0, 5.0) + wind_x
                vy = self._petal_rng.uniform(4.0, 8.5) + wind_y * 0.8
                gravity = 22.0 if swept else 15.0
                sway = 1.5 + min(source_wind_speed / 600.0, 2.4) if swept else 1.5
                life = self._petal_rng.uniform(1.35, 1.95) if swept else self._petal_rng.uniform(0.82, 1.12)
                spin_limit = min(150.0 + source_wind_speed * 0.08, 300.0) if swept else 150.0
            self.petal_particles.append({
                "x": x,
                "y": y,
                "vx": vx,
                "vy": vy,
                "size": size,
                "angle": self._petal_rng.uniform(0.0, 360.0),
                "spin": self._petal_rng.uniform(-spin_limit, spin_limit),
                "phase": self._petal_rng.uniform(0.0, math.tau),
                "gravity": gravity,
                "sway": sway,
                "age": 0.0,
                "life": life,
                "color": self._petal_rng.choice(("#f2b8c7", "#f7cfda", "#e9a3b8")),
            })
        if len(self.petal_particles) > MAX_PETAL_PARTICLES:
            self.petal_particles = self.petal_particles[-MAX_PETAL_PARTICLES:]

    def _update_petals(self, dt):
        alive = []
        for petal in self.petal_particles:
            petal["age"] += dt
            if petal["age"] >= petal["life"]:
                continue
            petal["vx"] *= math.exp(-dt * 0.72)
            petal["vy"] += petal.get("gravity", 15.0) * dt
            petal["x"] += petal["vx"] * dt + math.sin(
                petal["age"] * 8.0 + petal["phase"]
            ) * petal.get("sway", 1.5) * dt
            petal["y"] += petal["vy"] * dt
            petal["angle"] += petal["spin"] * dt
            if petal["y"] <= BALL_SIZE + 3:
                alive.append(petal)
        self.petal_particles = alive

    # ── 绘制 ──
    def paintEvent(self, _e):
        p = QPainter(self)
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_Source)
        p.fillRect(self.rect(), Qt.GlobalColor.transparent)
        p.setCompositionMode(QPainter.CompositionMode.CompositionMode_SourceOver)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)

        # 只缩放可见内容，透明窗口仍保留 80px：悬停命中、贴边和面板锚点不漂移。
        p.save()
        p.translate(BALL_SIZE / 2.0, BALL_SIZE / 2.0)
        p.scale(BALL_VISUAL_SCALE, BALL_VISUAL_SCALE)
        p.translate(-BALL_SIZE / 2.0, -BALL_SIZE / 2.0)
        lift = -0.45 * math.sin(self.t * 1.05)
        self._draw_flower(p, lift)
        self._draw_petals(p)
        p.restore()
        p.end()

    def _draw_flower(self, p, lift):
        """用整枝插画做主视觉，沿原有枝根弹簧轻摆；资源缺失时回退旧版分层花枝。"""
        if self.sprig_ready:
            motion_scale = 0.18 if self.pressed else 1.0
            vertical_offset = self.cursor_lift * 2.8 * motion_scale + self.drag_vertical
            breathe_scale = 1.0 + max(0.0, min(self.bloom, 1.0)) * 0.012
            p.save()
            p.translate(BRANCH_PIVOT[0], BRANCH_PIVOT[1])
            p.rotate(self._branch_angle())
            p.translate(-BRANCH_PIVOT[0], -BRANCH_PIVOT[1])
            self._draw_layer(
                p, self.pix_sprig, BALL_SIZE, 0.0,
                BALL_SIZE / 2.0, BALL_SIZE / 2.0 + lift + vertical_offset,
                breathe_scale,
            )
            p.restore()
            return

        if not self.layered_flower_ready:
            if not self._draw_layer(
                p, self.pix_flower, FLOWER_SIZE,
                self.angle + self.drag_flower_angle,
                FLOWER_CENTER[0],
                FLOWER_CENTER[1] + lift + self.drag_vertical,
                1.0,
            ):
                self._draw_fallback_flower(
                    p,
                    FLOWER_CENTER[0],
                    FLOWER_CENTER[1] + lift + self.drag_vertical,
                    FLOWER_SIZE / 47.0,
                )
            return

        rebound = max(0.0, -self.press_amount)
        motion_scale = 0.18 if self.pressed else 1.0
        effective_gust = max(self.gust, abs(self.cursor_wind) * 0.9) * motion_scale
        effective_direction = -1.0 if self.cursor_wind < -0.03 else 1.0 if self.cursor_wind > 0.03 else self.gust_direction
        _, flower_offset, leaf_offset = component_motion(
            self.t, self.bloom, effective_gust, effective_direction, rebound,
        )
        vertical_offset = self.cursor_lift * 2.8 * motion_scale + self.drag_vertical
        branch_angle = self._branch_angle()

        # 整枝绕画外树身连接处弯下；松手后 press_amount 越过 0，形成快速回弹。
        p.save()
        p.translate(BRANCH_PIVOT[0], BRANCH_PIVOT[1])
        p.rotate(branch_angle)
        p.translate(-BRANCH_PIVOT[0], -BRANCH_PIVOT[1])
        self._draw_layer(
            p, self.pix_branch, BRANCH_SIZE, 0.0, BALL_SIZE / 2, BALL_SIZE / 2,
        )
        self._draw_layer(
            p, self.pix_leaf, LEAF_SIZE, leaf_offset + self.drag_leaf_angle,
            LEAF_CENTER[0], LEAF_CENTER[1] + lift * 0.35 + vertical_offset * 0.45,
        )
        self._draw_layer(
            p, self.pix_flower, FLOWER_SIZE, flower_offset + self.drag_flower_angle,
            FLOWER_CENTER[0], FLOWER_CENTER[1] + lift + vertical_offset, 1.0,
        )
        p.restore()

    def _draw_layer(self, p, pix, target_size, angle, cx, cy, layer_scale=1.0):
        """把完整 SVG 作为一个零件围绕自身中心绘制；空资源安全跳过。"""
        if pix is None or pix.isNull() or pix.width() <= 0:
            return False
        pix_size = pix.width()
        scale = (target_size / pix_size) * layer_scale
        half = pix_size / 2
        p.save()
        p.translate(cx, cy)
        p.rotate(angle)
        p.scale(scale, scale)
        p.translate(-half, -half)
        p.drawPixmap(0, 0, pix)
        p.restore()
        return True

    def _draw_fallback_flower(self, p, cx, cy, flower_scale=1.0):
        """SVG 全部失效时仍画一朵稳定简花，避免传音樱空白或崩溃。"""
        p.save()
        p.translate(cx, cy)
        p.scale(flower_scale, flower_scale)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor("#efb3c3"))
        for _ in range(5):
            p.drawEllipse(QPointF(0.0, -10.5), 7.8, 12.5)
            p.rotate(72.0)
        p.setBrush(QColor("#edc46f"))
        p.drawEllipse(QPointF(0.0, 0.0), 5.2, 5.2)
        p.restore()

    def _draw_petals(self, p):
        """绘制零碎小花瓣；单瓣始终小于 2px，不借数量偷换成大花瓣。"""
        p.save()
        p.setPen(Qt.PenStyle.NoPen)
        for petal in self.petal_particles:
            progress = petal["age"] / max(petal["life"], 0.001)
            alpha = int(205 * max(0.0, 1.0 - progress) ** 0.72)
            color = QColor(petal["color"])
            color.setAlpha(max(0, min(alpha, 205)))
            p.setBrush(color)
            p.save()
            p.translate(petal["x"], petal["y"])
            p.rotate(petal["angle"])
            p.drawEllipse(
                QPointF(0.0, 0.0),
                petal["size"] * 0.62,
                petal["size"],
            )
            p.restore()
        p.restore()

    # ── 鼠标交互 ──
    def _begin_press_effect(self):
        self.pressed = True
        self.press_amount = max(self.press_amount, 0.18)
        self.press_velocity = max(self.press_velocity, 2.6)
        self._spawn_petals(PRESS_PETAL_COUNT, burst=True)

    def _end_press_effect(self):
        if not self.pressed:
            return
        self.pressed = False
        self.press_velocity = min(self.press_velocity, -8.4)
        self._spawn_petals(RELEASE_PETAL_COUNT, burst=True)

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_menu_was_visible = bool(self.menu and self.menu.isVisible())
            self._drag_read_was_visible = bool(self.read_panel and self.read_panel.isVisible())
            self._drag_ask_was_visible = bool(self.ask_flower_dialog and self.ask_flower_dialog.isVisible())
            self._drag_menu_start = self.menu.pos() if self._drag_menu_was_visible else None
            self._drag_read_start = self.read_panel.pos() if self._drag_read_was_visible else None
            self._drag_ask_start = self.ask_flower_dialog.pos() if self._drag_ask_was_visible else None
            # 润色弹窗挂在主面板上（同开同关）：球拖时若面板可见就带它，锚点取面板当前位置
            self._drag_polish_was_visible = bool(
                self.polish_panel is not None
                and self.polish_panel.isVisible()
            )
            self._drag_polish_start = self.polish_panel.pos() if self._drag_polish_was_visible else None
            # 排队弹窗同款：球拖时若它开着就带它，锚点取弹窗当前位置
            self._drag_queue_was_visible = bool(
                self.queue_panel is not None
                and self.queue_panel.isVisible()
            )
            self._drag_queue_start = self.queue_panel.pos() if self._drag_queue_was_visible else None
            # 压缩档案同样是二级弹窗：球被单独拖动时它也要跟着走（与朗读/润色同款）
            self._drag_compaction_was_visible = bool(
                self.compaction_panel is not None
                and self.compaction_panel.isVisible()
            )
            self._drag_compaction_start = (
                self.compaction_panel.pos() if self._drag_compaction_was_visible else None
            )
            self._drag_ball_start = self.pos()
            self._press_global = e.globalPosition().toPoint()
            self._drag = self._press_global - self.pos()
            self._moved = False
            self._reset_drag_motion()
            self._begin_press_effect()
        e.accept()

    def mouseMoveEvent(self, e):
        if self._drag is not None and (e.buttons() & Qt.MouseButton.LeftButton):
            current = e.globalPosition().toPoint()
            if not self._moved:
                if (current - self._press_global).manhattanLength() < QApplication.startDragDistance():
                    e.accept()
                    return
                self._moved = True
                self._cancel_press_for_drag()
            delta = current - self._press_global
            if self._drag_menu_was_visible or self._drag_read_was_visible or self._drag_ask_was_visible or self._drag_polish_was_visible or self._drag_queue_was_visible or self._drag_compaction_was_visible:
                self._sync_dragged_popups(delta)
            else:
                self.move(current - self._drag)
                self._ensure_visible()
            self._record_drag_motion()
        e.accept()

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._end_press_effect()
            if self._moved:
                self._release_drag_motion()
                self._snap()
                self._sync_dragged_popups()
                self._save_pos()
            else:
                self._toggle_expand()
            if not self._moved:
                self._drag_motion_active = False
            self._drag = None
            self._press_global = None
            self._drag_menu_was_visible = False
            self._drag_read_was_visible = False
            self._drag_ask_was_visible = False
            self._drag_polish_was_visible = False
            self._drag_queue_was_visible = False
            self._drag_compaction_was_visible = False
            self._drag_menu_start = None
            self._drag_read_start = None
            self._drag_ask_start = None
            self._drag_polish_start = None
            self._drag_queue_start = None
            self._drag_compaction_start = None
            self._drag_ball_start = None
        elif e.button() == Qt.MouseButton.RightButton:
            self._toggle_context_menu(e.globalPosition().toPoint())
        e.accept()

    def _toggle_context_menu(self, global_pos):
        # 单击右键展开 / 再次右键收起（与左键面板一致）
        if self.context_menu is not None and self.context_menu.isVisible():
            self.context_menu.close()
        else:
            self._open_context_menu(global_pos)

    def _sync_dragged_popups(self, desired_delta=None):
        """球被单独拖动时，让所有已打开的弹窗保持用户当前的相对位置。
        可同时带多个：左键面板 / 朗读窗 / 问问小花弹窗。"""
        if self._drag_ball_start is None:
            return
        popups = []
        if self._drag_read_was_visible and self.read_panel is not None:
            popups.append((self.read_panel, self._drag_read_start))
        if self._drag_menu_was_visible and self.menu is not None:
            popups.append((self.menu, self._drag_menu_start))
        if self._drag_ask_was_visible and self.ask_flower_dialog is not None:
            popups.append((self.ask_flower_dialog, self._drag_ask_start))
        if self._drag_polish_was_visible and self.polish_panel is not None:
            popups.append((self.polish_panel, self._drag_polish_start))
        if self._drag_queue_was_visible and self.queue_panel is not None:
            popups.append((self.queue_panel, self._drag_queue_start))
        if self._drag_compaction_was_visible and self.compaction_panel is not None:
            popups.append((self.compaction_panel, self._drag_compaction_start))
        if not popups:
            return
        delta = desired_delta if desired_delta is not None else self.pos() - self._drag_ball_start
        screen = self.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        for popup, popup_start in popups:
            if popup_start is None:
                continue
            dx, dy = clamp_pair_drag(
                delta.x(), delta.y(),
                (self._drag_ball_start.x(), self._drag_ball_start.y(), self.width(), self.height()),
                (popup_start.x(), popup_start.y(), popup.width(), popup.height()),
                (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            )
            self.move(self._drag_ball_start + QPoint(dx, dy))
            # 球带着弹窗移动也算用户手动调整；延迟布局回调不能再按左优先规则把弹窗拽走。
            popup._user_dragged = True
            popup.move(popup_start + QPoint(dx, dy))
            if not popup.isVisible():
                popup.show()
                popup.raise_()

    # ── 贴边吸附 ──
    def _snap(self):
        screen = self.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        margin = 26
        x, y = self.pos().x(), self.pos().y()
        w, h = self.width(), self.height()
        if x < geo.left() + margin:
            x = geo.left() + EDGE_INSET
        elif x + w > geo.right() - margin:
            x = geo.right() - w - EDGE_INSET + 1
        if y < geo.top() + margin:
            y = geo.top() + EDGE_INSET
        elif y + h > geo.bottom() - margin:
            y = geo.bottom() - h - EDGE_INSET + 1
        self.move(x, y)

    # ── 展开 / 收起 ──
    def _toggle_expand(self):
        if self.menu and self.menu.isVisible():
            if self.menu.is_ask_open():
                # 收起只是隐藏窗口，不改变 ask 状态；再次点花朵仍会回到同一道题。
                self._close_menu()
                return
            self._close_menu()
            return
        # 主面板没开，但朗读窗口开着：点球先收掉它（停读），不展开面板
        if self.read_panel is not None and self.read_panel.isVisible():
            self.read_panel.close()
            return
        # 主面板没开，但润色窗开着：点球先收掉它（不展开面板，跟朗读同款）
        if self.polish_panel is not None and self.polish_panel.isVisible():
            self.polish_panel.close()
            return
        # 主面板没开，但排队窗开着：同上，先收掉不展开面板
        if self.queue_panel is not None and self.queue_panel.isVisible():
            self.queue_panel.close()
            return
        # 主面板没开，但压缩档案开着：同上，先收掉不展开面板
        if self.compaction_panel is not None and self.compaction_panel.isVisible():
            self.compaction_panel.close()
            return
        # 主面板没开，但问问小花弹窗开着：先收掉它，再正常展开主面板
        if self.ask_flower_dialog is not None and self.ask_flower_dialog.isVisible():
            self.ask_flower_dialog.close()
        self._open_menu()

    def _close_menu(self):
        if self.menu:
            # 点球收起面板是用户动作：这条续接提醒别再反复把面板叫出来。
            self.menu.close_menu(user_dismissed=True)
        self._set_fusion_panel_state("none")

    # ── 右键菜单 ──
    def _open_context_menu(self, global_pos):
        # 互斥：开右键浮签前先收左键面板、朗读窗与润色窗，弹窗永不并存（避免叠放/遮挡干扰 hover）
        self._close_menu()
        if self.read_panel is not None and self.read_panel.isVisible():
            self.read_panel.close()
        if self.polish_panel is not None and self.polish_panel.isVisible():
            self.polish_panel.close()
        if self.queue_panel is not None and self.queue_panel.isVisible():
            self.queue_panel.close()
        if self.compaction_panel is not None and self.compaction_panel.isVisible():
            self.compaction_panel.close()
        if self.context_menu is None:
            self.context_menu = SendModeMenu(self)
        self.context_menu.show_at(global_pos)

    def eventFilter(self, obj, event):
        # 右键浮签开着时，任何窗口上的鼠标按下都先过这里：
        # 按在浮签内 → 放行；按在浮签外 → 关闭（点空白/点别的窗口都算）
        if event.type() == QEvent.Type.MouseButtonPress:
            self._dismiss_context_menu_on_outside_click(event)
        return super().eventFilter(obj, event)

    def _dismiss_context_menu_on_outside_click(self, event):
        menu = self.context_menu
        if menu is None or not menu.isVisible():
            return
        pos = event.globalPosition().toPoint()
        if menu.geometry().contains(pos):
            return
        # 右键点在花朵上：不在这里关，交给花朵的右键 toggle（保持"再按一次右键收起"）
        if event.button() == Qt.MouseButton.RightButton and self.geometry().contains(pos):
            return
        menu.close()

    def _set_action(self, action):
        self.action = action
        self.state["action"] = action
        save_state(self.state)
        try:
            api_post("/action", {"action": action}, timeout=5)
        except Exception:
            pass
        # 模式切换后同步面板底部的模式文案
        if self.menu is not None:
            self.menu._update_hint()

    # ── 面板 ──
    def _open_menu(self):
        if self.read_panel is not None and self.read_panel.isVisible():
            self.read_panel.close()
        if self.polish_panel is not None and self.polish_panel.isVisible():
            self.polish_panel.close()
        if self.queue_panel is not None and self.queue_panel.isVisible():
            self.queue_panel.close()
        if self.compaction_panel is not None and self.compaction_panel.isVisible():
            self.compaction_panel.close()
        if self.menu is None:
            self.menu = ZhujianMenu(self)
        if not self.menu.is_ask_open():
            self.menu.prepare_for_show()
        else:
            # 手动重新点花朵 = 明确要回来处理这道题，解除“用户主动收起”抑制。
            self.menu._ask_user_hidden = False
        self.menu.move_to_ball()
        self.menu.show()
        self.menu.raise_()
        self.menu.activateWindow()
        self._set_fusion_panel_state("ask" if self.menu.is_ask_open() else "menu")


# ─────────────────────────────
#  解语花主面板：推荐回复 + 对话工具
# ─────────────────────────────
class ZhujianMenu(FadeOnLeaveMixin, QFrame):
    refresh_ready = pyqtSignal(object)
    target_ready = pyqtSignal(object)
    rename_ready = pyqtSignal(object)
    undo_ready = pyqtSignal(object)
    ask_response_ready = pyqtSignal(object)
    resume_state_ready = pyqtSignal(object)   # 轮询 GET /resume/state 的回包
    sleep_state_ready = pyqtSignal(object)    # 轮询 GET /sleep/state 的回包
    sleep_action_done = pyqtSignal(object)    # POST /sleep/action 的回包
    resume_action_ready = pyqtSignal(object)  # 按钮 POST /resume/action 的回包
    recommend_state_ready = pyqtSignal(object)  # 轮询 GET /recommend/state 的回包
    recommend_request_failed = pyqtSignal(object)  # 球→App 请求发不出去时的回包

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("panel")
        self.setFixedWidth(344)
        # 面板边向：默认左；读持久化的 panel_side（贴边换边时写入）
        self.side = str(self.ball.state.get("panel_side") or "left")
        self._refreshing = False
        self._renaming = False
        self._undo_available = False
        self._target_seq = 0
        self._refresh_seq = 0
        # 面板拖拽状态：面板与花朵始终作为一组移动
        self._drag_press = None
        self._drag_panel_start = None
        self._drag_ball_start = None
        self._drag_moved = False
        self._needs_reanchor = False  # 本次打开后内容尚未以完整高度锚定过
        self._user_dragged = False    # 本次打开后用户是否手动拖过面板（拖过则尊重手动位置）
        self._ask_entry = None
        self._ask_option_frames = []
        self._ask_responding = False
        self._ask_finished = False
        self._ask_user_hidden = False  # 用户主动收起 ask；轮询不自动打回脸上，手动重开仍保留原题
        # ask 挂起期间允许面板暂时收起，但问题状态必须保留到真正作答完成。
        self._ask_response_mode = ""
        self._ask_response_choice = ""
        self._ask_selection_mode = "single"
        self._ask_min_selections = 1
        self._ask_max_selections = 1
        self._ask_selected_indices = []
        self._ask_option_labels = []
        self._ask_flower_enabled = False
        # 断联续接小条：App 推 notice 才亮，球只管把按钮意图回传
        self._closed = False  # 菜单不销毁但 worker 守卫会引用 _closed（Ball/ReadPanel 都有，菜单漏了——2026-08-27 实机踩到：缺失导致 worker 抛 AttributeError，emit 永不执行，按钮永远「发送中」）
        self._resume_view_active = False
        self._resume_notice = None        # 当前桥上的提醒；None = 空态
        self._resume_sig = None           # 同一条提醒的指纹，避免重复重渲染
        self._resume_hidden_sig = None    # 用户点了「不用管」的那条指纹，同一条不打回
        self._resume_deferred_sig = None  # 用户只是收起了面板：不再自动弹，但自己点开仍要看得到
        self._resume_ask_pending_sig = None  # 提问期间到的提醒：提问一让位就补上，不能跟着沉底
        self._resume_rounds = 1  # 「这次接几轮」：一次性动作参数，不是全局设置
        self._resume_sending = False      # 「继续哈」发送中，防重复点击
        self._resume_auto = False         # 全局自动续接配置，App 推快照同步
        self._resume_enabled = False      # 旧桥缺省关闭；progress 本身绝不唤起面板
        self._resume_max_consecutive = 3
        self._resume_progress = []
        self._resume_config_sending = False
        self._loop_state = None            # App 推来的循环状态
        self._queue_state = None           # App 推来的排队话单状态
        self._resume_notice_timer = None
        self._resume_timer = None         # 800ms 轮询 /resume/state
        self._sleep_timer = None          # 3s 轮询 /sleep/state（守门人状态）
        self._sleep_poll_inflight = False
        self._sleep_state = None
        self._sleep_action_pending = False
        self._resume_poll_inflight = False
        self._resume_action_seq = 0       # 已见过的 actionSeq，避免重复补发
        self._resume_action_inflight = 0
        self._resume_seq_adopted = False  # 首轮只记 actionSeq 基线，不把旧动作重发
        self._resume_last_attempt = None  # 本球最近一次 POST 的动作指纹（去重回包丢失的重复补发）
        # 球内推荐与目标跟随：走 App 桥的 /recommend/*（球发请求，App 推快照）。
        self._recommend_timer = None
        self._recommend_poll_inflight = False
        self._recommend_seq = 0          # 本球发过的请求序号
        self._recommend_ack_seq = 0      # App 已读到的请求序号
        self._recommend_push_seq = 0     # 已应用过的推送序号（仅记录）
        self._recommend_push_sig = None  # 快照内容指纹：内容没变就不重渲染，避免每 1.5 秒抖一次
        self._recommend_generating = False
        self._recommend_notice = ""
        self._recommend_visible = True   # 推荐区显隐，由 App 推的 enabled 决定
        self._recommend_sticky = False   # 错误提示粘住不放，直到收起面板或真的生成出东西
        self._resume_flash_at = None      # 自动续接成功闪报的时间戳，去重用
        self.resume_state_ready.connect(self._apply_resume_state)
        self.sleep_state_ready.connect(self._apply_sleep_state)
        self.sleep_action_done.connect(self._after_sleep_action)
        # 菜单是懒创建的：main 里启动时它还不存在，所以轮询必须从自己这里起来。
        # 控件在 _build_ui 里才建好，延后一拍再启动。
        QTimer.singleShot(600, self.start_sleep_polling)
        self.resume_action_ready.connect(self._apply_resume_action_result)
        self.recommend_state_ready.connect(self._apply_recommend_state)
        self.recommend_request_failed.connect(self._apply_recommend_request_failure)
        self.refresh_ready.connect(self._apply_async_refresh)
        self.target_ready.connect(self._apply_target_state)
        self.rename_ready.connect(self._apply_rename_result)
        self.undo_ready.connect(self._apply_undo_result)
        self.ask_response_ready.connect(self._apply_ask_response)
        self._build_ui()
        self.set_ask_flower_enabled(getattr(self.ball, "ask_flower_enabled", False))
        if APP_ONLY_ASK:
            self._configure_app_mode()
        self.setup_fade_on_leave()

    def _configure_app_mode(self):
        """知意首期只开放关键 Ask；其他旧插件业务入口先不向用户展示。
        球内目标跟随与推荐面板已改走 App 桥的 /recommend/* 端点，重新开放。"""
        for name in (
            # resume_body 不在隐藏名单里：它现在是常驻小条，默认隐藏、有 notice 才亮。
            # lbl_resume_notice 也不在：它是自动续接成功的几秒闪报，App 会在有 flash 时自己 show。
            "compaction_tool", "lbl_hint",
        ):
            widget = getattr(self, name, None)
            if widget is not None:
                widget.hide()
        # 「念给我听」在 App 模式下重新开放：朗读链路已改走 App 桥的 /voice/* 端点。
        say_tool = getattr(self, "say_tool", None)
        if say_tool is not None:
            say_tool.show()
        # 「理顺」同样重新开放：弹窗改走桥上的 /polish/* 端点，App 侧路由与实现本就有。
        # 压缩档案仍然藏着：它读的是旧路由，App 桥没开，也拿不到需要的权限。
        polish_tool = getattr(self, "polish_tool", None)
        if polish_tool is not None:
            polish_tool.show()
        # 「会话标题」重新开放：起名与写回改走桥上的 /title/*，App 侧有 session:update 权限。
        rename_tool = getattr(self, "rename_tool", None)
        if rename_tool is not None:
            rename_tool.show()
        # 目标跟随（当前对话）与球内推荐面板在 App 模式下重新开放，链路走 /recommend/*。
        # target_menu 不在其中：候选浮签默认收起，只有点「当前对话」按钮才展开。
        # （旧版主面板也是 TargetMenu().hide() + showEvent 里再 hide 一次；
        #   这里一度把它跟着其他控件一起 show()，结果每次开面板都坦着半屏。）
        for name in ("lbl_target_label", "btn_target", "lbl_target_info", "lbl_section"):
            widget = getattr(self, name, None)
            if widget is not None:
                widget.show()
        if self.target_menu is not None:
            self.target_menu.hide()
        # 推荐区归桥推的 enabled 管。这里以前无条件 show()，而 _set_recommend_visible
        # 是幂等早退的，所以用户在设置里关掉推荐、答完一道题之后，这张卡会被强行
        # 放回来而且再也藏不回去——面板里留一个只有「刷新推荐/清空」的空壳。
        if getattr(self, "_recommend_visible", True):
            recommend_body = getattr(self, "recommend_body", None)
            if recommend_body is not None:
                recommend_body.show()
        self.app_idle_notice.show()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 18, 20, 18)
        root.setSpacing(9)

        head_row = QHBoxLayout()
        head_row.setSpacing(8)
        self.lbl_head = QLabel("解语花")
        self.lbl_head.setTextFormat(Qt.TextFormat.PlainText)
        self.lbl_head.setObjectName("head")
        self.lbl_head.setWordWrap(True)
        head_row.addWidget(self.lbl_head, 1)
        self.btn_ask_close = QPushButton("收起")
        self.btn_ask_close.setObjectName("askClose")
        self.btn_ask_close.setToolTip("暂时收起问题；点传音樱还能回来回答")
        self.btn_ask_close.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_ask_close.clicked.connect(lambda: self.close_menu(user_dismissed=True))
        self.btn_ask_close.hide()
        head_row.addWidget(self.btn_ask_close)

        target_row = QHBoxLayout()
        target_row.setSpacing(6)
        self.lbl_target_label = QLabel("当前对话")
        self.lbl_target_label.setObjectName("targetLabel")
        self.btn_target = QPushButton("跟随最近 ▾")
        self.btn_target.setObjectName("target")
        self.btn_target.setToolTip("选择推荐、朗读和标题操作要作用于哪段对话")
        self.btn_target.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_target.clicked.connect(self._open_target_menu)
        target_row.addWidget(self.lbl_target_label)
        target_row.addWidget(self.btn_target)
        head_row.addLayout(target_row)
        root.addLayout(head_row)

        # 当前读取的是哪个对话框（跟随最近结果或手动固定的会话），重命名/推荐都基于它
        self.lbl_target_info = QLabel("")
        self.lbl_target_info.setObjectName("targetInfo")
        self.lbl_target_info.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        root.addWidget(self.lbl_target_info)
        self.app_idle_notice = QLabel("知意已就位。需要你决定的关键分岔，会显示在这里。")
        self.app_idle_notice.setObjectName("appIdleNotice")
        self.app_idle_notice.setWordWrap(True)
        self.app_idle_notice.hide()
        root.addWidget(self.app_idle_notice)

        # 恢复旧版的内嵌目标选择区，展开时向下排布，不覆盖推荐内容。
        self.target_menu = TargetMenu(self)
        self.target_menu.hide()
        root.addWidget(self.target_menu)


        # 提问模式复用同一块展板：推荐条暂时让位，答完后恢复原缓存。
        self.ask_scroll = QScrollArea()
        self.ask_scroll.setObjectName("askScroll")
        self.ask_scroll.setAutoFillBackground(False)
        self.ask_scroll.viewport().setAutoFillBackground(False)
        self.ask_scroll.setWidgetResizable(True)
        self.ask_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.ask_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.ask_scroll.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.ask_body = QFrame()
        self.ask_body.setObjectName("askBody")
        ask_body_layout = QVBoxLayout(self.ask_body)
        ask_body_layout.setContentsMargins(0, 0, 0, 0)
        ask_body_layout.setSpacing(10)
        self.lbl_ask_from = QLabel("")
        self.lbl_ask_from.setTextFormat(Qt.TextFormat.PlainText)
        self.lbl_ask_from.setObjectName("askFrom")
        self.lbl_ask_from.setWordWrap(True)
        self.lbl_ask_from.hide()
        ask_body_layout.addWidget(self.lbl_ask_from)
        self.lbl_ask_question = QLabel("")
        self.lbl_ask_question.setTextFormat(Qt.TextFormat.PlainText)
        self.lbl_ask_question.setObjectName("askQuestion")
        self.lbl_ask_question.setWordWrap(True)
        ask_body_layout.addWidget(self.lbl_ask_question)
        self.lbl_ask_background = QLabel("")
        self.lbl_ask_background.setTextFormat(Qt.TextFormat.PlainText)
        self.lbl_ask_background.setObjectName("askBackground")
        self.lbl_ask_background.setWordWrap(True)
        ask_body_layout.addWidget(self.lbl_ask_background)
        self.lbl_ask_recommendation = QLabel("")
        self.lbl_ask_recommendation.setTextFormat(Qt.TextFormat.PlainText)
        self.lbl_ask_recommendation.setObjectName("askRecommendation")
        self.lbl_ask_recommendation.setWordWrap(True)
        ask_body_layout.addWidget(self.lbl_ask_recommendation)
        self.lbl_ask_select_hint = QLabel("")
        self.lbl_ask_select_hint.setObjectName("askSelectHint")
        self.lbl_ask_select_hint.setWordWrap(True)
        self.lbl_ask_select_hint.hide()
        ask_body_layout.addWidget(self.lbl_ask_select_hint)
        self.ask_options_grid = QGridLayout()
        self.ask_options_grid.setContentsMargins(0, 0, 0, 0)
        self.ask_options_grid.setSpacing(9)
        ask_body_layout.addLayout(self.ask_options_grid)
        ask_body_layout.addStretch(1)
        self.ask_scroll.setWidget(self.ask_body)
        self.ask_scroll.hide()
        root.addWidget(self.ask_scroll)

        # 推荐区与工具区共用同一张薄荷色卡片，刷新动作自然落在卡片右侧内边。
        self.recommend_body = QFrame()
        self.recommend_body.setObjectName("recommendCard")
        recommend_layout = QVBoxLayout(self.recommend_body)
        recommend_layout.setContentsMargins(10, 8, 10, 8)
        recommend_layout.setSpacing(8)
        self.lbl_recommend_section = QLabel("推荐回复")
        self.lbl_recommend_section.setObjectName("sectionTitle")
        recommend_layout.addWidget(self.lbl_recommend_section)

        self.grid = QGridLayout()
        self.grid.setSpacing(8)
        self.buttons = []
        recommend_layout.addLayout(self.grid)

        row_refresh = QHBoxLayout()
        row_refresh.setContentsMargins(0, 0, 0, 0)
        row_refresh.setSpacing(8)
        # 清空：只清当前这一屏，不动已存的方向设置；清完不会被 App 推回来的旧列表填回去。
        # 它是撤退动作，比「刷新推荐」窄一档（clearBtn 样式），并且没有已生成的推荐时不出现。
        self.btn_clear_recommend = QPushButton("清空")
        self.btn_clear_recommend.setObjectName("clearBtn")
        self.btn_clear_recommend.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_clear_recommend.setToolTip("清掉现在这几条推荐（不会调模型，也不会重新生成）")
        self.btn_clear_recommend.clicked.connect(self.clear_recommend)
        self._clear_available = False
        self.btn_clear_recommend.setVisible(False)
        self.btn_refresh = QPushButton("刷新推荐")
        self.btn_refresh.setObjectName("refreshBtn")
        self.btn_refresh.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_refresh.clicked.connect(self.refresh_async)
        self.lbl_cache_time = QLabel("")
        self.lbl_cache_time.setObjectName("cacheTime")
        row_refresh.addStretch(1)
        row_refresh.addWidget(self.lbl_cache_time)
        row_refresh.addWidget(self.btn_clear_recommend)
        row_refresh.addWidget(self.btn_refresh)
        recommend_layout.addLayout(row_refresh)
        root.addWidget(self.recommend_body)

        self.ask_input = QLineEdit()
        self.ask_input.setObjectName("askInput")
        self.ask_input.setMaxLength(ASK_INPUT_MAX_LENGTH)
        # 俏皮文案：弹窗里能写，主对话框直接说也行（隐式跳开会静默收起提问，助手上下文仍能对上）
        # 字号调小到 10px 保证这 26 个字在输入框里完整显示
        self.ask_input.setPlaceholderText("在此输入文本（嘻嘻，惯性思维了不是？在哪输入不是输入呢？）")
        self.ask_input.returnPressed.connect(self._send_custom_ask)
        self.ask_input.textChanged.connect(self._update_ask_selection_ui)
        self.ask_input.hide()
        root.addWidget(self.ask_input)
        self.btn_ask_skip = QPushButton("跳过本题")
        self.btn_ask_skip.setObjectName("askSkip")
        self.btn_ask_skip.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_ask_skip.clicked.connect(lambda: self._respond_ask("skip", ""))
        self.btn_ask_skip.hide()
        self.btn_ask_send = QPushButton("发送")
        self.btn_ask_send.setObjectName("askSend")
        self.btn_ask_send.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_ask_send.clicked.connect(self._send_custom_ask)
        self.btn_ask_send.hide()
        ask_actions = QHBoxLayout()
        ask_actions.setSpacing(8)
        ask_actions.addWidget(self.btn_ask_skip)
        ask_actions.addWidget(self.btn_ask_send)
        root.addLayout(ask_actions)

        # 断联续接小条：App 推 notice 才亮（一键继续 / 不用管 / 自动续接开关）
        self.resume_body = QFrame()
        self.resume_body.setObjectName("resumeCard")
        resume_layout = QVBoxLayout(self.resume_body)
        resume_layout.setContentsMargins(12, 10, 12, 10)
        resume_layout.setSpacing(6)
        self.lbl_resume_from = QLabel("")
        self.lbl_resume_from.setObjectName("resumeFrom")
        self.lbl_resume_from.setWordWrap(True)
        resume_layout.addWidget(self.lbl_resume_from)
        self.lbl_resume_reason = QLabel("")
        self.lbl_resume_reason.setObjectName("resumeReason")
        self.lbl_resume_reason.setWordWrap(True)
        resume_layout.addWidget(self.lbl_resume_reason)
        resume_actions = QHBoxLayout()
        resume_actions.setContentsMargins(0, 0, 0, 0)
        resume_actions.setSpacing(8)
        self.btn_resume_continue = QPushButton("继续哈")
        self.btn_resume_continue.setObjectName("resumeContinue")
        self.btn_resume_continue.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_resume_continue.setToolTip("往这个窗口发一条「继续哈」，接上话头")
        self.btn_resume_continue.clicked.connect(self._resume_send_continue)
        resume_actions.addWidget(self.btn_resume_continue)
        # 「就到这吧」：循环跑到收工话时问的是“还接着吗”，得给一个收工选项，
        # 不能只剩「继续哈」把人逼着继续。
        self.btn_loop_finish = QPushButton("就到这吧")
        self.btn_loop_finish.setObjectName("loopFinish")
        self.btn_loop_finish.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_loop_finish.setToolTip("收工：不再自动接着往下续")
        self.btn_loop_finish.clicked.connect(self._loop_finish)
        self.btn_loop_finish.hide()
        resume_actions.addWidget(self.btn_loop_finish)
        # 「不用管」：同排次要按钮，语义是用户主动放下这条提醒（不是拒绝继续）。
        self.btn_resume_dismiss = QPushButton("不用管")
        self.btn_resume_dismiss.setObjectName("resumeDismiss")
        self.btn_resume_dismiss.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_resume_dismiss.setToolTip("先不管这条提醒，小条收起来")
        self.btn_resume_dismiss.clicked.connect(self._resume_send_dismiss)
        resume_actions.addWidget(self.btn_resume_dismiss)
        self.btn_resume_auto = QPushButton("自动续接：关")
        self.btn_resume_auto.setObjectName("resumeAuto")
        self.btn_resume_auto.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_resume_auto.setCheckable(True)
        self.btn_resume_auto.setToolTip("打开后检测到窗口断联会自动发「继续哈」，不再弹窗")
        self.btn_resume_auto.clicked.connect(self._resume_send_auto)
        resume_actions.addWidget(self.btn_resume_auto, 0, Qt.AlignmentFlag.AlignRight)
        resume_layout.addLayout(resume_actions)

        self.resume_body.hide()
        root.addWidget(self.resume_body)

        # 循环续接运行中的状态行（旧版同款）：只在真的循环时亮。
        self.loop_status_widget = QWidget()
        loop_status_row = QHBoxLayout(self.loop_status_widget)
        loop_status_row.setContentsMargins(0, 2, 0, 0)
        loop_status_row.setSpacing(6)
        self.lbl_loop_state = QLabel("")
        self.lbl_loop_state.setObjectName("loopState")
        self.lbl_loop_state.setWordWrap(True)
        loop_status_row.addWidget(self.lbl_loop_state, 1)
        self.btn_loop_stop = QPushButton("停")
        self.btn_loop_stop.setObjectName("loopBtn")
        self.btn_loop_stop.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_loop_stop.setToolTip("不再自动往下续；已经发出去的那一句照常")
        self.btn_loop_stop.clicked.connect(self._loop_stop)
        loop_status_row.addWidget(self.btn_loop_stop)
        self.loop_status_widget.hide()
        root.addWidget(self.loop_status_widget)

        # 自动续接成功的短暂提示条（轮询带回，面板开着时显示几秒）
        self.lbl_resume_notice = QLabel("")
        self.lbl_resume_notice.setObjectName("resumeNotice")
        self.lbl_resume_notice.setWordWrap(True)
        self.lbl_resume_notice.hide()
        root.addWidget(self.lbl_resume_notice)

        self.lbl_section = QLabel("对话工具")
        self.lbl_section.setObjectName("sectionTitle")
        root.addWidget(self.lbl_section)

        # 工具统一成「标题 + 说明 + 动作」的卡片行，未来新增工具沿用同一骨架。
        self.say_tool = QFrame()
        self.say_tool.setObjectName("toolRow")
        say_row = QHBoxLayout(self.say_tool)
        say_row.setContentsMargins(10, 8, 10, 8)
        say_row.setSpacing(10)
        say_copy = QVBoxLayout()
        say_copy.setSpacing(2)
        self.lbl_say_title = QLabel("朗读回复")
        self.lbl_say_title.setObjectName("toolTitle")
        say_copy.addWidget(self.lbl_say_title)
        self.lbl_say_desc = QLabel("让小花把当前回复念出来")
        self.lbl_say_desc.setObjectName("toolDesc")
        self.lbl_say_desc.setWordWrap(True)
        say_copy.addWidget(self.lbl_say_desc)
        say_row.addLayout(say_copy, 1)
        self.btn_say = QPushButton("念给我听")
        self.btn_say.setObjectName("sayBtn")
        self.btn_say.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_say.setToolTip("打开朗读窗口，可选择要朗读的回复（需在设置页开启语音朗读）")
        self.btn_say.clicked.connect(self._open_read_panel)
        say_row.addWidget(self.btn_say)
        root.addWidget(self.say_tool)
        # 朗读入口已经搬到每条回复的操作行（宿主 contributes.ui.messageActions），
        # 球里这一排就收起来，两套并存反而让人不知道该点哪个。
        self.say_tool.hide()

        # 问问小花：问 Hana 用法，弹窗内用解语花配置的模型直接回答（不注入真实会话）
        self.ask_flower_tool = QFrame()
        self.ask_flower_tool.setObjectName("toolRow")
        ask_flower_row = QHBoxLayout(self.ask_flower_tool)
        ask_flower_row.setContentsMargins(10, 8, 10, 8)
        ask_flower_row.setSpacing(10)
        ask_flower_copy = QVBoxLayout()
        ask_flower_copy.setSpacing(2)
        self.lbl_ask_flower_title = QLabel("问问小花")
        self.lbl_ask_flower_title.setObjectName("toolTitle")
        ask_flower_copy.addWidget(self.lbl_ask_flower_title)
        self.lbl_ask_flower_desc = QLabel("想问 Hana 使用上的问题？点这里问问小花，基于 Hana 内置的 user-guide 说明书 skill，帮你更方便地解答")
        self.lbl_ask_flower_desc.setObjectName("toolDesc")
        self.lbl_ask_flower_desc.setWordWrap(True)
        ask_flower_copy.addWidget(self.lbl_ask_flower_desc)
        ask_flower_row.addLayout(ask_flower_copy, 1)
        self.btn_ask_flower = QPushButton("问问小花")
        self.btn_ask_flower.setObjectName("sayBtn")
        self.btn_ask_flower.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_ask_flower.setToolTip("打开提问弹窗，问 Hana 用法，小花用说明书在这里答你")
        self.btn_ask_flower.clicked.connect(self._open_ask_flower)
        ask_flower_row.addWidget(self.btn_ask_flower)
        root.addWidget(self.ask_flower_tool)

        self.rename_tool = QFrame()
        self.rename_tool.setObjectName("toolRow")
        rename_row = QVBoxLayout(self.rename_tool)
        rename_row.setContentsMargins(10, 8, 10, 8)
        rename_row.setSpacing(6)
        rename_copy = QVBoxLayout()
        rename_copy.setSpacing(2)
        self.lbl_rename_title = QLabel("会话标题")
        self.lbl_rename_title.setObjectName("toolTitle")
        rename_copy.addWidget(self.lbl_rename_title)
        self.lbl_rename_desc = QLabel(RENAME_DESC_IDLE)
        self.lbl_rename_desc.setObjectName("toolDesc")
        self.lbl_rename_desc.setWordWrap(True)
        rename_copy.addWidget(self.lbl_rename_desc)
        rename_row.addLayout(rename_copy)
        # 两个动作排同一行、靠右：还原只在这一行里出现，不另起一行。
        # 竖着排的话，还原一亮出来就要把整行撑高，而这层容器被上层挤着不长个，
        # 按钮就会掉到虚线框外面去（2026-10-19 实机反馈）。
        rename_actions = QHBoxLayout()
        rename_actions.setContentsMargins(0, 0, 0, 0)
        rename_actions.setSpacing(8)
        rename_actions.addStretch(1)
        self.btn_undo = QPushButton("还原")
        self.btn_undo.setObjectName("undoBtn")
        self.btn_undo.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_undo.setToolTip("还原到上一次的标题")
        self.btn_undo.setEnabled(False)
        self.btn_undo.hide()
        self.btn_undo.clicked.connect(self.undo_async)
        rename_actions.addWidget(self.btn_undo, 0, Qt.AlignmentFlag.AlignVCenter)
        self.btn_rename = QPushButton("生成新标题")
        self.btn_rename.setObjectName("renameBtn")
        self.btn_rename.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_rename.setToolTip("总结这段对话的整体内容，给会话起个新标题")
        self.btn_rename.clicked.connect(self.rename_async)
        rename_actions.addWidget(self.btn_rename, 0, Qt.AlignmentFlag.AlignVCenter)
        rename_row.addLayout(rename_actions)
        root.addWidget(self.rename_tool)

        # 把话理顺：把糙话理成 AI 更好理解的样子（独立二级弹窗）
        self.polish_tool = QFrame()
        self.polish_tool.setObjectName("toolRow")
        polish_row = QHBoxLayout(self.polish_tool)
        polish_row.setContentsMargins(10, 8, 10, 8)
        polish_row.setSpacing(10)
        polish_copy = QVBoxLayout()
        polish_copy.setSpacing(2)
        self.lbl_polish_title = QLabel("把话理顺")
        self.lbl_polish_title.setObjectName("toolTitle")
        polish_copy.addWidget(self.lbl_polish_title)
        self.lbl_polish_desc = QLabel("把随手写的话理顺，原意不乱，确认后再发出去")
        self.lbl_polish_desc.setObjectName("toolDesc")
        self.lbl_polish_desc.setWordWrap(True)
        polish_copy.addWidget(self.lbl_polish_desc)
        polish_row.addLayout(polish_copy, 1)
        self.btn_polish = QPushButton("理顺")
        self.btn_polish.setObjectName("renameBtn")
        self.btn_polish.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_polish.setToolTip("打开把话理顺：写下糙话 → 理顺 → 可改 → 发进当前对话")
        self.btn_polish.clicked.connect(self._open_polish_panel)
        polish_row.addWidget(self.btn_polish)
        root.addWidget(self.polish_tool)

        # 排队发送：写一句或几句，ta 说完再送进去（旧版「写一句」弹窗的形）
        self.queue_tool = QFrame()
        self.queue_tool.setObjectName("toolRow")
        # 外层竖排：上面是标题与按钮，下面挂状态行。
        # 状态属于这个功能，就长在同一个框里；框一收，提示也跟着收，
        # 不会在框外飘一条让人认不出是哪个功能的字。
        queue_root = QVBoxLayout(self.queue_tool)
        queue_root.setContentsMargins(10, 8, 10, 8)
        queue_root.setSpacing(6)
        queue_row = QHBoxLayout()
        queue_row.setContentsMargins(0, 0, 0, 0)
        queue_row.setSpacing(10)
        queue_copy = QVBoxLayout()
        queue_copy.setSpacing(2)
        self.lbl_queue_title = QLabel("排队发送")
        self.lbl_queue_title.setObjectName("toolTitle")
        queue_copy.addWidget(self.lbl_queue_title)
        self.lbl_queue_desc = QLabel("写一句或几句，ta 说完再送进去")
        self.lbl_queue_desc.setObjectName("toolDesc")
        self.lbl_queue_desc.setWordWrap(True)
        queue_copy.addWidget(self.lbl_queue_desc)
        queue_row.addLayout(queue_copy, 1)
        self.btn_queue_open = QPushButton("排队")
        self.btn_queue_open.setObjectName("renameBtn")
        self.btn_queue_open.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_queue_open.setToolTip("打开排队发送：写一句或几句，ta 说完就送进去")
        self.btn_queue_open.clicked.connect(self._open_queue_panel)
        queue_row.addWidget(self.btn_queue_open)
        queue_root.addLayout(queue_row)

        # 排队话单的状态行：跑着的时候亮，能看见排到第几轮，也能随手停。
        self.queue_status_widget = QWidget()
        queue_status_row = QHBoxLayout(self.queue_status_widget)
        queue_status_row.setContentsMargins(0, 0, 0, 0)
        queue_status_row.setSpacing(6)
        self.lbl_queue_state = QLabel("")
        self.lbl_queue_state.setObjectName("loopState")
        self.lbl_queue_state.setWordWrap(True)
        queue_status_row.addWidget(self.lbl_queue_state, 1)
        self.btn_queue_stop = QPushButton("停")
        self.btn_queue_stop.setObjectName("loopBtn")
        self.btn_queue_stop.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_queue_stop.setToolTip("不再往下送；已经送出去的那一句照常")
        self.btn_queue_stop.clicked.connect(self._queue_stop)
        queue_status_row.addWidget(self.btn_queue_stop)
        queue_root.addWidget(self.queue_status_widget)
        self.queue_status_widget.hide()
        root.addWidget(self.queue_tool)

        # 压缩档案：把这段对话被压缩后的摘要摊开看（只读，不发模型请求）
        self.compaction_tool = QFrame()
        self.compaction_tool.setObjectName("toolRow")
        compaction_row = QHBoxLayout(self.compaction_tool)
        compaction_row.setContentsMargins(10, 8, 10, 8)
        compaction_row.setSpacing(10)
        compaction_copy = QVBoxLayout()
        compaction_copy.setSpacing(2)
        self.lbl_compaction_title = QLabel("压缩档案")
        self.lbl_compaction_title.setObjectName("toolTitle")
        compaction_copy.addWidget(self.lbl_compaction_title)
        self.lbl_compaction_desc = QLabel("看看这段对话被压缩成了什么，记忆还全不全")
        self.lbl_compaction_desc.setObjectName("toolDesc")
        self.lbl_compaction_desc.setWordWrap(True)
        compaction_copy.addWidget(self.lbl_compaction_desc)
        compaction_row.addLayout(compaction_copy, 1)
        self.btn_compaction = QPushButton("查看档案")
        self.btn_compaction.setObjectName("renameBtn")
        self.btn_compaction.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_compaction.setToolTip("打开压缩档案：看这段对话被压缩后的摘要全文（对话没压缩过会直接说明）")
        self.btn_compaction.clicked.connect(self._open_compaction_panel)
        compaction_row.addWidget(self.btn_compaction)
        root.addWidget(self.compaction_tool)

        # 守门人：跟「朗读回复 / 会话标题 / 把话理顺」同一套行，不自己另做一张卡。
        self.sleep_tool = QFrame()
        self.sleep_tool.setObjectName("toolRow")
        sleep_row = QHBoxLayout(self.sleep_tool)
        sleep_row.setContentsMargins(10, 8, 10, 8)
        sleep_row.setSpacing(10)
        sleep_copy = QVBoxLayout()
        sleep_copy.setSpacing(2)
        self.lbl_sleep_title = QLabel("静候关机")
        self.lbl_sleep_title.setObjectName("toolTitle")
        sleep_copy.addWidget(self.lbl_sleep_title)
        self.lbl_sleep_desc = QLabel("等所有任务结束，安静地关机；中途有动静会重新计时")
        self.lbl_sleep_desc.setObjectName("toolDesc")
        self.lbl_sleep_desc.setWordWrap(True)
        sleep_copy.addWidget(self.lbl_sleep_desc)
        sleep_row.addLayout(sleep_copy, 1)
        self.btn_sleep_toggle = QPushButton("完成后关机")
        self.btn_sleep_toggle.setObjectName("renameBtn")
        self.btn_sleep_toggle.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_sleep_toggle.setToolTip("点一下开始静候：所有任务结束后替你关机")
        self.btn_sleep_toggle.clicked.connect(self._sleep_toggle_clicked)
        sleep_row.addWidget(self.btn_sleep_toggle)
        root.addWidget(self.sleep_tool)

        self.lbl_feedback = QLabel("")
        self.lbl_feedback.setObjectName("feedback")
        self.lbl_feedback.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        root.addWidget(self.lbl_feedback)

        self.lbl_hint = QLabel("")
        self.lbl_hint.setObjectName("hint")
        self.lbl_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        root.addWidget(self.lbl_hint)
        self._build_resume_view(root)
        self.apply_theme()

    def _build_resume_view(self, root):
        """同一面板内切页；推荐/Ask 留在原容器，续接有独立标题与固定操作条。"""
        for widget in (self.resume_body, self.loop_status_widget, self.lbl_resume_notice):
            root.removeWidget(widget)
        self.main_view = QWidget()
        main_layout = QVBoxLayout(self.main_view)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(9)
        while root.count():
            item = root.takeAt(0)
            if item.widget() is not None:
                main_layout.addWidget(item.widget())
            elif item.layout() is not None:
                main_layout.addLayout(item.layout())
            else:
                main_layout.addItem(item)
        self.btn_resume_entry = QPushButton("断点续接 · 有待接提醒")
        self.btn_resume_entry.setObjectName("resumeAuto")
        self.btn_resume_entry.setMinimumHeight(36)
        self.btn_resume_entry.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_resume_entry.clicked.connect(self.open_resume_view)
        self.btn_resume_entry.hide()
        main_layout.insertWidget(1, self.btn_resume_entry)
        self.lbl_resume_progress = QLabel("")
        self.lbl_resume_progress.setObjectName("resumeProgress")
        self.lbl_resume_progress.setTextFormat(Qt.TextFormat.PlainText)
        self.lbl_resume_progress.setWordWrap(True)
        self.resume_progress_scroll = QScrollArea()
        self.resume_progress_scroll.setObjectName("askScroll")
        self.resume_progress_scroll.setAutoFillBackground(False)
        self.resume_progress_scroll.viewport().setAutoFillBackground(False)
        self.resume_progress_scroll.setWidgetResizable(True)
        self.resume_progress_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.resume_progress_scroll.setWidget(self.lbl_resume_progress)
        self.resume_progress_scroll.hide()
        main_layout.insertWidget(2, self.resume_progress_scroll)
        # 主区外面套一层滚动容器。面板高度受屏幕限制，而内容会变（候选浮签展开 +
        # 五段对话、推荐条变长），一旦内容高过一屏，直接塞进固定高度的面板会被 Qt
        # 逐行压扁（2026-10-19 实机：候选对话压成一条条）。装不下时让它滚，不压。
        self.main_scroll = QScrollArea()
        self.main_scroll.setObjectName("panelScroll")
        self.main_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.main_scroll.setAutoFillBackground(False)
        self.main_scroll.viewport().setAutoFillBackground(False)
        self.main_scroll.setWidgetResizable(True)
        self.main_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.main_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.main_scroll.setWidget(self.main_view)
        root.addWidget(self.main_scroll, 1)

        self.resume_view = QWidget()
        page = QVBoxLayout(self.resume_view)
        page.setContentsMargins(0, 0, 0, 0)
        page.setSpacing(10)
        # 顶行只留标题和一个叉：返回主面板的路本来就有（关掉再从球进），
        # 多一个「返回」按钮反而让这一行跟别的弹窗对不上。
        nav = QHBoxLayout()
        self.lbl_resume_heading = QLabel("断点续接")
        self.lbl_resume_heading.setObjectName("head")
        nav.addWidget(self.lbl_resume_heading)
        nav.addStretch(1)
        self.btn_resume_close = QPushButton("✕")
        self.btn_resume_close.setObjectName("resumeCloseBtn")
        self.btn_resume_close.setToolTip("关掉这个面板")
        self.btn_resume_close.setFixedSize(24, 24)
        self.btn_resume_close.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_resume_close.clicked.connect(lambda: self.close_menu(user_dismissed=True))
        nav.addWidget(self.btn_resume_close)
        page.addLayout(nav)

        self.resume_scroll = QScrollArea()
        self.resume_scroll.setObjectName("askScroll")
        self.resume_scroll.setAutoFillBackground(False)
        self.resume_scroll.viewport().setAutoFillBackground(False)
        self.resume_scroll.setWidgetResizable(True)
        self.resume_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.resume_scroll.setMinimumSize(0, 0)
        content = QWidget()
        content.setAutoFillBackground(False)
        content.setObjectName("resumeContent")
        content.setStyleSheet("QWidget#resumeContent { background: transparent; }")
        content.setMinimumWidth(0)
        details = QVBoxLayout(content)
        details.setContentsMargins(0, 0, 0, 0)
        details.setSpacing(12)
        details.addWidget(self.resume_body)
        # 「这次接几轮」：一次性动作参数，不是设置（全局上限在知意设置页）。
        # 1 轮 = 现在的行为（只发一句「继续哈」）；N 轮 = 第一句发完，之后每轮说完自动接上，
        # ta 说收工就停下来问用户。
        self.resume_rounds_row = QFrame()
        self.resume_rounds_row.setObjectName("resumeRounds")
        rounds_layout = QVBoxLayout(self.resume_rounds_row)
        rounds_layout.setContentsMargins(12, 10, 12, 10)
        rounds_layout.setSpacing(6)
        rounds_title = QLabel("这次接几轮")
        rounds_title.setObjectName("toolTitle")
        rounds_layout.addWidget(rounds_title)
        rounds_row = QHBoxLayout()
        rounds_row.setSpacing(6)
        self.btn_resume_rounds_minus = QPushButton("−")
        self.lbl_resume_rounds = QLabel("1")
        self.btn_resume_rounds_plus = QPushButton("＋")
        for button, delta in ((self.btn_resume_rounds_minus, -1), (self.btn_resume_rounds_plus, 1)):
            button.setObjectName("loopStep")
            button.setFixedSize(30, 28)
            button.setCursor(Qt.CursorShape.PointingHandCursor)
            button.setToolTip("少一轮" if delta < 0 else "多一轮")
            button.clicked.connect(lambda _checked=False, step=delta: self._step_resume_rounds(step))
        self.lbl_resume_rounds.setObjectName("loopValue")
        self.lbl_resume_rounds.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_resume_rounds.setFixedWidth(34)
        rounds_row.addWidget(self.btn_resume_rounds_minus)
        rounds_row.addWidget(self.lbl_resume_rounds)
        rounds_row.addWidget(self.btn_resume_rounds_plus)
        self.lbl_resume_rounds_hint = QLabel("这次最多连着接这么几轮；ta 说做完了就停。")
        self.lbl_resume_rounds_hint.setObjectName("loopRoundsLabel")
        self.lbl_resume_rounds_hint.setWordWrap(True)
        rounds_row.addWidget(self.lbl_resume_rounds_hint, 1)
        rounds_layout.addLayout(rounds_row)
        details.addWidget(self.resume_rounds_row)
        # 现有按钮/配置原位搬迁，信号与端点不变。动作条独立于滚动内容。
        body_layout = self.resume_body.layout()
        actions = body_layout.takeAt(2).layout()
        actions.removeWidget(self.btn_resume_auto)
        self.resume_actions = QWidget()
        self.resume_actions.setLayout(actions)
        self.resume_actions.setFixedHeight(42)
        for button in (self.btn_resume_continue, self.btn_resume_dismiss, self.btn_loop_finish):
            button.setMinimumHeight(36)
        # 体型也算一层层级：颜色之外再加一个不细看就能分辨的差别。
        # 「继续哈」吃掉多余宽度当主角，「不用管」收窄成次要体量。
        actions.insertWidget(actions.indexOf(self.btn_resume_continue), self.btn_resume_continue, 1)
        self.btn_resume_dismiss.setFixedWidth(68)
        self.lbl_resume_status = QLabel("当前状态：暂无待接提醒")
        self.lbl_resume_status.setObjectName("resumeReason")
        self.lbl_resume_status.setTextFormat(Qt.TextFormat.PlainText)
        self.lbl_resume_status.setWordWrap(True)
        self.lbl_resume_status.setMinimumWidth(0)
        self.lbl_resume_status.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        body_layout.insertWidget(1, self.lbl_resume_status)
        self.resume_settings = QFrame()
        self.resume_settings.setObjectName("toolRow")
        settings = QVBoxLayout(self.resume_settings)
        settings.setContentsMargins(12, 10, 12, 10)
        settings.setSpacing(10)
        auto_title = QLabel("自动续接")
        auto_title.setObjectName("toolTitle")
        settings.addWidget(auto_title)
        auto_copy = QLabel("这是全局设置。打开后在后台续接，达到上限仍未恢复才提醒你。")
        auto_copy.setWordWrap(True)
        settings.addWidget(auto_copy)
        settings.addWidget(self.btn_resume_auto)
        limit_title = QLabel("每个窗口最多连续续接")
        limit_title.setObjectName("toolTitle")
        settings.addWidget(limit_title)
        limit_row = QHBoxLayout()
        self.btn_resume_max_minus = QPushButton("−")
        self.btn_resume_max_plus = QPushButton("＋")
        self.lbl_resume_max = QLabel("3 次")
        self.lbl_resume_max.setObjectName("loopValue")
        self.lbl_resume_max.setAlignment(Qt.AlignmentFlag.AlignCenter)
        for button, delta in ((self.btn_resume_max_minus, -1), (self.btn_resume_max_plus, 1)):
            button.setObjectName("loopStep")
            button.setFixedSize(36, 32)
            button.clicked.connect(lambda _checked=False, step=delta: self._step_resume_max(step))
        limit_row.addWidget(self.btn_resume_max_minus)
        limit_row.addWidget(self.lbl_resume_max, 1)
        limit_row.addWidget(self.btn_resume_max_plus)
        settings.addLayout(limit_row)
        # 循环真的跑起来时，一级面板只多出这一行状态与停止；平时不占地方。
        main_layout.addWidget(self.loop_status_widget)
        self.loop_status_widget.hide()
        self.lbl_resume_notice.hide()  # 旧 flash 保留协议，不再单独弹出/占位。
        self.lbl_resume_notice.setParent(self.main_view)
        details.addWidget(self.resume_settings)
        details.addStretch(1)
        # 续接的设置项不在这摆：开关与「最多连续续接几轮」都在知意设置页，
        # 球上只负责一件事——连续几轮都没接上时，把这事告诉你。
        # （设置两处都放，改一边不知道另一边生效没，这才是真麻烦。）
        self.resume_settings.hide()
        for label in (self.lbl_resume_from, self.lbl_resume_reason, self.lbl_resume_notice, self.lbl_loop_state):
            label.setTextFormat(Qt.TextFormat.PlainText)
            label.setMinimumWidth(0)
            label.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self.resume_scroll.setWidget(content)
        page.addWidget(self.resume_scroll, 1)
        # 续接设置常驻摆着，不再折进去：这页内容本来就少，藏起来只会让人滚动去找开关。
        page.addWidget(self.resume_actions)
        root.addWidget(self.resume_view)
        self.resume_view.hide()

    def open_resume_view(self):
        notice = self._resume_notice or {}
        if self.is_ask_open() or not notice or (not self._resume_enabled and notice.get("source") != "loop_confirm"):
            return  # 仅待办可进入；Ask 优先，关闭/恢复后不留空入口。
        self._resume_view_active = True
        self.main_scroll.hide()
        self.resume_view.show()
        self.resume_body.show()
        if not self._resume_notice:
            self._render_resume_empty()
        screen = self.ball.screen() or QApplication.primaryScreen()
        # 设置区搬去设置页之后这页内容不多，固定到 560 会留一大片空：按内容给个紧凑高度。
        height = min(360, max(300, screen.availableGeometry().height() - 48))
        self.setFixedHeight(height)
        self.setWindowOpacity(1.0)
        self._cancel_fade()
        self._resize_after_title_change()

    def close_resume_view(self):
        self._resume_view_active = False
        self.resume_view.hide()
        self.main_scroll.show()
        self.main_view.show()
        self.setMinimumHeight(0)
        self.setMaximumHeight(16777215)
        self._schedule_size_sync()

    def _render_resume_empty(self):
        self.lbl_resume_status.setText("当前状态：暂无待接提醒")
        self.lbl_resume_from.setText("有对话需要续接时，会在这里显示来源伙伴与窗口。")
        self.lbl_resume_reason.setText("现在不用处理；自动续接与有限次数设置仍可查看。")
        self.btn_resume_continue.setEnabled(False)
        self.btn_resume_continue.setText("继续哈")
        self.btn_resume_dismiss.setEnabled(False)
        self.btn_resume_dismiss.show()
        self._render_resume_rounds()
        self.btn_loop_finish.hide()

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #panel {{
                background: transparent; border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ color: {c['ink']}; background: transparent; }}
            QLabel#head {{ color: {c['accent_deep']}; font-size: 15px; font-weight: 700; }}
            QLabel#targetLabel {{ color: {c['sub']}; font-size: 10px; padding-bottom: 1px; }}
            QLabel#targetInfo {{ color: {c['sub']}; font-size: 10px; }}
            QPushButton#target {{
                color: {c['sub']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 9px;
                font-size: 11px; padding: 3px 8px;
            }}
            QPushButton#target:hover {{ color: {c['accent_deep']}; border-color: {c['accent']}; }}
            QPushButton#target:disabled {{ color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']}; }}
            QLabel#hint {{ color: {c['sub']}; font-size: 11px; padding: 2px 0; }}
            QLabel#sectionTitle {{ color: {c['accent_deep']}; font-size: 12px; font-weight: 700; padding-top: 2px; }}
            QFrame#recommendCard, QFrame#toolRow {{
                background: {c['surface_alt']}; border: 1px dashed {c['border']}; border-radius: 12px;
            }}
            QLabel#toolTitle {{ color: {c['accent_deep']}; font-size: 12px; font-weight: 700; }}
            QLabel#toolDesc {{ color: {c['sub']}; font-size: 10px; }}
            QLabel#cacheTime {{ color: {c['sub']}; font-size: 10px; }}
            QScrollArea#askScroll {{
                border: none; background: transparent;
            }}
            QScrollArea#askScroll > QWidget > QWidget {{
                background: transparent;
            }}
            #askBody {{
                background: transparent;
            }}
            QScrollArea#panelScroll {{
                border: none; background: transparent;
            }}
            QScrollArea#panelScroll > QWidget > QWidget {{
                background: transparent;
            }}
            QScrollBar:vertical {{
                width: 8px; background: transparent; margin: 3px 0;
            }}
            QScrollBar::handle:vertical {{
                min-height: 26px; background: #c9dfd3; border-radius: 4px;
            }}
            QScrollBar::handle:vertical:hover {{ background: {c['accent']}; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
            QLabel#askQuestion {{
                color: {c['ink']}; font-size: 15px; font-weight: 700;
                padding: 2px 3px 9px;
            }}
            QLabel#askBackground {{
                color: {c['sub_deep']}; font-size: 12px; padding: 0 3px 9px;
            }}
            QLabel#askRecommendation {{
                color: {c['accent_deep']}; font-size: 12px;
                background: {c['surface_alt']}; border-radius: 12px; padding: 10px 12px;
            }}
            QLabel#askSelectHint {{
                color: {c['sub']}; font-size: 11px; padding: 1px 3px 0;
            }}
            QLabel#askFrom {{
                color: {c['sub']}; font-size: 11px;
                padding: 0 3px 3px;
            }}
            QFrame#askOption {{
                background: {c['surface']}; border: 1px solid {c['border']}; border-radius: 14px;
            }}
            QFrame#askOption:hover {{
                border-color: {c['accent']};
            }}
            QFrame#askOption[selected="true"] {{
                background: {c['surface_alt']}; border: 2px solid {c['accent']};
            }}
            QFrame#askOption[selected="true"] QLabel#askChoice {{
                color: {c['accent_deep']}; font-weight: 700;
            }}
            QLabel#askChoice {{
                color: {c['ink']}; font-size: 14px; font-weight: 600;
            }}
            QLabel#askDescription {{
                color: {c['sub_deep']}; font-size: 12px; padding: 3px 12px 10px;
            }}
            QLabel#askRecommended {{
                color: {c['pink']}; font-size: 11px; padding: 9px 9px 0 0;
            }}
            QLineEdit#askInput {{
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 12px;
                font-size: 12px; padding: 8px 11px;
            }}
            QPushButton#askClose {{
                color: {c['sub_deep']}; background: transparent; border: none;
                border-radius: 8px; padding: 5px 8px; font-size: 11px;
            }}
            QPushButton#askClose:hover {{ background: {c['surface_alt']}; color: {c['accent_deep']}; }}
            QPushButton#askSkip, QPushButton#askSend {{
                min-height: 30px; border-radius: 11px; font-size: 12px; font-weight: 600; padding: 0 15px;
            }}
            QPushButton#askSkip {{
                color: {c['accent_deep']}; background: transparent; border: 1px solid {c['border']};
            }}
            QPushButton#askSend {{
                color: {c['accent_text']}; background: {c['accent']}; border: 1px solid {c['accent']};
            }}
            QPushButton#askSkip:hover {{ border-color: {c['accent']}; background: {c['surface_alt']}; }}
            QPushButton#askSend:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#askSkip:disabled, QPushButton#askSend:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QFrame#resumeCard {{
                background: {c['surface_alt']}; border: 1px solid {c['border']}; border-radius: 12px;
            }}
            QFrame#resumeRounds {{
                background: transparent; border: 1px solid {c['border']}; border-radius: 12px;
            }}
            QLabel#resumeFrom {{
                color: {c['accent_deep']}; font-size: 13px; font-weight: 700;
            }}
            QLabel#resumeReason {{ color: {c['sub_deep']}; font-size: 11px; }}
            QPushButton#resumeContinue {{
                min-height: 32px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 10px;
                font-size: 12px; font-weight: 700; padding: 0 18px;
            }}
            QPushButton#resumeContinue:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#resumeContinue:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QPushButton#resumeAuto {{
                min-height: 28px; color: {c['accent_deep']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 11px; font-weight: 600; padding: 0 12px;
            }}
            QPushButton#resumeAuto:checked {{
                color: {c['accent_text']}; background: {c['accent_deep']}; border-color: {c['accent_deep']};
            }}
            QPushButton#resumeAuto:disabled, QPushButton#resumeAuto:checked:disabled {{
                color: {c['sub_deep']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QPushButton#resumeAuto:hover {{ border-color: {c['accent']}; }}
            QPushButton#resumeAuto:focus {{ border-color: {c['pink']}; }}
            QLabel#resumeProgress {{ color: {c['accent_deep']}; background: {c['surface_alt']};
                border-radius: 10px; padding: 8px; font-size: 11px; }}
            QPushButton#loopStep:disabled {{ color: {c['sub']}; background: {c['surface_alt']}; }}
            QPushButton#resumeDismiss {{
                min-height: 28px; color: {c['sub']}; background: transparent;
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 10px; font-weight: 500; padding: 0 6px;
            }}
            QPushButton#resumeDismiss:hover {{ background: {c['surface']}; border-color: {c['accent']}; color: {c['accent_deep']}; }}
            QPushButton#resumeCloseBtn {{
                color: {c['sub']}; background: transparent; border: none;
                border-radius: 12px; font-size: 13px;
            }}
            QPushButton#resumeCloseBtn:hover {{ background: {c['danger_bg']}; color: {c['pink']}; }}
            QPushButton#resumeDismiss:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QLabel#resumeNotice {{ color: {c['pink']}; font-size: 11px; font-weight: 600; padding: 2px 2px 0; }}
            QLabel#loopRoundsLabel {{ color: {c['sub']}; font-size: 11px; }}
            QPushButton#loopStep {{
                color: {c['accent_deep']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 8px;
                font-size: 12px; font-weight: 700; min-height: 20px;
            }}
            QPushButton#loopStep:hover {{ border-color: {c['accent']}; }}
            QLabel#loopValue {{ color: {c['ink']}; font-size: 12px; font-weight: 600; }}
            QLabel#loopState {{ color: {c['accent_deep']}; font-size: 11px; font-weight: 600; }}
            QPushButton#loopBtn {{
                color: {c['pink']}; background: transparent;
                border: 1px solid {c['border']}; border-radius: 8px;
                font-size: 11px; font-weight: 600; padding: 2px 10px;
            }}
            QPushButton#loopBtn:hover {{ border-color: {c['pink']}; }}
            QPushButton#loopFinish {{
                min-height: 28px; color: {c['sub_deep']}; background: transparent;
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 11px; font-weight: 600; padding: 0 12px;
            }}
            QPushButton#loopFinish:hover {{ border-color: {c['accent']}; color: {c['accent_deep']}; }}
            QPushButton#refreshBtn, QPushButton#renameBtn, QPushButton#sayBtn {{
                min-height: 28px; min-width: 88px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 10px;
                font-size: 11px; font-weight: 600; padding: 0 11px;
            }}
            QPushButton#refreshBtn:hover, QPushButton#renameBtn:hover, QPushButton#sayBtn:hover {{
                background: {c['accent_deep']}; border-color: {c['accent_deep']};
            }}
            QPushButton#refreshBtn:disabled, QPushButton#renameBtn:disabled, QPushButton#sayBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            /* 清空：同一套绿色，只是窄一档，退到「刷新推荐」旁边不抢位置 */
            QPushButton#clearBtn {{
                min-height: 28px; min-width: 42px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 10px;
                font-size: 11px; font-weight: 600; padding: 0 9px;
            }}
            QPushButton#clearBtn:hover {{
                background: {c['accent_deep']}; border-color: {c['accent_deep']};
            }}
            QPushButton#clearBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            /* 还原：跟旁边那些次要按钮同一套字号与圆角，只把色压淡一档 */
            QPushButton#undoBtn {{
                min-height: 28px; color: {c['accent_deep']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 9px;
                font-size: 11px; font-weight: 600; padding: 0 12px;
            }}
            QPushButton#undoBtn:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QPushButton#undoBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QLabel#feedback {{ color: {c['pink']}; font-size: 11px; font-weight: 600; }}
            QLabel#rec {{
                background: {c['surface']}; color: {c['ink']};
                border: 1px solid {c['border']}; border-radius: 14px; font-size: 13px;
            }}
            QLabel#rec:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QLabel#rec:focus {{ border: 2px solid {c['accent']}; }}
        """)
        if self.target_menu is not None:
            self.target_menu.apply_theme()

    def set_ask_flower_enabled(self, enabled):
        """按配置显隐「问问小花」入口；提问/断联模式下始终隐藏。"""
        self._ask_flower_enabled = bool(enabled)
        if not hasattr(self, "ask_flower_tool"):
            return
        visible = self._ask_flower_enabled and not self.is_ask_open()
        self.ask_flower_tool.setVisible(visible)
        self.ask_flower_tool.setEnabled(self._ask_flower_enabled)
        if self.isVisible():
            self._schedule_size_sync()

    def prepare_for_show(self):
        # 知意首版：关键提问 + 球内目标跟随与推荐，其余旧入口不展示。
        if APP_ONLY_ASK:
            self._set_window_stays_on_top(True)
            self._needs_reanchor = True
            self._user_dragged = False
            self._flash("")
            self._set_ask_mode(False)
            # 目标与推荐走 App 桥：先渲染缓存/占位，最新快照由轮询带回（不主动触发一次模型调用）。
            if not self.is_ask_open():
                self._update_target()
                cached = self.ball.cached
                if cached and cached.get("items"):
                    self._render_items(cached["items"])
                else:
                    self._render_empty()
            return
        # 普通面板/提问态恢复为原来的互动层；续接小条由 /resume/state 轮询驱动，不在这里管。
        self._set_window_stays_on_top(True)
        self._needs_reanchor = True
        self._user_dragged = False
        self._flash("")
        self._update_target()
        self._sync_target_state()
        cached = self.ball.cached
        if cached and cached.get("items"):
            self._render_items(cached["items"])
        else:
            self._render_empty()
        self.load_cache_async()

    # ── 提问模式：推荐条让位，作答后恢复原缓存 ──
    def is_ask_open(self):
        return self._ask_entry is not None and not self._ask_finished

    def _set_window_stays_on_top(self, enabled):
        """只让断联卡成为一次性的前台提醒，切换程序后按普通工具窗自然让位。"""
        flag = Qt.WindowType.WindowStaysOnTopHint
        enabled = bool(enabled)
        current = bool(self.windowFlags() & flag)
        if current == enabled:
            return
        was_visible = self.isVisible()
        position = self.pos()
        self.setWindowFlag(flag, enabled)
        if was_visible:
            # Qt 改顶层 flag 时会暂时隐藏窗口，保住用户已经拖好的位置并恢复显示。
            self.move(position)
            self.show()

    def _fade_allowed(self):
        # 提问态保持实体：读题/作答是强互动，不参与鼠标离开淡出。
        # 续接小条是常驻内容，跟随面板普通淡出即可，不再单独挡住。
        return not self.is_ask_open() and not self._resume_view_active

    def show_ask(self, ask):
        ask_id = ask.get("askId") if isinstance(ask, dict) else ""
        if not ask_id or self._ask_responding or self._ask_finished:
            return
        # 断联卡让位给提问后，提问重新回到原来的互动层。
        self._set_window_stays_on_top(True)
        if self._ask_entry:
            if ask_id == self._ask_entry.get("askId"):
                # 当前题正在显示或等待失败重试时，不用新题覆盖输入状态；下一轮再处理。
                return
            # 新提问（askId 不同）：用最新题替换当前题，仍保持 ask 模式
            #（旧提问由服务端 TTL / 隐式跳过兜底，不丢）
            self._ask_entry = None
        self._ask_entry = dict(ask)
        self._ask_user_hidden = False
        # 提问态保持实体：若此前已淡出/正在淡出，立即拉回全不透明并取消排期
        self.setWindowOpacity(1.0)
        self._cancel_fade()
        self._ask_finished = False
        self._ask_responding = False
        self._needs_reanchor = not self._user_dragged
        self._set_ask_mode(True)
        self._render_ask(self._ask_entry)
        self.ball._ask_emitting = True  # 提问挂起：花朵持续散发花瓣
        self.ball._set_fusion_panel_state("ask")
        self._ask_pulse_title()

    def _ask_pulse_title(self, rounds=3):
        """提问弹出时标题颜色脉冲（accent_deep ↔ pink），提醒面板内容已切换成提问。"""
        c = THEME_COLORS[self.ball.theme_mode]
        step_ms = 170
        for i in range(rounds * 2):
            on = i % 2 == 0
            QTimer.singleShot(
                i * step_ms,
                lambda on=on: self.lbl_head.setStyleSheet(f"color: {c['pink']};" if on else ""),
            )

    def _set_ask_mode(self, active):
        if not active and self._resume_view_active:
            return
        if active:
            if self._resume_view_active:
                self.close_resume_view()
            self.btn_resume_entry.hide()
            self.resume_progress_scroll.hide()
            entry = self._ask_entry or {}
            source_title = str(entry.get("sessionTitle") or "").strip()
            source_agent = str(entry.get("agentName") or "").strip()
            heading = f"「{source_title}」" if source_title else ""
            if source_agent:
                heading = f"{source_agent} ·{heading}" if heading else source_agent
            self.lbl_head.setText(heading or "来源对话未命名")
            self.btn_ask_close.show()
            self.setMinimumHeight(0)  # 清掉上一轮 settle 残留的最小高度
            for widget in (
                self.lbl_target_label, self.btn_target, self.lbl_target_info,
                self.recommend_body,
                self.lbl_section, self.say_tool, self.ask_flower_tool, self.rename_tool, self.polish_tool, self.compaction_tool, self.lbl_hint,
            ):
                widget.hide()
            self.target_menu.hide()
            # 提问是二级弹窗：主面板的其他区块（推荐、工具、排队发送、静候关机）全收起来，
            # 只留问题本身。以前是逐个数着藏，后加的区块一忘就露在下半截（排队发送占着底、
            # 再往下是静候关机）；面板内容一长还会多出一条外层长滚动条，看着像两个窗口粘在一起。
            for name in ("queue_tool", "sleep_tool", "lbl_feedback"):
                widget = getattr(self, name, None)
                if widget is not None:
                    widget.hide()
            # 外层（主面板那一层）不长滚动条：提问自己要不要滚，它自己那一层说了道。
            self.main_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
            self.ask_scroll.show()
            self.ask_input.show()
            self.btn_ask_skip.show()
            self.btn_ask_send.show()
            self.btn_ask_send.setText("确认发送")
            self.resume_body.hide()  # 提问占台面：续接小条让位
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry() if screen else None
            max_height = ASK_PANEL_MAX_HEIGHT
            if geo is not None:
                max_height = min(max_height, max(280, int(geo.height() * 0.60)))
            self.setMaximumHeight(max_height)
            # 滚动区不预先吃满整个可用高度：先给一个紧凑的初始值，
            # 真正的高度等选项填完、布局稳定后由 _settle_ask_height 按内容算。
            # （以前这里直接取 max_height-124，内容少时就是一大片空白配一条长滚动条。）
            self.ask_scroll.setFixedHeight(160)
            self.ask_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
            self._set_ask_controls_enabled(not self._ask_responding and not self._ask_finished)
            self.app_idle_notice.hide()
            # QScrollArea 的 sizeHint 不反映内容高度，直接 adjustSize 会让窗口停在小高度，
            # 长内容时选项被压在折叠区。等两轮布局稳定后按内容真实高度撑起面板。
            QTimer.singleShot(0, lambda: QTimer.singleShot(0, self._settle_ask_height))
        else:
            self._sync_resume_entry()
            # 提问刚让位：把提问期间到的断点提醒补上。延后一拍，等收面板的收尾动作先跑完，
            # 不然刚打开的续接专页会被同一个收尾动作顺手收掉。
            QTimer.singleShot(250, self._flush_resume_after_ask)
            self.setMaximumHeight(16777215)
            self.setMinimumHeight(0)
            # 退出提问，主面板那一层恢复成「装不下才滚」。
            self.main_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
            self.lbl_head.setText("解语花")
            self.btn_ask_close.hide()
            if APP_ONLY_ASK:
                # App 模式：只放回真正开放的入口（目标 + 推荐 + 朗读），不把旧工具重新弹出来。
                self._configure_app_mode()
            else:
                for widget in (
                    self.lbl_target_label, self.btn_target, self.lbl_target_info,
                    self.recommend_body,
                    self.lbl_section, self.say_tool, self.rename_tool, self.polish_tool, self.compaction_tool, self.lbl_hint,
                ):
                    widget.show()
                self.set_ask_flower_enabled(self._ask_flower_enabled)
            self.ask_scroll.hide()
            self.ask_input.hide()
            self.btn_ask_skip.hide()
            self.btn_ask_send.hide()
            self.btn_ask_send.setText("发送")
            self.lbl_ask_select_hint.hide()
            # 提问期间收起来的工具行（排队发送、静候关机）回到台面。
            for name in ("queue_tool", "sleep_tool", "lbl_feedback"):
                widget = getattr(self, name, None)
                if widget is not None:
                    widget.show()
            self._set_ask_controls_enabled(False)
            if APP_ONLY_ASK:
                # 提问结束，之前让位的续接小条重新亮出来（若桥上有提醒）。
                if self._resume_notice:
                    self.show_resume_strip(self._resume_notice)

    def _settle_ask_height(self):
        """提问态布局稳定后，按内容真实高度调整面板：
        滚动区跟着内容长，内容少就贴合（不留一大片空白），超过上限才封顶并在里面滚。"""
        if not self.is_ask_open() or self._ask_responding or self._ask_finished:
            return
        max_height = self.maximumHeight()
        if max_height <= 0 or max_height >= 16777215:
            return
        body = self.ask_scroll.widget()
        if body is None:
            return
        body_layout = body.layout()
        if body_layout is not None:
            body_layout.activate()
        content_h = max(1, body.sizeHint().height())
        fixed_h = 176  # 标题 + 输入框 + 按钮 + feedback + 边距 + 间距（近似）
        avail = max(120, max_height - fixed_h)
        scroll_h = min(avail, max(120, content_h))
        need_scroll = content_h > scroll_h
        self.ask_scroll.setFixedHeight(scroll_h)
        # 不需要滚的时候就把滚动条关掉：让它反复出现/消失，内容宽度会跟着变一次，
        # 高度又再变一次，表现就是面板一直在抽。
        self.ask_scroll.setVerticalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAsNeeded if need_scroll
            else Qt.ScrollBarPolicy.ScrollBarAlwaysOff
        )
        target = min(max_height, max(300, fixed_h + scroll_h))
        if target <= 0 or target == self.height():
            return
        # 用 setFixedHeight 锁死：move_to_ball 里的 adjustSize 不会把高度压回
        #（QScrollArea 的 sizeHint 是默认小值，直接 resize 会被 adjustSize 覆盖）
        self.setFixedHeight(target)
        self.move_to_ball()

    def _clear_ask_options(self):
        while self.ask_options_grid.count():
            item = self.ask_options_grid.takeAt(0)
            widget = item.widget()
            if widget:
                widget.hide()
                widget.deleteLater()
        self._ask_option_frames = []

    def _render_ask(self, ask):
        self._clear_buttons()
        self._clear_ask_options()
        question_text = str(ask.get("question") or "").strip()
        question_title = str(ask.get("header") or "").strip()
        # 标题和问题经常是同一句话（标题换个说法再讲一遍），两层并排就成了重复。
        # 这里去重：题干里已经包含标题，就不再单独占一行。
        title_repeats = bool(question_title) and (
            question_title in question_text or question_text.startswith(question_title.rstrip("？?。.!！"))
        )
        self.lbl_ask_from.setText(question_title if question_title and not title_repeats else "")
        self.lbl_ask_from.setVisible(bool(question_title) and not title_repeats)
        self.lbl_ask_question.setText(question_text or question_title)
        background = str(ask.get("background") or "").strip()
        self.lbl_ask_background.setText("背景 · " + background if background else "")
        self.lbl_ask_background.setVisible(bool(background))
        recommendation = str(ask.get("recommendation") or "").strip()
        reason = str(ask.get("reason") or "").strip()
        self.lbl_ask_recommendation.setText(
            "建议 · " + recommendation + ("\n理由 · " + reason if reason else "")
            if recommendation else ""
        )
        self.lbl_ask_recommendation.setVisible(bool(recommendation))
        options = ask.get("options") if isinstance(ask.get("options"), list) else []
        self._ask_selection_mode = "multiple" if ask.get("selectionMode") == "multiple" else "single"
        self._ask_selected_indices = []
        self._ask_option_labels = []
        if self._ask_selection_mode == "multiple":
            min_value = ask.get("minSelections")
            max_value = ask.get("maxSelections")
            self._ask_min_selections = min_value if isinstance(min_value, int) and min_value > 0 else 1
            self._ask_max_selections = max_value if isinstance(max_value, int) and max_value > 0 else len(options)
            self._ask_max_selections = max(self._ask_min_selections, min(self._ask_max_selections, len(options)))
        else:
            self._ask_min_selections = 1
            self._ask_max_selections = 1
        # 选项永远 1 列竖排：每个选项一个整行横条胶囊（跟普通推荐条同款排法）
        for option in options:
            if not isinstance(option, dict):
                continue
            original_label = str(option.get("label") or "").strip()
            if not original_label:
                continue
            recommended = bool(option.get("recommended"))
            display_label = original_label
            option_index = len(self._ask_option_labels)
            self._ask_option_labels.append(original_label)
            frame = AskOptionFrame(
                display_label or original_label,
                str(option.get("description") or "").strip(),
                recommended,
                self._ask_selection_mode,
            )
            frame.choice_label.clicked.connect(
                lambda index=option_index: self._toggle_ask_option(index)
            )
            # 整条可点：点标题、点说明、点旁边留白都算选这一项
            frame.clicked.connect(
                lambda index=option_index: self._toggle_ask_option(index)
            )
            self.ask_options_grid.addWidget(frame, option_index, 0)
            self._ask_option_frames.append(frame)
        self.ask_input.clear()
        self.ask_input.setPlaceholderText("补充说明，可不填")
        self.lbl_feedback.setText("")
        self._update_ask_selection_ui()
        self._set_ask_controls_enabled(not self._ask_responding and not self._ask_finished)
        self._sync_size()
        self.keep_current_position(full_height=True)

    def _toggle_ask_option(self, index):
        if not self._ask_entry or self._ask_responding or self._ask_finished:
            return
        if index < 0 or index >= len(self._ask_option_labels):
            return
        if self._ask_selection_mode != "multiple":
            self._ask_selected_indices = [] if index in self._ask_selected_indices else [index]
            self._update_ask_selection_ui()
            return
        if index in self._ask_selected_indices:
            self._ask_selected_indices.remove(index)
        elif len(self._ask_selected_indices) >= self._ask_max_selections:
            self._flash(f"最多选择 {self._ask_max_selections} 项")
            return
        else:
            self._ask_selected_indices.append(index)
        self._ask_selected_indices.sort()
        self._update_ask_selection_ui()

    def _update_ask_selection_ui(self):
        selected = set(self._ask_selected_indices)
        for index, frame in enumerate(self._ask_option_frames):
            frame.set_selected(index in selected)
        count = len(self._ask_selected_indices)
        if self._ask_selection_mode == "multiple":
            self.lbl_ask_select_hint.setText(
                f"可多选 · 已选 {count}/{self._ask_max_selections}"
            )
        else:
            self.lbl_ask_select_hint.setText(f"单选 · 已选 {count}")
        self.lbl_ask_select_hint.show()
        self.btn_ask_send.setText("确认发送")

    def _set_ask_controls_enabled(self, enabled):
        for frame in self._ask_option_frames:
            frame.setEnabled(bool(enabled))
            frame.choice_label.setEnabled(bool(enabled))
        self.ask_input.setEnabled(bool(enabled))
        self.btn_ask_skip.setEnabled(bool(enabled))
        self.btn_ask_send.setEnabled(bool(enabled))

    def _send_custom_ask(self):
        value = normalize_custom_answer(self.ask_input.text())
        if self._ask_selected_indices:
            if len(self._ask_selected_indices) < self._ask_min_selections:
                self._flash(f"至少选择 {self._ask_min_selections} 项")
                return
            choices = [self._ask_option_labels[index] for index in self._ask_selected_indices]
            choice = choices if self._ask_selection_mode == "multiple" else choices[0]
            self._respond_ask("option", choice, note=value)
            return
        if value:
            self._respond_ask("custom", value)
            return
        self._flash("请选择选项或填写说明后再确认发送")

    def _respond_ask(self, mode, choice, note=""):
        if not self._ask_entry or self._ask_responding or self._ask_finished:
            return
        ask_id = self._ask_entry.get("askId") or ""
        self._ask_responding = True
        self._ask_response_mode = mode
        self._ask_response_choice = choice
        self._set_ask_controls_enabled(False)
        self._flash("正在发送…")

        def worker():
            payload = {
                "askId": ask_id,
                "mode": mode,
                "choice": choice,
                "ok": False,
                "error": "暂时无法送达，请重试。",
            }
            try:
                data = api_post("/ask/respond", {
                    "askId": ask_id,
                    "mode": mode,
                    "choice": choice,
                    "note": note,
                }, timeout=20)
                payload.update(data or {})
                payload["askId"] = ask_id
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"出错了 ({e.code})"
                except Exception:
                    payload["error"] = f"出错了 ({e.code})"
            except Exception:
                pass
            try:
                self.ask_response_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-ask-response").start()

    def _apply_ask_response(self, payload):
        if not self._ask_entry or payload.get("askId") != self._ask_entry.get("askId"):
            return
        self._ask_responding = False
        if payload.get("ok"):
            self._ask_finished = True
            mode = payload.get("mode") or self._ask_response_mode
            choice = payload.get("choice") or self._ask_response_choice
            if isinstance(choice, list):
                choice_text = "、".join(str(item) for item in choice)
            else:
                choice_text = str(choice)
            self._flash("已跳过" if mode == "skip" else f"已发送 · {choice_text}")
            self._set_ask_controls_enabled(False)
            completed_ask_id = self._ask_entry.get("askId")
            # 作答完成不恢复推荐面板，短暂反馈后直接收起成传音樱
            QTimer.singleShot(
                650,
                lambda ask_id=completed_ask_id: self.finish_ask_and_collapse(ask_id),
            )
        else:
            self._set_ask_controls_enabled(True)
            self._flash(payload.get("error") or "发送失败，再试一次")

    def finish_ask_and_collapse(self, expected_ask_id=None):
        """提问作答完成 / ask 判定可关闭（隐式跳过、过期等）后：清理提问态并收起面板回传音樱。

        用户已通过面板作答或直接在主对话继续，不需要再弹推荐面板；
        恢复推荐交给下次手动打开面板时 prepare_for_show 重新渲染。"""
        if not self._ask_entry or self._ask_responding:
            return
        if expected_ask_id and self._ask_entry.get("askId") != expected_ask_id:
            return
        self._ask_entry = None
        self._ask_finished = False
        self._ask_user_hidden = False
        self._ask_response_mode = ""
        self._ask_response_choice = ""
        self._ask_selection_mode = "single"
        self._ask_min_selections = 1
        self._ask_max_selections = 1
        self._ask_selected_indices = []
        self._ask_option_labels = []
        self._needs_reanchor = False
        self.ball._ask_emitting = False  # 提问结束，停止散发花瓣
        self._set_ask_mode(False)
        self._flash("")
        self.close_menu()
        self.ball._set_fusion_panel_state("none")

    # ── 断联续接小条：App 推 notice 才亮，球只管把用户意图回传 ──
    def _resume_notice_sig(self, notice):
        # 同一条提醒的指纹：会话 + 次数 + 文案。任一项变了就是新一条，要重渲染。
        return (
            str(notice.get("sessionId") or ""),
            notice.get("attempt"),
            str(notice.get("reason") or ""),
            str(notice.get("title") or ""),
            str(notice.get("agentName") or ""),
            str(notice.get("source") or ""),
        )

    @staticmethod
    def _resume_source_text(title, agent_name, first_message="", opened_at=""):
        """小条抬头：窗口名 → 伙伴名 → 开头那句 → 开窗时间。

        后两层是给「宿主还没给这段对话起名」的情况准备的。以前只写
        「一个还没标题的对话」，等于什么都没说：用户既认不出是哪个窗，
        也没法判断要不要接。
        """
        window_title = str(title or "").strip()
        agent = str(agent_name or "").strip()
        if window_title and agent:
            return f"来自窗口：{window_title}（{agent}）"
        if window_title:
            return f"来自窗口：{window_title}"
        if agent:
            return f"来自：{agent} 的对话"
        opening = _opening_snippet(first_message)
        if opening:
            return f"来自：一段还没起名的对话（开头是「{opening}」）"
        clock = str(opened_at or "").strip()
        if clock:
            return f"来自：{clock} 开的那段对话"
        return "来自：一段还没起名的对话"

    def _render_resume_notice(self, notice):
        """小条文案：抬头写窗口名与伙伴名，正文带原因与已试次数。"""
        reason = str(notice.get("reason") or "").strip() or "这一轮停在半路了，没往下说。"
        attempt = notice.get("attempt")
        self.lbl_resume_from.setText(
            self._resume_source_text(
                notice.get("title"),
                notice.get("agentName"),
                notice.get("firstMessage"),
                notice.get("openedAt"),
            )
        )
        text = reason
        if isinstance(attempt, int) and attempt > 0:
            maximum = notice.get("maxConsecutive") or self._resume_max_consecutive
            # 球上只说一件事：这个窗口连续几轮都没接上（设置在上限多少轮）。
            text = f"这个窗口连续 {attempt} 轮都没接上，已经到设置的 {maximum} 轮上限。"
            if reason and reason != "这一轮停在半路了，没往下说。":
                text = f"{text}\n{reason}"
        elif isinstance(attempt, int):
            # 手动模式第一次发现就报，还没续过：说「连续 0 轮」就是胡说。
            text = "这个窗口停在半路了，要接着往下说吗？"
            if reason and reason != "这一轮停在半路了，没往下说。":
                text = f"{text}\n{reason}"
        self.lbl_resume_reason.setText(text)
        self.lbl_resume_status.setText("当前状态：等待你决定是否续接")
        self.btn_resume_continue.setEnabled(not self._resume_sending)
        self.btn_resume_dismiss.setEnabled(True)
        # 循环跑到收工话时，这张卡问的是“还接着吗”，得换成「接着来 / 就到这吧」，
        # 并把循环设置藏起来（这时不该让人再去调轮数）。
        is_loop_confirm = str(notice.get("source") or "") == "loop_confirm"
        self.btn_loop_finish.setVisible(is_loop_confirm)
        self.btn_resume_dismiss.setVisible(not is_loop_confirm)
        self._render_resume_rounds()
        self._render_resume_auto()

    def _render_resume_rounds(self):
        """「这次接几轮」那一行。按钮上直接写出这次要接几轮，别让人自己对两处。"""
        has_notice = bool(self._resume_notice)
        self.lbl_resume_rounds.setText(str(self._resume_rounds))
        self.btn_resume_rounds_minus.setEnabled(has_notice and self._resume_rounds > 1)
        self.btn_resume_rounds_plus.setEnabled(has_notice and self._resume_rounds < 10)
        is_loop_confirm = str((self._resume_notice or {}).get("source") or "") == "loop_confirm"
        if is_loop_confirm:
            self.btn_resume_continue.setText("接着来")
        elif self._resume_rounds > 1:
            self.btn_resume_continue.setText(f"接 {self._resume_rounds} 轮")
        else:
            self.btn_resume_continue.setText("继续哈")

    def _step_resume_rounds(self, delta):
        value = max(1, min(10, self._resume_rounds + int(delta)))
        if value == self._resume_rounds:
            return
        self._resume_rounds = value
        self._render_resume_rounds()

    def _render_resume_auto(self):
        self.btn_resume_auto.setChecked(self._resume_auto)
        self.btn_resume_auto.setText("自动续接：开" if self._resume_auto else "自动续接：关")
        available = self._resume_enabled and not self._resume_config_sending
        self.btn_resume_auto.setEnabled(available)
        self.lbl_resume_max.setText(f"{self._resume_max_consecutive} 次")
        self.btn_resume_max_minus.setEnabled(available and self._resume_max_consecutive > 1)
        self.btn_resume_max_plus.setEnabled(available and self._resume_max_consecutive < 10)

    def _sync_resume_entry(self):
        ask_open = self.is_ask_open()
        self.btn_resume_entry.setVisible(bool(self._resume_notice) and not ask_open)
        self.resume_progress_scroll.setVisible(bool(self._resume_enabled and self._resume_progress) and not ask_open)

    def _render_resume_progress(self):
        lines = []
        for item in self._resume_progress:
            who = str(item.get("agentName") or "伙伴")
            title = str(item.get("title") or _opening_snippet(item.get("firstMessage")) or "未命名窗口")
            source = QFontMetrics(self.lbl_resume_progress.font()).elidedText(
                f"{who} ·「{title}」", Qt.TextElideMode.ElideRight, 270)
            attempt = item.get("attempt", 0)
            maximum = item.get("maxConsecutive") or self._resume_max_consecutive
            # 一行只讲一件事：已发出几句 / 计划几轮。
            # sent/total 是新协议；旧协议只有失败计数（手动时恒为 0），不能拿它冒充进度。
            sent = item.get("sent")
            total = item.get("total")
            if sent is None:
                sent = attempt
                total = maximum
            state = {"waiting": "已发送继续哈", "failed": "续接未送达", "limit": "已达续接上限",
                     "done": "已连着接"}.get(item.get("status"), "续接中")
            if total:
                lines.append(f"{source}\n{state} {sent}/{total}")
            else:
                # 没有计划轮数（手动只发一句）：别摆 0/3，那是全局重试上限，跟这里无关。
                lines.append(f"{source}\n{state}，正在等回应")
        self.lbl_resume_progress.setText("\n\n".join(lines))
        self.resume_progress_scroll.setFixedHeight(min(120, max(48,
            QFontMetrics(self.lbl_resume_progress.font()).lineSpacing() * (3 * len(lines) - 1) + 20)))
        self.lbl_resume_progress.setToolTip("\n".join(
            f"{item.get('agentName') or '伙伴'} · {item.get('title') or '未命名窗口'}"
            for item in self._resume_progress))
        self._sync_resume_entry()
        if self.isVisible() and not self._resume_view_active:
            self._schedule_size_sync()

    def _step_resume_max(self, delta):
        if not self._resume_enabled or self._resume_config_sending:
            return
        previous = self._resume_max_consecutive
        self._resume_max_consecutive = max(1, min(10, previous + delta))
        if previous == self._resume_max_consecutive:
            return
        self._resume_config_sending = True
        self._render_resume_auto()
        self.lbl_resume_status.setText("正在提交续接设置…")

        def done(ok, error):
            self._resume_config_sending = False
            if not ok:
                self._resume_max_consecutive = previous
            self._render_resume_auto()
            self.lbl_resume_status.setText("设置已提交，等待同步" if ok else f"设置未保存，可重试\n{error}")
        self._post_resume_action({"action": "config", "config": {
            "maxConsecutive": self._resume_max_consecutive}}, on_done=done)

    def show_resume_strip(self, notice):
        """轮询到 notice 非 null：把常驻小条亮出来（面板收着时一并带出来）。"""
        if not self._resume_enabled and notice.get("source") != "loop_confirm":
            return
        sig = self._resume_notice_sig(notice)
        if sig == self._resume_hidden_sig:
            return  # 用户刚点了「不用管」，同一条不再打回脸上
        self._resume_notice = dict(notice)
        is_new = sig != self._resume_sig
        if is_new:
            self._resume_sig = sig
            self._render_resume_notice(notice)
        self.btn_resume_entry.setText("断点续接 · 有待接提醒")
        self._sync_resume_entry()
        if self.is_ask_open():
            # 提问优先：问题在台面上时小条让位（跟旧断联卡一个规矩），答完 _set_ask_mode(False) 再亮。
            # 但提醒不能跟着提问一起沉底：提问期间新到的这一条先记下来，提问一结束就补上。
            # （2026-10-23 实机：Ask 开着时窗口断点，提醒既没弹、入口也没露，问完就再也没人提起。）
            self._resume_ask_pending_sig = sig
            return
        if is_new and sig != self._resume_deferred_sig:
            self.open_resume_view()
        elif self._resume_view_active:
            self.resume_body.show()
        # 提醒是强互动，别让它半透明待着：拉回全显、取消排期淡出。
        self.setWindowOpacity(1.0)
        self._cancel_fade()

    def _raise_resume_panel(self):
        """把球和面板一起带到眼前。

        球不在视线里、或面板被球盖住时，用户眼里就是"什么都没有"，
        容易误以为提醒没送到（2026-10-23 实机踩过这个误会）。"""
        self.ball.show()
        ensure = getattr(self.ball, "_ensure_visible", None)
        if callable(ensure):
            ensure()
        self.move_to_ball()
        self.show()
        self.raise_()
        self.ball.raise_()

    def _flush_resume_after_ask(self):
        """提问刚让位：把提问期间到的断点提醒补上。

        提问优先是对的，但提醒不能跟着提问一起沉底——提问结束的那一刻，
        这条提醒就得让用户看见：面板叫出来，续接专页打开。"""
        sig = self._resume_ask_pending_sig
        self._resume_ask_pending_sig = None
        if not sig or not self._resume_notice:
            return
        if self.is_ask_open():
            return  # 提问还在，别抢台面
        if sig != self._resume_sig:
            return  # 已经不是那一条了（多半已经被处理掉）
        if sig == self._resume_hidden_sig:
            return  # 用户点过「不用管」，同一条不再打回脸上
        self._sync_resume_entry()
        if not self._resume_view_active:
            self.open_resume_view()
        self._raise_resume_panel()

    def collapse_resume_strip(self):
        """notice 变回 null 且没有在途请求：收起小条，等下一次提醒。"""
        self._resume_notice = None
        self._resume_sig = None
        self.btn_resume_entry.hide()
        if self._resume_view_active:
            self.close_resume_view()

    def _post_resume_action(self, payload, on_done=None):
        """三个按钮的意图统一从这里 POST /resume/action，回包用信号带回主线程。"""
        self._resume_action_inflight += 1
        # 记下本球刚发过的动作：若回包丢了，轮询会看到桥上的自己，别当成待办再发一次。
        self._resume_last_attempt = self._resume_action_key(payload)

        def worker():
            result = {"ok": False, "error": "连不上解语花，看看插件开着没", "on_done": on_done}
            try:
                data = api_post("/resume/action", payload, timeout=8)
                if data and data.get("ok"):
                    result = {"ok": True, "on_done": on_done, "actionSeq": int(data.get("actionSeq") or 0)}
                else:
                    result = {"ok": False, "error": (data or {}).get("error") or "没发出去", "on_done": on_done}
            except Exception:
                pass  # 网络异常安静处理，界面在回调里给一句人话
            if self._closed:
                return
            try:
                self.resume_action_ready.emit(result)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-resume-action").start()

    def _apply_resume_action_result(self, payload):
        self._resume_action_inflight = max(0, self._resume_action_inflight - 1)
        if payload.get("ok"):
            seq = int(payload.get("actionSeq") or 0)
            if seq:
                self._resume_action_seq = seq  # 记住已发出的序号，轮询不再补发
        on_done = payload.get("on_done")
        if callable(on_done):
            on_done(bool(payload.get("ok")), str(payload.get("error") or ""))

    def _resume_send_continue(self):
        notice = self._resume_notice or {}
        session_id = str(notice.get("sessionId") or "")
        if not session_id or self._resume_sending:
            return
        self._resume_sending = True
        self.btn_resume_continue.setEnabled(False)
        self.btn_resume_continue.setText("提交中…")
        self.lbl_resume_status.setText("当前状态：正在提交续接请求…")
        # 循环确认卡上的「接着来」不是普通续接，得告诉 App“继续这个循环”。
        action = "loop-resume" if str(notice.get("source") or "") == "loop_confirm" else "continue"
        payload = {"action": action, "sessionId": session_id}
        if action == "continue":
            # 「这次接几轮」：N>1 时 App 会在第一句之后接着往下接。
            payload["rounds"] = self._resume_rounds
        self._post_resume_action(
            payload,
            on_done=self._after_resume_continue,
        )

    def _after_resume_continue(self, ok, error):
        self._resume_sending = False
        self.btn_resume_continue.setEnabled(True)
        self._render_resume_rounds()
        if ok:
            self.lbl_resume_status.setText("当前状态：已提交续接请求，等待确认")
        else:
            self.lbl_resume_status.setText(f"当前状态：未能提交，可重试\n{error or '发送失败，再试一次'}")

    def _resume_send_dismiss(self):
        notice = self._resume_notice or {}
        session_id = str(notice.get("sessionId") or "")
        if not session_id:
            return
        self._submit_resume_dismiss("dismiss", session_id, notice)

    def _submit_resume_dismiss(self, action, session_id, notice):
        if self._resume_sending:
            return
        self._resume_sending = True
        self.btn_resume_dismiss.setEnabled(False)
        self.btn_loop_finish.setEnabled(False)
        self.lbl_resume_status.setText("当前状态：正在提交…")

        def done(ok, error):
            self._resume_sending = False
            self.btn_resume_dismiss.setEnabled(True)
            self.btn_loop_finish.setEnabled(True)
            if ok:
                self._resume_hidden_sig = self._resume_notice_sig(notice)
                if self._resume_notice_sig(self._resume_notice or {}) == self._resume_hidden_sig:
                    self.collapse_resume_strip()
            else:
                self.lbl_resume_status.setText(f"当前状态：未能提交，可重试\n{error or '请再试一次'}")
        self._post_resume_action({"action": action, "sessionId": session_id}, on_done=done)

    def _resume_send_auto(self, checked):
        if not self._resume_enabled or self._resume_config_sending:
            self._render_resume_auto()
            return
        self._resume_config_sending = True
        previous = self._resume_auto
        self._resume_auto = bool(checked)
        self._render_resume_auto()  # 视觉先行：点了立刻显示目标状态，失败再回滚
        self._post_resume_action(
            {"action": "auto", "enabled": self._resume_auto},
            on_done=lambda ok, error: self._after_resume_auto(ok, error, previous),
        )

    def _after_resume_auto(self, ok, error, previous):
        self._resume_config_sending = False
        if not ok:
            self._resume_auto = bool(previous)
        self._render_resume_auto()
        self.lbl_resume_status.setText("设置已提交，等待同步" if ok else f"自动续接没保存上，可重试\n{error}")

    # ── 循环续接（只剩「ta 说做完了 → 问你还要不要接着来」这条确认，不再有常驻勾选）──
    def _loop_stop(self):
        state = self._loop_state or {}
        session_id = str(state.get("sessionId") or "")
        if not session_id:
            return
        self._post_resume_action({"action": "loop-stop", "sessionId": session_id})
        self._loop_state = None
        self._render_loop_state()

    def _loop_finish(self):
        notice = self._resume_notice or {}
        session_id = str(notice.get("sessionId") or "")
        if not session_id:
            return
        self._submit_resume_dismiss("loop-finish", session_id, notice)

    def _apply_loop_state(self, loop):
        self._loop_state = loop if isinstance(loop, dict) and loop.get("active") else None
        self._render_loop_state()

    def _render_loop_state(self):
        state = self._loop_state or {}
        text = str(state.get("text") or "")
        active = bool(text)
        if active and state.get("status") == "awaiting":
            text = "循环已暂停：ta 好像做完了，等你定"
        self.lbl_loop_state.setText(text)
        self.loop_status_widget.setVisible(active)
        if active and self.isVisible():
            self._resize_after_title_change()

    # ── 续接状态轮询：只读桥，网络异常安静忽略 ──
    def start_resume_polling(self):
        if not APP_ONLY_ASK:
            return
        if self._resume_timer is None:
            self._resume_timer = QTimer(self)
            self._resume_timer.timeout.connect(self._poll_resume_async)
        self._resume_timer.start(RESUME_POLL_INTERVAL_MS)
        self._poll_resume_async()  # 开面板先同步一次，小条别等 800ms

    def stop_resume_polling(self):
        if self._resume_timer is not None:
            self._resume_timer.stop()

    def stop_recommend_polling(self):
        if self._recommend_timer is not None:
            self._recommend_timer.stop()

    def _slow_resume_polling(self):
        """面板收起后不能直接停：停了Remind就永远送不到。改成慢速继续听，
        有新提醒时再把面板叫出来（只在 App 模式下）。"""
        if self._resume_timer is None or self._closed:
            return
        self._resume_timer.start(RESUME_POLL_INTERVAL_MS * 4)

    def _poll_resume_async(self):
        if self._resume_poll_inflight or self._closed:
            return
        self._resume_poll_inflight = True

        def worker():
            payload = {"ok": False}
            try:
                data = api_get("/resume/state", timeout=4)
                if data and data.get("ok"):
                    payload = {
                        "ok": True,
                        "notice": data.get("notice"),
                        "action": data.get("action"),
                        "actionSeq": int(data.get("actionSeq") or 0),
                        "flash": data.get("flash"),
                        "loop": data.get("loop"),
                        "enabled": data.get("enabled") is True,
                        "autoResume": data.get("autoResume") is True,
                        "maxConsecutive": data.get("maxConsecutive", 3),
                        "progress": data.get("progress") or [],
                        # 话单状态搭这条车：桥上 /resume/state 带了 queue，但这里重建
                        # payload 时漏了它，主面板就永远收不到「排队中 第 n/N 轮」，
                        # 状态行只剩开始那一句「已排进队列」（2026-10-23 实机）。
                        "queue": data.get("queue"),
                        "queueSeq": int(data.get("queueSeq") or 0),
                    }
            except Exception:
                pass  # 网络异常安静忽略，不弹错
            if self._closed:
                return
            try:
                self.resume_state_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-resume-poll").start()

    # ── 守门人状态位：只读桥上 App 推的快照，不在球上做任何判定 ──
    def start_sleep_polling(self):
        if self._sleep_timer is None:
            self._sleep_timer = QTimer(self)
            self._sleep_timer.timeout.connect(self._poll_sleep_async)
        self._sleep_timer.start(SLEEP_POLL_INTERVAL_MS)
        self._poll_sleep_async()

    def stop_sleep_polling(self):
        if self._sleep_timer is not None:
            self._sleep_timer.stop()

    def _poll_sleep_async(self):
        if self._sleep_poll_inflight or self._closed:
            return
        self._sleep_poll_inflight = True

        def worker():
            payload = {"ok": False}
            try:
                data = api_get("/sleep/state", timeout=3)
                if data and data.get("ok"):
                    payload = {
                        "ok": True,
                        "state": data.get("state"),
                        "stateSeq": int(data.get("stateSeq") or 0),
                    }
            except Exception:
                pass  # 网络异常安静忽略，不弹错
            if self._closed:
                return
            try:
                self.sleep_state_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-sleep-poll").start()

    @staticmethod
    def _sleep_duration_text(seconds):
        total = max(0, int(seconds or 0))
        if total < 60:
            return f"{total} 秒"
        minutes, rest = divmod(total, 60)
        if minutes < 60:
            return f"{minutes} 分 {rest} 秒" if rest else f"{minutes} 分钟"
        hours, minutes = divmod(minutes, 60)
        return f"{hours} 小时 {minutes} 分"

    def _apply_sleep_state(self, payload):
        self._sleep_poll_inflight = False
        if not payload.get("ok"):
            return
        # 轮询可能比控件先到（菜单是懒创建的），没建好就安静退回去。
        if getattr(self, "btn_sleep_toggle", None) is None:
            return
        state = payload.get("state")
        if not isinstance(state, dict) or not state.get("armed"):
            self._sleep_state = None
            if not self._sleep_action_pending:
                self.btn_sleep_toggle.setText("完成后关机")
                self.btn_sleep_toggle.setToolTip("点一下开始静候：所有任务结束后替你关机")
                self.lbl_sleep_desc.setText("等所有任务结束，安静地关机；中途有动静会重新计时")
            return

        self._sleep_state = state
        status = str(state.get("status") or "watching")
        idle_seconds = int(state.get("idleSeconds") or 0)
        need_seconds = int(state.get("needSeconds") or 0)
        busy = int(state.get("busyCount") or 0)

        if status == "countdown":
            desc = f"还有 {self._sleep_duration_text(state.get('countdownSeconds'))} 就关机，这期间一有动静就取消"
            button_text = "取消"
        elif status == "shutdown-issued":
            desc = "已经发出关机命令"
            button_text = "已发出"
        else:
            parts = [f"已空 {self._sleep_duration_text(idle_seconds)}"]
            if need_seconds:
                parts.append(f"满 {self._sleep_duration_text(need_seconds)}才算完")
            if busy:
                parts.append(f"现在 {busy} 处还在忙")
            desc = "·".join(parts)
            button_text = "取消"

        if not self._sleep_action_pending:
            self.btn_sleep_toggle.setText(button_text)
            self.btn_sleep_toggle.setToolTip("点一下就不再盯着了，在这儿就能取消")
        self.lbl_sleep_desc.setText(desc)

    # ── 守门按钮：只把「人按了」这件事交给 App，球自己不做判定 ──
    def _sleep_toggle_clicked(self):
        if self._sleep_action_pending:
            return
        armed = bool(self._sleep_state and self._sleep_state.get("armed"))
        kind = "cancel" if armed else "arm"
        self._sleep_action_pending = True
        self.btn_sleep_toggle.setEnabled(False)
        self.btn_sleep_toggle.setText("正在撤…" if kind == "cancel" else "正在安排…")
        def worker():
            ok = False
            try:
                data = api_post("/sleep/action", {"kind": kind}, timeout=8)
                ok = bool(data and data.get("ok"))
            except Exception:
                ok = False
            try:
                self.sleep_action_done.emit({"ok": ok, "kind": kind})
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-sleep-action").start()

    def _after_sleep_action(self, payload):
        self._sleep_action_pending = False
        self.btn_sleep_toggle.setEnabled(True)
        if payload.get("ok"):
            # 真正的状态由 3 秒轮询回来定，这里只给一个过渡字。
            return
        self.btn_sleep_toggle.setText("没提交上，再点一次")
        QTimer.singleShot(2500, lambda: self._apply_sleep_state({"ok": True, "state": self._sleep_state}))

    def _apply_resume_state(self, payload):
        self._resume_poll_inflight = False
        if not payload.get("ok"):
            return
        # 循环续接状态：主面板进度行靠它亮/灭
        self._apply_loop_state(payload.get("loop"))
        # 排队话单状态：主面板状态行靠它亮/灭
        self._apply_queue_state(payload.get("queue"))
        self._resume_enabled = payload.get("enabled") is True
        if not self._resume_config_sending:
            self._resume_auto = payload.get("autoResume") is True
            try:
                self._resume_max_consecutive = max(1, min(10, int(payload.get("maxConsecutive") or 3)))
            except (ValueError, TypeError):
                self._resume_max_consecutive = 3
        progress = payload.get("progress")
        self._resume_progress = [item for item in progress if isinstance(item, dict)] if self._resume_enabled and isinstance(progress, list) else []
        self._render_resume_progress()  # 只更新一级面板，绝不 show/raise/open。
        self._render_resume_auto()
        notice = payload.get("notice")
        if not self._resume_enabled and (not isinstance(notice, dict) or notice.get("source") != "loop_confirm"):
            self._resume_hidden_sig = None
            self._resume_deferred_sig = None
            self.collapse_resume_strip()
            self.lbl_resume_notice.hide()
            self._resume_action_seq = max(self._resume_action_seq, int(payload.get("actionSeq") or 0))
            self._resume_seq_adopted = True
            return
        if isinstance(notice, dict) and notice.get("sessionId"):
            was_hidden = not self.isVisible()
            sig = self._resume_notice_sig(notice)
            self.show_resume_strip(notice)
            # 面板收着时来了新提醒：把面板叫出来，否则这条提醒永远送不到用户眼前。
            # 已点过「不用管」的不再打脸；用户只是把面板收起来的也不再反复弹开——
            # 那条提醒仍挂在小条上，自己点开面板就能看到。
            deferred = sig in (self._resume_hidden_sig, self._resume_deferred_sig)
            if was_hidden and not deferred and not self.is_ask_open():
                # 先把球带出来、再把面板贴到球旁边。
                # 实机缺过一种情况：面板自己出现在上次的位置，球却不在视线里（或被面板盖住），
                # 看起来就是「只有一张窗口，找不到传音樱」。
                self._raise_resume_panel()
        else:
            # notice 清空：没有在途请求时才收起小条（正在发「继续哈」就先留着）
            if self._resume_action_inflight == 0:
                self._resume_hidden_sig = None
                self._resume_deferred_sig = None
                self.collapse_resume_strip()
        # action 非空且序号是本球还没发过的 → 补发一次；首轮只记基线，不把旧动作再发一遍。
        action = payload.get("action")
        seq = int(payload.get("actionSeq") or 0)
        if isinstance(action, dict) and action.get("action") and seq > self._resume_action_seq:
            self._resume_action_seq = seq
            if self._resume_seq_adopted and self._resume_action_inflight == 0:
                self._replay_resume_action(action)
        self._resume_seq_adopted = True

    # ── 球内推荐 / 目标快照轮询：只读桥，网络异常安静忽略 ──
    def start_recommend_polling(self, interval_ms=None):
        if not APP_ONLY_ASK:
            return
        if self._recommend_timer is None:
            self._recommend_timer = QTimer(self)
            self._recommend_timer.timeout.connect(self._poll_recommend_async)
        self._recommend_timer.start(int(interval_ms or RECOMMEND_POLL_INTERVAL_MS))
        self._poll_recommend_async()  # 开面板先同步一次，不等 1.5 秒

    def _subpanels_open(self):
        """朗读窗 / 理顺窗是否打开：它们有自己的目标行，靠同一份快照喂。"""
        for attr in ("read_panel", "polish_panel", "queue_panel"):
            panel = getattr(self.ball, attr, None)
            if panel is not None and panel.isVisible():
                return True
        return False

    def _sync_recommend_polling(self):
        """按“现在还有谁在看”决定轮询频率。

        以前 hideEvent 直接停轮询，于是主面板一让位给二级弹窗（打开朗读/理顺时
        必须让位），目标快照就断了；弹窗里点“固定某段对话”，后台改成功、弹窗那一行
        却永远不动。现在：主面板可见就正常听，只剩二级弹窗就慢速听，都没有才停。
        """
        if self._recommend_timer is None or self._closed:
            return
        if self.isVisible():
            self._recommend_timer.start(RECOMMEND_POLL_INTERVAL_MS)
        elif self._subpanels_open():
            self._recommend_timer.start(RECOMMEND_POLL_SLOW_MS)
        else:
            self._recommend_timer.stop()

    def stop_recommend_polling(self):
        if self._recommend_timer is not None:
            self._recommend_timer.stop()

    def _poll_recommend_async(self):
        if self._recommend_poll_inflight or self._closed:
            return
        self._recommend_poll_inflight = True

        def worker():
            payload = {"ok": False}
            try:
                data = api_get("/recommend/state", timeout=4)
                if data and data.get("ok"):
                    payload = {
                        "ok": True,
                        "push": data.get("push"),
                        "pushSeq": int(data.get("pushSeq") or 0),
                        "request": data.get("request"),
                    }
            except Exception:
                pass  # 网络异常安静忽略，不弹错
            if self._closed:
                return
            try:
                self.recommend_state_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-recommend-poll").start()

    def _apply_recommend_state(self, payload):
        self._recommend_poll_inflight = False
        if not payload.get("ok"):
            return
        # 只记 App 已读到的请求序号，用来判断「我发的这条它收到了没」。
        request = payload.get("request")
        if isinstance(request, dict):
            self._recommend_ack_seq = int(request.get("seq") or 0)
        push = payload.get("push")
        if not isinstance(push, dict):
            return
        # 按内容指纹去重：App 每轮都推（序号一直在涨），但内容一样时不该重渲染。
        sig = self._recommend_sig(push)
        if sig == self._recommend_push_sig:
            return
        self._recommend_push_sig = sig
        self._recommend_push_seq = int(payload.get("pushSeq") or 0) or self._recommend_push_seq
        self._apply_recommend_push(push)

    @staticmethod
    def _recommend_sig(push):
        target = push.get("target") if isinstance(push.get("target"), dict) else {}
        candidates = push.get("candidates") if isinstance(push.get("candidates"), list) else []
        suggestions = push.get("suggestions") if isinstance(push.get("suggestions"), list) else []
        return (
            target.get("sessionId"), target.get("mode"), target.get("title"), target.get("agentName"), bool(target.get("stale")),
            tuple(str(item.get("sessionId") or "") for item in candidates),
            tuple(str(item.get("text") or "") for item in suggestions),
            bool(push.get("generating")),
            str(push.get("notice") or ""),
            push.get("enabled") is not False,
        )

    def _apply_recommend_push(self, push):
        target = push.get("target") if isinstance(push.get("target"), dict) else None
        candidates = push.get("candidates") if isinstance(push.get("candidates"), list) else []
        suggestions = push.get("suggestions") if isinstance(push.get("suggestions"), list) else []
        self._recommend_generating = bool(push.get("generating"))
        # 推回来了（不管有没有结果）就把刷新锁解开，否则一次失败会把按钮永久禁住。
        if not self._recommend_generating and self._refreshing:
            self._refreshing = False
            self._set_refreshing_ui(False)
        # 错误提示要钉住：App 下一轮推的 notice 是空的（旧错误只在生成那一轮带），
        # 不粘住就会 1.5 秒后回退成「点刷新推荐生成一批」，等于错误只闪一下。
        # 粘性在三种情况下解除：真的生成出东西了、用户点了清空、面板被收起。
        notice = str(push.get("notice") or "")
        if self._recommend_generating or suggestions:
            self._recommend_sticky = False
            self._recommend_notice = notice
        elif notice:
            self._recommend_sticky = True
            self._recommend_notice = notice
        elif not self._recommend_sticky:
            self._recommend_notice = ""
        # 推荐回复在设置里关掉时：推荐区整块收起来，不留「已关闭」的空壳。
        self._set_recommend_visible(push.get("enabled") is not False)
        # 目标：更新球上当前对话状态（固定/跟随）与标题。
        if target:
            self.ball.target_mode = "pinned" if target.get("mode") == "pinned" else "auto"
            self.ball.target_name = target.get("agentName") or ""
            self.ball.target_title = target.get("title") or ""
            self.ball.target_session_id = target.get("sessionId") or ""
            self.ball.pinned_target = {"sessionId": target.get("sessionId") or "", "title": target.get("title") or ""} if target.get("mode") == "pinned" else None
        else:
            self.ball.target_mode = "auto"
            self.ball.pinned_target = None
            self.ball.target_name = ""
            self.ball.target_title = ""
            self.ball.target_session_id = ""
        # 候选列表交给 TargetMenu 缓存，展开时直接渲染（球级分发，主面板与子弹窗共用）。
        if self.target_menu is not None:
            self.ball.set_recommend_candidates(candidates)
        # 推荐条目缓存：与旧链路共用 ball.cached，点一下仍走复制。
        if suggestions:
            self.ball.cached = {"items": suggestions, "rid": "bridge", "ts": int(time.time() * 1000)}
        elif not self._recommend_generating:
            self.ball.cached = None
        self._update_target()
        # 二级弹窗（朗读窗、润色窗）各有自己的目标行：推送到了也顺手刷一下，
        # 否则球上目标变了、弹窗里那一行永远停在开窗时的样子。
        for attr in ("read_panel", "polish_panel", "queue_panel"):
            panel = getattr(self.ball, attr, None)
            updater = getattr(panel, "_update_target", None) if panel is not None else None
            if callable(updater):
                updater()
        if not self.is_ask_open():
            self._render_recommend_state()
        # 排障：记下推送到达时球自己看到的目标与各面板按钮文字。
        def _btn_text(panel):
            btn = getattr(panel, "btn_target", None)
            return btn.text() if btn is not None else None
        _panel_diag(
            "push",
            mode=self.ball.target_mode,
            targetSession=getattr(self.ball, "target_session_id", ""),
            targetTitle=self.ball.target_title,
            menuBtn=_btn_text(self),
            polishBtn=_btn_text(getattr(self.ball, "polish_panel", None)),
            readBtn=_btn_text(getattr(self.ball, "read_panel", None)),
            polishOpen=bool(getattr(self.ball, "polish_panel", None) and self.ball.polish_panel.isVisible()),
            candidates=[str(c.get("sessionId") or "") for c in candidates],
        )

    def _set_recommend_visible(self, visible):
        """推荐区的显隐跟着设置走；隐藏时顺手清掉缓存，免得下次开面板闪出旧条目。"""
        if getattr(self, "_recommend_visible", True) == bool(visible):
            return
        self._recommend_visible = bool(visible)
        self.recommend_body.setVisible(bool(visible))
        if not visible:
            self.ball.cached = None
            self._clear_buttons()
        self.keep_current_position()

    def _render_recommend_state(self):
        """按当前桥快照渲染推荐区：生成中 / 有结果 / 空 / 提示。"""
        if not getattr(self, "_recommend_visible", True):
            return
        if self._recommend_generating:
            self._render_loading()
            return
        items = (self.ball.cached or {}).get("items") if self.ball.cached else None
        if items:
            self._render_items(items)
        elif self._recommend_notice:
            self._render_notice(self._recommend_notice)
        else:
            self._render_empty()

    def _render_notice(self, text):
        self._clear_buttons()
        lbl = QLabel(text)
        lbl.setObjectName("hint")
        lbl.setWordWrap(True)
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.grid.addWidget(lbl, 0, 0)
        self.lbl_cache_time.setText("")
        self.keep_current_position()

    def request_recommend(self, kind, session_id=""):
        """球 → App：请求刷新推荐 / 固定某段对话 / 取消固定。"""
        if not APP_ONLY_ASK:
            return
        self._recommend_seq += 1
        seq = self._recommend_seq

        def worker():
            payload = {"ok": False, "error": "连不上知意，看看 App 开着没"}
            try:
                body = {"kind": kind}
                if session_id:
                    body["sessionId"] = session_id
                data = api_post("/recommend/request", body, timeout=6)
                payload["ok"] = bool(data.get("ok"))
                payload["error"] = data.get("error") or ""
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"出错了 ({e.code})"
                except Exception:
                    payload["error"] = f"出错了 ({e.code})"
            except Exception:
                pass
            try:
                self.recommend_request_failed.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-recommend-request").start()

    def _apply_recommend_request_failure(self, payload):
        if payload.get("ok"):
            return
        # 请求没送出去：给一句人话，不把界面留在假的“已切换”状态上。
        self._flash(payload.get("error") or "请求没送出去，再试一次")
        # 也不能把推荐区留在假的“正在获取…”：App 没开、桥 404 时那条 loading
        # 永远没人来覆盖，指纹又没变，所以它会一直转下去，只能关面板重开才恢复。
        self._refreshing = False
        self._set_refreshing_ui(False)
        if not self._recommend_sticky:
            self._render_recommend_state()

    @staticmethod
    def _resume_action_key(payload):
        # 归一成可比对的指纹，用来区分「桥上这条是我自己刚发的」还是「真有别的动作要补发」。
        return (
            str(payload.get("action") or ""),
            str(payload.get("sessionId") or ""),
            payload.get("enabled") is True,
        )

    def _replay_resume_action(self, action):
        """桥上有一条本球还没送出的动作（例如上一轮 POST 丢了）：按原样补发。
        若它就是本球刚发过的那条（回包丢失），指纹会相同，跳过避免重复发。"""
        if self._resume_action_key(action) == self._resume_last_attempt:
            return
        kind = str(action.get("action") or "")
        if kind == "auto":
            self._post_resume_action({"action": "auto", "enabled": action.get("enabled") is True})
        elif kind in ("continue", "dismiss"):
            session_id = str(action.get("sessionId") or "")
            if session_id:
                self._post_resume_action({"action": kind, "sessionId": session_id})

    def show_resume_notice(self, notice):
        """兼容旧 flash 入口；临时状态统一交给 progress，不弹窗、不留空位。"""
        self.lbl_resume_notice.hide()

    def load_cache_async(self):
        target_revision = getattr(self.ball, "target_revision", 0)

        def worker():
            try:
                data = api_get("/cache", timeout=4)
                if data.get("ok") and data.get("cached") and data["cached"].get("items"):
                    self.refresh_ready.emit({
                        "source": "cache",
                        "items": data["cached"]["items"],
                        "rid": data["cached"].get("rid") or "",
                        "ts": data["cached"].get("ts") or 0,
                        "target": data["cached"].get("target"),
                        "target_revision": target_revision,
                        "fromCache": True,
                    })
            except Exception:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-cache").start()

    def refresh_async(self):
        # App 模式：推荐由 App 桥生成，这里只发一个「刷新」请求，结果由轮询推回。
        if APP_ONLY_ASK:
            # 重入锁：以前 App 分支没上锁，连点几下就真的多跑几次生成
            # （桥那边 seq 递增，每次 refresh 都执行一次，不会帮你合并）。
            if self._refreshing:
                return
            self._refreshing = True
            self._set_refreshing_ui(True)
            self._render_loading()
            self._flash("")
            self.request_recommend("refresh")
            return
        if self._refreshing:
            return
        self._refreshing = True
        self._refresh_seq += 1
        refresh_seq = self._refresh_seq
        target_revision = getattr(self.ball, "target_revision", 0)
        self._set_refreshing_ui(True)

        def worker():
            payload = {"source": "refresh", "seq": refresh_seq, "target_revision": target_revision, "items": None, "rid": None, "target": None, "error": None, "target_state_loaded": False}
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload["target"] = data["target"]
                    payload["mode"] = data.get("mode") or "auto"
                    payload["pinned"] = data.get("pinned")
                    payload["target_state_loaded"] = True
            except Exception:
                pass
            try:
                data = api_get("/suggest", timeout=30)
                if data.get("ok"):
                    payload["items"] = data.get("items") or []
                    payload["rid"] = data.get("rid") or ""
                    # 兜底：/target 超时但 /suggest 成功时，只补显示名；
                    # 不覆盖本地 mode/pinned，避免把未知状态误写成自动模式。
                    if data.get("target") and not payload["target"]:
                        payload["target"] = data["target"]
            except Exception as e:
                payload["error"] = str(e)
            try:
                self.refresh_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-refresh").start()

    # ── 语音朗读：主面板只留「念给我听」入口，朗读本体在独立 ReadPanel ──
    def _open_read_panel(self):
        """点「念给我听」：只打开选择窗口，等用户选好回复后再点击朗读。"""
        if self.ball.read_panel is None:
            self.ball.read_panel = ReadPanel(self.ball)
        self.close_menu()                       # 推荐面板让位，不再自带朗读按钮
        self.ball.read_panel.open_for(self.ball.target_name, start=False)
        self.ball._set_fusion_panel_state("read")
        # 主面板已让位，但朗读窗的目标行还得跟着快照走：切到慢速轮询。
        self._sync_recommend_polling()

    def _open_ask_flower(self):
        """点「问问小花」：收起推荐面板，弹提问窗，用解语花自己配置的模型直接回答。"""
        if not getattr(self.ball, "ask_flower_enabled", False):
            return
        if self.ball.ask_flower_dialog is None:
            self.ball.ask_flower_dialog = AskFlowerDialog(self.ball)
        self.close_menu()
        self.ball.ask_flower_dialog.show_near_ball()
        self.ball._set_fusion_panel_state("ask")

    def _open_polish_panel(self):
        """点「理顺」：主面板让位（跟朗读同款），只留把话理顺弹窗独立展示。"""
        if self.ball.polish_panel is None:
            self.ball.polish_panel = PolishPanel(self.ball)
        self.close_menu()                       # 推荐面板让位，不再自带润色按钮
        self.ball.polish_panel.open_near_ball()
        self.ball._set_fusion_panel_state("polish")
        # 同理：理顺窗开着时，目标快照不能断。
        self._sync_recommend_polling()

    def _open_queue_panel(self):
        """点「排队」：主面板让位（跟理顺同款），只留排队弹窗独立展示。"""
        panel = getattr(self.ball, "queue_panel", None)
        if panel is None:
            panel = QueueInsertPanel(self.ball)
            self.ball.queue_panel = panel
        self.close_menu()
        panel.open_near_ball()
        self.ball._set_fusion_panel_state("queue")
        # 排队窗也有自己的目标行：目标快照不能断。
        self._sync_recommend_polling()

    def _queue_stop(self):
        """主面板状态行上的「停」：话单不再往下送。"""
        state = self._queue_state or {}
        session_id = str(state.get("sessionId") or "")
        if not session_id:
            return
        bridge_queue_call("queue-cancel", "", 1, session_id, timeout_s=10)

    def _apply_queue_state(self, state):
        """App 推来的话单状态：主面板状态行 + 弹窗里的进度。"""
        self._queue_state = state if isinstance(state, dict) else None
        self._render_queue_state()
        panel = getattr(self.ball, "queue_panel", None)
        if panel is not None and panel.isVisible():
            panel.apply_queue_state(state)

    def _render_queue_state(self):
        state = self._queue_state or {}
        text = str(state.get("text") or "")
        message = str(state.get("message") or "")
        error = str(state.get("error") or "")
        active = bool(state.get("active"))
        if error:
            text = error
        elif not active and message:
            # 发完/停掉这类一句话交代，亮几秒就收起来，不长期占着状态行。
            text = message
        self.lbl_queue_state.setText(text)
        self.queue_status_widget.setVisible(bool(text))
        if text and self.isVisible():
            self._resize_after_title_change()
        if text and not active and not error:
            QTimer.singleShot(8000, self._clear_queue_message)

    def _clear_queue_message(self):
        state = self._queue_state or {}
        if state.get("active"):
            return
        self.lbl_queue_state.setText("")
        self.queue_status_widget.setVisible(False)

    def _open_compaction_panel(self):
        """点「查看档案」：主面板让位，只留压缩档案窗独立展示（只读，不发模型请求）。"""
        if self.ball.compaction_panel is None:
            self.ball.compaction_panel = CompactionPanel(self.ball)
        self.close_menu()                       # 推荐面板让位，跟朗读/润色同款
        self.ball.compaction_panel.open_near_ball()
        self.ball._set_fusion_panel_state("compaction")

    def _update_say_btn(self):
        """让朗读工具的说明跟随当前判定的助手名，按钮本身保持统一动作文案。"""
        name = (self.ball.target_name or "").strip()
        try:
            self.btn_say.setText("念给我听")
            self.lbl_say_desc.setText(f"让 {name or '小花'} 把当前回复念出来")
        except RuntimeError:
            pass

    def hideEvent(self, event):
        # 朗读归独立 ReadPanel 管理（它自己有关闭即停读），主面板收起不管声音
        super().hideEvent(event)
        self._cancel_fade()

    def _apply_async_refresh(self, payload):
        if payload.get("source") == "refresh" and payload.get("seq") != self._refresh_seq:
            return
        if payload.get("source") == "refresh":
            self._refreshing = False
            self._set_refreshing_ui(False)
        target_state_current = payload.get("target_revision", getattr(self.ball, "target_revision", 0)) == getattr(self.ball, "target_revision", 0)
        if payload.get("target") and target_state_current:
            self.ball.target_name = payload["target"].get("name") or payload["target"].get("agentId") or ""
            self.ball.target_title = payload["target"].get("title") or self.ball.target_title
        if payload.get("target_state_loaded") and target_state_current:
            self.ball.target_mode = "pinned" if payload.get("mode") == "pinned" else "auto"
            self.ball.pinned_target = payload.get("pinned")
        self._update_target()
        if payload.get("items"):
            ts = payload.get("ts") or (int(time.time() * 1000) if not payload.get("fromCache") else (self.ball.cached or {}).get("ts") or 0)
            self.ball.cached = {"items": payload["items"], "rid": payload["rid"], "ts": ts}
            if self._ask_entry is None:
                self._render_items(payload["items"])
        elif payload.get("error"):
            self._render_error(payload["error"])

    def _render_empty(self):
        self._clear_buttons()
        lbl = QLabel("点「刷新推荐」生成一批")
        lbl.setObjectName("hint")
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.grid.addWidget(lbl, 0, 0)
        self.lbl_cache_time.setText("")
        self.keep_current_position()

    def _render_loading(self):
        self._clear_buttons()
        lbl = QLabel("正在获取推荐回复…")
        lbl.setObjectName("hint")
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.grid.addWidget(lbl, 0, 0)
        self.lbl_hint.setText("")
        self.keep_current_position()

    def clear_recommend(self):
        """清空当前推荐：本地缓存 + 通知 App 丢掉它那份，否则下一轮又把旧列表推回来。"""
        self.ball.cached = None
        self._clear_buttons()
        self.lbl_cache_time.setText("")
        # 清空也是「这条到此为止」，粘住的错误提示跟着退场，回到默认文案。
        self._recommend_sticky = False
        self._recommend_notice = ""
        self._refreshing = False
        self._set_refreshing_ui(False)
        self.request_recommend("clear")
        self._render_empty()
        self.keep_current_position()

    def _set_refreshing_ui(self, refreshing):
        self.btn_refresh.setEnabled(not refreshing)
        # 刷新推荐期间仍允许切换目标；回包带 target_revision，旧目标状态只会被丢弃。
        self.btn_target.setEnabled(True)
        self.btn_refresh.setText("正在获取推荐回复…" if refreshing else "刷新推荐")

    def _bridge_title_call(self, kind, timeout_s=75):
        """App 模式下的起名/还原：把请求交给桥，再轮询等 App 推回结果。

        球不能回调 App，只能轮询；等不到就返回 None，由调用方报「知意没回话」，不假装成功。
        """
        deadline = time.time() + timeout_s
        try:
            before = api_get("/title/state", timeout=4)
        except Exception:
            before = {}
        baseline = int(before.get("resultSeq") or 0) if isinstance(before, dict) else 0
        try:
            api_post("/title/request", {
                "kind": kind,
                "sessionId": getattr(self.ball, "target_session_id", "") or "",
            }, timeout=6)
        except Exception:
            return None
        while time.time() < deadline:
            if self._closed:
                return None
            try:
                state = api_get("/title/state", timeout=4)
            except Exception:
                time.sleep(0.3)
                continue
            if not isinstance(state, dict) or not state.get("ok"):
                time.sleep(0.3)
                continue
            if int(state.get("resultSeq") or 0) > baseline and isinstance(state.get("result"), dict):
                return state["result"]
            time.sleep(0.3)
        return None

    def rename_async(self):
        """重命名标题：总结整段对话 → 改宿主标题，服务端会记下旧标题供退回。"""
        if self._renaming:
            return
        self._renaming = True
        self._set_renaming_ui(True)

        def worker():
            payload = {"ok": False, "error": None, "title": None, "agentName": "", "fallback": False}
            if APP_ONLY_ASK:
                result = self._bridge_title_call("rename", timeout_s=75)
                if result is None:
                    payload["error"] = "知意没回话，看看 App 开着没"
                else:
                    payload["ok"] = bool(result.get("ok"))
                    payload["title"] = result.get("title") or ""
                    payload["agentName"] = result.get("agentName") or ""
                    payload["fallback"] = bool(result.get("fallback"))
                    payload["error"] = result.get("error")
            else:
                try:
                    data = api_post("/rename", {}, timeout=40)
                    payload["ok"] = bool(data.get("ok"))
                    payload["title"] = data.get("title") or ""
                    payload["agentName"] = data.get("agentName") or ""
                    payload["fallback"] = bool(data.get("fallback"))
                    payload["error"] = data.get("error")
                except urllib.error.HTTPError as e:
                    try:
                        body = json.loads(e.read().decode("utf-8"))
                        payload["error"] = body.get("error") or f"出错了 ({e.code})"
                    except Exception:
                        payload["error"] = f"出错了 ({e.code})"
                except Exception:
                    payload["error"] = "连不上解语花，看看插件开着没"
            try:
                self.rename_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-rename").start()

    def undo_async(self):
        """退回：把标题恢复到最近一次重命名之前。"""
        if self._renaming:
            return
        self._renaming = True
        self._set_undo_busy(True)

        def worker():
            payload = {"ok": False, "error": None, "restoredTitle": None, "agentName": ""}
            if APP_ONLY_ASK:
                result = self._bridge_title_call("undo", timeout_s=20)
                if result is None:
                    payload["error"] = "知意没回话，看看 App 开着没"
                else:
                    payload["ok"] = bool(result.get("ok"))
                    payload["restoredTitle"] = result.get("restoredTitle") or ""
                    payload["agentName"] = result.get("agentName") or ""
                    payload["error"] = result.get("error")
            else:
                try:
                    data = api_post("/rename/undo", {}, timeout=15)
                    payload["ok"] = bool(data.get("ok"))
                    payload["restoredTitle"] = data.get("restoredTitle") or ""
                    payload["agentName"] = data.get("agentName") or ""
                    payload["error"] = data.get("error")
                except urllib.error.HTTPError as e:
                    try:
                        body = json.loads(e.read().decode("utf-8"))
                        payload["error"] = body.get("error") or f"出错了 ({e.code})"
                    except Exception:
                        payload["error"] = f"出错了 ({e.code})"
                except Exception:
                    payload["error"] = "连不上解语花，看看插件开着没"
            try:
                self.undo_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-undo").start()

    def _apply_rename_result(self, payload):
        self._renaming = False
        self._set_renaming_ui(False)
        if payload.get("ok") and payload.get("title"):
            # 标题改了，球上显示的目标标题立刻跟上，不等下一轮推荐快照。
            self.ball.target_title = payload.get("title") or self.ball.target_title
            # 第一行只报结果；Hana 侧栏现在立即生效，不再提醒「聊一句后刷新」。
            tip = "（兜底标题）" if payload.get("fallback") else ""
            self._flash(f"已改为：{payload['title']}{tip}")
            self._set_undo_available(True)
            self._update_target()
            self._sync_target_state()
        else:
            self._flash(payload.get("error") or "重命名失败，再试一次")

    def _apply_undo_result(self, payload):
        self._renaming = False
        self._set_undo_busy(False)
        if payload.get("ok"):
            restored = payload.get("restoredTitle") or "无标题"
            self.ball.target_title = restored
            who = f"{payload['agentName']} 的" if payload.get("agentName") else ""
            self._flash(f"已把{who}会话标题退回：{restored}")
            self._set_undo_available(False)
            self._update_target()
            self._sync_target_state()
        else:
            self._flash(payload.get("error") or "退回失败，再试一次")

    def _set_undo_available(self, available):
        available = bool(available)
        changed = self._undo_available != available
        self._undo_available = available
        self.btn_undo.setVisible(available)
        self.btn_undo.setEnabled(available and not self._renaming)
        if changed and self.isVisible():
            self._resize_after_title_change()

    def _set_renaming_ui(self, renaming):
        self.btn_rename.setEnabled(not renaming)
        self.btn_rename.setText("总结中…" if renaming else "生成新标题")
        # 进度就写在按钮左边那行说明里：一轮总结十几秒，只在按钮上改字看着像点了没反应，
        # 底部的反馈行又要等结果才亮（2026-10-19 实机反馈）。
        self.lbl_rename_desc.setText(RENAME_DESC_BUSY if renaming else RENAME_DESC_IDLE)
        self.btn_undo.setEnabled(self._undo_available and not renaming)

    def _set_undo_busy(self, busy):
        """退回按钮自己的忙碌态：文案跟着变，避免连点两下退两次。"""
        self.btn_undo.setText("退回中…" if busy else "还原")
        self.btn_undo.setEnabled(self._undo_available and not busy and not self._renaming)

    def _update_cache_time(self):
        ts = (self.ball.cached or {}).get("ts") or 0
        if ts:
            self.lbl_cache_time.setText(f"上次生成 {time.strftime('%H:%M', time.localtime(ts / 1000))}")
        else:
            self.lbl_cache_time.setText("")

    def _render_error(self, err):
        self._clear_buttons()
        lbl = QLabel("推荐生成失败，再点一次试试")
        lbl.setObjectName("hint")
        lbl.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.grid.addWidget(lbl, 0, 0)
        self._flash("")
        self.keep_current_position()

    def _render_items(self, items):
        self._clear_buttons()
        self.buttons = []
        for i, item in enumerate(items):
            text = item.get("text") or ""
            if not text:
                continue
            lbl = RecLabel(text, i)
            lbl.setObjectName("rec")
            lbl.clicked.connect(self._pick)
            self.grid.addWidget(lbl, i, 0)
            self.buttons.append(lbl)
        self._update_hint()
        self._update_cache_time()
        # 只有真渲染出条目，才有「清空」这回事。
        self._set_clear_available(bool(self.buttons))
        self.keep_current_position(full_height=True)

    def _set_clear_available(self, available):
        """清空按钮跟随「现在有没有已生成的推荐」：没有就整块收起，不留死按钮。"""
        available = bool(available)
        if getattr(self, "_clear_available", False) == available:
            return
        self._clear_available = available
        self.btn_clear_recommend.setVisible(available)

    def _clear_buttons(self):
        while self.grid.count():
            item = self.grid.takeAt(0)
            w = item.widget()
            if w:
                w.hide()
                w.deleteLater()
        self.buttons = []
        # 网格清空 = 没东西可清，清空按钮一起退场（空/加载/出错/提示/清空后都走这里）。
        if hasattr(self, "btn_clear_recommend"):
            self._set_clear_available(False)

    def _pick(self, index):
        items = self.ball.cached.get("items") if self.ball.cached else None
        if not items or index >= len(items):
            self._flash("推荐已失效，重新打开试试")
            return
        item = items[index]
        text = item.get("text") or ""
        if not text:
            return
        if APP_ONLY_ASK:
            # App 模式：推荐由 App 桥生成，球内只做「点一下复制」，不代替发送。
            self._copy_to_clipboard(text)
            self._flash("已复制 ✓ 手动粘贴到对话框")
            return
        rid = (self.ball.cached or {}).get("rid") or ""
        action = self.ball.action
        self._flash("正在发送…" if action == "send" else "正在填入…")
        try:
            if action == "send":
                res = api_post("/apply", {"rid": rid, "index": index}, timeout=20)
                if res.get("ok"):
                    self._flash("已发送 ✓")
                else:
                    self._flash(res.get("error") or "发送失败")
            else:
                res = api_post("/copy", {"rid": rid, "index": index}, timeout=8)
                if res.get("ok") and res.get("text"):
                    self._copy_to_clipboard(res["text"])
                    self._flash("已复制 ✓ 手动粘贴到对话框")
                else:
                    self._flash(res.get("error") or "复制失败")
        except urllib.error.HTTPError as e:
            try:
                body = json.loads(e.read().decode("utf-8"))
                self._flash(body.get("error") or f"出错了 ({e.code})")
            except Exception:
                self._flash(f"出错了 ({e.code})")
        except Exception:
            self._flash("连不上解语花，看看插件开着没")

    def _copy_to_clipboard(self, text):
        try:
            from PyQt6.QtGui import QGuiApplication
            QGuiApplication.clipboard().setText(text)
        except Exception:
            pass

    def _update_target(self):
        arrow = "▴" if self.target_menu is not None and self.target_menu.isVisible() else "▾"
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            # target_title 是最近一次 /target 拉的值（重命名后会更新），比固定时存的 pinned_target.title 新
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            label = f"固定 · {title[:6]}" if title else "固定"
        else:
            label = "跟随最近"
        self.btn_target.setText(f"{label} {arrow}")
        self._update_target_info()

    def _update_target_info(self):
        """头部下方显示当前读取的是哪个对话框：固定会话或跟随最近结果。"""
        name = (self.ball.target_name or "").strip()
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            prefix = "固定"
        else:
            title = (self.ball.target_title or "").strip()
            prefix = "跟随最近"
        if title:
            text = " · ".join([prefix, name, title]) if name else " · ".join([prefix, title])
        elif name:
            text = " · ".join([prefix, name]) + "（无标题）"
        else:
            text = "跟随最近 · 正在定位对话…"
        self._set_panel_line(self.lbl_target_info, text)
        self._update_say_btn()

    def _sync_target_state(self):
        # App 模式：目标状态与候选都由 /recommend/* 快照驱动，不再走旧插件 /target。
        if APP_ONLY_ASK:
            return
        self._target_seq += 1
        target_seq = self._target_seq
        target_revision = getattr(self.ball, "target_revision", 0)

        def worker():
            payload = None
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload = {**data, "seq": target_seq, "target_revision": target_revision}
            except Exception:
                pass
            if payload is not None:
                try:
                    self.target_ready.emit(payload)
                except RuntimeError:
                    pass

        threading.Thread(target=worker, daemon=True, name="zhujian-target").start()

    def _apply_target_state(self, data):
        if data.get("seq") != self._target_seq:
            return
        if data.get("target_revision", getattr(self.ball, "target_revision", 0)) != getattr(self.ball, "target_revision", 0):
            return
        t = data.get("target") or {}
        self.ball.target_name = t.get("name") or t.get("agentId") or ""
        self.ball.target_title = t.get("title") or ""
        self.ball.target_mode = "pinned" if data.get("mode") == "pinned" else "auto"
        self.ball.pinned_target = data.get("pinned")
        self._update_target()
        # 退回按钮的显示与可用性都由服务端真实记录驱动。
        if "undoAvailable" in data and not self._renaming:
            self._set_undo_available(data.get("undoAvailable"))

    def invalidate_target_sync(self):
        """用户主动切换目标时作废先前的 /target 回包，避免旧状态覆盖新选择。"""
        self._target_seq += 1

    def _open_target_menu(self):
        show = not self.target_menu.isVisible()
        if show:
            self.target_menu.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
            if APP_ONLY_ASK:
                # App 模式：候选由轮询快照维护，展开时直接渲染（最新快照由轮询带回）。
                # 先渲染再摆位置，不然刚打开那一刻高度还是旧的。
                self.target_menu.render_from_cache()
            else:
                self.target_menu.refresh_sessions_async()
        self._set_target_selector_visible(show)

    def _set_target_selector_visible(self, visible):
        self.target_menu.setVisible(bool(visible))
        self._update_target()
        self._resize_after_target_change()

    def _resize_after_target_change(self):
        # 内嵌菜单切换后，Qt 仍可能用收起时的行分配；重新登记这一项，
        # 保留原顺序与显隐状态，让后面的推荐区按当前高度排布。
        def settle():
            self._sync_size()
            inner = self.main_view.layout()
            index = inner.indexOf(self.target_menu)
            if index >= 0:
                inner.removeWidget(self.target_menu)
                inner.insertWidget(index, self.target_menu)
                inner.activate()
            if self.isVisible():
                self.move_to_ball()
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle))

    def _resize_after_title_change(self):
        # 还原按钮显示/隐藏会改变面板高度；非手动拖动时重新按比例贴回传音樱。
        def settle():
            self._sync_size()
            if self.isVisible() and not self._user_dragged:
                self.move_to_ball()
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle))

    def _update_hint(self):
        action = self.ball.action
        mode = "点一下直接发出" if action == "send" else "点一下复制，自己粘贴到对话框"
        self.lbl_hint.setText(f"当前模式：{mode}")
        self._flash("")

    def _set_panel_line(self, label, text):
        """单行说明不参与撑宽；可见区省略显示，悬停保留全文。"""
        margins = self.layout().contentsMargins()
        width = self.width() - margins.left() - margins.right()
        scroll = getattr(self, "main_scroll", None)
        if scroll is not None and scroll.viewport().width() > 0:
            width = min(width, scroll.viewport().width())
        label.setToolTip(text)
        label.setText(label.fontMetrics().elidedText(text, Qt.TextElideMode.ElideRight, max(1, width)))

    def _flash(self, text):
        self._set_panel_line(self.lbl_feedback, text)

    def keep_current_position(self, full_height=False):
        """
        保持/校正面板位置。full_height=True 表示本次渲染是完整内容高度
        （推荐条已就绪），此时若尚未正式锚定则按花朵重新锚定，保证每次
        打开最终位置一致；内容未就绪时先贴近花朵，避免闪现左上角。
        """
        if self._user_dragged:
            # 用户拖过面板：尊重手动位置，内容变化只保持
            self._needs_reanchor = False
        elif full_height and self._needs_reanchor:
            # 布局尺寸要在事件循环跑过两轮后才稳定：第一轮给推荐条分配宽度，
            # 第二轮换行高度才生效。延迟锚定保证用真实全高计算位置。
            self._needs_reanchor = False
            QTimer.singleShot(0, lambda: QTimer.singleShot(0, self._reanchor_once))
            return
        elif self._needs_reanchor:
            # 内容未就绪（空/加载中）：先贴到花朵旁边，等 full_height 时正式锚定
            self.move_to_ball()
            return
        # 内容已就绪且已锚定过：尺寸同步延迟到布局稳定（两轮事件循环）后再 adjustSize。
        # 换行 QLabel 的 sizeHint 在宽度分配后两轮才正确，立即 adjustSize 会拿到
        # 未换行的错误高度，把推荐条压扁/撑爆（图1 错位残字的根因）。
        self._schedule_size_sync()
        screen = self.ball.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
        y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
        self.move(x, y)

    def _schedule_size_sync(self):
        """延迟到布局稳定（两轮事件循环）后再 adjustSize。"""
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, self._sync_size))

    def _reanchor_once(self):
        """延迟锚定：等布局稳定后按花朵重新定位（用于内容就绪后的首次锚定）。"""
        if not self.isVisible():
            return
        self.move_to_ball()

    def _sync_size(self):
        """主视图直接按真实内容定高，避免先 adjustSize 缩小再撑回引起滚动条闪动。"""
        if self.layout() is not None:
            self.layout().activate()
        main = getattr(self, "main_view", None)
        if main is not None and main.isVisible():
            self._fit_to_content()
        else:
            # 续接专页不使用主视图，保留原有尺寸计算。
            self.adjustSize()

    def _fit_to_content(self):
        """面板高度按主视图的真实内容算，并且至少和一屏装得下的一样高。

        adjustSize 读的是容器 sizeHint，而主视图那层的 sizeHint 会停在旧值，面板就比内容
        矮一截：行被压皱、底部反馈行被裁（2026-10-19 实机：「还原」掉出虚线框、候选对话
        被压成一条条）。现在两步：① 把主视图的最小高度钉在内容高度上，装在滚动容器里就
        只会出现滚动条，不会再挤压行；② 面板高度 = min(内容 + 边距, 上限, 屏幕)。"""
        main = getattr(self, "main_view", None)
        if main is None or not main.isVisible() or self.layout() is None:
            return
        inner = main.layout()
        if inner is None:
            return
        inner.invalidate()
        self._pin_row_heights(inner)
        need = inner.sizeHint().height()
        if need <= 0:
            return
        if main.minimumHeight() != need:
            main.setMinimumHeight(need)
        margins = self.layout().contentsMargins()
        want = need + margins.top() + margins.bottom()
        limit = self.maximumHeight()
        if limit and limit < 16777215:
            want = min(want, limit)
        screen = self.screen() or QApplication.primaryScreen()
        if screen is not None:
            # 再高也高不过屏幕：装不下时交给主视图的滚动条。
            want = min(want, max(320, screen.availableGeometry().height() - 24))
        if want > 0 and want != self.height():
            self.resize(self.width(), want)

    @staticmethod
    def _pin_row_heights(layout):
        """把面板里每一块容器的“最小高度”钉在它自己布局的真实高度上。

        这批 PyQt6/Qt 在「藏在布局深处的控件忽然显示」时不会把外层重算一次，外层就
        按旧值分配，子行被压扁：候选对话列表压成一条条、还原按钮掉出虚线框都是这个。
        钉住最小高度后外层必须给够，装不下时交给主视图的滚动条。
        滚动区（提问列表等）自己管高度，不碰。"""
        for i in range(layout.count()):
            item = layout.itemAt(i)
            widget = item.widget()
            if widget is None or isinstance(widget, QScrollArea) or not widget.isVisible():
                continue
            own = widget.layout()
            if own is None:
                continue
            want = own.sizeHint().height()
            if want > 0 and widget.minimumHeight() != want:
                widget.setMinimumHeight(want)

    def move_to_ball(self):
        """与推荐面板同一套定位：左侧优先，左侧放不下才翻到右侧。"""
        self._sync_size()
        b = self.ball
        screen = b.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        bw = b.width()
        bh = b.height()
        x, y, side = position_popup_left_first(
            (b.x(), b.y(), bw, bh),
            (self.width(), self.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            gap=8,
            anchor_ratio=PANEL_ANCHOR_RATIO,
        )
        if side != self.side:
            self.side = side
            b.state["panel_side"] = side
            save_state(b.state)
        self.move(x, y)

    def close_menu(self, user_dismissed=False):
        if self.is_ask_open():
            self._ask_user_hidden = True
        # 用户亲手收起面板 = 这条断联提醒先别再自动叫醒我。
        # 记的是「延后」不是「不用管」：自己再点开面板时，小条照样亮着。
        # 程序内部的收起（打开朗读/润色等子弹窗、答完题）不算，不传这个标记。
        if user_dismissed:
            if self._resume_notice:
                self._resume_deferred_sig = self._resume_notice_sig(self._resume_notice)
            # 用户亲手关掉断点续接专页：退一级面板。专页内部只 hide 面板不会回退页面，
            # 下次点球就会原样再开这张专页——原来靠「返回」按钮兜着，那按钮没了就得在这里退。
            # 提醒不丢：一级面板上「断点续接 · 有待接提醒」那个入口照样能再进去。
            if self._resume_view_active:
                self.close_resume_view()
        if self.target_menu is not None:
            self.target_menu.hide()
        # 润色弹窗是主面板的二级窗：面板收起时一并收起（下次点开是干净状态）
        if self.ball.polish_panel is not None and self.ball.polish_panel.isVisible():
            self.ball.polish_panel.close()
        # 排队窗同款：它是主面板的二级窗，面板收起就收起来
        queue_panel = getattr(self.ball, "queue_panel", None)
        if queue_panel is not None and queue_panel.isVisible():
            queue_panel.close()
        self.hide()

    def showEvent(self, event):
        super().showEvent(event)
        self.activateWindow()
        # 面板是自己点开的：「延后」到此解除，那条没处理的断联提醒重新亮起来。
        self._resume_deferred_sig = None
        # 候选浮签每次开面板都收着（跟旧版一致）：上一次摊开着，重新打开不该接着坦。
        if self.target_menu is not None:
            self.target_menu.hide()
        # 重绘推荐区：hide 只是隐藏控件，上一屏的错误字样会原封不动跟着回来。
        # 这里按当前状态重新画一次，打开就是干净的一屏。
        if not self.is_ask_open():
            self._render_recommend_state()
        self._reset_fade_on_show()
        # 面板开着时正常频率听续接状态与推荐快照。
        self.start_resume_polling()
        self.start_recommend_polling()

    def hideEvent(self, event):
        super().hideEvent(event)
        self._cancel_fade()
        # 收起面板 = 这次「保持错误提示」到头；下次点开回到「点刷新推荐生成一批」。
        self._recommend_sticky = False
        self._recommend_notice = ""
        # 收起不等于收工：改成慢速继续听，不然面板关着时来的提醒永远送不到用户眼前。
        self._slow_resume_polling()
        # 推荐快照不能一刀切停：二级弹窗还开着时它就是它们唯一的数据源。
        self._sync_recommend_polling()

    def enterEvent(self, event):
        super().enterEvent(event)
        self._on_fade_enter()

    def leaveEvent(self, event):
        super().leaveEvent(event)
        self._on_fade_leave()

    # ── 面板拖拽：按住空白处时，展板与花朵保持原距离一起移动 ──
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_press = e.globalPosition().toPoint()
            self._drag_panel_start = self.pos()
            self._drag_ball_start = self.ball.pos()
            self._drag_moved = False
            self._drag_polish_start = (
                self.ball.polish_panel.pos()
                if self.ball.polish_panel is not None and self.ball.polish_panel.isVisible()
                else None
            )
            # 排队弹窗同款
            queue_panel = getattr(self.ball, "queue_panel", None)
            self._drag_queue_start = (
                queue_panel.pos()
                if queue_panel is not None and queue_panel.isVisible()
                else None
            )
            reset_motion = getattr(self.ball, "_reset_drag_motion", None)
            if callable(reset_motion):
                reset_motion()
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._drag_press is not None and (e.buttons() & Qt.MouseButton.LeftButton):
            cur = e.globalPosition().toPoint()
            delta = cur - self._drag_press
            if not self._drag_moved:
                if delta.manhattanLength() < QApplication.startDragDistance():
                    return
                self._drag_moved = True
                self._user_dragged = True
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry()
            dx, dy = clamp_pair_drag(
                delta.x(), delta.y(),
                (self._drag_panel_start.x(), self._drag_panel_start.y(), self.width(), self.height()),
                (self._drag_ball_start.x(), self._drag_ball_start.y(), self.ball.width(), self.ball.height()),
                (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            )
            self.move(self._drag_panel_start + QPoint(dx, dy))
            self.ball.move(self._drag_ball_start + QPoint(dx, dy))
            # 润色弹窗开着时跟随主面板一起动，保持相对位置
            if self._drag_polish_start is not None and self.ball.polish_panel is not None:
                self.ball.polish_panel.move(self._drag_polish_start + QPoint(dx, dy))
                self.ball.polish_panel._user_dragged = True
            # 排队弹窗同款
            queue_panel = getattr(self.ball, "queue_panel", None)
            if self._drag_queue_start is not None and queue_panel is not None:
                queue_panel.move(self._drag_queue_start + QPoint(dx, dy))
                queue_panel._user_dragged = True
            record_motion = getattr(self.ball, "_record_drag_motion", None)
            if callable(record_motion):
                record_motion()
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._drag_moved:
                release_motion = getattr(self.ball, "_release_drag_motion", None)
                if callable(release_motion):
                    release_motion()
                self.ball._save_pos()
            self._drag_press = None
            self._drag_panel_start = None
            self._drag_ball_start = None
            self._drag_moved = False
            self._drag_polish_start = None
            self._drag_queue_start = None
        super().mouseReleaseEvent(e)

    def paintEvent(self, event):
        super().paintEvent(event)
        c = THEME_COLORS[self.ball.theme_mode]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        shadow = QColor(c["shadow"])
        shadow.setAlpha(28 if self.ball.theme_mode == "light" else 52)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(shadow)
        painter.drawRoundedRect(self.rect().adjusted(7, 8, -5, -3), 20, 20)

        painter.setPen(QColor(c["border"]))
        painter.setBrush(QColor(c["panel"]))
        painter.drawRoundedRect(self.rect().adjusted(4, 3, -4, -6), 20, 20)
        # 这里原来还画过一个粉色小圆点当装饰，固定落在面板左上角，
        # 断点续接页的按钮正好压在上面，看着像个莫名其妙的小红点。已去掉。
        painter.end()


# ─────────────────────────────
#  朗读专属弹窗（点主面板「念给我听」打开）
# ─────────────────────────────
class ReadPanel(QFrame):
    """独立朗读窗口：把播放/暂停/继续、重听、刷新回复、收藏集中在一处，
    从推荐面板拆出，空间宽裕不拥挤。关闭即停读；播完自动复位。"""

    read_ready = pyqtSignal(object)   # 合成结果（来自 App 桥 /voice/result）
    fav_ready = pyqtSignal(object)    # 收藏已下线，保留信号但不再接线
    target_ready = pyqtSignal(object) # /target 回包
    replies_ready = pyqtSignal(object) # 回复列表（来自 App 桥 /voice/state）
    full_text_ready = pyqtSignal(object) # 改稿要的整条全文（App 回包）

    WIDTH = 320

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.target_menu_title = "朗读哪段对话？"
        self._name = ""
        # 面板边向：与推荐面板共用同一份 panel_side（贴边翻边后写入），默认左
        self.side = str((getattr(self.ball, "state", None) or {}).get("panel_side") or "left")
        # 双窗拖动状态：朗读窗与花朵始终作为一组移动（与推荐面板一致）
        self._drag_press = None
        self._drag_panel_start = None
        self._drag_ball_start = None
        self._drag_moved = False
        self._user_dragged = False
        self._reading = False
        self._player = None
        self._audio_out = None
        self._media_path = None    # 临时音频文件路径（播放走文件，Qt 内存播 mp3 不稳）
        self._last_read = None     # 最近一次朗读的内容（文本/音频/音色），供收藏
        self._replies = []         # 最新在前，最多 6 条助手回复
        self._reply_index = 0      # 0=最新，1~5=往前第几条
        self._replies_loading = False
        self._replies_error = ""
        self._read_session_path = ""
        self._voice_session_id = ""      # App 桥的会话标识：新链路只认它，不再传路径
        self._voice_entry_id = ""
        self._voice_result_seq = 0       # 只认序号变大，不认时间戳或内容比对
        self._caption_segments = []      # 字幕分段 [(start, end, text)]，空则按句均摊
        self._caption_timer = None
        self._auto_read_pending = False
        self._read_seq = 0
        self._fav_seq = 0
        self._target_seq = 0
        self._replies_seq = 0
        self._refresh_feedback_seq = 0
        self._closed = False
        # 朗读稿：进来时记原文，改稿只影响这一次念什么，不动聊天记录。
        self._reply_original_text = ""
        self._draft_text = ""
        self._draft_edited = False
        self._editing_draft = False
        self._text_seq = 0            # 全文请求序号（桥那边一轮一个）
        self._text_request_seq = 0

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("readPanel")
        self.setFixedWidth(self.WIDTH)

        self.read_ready.connect(self._apply_read_result)
        self.fav_ready.connect(self._apply_fav_result)
        self.target_ready.connect(self._apply_target_state)
        self.replies_ready.connect(self._apply_replies)
        self.full_text_ready.connect(self._apply_full_text)
        self._build_ui()
        self.apply_theme()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 14, 20, 16)
        root.setSpacing(10)

        # 头部：当前助手名 + 关闭
        head = QHBoxLayout()
        head.setSpacing(8)
        self.lbl_head = QLabel("让 助手 说话")
        self.lbl_head.setObjectName("readHead")
        head.addWidget(self.lbl_head)
        head.addStretch(1)
        self.btn_close = QPushButton("✕")
        self.btn_close.setObjectName("readCloseBtn")
        self.btn_close.setFixedSize(24, 24)
        self.btn_close.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_close.setToolTip("收起朗读（停止播放）")
        self.btn_close.clicked.connect(self.close)
        head.addWidget(self.btn_close)
        root.addLayout(head)

        # 朗读目标窗口：与推荐面板共用跟随最近/手动固定逻辑
        target_row = QHBoxLayout()
        target_row.setSpacing(6)
        self.lbl_target_label = QLabel("选择对话")
        self.lbl_target_label.setObjectName("readTargetLabel")
        self.btn_target = QPushButton("跟随最近 ▾")
        self.btn_target.setObjectName("readTargetBtn")
        self.btn_target.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_target.setToolTip("跟随最近活跃的对话，或固定一段窗口")
        self.btn_target.clicked.connect(self._open_target_menu)
        target_row.addWidget(self.lbl_target_label)
        target_row.addWidget(self.btn_target)
        target_row.addStretch(1)
        root.addLayout(target_row)

        self.lbl_target_info = QLabel("")
        self.lbl_target_info.setObjectName("readTargetInfo")
        self.lbl_target_info.setWordWrap(True)
        root.addWidget(self.lbl_target_info)

        self.target_menu = TargetMenu(self)
        self.target_menu.hide()
        root.addWidget(self.target_menu)

        # 朗读哪一条：默认最新，列表里再给最新前的 5 条
        reply_row = QHBoxLayout()
        reply_row.setSpacing(6)
        self.lbl_reply_label = QLabel("选择回复")
        self.lbl_reply_label.setObjectName("readReplyLabel")
        self.btn_reply = QPushButton("最新回复 ▾")
        self.btn_reply.setObjectName("readReplyBtn")
        self.btn_reply.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_reply.setToolTip("默认朗读最新回复，也可以从前 5 条里挑一条")
        self.btn_reply.clicked.connect(self._open_reply_menu)
        self.btn_refresh_replies = QPushButton("↻ 刷新")
        self.btn_refresh_replies.setObjectName("readRefreshBtn")
        self.btn_refresh_replies.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_refresh_replies.setToolTip("重新读取这段对话的最新 6 条助手回复，不会自动朗读")
        self.btn_refresh_replies.clicked.connect(
            lambda checked=False: self.refresh_replies_async(reset_read=True)
        )
        reply_row.addWidget(self.lbl_reply_label)
        reply_row.addWidget(self.btn_reply)
        reply_row.addWidget(self.btn_refresh_replies)
        reply_row.addStretch(1)
        root.addLayout(reply_row)

        self.reply_menu = QFrame(self)
        self.reply_menu.setObjectName("readReplyMenu")
        reply_menu_layout = QVBoxLayout(self.reply_menu)
        reply_menu_layout.setContentsMargins(8, 8, 8, 8)
        reply_menu_layout.setSpacing(5)
        self.reply_list_box = QVBoxLayout()
        self.reply_list_box.setContentsMargins(0, 0, 0, 0)
        self.reply_list_box.setSpacing(5)
        reply_menu_layout.addLayout(self.reply_list_box)
        self.reply_menu.hide()
        root.addWidget(self.reply_menu)

        # 朗读文本预览：完整显示不截断，超长限高；可选中复制。
        # 实机反馈：字一多下半截就看不到、也没法滑 —— 套一层滚动区，预览不再被砌掉。
        self.lbl_text = QLabel("")
        self.lbl_text.setObjectName("readText")
        self.lbl_text.setWordWrap(True)
        self.lbl_text.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.lbl_text.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.read_text_scroll = QScrollArea()
        self.read_text_scroll.setObjectName("readTextScroll")
        self.read_text_scroll.setWidgetResizable(True)
        self.read_text_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.read_text_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.read_text_scroll.setMaximumHeight(132)
        # 背景与滚动条样式统一写在 apply_theme() 的 QSS 里（QScrollArea#readTextScroll），
        # 这里再 setStyleSheet 一份，换主题时两边各说各的，且子控件拿不到主题色。
        self.read_text_scroll.setWidget(self.lbl_text)

        # 改稿：只读时用 QLabel（逐词点亮靠它的富文本），编辑时换 QPlainTextEdit。
        # 两个控件都放在同一位置，切哪个显哪个。
        self.txt_draft = QPlainTextEdit()
        self.txt_draft.setObjectName("readDraft")
        self.txt_draft.setMaximumHeight(132)
        self.txt_draft.setFrameShape(QFrame.Shape.NoFrame)
        self.txt_draft.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.txt_draft.setPlaceholderText("不想读的段落直接删掉，点「保存改稿」就行")
        self.txt_draft.textChanged.connect(self._update_draft_count)
        self.txt_draft.hide()

        draft_row = QHBoxLayout()
        draft_row.setContentsMargins(2, 4, 2, 0)
        draft_row.setSpacing(6)
        self.lbl_draft_count = QLabel("")
        self.lbl_draft_count.setObjectName("readDraftCount")
        draft_row.addWidget(self.lbl_draft_count)
        draft_row.addStretch(1)
        self.btn_restore_draft = QPushButton("还原原文")
        self.btn_restore_draft.setObjectName("readDraftBtn")
        self.btn_restore_draft.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_restore_draft.setToolTip("把稿子还原成这条回复的原文")
        self.btn_restore_draft.clicked.connect(self._restore_draft)
        self.btn_restore_draft.hide()
        self.btn_edit_draft = QPushButton("改稿")
        self.btn_edit_draft.setObjectName("readDraftBtn")
        self.btn_edit_draft.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_edit_draft.setToolTip("删掉不想听的段落，再点朗读")
        self.btn_edit_draft.clicked.connect(self._toggle_edit_draft)
        draft_row.addWidget(self.btn_restore_draft)
        draft_row.addWidget(self.btn_edit_draft)
        root.addLayout(draft_row)

        root.addWidget(self.read_text_scroll)
        root.addWidget(self.txt_draft)

        # 主播放键：读 / 暂停 / 继续 三态
        self.btn_play = QPushButton("🔊 朗读")
        self.btn_play.setObjectName("readPlayBtn")
        self.btn_play.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_play.clicked.connect(self.toggle_play)
        root.addWidget(self.btn_play)

        # 次键：重听 / 收藏（都只作用于当前选中的回复）
        row = QHBoxLayout()
        row.setSpacing(8)
        self.btn_replay = QPushButton("↻ 重听")
        self.btn_replay.setObjectName("readSubBtn")
        self.btn_replay.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_replay.setToolTip("从头重新播放当前选中的回复")
        self.btn_replay.clicked.connect(self.replay_read)
        self.btn_replay.setEnabled(False)
        self.btn_sub_fav = QPushButton("♡ 收藏")
        self.btn_sub_fav.setObjectName("readSubBtn")
        self.btn_sub_fav.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_sub_fav.setToolTip("把当前选中的回复存进收藏，以后不用重新合成、随时能听")
        self.btn_sub_fav.clicked.connect(self.fav_read_async)
        self.btn_sub_fav.setEnabled(False)
        for b in (self.btn_replay, self.btn_sub_fav):
            row.addWidget(b)
        row.addStretch(1)
        root.addLayout(row)

        self.lbl_feedback = QLabel("")
        self.lbl_feedback.setObjectName("readFeedback")
        root.addWidget(self.lbl_feedback)

    # ── 目标窗口与回复选择 ──
    def _clear_reply_menu(self):
        while self.reply_list_box.count():
            item = self.reply_list_box.takeAt(0)
            widget = item.widget()
            if widget:
                widget.hide()
                widget.deleteLater()

    def _reply_choice_text(self, index, preview=""):
        prefix = "最新回复" if index == 0 else f"前 {index} 条回复"
        clean = " ".join(str(preview or "").split())
        return f"{prefix} · {clean or '（没有可预览的文字）'}"

    def _update_reply_button(self):
        label = "最新回复" if self._reply_index == 0 else f"前 {self._reply_index} 条回复"
        self.btn_reply.setText(label + " ▾")

    def _render_replies(self):
        self._clear_reply_menu()
        if self._replies_loading:
            lbl = QLabel("正在读取这段对话的回复…")
            lbl.setObjectName("readReplySub")
            self.reply_list_box.addWidget(lbl)
            return
        if self._replies_error:
            lbl = QLabel(self._replies_error)
            lbl.setObjectName("readReplySub")
            lbl.setWordWrap(True)
            self.reply_list_box.addWidget(lbl)
            retry = QPushButton("↻ 重新读取")
            retry.setObjectName("replyItem")
            retry.setCursor(Qt.CursorShape.PointingHandCursor)
            retry.clicked.connect(lambda checked=False: self.refresh_replies_async(reset_read=True))
            self.reply_list_box.addWidget(retry)
            return
        if not self._replies:
            lbl = QLabel("还没找到可朗读的助手回复")
            lbl.setObjectName("readReplySub")
            self.reply_list_box.addWidget(lbl)
            return
        for index, item in enumerate(self._replies):
            preview = str(item.get("preview") or "")
            btn = QPushButton()
            btn.setObjectName("replyItem")
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setProperty("active", "true" if index == self._reply_index else "false")
            label = self._reply_choice_text(index, preview)
            btn.setText(btn.fontMetrics().elidedText(label, Qt.TextElideMode.ElideRight, 250))
            btn.setToolTip(preview or label)
            btn.clicked.connect(lambda checked=False, i=index: self._pick_reply(i))
            self.reply_list_box.addWidget(btn)
        self.reply_list_box.addStretch(1)

    def _open_reply_menu(self):
        show = not self.reply_menu.isVisible()
        if show:
            self._set_target_selector_visible(False)
        self._set_reply_selector_visible(show)
        if show and not self._replies and not self._replies_loading:
            self.refresh_replies_async()

    def _set_reply_selector_visible(self, visible):
        self.reply_menu.setVisible(bool(visible))
        if visible:
            self.target_menu.hide()
        self._resize_after_target_change()

    def _pick_reply(self, index):
        if index < 0 or index >= len(self._replies):
            return
        self._reply_index = index
        self._update_reply_button()
        self._render_replies()
        self._set_reply_selector_visible(False)
        self._clear_current_read()
        self._show_selected_preview()
        label = "最新回复" if index == 0 else f"前 {index} 条回复"
        self._flash(f"已选{label}，点「朗读」播放")

    def _clear_current_read(self):
        self._read_seq += 1
        self._fav_seq += 1
        self._stop_read()
        self._reset_read_ui()
        self._last_read = None
        self.btn_sub_fav.setEnabled(False)
        self.btn_sub_fav.setText("♡ 收藏")
        self.lbl_text.setText("")
        self._reset_draft("")

    def _show_selected_preview(self):
        """选中哪一条，先把那一条的字摆出来，不必等合成。

        实机反馈：选了回复之后文字区是空的，得点完朗读才出字 —— 那样根本不知道自己选的是哪段。
        现在这里只负责把字摆上，并且把朗读稿重置回原文；删改要自己按「改稿」。
        """
        if not self._replies:
            # 刷新/切目标后列表没拿到时，必须把旧字清掉。
            # 实机（2026-10-22）：切了窗口刷新，列表空了但文字区还摆着上一段对话的内容，
            # 看着就是“刷新也没用”——其实列表早就换空了，只是旧字没撒手。
            self.lbl_text.setText("")
            self._reset_draft("")
            return
        index = min(max(int(self._reply_index), 0), len(self._replies) - 1)
        item = self._replies[index] if isinstance(self._replies[index], dict) else {}
        text = str(item.get("text") or item.get("preview") or "").strip()
        if not text:
            self.lbl_text.setText("")
            self._reset_draft("")
            return
        self._reset_draft(text)
        self.lbl_text.setText(text)
        try:
            self.read_text_scroll.verticalScrollBar().setValue(0)
        except Exception:
            pass
        if item.get("truncated"):
            self.lbl_feedback.setText("这条比较长，预览只有开头；点「改稿」会把全文取回来。")

    # ── 朗读稿（删掉不想读的段落） ──
    def _reset_draft(self, text):
        self._reply_original_text = str(text or "")
        self._draft_text = self._reply_original_text
        self._draft_edited = False
        self._set_editing_draft(False)
        self._update_draft_count()

    def _update_draft_count(self):
        if self._editing_draft:
            text = self.txt_draft.toPlainText()
        else:
            text = self._draft_text
        count = len("".join(str(text or "").split()))
        self.lbl_draft_count.setText(f"{count} 字" if count else "")
        self.btn_restore_draft.setVisible(self._editing_draft or self._draft_edited)

    def _set_editing_draft(self, editing):
        self._editing_draft = bool(editing)
        self.txt_draft.setVisible(self._editing_draft)
        self.read_text_scroll.setVisible(not self._editing_draft)
        self.btn_edit_draft.setText("保存改稿" if self._editing_draft else "改稿")

    def _toggle_edit_draft(self):
        if not self._replies:
            return
        if not self._editing_draft:
            self._set_editing_draft(True)
            self.txt_draft.setPlainText(self._draft_text)
            self.lbl_feedback.setText("不想读哪里就删哪里，删完点「保存改稿」。")
            index = min(max(int(self._reply_index), 0), len(self._replies) - 1)
            item = self._replies[index] if isinstance(self._replies[index], dict) else {}
            # 列表里的字只到 1200 字，长回复得先把全文取回来，不然删完保存就丢了后半截。
            if item.get("truncated"):
                self._request_full_text(str(item.get("entryId") or ""))
            return
        self._save_draft()

    def _save_draft(self):
        text = self.txt_draft.toPlainText().strip()
        if not "".join(text.split()):
            self.lbl_feedback.setText("稿子删空了，留一点字再保存。")
            return
        changed = text != self._draft_text
        self._draft_text = text
        self._draft_edited = text != self._reply_original_text
        self._set_editing_draft(False)
        self.lbl_text.setText(text)
        self._update_draft_count()
        if changed:
            # 稿子变了，之前合成的音频就不算数了，否则按下播放还是旧的那一版。
            self._last_read = None
            self._stop_read()
            self.btn_play.setText("🔊 朗读")
        self.lbl_feedback.setText("稿子只影响这次朗读，不动聊天记录。")

    def _restore_draft(self):
        self._draft_text = self._reply_original_text
        self._draft_edited = False
        if self._editing_draft:
            self.txt_draft.setPlainText(self._draft_text)
        else:
            self.lbl_text.setText(self._draft_text)
        self._update_draft_count()
        self.lbl_feedback.setText("已还原成原文。")

    def _request_full_text(self, entry_id):
        if not entry_id:
            return
        self._text_request_seq += 1
        seq_guard = self._text_request_seq

        def worker():
            payload = {"seq": seq_guard, "entryId": entry_id, "text": "", "error": ""}
            try:
                api_post("/voice/text-request", {"entryId": entry_id}, timeout=5)
                deadline = time.time() + 12.0
                while time.time() < deadline:
                    if self._closed or seq_guard != self._text_request_seq:
                        return
                    state = api_get("/voice/state", timeout=5) or {}
                    result = state.get("textResult")
                    if isinstance(result, dict) and int(state.get("textSeq") or 0) > 0:
                        payload["text"] = str(result.get("text") or "")
                        payload["error"] = str(result.get("error") or "")
                        break
                    time.sleep(0.6)
            except Exception:
                return
            if self._closed or seq_guard != self._text_request_seq:
                return
            try:
                self.full_text_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-full-text").start()

    def _apply_full_text(self, payload):
        if not isinstance(payload, dict):
            return
        if int(payload.get("seq") or 0) != self._text_request_seq:
            return
        if payload.get("error"):
            self.lbl_feedback.setText("全文没取到，编辑器里只有开头那段")
            return
        text = str(payload.get("text") or "")
        if not text or self._draft_edited:
            # 她已经动手改了，不拿全文盖掉。
            return
        index = min(max(int(self._reply_index), 0), len(self._replies) - 1) if self._replies else -1
        item = self._replies[index] if index >= 0 and isinstance(self._replies[index], dict) else {}
        if str(item.get("entryId") or "") != str(payload.get("entryId") or ""):
            return
        self._reply_original_text = text
        self._draft_text = text
        self.txt_draft.setPlainText(text)
        self._update_draft_count()
        self.lbl_feedback.setText("完整正文取回来了。")

    def _open_target_menu(self):
        show = not self.target_menu.isVisible()
        if show:
            self._set_reply_selector_visible(False)
        self._set_target_selector_visible(show)
        if show:
            self.target_menu.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
            if APP_ONLY_ASK:
                # App 模式：候选在球上共用一份，直接渲染缓存。
                # 以前这里无条件走旧插件的 /sessions，App 模式下必然超时，
                # 会出现「读取失败」+ 重试按钮，而主面板同一时刻显示的是另一份。
                self.target_menu.render_from_cache()
            else:
                self.target_menu.refresh_sessions_async()

    def _update_target(self):
        arrow = "▴" if self.target_menu.isVisible() else "▾"
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            label = f"固定 · {title[:6]}" if title else "固定"
        else:
            label = "跟随最近"
        self.btn_target.setText(label + " " + arrow)
        self._update_target_info()

    def _update_target_info(self):
        name = (self.ball.target_name or "").strip()
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            prefix = "固定"
        else:
            title = (self.ball.target_title or "").strip()
            prefix = "跟随最近"
        if title:
            text = " · ".join([prefix, name, title]) if name else " · ".join([prefix, title])
        elif name:
            text = " · ".join([prefix, name]) + "（无标题）"
        else:
            text = "跟随最近 · 正在定位对话…"
        self.lbl_target_info.setText(text)
        self._name = name
        self.lbl_head.setText("让 " + (name or "助手") + " 说话")

    def _on_target_changed(self):
        """TargetMenu 已完成 pin：清掉旧目标，立刻按新目标重拉回复列表。"""
        self._auto_read_pending = False
        self._read_session_path = ""
        self._reply_index = 0
        self._clear_current_read()
        self._update_reply_button()
        self.refresh_replies_async()

    def _sync_target_state(self):
        # App 模式：目标由 /recommend/* 快照推下来，这里只重绘；
        # 打旧插件的 /target 在 App 桥上只会静默失败。
        if APP_ONLY_ASK:
            self._update_target()
            return
        self._target_seq += 1
        target_seq = self._target_seq
        target_revision = getattr(self.ball, "target_revision", 0)

        def worker():
            payload = None
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload = {**data, "seq": target_seq, "target_revision": target_revision}
            except Exception:
                pass
            if payload is not None and not self._closed:
                try:
                    self.target_ready.emit(payload)
                except RuntimeError:
                    pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-read-target").start()

    def _apply_target_state(self, data):
        if data.get("seq") != self._target_seq:
            return
        if data.get("target_revision", getattr(self.ball, "target_revision", 0)) != getattr(self.ball, "target_revision", 0):
            return
        target = data.get("target")
        if target:
            self.ball.target_name = target.get("name") or target.get("agentId") or ""
            self.ball.target_title = target.get("title") or ""
        else:
            self.ball.target_name = ""
            self.ball.target_title = ""
        self.ball.target_mode = "pinned" if data.get("mode") == "pinned" else "auto"
        self.ball.pinned_target = data.get("pinned")
        self._update_target()
        if self.isVisible():
            self.refresh_replies_async()

    def invalidate_target_sync(self):
        """用户主动切换窗口时，让旧目标的声音和回复列表立即失效。"""
        self._target_seq += 1
        self._auto_read_pending = False
        # 先停掉旧语音，但保留旧列表；/pin 失败时仍能回到原选择。
        self._clear_current_read()

    def _set_target_selector_visible(self, visible):
        self.target_menu.setVisible(bool(visible))
        self._update_target()
        self._resize_after_target_change()

    def _resize_after_target_change(self):
        # 与推荐面板一致：菜单/内容变化后重新定位，用户拖过则保持手动位置
        if self.isVisible():
            self._keep_position()

    def refresh_replies_async(self, auto_read=False, reset_read=False):
        if reset_read:
            self._reply_index = 0
            self._clear_current_read()
            self._update_reply_button()
            self._flash("正在刷新回复列表…")
        self._auto_read_pending = bool(auto_read)
        self._replies_seq += 1
        replies_seq = self._replies_seq
        self._refresh_feedback_seq = replies_seq if reset_read else 0
        self._replies_loading = True
        self._replies_error = ""
        self.btn_refresh_replies.setEnabled(False)
        self._render_replies()

        def worker():
            # 新链路：球不能回调 App，只能告诉桥「我开窗了」，然后轮询等 App 把列表推下来。
            payload = {"seq": replies_seq, "ok": False, "replies": [], "sessionId": "", "error": "读取失败，点「↻ 刷新」再试"}
            # 期望的会话：固定了目标就不许收别的窗口的列表。
            # 实机（2026-10-22）：切了窗口点刷新，文字区还是旧窗口的内容 —— App 侧有 60 秒推送缓存，
            # 点刷新只报 readOpen 不报 forcePush，它就不重拉，球一直读着上一段对话的列表。
            expected_sid = ""
            try:
                if self.ball.target_mode == "pinned" and self.ball.pinned_target:
                    expected_sid = str(self.ball.pinned_target.get("sessionId") or "")
            except Exception:
                expected_sid = ""

            def matches(data):
                replies = [item for item in (data.get("replies") or []) if isinstance(item, dict)]
                if not replies:
                    return False
                if not expected_sid:
                    return True
                return str(data.get("sessionId") or "") == expected_sid

            try:
                api_post("/voice/state", {"readOpen": True, "forcePush": True}, timeout=5)
                deadline = time.time() + 8.0
                data = {}
                while time.time() < deadline:
                    data = api_get("/voice/state", timeout=5) or {}
                    if matches(data):
                        break
                    if self._closed:
                        return
                    time.sleep(0.7)
                replies = [item for item in (data.get("replies") or []) if isinstance(item, dict)]
                if not replies:
                    payload["error"] = "这段对话里暂时没有可以朗读的回复"
                elif expected_sid and str(data.get("sessionId") or "") != expected_sid:
                    # 拿到了列表但不是这段对话的：宁可说“没拿到”，不把别的窗口的字摆出来。
                    payload["error"] = "新目标的回复列表还没推上来，稍等再点「↻ 刷新」"
                else:
                    # App 推的是「最新在前」（2026-10-22 起列表按轮聚合，最近的排第一），
                    # 这个面板也习惯最新在前，原样用。以前这里还 reversed 一次，是把旧约定
                    #（旧 → 新）当成了现状，于是「最新回复」念出来的是最旧那一轮。
                    payload = {
                        "seq": replies_seq,
                        "ok": True,
                        "replies": list(replies),
                        "sessionId": str(data.get("sessionId") or ""),
                        "agentId": str(data.get("agentId") or ""),
                        "error": "",
                    }
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"读取失败了 ({e.code})"
                except Exception:
                    payload["error"] = f"读取失败了 ({e.code})"
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.replies_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-read-replies").start()

    def _apply_replies(self, payload):
        if payload.get("seq") != self._replies_seq:
            return
        self._replies_loading = False
        self.btn_refresh_replies.setEnabled(True)
        show_refresh_feedback = payload.get("seq") == self._refresh_feedback_seq
        if show_refresh_feedback:
            self._refresh_feedback_seq = 0
        self._replies_error = payload.get("error") or ""
        self._voice_session_id = str(payload.get("sessionId") or "")
        self._read_session_path = ""
        auto_read = self._auto_read_pending
        self._auto_read_pending = False
        if payload.get("ok") and payload.get("agentId") and not self._name:
            self._name = str(payload.get("agentId") or "")
        if payload.get("ok"):
            self._replies = [item for item in (payload.get("replies") or []) if isinstance(item, dict)][:6]
            self._reply_index = 0
        else:
            self._replies = []
        self._update_target()
        self._update_reply_button()
        self._render_replies()
        self._show_selected_preview()
        self._resize_after_target_change()
        if show_refresh_feedback:
            self._flash(
                "回复列表已更新，点「朗读」播放"
                if payload.get("ok")
                else (self._replies_error or "回复列表读取失败，点「↻ 刷新」再试")
            )
        if auto_read and payload.get("ok") and self._replies and self.isVisible():
            QTimer.singleShot(0, self.read_async)

    # ── 打开 / 定位 ──
    def open_for(self, name, start=False):
        self._closed = False
        self._user_dragged = False
        self._read_seq += 1
        self._fav_seq += 1
        self._target_seq += 1
        self._replies_seq += 1
        requested_name = (name or "").strip()
        self._name = requested_name
        self._reply_index = 0
        self._last_read = None
        self._replies = []
        self._replies_error = ""
        self._replies_loading = False
        self._read_session_path = ""
        self._voice_session_id = ""
        self._auto_read_pending = bool(start)
        self.target_menu.hide()
        self.reply_menu.hide()
        self.lbl_head.setText("让 " + (self._name or "助手") + " 说话")
        self.lbl_text.setText("")
        self._reset_draft("")
        self._stop_read()
        self._reset_read_ui()
        self.btn_sub_fav.setEnabled(False)
        self.btn_sub_fav.setText("♡ 收藏")
        self.btn_refresh_replies.setEnabled(True)
        self._update_reply_button()
        self._update_target()
        if requested_name and not self.ball.target_name:
            self._name = requested_name
            self.lbl_head.setText("让 " + requested_name + " 说话")
        self._render_replies()
        self.apply_theme()
        self.move_to_ball()
        self.show()
        self.raise_()
        self.activateWindow()
        # 布局稳定后再校准一次位置（空文本时高度偏小，读到内容后还会再 settle）
        self._settle()
        # 打开弹窗只读取可选回复，不自动消耗语音额度；start=True 仅保留给
        # 旧调用方的显式兼容路径，正常入口传 False，必须由用户点击「朗读」才合成。
        self.refresh_replies_async(auto_read=bool(start))

    def move_to_ball(self):
        """与推荐面板同一套定位：左侧优先，左侧放不下才翻到右侧。"""
        self._sync_size()
        b = self.ball
        screen = b.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        bw = b.width()
        bh = b.height()
        x, y, side = position_popup_left_first(
            (b.x(), b.y(), bw, bh),
            (self.width(), self.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            gap=8,
            anchor_ratio=PANEL_ANCHOR_RATIO,
        )
        if side != self.side:
            self.side = side
            if getattr(b, "state", None) is not None:
                b.state["panel_side"] = side
                save_state(b.state)
        self.move(x, y)

    def _keep_position(self):
        """内容高度变化后：用户拖过就保持当前，没拖过按球重新锚定（两轮事件循环后）。"""
        if not self.isVisible():
            return
        def settle_now():
            self._sync_size()
            if self._user_dragged:
                screen = self.ball.screen() or QApplication.primaryScreen()
                geo = screen.availableGeometry()
                x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
                y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
                self.move(x, y)
            else:
                self.move_to_ball()
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle_now))

    def _sync_size(self):
        if self.layout() is not None:
            self.layout().activate()
        self.adjustSize()

    def _settle(self):
        # 内容高度变化后等两轮事件循环再调尺寸与位置，避免跳动
        if not self.isVisible():
            return
        self._keep_position()

    # ── 播放控制 ──
    def toggle_play(self):
        if not _HAS_QMULTIMEDIA:
            self._flash("缺少音频播放组件（PyQt6 需要 QtMultimedia），重新安装 PyQt6 就好")
            return
        if self._player is not None:
            st = self._player.playbackState()
            if st == QMediaPlayer.PlaybackState.PlayingState:
                self._player.pause()
                self.btn_play.setText("▶ 继续")
                self._flash("已暂停 · 点 ▶ 继续")
                return
            if st == QMediaPlayer.PlaybackState.PausedState:
                self._player.play()
                self.btn_play.setText("⏸ 暂停")
                self._flash("继续播放中…")
                return
        if self._reading:
            self._flash("正在生成语音，等一下")
            return
        if self._last_read and self._last_read.get("file"):
            # 播完/复位过：直接重播刚读的这段（不重新合成）
            self._play_audio_file(self._last_read["file"], self._last_read.get("format") or "mp3")
            return
        self.read_async()

    def read_async(self):
        if not _HAS_QMULTIMEDIA:
            self._flash("缺少音频播放组件（PyQt6 需要 QtMultimedia），重新安装 PyQt6 就好")
            return
        if self._reading:
            self._flash("正在生成语音，等一下")
            return
        if self.isVisible() and self._replies_loading:
            self._flash("正在读取对话和回复，等一下")
            return
        if self.isVisible() and not self._voice_session_id:
            self._flash("还没拿到目标对话，正在重新读取…")
            self.refresh_replies_async()
            return
        self._read_seq += 1
        read_seq = self._read_seq
        reply_index = self._reply_index
        selected_reply = self._replies[reply_index] if 0 <= reply_index < len(self._replies) else None
        entry_id = str((selected_reply or {}).get("entryId") or "").strip()
        if not entry_id:
            self._flash("这条回复认不出身份了，点「↻ 刷新」重新取一次列表")
            return
        self._voice_entry_id = entry_id
        # 还在改稿就直接按朗读：先把稿子收下，别让她白改一场。
        if self._editing_draft:
            self._save_draft()
            if self._editing_draft:
                return
        self._reading = True
        self._stop_read()
        self.btn_play.setEnabled(False)
        self.btn_play.setText("正在生成语音…")
        choice = "最新一条回复" if reply_index == 0 else f"前 {reply_index} 条回复"
        self.lbl_feedback.setText("正在读 " + (self._name or "助手") + " 的" + choice + "…")
        self.lbl_text.setText("")

        def worker():
            payload = {"ok": False, "error": None, "file": None, "text": None, "readSeq": read_seq}
            try:
                # 桥不认「第 N 条」，只认回复编号；每次选择都会让 selectionSeq 自增。
                select_body = {"entryId": entry_id}
                draft = self._draft_text.strip()
                if self._draft_edited and draft:
                    # 改过稿就走文字通道：不拿 entryId 去拼原文，念的就是她删过的那版。
                    select_body["text"] = draft
                api_post("/voice/select", select_body, timeout=8)
                deadline = time.time() + 45.0
                while time.time() < deadline:
                    if self._closed or self._read_seq != read_seq:
                        return
                    state = api_get("/voice/state", timeout=8) or {}
                    result = state.get("result")
                    result_seq = int(state.get("resultSeq") or 0)
                    if isinstance(result, dict) and result_seq > self._voice_result_seq and str(result.get("entryId") or "") == entry_id:
                        self._voice_result_seq = result_seq
                        payload.update(result)
                        payload["readSeq"] = read_seq
                        break
                    time.sleep(0.8)
                else:
                    payload["error"] = "合成等了很久没回话，再试一次，或先去设置里测试一下朗读模型"
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"出错了 ({e.code})"
                except Exception:
                    payload["error"] = f"出错了 ({e.code})"
            except Exception:
                payload["error"] = "连不上知意，看看 App 开着没"
            if self._closed:
                return
            try:
                self.read_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-read").start()

    def _apply_read_result(self, payload):
        if payload.get("readSeq") is not None and payload.get("readSeq") != self._read_seq:
            return
        if payload.get("ok") and payload.get("file"):
            self._last_read = {
                "text": payload.get("text") or "",
                "file": payload["file"],
                "format": payload.get("format") or "mp3",
                "voiceId": payload.get("voiceId") or "",
                "entryId": payload.get("entryId") or "",
                "agentId": payload.get("agentId") or "",
                # 收藏只存引用，clipId 就是那个引用；没有它就没法收藏。
                "clipId": payload.get("clipId") or "",
            }
            self._play_audio_file(payload["file"], payload.get("format") or "mp3")
            self._start_caption(payload)
            notes = []
            if payload.get("matched") is False:
                notes.append("这句没有引号台词，按整条念的")
            if payload.get("truncated"):
                notes.append("太长，截了一段")
            self.lbl_feedback.setText(" · ".join(notes) or "正在播放…")
            self.btn_sub_fav.setText("♡ 收藏")
            # 朗读成功就把收藏键放活：有 clipId 才能收藏，否则点了只会白等一趟。
            self.btn_sub_fav.setEnabled(bool(payload.get("clipId")))
            self.btn_play.setEnabled(True)
            self.btn_play.setText("⏸ 暂停")
            self._settle()
        else:
            self._stop_caption()
            self._reset_read_ui()
            self._flash(payload.get("error") or "朗读失败，再试一次")
            self.btn_play.setText("🔊 朗读")
            self.lbl_text.setText("")

    def replay_read(self):
        # 新链路的音频是 App 落盘的文件，不再是临时文件，所以看_last_read 里的路径。
        if self._player is None or not (self._last_read or {}).get("file"):
            return
        try:
            self._player.setPosition(0)
            self._player.play()
        except Exception:
            self._flash("重播失败，再点一次朗读试试")
            return
        self.btn_play.setText("⏸ 暂停")
        self._flash("重新播放中…")

    def fav_read_async(self):
        """收藏刚朗读完的这段。

        App 模式：桥上的 /voice/fav → App 侧 /voice/favorites。
        App 那边只存引用（clipId + 文本 + 音色 + 来源伙伴），不复制音频。
        """
        if not self._last_read or not self._last_read.get("audio"):
            self._flash("先朗读一次，才能收藏这段")
            return
        self.btn_sub_fav.setEnabled(False)
        fav_seq = self._fav_seq
        payload_src = dict(self._last_read)
        if not payload_src.get("agentId") and self._read_session_path:
            payload_src["sessionPath"] = self._read_session_path

        if APP_ONLY_ASK:
            self._bridge_fav_async(payload_src, fav_seq)
            return

        def worker():
            payload = {"ok": False, "error": None, "favSeq": fav_seq}
            try:
                data = api_post("/tts/favorite", payload_src, timeout=20)
                payload.update(data or {})
                payload["favSeq"] = fav_seq
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"收藏失败了 ({e.code})"
                except Exception:
                    payload["error"] = f"收藏失败了 ({e.code})"
            except Exception:
                payload["error"] = "收藏失败了，再试一次"
            if self._closed:
                return
            try:
                self.fav_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-fav").start()

    def _bridge_fav_async(self, source, fav_seq):
        """把收藏请求交给桥，再按 favSeq 等 App 推回结果。"""
        clip_id = str(source.get("clipId") or "")

        def worker():
            payload = {"ok": False, "error": "连不上知意，看看 App 开着没", "favSeq": fav_seq}
            try:
                baseline = int((api_get("/voice/state", timeout=5) or {}).get("favSeq") or 0)
                posted = api_post("/voice/fav", {
                    "clipId": clip_id,
                    "text": str(source.get("text") or "")[:600],
                    "format": str(source.get("format") or "mp3"),
                    "voiceId": str(source.get("voiceId") or ""),
                    "agentId": str(source.get("agentId") or ""),
                    "agentName": self._name or "",
                }, timeout=6)
                if not (posted or {}).get("ok"):
                    payload["error"] = (posted or {}).get("error") or "收藏请求没送出去"
                else:
                    deadline = time.time() + 15.0
                    while time.time() < deadline:
                        if self._closed:
                            return
                        state = api_get("/voice/state", timeout=6) or {}
                        result = state.get("favResult")
                        if isinstance(result, dict) and int(state.get("favSeq") or 0) > baseline:
                            payload = {"ok": bool(result.get("ok")), "favSeq": fav_seq}
                            payload["message"] = result.get("message") or ""
                            payload["error"] = result.get("error") or ""
                            break
                        time.sleep(0.5)
                    else:
                        payload["error"] = "知意很久没回话，再点一次收藏试试"
            except Exception as ex:
                payload["error"] = f"连不上知意（{ex}），看看传音樱还开着没"
            if self._closed:
                return
            try:
                self.fav_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-fav-bridge").start()

    def _apply_fav_result(self, payload):
        if "favSeq" in payload and payload.get("favSeq") != self._fav_seq:
            return
        try:
            self.btn_sub_fav.setEnabled(not payload.get("ok"))
            self.btn_sub_fav.setText("✓ 已收藏" if payload.get("ok") else "♡ 收藏")
        except Exception:
            pass
        if payload.get("ok"):
            self._flash(payload.get("message") or "已收藏 ♡ 主页「语音收藏」里能听")
        else:
            self._flash(payload.get("error") or "收藏失败")

    def _init_player(self):
        if self._player is not None:
            return
        self._player = QMediaPlayer(self)
        self._audio_out = QAudioOutput(self)
        self._audio_out.setVolume(1.0)
        self._player.setAudioOutput(self._audio_out)
        self._player.mediaStatusChanged.connect(self._on_media_status)
        self._player.errorOccurred.connect(self._on_media_error)

    def _cleanup_media_file(self):
        p = self._media_path
        self._media_path = None
        if p:
            try:
                os.unlink(p)
            except Exception:
                pass

    def _play_audio_file(self, path, fmt="mp3"):
        """播放 App 已经落盘的音频：直接用绝对路径，不解码 base64、不删 App 的文件。"""
        try:
            self._init_player()
            target = str(path or "")
            if not target or not os.path.exists(target):
                self._stop_caption()
                self._reset_read_ui()
                self._flash("这段音频已经不在了，重新念一次")
                return
            self._cleanup_media_file()
            # _media_path 只记临时文件（现在没有），App 的文件不归球管
            self._player.setSource(QUrl.fromLocalFile(target))
            self._player.play()
            self.btn_play.setEnabled(True)
            self.btn_play.setText("⏸ 暂停")
            self.btn_replay.setEnabled(True)
        except Exception as e:
            self._stop_caption()
            self._reset_read_ui()
            self._flash(f"播放失败：{e}")

    # ── 字幕跟读 ──
    def _start_caption(self, payload):
        self._stop_caption()
        text = str(payload.get("text") or "")
        if not text:
            self.lbl_text.setText("（这一段是纯符号或太短，没读到文字）")
            return
        rows = payload.get("timings")
        segments = []
        if isinstance(rows, list) and rows:
            for row in rows:
                if not isinstance(row, dict):
                    continue
                start = row.get("start")
                end = row.get("end")
                label = str(row.get("text") or "")
                try:
                    start = float(start)
                    end = float(end)
                except (TypeError, ValueError):
                    continue
                if label and end > start:
                    segments.append((start, end, label))
        if not segments:
            # 没拿到词级字幕就按句均摊，界面会说明这次用的是整句估计
            parts = [p for p in re.split(r"(?<=[。！？!?；;\n])", text) if p.strip()]
            total = sum(len(p) for p in parts) or 1
            try:
                duration = float(payload.get("durationMs") or 0)
            except (TypeError, ValueError):
                duration = 0.0
            cursor = 0.0
            for part in parts:
                span = max(400.0, (len(part) / total) * (duration or 0.0))
                segments.append((cursor, cursor + span, part))
                cursor += span
        if not segments:
            self.lbl_text.setText(text)
            return
        self._caption_segments = segments
        self.lbl_text.setText(self._caption_html(-1))
        self._caption_timer = QTimer(self)
        self._caption_timer.setInterval(200)
        self._caption_timer.timeout.connect(self._tick_caption)
        self._caption_timer.start()

    def _caption_html(self, active_index):
        parts = []
        for index, (_start, _end, label) in enumerate(self._caption_segments):
            escaped = (
                str(label)
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
            )
            weight = ' style="font-weight:700"' if index == active_index else ""
            parts.append(f"<span{weight}>{escaped}</span>")
        return '<span style="line-height:190%">' + "".join(parts) + "</span>"

    def _tick_caption(self):
        if self._player is None or not self._caption_segments:
            return
        try:
            position = float(self._player.position())
        except Exception:
            return
        active = -1
        for index, (start, end, _label) in enumerate(self._caption_segments):
            if start <= position < end:
                active = index
                break
        if active != getattr(self, "_caption_active", -1):
            self._caption_active = active
            try:
                self.lbl_text.setText(self._caption_html(active))
            except RuntimeError:
                pass

    def _stop_caption(self):
        if self._caption_timer is not None:
            try:
                self._caption_timer.stop()
                self._caption_timer.deleteLater()
            except RuntimeError:
                pass
            self._caption_timer = None
        self._caption_segments = []
        self._caption_active = -1

    def _play_audio(self, b64_audio, fmt="mp3"):
        try:
            self._init_player()
            raw = base64.b64decode(b64_audio)
            # QtMultimedia 从 QBuffer 内存播 mp3 不稳，写临时文件再播，文件路径最稳
            ext = "wav" if fmt == "wav" else "mp3"
            fd, tmp_path = tempfile.mkstemp(prefix="jiegehua_read_", suffix="." + ext)
            try:
                with os.fdopen(fd, "wb") as fh:
                    fh.write(raw)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass
                raise
            self._cleanup_media_file()
            self._media_path = tmp_path
            self._player.setSource(QUrl.fromLocalFile(tmp_path))
            self._player.play()
            self.btn_play.setEnabled(True)
            self.btn_play.setText("⏸ 暂停")
            self.btn_replay.setEnabled(True)
        except Exception as e:
            self._reset_read_ui()
            self._flash(f"播放失败：{e}")

    def _on_media_status(self, status):
        if status == QMediaPlayer.MediaStatus.EndOfMedia:
            self._stop_read()
            self._reset_read_ui()
            self._flash("读完了 · 想再听就点 ↻ 重听")
        elif status == QMediaPlayer.MediaStatus.InvalidMedia:
            self._reset_read_ui()
            self._flash("音频格式不支持，换个音色试试")

    def _on_media_error(self, error):
        self._reset_read_ui()
        self._flash("播放出错了，再试一次")

    def _stop_read(self):
        try:
            if self._player is not None:
                self._player.stop()
        except Exception:
            pass

    def _reset_read_ui(self):
        self._reading = False
        self._stop_caption()
        self._cleanup_media_file()
        try:
            self.btn_play.setEnabled(True)
            self.btn_play.setText("🔊 朗读")
            self.btn_replay.setEnabled(False)
            self.lbl_feedback.setText("")
        except RuntimeError:
            pass

    def _flash(self, text):
        self.lbl_feedback.setText(text)

    def closeEvent(self, event):
        self._closed = True
        self._read_seq += 1
        self._fav_seq += 1
        self._target_seq += 1
        self._replies_seq += 1
        self._notify_read_window(False)
        self._stop_caption()
        self._stop_read()
        super().closeEvent(event)

    def _notify_read_window(self, opened):
        """告诉 App 朗读窗开/关；失败就忽略，球不能因为 App 不在就崩。"""
        try:
            api_post("/voice/state", {"readOpen": bool(opened)}, timeout=3)
        except Exception:
            pass

    def hideEvent(self, event):
        # 收起朗读窗口 = 结束朗读，别让声音在背后自己放
        self._read_seq += 1
        self._fav_seq += 1
        self._target_seq += 1
        self._replies_seq += 1
        self._refresh_feedback_seq = 0
        self._auto_read_pending = False
        self._read_session_path = ""
        self._voice_session_id = ""
        self._last_read = None
        self.target_menu.hide()
        self.reply_menu.hide()
        self._notify_read_window(False)
        self._stop_read()
        self._stop_caption()
        self._reset_read_ui()
        self.ball._set_fusion_panel_state("none")
        super().hideEvent(event)
        # 朗读窗关了，理顺窗也没开时，让主面板把推荐快照轮询彻底停掉。
        menu = getattr(self.ball, "menu", None)
        sync = getattr(menu, "_sync_recommend_polling", None)
        if callable(sync):
            sync()

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_press = e.globalPosition().toPoint()
            self._drag_panel_start = self.pos()
            self._drag_ball_start = self.ball.pos()
            self._drag_moved = False
            reset_motion = getattr(self.ball, "_reset_drag_motion", None)
            if callable(reset_motion):
                reset_motion()
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._drag_press is not None and (e.buttons() & Qt.MouseButton.LeftButton):
            cur = e.globalPosition().toPoint()
            delta = cur - self._drag_press
            if not self._drag_moved:
                if delta.manhattanLength() < QApplication.startDragDistance():
                    return
                self._drag_moved = True
                self._user_dragged = True
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry()
            dx, dy = clamp_pair_drag(
                delta.x(), delta.y(),
                (self._drag_panel_start.x(), self._drag_panel_start.y(), self.width(), self.height()),
                (self._drag_ball_start.x(), self._drag_ball_start.y(), self.ball.width(), self.ball.height()),
                (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            )
            self.move(self._drag_panel_start + QPoint(dx, dy))
            self.ball.move(self._drag_ball_start + QPoint(dx, dy))
            record_motion = getattr(self.ball, "_record_drag_motion", None)
            if callable(record_motion):
                record_motion()
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._drag_moved:
                release_motion = getattr(self.ball, "_release_drag_motion", None)
                if callable(release_motion):
                    release_motion()
                try:
                    self.ball._save_pos()
                except Exception:
                    pass
            self._drag_press = None
            self._drag_panel_start = None
            self._drag_ball_start = None
            self._drag_moved = False
        super().mouseReleaseEvent(e)

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #readPanel {{
                background: transparent; border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#readHead {{ color: {c['accent_deep']}; font-size: 14px; font-weight: 700; }}
            QLabel#readTargetLabel, QLabel#readReplyLabel {{ color: {c['sub_deep']}; font-size: 11px; }}
            QLabel#readTargetInfo {{ color: {c['sub']}; font-size: 10px; padding-left: 2px; }}
            QPushButton#readTargetBtn, QPushButton#readReplyBtn, QPushButton#readRefreshBtn {{
                min-height: 28px; padding: 0 10px;
                color: {c['accent_deep']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 11px; font-weight: 600;
            }}
            QPushButton#readTargetBtn:hover, QPushButton#readReplyBtn:hover, QPushButton#readRefreshBtn:hover {{
                background: {c['surface']}; border-color: {c['accent']};
            }}
            QFrame#readReplyMenu {{
                background: {c['surface_alt']}; border: 1px dashed {c['border']}; border-radius: 12px;
            }}
            QPushButton#replyItem {{
                min-height: 34px; max-height: 34px; text-align: left; padding: 0 9px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 9px; font-size: 10px;
            }}
            QPushButton#replyItem:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
            QPushButton#replyItem[active="true"] {{
                color: {c['accent_deep']}; background: {c['surface_alt']}; border-color: {c['accent']};
                font-weight: 600;
            }}
            QLabel#readReplySub {{ color: {c['sub']}; font-size: 10px; padding: 3px 2px; }}
            QLabel#readText {{
                background: {c['surface_alt']}; border-radius: 10px;
                padding: 9px 11px; font-size: 12px; line-height: 1.6;
            }}
            QLabel#readDraftCount {{ color: {c['sub']}; font-size: 10px; }}
            QPushButton#readDraftBtn {{
                min-height: 24px; padding: 0 9px;
                color: {c['accent_deep']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 8px;
                font-size: 10.5px; font-weight: 600;
            }}
            QPushButton#readDraftBtn:hover {{ background: {c['surface']}; border-color: {c['accent']}; }}
            QPlainTextEdit#readDraft {{
                background: {c['surface_alt']}; color: {c['ink']};
                border: 1px solid {c['accent']}; border-radius: 10px;
                padding: 7px 10px; font-size: 12px;
            }}
            QScrollArea#readTextScroll {{ background: transparent; border: none; }}
            QScrollArea#readTextScroll > QWidget > QWidget {{ background: transparent; }}
            QScrollBar:vertical {{
                width: 8px; background: transparent; margin: 3px 0;
            }}
            QScrollBar::handle:vertical {{
                min-height: 26px; background: #c9dfd3; border-radius: 4px;
            }}
            QScrollBar::handle:vertical:hover {{ background: {c['accent']}; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
            QScrollBar:horizontal {{
                height: 8px; background: transparent; margin: 0 3px;
            }}
            QScrollBar::handle:horizontal {{
                min-width: 26px; background: #c9dfd3; border-radius: 4px;
            }}
            QScrollBar::handle:horizontal:hover {{ background: {c['accent']}; }}
            QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {{ width: 0; }}
            QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {{ background: transparent; }}
            QLabel#readFeedback {{ color: {c['pink']}; font-size: 11px; font-weight: 600; }}
            QPushButton#readCloseBtn {{
                color: {c['sub']}; background: transparent; border: none;
                border-radius: 12px; font-size: 13px;
            }}
            QPushButton#readCloseBtn:hover {{ background: {c['danger_bg']}; color: {c['pink']}; }}
            QPushButton#readPlayBtn {{
                min-height: 36px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 12px;
                font-size: 13px; font-weight: 600;
            }}
            QPushButton#readPlayBtn:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#readPlayBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QPushButton#readSubBtn {{
                min-height: 28px; padding: 0 10px;
                color: {c['accent_deep']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 11px; font-weight: 600;
            }}
            QPushButton#readSubBtn:hover {{ background: {c['surface']}; border-color: {c['accent']}; }}
            QPushButton#readSubBtn:disabled {{ color: {c['sub']}; }}
        """)
        if hasattr(self, "target_menu"):
            self.target_menu.apply_theme()
        self._render_replies()

    def paintEvent(self, event):
        super().paintEvent(event)
        c = THEME_COLORS[self.ball.theme_mode]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        shadow = QColor(c["shadow"])
        shadow.setAlpha(28 if self.ball.theme_mode == "light" else 52)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(shadow)
        painter.drawRoundedRect(self.rect().adjusted(7, 8, -5, -3), 20, 20)

        painter.setPen(QColor(c["border"]))
        painter.setBrush(QColor(c["panel"]))
        painter.drawRoundedRect(self.rect().adjusted(4, 3, -4, -6), 20, 20)
        painter.end()


# ─────────────────────────────
#  压缩档案弹窗（主面板「查看档案」打开：只读看压缩摘要）
# ─────────────────────────────
class CompactionPanel(FadeOnLeaveMixin, QFrame):
    """把当前目标对话被压缩后的摘要摊开给用户看。

    数据来自代理 /compaction（读会话 JSONL 里的 compaction 条目）：只读、不调模型、
    不写任何文件。对话没压缩过时直接说明，不报错。
    定位/双窗拖动/主题/鼠标离开淡出与朗读、润色弹窗同一套。"""

    archive_ready = pyqtSignal(object)

    WIDTH = 320
    SUMMARY_HEIGHT = 232

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        # 面板边向：与推荐/朗读窗共用同一份 panel_side（贴边翻边后写入）
        self.side = str((getattr(self.ball, "state", None) or {}).get("panel_side") or "left")
        # 双窗拖动状态：档案窗与花朵始终作为一组移动
        self._drag_press = None
        self._drag_panel_start = None
        self._drag_ball_start = None
        self._drag_moved = False
        self._user_dragged = False
        self._closed = False
        self._seq = 0
        self._archive = None      # 最近一次回包
        self._session_path = ""   # 打开时锁定的目标对话，防止看到一半串窗
        self._count = 0           # 这段对话一共压缩过几次
        self._index = 0           # 0 = 最近一次，往前递增

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("compactionPanel")
        self.setFixedWidth(self.WIDTH)

        self.archive_ready.connect(self._apply_archive)
        self._build_ui()
        self.apply_theme()
        self.setup_fade_on_leave()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(20, 14, 20, 16)
        root.setSpacing(8)

        head = QHBoxLayout()
        head.setSpacing(8)
        self.lbl_head = QLabel("压缩档案")
        self.lbl_head.setObjectName("compactionHead")
        head.addWidget(self.lbl_head)
        head.addStretch(1)
        self.btn_close = QPushButton("✕")
        self.btn_close.setObjectName("compactionCloseBtn")
        self.btn_close.setFixedSize(24, 24)
        self.btn_close.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_close.setToolTip("收起压缩档案")
        self.btn_close.clicked.connect(self.close)
        head.addWidget(self.btn_close)
        root.addLayout(head)

        target_row = QHBoxLayout()
        target_row.setSpacing(6)
        self.lbl_target_label = QLabel("当前对话")
        self.lbl_target_label.setObjectName("compactionTargetLabel")
        self.btn_refresh = QPushButton("↻ 刷新")
        self.btn_refresh.setObjectName("compactionBtn")
        self.btn_refresh.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_refresh.setToolTip("重新读一次这段对话的压缩记录（不发模型请求）")
        self.btn_refresh.clicked.connect(lambda checked=False: self.refresh_async())
        target_row.addWidget(self.lbl_target_label)
        target_row.addStretch(1)
        target_row.addWidget(self.btn_refresh)
        root.addLayout(target_row)

        self.lbl_target_info = QLabel("")
        self.lbl_target_info.setObjectName("compactionTargetInfo")
        self.lbl_target_info.setWordWrap(True)
        root.addWidget(self.lbl_target_info)

        # 元信息：压缩时间 / 压缩前 token / 摘要字数
        self.lbl_meta = QLabel("")
        self.lbl_meta.setObjectName("compactionMeta")
        self.lbl_meta.setWordWrap(True)
        root.addWidget(self.lbl_meta)

        self.lbl_sub = QLabel("")
        self.lbl_sub.setObjectName("compactionSub")
        self.lbl_sub.setWordWrap(True)
        root.addWidget(self.lbl_sub)

        # 摘要全文：限高 + 滚动，可选中复制
        self.scroll = QScrollArea(self)
        self.scroll.setObjectName("compactionScroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.scroll.setFixedHeight(self.SUMMARY_HEIGHT)
        self.lbl_summary = QLabel("")
        self.lbl_summary.setObjectName("compactionText")
        self.lbl_summary.setWordWrap(True)
        self.lbl_summary.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.lbl_summary.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.scroll.setWidget(self.lbl_summary)
        root.addWidget(self.scroll)

        # 翻历史压缩：第 N 次 / 共 M 次
        self.pager = QFrame()
        self.pager.setObjectName("compactionPager")
        pager_row = QHBoxLayout(self.pager)
        pager_row.setContentsMargins(0, 0, 0, 0)
        pager_row.setSpacing(6)
        self.lbl_pager = QLabel("")
        self.lbl_pager.setObjectName("compactionSub")
        pager_row.addWidget(self.lbl_pager)
        pager_row.addStretch(1)
        self.btn_older = QPushButton("← 更早")
        self.btn_older.setObjectName("compactionBtn")
        self.btn_older.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_older.setToolTip("往前翻，看更早一次压缩留下的摘要")
        self.btn_older.clicked.connect(lambda checked=False: self.refresh_async(index=self._index + 1))
        self.btn_newer = QPushButton("更近 →")
        self.btn_newer.setObjectName("compactionBtn")
        self.btn_newer.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_newer.setToolTip("往后翻，回到更近一次压缩")
        self.btn_newer.clicked.connect(lambda checked=False: self.refresh_async(index=max(0, self._index - 1)))
        pager_row.addWidget(self.btn_older)
        pager_row.addWidget(self.btn_newer)
        self.pager.hide()
        root.addWidget(self.pager)

        self.btn_copy = QPushButton("复制摘要")
        self.btn_copy.setObjectName("compactionCopyBtn")
        self.btn_copy.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_copy.setToolTip("把当前这条摘要全文复制到剪贴板")
        self.btn_copy.clicked.connect(self.copy_summary)
        self.btn_copy.setEnabled(False)
        root.addWidget(self.btn_copy)

        self.lbl_feedback = QLabel("")
        self.lbl_feedback.setObjectName("compactionFeedback")
        root.addWidget(self.lbl_feedback)

    # ── 打开 / 定位 ──
    def open_near_ball(self):
        self._closed = False
        self._user_dragged = False
        self._seq += 1
        self._archive = None
        self._count = 0
        self._index = 0
        self._session_path = ""
        self.lbl_target_info.setText("")
        self.lbl_meta.setText("")
        self.lbl_sub.setText("")
        self.lbl_feedback.setText("")
        self.lbl_summary.setText("正在读这段对话的压缩记录…")
        self._set_pager_visible(False)
        self.btn_copy.setEnabled(False)
        self.apply_theme()
        self.move_to_ball()
        self.show()
        self.raise_()
        self.activateWindow()
        self._settle()
        self.refresh_async()

    def move_to_ball(self):
        """与推荐面板同一套定位：左侧优先，左侧放不下才翻到右侧。"""
        self._sync_size()
        b = self.ball
        screen = b.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        bw = b.width()
        bh = b.height()
        x, y, side = position_popup_left_first(
            (b.x(), b.y(), bw, bh),
            (self.width(), self.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            gap=8,
            anchor_ratio=PANEL_ANCHOR_RATIO,
        )
        if side != self.side:
            self.side = side
            if getattr(b, "state", None) is not None:
                b.state["panel_side"] = side
                save_state(b.state)
        self.move(x, y)

    def _keep_position(self):
        if not self.isVisible():
            return

        def settle_now():
            self._sync_size()
            if self._user_dragged:
                screen = self.ball.screen() or QApplication.primaryScreen()
                geo = screen.availableGeometry()
                x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
                y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
                self.move(x, y)
            else:
                self.move_to_ball()

        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle_now))

    def _sync_size(self):
        if self.layout() is not None:
            self.layout().activate()
        self.adjustSize()

    def _settle(self):
        if not self.isVisible():
            return
        self._keep_position()

    # ── 取数 ──
    def refresh_async(self, index=None):
        if index is not None:
            self._index = max(0, int(index))
        self._seq += 1
        seq = self._seq
        self.btn_refresh.setEnabled(False)
        expected = self._session_path
        requested_index = self._index
        if self._archive is None:
            self.lbl_summary.setText("正在读这段对话的压缩记录…")

        def worker():
            payload = {"seq": seq, "ok": False, "error": "读取失败，点「↻ 刷新」再试"}
            try:
                route = "/compaction?index=" + str(requested_index)
                if expected:
                    route += "&sessionPath=" + urllib.parse.quote(expected, safe="")
                data = api_get(route, timeout=6)
                if isinstance(data, dict):
                    payload = dict(data)
                    payload["seq"] = seq
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8"))
                    payload["error"] = body.get("error") or f"读取失败了 ({e.code})"
                except Exception:
                    payload["error"] = f"读取失败了 ({e.code})"
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.archive_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="jiegehua-compaction").start()

    def _apply_archive(self, payload):
        if payload.get("seq") != self._seq:
            return
        self.btn_refresh.setEnabled(True)
        if payload.get("ok"):
            returned = str(((payload.get("target") or {}).get("sessionPath")) or "")
            if not self._session_path:
                self._session_path = returned
            elif returned and (
                os.path.normcase(os.path.normpath(returned))
                != os.path.normcase(os.path.normpath(self._session_path))
            ):
                # 看的过程里目标对话变了：不混着显示，提示重开（跟朗读的串窗保护同款）
                self.lbl_summary.setText("当前对话刚刚变了，收起后重新打开档案看看")
                return
            self._count = int(payload.get("count") or 0)
            self._index = int(payload.get("index") or 0)
        self._archive = payload
        self._render()
        self._settle()

    # ── 渲染 ──
    def _render(self):
        arch = self._archive or {}
        target = arch.get("target") or {}
        name = (target.get("name") or "助手").strip()
        title = str(target.get("title") or "").strip()
        mode = "固定窗口" if arch.get("mode") == "pinned" else "跟随最近"
        line = f"{name} · {mode}"
        if title:
            line += f" · {title}"
        self.lbl_target_info.setText(line)

        if not arch.get("ok"):
            self.lbl_meta.setText("")
            self.lbl_sub.setText("")
            self.lbl_summary.setText(str(arch.get("error") or "读取失败，点「↻ 刷新」再试"))
            self._set_pager_visible(False)
            self.btn_copy.setEnabled(False)
            return

        if not arch.get("compacted"):
            self.lbl_meta.setText("这个对话还没压缩过")
            self.lbl_sub.setText("上下文还短，也没触发过自动压缩。等它长了、压缩过之后，这里会摊出压缩后的摘要全文。")
            self.lbl_summary.setText("记忆还全须全尾的，什么都没有被折叠。")
            self._set_pager_visible(False)
            self.btn_copy.setEnabled(False)
            return

        entry = arch.get("entry") or {}
        summary = str(entry.get("summary") or "")
        when = self._format_ts(entry.get("timestamp"))
        tokens = self._format_tokens(entry.get("tokensBefore"))
        chars = int(entry.get("summaryChars") or len(summary))

        meta_bits = []
        if when:
            meta_bits.append(f"压缩于 {when}")
        if tokens:
            meta_bits.append(f"压缩前 {tokens} token")
        meta_bits.append(f"摘要 {chars} 字")
        self.lbl_meta.setText(" · ".join(meta_bits))

        if self._index == 0:
            entries = ((arch.get("verbatim") or {}).get("entries")) or 0
            note = (
                f"这是模型现在看到的历史概要；它之后又续了 {entries} 条原始记录，那些原文没被折叠。"
                if entries
                else "这是模型现在看到的历史概要；它之后还没有新的原始记录。"
            )
            if entry.get("truncated"):
                note += "（摘要太长，这里只显示前一段，复制也是这一段）"
            self.lbl_sub.setText(note)
        else:
            self.lbl_sub.setText("这是一次历史快照：它之后的内容已经被更晚的压缩覆盖，不在模型当前的视野里了。")

        self.lbl_summary.setText(summary or "（这次压缩没有留下摘要文本）")
        self.btn_copy.setEnabled(bool(summary))

        if self._count > 1:
            pos = self._index + 1
            label = "最近一次" if self._index == 0 else f"往前第 {self._index} 次"
            self.lbl_pager.setText(f"第 {pos} 次 / 共 {self._count} 次 · {label}")
            self.btn_older.setEnabled(self._index < self._count - 1)
            self.btn_newer.setEnabled(self._index > 0)
            self._set_pager_visible(True)
        else:
            self._set_pager_visible(False)

    def _set_pager_visible(self, visible):
        self.pager.setVisible(bool(visible))

    def copy_summary(self):
        entry = (self._archive or {}).get("entry") or {}
        text = str(entry.get("summary") or "")
        if not text:
            self._flash("还没有可复制的摘要")
            return
        try:
            QApplication.clipboard().setText(text)
            self._flash("摘要已复制 ✓")
        except Exception:
            self._flash("复制失败，手动选中也可以")

    def _flash(self, text):
        self.lbl_feedback.setText(text)

    @staticmethod
    def _format_ts(iso):
        raw = str(iso or "").strip()
        if not raw:
            return ""
        try:
            dt = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone()
            return f"{dt.month}月{dt.day}日 {dt.hour:02d}:{dt.minute:02d}"
        except Exception:
            return ""

    @staticmethod
    def _format_tokens(value):
        try:
            n = float(value)
        except Exception:
            return ""
        if n >= 10000:
            return f"{n / 10000:.1f} 万"
        return str(int(n))

    # ── 事件 ──
    def showEvent(self, event):
        super().showEvent(event)
        self._reset_fade_on_show()

    def closeEvent(self, event):
        self._closed = True
        self._seq += 1
        self._cancel_fade()
        super().closeEvent(event)

    def hideEvent(self, event):
        self._seq += 1
        self._archive = None
        self._session_path = ""
        self._count = 0
        self._index = 0
        self.lbl_feedback.setText("")
        self._cancel_fade()
        self.ball._set_fusion_panel_state("none")
        super().hideEvent(event)

    def enterEvent(self, event):
        super().enterEvent(event)
        self._on_fade_enter()

    def leaveEvent(self, event):
        super().leaveEvent(event)
        self._on_fade_leave()

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_press = e.globalPosition().toPoint()
            self._drag_panel_start = self.pos()
            self._drag_ball_start = self.ball.pos()
            self._drag_moved = False
            reset_motion = getattr(self.ball, "_reset_drag_motion", None)
            if callable(reset_motion):
                reset_motion()
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._drag_press is not None and (e.buttons() & Qt.MouseButton.LeftButton):
            cur = e.globalPosition().toPoint()
            delta = cur - self._drag_press
            if not self._drag_moved:
                if delta.manhattanLength() < QApplication.startDragDistance():
                    return
                self._drag_moved = True
                self._user_dragged = True
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry()
            dx, dy = clamp_pair_drag(
                delta.x(), delta.y(),
                (self._drag_panel_start.x(), self._drag_panel_start.y(), self.width(), self.height()),
                (self._drag_ball_start.x(), self._drag_ball_start.y(), self.ball.width(), self.ball.height()),
                (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            )
            self.move(self._drag_panel_start + QPoint(dx, dy))
            self.ball.move(self._drag_ball_start + QPoint(dx, dy))
            record_motion = getattr(self.ball, "_record_drag_motion", None)
            if callable(record_motion):
                record_motion()
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._drag_moved:
                release_motion = getattr(self.ball, "_release_drag_motion", None)
                if callable(release_motion):
                    release_motion()
                try:
                    self.ball._save_pos()
                except Exception:
                    pass
            self._drag_press = None
            self._drag_panel_start = None
            self._drag_ball_start = None
            self._drag_moved = False
        super().mouseReleaseEvent(e)

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #compactionPanel {{
                background: transparent; border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#compactionHead {{ color: {c['accent_deep']}; font-size: 14px; font-weight: 700; }}
            QLabel#compactionTargetLabel {{ color: {c['sub_deep']}; font-size: 11px; }}
            QLabel#compactionTargetInfo {{ color: {c['sub']}; font-size: 10px; padding-left: 2px; }}
            QLabel#compactionMeta {{ color: {c['accent_deep']}; font-size: 11px; font-weight: 600; }}
            QLabel#compactionSub {{ color: {c['sub']}; font-size: 10px; }}
            QLabel#compactionFeedback {{ color: {c['pink']}; font-size: 11px; font-weight: 600; }}
            QLabel#compactionText {{
                background: {c['surface_alt']}; border-radius: 10px;
                padding: 9px 11px; font-size: 12px; line-height: 1.6;
            }}
            QScrollArea#compactionScroll {{ background: transparent; border: none; }}
            QScrollArea#compactionScroll > QWidget > QWidget {{ background: transparent; }}
            QScrollBar:vertical {{ background: transparent; width: 6px; margin: 2px; }}
            QScrollBar::handle:vertical {{ background: {c['border']}; border-radius: 3px; min-height: 20px; }}
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
            QPushButton#compactionCloseBtn {{
                color: {c['sub']}; background: transparent; border: none;
                border-radius: 12px; font-size: 13px;
            }}
            QPushButton#compactionCloseBtn:hover {{ background: {c['danger_bg']}; color: {c['pink']}; }}
            QPushButton#compactionBtn {{
                min-height: 28px; padding: 0 10px;
                color: {c['accent_deep']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 11px; font-weight: 600;
            }}
            QPushButton#compactionBtn:hover {{ background: {c['surface']}; border-color: {c['accent']}; }}
            QPushButton#compactionBtn:disabled {{ color: {c['sub']}; }}
            QPushButton#compactionCopyBtn {{
                min-height: 34px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 12px;
                font-size: 12px; font-weight: 600;
            }}
            QPushButton#compactionCopyBtn:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#compactionCopyBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
        """)

    def paintEvent(self, event):
        super().paintEvent(event)
        c = THEME_COLORS[self.ball.theme_mode]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        shadow = QColor(c["shadow"])
        shadow.setAlpha(28 if self.ball.theme_mode == "light" else 52)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(shadow)
        painter.drawRoundedRect(self.rect().adjusted(7, 8, -5, -3), 20, 20)

        painter.setPen(QColor(c["border"]))
        painter.setBrush(QColor(c["panel"]))
        painter.drawRoundedRect(self.rect().adjusted(4, 3, -4, -6), 20, 20)
        painter.end()


# ─────────────────────────────
#  把话理顺弹窗（主面板「把话理顺」打开）
# ─────────────────────────────
def merge_polish_result(payload, result):
    """把桥回包合进本地 payload，但丢掉回包里的 seq。

    回包里的 seq 是 App 侧的请求编号（桥的 requestSeq），跟面板自己的 _request_seq
    分属两套计数：只要面板开过一次又关掉（closeEvent 也会 +1）、或者某次请求被桥拒了，
    两边就永远错一位。之前直接 payload.update(result)，结果 _apply_polish_result 拿
    App 的号跟本地的比，每次都判“过期回包”，直接把结果丢掉——界面就永远停在
    「正在理顺…」，连带淡出也被 _fade_allowed 锁住。这里只取内容，序号永远用本地的。
    """
    for key, value in dict(result or {}).items():
        if key != "seq":
            payload[key] = value
    return payload


def queue_receipt_matches(state, my_seq=0, baseline=0, baseline_known=True):
    """这份回包是不是我们这次排队请求的？认不出来就返回 None。

    主判据：状态里回声带的请求号（App 每次推状态都带着当前请求号）——准。
    粗判据：状态序号涨过我们发请求那一刻——只认序号会把别的请求推来的状态当成自己这份，
    所以它只在拿不到请求号时才用，而且**预读失败时不用**（那时候基线是 0，条件恒真，
    第一次轮询就会拿一个可能很旧的状态当回执）。
    """
    if not isinstance(state, dict) or not state.get("ok"):
        return None
    pushed = state.get("state")
    if not isinstance(pushed, dict):
        return None
    try:
        seq = int(pushed.get("seq") or pushed.get("requestSeq") or 0)
    except (TypeError, ValueError):
        seq = 0
    try:
        mine = int(my_seq or 0)
    except (TypeError, ValueError):
        mine = 0
    if mine and seq == mine:
        return pushed
    # 推送带着别人的请求号：这份状态根本不是我们这份，粗判据也不能拿来凑。
    if seq:
        return None
    if not baseline_known:
        return None
    try:
        base = int(baseline or 0)
    except (TypeError, ValueError):
        return None
    try:
        if int(state.get("stateSeq") or 0) > base:
            return pushed
    except (TypeError, ValueError):
        return None
    return None


def bridge_queue_call(kind, text, rounds, session_id, timeout_s=25, cancelled=None):
    """球 → 桥的排队请求：发一次，再等 App 的回包。

    回包认两样（见 queue_receipt_matches）：App 回声带的那次请求号，以及状态序号涨没涨。
    等到就返回 App 推来的状态；等满 25 秒还没等到，最后再确认一次——
    App 那边可能早就收下这一发了，只是回包晚到，那就不该报「知意没回话」。
    """
    def _cancelled():
        return bool(callable(cancelled) and cancelled())

    deadline = time.time() + timeout_s
    baseline_known = True
    try:
        before = api_get("/queue/state", timeout=4)
    except Exception:
        before = {}
        baseline_known = False
    baseline = int(before.get("stateSeq") or 0) if isinstance(before, dict) else 0
    my_seq = 0
    try:
        posted = api_post("/queue/request", {
            "kind": kind,
            "text": text or "",
            "rounds": int(rounds or 1),
            "sessionId": session_id or "",
        }, timeout=6)
        my_seq = int((posted or {}).get("seq") or 0)
    except Exception:
        return None
    _panel_diag("queue-send", kind=kind, textLen=len(text or ""), rounds=int(rounds or 1),
                sessionId=session_id or "", mySeq=my_seq, baseline=baseline,
                baselineKnown=baseline_known)

    while time.time() < deadline:
        if _cancelled():
            return None
        try:
            state = api_get("/queue/state", timeout=4)
        except Exception:
            time.sleep(0.3)
            continue
        pushed = queue_receipt_matches(state, my_seq, baseline, baseline_known)
        if pushed is not None:
            _panel_diag("queue-receipt", mySeq=my_seq, baseline=baseline,
                        stateSeq=(state or {}).get("stateSeq"), pushSeq=(pushed or {}).get("seq"),
                        ok=(pushed or {}).get("ok"), text=(pushed or {}).get("text"))
            return pushed
        time.sleep(0.3)
    # 等不到不算没排上：最后再问一次，App 那边可能早就收下这一发了。
    try:
        state = api_get("/queue/state", timeout=4)
        pushed = queue_receipt_matches(state, my_seq, baseline, baseline_known)
        if pushed is not None:
            _panel_diag("queue-receipt-late", mySeq=my_seq, baseline=baseline,
                        stateSeq=(state or {}).get("stateSeq"))
            return pushed
    except Exception:
        pass
    _panel_diag("queue-timeout", kind=kind, mySeq=my_seq, baseline=baseline)
    return None


def bridge_polish_call(kind, text, level, timeout_s=40, deliver_as="", session_id="", cancelled=None,
                       source="", previous="", instruction=""):
    """球 → 桥的润色 / 发送请求：发一次，再按 resultSeq 轮询等 App 回包。

    球不能回调 App，只能轮询，所以做成“发一次 + 按序号等回包”。
    cancelled 是可调用的“用户已关窗”检查，避免关窗后还在这白等。
    等不到就返回 None，由调用方报“知意没回话”，不假装成功。

    source / previous / instruction 三个可选参数是给“在原版上接着改”用的：
      source = 最初那版原话（安全校验的锚，不随上一版漂）
      previous = 上一版结果（有这个才走“只改点名处”的迭代）
      instruction = 用户这次额外提的整理方向
    """
    def _cancelled():
        return bool(callable(cancelled) and cancelled())

    deadline = time.time() + timeout_s
    try:
        before = api_get("/polish/state", timeout=4)
    except Exception:
        before = {}
    baseline = int(before.get("resultSeq") or 0) if isinstance(before, dict) else 0
    try:
        api_post("/polish/request", {
            "kind": kind, "text": text, "level": level or "standard",
            "deliverAs": deliver_as or "steer",
            "sessionId": session_id or "",
            "source": source or "",
            "previous": previous or "",
            "instruction": instruction or "",
        }, timeout=6)
    except Exception:
        return None
    while time.time() < deadline:
        if _cancelled():
            return None
        try:
            state = api_get("/polish/state", timeout=4)
        except Exception:
            time.sleep(0.3)
            continue
        if not isinstance(state, dict) or not state.get("ok"):
            time.sleep(0.3)
            continue
        if int(state.get("resultSeq") or 0) > baseline and isinstance(state.get("result"), dict):
            result = state["result"]
            # 只认自己要的那一种回包：捋和候选方向共用同一条结果通道，
            # 不核对类型的话，先回来的那个会被另一边当成自己的结果
            # （捋拿到一个只有 items 的回包，会把输入框直接清空）。
            # 旧版 App 不带 kind，那种情况下照旧接受。
            got_kind = str(result.get("kind") or "")
            if got_kind and got_kind != str(kind or ""):
                time.sleep(0.3)
                continue
            return result
        time.sleep(0.3)
    return None
class PolishPanel(FadeOnLeaveMixin, QFrame):
    """把随手写的、口语化的提示词捋成 AI 更好理解的样子。
    输入 → 选力度 → 理顺 → 结果回填可改 → 发送进当前对话。
    发送成功自动收起；与朗读弹窗同款独立二级弹窗。"""

    polish_ready = pyqtSignal(object)     # /polish 回包
    send_ready = pyqtSignal(object)       # /polish/send 回包
    suggest_ready = pyqtSignal(object)    # 候选方向回包（list）
    target_ready = pyqtSignal(object)     # /target 回包

    WIDTH = 344
    # 档位只剩一档：均衡。以前标准/深度摆两个按钮，两档提示词只差 47 个字，
    # 用户站在前面分不出差别，等于抽签。于是从界面收走，不再问；后端仍认旧值。
    LEVEL = "balanced"

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.side = str((getattr(self.ball, "state", None) or {}).get("panel_side") or "left")
        self._drag_press = None
        self._drag_panel_start = None
        self._drag_ball_start = None
        self._drag_moved = False
        self._user_dragged = False
        self._level = self.LEVEL
        self._polishing = False
        self._sending = False
        self._closed = False
        self._request_seq = 0
        self._target_seq = 0
        self._target_synced_once = False
        # 原文锚点：第一次捋的那段原话。此后无论捋几轮，安全校验都对着它，
        # 以前每次都拿输入框内容当基线，而输入框里已经是上一版了，会越捋越偏。
        self._anchor_text = ""
        # 上一次捋出来的结果：用来判断“输入框里的是不是上一版，该不该走迭代”。
        self._last_result = ""
        self._suggest_seq = 0
        self._suggest_busy = False

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("polishPanel")
        self.setFixedWidth(self.WIDTH)

        self.polish_ready.connect(self._apply_polish_result)
        self.send_ready.connect(self._apply_send_result)
        self.suggest_ready.connect(self._apply_suggest_result)
        self.target_ready.connect(self._apply_target_state)
        self._build_ui()
        self.apply_theme()
        self.setup_fade_on_leave()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(18, 14, 18, 14)
        root.setSpacing(9)

        # 头部：标题 + 关闭
        head = QHBoxLayout()
        head.setSpacing(8)
        self.lbl_head = QLabel("✨ 把话理顺")
        self.lbl_head.setObjectName("polishHead")
        head.addWidget(self.lbl_head)
        head.addStretch(1)
        self.btn_close = QPushButton("✕")
        self.btn_close.setObjectName("polishCloseBtn")
        self.btn_close.setFixedSize(24, 24)
        self.btn_close.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_close.setToolTip("收起小窗")
        self.btn_close.clicked.connect(self.close)
        head.addWidget(self.btn_close)
        root.addLayout(head)

        self.lbl_desc = QLabel("把随手写的话理顺，原意不乱，结果可以再改。")
        self.lbl_desc.setObjectName("polishDesc")
        self.lbl_desc.setWordWrap(True)
        root.addWidget(self.lbl_desc)

        # 发送到：哪个对话（跟随最近 / 自己固定一段；与朗读/主面板共用同一套目标）
        target_row = QHBoxLayout()
        target_row.setSpacing(6)
        self.lbl_target_label = QLabel("发送到")
        self.lbl_target_label.setObjectName("polishTargetLabel")
        target_row.addWidget(self.lbl_target_label)
        self.btn_target = QPushButton("跟随最近 ▾")
        self.btn_target.setObjectName("polishTargetBtn")
        self.btn_target.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_target.setToolTip("理顺后发进哪段对话：默认跟随最近活跃，也可自己固定一段")
        self.btn_target.clicked.connect(self._open_target_menu)
        target_row.addWidget(self.btn_target)
        target_row.addStretch(1)
        root.addLayout(target_row)

        self.lbl_target_info = QLabel("")
        self.lbl_target_info.setObjectName("polishTargetInfo")
        self.lbl_target_info.setWordWrap(True)
        root.addWidget(self.lbl_target_info)

        self.target_menu = TargetMenu(self)
        self.target_menu.hide()
        root.addWidget(self.target_menu)

        # 输入框：多行，写糙话 / 展示捋好结果
        self.input = QPlainTextEdit()
        self.input.setObjectName("polishInput")
        self.input.setPlaceholderText("写下你想对 AI 说的话…")
        self.input.setFixedHeight(120)
        root.addWidget(self.input)

        # 补充要求：可选一句，说这次想怎么捋（语气、长短、繁简）。
        # 不写就按档位走；写了也只管表达方式，不许凭空加信息。
        self.require_input = QLineEdit()
        self.require_input.setObjectName("polishRequire")
        self.require_input.setPlaceholderText("还想怎么顺？可选，比如：收短一点")
        self.require_input.setMaxLength(200)
        self.require_input.setToolTip("写一句整理方向：只管语气、长短、繁简、分不分条，不会替你加原文没有的信息")
        self.require_input.returnPressed.connect(self._on_require_enter)
        root.addWidget(self.require_input)

        # 候选方向：捋完一版才出现，点一下就是一次定向迭代。
        # 专给“知道不太对、但说不出哪儿不对”的人用，拿不到就整个收起。
        self.suggest_box = QFrame()
        self.suggest_box.setObjectName("polishSuggestBox")
        suggest_root = QVBoxLayout(self.suggest_box)
        suggest_root.setContentsMargins(0, 0, 0, 0)
        suggest_root.setSpacing(5)
        self.lbl_suggest_title = QLabel("还能往这些方向改")
        self.lbl_suggest_title.setObjectName("polishSuggestTitle")
        suggest_root.addWidget(self.lbl_suggest_title)
        self.suggest_rows = QVBoxLayout()
        self.suggest_rows.setContentsMargins(0, 0, 0, 0)
        self.suggest_rows.setSpacing(5)
        suggest_root.addLayout(self.suggest_rows)
        self.suggest_box.hide()
        root.addWidget(self.suggest_box)
        # 输入框聚焦时不淡出（与问问小花一致）
        self.input._polish_orig_focus_in = self.input.focusInEvent
        self.input._polish_orig_focus_out = self.input.focusOutEvent
        self.input.focusInEvent = self._on_input_focus_in
        self.input.focusOutEvent = self._on_input_focus_out

        # 按钮行：理顺 + 排队（等这一轮说完再发）+ 发送（立刻插话）
        btn_row = QHBoxLayout()
        btn_row.setSpacing(8)
        self.btn_polish = QPushButton("✨ 理顺")
        self.btn_polish.setObjectName("polishBtn")
        self.btn_polish.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_polish.setToolTip("把输入框里的话理顺，让 AI 更好理解；只顺表达，不动原意")
        self.btn_polish.clicked.connect(self.polish_async)
        self.btn_polish.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        btn_row.addWidget(self.btn_polish, 1)
        self.btn_queue = QPushButton("排队发送")
        self.btn_queue.setObjectName("polishQueueBtn")
        self.btn_queue.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_queue.setToolTip("ta 说完再发，不打断当前回复")
        self.btn_queue.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.btn_queue.clicked.connect(lambda: self.send_async("followUp"))
        btn_row.addWidget(self.btn_queue, 1)
        self.btn_send = QPushButton("发送")
        self.btn_send.setObjectName("polishSendBtn")
        self.btn_send.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_send.setToolTip("立刻发进当前对话（插话，不等 ta 说完）")
        self.btn_send.clicked.connect(lambda: self.send_async("steer"))
        self.btn_send.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        btn_row.addWidget(self.btn_send, 1)
        root.addLayout(btn_row)

        self.lbl_status = QLabel("")
        self.lbl_status.setObjectName("polishStatus")
        self.lbl_status.setWordWrap(True)
        self.lbl_status.hide()
        root.addWidget(self.lbl_status)

    def polish_text(self):
        return self.input.toPlainText().strip()

    # ── 发送目标（与朗读/主面板共用同一套 TargetMenu 协议） ──
    def _update_target(self):
        arrow = "▴" if self.target_menu is not None and self.target_menu.isVisible() else "▾"
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            label = f"固定 · {title[:8]}" if title else "固定"
        else:
            label = "跟随最近"
        self.btn_target.setText(f"{label} {arrow}")
        self._update_target_info()

    def _update_target_info(self):
        name = (self.ball.target_name or "").strip()
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            prefix = "固定对话"
        else:
            title = (self.ball.target_title or "").strip()
            prefix = "跟随最近"
        if title:
            text = " · ".join([prefix, name, title]) if name else " · ".join([prefix, title])
        elif name:
            text = " · ".join([prefix, name]) + "（无标题）"
        else:
            text = "跟随最近 · 正在定位对话…"
        self.lbl_target_info.setText(text)

    def _open_target_menu(self):
        show = not self.target_menu.isVisible()
        self._set_target_selector_visible(show)
        if show:
            self.target_menu.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
            if APP_ONLY_ASK:
                # App 模式：候选在球上共用一份（与主面板、朗读窗同一份数据）。
                self.target_menu.render_from_cache()
            else:
                self.target_menu.refresh_sessions_async()

    def _set_target_selector_visible(self, visible):
        self.target_menu.setVisible(bool(visible))
        self._update_target()
        self._resize_after_target_change()

    def invalidate_target_sync(self):
        """用户主动切目标时作废先前的 /target 回包，避免旧状态覆盖新选择。"""
        self._target_seq += 1

    def _resize_after_target_change(self):
        def settle():
            self._sync_size()
            if self.isVisible():
                if self._user_dragged:
                    self._reanchor()
                else:
                    self._move_to_ball()
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle))

    def _sync_target_state(self):
        """打开弹窗时同步一次全局目标（pinned 固定 / 跟随最近），并刷新显示。"""
        # App 模式：目标由 /recommend/* 快照推下来，这里只重绘；
        # 打旧插件的 /target 在 App 桥上只会静默失败。
        if APP_ONLY_ASK:
            self._update_target()
            return
        self._target_seq += 1
        target_seq = self._target_seq
        target_revision = getattr(self.ball, "target_revision", 0)

        def worker():
            payload = None
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload = {**data, "seq": target_seq, "target_revision": target_revision}
            except Exception:
                pass
            if payload is not None and not self._closed:
                try:
                    self.target_ready.emit(payload)
                except RuntimeError:
                    pass

        threading.Thread(target=worker, daemon=True, name="zhujian-polish-target").start()

    def _apply_target_state(self, data):
        if data.get("seq") != self._target_seq:
            return
        if data.get("target_revision", getattr(self.ball, "target_revision", 0)) != getattr(self.ball, "target_revision", 0):
            return
        t = data.get("target") or {}
        self.ball.target_name = t.get("name") or t.get("agentId") or ""
        self.ball.target_title = t.get("title") or ""
        self.ball.target_mode = "pinned" if data.get("mode") == "pinned" else "auto"
        self.ball.pinned_target = data.get("pinned")
        self._update_target()

    # ── 润色 ──
    def polish_async(self):
        if self._polishing:
            return
        text = self.polish_text()
        if not text:
            self._set_status("先写点什么再理顺嘛", ok=False)
            return
        self._polishing = True
        self._request_seq += 1
        request_seq = self._request_seq
        self._set_busy(True, polishing=True)
        self._clear_suggestions()
        # 旧标签收起后窗要跟着缩回去，否则留下一块空白等新结果
        self._resize_after_layout_change()
        level = self._level

        # 这次是「在上一版上改」还是「重新捋一句话」：
        # 输入框里还是上一版结果、且不等于最初原文时，才算迭代。
        # 用户自己动过输入框就当新原文，不然一个改过的版本套着旧锚点，两边打架。
        revising = (bool(self._last_result) and text == self._last_result
                    and text != self._anchor_text)
        if not revising:
            self._anchor_text = text
        anchor = self._anchor_text or text
        previous = self._last_result if revising else ""
        instruction = self.require_input.text().strip()
        self._set_status("接着改这一处…" if revising else "正在理顺…", ok=True)

        def worker():
            payload = {"ok": False, "error": "连不上知意，看看 App 开着没", "seq": request_seq}
            if APP_ONLY_ASK:
                # App 模式：球够不着 App 的 /polish，走桥上那对请求/结果。
                result = self._bridge_polish_call(
                    "polish", text, level,
                    source=anchor, previous=previous, instruction=instruction)
                if result is not None:
                    merge_polish_result(payload, result)
                else:
                    payload["error"] = "知意那边没回话，再点一次试试"
                if self._closed or request_seq != self._request_seq:
                    return
                try:
                    self.polish_ready.emit(payload)
                except RuntimeError:
                    pass
                return
            try:
                data = api_post("/polish", {
                    "text": text, "level": level,
                    "source": anchor, "previous": previous, "instruction": instruction,
                }, timeout=35)
                payload.update(data or {})
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8", "replace"))
                    payload["error"] = body.get("error") or f"理顺失败了 ({e.code})"
                except Exception:
                    payload["error"] = f"理顺失败了 ({e.code})"
            except Exception as ex:
                payload["error"] = f"连不上解语花（{ex}），看看传音樱还开着没"
            if self._closed or request_seq != self._request_seq:
                return
            try:
                self.polish_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-polish-worker").start()

    def _bridge_polish_call(self, kind, text, level, timeout_s=40, deliver_as="",
                            source="", previous="", instruction=""):
        return bridge_polish_call(
            kind, text, level, timeout_s=timeout_s, deliver_as=deliver_as,
            session_id=getattr(self.ball, "_polish_session_id", "") or "",
            cancelled=lambda: self._closed,
            source=source, previous=previous, instruction=instruction,
        )

    def _apply_polish_result(self, payload):
        if self._closed or (payload.get("seq") is not None and payload.get("seq") != self._request_seq):
            return
        # 桥上结果通道是共用的：没正文也没报错的回包不是润色结果（比如候选方向那个），
        # 拿去 setPlainText 会把用户刚写的字直接清空。
        if payload.get("ok") and "text" not in payload:
            return
        self._polishing = False
        self._set_busy(False, polishing=True)
        if payload.get("ok"):
            result_text = payload.get("text") or ""
            revising = payload.get("revising") is True
            self._last_result = result_text
            self.input.setPlainText(result_text)
            # 一字未改也说「捋好了」会让人以为功能没生效，这里把实际情况说清楚。
            if payload.get("unchanged"):
                self._set_status("这处已经差不多了，我没动它；想说清哪块不对就写在上面那行", ok=True)
            elif payload.get("fellBack"):
                if revising:
                    self._set_status("这次的改动我拿不准会不会改歪意思，先留着你这一版", ok=True)
                else:
                    self._set_status("这版改写我拿不准会不会改错意思，先按你原文留着", ok=True)
            elif revising:
                self._set_status("改好了，就动了那一处", ok=True)
            else:
                self._set_status("理顺好了，可以再改改", ok=True)
            # 补充要求只管一次：不清掉的话，下一轮会接着带上同一条要求，
            # 用户点个候选标签也会被旧要求抢在前面。
            self.require_input.clear()
            self.input.setFocus()
            self._request_suggest()
        else:
            self._set_status(payload.get("error") or "没顺出结果，再试一次", ok=False)

    # ── 候选方向（捋完之后才出现） ──
    def _on_require_enter(self):
        """在补充要求那一行按回车，直接捋。"""
        self.polish_async()

    def _request_suggest(self):
        """捋完之后问一次「还能往哪儿改」。

        专给「知道不太对、但说不出哪儿不对」的人用。拿不到就安静收场：
        不占状态行、不报错、不弹任何提示，这个功能本身不能变成新的打断源。
        """
        text = (self._anchor_text or "").strip()
        if not text:
            self.suggest_box.hide()
            return
        self._suggest_seq += 1
        seq = self._suggest_seq
        level = self._level

        def worker():
            items = []
            try:
                if APP_ONLY_ASK:
                    result = self._bridge_polish_call("suggest", text, level, timeout_s=28)
                    if isinstance(result, dict) and result.get("ok"):
                        items = result.get("items") or []
                else:
                    data = api_post("/polish/suggest", {"text": text}, timeout=28)
                    if isinstance(data, dict):
                        items = data.get("items") or []
            except Exception:
                items = []
            if self._closed or seq != self._suggest_seq:
                return
            try:
                self.suggest_ready.emit(items)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-suggest-worker").start()

    def _apply_suggest_result(self, items):
        self._clear_suggestions()
        rows = []
        for item in items or []:
            if not isinstance(item, dict):
                continue
            label = str(item.get("label") or "").strip()
            prompt = str(item.get("prompt") or "").strip()
            if label and prompt:
                rows.append((label[:12], prompt))
        if not rows or self._closed:
            self._resize_after_layout_change()
            return
        per_row = 2
        for start in range(0, len(rows), per_row):
            row = QHBoxLayout()
            row.setSpacing(5)
            for label, prompt in rows[start:start + per_row]:
                btn = QPushButton(label)
                btn.setObjectName("polishSuggestBtn")
                btn.setCursor(Qt.CursorShape.PointingHandCursor)
                btn.setToolTip(prompt)
                btn.clicked.connect(lambda _=False, p=prompt: self._apply_suggestion(p))
                row.addWidget(btn)
            row.addStretch(1)
            self.suggest_rows.addLayout(row)
        self.suggest_box.show()
        self._resize_after_layout_change()

    def _apply_suggestion(self, prompt):
        """点一下候选方向：把它当成这次的整理方向，直接再捋一次。"""
        if self._polishing or self._closed:
            return
        self.require_input.setText(prompt)
        self.require_input.setCursorPosition(0)
        self.polish_async()

    def _clear_suggestions(self):
        if getattr(self, "suggest_rows", None) is None:
            return
        while self.suggest_rows.count():
            entry = self.suggest_rows.takeAt(0)
            layout = entry.layout()
            if layout is not None:
                while layout.count():
                    child = layout.takeAt(0)
                    widget = child.widget()
                    if widget is not None:
                        widget.deleteLater()
                layout.deleteLater()
            else:
                widget = entry.widget()
                if widget is not None:
                    widget.deleteLater()
        self.suggest_box.hide()

    def _resize_after_layout_change(self):
        """尺寸变了（候选标签出现或收起）：按 target 菜单那套重新贴回球边。"""
        self._resize_after_target_change()

    # ── 发送 ──
    def send_async(self, deliver_as="steer"):
        if self._sending:
            return
        text = self.polish_text()
        if not text:
            self._set_status("没有可发送的内容", ok=False)
            return
        deliver_as = "followUp" if deliver_as == "followUp" else "steer"
        self._sending = True
        self._request_seq += 1
        request_seq = self._request_seq
        self._set_busy(True, sending=True)
        self._set_status("正在排队…" if deliver_as == "followUp" else "正在发送…", ok=True)

        def worker():
            payload = {"ok": False, "error": "连不上知意，看看 App 开着没", "seq": request_seq}
            if APP_ONLY_ASK:
                result = self._bridge_polish_call("send", text, "", deliver_as=deliver_as)
                if result is not None:
                    merge_polish_result(payload, result)
                else:
                    payload["error"] = "知意那边没回话，再点一次试试"
                if self._closed or request_seq != self._request_seq:
                    return
                try:
                    self.polish_ready.emit(payload)
                except RuntimeError:
                    pass
                return
            try:
                data = api_post("/polish/send", {"text": text}, timeout=25)
                payload.update(data or {})
            except urllib.error.HTTPError as e:
                try:
                    body = json.loads(e.read().decode("utf-8", "replace"))
                    payload["error"] = body.get("error") or f"发送失败了 ({e.code})"
                except Exception:
                    payload["error"] = f"发送失败了 ({e.code})"
            except Exception as ex:
                payload["error"] = f"连不上解语花（{ex}），看看传音樱还开着没"
            if self._closed or request_seq != self._request_seq:
                return
            try:
                self.send_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-polish-send").start()

    def _apply_send_result(self, payload):
        if self._closed or (payload.get("seq") is not None and payload.get("seq") != self._request_seq):
            return
        self._sending = False
        self._set_busy(False, sending=True)
        if payload.get("ok"):
            self._flash(payload.get("message") or "已发送 ✨")
            QTimer.singleShot(450, self._close_and_clear)
        else:
            self._set_status(payload.get("error") or "发送失败，再试一次", ok=False)

    def _close_and_clear(self):
        # 发送成功：收起弹窗，下次打开是干净的输入框
        self.input.clear()
        self._level = self.LEVEL
        self.close()

    # ── 状态/忙碌 ──
    def _set_status(self, text, ok=True):
        self.lbl_status.setText(text)
        self.lbl_status.setStyleSheet("" if ok else "color:#e07090;")
        self.lbl_status.show()

    def _clear_status(self):
        self.lbl_status.hide()
        self.lbl_status.setText("")

    def _set_busy(self, busy, polishing=False, sending=False):
        if polishing or sending:
            # 请求期间锁住输入框，避免回包覆盖用户刚改的新内容
            self.input.setReadOnly(busy)
            # 补充要求那一行同理：捋的时候改它不会影响已经发出去的请求，
            # 但留在那里会让人以为能随时改。
            require_input = getattr(self, "require_input", None)
            if require_input is not None:
                require_input.setReadOnly(busy)
        if polishing:
            self.btn_polish.setEnabled(not busy)
        if sending:
            self.btn_send.setEnabled(not busy)
            self.btn_queue.setEnabled(not busy)
        if polishing and busy:
            self.btn_send.setEnabled(False)
            self.btn_queue.setEnabled(False)
        if sending and busy:
            self.btn_polish.setEnabled(False)
        if not busy:
            self.btn_polish.setEnabled(True)
            self.btn_send.setEnabled(True)
            self.btn_queue.setEnabled(True)

    def _flash(self, text):
        self._set_status(text, ok=True)

    # ── 展示/定位 ──
    def open_near_ball(self):
        """从主面板工具卡点开：主面板已让位，弹窗直接贴在球旁边（跟朗读同款）。"""
        self._closed = False
        self._user_dragged = False
        self.input.setReadOnly(False)
        self.apply_theme()
        self._update_target()
        self._sync_size()
        self.input.setFocus()
        self._move_to_ball()
        self.show()
        self.raise_()
        self.activateWindow()
        self._sync_target_state()

    def _move_to_ball(self):
        """按花朵重新锚定（展开/收起目标选择器后也用它校正位置）。"""
        ball = self.ball
        screen = ball.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        x, y, side = position_popup_left_first(
            (ball.x(), ball.y(), ball.width(), ball.height()),
            (self.width(), self.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            gap=8,
            anchor_ratio=PANEL_ANCHOR_RATIO,
        )
        if side != self.side:
            self.side = side
            if getattr(ball, "state", None) is not None:
                ball.state["panel_side"] = side
                save_state(ball.state)
        self.move(x, y)

    def _sync_size(self):
        if self.layout() is not None:
            self.layout().activate()
        self.adjustSize()

    def _reanchor(self):
        self.adjustSize()
        if self._user_dragged:
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry()
            x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
            y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
            self.move(x, y)

    # ── 双窗拖动（与朗读/问问小花同一套：弹窗与花朵一组移动） ──
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_press = e.globalPosition().toPoint()
            self._drag_panel_start = self.pos()
            self._drag_ball_start = self.ball.pos()
            self._drag_moved = False
            reset_motion = getattr(self.ball, "_reset_drag_motion", None)
            if callable(reset_motion):
                reset_motion()
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._drag_press is not None and (e.buttons() & Qt.MouseButton.LeftButton):
            cur = e.globalPosition().toPoint()
            delta = cur - self._drag_press
            if not self._drag_moved:
                if delta.manhattanLength() < QApplication.startDragDistance():
                    return
                self._drag_moved = True
                self._user_dragged = True
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry()
            dx = max(geo.left() - self._drag_panel_start.x(), min(delta.x(), geo.right() - self.width() + 1 - self._drag_panel_start.x()))
            dy = max(geo.top() - self._drag_panel_start.y(), min(delta.y(), geo.bottom() - self.height() + 1 - self._drag_panel_start.y()))
            self.move(self._drag_panel_start + QPoint(dx, dy))
            self.ball.move(self._drag_ball_start + QPoint(dx, dy))
            record_motion = getattr(self.ball, "_record_drag_motion", None)
            if callable(record_motion):
                record_motion()
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            if self._drag_moved:
                release_motion = getattr(self.ball, "_release_drag_motion", None)
                if callable(release_motion):
                    release_motion()
                try:
                    self.ball._save_pos()
                except Exception:
                    pass
            self._drag_press = None
            self._drag_panel_start = None
            self._drag_ball_start = None
        super().mouseReleaseEvent(e)

    def enterEvent(self, event):
        super().enterEvent(event)
        self._on_fade_enter()

    def leaveEvent(self, event):
        super().leaveEvent(event)
        self._on_fade_leave()

    def _fade_allowed(self):
        # 正在润色/发送或输入框（含补充要求那一行）有焦点时不淡出
        if self._polishing or self._sending:
            return False
        for box in (getattr(self, "input", None), getattr(self, "require_input", None)):
            if box is not None and box.hasFocus():
                return False
        return True

    def showEvent(self, event):
        super().showEvent(event)
        self._reset_fade_on_show()
        self.input.setFocus()

    def hideEvent(self, event):
        super().hideEvent(event)
        self._cancel_fade()
        try:
            self.ball._set_fusion_panel_state("none")
        except Exception:
            pass
        # 弹窗都收起来之后，让主面板按实际情况决定还听不听推荐快照。
        menu = getattr(self.ball, "menu", None)
        sync = getattr(menu, "_sync_recommend_polling", None)
        if callable(sync):
            sync()

    def closeEvent(self, event):
        self._closed = True
        self._request_seq += 1
        self._target_seq += 1
        # 在途的候选方向请求也要作废：关窗后回包不该再弹标签
        self._suggest_seq += 1
        self._polishing = False
        self._sending = False
        self.input.setReadOnly(False)
        self.btn_polish.setEnabled(True)
        self.btn_send.setEnabled(True)
        self.btn_queue.setEnabled(True)
        super().closeEvent(event)

    def _on_input_focus_in(self, event):
        self._fade_out_timer.stop()
        self._fade_to(1.0, FADE_IN_DURATION_MS)
        orig = getattr(self.input, "_polish_orig_focus_in", None)
        if orig is not None:
            orig(event)

    def _on_input_focus_out(self, event):
        if self._fade_allowed() and not self._cursor_inside():
            self._fade_out_timer.start(FADE_OUT_DELAY_MS)
        orig = getattr(self.input, "_polish_orig_focus_out", None)
        if orig is not None:
            orig(event)

    def paintEvent(self, event):
        super().paintEvent(event)
        c = THEME_COLORS[self.ball.theme_mode]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        shadow = QColor(c["shadow"])
        shadow.setAlpha(28 if self.ball.theme_mode == "light" else 52)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(shadow)
        painter.drawRoundedRect(self.rect().adjusted(7, 8, -5, -3), 20, 20)

        painter.setPen(QColor(c["border"]))
        painter.setBrush(QColor(c["panel"]))
        painter.drawRoundedRect(self.rect().adjusted(4, 3, -4, -6), 20, 20)
        painter.end()

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #polishPanel {{
                background: transparent; border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#polishHead {{ color: {c['accent_deep']}; font-size: 15px; font-weight: 700; }}
            QLabel#polishDesc {{ color: {c['sub']}; font-size: 10px; padding-bottom: 1px; }}
            QLabel#polishTargetLabel {{ color: {c['sub_deep']}; font-size: 11px; }}
            QLabel#polishTargetInfo {{ color: {c['sub']}; font-size: 10px; padding-left: 2px; }}
            QPushButton#polishTargetBtn {{
                min-height: 26px; padding: 0 10px;
                color: {c['accent_deep']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 11px; font-weight: 600;
            }}
            QPushButton#polishTargetBtn:hover {{
                background: {c['surface']}; border-color: {c['accent']};
            }}
            QPushButton#polishCloseBtn {{
                color: {c['sub']}; background: transparent; border: none; border-radius: 12px;
                font-size: 13px;
            }}
            QPushButton#polishCloseBtn:hover {{ background: {c['surface_alt']}; color: {c['ink']}; }}
            QPlainTextEdit#polishInput {{
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px;
                padding: 8px 10px; font-size: 12px;
            }}
            QPlainTextEdit#polishInput:focus {{ border-color: {c['accent']}; }}
            QPushButton#polishBtn, QPushButton#polishSendBtn, QPushButton#polishQueueBtn {{
                min-height: 32px; border-radius: 10px; font-size: 12px; font-weight: 600;
                padding: 0 8px;
            }}
            QPushButton#polishBtn {{
                color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']};
            }}
            QPushButton#polishBtn:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#polishSendBtn {{
                color: {c['accent_deep']}; background: {c['surface']};
                border: 1px solid {c['accent']};
            }}
            QPushButton#polishSendBtn:hover {{ background: {c['surface_alt']}; }}
            /* 排队发送：更轻一档，等于“先放一放”，不跟主操作抢眼 */
            QPushButton#polishQueueBtn {{
                color: {c['sub_deep']}; background: {c['surface']};
                border: 1px solid {c['border']};
            }}
            QPushButton#polishQueueBtn:hover {{ border-color: {c['accent']}; color: {c['accent_deep']}; }}
            QPushButton#polishBtn:disabled, QPushButton#polishSendBtn:disabled, QPushButton#polishQueueBtn:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
            QLabel#polishStatus {{ color: {c['pink']}; font-size: 11px; font-weight: 600; }}
            /* 补充要求：一行，不写就不占眼，写了就提示这是可选的 */
            QLineEdit#polishRequire {{
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px;
                padding: 5px 10px; font-size: 11px; min-height: 16px;
            }}
            QLineEdit#polishRequire:focus {{ border-color: {c['accent']}; }}
            /* 候选方向：比档位胶囊再轻一档，不让它抢“理顺”的戏 */
            QLabel#polishSuggestTitle {{ color: {c['sub']}; font-size: 10px; padding-left: 2px; }}
            QPushButton#polishSuggestBtn {{
                color: {c['accent_deep']}; background: {c['surface_alt']};
                border: 1px solid {c['border']}; border-radius: 11px;
                min-height: 22px; padding: 0 9px; font-size: 11px;
            }}
            QPushButton#polishSuggestBtn:hover {{
                border-color: {c['accent']}; background: {c['surface']};
            }}
        """)


# ─────────────────────────────
#  我的另一枝 · 分支列表（面板内嵌）
# ─────────────────────────────
class QueueInsertPanel(FadeOnLeaveMixin, QFrame):
    """排队发送：写一句（或一串话），等 ta 这一轮说完就送进去。

    形是旧版「写一句」弹窗：标题、发送到、输入框、取消 / 就这么发。
    多了两样：输入框能写多行（一行一句，写几句就一轮一句往下推），
    以及「每句排 N 轮」（同一句连着排 N 轮）。
    排进去之后由 App 那边记账：ta 每说完一轮，就送下一句。
    """

    queue_ready = pyqtSignal(object)     # /queue 回包
    target_ready = pyqtSignal(object)    # /target 回包

    WIDTH = 320

    def __init__(self, ball):
        super().__init__(None)
        self.ball = ball
        self.side = str((getattr(self.ball, "state", None) or {}).get("panel_side") or "left")
        self._drag_press = None
        self._drag_panel_start = None
        self._drag_ball_start = None
        self._drag_moved = False
        self._user_dragged = False
        self._closed = False
        self._sending = False
        self._stopping = False
        self._request_seq = 0
        self._target_seq = 0
        self._rounds = 1
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
            | Qt.WindowType.NoDropShadowWindowHint
        )
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("queueInsertPanel")
        self.setFixedWidth(self.WIDTH)
        self.queue_ready.connect(self._apply_queue_result)
        self.target_ready.connect(self._apply_target_state)
        self._build_ui()
        self.apply_theme()
        self.setup_fade_on_leave()

    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 14, 16, 13)
        root.setSpacing(7)

        head = QHBoxLayout()
        head.setSpacing(6)
        self.lbl_head = QLabel("💬 排队发送")
        self.lbl_head.setObjectName("qpHead")
        head.addWidget(self.lbl_head)
        head.addStretch(1)
        self.btn_close = QPushButton("✕")
        self.btn_close.setObjectName("qpCloseBtn")
        self.btn_close.setFixedSize(22, 22)
        self.btn_close.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_close.setToolTip("收起这个窗口（写好的话还在，重开接着写）")
        self.btn_close.clicked.connect(self.close)
        head.addWidget(self.btn_close)
        root.addLayout(head)

        self.lbl_desc = QLabel("写一句或几句，ta 说完就送进去。")
        self.lbl_desc.setObjectName("qpDesc")
        self.lbl_desc.setWordWrap(True)
        root.addWidget(self.lbl_desc)

        target_row = QHBoxLayout()
        target_row.setSpacing(6)
        self.lbl_target_label = QLabel("发送到")
        self.lbl_target_label.setObjectName("qpTargetLabel")
        target_row.addWidget(self.lbl_target_label)
        self.btn_target = QPushButton("跟随最近 ▾")
        self.btn_target.setObjectName("qpTargetBtn")
        self.btn_target.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_target.setToolTip("排进哪段对话：默认跟随最近活跃，也可以自己固定一段")
        self.btn_target.clicked.connect(self._open_target_menu)
        target_row.addWidget(self.btn_target)
        target_row.addStretch(1)
        root.addLayout(target_row)

        self.lbl_target_info = QLabel("")
        self.lbl_target_info.setObjectName("qpTargetInfo")
        self.lbl_target_info.setWordWrap(True)
        root.addWidget(self.lbl_target_info)

        self.target_menu = TargetMenu(self)
        self.target_menu.hide()
        root.addWidget(self.target_menu)

        # 输入框：可以写一句，也可以写几句（一行一句）。
        self.input = QPlainTextEdit()
        self.input.setObjectName("qpInput")
        self.input.setPlaceholderText("一句一行，ta 说完就发。")
        self.input.setFixedHeight(92)
        self.input._qp_orig_focus_in = self.input.focusInEvent
        self.input._qp_orig_focus_out = self.input.focusOutEvent
        self.input.focusInEvent = self._on_input_focus_in
        self.input.focusOutEvent = self._on_input_focus_out
        root.addWidget(self.input)

        # 每句排几轮：1 = 说完一次；调大就是同一句连着排 N 轮。
        rounds_row = QHBoxLayout()
        rounds_row.setSpacing(6)
        self.lbl_rounds_title = QLabel("每句排")
        self.lbl_rounds_title.setObjectName("qpRoundsLabel")
        rounds_row.addWidget(self.lbl_rounds_title)
        self.btn_round_minus = QPushButton("−")
        self.btn_round_minus.setObjectName("qpRoundStep")
        self.btn_round_minus.setFixedWidth(26)
        self.btn_round_minus.setAutoRepeat(True)
        self.btn_round_minus.setAutoRepeatDelay(500)
        self.btn_round_minus.setAutoRepeatInterval(90)
        self.btn_round_minus.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_round_minus.setToolTip("少排一轮（按住可以连续减）")
        self.btn_round_minus.clicked.connect(lambda: self._step_rounds(-1))
        rounds_row.addWidget(self.btn_round_minus)
        self.lbl_rounds = QLabel("1")
        self.lbl_rounds.setObjectName("qpRoundValue")
        self.lbl_rounds.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_rounds.setFixedWidth(42)
        rounds_row.addWidget(self.lbl_rounds)
        self.lbl_round_unit = QLabel("轮")
        self.lbl_round_unit.setObjectName("qpRoundUnit")
        rounds_row.addWidget(self.lbl_round_unit)
        self.btn_round_plus = QPushButton("+")
        self.btn_round_plus.setObjectName("qpRoundStep")
        self.btn_round_plus.setFixedWidth(26)
        self.btn_round_plus.setAutoRepeat(True)
        self.btn_round_plus.setAutoRepeatDelay(500)
        self.btn_round_plus.setAutoRepeatInterval(90)
        self.btn_round_plus.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_round_plus.setToolTip("多排一轮（按住可以连续加）")
        self.btn_round_plus.clicked.connect(lambda: self._step_rounds(1))
        rounds_row.addWidget(self.btn_round_plus)
        rounds_row.addStretch(1)
        root.addLayout(rounds_row)

        self.lbl_hint = QLabel("你开口就停，最多 50 轮。")
        self.lbl_hint.setObjectName("qpHint")
        self.lbl_hint.setWordWrap(True)
        root.addWidget(self.lbl_hint)

        status_row = QHBoxLayout()
        status_row.setSpacing(6)
        self.lbl_status = QLabel("")
        self.lbl_status.setObjectName("qpStatus")
        self.lbl_status.setWordWrap(True)
        self.lbl_status.hide()
        status_row.addWidget(self.lbl_status, 1)
        self.btn_stop = QPushButton("停")
        self.btn_stop.setObjectName("qpStopBtn")
        self.btn_stop.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_stop.setToolTip("不再往下送；已经送出去的那一句照常")
        self.btn_stop.clicked.connect(self._stop)
        self.btn_stop.hide()
        status_row.addWidget(self.btn_stop)
        root.addLayout(status_row)

        btns = QHBoxLayout()
        btns.setSpacing(6)
        self.btn_cancel = QPushButton("取消")
        self.btn_cancel.setObjectName("qpCancel")
        self.btn_cancel.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_cancel.clicked.connect(self.close)
        btns.addWidget(self.btn_cancel, 1)
        self.btn_send = QPushButton("就这么发")
        self.btn_send.setObjectName("qpSend")
        self.btn_send.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_send.setToolTip("排进当前对话，ta 说完就发")
        self.btn_send.clicked.connect(self._send)
        btns.addWidget(self.btn_send, 1)
        root.addLayout(btns)

    # ── 目标行（与朗读窗/理顺窗同一套）──
    def _update_target(self):
        arrow = "▴" if self.target_menu is not None and self.target_menu.isVisible() else "▾"
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            label = f"固定 · {title[:8]}" if title else "固定"
        else:
            label = "跟随最近"
        self.btn_target.setText(f"{label} {arrow}")
        self._update_target_info()

    def _update_target_info(self):
        name = (self.ball.target_name or "").strip()
        if self.ball.target_mode == "pinned" and self.ball.pinned_target:
            title = (self.ball.target_title or self.ball.pinned_target.get("title") or "").strip()
            prefix = "固定"
        else:
            title = (self.ball.target_title or "").strip()
            prefix = "跟随最近"
        if title:
            text = " · ".join([prefix, name, title]) if name else " · ".join([prefix, title])
        elif name:
            text = " · ".join([prefix, name]) + "（无标题）"
        else:
            text = "跟随最近 · 正在定位对话…"
        self.lbl_target_info.setText(text)

    def _open_target_menu(self):
        show = not self.target_menu.isVisible()
        self._set_target_selector_visible(show)
        if show:
            self.target_menu.view_mode = "pinned" if self.ball.target_mode == "pinned" else "auto"
            if APP_ONLY_ASK:
                self.target_menu.render_from_cache()
            else:
                self.target_menu.refresh_sessions_async()

    def _set_target_selector_visible(self, visible):
        self.target_menu.setVisible(bool(visible))
        self._update_target()
        self._resize_after_target_change()

    def invalidate_target_sync(self):
        self._target_seq += 1

    def _sync_target_state(self):
        if APP_ONLY_ASK:
            self._update_target()
            return
        self._target_seq += 1
        target_seq = self._target_seq
        target_revision = getattr(self.ball, "target_revision", 0)

        def worker():
            payload = None
            try:
                data = api_get("/target", timeout=4)
                if data.get("ok"):
                    payload = {**data, "seq": target_seq, "target_revision": target_revision}
            except Exception:
                pass
            if payload is not None and not self._closed:
                try:
                    self.target_ready.emit(payload)
                except RuntimeError:
                    pass

        threading.Thread(target=worker, daemon=True, name="zhujian-queue-target").start()

    def _apply_target_state(self, data):
        if data.get("seq") != self._target_seq:
            return
        if data.get("target_revision", getattr(self.ball, "target_revision", 0)) != getattr(self.ball, "target_revision", 0):
            return
        t = data.get("target") or {}
        self.ball.target_name = t.get("name") or t.get("agentId") or ""
        self.ball.target_title = t.get("title") or ""
        self.ball.target_mode = "pinned" if data.get("mode") == "pinned" else "auto"
        self.ball.pinned_target = data.get("pinned")
        self._update_target()

    def _resize_after_target_change(self):
        def settle():
            self._sync_size()
            if self.isVisible():
                if self._user_dragged:
                    self._reanchor()
                else:
                    self._move_to_ball()
        QTimer.singleShot(0, lambda: QTimer.singleShot(0, settle))

    # ── 状态 ──
    def _set_status(self, text, ok=True):
        self.lbl_status.setText(text)
        self.lbl_status.setStyleSheet("" if ok else "color:#e07090;")
        self.lbl_status.show()

    def _flash(self, text):
        self._set_status(text, ok=True)

    def _step_rounds(self, delta):
        self._rounds = max(1, min(50, int(self._rounds) + int(delta)))
        self.lbl_rounds.setText(str(self._rounds))
        self.btn_round_minus.setEnabled(self._rounds > 1)
        self.btn_round_plus.setEnabled(self._rounds < 50)

    # ── 排进去 ──
    def _send(self):
        if self._sending:
            return
        text = self.input.toPlainText().strip()
        if not text:
            self._set_status("先写一句再排", ok=False)
            return
        if len(text) > 2000:
            self._set_status("太长了，精简一点再排", ok=False)
            return
        self._sending = True
        self.btn_send.setEnabled(False)
        self.btn_send.setText("排进去了…")
        self._set_status("正在排…", ok=True)
        session_id = getattr(self.ball, "target_session_id", "") or ""
        rounds = max(1, min(50, int(self._rounds)))
        self._request_seq += 1
        request_seq = self._request_seq

        def worker():
            result = bridge_queue_call(
                "queue", text, rounds, session_id, timeout_s=25,
                cancelled=lambda: self._closed,
            )
            payload = {"ok": False, "error": "知意那边没回话，再点一次试试", "seq": request_seq}
            if isinstance(result, dict):
                payload.update({k: v for k, v in result.items() if k != "seq"})
            if self._closed or request_seq != self._request_seq:
                return
            try:
                self.queue_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="zhujian-queue-send").start()

    def _apply_queue_result(self, payload):
        if self._closed or (payload.get("seq") is not None and payload.get("seq") != self._request_seq):
            return
        self._sending = False
        self.btn_send.setEnabled(True)
        self.btn_send.setText("就这么发")
        # 回包没带 ok 时别急着当失败：App 推来的状态只要有文字，就说明它已经收下这一发了。
        # 早先 App 那边的状态里没带 ok 字段，球这边就一直当成「没排上」——
        # 明明排上了，弹窗里也报一句「知意那边没回话」。
        ok = payload.get("ok")
        if ok is None and (payload.get("message") or payload.get("text")):
            ok = True
        if ok:
            self._set_status(payload.get("message") or "已排进队列，等 ta 说完就发", ok=True)
            # 多轮时不自动关窗：留着能随时看到排到第几轮，也能随手停。
            if int(payload.get("total") or 1) > 1:
                self.btn_stop.setVisible(True)
            else:
                QTimer.singleShot(600, self._close_and_clear)
        else:
            self._set_status(payload.get("error") or "没排上，再试一次", ok=False)

    def _stop(self):
        if self._stopping:
            return
        self._stopping = True
        self.btn_stop.setEnabled(False)
        session_id = getattr(self.ball, "target_session_id", "") or ""

        def worker():
            bridge_queue_call("queue-cancel", "", 1, session_id, timeout_s=15,
                              cancelled=lambda: self._closed)
            if not self._closed:
                try:
                    self.queue_ready.emit({"ok": True, "message": "停了，不再往下送", "seq": self._request_seq})
                except RuntimeError:
                    pass

        threading.Thread(target=worker, daemon=True, name="zhujian-queue-stop").start()

    def apply_queue_state(self, state):
        """App 推来的话单状态：弹窗里显示排到第几轮，也能随手停。"""
        if not isinstance(state, dict):
            return
        message = str(state.get("message") or "")
        error = str(state.get("error") or "")
        text = str(state.get("text") or "")
        if error:
            self._set_status(error, ok=False)
        elif text:
            self._set_status(text, ok=True)
        elif message:
            self._set_status(message, ok=True)
        if state.get("active"):
            self.btn_stop.setVisible(True)

    def _close_and_clear(self):
        if self._closed:
            return
        self.input.clear()
        self.close()

    # ── 展示/定位 ──
    def open_near_ball(self):
        self._closed = False
        self._user_dragged = False
        self._sending = False
        self._stopping = False
        self._rounds = 1
        self.lbl_rounds.setText("1")
        self.btn_round_minus.setEnabled(False)
        self.btn_round_plus.setEnabled(True)
        self.btn_stop.hide()
        self.btn_stop.setEnabled(True)
        self.btn_send.setEnabled(True)
        self.btn_send.setText("就这么发")
        self.apply_theme()
        self._update_target()
        self._sync_size()
        self.input.setFocus()
        self._move_to_ball()
        self.show()
        self.raise_()
        self.activateWindow()
        self._sync_target_state()

    def _move_to_ball(self):
        ball = self.ball
        screen = ball.screen() or QApplication.primaryScreen()
        geo = screen.availableGeometry()
        x, y, side = position_popup_left_first(
            (ball.x(), ball.y(), ball.width(), ball.height()),
            (self.width(), self.height()),
            (geo.left(), geo.top(), geo.right() + 1, geo.bottom() + 1),
            gap=8,
            anchor_ratio=PANEL_ANCHOR_RATIO,
        )
        if side != self.side:
            self.side = side
            if getattr(ball, "state", None) is not None:
                ball.state["panel_side"] = side
                save_state(ball.state)
        self.move(x, y)

    def _sync_size(self):
        if self.layout() is not None:
            self.layout().activate()
        self.adjustSize()

    def _reanchor(self):
        self.adjustSize()
        if self._user_dragged:
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry()
            x = max(geo.left(), min(self.x(), geo.right() - self.width() + 1))
            y = max(geo.top(), min(self.y(), geo.bottom() - self.height() + 1))
            self.move(x, y)

    # ── 双窗拖动（与朗读/理顺同一套：弹窗与花朵一组移动） ──
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag_press = e.globalPosition().toPoint()
            self._drag_panel_start = self.pos()
            self._drag_ball_start = self.ball.pos()
            self._drag_moved = False
            reset_motion = getattr(self.ball, "_reset_drag_motion", None)
            if callable(reset_motion):
                reset_motion()
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        if self._drag_press is not None and (e.buttons() & Qt.MouseButton.LeftButton):
            cur = e.globalPosition().toPoint()
            delta = cur - self._drag_press
            if not self._drag_moved:
                if delta.manhattanLength() < QApplication.startDragDistance():
                    return
                self._drag_moved = True
                self._user_dragged = True
            screen = self.ball.screen() or QApplication.primaryScreen()
            geo = screen.availableGeometry()
            dx = max(geo.left() - self._drag_panel_start.x(), min(delta.x(), geo.right() - self.width() + 1 - self._drag_panel_start.x()))
            dy = max(geo.top() - self._drag_panel_start.y(), min(delta.y(), geo.bottom() - self.height() + 1 - self._drag_panel_start.y()))
            self.move(self._drag_panel_start + QPoint(dx, dy))
            self.ball.move(self._drag_ball_start + QPoint(dx, dy))
            record_motion = getattr(self.ball, "_record_drag_motion", None)
            if callable(record_motion):
                record_motion()
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self._drag_moved:
            self._drag_press = None
            self._drag_panel_start = None
            self._drag_ball_start = None
            self._drag_moved = False
        super().mouseReleaseEvent(e)

    # ── 焦点/淡出 ──
    def _on_input_focus_in(self, event):
        self._fade_to(1.0, FADE_IN_DURATION_MS)
        orig = getattr(self.input, "_qp_orig_focus_in", None)
        if orig is not None:
            orig(event)

    def _on_input_focus_out(self, event):
        orig = getattr(self.input, "_qp_orig_focus_out", None)
        if orig is not None:
            orig(event)

    def _fade_allowed(self):
        # 进出完全看鼠标：不在面板上就淡出，移回来立刻恢复实体。
        # 别的弹窗在「输入框有焦点」时会保持实体（免得让人对着半透明的字改稿），
        # 这个窗按她要的来：鼠标在面板上才实体，输入框有没有焦点不作数。
        # 正在发送时也不淡出：那一刻她要盯着回执。
        return not self._sending

    # ── 鼠标进出：进来立刻恢复实体，离开一会儿才淡出（与理顺窗/朗读窗同款）──
    def enterEvent(self, event):
        super().enterEvent(event)
        self._on_fade_enter()

    def leaveEvent(self, event):
        super().leaveEvent(event)
        self._on_fade_leave()

    def showEvent(self, event):
        super().showEvent(event)
        self._reset_fade_on_show()
        self.input.setFocus()

    def hideEvent(self, event):
        super().hideEvent(event)
        self._cancel_fade()
        try:
            self.ball._set_fusion_panel_state("none")
        except Exception:
            pass

    def closeEvent(self, event):
        self._closed = True
        self._request_seq += 1
        self._sending = False
        self.btn_send.setEnabled(True)
        self.btn_send.setText("就这么发")
        super().closeEvent(event)

    def paintEvent(self, event):
        # 背景不靠样式表：窗口开了透明属性，样式表里的 background 画不实，
        # 整块窗会看着像半透明。这里跟理顺窗/压缩档案窗同款：阴影 + 实底自己画。
        super().paintEvent(event)
        c = THEME_COLORS[self.ball.theme_mode]
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)

        shadow = QColor(c["shadow"])
        shadow.setAlpha(28 if self.ball.theme_mode == "light" else 52)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(shadow)
        painter.drawRoundedRect(self.rect().adjusted(7, 8, -5, -3), 20, 20)

        painter.setPen(QColor(c["border"]))
        painter.setBrush(QColor(c["panel"]))
        painter.drawRoundedRect(self.rect().adjusted(4, 3, -4, -6), 20, 20)
        painter.end()

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #queueInsertPanel {{
                background: transparent; border: none;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            QLabel {{ background: transparent; }}
            QLabel#qpHead {{ color: {c['ink']}; font-size: 13px; font-weight: 700; }}
            QLabel#qpDesc {{ color: {c['sub']}; font-size: 11px; }}
            QPushButton#qpCloseBtn {{
                color: {c['sub']}; background: transparent; border: none;
                border-radius: 11px; font-size: 13px;
            }}
            QPushButton#qpCloseBtn:hover {{ color: {c['accent_deep']}; background: {c['surface_alt']}; }}
            QLabel#qpTargetLabel {{ color: {c['sub']}; font-size: 11px; }}
            QPushButton#qpTargetBtn {{
                color: {c['accent_deep']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 9px;
                font-size: 11px; font-weight: 600; padding: 3px 9px;
            }}
            QPushButton#qpTargetBtn:hover {{ border-color: {c['accent']}; }}
            QLabel#qpTargetInfo {{ color: {c['sub_deep']}; font-size: 10px; }}
            QPlainTextEdit#qpInput {{
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px;
                padding: 8px 10px; font-size: 12px;
            }}
            QPlainTextEdit#qpInput:focus {{ border-color: {c['accent']}; }}
            QLabel#qpStatus {{ color: {c['pink']}; font-size: 11px; font-weight: 600; }}
            QLabel#qpHint {{ color: {c['sub_deep']}; font-size: 10px; }}
            QLabel#qpRoundsLabel {{ color: {c['sub']}; font-size: 11px; }}
            QPushButton#qpRoundStep {{
                color: {c['accent_deep']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 8px;
                font-size: 12px; font-weight: 700; min-height: 22px;
            }}
            QPushButton#qpRoundStep:hover {{ border-color: {c['accent']}; }}
            QPushButton#qpRoundStep:disabled {{ color: {c['sub']}; border-color: {c['border']}; }}
            QLabel#qpRoundValue {{ color: {c['ink']}; font-size: 12px; font-weight: 600; }}
            QLabel#qpRoundUnit {{ color: {c['sub']}; font-size: 11px; }}
            QPushButton#qpStopBtn {{
                color: {c['pink']}; background: transparent;
                border: 1px solid {c['border']}; border-radius: 8px;
                font-size: 11px; font-weight: 600; padding: 2px 8px;
            }}
            QPushButton#qpStopBtn:hover {{ border-color: {c['pink']}; }}
            QPushButton#qpCancel {{
                min-height: 30px; color: {c['sub_deep']}; background: transparent;
                border: 1px solid {c['border']}; border-radius: 10px;
                font-size: 11px; font-weight: 600;
            }}
            QPushButton#qpCancel:hover {{ background: {c['surface']}; border-color: {c['accent']}; }}
            QPushButton#qpSend {{
                min-height: 30px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 10px;
                font-size: 11px; font-weight: 600;
            }}
            QPushButton#qpSend:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            QPushButton#qpSend:disabled {{
                color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']};
            }}
        """)


class BranchListMenu(QFrame):
    """已开分支列表：数据来自代理 /branch/list；点某项打开对应聊天窗口。"""

    branches_ready = pyqtSignal(object)

    def __init__(self, panel):
        super().__init__(panel)
        self.panel = panel
        self.ball = panel.ball
        self.branches = []
        self.loading = False
        self.branches_ready.connect(self._apply_branches)
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("branchListMenu")
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 11, 12, 11)
        root.setSpacing(6)
        title = QLabel("我的另一枝（点开继续聊）")
        title.setObjectName("menuTitle")
        root.addWidget(title)
        self.lbl_hint = QLabel("")
        self.lbl_hint.setObjectName("menuSub")
        self.lbl_hint.setWordWrap(True)
        root.addWidget(self.lbl_hint)
        self.list_host = QWidget(self)
        self.list_host.setObjectName("branchListHost")
        self.list_box = QVBoxLayout(self.list_host)
        self.list_box.setContentsMargins(0, 0, 0, 0)
        self.list_box.setSpacing(5)
        root.addWidget(self.list_host)
        self.apply_theme()

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #branchListMenu {{ background: transparent; border: none; font-family: "LXGW WenKai", "Microsoft YaHei UI"; }}
            QLabel {{ background: transparent; color: {c['ink']}; }}
            QLabel#menuTitle {{ font-size: 13px; font-weight: 700; color: {c['accent_deep']}; }}
            QLabel#menuSub {{ font-size: 10px; color: {c['sub']}; padding-bottom: 2px; }}
            QWidget#branchListHost {{ background: transparent; border: none; }}
            QPushButton#branchItem {{
                min-height: 30px; max-height: 30px; text-align: left; padding: 0 9px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 10px; font-size: 11px;
            }}
            QPushButton#branchItem:hover {{ background: {c['surface_alt']}; border-color: {c['accent']}; }}
        """)
        self._sync_ui()

    def refresh_async(self):
        if self.loading:
            return
        self.loading = True
        self.lbl_hint.setText("正在读取…")

        def worker():
            payload = {"ok": False, "branches": []}
            try:
                data = api_get("/branch/list", timeout=5)
                if data.get("ok"):
                    payload = data
            except Exception:
                pass
            try:
                self.branches_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="branch-list").start()

    def _apply_branches(self, payload):
        self.loading = False
        self.branches = payload.get("branches") or [] if payload.get("ok") else []
        self._sync_ui()

    def _sync_ui(self):
        self._clear_list()
        if not self.branches:
            self.lbl_hint.setText("还没开过另一枝，点上面的「另开一枝」试试")
            return
        self.lbl_hint.setText("")
        for b in self.branches:
            btn = QPushButton(self._item_label(b))
            btn.setObjectName("branchItem")
            btn.setCursor(Qt.CursorShape.PointingHandCursor)
            btn.setToolTip("打开这个分支的聊天窗口")
            btn.clicked.connect(lambda _=False, branch=b: self._open(branch))
            self.list_box.addWidget(btn)

    @staticmethod
    def _item_label(b):
        preview = str(b.get("preview") or "").strip()
        when = format_branch_time(int(b.get("lastTs") or b.get("createdAt") or 0))
        text = "另一枝 · " + when if when else "另一枝"
        if preview:
            text += "  " + preview
        return text

    def _open(self, branch):
        self.panel._toggle_branch_list_off()
        self.ball.open_branch_window(branch)

    def _clear_list(self):
        while self.list_box.count():
            item = self.list_box.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()


# ─────────────────────────────
#  另一枝 · 独立聊天窗口
# ─────────────────────────────
class BranchChatWindow(QFrame):
    """分支会话的独立聊天窗口：可随时关闭（对话保留在服务端），
    从面板「我的另一枝」列表可重新打开；多开互不干扰。"""

    history_ready = pyqtSignal(object)     # 加载 / 轮询历史回包
    chat_sent_ready = pyqtSignal(object)   # 发送回包

    WIDTH = 380
    HEIGHT = 520
    REPLY_POLL_MS = 1500
    REPLY_TIMEOUT_S = 120

    def __init__(self, ball, branch):
        super().__init__(None)
        self._closed = False
        self.ball = ball
        self.branch = branch
        self.branch_id = str(branch.get("id") or "")
        self.branch_title = str(branch.get("title") or "另一枝")
        self._rendered = 0          # 已渲染的消息条数（轮询增量追加）
        self._awaiting_reply = False
        self._sending = False
        self._poll_inflight = False
        self._poll_started = 0.0
        self._poll_timer = None
        self._status_row = None     # 「正在回复…」占位行
        self._title_bar = None
        self._drag_press = None
        self._drag_start = None

        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint
            | Qt.WindowType.WindowStaysOnTopHint
            | Qt.WindowType.Tool
        )
        self.setAttribute(Qt.WidgetAttribute.WA_StyledBackground, True)
        self.setObjectName("chatRoot")
        self.setFixedSize(self.WIDTH, self.HEIGHT)

        self.history_ready.connect(self._apply_history)
        self.chat_sent_ready.connect(self._apply_chat_sent)

        self._build_ui()
        self.apply_theme()
        self._load_history_async()

    # ── UI ──
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # 标题栏：拖拽移动 + 关闭
        bar = QFrame()
        bar.setObjectName("chatTitleBar")
        bar.setFixedHeight(38)
        bar.installEventFilter(self)
        self._title_bar = bar
        bar_layout = QHBoxLayout(bar)
        bar_layout.setContentsMargins(14, 0, 8, 0)
        bar_layout.setSpacing(8)
        self.lbl_title = QLabel(self.branch_title)
        self.lbl_title.setObjectName("chatTitle")
        bar_layout.addWidget(self.lbl_title)
        bar_layout.addStretch(1)
        self.btn_close = QPushButton("✕")
        self.btn_close.setObjectName("chatClose")
        self.btn_close.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_close.setFixedSize(22, 22)
        self.btn_close.setToolTip("关闭窗口（分支对话保留，可随时再打开）")
        self.btn_close.clicked.connect(self.close)
        bar_layout.addWidget(self.btn_close)
        root.addWidget(bar)

        # 消息滚动区
        self.scroll = QScrollArea()
        self.scroll.setObjectName("chatScroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.body = QFrame()
        self.body.setObjectName("chatBody")
        self.msg_box = QVBoxLayout(self.body)
        self.msg_box.setContentsMargins(14, 12, 14, 12)
        self.msg_box.setSpacing(8)
        self.msg_box.addStretch(1)
        self.scroll.setWidget(self.body)
        root.addWidget(self.scroll, 1)

        # 输入行
        input_bar = QFrame()
        input_bar.setObjectName("chatInputBar")
        input_bar.setFixedHeight(52)
        input_layout = QHBoxLayout(input_bar)
        input_layout.setContentsMargins(14, 8, 14, 8)
        input_layout.setSpacing(8)
        self.input = QLineEdit()
        self.input.setObjectName("chatInput")
        self.input.setMaxLength(500)
        self.input.setPlaceholderText("和分支里的小花聊两句…")
        self.input.returnPressed.connect(self._send_text)
        input_layout.addWidget(self.input, 1)
        self.btn_send = QPushButton("发送")
        self.btn_send.setObjectName("chatSend")
        self.btn_send.setCursor(Qt.CursorShape.PointingHandCursor)
        self.btn_send.setFixedWidth(64)
        self.btn_send.clicked.connect(self._send_text)
        input_layout.addWidget(self.btn_send)
        root.addWidget(input_bar)

    def apply_theme(self):
        c = THEME_COLORS[self.ball.theme_mode]
        self.setStyleSheet(f"""
            #chatRoot {{
                background: {c['panel']};
                border: 1px solid {c['border']};
                border-radius: 14px;
                font-family: "LXGW WenKai", "Microsoft YaHei UI";
            }}
            #chatTitleBar {{ background: {c['surface_alt']}; border-top-left-radius: 14px; border-top-right-radius: 14px; }}
            #chatTitle {{ color: {c['accent_deep']}; font-size: 13px; font-weight: 700; background: transparent; }}
            #chatClose {{
                color: {c['sub']}; background: transparent; border: none;
                border-radius: 11px; font-size: 12px; font-weight: 700;
            }}
            #chatClose:hover {{ color: {c['accent_text']}; background: {c['accent']}; }}
            QScrollArea#chatScroll {{ background: transparent; border: none; }}
            QWidget#chatBody {{ background: transparent; }}
            QLabel#bubbleUser {{
                background: {c['accent']}; color: {c['accent_text']};
                border-radius: 12px; padding: 8px 12px; font-size: 12px;
            }}
            QLabel#bubbleAssistant {{
                background: {c['surface']}; color: {c['ink']};
                border: 1px solid {c['border']}; border-radius: 12px;
                padding: 8px 12px; font-size: 12px;
            }}
            QLabel#bubbleStatus {{ color: {c['sub']}; font-size: 11px; background: transparent; }}
            #chatInputBar {{ background: {c['surface_alt']}; border-bottom-left-radius: 14px; border-bottom-right-radius: 14px; }}
            #chatInput {{
                min-height: 32px; padding: 0 12px;
                color: {c['ink']}; background: {c['surface']};
                border: 1px solid {c['border']}; border-radius: 12px; font-size: 12px;
            }}
            #chatInput:focus {{ border-color: {c['accent']}; }}
            #chatSend {{
                min-height: 32px; color: {c['accent_text']}; background: {c['accent']};
                border: 1px solid {c['accent']}; border-radius: 12px; font-size: 12px; font-weight: 600;
            }}
            #chatSend:hover {{ background: {c['accent_deep']}; border-color: {c['accent_deep']}; }}
            #chatSend:disabled {{ color: {c['sub']}; background: {c['surface_alt']}; border-color: {c['border']}; }}
        """)

    # ── 事件：标题栏拖拽 ──
    def eventFilter(self, obj, event):
        if obj is self._title_bar:
            etype = event.type()
            if etype == QEvent.Type.MouseButtonPress and event.button() == Qt.MouseButton.LeftButton:
                self._drag_press = event.globalPosition().toPoint()
                self._drag_start = self.pos()
                return True
            if etype == QEvent.Type.MouseMove and self._drag_press is not None:
                if event.buttons() & Qt.MouseButton.LeftButton:
                    delta = event.globalPosition().toPoint() - self._drag_press
                    self.move(self._drag_start + delta)
                    return True
            if etype == QEvent.Type.MouseButtonRelease:
                self._drag_press = None
        return super().eventFilter(obj, event)

    # ── 消息渲染 ──
    def _append_message(self, role, text):
        bubble = QLabel(text)
        bubble.setObjectName("bubbleUser" if role == "user" else "bubbleAssistant")
        bubble.setWordWrap(True)
        bubble.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        bubble.setMaximumWidth(int(self.WIDTH * 0.72))
        row = QHBoxLayout()
        row.setSpacing(0)
        if role == "user":
            row.addStretch(1)
            row.addWidget(bubble)
        else:
            row.addWidget(bubble)
            row.addStretch(1)
        self.msg_box.insertLayout(self.msg_box.count() - 1, row)
        self._scroll_bottom()

    def _append_status(self, text):
        self._clear_status()
        lbl = QLabel(text)
        lbl.setObjectName("bubbleStatus")
        row = QHBoxLayout()
        row.setSpacing(0)
        row.addWidget(lbl)
        row.addStretch(1)
        self._status_row = row
        self.msg_box.insertLayout(self.msg_box.count() - 1, row)
        self._scroll_bottom()

    def _clear_status(self):
        if self._status_row is not None:
            while self._status_row.count():
                item = self._status_row.takeAt(0)
                w = item.widget()
                if w:
                    w.deleteLater()
            self.msg_box.removeItem(self._status_row)
            self._status_row = None

    def _scroll_bottom(self):
        bar = self.scroll.verticalScrollBar()
        QTimer.singleShot(0, lambda: None if self._closed else bar.setValue(bar.maximum()))

    # ── 历史加载 ──
    def _load_history_async(self):
        branch_id = self.branch_id

        def worker():
            payload = {"ok": False, "messages": []}
            try:
                data = api_get("/branch/history?branchId=" + urllib.parse.quote(branch_id), timeout=6)
                if data.get("ok"):
                    payload = data
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.history_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="branch-history").start()

    # ── 发送 ──
    def _send_text(self):
        if self._sending:
            return
        text = self.input.text().strip()
        if not text:
            return
        self.input.clear()
        self._sending = True
        self.btn_send.setEnabled(False)
        self._append_message("user", text)
        self._append_status("正在回复…")
        self._poll_started = time.monotonic()
        branch_id = self.branch_id

        def worker():
            payload = {"ok": False, "error": "连不上解语花，看看插件开着没"}
            try:
                data = api_post("/branch/chat", {"branchId": branch_id, "text": text}, timeout=20)
                payload.update(data or {})
            except urllib.error.HTTPError as e:
                try:
                    payload.update(json.loads(e.read().decode("utf-8", "replace")) or {})
                except Exception:
                    pass
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.chat_sent_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="branch-chat-send").start()

    def _apply_chat_sent(self, payload):
        if not payload.get("ok"):
            self._clear_status()
            self._append_status(payload.get("error") or "发送失败，再试一次")
            self._sending = False
            self.btn_send.setEnabled(True)
            return
        # 发送成功：轮询分支会话，等助手新消息
        self._awaiting_reply = True
        self._poll_timer = QTimer(self)
        self._poll_timer.timeout.connect(self._poll_reply)
        self._poll_timer.start(self.REPLY_POLL_MS)
        self._poll_reply()

    def _poll_reply(self):
        if self._closed or self._poll_inflight or not self._awaiting_reply:
            return
        self._poll_inflight = True
        branch_id = self.branch_id

        def worker():
            payload = {"ok": False, "messages": []}
            try:
                data = api_get("/branch/history?branchId=" + urllib.parse.quote(branch_id), timeout=5)
                if data.get("ok"):
                    payload = data
            except Exception:
                pass
            if self._closed:
                return
            try:
                self.history_ready.emit(payload)
            except RuntimeError:
                pass

        threading.Thread(target=worker, daemon=True, name="branch-poll").start()

    def _apply_history(self, payload):
        if self._closed:
            return
        self._poll_inflight = False
        if not payload.get("ok"):
            if self._awaiting_reply:
                self._finish_reply(payload.get("error") or "回复获取失败，再试一次")
            else:
                self._append_status(payload.get("error") or "分支历史加载失败")
            return
        messages = payload.get("messages") or []
        if self._awaiting_reply:
            # 轮询模式：增量追加；出现新的助手消息即完成
            if len(messages) > self._rendered:
                for m in messages[self._rendered:]:
                    self._append_message(m.get("role"), m.get("content") or "")
                self._rendered = len(messages)
            last = messages[-1] if messages else {}
            if last.get("role") == "assistant":
                self._finish_reply("")
                return
            if time.monotonic() - self._poll_started > self.REPLY_TIMEOUT_S:
                self._finish_reply("小花好像还没回，看看 Hana 那边是不是卡了")
            return
        # 初次加载：全量渲染
        if not messages:
            self._append_status("从这里开始聊吧")
            return
        for m in messages:
            self._append_message(m.get("role"), m.get("content") or "")
        self._rendered = len(messages)

    def closeEvent(self, event):
        self._closed = True
        self._awaiting_reply = False
        self._sending = False
        self._poll_inflight = False
        if self._poll_timer is not None:
            self._poll_timer.stop()
            self._poll_timer = None
        super().closeEvent(event)

    def _finish_reply(self, error_msg):
        if self._closed:
            return
        self._awaiting_reply = False
        self._sending = False
        self.btn_send.setEnabled(True)
        self._clear_status()
        if self._poll_timer is not None:
            self._poll_timer.stop()
            self._poll_timer = None
        if error_msg:
            self._append_status(error_msg)


def main():
    global API_BASE, API_TOKEN
    control_stdout = sys.stdout
    control_stdin = sys.stdin
    sys.stdout = sys.stderr  # 控制握手独占 stdout，其余诊断不污染协议
    os.makedirs(APP_DATA_DIR, exist_ok=True)
    _install_crash_log()
    QApplication.setHighDpiScaleFactorRoundingPolicy(
        Qt.HighDpiScaleFactorRoundingPolicy.PassThrough
    )
    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(True)
    bridge = AppBallBridge()
    bridge_info = bridge.start()
    API_BASE = bridge_info["baseUrl"]
    API_TOKEN = bridge_info["token"]

    def close_bridge():
        shutdown_after_parent_ack(control_stdout, control_stdin, bridge)

    app.aboutToQuit.connect(close_bridge)
    ball = ZhujianBall()
    ball.start_speak_polling()
    if ball.menu is not None:
        ball.menu.start_sleep_polling()
    print(json.dumps({
        "type": "zhiyi-ball-ready",
        "baseUrl": API_BASE,
        "token": API_TOKEN,
    }), file=control_stdout, flush=True)
    ball.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
