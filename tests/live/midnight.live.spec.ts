import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { parseTestWallet, canSpend, waitForPublicReady, type TestWallet, type PublicBalances } from './wallet-input';
import { installStartupDiagnostics } from './startup-diagnostics';
import { observeProvingRelay, readPublicProvingState, waitForProving } from './proving-diagnostics';
import { liveProver, preflightLocalProver } from './prover-config';
import { readPublicSync } from './public-sync';
import { freedAfterReset, heldByBuild, lastSuccessfulSync, nothingReserved, resetSeen, syncedSince, watchForReset, type ReservationBalances } from './reservations';

// Live execution requires explicit authorization; wallet input stays private.
const enabled = process.env.MIDNIGHT_LIVE === 'preview' && !!process.env.MIDNIGHT_TEST_WALLET_FILE;
const diagnostics = new Map<Page, Awaited<ReturnType<typeof installStartupDiagnostics>>>();
test.beforeEach(async ({ page }) => {
  if (enabled && process.env.MIDNIGHT_LIVE_DIAGNOSTICS === 'startup') {
    if (process.env.MIDNIGHT_LIVE_REGISTER || process.env.MIDNIGHT_LIVE_TRANSFER) throw new Error('Startup diagnostics require a read-only run with transaction opt-ins unset.');
    const diagnostic = await installStartupDiagnostics(page);
    diagnostics.set(page, diagnostic);
    await page.goto('/midnight');
    await expect(page.locator('#restore-form')).toBeVisible();
    await diagnostic.armBalanceObserver();
  }
});
test.afterEach(async ({ context }, testInfo) => {
  for (const [page, diagnostic] of diagnostics) {
    await diagnostic.stop();
    await testInfo.attach('preview-startup-diagnostic', { body: JSON.stringify(diagnostic.snapshot()), contentType: 'application/json' });
    diagnostics.delete(page);
  }
  for (const [index, page] of context.pages().entries()) {
    // Fixed public stages survive early restore failures too; no DOM dump.
    const observation = await page.evaluate(() => {
      try {
        const value = JSON.parse(document.getElementById('initialization')?.textContent ?? '{}');
        const stages = ['idle', 'restore-started', 'restore-failed', 'waiting-for-engine', 'state-observed', 'synchronized', 'sync-failed', 'balance-stream-failed'];
        return { stage: stages.includes(value.stage) ? value.stage : 'not-observed', restoreReturned: value.restoreReturned === true, balances: value.balances === true, addresses: value.addresses === true, publicKeys: value.publicKeys === true, syncFailed: value.syncFailed === true, balanceStreamFailed: value.balanceStreamFailed === true };
      } catch { return { stage: 'not-observed' }; }
    }).catch(() => ({ stage: 'page-unavailable' }));
    await testInfo.attach(`preview-startup-${index}`, { body: JSON.stringify(observation), contentType: 'application/json' });
    await page.evaluate(() => {
      for (const id of ['phrase', 'password']) { const input = document.getElementById(id) as HTMLInputElement | null; if (input) input.value = ''; }
    }).catch(() => {});
  }
});

test.skip(!enabled, 'Requires explicit MIDNIGHT_LIVE=preview and a disposable MIDNIGHT_TEST_WALLET_FILE.');

