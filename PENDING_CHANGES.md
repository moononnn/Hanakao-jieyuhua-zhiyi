# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.1.41（2026-10-26），内容见 `CHANGELOG.md`。

## 待发

- 子代理钩子回归测试（2026-10-26）：`tests/app-tool.test.js` 新增三条，锁住 `agent/before-start` / `messages/post-assistant` / Ask 工具三条口子在子代理会话里一步不走（含用户窗口对照组）。只加测试，`index.js` 逻辑未改。详见 `TESTING.md`。
