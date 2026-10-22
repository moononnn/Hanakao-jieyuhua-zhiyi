---
name: zhiyi-ask-handoff
description: "知意关键 Ask 卡片两回合交接：收到知意待发卡时展示配方卡、绑定原会话；收到 zhiyi_ask_answer 卡片事件时核验并续原任务。MANDATORY TRIGGERS: 知意待发卡, zhiyi_ask_answer, 知意配方卡回传。"
default-enabled: true
---

# 知意 Ask 卡片交接

仅在 `jiegehua_zhiyi_ask` 返回「知意待发卡」或收到 `zhiyi_ask_answer` 卡片事件时运行。读取本 App 的 `recipes/zhiyi-ask/SKILL.md` 并严格执行。卡片数据来自工具返回的 JSON，不能自己猜；发卡、绑定、宿主数据初始化全成功前，不宣称用户已经看到能点的卡。点击事件开启新回合；核验 App 的 `jiegehua_zhiyi_resolve_card` 成功前，不能把事件里的选项当成有效决定，更不能依赖它做外部动作。`resolve_card` 是有效性的唯一裁判：它回报有效就续上任务，它拒绝才停下解释。不要因为 `ui_inspect` 说这张卡“不在 open instances / 可能已关闭”就放弃已经送达的选择——对话内嵌卡发出事件后就不再是 open instance，那是常态，不是没作答的证据。**发卡到收到事件之间不要重载 App 或重装 Recipe**：待发卡表是 App 进程内存里的，重载即清空，用户的真实选择会被 `resolve_card` 误判为「已过期或所属会话不符」而拒掉。
