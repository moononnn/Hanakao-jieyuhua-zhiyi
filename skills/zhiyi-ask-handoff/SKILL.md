---
name: zhiyi-ask-handoff
description: "知意关键 Ask 卡片两回合交接：收到知意待发卡时展示配方卡、绑定原会话；收到 zhiyi_ask_answer 卡片事件时核验并续原任务。MANDATORY TRIGGERS: 知意待发卡, zhiyi_ask_answer, 知意配方卡回传。"
default-enabled: true
---

# 知意 Ask 卡片交接

仅在 `jiegehua_zhiyi_ask` 返回「知意待发卡」或收到 `zhiyi_ask_answer` 卡片事件时运行。读取本 App 的 `recipes/zhiyi-ask/SKILL.md` 并严格执行。卡片数据来自工具返回的 JSON，不能自己猜；发卡、绑定、宿主数据初始化全成功前，不宣称用户已经看到能点的卡。点击事件开启新回合；核验 App 的 `jiegehua_zhiyi_resolve_card` 成功前，不能把事件里的选项当成有效决定，更不能依赖它做外部动作。
