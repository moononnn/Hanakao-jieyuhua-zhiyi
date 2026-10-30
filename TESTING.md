# 测试

## 2026-10-30 发布 0.1.48（Ask 三级回退与原生回包修复）

- 全量：`node --test` 550 项 548 通过 / 0 失败 / 2 跳过（跳过项为原有）；`node tests/python-tests.mjs` 126 项 125 通过 / 0 失败 / 1 跳过（跳过项为原有）。发布小工坊 verify 与最终副本测试均以同一组命令复跑通过（副本 548 项）。
- 本轮新增一条发布链路回归：`.gitattributes` 声明 `assets/install-input-zoom.ps1 -text`。发布副本默认会把 `.ps1` 规范成 LF，而该脚本要求 BOM+CRLF+纯 ASCII，否则 Windows PowerShell 5.1 按 ANSI 代码页解码时吞掉换行；副本测试先红（`tests/input-zoom-install.test.js:49` 报 46 !== 13），修复后包内副本与工作树逐字节相同（6445 字节、166 CRLF、带 BOM）。
- 独立审包（只读、带执行权限）实际解包 411 条目并复核：ZIP 与 entry 双指纹一致；403 个文件逐字节相同、8 个仅行尾规范化、0 个内容差异；两个配方文件与仓库源码 SHA-256 相同；隐私扫描无真名、无本机路径、无未授权邮箱（作者公开的反馈邮箱 4 处逐行对上公开授权，`sdk/components.css` 里与私名词表形近的 base64 片段为已知假阳性）。
- 发布证据：CI run 40981798907 在 `3f1c1f8` 上 completed/success；回下载 Release 附件实测 SHA-256 与本地包一致（`5af1595e…bd634b2`）；市场 PR #142 当前 head `173ce1d` 的 validate-pr success。
- 未做：安装/升级实机验证、多屏与全屏切换、原生询问十分钟超时取消、旧卡迟到提交、同一宿主内多道原生询问并发的边界。

## 2026-10-30 原生 Ask 工具回包与失败恢复（0.1.47-dev.2）

- 定向命令：`node --experimental-vm-modules --test tests/app-tool.test.js tests/card-handoff.test.js`，**91 通过 / 0 失败 / 0 跳过**。`node --check index.js`、`node --check lib/card-handoff.js` 均通过；未运行全量测试。
- 新回归在 App 装配前包装原生 ask 模拟宿主 inflight；旧实现于工具返回时 inflight 为 1，新实现回包时为 0、下一轮 timer 才开始等待真实答复。测试同时保留显式 drain 检查，不能只测 execute 自身的 Promise 是否结束。
- 失败覆盖：模糊发送超时不重试且保留原题作答；明确拒绝保留 failed 回执；错误 askId/跨会话不可读；重载后 sending 归未确认并恢复提示；内存保底与存储/清理不可用；已确认送达但副本清理失败不报未送达、不阻塞新题；prepared/ready 文案区分。原有同题接管、旧卡迟到拒绝、单多选与长说明回传均仍通过。
- dev.2 实机追加（2026-10-30，作者重载后）：① 缺失测试模板造成明确 show_failed，同题原生回退工具正常返回；随后计时 **35.1 秒**未作答，之后“展示正常回传验收”成功回到原会话。② 正常模板发卡并绑定，故意暂不写解锁数据；作者截图确认仍在等待绑定且不可作答后，先写 `{askId,ready:false,fallback:true}`，用原题及原卡编号执行 user_reported_unusable 接管，工具正常返回；原生提交“接管正常回传成功”，结果回到原会话。故障是验收注入，不算配方自发失效；业务配方未改。
- 证据边界：旧卡宿主停用数据写入成功；接管后的 DOM frame 未就绪、保存自检仍是 awaiting_binding，不能以此认定卡片渲染失败，也不能宣称已实测视觉转交提示或旧卡迟到提交。迟到拒绝、失败恢复仍以现有单元测试为证；多屏/全屏、十分钟取消/过期等未完整实测。
- 已知宿主边界：timer0 规避本次新询问拖住自身回包；另一道原生问答未结束时，同一 App 宿主的全局 drain 仍可能阻塞其他工具。此项不能以当前测试通过宣称解决，需要平台侧 detached/回包策略支持。配方源码和已安装配方均未改。

## 2026-10-26 子代理会话不许知意插手：补钩子级回归（未升版本）

- 需求：0.1.42 里两条钩子已经在开头认出子代理会话并直接退出，但只有 `resume-watch.test.js` 覆盖了那个识别函数本身，没有任何用例锁住「钩子真的提前返回」这个行为。重构 before-start 或者挪动那两行判断，删了也没人喊。
- 改法：`tests/app-tool.test.js` 在「子代理会话报错不进账本」之后新增三条，复用现成的 `createContext` harness。① `agent/before-start`：子代理路径返回 `undefined` 且 `modelCalls` 为 0（Ask 预检一次都不花）；同一段带决策线索的 prompt 落到用户窗口仍注入基础引导并跑一次预检，证明跳过是按会话认的。② `messages/post-assistant`：子代理路径不贴卡、不叫速览模型；同一段 720 字正文在用户窗口会跑一次（对照组）。③ 子代理会话里调 `jiegehua_zhiyi_ask`，回 `subagent_session`、`created: false`、不弹球不发问。
- 途中踩到的坑：速览那条一开始红了，不是闸门的事。`resolveFastModel` 要求先有一条配置好的模型，没有就抛 `MODEL_NOT_FOUND`，两条路径都跑不到模型，对照组变成空的。测试里必须 seed `fastTaskModel`，否则钉不住东西。这也顺带说明实机上没配快速档时速览本来就不工作。
- 命令与结果：`node --experimental-vm-modules --test --test-name-pattern="子代理" tests/app-tool.test.js` **4 通过 / 0 失败**（含原有的报错不进账本那条）；`node --experimental-vm-modules --test tests/app-tool.test.js` **69 通过 / 0 失败**（原 66 + 新 3）；全量 `node --experimental-vm-modules --test` **491 通过 / 0 失败 / 0 跳过**。
- 反向验证：临时把 `index.js` 两处 `isSubagentHook(invocation)` 判断改成 `false && isSubagentHook(invocation)`，两条新用例立刻变红（2 通过 / 2 失败）；恢复后复跑全绿。确认这不是写给自己看的瞎子测试。
- 未覆盖：本轮只加测试，`index.js` 逻辑一行没改，不需要重载 App。子代理实机没重新复验（0.1.42 那轮已经看过会话文件里不再出现速览卡）。`provider/before-request` 没加子代理判断是有意的：它只清洗历史里的旧速览卡格式，不追加任何内容。

## 2026-10-26 断点续接：额度用完、欠费、鉴权失效时不再自动续发（0.1.41）

- 需求：用户 2026-10-25 实测反馈，模型撞到限额或欠费时，知意把它当普通断联一并自动续发，反复往同一个窗口里灌「继续哈」，既花钱又推不动。
- 改法：`lib/resume-watch.js` 新增 `classifyResumeBlocker(signal)` 与会话 `blocked` 账；`onAbnormal` 撞上三类时不排队、不等待、不续发，`resolve`、`stuckCandidates`（90 秒卡住兜底）、`progressItems` 全部跳过它；解锁只认 `markRecovered`（真的回上一轮）或 `forget`（用户自己开口）。`index.js` 两条事件入口接上：回合失败信号走 `onAbnormal`，provider 的 `error` 事件只登记封锁（重试期间反复来，不当异常调度）。设置页「断了以后怎么办」补文案。
- 命令与结果：`node --test` **474 项，472 通过 / 0 失败 / 2 跳过**（跳过项为原有；`tests/resume-watch.test.js` 新增 4 条：分类、不排队不续发、撞上欠费不再等、用户开口后解锁）；`cd python && python -B -m unittest discover -p "test_*.py"` **122 通过 / 1 跳过（离屏 Qt）**。发布包核验：`validate-app.mjs --archive` 0 错误（1 条动态依赖静态不可证的通用警告）；暂存目录与解包树逐文件哈希对账 409/409 一致；`--smoke` 未跑（需要 Node 26+，本机 24）。
- 已知边界：① 宿主不生产额度/欠费错误码（查过 1.2.1-beta 的 server bundle），只能认 provider 原文，供应商若只回一句通用文案（如 "Connection error."）仍会按普通断联续一次；判据宁可漏判也不误判。② 「连着接几轮」（`continue-loop`）没动，仍会在失败轮继续推下一句。③ 实机只由用户在本地目录版上验过续接行为，未在空环境从 Release 重装复核。
- 顺手修掉的隐私问题：0.1.40 的公开包里，关机自检探针把本机用户名与计算机名写成了环境变量兜底值，已换成 `process.env.*` 链式兜底；发布前扫描本机用户名与本机路径无命中。
- 补提交：`ui/nav.html` 在 0.1.40 的市场包里，但当时漏了 `git add`，仓库里缺这个文件，本版补上。

## 2026-10-22 排队发送（话单）

- 需求：把旧版「写一句」弹窗借形加回来（用户：旧版解语花有这个功能，新版没加入），再加「一串话逐条发」——群里要的是「预先备一串话，每轮自动发一条，防 ta 自己收工」。
- 改法：新增 `lib/queue-plan.js`（话单状态机，纯逻辑）；`index.js` 接入钩子（`agent/before-start` 判插话即停、`messages/post-assistant` 轮末送下一句）与新桥通道（`/queue/request`·`/queue/state`·`/queue/push`）；`python/app_bridge.py` 加 `_queue` 段与三个端点（`/resume/state` 里顺带带一份 queue 快照，球已经每隔一会儿读它了）；`python/zhujian_app.py` 新增 `QueueInsertPanel`（借旧版 `QueueInsertDialog` 的形，多行输入 + 「每句排 N 轮」）、主面板「排队发送」工具行与状态行、模块级 `bridge_queue_call`。
- 关键判定（三条，都是踩过的坑）：
  ① **第一发不能一律用 `followUp`**。排队语义挂在空闲会话上会等一个永远不会来的轮次结束，表现是「点了没反应」（`index.js` 早有这条注释）。所以第一发按 `session:context` 判 ta 在不在回话：在回话 → `followUp` 排队；说完 → `steer` 直接发。之后每一轮在轮末一律 `steer`。
  ② **多轮不能把 N 句一起排进宿主**：会挤成同一轮里的一串 user 消息。轮数由 App 自己记，轮末才送下一句。
  ③ **轮末有两条信号**（`messages/post-assistant` 钩子 + `turn_end` 事件），相隔毫秒级，必须去重，复用 `shouldJudgeLoop` 那条 3 秒窗口；钩子撞上宿主的 App RPC 并发限制会漏判，所以 `turn_end` 那条兜底不能省。
- 命令与结果：`node --test tests/queue-plan.test.js` **13 通过 / 0 失败**（新增 13 条：轮数归一、写一句、写几句按行拆、同一句 N 轮、空内容与超长拒绝、总轮数超限拒绝、话单按序推进、插话即停、自己发的那句不算插话、pending 期间不送下一句、状态条文案、无会话编号不给建单、总轮数求和）；`node --test tests/continue-loop.test.js tests/send.test.js` **26 通过 / 0 失败**；`node --experimental-vm-modules --test tests/app-tool.test.js` **64 通过 / 0 失败**；`cd python && python -m unittest test_ask_dialog test_resume_dialog test_app_bridge test_queue_bridge` **102 通过 / 0 失败（1 跳过）**（新增 `python/test_queue_bridge.py` 8 条：请求带正文与轮数、类型非法拒收、无正文拒收、取消不需要正文、轮数夹到 1~50、状态推送球上读得到、`/resume/state` 带着 queue 快照、序号递增）；`node --check index.js lib/queue-plan.js tests/queue-plan.test.js` 通过，两个 `.py` 的 AST 通过，未留 `.pyc`。
- 途中踩到并修掉的一个坑：主面板里直接读 `self.ball.queue_panel`，而测试里的 `FakeBall` 没有这个属性 → PyQt6 把未捕获异常变成 `abort()`，整个 python 测试进程直接崩（退出码 0xC0000409，还不带 traceback，看起来像"随机崩溃"）。改法：面板侧一律 `getattr(self.ball, "queue_panel", None)`，同时给 `FakeBall` 补上这个属性。**教训：给球加新面板属性时，测试里的假球要同步补，否则整轮测试会以 native 崩掉的方式收场，看不出是谁的问题。**
- 未覆盖：**实机完全没验**——传音樱的排队弹窗没打开过、话单没真的排过一次、轮末推进、插话即停、关对话后的回执、App 重载后的话单丢失行为都还没跑。传音樱进程在这次重载前正好被关掉了（宿主日志：`传音樱用户关闭（0）`），要手动再开一次才能试。未跑全应用回归，未调付费模型。

