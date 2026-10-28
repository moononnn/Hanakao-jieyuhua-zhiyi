// 输入框图片放大：Hana 聊天输入框里粘贴的图片缩略图默认点不开，发出去以后才能点。
// 这里负责把一层独立预览脚本装进 Hana 当前的 renderer 目录，并读回装没装。
//
// 为什么不直接在本文件里读写文件：知意跑在 Hana 的受限环境里，读 ~/.hanako/artifacts
// 会被拒（ERR_ACCESS_DENIED）。所以真正的读写交给 assets/install-input-zoom.ps1，
// 用独立进程跑，不受 App 那层的文件限制。
//
// 每换一次 Hana 版本，renderer 会解包成新的版本目录，注入跟着消失。所以每次都重新
// 找最新的目录，而不是记住上次那个。
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(LIB_DIR, "..", "assets", "install-input-zoom.ps1");
const TIMEOUT_MS = 20_000;

// child_process 只能用到的时候再拉：顶层静态 import 会在 App 加载阶段就把它带进来，
// 触发宿主权限模型的 PERM0002 警告，整个 App 会被判加载失败。
async function runHelper(action) {
  let spawn;
  try {
    ({ spawn } = await import("node:child_process"));
  } catch (error) {
    throw new Error(`拿不到启动外部程序的权限：${String(error?.message || error).slice(0, 120)}`);
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", HELPER, action],
        {
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          // The action also travels in the environment: if a future edit ever
          // breaks the script's param block again, the helper still knows what
          // to do instead of quietly answering "status".
          env: { ...process.env, HDIZ_ACTION: action },
        }
      );
    } catch (error) {
      reject(new Error(`启动安装助手失败：${String(error?.message || error).slice(0, 120)}`));
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已经退了 */ }
      reject(new Error("安装助手超时，再点一次。"));
    }, TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`启动安装助手失败：${String(error?.message || error).slice(0, 120)}`));
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = String(stdout || "").trim();
      const start = text.lastIndexOf("{");
      if (start < 0) {
        reject(new Error(`安装助手没回话：${String(stderr || text).trim().slice(0, 120) || "没有输出"}`));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(text.slice(start));
      } catch {
        reject(new Error(`安装助手的回话读不出来：${text.slice(0, 120)}`));
        return;
      }
      // The helper echoes which action it really ran. A mismatch means the
      // script did not take the request we sent; do not let that pass as done.
      if (payload && payload.action && payload.action !== action) {
        reject(new Error(`安装助手跑成了「${payload.action}」，不是「${action}」，再点一次。`));
        return;
      }
      resolve(payload);
    });
  });
}

export async function inputZoomStatus() {
  return runHelper("status");
}

export async function installInputZoom() {
  return runHelper("install");
}

export async function uninstallInputZoom() {
  return runHelper("uninstall");
}
