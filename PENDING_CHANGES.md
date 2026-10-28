# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.1.43（2026-10-27），内容见 `CHANGELOG.md`。

## 待发

### 撤：报纸巡检补料不做了，整块剔除（待 0.1.44，2026-10-28）

- 决定（玥儿）：报纸（信息流巡检）这块优化**暂时不做**，从知意里整块剔除。用户拿到的知意不带这个功能，其余功能一个不少。
- 剔除范围（全部在未提交改动里，0.1.43 的已发布代码从没含过这部分）：
  - `lib/feed-patrol-feed.js`、`lib/feed-taste-profile.js`、`lib/feed-archive-search.js`、`lib/feed-patrol-trace.js` 四个文件删除。
  - `index.js` 里对应的四处：四个 import、`buildPatrolSystemPrompt` 整个函数、`agent/before-start` 钩子里的巡检分支、`patrolTraceTimer` 定时器。
  - 工具 `jiegehua_zhiyi_feed_search_sessions` 整个注销（连同它的注释块）。
  - `tests/` 下四个测试文件删除：`feed-patrol-feed`、`feed-patrol-hook`、`feed-archive-search`、`feed-patrol-trace`，共 37 条用例。
- 为什么整块剔除而不是留一个开关：这个功能本身没验证成功过，留着开关等于把一个不确定的东西挂上去，还得为它维护一份「打开才生效」的路径。要重新做的时候从 git 历史捞更干净。
- 剔除前查清的两件事（记下来，将来要重做时省得重查）：
  1. **宿主的报纸总开关本来就有**，不在知意里：`feed.enabled`（默认 true）与 `feed.proactivity`（off / rare / mid / often），设置 → 工作中；改完立刻重载巡检排期。本机 `preferences.json` 现在是 `feed_proactivity: "often"`，没写 `feed_enabled`（等于开着）。
  2. **这套补料当时大概率没跑到。** 10-28 08:01 那轮巡检启动的瞬间，日志里有 `hooks.onDecision("agent/before-start") adjudicator threw; treated as no decision: App RPC concurrency limit reached`，宿主把整次判定作废了；那轮会话原文里「近 24 小时聊过的」仍是「- 无」。当天 08:51、09:03、09:04 又被挡了三次。`报纸巡检已补充上下文 ×N` 这行日志**一次都没出现过**。
- 验证：`node --test` **504 通过 / 0 失败 / 2 跳过**（原 541 − 37 条巡检用例）；`node --check index.js` 通过；全仓 grep `feed-patrol|feed-taste|feed-archive|报纸巡检|口味档案|feed_search` 只剩本文件；`manifest.json` 没有为这个功能加过任何权限，所以权限集合不变。
- 未动：`app-data/jiegehua-zhiyi/feed-taste-profile.json` 那份手工写的口味档案还在本机，属于运行时数据、不进包，也不影响功能。

### 修：输入栏面板「有时候点不开」（待 0.1.44，2026-10-27）