## 2026-10-22 输入框面板改成「推荐回复 / 小工具 / 帮我理顺」

- 需求：把朗读页做成常用小功能汇总页，页面重命名放进去；理顺页改名「帮我理顺」；小工具页放理顺页右边；编辑常用仍属推荐回复页（她明确纠正了我把它划进「小功能」的错误）。
- 改法：`ui/suggest-panel.html` 页签换成 `推荐回复 / 小工具 / 帮我理顺`，新增 `tools-page`（`tools-grid` 两列入口格 + `rename-slug` 那一格 + `slug-note` 结果行），朗读的 `voice-list-view` / `voice-reader-view` 整体收进小工具页并加「← 小工具」；头部只剩「编辑常用」「收起」；`ui/assets/suggest-panel.js` 的 `PANEL_PAGES` 改成 `recommend / tools / polish`，新增 `showToolsView(sub)` 管两层与三档高度，`setRenameState()` 改格子上的小字；`ui/assets/suggest-panel.css` 新增格子样式。
- 关键判定：起名那格是复合结构（图标 + 标题 + 说明），改字只能改说明行 `rename-hint`；沿用 `textContent = '起名中…'` 会把整格内容抹平（图标和标题一起没）。`/suggest-panel/rename` 与「还原」链路没动，起名仍然只改面板所在那段对话。
- 命令与结果：`node --experimental-vm-modules --test tests/app-tool.test.js tests/suggest-panel.test.js tests/suggest-panel-ui.test.js tests/polish-panel.test.js tests/polish.test.js tests/session-title.test.js tests/voice-routes.test.js tests/voice-reader.test.js tests/voice.test.js tests/ball-bridge.test.js` **202 通过 / 0 失败**（`suggest-panel-ui` 与 `polish-panel` 各重写/新增用例：头部不再有起名、起名在小工具页里、朗读不再是一级页签且退路留全、页签顺序是 推荐回复 → 小工具 → 帮我理顺）；单跑 `suggest-panel-ui + polish-panel` **14 通过 / 0 失败**；`node --check ui/assets/suggest-panel.js` 通过；本轮改动的临时预览文件用完即删（`ui/__preview-*.html` 已删）。
- 视觉核对：用 Edge 无头把面板 HTML 离屏渲染成 PNG（本机工作台里的 `知意小工具页预览.png`、`知意朗读子页预览.png`），确认三页签排布、入口格两列、图标与说明不挤、「返回小工具」自己占一行。渲染用的是去掉脚本的静态副本，只看排版，不当作实机行为证据。
- 未覆盖：**实机没验**——真面板里的手感（小工具页高度 240 是否合适、朗读子页进出是否顺、起名结果行出现后面板会不会多出滚动条）、宿主重载后 iframe 是否拿到新 HTML、真实模型起的名字是否可用。未跑全应用回归，未调付费模型。

## 2026-10-22 面板头部加「起名」

- 需求：把「重新给这个对话框命名」从传音樱搬到输入框上方的知意面板（用户问放哪儿，给了两个方案，她选了头部小字那版）。
- 改法：`ui/suggest-panel.html` 头部那排加 `rename-slug`（排在「编辑常用」前、「收起」后），头下面加一行 `slug-note` 结果行；`ui/assets/suggest-panel.js` 新增 `renameCurrentSession()` / `undoTypedTitle()`；`index.js` 新增 `POST /suggest-panel/rename`；`lib/suggest-panel.js` 的 `estimatePanelHeight` 基数 90 → 110（多出的是结果行那一行的高度）。
- 关键判定：起名只改面板所在那段对话，用 `panelSessionId()` 报上去的编号，**不走** `pickMostActiveSession` 的「最近活跃那段」。测试里故意把另一段设成 `modified` 更新，钉住这条。
- 顺手修的真 bug：`applySessionTitle` 里记账那段条件写反了（`previousTitle === undefined` 才记，而两个真入口都会传旧标题），导致 `titleUndo` 一条也写不进去，两个入口的「还原」永远报「这段对话没有改过标题」。改成无条件记账，旧标题没读到就记 null。
- 命令与结果：`node --experimental-vm-modules --test tests/app-tool.test.js` **64 通过 / 0 失败**（新增 1 条「面板起名只改面板所在那段对话」）；`node --test tests/session-title.test.js` **12 通过 / 0 失败**（新增 1 条「写入标题要把旧值记下来」）；`tests/suggest-panel-ui.test.js` **6 通过**（新增 1 条头部按钮与结果行）；合跑 `app-tool + suggest-panel-ui + suggest-panel + polish-panel + session-title + ball-bridge + voice-routes` 共 **151 通过 / 0 失败**。`node --check index.js ui/assets/suggest-panel.js lib/suggest-panel.js lib/session-title.js` 通过，本轮改动文件无行尾空白。
- 未覆盖：**面板上实际观感没实机看过**——头部三个小字按钮跟「解语花·知意」在窄面板下挤不挤（已给品牌名加 `min-width:0` + 省略号兜底，但真实宽度没量）、结果行出现时面板会不会多出滚动条、真实模型起出来的名字是否可用。未跑全应用回归，未调付费模型。

## 2026-10-22 输入框面板加第三个页签「理顺」

- 需求：把传音樱的「把话理顺」搬进聊天输入框上方的知意面板（推荐回复、朗读之后第三个页签）。
- 改法：`ui/suggest-panel.html` 加 `tab-polish` / `polish-page`（多行输入框、补充要求、候选方向区、理顺/排队发给 ta/现在就发）；`ui/assets/suggest-panel.js` 的页签切换改成 `PANEL_PAGES` 列表驱动，理顺页走 `POST /polish`、`POST /polish/suggest`、`POST /send`；新模块 `ui/assets/polish-draft.js` 放纯逻辑（请求拼接、锚点判定、回包话术、候选方向过滤）。
- 关键判定：框里还是上一版结果 → 算迭代（带 `previous` + 最初原话 `source`）；用户改过输入框 → 算新原话（两个锚点都不传），后端的安全兜底才拦得住「越捋越不像本人」。
- 命令与结果：`node --test tests/polish-panel.test.js tests/suggest-panel.test.js tests/suggest-panel-ui.test.js` **22 通过 / 0 失败**（新增文件；含一条反向断言「输入栏只能有一个知意按钮、不得再出现 zhiyi_polish 与 startPage」）；`node --test tests/polish.test.js` 7/7；`node --experimental-vm-modules --test tests/app-tool.test.js` **63 通过 / 0 失败**；`node --check index.js ui/assets/suggest-panel.js ui/assets/polish-draft.js` 与 manifest JSON 解析通过。
- 撤回：当天实机否掉输入栏那个 🪄 独立按钮，已撤干净（manifest 第二条 inputStatus、工具 `jiegehua.zhiyi_polish`、`startPage` 那套全删），测试随之改成反向断言。
- 未覆盖：实机观感（面板第三页排版、输入栏是不是回到两个图标）、真实模型出的理顺结果、两个发送按钮是否真的落进当前对话（`/send` 走的是现有链路，本轮没实机点过）。未跑全应用回归，未调付费模型。

## 2026-10-22 输入栏 🌸 按钮做成开关

- 需求：跟表情包那个 🪄 一样，按一下开、再按一下收。
- 改法：`index.js` 模块级 `openSuggestPanels`（sessionId → 打开记录）；工具 `jiegehua.zhiyi_suggest` 里同一会话已有记录时先 `userInteraction.dismiss` 再清记录，否则照旧 show 并记一笔；新增 `POST /suggest-panel/hidden`（只清标记，不关面板），`/suggest-panel/dismiss` 与面板自己的收起按钮同步清；`ui/assets/suggest-panel.js` 在 `visibilitychange(hidden)` 与 `pagehide` 时用 `keepalive` 请求报一声，没 sessionId 就不报。
- 命令与结果：`node --test tests/app-tool.test.js` **45 通过 / 2 跳过 / 0 失败**；新增 1 条「输入栏 🌸 按钮是开关」（第一下 show、第二下 dismiss 且不重复 show、第三下再 show；先报 hidden 再点，应该是打开而不是收起）。测试 harness 的 `userInteraction` 补了 show/dismiss 记录。`node --check index.js` 与 `node --check ui/assets/suggest-panel.js` 通过。
- 未覆盖：实机上收起/重开的手感与草稿保留未验（需本人重载后点两下）；`openSuggestPanels` 是进程内 Map，App 重载会清，跨重载不保留——这是有意的（重载后面板本来就不在了）。

## 2026-10-22 朗读列表在长对话里拿不到最新回复

- 现象（实机截图）：朗读窗列出的是三轮前的三条（549/800/457 字），最上面标「最新」的那条其实很早，最新几轮完全不在列表里。
- 取证：日志 `朗读列表统计` 显示这段会话（600+ 条消息）两次都只 `读到 200 条消息 / 轮次 5 / 列出 4 轮`，`朗读列表末条：透明不是没设样式…`（三轮前）。200 条里只划出 5 轮，正好对应对话开头几轮；`REPLY_HISTORY_LIMIT` 传的 400 被封到 200。结论：`session:history` 给的是开头 200 条，不是最近的。
- 诊断：临时加了 `session:entries` 探测，实测返回 `形状=object 数量=643`，末三条带 `role` 与 timestamp 且落在最近一轮结束时间，说明它给的是全量条目。
- 改法：`lib/voice-replies.js` 新增 `readTimeline()`——优先 `session:entries`，按 `timestamp` 找最新一条，再沿 `parentId` 回溯成当前分支，只保留 user/assistant 两种 role；列表与合成（`resolveSpeakTarget`）都用它，entries 不可用时回落 `sessions.history`。
- 命令与结果：`node --test tests/voice-replies-entries.test.js tests/voice-reader.test.js tests/voice.test.js tests/voice-routes.test.js tests/app-tool.test.js` **101 通过 / 2 跳过 / 0 失败**；新增 `tests/voice-replies-entries.test.js` 2 条（①有 entries 时不走 history、沿 parentId 取到最新一轮、旧分支不进列表；②entries 抛错时回落 history 且列表不空）。`node --check lib/voice-replies.js` 通过。
- 未覆盖：真机上重载后列表是否立刻变新（需本人验收）；entries 在超长会话（上万条）下的耗时未测，当前 lambda 15s 超时，超时会自动回落旧方式。

## 2026-10-22 朗读页收藏按钮

- 范围：`ui/suggest-panel.html`（`#voice-favorite`，默认 hidden）、`ui/assets/suggest-panel.js`（`currentReadClip`、收藏事件、按钮显隐与文案）、`ui/assets/suggest-panel.css`（`.reader-status-actions`）、`tests/suggest-panel-ui.test.js`（新增 1 条）。
- 命令与结果：`node --experimental-vm-modules --test tests/suggest-panel-ui.test.js tests/voice-routes.test.js tests/app-tool.test.js` 94 通过 / 0 失败；`node --check ui/assets/suggest-panel.js` 与本轮 `git diff --check` 通过。
- 覆盖：按钮存在且默认隐藏、点开走 `POST /voice/favorites` 并带上当前 clipId、合成成功前不显示按钮。
- 验证边界：静态用例 + 本地 mock，未调用真实 TTS。收藏的实机行为需在面板里合成一段后点一次，看设置页「语音收藏」是否多出一条。manifest 版本、简介、README 未动。

