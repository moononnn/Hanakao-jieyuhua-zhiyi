// 理顺（整理润色）这一页的纯逻辑：请求怎么拼、回包怎么说。
//
// 单独放一个模块是为了能测：判断「这次是在上一版上改，还是重新起头」这件事
// 很容易改坏，而它一坏，安全锚点就跟着失效（模型把意思改偏了也拦不住）。
//
// 锚点规矩（跟后端 lib/polish.js 一致）：
//   - 框里还是上一版结果 → 算迭代：previous=上一版，source=最初原话；
//   - 用户自己动过输入框 → 算新原话：previous/source 都不传，后端拿当前内容当锚点。

/** 拼出这一次理顺要发的请求体，并说明这是不是「在上一版上改」。 */
export function buildPolishRequest({ text = '', lastResult = '', source = '', instruction = '' } = {}) {
  const body = String(text || '').trim();
  const last = String(lastResult || '').trim();
  const onPrevious = Boolean(last) && body === last;
  return {
    body,
    onPrevious,
    request: {
      text: body,
      level: 'balanced',
      instruction: String(instruction || '').trim(),
      previous: onPrevious ? last : '',
      source: onPrevious ? String(source || '').trim() : '',
    },
  };
}

/** 回包 → 面板上那一行提示。退回与「没改动」都要说清楚，不能只显示「理顺好了」。 */
export function polishStatusText(payload) {
  if (!payload || payload.ok !== true) {
    return { text: String(payload?.error || '这次没理顺成，原话没动。'), tone: 'warn' };
  }
  if (payload.fellBack) {
    return { text: '这版被安全兜底拦下了（会改掉原意），退回你原来写的话。', tone: 'warn' };
  }
  if (payload.unchanged) {
    return { text: '你这段本来就清楚，模型没改。', tone: 'warn' };
  }
  return { text: '理顺好了。可以直接改，也可以再点一次继续理。', tone: 'ok' };
}

/** 候选方向只留有标签也有做法的那几条，其余丢掉。 */
export function normalizePolishSuggestions(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item) => ({
      label: typeof item?.label === 'string' ? item.label.trim() : '',
      prompt: typeof item?.prompt === 'string' ? item.prompt.trim() : '',
    }))
    .filter((item) => item.label && item.prompt);
}
