# 测试

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
- Python 全部移植文件语法解析；不会生成 `.pyc`。

## 当前验证记录

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
