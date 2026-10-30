import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { canSpend, liveEndpoints, liveNetwork, parseTestWallet, waitForPublicReady, type PublicBalances, type TestWallet } from './wallet-input';
import { liveProver, preflightLocalProver } from './prover-config';
import { readPublicSync } from './public-sync';
import { indexedTransactions, nodeBlockNumber, nodePendingExtrinsics, waitForBlocks } from './local-chain';
import { observeSharedWorkers, type SharedWorkerObserver } from './worker-cdp';
import { freedAfterReset, heldByBuild, lastSuccessfulSync, nothingReserved, resetSeen, syncedSince, watchForReset, type ReservationBalances } from './reservations';
import type { SubmitBoundary } from '../../src/midnight/operations';

// The SDK's Worker mode in the reference consumer, in real Chromium. Live execution needs an explicit
// MIDNIGHT_LIVE (`preview` or `undeployed`, the local chain) and a disposable MIDNIGHT_TEST_WALLET_FILE,
// whose words and password reach the page once and are never printed. On Preview only the transfer runs, and
// it sends one smallest NIGHT unit to the wallet's own address; with MIDNIGHT_LIVE_RESET=1, the reset check runs there
// too. Every other scenario needs the local chain. Attachments carry public values only: hashes, counts, fixed labels and timings.

