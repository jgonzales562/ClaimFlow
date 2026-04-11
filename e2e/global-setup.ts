import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export default async function globalSetup(): Promise<void> {
  process.loadEnvFile(resolve(process.cwd(), ".env"));
  process.env.CLAIMFLOW_SEED_ADMIN_EMAIL =
    process.env.CLAIMFLOW_SEED_ADMIN_EMAIL?.trim() || "admin@claimflow.local";
  process.env.CLAIMFLOW_SEED_ADMIN_PASSWORD =
    process.env.CLAIMFLOW_SEED_ADMIN_PASSWORD?.trim() || `e2e-${randomBytes(18).toString("hex")}`;

  execFileSync("pnpm", ["db:seed"], {
    stdio: "inherit",
    env: process.env,
  });
}
