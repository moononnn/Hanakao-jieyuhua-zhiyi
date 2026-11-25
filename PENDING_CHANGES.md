# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.4.1（2026-11-22），内容见 `CHANGELOG.md`。

## 待发

- 关机提醒恢复整行长条（0.4.1-dev.11，作者看 dev.10 实机后拍板：右列半宽下面留白不好看，反正点了才出现，改回整行）：`.shutdown-warning` 的 `grid-column` 由 2 改回 `1 / -1`，仍默认 `display:none`、仅 `[data-armed="1"]` 展开。平时不显示所以整行不会再被误读成说整页；点了关机才以长条铺在格子下方。改动限 `ui/assets/suggest-panel.css`、`ui/suggest-panel.html` 注释与 `tests/suggest-panel-ui.test.js` 断言（须整行+默认隐藏+armed 展开）。全量 923 项 921 过 0 失败 2 既有跳过。仅本机开发存档，未推送、未打 tag、未上市场。详见 TESTING.md。

- 关机提醒改「点了才展开」（0.4.1-dev.10，作者实机 dev.9 后反馈：悬停就展开太跳）：撤掉 `:hover`/`:focus-visible` 展开与关机按钮的 mouseenter/mouseleave/focus/blur 重量监听，只留 `[data-armed="1"] + .shutdown-warning` 展开——点了关机开启才出现提醒，再点取消就收。高度回落走 refreshShutdownState 既有重量，不需额外监听。改动限 `ui/assets/suggest-panel.css`、`ui/assets/suggest-panel.js`、`ui/suggest-panel.html` 注释与 `tests/suggest-panel-ui.test.js` 断言（须 armed 展开、不得 hover/focus 展开、不得四事件监听）。全量 923 项 921 过 0 失败 2 既有跳过。仅本机开发存档，未推送、未打 tag、未上市场。详见 TESTING.md。

- 关机保存提醒归属修复（0.4.1-dev.9，作者 2026-11-25 截图批注：整行警告压在「随手记＋关机」最后一行底下，读起来像说整页；讨论后作者选方案3）：警告不再占整行（`grid-column:1/-1` 改 `2`，只贴关机正下方右列），平时 `display:none` 收着，悬停/聚焦/已开启（`#toggle-shutdown:hover/:focus-visible/[data-armed="1"] + .shutdown-warning`）才展开；关机格小字顶一句提前量「Hana 干完才关 · 先存好别的」，警告文案改「关机前请先存好别的：」。展开/收起会改页高，给关机按钮加 mouseenter/mouseleave/focus/blur 重量一次免得 iframe 裁掉。改动限 `ui/suggest-panel.html`、`ui/assets/suggest-panel.css`、`ui/assets/suggest-panel.js` 与 `tests/suggest-panel-ui.test.js` 新增用例。全量 923 项 921 过 0 失败 2 既有跳过。仅本机开发存档，未推送、未打 tag、未上市场。详见 TESTING.md。

- 点分组标记自动收起新建区（0.4.1-dev.8，作者 2026-11-25：点标签意味着想看记录，应直接进入输入框缩小态）：chip 点击在 setGroup 之外主动 `setCollapsed(true)`，把高度让给列表。难点是筛选会把列表夹回顶、补一个 `top<=1` 滚动事件，触发「滚回顶展开」把刚收起的又弹回；加 400ms 保护期 `holdExpandUntil`，展开分支须 `Date.now() > holdExpandUntil` 才生效，躲开这次程序性夹顶，之后用户真滚回顶仍正常展开。改动限 `ui/assets/quick-notes.js`（声明 + 展开分支 + chip 处理器）与 `tests/quick-notes-ui.test.js`（dev.5 断言同步加保护期、新增 chip 收起断言）。沙盘：点「茶话会」→ after4/dropdown茶话会/pressed true/collapsed true，再点取消 collapsed 仍 true。全量 922 项 920 过 0 失败 2 既有跳过。仅本机开发存档，未推送、未打 tag、未上市场。详见 TESTING.md。

- 随手记列表分组标记可点筛选（0.4.1-dev.7，作者 2026-11-25 截图批注意见1：分组标记只有样子不能点）：列表每条的分组 chip 由死 span 改为按钮，点一下只看该组、再点一下取消，选中态实心苔绿（`aria-pressed`），与「全部分组」下拉双向同步。顺带修了 `paintGroupFilter` 旧毛病：选项只在分组集合变时重建、选中值却跟着早退不同步，导致从 chip 筛选时下拉不跳；现改为选项按需重建、选中值每次 render 都跟。改动限 `ui/assets/quick-notes.js`（buildListItem 分组按钮 + paintGroupFilter）、`ui/assets/quick-notes.css` 与 `ui/suggest-panel.html` 内联样式（新增 `.notes-chip-group` 可点/悬停/选中态，两份逐字同步有测试盯）、`tests/quick-notes-ui.test.js` 新增用例。沙盘验证：点「茶话会」chip 列表 10→4、下拉跳「茶话会」、pressed=true；再点 4→10、下拉回「全部」。全量 922 项 920 过 0 失败 2 既有跳过。仅本机开发存档，未推送、未打 tag、未上市场。详见 TESTING.md。