- 现象（玥儿实机，多次）：点输入栏的粉色樱花按钮没反应，得再点一下才出来。0.1.43 修的是 Code 页「完全打不开」，这次是「偶尔点不开」——两个不同的根因。
- 根因一（主动因）：**App 自己记着一份开关状态，会和宿主的真实状态分歧。** 旧实现是开关：内存里的 `openSuggestPanels` 记着「这段会话的面板开着」，第二下就 `dismiss`。但宿主关面板的路径很多（宿主自己的关闭按钮、切会话、App 重载），唯一能清这张表的通知是面板 iframe 的 `pagehide`/`visibilitychange`，它经常不发。一旦表里写着「开着」而宿主其实已经关了，点一下就只跑一个空 `dismiss`——界面上什么都没发生。
- 根因二：**折叠态下参数完全一致，宿主直接返回。** 宿主 `show()` 的判定是「标题、message、contentFrame、presentation 四项都没变就返回」，不做任何动作。如果面板被折叠过（还占位置，内容看不见），而 App 传的仍是默认展开值，参数一模一样 → 什么都不发生。
- 根因三：**一次点击串行跑六次 RPC，任何一环被拒就整次报废。** 宿主 App RPC 有并发上限（`class Y0`，`MAX_PENDING = 128`），超了返回 `APP_RPC_BUSY`。实测日志（`logs/2026-10-27_17-03-13.log`）一天里有 **3046 条** 「App RPC concurrency limit reached」。旧路径是 `storage.get → storage.set → show → storage.get → storage.set → logger` 串行链，人点按钮只想要面板出来，却被几次记账连坐。
- 改法（`index.js`）：
  - 删掉 `openSuggestPanels` 这张状态表，按钮不再是开关：**每次点都 `show`**。宿主 `show` 是按 `(session, app, id)` 原地 upsert 的幂等操作（`input-panels` store 的 `shownByOwner`），重复调用不会叠出两块。收起只走面板里的「收起」按钮和宿主自己的关闭。
  - `show` 显式传 `expanded: true`：只要参数不同于现状，宿主就会重新摊开，绕开「四项全一致 → 直接返回」那一条。
  - 核心动作与记账解耦：读常用回复失败按 0 条估高度；写状态失败不管；记 `panelId` 失败不管；`logger` 失败不管。只有 `show` 本身失败才报错。
  - `APP_RPC_BUSY` 不再甩英文原文，改成「这会儿忙不过来，等一秒再点一下。」
  - `/suggest-panel/hidden` 保留但不做事（旧版面板页面还会往这里发，接住就行）。
- 验证：新增/改写 4 条回归（不再自己记开关、每次显式要求展开、RPC 全满也要把面板摆出来、Code 会话里照样能开）；`node --test` **509 通过 / 0 失败**；`node --check index.js` 通过；`validate-app --dir .` 0 error / 1 warning（仅动态依赖未证明那条固定提示）；实机 `extension_manager reload` 后日志确认 `jiegehua-zhiyi loaded` / `v0.1.43 loaded`。
- 未验证：面板 iframe 内按钮的端到端点击（需 iframe 票据）；「3046 次 RPC 拒」里有多少来自知意自己没有单独统计，只能确认它不再是开面板的失败点。

### 修：关机守门人看不见 Code 页（待 0.1.44，2026-10-27）

- 现象（玥儿问的）：要「聊天页和 Code 页所有对话框都完成了才关机」，但实际可能 Code 页还在跑就关了。
- 根因：守门人只问两处——`session:list` 列会话再逐个 `session:context` 探忙闲、`tasks.list` 列后台任务。而宿主给 v2 App 的 `session:list` **把 namespace 写死**成 `["home","app"]`（`bundle/index.js` 的 session:list handler：`namespace: d ? ["home", "app"] : h ? "all" : "home"`），Code 页会话的 namespace 是 `code`，根本不在名单里；v2 契约的 `AppSessionListRequestV2` 也没有 namespace 字段，传不进去。于是 Code 页在守门人眼里**等于不存在**。
- 实机铁证（修复前，我自己就在 Code 页跑着）：`jiegehua_zhiyi_idle_probe` 返回 `sessions.recentCount: 0, busyCount: 0, tasks.active: 0` —— 全空。
- 顺带发现的第二个洞：`judgeIdle` 只校验 `tasks.readable`，**不校验 `sessions.readable`**。`session:list` 抛错时会话层整体瞎掉，只要任务层空着就照常关机。
- 改法：
  - 新增 `lib/activity-ledger.js`：从**全局 `ctx.bus.subscribe`**（不给 `filter.sessionPath`）收每个会话的事件记账。这条路跟 namespace 无关，而且事件自带 `sessionPath`，不需要先知道 `sessionId`——正好绕开 `session:list` 给不出 Code 会话编号的死路。
  - 忙闲口径：`turn_start`/`agent_start`/`message_*`/`tool_execution_*`/`compaction_start`/`queue_update` 记忙；`agent_end` 且 `willRetry !== true` 才算说完，之后还有 90 秒宽限兜事件尾巴；标着忙却 45 分钟毫无动静的，不再拦关机但单列进 `stale`（会话大概已经没了，不能无限拦）。
  - 每次采样都读这一层（`lib/idle-watch.js` 第五步），`summarizeSnapshot` 单列 `events`，`busy` 条目带 `source: "events"`，看得出是哪一层在拦。会话层已经报过忙的不重复算。
  - `judgeIdle`（`lib/sleep-guard.js`）：`sessions.readable !== true` 也按忙算，与任务层同等严格。
  - 账本放在 `activity-ledger.js` 的模块级变量里（`setActivityLedger`/`getActivityLedger`），不靠调用方逐个传——采样入口不止一个（守门人、开发探针），少传一处就会出现「同一时刻两个入口一个说有活一个说空」。
  - 工具描述与 `enable-real`/`disable-real` 文案跟代码对齐：演练已于 2026-10-21 退役，总开关不再拦任何东西，以前描述写「默认只演练」是残留。