async function loadWallet(): Promise<TestWallet> {
  try { return parseTestWallet(JSON.parse(await readFile(process.env.MIDNIGHT_TEST_WALLET_FILE!, 'utf8'))); }
  catch { throw new Error('Invalid disposable wallet input; requires Preview, expected address, mnemonicWords and passwordHex or password.'); }
}
async function waitForState(page: Page, ready: () => Promise<boolean>, timeout: number, message: string) {
  const began = Date.now(), initialTestTimeout = test.info().timeout;
  await waitForPublicReady(async () => {
    const before = await page.evaluate(readPublicSync);
    const matched = await ready();
    const after = await page.evaluate(readPublicSync);
    return { ...after, stage: ['restore-failed', 'sync-failed', 'balance-stream-failed'].includes(before.stage) ? before.stage : after.stage, ready: matched };
  }, timeout, message, undefined, () => {
    // Keep the test-level bound on other work, but don't spend its budget on
    // an advancing sync. Live runs also disable the fixed global deadline.
    if (initialTestTimeout > 0) test.setTimeout(initialTestTimeout + Date.now() - began + timeout);
  });
}
async function restore(page: Page, wallet: TestWallet, verifySuppliedAddress = true) {
  const prover = liveProver(process.env.MIDNIGHT_LIVE_PROVER);
  await page.goto('/midnight');
  await expect(page.locator('#restore-form')).toBeVisible();
  // Catch inside the browser: library exceptions must never serialize secret input.
  const injected = await page.evaluate(({ mnemonicWords, password, accountIndex, prover }) => {
    try {
      (document.getElementById('phrase') as HTMLTextAreaElement).value = mnemonicWords.join(' ');
      (document.getElementById('password') as HTMLInputElement).value = password;
      (document.getElementById('index') as HTMLInputElement).value = String(accountIndex);
      (document.getElementById('network') as HTMLSelectElement).value = 'preview';
      (document.getElementById('prover') as HTMLSelectElement).value = prover;
      (document.getElementById('restore-form') as HTMLFormElement).requestSubmit();
      return true;
    } catch { return false; }
    finally {
      (document.getElementById('phrase') as HTMLTextAreaElement).value = '';
      (document.getElementById('password') as HTMLInputElement).value = '';
      mnemonicWords.fill('');
    }
  }, { ...wallet, prover });
  expect(injected).toBe(true);
  // Boolean assertions cannot disclose DOM field values on failure.
  expect(await page.evaluate(() => ({
    phraseCleared: (document.getElementById('phrase') as HTMLTextAreaElement).value === '',
    passwordCleared: (document.getElementById('password') as HTMLInputElement).value === '',
  }))).toEqual({ phraseCleared: true, passwordCleared: true });
  await waitForState(page, () => page.locator('#wallet-controls').isVisible(), 240_000, 'Restore must return wallet controls.');
  await waitForState(page, async () => {
    try { const address = (await balances(page)).address.unshielded; return verifySuppliedAddress ? address === wallet.address : address.startsWith('mn_addr_preview'); } catch { return false; }
  }, 240_000, 'Derived Preview address must match the supplied public address before any signing.');
}
async function balances(page: Page): Promise<PublicBalances & ReservationBalances & { synced: { shielded: boolean } }> {
  return JSON.parse((await page.locator('#balances').textContent())!);
}
async function approve(page: Page) {
  await expect(page.locator('#confirmation')).toBeVisible();
  await expect(page.locator('#review-summary')).toContainText('preview');
  await page.locator('#approve').click();
}
async function proveAndSubmit(page: Page, testInfo: TestInfo) {
  await expect(page.locator('#prove')).toBeEnabled({ timeout: 120_000 });
  const relay = observeProvingRelay(page);
  try {
    await page.locator('#prove').click(); await approve(page);
    await waitForProving(() => page.evaluate(readPublicProvingState), 600_000);
  } finally {
    const publicState = await page.evaluate(readPublicProvingState).catch(() => ({ phase: 'page-unavailable' }));
    await testInfo.attach('preview-proving-diagnostic', { body: JSON.stringify({ publicState, relay: await relay.stop() }), contentType: 'application/json' });
  }
  await page.locator('#submit').click(); await approve(page);
  // The app records the activity hash before broadcast; history is the authority for the outcome.
  // An SDK timeout or error leaves the record uncertain, so keep watching history for the hash.
  // The panel lists every submission of the session, newest first.
  const record = async () => { try { return JSON.parse((await page.locator('#submission').textContent())!)[0] ?? {}; } catch { return {}; } };
  try {
    await expect.poll(async () => (await record()).stage ?? 'not-observed', { timeout: 30_000, message: 'Approval must record the submission and its hash.' }).not.toMatch(/^(idle|not-observed)$/);
    if ((await record()).stage === 'failed') throw new Error('Submission failed before broadcast.');
    await expect.poll(async () => (await record()).stage, { timeout: 900_000, message: 'History must confirm this exact proved transaction; an SDK result alone is insufficient.' }).toMatch(/^(confirmed|failed-on-chain)$/);
  } finally {
    await testInfo.attach('preview-submission', { body: JSON.stringify({ submission: await record(), status: await page.locator('#status').textContent() }), contentType: 'application/json' });
  }
  const submission = await record();
  if (submission.stage !== 'confirmed' || !submission.activityHash) throw new Error('History reported the submitted transaction as failed.');
  await expect.poll(async () => {
    const rows = JSON.parse((await page.locator('#history').textContent())!);
    return rows.find((row: { activityId: string; type: string }) => row.activityId === submission.activityHash)?.type ?? 'Not observed';
  }, { timeout: 60_000 }).toMatch(/^(Self|Send|Receive)$/);
  // Controls stay locked until the SDK call itself settles (bounded by its submit timeout).
  await expect.poll(async () => (await record()).sdk, { timeout: 360_000, message: 'The SDK submission call must settle.' }).not.toBe('pending');
  const rows = JSON.parse((await page.locator('#history').textContent())!);
  const index = rows.findIndex((row: { activityId: string }) => row.activityId === submission.activityHash);
  await page.locator('summary', { hasText: 'History and token display names' }).click();
  await page.locator('#activity').selectOption(String(index));
  await page.locator('#details').click();
  await expect(page.locator('#activity-details')).toContainText(submission.activityHash, { timeout: 120_000 });
  await page.locator('summary', { hasText: 'History and token display names' }).click();

}
test('packaged browser WASM: indexed restore, real state and explicitly enabled own-wallet transactions', async ({ page, context }, testInfo) => {
  const prover = liveProver(process.env.MIDNIGHT_LIVE_PROVER);
  if (prover === 'local') await preflightLocalProver();
  const wallet = await loadWallet();
  await restore(page, wallet);
  const addresses = JSON.parse((await page.locator('#addresses').textContent())!);
  const keys = await page.locator('#keys').textContent();
  // Transaction runs keep one restored session to avoid redundant synchronization.
  if (!process.env.MIDNIGHT_LIVE_REGISTER && !process.env.MIDNIGHT_LIVE_TRANSFER) {
    const second = await context.newPage(); await restore(second, wallet);
    expect(JSON.parse((await second.locator('#addresses').textContent())!)).toEqual(addresses);
    expect(await second.locator('#keys').textContent()).toEqual(keys);
    await second.locator('#disconnect').click(); await second.close();
    // Stopping the second consumer must not clear the first consumer's public state.
    expect(JSON.parse((await page.locator('#addresses').textContent())!)).toEqual(addresses);
  }
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  await waitForState(page, async () => {
    try { const state = await balances(page); return state.synced.unshielded && state.synced.dust; } catch { return false; }
  }, 600_000, 'Read-only acceptance requires synchronized public balances, including a valid zero.');
  const before = { balances: await balances(page), tokens: await page.locator('#tokens').textContent(), dust: await page.locator('#dust').textContent(), sync: await page.locator('#sync').textContent() };
  try {
  // No automatic restore→sign/register/submit. Each transaction needs an explicit environment opt-in,
  // then the same visible application confirmation for every sensitive stage.
  if (process.env.MIDNIGHT_LIVE_REGISTER === 'own') {
    await waitForState(page, async () => canSpend(await balances(page), wallet.address, false), 600_000, 'Own registration requires actual synchronized NIGHT funding.');
    await page.locator('#kind').selectOption('dust');
    await page.locator('#build').click(); await approve(page); await proveAndSubmit(page, testInfo);
    await expect.poll(async () => {
      try { return BigInt(JSON.parse((await page.locator('#dust').textContent())!).generated ?? '0') > 0n; } catch { return false; }
    }, { timeout: 600_000 }).toBe(true);
  }
  if (process.env.MIDNIGHT_LIVE_TRANSFER === 'own') {
    await waitForState(page, async () => canSpend(await balances(page), wallet.address, true), 600_000, 'Own transfer requires actual NIGHT and matured spendable DUST.');
    const state = await balances(page);
    const recipient = wallet.address;
    const tokenId = state.nightTokenId;
    if (!tokenId || !tokenId.startsWith('unshielded-preview')) throw new Error('Expected Preview NIGHT token unavailable.');
    await page.locator('#kind').selectOption('unshielded');
    // Only this wallet's own address, exactly one smallest unit.
    await page.locator('#outputs').fill(JSON.stringify([{ to: recipient, tokenId, amount: '1' }]));
    await page.locator('#estimate').click(); await expect(page.locator('#operation')).toContainText('unsignedEstimate', { timeout: 120_000 });
    await page.locator('#build').click(); await expect(page.locator('#sign')).toBeEnabled({ timeout: 120_000 });
    await page.locator('#sign').click(); await approve(page); await proveAndSubmit(page, testInfo);
  }
  } finally {
  // Public observations only; no phrase, password, wallet entity or raw SDK state.
  await testInfo.attach('preview-public-observations', { body: JSON.stringify({ before, after: { balances: await balances(page), tokens: await page.locator('#tokens').textContent(), dust: await page.locator('#dust').textContent(), history: await page.locator('#history').textContent(), activityDetails: await page.locator('#activity-details').textContent(), operation: await page.locator('#operation').textContent(), progress: await page.evaluate(readPublicProvingState) } }, null, 2), contentType: 'application/json' });
  await page.locator('#disconnect').click();
  }
});