- 随手记「记一笔」展开后可再收起（0.4.1-dev.6，作者 2026-11-25 验收 dev.5 后提）：点「＋ 记一笔」展开大输入框后，旧代码把 collapse 武装关掉（`armed=false`），导致再往下滚不会收回去，必须先滚回顶。现改为点「＋ 记一笔」时 `armed=true` 重新武装，展开后往下滚过 24px 仍能收回；展开本身只把列表帽子压回 140、scrollTop 向下夹（dir<0），不会刚展开就又被收走。改动限 `ui/assets/quick-notes.js` 该点击处理器一行 + 注释，及 `tests/quick-notes-ui.test.js` 新增回归断言（不得保留「newbar 点击 armed=false」旧块）。沙盘（rAF 换定时器）验证：下滚收起→点记一笔展开→再下滚重新收起，四态几何齐全。全量 921 项 919 过 0 失败 2 既有跳过。仅本机开发存档，未推送、未打 tag、未上市场。详见 TESTING.md。

- 随手记收起后被「弹回」修复（0.4.1-dev.5）：dev.4 的收起在作者实机看着像「收不起」——往下滚输入框不收、列表不长高。逐轮探针（HTML 侧 / JS 侧 / 滚动轨迹 / 收起瞬间几何，均只写后台日志、用完已拆）定位：收起逻辑与内联样式都生效，`is-collapsed` 也翻成了 true，但旧判断「收起后见 `dir<0` 或滚回顶就展开」太灵：收起那一刻输入框缩、列表长高、面板高度跟着变，会补出几个像素的向上滚动抖动，自己把自己弹回展开，肉眼看着就是一直展开。修法：展开只认「真正滚回顶（`top<=1`）」，中途向上抖几下不再弹回；点「＋ 记一笔」展开不变。改动限 `ui/assets/quick-notes.js` 一行判断 + 注释，及 `tests/quick-notes-ui.test.js` 新增回归断言（展开须为 `top<=1`、不得含 `dir<0` 弹回）。全量 `node --test tests/*.test.js` 921 项：919 通过 / 0 失败 / 2 既有跳过。实机探针轨迹确认收起后 `is-collapsed` 能持续、输入框真实缩高（edH 142→116→0 过渡）。未验证：作者重载后肉眼复验收放观感。仅本机开发存档，未推送、未打 tag、未上市场。详见 TESTING.md。

- 随手记列表让位与翻页（0.4.1-dev.4，作者 2026-11-24 拍板交互：不记住收起状态，分页与按组筛一起做）：新建区仍在最明显位置，列表往下滚过 24px 就把它收成一条「＋ 记一笔」，往回滚或点它展开，高度用 grid 行 1fr→0fr 过渡（浏览器算，不用 JS 量），收前记住光标、展开时还回去；同时把列表帽子从 140 提到 282，让出来的高度真的给条目。列表改为一次 10 条、快到底自动续，末尾留一行「还有 N 条」；工具条加分组下拉（选项来自已有笔记）。收起与筛选都不写存储，跟滚动走；重新读取后回第一页，空分组自动放掉。改动限 `ui/suggest-panel.html`、`ui/assets/quick-notes.js`、`ui/assets/quick-notes.css` 与对应测试，未动 `lib/**`、配方与发布边界。全量 `node --test` 920 项：918 通过 / 0 失败 / 2 既有跳过；新增 5 项单测（分组筛选、分页与回页、重读回第一页与空分组、滚轮收起不入库、notes-layout.css 与 quick-notes.css 逐字同步）。真实视图沙盘跑通：首页 10 条、末尾提示、下滚收起、滚到底续到 20 条、回顶展开、切组剩 7 条。**缓存绕行**：作者实机出现「HTML/JS 是新的、样式表还是旧的」（卡片高过 360、列表没有帽子、面板滑不动），换文件名（notes-layout.css）也不行，所以改为把整套随手记样式**内联进 `ui/suggest-panel.html`** 的 `<style data-notes-layout>`（不依赖任何子资源，跟 HTML 一起到）；`assets/quick-notes.css` 保留为唯一改动入口，两者有测试盯着逐字相等，日后若要拆回外链，先确认宿主不再缓存旧 `.css`。未验证：真机输入面板里的高度回落与动画观感、窄屏工具条是否换行、真实条目多到几百条时的滚动性能。仅本机开发存档，未推送、未打 tag、未上市场。详见 TESTING.md。

