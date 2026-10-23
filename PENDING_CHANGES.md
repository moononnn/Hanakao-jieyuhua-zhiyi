# 未发布改动

- 2026-10-23 | 新增 | **球上的续接专页能选「这次接几轮」**

  实机反馈：续接专页里只有「继续哈」和「不用管」两个动作，当场想决定「这次接几轮」没有地方选。查代码发现循环续接那套控件（`继续后自动循环` + `最多续接 N 轮`）在 `_build_resume_view` 里被搬进了不显示的 `loop_controls` 容器——功能早就在，入口丢了。

  改法：
  ① 球上：专页加一行「这次接几轮」（1～10 步进，默认 1）。1 轮 = 原行为（只发一句「继续哈」）；N 轮 = 点「继续哈」时把轮数一起发回去，按钮文案随之变成「接 N 轮」。文案与设置页的「每个窗口连续续接上限」刻意区分：这个是一次性动作参数，那个是全局上限。
  ② App 端：`/resume/action` 的 continue 动作认 rounds；rounds>1 时先起循环续接（轮数 = N-1，第一句单独发）、再发第一句；第一句没送出去就把循环收掉，不让它空转。判断抽成纯函数 `planManualResume`（lib/continue-loop.js）便于单测。
  ③ 样式：新控件用实线圆角框（`#resumeRounds`），不用 `toolRow` 的虚线——用户明确不要虚线边框（kc-design-弹窗禁用虚线外框）。专页高度上限从 420 收到 360。

  验证：Python `unittest` 77 通过 / 1 跳过 / 0 失败（新增 2 条：轮数步进上下限与按钮文案、点「继续哈」把轮数带上）；`node --test tests/continue-loop.test.js tests/resume-watch.test.js` 45 通过（新增 2 条：轮数→模式判定、接 N 轮时循环自己发 N-1 句）。**实机验收未做**：重启球后，断点提醒的专页里应出现「这次接几轮」，选 3 轮点「继续哈」，对话里应连着接三轮。manifest 版本、简介、README 未动。

- 2026-10-23 | 修复 | **Ask 弹窗开着时到的断点提醒被整个吞掉（球知道，用户不知道）**

  实机：用「喜鹊」模型造故障（`127.0.0.1:3425` ECONNREFUSED），宿主日志里知意侧「续接用尽，已在传音樱提醒」与「已续接」两行都在，球上却什么都没冒出来。同期球侧有一行「球上提问未作答（rejected）」——那段时间球正开着 Ask。

  病根两处，叠在一起：
  ① `show_resume_strip` 里 `if self.is_ask_open(): return` 直接吞掉这条提醒，而它在 return 之前已经把 `_resume_sig` 更新了。等 Ask 结束、notice 还在时 `is_new` 已是 False，`open_resume_view()` 再也不会被调用——这条提醒永远不会再自己冒出来。
  ② `_sync_resume_entry` 要求「有提醒 且 Ask 没开」才显示入口按钮 → Ask 期间连入口都没有。

  改法：提问期间到的提醒先记进 `_resume_ask_pending_sig`；Ask 一让位（`_set_ask_mode(False)`，延后 250ms，让收面板的收尾动作先跑完，不然刚打开的专页又被顺手收掉）就补：点亮入口 + 打开续接专页 + 把球和面板一起带到眼前（`_raise_resume_panel`：原先散在 `_apply_resume_state` 里的一段，抽出来复用）。用户点过「不用管」的那条不补。

  验证：Python `unittest` 75 通过 / 1 跳过 / 0 失败（新增 2 条：提问期间到达的提醒在提问结束后补上、用户「不用管」的提醒不补）。**实机验收未做**：重启球后，在一个 Ask 开着时制造断点，看 Ask 关掉后提醒是否补弹。manifest 版本、简介、README 未动。

- 2026-10-23 | 移除 | **断点续接的冻结层整个拆掉：设置页直接可见，不再要暗号**（用户：不需要解冻那一套了，做成正常的就行）。

  冻绘是 2026-10-19 两位一起定的：界面藏起、引擎照跑，要连点标题五次再输暗号才露出来。结果就是用户自己都找不到那个开关，只能来问“是不是藏右上角了”。既是自己的工具，这层就没必要了。

  ① 后端：`resumeUiFrozen` 固定为 false（字段留着只为兼容旧前端），`/resume-freeze` 路由连同哈希常量与 `phraseMatches` 一起删除；`RESUME_FROZEN_KEY` 不再读取，旧存储值ignore。
  ② 前端：`panel.js` 的冻结判定、连点五次、暗号提交整段删除，进页就直接 `resumeSettings.load()` + `refreshResumeStatus()`；`panel.html` 去掉 `#resume-section` 的 `hidden` 与整块 `#resume-freeze-gate`。
  ③ 测试跟着产品形态改：`voice-routes.test.js` 那条改成「不再有冻结层，frozen 恒为 false」；`app-tool.test.js` 三条冻结用例并成一条「设置区直接可见，进来就读设置与结果」。

  验证：`node --experimental-vm-modules --test tests/app-tool.test.js tests/voice-routes.test.js` 97/97；`node --test tests/queue-plan.test.js tests/send.test.js tests/resume-watch.test.js tests/continue-loop.test.js tests/session-title.test.js` 79/79；`node --check` 与 Python `ast.parse` 均通过。**实机验收未做**：重载后进设置页，断点续接那一段应该直接就在那儿（总开关、自动续接、最多连续续接几次）。manifest 版本、简介、README 未动。

- 2026-10-23 | 调整 | **断点续接分两处管：设置页管开关与轮数，传音樱只负责「连续几轮都失败了」的提醒**（用户定义：设置页放开关和自动续接几轮；球上只在连续几轮都失败时提醒这个窗口；没开球就不管）。

  球上以前两套都做：既摆开关与轮数加减（自动续接、每个窗口最多连续续接几次），又做失败提醒。同一个值在两个地方能改，改了一边不知道另一边生效没。

  ① 球上不再摆设置：`resume_settings`（自动续接开关 + 每个窗口最多连续续接 N 次）整块收起，注释写明设置已归设置页；控件与同步/步进逻辑全部保留，只是不露面。
  ② 提醒文案改成说人话：「这个窗口连续 N 轮都没接上，已经到设置的 M 轮上限」，下面再接一行具体原因，不再用「提醒原因：」这种抬头。
  ③ 续接页高度从 320～560 收到 260～420：设置搬走后内容少了，再给五百多高就是一片空白。
  ④ 没开传音樱就不提醒——提醒本来就只在球的面板上，不开球自然不会有，本次未另加开关。

  验证：Python `unittest` 73 通过 / 1 跳过 / 0 失败（`test_resume_dialog` / `test_ask_dialog` / `test_queue_panel` / `test_queue_bridge` / `test_queue_receipt`），`ast.parse` 通过，未留 `__pycache__`。其中 `test_resume_dialog` 两条断言按新形态改：文案从「提醒原因」改成「连续 2 轮都没接上」；设置区从「应该在球上可见」改成「不应该在球上露出」，同时保留配置同步与步进的断言。**实机验收未做**：要等一次真的连续失败，看球上那句提醒是不是这个口径、设置页改的轮数是不是真传到了。manifest 版本、简介、README 未动。

- 2026-10-23 | 修复 | **传音樱的 Ask 弹窗：露底、滚动条跑出面、窗口一直抱**（用户实机：右边滚动条不是原来那套风格，窗口一直在抖，关机键不该在每一层弹窗里都有）。

  三个毛病其实是同一个结构造成的：Ask 复用主面板那块展台，但只逐件藏了「推荐 + 几个工具」，后加的**排队发送**和**静候关机**没进名单，于是它们还露在问题下面；面板内容一长，外层主面板也跟着长出一条通到底的滚动条（就是截图里那根，不是 Ask 自己那层）；两层滚动区 + 外层按内容重算高度（`_fit_to_content`）与 Ask 自己那套（`_settle_ask_height`）交替跑，看起来就是窗口一直在抽。

  改法：
  ① 进 Ask 模式时把 `queue_tool`（排队发送）和 `sleep_tool`（静候关机）一起收起来，答完再放回；关机键从此只在一级面板。
  ② Ask 那层不让外层（主面板）长滚动条：要滚就 Ask 自己那层滚，不再出现一条通到底的粗条。
  ③ 滚动区不再预先吃满 `max_height-124`（内容少时就是一大片空白配一条长条），改成跟着内容长：内容少就贴合，超过上限才封顶并在里面滚，不需要滚时直接关掉滚动条（不让它反复现身/消失把高度带得来回跳）。
  ④ 面板高度下限从 440 收到 300，内容少时不再空一大块。

  验证：Python `unittest` 47 通过 / 0 失败（`test_ask_dialog` / `test_queue_panel` / `test_queue_bridge` / `test_queue_receipt`），`ast.parse` 通过，未留 `__pycache__`。改动前备份：`L:\哈娜的工作台\_插件备份\知意_2026-10-23_092503_ask弹窗修格式前`。**实机验收未做**：重开一道 Ask 看①底下是不是只剩问题与选项、②右边不再有通到底的长条、③窗口不再抱。manifest 版本、简介、README 未动。

- 2026-10-23 | 修复 | **排队发送：排 2 轮只发 1 轮 + 面板弹假红字，两个病根一起拔**（用户实机：设置两轮，还是只发了一轮；面板还刷一句「排的那句没发出去」）。

  实机取证（宿主日志 `2026-10-23_07-01-55.log`）：07:57:42 建单成功、第一句发出；之后到 07:59:24 之间**一次都没出现「已送出第 2/2 轮」**，只反复出现「排队话单兜底：按唯一在跑的话单认了对话」，最后 07:59:24 一句「排队话单没被接走，话单已停」。

  ① **轮末拿不到话单，静默 return**——真正的病根。轮末钩子用 `invocation.session.sessionId` 去 `queuePlans.get()` 取账，而球上给的是另一套编号（文件名式 UUID），两边对不上就直接 `return null`，什么都不发也不记日志。那句「按唯一在跑兜底」反复刷，就是编号对不上的直接证据。
  ② **pending 只能靠钩子清，钩子一丢就永远清不掉**——90 秒后被定时器判成「没被接走」，面板弹出假红字（那句话其实早就送到了）。

  改法：**不再让 App 去猜「宿主有没有把我这句接走」**。
  · `pumpQueue()` 自己盯会话忙闲（`session:context` 的 `isStreaming` / `pendingMessageCount`）：ta 这轮说完了、也过了 4 秒冷却，就把下一句 `steer` 直发进去；说完一句等 ta 回，回完再送下一句。
  · 2 秒心跳（`queueBridgeTimer`）+ 轮末钩子 + `turn_end` 三处都只喊 `pumpQueue`，钩子丢了心跳还在；死掉的那条路自己会回来。
  · 建单时先把会话编号归一成 `sess_xxx`（`normalizeQueueSessionId`）；万一还对不上，`QueuePlanRegistry.resolve()` 按「唯一在跑」兜底，但**不再拿它去误停话单**。
  · 删掉 90 秒 `pending` 判死；删掉 `followUp` 排队语义（那种语义要宿主那轮结束才发，而 App 又看不见它什么时候结束）。
  · 忙闲查不到（编号不对/RPC 撞上限）时不再当「忙」死等，改成至少隔 20 秒再发，既不卡死也不插话。

  验证：`node --test tests/queue-plan.test.js` 18/18（新增 2 条：编号对不上时按唯一在跑兜底、两份在跑不乱认；`peekText` 与 `nextText` 的区别），`tests/send.test.js` 6/6，`node --check index.js lib/queue-plan.js` 通过。改动前备份：`L:\哈娜的工作台\_插件备份\知意_2026-10-23_085914_排队发送重做前`。**实机验收未做**：重载后排 2 轮，看能不能自己把第二轮送出去、面板轮数是不是跟着走、说完最后一句之后有没有「排的都发完了」。manifest 版本、简介、README 未动。

- 2026-10-22 | 修复 | **断点续接每 20 秒拉一次全量会话名单，把宿主的事件循环吊在自己身上**（系统性问题：今天 1136 次「App RPC concurrency limit reached」，两个 App 的钩子被丢，排队发送接不上、续接提醒丢信号，一半毛病都从这儿长出来）。

  实机取证：宿主日志一天打印 `sessions_list_timing` **3994 次**（几乎就是 86400/20 秒），每次 `sessionCount` 都在 326~342，单次 `listMs` 三四百毫秒、偶尔 3~5.8 秒，`eventLoopDelayMaxMs` 同时到 4123ms。原因就一处：`readResumeSessionIndex` 的缓存期是 20 秒，而 `resolveResumeTarget` 几乎每条会话事件都要走一次，于是只要 App 常驻、只要还有事件在流，就精确地每 20 秒拉一次全量名单。而这正是宿主最慢的那条路（三百多个会话一条条列），拉的时候事件循环一起等，钩子在后面排队堆到 App RPC 的 128 并发上限，被拒的那条直接当「没有决策」。

  改法（四条，都是「别问不该问的」，没有新增保险）：
  ① **只列活跃会话**：`lifecycle: "all"` → `"active"`。断点续接认的是「正在聊的那几段」，归档会话本来就不该参与（真要查归档，那也不是这一层的事）。单次开销跟着会话总数一起掉。
  ② **缓存期 20 秒 → 5 分钟**，同一时刻只飞一个请求（并发调用共享结果），读失败退回 20 秒节流后再试（不停跳，也不添乱）。
  ③ **复核的强制刷新也上节流**：卡住复核每 5 秒跑一次，以前每次都 `force`，等于绕着缓存把频率拉回来；现在 force 最短 20 秒一次。
  ④ **事件里的编号已经能对上时，根本不问宿主**：新增 `resolveResumeTargetLite`，`turn_end` 三处（循环续接兜底、排队兜底、恢复分支）改走它。钩子那一层同时握着 `sessionId` 和 `path`，是全流程唯一不必问宿主就能建映射的地方，所以顺手在 `agent/before-start` 里登记（`resumePathAlias`，内存表，400 条封顶）。之后同一段对话的轮末事件直接命中本地映射，零 RPC。

  验证：`node --test tests/app-tool.test.js` 50/50（新增 2 条钉住：① 只列 active、编号对上就不再拉；② 强制刷新有节流），`tests/resume-watch.test.js tests/continue-loop.test.js tests/send.test.js tests/queue-plan.test.js tests/session-title.test.js tests/voice-routes.test.js` 110/110，`node --check index.js` 通过。**实机验收未做**：重载后看宿主日志里 `sessions_list_timing` 的频率与 `sessionCount` 是不是都掉下来了（预期频率从 20 秒一次变成 5 分钟一次，sessionCount 从 342 变成活跃会话数）。manifest 版本、简介、README 未动。

- 2026-10-22 | 修复 | **排队发送：第二轮接不上 + 明明排上了却报「知意那边没回话」**（用户实机：排 2 轮只发了一轮，弹窗报知意没回话）。经审查伙伴复核后定稿。

  实机证据：宿主日志 20:37:51.489「排队话单已开始：共 2 轮，第一句已直接发出」——第一轮确实发进去了；之后 20 分钟再没有「已送出第 2/2 轮」，话单在桥里一直卡着 `done=1/total=2/running`；球上弹窗报的是「知意那边没回话，再点一次试试」。

  ① **回包少了 `ok` 字段**（假报错的根因）：App 推给球的话单状态里没带 `ok`，球那边拿到回包先看 `ok`，没有就一律当成「没排上」——所以明明排上了，弹窗里也报一句假报错。改法：App 的 `pushQueueState` 带上 `ok/error`；球那边再加一道兜底（没带 `ok` 但有文字就按成功算）。
  ② **我们自己的话被当成用户插话**（“只发一轮”的头号嫌疑）：`agent/before-start` 钩子靠 `sentTexts` 认「这是我们发的那句」，而 `sentTexts` 是在 `markFired` 里写的，`markFired` 又排在 `await sendToConversation` **之后**。steer 会立刻起轮，宿主在发送回包回来之前就可能跑钩子——那时 `sentTexts` 还是空，钩子判成用户插话，整份话单当场被停。改法：新增 `QueuePlanRegistry.markSending()`，**发之前**就把这句记成我们自己的（记下不占轮数）。
  ③ **轮末信号会整轮丢掉**：轮末判定挂在 `messages/post-assistant` 钩子上，宿主对 App RPC 有并发上限，撞上限时整条钩子被丢弃（今天 1136 次「adjudicator threw: App RPC concurrency limit reached」，20 点那一个小时 543 次，连那一轮回复的每次 post-assistant 判定全被丢）。`turn_end` 兜底那条路又要靠 `session:list` 认会话，认不出就静默作罢。改法：① 钩子里排队判定**挪到最前面**并单独包 try/catch（logger 自己也走 RPC，撞上限时它自己会抛，早先一句 `await logger.warn` 一抛，整条话单的收尾就跟着没了）；② `turn_end` 兜底认不出会话时，只有一份话单在跑就按它认（事件给文件名、话单记 `sess_xxx`，两套编号对不上时最容易在这儿空转）；③ 日志包一层 `safeLog`，日志挂了不影响正事。
  ④ **回执认得太松**：球原来只看「状态序号涨没涨」，会把别的请求推来的状态当成自己的回执；等满 25 秒就报没回话。改法：App 每次推状态都带上当前请求号，球只认 `requestSeq` 对得上自己的那次（对不上就绝不认，哪怕序号涨了）；状态里没带号时才退回看序号，且**预读失败时不启用**这条粗判据（那时基线是 0，条件恒真）；25 秒到了再做一次最终确认，确认到就不报失败。球侧另加 `queue-send` / `queue-receipt` / `queue-timeout` 三条排障记录，下次再出问题看 `panel-diag.log` 就有实证。
  ⑤ **发送失败的处理**：早先一发失败就把整份话单停掉，而宿主 RPC 撞上限时失败是常事。改法：**超时是“说不准”**（可能已经送到，只是回包没回来）→ 不赌，不重发，如实停掉并说明；**其余错误（限流、busy、没权限）= 明确没送出去** → 5 秒后自己重试，连续 3 次才停。第一句也走同一套（明确失败重试一次，超时不重试）。
  ⑥ 去重与互斥按会话记（`queueFiring` / `queueDecidedAt`）：全局记会让两段对话挨着结束时互相挡掉。同一段对话上再排一份时，旧的那份会明确停掉并告知，不再静默顶掉。

  **被审查伙伴否掉的一处**（写在这里是因为它反着更值得记）：先前加过一个「自愈看门狗」——按“ta 连续闲够 8 秒、自己空够 12 秒”自己补发下一轮。审查后删了：忙闲只能**猜**“ta 说完了没有”，而 busy=false 同时对应“ta 说完了”和“我们刚把话塞进去、ta 还没起跑”两种状态；一旦判错就是当着 ta 的面插一句，而且工具调用中间段也会短暂不忙，容易误发。判据要从「猜”改成“事实”（比如读会话时间线看 ta 答没答），那是下一版的事。这一版的自愈靠三条路：钩子（挪到最前 + 各自包 try/catch）、turn_end 兜底（认不出就按唯一在跑的话单认）、明确失败后的重试。

  验证：`node --test tests/queue-plan.test.js` 16/16（新增 3 条“发之前就记下我们的话”）；`node --experimental-vm-modules --test tests/app-tool.test.js` 64/64；`node --test tests/continue-loop.test.js tests/send.test.js tests/resume-watch.test.js` 49/49；`cd python && python -m unittest test_queue_receipt test_queue_panel test_queue_bridge` 23 通过 / 0 失败（新增 `test_queue_receipt.py` 8 条 + 面板 2 条）；`node --check index.js lib/queue-plan.js tests/queue-plan.test.js` 通过，未留 `.pyc`。**仍未实机验收**：要看的就是那两条——① 排 2 轮时第二轮能不能自己接上（看球上「排队中 第 n/N 轮」会不会动）；② 弹窗里显示的是不是「已发出，ta 这轮说完就接下一句」而不是那句假报错。manifest 版本、简介、README 未动。

- 2026-10-22 | 新功能 | **排队发送：写一句或一串话，等 ta 说完这一轮再送进去；一串话就一轮一句往下推**（用户：把旧版「写一句」弹窗借形加回来，再加一串话逐条发）。

  ① 球上主面板多了一行「排队发送」+「排队」按钮，打开独立二级弹窗（借旧版「写一句」弹窗的形：标题 / 发送到 / 输入框 / 取消 · 就这么发）。输入框改成多行（一行一句），多出一行「每句排 N 轮」（1~50，默认 1）。弹窗里能看见排到第几轮，也能随手「停」。
  ② 新模块 `lib/queue-plan.js`：话单状态机。一份话单 = 一串话按轮次往下送（`items` + 游标 + 已发轮数 + 状态 running/finished/stopped）。`buildQueueItems` 负责归一化：去空行、限 50 轮、限 20 句、限单句 500 字。
  ③ App 侧：球上的请求走新桥通道 `/queue/request`（球→App）、`/queue/state`（两边都读）、`/queue/push`（App→球）。**第一发按 ta 在不在回话来选**：还在回话 → `followUp`（排队等这轮结束）；已经说完了 → `steer`（直接发，把新回合拉起来）。之后每一轮都在轮末用 `steer` 发——排队语义挂在空闲会话上会等一个永远不会来的轮次结束，表现就是「点了没反应」。
  ④ 停止条件四条：发满 / 球上点「停」/ 用户在同一段对话自己开口（人优先，不跟人抢麦；误判方向单向，最坏是没停）/ 会话被中止或被关（宿主会清掉排队中的输入 → 回执告诉用户「排的那句没发出去」）。
  ⑤ 状态可见：主面板状态行「排队中 第 2/5 轮」+「停」；不在面板上时也能看见、也能停。
  ⑥ 与「循环续接」互斥：同一段对话上只留一样，开始一方会把另一方停掉。
  ⑦ **没有直接捡回旧版那套**（`lib/queue-loop.js` + `QueueInsertDialog`）：旧版只能「同一句 × N 轮」，这次要「一串话逐条发」，结构多了一层；而且旧版轮末走 `followUp`，那正是「点了没反应」的来源。借的是形，不是实现。
  ⑧ 已知代价：这版是内存态，App 重载后话单会丢（界面上没写「重载会丢」，这一条要等实机看过再决定要不要补文案）；落盘持久化留到下一版。

  验证：`node --test tests/queue-plan.test.js` 13/13；`node --test tests/continue-loop.test.js tests/send.test.js` 26/26；`node --experimental-vm-modules --test tests/app-tool.test.js` 64/64；`cd python && python -m unittest test_ask_dialog test_resume_dialog test_app_bridge test_queue_bridge` 102 通过 / 0 失败（1 跳过，新增 8 条桥端点用例）；`node --check index.js lib/queue-plan.js tests/queue-plan.test.js` 与两个 `.py` 的 AST 均通过，未留 `.pyc`。**未实机验收**：见下面验收清单。App 已重载；传音樱进程当时正好被关掉（见日志「传音樱用户关闭（0）」），需要手动再开一次才能试。manifest 版本、简介、README 未动。

  **要她实机验收的六条**：① ta 正在回话时点「排队」写一句 → 那句等 ta 这轮说完才出现，不打断；② 排同一句 3 轮 → 发满 3 次自停，球上计数对得上；③ 排一串 3 句 → 一轮一句，不挤在同一轮里；④ 排队中自己在聊天框说话 → 话单立刻停；⑤ 排队中把那段对话关掉 → 有「没发出去」的回执；⑥ 排队中重载 App → 确认行为与文案一致（这版是内存态，重载会丢）。

  **实机反馈后修的三处（都在同一个弹窗上）**：
  ① 整个窗看着半透明 → 原因是这个窗开了透明背景属性，而背景色写在样式表里：透明窗口上样式表的 background 画不实。改成像「理顺」窗/「压缩档案」窗同款：样式表改成 `background: transparent`，实底与圆角描边由 `paintEvent` 自己画（阴影 + 不透明底色）。
  ② 鼠标进出不判定（不判定就过一会儿直接变半透明）→ 漏了 `enterEvent` / `leaveEvent`：只调了 `setup_fade_on_leave()`，没把「鼠标进来恢复实体 / 离开排期淡出」接上。补上后与其他弹窗一致：在面板上实体，离开一会儿才半透明，移回来立刻恢复。
  ③ 接上②之后又不淡了 → `_fade_allowed` 里那条「输入框有焦点就不淡出」把离开时的淡出挡掉了（输入框开窗就自动获焦，等于永远不淡）。按她要的行为改成：进出只看鼠标位置，输入框有没有焦点不作数；只有「正在发送」期间不淡（那一刻要盯着回执）。
  新增 `python/test_queue_panel.py` 5 条，把这三条行为钉住（开窗是实的 / 移出排期淡出 / 移回立刻恢复且排期撤掉 / 焦点不作数 / 发送中不淡）。

