"""Safe path authorization tests for local voice playback (never starts a listener)."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from app_bridge import AppBallBridge


class VoicePlaybackRestrictionTests(unittest.TestCase):
    def test_voice_play_rejects_files_outside_own_clip_directory(self):
        with tempfile.TemporaryDirectory() as data_dir, tempfile.TemporaryDirectory() as outside:
            valid = Path(data_dir, "voice-clips", "welcome.mp3")
            valid.parent.mkdir(parents=True)
            valid.write_bytes(b"ID3")
            foreign = Path(outside, "foreign.mp3")
            foreign.write_bytes(b"ID3")
            with patch.dict(os.environ, {"ZHIYI_APP_DATA_DIR": data_dir}):
                bridge = AppBallBridge()
                try:
                    status, _ = bridge._post("/voice/play", {"path": str(foreign), "format": "mp3"})
                    self.assertEqual(status, 400)
                    status, _ = bridge._post("/voice/play", {"path": str(valid), "format": "mp3"})
                    self.assertEqual(status, 200)
                    status, _ = bridge._post("/voice/play", {"path": str(valid.parent / "missing.mp3")})
                    self.assertEqual(status, 400)
                finally:
                    bridge.close()

    def test_unsupported_extension_is_rejected(self):
        with tempfile.TemporaryDirectory() as data_dir:
            directory = Path(data_dir, "voice-clips")
            directory.mkdir()
            other = directory / "config.ini"
            other.write_text("hello", encoding="utf-8")
            with patch.dict(os.environ, {"ZHIYI_APP_DATA_DIR": data_dir}):
                bridge = AppBallBridge()
                try:
                    status, _ = bridge._post("/voice/play", {"path": str(other)})
                    self.assertEqual(status, 400)
                finally:
                    bridge.close()


if __name__ == "__main__":
    unittest.main()
