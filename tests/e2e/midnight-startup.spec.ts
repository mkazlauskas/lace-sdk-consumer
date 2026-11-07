import { test, expect } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import { installStartupDiagnostics } from '../live/startup-diagnostics';

// Synthetic UI observations only: the actual runtime is never imported and
// every remote request is refused. No wallet, keys or network wallet operations.
const runtime = (mode: 'failed' | 'delayed' | 'stream-error' | 'projection-error') => `
${mode === 'projection-error' ? "import { failure } from '/node_modules/.vite/deps/balance-diagnostic-fixture.js';" : ''}
const observable = value => ({ subscribe(next) { next(value); return { unsubscribe() {} }; } });
export async function restore(words, password, config) {
  const accountId = 'synthetic-account';
  const failed = { [accountId]: { pendingSync: { operations: { [accountId + '-midnight-sync']: { status: 'Failed', error: 'sync.error.midnight-sync-failed' } } } } };
  let syncNext;
  const sync = { subscribe(next) { syncNext = next; next(${mode === 'failed' ? 'failed' : '{}'}); return { unsubscribe() {} }; } };
  window.failSyntheticSync = () => syncNext(failed);
  const wallet = { dispatch() {}, stateObservables: {
    addresses: { selectByAccountId$: observable(() => []) },
    midnightContext: { selectPublicKeysByAccountId$: observable(() => undefined), selectDustBalanceByAccount$: observable({}), selectDustAvailableByAccount$: observable({}), selectDustGenerationDetails$: observable(() => ({})) },
    sync: { selectSyncStatusByAccount$: sync },
    tokens: { selectAggregatedTokensByAccountId$: observable(() => []), selectTokensMetadata$: observable({}) },
    activities: { selectByAccountId$: observable(() => []), selectActivityDetails$: observable(undefined) }
  } };
  const sdk = { AccountId: x => x, MidnightNetworkId: x => 'midnight-' + x, MIDNIGHT_PUBLIC_ENDPOINTS: { preview: {} }, NIGHT_TOKEN_ID: 'night',
    observeMidnightBalances: () => ({ subscribe(observer) { ${mode === 'projection-error' ? 'Promise.reject(failure).catch(observer.error);' : mode === 'stream-error' ? "observer.error(new Error('private sentinel must not escape'));" : ''} return { unsubscribe() {} }; } }) };
  return { wallet, entity: { walletId: 'synthetic-wallet', accounts: [{ accountId, blockchainName: 'Midnight', blockchainNetworkId: 'midnight-preview' }] }, sdk, config };
}
export function stopSession() {}
`;

