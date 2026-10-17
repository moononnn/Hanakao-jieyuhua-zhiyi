// lib/fusion-service.js — 知意这一侧的融合服务
//
// 闲不住的融合协调器要拿到三样东西：球在不在跑、球在屏幕哪儿、球的桥地址与令牌。
// 它没法直接读知意的目录，所以知意把服务挂在宿主命名为 app:jiegehua-zhiyi/fusion 的
// 自定义动词上，由闲不住用 app/services.call 来请求。
//
// 只暴露这四件事，不代理别的：融合球的业务请求走知意球自己的回环桥，
// 这里只是把「门牌号」递出去，省得两边互相猜端口。
// ① snapshot 球在不在跑、在屏幕哪儿、桥地址
// ② start   启动球
// ③ stop    停球
// ④ place   把球放回指定坐标（拆回两球时用；只有知意自己写得动这个文件）

import fs from "node:fs";
import path from "node:path";

const STATE_FILE = "zhujian-state.json";
const BRIDGE_FILE = "ball-bridge.json";
const BALL_SIZE = { width: 80, height: 80 };
export const FUSION_METHOD = "fusion";

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function ballSnapshotFrom(dataDir, state = {}) {
  const dir = typeof dataDir === "string" ? dataDir.trim() : "";
  if (!dir) return { running: false, position: null, panel: "none", proxy: null };
  const fileState = readJson(path.join(dir, STATE_FILE)) || {};
  const bridge = readJson(path.join(dir, BRIDGE_FILE)) || null;
  const x = asNumber(fileState.x);
  const y = asNumber(fileState.y);
  const running = Boolean(state?.running);
  return {
    running,
    // 球停了还留着旧坐标时不该报位置，否则闲不住会拿一具尸体去算重叠。
    position: running && x !== null && y !== null
      ? { x, y, width: BALL_SIZE.width, height: BALL_SIZE.height }
      : null,
    panel: String(fileState.fusionPanel || "none"),
    proxy: running && bridge?.baseUrl ? { baseUrl: String(bridge.baseUrl), token: String(bridge.token || "") } : null,
  };
}

/**
 * 注册知意的融合服务。宿主把名字固定成 app:jiegehua-zhiyi/fusion，
 * 跨 App 调用方需要声明 allowCrossApp，调用方自己要有 app/services.call。
 */
export async function registerFusionService({ sdk, ball }) {
  if (typeof sdk?.bus?.handle !== "function") {
    await sdk?.logger?.warn?.("宿主没有 bus.handle，融合服务没有注册");
    return null;
  }
  try {
    const dispose = await sdk.bus.handle(FUSION_METHOD, async (payload = {}) => {
      const action = String(payload?.action || "snapshot");
      if (action === "stop") {
        const result = await ball.stop();
        return { ok: result?.ok !== false, running: false, error: result?.error || "" };
      }
      if (action === "start") {
        const result = await ball.start();
        return { ok: result?.ok !== false, running: Boolean(result?.running), error: result?.error || "" };
      }
      if (action === "place") {
        // 闲不住拆回两球时要把球放回原位。它读不到本 App 的数据目录
        // （App 沙箱只能读自己授权过的路径），所以由知意自己写自己的状态文件。
        // 字段与 zhujian_app.py 的 _place_from_state / _save_pos 对齐：x / y。
        const dir = typeof sdk.dataDir === "string" ? sdk.dataDir.trim() : "";
        const x = asNumber(payload?.x);
        const y = asNumber(payload?.y);
        if (!dir) return { ok: false, error: "知意没有拿到自己的数据目录" };
        if (x === null || y === null) return { ok: false, error: "位置参数无效" };
        const fileState = readJson(path.join(dir, STATE_FILE)) || {};
        fileState.x = Math.round(x);
        fileState.y = Math.round(y);
        if (!writeJson(path.join(dir, STATE_FILE), fileState)) {
          return { ok: false, error: "解语花位置保存失败" };
        }
        return { ok: true, x: fileState.x, y: fileState.y };
      }
      if (action !== "snapshot") {
        return { ok: false, error: `不认识的融合动作：${action}` };
      }
      return { ok: true, ...ballSnapshotFrom(sdk.dataDir, ball.state()) };
    }, { allowCrossApp: true });
    await sdk.logger?.info?.("融合服务已注册：app:jiegehua-zhiyi/fusion");
    return dispose;
  } catch (error) {
    // 没拿到 app/services.provide 就退化成单侧：知意自己的球照常，不牵连别处。
    await sdk?.logger?.warn?.(`融合服务注册失败，知意单侧运行：${error?.message || error}`);
    return null;
  }
}
