import { defineConfig } from "@playwright/test";

process.loadEnvFile(".env");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3001",
    headless: true,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node e2e/web-server.mjs",
    url: "http://localhost:3001/login",
    timeout: 240_000,
    reuseExistingServer: false,
  },
});