- 验证：新增 `tests/activity-ledger.test.js` 13 条（含「Code 页在跑、会话层任务层都空也要拦住」「会话层读不到也按忙算」「账本缺席不该拦关机」）；`node --test` **509 通过 / 0 失败**。**实机复测（reload 后）**：同一个探针变成 `events.readable: true, tracked: 1, busyCount: 1`，抓到的正是我自己这段 Code 会话（`source: "events"`，`streaming: true`），而会话层仍然是 `recentCount: 0`——修复前是 0，修复后是 1。
- 复查时补上的第三个洞（同日）：**App 重载后的账本是空的，而「空账本」等于「什么都没在跑」。** 升级、改代码、宿主重启都会让 App 重载，可那时 Code 页那一段可能正跑着几十分钟的活，不会因为重载就停。账本刚要那一下会把这种情况报成全空。改法：`createActivityLedger` 带 `warmupMs`（默认 `WARMUP_MS = 3 分钟`），刚建立那段时间的 `snapshot()` 返回 `warmingUp: true`；`judgeIdle` 在「warmingUp 且账本为空」时按忙算（`eventsUncertain: true`），但账本真报出了忙就按那个忙算（不一律阻着）。过了预热期仍空才允许说真空。采样层同步单列 `events.warmingUp`。
- 关机通知文案也补了第三层：原来只说「扫了 N 个窗口，后台任务……」，现在加一句「事件层盯着 N 段会话」。不报的话，人看到「活都完了」分不清是真看过还是没看见；事件层读不到时会明说「聊天页以外的会话可能没看见」。
- 最终验证：`node --test` **513 通过 / 0 失败**（账本测试 17 条）；实机 reload 后立即采样：`events: { readable: true, tracked: 1, busyCount: 1, warmingUp: true }`，`busy` 里正是我自己这段 Code 会话（`source: "events"`），而 `sessions.recentCount` 仍是 0。用这份真实快照跑判定对照：Code 页在跑 + 空够 10 分钟 → `busy: true, fire: false`（拦住）；去掉事件层（等于修复前）→ `busy: false, fire: true`（会关机）。
- 未验证：Code 页一段长任务跑完时 `agent_end` 的释放时机没实跑几十小时确认（只靠单测与 90 秒宽限兜底）；没真挂守门人跑一整晚做端到端验证。

### 改：关机只负责两件事，但把关机文案说清楚（待 0.1.44，2026-10-28）

- 定位（玥儿定）：这个功能只负责 **① 判断 Hana 什么时候真干完 ② 到点执行关机**。
  不管别的程序存没存盘，也不做人工点击确认：痛点是「我要睡了，Hana 还在跑，不想爬起来关」。
