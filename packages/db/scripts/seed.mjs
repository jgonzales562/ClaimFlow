import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageRoot = resolve(import.meta.dirname, "..");
const schemaPath = resolve(packageRoot, "prisma/schema.prisma");

function resolveGeneratedClientPath() {
  try {
    const prismaClientEntry = require.resolve("@prisma/client");
    return resolve(dirname(prismaClientEntry), "..", "..", ".prisma/client/index.js");
  } catch {
    return null;
  }
}

function shouldGenerateClient() {
  const generatedClientPath = resolveGeneratedClientPath();
  if (!generatedClientPath || !existsSync(generatedClientPath)) {
    return true;
  }

  return statSync(generatedClientPath).mtimeMs < statSync(schemaPath).mtimeMs;
}

if (shouldGenerateClient()) {
  execFileSync("pnpm", ["exec", "prisma", "generate"], {
    cwd: packageRoot,
    stdio: "inherit",
    env: globalThis.process.env,
  });
}

execFileSync("pnpm", ["exec", "tsx", "prisma/seed.ts"], {
  cwd: packageRoot,
  stdio: "inherit",
  env: globalThis.process.env,
});
