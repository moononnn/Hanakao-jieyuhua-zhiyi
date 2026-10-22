import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";

const BRIDGE_TIMEOUT_MS = 5000;
const STARTUP_TIMEOUT_MS = 15000;
const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG"];
// 闲不住的融合协调器读这份文件，才接得上知意球的桥。文件名写死，两边都要一致。
const FUSION_BRIDGE_FILE = "ball-bridge.json";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureProcess(spawn, command, args, options, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish({ code: -1, stdout, stderr });
      return;
    }
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", () => finish({ code: -1, stdout, stderr }));
    child.once("exit", (code) => finish({ code: code ?? -1, stdout, stderr }));
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ code: -1, stdout, stderr });
    }, timeoutMs);
  });
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode != null) return Promise.resolve(true);
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

export function createBallManager({
  sdk,
  appRoot,
  spawn = nodeSpawn,
  environment = process.env,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  onStarted = null,
  onExited = null,
}) {
  let child = null;
  let bridge = null;
  let stoppingChild = null;
  let startPromise = null;
  let lastError = "";
  let pendingStops = 0;
  let lifecycleTail = Promise.resolve();
  // 这一次 stop 是 App 自己在卸载（重载/退出），还是用户亲手关掉。
  // 两者的区别很关键：卸载时球必须停下来，但不应该把「用户想让它开着」这个意图改掉，
  // 否则每次 App 重载都会把球弄没，得人手点一次。
  let stopForShutdown = false;

  // 融合球是闲不住另起的进程，拿不到这里内存里的桥地址。
  // 把地址与令牌写进 App 数据目录，由闲不住读走接上；只对本机回环有效，
  // 球一停就删，跟不上就一直连不上的东西不值得留。
  function publishBridgeFile(value) {
    const dir = typeof sdk?.dataDir === "string" ? sdk.dataDir.trim() : "";
    if (!dir) return;
    const file = path.join(dir, FUSION_BRIDGE_FILE);
    try {
      if (!value) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ ...value, updatedAt: Date.now() }), "utf8");
      try { fs.chmodSync(file, 0o600); } catch { /* Windows 上没有 POSIX 权限位 */ }
    } catch { /* 落盘失败只影响融合，不该拖累传音樱本身 */ }
  }

  function state() {
    const running = Boolean(child && child.exitCode == null);
    const stopping = Boolean(running && (stoppingChild === child || pendingStops > 0));
    return {
      running,
      stopping,
      error: running ? (stopping ? lastError || "传音樱正在关闭，请稍候。" : "") : lastError,
    };
  }

  function setStopped(expectedChild, reason = "") {
    if (expectedChild && child !== expectedChild) return false;
    if (stoppingChild === expectedChild && !reason) reason = lastError;
    bridge = null;
    publishBridgeFile(null);
    stoppingChild = null;
    lastError = reason;
    child = null;
    return true;
  }

  function serializeLifecycle(operation) {
    const next = lifecycleTail.then(operation, operation);
    lifecycleTail = next.catch(() => {});
    return next;
  }

  function isStoppedOrStopping() {
    return pendingStops > 0 || stoppingChild === child || !state().running || !bridge;
  }

  async function callBridge(route, { method = "GET", body } = {}) {
    const target = bridge;
    if (!target || isStoppedOrStopping()) throw new Error("知意传音樱进程已停止。");
    const response = await sdk.network.fetch(`${target.baseUrl}${route}`, {
      method,
      headers: {
        "X-Zhiyi-Token": target.token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: BRIDGE_TIMEOUT_MS,
      maxResponseBytes: 64 * 1024,
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("知意传音樱返回了无法读取的响应。");
    }
    if (!response.ok || payload?.ok !== true) {
      const error = new Error(typeof payload?.error === "string" ? payload.error : "知意传音樱请求失败。");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function start() {
    if (state().running && bridge && stoppingChild !== child && pendingStops === 0) {
      return { ok: true, ...state() };
    }
    if (startPromise) return startPromise;
    const task = serializeLifecycle(startInternal).finally(() => {
      if (startPromise === task) startPromise = null;
    });
    startPromise = task;
    return task;
  }

  async function startInternal() {
    const currentState = state();
    if (currentState.running) {
      if (bridge && stoppingChild !== child) return { ok: true, ...currentState };
      return {
        ok: false,
        ...currentState,
        error: currentState.error || "传音樱进程仍在退出，请等它完全关闭后再启动。",
      };
    }
    if (typeof sdk.dataDir !== "string" || !sdk.dataDir.trim()) {
      lastError = "知意没有可用的专属数据目录，未启动传音樱。";
      return { ok: false, error: lastError };
    }

    lastError = "";
    let executable;
    try {
      const windowsRoot = environment?.SystemRoot || environment?.WINDIR || "C:\\Windows";
      executable = await sdk.process.resolveExecutable({
        candidates: process.platform === "win32"
          ? [path.win32.join(windowsRoot, "py.exe"), "py.exe", "python.exe", "python3.exe", "python"]
          : ["python3", "python"],
      });
    } catch (error) {
      const message = error?.code === "APP_CAPABILITY_DENIED"
        ? "尚未允许知意启动外部进程。请在 Hana「设置 → 安全 → 应用能力」中审核「外部进程启动」权限。"
        : "没有成功检查 Python 环境；请确认知意的外部进程权限已获准。";
      lastError = message;
      return { ok: false, error: message };
    }
    if (pendingStops > 0) {
      lastError = "传音樱启动已取消。";
      return { ok: false, error: lastError };
    }
    if (!executable?.path) {
      lastError = "没有找到 Python。请先安装 Python 和 PyQt6，并确保 Hana 服务可从 PATH 找到 Python；知意不会自动安装依赖。";
      return { ok: false, error: lastError };
    }

    const scriptPath = path.join(appRoot, "python", "zhujian_app.py");
    const isLauncher = path.basename(executable.path).toLowerCase() === "py.exe";
    const childEnv = {};
    for (const key of CHILD_ENV_ALLOWLIST) {
      if (typeof environment?.[key] === "string") childEnv[key] = environment[key];
    }
    if (process.platform === "win32") {
      const profileRoot = environment?.USERPROFILE || environment?.HOME;
      if (typeof profileRoot === "string" && path.win32.isAbsolute(profileRoot)) {
        childEnv.APPDATA = path.win32.join(profileRoot, "AppData", "Roaming");
      } else if (typeof environment?.APPDATA === "string" && path.win32.isAbsolute(environment.APPDATA)) {
        childEnv.APPDATA = environment.APPDATA;
      }
    }
    Object.assign(childEnv, {
      ZHIYI_APP_DATA_DIR: sdk.dataDir,
      ZHIYI_APP_MODE: "ask-only",
      PYTHONDONTWRITEBYTECODE: "1",
    });

    let pythonExecutable = executable.path;
    let args = [scriptPath];
    if (isLauncher) {
      const listed = await captureProcess(spawn, executable.path, ["-0p"], {
        cwd: path.join(appRoot, "python"),
        windowsHide: true,
        env: childEnv,
      });
      const candidates = listed.stdout.split(/\r?\n/)
        .map((line) => line.match(/^\s*-V:\S+\s+\*?\s*(.+?)\s*$/)?.[1]?.replace(/^\"|\"$/g, ""))
        .filter((candidate) => candidate && path.win32.isAbsolute(candidate));
      for (const candidate of candidates) {
        const probe = await captureProcess(spawn, candidate, ["-c", "import PyQt6.QtCore, PyQt6.QtSvg"], {
          cwd: path.join(appRoot, "python"),
          windowsHide: true,
          env: childEnv,
        });
        if (probe.code === 0) {
          pythonExecutable = candidate;
          break;
        }
      }
      if (pendingStops > 0) {
        lastError = "传音樱启动已取消。";
        return { ok: false, error: lastError };
      }
      if (listed.code === 0 && candidates.length > 0 && pythonExecutable === executable.path) {
        lastError = `已检查这些 Python，均无法导入 PyQt6：${candidates.join("、")}`;
        return { ok: false, error: lastError };
      }
      if (pythonExecutable === executable.path) args = ["-3", scriptPath];
    }

    let currentChild;
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const startupError = [];

    try {
      currentChild = spawn(pythonExecutable, args, {
        cwd: path.join(appRoot, "python"),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
      });
      child = currentChild;
    } catch {
      lastError = "Python 启动失败。";
      return { ok: false, error: lastError };
    }

    currentChild.stdin?.on("error", () => {});
    let settled = false;
    const failReady = (message) => {
      if (settled) return;
      settled = true;
      readyReject(new Error(message));
    };
    const lines = createInterface({ input: currentChild.stdout });
    lines.on("line", (line) => {
      if (child !== currentChild) return;
      try {
        const payload = JSON.parse(line);
        if (payload?.type === "zhiyi-ball-stopping") {
          bridge = null;
          publishBridgeFile(null);
          stoppingChild = currentChild;
          try { currentChild.stdin?.write("zhiyi-ball-stopping-ack\n"); } catch {}
          return;
        }
        if (settled) return;
        const address = typeof payload?.baseUrl === "string" ? new URL(payload.baseUrl) : null;
        const port = Number(address?.port);
        if (payload?.type === "zhiyi-ball-ready"
          && address?.protocol === "http:"
          && address.hostname === "127.0.0.1"
          && Number.isInteger(port) && port > 0 && port <= 65535
          && address.pathname === "/" && !address.search && !address.hash
          && typeof payload.token === "string"
          && payload.token.length >= 32) {
          settled = true;
          readyResolve({ baseUrl: address.origin, token: payload.token });
        }
      } catch {
        // Stdout is reserved for the one-line ready handshake; ignore non-JSON startup noise.
      }
    });
    currentChild.stderr?.on("data", (chunk) => {
      const text = String(chunk || "").trim();
      if (text) {
        startupError.push(text.slice(-500));
        if (startupError.length > 8) startupError.shift();
      }
    });
    currentChild.once("error", (error) => {
      if (child !== currentChild) return;
      failReady(error?.code === "ERR_ACCESS_DENIED"
        ? "Hana 拒绝启动 Python 子进程。请检查知意的「外部进程启动」权限。"
        : "Python 启动失败；请确认 Python 和 PyQt6 已安装。");
      setStopped(currentChild, "Python 启动失败。");
    });
    currentChild.once("exit", (code) => {
      if (child !== currentChild) return;
      const wasIntentional = stoppingChild === currentChild || pendingStops > 0;
      const intentional = wasIntentional ? (stopForShutdown ? "shutdown" : "user") : "unexpected";
      if (!settled) {
        const detail = startupError.join("\n");
        failReady(detail
          ? `传音樱没有启动。请确认 Python 和 PyQt6 已安装。\n${detail}`
          : `传音樱进程在完成启动前退出（${code ?? "未知状态"}）。`);
      }
      setStopped(currentChild, code === 0 ? "" : `传音樱进程已退出（${code ?? "未知状态"}）。`);
      // 把退出前那几行 stderr 写进宿主日志：球是独立进程，崩了以后以前什么都看不到。
      // 退出码也写进正文：宿主日志只打 message，detail 里的 code 看不到。
      const tail = startupError.join("\n").trim();
      const how = intentional === "unexpected" ? "意外退出" : intentional === "shutdown" ? "随 App 卸载退出" : "用户关闭";
      if (tail) {
        void sdk?.logger?.warn?.(`传音樱${how}（${code ?? "未知状态"}），退出前输出`, { code, tail: tail.slice(-1200) });
      } else {
        void sdk?.logger?.warn?.(`传音樱${how}（${code ?? "未知状态"}），没有留下 stderr`, { code });
      }
      // 先复位标志再通知：下一轮 stop 不能继承上一轮的「卸载中」。
      stopForShutdown = false;
      if (typeof onExited === "function") {
        try { onExited({ code, tail, intentional }); } catch { /* 通知失败不能影响退出流程 */ }
      }
    });

    let timer;
    try {
      const result = await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("传音樱启动等待超时。")), startupTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (pendingStops > 0 || child !== currentChild || stoppingChild === currentChild || currentChild.exitCode != null) {
        throw new Error("传音樱在启动完成前已停止。");
      }
      bridge = result;
      publishBridgeFile({ baseUrl: result.baseUrl, token: result.token, pid: child?.pid ?? null });
      lastError = "";
      if (typeof onStarted === "function") {
        try { onStarted({ pid: child?.pid ?? null }); } catch { /* 通知失败不影响球本身 */ }
      }
      return { ok: true, ...state() };
    } catch (error) {
      clearTimeout(timer);
      const message = error?.message || "传音樱启动失败。";
      if (child === currentChild && currentChild.exitCode == null) {
        lastError = message;
        bridge = null;
        publishBridgeFile(null);
        if (stoppingChild !== currentChild) {
          stoppingChild = currentChild;
          try { currentChild.kill(); } catch {}
        }
      } else {
        lastError = message;
      }
      return { ok: false, ...state(), error: message };
    }
  }

  async function stopInternal() {
    const currentChild = child;
    if (!currentChild || currentChild.exitCode != null) {
      if (currentChild) setStopped(currentChild, "");
      else {
        bridge = null;
        publishBridgeFile(null);
        lastError = "";
      }
      return { ok: true, running: false };
    }
    if (!currentChild.killed) {
      try { currentChild.kill(); } catch {}
    }
    let exited = await waitForExit(currentChild, 4000);
    if (!exited && currentChild.exitCode == null) {
      try { currentChild.kill("SIGKILL"); } catch {}
      exited = await waitForExit(currentChild, 1000);
    }
    if (!exited && currentChild.exitCode == null) {
      lastError = "传音樱进程未能确认退出；知意不会启动第二个球。";
      return { ok: false, ...state(), error: lastError };
    }
    if (child === currentChild) setStopped(currentChild, "");
    return { ok: true, running: false };
  }

  function stop({ forShutdown = false } = {}) {
    if (forShutdown) stopForShutdown = true;
    pendingStops += 1;
    const currentChild = child;
    if (currentChild && currentChild.exitCode == null) {
      stoppingChild = currentChild;
      if (!currentChild.killed) {
        try { currentChild.kill(); } catch {}
      }
    }
    return serializeLifecycle(async () => {
      try {
        return await stopInternal();
      } finally {
        pendingStops = Math.max(0, pendingStops - 1);
      }
    });
  }

  // 把问题送到球上就返回，不等作答。
  // 以前是入队后在这里死等，最长等十分钟——但宿主给工具执行的 RPC 只有 30 秒，
  // 两头的时间尺度对不上：用户稍一犹豫，工具先报 timed out，球上的题还挂着，
  // 答案永远回不到那一轮。所以这里只负责「把题送到」，作答由 ball-ask-watch 轮询接续。
  // 带上 sessionId 是为了 App 重载后能从 /ask/pending 把这道题认回来，不至于丢答案。
  async function enqueueAsk(request, { sessionId = "", sessionTitle = "", agentName = "" } = {}) {
    if (!state().running || !bridge || stoppingChild === child || pendingStops > 0) return null;
    const askId = randomUUID();
    try {
      await callBridge("/ask/enqueue", {
        method: "POST",
        body: {
          askId,
          sessionId: String(sessionId || ""),
          sessionTitle: String(sessionTitle || "").trim().slice(0, 120),
          agentName: String(agentName || "").trim().slice(0, 40),
          title: request.title,
          question: request.question,
          background: request.background,
          recommendation: request.recommendation,
          reason: request.reason,
          options: request.options,
          selectionMode: request.selectionMode,
          minSelections: request.minSelections,
          maxSelections: request.maxSelections,
        },
      });
      return { askId };
    } catch (error) {
      // 409 = 球上还压着一道没答的题，交给调用方说清楚，不覆盖原题。
      if (error?.status === 409) return { busy: true };
      if (isStoppedOrStopping()) return null;
      throw error;
    }
  }

  // 读一次这道题的状态：pending / answered / rejected / aborted / timeout。
  async function readAskResult(askId) {
    if (!bridge || isStoppedOrStopping()) return { status: "aborted" };
    return callBridge(`/ask/result?askId=${encodeURIComponent(askId)}`);
  }

  // 球上还挂着哪些题。App 重载后靠这个把在等的题接回来，
  // 否则用户在那之后才作答，答案就没人接了。
  async function listPendingAsks() {
    if (!state().running || !bridge || isStoppedOrStopping()) return [];
    try {
      const payload = await callBridge("/ask/pending");
      return Array.isArray(payload?.pending) ? payload.pending : [];
    } catch {
      return [];
    }
  }

  return { state, start, stop, enqueueAsk, readAskResult, listPendingAsks, bridgeRequest: callBridge };
}