## 2026-10-22 音色试听按钮

- 范围：`index.js`（新增 `POST /voice/preview`）、`ui/panel.html`（`#voice-tone-preview`）、`ui/assets/panel.js`（`previewVoiceTone()`、按钮状态同步、伙伴行试听按钮）、`ui/assets/panel.css`（`.partner-voice-preview`）、`tests/voice-routes.test.js`（新增 1 条）。
- 命令与结果：`node --experimental-vm-modules --test tests/app-tool.test.js tests/voice-routes.test.js tests/voice.test.js tests/voice-reader.test.js tests/suggest-panel-ui.test.js` 114 通过 / 0 失败；`node --check index.js`、`node --check ui/assets/panel.js`、`node --check tests/voice-routes.test.js` 与本轮 `git diff --check` 通过。
- 覆盖：指定音色确实进了请求（`voice_setting.voice_id`）、同一音色二次点不再出网且 clipId 相同、换音色重新合成、缓存里的音频仍能按 `GET /voice/clip/:clipId` 取回。
- 验证边界：全为本地 mock，未调用真实 TTS。试听功能本身要走真实语音服务，需在设置页实地点一次。manifest 版本、简介、README 未动。

## 2026-10-22 撤掉聊天区右键朗读与「就绪」状态位

- 范围：`manifest.json`（删 `contributes.ui.contextMenus` 与 `inputStatus` 里的 `read-aloud-status`）、`index.js`（删 `jiegehua.read_aloud` 工具与阶段状态写入整段）、`tests/app-tool.test.js`（删 5 条旧用例，换成 1 条反向断言）。
- 命令与结果：`node --experimental-vm-modules --test tests/app-tool.test.js tests/voice-routes.test.js tests/voice-reader.test.js tests/suggest-panel-ui.test.js tests/suggest-panel.test.js tests/ball-bridge.test.js tests/voice.test.js` 142 通过 / 0 失败；`node --check index.js`、`node --check ui/assets/suggest-panel.js`、`node --check tests/app-tool.test.js` 与 manifest JSON 解析通过；`git diff --check` 对本轮改动的 `index.js` / `manifest.json` / `ui/assets/suggest-panel.js` 通过。
- 已知噪声：`tests/app-tool.test.js` 整个文件是 CRLF，对它跑全文件 `git diff --check` 会把每一行都报成尾随空格（既有噪声，非本轮引入）；本轮只核了改动的 `index.js` / `manifest.json` / `ui/assets/suggest-panel.js`。
- 验证边界：全为本地 mock，删除的是入口声明与工具注册，不涉及真实 TTS。App 已重载，inspect `host=on / agent=on (hanako)`；右键菜单与输入栏状态位在重载后应消失，需本人在界面上看一眼确认。manifest 版本、简介、README 未动。

## 2026-10-21 朗读缓存与播放键状态

- 补测（同日追加）：`tests/suggest-panel-ui.test.js` 新增「播放/静音图标是 svg：显隐只能走 toggleAttribute」，钉住四个图标不得再用 `.hidden =` 属性切换（SVG 上不生成 HTML 属性，CSS `[hidden]` 选不中）。命令与结果：`node --experimental-vm-modules --test tests/suggest-panel-ui.test.js tests/voice-reader.test.js tests/voice-routes.test.js` 34 通过 / 0 失败；`node --check ui/assets/suggest-panel.js`、`node --check tests/suggest-panel-ui.test.js` 与本轮 `git diff --check` 通过。

- 范围：`lib/voice.js`（`clipExists`、`clipMetaFile`、`saveClipMeta`、`readClipMeta`）、`index.js`（`voiceFingerprint`、`readClipCacheIndex`、`rememberCachedSpeak`、`readCachedSpeak`，`speakByEntry` 支持 `allowCache`）、`ui/assets/suggest-panel.js`（命中缓存的提示文案）、`ui/assets/suggest-panel.css`（播放键 40→32）、`tests/voice-routes.test.js`（新增 2 条）、`tests/ball-bridge.test.js`（旧断言对齐）。
- 命令与结果：`node --experimental-vm-modules --test tests/app-tool.test.js tests/ball-bridge.test.js tests/ball.test.js tests/ball-ask-watch.test.js tests/voice-routes.test.js tests/voice.test.js tests/voice-reader.test.js tests/suggest-panel.test.js tests/suggest-panel-ui.test.js` 175 通过 / 0 失败；对 `index.js`、`lib/voice.js`、`ui/assets/suggest-panel.js`、`tests/voice-routes.test.js`、`tests/ball-bridge.test.js` 运行 `node --check`，对本轮改动文件跑 `git diff --check`，均通过。
- 新增用例：同一段话二次合成不出网（合成请求数仍为 1）、clipId 与逐词时间戳照旧返回、缓存里的音频仍能按 `GET /voice/clip/:clipId` 取回；改语速后不命中缓存且 clipId 不同。
- 验证边界：缓存命中与失效路径均用本地 mock，没有调用真实 TTS。App 已重载，inspect `host=on / agent=on (hanako)`；**缓存命中未经真实合成链路验收**，需在面板里对同一段话连点两次确认第二遍直接出（提示会写「这段以前合成过」），并在改语速后确认重新合成。版本、简介、README 未动。

## 2026-10-21 朗读专注阅读页与词级播放器

- 范围：`ui/suggest-panel.html`、`ui/assets/suggest-panel.js`、`ui/assets/suggest-panel.css`、新增 `ui/assets/voice-reader.js`；`tests/voice-reader.test.js`、`tests/suggest-panel-ui.test.js`、`tests/voice-routes.test.js`。覆盖选中后独立阅读视图、自绘播放器控件、MiniMax 时间戳路由回传、词与原文标点对齐、标点/换行/表情不稀释时间戳覆盖率、缺少或覆盖不足时完整显示原文；并静态核对列表响应序号守卫、阅读区跟随高亮词滚动及音量滑条填充。
- 命令与结果：`node --experimental-vm-modules --test --test-concurrency=1 tests/voice-reader.test.js tests/suggest-panel-ui.test.js tests/voice-routes.test.js` 31 通过 / 0 失败；分别对 `ui/assets/suggest-panel.js`、`ui/assets/voice-reader.js`、`tests/suggest-panel-ui.test.js`、`tests/voice-reader.test.js`、`tests/voice-routes.test.js` 运行 `node --check`，均通过；本轮源码与测试文件的 `git diff --check` 通过。
- 验证边界：全部使用本地 mock，没有调用真实 TTS。App 已从当前磁盘代码重载，inspect 为 `host=on / agent=on (hanako)`；朗读页的实际布局与试听仍待本人在输入栏面板点验。版本、简介、README 未动。

## 2026-10-21 朗读入口移入输入框多功能面板

- 范围：`suggest-panel.html/js/css` 增加「推荐回复 / 朗读」切页；朗读页按 `hana.inputPanel.getContext().sessionId` 取当前对话最近 8 条回复，点某条后调用现有 `/voice/speak` 与 `/voice/clip`，用 Blob URL 显示原生音频控件；面板页切换时调整高度、切会话时清掉旧音频；移除 manifest 的回复末尾朗读 `messageActions`，保留选中文字右键菜单；`resolveSpeakTarget` 依据稳定会话编号补取 `agentId`，确保面板朗读跟随当前伙伴音色。收到截图反馈后修正常用回复胶囊被 Flex 压窄并省略的问题，改为完整换行显示；`estimatePanelHeight` 纳入页签和多条常用回复的空间。
- 命令与结果：完整相关测试 `node --experimental-vm-modules --test --test-concurrency=1 tests/suggest-panel-ui.test.js tests/suggest-panel.test.js tests/voice-routes.test.js tests/app-tool.test.js` 102 通过 / 0 失败；布局修正后重跑 `tests/suggest-panel-ui.test.js tests/suggest-panel.test.js`，11 通过 / 0 失败；对相关 JS 运行 `node --check`，manifest JSON 解析通过。
- 验证边界：未由小花调用真实 TTS API；设置页测试播放器证明 Blob 播放路线可用，但新输入面板尚未实机点验。布局修正后 App 已再次从磁盘代码重载，`inspect` 为 `host=on / agent=on (hanako)`，但当前仍未完成新输入面板的实机点验。需在面板切到「朗读」并点一条回复确认合成及播放器；自动播放若被拦，会显示手动播放控件。版本、简介、README 未动。

## 2026-10-21 聊天区选中文字右键朗读与阶段状态

- 范围：`manifest.json` 的聊天选区右键菜单与纯显示朗读状态项；`index.js` 复用朗读工具，在输入栏显示准备、合成、结果阶段；修正 `sessionPath` 到稳定 `sessionId` 的映射（复用 `resolveSessionIdByPath()`）；加入缺失选区提示、状态写入失败/成功/过期跳过日志、音频字节数/时长估计/音频头标记诊断；`tests/app-tool.test.js` 覆盖菜单声明、选区优先与伙伴音色、消息行旧行为、成功/失败状态、空选区、缺失选区及路径映射到不同的稳定会话编号。
- 命令与结果：`node --experimental-vm-modules --test --test-name-pattern='context-menu|chat selection|read-aloud reports synthesis failure|empty right-click' tests/app-tool.test.js` 5 通过 / 0 失败；`node --check index.js`、`node --check tests/app-tool.test.js` 与 manifest JSON 解析通过。
- 验证边界：本地 mock 成功/失败响应，未由小花调用真实 TTS API。本人 19:20 的实测日志显示三阶段 `inputStatus.set` 均成功，TTS 回 18,132 字节、时长估算 2,267ms；19:48 重测仍无声，但状态三阶段仍全部成功，音频回 17,844 字节、`ID3` 头、时长估算 2,231ms。本人确认「语音服务」测试音频的播放器手动点击后能听见。代码对照发现 App 测试播放器使用 Blob URL，而宿主 ChatTranscript UI action helper 使用 `Audio(data:audio/mpeg;base64,...)`，并静默吞掉 `Audio.play()` 拒绝。桌面 `/desktop` 会重定向到 `/pad`；`pad.html` 加载的 CSP 设置 `default-src 'self'`，未声明 `media-src`，因此 `data:` 音频源被回退规则阻止。MDN 说明 `media-src` 缺失时会回退至 `default-src`（https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/media-src）。这是宿主 renderer 策略与播放实现的冲突，仍未捕获控制台 violation；App 本身不改宿主包。新增日志只记阶段、来源、序号、字节数、时长和安全头标记，不记正文、完整路径或原始音频。最新版已重载，inspect `host=on / agent=on`。版本、简介、README 未动。

## 2026-10-20 Ask 卡片回传核验修正

- 范围：`recipes/zhiyi-ask/SKILL.md`（第 4 条重写）、`skills/zhiyi-ask-handoff/SKILL.md`、`index.js`（`CARD_RESOLVE_TOOL` 工具描述）、`lib/ask-guidance.js`（引导语）、`recipes/zhiyi-ask/assets/ask.card.html`（`yes()` / `unwrapOptions()` / `pullData()`）、`tests/ask-handoff-prompt.test.js`（新增 3 条）、`tests/card-template.test.js`（补 3 条、改 1 条旧断言）。
- 背景一（回传核验）：用户在 Ask 卡里选完并点确认发送，事件带完整 payload 回到原对话，但伙伴因 `ui_inspect` 回 `UI_INSPECT_CARD_NOT_FOUND` 而误判成没收到，扔掉有效选择。病根是把 `ui_inspect` 当成来源核验硬门槛，而 `resolve_card` 本就是更强的裁判。
- 背景二（卡片不可点）：用户报「一直显示正在与原对话绑定」，实为四个坑叠加——宿主把 host data 的 `ready` 存成字符串 `"true"`（模板只认布尔）、`options` 被包成 `{item:[...]}`、调用方自己多包一层 `item`、以及 `data.onChange` 根本不响（必须主动去拉）。
- 命令与结果：`node --test tests/card-template.test.js` 12 通过 / 0 失败；`node --test tests/ask-handoff-prompt.test.js tests/card-handoff.test.js tests/card-template.test.js` 全绿；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；`node --check index.js lib/ask-guidance.js` 通过。
- 覆盖边界：本轮只改规则文本、工具描述、引导语与卡片模板，`lib/card-handoff.js` 的 `resolve` 逻辑未动。**实机复验分两段**：① 选项可点已由用户确认（此前两张卡选项全灰）；② 事件回传的最终验收——用户点「确认发送」后回看 `resolve_card` 是否接住，尚未完成。旧卡不热更新。版本、简介、README 未动。