- 查实的一个事实：`shutdown.exe /s /t xxx` 在 `/t` 大于 0 时 **`/f` 是隐含的**（微软文档明写），
  而 `/f` 是「强制关闭程序、不提示保存」，文档自己也标了「可能导致未保存数据丢失」。
  也就是说原来的关机路径 **连 Windows 那个「这些程序阻止关机」界面都不会出现**，是静默强杀。
- 讨论过但**没采用**的 `/soft`：它是「请求程序关闭并等它们自己结束」。
  听着更安全，但在「人已经睡了」这个场景里会卡死——有程序弹了「要不要保存」的框在等人点，
  关机就整夜挂着，第二天的结果是「机器没关成」。所以它反而违背了这个功能的定位。
- 改法（只改文案与展示，不改判定逻辑）：
  - `lib/sleep-guard.js` 新增 `SAVE_REMINDER`，写进**挂上守门时**、**倒计时开始时**、**真的关机时**、演练结束时的四条通知。
    挂上那一刻最重要：那时人还醒着、来得及存。等到倒数才开始说，人可能已经躺下了。
  - 关机命令 **完全没改**（`/s /t 30`，参数、环境、启动方式跟 0.1.43 一致）。
    过程中我曾把它改成 `/t 300` + `/c` 想多给个存盘窗口，后来 **退回去了**：
    这次改动的目的是「关机看得见 Code 页」，不是改关机本身。
    关机命令一变，玥儿之前连续几天实机验证过的那份证据就作废了，得重新验一遍，不值得。
    要改 `/t` 应该单独立项、单独验。所以「不亲自验证关机」是成立的——因为关机那段代码路径一行没动。
  - 提醒全部只走通知与界面文案：
    - `lib/sleep-guard.js` 新增 `SAVE_REMINDER`，写进**挂上守门时**、**倒计时开始时**、**真的关机时**、演练结束时的四条通知。
      挂上那一刻最重要：那时人还醒着、来得及存。等到倒数才开始说，人可能已经躺下了。
  - **取消已经发出的关机**（2026-10-28 玥儿问「按取消能不能取消」时查出的真缺陷）：
    以前 `cancelSleepGuard` 只把本地状态改成 `cancelled`，**从来没调过 `shutdown /a`**。
    于是那 30 秒里就算在面板上点「取消」，机器照样会关——反馈说撤了、其实没撤。
    现在：命令已发出时取消会真去发 `shutdown /a`，并把成败如实报出来（工具文本、面板 409、通知三处一致）。
    实机验证：真发 `shutdown /s /t 30`（退码 0）→ 等 3 秒 → `shutdown /a`（退码 0，救回来了）→ 再确认已无排队关机（1116）。
  - `shutdown-issued` 现在也算激态（`armed`），否则面板会显示「没在守」、提示条直接收掉，人以为没事了。
    新增 `abortLeftMs`：报出还剩多少秒可撤。提示条会写「关机已发出，约 N 秒后关（还能撤）」。
  - `/c` 提示语加回来了（`SHUTDOWN_COMMENT`），不带任何强杀风险，只是屏幕与事件日志里多一句话。
    但 `/t` 仍是 **30 秒没改**。
  - **关机提示条挂不到 Code 页**（2026-10-28 玥儿实机碰到：在 Code 页点了关机，输入框上方一条提示都没出）。
    根因跟守门人是同一个洞：候选会话名单只来自 `session:list`，
    而宿主给 v2 App 的 `session:list` 把 namespace 写死成 `home / app`，
    Code 页（`namespace=code`）根本不在里面。
    既然看不见，就挂不上去——人想反悔都找不到入口。
    修法：账本新增 `paths()`（按最近动静排序），
    `pickRecentSessionPaths` 把账本里的会话**排在前面**补进候选名单。
    实机验证：当前 Code 页会话 `01a17dfe` 已出现在 `candidates` 与 `mounted` 里。
  - 新增 `GET /sleep-guard/banner-debug` 和落盘的 `shutdownBannerDebug`：
    直接看提示条挂到了哪几段、候选名单里有没有那段、账本里到底知道多少段。
  - 新增测试：把 session:list 弄成只给 home 那一段，用全局事件写一段 Code 会话进账本，
    验证提示条会往 Code 页挂。**撤掉补丁验证过它会挂**（那时实际只挂到 `home.jsonl`）。
  - **小工具页内容被切掉、得滚动才看得全**（2026-10-28 玥儿截图指出）。
    根因：那页高度写死 `TOOLS_PANEL_HEIGHT = 300`，我加的那行保存提醒实测占 48px，
    内容底部跑到 320px，iframe 只给 300px——底下就被切了。
    修法：改成 `measureToolsPageHeight()` 量真实高度（内容底部 + 面板下 padding 14px），
    不再写死。写死高度这种事以后加一行字就会重现。
    `MAX_PANEL_HEIGHT` 从 560 提到 640（实测含页签需要 561px，就差 1px）。
    无头浏览器实测：算出来 336px，按 336px 视口截图，保存提醒那行完整可见。
  - 输入框上方那条常驻提示条（`describeShutdownBanner`）尾巴加「· 别的内容请先存好」；
    演练时明写「演练中（不会真关）」，不再让它看起来像真关机。
  - 面板上的关机格子下面单独加一行 `.shutdown-warning`（自己的颜色和底色，不藏在按钮小字里），
    明说「它只等 Hana 的窗口和任务跑完，不会替你保存 Word、PS、浏览器里没提交的内容」。
    新加 `--warn` 色变量（明暗两套主题都给了值）。
