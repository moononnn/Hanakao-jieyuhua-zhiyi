const ASK_SELECTION_MODES = new Set(["single", "multiple"]);
const ACTION_AUTHORIZATION_BOUNDARY = "如后续需执行外部或不可逆操作，先核对是否已有针对具体动作及后果的明确授权；Ask 的选择本身不构成执行授权，尚无授权时须另行确认。";

export const ASK_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "question", "selectionMode", "options"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 60, description: "弹窗顶部的小标题，6-14 个字，说清要定什么事。别和 question 说同一句话。" },
    question: { type: "string", minLength: 1, maxLength: 500, description: "一句话问清要用户决定什么，20-40 个字；不复述背景，也不把选项列一遍。涉及卸载、删除、覆盖等高影响动作时，直接写出具体动作及目标。" },
    background: { type: "string", maxLength: 1200, description: "只有用户不知道就选不了时才写，1-2 句、40-60 字。弹窗只有一掌宽，写长了满屏都是小字。高影响操作要写清实际影响范围、已核实的备份版本与可行替代方案；未知信息先查证，不得猜写。" },
    recommendation: { type: "string", maxLength: 300, description: "可选，8-16 个字，只写方向名，不写解释。" },
    reason: { type: "string", maxLength: 500, description: "可选，20 个字内说清为什么，一句就够。" },
    selectionMode: {
      type: "string",
      enum: ["single", "multiple"],
      description: "必填，仅表示答案形式：互斥选项用 single；可同时成立、需要勾选一组的选项用 multiple。此字段不代表用户授权执行所选动作，不可省略。", 
    },
    minSelections: { type: "integer", minimum: 1, maximum: 5, description: "仅 multiple 使用，最少选择数量，默认 1；如显式指定必须至少为 1。" },
    maxSelections: { type: "integer", minimum: 1, maximum: 5, description: "仅 multiple 使用，最多选择数量，默认全部选项。" },
    options: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      description: "2 到 5 个彼此分得清的选择。label 是选项标题，8-14 个字、动宾短语，例：只改茶话会；detail 可选，20 个字内说清选它会发生什么，能省就省。",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label"],
        properties: {
          label: { type: "string", minLength: 1, maxLength: 100, description: "8-14 个字，动宾短语；解释别塞进标题。" },
          detail: { type: "string", maxLength: 240, description: "20 个字内说清后果，不必复述标题。" },
        },
      },
    },
  },
};

function text(value, maxLength, fieldName) {
  if (value == null) return "";
  if (typeof value !== "string") throw new TypeError(`${fieldName}必须是文字。`);
  const normalized = value.trim();
  if ([...normalized].length > maxLength) {
    throw new RangeError(`${fieldName}不能超过 ${maxLength} 个字符。`);
  }
  return normalized;
}

export function normalizeAskRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("问题参数必须是对象。");
  }

  const title = text(input.title, 60, "标题");
  const question = text(input.question, 500, "问题");
  const background = text(input.background, 1200, "背景");
  const recommendation = text(input.recommendation, 300, "推荐方向");
  const reason = text(input.reason, 500, "推荐理由");
  const selectionMode = input.selectionMode == null ? "single" : input.selectionMode;
  if (!ASK_SELECTION_MODES.has(selectionMode)) throw new TypeError("选择模式只能是 single 或 multiple。");
  if (!title) throw new TypeError("请给问题填写标题。");
  if (!question) throw new TypeError("请说明需要用户决定什么。");
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 5) {
    throw new TypeError("选择项需要在 2 到 5 个之间。");
  }

  const options = input.options.map((option, index) => {
    const value = typeof option === "string" ? { label: option } : option;
    const label = text(value?.label, 100, `第 ${index + 1} 个选择项标题`);
    if (!label) throw new TypeError(`第 ${index + 1} 个选择项没有标题。`);
    return { label, detail: text(value?.detail, 240, `第 ${index + 1} 个选择项说明`) };
  });
  const labels = options.map(({ label }) => label);
  if (new Set(labels.map((label) => label.toLocaleLowerCase())).size !== labels.length) {
    throw new TypeError("选择项不能重名。");
  }

  let minSelections = 1;
  let maxSelections = 1;
  if (selectionMode === "multiple") {
    minSelections = input.minSelections == null ? 1 : input.minSelections;
    maxSelections = input.maxSelections == null ? options.length : input.maxSelections;
    if (!Number.isInteger(minSelections) || minSelections < 1 || minSelections > options.length) {
      throw new RangeError(`多选最少选择数需在 1 到 ${options.length} 之间。`);
    }
    if (!Number.isInteger(maxSelections) || maxSelections < 1 || maxSelections > options.length) {
      throw new RangeError(`多选最多选择数需在 1 到 ${options.length} 之间。`);
    }
    if (minSelections > maxSelections) throw new RangeError("多选最少选择数不能超过最多选择数。");
  } else if ((input.minSelections != null && input.minSelections !== 1)
    || (input.maxSelections != null && input.maxSelections !== 1)) {
    throw new RangeError("单选题的最少和最多选择数只能是 1。");
  }

  return { title, question, background, recommendation, reason, options, selectionMode, minSelections, maxSelections };
}

