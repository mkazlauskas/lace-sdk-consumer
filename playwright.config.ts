import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1,
  use: { browserName: "chromium", baseURL: `http://localhost:${process.env.E2E_PORT ?? "5198"}`, trace: "retain-on-failure" },
  webServer: {
    command: `npm run dev -- --host localhost --port ${process.env.E2E_PORT ?? "5198"} --strictPort`,
    url: `http://localhost:${process.env.E2E_PORT ?? "5198"}`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { VITE_BLOCKFROST_PROJECT_ID_PREPROD: "playwright-fixture" },
  },
});
