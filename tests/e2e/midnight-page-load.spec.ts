import { test, expect, type Page, type CDPSession, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

// Measures what the Midnight page itself loads in each engine mode, with no chain and no proof server: every
// request leaving the server's origin is refused, and the restore points the engine at refused loopback ports. The
// page's requests come from a DevTools session on the page; the SharedWorker's from a browser-level session, since
// Playwright's routing never sees a SharedWorker. Only URLs, byte counts and timings are recorded: no wallet input.
// With EXPECT_NO_PAGE_WASM=1 the Worker-mode case also asserts that the page requested no ledger WebAssembly.

const WASM = /midnight_ledger_wasm_bg[^/]*\.wasm/;
const QUIET_MS = 4_000;
const SETTLE_LIMIT_MS = 90_000;
const RESULTS_DIR = process.env.PAGE_LOAD_RESULTS ?? 'playwright-report/page-load';

type RequestRecord = { url: string; type: string; bytes: number; finished: boolean; initiator: string };

/** Every request the page target makes, with its transferred (encoded) size once finished. */
async function observePage(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const requests = new Map<string, RequestRecord>();
  let lastActivity = Date.now();
  cdp.on('Network.requestWillBeSent', event => {
    // The script that asked for it: the top frame of the initiator's stack, or its URL for a parser-initiated load.
    const initiator = event.initiator as { type: string; url?: string; stack?: { callFrames: { url: string }[] } };
    const frame = initiator.stack?.callFrames.find(call => call.url)?.url ?? initiator.url ?? initiator.type;
    requests.set(event.requestId, { url: event.request.url, type: event.type ?? 'Other', bytes: 0, finished: false, initiator: frame });
    lastActivity = Date.now();
  });
  cdp.on('Network.loadingFinished', event => {
    const record = requests.get(event.requestId);
    if (record) { record.bytes = event.encodedDataLength; record.finished = true; }
    lastActivity = Date.now();
  });
  cdp.on('Network.loadingFailed', () => { lastActivity = Date.now(); });
  await cdp.send('Network.enable');
  return {
    records: () => [...requests.values()],
    quietSince: () => Date.now() - lastActivity,
  };
}

/** Every request each SharedWorker of the browser makes, from a browser-level DevTools session. */
async function observeWorkers(page: Page) {
  const browser = page.context().browser()!;
  const cdp: CDPSession = await browser.newBrowserCDPSession();
  const workers = new Map<string, { url: string; requests: string[] }>();
  const bySession = new Map<string, string>();
  let lastActivity = Date.now();
  cdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const targetId = bySession.get(sessionId);
    if (!targetId) return;
    let parsed: { method?: string; params?: { request?: { url?: string } } };
    try { parsed = JSON.parse(message); } catch { return; }
    if (parsed.method === 'Network.requestWillBeSent' && parsed.params?.request?.url) {
      workers.get(targetId)!.requests.push(parsed.params.request.url);
      lastActivity = Date.now();
    }
  });
  const attach = async (info: { targetId: string; url: string }) => {
    if (workers.has(info.targetId)) return;
    workers.set(info.targetId, { url: info.url, requests: [] });
    lastActivity = Date.now();
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: false });
    bySession.set(sessionId, info.targetId);
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: 1, method: 'Network.enable', params: {} }) });
  };
  cdp.on('Target.targetCreated', ({ targetInfo }) => { if (targetInfo.type === 'shared_worker') void attach(targetInfo).catch(() => {}); });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  return {
    workers: () => [...workers.values()],
    quietSince: () => Date.now() - lastActivity,
    stop: () => cdp.detach().catch(() => {}),
  };
}

const bytesOf = (records: RequestRecord[]) => records.reduce((sum, record) => sum + record.bytes, 0);

async function settle(quietSince: () => number) {
  const end = Date.now() + SETTLE_LIMIT_MS;
  while (Date.now() < end && quietSince() < QUIET_MS) await new Promise(resolve => setTimeout(resolve, 250));
}