- 2026-10-22 | 优化 | **输入框面板改成「推荐回复 / 小工具 / 帮我理顺」三页签：小工具收小动作，朗读降成二级**（用户：把朗读页做成「常用小功能汇总页」，页面重命名也放进去；理顺页改名「帮我理顺」，工具页放在理顺页右边；编辑常用仍属推荐回复页，不许挪走）。

  ① `ui/suggest-panel.html`：页签从三个变三个但成员换了——`推荐回复 / 小工具 / 帮我理顺`。**朗读不再是页签**，它变成小工具页里的一格。头部那排只剩「编辑常用」（本来就只在推荐页出现）与「收起」；「起名」从头部搬进小工具页，改名「重新命名标题」。
  ② 小工具页是入口格（`tools-grid`，两列网格）：「重新命名标题」（就地跑，写回面板所在那段对话，结果行带「还原」）与「朗读」。以后想到新功能，往这页加一格就行。
  ③ 朗读降为二级：点「朗读」进列表（列表 → 播放器两层不变），列表页顶上多一条「← 小工具」，退路留全；播放器里原有的「返回列表」不变。切走小工具页照旧停音频、收起草稿。
  ④ `ui/assets/suggest-panel.js`：页签驱动表从 `recommend / voice / polish` 改成 `recommend / tools / polish`；新增 `showToolsView(sub)` 管小工具页的两层（grid / voice）与高度（格子页 240、列表 460、播放器 560）。起名那格是复合结构，改字改成 `setRenameState()` 改 `rename-hint` 那行小字，不再拿 `textContent` 覆整格（会把图标和标题一起抹掉）。
  ⑤ `ui/assets/suggest-panel.css`：新增 `.tools-grid` / `.tool-tile` / `.tool-tile-mark` / `.tool-tile-label` / `.tool-tile-hint`；「返回小工具」自己占一行，不跟标题挤着。
  ⑥ 「理顺」页签文案改成「帮我理顺」，页内引导句一并改（单说「理顺」看不出点完会得到什么）。

  **没动的**：编辑常用仍只在推荐页出现；传音樱（球）那一套完全没碰；`/suggest-panel/rename`、`/voice/*` 后端路由没动；manifest 版本、简介、README 未动。

  代价（说清楚）：朗读从一级页签降成小工具页里的二级入口，比以前多一次点击（她已拍板要这个摆法）；起名从头部一步变成「小工具 → 点格子」两步（起名低频，这个代价可接受）。

  验证：见 TESTING.md 同日条目。**未实机验收**：真实面板里的手感（小工具页高度、朗读子页返回、起名结果行）、宿主重载后 iframe 是否拿到新的 HTML。manifest 版本、简介、README 未动。

- 2026-10-22 | 新功能 | **输入框面板头部加「起名」：不用开传音樱也能给当前对话起名**（用户：给知意的输入框快捷按钮加上重新命名对话的功能，问放哪儿合适）。

  以前起名只在传音樱球上（面板 →「会话标题」那张卡片行），球没开就是空的；而且球上得先选「要作用于哪段对话」。这次搬到面板头部：

  ① `ui/suggest-panel.html`：头那排加「起名」，排在「编辑常用」前、「收起」后；头下面加一行结果行 `slug-note`。不新开页签（页签是按「要干什么活」分的，起名是一次点击，做成第四页只有两个按钮、还把三等宽挤成四等宽）。
  ② `index.js`：新增 `POST /suggest-panel/rename`，只改面板报上来的那段会话编号，**不走**「最近活跃那段」——面板就杵在某个窗口上，拿最近的去改名是最烦人的一种错。旧标题先读出来交给写入方，供「还原」。
  ③ `ui/assets/suggest-panel.js`：点下去立刻变「起名中…」并禁用；成功写「已改为：xxx」+「还原」小字，兜底加「（兜底）」不装正常；失败红字一行；换会话时清掉（那名字说的是别的窗口）。
  ④ `lib/suggest-panel.js`：`estimatePanelHeight` 基数 90 → 110，把结果行算进去，免得它一出现就多一条滚动条。
  ⑤ 顺手修的真 bug：`applySessionTitle` 的记账条件写反了（`previousTitle === undefined` 才记，而两个真入口——球和面板——永远都会传旧标题），所以 `titleUndo` 一条也写不进去，两边「还原」都报「这段对话没有改过标题」。改成无条件记账，旧标题没读到就记 null。

  验证：见 TESTING.md 同日条目（app-tool 64、session-title 12、suggest-panel-ui 6，合跑 151 全过）。**未实机验收**：头部三个小字按钮在窄面板下跟品牌名挤不挤（已给品牌名加 `min-width:0` + 省略号兜底）、结果行出现时的高度、真实模型起的名字是否用得。manifest 版本、简介、README 未动。

- 2026-10-22 | 新功能 | **输入框面板加第三个页签「理顺」：把传音樱的「把话理顺」搬进聊天输入框上方的知意面板**（用户：给知意的输入框快捷按钮加上整理润色，做成独立面板，传音樱那套搬过来就行）。

  传音樱那边本来就有完整的「把话理顺」二级弹窗（写下糙话 → 理顺 → 结果可改 → 排队/插话发送），但它只在桌面悬浮球里；聊天输入框上方的知意面板当时只有「推荐回复」「朗读」两页。这次把理顺搬进同一块面板，成了第三个页签：

  ① `ui/suggest-panel.html`：页签从两个变三个（`推荐回复 / 朗读 / 理顺`），理顺页有独立的多行输入框、可选补充要求、候选方向区，以及「理顺 / 排队发给 ta / 现在就发」三个按钮。
  ② `ui/assets/suggest-panel.js`：页签切换从二元改成 `PANEL_PAGES` 列表驱动，三页共用一套显隐与高度逻辑；理顺走现成后端：`POST /polish` 理顺、`POST /polish/suggest` 给「还能往哪儿改」的候选方向、`POST /send` 发送（`followUp` 排队 / `steer` 插话，带当前会话编号）。
  ③ 迭代锚点：框里还是上一版结果就算「在上一版上改」（带 `previous` + 最初原话 `source`）；用户自己动过输入框就当新原话（两个锚点都不传），这样后端的安全兜底才拦得住「越捋越不像本人」。
  ④ 状态话术分三种：安全兜底退回、原文本来就清楚没改、理顺好了。退回和「没改」都明说，不装成成功。
  ⑤ 换会话时理顺草稿、候选方向、发送按钮一起清空（那句话是写给上一段 ta 的）。
  ⑥ 新增 `ui/assets/polish-draft.js` 放纯逻辑（请求怎么拼、回包怎么说、候选方向怎么过滤），好测；新增 `tests/polish-panel.test.js` 7 条。

  中途我多手多脚：还给输入栏单开了一个 🪄「知意·把话理顺」按钮（manifest 第二条 inputStatus + 工具 `jiegehua.zhiyi_polish` + 面板状态里的 `startPage`），理由是「理顺不该被推荐回复的开关连坐」。实机被她否了——输入栏那一排变成四个小图标，还跟表情包的 🪄 撞了同一个图标，杵两下更乱。已撤干净：manifest 第二条 inputStatus、工具注册、`lib/suggest-panel.js` 的 `startPage` 字段与两个导出、`/suggest-panel/state` 的 `startPage`、前端 `load()` 的读 `startPage` 全删；测试改成反向断言（输入栏只能有一个知意按钮，不得再出现 `jiegehua.zhiyi_polish` 与 `startPage`）。**理顺只当面板里的第三个页签，不另起按钮。**

  代价（说清楚，不装作没有）：理顺现在只在 🌸 面板里，而 🌸 的显隐跟着设置页「推荐回复」的开关走——推荐关掉了，🌸 整个隐藏，理顺也就进不去了。要不要给理顺单独入口，等她拍板。

  验证：`node --test tests/polish-panel.test.js tests/suggest-panel.test.js tests/suggest-panel-ui.test.js` 22/22；`node --test tests/polish.test.js` 7/7；`node --experimental-vm-modules --test tests/app-tool.test.js` 63/63；`node --check index.js ui/assets/suggest-panel.js ui/assets/polish-draft.js` 与 manifest JSON 解析通过。改前备份：`L:\哈娜的工作台\_插件备份\知意_2026-10-22_125144_输入框面板加理顺页前`。**未实机验收**：面板上理顺页的实际观感、真实模型调用出的理顺结果、两个发送按钮是否真的落进当前对话、输入栏是不是真的回到两个图标（宿主可能缓存旧贡献，重载后需她看一眼）。manifest 版本、简介、README 未动。

- 2026-10-22 | 新功能 | **传音樱的朗读窗也能改稿：不想读的段落删掉再念**（用户：传音樱也做相同的优化）。

  球上本来就是「选中回复 → 预览文字 → 按朗读才合成」，所以这边只补了缺的那一半：

  ① 文字区上方多一行：左边字数、右边「改稿」/「还原原文」。点「改稿」切到 `QPlainTextEdit`（只读态还是原来的 `QLabel`，逐词点亮靠它的富文本，不能换成输入框）。删完点「保存改稿」回到展示态，字数实时跟着变，删空不许保存。
  ② 稿子变了就把 `_last_read` 清掉，否则再按播放还是旧的那一版。
  ③ 朗读时如果改过稿，`POST /voice/select` 带上 `text`；桥存进 `selectedText`，App 走 `speakByEntry({ text, draft: true })`，不再拿 entryId 去拼原文。
  ④ 长回复：球的列表也只带 1200 字，所以新增一对 `POST /voice/text-request` / `/voice/text-result`：点「改稿」时如果这条被截断，就按 request/result 对向 App 要全文（App 用 `readFullReplyText()` 回来），拿回后只替换稿子、不盖她已改的内容。
  ⑤ 改稿走文字通道时 `speakByEntry` 会把原 `entryId` 回填进回执：球靠它认领结果，否则永远等不到回包。

  验证：Python `unittest` 94 通过 / 0 失败（1 跳过，新增两条：稿子随选择上报、全文请求/结果按序号收）；JS `ball-bridge` / `ball` / `voice-routes` 69 通过 / 0 失败；`ast.parse`、`node --check index.js` 通过，未留 `.pyc`。App 已重载。**需重启传音樱（Python 进程）后实机验收**：改稿删两段 → 字数跟着变 → 按朗读念的是删完那版。manifest 版本、简介、README 未动。

- 2026-10-22 | 新功能 | **朗读页改成「先看稿再决定念什么」，不想读的段落直接删**（用户提的：列表按钮别叫朗读，点进去只是看；首尾不要的段自己删）。

  以前的毛病：列表上一点「朗读」就直接合成，等于一点就花钱，而且只能整条念。现在：

  ① 列表按钮改名「查看」，`openReply()` 只打开阅读页并渲染正文，**一次合成请求都不发**。
  ② 进页后主按钮是「朗读这篇」，按了才合成（没改稿就走 `entryIds` 念整轮原文，改过就走文字通道）。
  ③ 新增「改稿」：切到编辑盒（textarea）随便删，字数实时更新，删空则禁用朗读；「保存改稿」回到带逐词点亮的阅读态，「还原原文」一键回去。稿子只影响本次朗读，不动聊天记录，关面板即丢。
  ④ 长回复必备：列表里的 `text` 只带前 1200 字（桥的 64KB 上限），所以新增 `GET /voice/reply-text` 取整轮全文（`readFullReplyText()`），进页时异步补上；她若已动手改就不覆盖。否则长回复删完保存会把后半截默默丢掉。
  ⑤ 改过的稿子走 `speakByEntry({ draft: true })` → `prepareDraftText()`：**不再套**「只念引号」与 `maxChars`，否则她辛辛苦苦删到刚好，又被默默截一刀。只清掩码与空白，留一道 10000 字防呆上限。

  验证：定向 `voice-routes` / `suggest-panel-ui` / `voice` / `voice-reader` 60 通过 / 0 失败（新增三条：列表叫「查看」且不再直接合成、改稿走 `draft:true`、全文接口不受 1200 字限制）；改动文件 `node --check` 全过。App 已重载。需玥儿实机验收：点「查看」→ 应停在稿子上不花钱；删几段 → 字数跟着变 → 「朗读这篇」念的是删完的版本。manifest 版本、简介、README 未动。

- 2026-10-22 | 修复 | **传音樱切了窗口，朗读窗还是旧文字**（用户：切换窗口后文字还是之前旧版的，刷新也不行）。

  四个毛病叠在一起：

  ① **刷新不带强制重推**：球点「↻ 刷新」只报 `readOpen`，不报 `forcePush`，App 侧那份 60 秒推送缓存就装死，球一直读着上一段对话的列表。现在 worker 一开始就报 `forcePush: True`。
  ② **强制信号被球自己吃掉**：`forcePush` 以前是「读到即清」的布尔，而球自己也 GET 同一个接口（开窗、刷新都要读），常常抢在 App 前面把它消费掉，App 根本看不到。改成 `forcePushAt` 时间戳，谁读都不清，App 按「比上次大」判定（`voiceBridgeState.lastForcePushAt`）。`python/test_app_bridge.py` 那条旧断言一并改成新语义。
  ③ **文字区不撒手**：列表拿空/读取失败时 `_show_selected_preview()` 直接 return，旧的预览字就留在那里，看着像「刷新没反应」。现在列表空了就清空文字区；切目标也不再只重拉、还带上 `reset_read`。
  ④ **不校会话就算数**：固定了目标时，拿到列表还要对一下 `sessionId`，对不上就说「新目标的回复列表还没推上来」，不把别的窗口的字摆出来。

  顺手把切目标时那个另开线程 poke `forcePush` 的支线删了——refresh 自己已带 forcePush，两边抢着读同一个接口只会互相坏。

  另外朗读文字区的滚动条换成 UI 偏好那套细薄荷条（宽 8px、轨道透明、`#c9dfd3` 圆角、hover 变主题主色），并收进 `apply_theme()` 的 QSS，跟其他面板一致；不再在控件上另设一份 `setStyleSheet`。

  验证：Python `unittest` 92 通过 / 0 失败（1 跳过）；`node --check index.js`、`ball-bridge` / `voice-routes` / `voice` / `suggest-panel-ui` 71 通过 / 0 失败；`ast.parse` 与 `git diff --check` 通过，未留 `.pyc`。**需重载 App + 重启传音樱（Python 进程）后实机验收**：切窗口→文字区应先清空再出新内容；点刷新→列表跟着变。manifest 版本、简介、README 未动。

- 2026-10-22 | 修复 | **朗读列表的「最新」标记真的错位了**（用户：标着「最新」那条不是最新回复，最新的一条根本看不到）。

  前一版把「最新」硬编码在数组最后一条上（`index === items.length - 1`）。那是「旧 → 新」时代留下的假设：`listSpeakableReplies()` 改成从后往前收、最近的排在数组第一位以后，写死的下标就指到了**最旧**那一轮。列表最上面那条其实是最新的，但它不带标记，反而最底下那条旧的顶着「最新」。上一轮把它当成「面板挂错窗口」是误判，这里修正。

  两处都改：① `lib/voice-replies.js` 每条回复自己带 `isLatest`（第一个收进来的就是最新），前端只认这个字段，不再按数组下标猜；② `python/zhujian_app.py` 的传音樱朗读窗以前把 App 推来的列表 `reversed()` 一次（因为当时 App 推的是旧→新），现在 App 推的是最新在前，这个反转会把最旧蹦到「最新回复」的位上——已去掉。

  验证：定向 `voice-routes` / `suggest-panel-ui` 35 通过 / 0 失败（新增两条：后端 `isLatest` 只有一条为真；前端不得再出现 `items.length - 1 ? '最新`）；`node --check` 三个改动 JS 与 `ast.parse` 解析 `zhujian_app.py` 均通过。App 已重载。需玥儿在朗读页刷新看最上面那条是不是真的最后一条回复。manifest 版本、简介、README 未动。

- 2026-10-22 | 调整 | **朗读列表写明读的是哪段对话**（用户：列表里那条标着「最新」的，内容却是昨天另一段对话里的）。

  这不是列表坏了：输入框面板读的是「面板所在的窗口」那段对话，截图里那三条正是昨天那个窗口（讲 CSP 与 SVG hidden 那段）的最后三轮，顺序和内容都对得上——面板挂在哪个窗口的输入栏，就读哪个窗口。

  为了以后不用猜，朗读列表页现在直接把窗口名写出来：「读的是「xxx」这段对话。」；后端日志也记上会话编号与窗口名（`朗读列表统计：会话 … / 窗口名 … / 读到 N 条消息 / 列出 N 轮`）。若面板没绑到具体对话，那行会写「读的是这个窗口的对话」，此时列表读的是最近活跃的那段。

  验证：定向 `suggest-panel-ui` / `voice-routes` 34 通过 / 0 失败；`node --check` 与本轮 `git diff --check` 通过。App 已重载。

- 2026-10-22 | 修复 | **朗读列表按「一轮」列出，最新的在最上面**（用户：列表里看不到最新回复，还看到同一轮被切开的碎片）。

  病根两个。① 顺序：列表是「从后往前收集再 reverse」，等于把最新的排到了最后面——所以看着像「只显示很早以前的」。② 切分：一轮回复里我常常分几次说话（先给方案 → 工具跑完再补一句 → 收尾），宿主历史里每段是独立一条消息，逐条列出来就是一屏碎片。

  改法：`lib/voice-replies.js` 的 `listSpeakableReplies()` 改为按轮聚合——以「你的话」为界，你的话之后、下一次你的话之前的全部回复算一轮，一轮只列一条，条目里带 `entryIds`（这一轮的全量编号）。`resolveSpeakTarget()` 接受 `entryIds` 数组，按顺序把各段正文接起来念；单条 `entryId` 仍然支持（传音樱那边按单条走）。`/voice/speak` 透传 `entryIds`，输入框面板合成时整轮一起传。

  顺带修了一个自己踩的坑：`entryIds` 传空数组时会把 `entryId` 也吃掉，导致「认不出回复编号」变成「没说要念哪一句」——现在空列表回落到单个编号。

  另外本地会话文件实测：这段对话最近 400 条 entry 里，能念的 assistant 正文有 8 轮，60 条配额时只剩 4 条且都是旧的——所以之前「只显示两条」是配额被工具调用吃掉，不是没有新回复。

  验证：`tests/voice-routes.test.js` 新增两条（列表按轮聚合并把最新排最前；按整轮合成时两段正文接在一起念）。定向 `voice-routes` / `voice` / `app-tool` / `voice-reader` / `suggest-panel-ui` 118 通过 / 0 失败；`lib/voice-replies.js`、`index.js`、`ui/assets/suggest-panel.js` 的 `node --check` 与本轮 `git diff --check` 通过。App 已重载。需玥儿在面板里刷新朗读页看列表顺序与条数。manifest 版本、简介、README 未动。

- 2026-10-22 | 新功能 | **输入框面板的朗读页加了收藏按钮**（用户：面板里没有收藏按钮）。朗读页提示行右边多了「♡ 收藏」，和「重试合成」并排（`.reader-status-actions` 包一层）。合成成功后按钮才出现，收藏成功变「♥ 已收藏」；重复收藏时后端会认出来，提示「这段刚才收藏过了」。

  走后端已有的 `POST /voice/favorites`：只存引用（clipId + 文本 + 音色 + 来源伙伴），不复制音频，听的时候直接读原来那段。设置页「语音收藏」里能听。

  验证：`tests/suggest-panel-ui.test.js` 新增一条静态用例（按钮存在且默认隐藏、走 `/voice/favorites`、带 clipId）。定向 `suggest-panel-ui` / `voice-routes` / `app-tool` 94 通过 / 0 失败；`node --check ui/assets/suggest-panel.js` 与本轮 `git diff --check` 通过。App 已重载。收藏需要先有一段合成好的语音，按钮才会出现。manifest 版本、简介、README 未动。

- 2026-10-22 | 调整 | **伙伴列表的布局重排**（用户：下拉太长、试听单独占一列，页面乱）。伙伴行改成两行网格：第一行「伙伴名 + ▶ 试听」，第二行音色下拉占满。之前的 flex 布局里，音色下拉自带 `width: 100%`，把试听按钮挤到了另一行，整块就散了；网格用 `grid-template-areas` 固定位置，不再靠挤。

  试听按钮文案也统一成 `▶ 试听` / `■ 停止`，默认音色那一行同样。

  验证：`node --experimental-vm-modules --test tests/app-tool.test.js tests/voice-routes.test.js` 91 通过 / 0 失败；`node --check ui/assets/panel.js` 与本轮 `git diff --check` 通过。App 已重载。布局效果需玥儿在设置页看一眼。

- 2026-10-22 | 修复 | **在伙伴那里选音色会把整页音色清空**（用户实测：选完默认音色和伙伴音色都变成空的）。

  病根：面板改偏好会走 `PUT /voice-config` 自动保存，而这条路由只回 `{ ok, config, encrypted }`；页面的 `applyVoicePayload()` 拿到这份精简响应，就把 `voiceVoices` 与 `voiceLibrary` 当成空数组，音色下拉里只剩「跟随默认」。后端存的配置其实一直是好的（`voiceConfig` 里 `protocol=t2a`、音色、`voiceByAgent` 都在）。

  改法三处：① 后端抽 `buildVoiceConfigPayload()`，`GET` 与 `PUT` 回同一份完整形状（config / presets / voices / voiceLibrary / partners / partnersNote / encrypted）；② 前端 `applyVoicePayload()` 改成“缺哪项留哪项”，不再用空值覆盖；③ 新增一条用例钉住 `PUT` 必须回完整的一份。

  另一处是今天加试听按钮时的副作用：伙伴行多了一个按钮，行宽不够把伙伴名挤成 0 宽（截图里那一列整个是空的）。`.partner-voice-row` 改为可换行，伙伴名独占一行，下拉与试听按钮在第二行。

  验证：`tests/voice-routes.test.js` 新增「保存语音设置后回完整的一份」；定向 `app-tool` / `voice-routes` / `voice` 107 通过 / 0 失败，`index.js` 与 `ui/assets/panel.js` 的 `node --check` 通过。App 已重载，inspect `host=on / agent=on (hanako)`；需玥儿刷新设置页确认音色列表与伙伴名都还在。manifest 版本、简介、README 未动。

- 2026-10-22 | 新功能 | **设置页能试听音色**（用户：默认音色和伙伴各自的音色都该有个播放按钮）。默认音色那一行加了「试听」按钮，给伙伴分开选音色的每一行也加了一个；点一下用当前草稿配置合成一句固定的话（「这是这个音色的试听，听听看合不合适。」）放出来，字幕高亮走设置页已有的播放器。播放中按钮变「停止」，再点停。

  后端新增 `POST /voice/preview`：收 `{ config?, voiceId }`，按音色 + 文本 + 配置的哈希落盘并缓存，**同一个音色再点不重复合成、不重复花钱**（换音色才会重新合成）。页面没传配置时不能拿空配置盖住已存的那份——`normalizeVoiceConfig({})` 会填出一套默认地址和空 Key，盖上去就会误报「模型没配齐」。

  前端：`ui/panel.html` 加 `#voice-tone-preview`，`ui/assets/panel.js` 加 `previewVoiceTone()` 与按钮状态同步（播完才复位；`pause` 事件在换音频时也会来，拿它复位会把刚放上的试听又按回去），`renderVoicePartners()` 给每行插入试听按钮（这一行没单独选音色时听默认音色），`ui/assets/panel.css` 加 `.partner-voice-preview` 尺寸。

  验证：新增 `tests/voice-routes.test.js` 用例「音色试听：按指定音色合成，同一个音色再点命中缓存不再出网」（断言请求里的 `voice_setting.voice_id` 是指定音色、二次点不再出网、换音色会重新合成、缓存里的音频仍可取回）。定向 `app-tool` / `voice-routes` / `voice` / `voice-reader` / `suggest-panel-ui` 114 通过 / 0 失败；`index.js`、`ui/assets/panel.js`、`tests/voice-routes.test.js` 的 `node --check` 与本轮 `git diff --check` 通过。App 已重载，inspect `host=on / agent=on (hanako)`。**试听走的是真实 TTS，需玥儿在设置页点一次确认能出声**（本轮未由小花触发真实付费合成）。manifest 版本、简介、README 未动。

- 2026-10-22 | 调整 | **输入栏的知意按钮换成 🌸**（用户拍板：讨论后选定樱花）。`manifest.json` 的 `contributes.ui.inputStatus` 里 `zhiyi-suggest` 去掉内置 `icon: "sync"`，改用 `text: "🌸"`，与表情包 App 的 `🪄` 同一个路子（宿主会把 emoji 渲染成彩色）。悬停名与提示语不变，工具与显隐逻辑一行没动。

  验证：manifest JSON 解析通过，`inputStatus` 打印确认只剩 `text` 一项；App 已重载，inspect 为 `host=on / agent=on (hanako)`。按钮上能不能看到彩色 🌸 需玥儿在输入栏上看一眼。manifest 版本、简介、README 未动。

- 2026-10-22 | 移除 | **撤掉聊天区右键朗读与输入栏的「就绪」状态位**（用户要求：“把之前旧的那个什么就绪啦，右键朗读啦，都删掉”）。朗读只走输入框面板里的「朗读」页，不再在聊天区开第二个入口。

  `manifest.json`：删掉 `contributes.ui.contextMenus` 整块（`hana/chat.selection.contextMenu` 上的「朗读」）与 `inputStatus` 里的 `read-aloud-status` 项（标题「语音朗读状态」、文字「就绪」）。`app/input.status` 能力保留——知意按钮（`zhiyi-suggest`）还在用它做显隐。

  `index.js`：删掉 `jiegehua.read_aloud` 工具整段，以及配套的阶段状态写入（`READ_ALOUD_STATUS_ID`、`readAloudStatusRuns`、`beginReadAloudStatus` / `updateReadAloudStatus` / `finishReadAloudStatus`、`readAloudSessionIdsByPath`、音频头标记诊断）。这条链路本来就是宿主 CSP 挡下 `data:` 音频导致“合成成功但永远不响”的那一条，功能已由面板朗读页接管，撤掉反而少一个误导人的入口。

  `tests/app-tool.test.js`：删掉五条依赖右键朗读的用例（菜单声明、选区优先、合成失败状态、空选区不回退、缺选区提示），改写成一条反向断言：`contextMenus` 不存在、`read-aloud-status` 不存在、`zhiyi-suggest` 还在。别让谁又把它加回来。

  验证：`node --experimental-vm-modules --test` 覆盖 app-tool / voice-routes / voice-reader / suggest-panel-ui / suggest-panel / ball-bridge / voice，142 通过 / 0 失败；`index.js`、`ui/assets/suggest-panel.js`、`tests/app-tool.test.js` 的 `node --check` 与 manifest JSON 解析通过；本轮改动的 `index.js` / `manifest.json` / `ui/assets/suggest-panel.js` 的 `git diff --check` 通过（`tests/app-tool.test.js` 是 CRLF 文件，全文件 diff 报满尾随空格，是既有噪声，未动它的行尾）。App 已重载，inspect 为 `host=on / agent=on (hanako)`。宿主权限面板里先前授予的「读取选中文字」授权已无使用方，界面上是否还显示由宿主管。manifest 版本、简介、README 未动。