## 2026-10-20 面板按 UI 偏好重做

- 范围：`ui/assets/suggest-panel.css`（整块重写：配色、字体、圆角分档、按钮三档、滚动条）、`ui/suggest-panel.html`（标题改「解语花·知意」+ 手绘花枝 SVG）、`ui/assets/suggest-panel.js`（文案改「想一下…」「发好了 ✓」）、新增 `ui/assets/fonts/lxgw-wenkai.woff2`。
- 命令与结果：`node --test tests/suggest-panel.test.js tests/suggestions.test.js tests/recommendation.test.js tests/recommendation-config.test.js` 39 通过 / 0 失败；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；`node --check ui/assets/suggest-panel.js` 通过；字体文件已确认存在于 `ui/assets/fonts/`。
- 未覆盖：真实桌面验收（文楷标题实际渲染、背景铺满不再透明、按钮层次）未实机确认。版本、简介、README 未动。

## 2026-10-20 面板铺满 + 常用回复面板内可管

- 范围：`ui/suggest-panel.html` + `ui/assets/suggest-panel.js` + `ui/assets/suggest-panel.css`（整块铺满、编辑态增删改常用回复）、`index.js`（新增 `POST /suggest-panel/quick-replies`）、`lib/suggest-panel.js`（高度估算加余量与编辑态行）。
- 命令与结果：`node --test tests/suggest-panel.test.js tests/suggestions.test.js tests/recommendation.test.js tests/recommendation-config.test.js` 39 通过 / 0 失败；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；`node --check index.js lib/suggest-panel.js ui/assets/suggest-panel.js` 通过。
- 未覆盖：真实桌面验收（面板与宿主容器同色无透明缝、空态文字不再被裁、编辑态增删改落盘）未实机确认。版本、简介、README 未动。

## 2026-10-20 面板改两段式（常用回复 + 生成按钮）

- 范围：`lib/recommendation-config.js`（`quickReplies`）、`lib/suggest-panel.js`（状态带 `quickReplies`/`panelId`、高度估算）、`index.js`（工具只挂面板、新增 `/suggest-panel/generate`、状态路由实时读常用回复）、`ui/suggest-panel.html` + `ui/assets/suggest-panel.js` + `suggest-panel.css`、`ui/panel.html` + `ui/assets/panel.js` + `panel.css`（设置页常用回复编辑）。
- 命令与结果：`node --test tests/suggest-panel.test.js tests/suggestions.test.js tests/recommendation.test.js tests/recommendation-config.test.js` 39 通过 / 0 失败（新增：常用回复去重/限长/限量、配置归一化、无推荐时会话归属与 panelId 仍保留、高度估算随内容增长且不超上限）；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；`node --check index.js ui/assets/panel.js ui/assets/suggest-panel.js` 通过。
- 未覆盖：真实桌面验收（点按钮立刻弹面板 → 生成推荐 → 改字 → 发出；常用回复按钮）未实机确认；生成推荐这条真实模型调用未在本轮触发（由用户在面板里点按钮触发）。版本、简介、README 未动。

## 2026-10-20 推荐面板跟设置打通 + 输入栏按钮开关

- 范围：`lib/recommendation-config.js`（`inputButton`）、`lib/suggest-panel.js`（候选带方向、上限四条）、`index.js`（显隐同步、设置保存后同步、`session_created` 合流、面板结构变更）、`ui/panel.html` + `ui/assets/panel.js`（新开关）、`ui/assets/suggest-panel.js` + `suggest-panel.css`（去复制、加方向标签）。
- 命令与结果：`node --test tests/suggest-panel.test.js tests/suggest-banner.test.js tests/suggestions.test.js tests/recommendation.test.js tests/recommendation-config.test.js` 44 通过 / 0 失败；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；`node --check index.js lib/suggest-panel.js lib/recommendation-config.js ui/assets/suggest-panel.js ui/assets/panel.js` 与 manifest JSON 解析通过。
- 修过的两处回归：`app-tool` 的「自动续接」用例曾因另起一个 `bus.subscribe` 顶掉原有续接订阅而失败（mock 的 subscribe 只保留最后一个 handler），改为合进原订阅后恢复 61/61；`inputStatus.set` 曾在 App 加载过程中调用导致装载报 `has no declared input status item` 并中断重载，改为延后 2 秒调用后重载成功。
- 未覆盖：真实桌面验收（设置页开关 → 输入栏按钮显隐 → 新会话也生效）未实机确认；面板方向标签与设置勾选的对应只做了纯函数层校验。版本、简介、README 未动。

## 2026-10-20 推荐语改自绘面板（inputPanels）

- 范围：新增 `lib/suggest-panel.js` + `tests/suggest-panel.test.js`（7 条）、`ui/suggest-panel.html` 与 `ui/assets/suggest-panel.js` / `suggest-panel.css`；`index.js` 的工具 `jiegehua.zhiyi_suggest` 改为挂面板并加 `GET /suggest-panel/state`、`POST /suggest-panel/send` 两个路由；`manifest.json` 加能力词 `app/input.panels`。
- 命令与结果：`node --test tests/suggest-panel.test.js tests/suggest-banner.test.js tests/suggestions.test.js tests/recommendation.test.js` 36 通过 / 0 失败（覆盖候选归一化与上限三条、面板状态读写、跨会话不串内容、面板高度取值）；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；`node --check index.js lib/suggest-panel.js ui/assets/suggest-panel.js` 与 manifest JSON 解析均通过。
- 未覆盖：真实桌面验收（点输入栏按钮 → 输入框上方挂出板子 → 点「发这句」→ 伙伴接话）需用户批准 `app/input.panels` 权限后实机确认；面板挂载失败退回横幅的降级路径未实机触发。版本、简介、README 未动。

## 2026-10-20 输入栏推荐按钮与推荐横幅

- 范围：新增 `lib/suggest-banner.js`（横幅构造纯函数）与 `tests/suggest-banner.test.js`（8 条），`index.js` 新增工具 `jiegehua.zhiyi_suggest`，`manifest.json` 声明 `contributes.ui.inputStatus` 与能力词 `app/input.status`。
- 命令与结果：`node --test tests/suggest-banner.test.js tests/suggestions.test.js tests/recommendation.test.js` 27 通过 / 0 失败（覆盖按钮上限 3、标题按字符数截断到 40 且带省略号、注入用完整原文、横幅正文 ≤200、字符串形式建议与空项过滤）；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败（index.js 装配与相邻回归）；`node --check index.js`、`node --check lib/suggest-banner.js` 与 manifest JSON 解析均通过。
- 未覆盖：真实桌面点击（输入栏按钮 → 横幅 → 点一条发出去 → 伙伴接话）需用户在设置里批准「在输入栏显示按钮和状态」后实机验收；宿主横幅按钮点击的 bus 事件名未在公开契约中找到，故未实现「换一批」按钮。版本、简介、README 未动。

## 2026-10-19 移除「等 ta 说完再发」整块

- 删除范围：`QueueInsertDialog` 类、主面板 `queue_tool` 工具行与「写一句」、`_open_queue_insert`、球的拖动跟随与关窗联动、`bridge_polish_call` 的 `rounds`、`index.js` 的 `queueLoop` 状态机与 `queue`/`queue-cancel` 两个 kind、`lib/queue-loop.js`、`tests/queue-loop.test.js`，以及 Python 四处用例。`followUp` 投递能力与捋一捋窗的发送/排队保留。
- 命令：`node --test tests/*.test.js` 353/353 全绿；Python 目录 `python -m unittest test_ask_dialog test_resume_dialog test_app_bridge` 88 项通过、1 跳过；`zhujian_app.py`、`app_bridge.py`、三个测试文件 ast 通过。
- 离屏复核：主面板渲染无「等 ta 说完再发」行且无空白缺口，`ZhujianMenu` 不再有 `queue_tool`，模块不再导出 `QueueInsertDialog`；App 已正式重新加载、球进程重启为新代码。
- 未覆盖：全量 Python 套件、真实桌面点击验收、宿主原生排队的实机对照。历史与恢复步骤见项目根 `已移除功能记录.md`。版本、简介、README 未动。

## 2026-10-19 快速档真实成功确认与结果提示

- 13:05:35真实调用账确认快速档实际模型为openai-codex/gpt-6-luna，状态ok，耗时3595ms，输入92/输出48 token，reasoningTokens为null。确认此前测错模型修复后新调用成功，但不能倒推旧服务商错误的唯一原因。界面显示0而账本缺思考用量，因此不把0当作已关闭思考的证明。
- 提示修正：后端effort保留原值，前端明确“测试通过”，将3595毫秒呈现为3.6秒；off文案只表示“已请求关闭”，默认文案“使用模型默认档”。仅正数思考用量显示具体数量，不将接口0解释为未思考；未改实际调用档位或模型。
- 补整模块DOM结果显示两场景，先在完整可用模型fixture复现旧提示导致2个断言失败（早期fixture缺目录引发按钮禁用不算业务复现）。修复后 `node --experimental-vm-modules --test --test-name-pattern='panel ES module|panel full-module|fast-model test|fast-model follow' tests/app-tool.test.js`：18/18通过，0跳过；index.js与ui/assets/panel.js语法检查通过。不运行全应用回归；本轮尚未额外发模型请求。

## 2026-10-19 快速档测试误用已保存模型

- 原始证据：12:55多次快速档测试实际调用MiniMax；后续一次才调用6luna并报APP_MODEL_PROVIDER_ERROR。同分钟6luna其他短任务有成功记录，不能判断模型整体不可用；泛化错误与附近HTTP2警告不能直接归为同一请求根因。
- 确认代码问题：测试路由将界面modelRef作为resolveFastModel的fallback，库却优先读取已保存fastTaskModel。新增三条装配路由测试：保存MiniMax但当前选6luna、当前选跟随Ask、当前选已删除模型。修前3/3失败，前两条实际调用旧模型，第三条竟然成功。
- 修复：resolveFastModel增加useStored选项，默认true保持正式任务语义；测试路由明确false，跳过已保存快速模型。目录查找结果必须与所选provider/model一致，防止resolveAskModel回退当前模型。测试不落盘、不改用户设置。
- 命令：`node --experimental-vm-modules --test --test-name-pattern='fast-model test|fast-model follow' tests/app-tool.test.js`：3/3通过；`node --test tests/fast-model.test.js tests/length-summary.test.js tests/session-title.test.js`：47/47通过。`node --check index.js`及`node --check lib/fast-model.js`通过。未全应用回归。
- 正式管理入口重新加载成功。真实6luna调用待验：卡片describe_elements返回Unknown UI action，Computer Use只取得无目标控件的窗口树，未绕过UI通道或猜坐标；已请在设置界面选6luna后点测试，以实际调用账验证。尚无本轮真实模型成功证据，不能宣称此前服务商失败解决。版本/简介/README未动；源码与测试改前已专项备份核SHA-256。

## 2026-10-19 不用管返回后一级面板右侧裁切