const network = liveNetwork(process.env.MIDNIGHT_LIVE);
const enabled = !!network && !!process.env.MIDNIGHT_TEST_WALLET_FILE;
const onLocalChain = network === 'undeployed';
const ENDPOINT = /:9944\b|:8088\b|:6300\b|\.midnight\.network\b/;
/** An indexer's GraphQL subscription socket, local or Preview. */
const INDEXER_SOCKET = /\/api\/v\d+\/graphql\/ws$/;
// The one call in the worker's engine that broadcasts a proved transaction (the wallet SDK's facade).
const BROADCAST_ANCHOR = /submissionService\.submitTransaction\(/;

type Balances = PublicBalances & ReservationBalances & { synced: { unshielded: boolean; shielded: boolean; dust: boolean } };
type SubmissionRecord = { stage?: string; activityHash?: string; txId?: string; historyType?: string; sdk?: string; errorCode?: string };

async function loadWallet(): Promise<TestWallet> {
  try { return parseTestWallet(JSON.parse(await readFile(process.env.MIDNIGHT_TEST_WALLET_FILE!, 'utf8')), network); }
  catch { throw new Error(`Invalid disposable wallet input; requires ${network}, its expected address, mnemonicWords and passwordHex or password.`); }
}
function requireLocalProver() {
  if (liveProver(process.env.MIDNIGHT_LIVE_PROVER) !== 'local') throw new Error('Worker mode proves only through a proof server URL: set MIDNIGHT_LIVE_PROVER=local.');
}

const loads = new WeakMap<Page, number>();
async function openMidnight(page: Page) {
  if (!loads.has(page)) page.on('load', () => loads.set(page, (loads.get(page) ?? 0) + 1));
  loads.set(page, 0);
  await page.goto('/midnight');
  await expect(page.locator('#restore-form')).toBeVisible();
}
/** Bounded, progress-aware wait on public page state; a reload, a failed restore or a failed stream ends it at once. */
async function waitForState(page: Page, ready: () => Promise<boolean>, timeout: number, message: string) {
  const began = Date.now(), initialTestTimeout = test.info().timeout;
  await waitForPublicReady(async () => {
    if ((loads.get(page) ?? 0) > 1) throw new Error('The page reloaded, which ends its session.');
    const before = await page.evaluate(readPublicSync);
    const matched = await ready();
    const after = await page.evaluate(readPublicSync);
    return { ...after, stage: ['restore-failed', 'sync-failed', 'balance-stream-failed'].includes(before.stage) ? before.stage : after.stage, ready: matched };
  }, timeout, message, undefined, () => {
    if (initialTestTimeout > 0) test.setTimeout(initialTestTimeout + Date.now() - began + timeout);
  });
}

/** Restores the wallet on this page in Worker mode with the local proof server. Returns once wallet controls show. */
async function restore(page: Page, wallet: TestWallet, options: { storage?: 'memory' | 'indexeddb'; adopt?: boolean; engineFailureExpected?: boolean } = {}) {
  await openMidnight(page);
  // Catch inside the browser: library exceptions must never serialize secret input.
  const injected = await page.evaluate(({ mnemonicWords, password, accountIndex, network, endpoints, storage, adopt }) => {
    const field = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
    try {
      field<HTMLTextAreaElement>('phrase').value = mnemonicWords.join(' ');
      field<HTMLInputElement>('password').value = password;
      field<HTMLInputElement>('index').value = String(accountIndex);
      field<HTMLSelectElement>('network').value = network;
      field<HTMLSelectElement>('prover').value = 'local';
      field<HTMLSelectElement>('engine').value = 'worker';
      field<HTMLSelectElement>('worker-storage').value = storage;
      field<HTMLInputElement>('worker-adopt').checked = adopt;
      field<HTMLInputElement>('node').value = endpoints?.nodeAddress ?? '';
      field<HTMLInputElement>('indexer').value = endpoints?.indexerAddress ?? '';
      field<HTMLFormElement>('restore-form').requestSubmit();
      return true;
    } catch { return false; }
    finally {
      field<HTMLTextAreaElement>('phrase').value = ''; field<HTMLInputElement>('password').value = '';
      mnemonicWords.fill('');
    }
  }, { ...wallet, endpoints: liveEndpoints(wallet.network), storage: options.storage ?? 'memory', adopt: options.adopt ?? false });
  expect(injected).toBe(true);
  // Boolean assertions cannot disclose DOM field values on failure.
  expect(await page.evaluate(() => ({
    phraseCleared: (document.getElementById('phrase') as HTMLTextAreaElement).value === '',
    passwordCleared: (document.getElementById('password') as HTMLInputElement).value === '',
  }))).toEqual({ phraseCleared: true, passwordCleared: true });
  // A scenario that expects the engine to fail sees the sync fail too; only a failed restore ends its wait.
  if (options.engineFailureExpected) {
    await expect.poll(async () => {
      if ((await page.evaluate(readPublicSync)).stage === 'restore-failed') throw new Error('Midnight restore failed; secret-bearing library errors are withheld.');
      return page.locator('#wallet-controls').isVisible();
    }, { timeout: 240_000, message: 'Restore must return wallet controls.' }).toBe(true);
  } else await waitForState(page, () => page.locator('#wallet-controls').isVisible(), 240_000, 'Restore must return wallet controls.');
}
async function balances(page: Page): Promise<Balances> {
  return JSON.parse((await page.locator('#balances').textContent())!);
}
async function isSynced(page: Page, wallet: TestWallet) {
  try { const state = await balances(page); return state.address.unshielded === wallet.address && state.synced.unshielded && state.synced.shielded && state.synced.dust; }
  catch { return false; }
}
async function waitForSynced(page: Page, wallet: TestWallet, timeout: number) {
  await waitForState(page, () => isSynced(page, wallet), timeout, 'The account must reach a strictly synced balance at the supplied address.');
}
/**
 * After a recorded engine failure the page still shows the failed sync while a new engine starts; the failure
 * clears once that engine syncs. So this wait accepts the failed stage until the new engine is synced.
 */
async function waitForRecovered(page: Page, wallet: TestWallet, timeout: number) {
  await expect.poll(async () => (await page.evaluate(readPublicSync)).stage === 'synchronized' && await isSynced(page, wallet),
    { timeout, message: 'A new engine must sync the account and clear the failure.' }).toBe(true);
}
/** The SDK error label the page shows for the ended balance stream, such as `MidnightWorkerStoppedError [midnight-worker-stopped]`. */
async function streamError(page: Page): Promise<string | undefined> {
  try { return (JSON.parse((await page.locator('#readiness').textContent())!) as { error?: string }).error; } catch { return undefined; }
}
async function statusText(page: Page) { return (await page.locator('#status').textContent()) ?? ''; }
const labelIn = (text: string) => text.match(/Midnight[A-Za-z]*Error \[midnight-[a-z-]+\]/)?.[0];
/** The SDK label of the operation the page last reported as failed. */
async function failedOperation(page: Page) {
  const status = await statusText(page);
  return status.startsWith('Operation failed') ? labelIn(status) : undefined;
}
/** How each submitMidnightTx promise of the page settled, when the test set `__laceSubmitBoundary` before load. */
async function submitBoundary(page: Page): Promise<SubmitBoundary[]> {
  return page.evaluate(() => [...((window as { __laceSubmitBoundary?: SubmitBoundary[] }).__laceSubmitBoundary ?? [])]);
}
async function record(page: Page): Promise<SubmissionRecord> {
  try { return JSON.parse((await page.locator('#submission').textContent())!)[0] ?? {}; } catch { return {}; }
}
async function history(page: Page): Promise<{ activityId: string; type: string }[]> {
  try { return JSON.parse((await page.locator('#history').textContent())!); } catch { return []; }
}
async function approve(page: Page) {
  await expect(page.locator('#confirmation')).toBeVisible();
  await expect(page.locator('#review-summary')).toContainText(network!);
  await page.locator('#approve').click();
}
/**
 * Waits for `ready`, and fails at once, naming only the SDK label, when the page reports a failed operation. A
 * failure the status line already showed before the action (`previousStatus`) is not this operation's.
 */
async function waitForOperation(page: Page, ready: () => Promise<boolean>, timeout: number, message: string, previousStatus?: string) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await ready()) return;
    const status = await statusText(page);
    if (status.startsWith('Operation failed') && status !== previousStatus) throw new Error(`${message}: the page reported a failed operation${labelIn(status) ? ` (${labelIn(status)})` : ''}.`);
    await page.waitForTimeout(250);
  }
  throw new Error(`${message}: timed out after ${timeout} ms.`);
}
async function prove(page: Page) {
  await expect(page.locator('#prove')).toBeEnabled({ timeout: 120_000 });
  await page.locator('#prove').click(); await approve(page);
  await waitForOperation(page, () => page.locator('#submit').isEnabled(), 900_000, 'Proving must enable submission');
}
/** Submits the proved transaction and waits until history confirms its hash and the SDK call settles. */
async function submitAndConfirm(page: Page, confirmTimeout: number): Promise<SubmissionRecord> {
  await page.locator('#submit').click(); await approve(page);
  await expect.poll(async () => (await record(page)).stage ?? 'not-observed', { timeout: 30_000, message: 'Approval must record the submission and its hash.' }).not.toMatch(/^(idle|not-observed)$/);
  if ((await record(page)).stage === 'failed') throw new Error(`Submission failed before broadcast (${(await record(page)).errorCode ?? 'no code'}).`);
  await expect.poll(async () => (await record(page)).stage, { timeout: confirmTimeout, message: 'History must confirm this exact proved transaction.' }).toMatch(/^(confirmed|failed-on-chain)$/);
  await expect.poll(async () => (await record(page)).sdk, { timeout: 360_000, message: 'The SDK submission call must settle.' }).not.toBe('pending');
  return record(page);
}
/** Builds, signs, proves and submits one smallest NIGHT unit to the wallet's own address, through the page's reviews. */
async function transferOwn(page: Page, wallet: TestWallet, confirmTimeout: number) {
  const state = await balances(page);
  if (!state.nightTokenId?.startsWith(`unshielded-${wallet.network}`)) throw new Error('Expected NIGHT token unavailable.');
  await page.locator('#kind').selectOption('unshielded');
  // Only this wallet's own address, exactly one smallest unit.
  await page.locator('#outputs').fill(JSON.stringify([{ to: wallet.address, tokenId: state.nightTokenId, amount: '1' }]));
  await page.locator('#estimate').click();
  await waitForOperation(page, async () => ((await page.locator('#operation').textContent()) ?? '').includes('unsignedEstimate'), 120_000, 'The fee estimate must return');
  await page.locator('#build').click();
  await waitForOperation(page, () => page.locator('#sign').isEnabled(), 120_000, 'The build must return an unsigned transfer');
  await page.locator('#sign').click(); await approve(page);
  await prove(page);
  return submitAndConfirm(page, confirmTimeout);
}
/** Spendable NIGHT and DUST. On the local chain a fresh genesis wallet first registers its NIGHT for DUST; never on Preview. */
async function ensureSpendable(page: Page, wallet: TestWallet) {
  if (canSpend(await balances(page), wallet.address, true)) return;
  if (wallet.network !== 'undeployed') throw new Error('The Preview wallet has no spendable NIGHT and DUST; this suite never registers on Preview.');
  if (BigInt((await balances(page)).night.available) < 1n) throw new Error('The local genesis wallet holds no NIGHT.');
  await page.locator('#kind').selectOption('dust');
  await page.locator('#dust-address').fill('');
  await page.locator('#build').click(); await approve(page);
  await prove(page);
  await submitAndConfirm(page, 180_000);
  await waitForState(page, async () => { try { return canSpend(await balances(page), wallet.address, true); } catch { return false; } }, 600_000, 'Registered NIGHT must generate spendable DUST.');
}
/** Requests the page itself sent to a node, an indexer or a proof server, WebSockets included. */
function watchPage(page: Page) {
  const seen: string[] = [];
  page.on('request', request => { if (ENDPOINT.test(request.url())) seen.push(`${request.method()} ${request.url().split('?')[0]}`); });
  page.on('websocket', socket => { if (ENDPOINT.test(socket.url())) seen.push(`WS ${socket.url().split('?')[0]}`); });
  return () => [...seen];
}
async function attach(testInfo: TestInfo, name: string, body: unknown) {
  await testInfo.attach(name, { body: JSON.stringify(body, null, 2), contentType: 'application/json' });
}
async function clearSecrets(page: Page) {
  await page.evaluate(() => {
    for (const id of ['phrase', 'password']) { const input = document.getElementById(id) as HTMLInputElement | null; if (input) input.value = ''; }
  }).catch(() => {});
}
// Prefer the page's Clear session, so the SDK detaches this page from the worker.
async function disconnect(page: Page) {
  if (page.isClosed()) return;
  await page.locator('#disconnect').click({ timeout: 5_000 }).catch(() => {});
  await clearSecrets(page);
}

