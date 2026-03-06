import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";

process.loadEnvFile(resolve(process.cwd(), ".env"));
process.env.PORT = "3001";

execFileSync("pnpm", ["--filter", "@claimflow/web", "build"], {
  stdio: "inherit",
  env: process.env,
});

const child = spawn("pnpm", ["--filter", "@claimflow/web", "exec", "next", "start", "-p", "3001"], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