test('packaged same-page instances keep identical account IDs isolated across stop', async ({ page }) => {
  const wallet = await loadWallet();
  await page.goto('/midnight');
  await expect(page.locator('#restore-form')).toBeVisible();
  // Both instances share one JS module registry, unlike two pages. No signing or submission.
  const outcome = await page.evaluate(async ({ words, password, accountIndex, address }) => {
    const path = '/src/midnight/runtime.ts';
    const runtime = await import(/* @vite-ignore */ path);
    const firstPassword = new TextEncoder().encode(password), secondPassword = firstPassword.slice();
    let first: Awaited<ReturnType<typeof runtime.restore>> | undefined;
    let second: Awaited<ReturnType<typeof runtime.restore>> | undefined;
    try {
      const config = { network: 'preview', index: accountIndex, nodeAddress: '', indexerAddress: '', prover: 'local' };
      first = await runtime.restore(words, firstPassword, config);
      second = await runtime.restore(words, secondPassword, config);
      const account = first.entity.accounts.filter((a: { blockchainNetworkId: string }) => a.blockchainNetworkId === 'midnight-preview').at(-1);
      if (!account) return { ok: false, reason: 'No Preview account' };
      const read = (session: typeof first) => new Promise<{ address: string }>((resolve, reject) => {
        let sub: { unsubscribe(): void } | undefined;
        const timer = setTimeout(() => { sub?.unsubscribe(); reject(new Error('State timeout')); }, 240_000);
        sub = session!.sdk.observeMidnightBalances(session!.wallet, { accountId: account.accountId }).subscribe({
          next: (state: { address: { unshielded: string } }) => {
            if (state.address.unshielded) { clearTimeout(timer); queueMicrotask(() => sub?.unsubscribe()); resolve({ address: state.address.unshielded }); }
          },
          error: () => { clearTimeout(timer); reject(new Error('Public state unavailable')); },
        });
      });
      const a = await read(first), b = await read(second);
      runtime.stopSession(first); first = undefined;
      const survivor = await read(second);
      return { ok: a.address === address && a.address === b.address && b.address === survivor.address };
    } catch { return { ok: false, reason: 'Same-page live restore/state prerequisite failed' }; }
    finally {
      if (first) runtime.stopSession(first); if (second) runtime.stopSession(second);
      firstPassword.fill(0); secondPassword.fill(0); words.fill('');
    }
  }, { words: wallet.mnemonicWords, password: wallet.password, accountIndex: wallet.accountIndex, address: wallet.address });
  expect(outcome.ok, outcome.reason).toBe(true);
});

