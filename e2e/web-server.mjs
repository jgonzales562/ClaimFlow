import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

process.loadEnvFile(resolve(process.cwd(), ".env"));
process.env.PORT = "3001";

const projectRoot = process.cwd();
const webBuildIdPath = resolve(projectRoot, "apps/web/.next/BUILD_ID");
const watchedPaths = [
  resolve(projectRoot, "package.json"),
  resolve(projectRoot, "pnpm-lock.yaml"),
  resolve(projectRoot, "tsconfig.base.json"),
  resolve(projectRoot, "apps/web"),
  resolve(projectRoot, "packages/db"),
];
const ignoredNames = new Set([".next", "node_modules", "dist", "coverage", "playwright-report", "test-results"]);

function hasChangesNewerThan(targetPath, buildMtimeMs) {
  if (!existsSync(targetPath)) {
    return false;
  }

  const stats = statSync(targetPath);
  if (stats.mtimeMs > buildMtimeMs) {
    return true;
  }

  if (!stats.isDirectory()) {
    return false;
  }

  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    if (ignoredNames.has(entry.name)) {
      continue;
    }

    if (hasChangesNewerThan(resolve(targetPath, entry.name), buildMtimeMs)) {
      return true;
    }
  }

  return false;
}

function shouldBuildWeb() {
  if (!existsSync(webBuildIdPath)) {
    return true;
  }

  const buildMtimeMs = statSync(webBuildIdPath).mtimeMs;
  return watchedPaths.some((targetPath) => hasChangesNewerThan(targetPath, buildMtimeMs));
}

if (shouldBuildWeb()) {
  execFileSync("pnpm", ["--filter", "@claimflow/web", "build"], {
    stdio: "inherit",
    env: process.env,
  });
} else {
  console.log("Reusing existing @claimflow/web build for Playwright.");
}

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
