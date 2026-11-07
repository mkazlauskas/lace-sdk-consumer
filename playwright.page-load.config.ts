import { defineConfig } from '@playwright/test';

process.env.PLAYWRIGHT_NO_COPY_PROMPT = '1';

// The offline page-load measurement of the Midnight route, against the Vite development server and against
// `vite build` served by `vite preview`. No chain, no proof server, no wallet file.
const devPort = Number(process.env.PAGE_LOAD_DEV_PORT ?? 5194);
const previewPort = Number(process.env.PAGE_LOAD_PREVIEW_PORT ?? 5195);
const outDir = 'dist-page-load';
const env = {
  VITE_BLOCKFROST_PROJECT_ID_PREPROD: 'playwright-fixture',
  VITE_PASSKEY_SIGNER_URL: 'https://passkey-preview.lace.io',
  SPONSOR_URL: 'http://127.0.0.1:9',
  SPONSOR_API_KEY: '',
};

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'midnight-page-load.spec.ts',
  timeout: 300_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  fullyParallel: false,
  captureGitInfo: { commit: false, diff: false },
  reporter: [['line'], ['json', { outputFile: process.env.PAGE_LOAD_JSON ?? 'playwright-report/page-load.json' }]],
  use: { browserName: 'chromium', trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'dev', use: { baseURL: `http://localhost:${devPort}` } },
    { name: 'preview', use: { baseURL: `http://localhost:${previewPort}` } },
  ],
  webServer: [
    {
      command: `npm run dev -- --host localhost --port ${devPort} --strictPort`,
      url: `http://localhost:${devPort}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env,
    },
    {
      command: `npm run build -- --outDir ${outDir} --emptyOutDir && npm run preview -- --outDir ${outDir} --host localhost --port ${previewPort} --strictPort`,
      url: `http://localhost:${previewPort}`,
      reuseExistingServer: false,
      timeout: 600_000,
      env,
    },
  ],
});