export function buildAskMessage(request) {
  const lines = [request.question];
  if (request.selectionMode === "multiple") {
    lines.push(`可多选：至少 ${request.minSelections} 项，最多 ${request.maxSelections} 项。`);
  }
  if (request.background) lines.push(`背景：${request.background}`);
  if (request.recommendation) {
    lines.push(`建议方向：${request.recommendation}${request.reason ? `。理由：${request.reason}` : ""}`);
  }
  if (request.options.some(({ detail }) => detail)) {
    lines.push("各选项说明：", ...request.options.map(({ label, detail }) => `• ${label}${detail ? `：${detail}` : ""}`));
  }
  return lines.join("\n\n");
}

export function buildRequestedSchema(request) {
  if (request.selectionMode === "multiple") {
    const properties = Object.fromEntries(request.options.map(({ label, detail }, index) => [`option_${index + 1}`, {
      type: "boolean",
      title: label,
      ...(detail ? { description: detail } : {}),
    }]));
    properties.note = { type: "string", title: "补充说明（可不填）" };
    return {
      type: "object",
      description: `请勾选至少 ${request.minSelections} 项、最多 ${request.maxSelections} 项。`,
      properties,
    };
  }
  return {
    type: "object",
    properties: {
      choice: {
        type: "string",
        title: "你的选择",
        enum: request.options.map(({ label }) => label),
      },
      note: {
        type: "string",
        title: "补充说明（可不填）",
      },
    },
    required: ["choice"],
  };
}

export function formatAskAnswer(answer, request) {
  const action = answer?.action;
  if (action === "confirmed") {
    const customChoice = answer?.value?.customChoice;
    if (typeof customChoice === "string" && customChoice.trim() && [...customChoice].length <= 500) {
      return {
        isError: false,
        text: `用户给出了自定义选择：${customChoice.trim()}\n请沿用这一选择继续原任务；如果后续方案发生实质变化，再向用户说明。${ACTION_AUTHORIZATION_BOUNDARY}`, 
      };
    }
    const rawNote = answer?.value?.note;
    if (rawNote != null && typeof rawNote !== "string") {
      return { isError: true, text: "补充说明格式无效，不能把这次回答当作有效选择。" };
    }
    const note = typeof rawNote === "string" ? rawNote.trim() : "";
    if (request.selectionMode === "multiple") {
      const rawChoices = answer?.value?.choice;
      const choices = Array.isArray(rawChoices) ? rawChoices : typeof rawChoices === "string" ? [rawChoices] : [];
      const selected = choices.map((choice) => typeof choice === "string" ? choice.trim() : "");
      const allowed = new Set(request.options.map(({ label }) => label));
      if (selected.some((choice) => !choice)) {
        return { isError: true, text: "多选答案里有空选项，不能继续依赖这次选择。" };
      }
      if (new Set(selected).size !== selected.length) {
        return { isError: true, text: "多选答案里有重复选项，不能继续依赖这次选择。" };
      }
      if (selected.length < request.minSelections || selected.length > request.maxSelections) {
        return { isError: true, text: `多选答案数量无效，应为 ${request.minSelections}～${request.maxSelections} 项；不能继续依赖这次选择。` };
      }
      if (selected.some((choice) => !allowed.has(choice))) {
        return { isError: true, text: "多选答案含有不属于本题的选项，不能继续依赖这次选择。" };
      }
      return {
        isError: false,
        text: `用户选择了多项：\n${selected.map((choice) => `- ${choice}`).join("\n")}${note ? `\n补充：${note}` : ""}\n请综合这些选择继续原任务；如果后续方案发生实质变化，再向用户说明。${ACTION_AUTHORIZATION_BOUNDARY}`, 
      };
    }
    const choice = answer?.value?.choice;
    if (typeof choice !== "string" || !request.options.some((option) => option.label === choice)) {
      return { isError: true, text: "知意没有收到有效的单选项，请向用户说明这次回答没有被确认，不要继续依赖该选择的操作。" };
    }
    return {
      isError: false,
      text: `用户选择：${choice}${note ? `\n补充：${note}` : ""}\n请沿用这一选择继续原任务；如果后续方案发生实质变化，再向用户说明。${ACTION_AUTHORIZATION_BOUNDARY}`, 
    };
  }
  if (action === "rejected") {
    return { isError: false, text: "用户暂不作此选择。不要把拒绝当作同意；暂停依赖该决定的操作，或说明安全、可逆的默认方案后再继续。" };
  }
  if (action === "timeout") {
    return { isError: false, text: "等待用户选择超时，未收到有效决定。不要把超时当作同意，也不要立即重复弹问；暂停依赖该选择的操作，向用户说明当前状态。" };
  }
  if (action === "aborted") {
    return { isError: false, text: "这次提问已被关闭或中止，没有收到用户决定。不要把它当作同意；停止依赖该选择的操作。" };
  }
  return { isError: true, text: "知意收到无法识别的回答状态；请不要据此执行依赖该选择的操作。" };
}