- 顺手修的三个真 bug：
  1. `status` 里用了一个从没声明过的 `realEnabled`，必然抛 `ReferenceError`，工具回「守门没弄成」。现在自己读一次。
  2. `status` 那行写死的「现在是真关机」——演练也这么说。现在按 `dryRun` 如实报。
  3. 状态行说「已经空了 0 秒」，时间线同时说「忙 7 处」，自相矛盾。
     现在 `describeSleepGuard` 带上 `busyCount`，有活时说「还有 N 处在跑，所以还没开始算空」。
- 新增 `rehearse` 动作：整套流程真跑（采样、判定、倒计时、撤销、通知、记录），只有 `executeShutdown` 里的
  `dryRun` 分支不执行关机命令。`arm` 保持真关机不变。
- **撞上并修掉的另一个真 bug（很重要）**：`index.js` 启动时那个 `syncInputStatusVisibility` 定时器，
  在 App reload 窗口期调 `inputStatus.set` 会被宿主拒（贡献表快照里还查不到本 App 的声明），
  而这个异常会从异步任务冒出去，宿主直接判「plugin failed to load」把 **整份 App 下掉**（工具全部消失）。
  实机日志：`plugin "jiegehua-zhiyi" failed to load: App jiegehua-zhiyi has no declared input status item zhiyi-suggest`。
  修法：延迟 4 秒；异常自己吞掉；一条写失败就当场停整趟（这种错每个会话报一次只是刷日志）；15 秒后重试一次；再不行就等下次启动。
  失败不影响功能：按钮默认就是显示的，这个同步只在「用户把按钮关了」时才有意义。
- 验证：`node --test` **515 通过 / 0 失败**（新增 2 条：挂上时必须提醒存盘、演练通知不能说成真关机）；
  `node --check` 三个改动文件均通过；`validate-app --dir .` 0 error / 1 warning（仅固定的动态依赖提示）。
  实机：连续两次 `extension_manager reload` 均正常装载（`v0.1.43 loaded`），无 `failed to load`；
  `status` 能正常返回且如实报「演练中：流程全真，最后一步不执行关机命令」；
  落盘状态确认 `dryRun: true, real: false`（演练不会执行关机命令）。
- 未验证：面板上那行橙色提醒与提示条尾巴文案没截图看过渲染效果（只过了语法与结构校验）；
  真关机路径没有实机跑一次（**但那段代码一行没改**，见上：`/s /t 30` 原样保留，
  玥儿 0.1.43 及以前连续几天实机验证通过，那份证据仍然有效）。