- 现场截图：工具卡片右边与按钮被同一边界截断，顶部目标说明、底部改名反馈均为未省略长单行。普通标题切页与五行目标菜单打开后切页未复现相同裁切；不能宣称断联页切换是必要触发条件，也未据此判断提醒本身是否误报。
- 增加长标题快照在主区隐藏时到达、点击不用管成功后返回的完整链路。修前真实断言失败：main_view宽776 > viewport宽304；独立长标题在切页前更新也可撑宽，因此定位为单行文本最小宽度传到滚动内容。底部反馈携带长标题亦需独立防护。
- 修复：只处理一级主面板的目标说明与反馈行，水平尺寸策略Ignored；显示按外框内宽与视口宽的较小值省略，tooltip保留全文。目标状态、存储标题、改名请求与反馈来源不截断；没有改提醒触发或不用管协议。
- `PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen python -B -m unittest test_resume_dialog test_ask_dialog`：55项中54通过、1个可选截图用例因未指定预览目录跳过。含隐藏时长目标/改名反馈到达→不用管→主区恢复、反馈独立撑宽，以及上轮旧版内嵌菜单和无闪动回归。两个修改文件ast.parse通过，目录无.pyc。改前四文件专项备份并核SHA-256。
- 另以合成中文长标题生成工作台“传音樱旧版恢复验收/不用管返回-长标题.png”，实际内容宽304、视口304、面板344。未全应用回归、未访问真实会话正文、未调用模型或发送真实消息；真实桌面同场景待关闭重开传音樱后验收。版本/简介/README不动。

## 2026-10-19 一级面板滚动条周期闪动

- 改前离屏复现：内容不变，连续三次 _sync_size 产生面板高度事件 `[324,522,324,522,324,522]`，对应 adjustSize 先缩、_fit_to_content 再撑回。新增稳定性断言修复前失败；长内容真实滚动用例原本通过。
- 修复仅分流 _sync_size：主视图可见时直接 _fit_to_content，其余（续接专页）保留 adjustSize。未改滚动条策略、宽度、旧版目标样式或刷新频率。测试进一步监听面板、视口尺寸和滚动条显隐，三轮不变内容同步均无事件；420px封顶的长内容仍可滚动，候选与推荐不重叠。
- 运行范围：Python目录设置 `PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen`，`python -B -m unittest test_ask_dialog test_resume_dialog`：53项中52通过、1跳过（可选预览产物用例未指定输出目录）。覆盖一级面板/Ask及直接受影响的续接专页，不是全应用回归。两个修改文件 ast.parse通过，目录无.pyc。改前四文件已专项备份并核SHA-256。
- 真实桌面闪动消除仍需关闭并重新打开传音樱确认，离屏测试不等同实机。未重启Hana、未调用模型、未向真实对话发消息、未发布；版本、简介、README未动。

## 2026-10-19 一级目标选择恢复旧版

- 参照旧版工作台源码的 TargetMenu 样式与内嵌结构；仅恢复样式和主面板展开方式，不回滚 App 请求、sessionId 匹配、modified 时间兼容及候选缓存。当前目标 QSS 与旧版逐字对比相同。
- 改前留存四文件备份并核 SHA-256；原浮层三条定向用例通过，仅说明原有结构符合旧测试，不作为视觉满意证据。恢复内嵌后新增非覆盖断言实际失败：目标菜单底边438，推荐区顶边262，重叠177px。停用 _fit_to_content、重新激活布局无效，父对象归属核对正确；原位置移出再插回该菜单布局项后推荐区恢复向下排列。仅在目标变化的延迟排布中采用此措施，保留顺序与显隐。
- 命令：python 目录设置 `PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen`，运行 `python -B -m unittest test_ask_dialog`：25/25通过、0跳过。覆盖旧版内嵌结构和选中样式、五条候选不重叠、后续推荐区不覆盖、固定/自动请求与收起、反复展开与切换，以及同模块直接相邻界面回归。两个修改 Python 文件 ast.parse 通过，目录无 .pyc。
- 离屏合成数据截图位于工作台“传音樱旧版恢复验收”，显式加载本机中文字体仅用于预览；截图目标底边408、推荐区顶边418。独立只读复核无阻断项。离屏验证不等于真实桌面验收，运行中的 Python 球需关闭重开才能加载源码；本次未重启 Hana、未调用模型或向真实会话发送消息、未全应用回归、未发布。版本/简介/README未改。

## 2026-10-19 推荐开关与状态文字矛盾

- 实际基线：截图选中传音樱，状态写已关闭；panel.js的renderRecommendationBehavior仍比较display==='card'，后端规范值已为ball/off。未读取或改写生产设置，不把单个截图当作保存失败证据。
- 先加整模块行为测试：GET返回ball时选中与文字一致；关闭→350ms自动保存→回显关闭；开启→保存PUT携带ball→响应后回显开启。修复前首次加载和保存开启两个子场景均得到已关闭，确认复现；关闭场景正常。
- 修复仅将开启判定改成ball；测试同时复验现有续接整模块交互，不改保存协议、次数或用户配置。
- 命令：`node --experimental-vm-modules --test --test-name-pattern='panel ES module|panel full-module|recommendation display setting' tests/app-tool.test.js`：14/14通过、0跳过。`node --test tests/recommendation-config.test.js`：7/7通过。无付费模型、未全应用回归；测试使用模拟接口与DOM，生产页面重新打开仍待反馈。

## 2026-10-19 断点续接整体策略与条件界面（本地验证通过，实机待验）

- 基线：App清单0.1.39，已有大量其他未提交修改，不回滚、不动版本/简介/README。改前14个直接相关文件及2个发送路径文件已复制到工作台专项备份目录并逐文件SHA-256比对通过。10-18默认enabled=true、球一级有“暂无待接”常驻入口；自动发送后立即noteResumeFailed是待修路径，不能把旧离屏截图或旧70/65测试计入本轮验收。
- 当前约定：整体开关默认关闭；开启默认手动。总关不检测/不发/不显示，撤提醒与未发送任务。手动无球安静、有球才弹操作页；自动不依赖球，按窗口独立计数，有球仅一级面板临时状态，不主动展开；达到上限且最后一次判定仍未恢复才弹。无球上限后安静停止，设置可查结果。恢复清对应窗口、正常新消息另起故障轮；发送成功不清零。总关不误停正常聊天循环。
- 接口验收：/resume-config的enabled/autoResume/maxConsecutive为统一设置；/resume/progress全量替换临时状态，携带开关与上限；空任务不占位。球重启/应用重载同步设置，不重放旧按钮动作。关闭与异步名单读取/发送排队并发时，过期决定不得触发新的发送；已经交给宿主的请求不能声称可撤回。
- 安全边界：只跑续接与直接相邻Ask/循环/桥测试，不跑全应用回归、不调用付费模型、不实际向对话发送继续哈、不启动桌面试验窗；显示预览使用离屏合成数据。需要实机恢复/误报观察的场景单列待验。
- 验收矩阵：总关×球开关；手动×球开关；自动×球开关；多窗口独立上限；最后一发恢复与失败；发送拒绝；关闭并发取消；恢复撤临时状态；设置保存失败与计数保留；球旧动作不重放；Ask选项和补充不丢；开关开/关/禁用配色及长来源/错误下底部按钮稳定。下述为模拟接口与离屏覆盖，不等同于桌面端到端实测。
- 最终Node命令：`node --experimental-vm-modules --test tests/resume-watch.test.js tests/app-tool.test.js tests/continue-loop.test.js tests/send.test.js tests/voice-routes.test.js tests/ask.test.js tests/card-template.test.js tests/ball-ask-watch.test.js tests/card-handoff.test.js tests/ball-bridge.test.js tests/ball.test.js`：188/188通过、0跳过。`--experimental-vm-modules`不能省，否则整文件ESM用例会跳过；8个子场景实际执行完整模块启动、单次开关请求、最大次数单字段保存、失败恢复、全窗口进度等。不是全应用回归。
- 最终Python命令：python目录设置`PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen ZHIYI_RESUME_PREVIEW_DIR=<预览目录>`，`python -B -m unittest test_resume_dialog test_ask_dialog test_app_bridge`：78/78通过、0跳过；四个修改Python文件ast.parse通过，无pyc残留。最后补按钮独立截图后，单独复验`test_resume_dialog.ResumeDialogTests.test_render_requested_previews`：1/1通过。
- 最后局部修正忽略接口的来源校验与循环提醒隔离后，`node --check index.js`通过，并运行`node --test --test-name-pattern='续接|继续哈|不用管' tests/voice-routes.test.js`：5/5通过。未把重复运行数量并入188项。
- 审查收尾：桥嵌套config现在进入同一applyResumeConfig；手动桥与路由都受总开/代次及发送前守卫约束。sendToConversation将beforeSend交给每次busy重试前guard；关闭配置后增加代次、clearAll，不把原任务在关→开后复活。turn_end异步解析后重新检查代次；手动报告不计作自动上限；恢复与忽略仅清同窗口、非loop_confirm提醒。
- 视觉检查：离屏生成手动、自动1/3、上限3/3、空任务隐藏、开关开/关/禁用及长来源/失败预览；另外独立保存三态开关按钮，避免整页滚动位置遮挡。使用测试中文字体不修改产品字体。真实球重开、真实异常是否恢复、同宿主请求拥堵与误报仍待实机观察。
- 保护核对：manifest与本轮改前备份SHA-256一致，版本/简介未改，README无diff。未安装更新、未发布、未push；采用正式重新加载使Node部分生效，运行中Python球须手动关闭重开。

## 2026-10-18 续接误报：现场与验证约束

- 修改前现场：宿主日志 `2026-10-18_12-20-10.log` 的 21:44:06.750，同一对话仍有 `message_end stopReason=toolUse`；21:44:07.723 出现“续接用尽，已在传音樱提醒”；21:44:09.338 同一对话 `turn done`。据此确认本次在对话进行中误报。截图同时显示推荐区会话名单超时，不能只凭该提示断言误报唯一原因。
- 已确认代码漏洞：续接复核在名单请求失败时沿用缓存，原逻辑没有区分旧缓存和新证据，可能把旧 modified 当“本轮没有进展”。这与现场一致；原日志未包含该次候选开始时间与复核快照，完整单一因果仍不可追溯，不宣称唯一根因。
- 验证要求：旧名单只允许提供来源名称，不可证明会话无进展；证据缺失/过期先等待，新鲜证据显示有进展则恢复；正常工具中间轮不算结束。必须校验缓存失败与后续恢复的集成路径，不以“新增导出尚不存在”这一失败代替行为复现。
- UI要求：球内独立断点续接视图，来源/原因/状态分清，操作栏稳定；自动与循环配置保留、单独成区，推荐刷新不能穿透。桥上登记请求不等于消息已送达，提示须区分提交与完成；失败保留页面与重试。
- 最终Node验证：`node --test tests/app-tool.test.js tests/resume-watch.test.js tests/continue-loop.test.js tests/card-handoff.test.js`，70/70通过。合成集成场景走App装配、钩子与定时器，覆盖旧索引+名单失败不记卡住、新鲜无进展仍可报告、连续失败freshAt不推进；纯逻辑补缺时间等待。测试输入均为合成数据，首次缺export失败不作为行为复现证据。index与resume-watch语法检查通过。
- Python相关验证：在python目录设 `PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen`，运行 `python -B -m unittest test_resume_dialog test_ask_dialog test_app_bridge`，65/65通过、0跳过（设置 `ZHIYI_RESUME_PREVIEW_DIR` 才执行预览用例）。覆盖专页空态/来源/长内容/失败重试/配置与循环能力、推荐刷新隔离、Ask选项和说明保留，以及桥接口；修改文件ast.parse通过，无pyc残留。
- 视觉复核：离屏fixture显式加载已安装的中文字体，不改变产品字体。首次预览发现滚动区系统灰底与缺字体，修补后复验正常与长来源/失败两张PNG；来源置于长失败信息前，内层滚动、420px上限、底部按钮位置保持。产物在工作台“知意续接界面预览”。
- 交叉复核已完成。未启动真实续接或付费模型，未全应用回归，未人为阻塞宿主名单请求；实机误报是否彻底消失须观察。现有总线正常结束事件已按同会话清旧提醒，本次未增全局清理。另读到设置页无实际元素的旧手动续接处理器（空来源回退最近会话）风险，当前新Qt专页有来源检查，不在本轮扩改该潜在旧入口。