- 2026-10-21 | 调整 + 诊断 | **朗读列表读得更深，高亮退化的原因会说出来**。

  列表只列得出两条的病根：读历史写死 `limit: 60`，而 Hana 的一轮回复会被拆成好几条 entry（先 mood、再工具调用、再工具结果、再正文），配额被工具调用与“清洗后正文为空”的条目吃掉，扫不到更早的轮次。`REPLY_HISTORY_LIMIT` 放宽到 400。

  另加一条统计日志（只记数字：读到多少条消息、多少条助手、清洗后空掉多少条、最终列出多少条），列表再不对时不必再猜。

  高亮方面：`buildReaderSegments` 现在会回传 `covered` / `eligibleCharacters`，页面上逐词点亮对不上时不再只说一句“全文照常播放”，而是写明「只对上 X/Y 字（收到 N 条时间戳）」，播放、暂停时这句原因也不会被「正在播放」盖掉。

  高亮排查期间临时加过前端 console 追踪与后端时间轴日志（记音频时长与时间戳首尾），问题确认后已把前端追踪删干净；后端那两行诊断日志保留，日后对不上时能直接看出时间轴尺度。

  验证：定向测试全绿（见同日「朗读缓存与播放键状态」条目）。manifest 版本、简介、README 未动。

- 2026-10-21 | 优化 + 修复 | **朗读不再重复收费，同一段话直接用现成语音；播放键跟着声音变**。上一窗口遗留的两个实测反馈本轮收掉：① 播放键点了之后不会变成暂停图标（声音其实停了）；② 关闭面板重开、同一条回复仍然重新合成一遍。

  播放状态机：`setPlayerPlaying()` 统一管播放/暂停图标与 `aria-label`，并挂了 `play` / `pause` / `ended` 事件同步，不再只看点击意图；播放键尺寸从 40×40 收到 32×32（图标 21→17），圆角随小一档。

  朗读缓存：合成后除了落 `.mp3`，同时在同目录写一份 `<clipId>.json`（词级时间戳等），并把「清洗后文本 + 实际音色 + 会影响声音的配置（协议/地址/模型/GroupId/语速/范围）」的哈希存进 `voiceClipCache`。下次同一段话直接读回原来的 clip 与字幕，不出网也不花钱；音频文件不在、sidecar 指纹对不上、或换了音色与语速，都会照常重合成。逐词时间戳放 sidecar 而不是全局存储——一段长回复的 timings 就能到几百 KB，攒几十条会把 storage 撑肿。缓存只保留最近 80 条索引；被挤掉的旧音频文件不删（语音收藏还引用着它们的 clipId）。面板提示会明说「这段以前合成过，直接用现成的语音。」

  顺手修掉一个既有红灯：`tests/ball-bridge.test.js` 里「推荐生成失败把原因写进 notice」的断言仍在 2026-10-20 那次改动之前的旧行为上（那次已刻意改成球面只给人话、原文挂日志），按实现更新了断言。

  **图标不换的真正病根**：`play` / `pause` / `ended` 事件早就接好了，但图标切不动。`hidden` 属性定义在 `HTMLElement` 上，`<svg>` 没有这个属性，`svgEl.hidden = true` 只会挂一个普通 JS 属性、不生成 HTML 属性，CSS 里的 `[hidden] { display: none !important }` 永远选不中。播放三角初始没带 `hidden`，就一直显着；暂停图标 HTML 里带了 `hidden`，就一直被压住——两个方向都卡住。音量那一对图标同病，静音也不会变。改成 `Element.toggleAttribute('hidden', bool)` 才动真属性。新增一条静态用例钉住：四个图标都必须是 svg，且只能用 `toggleAttribute` 切换，不能再出现 `.hidden =`。

  验证：`node --experimental-vm-modules --test` 覆盖 app-tool / ball-bridge / ball / ball-ask-watch / voice-routes / voice / voice-reader / suggest-panel / suggest-panel-ui，175 通过 / 0 失败（新增两条缓存用例：同段二次合成不再出网且时间戳照旧返回、换语速后不命中缓存）；五个改动文件 `node --check` 与 `git diff --check` 通过。App 已重载，inspect 为 `host=on / agent=on (hanako)`。缓存命中路径未经真实 TTS 验收，需玥儿在面板里对同一段话连点两次确认第二遍秒出、换语速后会重新合成。manifest 版本、简介、README 未动。

- 2026-10-21 | 调整 | **朗读切换为专注阅读页，并加入词级同步高亮**。选中一条回复后立即隐藏回复列表，只显示当前朗读文本；使用现有 MiniMax `timings` 将对应词逐个点亮，保留标点与间隔。时间戳缺失、无法对齐或覆盖不足时仍展示完整文本，不做残缺高亮；覆盖率按可朗读的字母与数字计算，标点、换行和表情不会稀释结果。高亮词离开可视区时阅读区会跟随滚动；会话切换的旧列表响应由序号守卫拦截；音量条随音量值显示填充。原生音频条替换为统一的自定义播放/暂停、进度、音量/静音与倍速控件；合成失败可在阅读页重试。改动：`ui/suggest-panel.html`、`ui/assets/suggest-panel.js`、`ui/assets/suggest-panel.css`、新增 `ui/assets/voice-reader.js`；新增 `tests/voice-reader.test.js`，更新 `tests/suggest-panel-ui.test.js` 与 `tests/voice-routes.test.js`。定向验证 31/31 通过，相关 JS 语法检查及本轮源码/测试范围的 diff 空白检查通过；未调用真实 TTS。App 已从当前磁盘代码重载，inspect 确认为 `host=on / agent=on (hanako)`；朗读页实机显示与试听仍待玥儿在输入栏面板里点验。manifest 版本、简介、README 未动。

- 2026-10-21 | 功能调整 | **朗读入口移入输入框多功能面板**。保留「推荐回复」为默认页，新增「朗读」切页；朗读页按当前输入面板绑定的会话列出最近 8 条伙伴回复，每条有明确的「朗读」按钮，合成后在面板内显示音频控件，可播放、暂停和拖动。自动播放失败时控件仍留在面板里手动播放。回复行末尾的 `messageActions` 朗读按钮已移除；聊天区选中文字右键朗读保留。根据截图回报，常用回复按钮现在不会被 flex 挤窄后截字，长句会自动换行；面板高度估算也补入页签与多条常用回复的空间，减少内容被裁切。

  朗读页使用现有 `/voice/replies`、`/voice/speak`、`/voice/clip/:clipId` 路由和本机音频文件，通过 Blob URL 加载到面板播放器；列表只在打开朗读页/点刷新时读当前会话，不调用模型，明确点某条「朗读」后才请求 TTS。修正显式 sessionId 的朗读目标会从 `session:list` 补伙伴 `agentId`，保持按当前伙伴选择音色。沿用已批准的 `app/input.panels` 与会话读取能力，无新权限；manifest 版本、简介、README 未动。布局修正后 App 已再次从当前磁盘代码重载，inspect 确认 `host=on / agent=on (hanako)`；实机 UI 与 TTS 播放仍待点验。

- 2026-10-21 | 新功能 + 诊断 | **聊天区选中文字右键朗读**。`manifest.json` 新增 `hana/chat.selection.contextMenu` 的「朗读」入口，复用 `jiegehua.read_aloud` 与现有伙伴音色；选区文本优先、空选区不回退到整条消息。手动选区按用户明确选中的范围朗读，不受「只念引号台词」设置影响，仍受现有最长字数限制；回复行原有朗读行为保留。首次使用选区时宿主会请求 `app/session.read-selection` 授权。

  输入栏状态区显示 `就绪 → 准备中 → 正在合成 → 已合成 / 合成失败`。接口一次返回完整音频，不提供可计算的百分比；「已合成」只代表音频数据已生成，不能证明宿主确实播放出声。状态更新沿用已有 `app/input.status`，未增加权限。最初一直停在「就绪」的根因已定位：聊天右键上下文只给 `sessionPath`，旧代码把路径文件名当成稳定 `sessionId`；宿主 `inputStatus.set` 要求真正的稳定编号。现复用 `resolveSessionIdByPath()` 通过 `session:list` 映射并按路径缓存编号；该读取能力已由 App 声明，没有新增权限。

  玥儿 18:22 的实测日志显示，两次右键都进入工具并返回 MP3 字节（15,252 / 16,692 / 16,116 字节）；19:20 诊断点击的 `inputStatus.set` 三阶段均成功，TTS 回 18,132 字节、时长估算 2,267ms；19:48 再测仍无声，但三阶段状态照样成功，TTS 回 17,844 字节、头部标记为 `ID3`、时长估算 2,231ms。玥儿确认知意设置页「语音服务」里的测试音频手动点播放能听见，TTS 服务与系统输出可用，故障集中在右键的宿主自动播放链。代码核对发现：宿主 `/desktop` 跳转到 `/pad`；`pad.html` 的 `connection-csp.js` 设置 `default-src 'self'`，却未声明 `media-src`，而 ChatTranscript 的 UI action helper 用 `Audio(data:audio/mpeg;base64,...)` 播放。按 CSP 规则，缺少 `media-src` 时会回退到 `default-src`，因此该 `data:` 音频源被策略拦截；宿主又把 `Audio.play()` 的拒绝静默吞掉。设置页播放器用 Blob URL，能走通另一条播放路径。根因定位为 Hana renderer 的 CSP 与其 `details.audio` 播放实现不兼容，修复需要宿主补充允许的媒体来源或改用受允许的 Blob 路径；本 App 不改写宿主包。新增逐阶段状态成功/过期跳过日志及音频安全元数据，不记录正文或原始音频；曾用的十六进制头部日志因隐私脱敏误判卡号，已替换为类别标记。本轮未由小花调用真实 TTS API。版本、简介、README 未动。

  验证：定向 `app-tool.test.js` 5/5；`node --check index.js`、`node --check tests/app-tool.test.js` 与 manifest JSON 解析通过。最新安全头部诊断版已重载，inspect 为 `host=on / agent=on`。设置页手动播放可听，聊天右键的宿主自动播放仍待宿主侧修复。

- 2026-10-21 | 修复 | **理顺结果跟原文几乎一样，只动了标点**。实机三连测（同一段糙话）：第一版只删了一个「那个」并把两个逗号换成句号；第二版多了个冒号、断句稍好；提示词改结构后第三版才真正动起来（删开场铺垫、收「然后」「就是」、断成三句，字数 118 → 105，且「那个按钮」的指代、「别大改」、「大概是哪儿的问题」、语气与信息顺序全部保留）。

  **根因不是模型笨**：同一段话的候选标签自己写着「删口头垫话」「砍掉开场废话」，说明它完全看得见毛病；是提示词结构把它束住了——八条规则里七条是「不许」，唯一允许的那条写的是「可以」，主指令与禁令的篇幅比约 1:7；示例名前缀还挂着「保守示例」三个字，等于提前发了免死金牌。**看得见但不敢动，先查提示词里禁令与主指令的比例**，不要先怀疑模型。

  改法（`lib/polish.js` 的 `POLISH_LEVELS.balanced.rules`）：八条压成三条——①主指令（几件事拆成几句、收口语填充词与开场铺垫、重复合一、补标点），末尾明写「这是这个任务的主要工作，占你大部分注意力」；②自查一正一反（改完看不出区别就是没干活；为显得在干活而硬凑也算没完成）；③把所有安全线合成一句底线（事实、数字、专名、来源、指代、程度词、语气强度、沟通行为、信息顺序、省略号与占位符）。主指令与底线篇幅比从 1:7 变 1.2:1，提示词总长 1437 → 1214 字。示例名同时去旧标签：「保守示例」→「边界示例」、「标准档示例」→「分句示例」、「深度档示例」→「语气示例」、「深度档再示例」→「合并示例」；提示词里的「本档规则」→「整理规则」、「按档位整理」→「整理」。

  验证：`node --test tests/polish.test.js` 28 通过 / 0 失败（用例名与断言由「本档规则」改为「整理规则」）；`node --check` 通过；App 已重载，实机第三版效果已由用户确认。**单次成功不等于稳定**：短句段与带情绪段（考「沟通行为不能被抹平」）尚未实机复测；候选标签点击与迭代链路也仍未真点过。

- 2026-10-21 | 调整 | **演练退役，静候关机转正**（用户：演练是测试用的，功能上线后不需要）。`armSleepGuard` 不再读 `sleepGuardRealEnabled`，默认就是真关机；`dryRun` 只留给开发验证（显式传 true 才生效），界面上不再出现。面板删掉「真关机」开关那一行与 `/sleep-guard/real` 的前端逻辑（路由保留并改成返回「已退役」），球上说明行不再显示「只演练/真关机」。

  文案定稿：「静候关机」，说明「等所有任务结束，安静地关机；中途有动静会重新计时」，按钮「完成后关机」→ 守着时「取消」。

  延迟：App 轮询从 4 秒压到 1.5 秒，按钮按完后立即 `pushSleepState(force)` 推一次，真关机开关读值缓存 3 秒不重复打 RPC。新增 `bootId`：球重启后 actionSeq 重新从 1 开始，App 靠它分辨「号变小了」是重启而不是倒流；已执行到哪一号落 `sleepBallActionSeq`，重载不重放旧按键。

- 2026-10-21 | 调整 | **传音樱改成一级常驻按钮**（用户要求：点一下就能挂，随时能取消，不躲二级）。原来那张「只在守着时出现」的状态卡拆了，换成主面板头部下方一个常开的 `sleepToggle`：没守时写「干完再关机」，点一下就是挂；守着时写「取消守门」，倒计时时写「取消（4:32 后关机）」；下面一行小字跟状态（已空多少、满多少才算完、几处还在忙、真关机还是只演练）。

  球不能回调 App，所以意图走桥：`POST /sleep/action`（只认 arm/cancel）把「人按了」存进 `self._sleep.action/actionSeq`，App 每 4 秒 `GET /sleep/state` 读 seq，比上次大才执行（第一轮先立基线，不重放旧按键）。球上仍然不做任何判定。

- 2026-10-21 | 优化 | **「捋一捋」改名「理顺」**。旧名是方言口语，外地用户看不懂，也看不出点完会得到什么。用户可见的文案全部换掉：弹窗标题「✨ 把话理顺」、按钮「✨ 理顺」、描述「把随手写的话理顺，原意不乱，结果可以再改。」、主面板工具卡「把话理顺」与其入口按钮「理顺」、悬停提示、补充框占位符「还想怎么顺？可选，比如：收短一点」、候选标签标题「还能往这些方向改」、几条状态行与错误提示（「正在理顺…」「理顺好了，可以再改改」「先写点什么再理顺嘛」「理顺失败了」「没顺出结果」），以及 `ui/panel.html` 与 `panel.js` 里“传音樱能做什么”那一句。后端提示词与错误话一并改用「整理尺度」「理顺」，不再叫「润色力度」。

  **不动的**：代码标识符（`polishText` / `polish_async` / `/polish` 路由）一个字没改，用户看不见；`PENDING_CHANGES` / `PROJECT_LOG` / `TESTING` 里的历史记录是账本，不能改。`lib/polish.js` 文件头加了一句「原名捋一捋，2026-10-21 改名」，免得以后看代码的人把两个名字当成两个功能。

  验证：`node --test tests/polish.test.js` 28 通过 / 0 失败（断言跟着改成「本次整理尺度：均衡」与「只输出整理后的提示词本身」）；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；`cd python && python -m unittest test_ask_dialog test_resume_dialog test_app_bridge` 92 通过（1 跳过）；四个改动文件语法/AST 均通过；离屏渲染逐项核对标题/按钮/描述/占位符/候选标题均已换名，窗口 344×417。App 已重载。

  **过程异常（待核）**：本次操作期间 `ui/assets/panel.js` 与 `python/zhujian_app.py` 出现过不是我造成的改动——`zhujian_app.py` 里 `def _apply_resume_state` 与下一行被粘成一行（已修），`panel.js` 的睡眠守卫那两处 `!response.ok || payload?.ok === false` 被拆成了两个单独的 `if`（不是我改的）。已按工作区完整性事件处理：停下写入、只读核对、恢复临时占位符、重跑全部相关测试。当前文件自洽、三套测试全绿，但**未能确认改动来源**，需要用户确认是否有其他窗口/伙伴在同时编辑本项目。

- 2026-10-21 | 新增 | **守门人上了面板和传音樱**（用户要求「包括传音樱也专门留个位置」）。

  面板（设置页「活都干完了，再关机」）：状态一句话（守着/倒计时/已发出/演练走完/等太久放弃）、厉害了多久、空多久才算完、可撤销窗、真关机开关、最近 20 条复盘时间线、撤掉守门。两个数字改成面板上的默认值（`sleepGuardConfig`，`armSleepGuard` 没传参数时读它）。新增三条路由：`GET /sleep-guard`、`POST /sleep-guard/config`、`POST /sleep-guard/real`、`POST /sleep-guard/cancel`。

  传音樱：主面板加一张 `sleepCard`（默认隐藏，真在守时出现），标题写着「守门中 / 倒计时 X 后关机」，副行写「已空 X·满 Y 才算完·现在 N 处还在忙·真关机/只演练」。App 每 4 秒推一次 `POST /sleep/state`（状态指纹没变就不推），球 3 秒轮询自己的桥。球上不放按钮：判定只能有一个来源。

  验证：`tests/app-tool.test.js` 61/61、`tests/sleep-guard.test.js` 16/16；`index.js`、`panel.js` 语法检查通过；`app_bridge.py`、`zhujian_app.py` `ast.parse` 通过。修正了两处会撞上现有测试的写法：`!response.ok || payload?.ok === false` 合并判断（测试明确禁止）、panel 里常驻的 setInterval（改成只在 armed 时排的 setTimeout）。**未实机看过面板和球的渲染**，待用户打开确认。

- 2026-10-21 | 优化 | **把「标准 / 深度」两档并成一档「均衡」**。实测两档提示词只差 47 个字，唯一的实质区别是能不能重排信息顺序；而两档的按钮说明（「只补几乎不会猜错的直接信息」vs「不替你猜事实」）基本同义反复，用户站在两个按钮前分不出差别，等于让他们抽签。而且深度档独有的「重排结构」能力已经被新加的补充要求框和候选标签覆盖。

  `lib/polish.js`：`POLISH_LEVELS` 只留 `balanced` 一档，规则重新写成中间档——可以整理标点、断句、语病、顺口；成串的口语填充词（「然后」「就是」「那个」）可以收掉；但**不许重排信息顺序**（同一件事被拆散在几处才拢到一起，且不得因此改动其他内容次序），不许增删事实。新增 `resolvePolishLevel()`：`standard` / `deep` 两个旧值仍能被认出来（`isValidPolishLevel` 也认），统一归到 `balanced`，旧球、旧配置、旧调用不会报错。

  界面：`zhujian_app.py` 删掉力度那一整行（`level_row`、两个胶囊按钮、`polishLevelLabel` / `polishLevelBtn` 两段样式），一并清掉 `_pick_level` / `_sync_level_ui` / `current_level` 三个方法；`_level` 保留但固定为类常量 `LEVEL = "balanced"`（桥的 level 参数还在，只是不再由用户选）。窗口基础高度 380 → 343（少了一行），带三条候选标签时 446。

  验证：`node --test tests/polish.test.js` 28 通过 / 0 失败（原「力度档位只有标准和深度」用例改写为「档位只有均衡一档，旧档位名仍能认出来并归到均衡」，并加遍历断言：balanced / standard / deep / undefined / nope 五种传法都必须落成均衡）；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过；`cd python && python -m unittest test_ask_dialog test_resume_dialog test_app_bridge` 92 通过（1 跳过）；`node --check index.js lib/polish.js` 与 `zhujian_app.py` AST 均通过；`python/zhujian_app.py` 里 `_pick_level` / `_sync_level_ui` / `level_btns` / `POLISH_LEVEL` / `polishLevel` 字串搜索均为空。离屏渲染实拍已确认力度行消失。App 已重载。

  **待实机验收**：球上真点击的完整链路（含候选标签自动请求）仍未走过；跑一遭时留意界面高度。另：截图里「发送到」下方那块空白是探测脚本没跑目标同步造成的，真机里会填一行对话名，不是新问题。

- 2026-10-20 | 新功能 | **捋一捋改成可以接着改、可以点方向、可以补一句要求**（借鉴 HanaAgent-prompt-optimizer 的三条设计，见项目根 `借鉴与致谢.md`；只借思路，未复制代码）。版本、简介、README 均未动。

  ① **原文锚定 + 迭代精修**。以前结果是用 `setPlainText()` 直接盖进输入框，最初原文不留；再点一次「捋一捋」时基线就变成上一版，`enforcePolishSafety` 比的也是上一版，多轮之后既越捋越不像用户本人的话，兜底规则本身也跟着漂。现在 `PolishPanel` 存 `_anchor_text`（最初原话）与 `_last_result`（上一版），`lib/polish.js` 的 `polishText` 新增 `source` / `previous` / `instruction` 三个可选参数：安全校验永远对着 `source` 做，不管这是第几轮。

  迭代判定卡在“输入框里还是上一版”（`text === prev`）。用户自己动过输入框就当新原文，锚点重设——否则会拿一个改过的版本去对照旧原文，两边打架。后端也做了同样的自保：`onPrevious` 不成立时锚点取当前内容。

  **兜底退回的目标改了**：首次失败退回原话（同以前），迭代失败退回**上一版**。上一版可能已经被用户手改过，退回原文会把他改的字一起抹掉，那是比不改更狠的伤害。

  ② **可选「补充要求」框**（输入框下方一行，`polishRequire`）。写一句这次想怎么捋（语气、长短、繁简），空着就按档位走。进提示词时单独成段，并明写「只能改变表达方式，不能改变信息本身」，防的是用户说「语气客气点」时模型顺手编一句客套话塞进去——那正好是兜底要拦的东西。另外补了优先级声明：方向与档位规则冲突时以档位为先，做不到就保留原样。用完即清，避免下一轮接着带同一条要求、或抢在候选标签前面。

  ③ **候选方向**（`suggestPolishFixes` + 新增桥 kind `suggest` 与 `POST /polish/suggest`）。捋成功后自动问一次「还能往这些方向捋」，只要 `{"label","prompt"}` 的 JSON 数组，4~6 条，走快速档（`invokeFastTextModel`，避免长思考模型把预算吃光），20 秒超时，失败一律静默返回 null。界面上排两列小标签，点一下就把那条 prompt 填进补充框并立即迭代。专给「感觉不对但说不出哪儿不对」的用户用。

  桥/路由：`python/app_bridge.py` 的 `/polish/request` 允许 kind `suggest` 并把 `source`/`previous`/`instruction` 原样带上；`index.js` 的桥轮询新增 suggest 分支，`/polish` 接受新参数，新增 `/polish/suggest` 路由（拿不到就回空列表，不报错）。

  验证：`node --test tests/polish.test.js` 28 通过 / 0 失败（新增 12 条：迭代退回上一版而非原话、首次退回原话、合规迭代保留改动、用户改过输入框不算迭代、迭代/自查提示词、补充要求进提示词与清洗、候选方向解析与去脏去重限条、模型报错返回 null）；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过；`cd python && python -m unittest test_ask_dialog test_resume_dialog test_app_bridge` 92 通过（1 跳过，新增 3 条桥参数透传用例）；`node --check index.js lib/polish.js` 与两个 .py 的 AST 均通过。离屏渲染实拍：基础 344×380，带五条候选标签 344×489，完整状态（标签+状态行）344×512，收起后回落到基础高度。App 已重载（v0.1.39），日志无报错。

  **待实机验收**：传音樱上的真点击链路没走过（需球运行 + 真模型），候选标签的真实返回效果也只看过假数据。另外发现一个旧问题：`发送到` 与 `力度` 之间约 40px 空白（空的 `polishTargetInfo` 占位），本次没动。