// Nonzero derivation is explicitly read-only and is not treated as a funded account.
test('nonzero account restoration is deterministic without spending', async ({ page, context }) => {
  const supplied = await loadWallet();
  const wallet = { ...supplied, accountIndex: supplied.accountIndex === 7 ? 8 : 7 };
  await restore(page, wallet, false);
  const address = (await balances(page)).address.unshielded;
  const keys = await page.locator('#keys').textContent();
  expect(address).not.toBe(supplied.address);
  const second = await context.newPage();
  await restore(second, wallet, false);
  expect((await balances(second)).address.unshielded).toBe(address);
  expect(await second.locator('#keys').textContent()).toBe(keys);
  await page.locator('#disconnect').click(); await second.locator('#disconnect').click();
});

// lace-platform#2939. Only with MIDNIGHT_LIVE_RESET=1, after any transaction run has confirmed, so that no other
// transaction holds coins. Nothing is signed, proved or submitted.
test('reset frees the NIGHT and the DUST fee that a built transfer reserved', async ({ page }, testInfo) => {
  test.skip(process.env.MIDNIGHT_LIVE_RESET !== '1', 'Requires MIDNIGHT_LIVE_RESET=1.');
  if (process.env.MIDNIGHT_LIVE_REGISTER || process.env.MIDNIGHT_LIVE_TRANSFER) throw new Error('The reset check requires transaction opt-ins unset.');
  const wallet = await loadWallet();
  const seen: Partial<Record<'before' | 'built' | 'afterReset', ReservationBalances>> = {};
  // Each wait records the last state it read, so the attachment shows the values it compared.
  const read = async (name: keyof typeof seen) => { const state = await balances(page); seen[name] = { night: state.night, dust: state.dust }; return state; };
  const strictlySynced = async () => { try { const { synced } = await balances(page); return synced.unshielded && synced.shielded && synced.dust; } catch { return false; } };
  await restore(page, wallet);
  try {
    await waitForState(page, async () => await strictlySynced() && canSpend(await balances(page), wallet.address, true), 600_000, 'The reset check requires a strict sync, actual NIGHT and matured spendable DUST.');
    await waitForState(page, async () => nothingReserved(await read('before')), 120_000, 'Nothing may be reserved before the build: another transaction holds coins.');
    const availableBefore = BigInt(seen.before!.night.available);
    await page.locator('#kind').selectOption('unshielded');
    await page.locator('#outputs').fill(JSON.stringify([{ to: wallet.address, tokenId: (await balances(page)).nightTokenId, amount: '1' }]));
    await page.locator('#estimate').click(); await expect(page.locator('#operation')).toContainText('unsignedEstimate', { timeout: 120_000 });
    await page.locator('#build').click(); await expect(page.locator('#sign')).toBeEnabled({ timeout: 120_000 });
    // Left unsigned: the engine's reservation is what the reset must free.
    await waitForState(page, async () => heldByBuild(await read('built'), availableBefore), 120_000, 'The build must show its reservation; without it this check is invalid.');
    expect(JSON.parse((await page.locator('#history').textContent())!).length, 'The reset signal needs a non-empty history before the reset.').toBeGreaterThan(0);
    const syncMark = await lastSuccessfulSync(page);
    await watchForReset(page);
    await page.locator('#reset').click();
    await expect(page.locator('#status')).toContainText('Reset requested');
    await expect.poll(() => resetSeen(page), { timeout: 60_000, message: 'The page must observe the reset.' }).toBe(true);
    await waitForState(page, async () => await syncedSince(page, syncMark) && await strictlySynced(), 600_000, 'The reset account must complete a new strict sync.');
    await waitForState(page, async () => { try { return freedAfterReset(await read('afterReset'), availableBefore); } catch { return false; } }, 120_000,
      'Once the reset account has synced, the NIGHT and the DUST the build reserved must be free.');
  } finally {
    await testInfo.attach('preview-reset-reservations', { body: JSON.stringify(seen, null, 2), contentType: 'application/json' });
    await page.locator('#disconnect').click();
  }
});