test.describe('Worker mode, live', () => {
  test.skip(!enabled, 'Requires MIDNIGHT_LIVE=preview or undeployed and a disposable MIDNIGHT_TEST_WALLET_FILE.');
  let workers: SharedWorkerObserver;
  test.beforeEach(async ({ browser }) => { workers = await observeSharedWorkers(browser); });
  test.afterEach(async ({ context }, testInfo) => {
    // Public page state and the workers' connections, for a failure's diagnosis: fixed stages, SDK labels and URLs.
    const pages = [];
    for (const page of context.pages()) {
      pages.push(await page.evaluate(() => {
        const text = (id: string) => document.getElementById(id)?.textContent ?? null;
        return { status: text('status'), initialization: text('initialization'), readiness: text('readiness'), configuration: text('configuration'), submission: text('submission') };
      }).catch(() => ({ unavailable: true })));
    }
    await attach(testInfo, 'worker-diagnostic', { pages, workers: workers.all().map(({ title, closed, openSockets, socketEvents, submitFrames, requests }) => ({ title, closed, openSockets, socketEvents, submitFrames, requests: requests.length })) });
    for (const page of context.pages()) await disconnect(page);
    await workers.stop();
  });

  test('Transfer: Worker mode, unlock, synced balance, build → sign → prove → submit, finalized', async ({ page }, testInfo) => {
    requireLocalProver();
    // The proof server Worker mode proves through, checked before any wallet starts.
    await preflightLocalProver();
    const wallet = await loadWallet();
    const pageEndpoints = watchPage(page);
    const t0 = Date.now();
    const timings: Record<string, number> = {};
    let observation: Record<string, unknown> = {};
    try {
      await restore(page, wallet);
      timings.restoreMs = Date.now() - t0;
      // Worker mode is on: the page says so and the SDK started its SharedWorker.
      expect(JSON.parse((await page.locator('#configuration').textContent())!)).toMatchObject({ engine: 'worker', workerStorage: 'memory', adopt: false });
      const worker = await workers.waitForWorker(120_000);
      expect(worker.title).toBe('lace-midnight-engine');
      // The page stays usable while the engine syncs in the worker.
      const syncingWhileTyping = !(await balances(page).then(state => state.synced.unshielded && state.synced.shielded && state.synced.dust).catch(() => false));
      await page.locator('#scratch').pressSequentially('typed during sync');
      await expect(page.locator('#scratch-echo')).toHaveText('17 characters: typed during sync');
      await waitForSynced(page, wallet, 2_400_000);
      timings.syncedMs = Date.now() - t0;
      await ensureSpendable(page, wallet);
      const before = await balances(page);
      // A fresh local chain first needs a DUST registration, which is a submission too.
      const framesBefore = workers.all().find(item => item.targetId === worker.targetId)!.submitFrames;
      const started = Date.now();
      const submission = await transferOwn(page, wallet, wallet.network === 'preview' ? 900_000 : 180_000);
      timings.transferMs = Date.now() - started;
      timings.totalMs = Date.now() - t0;
      // Finalized: the SDK returned its txId at finality, and history lists the exact hash as the wallet's own transfer.
      expect(submission).toMatchObject({ stage: 'confirmed', sdk: 'returned', historyType: 'Self' });
      expect(submission.txId).toBeTruthy();
      expect((await history(page)).find(row => row.activityId === submission.activityHash)?.type).toBe('Self');
      // The engine ran in the worker: the worker reached the node, the indexer and the proof server, the page none of them.
      const engine = workers.all().find(item => item.targetId === worker.targetId)!;
      expect(engine.requests.some(request => /^POST http:\/\/127\.0\.0\.1:6300\/prove/.test(request))).toBe(true);
      expect(engine.sockets.filter(url => ENDPOINT.test(url)).length).toBeGreaterThan(0);
      expect(engine.submitFrames - framesBefore).toBe(1);
      expect(pageEndpoints()).toEqual([]);
      observation = {
        network: wallet.network, server: testInfo.project.name, syncingWhileTyping,
        activityHash: submission.activityHash, txId: submission.txId, stage: submission.stage, sdk: submission.sdk, historyType: submission.historyType,
        balancesBefore: { night: before.night, dust: before.dust, synced: before.synced },
        worker: { title: engine.title, sockets: engine.sockets.filter(url => ENDPOINT.test(url)), proveRequests: engine.requests.filter(r => r.includes(':6300/')).length, transferSubmitFrames: engine.submitFrames - framesBefore },
        pageEndpointRequests: pageEndpoints().length, timings,
      };
    } finally {
      await attach(testInfo, 'worker-sc1', { ...observation, timings, submission: await record(page), status: await statusText(page) });
    }
  });

  // lace-platform#2939. Only with MIDNIGHT_LIVE_RESET=1, after the transfers have confirmed, so that no other transaction
  // holds coins. Nothing is signed, proved or submitted, but the proof server is checked as for every scenario.
  test('reset frees the NIGHT and the DUST fee that a built transfer reserved', async ({ page }, testInfo) => {
    test.skip(process.env.MIDNIGHT_LIVE_RESET !== '1', 'Requires MIDNIGHT_LIVE_RESET=1.');
    requireLocalProver();
    await preflightLocalProver();
    const wallet = await loadWallet();
    const seen: Partial<Record<'before' | 'built' | 'afterReset', ReservationBalances>> = {};
    // Each wait records the last state it read, so the attachment shows the values it compared.
    const read = async (name: keyof typeof seen) => { const state = await balances(page); seen[name] = { night: state.night, dust: state.dust }; return state; };
    try {
      await restore(page, wallet);
      await waitForSynced(page, wallet, 2_400_000);
      // Read-only, unlike ensureSpendable: this check never registers, on any chain.
      await waitForState(page, async () => canSpend(await balances(page), wallet.address, true), 600_000, 'The reset check needs spendable NIGHT and DUST; it never registers.');
      await waitForState(page, async () => nothingReserved(await read('before')), 120_000, 'Nothing may be reserved before the build: another transaction holds coins.');
      const availableBefore = BigInt(seen.before!.night.available);
      await page.locator('#kind').selectOption('unshielded');
      await page.locator('#outputs').fill(JSON.stringify([{ to: wallet.address, tokenId: (await balances(page)).nightTokenId, amount: '1' }]));
      await page.locator('#estimate').click();
      await waitForOperation(page, async () => ((await page.locator('#operation').textContent()) ?? '').includes('unsignedEstimate'), 120_000, 'The fee estimate must return');
      await page.locator('#build').click();
      await waitForOperation(page, () => page.locator('#sign').isEnabled(), 120_000, 'The build must return an unsigned transfer');
      // Left unsigned. The worker sends its state at most every 500 ms, so the reservation shows a little later.
      await waitForState(page, async () => heldByBuild(await read('built'), availableBefore), 120_000, 'The build must show its reservation; without it this check is invalid.');
      expect((await history(page)).length, 'The reset signal needs a non-empty history before the reset.').toBeGreaterThan(0);
      const syncMark = await lastSuccessfulSync(page);
      await watchForReset(page);
      await page.locator('#reset').click();
      await expect(page.locator('#status')).toContainText('Reset requested');
      await expect.poll(() => resetSeen(page), { timeout: 60_000, message: 'The page must observe the reset' }).toBe(true);
      await waitForState(page, async () => await syncedSince(page, syncMark) && await isSynced(page, wallet), 2_400_000, 'The reset account must complete a new strict sync.');
      await waitForState(page, async () => { try { return freedAfterReset(await read('afterReset'), availableBefore); } catch { return false; } }, 120_000,
        'Once the reset account has synced, the NIGHT and the DUST the build reserved must be free.');
    } finally {
      await attach(testInfo, 'worker-reset-reservations', { network: wallet.network, server: testInfo.project.name, ...seen, status: await statusText(page) });
    }
  });

  test.describe('local chain', () => {
    test.skip(!onLocalChain, 'These scenarios run on the local chain only (MIDNIGHT_LIVE=undeployed).');
    test.beforeEach(async () => { test.setTimeout(900_000); requireLocalProver(); await preflightLocalProver(); });

    test('tabs: two tabs share one engine; closing one keeps the other working', async ({ page, context }, testInfo) => {
      const wallet = await loadWallet();
      await restore(page, wallet);
      await waitForSynced(page, wallet, 300_000);
      const engine = await workers.waitForWorker(60_000);
      // An engine holds its indexer subscriptions open while it runs; the node socket opens and closes on demand.
      const openIndexerSockets = () => workers.all().find(item => item.targetId === engine.targetId)!.openSocketUrls.filter(url => INDEXER_SOCKET.test(url)).length;
      const indexerSocketsWithOneTab = openIndexerSockets();
      expect(indexerSocketsWithOneTab).toBeGreaterThan(0);
      const second = await context.newPage();
      await restore(second, wallet);
      await waitForSynced(second, wallet, 300_000);
      // One SharedWorker, and tab 2 attached to the running engine: as many open indexer subscriptions as with one
      // tab. A second engine holds its own set open beside the first one's; a reconnect only replaces a socket, so
      // the count is polled until it settles.
      expect((await workers.live()).map(item => item.targetId)).toEqual([engine.targetId]);
      await expect.poll(openIndexerSockets, { timeout: 30_000 }).toBe(indexerSocketsWithOneTab);
      expect((await balances(second)).address).toEqual((await balances(page)).address);
      // Closing tab 1 (its pagehide clears its session) leaves tab 2 working on the same engine.
      await page.close();
      await second.locator('#kind').selectOption('unshielded');
      await second.locator('#outputs').fill(JSON.stringify([{ to: wallet.address, tokenId: (await balances(second)).nightTokenId, amount: '1' }]));
      await second.locator('#estimate').click();
      await waitForOperation(second, async () => ((await second.locator('#operation').textContent()) ?? '').includes('unsignedEstimate'), 120_000, 'Tab 2 must still reach the engine');
      expect((await workers.live()).map(item => item.targetId)).toEqual([engine.targetId]);
      expect((await balances(second)).synced).toMatchObject({ unshielded: true, shielded: true, dust: true });
      await attach(testInfo, 'worker-tabs', { workers: workers.all().map(({ title, closed, sockets, openSocketUrls }) => ({ title, closed, sockets: sockets.length, openSockets: openSocketUrls.length })), indexerSocketsWithOneTab, indexerSocketsWithTwoTabs: openIndexerSockets() });
    });

    test('tabs: other settings conflict, and adopt resolves it', async ({ page, context }, testInfo) => {
      const wallet = await loadWallet();
      await restore(page, wallet, { storage: 'memory' });
      await waitForSynced(page, wallet, 300_000);
      const second = await context.newPage();
      // Another storage kind is another engine setting: refused by default.
      await restore(second, wallet, { storage: 'indexeddb', engineFailureExpected: true });
      await expect.poll(() => streamError(second), { timeout: 120_000 }).toBe('MidnightWorkerSettingsConflictError [midnight-settings-conflict]');
      expect(await statusText(second)).toContain('Use the running engine');
      await second.locator('#kind').selectOption('unshielded');
      await second.locator('#outputs').fill(JSON.stringify([{ to: wallet.address, tokenId: (await balances(page)).nightTokenId, amount: '1' }]));
      await second.locator('#estimate').click();
      await expect.poll(() => failedOperation(second), { timeout: 60_000 }).toBe('MidnightWorkerSettingsConflictError [midnight-settings-conflict]');
      // With adopt the tab attaches with the running engine's settings.
      await second.locator('#disconnect').click();
      await restore(second, wallet, { storage: 'indexeddb', adopt: true });
      await waitForSynced(second, wallet, 300_000);
      expect(JSON.parse((await second.locator('#configuration').textContent())!)).toMatchObject({ engine: 'worker', workerStorage: 'indexeddb', adopt: true });
      expect((await workers.live())).toHaveLength(1);
      await attach(testInfo, 'worker-settings-conflict', { refused: 'MidnightWorkerSettingsConflictError [midnight-settings-conflict]', adopted: true, workers: workers.all().length });
    });

    test('tabs: a reset in one tab resets the engine both tabs share', async ({ page, context }, testInfo) => {
      const wallet = await loadWallet();
      await restore(page, wallet);
      await waitForSynced(page, wallet, 300_000);
      await ensureSpendable(page, wallet);
      const second = await context.newPage();
      await restore(second, wallet);
      await waitForSynced(second, wallet, 300_000);
      // Tab 2 builds a transfer, then tab 1 resets the account's sync.
      await second.locator('#kind').selectOption('unshielded');
      await second.locator('#outputs').fill(JSON.stringify([{ to: wallet.address, tokenId: (await balances(second)).nightTokenId, amount: '1' }]));
      await second.locator('#build').click();
      await waitForOperation(second, () => second.locator('#sign').isEnabled(), 120_000, 'Tab 2 must build a transfer');
      // Each tab clears the account's history when the worker reports the reset; record it in tab 2 as it happens.
      await second.evaluate(() => {
        const target = document.getElementById('history')!;
        const seen = () => { if (target.textContent === '[]') (window as unknown as { __resetSeen?: boolean }).__resetSeen = true; };
        new MutationObserver(seen).observe(target, { childList: true, characterData: true, subtree: true });
      });
      expect((await history(second)).length).toBeGreaterThan(0);
      await page.locator('#reset').click();
      await expect(page.locator('#status')).toContainText('Reset requested');
      // Tab 2 sees the reset, then both tabs sync the fresh engine.
      await expect.poll(() => second.evaluate(() => (window as unknown as { __resetSeen?: boolean }).__resetSeen === true), { timeout: 60_000, message: 'Tab 2 must observe the reset' }).toBe(true);
      await waitForSynced(page, wallet, 300_000);
      await waitForSynced(second, wallet, 300_000);
      // The transfer tab 2 built before the reset is refused.
      await second.locator('#sign').click(); await approve(second);
      await expect.poll(() => failedOperation(second), { timeout: 60_000 }).toMatch(/^Midnight(StaleTx|EngineReset)Error \[midnight-(stale-tx|engine-reset)\]$/);
      const refusal = await failedOperation(second);
      // A transfer built after the reset signs; it is then discarded unsent.
      const refusalStatus = await statusText(second);
      await second.locator('#build').click();
      await waitForOperation(second, () => second.locator('#sign').isEnabled(), 120_000, 'Tab 2 must build again', refusalStatus);
      await second.locator('#sign').click(); await approve(second);
      await waitForOperation(second, () => second.locator('#prove').isEnabled(), 120_000, 'Tab 2 must sign the new transfer');
      await second.locator('#cancel-operation').click();
      expect((await workers.live())).toHaveLength(1);
      await attach(testInfo, 'worker-shared-reset', { refusal, rebuiltAndSigned: true, workers: workers.all().length });
    });

    test('unsupported browser: without SharedWorker every engine call returns MidnightWorkerUnsupportedError, with no fallback', async ({ page, context }, testInfo) => {
      await context.addInitScript(() => { Object.defineProperty(window, 'SharedWorker', { value: undefined, configurable: true, writable: true }); });
      const wallet = await loadWallet();
      const pageEndpoints = watchPage(page);
      await restore(page, wallet, { engineFailureExpected: true });
      await expect.poll(() => streamError(page), { timeout: 120_000 }).toBe('MidnightWorkerUnsupportedError [midnight-worker-unsupported]');
      await page.locator('#kind').selectOption('unshielded');
      // A valid NIGHT output (NIGHT's raw token type is 64 zeros), so only the engine can refuse the call.
      await page.locator('#outputs').fill(JSON.stringify([{ to: wallet.address, tokenId: `unshielded-undeployed${'0'.repeat(64)}`, amount: '1' }]));
      await page.locator('#estimate').click();
      await expect.poll(() => failedOperation(page), { timeout: 60_000 }).toBe('MidnightWorkerUnsupportedError [midnight-worker-unsupported]');
      // No SharedWorker started, and the page did not run the engine itself.
      expect(workers.all()).toEqual([]);
      expect(pageEndpoints()).toEqual([]);
      await attach(testInfo, 'worker-unsupported', { error: 'MidnightWorkerUnsupportedError [midnight-worker-unsupported]', workers: 0, pageEndpointRequests: 0 });
    });

    test('proving provider: a dApp-style circuit call proves in the worker through the proof server', async ({ page }, testInfo) => {
      const wallet = await loadWallet();
      const pageEndpoints = watchPage(page);
      await restore(page, wallet);
      await waitForSynced(page, wallet, 300_000);
      const worker = await workers.waitForWorker(60_000);
      // A dApp's unproven transaction: one shielded output to sample public keys, built by the ledger in Node.
      // Its preimage is for the protocol circuit midnight/zswap/output, so the SDK uses the proof server's built-in keys.
      const ledger = await import('@midnight-ntwrk/ledger-v8');
      const token = ledger.shieldedToken().raw;
      const output = ledger.ZswapOutput.new(ledger.createShieldedCoinInfo(token, 1n), 0, ledger.sampleCoinPublicKey(), ledger.sampleEncryptionPublicKey());
      const unproven = ledger.Transaction.fromParts('undeployed', ledger.ZswapOffer.fromOutput(output, token, 1n));
      const captured: { preimage?: Uint8Array; keyLocation?: string } = {};
      await unproven.prove({
        check: async () => { throw new Error('captured'); },
        prove: async (preimage, keyLocation) => { captured.preimage = preimage; captured.keyLocation = keyLocation; throw new Error('captured'); },
      }, ledger.CostModel.initialCostModel()).catch(() => {});
      expect(captured.keyLocation).toBe('midnight/zswap/output');
      const hex = Buffer.from(captured.preimage!).toString('hex');
      await page.locator('summary', { hasText: 'Prove / check a circuit' }).click();
      const run = async (kind: 'check' | 'prove') => {
        await page.locator('#circuit-kind').selectOption(kind);
        await page.locator('#key-location').fill(captured.keyLocation!);
        await page.locator('#preimage').fill(hex);
        await page.locator('#circuit-run').click(); await approve(page);
        await waitForOperation(page, async () => ((await page.locator('#circuit-result').textContent()) ?? '') !== 'No circuit result.', 300_000, `The circuit ${kind} must return`);
        const result = (await page.locator('#circuit-result').textContent())!;
        await page.evaluate(() => { document.getElementById('circuit-result')!.textContent = 'No circuit result.'; });
        return result;
      };
      const checked = JSON.parse(await run('check'));
      expect(Array.isArray(checked)).toBe(true);
      const proof = await run('prove');
      expect(proof).toMatch(/^(?:[0-9a-f]{2})+$/);
      // The proof bytes complete the dApp's transaction in the ledger.
      const proven = await unproven.prove({ check: async () => [], prove: async () => Buffer.from(proof, 'hex') }, ledger.CostModel.initialCostModel());
      expect(proven.serialize().length).toBeGreaterThan(0);
      // The worker called the proof server; the page did not.
      const requests = workers.all().find(item => item.targetId === worker.targetId)!.requests;
      expect(requests.some(request => request.startsWith('POST http://127.0.0.1:6300/check'))).toBe(true);
      expect(requests.some(request => request.startsWith('POST http://127.0.0.1:6300/prove'))).toBe(true);
      expect(pageEndpoints().filter(request => request.includes(':6300'))).toEqual([]);
      await attach(testInfo, 'worker-proving-provider', { keyLocation: captured.keyLocation, checkResultLength: checked.length, proofBytes: proof.length / 2, workerProofServerRequests: requests.filter(r => r.includes(':6300/')) });
    });

    test('connector: balancing a dApp transaction signs and proves in the worker, then it lands', async ({ page }, testInfo) => {
      const wallet = await loadWallet();
      const pageEndpoints = watchPage(page);
      await restore(page, wallet);
      await waitForSynced(page, wallet, 300_000);
      await ensureSpendable(page, wallet);
      const worker = await workers.waitForWorker(60_000);
      // A dApp's unbalanced, unproven transaction: an intent paying one smallest NIGHT unit to the wallet's own
      // address, with no inputs and no fee. The wallet must add both.
      const ledger = await import('@midnight-ntwrk/ledger-v8');
      const addresses = await import('@midnightntwrk/wallet-sdk-address-format');
      const owner = addresses.MidnightBech32m.parse(wallet.address).decode(addresses.UnshieldedAddress, 'undeployed').hexString;
      const intent = ledger.Intent.new(new Date(Date.now() + 30 * 60_000));
      intent.guaranteedUnshieldedOffer = ledger.UnshieldedOffer.new([], [{ value: 1n, owner, type: ledger.nativeToken().raw }], []);
      // The connector balances a proved transaction (`proof`, `pre-binding`); this one needs no proof, so proving
      // only changes its type and the provider is never called.
      const unproven = ledger.Transaction.fromParts('undeployed', undefined, undefined, intent);
      const noProofs = { check: async () => { throw new Error('no circuit expected'); }, prove: async () => { throw new Error('no circuit expected'); } };
      const tx = Buffer.from((await unproven.prove(noProofs, ledger.CostModel.initialCostModel())).serialize()).toString('hex');
      await page.locator('#connector-kind').selectOption('unsealed');
      await page.locator('#connector').fill(JSON.stringify({ tx, options: { payFees: true } }));
      await page.locator('#connector-run').click(); await approve(page);
      await waitForOperation(page, () => page.locator('#submit').isEnabled(), 600_000, 'Balancing must return a proved transaction');
      const submission = await submitAndConfirm(page, 180_000);
      expect(submission).toMatchObject({ stage: 'confirmed', sdk: 'returned' });
      const requests = workers.all().find(item => item.targetId === worker.targetId)!.requests;
      expect(requests.some(request => request.startsWith('POST http://127.0.0.1:6300/prove'))).toBe(true);
      expect(pageEndpoints()).toEqual([]);
      expect(await indexedTransactions(submission.activityHash!)).toBe(1);
      await attach(testInfo, 'worker-connector-balance', { activityHash: submission.activityHash, txId: submission.txId, historyType: submission.historyType, indexed: 1 });
    });

    test('engine load failure: the worker closes, and the next call starts a new worker', async ({ page, browser }, testInfo) => {
      const wallet = await loadWallet();
      // This worker ends by itself: observe it without a DevTools session, which would keep it (see worker-cdp.ts).
      await workers.stop();
      workers = await observeSharedWorkers(browser, { attach: false });
      // The worker's engine chunk, in both the development server and a production build.
      const failing = await workers.failRequests('*midnight-worker-engine-host-*', 1);
      await restore(page, wallet, { engineFailureExpected: true });
      await expect.poll(() => streamError(page), { timeout: 60_000 }).toBe('MidnightWorkerStartupError [midnight-worker-startup-failed]');
      expect(failing.failed()).toHaveLength(1);
      const first = workers.all();
      expect(first).toHaveLength(1);
      // The worker that could not load its engine closes.
      await workers.waitForClosed(first[0]!.targetId, 30_000);
      // Observing again is the next call: a new worker loads the engine and the account syncs.
      await page.locator('#rewatch').click();
      const next = await workers.waitForWorker(60_000, first.map(item => item.targetId));
      await waitForRecovered(page, wallet, 300_000);
      expect(failing.passed().length).toBeGreaterThan(0);
      await attach(testInfo, 'worker-engine-load-failure', { failedRequests: failing.failed().length, firstWorkerClosed: true, newWorker: next.title, workers: workers.all().map(({ closed }) => ({ closed })) });
    });

    test('Interrupted submit: the SharedWorker closed right after the submit request: MidnightSubmitInterruptedError, Pending row kept, 0 resubmissions', async ({ page }, testInfo) => {
      const wallet = await loadWallet();
      // Ask the page to record how each submitMidnightTx promise settles (names and codes only), so the error is
      // shown to arrive through Result: the tracker catches a rejected promise the same way.
      await page.addInitScript(() => { (window as { __laceSubmitBoundary?: unknown }).__laceSubmitBoundary = []; });
      await restore(page, wallet);
      await waitForSynced(page, wallet, 300_000);
      await ensureSpendable(page, wallet);
      const engine = await workers.waitForWorker(60_000);
      // A fresh local chain first needs a DUST registration, which is a submission too: count from here.
      const framesBefore = workers.all().find(item => item.targetId === engine.targetId)!.submitFrames;
      // Control: an ordinary submission reaches the node once and the indexer lists it.
      const control = await transferOwn(page, wallet, 180_000);
      expect(control).toMatchObject({ stage: 'confirmed', sdk: 'returned' });
      expect(workers.all().find(item => item.targetId === engine.targetId)!.submitFrames - framesBefore).toBe(1);
      // Prepare a second transfer, and pause the worker at its broadcast call before anything is sent.
      await page.locator('#outputs').fill(JSON.stringify([{ to: wallet.address, tokenId: (await balances(page)).nightTokenId, amount: '1' }]));
      await page.locator('#build').click();
      await waitForOperation(page, () => page.locator('#sign').isEnabled(), 120_000, 'The second transfer must build');
      await page.locator('#sign').click(); await approve(page);
      await prove(page);
      const { paused } = await workers.pauseAt(engine.targetId, BROADCAST_ANCHOR);
      await page.locator('#submit').click(); await approve(page);
      await Promise.race([paused, new Promise((_, reject) => setTimeout(() => reject(new Error('The worker did not reach its broadcast call within 60 s')), 60_000))]);
      // The page handed the transaction to the worker; close the worker now, through the DevTools Protocol,
      // without letting the paused task broadcast.
      await workers.closePaused(engine.targetId);
      await workers.waitForClosed(engine.targetId, 15_000);
      await expect.poll(async () => (await record(page)).stage, { timeout: 60_000 }).toBe('interrupted');
      const interrupted = await record(page);
      expect(interrupted).toMatchObject({ stage: 'interrupted', sdk: 'error', errorCode: 'midnight-submit-interrupted' });
      // Through Result: submitMidnightTx's promise fulfilled with an Err holding MidnightSubmitInterruptedError, and
      // no submission's promise rejected. The control fulfilled with an Ok.
      const boundary = await submitBoundary(page);
      expect(boundary.filter(entry => entry.settled === 'rejected'), 'submitMidnightTx must not reject; its errors come through Result').toEqual([]);
      expect(boundary.slice(-2)).toEqual([
        { settled: 'fulfilled', isErr: false },
        { settled: 'fulfilled', isErr: true, errorName: 'MidnightSubmitInterruptedError', errorCode: 'midnight-submit-interrupted', interruptedError: true },
      ]);
      expect(interrupted.activityHash).toMatch(/^[0-9a-f]{64}$/);
      expect(interrupted.activityHash).not.toBe(control.activityHash);
      // The SDK's Pending row stays, and the page offers no resubmission.
      expect((await history(page)).find(row => row.activityId === interrupted.activityHash)?.type).toBe('Pending');
      await expect(page.locator('#submit')).toBeDisabled();
      // The next call starts a new worker; give the chain time to include anything sent.
      await page.locator('#rewatch').click();
      const next = await workers.waitForWorker(60_000, [engine.targetId]);
      await waitForRecovered(page, wallet, 300_000);
      const blocks = await waitForBlocks(5, 120_000);
      // 0 resubmissions, from the chain: the indexer lists the control and not the interrupted hash, the
      // node's pool is empty, and no worker sent a second submission.
      const indexed = { control: await indexedTransactions(control.activityHash!), interrupted: await indexedTransactions(interrupted.activityHash!) };
      expect(indexed).toEqual({ control: 1, interrupted: 0 });
      expect(await nodePendingExtrinsics()).toBe(0);
      const frames = workers.all().map(({ targetId, submitFrames, closed }) => targetId === engine.targetId
        ? { worker: 'closed engine worker', submitFrames: submitFrames - framesBefore, closed }
        : { worker: 'new worker', submitFrames, closed });
      expect(frames.reduce((sum, item) => sum + item.submitFrames, 0)).toBe(1);
      expect((await history(page)).find(row => row.activityId === interrupted.activityHash)?.type).toBe('Pending');
      expect((await record(page)).stage).toBe('interrupted');
      await attach(testInfo, 'worker-sc2', {
        control: { activityHash: control.activityHash, stage: control.stage }, interrupted, pendingRowKept: true,
        indexer: indexed, nodePendingExtrinsics: 0, blocksWaited: blocks, submitFramesBeforeControl: framesBefore, submitFrames: frames, newWorker: next.title, bestBlock: await nodeBlockNumber(),
        submitBoundary: boundary,
      });
    });
  });
});

// No other test loads the production build's Cardano route. Remote requests are refused.
test('production build: the Cardano route loads', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'preview', 'The production preview server only.');
  const pageErrors: string[] = [];
  const refused: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(baseURL!).origin) { refused.push(url.origin); return route.abort(); }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.locator('#out')).toContainText('Lace initialized', { timeout: 60_000 });
  await expect(page.getByRole('link', { name: 'Midnight developer wallet' })).toHaveAttribute('href', '/midnight');
  await expect(page.locator('#custody h2')).toContainText('Cardano custody account');
  expect(pageErrors).toEqual([]);
  await attach(testInfo, 'cardano-route', { refusedOrigins: [...new Set(refused)], pageErrors: pageErrors.length });
});

