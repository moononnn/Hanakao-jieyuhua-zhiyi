// 推荐回复的用户设置：展示方式、时机、条数、方向、点击行为。
// 后端早就读 recommendationConfig 里的 count / styles / selectedByCount，
// 这里把归一化收口一处，设置页、模型引导和生成流程都走同一份。

export const DEFAULT_STYLES = Object.freeze([
  Object.freeze({ name: "追问/延伸", intent: "顺着话题往下问一句，或延伸到自己关心的事" }),
  Object.freeze({ name: "分享/感慨", intent: "分享自己的感受或关联的事，带点情绪" }),
  Object.freeze({ name: "行动/请求", intent: "让伙伴帮忙做点什么、解释什么或推荐什么" }),
  Object.freeze({ name: "玩笑/俏皮", intent: "用俏皮、调侃的方式说话" }),
]);

export const DEFAULT_RECOMMENDATION_CONFIG = Object.freeze({
  display: "ball",
  count: 3,
  styles: DEFAULT_STYLES,
  selectedByCount: { 2: [0, 1], 3: [0, 1, 2], 4: [0, 1, 2, 3] },
});

// 只有传音樱和关闭两档：回复卡片已于 2026-10-17 去掉，主对话不再生成推荐。
export const DISPLAY_MODES = Object.freeze(["ball", "off"]);
export const COUNT_CHOICES = Object.freeze([2, 3, 4]);

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  // 控制字符会让提示词出现看不见的断裂，留着反而更难排查。
  const stripped = [...value]
    .filter((char) => { const code = char.codePointAt(0); return code >= 0x20 && code !== 0x7f; })
    .join("");
  return stripped.trim().slice(0, limit);
}

function normalizeStyles(styles) {
  if (!Array.isArray(styles)) return DEFAULT_STYLES.map((style) => ({ ...style }));
  const mapped = styles
    .map((style, index) => {
      if (typeof style === "string") {
        const name = cleanText(style, 20);
        return name ? { name, intent: DEFAULT_STYLES[index]?.intent || "按方向名理解" } : null;
      }
      if (style && typeof style === "object") {
        const name = cleanText(style.name, 20);
        if (!name) return null;
        return { name, intent: cleanText(style.intent, 60) || "按方向名理解" };
      }
      return null;
    })
    .filter(Boolean);
  return mapped.length >= 2 ? mapped : DEFAULT_STYLES.map((style) => ({ ...style }));
}

function normalizeSelection(selected, styleCount, amount) {
  if (!Array.isArray(selected)) return null;
  const unique = [...new Set(selected
    .filter((index) => Number.isInteger(index) && index >= 0 && index < styleCount))];
  // 选不满条数时回落到默认轮转，别让生成流程拿到半截配置。
  if (unique.length !== amount) return null;
  return unique;
}

function normalizeSelectedByCount(raw, styleCount) {
  const source = raw && typeof raw === "object" ? raw : {};
  const result = {};
  for (const amount of COUNT_CHOICES) {
    const key = String(amount);
    const fallback = Array.from({ length: amount }, (_, index) => index % styleCount);
    result[amount] = normalizeSelection(source[key] ?? source[amount], styleCount, amount) ?? fallback;
  }
  return result;
}

export function normalizeRecommendationConfig(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  // 旧值 card 一律落到传音樱：卡片已经不做，不该因为历史设置把人静默关掉。
  const display = source.display === "card"
    ? "ball"
    : DISPLAY_MODES.includes(source.display) ? source.display : DEFAULT_RECOMMENDATION_CONFIG.display;
  const count = COUNT_CHOICES.includes(source.count) ? source.count : DEFAULT_RECOMMENDATION_CONFIG.count;
  const styles = normalizeStyles(source.styles);
  return {
    display,
    count,
    styles,
    selectedByCount: normalizeSelectedByCount(source.selectedByCount, styles.length),
  };
}