## 2026-10-18 选项与补充说明同时提交

- 修改前基线（App 0.1.39）：球上多选已勾选＋文字会走 custom 分支、舍弃选择；单选点击立即提交，无法随后补充。配方卡“用我的答案”也会舍弃已选项。先增加测试复现：球UI 14项中3项失败；卡片9项中3项失败；桥34项中3失败＋1错误，均对应缺字段或旧交互。
- 修改：两种选择模式都先点选再确认；选项＋说明走 choice＋note；没有任何选项时，文字单独走原 customChoice 路径。卡片单一确认按钮，不再提供会覆盖选择的“用我的答案”；有部分多选时仍校验最少数量。桥校验补充说明类型与500字符限制。保留发送失败后的选择、说明与重试入口。
- Python：`PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen python -B -m unittest test_ask_dialog test_app_bridge`，49/49通过；含界面→HTTP请求中的 choice＋note、失败保留，以及桥端单双选、仅文字、非法说明校验。四个改动Python文件 ast.parse 通过，检查无 .pyc。
- Node：`node --test tests/card-template.test.js tests/ask.test.js tests/card-handoff.test.js tests/ball-ask-watch.test.js`，37/37通过；覆盖单双选＋说明、仅文字、失败重试、数量限制、真实卡片脚本语法、注册器核验和球回传文本。
- 未做全应用回归、未调用付费模型。lib/ask.js与球回传已有choice＋note支持，保留不改；此次只修上游实际提交的互斥，不扩充混用customChoice＋choice协议。全局Recipe通过正式安装确认同步；旧卡不热更新，球需关闭重开，新场景实机仍待验。

## 2026-10-18 Ask 来源标题微调

- 顶部改为动态“伙伴名 ·「窗口标题」”，保留题名单列；缺失伙伴/标题时只显示已有信息。
- 离屏运行 `PYTHONDONTWRITEBYTECODE=1 QT_QPA_PLATFORM=offscreen python -B -m unittest test_ask_dialog`：12/12 通过，覆盖新格式及三种缺失字段组合；未发现 .pyc。首次新增测试复用同一 askId 被界面去重而失败，改用独立 askId 后通过。
- 21:14 收到上一轮球上自定义回答，确认该次回到原会话；回传文本未含多选数组，多选仍未据此验收。发题工具曾30秒超时，但实际题目可作答并回传，不能据工具超时认定未发出。新标题需球重开后再实机检查。

## 2026-10-18 传音樱 Ask 回传与来源标题

- 修改前基线：20:39 发球题，20:40:47 日志记录回传 `APP_HOST_ERROR`；当时 send.js 已把原始错误改成泛化提示，无法从旧日志还原唯一原始原因。当前宿主 1.1.24 的 session:send 对 v2 调用额外校验 `app/session.start-turn`；修改前 manifest 和该 App 权限记录均缺此项，是已确认的阻断条件。标题链路则在 Python 桥写死来源名，未透传真实会话标题。
- 先新增错误 cause、来源字段透传和 Qt 顶部来源标题用例：修改前各失败；修复后相关 Node 测试 `node --test tests/send.test.js tests/ball.test.js tests/ball-ask-watch.test.js tests/app-tool.test.js` 66/66。
- Python 仅相关桥和离屏弹窗两个模块：在 python 目录 `PYTHONDONTWRITEBYTECODE=1 python -B -m unittest test_app_bridge test_ask_dialog`，40/40；ast.parse 通过，无新增 .pyc。Node 修改文件语法检查通过。
- 未做全应用回归、未调用付费模型。新增权限必须经正式更新与本人授权；球重开后再验新题的来源标题与回传，测试通过不替代实机结果。

## 2026-10-18 Ask 卡片排版恢复

- 范围：仅恢复 Recipe 原 CSS 与平铺结构，保留数值、包装数组、缺失标题兼容和单/多选回传。
- `node --test tests/card-template.test.js tests/card-handoff.test.js`：8/8 通过；覆盖普通/包装选项、字符串数值、多选确认数组回传、绑定与拒绝边界，以及防止重新引入本次限高包装。
- 与 Git HEAD 对比：CSS 逐字一致，main 去除标题兼容标签差异后逐字一致。
- Recipe 已经界面确认安装；20:32 核验本会话新卡的真实事件和 resolve_card：四个选项可见、勾选/取消正常、底部输入框与按钮可见，多选三项及补充说明成功回传。仅本次短内容场景通过，不代表任意长内容裁切已解决。
- 未通过：反馈「视觉上滑动还是有点拖沓」。撤回限高滚动布局没有消除这一现象，根因待查，不归咎宿主冻结机制或宣称整体验收通过。旧卡不会热更新。

## 2026-10-18 快速档与 Ask 卡片修复

- 全量：`node --test tests/*.test.js` → **301/301 通过**（含新增 `tests/fast-model.test.js` 9 条）。
- 语法：`node --check` 过 `lib/fast-model.js`、`lib/length-summary.js`、`lib/session-title.js`、`lib/custom-model.js`、`lib/ask-model.js`、`index.js`、`ui/assets/panel.js`。
- 新增用例覆盖：默认带 `off`；模型报 `APP_MODEL_UNSUPPORTED_REASONING` 时脱掉重发且重试留在同一模型；别的错误码不当成“不支持思考”；空正文时同模型加预算重试并带 `reasoningTokens`；两次都空才抛 `MODEL_EMPTY`；自定义直连档不发思考参数；快速档模型的选择与回落。
- 同步修了 `card-template.test.js` 的断言方向：它原先要求模板必须直接用 `snapshot.expiresAt` 比较，而这正是“卡片一出生就过期”的成因。
- **未调用真实付费模型**。三个目标模型（deepseek-flash / MiniMax-M3.1 / gpt-6-luna）关思考是否生效、耗时多少，需要在设置里点「测试一下」实机确认。

## 命令

```powershell
node --check index.js
node --check lib/ask.js
node --check lib/ball.js
node --check lib/card-handoff.js
node --check lib/ask-guidance.js
node --check lib/suggestions.js
node --check lib/recommendation.js
node --check lib/ask-model.js
node --check lib/length-summary.js
node --check ui/assets/panel.js
node --check ui/assets/ask-panel.js
node --check tests/ask.test.js
node --check tests/ask-model.test.js
node --check tests/app-tool.test.js
node --check tests/ball.test.js
node --check tests/card-handoff.test.js
node --check tests/card-template.test.js
node --check tests/suggestions.test.js
node --check tests/recommendation.test.js
node --check tests/recommendation-config.test.js
node --check tests/length-summary.test.js
node --test tests/ask.test.js tests/ask-model.test.js tests/app-tool.test.js tests/ball.test.js tests/card-handoff.test.js tests/card-template.test.js tests/suggestions.test.js tests/recommendation.test.js tests/recommendation-config.test.js tests/length-summary.test.js
$env:PYTHONDONTWRITEBYTECODE = '1'
python -c "import ast,pathlib; [ast.parse(pathlib.Path(p).read_text(encoding='utf-8'), filename=p) for p in ['python/app_bridge.py','python/zhujian_app.py','python/test_app_bridge.py','python/test_ask_dialog.py']]"
python -m unittest discover -s python -p 'test_*.py' -v
node <hana-app-creator>/scripts/validate_app.mjs --dir <app-source-dir> --json
node <hana-app-creator>/scripts/validate_app.mjs --dir <app-source-dir> --smoke --json
```

## 覆盖范围

- Ask 参数边界、推荐/备选项与自定义回答；按语义单选/多选、数量范围、数组答案与重复/伪造选项校验；拒绝、超时、关闭不能变成同意。
- 推荐回复基础纯逻辑：条数与方向映射、提示词的说话人/语言/JSON 约束、额外偏好清理、模型输出解析与大小上限、已知空话过滤；传音樱侧按目标会话编号读取最近 8 条可见文字、跟随本会话模型或使用显式选择的 Hana 模型，传递短时调用凭证，不读取隐藏思考；缺少模型、会话或调用凭证时拒绝静默换模型。展示方式只剩「传音樱内 / 关闭」，旧值 `card` 迁移到传音樱。
- 推荐卡片已于 2026-10-17 下线：`jiegehua_zhiyi_suggest_replies` 与 `jiegehua_zhiyi_send_recommendation` 两个工具不再注册，`lib/recommendation-card.js` 及其测试已删除，`buildRecommendationGuidance` / `appendRecommendationGuidance` / `isCardRecommendationEnabled` 一并移除；球面板在 `enabled: false` 时整块隐藏推荐区。`tests/app-tool.test.js` 保留反向断言，防止以后有人把它们加回来。
- App 工具注册、原会话归属、无球时登记配方卡待办、单/多选卡片绑定与数组作答/取消、数量范围和原生确认卡回退；配方卡脚本模拟验证勾选不提前提交、确认后按数组回传，花球分支不受影响；前端请求失败时保留后端报告的运行中/退出中状态。
- Ask 生成前引导与判断模型：注册 `agent/before-start` 钩子；普通输入不调用判断模型，候选决策输入最多触发一次有时限的模型预检；模型选择、聊天模型目录过滤、结构化结果解析、模型设置持久化与卡片交接提示均有覆盖。
- 浮球进程启动握手、App 专属数据目录、最小子进程环境、按 Windows `USERPROFILE` 推导的 Python 用户包 `APPDATA`、Python 启动器解释器枚举与 PyQt6/QtSvg 导入探测、回环请求令牌、忙碌回退；停止/重启并发、Python 探测期间停止、启动回包与关闭 marker 同批到达时不复活桥接；直接收球时采用 marker→父进程回执→关桥握手，父端无回应时有界退出；极端父端卡顿时 Ask 可返回“结果未确认”错误而非 aborted，但启动超时、等待中断联与传输故障都不把异常当作同意。
- Python 回环服务的令牌校验、问题入队/作答/过期状态机、多选范围校验与数组回传；离屏 Qt 测试验证多选勾选后再确认、数量上限及单选仍即时提交。桥接测试只用标准库；Qt 冒烟测试需要 PyQt6，另检查 Ask 问题/背景/建议分区、推荐标记和右键菜单关闭入口。
- 传音樱新主视觉：离屏 Qt 画布确认透明底樱花枝条资源可加载并实际绘制；该冒烟不替代桌面实机的视觉、拖动与悬停验收。
- Python 全部移植文件语法解析；不会生成 `.pyc`。

## 当前验证记录

2026-10-17（捋一捋按钮行重排）：离屏渲染实测三按钮宽度 97 / 98 / 97，高度与圆角一致，面板可见；Python `unittest` 37/37，无 `.pyc`。截图存过一份目测后已删（离屏无字体，只能看布局）。未在真实桌面看字体渲染后的观感。

2026-10-17（点球不弹面板）：`ball-crash.log` 实录 `AttributeError: 'ZhujianBall' object has no attribute 'ball'`（line 2725 `_toggle_expand`），定位为 `self.ball` 用错对象；修正后离屏调用 `_toggle_expand()` 两次：面板 `visible: True` → 收起正常，无异常。Python `unittest` 37/37，`ast.parse` 通过。未在真实桌面重实验证，需用户重启传音樱后点击确认。

2026-10-17（传音樱崩溃排除）：手动启动 `python zhujian_app.py` 两次（offscreen 与真实桌面平台各一次），均打出 `zhiyi-ball-ready`、无 stderr、`ball-crash.log` 为 0 字节，未能复现用户报告的崩溃；Python `unittest` 37/37、`node --check lib/ball.js` 通过。另：本轮改 import 时一度误删 `json` / `traceback`，已立即改回并复验通过（该失误发生在用户报告崩溃之后，与崩溃无关）。下一步需用户再点一次开关，靠 crash log / 宿主 stderr 日志取证。