- 2026-10-20 | 计划 | **捋一捋要借鉴 HanaAgent-prompt-optimizer，并且上线时必须写致谢**（本条只是立项记录，代码一行未动，版本、简介、README 均未改）。

  来源：`youyongdemao/HanaAgent-prompt-optimizer`（App id `prompt-optimizer`，参考 v1.0.2，MIT License，Copyright (c) 2026 youyongdemao，https://github.com/youyongdemao/HanaAgent-prompt-optimizer）。**本次只借设计思路，没复制任何代码。**完整台账见项目根 `借鉴与致谢.md`，发布时照它写 README 致谢区与 Release 说明。

  要借的三条，按优先级：

  ① **迭代精修契约**（最该做，属堵漏不属加分）。它把「在上一版上接着改」写成独立系统提示词，明说上一版是既成内容、本次只改用户点名的部分、其余保持原样，注释里写明理由：模型拿到「原文 + 上一版 + 新要求」时极容易顺手改掉没被要求的地方。

  本项目现状的真实隐患：`zhujian_app.py` 的 `_apply_polish_result` 用 `self.input.setPlainText()` 把结果覆盖进输入框，**最初原文不留**。再点一次「捋一捋」时，`polish_text()` 取到的已是上一版结果，`enforcePolishSafety` 的比对基线也跟着变成上一版——多轮之后既越捋越不像用户本人的原话，兜底规则本身也一起漂移。所以本项目要做就得比它更严：最初原文永久锚定，每一轮都拿原文做安全校验，而不是拿上一版。

  ② **可选「补充要求」框 + 优先级声明**。它在系统提示词里留一个可选段位写用户的硬性补充要求，并标「必须遵守，优先级高于上面的场景侧重」，防的是取向与要求撞车时模型自己挑一边。本项目现在界面只会提示「想换个说法可以加一句要求再试」，却没地方写那句要求，正好接上。

  ③ **按内容推荐改进方向（候选改法）**。输入停下后调一次轻量模型，只要 `{"label":短标签,"prompt":一句具体做法}` 的 JSON 数组，4~6 条，输出预算压小，temperature 0.5；提示词要求方向必须针对这一条内容、不许给放之四海而皆准的套话，解析时容忍模型裹解释或代码块（取首个 `[` 到末个 `]`）。这与本项目既有的「对话式修订 → 可预览建议 → 一键应用」偏好同路，专治「感觉不对但说不出哪儿不对」，成本最低、见效最快。

  **明确不借**：它核心原则第 2 条「把含糊的动词、缺失的背景补成明确可执行的描述」和第 3 条五段式结构（角色/背景 → 任务 → 要求 → 格式 → 约束）。这两条与「捋一捋」的保守底线正面冲突，照搬会架空 `enforcePolishSafety` 的全部规则，因为兜底拦的正是凭空新增的信息。它的场景清单内容取向同理不借（只可借「用户可改名改说明、服务端再洗一遍、保留旧配置迁移」这层外壳，且限定在整理形态维度）；左右对照与任意版本回点的溯源链条成本最高，暂缓。

  上线前必办：把 `借鉴与致谢.md` 里「已实现」的条目写进 README 致谢区与 Release 说明，写清项目名、作者、许可和参考版本；若届时有复制代码，补 `NOTICE` 与源文件版权声明。

- 2026-10-20 | 修复 | **知意 Ask 卡片的选择其实已经回到原对话，却被自己判成“没收到”**。实机事故：用户在 Ask 卡里选中“`两边同步手动排序`”并点确认发送，宿主把 `zhiyi_ask_answer` 事件连完整 payload（askId / action=confirmed / choice / note）投到了原会话，`originSessionId` 也对；但伙伴按配方第 4 条先做 `ui_inspect` 核验来源，宿主对“已经发出事件、不再是宿主 open instance”的对话内嵌卡回 `UI_INSPECT_CARD_NOT_FOUND`，伙伴就照“卡片已关闭就停止”把一个有效选择扔掉，改口要用户手打一遍。答案其实早到 8 分多钟（题 10 分钟后过期）。
  
  病根是**把 `ui_inspect` 当成了来源核验的硬门槛**，而它天生对这类卡报 NOT_FOUND（同一台机器上 2026-10-20 03:51 那一轮也踩过同样的坑，那次伙伴接着调了 `resolve_card` 就正常走通了）。真正的核验关卡一直是 `jiegehua_zhiyi_resolve_card`：它自己核 askId 是否绑在这张卡、是否本会话、是否过期或重复、选项是否合法，比 `ui_inspect` 强得多，而且是服务端状态，模型改不了；事件本身也是宿主投递的（`customType: hana-card-event`，带 `provenance.actor.kind = "card"`），来源可信。
  
  改法（三处规则文本，代码逻辑未动）：① `recipes/zhiyi-ask/SKILL.md` 第 4 条重写——事件本身就是宿主投递的真实点击，来源可信，`resolve_card` 是有效性的**唯一裁判**；`ui_inspect` 降为可选旁证，它报“不在 open instances / 可能已关闭”是常态，不构成拒绝作答的理由，只有它返回**另一张不同的卡**才算来源不符。② `skills/zhiyi-ask-handoff/SKILL.md` 同步写明不要因为 CARD_NOT_FOUND 放弃已送达的选择。③ `index.js` 里 `CARD_RESOLVE_TOOL` 的工具描述去掉“用 ui_inspect 核验来源后调用”这个前置条件，改成由工具自行核验。另加 `tests/ask-handoff-prompt.test.js`（3 条）把这条钉住：配方必须点名 resolve_card 为唯一裁判、必须解释 NOT_FOUND 不等于没收到、不得再出现“如果卡片已关闭或来源不符，停止”。
  
  验证：`node --test tests/ask-handoff-prompt.test.js tests/card-handoff.test.js tests/card-template.test.js` 16 通过 / 0 失败；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；`node --check index.js` 通过。App 已正式重新加载。**全局已安装的 `recipe:zhiyi-ask` 走扩展管理工具暂存了新版，等在界面确认后生效；旧卡不热更新，改完必须发新卡实机复验。** 版本、简介、README 未动。

- 2026-10-20 | 修复 | **Ask 卡片一直停在「正在与原对话绑定」，选项全灰点不动**。用户实机报障，连查三轮才定位，实际是四个坑叠在一起（不是单一时序问题）：
  
  ① **宿主把 host data 里的 `ready` 存成字符串 `"true"`**。落盘在 `~/.hanako/card-data/{cardHash}.json`，一读就看见 `{"askId":"…","ready":"true"}`；模板却用 `data.ready!==true`（布尔）判，`"true" !== true`，卡片永远不解锁。对照 21:38 那次**能正常点**的卡，同一份模板、同一套工具，宿主存的是布尔 `true`——**宿主两次写出来的形状不一样**。这是同一类坑的第三例（2026-10-18 踩过数字被写成字符串），模板对宿主写入的取值必须做归一化，不能假设类型原样送达。修法：`const yes=v=>v===true||v==='true'||v===1||v==='1'`。
  
  ② `options` 数组被宿主包成 `{item:[...]}`，原兼容写法只认一层。修法：改成 `unwrapOptions()` 循环拆解，层数不再限定。
  
  ③ **调用方自己多包了一层**——给 `show_card` 传 `options` 时套了 `item`，宿主再包一层变成 `{item:{item:[...]}}`，卡片一个选项都认不出。这条是自己的手滑，教训是卡片拿到选项数量不对，先查自己传的形状再查宿主包了几层。
  
  ④ **`window.card.data.onChange` 根本不响**。探针卡实测：注册成功（`onChangeRegistered: true`），但宿主写 host data 时回调一次都没被调用（宿主服务端确实发了 `card-data-changed`，走内部广播，卡片侧未必收到）。**「订阅变化」不是可靠通道，「主动去拉」才是。** 修法：收到变化提示也自己 `pullData()` 重拉一次，启动时若还没 ready 就每 500ms 拉一次、最多 40 次。
  
  改法：`recipes/zhiyi-ask/assets/ask.card.html`（`yes()` 归一化 + `unwrapOptions()` 循环拆解 + `pullData()` 主动重拉与有限轮询），`tests/card-template.test.js` 补 3 条实机对应用例（宿主先启动后写绑定数据仍能解锁、字符串 `"true"` 也解锁、多层 `item` 包裹能拆出选项）并改掉一条与新规则矛盾的旧断言。
  
  验证：`node --test tests/card-template.test.js` 12 通过 / 0 失败；`node --test tests/ask-handoff-prompt.test.js tests/card-handoff.test.js tests/card-template.test.js` 全绿；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败。全局 `recipe:zhiyi-ask` 已走扩展管理工具重装并核对哈希与 App 包内一致。**实机复验：新卡选项已可点，事件回传的最终验收待用户点「确认发送」后回看 `resolve_card`。** 版本、简介、README 未动。

- 2026-10-20 | 修复 | **知意 Ask 卡片的选择其实已经回到原对话，却被自己判成“没收到”**。实机事故：用户在 Ask 卡里选中“`两边同步手动排序`”并点确认发送，宿主把 `zhiyi_ask_answer` 事件连完整 payload（askId / action=confirmed / choice / note）投到了原会话，`originSessionId` 也对；但伙伴按配方第 4 条先做 `ui_inspect` 核验来源，宿主对“已经发出事件、不再是宿主 open instance”的对话内嵌卡回 `UI_INSPECT_CARD_NOT_FOUND`，伙伴就照“卡片已关闭就停止”把一个有效选择扔掉，改口要用户手打一遍。答案其实早到 8 分多钟（题 10 分钟后过期）。
  
  病根是**把 `ui_inspect` 当成了来源核验的硬门槛**，而它天生对这类卡报 NOT_FOUND（同一台机器上 2026-10-20 03:51 那一轮也踩过同样的坑，那次伙伴接着调了 `resolve_card` 就正常走通了）。真正的核验关卡一直是 `jiegehua_zhiyi_resolve_card`：它自己核 askId 是否绑在这张卡、是否本会话、是否过期或重复、选项是否合法，比 `ui_inspect` 强得多。
  
  改法（三处规则文本，代码逻辑未动）：① `recipes/zhiyi-ask/SKILL.md` 第 4 条重写——事件本身就是宿主投递的真实点击，来源可信，`resolve_card` 是有效性的**唯一裁判**；`ui_inspect` 降为可选旁证，它报“不在 open instances / 可能已关闭”是常态，不构成拒绝作答的理由，只有它返回**另一张不同的卡**才说明来源不符。② `skills/zhiyi-ask-handoff/SKILL.md` 同步写明不要因为 CARD_NOT_FOUND 放弃已送达的选择。③ `index.js` 里 `CARD_RESOLVE_TOOL` 的工具描述去掉“用 ui_inspect 核验来源后调用”这个前置条件，改成由工具自行核验。另加 `tests/ask-handoff-prompt.test.js`（3 条）把这条钉住：配方必须点名 resolve_card 为唯一裁判、必须解释 NOT_FOUND 不等于没收到、不得再出现“如果卡片已关闭或来源不符，停止”。
  
  验证：`node --test tests/ask-handoff-prompt.test.js tests/card-handoff.test.js tests/card-template.test.js` 16 通过 / 0 失败；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；`node --check index.js` 通过。App 已正式重新加载。**全局已安装的 `recipe:zhiyi-ask` 走扩展管理工具暂存了新版，等在界面确认后生效；旧卡不热更新，改完必须发新卡实机复验。** 版本、简介、README 未动。

- 2026-10-20 | 新功能 | **备用模型：主模型连撞三次不成就换一条，并且把“这次是备用”说出口**。新增 `GET/PUT /fallback-model`（存 `recommendationFallbackModel`，与主模型重复时直接拒，因为重复等于没兜住）；`lib/recommendation.js` 抽出 `runModelAttempts`，主模型用 45s 总预算，备用单独 25s 短预算（不能因为主模型耗光时间就连兜底机会也没了）；返回体带 `usedFallback` / `primaryName`，面板生成成功后在提示行写明“主模型没接住，这几句是备用「某某」拟的”。设置页「内容模型」下新增一行「备用模型」选择器（自行拉模型列表，不依赖内容模型那块加载成败）。不做“自己挑一条顶上”——换模型就是换价钱和换口味，得她知道。

- 2026-10-20 | 优化 | **把“为什么偏偏 luna 不行”追到了宿主层，并在知意这边做了能做的那一半**。逐层排查结论：
  
  ① 宿主把**所有** provider 错误统一包成一句：`bundle/index.js` 里 `class ZP extends Error`（`AppModelRuntimeStreamError`）的 constructor 只认 aborted 和默认两种，默认文案就是 `The model provider could not complete the request.`——原始错误、HTTP 状态码全部丢弃，所以日志与账本里看不到原因。
  
  ② 宿主只在调用方给了 `providerSessionKey` 时才给底层 provider 传 `sessionId`：`async function* mrr(...)` 里写的是 `...s?.providerSessionKey ? { sessionId: s.providerSessionKey } : {}`。`sessionId` 再由 `Lvr(api, id)` 变成会话亲和头（`openai-responses` → `session_id` + `x-client-request-id`），`CK()` 再用它做 prompt cache key。主对话天然带会话，所以缓存命中 98%、100% 成功；App 侧天然没有，每次都算“无主请求”（账本里 `cacheReadTokens` 恒为 0）。
  
  ③ 同一个病，`opencode-go` 把话说白了：App 侧 31 次全部失败，错误是 `Request is missing x-opencode-session and cannot be routed efficiently`。而 `deepseek` 不需要这套东西，App 侧 800+ 次 100%。
  
  ④ 公开契约 `AppModelInferenceRequestV2` 里没有这个字段，但运行时能透传：app-host 的 `domain()` 把整个 `args` 数组转给宿主，宿主 `AppModelsService.stream(o, a)` 收第二个参数，`TTe(a)` 的白名单里就包含 `providerSessionKey` / `cacheRetention`。
  
  所以知意能做的：`lib/custom-model.js` 的 `invokeTextModel` 新增 `transport`，Hana 模型那条路以第二参数传 `{ providerSessionKey: 会话编号, cacheRetention: "short" }`（编号由宿主先 sha256(appId+编号) 再下发，原文不出门）；`lib/recommendation.js` 把当前会话编号传进去。因为这是未声明参数，加了降级：一旦回 `APP_MODEL_INVALID_REQUEST` 就脱掉 transport 用单参数重发一次，不让“增强”变成新的失败源。自定义模型直连那条路不受影响（地址直连没这个说法）。
  
  仍做不到的：让宿主别吞原始错误、让它给 `openai-codex-responses` 也加上亲和头（`Lvr` 对 codex 走 default 分支返回空对象）——那两块得宿主改，知意只能绕。
  
  验证：`node --test` 推荐 13 / 面板建议润色 30 / 自定义模型 7 全绿（新增“会话纽带带上了”“宿主不认时自动脱掉重发”“备用模型顶上并交代清楚”“备用与主重复不白跑”四组用例）；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过；五个改动文件 `node --check` 通过。
  
  **实机结论（20:41，重载后新代码）：会话钥匙无效**。三次尝试（`zhiyi_recommend_mvgoabw3_1` 5156ms / `_2` 5899ms / `_3` 9195ms）全部 `could not complete`，`cacheRead` 依旧缺失。原因：`Lvr()` 对 `openai-codex-responses` 走 default 分支直接返回 `{}`，根本不用 sessionId 做亲和头；`CK()` 又只给**已存在**的 `prompt_cache_key` 字段赋值，codex 请求本身不带这个字段，于是什么也没发生。即：宿主给这条路根本没留门缝，知意这边再怎么传参数也顶不上去。保留 transport 传递（对其它 provider 仍有意义，且已带降级），但不再指望它救 codex。
  
  **已采取的处路（配置层）**：把 `recommendationModel` / `askJudgeModel` / `summaryModel` 三条从 `openai-codex/gpt-6-luna` 改为 `deepseek/deepseek-flash`（App 通道实测 827 次 100%），改前备份：`L:\哈娜的工作台\_配置文件备份\jiegehua-zhiyi-storage-20261020-204345.json`。
  
  **换模型后的实测（20:52）：通了**。`zhiyi_recommend_mvgonn27_4` —— 931ms、651 输入 / 95 输出 token、一次就成（同一时段 `zhiyi_ask_*` 也 1368ms 成）。对比原来 luna 的 5~9 秒且九成失败，快一个量级。所以根因定性：**不是知意请求结构的问题，是 `openai-codex` 这条 provider 在 App 通道下就是接不住活**（主对话里的 luna 仍是 138/138 正常，所以不是模型坏，是通道不适配）。
  
  **踩到的坑（后人必读）**：直接改 `app-data/jiegehua-zhiyi/storage/global.json` **无效**——宿主持着 App storage 的内存副本，20:43 改的文件在 20:47:44 被原样写回旧值，那一轮实测等于用旧模型白跑。改 App 设置只能走 App 自己的 HTTP 路由或界面。同理，改 App 源码后必须 `extension_manager reload`，否则跑的还是旧进程（20:37 那次实测就是旧代码，只重试 2 次、旧文案）。

- 2026-10-20 | 优化 | **推荐面板生成失败的真相查清并加固：失败不是额度问题，是 provider 在 App 调用通道上拒请求**。用 `usage-ledger.sqlite` 按 `zhiyi_recommend_*` 对账（2026-10-20）：面板当天 22 次模型请求 14 次失败（8/22 成功）；拉长到 7 天，`openai-codex/gpt-6-luna` 在 App 侧只有 63/264 = 24%；同一个模型在主对话（`subsystem=session`）里 138/138 全成；App 侧同样是 App 通道，`deepseek/deepseek-flash`（拾光记 554 次、提个醒 273 次）100%。所有失败都是 4~9 秒内返回 `The model provider could not complete the request.`，`usage` 为 null；成功一次只花 97~119 个输出 token，所以**旧文案「多半是输出额度不够」是错的**，白白支使人去调参数。因为「内容模型」是推荐 / Ask 判断 / 速览共用一条，速览当天 68 次全部失败也是同一个原因。
  
  改法（只动本 App，不动宿主）：`lib/recommendation.js`：重试 2 次立即重发 → **3 次、间隔 0.6s / 1.5s**（实机：人连点三下往往能撞过一次，说明是短时抖动窗口），加**总时长 45s 封顶**并让每次超时从剩余预算里取（单次 30s→25s），避免对着按钮坐一分半；新增 `isRetryableModelError`，会话凭证/模型不在列表/参数不合法这类不再盲目重试；`friendlyModelError` 改成如实描述（服务商没接住，过一会儿再点，一直这样就换一条内容模型），**原文不再塞进面板文案**（面板就那么高，长句会把按钮挤没），改挂 `rawMessage` 交给日志；`index.js` 的「面板推荐生成失败」日志补 `message` / `raw`（以前只记 code，等于把线索丢了，这一轮排障最后是从账本里把 provider 原话挖出来的）；`ui/assets/suggest-panel.js` 生成按钮 12s / 26s 后换一句话（「再等一下…」「还在试…」），不让重试看起来像卡死。
  
  验证：`node --test tests/recommendation.test.js tests/suggest-panel.test.js tests/suggestions.test.js tests/polish.test.js` 66 通过 / 0 失败（新增「不可修复的错误不重试」用例，两处重试次数断言从 2 改 3）；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；四个改动文件 `node --check` 通过。未做：换模型后的真实面板点击复验（建议把内容模型换成 `deepseek/deepseek-flash`，那是 App 通道上实测 100% 的一条）。

- 2026-10-20 | 优化 | **面板按 UI 偏好整体重做，并修好背景透明**。参照工作台《玥儿UI偏好设计指南》重写 `ui/assets/suggest-panel.css` 与标题：配色改薄荷绿主色 `#5dae8e` / 深墨绿压舱 `#3d8a6d` / 樱花粉 `#e89bb0` 只作点缀 / 米白暖底 `#fbf8f2` / 薄荷灰正文；标题换「解语花·知意」并改用**霞鹜文楷**（`ui/assets/fonts/lxgw-wenkai.woff2`，从工作台备份里找到的 44KB woff2 随包内嵌，不依赖外部字体链接），左侧配一支墨绿细枝 + 樱粉五瓣花的手绘感 SVG；圆角按尺寸分档（小控件 8 / 中等 12 / 推荐卡片 14 / 胶囊 999）；按钮三档音量（主=实心深墨绿「生成推荐回复」、次=浅薄荷底主色字「常用回复」「发这句」、三=纯文字「编辑常用」hover 才有底）；推荐句改成无虚线的小卡片（1px 极浅细线 + 柔和阴影）；滚动条换成细薄荷圆条；暗色模式另配一套。
  
  背景透明的病根：`html, body` 只写了 `min-height: 100%`，而 `html` 的百分比高度需要自身 `height: 100%` 才成立，**iframe 比内容高的那一截没被 body 背景铺满，露出透明、透出聊天背景**。改成 `height: 100%` 后整块铺满。
  
  文案：「正在拟…」改成「想一下…」，「已发出 ✓」改成「发好了 ✓」（用樱花粉，是全界面唯一一处粉色重色）。

- 2026-10-20 | 优化 | **面板改成整块铺满 + 常用回复可在面板内增删改**。实机反馈三处：面板画了自己的圆角框，框外是宿主容器的透明底（看着“背景纯透明”）、框内下方又空一块，空态那行还被裁掉半截；常用回复只能在设置页改。
  
  改法：① 面板不再画框（去圆角、边框、自己的底色），整块 iframe 与宿主容器同色铺满，透明缝和“框内框外”一起消失；② 高度估算加余量（最小 190、上限 460、每条推荐按 52 算），不再裁字；③ 常用回复在面板里可以直接管：点「编辑常用」进入编辑态，每条变成可改的输入框（改完失焦即存）、后面一个 × 删除，下方一个输入框 + 「添加」，存的是同一份 `recommendationConfig.quickReplies`，所以设置页那边刷新也看得到。
  
  新增路由 `POST /suggest-panel/quick-replies`（写配置，走 `normalizeQuickReplies` 归一化：去重、限 8 条、限 30 字）。「关闭面板」那行字是宿主自己渲染的关闭入口，App 侧改不了它的样式。

- 2026-10-20 | 新功能 | **面板改成「常用回复 + 生成推荐」两段，并加常用快捷回复自定义**。交互重做：点输入栏的知意按钮**立刻弹面板**（不再先调模型），面板里常有：① 常用回复一排小按钮，点一下直接发；② 一个「生成推荐回复」按钮，点了才调模型（也才花钱），生成完把面板调高；③ 生成出来的几句，每句可改字再发。常用回复内容在设置页新增的「常用快捷回复」里自己写（最多 8 条、每条 30 字以内，存 `recommendationConfig.quickReplies`），面板实时读配置，改了立刻生效。
  
  高度改成按内容估（`estimatePanelHeight`）：宿主给的是固定高度，报大了下面空一片、报小了要滚动，现在按「常用条数 + 推荐条数」估，并且生成后用 `ctx.userInteraction.updatePanel` 调高（不重挂、不闪）。面板内部去掉了那条 `max-height`，改由整块滚动。
  
  改动：`lib/recommendation-config.js`（`quickReplies` 字段与归一化、条数/长度上限）、`lib/suggest-panel.js`（状态带 `quickReplies`/`panelId`、`estimatePanelHeight`）、`index.js`（工具改为只挂面板不生成、新增 `POST /suggest-panel/generate` 路由、`GET /suggest-panel/state` 实时读常用回复、`PUT /recommendation-config` 收 `quickReplies`）、`ui/suggest-panel.html` + `ui/assets/suggest-panel.js` + `suggest-panel.css`（两段式新布局）、`ui/panel.html` + `ui/assets/panel.js` + `panel.css`（设置页常用回复编辑区）、`tests/recommendation-config.test.js` 与 `tests/suggest-panel.test.js` 相应用例。

- 2026-10-20 | 优化 | **推荐面板跟设置页打通，并加一个输入栏按钮开关**。三件事：① 面板里的条数与方向一律以设置页为准——条数直接用「推荐几条」（2/3/4，面板上限从 3 放宽到 4），方向不采信模型自己写的 `direction`，而是按设置里当前条数选中的方向顺序逐条标注；② 设置页「推荐回复」区新增一行「输入栏里的知意按钮」（显示/隐藏），存进 `recommendationConfig.inputButton`（默认开，旧配置不算关）；③ 面板里的「复制」按钮删掉——能直接改字，复制没用了。
  
  开关怎么真的生效：宿主里 `inputStatus` 是静态声明 + 按会话动态覆盖，所以「隐藏」得挨个会话盖 `visible=false`（`ctx.inputStatus.set`）；而新建会话没有覆盖、默认是显示的，因此还得在 `session_created` 事件里补一次。设置一保存就立刻同步，App 启动时也同步一遍。
  
  两个坑（都踩过）：**App 还在加载时不能调 `inputStatus.set`**——宿主此时还没把这个 App 的声明投影进贡献表，会抛 `has no declared input status item zhiyi-suggest` 并把装载带崩，所以启动同步延后 2 秒；**`ctx.bus.subscribe` 在测试 mock 里只保留最后一个 handler**，另起一个订阅会把知意原有的续接事件订阅顶掉（续接静默失效、app-tool 挂一条），所以 `session_created` 的处理合进原有那个订阅里。
  
  改动：`lib/recommendation-config.js`（`inputButton` 字段与归一化）、`lib/suggest-panel.js`（候选带方向、上限四条、高度 220、`pickDirection`）、`index.js`（显隐同步函数、设置保存后同步、`session_created` 合流、面板状态与发送按新结构、`PUT /recommendation-config` 收 `inputButton`）、`ui/panel.html` + `ui/assets/panel.js`（新开关）、`ui/assets/suggest-panel.js` + `suggest-panel.css`（去复制、加方向标签）、`tests/suggest-panel.test.js`（随结构更新）。