async function restoreFixture(page: import('@playwright/test').Page, mode: Parameters<typeof runtime>[0], diagnostic?: Awaited<ReturnType<typeof installStartupDiagnostics>>) {
  await page.route('**/*', route => {
    if (!['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname)) return route.abort();
    if (new URL(route.request().url()).pathname === '/node_modules/.vite/deps/balance-diagnostic-fixture.js') return route.fulfill({ contentType: 'application/javascript', body: `
      export let failure;
      try { const state = {}; state.unshielded.availableCoins; }
      catch (error) { error.privateData = 'private sentinel'; failure = error; }
    ` });
    if (route.request().url().includes('/src/midnight/runtime.ts')) return route.fulfill({ contentType: 'application/javascript', body: runtime(mode) });
    return route.continue();
  });
  await page.goto('/midnight');
  if (diagnostic) {
    // bootstrap imports the app asynchronously; navigation alone is not app readiness.
    await expect(page.locator('#restore-form')).toBeVisible();
    await diagnostic.armBalanceObserver();
    // The live harness navigates again after preflight, before restoring.
    await page.reload();
  }
  await page.locator('#phrase').fill(Array(12).fill('synthetic').join(' '));
  await page.locator('#password').fill('synthetic');
  await page.locator('#restore').click();
  await expect(page.locator('#wallet-controls')).toBeVisible();
  await expect(page.locator('#phrase')).toHaveValue('');
  await expect(page.locator('#password')).toHaveValue('');
}

test('startup failure already present at restore return is not overwritten by a success banner', async ({ page }) => {
  await restoreFixture(page, 'failed');
  await expect(page.locator('#status')).toContainText('Account synchronization failed');
  const observation = JSON.parse((await page.locator('#initialization').textContent())!);
  expect(observation).toEqual({ stage: 'sync-failed', restoreReturned: true, balances: false, addresses: false, publicKeys: false, synchronized: false, syncFailed: true, balanceStreamFailed: false });
});

test('later sync failure replaces waiting and clearing resets the observation', async ({ page }) => {
  await restoreFixture(page, 'delayed');
  await expect(page.locator('#initialization')).toContainText('waiting-for-engine');
  await page.evaluate(() => (window as unknown as { failSyntheticSync(): void }).failSyntheticSync());
  await expect(page.locator('#status')).toContainText('Account synchronization failed');
  await expect(page.locator('#initialization')).toContainText('sync-failed');
  await page.locator('#disconnect').click();
  expect(JSON.parse((await page.locator('#initialization').textContent())!)).toEqual({ stage: 'idle' });
});

test('balance observer failure is terminal and withholds the underlying exception', async ({ page }) => {
  await restoreFixture(page, 'stream-error');
  await expect(page.locator('#status')).toContainText('Engine state observation failed');
  await expect(page.locator('#initialization')).toContainText('balance-stream-failed');
  await expect(page.locator('body')).not.toContainText('private sentinel');
});

for (const mode of ['stream-error', 'projection-error'] as const) {
  test(`balance probe captures ${mode} at the actual consumer callback before account-watch failure`, async ({ page }) => {
    const diagnostic = await installStartupDiagnostics(page);
    try {
      await restoreFixture(page, mode, diagnostic);
      await expect(page.locator('#initialization')).toContainText('balance-stream-failed');
      const snapshot = diagnostic.snapshot();
      expect(snapshot.balanceObserverArmed).toBe(true);
      expect(snapshot.stages).toEqual(['balance-stream-failed']);
      expect(snapshot.failures).toHaveLength(1);
      expect(snapshot.failures[0]).toMatchObject({ stage: 'balance-stream-failed', kind: mode === 'projection-error' ? 'TypeError' : 'Error', category: mode === 'projection-error' ? 'missing-value' : 'unclassified' });
      if (mode === 'projection-error') expect(snapshot.failures[0].locations).toContainEqual({ file: '/node_modules/.vite/deps/balance-diagnostic-fixture.js', line: 3, column: expect.any(Number) });
      expect(snapshot.diagnosticError).toBe(false);
      expect(snapshot.budgetExpired).toBe(false);
      expect(JSON.stringify(snapshot)).not.toContain('private sentinel');
      await expect(page.locator('body')).not.toContainText('private sentinel');
    } finally { await diagnostic.stop(); }
  });
}

test('startup probe observes synthetic breakpoints and emits no raw exception data', async ({ page }) => {
  // Keep the optimized file's line layout, but execute ONLY inert fixture code.
  // This tests CDP binding, pause/resume and error projection without a wallet.
  await page.route('**/*', route => ['localhost', '127.0.0.1'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  // The engine's startup anchors sit in the SDK's page-mode init chunk and the watcher's chunk (the
  // current SDK build has them in watch), and the account watcher's in its watch
  // chunk. Each chunk that holds one is served inert, the startup one first.
  const findBundles = async () => {
    const names = (await readdir('node_modules/.vite/deps').catch(() => [] as string[])).filter(name => /^[\w@.-]+\.js$/.test(name));
    const entries = await Promise.all(names.map(async name => ({ name, source: await readFile(`node_modules/.vite/deps/${name}`, 'utf8') })));
    const startup = entries.find(entry => entry.source.includes('walletFacade = facade;'));
    const watch = entries.find(entry => entry.source.includes('Account watch failure:'));
    return startup && watch ? [...new Set([startup, watch])] : undefined;
  };
  let bundles = await findBundles();
  if (!bundles) {
    // A cold dev cache needs the existing, wallet-free runtime loading probe.
    await page.goto('/tests/e2e/runtime-probe.html');
    await page.locator('#load').click();
    await expect(page.locator('#result')).toContainText('"runtime":"function"', { timeout: 90_000 });
    bundles = await findBundles();
  }
  if (!bundles) throw new Error('Run the existing dev runtime probe to populate the diagnostic bundle.');
  // Classic scripts share one global scope, so only the watch chunk, whose
  // breakpoint reads `error`, declares it.
  const inert = new Map(bundles.map(({ name, source }) => {
    const body = source.split('\n').map(() => "window.__diagnosticStep = true;");
    // The chunk that holds the watcher's breakpoint reads `error`; its name depends on the SDK build.
    if (source.includes('Account watch failure:')) body[0] = "const error = new TypeError('private sentinel is not a function');";
    return [name, body.join('\n')];
  }));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) return route.abort();
    const name = url.pathname.split('/').pop() ?? '';
    const body = inert.get(name);
    if (body !== undefined) return route.fulfill({ contentType: 'application/javascript', body });
    return route.continue();
  });
  const diagnostic = await installStartupDiagnostics(page);
  try {
    await page.goto('/midnight');
    // A query keeps the page's own copy of a chunk from being reused; the
    // breakpoints' URL pattern accepts it.
    for (const { name } of bundles) await page.addScriptTag({ url: `/node_modules/.vite/deps/${name}?inert` });
    const snapshot = diagnostic.snapshot();
    expect(snapshot.stages).toEqual(['imports-complete', 'storage-read-complete', 'keys-ready', 'facade-ready', 'unshielded-started', 'account-watch-failed']);
    expect(snapshot.failures[0]?.category).toBe('missing-callable');
    expect(snapshot.failures[0]?.kind).toBe('TypeError');
    expect(snapshot.diagnosticError).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('private sentinel');
  } finally { await diagnostic.stop(); }
});
