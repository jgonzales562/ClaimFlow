import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export default async function globalSetup(): Promise<void> {
  process.loadEnvFile(resolve(process.cwd(), ".env"));

  execFileSync("pnpm", ["db:seed"], {
    stdio: "inherit",
    env: process.env,
  });
}