### 清理：删掉误入包的旧图标备份（待 0.1.44）

- 删了什么：`assets/_backup/assets_icon.svg`、`assets/_backup/ui_assets_cover.svg`。两个 2026-09-24 的旧图标备份，2026-10-25 首次公开时（`6ba7846`）一起进了仓库。
- 为什么删：全库扫描（js/mjs/html/css/json/md）对 `_backup`、`assets_icon.svg`、`ui_assets_cover.svg` 零命中；`manifest.json` 用的是 `assets/icon.png`、`assets/input-icon-pink.png`、`assets/nav-icon-adaptive.svg`，跟这两个无关。它们是开发残留，不该随包发布。
- **成因**：`.gitignore` 里有 `*.bak`、`*.bak-*`，但当时这两个文件没有后缀、直接叫 `.svg`，所以没被拦住。以后放备份请用 `.bak` 结尾，或者干脆放仓库外。
- 影响：0.1.43 的 Release 包（`app-jiegehua-zhiyi-0.1.43.zip`，sha256 `c1fc67b4…9151`）里还带着这两个文件。已发布的东西不重写、不重新打包，市场登记的 sha256 也照旧。下一次发版自然就不带了。
- 验证：`node --test` 478 通过 / 0 失败 / 2 跳过，与删除前完全一致；`node --check index.js` 通过。

### 已发布：修 Code 页输入栏的知意按钮点不开（0.1.43，2026-10-27）

- 现象（玥儿实机）：Hana 1.3.6-beta，在 Code 页点输入栏的粉色樱花按钮完全没反应；同一条输入栏里的表情包按钮正常。
- 根因：`jiegehua.zhiyi_suggest` 只用 `session:list` 按路径反查会话编号。宿主给 v2 App 的 `session:list` 默认 `namespace: ["home","app"]`（`bundle/index.js` 的 session:list handler），Code 页的会话不在里面，反查恒为空，工具直接回「没认出这是哪段对话」。表情包走的是 `session:get`（按路径直查，宿主内部用 `namespace:"all"`），所以不受影响。
- 佐证：同会话同接口对拍，`stickers.open_compose` 返回「表情面板已打开。」，`zhiyi_suggest` 返回「没认出这是哪段对话。」；`/api/sessions?namespace=code` 能查到该会话，`namespace=home` 查不到。
- 改法：
  - `index.js`：`jiegehua.zhiyi_suggest` 优先使用宿主在 `ui-actions` 通道 `context.sessionId` 里给的那个已校验编号（宿主源码 `...b ? { sessionId: b } : {}`），`resolveSessionIdByPath` 降级为聊天会话的兜底。
  - `lib/recommendation.js`：`pathForSessionId` 改为先 `session:get` 直查位置，`session:list` 只做兜底。否则面板里点「生成推荐回复」时，没单独选模型的那条路（跟随当前对话模型）在 Code 会话里同样拿不到位置。
- 验证：`node --test` 478 通过 / 0 失败 / 2 跳过（新增 3 条回归：Code 会话开面板、位置优先直查、直查成功不再翻名单）。实机 `ui-actions/invoke` 复测返回「面板打开了」，`/api/apps/input-panels` 确认知意面板以 `status: active` 挂在 `sess_0mvq1x6pc_e6f0cf2f50e389d6d4c4` 上，与表情包面板并存；玥儿实机点开面板并点「生成推荐回复」均正常。
- 未验证：面板 iframe 内「生成推荐回复」按钮的端到端点击（需 iframe 票据，未绕过；已用单测覆盖其取位置这一环）。其他 App 是否也有同类 `session:list` 依赖未逐一排查。没单独指定推荐模型那条分支（`pathForSessionId`）只有单测证据，未实机跑过。`validate-app --smoke` 因本机 Node 24（需 26+）未跑。
