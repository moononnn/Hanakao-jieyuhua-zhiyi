# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.3.0（2026-11-04），内容见 `CHANGELOG.md`。

## 待发 0.3.1

- 审包六条落地：速览卡脚注、标题结果行标注实际模型、`cancelFastModel` 取消真正发出去的 `_aN` 号、链内 `budgetMs`（速览 10s / 标题 25s）、自定义 HTTP 档入链。
- 审包后补修四处：`index.js` 两处重命名路由补 `degraded`/`model` 透传、`python/zhujian_app.py` 复制这两个字段、`run()` 开头检查 `cancelledBases`（同模型重试也不放行）、`SUMMARY_NOTE_RE` 只认紧跟要点的脚注行。
- 测试新增 5 项（取消号后缀、放弃后不重发、预算认输、自定义档入链、脚注边界），全量 777 项 775 通过 / 0 失败 / 2 跳过；python 126 项 125 通过 / 1 跳过。

## 记着但不在待发里的

- `python/test_*.py` 6 个仍在包内（0.1.46 起遗留）。想剥掉得先让发布小工坊的测试支架认识 `python/` 目录，否则 release-tests 会因「NO TESTS RAN」exit 5 卡死。
- 降级链只用单元测试模拟过额度、限流、服务商不可用三类错误，真实限额没跑过。
- 速览卡上那行斜体小字（`> _这条是「X」拟的_`）在真机引用块里的观感没看过。
- `WORKFLOW.md:75` 写「python/ 目录本身不进包」，但 `lib/ball.js` 要 spawn `python/zhujian_app.py`，这句与运行需求矛盾，属于平台文档口径问题。
