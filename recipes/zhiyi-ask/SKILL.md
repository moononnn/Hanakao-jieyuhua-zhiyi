---
name: zhiyi-ask
description: "知意无悬浮球时，把关键选择做成随对话滚动的交互卡。MANDATORY TRIGGERS: 知意待发卡, zhiyi_ask_answer, 知意选择卡, 知意 Ask 卡片交接。"
profile: card-skill
default-enabled: true
---

# 知意 Ask 交接卡

这份配方随知意 App 安装。无球时 `jiegehua_zhiyi_ask` 返回「知意待发卡」及 JSON；那只是待办，**还没有收到用户的选择**。

### 高影响操作的提问护栏

涉及卸载、删除、覆盖或其他难以撤销的动作时，发问前先查实具体动作、对象与实际影响范围；确认当前备份确实存在并核对覆盖的版本，同时查明不造成该损失的替代路径。若是本地目录 App 普通更新，优先使用重新加载，不要把卸载重装当刷新。问题和选项要直说会发生什么，避免“移除旧版”“继续更新”等掩盖后果的简称；未知的目录状态、备份状态或宿主行为先查证，不能猜成确定事实。

用户在 Ask 卡里选了一个方案，只表示作出该选择，不自动授权执行未明确说明的外部或不可逆操作。作答后先检查是否已有针对具体动作及后果的明确授权；只有缺少授权时，才在普通权限与确认边界内另行确认，不要机械地对每个选择重复发问。已发出的卡片不得重调工具改题；若发现描述有误，停止依赖该选择，向用户说明并另行处理。

1. 调用 `jiegehua_zhiyi_ask` 时必须先按选项语义明确填写 `selectionMode`：答案互斥用 `single`，能同时成立的项目用 `multiple`；它只表示答案形式，不代表执行授权，不能省略。无球返回待发卡后不可重调 Ask 工具修改本题。用 `show_card` 的 `template: "zhiyi-ask/assets/ask.card.html"`，`title` 为该题标题，`state` **完整传入**工具给的 JSON（`askId`、`expiresAt`、问题、选项、`selectionMode`、数量限制、推荐与理由）。不要改写或省略选项。不用 `card.emit` 在页面加载时自动发话。单选点选后即时提交；多选先勾选，达到数量限制后点「确认选择」再一次提交。
2. 从 `show_card` 返回值取得宿主铸造的 `cardInstanceId` 与 `cardEntityId`。先调用 `jiegehua_zhiyi_bind_card({askId,cardInstanceId})`；成功后调用 `update_card_data({cardEntityId, data:{askId,ready:true}})`；拿到当前会话编号时一并带上 `homeSessionId`。卡片只有收到这个宿主数据才开放点击。二者任何一步失败，不要声称已完成发问；若尚未绑定可调用 `jiegehua_zhiyi_native_fallback({askId})`，已绑定但未开卡则明确告诉用户当前卡不能作答，避免重复弹问。

   **注意**：`show_card` 不返回 `sessionId`，`homeSessionId` 是可选的（本目录的 `assets/ask.card.html` 已改成不把它当必填）。模板与全局安装的那份是两份文件，改一份不同步另一份；已发出的旧卡不热更新，修完必须发新卡验证。
3. 发完卡先停下，**不要自己选，也不要继续依赖这次选择的任务**。给用户一句简短说明即可。
4. 收到 `zhiyi_ask_answer` 事件时，以事件中的 `cardInstanceId` 精确调用 `ui_inspect`，核对来源就是知意卡且属于当前对话；如果卡片已关闭或来源不符，停止，不找同名卡。再把事件 `askId`、`action`、`choice`（单选为字符串，多选为选项字符串数组）、`note` 和真实来源 `cardInstanceId` 传给 `jiegehua_zhiyi_resolve_card`。只有它回报有效选择，才按用户选择续上此前任务；它拒绝旧卡、跨会话、过期、重复或非法选项时停下解释，不猜答案。
5. `action=rejected` 是明确暂不决定；用户关闭卡片无事件，不是同意。十分钟过期后不得自行沿用推荐项。换窗口或失去原任务上下文时，问用户，不凭空补原任务。

卡片点击开启**新回合**，不会恢复旧的工具 Promise。它不是外部操作授权：发邮件、删除文件等仍遵守正常确认与权限边界。配方不可用时回退原生确认卡前，要诚实说明该卡会占用阅读空间。
