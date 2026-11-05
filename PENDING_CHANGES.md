# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.3.2（2026-11-04），内容见 `CHANGELOG.md`。

## 待发

- 关机判定收紧到「看不清就不关」：会话扫描不完整、事件层不可读、后台任务读不到都算忙；5 秒采样加单飞锁和 90 秒超时；连续看不清十分钟发一条通知说明原因，状态接口与面板也能看到具体是哪一层。
- 关机命令改成可确认的状态机（preparing / sending / issued），发送前复核当前状态，退出码非零才算失败、超时算结果不明；撤销只在原始 30 秒窗口内执行 `shutdown /a`，失败标 `abort-failed` 不谎报；重载对 issued / unknown / abort-failed 走恢复分支。
- 新增 `clear` 动作、`/sleep-guard/clear` 路由与面板「已核实，解除警告」，给 `abort-failed` / `shutdown-unknown` 一个人工出口，避免永久挂不上关机。
- 下线 `probe-shutdown`、`test-shutdown` 两个会真跑 `shutdown.exe` 的探针；测试里那条真调 `/a` 的用例改成注入假执行器。
- 融合服务快照不再外发球桥的 baseUrl 与令牌，`start` / `stop` / `place` 保留。
- 未验收：真实 Windows 关机与撤销、App 重载后的恢复分支、宿主对 `sessionPermission: { readOnly: false }` 的处理，都要在真机上跑一次才算数。

## 记着但不在待发里的

- `python/test_*.py` 6 个仍在包内（0.1.46 起遗留）。想剥掉得先让发布小工坊的测试支架认识 `python/` 目录：现在副本测试只补 `tests/`、`scripts/`、`node_modules/`、`package*.json`，一排除 `python/` 下的测试，副本里就没有 python 用例，pytest 以「NO TESTS RAN」exit 5，整条 release-tests 断掉。
- 降级链只用单元测试模拟过额度、限流、服务商不可用三类错误；真实限额下的端到端降级没跑过。
- 宿主 `cancel()` 是 reject 还是安静结束取决于 Hana 实现，已证明两种情况都不会再发 `_a2`，但真机行为没观察过。
- 速览卡上那行斜体小字（`> _这条是「X」拟的_`）在真机引用块里的观感没逐屏确认。
- 脚注残留边界：`> _斜体_` 若紧贴最后一条要点的下一行，仍会被当脚注吃掉。要彻底消掉可让 `SUMMARY_NOTE_RE` 只认我们自己的固定前缀（`这条是「`）。
- `tests/app-tool.test.js:249` 那条 vm 测试在带 `--experimental-vm-modules` 时会失败（`ui/assets/panel.js` 引了 `model-groups.js`，测试的 link 白名单没加）。`6cbfee4` 就存在，平时被 `skip` 跳过，正是「2 跳过」的来源，该单独修一次。
- `WORKFLOW.md:75` 写「python/ 目录本身不进包」，但 `lib/ball.js` 要 spawn `python/zhujian_app.py`，这句与运行需求矛盾，属平台文档口径问题。
- 输入栏按钮显隐：没点过按钮的新 Code 页窗口，没有历史会话号可补，那颗按钮暂时藏不住；宿主目前没有「切换会话时通知 App」的通道。
- 发布小工坊的本地 pack 路线不写 `bundle.sourceCommit`（只有 `import` 写），`evidence -RunIds` 要先手工补 state.json 才能登记 CI。本版照旧按「先核树哈希、再补 sourceCommit」做，属工具缺口。
