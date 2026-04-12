import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const rootEnvPath = path.join(repoRoot, ".env");

if (existsSync(rootEnvPath)) {
  process.loadEnvFile(rootEnvPath);
}

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: node scripts/run-with-root-env.mjs <command> [...args]");
  process.exit(1);
}

const child = spawn(command, args, {
  stdio: "inherit",
  cwd: process.cwd(),
  env: process.env,
});

const signals = ["SIGINT", "SIGTERM"];
const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

for (const signal of signals) {
  process.on(signal, forwardSignal);
}

child.on("error", (error) => {
  console.error(`Failed to start command "${command}":`, error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  for (const forwardedSignal of signals) {
    process.off(forwardedSignal, forwardSignal);
  }

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});