2026-10-17（速览把 MOOD 算进原文）：`node --test` 16 个文件 186/186 通过（新增 `stripMoodBlock` 用例：MOOD 区块剥干净、无 MOOD 原样、null 空串）；`length-summary.test.js` 24/24。核实：`collectTextParts` 只收 `type==="text"`，所以 reasoning 本来就不在内；出问题的是写进正文的 `<mood>` 块。未用用户原消息逐字复算 1284 的构成（只做了结构核验）。

2026-10-17（速览插在回复中间）：`node --test` 16 个文件 185/185 通过（新增 `hasToolCalls` 用例：带 toolCall 为 true、纯文本/字符串正文/空为 false）；`length-summary.test.js` 23/23。查了用户实配：`summaryConfig = { enabled: true, minChars: 600 }`，速览卡上写的是 619 字，确实过了 600 的线，所以触发本身合规——真问题是插入位置（带工具调用的中间消息就被误当成结尾）。未实机验证修后是否只在末尾出现。

2026-10-17（循环续接补回）：`node --test`（16 个文件，含新增 `continue-loop.test.js` 6 条与 `queue-loop.test.js` 5 条）184/184 通过；Python `unittest` 37/37；`index.js`、`lib/continue-loop.js`、`lib/resume-watch.js`、`app_bridge.py`、`zhujian_app.py` 语法检查通过，无 `.pyc`。`continue-loop.test.js` 覆盖：轮数收敛、设 N 轮真发 N 轮、刚发完不重复发、收工话先问人、用户接话即停、弱询问词只在句尾算收工。**未覆盖**：index.js 里循环与钩子/桥的接线、球侧新 UI（勾选、轮数、状态行、停止、确认卡）均未实机验证。

2026-10-17（循环排队 + 插话停循环）：Python `unittest` 37/37；`node --test tests/app-tool.test.js tests/send.test.js tests/ball-bridge.test.js tests/polish.test.js tests/queue-loop.test.js` 79/79（新增 `queue-loop.test.js` 5 条：轮数收敛、自发消息不停、同会话插话停、别的会话不影响、无循环不动）；语法检查通过。**未覆盖**：钩子里“补发下一条”的 `queueLoop` 递减路径、真实多轮节奏与插话停止均未实机验证。

2026-10-17（循环排队 + 捋一捋排队钮）：Python `unittest` 37/37 通过（新增 `test_queue_loop_uses_queue_kind_with_rounds`：轮数>1 必须走 `kind=queue` 且带 rounds；`test_queue_request_carries_rounds_and_cancel_needs_no_text`：rounds 收敛到 1~50、`queue-cancel` 不要求正文）；`node --test tests/app-tool.test.js tests/send.test.js tests/ball-bridge.test.js tests/polish.test.js` 74/74；`index.js`、`app_bridge.py`、`zhujian_app.py` 语法检查通过。**未覆盖**：App 侧“每轮说完补下一条”的 `queueLoop` 状态机没有单元测试（在 `index.js` 钩子内），也没有真实多轮实机；未验证循环中途手动插话的行为。

2026-10-17（排队插话弹窗复刻旧版外形）：Python `unittest` 35/35 通过（新增 `test_queue_insert_dialog_queues_instead_of_steering`：点「就这么发」必须走 `followUp`，不能默默变插话）；`node --test tests/app-tool.test.js tests/send.test.js tests/ball-bridge.test.js tests/polish.test.js` 74/74；语法检查通过，无 `.pyc`。**排障记录**：测试进程退出时 0xC0000409，用 `git worktree` 拉 HEAD 对照定位到根因——`close_menu` 在缺少 `queue_insert_dialog` 属性的球对象上抛 AttributeError，PyQt 在槽函数里遇未捕获异常会直接 abort；改成 getattr 后退出 0。未做实机验收：新弹窗布局、目标行、排队与插话的真实投递时机。

2026-10-17（捋一捋排队发送）：Python `unittest` 34/34 通过（新增 `test_polish_request_keeps_delivery_timing`：followUp/steer/缺省三种情况在桥上都不丢）；`node --test tests/app-tool.test.js tests/send.test.js` 38/38；`app_bridge.py`、`zhujian_app.py`、`index.js` 语法检查通过，无 `.pyc`。未做桌面实机验收：三个按钮在 344px 宽下的排布、排队成功提示、真排队与插话两种投递时机都没在宿主里实测过。

2026-10-17（目标切换延迟实锤）：Python `unittest` 33/33 通过（轮询间隔断言改为 2000ms）；`zhujian_app.py` 语法解析通过。实证来自 `panel-diag.log`：18:30:26 push（目标=旧）/ 18:30:32 pick（sess_0mvc7z5bx）/ 18:30:35 pick（sess_0mvc6y2hd）/ 18:30:38 push（目标=新，polishBtn 已变），App 日志 18:30:34、18:30:35 两条 `球目标已固定`。结论：链路通，卡在延迟。乐观更新与 2 秒慢速轮询**未实机验收**。

2026-10-17（断联续接依旧无标题的真病根）：`node --test tests/*.test.js` 共 **256/256 通过**（`resume-watch.test.js` 23/23，新增 5 条：只有 UUID 没路径也能落到同一条会话、两套编号登记别名后收尾能清掉账、别名合并保留续接次数、没标题时用开头句当身份证、连开头也没有时用开窗时间）；Python `unittest` 33/33 通过；`index.js`、`lib/resume-watch.js` 语法检查通过；`zhujian_app.py` 内存 `compile()` 通过，未留 `.pyc`。现场取证：从 `app-data/jiegehua-zhiyi/ball-bridge.json` 取球地址与令牌，读 `/resume/state` 得到 `notice.title` 与 `notice.agentName` 均为空字符串、`sessionId` 是裸 UUID `01a14908-bc69-71c9-b629-2b6e8d424530`，而 `session:list` 里同一条会话的稳定编号是 `sess_…`、文件名带同一 UUID——即“两套编号对不上”的直接实证。顺带收紧了卡住复核：名单里查不到时不记账（以前会把“查不到”当成“没进展”直接判卡住，同一条提醒反复弹）。未覆盖：桌面实机未验收（需重载 App 后等一次真实断联；新版抬头文字要新代码写进桥才能看到）。

2026-10-17（二级弹窗目标行、真病根）：Python `unittest` 32/32 通过（新增 `test_recommend_polling_survives_while_only_subpanel_is_open`：主面板收起 + 子弹窗开着时轮询必须仍在跑且间隔 5000ms；都收起时才停）；`test_ask_dialog.py` 8/8；语法解析通过，无 `.pyc`。取证：球进程 17:47:24 启动（晚于 17:32:32 的代码修改），确认跑的是新代码，问题不在版本；`hideEvent → stop_recommend_polling()` 与 `_open_*_panel → close_menu()` 的先后关系是断管原因。未做桌面实机验收。

2026-10-17（二级弹窗目标栏不更新）：Python `unittest` 32/32 通过（新增 `test_voice_force_push_is_one_shot`）；`app_bridge.py`、`zhujian_app.py` 语法解析通过，`index.js` 语法检查通过，无 `.pyc`。现场取证：读 `/recommend/state` 看到 `request.kind=pin`、`push.target.mode=pinned`，日志里也有两条 `球目标已…` 写入记录，说明后台切换是成功的，坏的是弹窗那一层。未覆盖：三个面板的目标行重绘、朗读列表 forcePush 只做了静态检查与桥级单测，**未实机验收**（需重载 App + 重启球后点一次「跟随最近」和「固定某段对话」）。

2026-10-17（捋一捋没效果）：`node --test tests/polish.test.js` 17/17 通过（新增「提示词不再整段退回」「模型原样返回标 unchanged」两条）；Python 31/31；`lib/polish.js`、`index.js`、`python/zhujian_app.py` 语法检查通过。现场取证方式：从 `app-data/jiegehua-zhiyi/ball-bridge.json` 取球地址与令牌，读 `/polish/state` 看到 `result.ok=true / fellBack=false / text 与原文相同 / model=MiniMax M3.1 Flash`。本轮**未重新跑真实润色**（需用户重载 App + 重启球后自测），也未验证改后的提示词在 gpt-6-luna 等模型上是否真能产出可见改写。

2026-10-17（桥链路编号与模型取用全扫）：`node --test` 14 个测试文件共 171/171 通过（ball-bridge 新增「球重启后序号归零，刷新仍生效」「同场景固定目标仍生效」两条，polish 新增 `providerId/modelId` 变体一条）；`python -m unittest discover -s python -p 'test_*.py'` 31/31；`index.js`、`lib/polish.js`、`lib/ball-bridge.js` 语法检查通过，无 `.pyc`。覆盖：序号倒退不吞请求、模型 ref 变体、配置缓存与退避重试的代码路径。未覆盖：`index.js` 里朗读/续接/润色/标题四条定时轮的倒退处理没有自动化用例（需真实球重启才能验），`readConfig` 的退避重试未做失败注入测试；均未做实机验收。

2026-10-17（捋一捋卡在正在捋）：`node --test tests/ask.test.js tests/polish.test.js tests/recommendation.test.js tests/ball.test.js tests/app-tool.test.js tests/suggestions.test.js` 93/93 通过（polish 新增 3 条模型解析用例）；`python -m unittest discover -s python -p 'test_*.py'` 31/31 通过（新增 `test_bridge_result_keeps_local_request_seq`），四个 Python 文件 `ast.parse` 通过，无 `.pyc`。覆盖：桥回包里 App 侧 seq 不得覆盖本地序号、宿主模型列表为数组与对象两种形状都能选到已配置模型、两处未配时返回 null。未做真实模型调用与桌面实机验收：需重启传音樱 + 重载 App 后实测一次润色。

2026-10-17（推荐区「清空」按钮收窄与按需显隐）：`python -m unittest discover -s python -p 'test_ask_dialog.py' -v` 6/6 通过（新增 `test_clear_button_hides_when_there_is_nothing_to_clear`），`python -m unittest discover -s python -p 'test_*.py'` 30/30 通过，四个 Python 文件 `ast.parse` 通过，未留 `.pyc`。覆盖：初始无推荐时不占位、空状态与报错不显示、真渲染出条目才出现且 objectName 为 `clearBtn`、点清空后重新隐藏。未做桌面实机验收：50px 宽度与隐藏后的行内留白需重启传音樱后看真实面板。

2026-10-17（传音樱主视觉更新）：`python -m unittest discover -s python -p 'test_ask_dialog.py' -v` 5/5 通过；`python/zhujian_app.py` 与 `python/test_ask_dialog.py` AST 检查通过。新用例确认透明樱花枝条 PNG 成功加载，并能在离屏透明画布上实际绘出；未做桌面实机视觉、拖动/悬停或 Hana 重载验收，也未跑全量套件。

2026-10-17（推荐回复只留传音樱）：`node --test tests/recommendation-config.test.js tests/app-tool.test.js` 41/41 通过，`node --test tests/voice-routes.test.js tests/style-refine.test.js tests/recommendation.test.js tests/ball.test.js` 51/51 通过，`node --test tests/suggestions.test.js` 6/6 通过，`python -m unittest discover -s python -p 'test_*.py'` 27/27 通过，三个 Python 文件 `ast.parse` 通过。覆盖：旧值 `card` 迁移到传音樱、展示方式只剩两档、卡片专属配置键被丢弃、两个卡片工具确认不再注册、关闭时球面板收到 `enabled: false`。未运行全量套件（ask/card-handoff/card-template/length-summary/ask-model/ask/voice 等未跑）、未安装 App、未实机验证球面板显隐与真实模型调用。

2026-10-11（v0.1.31，速览设置失败保护与边界说明）：`node --check index.js`、`node --check ui/assets/panel.js`、`node --check tests/app-tool.test.js`、`node --check tests/length-summary.test.js` 通过，manifest JSON 可解析；`node --test tests/app-tool.test.js tests/length-summary.test.js` 38/38 通过，覆盖读取失败时锁定设置/重试入口，以及正文恰好达到阈值时会生成速览。未运行全量套件、App Host 安装或实机界面验收。

