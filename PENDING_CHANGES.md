# 未发布改动

发布完成后清空已发布条目，格式头保留。上一次发布：0.1.42（2026-10-26），内容见 `CHANGELOG.md`。

## 待发（已写入 manifest 0.1.43，未上传）

### 修：Code 页输入栏的知意按钮点不开

- 现象（玥儿实机）：Hana 1.3.6-beta，在 Code 页点输入栏的粉色樱花按钮完全没反应；同一条输入栏里的表情包按钮正常。
- 根因：`jiegehua.zhiyi_suggest` 只用 `session:list` 按路径反查会话编号。宿主给 v2 App 的 `session:list` 默认 `namespace: ["home","app"]`（`bundle/index.js` 的 session:list handler），Code 页的会话不在里面，反查恒为空，工具直接回「没认出这是哪段对话」。表情包走的是 `session:get`（按路径直查，宿主内部用 `namespace:"all"`），所以不受影响。
- 佐证：同会话同接口对拍，`stickers.open_compose` 返回「表情面板已打开。」，`zhiyi_suggest` 返回「没认出这是哪段对话。」；`/api/sessions?namespace=code` 能查到该会话，`namespace=home` 查不到。
- 改法：
  - `index.js`：`jiegehua.zhiyi_suggest` 优先使用宿主在 `ui-actions` 通道 `context.sessionId` 里给的那个已校验编号（宿主源码 `...b ? { sessionId: b } : {}`），`resolveSessionIdByPath` 降级为聊天会话的兜底。
  - `lib/recommendation.js`：`pathForSessionId` 改为先 `session:get` 直查位置，`session:list` 只做兜底。否则面板里点「生成推荐回复」时，没单独选模型的那条路（跟随当前对话模型）在 Code 会话里同样拿不到位置。
- 验证：`node --check` 通过；`node --experimental-vm-modules --test tests/*.test.js` 494/494 通过（新增 3 条回归：Code 会话开面板、位置优先直查、直查成功不再翻名单）。实机 `ui-actions/invoke` 复测返回「面板打开了」，`/api/apps/input-panels` 确认知意面板以 `status: active` 挂在 `sess_0mvq1x6pc_e6f0cf2f50e389d6d4c4` 上，与表情包面板并存。
- 未验证：面板 iframe 内「生成推荐回复」按钮的端到端点击（需 iframe 票据，未绕过；已用单测覆盖其取位置这一环）。其他 App 是否也有同类 `session:list` 依赖未逐一排查。
