// lib/feedback-chat.js — 反馈对话：把大白话（和截图）整理成一条能直接提交的 issue
//
// 图片只在这条请求里走一次：转成 base64 附在同一条用户消息上给模型看，
// 不落盘、不进 issue、不进日志。issue 里只放整理出来的纯文字。
//
// 一条硬规矩：模型只负责「整理」，不负责「发送」。发不发、发到哪，
// 由用户在界面上自己点；这里也不碰任何网络出口。

import { resolvePolishModel } from "./polish.js";
import { invokeTextModel, resolveTaskModel } from "./custom-model.js";

export const FEEDBACK_LIMITS = Object.freeze({
  maxMessages: 12,
  maxImages: 3,
  messageChars: 1200,
  titleChars: 80,
  bodyChars: 4000,
});

const CHAT_TIMEOUT_MS = 60_000;
let sequence = 0;

const SYSTEM_PROMPT = [
  "你在帮用户把一段抱怨整理成一条给开发者看的 GitHub issue。",
  "用户是普通使用者，不是开发者：ta 说的可能是大白话、情绪、模糊的猜测。",
  "你的任务：听清 ta 遇到了什么、想干什么、希望在哪儿改，把事实和猜测分开；",
  "猜的地方要标成「可能是」，没说的不要补，控件名、报错原文照 ta 说的写。",
  "如果信息还不够判断问题出在哪，就追问一句最关键的（只问一句），ready 给 false。",
  "如果你看不到我附的截图，就在 reply 里直说看不到图，不要猜图里有什么。",
  "信息够了就整理成 issue：title 一句话说清哪里不对，body 分三段——",
  "「遇到了什么」「我本来想做什么」「期望怎样」，能省的字都省，别写成作文。",
  "不要写「用户反馈」这类废话，不要加 Markdown 标题符号，不要编版本号。",
  "只输出 JSON，不要解释、不要代码块。",
  '信息不够时：{"reply":"追问的一句","ready":false}',
  '信息够了时：{"reply":"一句收尾的话","ready":true,"title":"...","body":"..."}',
].join("");

function cleanText(value, limit) {
  if (typeof value !== "string") return "";
  return [...value]
    .filter((char) => {
      const code = char.codePointAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .trim()
    .slice(0, limit);
}

/** 从模型回包里抠出 JSON；前后裹了解释或代码块也认。 */
export function parseFeedbackReply(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: false, error: "模型这次没回内容，再说一次也行。" };
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "模型这次没说清楚，再说一次。" };
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, error: "模型这次没说清楚，再说一次。" };
  }
  const reply = cleanText(parsed?.reply, FEEDBACK_LIMITS.messageChars) || "……";
  if (parsed?.ready !== true) return { ok: true, ready: false, reply };
  const title = cleanText(parsed?.title, FEEDBACK_LIMITS.titleChars);
  const body = cleanText(parsed?.body, FEEDBACK_LIMITS.bodyChars);
  if (!title || !body) return { ok: true, ready: false, reply: reply === "……" ? "再说细一点？" : reply };
  return { ok: true, ready: true, reply, title, body };
}

function normalizeMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: message?.role === "assistant" ? "assistant" : "user",
      content: cleanText(message?.content, FEEDBACK_LIMITS.messageChars),
      images: Array.isArray(message?.images)
        ? message.images
            .map((image) => ({
              data: typeof image?.data === "string" ? image.data : "",
              mimeType: typeof image?.mimeType === "string" ? image.mimeType : "image/jpeg",
            }))
            .filter((image) => image.data)
            .slice(0, FEEDBACK_LIMITS.maxImages)
        : [],
    }))
    .filter((message) => message.content || message.images.length)
    .slice(-FEEDBACK_LIMITS.maxMessages);
}

/** 最近一条带图的用户消息才把图带上：历史里的图不重复发，省 token。 */
function pickImages(history) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role === "user" && message.images.length) return message.images;
  }
  return [];
}

function describeModelError(error) {
  const raw = String(error?.message || "");
  const code = String(error?.code || "");
  if (/image|vision|modality|unsupported|not support/i.test(raw) || code === "UNSUPPORTED_CONTENT") {
    return "当前这条模型没法识别图片。用文字描述一下问题吧。";
  }
  if (error?.code === "MODEL_TIMEOUT") return raw || "想太久了，等它想完再点一次。";
  if (/[\u4e00-\u9fa5]/.test(raw) && raw) return raw;
  return "知意这边出了点岔子，等一下再试。";
}

export async function chatFeedback(sdk, { messages = [] } = {}) {
  const history = normalizeMessages(messages);
  if (!history.length) throw new Error("还没说话呢。");
  const images = pickImages(history);

  const model = await resolvePolishModel(sdk);
  const resolved = await resolveTaskModel(sdk, { hostModel: model });
  if (!resolved) throw new Error("没找到能用的模型，去「模型和接口」里选一条。");
  if (images.length && resolved.kind === "custom") {
    throw new Error("当前这条接口没法识别图片。用文字描述一下问题吧。");
  }

  const transcript = history
    .map((message) => {
      const who = message.role === "assistant" ? "知意" : "用户";
      const shots = message.images.length ? `（附了 ${message.images.length} 张截图）` : "";
      return `${who}：${message.content}${shots}`;
    })
    .join("\n");

  const text = [
    "（下面是用户和知意的对话。标了截图的那些，图就附在这条消息上，先看图再回。）",
    transcript,
    "",
    "按上面的规矩回我，只输出 JSON。",
  ].join("\n");

  const content = [{ type: "text", text }];
  for (const image of images) {
    content.push({ type: "image", mimeType: image.mimeType, data: image.data });
  }

  const requestId = `zhiyi_feedback_${Date.now().toString(36)}_${(++sequence).toString(36)}`;
  let timer;
  let timedOut = false;
  let raw = "";
  try {
    raw = await Promise.race([
      invokeTextModel(sdk, resolved, {
        requestId,
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
        temperature: 0.4,
        maxTokens: 1200,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new Error("想太久了，等它想完再点一次。");
          error.code = "MODEL_TIMEOUT";
          reject(error);
        }, CHAT_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (timedOut) {
      try {
        await sdk.models.cancel(requestId);
      } catch {}
    }
    throw new Error(describeModelError(error));
  } finally {
    clearTimeout(timer);
  }

  const result = parseFeedbackReply(raw);
  if (!result.ok) throw new Error(result.error);
  return { ...result, model: resolved.name, images: images.length };
}
