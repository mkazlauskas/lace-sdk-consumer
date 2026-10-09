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
    env: {
      VITE_BLOCKFROST_PROJECT_ID_PREPROD: "playwright-fixture",
      VITE_PASSKEY_SIGNER_URL: "https://passkey-preview.lace.io",
      VITE_BLOCKFROST_URL_PREPROD: "https://cardano-preprod.blockfrost.io",
      VITE_TIP_POLL_MS: "2000",
      // The tests serve the sponsor at the relay path in the browser. These
      // override any .env values, so the relay holds no key and forwards
      // nothing, and nothing reaches the hosted sponsor.
      SPONSOR_URL: "http://127.0.0.1:9",
      SPONSOR_API_KEY: "",
    },
  },
});
