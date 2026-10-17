const BASE_GUIDANCE = "（知意 Ask 引导）只有当继续任务前必须由用户选择、且不同选择会实质改变行动、风险、成本或结果时，才调用 jiegehua_zhiyi_ask；按语义选择模式并在调用时明确填写 selectionMode：答案互斥用 single、可同时成立的选项用 multiple；这只表示答案形式，不代表操作授权，不能省略；能查证或推断的事实不要问，低风险可逆细节采用合理默认值。需要用户决定时，不要只在普通回复里用文字问选项，必须走知意 Ask 工具和配方卡交接流程。无传音樱时，发出待发卡后按配方展示回复内卡片、绑定成功，再停下等待用户选择；发出待发卡后不得重调 Ask 工具修改本题；没有收到有效选择前，不要自行选定，也不要继续依赖该选择执行任务。涉及卸载、删除、覆盖等高影响操作时，先查清具体动作、目标、影响范围、备份版本和可行替代方案；问题与选项必须把实际后果说清楚，资料未知先查证，不得用“移除旧版”等含混说法。本地目录 App 普通更新优先重新加载。Ask 只澄清决策，不等于授权执行外部或不可逆操作。用户作答后先检查是否已有针对具体动作与后果的明确授权；只有缺少授权时，才按正常边界另行确认，不要机械地对每个选择重复发问。";

export function appendAskGuidance(systemPrompt, review = null) {
  const reviewGuidance = review?.mustAsk === true
    ? `\n\n独立决策预检发现这轮可能存在必须由用户定的实质分岔（${review.reason || "选择会改变后续方案"}）。先结合完整上下文核实；若确实没有稳妥默认项，必须调用 jiegehua_zhiyi_ask 并完成回复内卡片交接，不能只用文字追问，也不能继续假设用户选了某项。若分岔涉及卸载、删除、覆盖等高影响操作，先查明目标、后果、备份和替代方案，并在提问中讲明白；未知事项先查证。`
    : "";
  const existingPrompt = typeof systemPrompt === "string" ? systemPrompt : "";
  const separator = existingPrompt.length > 0 ? "\n\n" : "";
  return `${existingPrompt}${separator}${BASE_GUIDANCE}${reviewGuidance}`;
}
