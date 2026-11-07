# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.3.3（2026-11-07），内容见 `CHANGELOG.md`。

## 待发

## 记着但不在待发里的

- 输入框图片放大只下了 UI：`index.js` 的 `/input-zoom` 三条路由、`lib/input-zoom.js`、`assets/install-input-zoom.ps1`、`assets/input-zoom-script.js` 都还在包里，但已无调用方。安装那条会以 `-ExecutionPolicy Bypass` 起 `powershell.exe` 往 Hana 的 renderer 目录写脚本，属没有用处的特权写入路径，下一版该删净。
- 发布包从 0.3.3 起按 `package.trackedOnly` 只带真实 import 的 5 个 sdk 文件。以后宿主升级 SDK，要手工同步这 5 个，否则会悄悄落后于宿主版本。
- README 里的 8 张 `attachments/*.png` 与 `TESTING.md`、`PUBLISHING.md`、`旧版功能迁移清单.md` 链接指向的文件不在包内，装好后从包内读 README 会看到死链（0.3.2 起就这样）。
- `python/test_*.py` 6 个仍在包内（0.1.46 起遗留）。想剥掉得先让发布小工坊的测试支架认识 `python/` 目录：现在副本测试只补 `tests/`、`scripts/`、`node_modules/`、`package*.json`，一排除 `python/` 下的测试，副本里就没有 python 用例，pytest 以「NO TESTS RAN」exit 5，整条 release-tests 断掉。
- 降级链只用单元测试模拟过额度、限流、服务商不可用三类错误；真实限额下的端到端降级没跑过。
- 宿主 `cancel()` 是 reject 还是安静结束取决于 Hana 实现，已证明两种情况都不会再发 `_a2`，但真机行为没观察过。
- 速览卡上那行斜体小字（`> _这条是「X」拟的_`）在真机引用块里的观感没逐屏确认。
- 脚注残留边界：`> _斜体_` 若紧贴最后一条要点的下一行，仍会被当脚注吃掉。要彻底消掉可让 `SUMMARY_NOTE_RE` 只认我们自己的固定前缀（`这条是「`）。
- `tests/app-tool.test.js:249` 那条 vm 测试在带 `--experimental-vm-modules` 时会失败（`ui/assets/panel.js` 引了 `model-groups.js`，测试的 link 白名单没加）。`6cbfee4` 就存在，平时被 `skip` 跳过，正是「2 跳过」的来源，该单独修一次。
- `WORKFLOW.md:75` 写「python/ 目录本身不进包」，但 `lib/ball.js` 要 spawn `python/zhujian_app.py`，这句与运行需求矛盾，属平台文档口径问题。
- 输入栏按钮显隐：没点过按钮的新 Code 页窗口，没有历史会话号可补，那颗按钮暂时藏不住；宿主目前没有「切换会话时通知 App」的通道。
- 真实 Windows 关机与撤销、App 重载后的恢复分支、宿主对 `sessionPermission: { readOnly: false }` 的处理、Hana 宿主是否接受主题接口的 `Authorization` 头，都要在真机上跑一次才算数。
