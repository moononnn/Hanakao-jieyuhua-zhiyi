# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.3.0（2026-11-04），内容见 `CHANGELOG.md`。

## 待发

（暂无）

## 0.3.0 审包留下的待办（非阻断，下一版处理）

审包伙伴对 0.3.0 最终包判 pass、无阻断，同时提了这些；逐条记着，别让它们只留在聊天里。

- **降级换模型只在库层留了标记，界面层没落地。** `lib/fast-model.js` 会返回 `degraded` / `modelRole` / `modelName`，但 `index.js` 的速览只解构 `lines/elapsedMs/effort/attempts/reasoningTokens`，`lib/session-title.js` 只取 `value.text`。结果：库层说「不静默换」，用户看到的速览卡和标题其实还是静默换。要么在速览卡上加一行「这条是内容模型拟的」，要么把 CHANGELOG 的措辞收回库层。
- **取消落空，被放弃的链会在后台跑完。** `lib/fast-model.js` 把宿主 `requestId` 写成 `${requestId}_a${attempts}`，而 `length-summary.js` / `session-title.js` 超时分支用无后缀基号调 `sdk.models.cancel`。单条上限 60 秒，多出来的额度消耗是真金白银。修法二选一：取消时也带后缀，或让链接受一个 `shouldAbort()` 在每次尝试前检查。
- **速览 12 秒预算与链叠加。** 单条最多 3 次调用、链最多 3 条，理论上 9 次往返都要挤进 12 秒；慢模型下备用模型很可能轮不到就被外层超时掐掉。要实测一轮再决定是放宽预算还是链内共用 deadline。
- **纯自定义 HTTP 模型进不了快速档链。** `resolveFastModel` 要求 catalog 里存在完全相等的 provider/model，自定义档只在 `resolveTaskModel` 里存在。纯自定义档用户会直接看到「快速档没有可用模型」。需要给链加一条「自定义档」来源。
- **包内仍带 `python/test_*.py` 六个**（`test_app_bridge`、`test_ask_dialog`、`test_queue_bridge`、`test_queue_panel`、`test_queue_receipt`、`test_resume_dialog`），0.1.46 起就存在，与「测试不进包」的表述不符。下次打包前在 `发布小工坊/projects/jiegehua-zhiyi.json` 的 `excludeGlobs` 加 `python/test_*.py`，并顺手修 WORKFLOW 里「python/ 目录本身不进包」那句（与 `lib/ball.js` 要 spawn `python/zhujian_app.py` 矛盾）。
- **主会话的审计正则只覆盖 `^tests/`**，所以 python 测试只落在 `pyTests` 字段、`forbidden.hits` 为空，报告层面容易被读成「包内无测试」。下次把 `python/test_*.py` 并进 `forbidden` 或明确标注。
