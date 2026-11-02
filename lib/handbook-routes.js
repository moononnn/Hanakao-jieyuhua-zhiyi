// 更新手记的路由。
//
// 为什么用流式：Wall 和 Ask 都要等模型，一次可能三十秒以上。普通路由会卡在首包超时，
// 前端拿到的是一句英文错误。这里照应用雷达的做法：立刻吐一个空格、每十秒心跳一个空格，
// 结果最后作为一段 JSON 追加进去。前端读完再 JSON.parse。
//
// 为什么不在这里做缓存：缓存写在 lib/handbook-cache.js，跟"这个路由被调了几次"无关。
// 路由只管把数据送出去，重不重算由 service 决定，这样页面刷新不会意外重算一遍卡片。

import { HandbookCardError } from "./handbook-cards.js";
import { HandbookChatError } from "./handbook-chat.js";
import { HandbookReleaseError } from "./handbook-releases.js";
import { askHandbook } from "./handbook-chat.js";
import { loadWall, sourcesForCard } from "./handbook-service.js";

const USER_FACING = [HandbookReleaseError, HandbookCardError, HandbookChatError];

export function registerHandbookRoutes(app, sdk) {
  const respond = async (handler) => {
    try {
      return { ok: true, ...(await handler()) };
    } catch (error) {
      // 自己写的错误文案可以给用户看；其它异常可能带地址、密钥或请求正文，一律换成一句人话。
      const message = USER_FACING.some((kind) => error instanceof kind)
        ? error.message
        : "这次没读出来。确认网络通了、内容模型也选好了，再试一次。已有结果不会丢。";
      return { ok: false, error: message };
    }
  };

  const streamed = (handler) => (c) => {
    let cancelled = false;
    let heartbeat;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(" "));
        heartbeat = setInterval(() => {
          if (cancelled) return;
          try {
            controller.enqueue(encoder.encode(" "));
          } catch {
            clearInterval(heartbeat);
          }
        }, 10000);
        heartbeat.unref?.();
        void respond(() => handler(c))
          .then((result) => {
            if (cancelled) return;
            controller.enqueue(encoder.encode(JSON.stringify(result)));
            controller.close();
          })
          .catch(() => {
            try {
              controller.error(new Error("结果没传完，重开一次页面看看。"));
            } catch {
              // 流已经关了，什么都不用做。
            }
          })
          .finally(() => clearInterval(heartbeat));
      },
      cancel() {
        cancelled = true;
        clearInterval(heartbeat);
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
  };

  // rebuild=1 表示"这版的卡片重新挑一遍"，只在用户明确要求时传。
  app.get("/handbook/wall", streamed((c) => loadWall(sdk, { rebuild: c.req.query("rebuild") === "1" })));

  app.post("/handbook/ask", streamed(async (c) => {
    const payload = await c.req.json();
    return askHandbook(sdk, {
      question: payload?.question,
      card: payload?.card || null,
      tags: Array.isArray(payload?.tags) ? payload.tags : [],
      history: Array.isArray(payload?.history) ? payload.history : [],
    });
  }));

  // 这张卡背后的原文：点开细节时要看，也让用户能核对"它凭什么这么说"。
  app.post("/handbook/sources", streamed(async (c) => {
    const payload = await c.req.json();
    return { sources: await sourcesForCard(sdk, payload?.card || null) };
  }));
}