- 2026-10-20 | 新功能 | **推荐语改用自绘面板（inputPanels），横幅降级为回退**。实机发现横幅的根本局限：宿主渲染的 `inputBanner` 是固定高度的横条，宽度也固定，完整推荐语放不下（40 字标题把第二个按钮顶出屏幕右缘，16 字仍截断，App 名还跟按钮糊在一起），而 `inputBanner` 契约里只有 `sessionPath/bannerId/text/buttons` 四个字段，**没有高度或宽度参数**，拉不高也拉不宽。改用宿主 1.1.35-beta 的 `inputPanels`：内容是本 App `ui/` 目录里的 HTML，用 iframe 挂在输入框正上方，高度自己报（`presentation.height` 24~4096，另有 `collapsedHeight` / `expanded`），句子完整显示、可换行、字号间距自己定。
  
  改动：新增 `lib/suggest-panel.js`（面板状态读写、候选归一化、面板高度）、`ui/suggest-panel.html` + `ui/assets/suggest-panel.js` + `ui/assets/suggest-panel.css`（自绘板子，每句一栏 + 一个「发这句」）、`tests/suggest-panel.test.js`（7 条）；`index.js` 工具 `jiegehua.zhiyi_suggest` 改为「生成候选 → 存 app-data → `ctx.userInteraction.show` 挂面板」，并加两个后端路由 `GET /suggest-panel/state`（面板页自己读候选）与 `POST /suggest-panel/send`（点「发这句」→ `sendToConversation` 以她的口吻把那句发进这段对话）；`manifest.json` 加能力词 `app/input.panels`。
  
  降级：面板挂不上（权限没批 / 宿主不认）时自动退回横幅，横幅那条不需要额外权限，先前那套照旧能用。
  
  限制：App 侧读不到别的 App 的横幅（宿主只给了 `/api/apps/input-banners/interact` 写接口，没有列举接口），所以「同屏最多两条、事件型压过引导型」这类规矩在 App 侧实现不了，只有宿主层能做。

- 2026-10-20 | 新功能 | **输入栏多一个知意按钮，点一下就在输入框上方挂出推荐回复横幅**。宿主 1.1.35-beta 新增了 `contributes.ui.inputStatus`（8 月那版 SDK 文档快照里没有，所以按文档查不到），位置就是聊天输入框工具条中间那块空白（前端 `InputStatusItems.tsx`，`flex:1 1 0`，右边模型胶囊那排是 `flex:0 1 auto`）。manifest 声明一条 inputStatus（id `zhiyi-suggest`，icon `sync` 纯图标不给文字，title/tooltip 写悬停说明），点它走 ui-actions 通道调新工具 `jiegehua.zhiyi_suggest`；工具按当前对话拟几条推荐语（复用 `lib/recommendation.js` 的 `generateRecommendations`，不另写 prompt），用 `ctx.inputBanner.set` 挂成输入框正上方的横幅，横幅按钮用 `post-message`：点哪条就以她的口吻把哪条发出去，伙伴当场接话。
  
  改动：`manifest.json` 加能力词 `app/input.status` 与 `contributes.ui.inputStatus`；`index.js` 加 import 与工具注册（走 ui-actions 通道，不进模型车道，模型看不见这个工具）；新增 `lib/suggest-banner.js`（横幅构造：按钮 ≤3、按钮标题 ≤40 字按字符数截断、横幅正文 ≤200 字、注入用完整原文而不是截断标题）；新增 `tests/suggest-banner.test.js`（8 条）。
  
  限制（都是宿主定的，不是没做）：图标只有内置的 check/pin/sync 三个，做不了自定义图形；每个 app 每个会话只留一条横幅，重复 set 是原地替换；宿主公开的 bus 事件里只有 `input_banner_set` / `input_banner_dismissed`，没有横幅按钮点击那一档，所以没做「换一批」按钮——想换一批再点一次输入栏按钮覆盖即可。
  
  验证：`node --test tests/suggest-banner.test.js tests/suggestions.test.js tests/recommendation.test.js` 27 通过 / 0 失败；`node --experimental-vm-modules --test tests/app-tool.test.js` 61 通过 / 0 失败；`node --check index.js lib/suggest-banner.js` 与 manifest JSON 解析通过。未做：真实桌面点击验收（要用户开权限后点）、横幅按钮点击后伙伴接话的实机对证。

- 2026-10-20 | 新增 | **朗读加第三种协议 `speech`（自建 / 第三方标准 TTS）**。走 `POST {baseUrl}/audio/speech`，覆盖 GPT-SoVITS、CosyVoice、Fish Speech、kokoro-fastapi、openai-edge-tts 这类部署。
  
  改动：`lib/voice.js` 协议枚举加 speech（未知值仍落回 chat）；`voicesForProtocol("speech")` 返回空数组，音色改手填；`voiceIsConfigured()` 在 speech 下不要求 Key；`voiceRequestHeaders()` 改读新的 `authStyle`（bearer / api-key / none），空值走原有“按 providerId 猜”以兼容老配置，MiMo 用户不会被默默改成 Bearer；新增 `postBinary()`，用 `response.arrayBuffer()` 取字节，没暴露时退回 latin1 文本读法并在遇到非字节字符时报错；mp3 被拒（400/415/422 或回 JSON）时只退一次 wav，401/404/5xx 不重试；404 / 401 / 429 / 5xx 都给中文人话。
  
  UI：`panel.html` 协议多一个「自建 TTS」按钮，新增「Key 怎么带」四档，Key 占位在 speech 下改提示；`index.js` 的 `voiceLibrary` 补 `speech: []`，预设加「本地 / 自建 TTS」（127.0.0.1:9880 + tts-1，authStyle=none）；修掉「音色目录读不到了」在 speech 下的误报。
  
  验证：`node --test tests/voice.test.js tests/voice-routes.test.js tests/app-tool.test.js` 84 通过 / 0 失败 / 2 跳过（新增 speech 字节、退格式、鉴权头、无 arrayBuffer 兜底、老配置兼容五组用例）；`node --check` 三个文件通过。真机：本机起了个 mock `/audio/speech`（返回真 mp3）供手动「测试一下」，真实自建 TTS 未接（用户手上只有 MiniMax 与 MiMo）。`allowedHosts` 未改（speech 走本机/私网，`allowLocalhost` 已开）。

- 2026-10-20 | 优化 | **语音设置按用途拆成两处**（用户反馈：音色和收藏不该埋在设置里）。主页面新增「念出来听」区块（页面末尾）：朗读开关、念哪一段、语速、默认音色、逐伙伴音色、语音收藏。设置弹窗里那一块改名为「语音服务」，只留预设、协议、地址、模型名、GroupId、Key、鉴权方式、用 Hana 凭据、测试与保存、试听播放器。
  
  边界：朗读开关、范围、语速也算日常偏好，跟着音色一起挪到主页面；只有“跟哪个服务说话”算服务配置。元素 id 全部不变，`panel.js` 与 `scripts` 无需改绑定；已校验无重复 id、section 开闭平衡、面板相关测试全绿。

- 2026-10-20 | 优化 | **传音樱 Ask 弹窗可读性重做 + 整条选项可点**（用户反馈：字小又密、点选项里的小字没反应）。
  
  点击热区：`AskOptionFrame` 新增 `clicked` 信号与 `mousePressEvent`，说明文字和「推荐」徽标设 `WA_TransparentForMouseEvents`，鼠标事件落到整条胶囊上。以前只有标题 `AskChoiceLabel` 绑了点击，点下面的小字没反应，看起来像「这个选项点不中」。
  
  排版与字号：问题区去掉灰底块（15px、ink 色，不再像一条糊住的灰带）；背景 11→12px、建议块 11→12px、选项标题 13→14px、选项说明 11→12px、补充说明输入框 9→12px、按钮 11→12px；正文与选项间距 8→10/9；卡片圆角与内边距统一放大，选中态改成 2px 主色边框 + 左侧色条。
  
  文案精简：标题不再加「本题 · 」前缀，且与题干重复时自动隐去；单选提示从「单选 · 已选 0 项 · 可补充说明后确认发送」缩为「单选 · 已选 0」，多选缩为「可多选 · 已选 0/2」；输入框占位从长句缩为「补充说明，可不填」。
  
  模型侧：`lib/ask.js` 给 title / question / background / recommendation / reason / options 补上字数指引（标题 6-14 字、问题 20-40 字、选项 8-14 字、说明 20 字内），`lib/ask-guidance.js` 追加一句「Ask 是窄弹窗，文案要短」。硬上限未动，超长仍能通过工具校验，只是描述层面引导写短。
  
  验证：`node --test tests/ask.test.js tests/card-template.test.js tests/app-tool.test.js` 63 通过 / 0 失败 / 2 跳过；`python -m unittest test_ask_dialog` 24 通过（新增「点选项整条也能选中」用例，并改掉断言旧提示文案的一条）；`node --check` 与 Python ast 通过。界面未实机验证。版本号、简介、README 均未动。

- 2026-10-20 | 优化 | **知意 Ask 配方卡同步精简**。`recipes/zhiyi-ask/assets/ask.card.html`：提示从「单选 · 已选 N 项 · 可补充说明后确认发送」缩为「单选 · 已选 N」、多选缩为「可多选 · 已选 N/2」；补充说明标签缩为「补充说明 可不填」，占位改「还想补充什么？」；题干 14→15px、选项标题 14→15px、说明 11→12.5px、输入框 12→13px、按钮 12→13px；选项内边距与圆角放大，选中态加 2px 边框与左侧色条；标题与题干重复时隐去标题。
  
  全局安装的那份（`C:\\Users\\laotv\\.hanako\\recipes\\zhiyi-ask`）已经过扩展管理工具重新安装（hash 与 App 内源码一致）；旧卡不热更新。实机验收（当天午后）：新卡发到会话后可作答，点小字与整条空白均能选中，确认后 `zhiyi_ask_answer` 事件回传成功（choice=先这样用着）。

- 2026-10-20 | 修复 | **传音樱不再跨 Hana 生命周期自动恢复**。之前只记 `ballDesired`，所以用户开过一次之后，退出 Hana、重新打开、甚至电脑重启，球都会自己冒出来；分享版用户装完只要碰过一次球就被永久授权。

  改法：新增 `ballHostPid`，落球开启意图时一并记下 `process.ppid`。app 是宿主主 server 直接 spawn 的子进程（实测中间无其他层级），所以 ppid 就是这一次的宿主身份。app 加载要恢复球时先比对：`ballHostPid === process.ppid` 视为同一宿主才恢复（保住 2026-10-19 那个「reload 后球没了」的坑）；不等则视为 Hana 重开过，不自动起，并把 `ballDesired` 改回 false。`ballHostPid` 缺失也按「新宿主」处理，宁可少自动一次。

  实机验证：`process.ppid=27992` 与进程树查到的真实父进程一致；门禁生效后日志记「传音樱没自动恢复：Hana 已经重开过…」，`ballDesired` 落成 false。**待收尾**：验证时球仍被知意以外的组件反复拉起（父进程是宿主主 server，不是 app；知意自己没打任何启动日志），怀疑是闲不住的融合协调器读 `ball-bridge.json` 后去拉球，但未拿到直接证据。「球完全不自动出现」这个目标尚未达成。

- 2026-10-20 | 修复 | manifest 补声明 `app/agents.read`，此前「朗读伙伴名单」读不到、一直退回用会话名单冒充；因为 manifest 里根本没列这条能力，设置页也不会给出开关，表现为「找不到权限项」。

- 2026-10-20 | 修复 | **真关机昨晚静默失败，根因已找到并修好**。现场：2026-10-19 23:46:44 判定成立进倒计时，23:51:45 发出关机命令，日志写着「已发出」，但系统事件日志里 23:51 前后一条 1074 都没有，本次开机时间仍是 10-19 06:35——机器根本没收到请求。

  根因：Hana 给 App 子进程的环境是裁剪过的，`SESSIONNAME`、`COMPUTERNAME` 都是空的，`shutdown.exe` 靠它们干活，缺了直接报 203「系统找不到输入的环境变量」，而当时那段代码带 `detached` 又不监听输出，退码非零也没人知道。两种猜测被排除：补单一个 SESSIONNAME 没用；绝对路径、经 cmd 转一道也一样；补全一组常用变量后 `/a` 立即返回 1116（命令真的执行了）。

  修法：`buildShutdownEnv()` 只补缺不覆盖；spawn 去掉 `detached`，监听 `error`/`exit` 并把退码与 stderr 写进记录和日志。新增 `test-shutdown`（真发 `/s /t 120`，验证用）与 `probe-shutdown`（只跑 `/a`，无副作用）。实机验证：`test-shutdown` 退码 0，系统事件日志出现 1074「关机类型: 关机」，随即 `/a` 撤销（退码 0，1075）。**发布前必须删掉 test-shutdown 这个测试入口。**

- 2026-10-20 | 新增 | **守门人的复盘时间线**。昨晚只知道「一直忙到 23:36」，查不出是谁在拦。现在 `summarizeSnapshot` 会把活跃后台任务单独列出来，`noteBusyChange` 在「忙的指纹」变化时记一条（忙→空必记，其余变化最少隔 15 秒），落 `sleepGuardTimeline`（最多 300 条，arm 时清空）。`status` 会把最近 40 条渲染成 `07:37:47 忙 3 处：窗口 xxx（小花）` 这样。实机已验证能记下三个窗口在忙。

- 2026-10-19 | 新增 | **「活干完帮我关」的守门人（演练阶段）**。需求原话：困得要死但某个窗口还在传应用、跑子代理，想让它干完之后自己关机。

  三层拆开：`lib/idle-watch.js` 只管采样（会话名单 + 近十分钟有动静的会话状态 + `tasks.list` 后台任务）；`lib/sleep-guard.js` 只管判定与状态机；`lib/idle-probe.js` 退化成开发期观察壳（纯采样 watch，发布时可整份删）。判定以**任务层为主、会话层为辅**——2026-10-19 实机测到：子代理在跑时主会话空了两分十五秒，会话层什么都没看见；同一个子代理在任务列表里从头到尾挂着 `running`。任务层读不到时按「不空」处理，宁可永不触发。

  对外只有一个工具 `jiegehua_zhiyi_sleep_guard`（arm / status / cancel），默认 10 分钟静默、最多守 4 小时。**真关机开关在代码里焊死**（`REAL_SHUTDOWN_OPEN = false`），arm 时传 `dryRun:false` 会直接抛错；到点只写一笔记录、发一条系统通知「本来该关机了」。新增权限 `app/notifications.show`（仅用于这条提醒）。状态落 `sdk.storage`，App 重载后会接上（计时从重挂重算，中间断过那段看不见，不凭空算数）。

  验证：`node --experimental-vm-modules --test tests/app-tool.test.js` 61/61 通过；`index.js`、三个 lib 文件以 `.mjs` 副本 `node --check` 通过；manifest JSON 解析通过。未跑全量、未做实机验收。版本号未动。

- 2026-10-19 | 开发探针 | **新增只读空闲探针 `jiegehua_zhiyi_idle_probe`**（自动关机功能的前置验证，未对外）。`lib/idle-probe.js` 采样 `session:list(scope=all)`、对最近有动静的会话逐个查 `session:context`（streaming / compacting / pendingMessageCount），再尝试 `tasks.list({scope:"all"})` 记录后台任务状态；支持 snapshot / watch（定时写 JSON 行日志）/ stop / list。全程只读，不写会话、不改设置、不发任何关机命令。

  目的：先确认宿主是否允许 App 看见其它窗口的忙闲，以及「主回合已结束但子代理仍在跑」时状态表现如何。**发布前必须删除**本文件、`index.js` 顶部的 import 与对应工具注册块。版本号未动。