- 复用现有模型链与通道标识提示（0.4.1-dev.3）：自动整理动态跟随既有快速档 → 备用档，独立模型选择已由原正规工具 reset 并回读确认为 null，额外入口撤下；本条取代 dev2 的独立选择方案，发布时不要列入已撤功能。默认其他任务链不变，三档配置与 Provider 不改；生产提示词、300 字/70% 门槛、10 秒总预算和子代理隔离不变。运行日志确认 LongCat 被宿主 App 接口的 provider ASCII 校验拒绝；仅修快速档测试的准确错误提示，不冒充已修好实际连通，不改名、不猜通道 ID、不绕宿主接口。7 个相关测试文件 163 项：161 通过、0 失败、2 既有跳过；零次真实模型请求，新链速度和宿主附加效果未实机验收。仅本机开发存档和正式重载，未推送、未打 tag、未发布；原实验配方、交接规则、卡片测试及图标改动保留。详见 TESTING.md。

- 自动整理独立模型隔离（0.4.1-dev.2）：新增 `lib/reading-model.js` 与正式业务工具 `jiegehua_zhiyi_reading_model`，自动整理有自己的模型键 `replyReadingModel`（本机已合法设为目录内既有的 DeepSeek Flash），设了不再被共用快速档盖过，没设沿用旧速览链；主对话模型、共用快速档、内容/备用模型、会话起名、Ask 判断与任何 Provider/凭据均未改，工具只读写自己那一个键，set/reset 需 `confirm:true` 且写后回读核对。真实模型请求 4 次：短源 0 次调用；一份已分条的验证方案未被跳过（生成的总览被 70% 压缩门槛拦下）；两篇长文生成总览成功（5.667 秒 / 2.164 秒）；边界样例 4.701 秒生成。候选提示词未达标（该跳过的仍被整理、摘要仍保留大量像素/透明度细节），**不入运行源码**，临时候选 helper 与临时评测探针连同注册块已删除；生产判定段、300 字/70% 门槛、10 秒超时与子代理隔离均未改；宿主内附加卡观感未实机验。本轮不是新旧提示词的 A/B 对照。版本 dev2 仅表示独立模型隔离完成。**仅本机开发存档，未发布**：未推送、未打 tag、未上市场，不改已发布 0.4.1；实验配方、配套交接 skill、卡片模板与图标改动原样保留。详见 TESTING.md。

- 整理表达质量（2026-11-23 作者确认，0.4.1-dev.1）：借鉴 i-have-adhd 的行动可读性约定，仅细化 `buildReadingPrompt` 表达段。先回答对应判断/结果，分清完成、失败、未验；未知原因不写成确定因果，保留部分成功的数量与范围；原文由助手负责的排查不改成作者待办，执行者和授权条件不漂移；仅保留材料已有的后续安排，不强派任务或猜时间。原触发判定、300 字/70%门槛、模型调用、子代理隔离和后台诊断未改；无全局注入、无原回复改写钩子。新增六项中性样例契约/模拟管道回归，相关五文件 121 项中119通过、0失败、2项既有跳过；真实模型 A/B 和付费评分未运行，不能据此宣称真实生成质量达标。本机重载，不推送/发布，不改已发布0.4.1；实验配方与图标改动原样保留。详见 TESTING.md。

- Ask 卡到期反馈（授权：作者 2026-11-12 要求专修「过期后按钮变灰、没有明确提示」）。配方变更三处：`recipes/zhiyi-ask/assets/ask.card.html`（倒计时行、到点自动停表置灰并写明过期时间与服务端拒绝、无期限信息单独提示、过期后只留 `zhiyi_ask_expired` 请求按钮、`pagehide`/`beforeunload` 停表）、`recipes/zhiyi-ask/SKILL.md`（新增《到期与重新发问》，写明服务端无续期接口）、`skills/zhiyi-ask-handoff/SKILL.md`（触发词与过期语义）。验证：`node --test` 832 项 / 830 通过 / 2 跳过（跳过项为既有基线），新增 4 项卡到期用例全过。未验证：真卡实机走完十分钟到期、`zhiyi_ask_expired` 在宿主的真实投递只验了 emit 收包路径。已安装副本走 `extension_manager install` 重装，`stagedId stg_95b11babfa2a5bf6`，等作者在 App 里确认后才算同步；确认前已安装副本仍是旧模板。未发布、未打 tag、未上市场。

## 记着但不在待发里的

- 输入框图片放大只下了 UI：`index.js` 的 `/input-zoom` 三条路由、`lib/input-zoom.js`、`assets/install-input-zoom.ps1`、`assets/input-zoom-script.js` 都还在包里，但已无调用方。安装那条会以 `-ExecutionPolicy Bypass` 起 `powershell.exe` 往 Hana 的 renderer 目录写脚本，属没有用处的特权写入路径，下一版该删净。
- 发布包里的 `sdk/` 只带真实 import 的 5 个文件（server-client / bus-requests / model-stream / sdk-error / rpc-error），与仓库跟踪范围一致；宿主升级 SDK 时要手工同步这 5 个，否则会悄悄落后于宿主版本。整箱备份在本机工作台外的备份目录。
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
