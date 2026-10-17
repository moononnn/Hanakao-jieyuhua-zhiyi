const DEFAULT_STYLES = [
  { name: "追问/延伸", intent: "顺着话题往下问一句，或延伸到自己关心的事" },
  { name: "分享/感慨", intent: "分享自己的感受或关联的事，带点情绪" },
  { name: "行动/请求", intent: "让伙伴帮忙做点什么、解释什么或推荐什么" },
  { name: "玩笑/俏皮", intent: "用俏皮、调侃的方式说话" },
];

const AI_FLAVOR_PATTERNS = [
  /比[^，。！？\s]{0,8}还/,
  /仿佛|宛如|犹如/,
  /不是[^。！？]{0,10}而是/,
  /与其说|某种|说不清/,
  /逻辑|哲学|诗意|灵魂|时光/,
  /一丝|一抹|刹那/,
  /哈哈确实|你说得对|真不错|原来如此/,
  /谢谢你的建议|麻烦你了/,
  /！{3,}/,
];

export function hasAiFlavor(value) {
  if (typeof value !== "string" || !value) return false;
  return AI_FLAVOR_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeStyles(styles, count) {
  if (!Array.isArray(styles)) return DEFAULT_STYLES;
  const mapped = styles.map((style, index) => {
    if (typeof style === "string") return { name: style.trim(), intent: DEFAULT_STYLES[index]?.intent || "按方向名理解" };
    if (style && typeof style === "object") return {
      name: typeof style.name === "string" ? style.name.trim() : "",
      intent: typeof style.intent === "string" ? style.intent.trim() : "",
    };
    return { name: "", intent: "" };
  }).filter((style) => style.name);
  return mapped.length >= count ? mapped : DEFAULT_STYLES;
}

export function buildStyleLines(count, styles, selected) {
  const amount = [2, 3, 4].includes(count) ? count : 3;
  const list = normalizeStyles(styles, amount);
  const indices = Array.isArray(selected)
    ? [...new Set(selected.filter((index) => Number.isInteger(index) && index >= 0 && index < list.length))].slice(0, amount)
    : [];
  const chosen = indices.length === amount ? indices : Array.from({ length: amount }, (_, index) => index % list.length);
  return [
    `4. ${amount} 条请分别按以下方向生成，不要雷同：`,
    ...chosen.map((index, i) => {
      const style = list[index];
      return `   ${i + 1}. 方向【${style.name}】——意思是：${style.intent || "按方向名理解"}`;
    }),
  ];
}

function detectConversationLanguage(text) {
  const value = String(text || "");
  const han = (value.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (value.match(/[A-Za-z]/g) || []).length;
  return latin > han ? "en" : "zh";
}

export function buildSuggestionPrompt({ count = 3, styles, selected, contextText = "", hint = "" } = {}) {
  const amount = [2, 3, 4].includes(count) ? count : 3;
  const languageLine = detectConversationLanguage(contextText) === "en"
    ? "推荐语必须全部使用英文。"
    : "推荐语必须全部使用中文。";
  const cleanHint = typeof hint === "string" ? hint.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) : "";
  return [
    "你是解语花的推荐回复引擎，替用户想几句可以直接发给当前伙伴的话。",
    "所有输出必须是用户对伙伴说的话，使用用户第一人称，不能写成伙伴口吻或旁观者描述。",
    `请根据下方最近对话生成 ${amount} 条推荐语，每条 5～40 个字，必须紧扣具体话题、细节或情绪。`,
    ...buildStyleLines(amount, styles, selected),
    "模仿用户的口吻、用词和语气词，但不要为了模仿而把内容写空。推荐自然、具体、口语化，不凑套话，不堆感叹号，不写文章式比喻。",
    languageLine,
    "只输出合法 JSON 数组，不要代码围栏或额外说明。每项格式为 {\"text\":\"推荐语\",\"direction\":\"对应方向\"}。",
    "对话：",
    String(contextText || "（当前对话内容暂不可用）").slice(-12000),
    cleanHint ? `额外偏好：${cleanHint}` : "",
  ].filter(Boolean).join("\n");
}

function normalizeItem(value) {
  if (typeof value === "string") return { text: value.trim(), direction: "" };
  if (value && typeof value === "object" && typeof value.text === "string") {
    return { text: value.text.trim(), direction: typeof value.direction === "string" ? value.direction.trim() : "" };
  }
  return null;
}

export function parseSuggestions(raw, count = 3) {
  if (typeof raw !== "string" || !raw.trim()) return [];
  const limit = [2, 3, 4].includes(count) ? count : 3;
  let source = raw.trim().replace(/^```(?:json|jsonl)?\s*/i, "").replace(/\s*```$/, "");
  const normalizeList = (items) => items.map(normalizeItem)
    .filter((item) => item && item.text.length > 0 && [...item.text].length <= 200)
    .slice(0, limit);
  try {
    const parsed = JSON.parse(source);
    if (Array.isArray(parsed)) return normalizeList(parsed);
    if (parsed && typeof parsed === "object") {
      for (const key of ["suggestions", "replies", "items", "data"]) {
        if (Array.isArray(parsed[key])) return normalizeList(parsed[key]);
      }
      const single = normalizeList([parsed]);
      if (single.length) return single;
    }
  } catch {}

  const recovered = [];
  const field = /\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"(?:\s*,\s*"direction"\s*:\s*"((?:[^"\\]|\\.)*)")?\s*\}/g;
  for (const match of source.matchAll(field)) {
    try { recovered.push({ text: JSON.parse(`"${match[1]}"`), direction: match[2] ? JSON.parse(`"${match[2]}"`) : "" }); } catch {}
    if (recovered.length >= limit) break;
  }
  if (recovered.length) return normalizeList(recovered);
  const lines = source.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*]\s+|\d+[.)、]\s*)/, "").trim())
    .filter((line) => line && line.length <= 200 && !/^[\[\]{}]+$/.test(line));
  return normalizeList(lines);
}