- 2026-10-19 | 移除 | **「等 ta 说完再发」整块下线**（用户确认）。这个功能的全部前提是“忙碌时发消息会打断当前对话”，而宿主从 v1.0.0-beta（2026-10-06）起已经原生做了输入排队，当前 1.1.24-beta 的渲染层里确实有 `inputQueuedSubmissions` 队列与「仍有消息在排队」的提示。前提没了，留着只会让用户纠结“在输入框发还是点球写一句”。另外「这句排 N 轮」本身场景也极窄：能干的只有“我数几轮、不许你自动停”，而那是旧版 loop 误停的补丁，不是独立需求。

  删掉的东西：`QueueInsertDialog` 整个类、主面板 `queue_tool` 工具行与「写一句」入口、`_open_queue_insert`、球的拖动跟随与关窗联动、`bridge_polish_call` 的 `rounds`、`index.js` 的 `queueLoop` 状态机与 `queue`/`queue-cancel` 两个 kind、`lib/queue-loop.js`、`tests/queue-loop.test.js`，以及四处测试用例。`bridge_polish_call` 的 `followUp` 投递能力保留，捋一捋窗的「发送/排队」照旧。

  历史记录写在项目根 `已移除功能记录.md`：当初的需求原话（2026-09-27 群里「能给他准备一百句请继续」）、为什么做、为什么撤、原实现清单、三条停止条件的语义、以及以后接回来的步骤。两个被删的 js 原文件另存在 `L:\哈娜的工作台\_临时\removed-queue-insert-20261019\`。

  验证：`node --test tests/*.test.js` 353 项全绿；`python -m unittest test_ask_dialog test_resume_dialog test_app_bridge` 88 项通过（1 跳过）；`zhujian_app.py`、`app_bridge.py` 与三个测试文件 ast 通过。未跑全量 Python、未做实机界面验收。版本、简介、README 不动。

- 2026-10-19 | 优化 | **「等 ta 说完再发」弹窗按旧解语花那一页整体重排**（用户要求“照旧的页面整个重做”）。上一轮把循环续接的勾选与轮数搬进弹窗、做成虚线卡片「或者，让 ta 自己接着聊」，结果窗里叠了两套轮数（「这句排 N 轮」与「最多续接 N 轮」），加上目标菜单展开就顶到输入框，整页看着堆。现在回到旧版形态：标题 / 副标题 / 发送到 / 目标信息 / 输入框 / 「这句排 [−] N [+] 轮」/ 一行说明 / 按钮，共 268x285（旧版 268x291）。

  具体：① 撤掉虚线卡片那块，循环续接的控件留在 `loop_controls` 不再被 reparent 进弹窗（引擎、状态行、主面板停按钮都没动，只是这个窗不再摆它们；目前没有别的可见入口，待用户定位置）；② 补回说明行（1 轮 = 「只说这一次，跟以前一样」，多轮 = 「每轮说完接着发，共 N 轮」）；③ 副标题字号 11→10px，不再折成两行；④ 目标菜单抬头补上「排到哪段对话？」（之前沿用推荐面板的「推荐回复参考哪段对话？」，旧版有这句，知意版漏了）；⑤ 轮数框 42→28 宽、数字右对齐，目标按钮补 min-height 22，输入框字号降到 11px。

  验证：离屏渲染 268x285（目标菜单展开 268x392，内容不被遮挡）；`python -m unittest test_ask_dialog test_resume_dialog` 55 项通过（1 跳过），其中原「弹窗接手循环设置」用例改为「不再接手」，并断言说明行随轮数变化。未跑全量、未做实机界面验收。版本、简介、README 不动。

- 2026-10-19 | 优化 | **断点续接在界面上冻结（引擎保留）**。当前 Hana 版本里真断联极少，今天实机弹出的九次全部不该打扰用户：子代理会话四张（空抬头）、deepseek-v4.1-flash 被 429 限流两张（17:10:57–17:15，额度到 2026-10-20 09:43 重置，窗口看着在跑其实一个字没吐出来）、宿主自己在重试两张。所以决定先把这个功能对用户收起来，代码整套留着照跑。

  冻结的只有可见性：判定、记账、日志全在，只是不往设置页和传音樱上送（`pushResumeNotice` / `pushResumeFlash` / `pushResumeProgress` 三处早退）。设置页那一整段默认 `hidden`，并且冻结时连设置与结果都不去读。循环续接与排队插话是两套开关，不在冻结范围内，没动。

  解冻入口：设置页标题「知意」连点五次 → 出现暗号输入 → 填对才恢复显示，再填一次重新收回去。暗号只存 SHA-256，源码里没有明文；期望哈希允许本机存储 `resumeUnfreezeHash` 覆盖（只为自动化测试与本机自定暗号，默认仍是代码里那个）。冻结时会把球上可能已挂着的旧小条、闪报、进度一并收掉，球桥对 `enabled:false` 保留循环续接那一套，所以循环提示不会被带走。日志文案同步改成「续接用尽（冻结中，未推界面）」，不再谎称已提醒。

  **重启这个功能前必查两处**（今天查明、这次没修，因为界面反正不显示）：
  1. 判定异常后只等 `RESUME_AUTO_DELAY_MS = 4 秒` 就报，不复核那段对话后来有没有自己好起来；而今天宿主的实际重试间隔是 60 秒（被上限截断），门槛跟真实节奏对不上，于是「宿主正在重试」这道防线根本没来得及生效。卡住路径有 `session:list` 复核，异常路径没有。
  2. 重试延迟由代理给出，`Server requested 59432s retry delay (max: 60s)`——真实重置时间是次日上午 9:43，这个数字算错了，宿主截到 60 秒后一直空转到明天。属代理侧问题，不在知意代码里。

  验证：`node --experimental-vm-modules --test tests/app-tool.test.js tests/voice-routes.test.js tests/resume-watch.test.js` 121/121；`tests/continue-loop.test.js tests/card-handoff.test.js tests/ball-bridge.test.js tests/ball.test.js tests/queue-loop.test.js` 52/52；`index.js` 与 `ui/assets/panel.js` 以 `.mjs` 副本 `node --check` 通过。新增用例：默认冻结且整段隐藏且不读设置/结果、错暗号 403 且状态不动、标题连点五次才露入口、暗号对了才解冻并补读一次、按钮发的是「想切到的状态」而不是当前状态。Python 未改动，未跑 Python 套件；未做实机界面验收。版本、简介、README 均未动。

- 2026-10-19 | 修复 | 回复行朗读改成**不依赖传音樱**（实机反馈：不想把播放挂在球上）。回到宿主 `details.audio` 播放，同时把 TTS 码率从 128kbps 降到 64kbps：同样是 555 字，base64 从 2MB 级降到 904KB，排除「音频太大导致 `new Audio(data:...)` 静默失败」这条。桥上的 `/voice/play` 与球端轮询**没删**，以后要切回球播放，在工具里改一个分支就行。

  按伙伴分音色这件事后端早就支持（`voiceConfig.voiceByAgent` + `resolveVoiceIdForAgent`），设置页也已有「给伙伴分开选音色」那一块（`panel.html` 的 `voice-partners`，每个伙伴一行，可选「跟随默认」）；回复行朗读工具会从 `context.sessionPath` 里认 agentId，取的正是该伙伴的音色。本次只改播放链路与码率。

  验证：`node --test tests/voice.test.js tests/voice-routes.test.js tests/app-tool.test.js` 80 项（78 通过、2 跳过）；`node --check` 通过；重载后直接调 ui-actions 返回「朗读 555 字」、`details.audio.dataBase64` 长度 904688。是否真出声仍待点击确认。

- 2026-10-19 | 修复 | 回复行的「朗读」按钮点了没声音。查宿主渲染代码：前端拿到 `details.audio` 后是 `new Audio(data:...).play()`，而且 `play()` 的 Promise **`.catch(()=>{})` 直接吞掉**——Electron 的自动播放策略一拦，表现就是静默失败，半点提示都没有。

  现在出声改交给传音樱：桥新增 `POST/GET /voice/play`（路径 + 序号），球每 1 秒轮询一次，用 QMediaPlayer 播放（不受浏览器那条限制）；工具合成后先 `saveClip` 再把路径交给球，宿主 `details.audio` 只作「球没开」时的回退。顺带把球上的「念给我听」入口隐藏（代码保留）——朗读已经在前台操作行了，两套并存只会让人不知道点哪个。

  **图标改不了**：宿主对 `messageActions` 的渲染是 `icon: createElement($T)` 硬编码的一个内置图标组件，`manifest` 里的 `icon` 字段根本读不到（校验函数也只认 id/title/toolName/messages/args）。所以那个「太阳」形图标是宿主给所有消息按钮的统一外观，除非宿主自己改。

  验证：`node --test tests/app-tool.test.js tests/voice-routes.test.js` 68 项（66 通过、2 跳过）；Python 95 项（94 通过、1 跳过）；两处 ast.parse 与 `node --check` 通过。实机：直接调 `/api/apps/jiegehua-zhiyi/ui-actions/invoke` 返回「朗读 555 字，已交给传音樱播放」，桥 `/voice/play` 的 seq 从 0 变成 1 并带上了落盘路径；是否真出声待听感确认。

- 2026-10-19 | 新功能 | **朗读改到每条回复的操作行**（实机反馈：不该塞在悬浮球菜单里）。查宿主文档确认 v2 支持 `contributes.ui.messageActions`（最多 2 条，点击调用本 App 自己注册的工具，工具返回 `details.audio = { mimeType, dataBase64 }` 时宿主直接播放，就是官方 TTS 示例的形状）。

  实现：manifest 加 `contributes.ui.messageActions`（id `read-aloud`，标题「朗读」，只看助手消息，toolName 用 `jiegehua.read_aloud`）；`index.js` 注册同名工具，从 `args.context.messageText` 取整条正文 → `prepareSpeakText` → `synthesizeVoice` → 回 `details.audio`，音色按会话路径里的伙伴 id 分，超 8MB 或没开朗读功能都给中文提示。工具名故意带点：模型工具车道只收 `/^[a-z][a-z0-9_-]*$/`，所以这个工具不会被模型看到，只走 ui-actions 通道（重载日志已实测 “skipping ... from the model tool lane”）。

  同时修了上一轮朗读窗的两个尾随问题：① App 推回复列表时以前不传 sessionId，永远取最近活跃会话，所以固定了 A 却念 B——现在按 `ballTarget` 的固定状态取，名字从会话名单补全；② 球上的文字区套了滚动区（以前是死限高 132 的 QLabel，下半截看不到也滑不了），选中回复就先把正文摆出来（每条带 1200 字预览，超过注明只摆开头）。

  验证：`node --test tests/app-tool.test.js tests/voice-routes.test.js` 68 项（66 通过、2 跳过，含新增「朗读列表按固定目标取」）；manifest 与 `node --check` 通过；重载后日志确认 `1 message action(s)` 已注册。未调真实 TTS、按钮未实机点击。版本、简介、README 不动。

- 2026-10-19 | 修复 | **传音樱老是消失**（重载 App 就掉，掉完不自己回来）。根因两层：① App 卸载/重载时旧实例会把球当普通子进程杀算，新实例不记得用户想要它开着，于是每次改完东西都得人手点一次；② 球如果真的意外退出，代码只 `setStopped` 记一条 warn，不会重启。

  现在：① `lib/ball.js` 的退出回调带 `intentional` 三态（`user` / `shutdown` / `unexpected`），`stop({ forShutdown: true })` 专給卸载/重载用，不会改动「用户想让它开着」这个意图；② 意图落盘为 `ballDesired`（球启成功、`/ball/start` 写 true，`/ball/stop` 与用户亲手关球写 false）；③ App 加载完读 `ballDesired`，延 1.2 秒把球恢复回来；④ 意外退出时，如果本来就要球开着，按 2s/5s/10s 退避最多重启三次，并在日志写明几次；⑤ 退出日志把退出码与「意外/用户关/随 App 卸载」写进正文（以前 code 只在 detail 里，宿主日志看不到）。

  测试：`ball.test.js` 新增 2 条（启动成功会通知上层；退出三态分得清），`ball + app-tool + resume-watch` 98 项（96 通过、2 跳过）。**没做单实例锁/孤儿球接管**：如果 App 被强杀、旧球还在，新实例恢复时理论上可能短暂双球，这一点未验证也未处理，下次遇到再补。版本、简介、README 不动。

- 2026-10-19 | 修复 | 朗读直接报 `Plugin network.fetch response exceeded 1048576`：manifest.network.maxResponseBytes 还停在 1 MB，而朗读一次最多 800 字，32kHz/128kbps 的 mp3 就是 3 MB 上下，回到 JSON 里还有 base64 膨胀，必然撞墙。代码那边请求的 4 MB 反而被 manifest 的 1 MB 盖住，两边对不上。现在 manifest 与 `lib/voice.js` 的 `SYNTH_MAX_RESPONSE_BYTES` 统一到 8 MB（注释写明改一处就得改另一处）。另把宿主那句英文原话转成人话：「这段太长，合成出来的音频超过了单次能取回的大小。截短一段再读，或者把设置里的「最长朗读字数」调小」，不再把 `response exceeded` 直接甩到面板上。测试：voice/voice-routes 34 项全过（改请求上限断言 + 新增超限文案用例）；未调真实 TTS、未真机复测。版本、简介、README 不动。

- 2026-10-19 | 修复 | **断点续接把子代理会话当成了「用户窗口没说完」**（实机：12:24、12:31、13:00、13:07 连弹四张续接卡，抬头全是「来自：今天 X 开的那段对话」，没有任何标题）。查 session-manifest：这四条分别对应 04:24:03、04:28:06、04:57:46、05:04:44 创建的 `domain=subagent / kind=subagent_child` 会话（owner 都是绯月），是伙伴派出去干活的子代理，不是用户窗口。

  **走的是异常信号那条路，不是 90 秒卡住兜底**：卡上写的是「这一轮没能正常收尾」，只有 `reason` 非空才会这么写；子代理当时用的 MiniMax 一直在报 `The model provider could not complete the request.`（账本 05:42-05:48 连续 error，子代理会话里 5 次空正文 `stopReason: error`）。顺序是：子代理报错 → `parseResumeSignal` → `onAbnormal` → 待决 → `report`，不需要等 90 秒，所以 12:24:03 创建的会话 12:24:26 就弹了。之前只看「卡住兜底」，漏了这条 23 秒就能触发的主路。

  修法：新增 `isSubagentSessionPath` / `isSubagentSessionTarget`（路径含 `subagent-sessions`、`kind` 为 `subagent_child`、`provenance.createdBy=subagent`，真实路径上主要靠前两条），`buildSessionIndex` 补存 `kind` 与 provenance；事件入口、`agent/before-start`、`messages/post-assistant`、`auto_retry_start` 与异常信号两个分支、pump 复核处全部加过滤，认出子代理直接 `forget` 并清 `resumeSignals`/观察记录。

  **第一版不完整，已补**：最初只在事件入口按 `sessionPath` 挡了一次，加上钩子与卡住复核。审查伙伴指出两个缺口：① 信号分支在 `sessionPath` 为空时（历史已知现象）入口正则匹配不上，拿到 target 后没有第二道判断，仍会 `onAbnormal` 记账；② `buildSessionIndex` 没搬 provenance，而 `session:list` 本来就不带这一列，所谓「三条识别」实际只有 path 与 kind 两条在跑。现已补上 target 级判断（`auto_retry_start` 与异常信号两处）、provenance 透传与注释。

  另给卡住兜底加二次确认：第一次复核看到没进展只记观察窗，再过一个阈值仍没进展才报告（长思考/长工具轮本来就不写盘，一个 90 秒窗口太短）。

  传音樱侧：自动弹面板时先把球 `show` 出来、按球的位置重新定位再显示（以前只 `show()`，用的是面板上次坐标，会出现「只看得到一张续接窗，找不到球」）。

  验证：新增 3 条 Node 用例（子代理三种识别、kind 带进索引、无路径事件下子代理报错不记账），并把「确证没进展仍会报」改成两段断言。**把信号分支那条判断临时去掉复跑，「子代理报错不进账本」会失败（sendCalls 1≠0），说明用例真能复现修复前行为**。子代理会话文件时间线也核对上了：04:24:03 创建、04:24:12 第一次 `stopReason:error`、04:24:26 弹卡，是 14 秒后的异常信号，不是 90 秒卡住。`node --test tests/app-tool.test.js tests/resume-watch.test.js tests/continue-loop.test.js` 87 项（85 通过、2 跳过）；`test_resume_dialog test_ask_dialog test_app_bridge` 95 项（94 通过、1 跳过，预览用例未指定目录）；`node --check` 与 ast.parse 通过，无 `.pyc`。未全应用回归；版本、简介、README 不动。
- 2026-10-19 | 优化 | 快速档测试结果明确显示“测试通过”、秒级耗时与中文思考档；默认档不再夹带失败口吻，接口返回0时不再宣称实际思考用了0 token。后端保留原始effort值供前端统一呈现；不改变实际模型、思考参数或保存选择。确认本次真实6luna短任务成功，耗时3595ms，账本思考用量未报告；界面与路由直接相关18项通过。速度策略仍待核宿主默认行为，不以文案改善冒充提速。版本、简介、README不动。

- 2026-10-19 | 修复 | 快速档“测试一下”严格使用界面当前未保存选择，不再优先拿已保存的快速模型；选“跟随”时测试Ask判断模型，测试不保存选择。所选模型已不在目录时拒绝测试，不静默换当前模型。三个路由用例修前均失败、修后通过，快速档/速览/标题直接相关47项通过。正式应用已重新加载，实际6luna短任务待界面点击验证；此前服务商泛化报错原因未明，未声称已修复。版本、简介、README不动。

- 2026-10-19 | 修复 | 一级面板的目标标题与改名反馈超长时不再撑宽整个滚动内容，避免“不用管”返回后工具卡片右侧、按钮被裁切。两条说明改为可见宽度内单行省略、悬停看完整文本，不改真实标题或操作数据；明确忽略文本的横向最小尺寸要求。新增主区隐藏时更新长标题/反馈再返回、反馈单独撑宽回归，修前复现内容776px超出304px视口，修后内容与视口同宽。相关Python55项中54通过、1可选截图跳过；实机需重开球确认。未全量回归或调用模型，版本、简介、README不动。

- 2026-10-19 | 修复 | 一级面板定时尺寸同步不再先 adjustSize 缩小、再按内容撑回，避免右侧滚动条瞬间出现又消失。主视图直接计算最终高度，续接专页保持原尺寸路径；真正超高时仍保留滚动。先用尺寸事件复现三轮同步产生324→522的六次缩放，再修复验证无面板/视口缩放与滚动条显隐事件。相关 Python 53项中52通过、1个可选截图用例跳过；未全量回归，真实桌面重开球后待验。版本、简介、README不动。

- 2026-10-19 | 恢复 | 一级面板的目标选择区按旧版解语花恢复：内嵌向下展开、透明无边框容器、实心绿色选中模式与实线候选行；撤回本日浮层和后续按钮重绘方案（下两条保留为过程记录，本条取代其目标选择样式）。保留现有 App 目标请求、候选缓存、固定行高与防挤压措施。恢复内嵌后定向复现 Qt 沿用旧行分配导致推荐区重叠，尺寸稳定后重新登记原位置的目标菜单布局项解决；不手工移动后续控件。相关 Python 界面模块 25/25 通过，旧版 QSS 逐字一致，离屏预览与交叉复核通过；实际球需关闭重开后验收。未全应用回归、未调用模型，版本、简介、README 不动。

- 2026-10-19 | 优化 | 候选浮签的按钮换回面板那套手帐语言（实机反馈：这一版按钮跟整体弹窗格格不入）。之前浮签一改成浮层，里面的样式就显眼地“现代”了：模式按钮是实心绿胶囊、候选行是实心底居中字。现在改为：模式按钮透明底细描边（选中只换字色+边色+淡底，不填实心绿），候选行用淡底+虚线边跟面板里的卡片同一套手法、字靠左；「还原」按钮的字号从 10 提到 11、圆角从 10 收到 9，跟旁边的次要按钮对齐（它只有 10px 字，单看就比周围小一号）。

  顺带修了一个只有在列表面板里才看得到的毛病：`_sync_ui` 新建的候选行默认是隐藏的，布局当它们不存在，浮签高度只算到 74，行就叠在一起。现在加进去就 `show()`，行高又是固定 30，浮签高度 274/行区 180 都准了。

  相关 Python 90 项通过；未跑 Node 侧与全量回归；版本、简介、README 未动。

- 2026-10-19 | 修复 | **「选择对话」把候选压成一条条、还叠在推荐卡上**（实机截图）。先按原状取证：面板只给了候选浮签 101px，而它自己要 300px，五行对话被平均压成 4~5px，后一行盖到推荐卡上；同一次还看到整块面板比内容矮。根因是两层叠一起：① 面板高度靠 `adjustSize()` 读旧 `sizeHint`，总比内容矮（同一层的 `sizeHint` 停在 517，布局真实 560）；② 这层布局在「藏在里面的控件忽然显示」时不肯把外层重排，于是子行被往外挤。

  两处一起改：① 主区套一层滚动容器（无边框、透明底），`_fit_to_content` 按内层布局真实高度定面板高度（上限仍受提问页封顶与屏幕高度约束），装不下就出滚动条、不再压行；② 候选浮签整个从布局里拿出来，改成贴在「当前对话」那行下面、盖在内容上的浮层（自绘不透明底），展开与收合不牵动面板高度，就不可能再被压；行高改成 `setFixedHeight(30)`，QSS 的 min-height 只管样式、布局照样能压。顺手把候选列表的旧行改成先 `hide()` 再 `deleteLater()`（之前要等事件循环回收，中间一帧旧行还浮在原位）。

  **实机状态诚实标注**：本次的叠化现象在修复前用离屏渲染复现过（面板 850 > 屏 800、浮签 101/300、行距 5px），修复后同一场景面板正常、五行各占 30px；但实际桌面球仍需重开传音樱才能验证。下面一条写的「面板偏矮」与本条共用同一套 `_fit_to_content`，不是两次独立改动。

  另：朗读窗、排队窗、润色窗里的目标浮签**仍是内嵌在各自布局里**，本次不改：它们内容短，暂未见到同样现象；若也挤压，照这个做法改成浮层即可。

  相关 Python 90 项通过（新增 3 条：浮签不在布局里且不改变面板高度、五行各自成形不重叠、浮签不出面板）；未跑 Node 侧与全量回归；版本、简介、README 未动。

- 2026-10-19 | 修复 | 传音樱「会话标题」那一行两处：① 「还原」原来竖着排在「生成新标题」下面，一出现就要把整行撑高，而这层容器在面板偏矮时会被压皱，按钮就掉到虚线框外面（离屏实测：整行 hint 135 被压到 86，还原落在 y=65、底边 95 越界）。改成同一行靠右排（还原在左、生成新标题在右），出现与否都不改变行高。② 点「生成新标题」只有按钮变「总结中…」，下面那行说明照旧，要等改完底部的反馈行才出声，看起来像点了没反应。现在开头就把说明换成「正在按这段对话想新标题…」（长度与原文一致，不撑高行）；「还原」也补了「退回中…」忙态并禁点第二下。

  顺带治了面板偏矮的真根因：`adjustSize()` 读的是容器 `sizeHint()`，而主视图那层的 `sizeHint()` 会停在旧值（实测 517 vs 布局真实 560），于是面板总比内容矮一截，行被压皱、底部反馈行被裁。`_sync_size` 补一步 `_fit_to_content`：按内层布局真实高度 + 面板上下边距定高，再按 `maximumHeight`（提问页封顶）和屏幕高度兜底。离屏实测面板高度由 576 补到 596，会话标题行拿回 86 全高。相关 Python 87 项（新增 4 条：同一行、面板长高、起名/退回的即时反馈）均通过，其中新增的 4 条是按修复前的实测现象写的；未跑 Node 侧与全量回归，实机待重开传音樱验证。版本、简介、README 不动。

- 2026-10-19 | 修复 | 循环续接判定不再只挂 `messages/post-assistant` 钩子。实机复现：启动 2 轮循环后一轮结束也没发「继续哈」，`done` 停在 0 且一直 running——同一时刻日志有 `hooks.onDecision("messages/post-assistant") adjudicator threw: App RPC concurrency limit reached`，钩子被宿主并发限制跳过（一天十几次），而一轮只触发一次判定，错过就永久卡死。现在 turn_end 事件也走同一条判定（抽成 `fireContinueLoop`，钩子与事件共用），并放在断点续接总开关早退之前——循环本来归 `loopEnabled` 管，不该被 `enabled` 拦住。两条路会前后脚到同一轮，用 `shouldJudgeLoop` 做 3 秒去重避免连发两声（窗口只用于分辨同一轮的两个信号，不影响正常轮次）。兜底路径依赖球启动，当前测试基建够不着，**仅靠实机验证**；去重规则与状态机均已补单测。相关 Node 80 项、Python 83 项通过。版本、简介、README 不动。

- 2026-10-19 | 修复 | 「等 ta 说完再发」弹窗三处：① 勾选框没给 indicator 样式，在该弹窗里渲染成深色实心方块，补勾选/悬停/选中三态；② 新块用 QSS padding 与布局边距叠加，轮数加减按钮压到虚线框上，改成布局 margins；③ 「取消」原本只关窗，排进对话的那一句仍会照发——有排队在途时按钮改文案为「取消排队」并真的撤，撤完才关窗。补两条用例覆盖「有排队/没排队」两条取消路径。相关 Python 83 项通过。版本、简介、README 不动。

- 2026-10-19 | 修复 | 「等 ta 说完再发」弹窗两个老毛病：① 没有背景。根因是这套二级弹窗的背景靠各自 paintEvent 手画（主面板/朗读窗/润色窗都有，QSS 里写的是 transparent），只有这个弹窗没画，QSS 的 background 在半透明顶层窗口上根本画不出来——实测改成 red/magenta 像素仍是全透明。补上与润色窗同款 paintEvent（阴影 + 面板 + 圆角），QSS 改回 transparent。② 拖动悬浮球时弹窗不跟随：该弹窗没纳入 Ball 的拖动跟随名单，补上 `_drag_queue_was_visible/_start` 的记录、移动与复位（与朗读/润色/压缩档案同款）。离屏渲染实测背景像素 #fbf8ef 不透明、弹窗 268x348。相关 Python 测试 81 项通过。版本、简介、README 不动。

- 2026-10-19 | 修复 | 循环设置暂存容器误 `setParent` 面板，导致它以默认 640x480 整个盖在一级面板上（勾选框与轮数行浮在面板左上，压住输入框与底部按钮）；子控件的 hidden 标志默认是「父显示我就显示」，不手动 hide 就会露出来。改为容器不给父、显式 hide；弹窗接手后布局实测正常（268x350，勾选与轮数均在弹窗内）。相关 Python 测试 81 项通过。版本、简介、README 不动。

- 2026-10-19 | 优化 | 一级面板底部的「正常对话循环」整块撤走：它和「等 ta 说完再发」本就是同一件事的两种用法（排一句给 ta / ta 说完自动接一句），且与排队窗的循环轮数属重复实现。勾选与轮数搬进「等 ta 说完再发」弹窗作「或者，让 ta 自己接着聊」一块，原有那个「循环」改名为「这句排」以区分；循环真的跑起来时，状态行与「停」仍留在一级面板，平时收起不占地方。控件先在主面板建好、弹窗打开时 reparent 过去，保存偏好、步进、状态渲染那套逻辑不重写；弹窗补齐对应控件的主题样式。相关 Python 测试 81 项通过（含新增「弹窗接手循环设置、状态行留在外面」两条）。未跑 Node 侧与全量回归。版本、简介、README 不动。

- 2026-10-19 | 说明 | 一级面板「断点续接 · 有待接提醒」入口本身按 `_resume_notice` 判断显示，无提醒时自动隐藏，无需改代码；当时看到它是因为验证时向球塞的那条伪造提醒还挂着，清掉即消失。两者语义区分：`✕` 是「收起面板，稍后再说」（延后），「不用管」才是「这条我不要了」（撤下提醒）。

- 2026-10-19 | 修复 | 断点续接专页删掉返回按钮后，✕ 关闭只是 hide 整个面板，专页仍处于 active，下次点球又原样开这张专页；改成用户亲手关闭时同时退回一级面板，提醒挂在一级面板入口上不丢，程序内部的收起（开子弹窗、答完题）不退回。补两条用例覆盖两条关闭路径。相关 Python 测试 80 项通过。版本、简介、README 不动。

- 2026-10-19 | 优化 | 断点续接专页重排：删掉「← 返回」（顶行只剩标题与一个 ✕，关闭按钮与传音樱其他弹窗右上角同一套样式）；续接设置不再折叠，常驻直接摆出来，面板高度上限由 420 提到 560，正常内容不再需要滚动；「继续哈」吃掉多余宽度、加粗放大当主角，「不用管」收窄降字重，体型上就能一眼分清主次。同时去掉面板左上角那个粉色装饰圆点（原先正好压在返回按钮上，看着像莫名的小红点）。相关 Python 测试 80 项通过，其中断点续接专页用例按新结构调整断言（常驻、叉叉、按钮宽度层级）；未跑 Node 侧与全量回归。版本、简介、README 不动。

- 2026-10-19 | 修复 | 推荐回复设置仍用已移除的card模式判断开启，导致选中传音樱、保存返回ball后却显示“已关闭”并套关闭样式。改为按ball判断，不修改实际配置或后端存储；补整文件界面启动与开/关保存回显测试。先复现首次加载和保存开启两条失败，再修复；相关界面14项、配置归一化7项通过。仅界面逻辑修正，无模型调用、无全量回归，版本/简介/README不动。

- 2026-10-19 | 新功能与修复 | 断点续接改为知意统一设置：总开默认关闭、开启后默认手动；自动发送独立于球，按窗口计数，最后一发需等待真实恢复判定。总关撤下断点提醒并让未发送与旧代任务失效，不影响正常聊天循环。移除球一级面板常驻续接入口，仅自动尝试时显示临时来源与次数；手动异常或自动上限后仍未恢复才弹专页，恢复/忽略后撤下状态。设置页显示无球情况下的来源与进度；球上配置补丁与主页统一，设置更新保留计数。修正手动0/N误标上限、恢复漏清等待状态、工具进展丢失最终检查、旧事件越代写回及同会话误清循环确认。移除设置页重复控制器/ID，补真实ESM整文件初始化与交互测试；开关开/关/禁用采用明确文字对比。相关Node188项、Python78项通过，交叉复核通过；另复验手动路由5项、离屏预览1项。本轮未向真实会话发送测试消息、未全应用回归，真实异常恢复与桌面球仍待验。版本、简介、README未改；此条取代10-18暂加常驻入口的方案。

- 2026-10-18 | 修复 | 断点续接不再用读取失败后沿用的旧会话索引证明“无进展”；来源不明、索引过期或必要时间缺失先等待。索引与新鲜度绑定，连续失败保留最近成功时间，补行为级集成回归与时间/错误码诊断。现场确认存在工具进行中误报，但缺当次复核快照，不能宣称已锁定唯一根因；名单超时与宿主并发限流仍待后续观察。
- 2026-10-18 | 优化 | 传音樱新增球内独立“断点续接”专页及明显入口，来源、原因、状态分明，继续/忽略操作固定底部，自动与有限次数设置单独收纳。推荐刷新和Ask互不穿透，失败留页可重试，桥登记请求只显示“已提交，等待确认”；保留既有默认与循环能力。离屏预览和相关回归已验，实际桌面仍需球重开检查。

- 2026-10-18 | 修复 | Ask 悬浮球与配方卡统一为“选项＋补充说明”一起发送，单选也先选择再确认发送；填写说明不再替代已选项。保留无选项时只写答案的用法，已选项仍校验数量限制。球的桥接新增独立 note 字段与长度/类型校验，卡片合并为同一个确认按钮；失败保留选项和说明。全局配方需正式确认更新，新卡才采用新模板。

- 2026-10-18 | 优化 | 传音樱 Ask 顶部来源标题改为动态“伙伴名 ·「窗口标题」”；缺失字段保守显示已有信息，不影响题名与回传。21:14 实机已收到上一轮球上自定义回答，证明该次回到原会话；消息未携带多选数组，暂不宣称多选验收通过。

- 2026-10-18 | 修复 | 传音樱 Ask 答案回传补声明 `app/session.start-turn`，与既有管理会话权限分别授权；发送异常保留原始 cause，避免只剩泛化“没发出去”。20:40 实机基线为球上作答后 session:send 被拒，当前授权记录缺少该项；补齐声明不等于授权，正式更新确认并授权后需新题复验，不能提前宣称送达。权限状态页同步展示该项。
- 2026-10-18 | 修复 | 传音樱 Ask 顶部大标题显示实际来源对话，题名单列在“本题”处；来源标题与伙伴名随锁定的来源会话编号透传，不再写死“知意关键提问”。缺失时不伪造来源。桥接与离屏界面测试通过，运行中的球需重新打开才使用新 Python 源码，实机待验。

- 2026-10-18 | 恢复 | **撤回 Ask 卡片当日新增的限高滚动排版，恢复 Git 基线的平铺外观**。此前多轮滚动修补出现空白、选项藏在限高区域及滑动滞后反馈，尚未验收，原条目所称已修复与当前源码也不一致。现仅撤回 `.scroll` / `.footer` 包装、280/170px 限高和关联矮屏规则；保留数值/选项形状兼容、标题缺失处理及原有单选/多选/回传逻辑，不回滚其他 App 功能。恢复前模板已有专项备份；全局 Recipe 通过正式安装入口更新，须在界面确认，旧卡不会热更新。**部分实机通过**：确认安装后单张新卡，四个选项、勾选/取消、底部输入与按钮正常，多选数组及补充说明经 resolve_card 核验有效。**未通过**：反馈「视觉上滑动还是有点拖沓」，根因待查；旧版长内容裁切未做长文本复验，不因回滚就宣称已解决。

- 2026-10-18 | 新功能 | **设置新增「快速模型」**，给速览、会话标题这类「要快不要想」的小功能单独一条。起因是 2026-10-18 上午实测：长回复速览 9 次尝试里失败 4 次，失败信息全是「简写模型没有返回正文」，成功的那几次耗时 1.1~2.7 秒。根因不是预算给少了，是压根没告诉模型这活不用想——`invokeTextModel` 往 `sdk.models.stream` 传参时压根没有 `reasoningEffort`，而速览跟随的是 Ask 判断那条 MiniMax-M3.1-Flash（带思考），推理模型的思考和正文共用一份 `maxTokens`，800 被思考吃光就一个字不吐。做法：新增 `lib/fast-model.js`，先试宿主标准档位 `off`；模型不吃（宿主抛 `APP_MODEL_UNSUPPORTED_REASONING`）就脱掉重发；空正文则同模型把输出预算翻倍并附「只输出最终可见正文」再试一次。**全程不换模型、不静默改用户选的 provider/model**——宿主已把 off/minimal/low/medium/high/xhigh/max 统一抽象成 `reasoningLevel` 并适配各家协议（DeepSeek 的 `reasoning_effort`、MiniMax 的 `thinking.type`、OpenAI 的 `reasoning.effort`），App 侧不写映射表（只能靠猜），本机模型目录也不公开 `thinkingLevels`，所以“先试后退”是这个接口唯一诚实的用法。自定义直连档没有这层概念，不发该参数。设置里配一条模型 + 「测试一下」按钮，测试跑的是真实短压缩任务并回报：用了哪档、试了几次、思考吃了多少 token、耗时多少。附带把 `usage.reasoning` 接进日志（契约里一直有，`readModelText` 以前只读正文把它扔了），下次空正文日志会直接写「思考吃了 612、正文 0」，不用再靠对时间戳猜。影响面只有速览与会话标题；Ask 判断、推荐回复、风格润色、捋一捋全部不动。测试：新增 `fast-model.test.js` 9/9，全量 301/301。**未实机验证**：三个目标模型（deepseek-flash / MiniMax-M3.1 / gpt-6-luna）关思考到底生不生效，需在设置里点「测试一下」实测。

- 2026-10-18 | 修复 | **知意 Ask 卡片一发出就显示「已过期」且一个选项都不渲染**。取证方式：扒 `show_card` 生成的 `session-files/<id>/index.html` 看实际写进去的 state。真相三条，全是宿主的序列化行为，不是调用方手滑：①state 里的**数值一律被写成字符串**（`"expiresAt":"1792282978972"`），而模板用 `Number.isFinite(snapshot.expiresAt)` 判过期——它对字符串返回 false，于是卡片一出生就判定过期、选项全 disabled；②`options` 传数组，生成出来是 `{"item":[...]}`，模板的 `Array.isArray` 检查直接落空；③`state.title` 会被提走当卡片自身的标题字段，从 state 里移除，模板读不到（只走 `show_card` 的 `title` 参数）。模板已修：数值统一先过 `Number()` 再用，`options` 认 `{item:[...]}` 兜底，读不到标题就不渲染空 h1（题干本身就是问题）。全局 recipe 与 App 包内两份模板都已改，并在 recipe 说明里记了这三条，改完需重装 Recipe 或重启 Hana 才生效。测试：`card-template.test.js` 的断言从「必须出现旧写法」改成「必须出现归一化写法、且不得再直接用 snapshot.expiresAt 比较」。**未实机验证**：重启后发新卡确认三处都正常。

- 2026-10-17 | 修复 | **速览「不听话」的真根因：模型自己在正文里写卡**。实测样本：一条 1359 字的消息尾部挂着 **4 张** `> **速览** · 原文 N 字`（607/890/309/1216 四个不同数字），而 `replaceSummaryBlock` 每次先剥再贴、永远只留一张——能叠成这样只有一种解释：模型写正文时顺手写进去了，连字数都自己编。而卡片上那串字数就是它自己写的，跟知意判定的 `check.chars` 不是一回事，所以「卡上 383、日志说 478」这种对不上不是逻辑错，是两个来源。上一版只在「不够长」时清卡，够长时靠 `replaceSummaryBlock` 自己剥，两条路都盖不到「模型自己写的卡」。现在改成**无条件先清卡再判断**：`stripSummaryInMessage()` 先拿掉全部卡，剩下的字数才算阈值；不够线且原来有卡就返回清理后的消息；超过一张时额外记一条 `已清掉` 日志当脚印。另外查实：知意**从未注入过任何「写速览」的提示词**，模型是照历史回复里的格式自己学的；速览用知意自己配的模型（当前 MiniMax-M3.1-Flash），与主对话模型无交互，不存在两个模型打架。测试：新增 1 条（多张模型自写卡能一并清掉），全量 284/284。**未实机验证**。

- 2026-10-17 | 修复 | 旧速览卡赖着不走：正文改过一次（模型补写、工具轮追加）就比卡上当时那句「原文 N 字」长了，但缩回阈值以下时原代码只判「不变就跳」，判到不一样就往下走，`shouldSummarize` 再判不够线就 `return undefined`——旧卡原地留着，跟眼前这段正文对不上。实测证据：某个会话里卡写「原文 383 字」而正文剥卡后 478 字，同一刻日志写的是「跳过：under-threshold（478 字）」；同一会话另有 214/259、334/292 两例。现在：`already` 有值但不够线时，用新导出的 `stripSummaryInMessage()` 把旧卡撒掉并返回清理后的消息。新增 2 条用例（旧卡能撒干净且正文一字不动、没卡的消息原样返回不产生新对象），`length-summary.test.js` 26/26，全量 283/283。**未实机验证**：重载后在真实消息上确认旧卡会被撒。

- 2026-10-17 | 修复 | 悬浮球 Ask 走不通的真病根：宿主给工具执行的 RPC 有 30 秒上限（`RPC callback.tools.execute timed out after 30000ms`），而球侧 `ball.ask()` 是入队后在原地死等，最长等到十分钟。两头尺度对不上，用户稍一犹豫，工具先判超时，球上的题还挂着，答案永远回不到那一轮。现在拆成两截：①`ball.ask()` 换成 `enqueueAsk()`（送到就返回 askId，409 报 `{busy:true}` 不再静默覆盖原题）+ `readAskResult()`；②新增 `lib/ball-ask-watch.js` 轮询收答案，答上来以后用 `session:send`（followUp）作为一条新消息补回原会话，由伙伴开新回合接着做。工具侧改成「题已经在球上发出了，这一轮先停在这里」，不再假装拿到选择。代价：原工具 Promise 无法恢复（deferred 回传通道不在 v2 App 的公开授权面里），换来的是主干流程不再被 30 秒卡死。附带：`/ask/enqueue` 现在把 `sessionId` 一起存在桥上，App 重载后由 `adoptPendingBallAsks()` 按 `/ask/pending` 把在等的题接回来；跳过/超时/中止只记账不回传；回传失败留 warn 不静默吞。测试：`ball.test.js` 15/15、新增 `ball-ask-watch.test.js` 12/12、全量 `node --test` 281/281、Python 39/39（新增 2 条覆盖 sessionId 存留）。**未实机验证**：真实悬浮球上的「发出→作答→回传→新回合续做」全链路、App 重载接回。
- 2026-10-17 | 优化 | 捋一捋底部三个按钮重排：三个都改成 `Expanding` 尺寸策略 + 统一 `padding: 0 8px`，实测宽度 97/98/97（之前“排队”被压成窄条）；文案从「排队」改成「排队发送」，与「发送」对得上；排队底色从透明改成 `surface`，边框用淡边，发送仍用 accent 边框，形成一实一虚一淡的主次。

- 2026-10-17 | 修复 | 点球只有动画、不弹面板：上一轮加“排队窗跟着收起”时，把“主面板没开、但润色窗开着”那段匹配到了 **ZhujianBall** 的同结构代码里，于是球自己的点击处理里写了 `self.ball.queue_insert_dialog`——而那里 self 就是球，直接 AttributeError。已改成 `getattr(self, "queue_insert_dialog", None)`（`_toggle_expand` 与 `_open_menu` 两处）；主面板 `close_menu` 里仍是 `self.ball`（它确实持有 ball）。
- 2026-10-17 | 优化 | 新增的崩溃日志当场生效：`ball-crash.log` 直接给出了文件名、行号与异常类型，这类“点了没反应”的偶发问题不再靠猜。

- 2026-10-17 | 优化 | 球崩溃取证：`zhujian_app.py` 启动时装 `faulthandler` + `excepthook` 写 `ball-crash.log`（超 256KB 重开）；`lib/ball.js` 在球进程退出时把 stderr 尾部写进宿主日志（以前只有退出码，什么都没有）。针对“点开传音樱就崩溃消失”这条：本地离屏与真实桌面各启动一次都正常（ready 握手成功、crash log 为空），暂未复现。

- 2026-10-17 | 修复 | 速览把 MOOD 区块也当成原文算了：`collectTextParts` 只取 `type: "text"` 片段（所以思考/reasoning 没被算进去），而 MOOD 是写在正文里的纯文本，于是「原文 1284 字」里含了那几百字的内心记录，总结材料也跟着含进去。现在 `readBodyText` 之后先 `stripMoodBlock` 剥掉 `<mood>…</mood>`，字数与总结都只算真正说给对方的那部分；副作用是剥离后不足阈值时不再出速览，这正是应该的。

- 2026-10-17 | 修复 | 长回复速览插在回复中间：这一轮常是「正文 → 工具调用 → 正文」多段拼成，而 `messages/post-assistant` 对中间那条 assistant 消息也会触发，于是卡片夹在两段正文之间，字数也只算了前半段。现在先看这条消息带不带工具调用（`hasToolCalls`）：带了就跳过，等最后一条正文完整的。

- 2026-10-17 | 新功能 | 补回旧版的「循环续接」（与断联续接是两回事：那边管出事，这边管正常说完也接着续）：`lib/continue-loop.js` 整块移植旧版状态机（轮数 1~50、最小间隔 1.5s、「还继续吗」冷却 60s、收工话识别）；续接卡新增「继续后自动循环」勾选 + 「最多续接 N 轮」（−/+，默认 5）；主面板新增循环状态行（「正在续 第 n/N 轮」）+ 停；循环跑到收工话时弹确认卡（「接着来 / 就到这吧」），不自己替用户停；用户在同一对话里自己开口就停循环（排除自己补发的「继续哈」）。配置存 `resumeConfig.loopEnabled/loopRounds`，桥新增 `/resume/loop` 状态推送与 `loop-start/loop-stop/loop-resume/loop-finish/loop-prefs` 动作。

- 2026-10-17 | 新功能 | 排队窗补上「循环 N 轮」（旧版 1~50 档）：发送时轮数 >1 就走 `kind=queue`，App 记住剩余轮数，每轮 `messages/post-assistant` 后自动补下一条（`followUp`）；窗口发送后不自动关，状态显示「已排队，共 N 轮」并多出一个「停止排队」（发 `queue-cancel` 清循环）。轮数在 `/polish/request` 上归一化到 1~50，`queue-cancel` 不要求正文。**用户在同一段对话里自己开口也会停循环**（旧版行为）：在 `agent/before-start` 开头用 `shouldStopLoopOnPrompt` 判，靠“prompt 里含着我们排进去的原文”把自己补发的那条摘出去；别的对话里说话不影响。已知边界：插话恰好完整包含那句原文时会被当成自发消息，循环不停（概率极低，且方向是“没停”而不是误杀）。
- 2026-10-17 | 新功能 | 捋一捋窗恢复「排队」按钮：三个按钮「✨ 捋一捋 / 排队 / 发送」，排队走 `followUp`（等这一轮说完），发送仍是 `steer`（立刻插话）；`_set_busy` 与 `closeEvent` 同步管住新按钮。

- 2026-10-17 | 新功能 | 「等 ta 说完再发」按旧版形态补全：主面板新增「等 ta 说完再发」工具行（按钮「写一句」），点开是独立二级弹窗，抬头「💬 等 ta 说完再发」，带「发送到」（跟随最近/固定某对话）、输入框、取消 / 就这么发，发送后自动收起。内部走宿主 `followUp`，球只发一次，不维护队列状态机；捋一捋里那个挤进去的「排队」按钮已撤掉，恢复旧版的「捋一捋 + 发送」两钮。旧版的「循环 N 轮」未做（需要自己维护多轮队列）。
- 2026-10-17 | 修复 | `close_menu` / `_open_menu` / 点球收起三处直接读 `ball.queue_insert_dialog`，在没有该属性的球对象上会抛 AttributeError；而 PyQt 在槽函数里遇到未捕获异常会直接 abort（测试进程一退就 0xC0000409）。现在统一用 `getattr(..., None)`，缺属性时安静跳过。

- 2026-10-17 | 新功能 | 捋一捋窗补上「排队」出口：旧插件的「等 ta 说完再发」在后端早就有（走宿主 `deliverAs: followUp`），但界面上一直没入口，只能靠工具调。现在按钮行变成「✨ 捋一捋 / 排队 / 发送」：「发送」仍是立刻插话（steer），「排队」等这一轮说完再发（followUp），成功后提示「已排队，等 ta 说完就发」。桥上的 `/polish/request` 新增 `deliverAs`（缺省或认不出一律走 steer，保持老行为），App 侧按它选投递时机；`_set_busy` / `closeEvent` 同步管住新按钮。

- 2026-10-17 | 修复 | 二级弹窗切目标“点了没反应”的最后一层：加了 `panel-diag.log` 记录仪后拿到实证——球侧目标行确实更新了（`polishBtn` 从空变成「固定 · 茶话会版本更新对 ▾」），App 也真的写了存储；真正的毛病是**延迟**：点击 18:30:32 → App 18:30:34 处理完 → 球 18:30:38 才拿到新快照，三到六秒的空白让人以为没点上，于是又点一次。现在：①点完立刻就地更新球上的目标状态与目标行（乐观更新），推送回来再校准；②只剩二级弹窗时的慢速轮询从 5 秒缩到 2 秒。
- 2026-10-17 | 优化 | 新增 `_panel_diag`（写 `panel-diag.log`，只记目标 sessionId/标题、各面板按钮文字、候选顺序，不记对话内容，单文件 256KB 封顶）：球是独立进程、平时不写日志，「点了没反应」这类问题以前只能靠猜。

- 2026-10-17 | 修复 | 卡住复核把「查不到」当成「没进展」：`session:list` 里找不到这段对话时 `target` 为 null，`sessionWrittenSince(null, ...)` 返回 false，代码照样往下走 `markStuck`，于是同一条提醒反复弹，还要叠一句“自动续接没开”。没有 `modified` 就没有任何证据证明它卡了，现在这种情况直接跳过这轮、只记一条 debug，不记账；宁可漏报也不误报。

- 2026-10-17 | 修复 | 断联续接小条仍然「没标题、看不出是哪个窗」的真病根：同一个对话在两条链路上拿着两套编号。`agent/before-start` 与 `messages/post-assistant` 钩子给的是稳定编号 `sess_0mvc7z5bx_…`，而 `bus.subscribe` 的事件回调在 `sessionPath` 为空时只剩事件自带的裸 UUID `01a14908-bc69-…`；`session:list` 的 `byId` 只认 `sess_`，`byPath` 又因为没有路径而空，于是查不到 → `title`/`agentName` 全空 → 抬头落到「一个还没标题的对话」。更麻烦的是同一个会话被记成两本账：开头记在 `sess_` 上、收尾用 UUID 清，清不掉，90 秒后把正常会话误判成卡住。现在：①会话索引新增第三本按 UUID 查的账（`byUuid` + `sessionUuidOf`），大小写都认；②`resolveResumeTarget` 查到稳定编号后向状态机登记别名（`registerAlias` + `canonicalId`），之后两边自动落到同一个键，迁移时把旧键上的计时与续接次数一并搬过去；③抬头真的一无所有时依次改用这段对话的**开头那句**（`firstMessage`，16 字以内）和**会话文件的开启时间**（`openedAt`，取文件名里的 UTC 时间转本地，和侧栏排序用的就是同一个），不再写「一个还没标题的对话」这种等于没说的话。新增 5 条用例覆盖「只有 UUID 没路径」「别名合并」「开头摘要」「开窗时间」。未做桌面实机验收（需重载 App 后等一次真实断联，或用旧桥里的现场提醒验）。

- 2026-10-17 | 修复 | 二级弹窗切目标不更新的真病根：主面板 `hideEvent` 里直接 `stop_recommend_polling()`，而打开「念给我听」「帮我捋一捋」的第一件事就是把主面板收起（让位），于是弹窗开着的整段时间里推荐快照轮询是停的，目标状态永远不更新；上一批「弹窗目标行重绘」根本没被触发过。现在分三段：主面板可见 → 1.5 秒；只剩二级弹窗 → 5 秒（`RECOMMEND_POLL_SLOW_MS`）；都看不见 → 停。主面板与两个弹窗的开合都会重新算一次（`_sync_recommend_polling`）。

- 2026-10-17 | 修复 | 二级弹窗（朗读窗、捋一捋窗）里切目标「点了没反应」：后台其实已经改成功了（日志有「球目标已回到跟随最近活跃」「球目标已固定」），但三个面板各有自己的目标行，而二级弹窗只在开窗时去打旧插件的 `/target`——App 桥根本没这条路由，于是文字永远停在打开那一刻。现在：①`TargetMenu` 切完目标立刻重绘本窗口的目标行；②主面板收到推荐快照时顺手把开着的二级弹窗也刷一遍；③两个二级弹窗的 `_sync_target_state` 在 App 模式直接重绘，不再去敲不存在的路由。
- 2026-10-17 | 修复 | 切目标后朗读窗的回复列表不跟着变：App 侧推过列表后有 60 秒缓存，不会重推。现在球切目标后给桥打一个一次性 `forcePush` 信号，App 读到就绕开缓存重拉；信号读到即清，不会每轮都重拉。

- 2026-10-17 | 修复 | 捋一捋「点了一点效果都没有」：桥里现场取证——模型（MiniMax M3.1 Flash）真的被调用了，也返回了，但正文跟原文一字不差，`fellBack: false`，界面照样说「捋好了」。根在提示词：自检那条写的是「有一项无法确认就返回原文」，深度档又允许「原文已经清楚就原样返回」，用户那段本来就平顺，模型就选择不动。现在改为逐处保留（某处拿不准只保留那一处的原话，其余照常整理），并补一条「该整理的四种情形」（一句话塞多件事、口语连接词成串、指代与诉求拌匀、断句不清）；深度档改成「整段确实没可整理之处时才原样返回」。安全兜底一行没动，仍是不改错意思优先。
- 2026-10-17 | 优化 | 润色链路以前只在失败时留日志，用户说「没效果」时无从取证：现在成功后也记一笔（只记字数、`unchanged` / `fellBack`、原因和模型名，不记内容）。界面也不再一律说「捋好了」：模型一字未改时说「这段本身就够清楚，我没动它」，被兜底拦下时说「这版改写我拿不准，先按你原文留着」。

- 2026-10-17 | 修复 | 整体扫一遍桥链路后的三处「球一重启就哑掉」：①传音樱的推荐桥（`lib/ball-bridge.js`）把 `request.seq` 跟 App 自己记的上一个大号比，而球重启后桥上的 requestSeq 从 0 重数，于是之后点「刷新推荐」「固定对话」全部没反应；现在检测到序号倒退就归零重来。②朗读桥的 `selectionSeq` / `favSeq` 同理，球重启后在朗读窗里点选或点收藏会永久无效。③续接、润色、标题三处以前在序号倒退时直接 `return`，会把重启后第一次动作一起吞掉；现在只重建基线，不当场吞请求。
- 2026-10-17 | 优化 | 宿主 App RPC 并发上限把钩子打成筛子（日志满屏 `adjudicator threw ... App RPC concurrency limit reached`，一个钩子整条被丢掉，Ask 判断和长回复速览就这样静默消失，看着像「模型没连上」）：新增 `readConfig`，同一份配置读一次管 4 秒、撞上限时退避重试一次、真读不到就沿用上次读到的值（不拿默认值当真相）；设置页写配置改走 `saveConfig`，写完整即清缓存。另把推荐桥的 `session:list` 与 `recommendationConfig` 各加 5 秒缓存，1.5 秒一轮的轮询不再每圈都去抢宿主配额。
- 2026-10-17 | 修复 | 润色选模型时对存储值的形状太死：`resolvePolishModel` 直接拿 `ref.provider` / `ref.model` 比，存储里若是 `providerId` / `modelId` 变体（或者只有 `id`）就匹配不上，表现就是「明明配了模型却说没配」。现在统一走 `normalizeModelRef`。顺带核完其余模型入口（Ask 判断、速览、推荐、标题、自定义档、连通测试），它们的模型目录都用 `chatModelOptions` 或 `resolveAskModel`，调用参数（provider/model/systemPrompt/maxTokens/callToken）也与宿主 V2 契约一致，没再发现形状问题。

- 2026-10-17 | 修复 | 「帮我捋捋」永远卡在「正在捋…」、弹窗也一直不变半透明：球把桥回包整个 `update` 进本地 payload，而回包里的 `seq` 是 App 侧的请求编号（桥的 `requestSeq`），跟面板自己的 `_request_seq` 分属两套计数。面板开过一次又关掉（`closeEvent` 里也会 +1）、或某次请求被桥拒了，两边就永远错一位，`_apply_polish_result` 每次都判成过期回包直接 return，`_polishing` 再也不归位；连带 `_fade_allowed` 也永久返回 False（它用「正在处理中不淡出」）。现在新增 `merge_polish_result`：只取回包内容，序号永远用本地的。日志实证：16:51:13 有一次「球内润色失败」，App 回了错误包但球把它丢了。
- 2026-10-17 | 修复 | 捋一捋根本走不到模型：`lib/polish.js` 的 `resolvePolishModel` 还在用 `Array.isArray(catalog?.models)`，只认 `{ models: [...] }`；宿主实际给的是数组时就当空列表，直接报「Hana 模型列表为空，请先配置可用的文本模型」，而同一时刻设置页能正常列出模型。会话标题那边早前修过同一个坑，润色这处是漏网的，现在统一走 `chatModelOptions`（数组/对象都认，仍过滤非聊天模型）。日志实证：16:51 前后没有任何润色模型调用记录，说明在选模型那步就抦了。

- 2026-10-17 | 优化 | 传音樱推荐区的「清空」按钮收窄：换独立 `clearBtn` 样式，最小宽度从跟「刷新推荐」一样的 88px 降到 50px，内边距同步收到 10px，让撤退动作不跟主操作抢同一档视觉重量。
- 2026-10-17 | 修复 | 没有已生成的推荐时不再显示「清空」：之前它是常驻的，空状态、加载中、报错、清空后都摆着一个清不掉任何东西的按钮。现在由 `_set_clear_available` 统一管：只有 `_render_items` 真的渲染出条目才出现，`_clear_buttons` 一清空网格就跟着藏起来，隐藏时不留占位。离屏用例覆盖「初始/空/报错不显示 → 有条目才出现 → 清空后消失」。

- 2026-10-17 | 优化 | 会话标题改完后的提示去掉「聊一句后自动刷新」：Hana 侧栏现在立即生效，那句话已经不对；只留结果本身（兜底时仍带「（兜底标题）」标记）。

- 2026-10-17 | 修复 | 标题依旧兜底，日志写明原因「Hana 模型列表为空」（但同一时刻内容模型页能正常列出模型）：`pickTitleModel` 假定 `sdk.models.list()` 返回 `{models:[…]}`，而宿主给的可能是数组，`catalog?.models` 直接空；且它自己又写了一份严于 `chatModelOptions` 的过滤。现在统一走 `chatModelOptions` + `resolveAskModel`：数组与对象都认，选过内容模型就用选的那条，没选则跟随 Hana 当前模型。

- 2026-10-17 | 修复 | 内容模型区的「测试连接」永远失败（日志里连「内容模型测试失败」都没有，因为它根本没到服务端）：面板把测试请求打到了 `POST /content-model`，而服务端只有 `POST /content-model/test`，读 `/content-model` 的 GET/PUT 都不接 POST，于是每次都只能拿到「模型设置读取失败」。现在 `contentModelRequest` 多一个 path 参数，测试走正确的 `/content-model/test`。

- 2026-10-17 | 修复 | 会话标题总是退回「兜底标题」（直接把最后一条用户原话当标题）：拼上下文时 `buildTitleContext` 只认字符串 `content`，而宿主 history 里 assistant 消息的 `content` 是 `[{type:"text"},…]` 数组（已抽当前会话的文件核实），于是整段对话被当成空内容跳过，模型那一步直接不跑。现在统一走新增的 `messagePlainText`（字符串与数组都认，只取 text 片段），兜底取原话的那条路也一并修；兜底时往日志记一条原因，不再只能看到「兜底标题」四个字。

- 2026-10-17 | 修复 | 传音樱里「会话标题」不见了（不是代码丢了，是被 `_configure_app_mode` 的 App 模式隐藏名单整块藏着；就算放出来也点不了，它还在打旧插件的 `/rename`）。现在补齐整条链：桥上新增 `/title/state` `/title/request` `/title/push` 三端点，App 侧每 2 秒轮询（首轮只记基线，防重载重放），收到请求后走 `summarizeSessionTitle` + `applySessionTitle`且把现成的旧标题一并交给写入方（不传的话「还原」只能退回「未命名对话」）；球侧 `rename_async`/`undo_async` 在 App 模式改走这条桥，等不到回包就报「知意没回话」，不假装成功；改完立刻把球上的目标标题同步过去，不等下一轮推荐快照。

- 2026-10-17 | 修复 | 同一个气泡里叠出两张、三张速览：`messages/post-assistant` 对同一条消息可能被再交给一次（重试、后续工具轮又追加正文），而旧代码每次都往最后一个正文片段末尾直接 append，于是中间一张、结尾一张。现在先摘下已经贴过的速览块（新旧两种抬头都认：旧版「速览」与新版「🌸 知意速览」），再贴新的，`replaceSummaryBlock` 保证一条消息只留一张；正文没变且已经带卡的直接跳过，不白花一次模型调用。

- 2026-10-17 | 优化 | 长回复的引用块小卡抬头从「速览」改成「🌸 知意速览」，固定叫法带花；归档文件里的「速览：」标签不动（内部产物）。

- 2026-10-17 | 修复 | 断联续接的提醒不再是无名氏：小条标题以前取 `signal.agentName`，而这个字段在三个产生 signal 的地方（回合失败、强制释放、卡住兜底）从来不存在，所以永远落到「某个窗口」，而就算填上也是伙伴名不是窗口名。现在按 sessionId 查一次 `session:list`（缓存 20 秒）拿到真实窗口标题与伙伴名，两条通道（`/resume/notice`、`/resume/flash`）都带上；球侧抬头改成「来自窗口：标题（伙伴）/ 来自：伙伴 的对话 / 来自：一个还没标题的对话」，不再用占位词。日志也记下这次提醒到底来自哪个窗口。
- 2026-10-17 | 修复 | 断联续接的误报与错账：①`markStarted` 记的是宿主 sessionId（sess_xxx），`turn_end` 恢复时用的却是事件路径的文件名，两套编号各记各的账，会话自己好了也清不掉同一条状态。新增 `buildSessionIndex`/`lookupSession` 按 sessionId 和文件名双向对齐，事件侧统一归一到 sessionId。②卡住兜底以前只信倒计时：`messages/post-assistant` 钩子撞上宿主「App RPC concurrency limit reached」被整个丢掉时，连「这一轮出正文了」都记不上，90 秒后就把正常会话判成卡住报给用户。现在先出候选不记账，用 `session:list` 的 `modified` 复核一遍（`sessionWrittenSince`），确认这段对话之后真的没被写过才 `markStuck`。③顺手修掉多窗口互相覆盖：一个窗口自己好了不再把别的窗口那条提醒一起清掉，也不再无条件推空。④长回复速览的配置读取加内存缓存并降级处理，每轮少一次 App RPC，降低撞并发上限的概率。

- 2026-10-17 | 优化 | 传音樱主视觉换成用户提供的透明樱花枝条插画；保留原有枝根风摆、悬停/按压花瓣效果与交互区域，插画资源缺失时回退旧版分层绘制。
- 2026-10-17 | 新功能 | 补回语音收藏（用户拍定要做）：朗读成功时收藏键放活（旧代码一直硬写着禁用），点「♡ 收藏」经桥上的 `/voice/fav` 交给 App，落成 `/voice/favorites`；**只存引用不复制音频**（clipId + 文本 + 音色 + 来源伙伴），试听直接读当时的 clip，不用再合成一次。设置页新增「语音收藏」区：列表、试听（取回字节转 Blob URL，与旁边试听同一做法）、删除（两秒内再点确认）。路由对象只有 get/post/put，没有 delete，删除走 `POST /voice/favorites/delete` + body 里的 id。同一段重复收藏按已收藏处理。
- 2026-10-17 | 新功能 | 补回「捋一捋」入口（App 模式重新开放）：弹窗不再打旧插件的 `/polish`，改走桥上新开的 `/polish/state` `/polish/request` `/polish/push` 三端点，App 侧每 2 秒轮询桥并调用自己的 `/polish` 与 `lib/polish.js`；球侧发一次请求后按 `resultSeq` 轮询等回包，超时报「知意没回话」而不假装成功。App 侧同样先立基线，避免重载重放。压缩档案仍隐藏（读旧路由、桥未开、权限不足）。

## 2026-10-17 旧版逐函数对照后的一批修复

对照基础：`C:\Users\laotv\.hanako\plugins\jiegehua\python\zhujian_app.py`（旧版）对 `C:\Users\laotv\.hanako\apps\jiegehua-zhiyi\python\zhujian_app.py`（新版），四路并行逐函数核。已核实 11 条真 bug，全部修完。

- 2026-10-17 | 修复 | 断联续接：①球冷启动时提问轮询顺带读 `/resume/state`，桥上有提醒就建面板并接上续接轮询（以前只在 `showEvent` 起轮询，用户没手动开过面板就一次都拉不到，提醒直接丢）；②App 侧 `resumeBridgeTimer` 首轮只记基线、序号倒退也按新基线处理，修掉「App 每次重载都重放上一次动作」（桥里的 action 是读过就一直留着的）；③桥上补 `RESUME_NOTICE_TTL_MS = 30 分钟`（旧版本就有，迁移时漏了），且会话恢复正常时补推 null 清掉提醒，不再对着已聊完的窗口误发；④新开 `/resume/flash` 通道，自动续接成功后亮 4 秒反馈（以前 `resumeNotices` 被硬编码成空数组、提示条还被 App 模式藏着，全程无感知）。
- 2026-10-17 | 修复 | 面板状态：①`lbl_section`（「对话工具」）加回 `_configure_app_mode` 的显示名单，答完 Ask 后不再永久消失；②`_configure_app_mode` 先看 `_recommend_visible` 再决定是否 show 推荐卡，修掉关推荐后被强行放回且再也藏不回去的空壳；③`set_candidates` 加内容指纹，内容没变不重建列表，修掉每 1.5 秒拆了重建导致的 hover/焦点/滚动位置全丢；④`refresh_async` 的 App 分支补上重入锁与按钮禁用，连点不再重复消耗。
- 2026-10-17 | 修复 | 推荐区：`_apply_recommend_request_failure` 现在会解锁按钮并重绘，不再永久停在「正在获取推荐回复…」。
- 2026-10-17 | 修复 | 朗读窗/润色窗：①`TargetMenu` 新增 `_request_recommend` 回落，`request_recommend` 只定义在主面板上，在子弹窗里点「跟随最近」或固定对话以前是 `AttributeError` 且界面已经先弹了「已固定这段对话」；②候选列表改由球上的 `set_recommend_candidates` 统一分发，三处 `_open_target_menu` 都补上 App 分支，不再无条件打旧插件的 `/sessions`，主面板与子弹窗现在看到同一份「最近 5 个」。
- 2026-10-17 | 验证 | 已排除一条：审查怀疑 `ball-target.js` 的时间戳没做量级归一会显示 1970 年，实机截图显示的是正常钟点，该疑点不成立。

- 2026-10-17 | 修复 | 点「跟随最近」后浮签不再留在「自己选择」态：App 模式下的 `_pick_auto` 之前只发了请求就 return，漏了旧版那两步（置 view_mode、重绘、收起浮签）。现在切回「跟随最近」并自动收起，跟点具体对话是同一个效果。
- 2026-10-17 | 修复 | 球面板的「推荐回复参考哪段对话？」候选浮签不再默认摊着：`_configure_app_mode` 一度把它跟着其他控件一起 `show()`，导致每次开面板都占掉半屏。改回旧版做法——默认收起，只有点「当前对话」按钮才展开，并且 `showEvent` 里再收一次，保证重新打开永远是收着的。
- 2026-10-17 | 修复 | 推荐语出英文：语言判断以前数的是整段对话里汉字与拉丁字母的个数，而伙伴回复天然中英混排（变量名、库名、报错），拉丁字母数量碾压汉字，于是被判成英文对话，推荐语跟着跑英文。现在只数**用户自己说的话**，并且汉字占三成以上就算中文对话，只有英文真压倒性才当英文对话。用户没说话时才退回整段判断。
- 2026-10-17 | 优化 | 球内推荐出错时，错误提示会钉住不再 1.5 秒就退回默认文案：旧错误只在生成那一轮的快照里带，下一轮 notice 为空就回退成「点刷新推荐生成一批」，等于错误只闪一下。现在球会记住它，直到真生成出东西、你点「清空」、或收起面板；下次打开重新绘制，回到默认文案。
- 2026-10-17 | 修复 | 球内推荐回复稳定性：输出额度从 700 抬到 1800（与润色对齐），失败时自动用 3600 重试一次。以前 700 是全仓最低的一处，而推理模型（gpt-6-luna、M3.1、DeepSeek 全系）的思考 token 与正文共用同一份额度，给少了就出「模型已返回但没有正文」或服务商那句含糊的 could not complete——同一个模型在别处能刷出来，就是因为别处给的是 1200~1800。另外服务商报错现在翻成人话并保留原始细节（限流、超时、无正文、没跑完各有一句），不再只抛一句英文。

- 2026-10-17 | 优化 | 推荐回复下线卡片形态，只留传音樱（用户拍定：“一般是用在我不知道要跟你说啥、没思路的情况，那就只保留在传音樱里”）：展示方式从「回复卡片 / 关闭」改为「传音樱内展示 / 关闭」，旧值 `card` 自动落到传音樱而不是静默关掉；主对话不再注册 `jiegehua_zhiyi_suggest_replies` 与 `jiegehua_zhiyi_send_recommendation`，生成前也不再注入推荐引导；删除 `lib/recommendation-card.js`、`tests/recommendation-card.test.js`、`lib/send.js` 的 `sendRecommendationPick` 及配置里的 `timing` / `sendMode`。球面板在关闭时整块隐藏推荐区（新增 `enabled` 字段），不再显示「推荐回复已在设置里关闭」。推荐方向、条数、「和小花聊聊」对话式修订、恢复默认全部保留。README 未动（受保护）；已删除的两个文件备份在 `L:\哈娜的工作台\_插件备份\jiegehua-zhiyi_2026-10-17_推荐卡片下线前`。

- 2026-10-17 | 优化 | 传音樱里手动选定一段对话后，候选浮签自动收起（和「跟随最近活跃」那条行为对齐；之前只有取消固定会收起，选完列表一直挂着挡住推荐区）。目标行按钮仍在，想换随时点它再展开。
- 2026-10-17 | 修复 | 传音樱推荐回复改为纯手动：只有点「刷新推荐」才调模型生成；开面板、切目标、单纯过一会儿（原来的 120 秒 TTL）都不再自动生成，也不会偷偷花 token。换目标时旧列表自动作废，避免上一次的推荐留在新对话下。
- 2026-10-17 | 新功能 | 传音樱推荐区新增「清空」按钮：清掉当前这一屏推荐，并通知 App 丢掉它那份缓存，否则下一轮轮询会把旧列表推回来。不会调模型，不会动已存的方向设置。
- 2026-10-17 | 修复 | 断联续接面板不再反复自己弹开：用户点球收起面板或点面板里的关闭键时，把当前这条提醒记为「延后」——不再自动弹窗，但自己再点开面板小条仍然亮着，不会把没处理的提醒弄丢。只有点「不用管」才是真放弃。程序内部的收起（打开朗读/润色等子弹窗、答完题）不触发。
：ui 面板、设置弹窗、状态文案、权限项、lib/ball.js 错误信息、Ask 引导文案、工具描述、PyQt6 窗口标题与右键菜单里所有「悬浮球」「花球」统一改成「传音樱」；README 未动（受保护）；全局安装的 zhiyi-ask Recipe 描述里仍有「无悬浮球」，属 Recipe 托管内容未手改，后续如需同步走正式入口。
- 2026-10-17 | 优化 | 页头传音樱开关换成表情包应用主页那张纸飞机开关胶囊的样式（标签 + 32×18 拨杆，开了拨杆上重色，悬停/深色模式各自配色）；标签文字不再跟着状态变成「开/收传音樱」，固定写「传音樱」，开关状态交给拨杆和页头下方那行状态文案表达，标题属性改成「开启/收起桌面传音樱」。

- 2026-10-16 | 新功能 | 与闲不住的风铃融合重新接上（2026-10-15 曾定「不做」，本轮按用户要求恢复）：知意新增 `app/services.provide` 权限并挂 `app:jiegehua-zhiyi/fusion` 服务，供闲不住用 `app/services.call` 取球的坐标、面板状态与桥地址；知意的球 ready 后把桥地址与令牌落盘到 App 数据目录 `ball-bridge.json`（球一停就删），停球时一并清理。纠正旧结论：`zhujian_app.py` 并不拒绝被外部进程 import，实机可正常加载；真正卡点是①知意球写 `app-data/jiegehua-zhiyi/zhujian-state.json` 而融合协调器还在读旧插件目录 `data/jiegehua/`，②`bus.request("jiegehua:fusion:v1")` 不在宿主公开动词白名单里、宿主规定自定义服务名必须是 `app:<appId>/method`。两边新增权限需用户在 Hana 里批准后才能实机融合。
- 2026-10-16 | 优化 | 桌面悬浮球不再占一张卡片：改成页头右上角与「设置」同款的开关胶囊（带状态小圆点，开着时上重色），状态行紧跟页头；启动所需的 PyQt6 与权限说明移进设置弹窗。首次使用提醒提到页面开头（第一个分区之前）。

- 2026-10-16 | 优化 | 设置页改成「常用开关在主页 + 一个设置弹窗收全部配置」，照表情包应用的弹窗做法：页头右上角齿轮按钮，弹窗分 head/body/foot，关闭键与底部按钮常驻、内容自己滚、Tab 在弹窗内转圈、Esc 和点遮罩关闭。主页面从 5249px 缩到约 1800px，只留关键 Ask、推荐回复、长回复速览、悬浮球四节。
- 2026-10-16 | 优化 | 模型合并成两条：推荐回复、Ask 判断、长回复速览共用一个「内容模型」（新增 `/content-model`，一次写入同步三个存储键；读取时若三处原本不同会提示已统一），自定义接口缩进到内容模型同一张卡里；语音仍是独立的「语音模型」。页面上从三套模型选择器收成一套。

- 2026-10-16 | 优化 | 设置页只保留设置，功能从设置页移走：起标题、改标题、撤回标题、捋一捋、等 ta 说完再发、朗读试听（选回复+念给我听+播放器）不再占设置页，这些在悬浮球面板里做；并按旧版解语花的卡片分组重排为九节（Ask / 推荐 / 速览 / 断联 / 模型 / 自定义模型 / 朗读 / 悬浮球 / 权限），三处模型设置合为一节。页面视觉回到知意原生风格。

- 2026-10-15 | 新功能 | 桌面悬浮球补完「目标跟随」：球面板重新显示当前绑定的目标对话；未固定时自动跟随最近活跃的一段；点「当前对话」展开最近 5 个候选（只取 path/sessionId/title/agentName/modified，不读对话内容），点一条即把它固定为目标。链路走 App 桥新增的 `/recommend/*`，候选与目标由 App 侧读已授权的 session:list 得出。
- 2026-10-15 | 新功能 | 桌面悬浮球补完「固定目标」：固定后不再自动跟随最近活跃；可在球里切回「跟随最近」取消固定。固定状态存 `sdk.storage.global` 的 `ballTarget`（只存会话编号、标题、伙伴名，不存正文）。
- 2026-10-15 | 新功能 | 桌面悬浮球补完「球内推荐面板」：球面板直接显示当前目标的推荐回复，复用 `lib/recommendation.js` 的 `generateRecommendations`（不另写一套 prompt）；球内空间小，做成紧凑列表，点一条复制走，不塞大卡片、不代替发送。

- 2026-10-14 | 新功能 | 迁回「语音朗读」：设置页新增语音区，填一条朗读模型（MiniMax 或 OpenAI 兼容，含接口地址、模型名、API Key）就能选最近一段对话里ta 说过的话来听；可选整条回复或只念引号台词，语速三档。合成前会先剥掉隐藏块、代码块和 Markdown，隐藏思考不会进语音。
- 2026-10-14 | 新功能 | 按伙伴分音色：列出你最近聊过的伙伴，每人一行单独选音色，不选就跟随默认音色。
- 2026-10-14 | 新功能 | 朗读跟读逐词点亮：拿到词级字幕就跟着词亮，拿不到就按句点亮，界面上会明说这次用的是哪一种。
- 2026-10-14 | 新功能 | 花球里恢复「念给我听」：悬浮球面板上的朗读入口重新可用，朗读窗的回复列表、合成与播放都走 App，不再请求旧插件接口。
- 2026-10-15 | 新功能 | 悬浮球目标跟随/固定/球内推荐列表（候选名单保留 agentId 作伙伴名缺失时的兜底显示，2026-10-15 用户确认保留）
- 2026-10-15 | 新功能 | 会话标题可撤回（可再撤回一次）；推荐方向支持在设置页自定义方向名与意图
- 2026-10-15 | 新功能 | 语音朗读新增「用 Hana 的凭据」：Key 不落盘，每次合成向宿主索取，拿不到明说（地址 + 模型名 + Key）跑推荐回复、长回复速览、捋一捋、起标题和改推荐方向；上面已经选过 Hana 模型的地方仍然用你选的。Key 用 Windows 系统加密保存，带「测试一下」且测试不写盘。
- 2026-10-15 | 新功能 | 推荐方向支持「和小花聊聊」改：在设置页点一下，主对话里的知意会先问你一句想怎么改；商量完出一张对照卡（每条「现在 / 改完以后」+ 单条「这条不要」），你点「确认修改」它才真的换，并告诉你换成什么样了。
- 2026-10-15 | 新功能 | 推荐方向可以一键恢复默认四个，不用手动一条条改回去。
- 2026-10-15 | 修复 | 「确认修改」加了落盘回读校验：写完不核对一遍就算成功、卡片直接关掉的毛病没有了；确认不了就留在原界面让你再点一次。
- 2026-10-14 | 新功能 | 异常中断续接（分工：提醒归「提个醒」，知意只管续接）：发现那一轮停在半路了，按你的选择发一句「继续哈」接上；连续几次没成才在悬浮球与设置页各留一条提醒等你决定。自动续接默认关，因为它每次都是一次真实模型调用。
- 2026-10-14 | 新功能 | 断联续接的判定：订阅宿主事件流识别回合失败与强制释放，用户主动按停不算异常；另留一条「开头多久没说话算异常」兼底，避免你手动停下来时被反复提醒。
- 2026-10-14 | 修复 | 宿主不支持事件订阅时不再整个 App 装载失败，自动退到兼底判定，并在设置页说清当前宿主能力。
- 2026-10-14 | 新功能 | 朗读模型配置不再暴露成技术参数：预设模板一键填好地址与模型名，Key 落盘前用Windows 系统加密保护，页面只显示「已加密保存」；系统加密不可用时会明说，不会假装加密成功。

- 2026-10-12 | 新功能 | 推荐卡的「直接发送」：在卡片上点选一条、点确定，就以你的身份把那一句原样发进对话，伙伴当场接话；发不出去会明说并恢复按钮。默认仍是复制。

- 2026-10-12 | 新功能 | 「等 ta 说完再发」：写下一句话排进最近这段对话，ta 还在回复就等着，这轮结束了再以你的身份发进去；会话忙会按 2 秒/5 秒/10 秒退避重试。

- 2026-10-12 | 新功能 | 会话标题可以直接写回这段对话：起完名点「用这个标题」即可；需要新的「管理会话」权限，没授权时会说清去哪开，不把内部错误码扔给你。

- 2026-10-12 | 修复 | 推荐回复读对话的方式一直是坏的：宿主只认会话编号，而它拿路径去读，所以每次都在第一步就失败、一张卡都没生成过；现在改成先从会话名单里认出编号再读历史，认不出就不读也不调模型。

- 2026-10-12 | 新功能 | 迁回「会话标题生成」：拿最近有动静的那段对话，按会话编号读历史，请模型用十个字概括主题；只生成、只显示、只复制，不改 Hana 里的原标题。
- 2026-10-12 | 修复 | 标题里成对的全角引号剥不掉（`「今天改代码。」` 会原样留下引号和句号）：旧版用首尾同字的反向引用，配对引号剥除等于没生效。

- 2026-10-12 | 新功能 | 迁回「捋一捋」提示词润色：设置页新增工具区，支持标准/深度两档，纯改写不碰对话也不代发；改写结果可能退回原文时会明说原因。

- 2026-10-12 | 新功能 | 设置页新增「关键 Ask 卡」开关：关闭后本轮引导不再注入、判断模型不再调用、工具不再建待办；重新加载一次后这组工具整个不注册，主对话模型在工具列表里也看不到它。

- 2026-10-12 | 修复 | 推荐回复在工具执行侧真正检查展示开关：关掉推荐或选球内展示时不再生成卡片、不调用模型，也不许把推荐改写进正文；读取设置失败按不生成处理，不再只靠提示词自觉。

- 2026-10-11 | 修复 | 速览设置未读取成功前锁住编辑与保存，并提供重试，避免默认值覆盖已有阈值；修正达到阈值即可生成的边界文案及归档写入时机说明。
- 2026-10-11 | 优化 | 速览阈值改为保留自定义值的 50 字步进器，速览模型改用自绘列表并提示失效旧选择；纠正原文保留与思考预算说明。
- 2026-10-11 | 新功能 | 设置页与 Hana 功能面板只读展示知意权限状态；查询失败按未知显示，不在 App 内申请或更改授权。
- 2026-09-29 | 新功能 | 推荐回复设置补齐：展示方式（回复卡片/关闭）、推荐时机（每次都推荐/看情况推荐）、推荐条数（2/3/4）、推荐方向勾选，改完即时保存；并把时机与方向写进主模型生成前的系统提示词引导，伙伴在正文写完后自己判断是否出卡。关闭推荐时不再注入引导。卡片仍只复制，球内推荐面板和直接发送待后续迁移。

- 2026-09-29 | 优化 | 速览超时从 6 秒回调到 12 秒：实测 663 字 1.4 秒、907 字 1.6 秒，但 1253 字会超过 6 秒，6 秒偏紧。12 秒两头都不吃亏。README 同步。

- 2026-09-29 | 优化 | 速览超时上限从 20 秒压到 6 秒：速览是锦上添花，模型慢的时候让原文先走，不让整条回复干等。实测 MiniMax-M3.1 压 1300 字约 2 秒，6 秒宽裕。README 同步。

- 2026-09-29 | 修复 | 删掉上一版加的 `reasoningEffort: "low"`：模型不支持这个档位时宿主直接拒掉整个请求（`APP_MODEL_UNSUPPORTED_REASONING`，实测 MiniMax-M3.1 就中招），从 14:55 到修复前每条长回复的速览全在失败。给不知道支持与否的参数硬塞固定值，是自己给自己挖坑。`maxTokens` 的提高保留，那部分对 gpt-6-luna 这类长思考模型仍然有用。
- 2026-09-29 | 修复 | “速览跳过”从 debug 提到 info：以前跳过原因不落盘，“没触发”这件事排查时两眼一抹黑，这次就因为漏看一条 WARN 白绕了一圈。

- 2026-09-29 | 修复 | 推理模型「连上了但没有正文」：思考 token 和正文共用 maxTokens，连通测试只给 16、Ask 判断 120、速览 200 都会被思考吃光。测试提到 512、Ask 判断 400、速览 800，并统一传 `reasoningEffort: "low"`。gpt-6-luna 那两次超时真相也是这个。
- 2026-09-29 | 新功能 | 三处模型测试失败终于会写日志（以前只回一句界面提示，日志里连个水花都没有），并新增流事件诊断：只记事件类型序列、字节数、stopReason，不记模型输出内容。

- 2026-09-29 | 新功能 | 长回复速览支持单独指定「速览模型」并带连通测试：默认跟随 Ask 判断模型，但大模型容易超时，建议单独选一个非推理的快模型。
- 2026-09-29 | 修复 | 速览失败时把错误码与原因写到本机 `last-summary-error.json`（作用域错误已修：catch 里读 try 块内 const 声明的变量会让错误处理二次崩溃）；超上限从 8 秒放宽到 20 秒；跳过时补一行 debug 日志。

- 2026-09-29 | 优化 | Ask 工具说明补全 options 每项的字段结构（`label` 必填、`detail` 可选），减少调用方猜字段名导致的无效调用。

- 2026-09-29 | 新功能 | 长回复速览改为引用块小卡接在原文末尾（`**速览** · 原文 N 字` + 最多三行要点），原文完整保留、位于速览上方；速览随正文一起进会话历史。

- 2026-09-29 | 修复 | 长回复简写不再改写正文：原文在界面和会话历史里完整保留，只多生成一份几行速览存入本地归档，等卡片形态接上后挂在消息下方。阈值设置不变。

- 2026-09-29 | 新功能 | 长回复自动简写：正文超过阈值时用模型压成最多三行要点，同时改写聊天显示与会话记录；原文先落到本机 long-replies 目录。阈值可在设置页调节，默认 600 字，用户明确要求长文时不触发。

- 2026-09-27 | 修复 | Ask 回答回传增加授权边界：选择只决定方案，执行外部或不可逆操作前核对是否已有针对具体动作的授权，缺少时再单独确认。
- 2026-09-27 | 修复 | 高影响 Ask 必须写清操作对象、后果、备份与替代方案，并明确选择不等于破坏性操作授权；本地 App 普通更新优先重新加载。
- 2026-09-27 | 新功能 | 主模型生成前注入条件式 Ask 引导，关键分岔优先走知意回复内卡片交接。
- 2026-09-27 | 新功能 | 新增 Ask 判断模型设置；只对含明显选择线索的当前输入调用一次 Hana 已配置模型，普通聊天不额外调用。
- 2026-09-27 | 修复 | 增加 Ask 判断模型连通测试按钮；保存后明确显示「已保存」，消除按钮灰态造成的状态不明。
- 2026-09-27 | 修复 | 将固定与条件式 Ask 引导追加到 Hook 的系统提示词，不再作为隐藏自定义消息注入，避免模型上下文将内部规则看成新发言。
- 2026-09-27 | 新功能 | Ask 可按问题语义选择单选/多选；多选支持最少/最多数量、复选确认与数组答案校验，覆盖聊天卡、悬浮球和原生回退。
- 2026-09-27 | 修复 | Ask 工具要求显式提交单选/多选模式；模型漏参时拒绝发卡，避免可多选问题静默落成单选并留下待办冲突。

- 2026-09-26 | 新功能 | 右键知意花球可打开只含「关闭悬浮球」的菜单，通过现有退出握手真正停止花球；不显示旧版发送方式。

- 2026-09-26 | 修复 | 知意 Ask 弹窗将问题、背景与推荐理由分开显示，正确标出推荐选项；可收起后继续回答，不影响花球启动。

- 2026-09-25 | 修复 | Windows 下保留 Python 用户级包所需的 APPDATA，并从启动器枚举解释器、逐个验证 PyQt6 后再启动悬浮球。

- 2026-09-24 | 修复 | Windows 下优先使用 Python 启动器的默认解释器，避免选中缺少 PyQt6 的 Python 环境。
- 2026-09-24 | 新功能 | 知意改为 Hana 固定整页入口，设置页重新整理为关键 Ask、可选悬浮球和权限说明。
- 2026-09-24 | 新功能 | 完成首条关键决策 Ask：伙伴可等待用户结构化选择并接续原任务，拒绝/超时/关闭均不视为同意。
- 2026-09-24 | 修复 | 超长问题/背景/选项文本不再静默截断；超限直接拒绝，补充说明完整保留，并将用户背景字段与宿主会话上下文分开。

- 2026-10-22 | 修复 | 朗读列表在长对话里永远只列得出开头的几轮（实机：这段 600 多条的会话，`session:history` 只回开头 200 条，列表最上面标的「最新」其实是我三轮前的回复）：朗读数据源改用 v2 的 `session:entries`，沿 parentId 把当前分支回溯成一条时间线再取尾部，旧分支/被改掉的回复不进列表；entries 拿不到时回落 history（短对话仍可用）

- 2026-10-22 | 优化 | 输入栏 🌸 按钮改成开关（跟表情包那边一套）：第一下挂出知意面板，再点一下收起（走 userInteraction.dismiss），第三下再打开；面板被宿主收起/关掉时前端用 keepalive 请求报 /suggest-panel/hidden，后端清掉「开着」标记，避免下次点按钮被误判成收起；面板自己的「收起」按钮也会清标记