2026-10-11（v0.1.30，速览设置控件与文案）：`node --check ui/assets/panel.js`、`node --check tests/app-tool.test.js` 通过；`node --test tests/app-tool.test.js` 20/20 通过，新增设置页阈值步进器、自绘模型选择器、失效旧选择与原文保留文案的静态结构断言。未运行全量套件、App Host 安装或实机界面验收。

2026-10-11（v0.1.29，权限状态只读页）：`node --check index.js`、`node --check ui/assets/panel.js`、`node --check ui/assets/permission-status.js`、`node --check tests/app-tool.test.js` 全通过；`node --test tests/app-tool.test.js` 19/19 通过，覆盖权限查询成功/失败、各状态与未知值映射、主设置页及功能面板声明。未运行全量套件、App Host 安装或实机界面验收。

2026-10-11（恢复基线 v0.1.28）：仅运行 Ask、悬浮球、推荐回复三组定向单测，31/31 通过（`node --test tests/ask.test.js tests/ball.test.js tests/recommendation.test.js`）。这是归档源码恢复后的本地单测基线，不是全量测试，也不代表当前 Hana App Host 实机验收；未安装 App、未调用真实模型。

2026-09-29（v0.1.23，速览单独指定模型）：Node 语法检查通过，Node 测试 84/84。实机已定位根因为 `MODEL_TIMEOUT`（`last-summary-error.json` 实录 `timeoutMs: 20000`），即速览借用 Ask 判断模型 `gpt-6-luna` 时 20 秒仍等不到返回。新增 `GET/PUT /summary-model` 与 `POST /summary-model/test`，设置页在「长回复速览」分区加速览模型下拉与连通测试；`resolveSummaryModelRef` 决定优先级（速览模型 > Ask 判断模型 > Hana 当前）。**速览卡片形态实机仍未通过**，需在设置页选一条快模型后重测。已知待办：把已不在列表的旧选择显式提示而不是静默回落。

2026-09-29（v0.1.22，Ask options 字段说明补全）：Node 语法检查通过，Node 测试 82/82。`ASK_TOOL_SCHEMA.options.description` 补上每项的字段结构（`label` 必填、`detail` 可选）。实测确认调用方在参数说明里看不到每项结构时容易猜错字段名。注意：本次排障的直接原因不在本 App——`tool_call` 转发时把嵌套数组变成 object，导致宿主类型校验先于 App 执行报错；改用 JSON 字符串传 `arguments` 即可通过，同一症状在无关的 `gomoku_suggest_move` 上可复现。

2026-09-29（v0.1.21，速览改为引用块小卡）：Node 语法检查通过，Node 测试 82/82。速览不再改写正文，也不再只存归档，而是以引用块小卡的形式追加到**最后一个正文片段末尾**，保证落在全文最后、不插进正文中间；thinking 与工具片段原样保留。新增 `buildSummaryBlock` / `appendSummaryBlock` 及对应断言（多片段正文、字符串正文、无正文返回 null）。实机需重启 Hana 确认渲染效果与原文完整性。

2026-09-29（v0.1.20，长回复速览不再改写正文）：Node 语法检查通过，Node 测试 80/80。`messages/post-assistant` 钩子不再返回改写后的消息，原文在界面与会话历史里完整保留；简写仍由同一模型生成，与原文一同写入 `long-replies` 归档。删除了改写正文的 `replaceBodyText`/`buildRewrittenBody`/`alreadyRewritten` 及其断言，新增归档同时含原文与速览的落盘测试。**卡片形态尚未施工**：简写目前只存在归档里，没有出现在消息下方；实机需重启 Hana 确认长回复正文不再被替换。

2026-09-27（v0.1.18，Ask 选择与执行授权分界）：Node 语法检查通过，Node 测试 50/50、Python 测试 16/16；App 静态校验 0 错误、1 条 `DYNAMIC_DEPENDENCIES_NOT_PROVEN` 提醒。新增单选、多选、自定义选择回包断言：方案选择可用于继续原任务，但 Ask 回答本身不授权执行外部或不可逆操作；仅当缺少针对具体动作与后果的既有明确授权时，才需另行确认。App 源码与全局安装的 `zhiyi-ask` 配方已同步。隔离运行时 smoke 和真实卸载场景实机验收尚未完成。

2026-09-27（v0.1.17，高影响 Ask 与本地 App 更新护栏）：Node 语法检查通过；Node 测试 49/49、Python 测试 16/16；App 静态校验 0 错误、1 条 `DYNAMIC_DEPENDENCIES_NOT_PROVEN` 提醒。新增覆盖检查 Ask 工具说明、系统提示词及参数描述含有高影响动作后果、备份与替代路径要求，并保留 Ask 不构成破坏性动作授权的边界。隔离运行时 smoke 本轮未执行；实机尚未验证卡面文案在真实卸载场景的表现，且不因此授权卸载或重启。

2026-09-27（v0.1.16，Ask 模式显式校验）：Node 语法检查通过，Node 测试 49/49、Python 测试 16/16；App 静态校验 0 错误、1 条 `DYNAMIC_DEPENDENCIES_NOT_PROVEN` 提醒。覆盖按问题语义显式指定模式、漏填模式时拒绝发卡、数量范围校验、多选数组回传、卡片勾选后确认、悬浮球和原生回退；并覆盖预检模型、系统提示词引导、连通测试及既有单选/拒绝/过期边界。运行时 smoke 未完成：本机 Node v24.16.0，验证器要求 Node 26+。2026-09-27 实机复测发现 Ask 回包为 multiple，但全局已安装的 `zhiyi-ask` Recipe 仍是旧单选模板；已同步全局模板与 App 内源码，旧卡不会热更新，需重启 Hana 后新建卡片复验，当前实机多选尚未通过。

2026-09-26（配方卡交接施工中，未升版本）：App 无球分支改为待办登记、配方发卡交接；含来源卡片编号/原会话核对、选项约束、十分钟过期、重复消费拒绝、自定义答案、原生兜底。Node 32/32 全通过，Python 测试及 App 静态校验此前通过。`show_card.template` 无法从 App 自带 `recipes/` 直接发现；已通过 Hana 审核将 `zhiyi-ask` 单独安装到当前伙伴，extension_manager 显示 host=on、agent=on。卡片模板源码语法已验，**正式 Ask 发卡→绑定→点选→新回合核验→续原任务尚未实机完成**。内存中的待办在 App reload 后会安全失效；多伙伴配方启用和分享版双包安装尚待验收。

2026-09-26（消息流入口查证，未施工）：本机 Hana 0.1050.9 公开 SDK 可用 `contributes.messageRenderers` + `session:send-custom` 展示随对话滚动的卡片（hana-app-creator/SKILL.md「contributes.messageRenderers」）；`sdk.userInteraction.ask` 可阻塞工具直到用户回答（同文「sdk.userInteraction.ask」）。两者之间没有公开的卡片点击应答同一 `ask()` 的契约；`hana.emit` 另起 Agent turn，不能直接视为原工具续接。App 当前保持原生确认卡作为无球分支，但其遮挡问题已实机确认，尚未通过体验验收。补充：以上仅限 v2 App `messageRenderers`/原 Ask 的同一次工具调用接口；Hana Interactive Card/Recipe 的 `show_card` 可在聊天消息流中展示，卡内 `window.card.emit` 会把选择送回原会话并唤醒伙伴（本机 `card-guide/guide.md` §2.1；`solan` Recipe 是已落地例子）。这是一条「结束当前轮、点击后新回合继续」的路线，尚未在知意测试；不能宣称它恢复同一次工具 Promise。2026-09-26 实机卡片探针已通过：`show_card` 在当前会话生成「知意 · 配方卡交互试验」，卡片实例 `c_mui9grym_1_xyfl` 经 `ui_inspect` 确认位于原会话消息流、已挂载；用户点「不挡回复」，卡片发出 `zhiyi_recipe_probe`，事件携带相同实例 ID 与探针 ID，唤醒本会话的新一轮回复。此探针不涉及正式知意 Ask，也不证明原工具 Promise 会被恢复。下一步接入前仍需设计 pending Ask 的身份绑定、过期与重复点击护栏。

2026-09-26（原生确认卡试验，尚未完成）：因输入框上方自定义面板遮挡回复，且宿主「拒绝」和「关闭面板」同走 close 并把待答 Ask 结算为 rejected，无球分支已改回 Hana 原生确认卡。Node 测试 27/27 通过；应用重载日志显示新进程已加载，但在同一对话回合内调用工具两次均报 `RPC peer closed; cannot call callback.tools.execute`，均未展示确认卡，也未拿到用户回答。同日新回合重新取得工具入口后，原生确认卡实际弹出；用户选择「仍会挡住回复」，结果完整回到原会话。结论：原生确认卡没有解决遮挡，当前方案未通过布局验收。当前 manifest 仍为 0.1.10，未标记新方案完成。

2026-09-26（v0.1.10）：无球分支新增输入框上方的知意选择卡；Node 语法及 28/28 测试通过，Python 12/12 通过，App 静态校验 0 错误、1 条动态依赖未证明提醒。Hana 重启后首次因新增声明待审核而未加载，完成应用审核后 Ask 工具恢复。真实 Hana 当前对话实机验收：悬浮球未运行时，知意选择卡成功挂载；用户选「显示正常」，补充「好棒诶！」，两项内容完整回到发起调用的原会话。拒绝、超时和跨会话切换的实机行为本轮未单独测。

2026-09-26（v0.1.9）：右键关球菜单离屏 Qt 测试通过；Python 12/12 通过。关闭动作复用现有退出握手；运行中 Hana 的右键点击、进程退出和 Ask 中途关球仍待实机确认。

2026-09-26（v0.1.8）：Node 语法检查通过、测试 27/27 通过；Python 语法解析通过、测试 11/11 通过（含离屏 Qt 弹窗冒烟）。尚未通过运行中 Hana 宿主的真实 Ask 工具调用、弹窗点击及会话续接验收；需要由用户重启 Hana 后再测，静态/离屏结果不能替代实机验收。

2026-09-25（v0.1.7）：Node `--check` 全通过；Node 内置测试 27/27 通过；Python 语法检查通过，标准库测试 9/9 通过。Windows 子进程依据 `USERPROFILE` 恢复正确的 `APPDATA` 用户包目录，并枚举解释器验证 PyQt6/QtSvg；Hana 实机验收待完成。

2026-09-24（v0.1.3）：Node `--check` 全通过；Node 内置测试 25/25 通过；Python 语法检查通过，标准库测试 9/9 通过；官方 App 静态校验 0 错误、1 条 `DYNAMIC_DEPENDENCIES_NOT_PROVEN` 提醒。固定整页入口已通过静态校验；页面实际挂载仍需在 Hana 中验收。

2026-09-24（v0.1.4）：Node `--check` 全通过；Node 内置测试 26/26 通过；Python 语法检查通过，标准库测试 9/9 通过；`py.exe -3` 实测可导入 PyQt6/QtSvg；官方 App 静态校验 0 错误、1 条 `DYNAMIC_DEPENDENCIES_NOT_PROVEN` 提醒。Python 启动器选择逻辑仍待重启后的 Hana 实机确认。

同日 v0.1.4 修复前环境对比：Python 3.14 能导入 PyQt6/QtSvg，uv 管理的 Python 3.12 未安装 PyQt6；使用 Windows Python 启动器 `py.exe -3` 实测可导入 PyQt6/QtSvg。由于 Hana 实际解析到的 Python 路径无法从桌面截图单独确认，v0.1.4 改为优先使用该启动器；还需用户重启后实机复验。

仍未通过真实 Hana App Host 安装验收：`app/process.spawn` 权限审批、`sdk.network.fetch` 到本机回环服务、PyQt6 桌面窗口，以及悬浮球作答是否可靠返回并续接原工具调用，均待实际运行验证。隔离 UI smoke 也未能运行：环境没有独立 Electron 运行时（需设置 `HANA_APP_ELECTRON`）。模拟测试和静态校验不能替代这两项实机验收。
