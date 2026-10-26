// 发布预检用的 Python 测试入口。
// 发布小工坊的 testCommands 都在同一个目录里串行跑，而 python 用例得在 python/ 下执行，
// 所以借这一层把工作目录切过去，失败时直接把子进程的非零退出码抛给预检。
import { execFileSync } from "node:child_process";

const python = process.env.PYTHON || (process.platform === "win32" ? "python" : "python3");
try {
  execFileSync(python, ["-B", "-m", "unittest", "discover", "-p", "test_*.py"], {
    cwd: new URL("../python", import.meta.url),
    stdio: "inherit",
  });
} catch (error) {
  const code = typeof error?.status === "number" ? error.status : 1;
  console.error(`python 测试失败（exit ${code}）`);
  process.exit(code);
}
