import { execFileSync } from "node:child_process";

if (process.env.CLAIMFLOW_SKIP_DB_PREBUILD?.trim().toLowerCase() === "true") {
  process.exit(0);
}

execFileSync("pnpm", ["--filter", "@claimflow/db", "build"], {
  stdio: "inherit",
  env: process.env,
});