for (const engine of ['worker', 'page'] as const) {
  test(`the Midnight page in ${engine} mode: what the page loads, what the worker loads, and how long restore takes`, async ({ page, baseURL }, testInfo: TestInfo) => {
    test.setTimeout(300_000);
    const origin = new URL(baseURL!).origin;
    const remote: string[] = [];
    const loopbackSockets: string[] = [];
    const isLoopback = (url: URL) => ['localhost', '127.0.0.1'].includes(url.hostname);
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== origin && !isLoopback(url)) { remote.push(url.origin); return route.abort(); }
      return route.continue();
    });
    // The engine's own connections go to the refused loopback endpoints the restore names; they are not remote.
    await page.routeWebSocket('**/*', socket => {
      const url = new URL(socket.url());
      if (url.host === new URL(baseURL!).host) { socket.connectToServer(); return; }
      if (isLoopback(url)) { loopbackSockets.push(url.pathname); socket.close(); return; }
      remote.push(socket.url().split('?')[0]); socket.close();
    });
    const pageObserver = await observePage(page);
    const workerObserver = await observeWorkers(page);
    // A fresh throwaway phrase for this run: never funded, never stored.
    const { util } = await import('@laceio/cardano/key-management');
    const words: string[] = util.generateMnemonicWords();
    try {
      const t0 = Date.now();
      await page.goto('/midnight');
      await expect(page.locator('#restore-form')).toBeVisible();
      const formMs = Date.now() - t0;
      await settle(pageObserver.quietSince);
      const loadRecords = pageObserver.records();
      const t1 = Date.now();
      await page.evaluate(({ words, engine }) => {
        const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
        field<HTMLTextAreaElement>('phrase').value = words.join(' ');
        field<HTMLInputElement>('password').value = 'throwaway-session';
        field<HTMLSelectElement>('network').value = 'undeployed';
        field<HTMLInputElement>('node').value = 'http://localhost:9';
        field<HTMLInputElement>('indexer').value = 'http://localhost:9/api/v4/graphql';
        field<HTMLSelectElement>('engine').value = engine;
        field<HTMLFormElement>('restore-form').requestSubmit();
      }, { words, engine });
      words.fill('');
      await expect(page.locator('#wallet-controls')).toBeVisible({ timeout: 180_000 });
      const restoreMs = Date.now() - t1;
      await settle(() => Math.min(pageObserver.quietSince(), workerObserver.quietSince()));
      const records = pageObserver.records();
      const afterRestore = records.slice(loadRecords.length);
      const workers = workerObserver.workers();
      const result = {
        engine,
        project: testInfo.project.name,
        timings: { navigationToFormMs: formMs, restoreMs },
        page: {
          requestsAtLoad: loadRecords.length,
          bytesAtLoad: bytesOf(loadRecords),
          requestsAfterRestore: afterRestore.length,
          bytesAfterRestore: bytesOf(afterRestore),
          requestsTotal: records.length,
          bytesTotal: bytesOf(records),
          wasm: records.filter(record => WASM.test(record.url)).map(record => ({ url: new URL(record.url).pathname, bytes: record.bytes, initiator: record.initiator })),
          // Every script and module the page loaded, for a reading of what reached it.
          scriptUrls: records.filter(record => record.type === 'Script' || /\.m?js(\?|$)/.test(record.url)).map(record => new URL(record.url).pathname + (new URL(record.url).search.includes('import') ? '?import' : '')),
          scripts: records.filter(record => record.type === 'Script' || /\.m?js(\?|$)/.test(record.url)).length,
        },
        sharedWorkers: workers.map(worker => ({
          url: new URL(worker.url).pathname,
          requests: worker.requests.length,
          wasm: worker.requests.filter(url => WASM.test(url)).map(url => new URL(url).pathname),
        })),
        initialization: await page.locator('#initialization').textContent(),
        status: await page.locator('#status').textContent(),
        remote,
        loopbackSockets: loopbackSockets.length,
      };
      await mkdir(RESULTS_DIR, { recursive: true });
      await writeFile(`${RESULTS_DIR}/${testInfo.project.name}-${engine}.json`, JSON.stringify(result, null, 2));
      await testInfo.attach(`page-load-${engine}`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
      expect(remote).toEqual([]);
      if (engine === 'page') expect(result.page.wasm.length).toBeGreaterThan(0);
      if (engine === 'worker') {
        expect(result.sharedWorkers.length).toBe(1);
        expect(result.sharedWorkers[0].wasm.length).toBeGreaterThan(0);
        if (process.env.EXPECT_NO_PAGE_WASM === '1') expect(result.page.wasm).toEqual([]);
      }
      await page.locator('#disconnect').click();
    } finally {
      await workerObserver.stop();
    }
  });
}
