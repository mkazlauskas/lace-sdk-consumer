import type { Page } from '@playwright/test';

// The reset check (lace-platform#2939): building reserves the NIGHT a transfer spends and the DUST that pays its fee,
// and a sync reset must free both. The page renders `observeMidnightBalances` with bigints as strings.

/** The balance fields that show a reservation. */
export type ReservationBalances = { night: { available: string; pending: string }; dust: { balance: string; available: string } };

// BigInt('') is 0n, so only digits count as an amount.
function amount(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error('Not an amount');
  return BigInt(value);
}

/** Nothing reserved: no pending NIGHT, and all generated DUST spendable. */
export function nothingReserved({ night, dust }: ReservationBalances): boolean {
  try { return amount(night.pending) === 0n && amount(dust.available) === amount(dust.balance); }
  catch { return false; }
}
/** A build's reservation: less NIGHT available than before it, and DUST held by the unsent transaction. */
export function heldByBuild({ night, dust }: ReservationBalances, availableBefore: bigint): boolean {
  try { return amount(night.available) < availableBefore && amount(dust.available) < amount(dust.balance); }
  catch { return false; }
}
/** Freed: the NIGHT available before the build, nothing pending, and positive DUST all spendable. */
export function freedAfterReset(state: ReservationBalances, availableBefore: bigint): boolean {
  try { return amount(state.night.available) === availableBefore && nothingReserved(state) && amount(state.dust.available) > 0n; }
  catch { return false; }
}

// A reset clears the account's history in the page before the new engine syncs it again, so an emptied history
// tells that this reset happened, rather than accepting the balances of the engine it replaced.
export async function watchForReset(page: Page) {
  await page.evaluate(() => {
    const target = document.getElementById('history')!;
    const seen = () => { if (target.textContent === '[]') (window as unknown as { __resetSeen?: boolean }).__resetSeen = true; };
    new MutationObserver(seen).observe(target, { childList: true, characterData: true, subtree: true });
  });
}
export function resetSeen(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __resetSeen?: boolean }).__resetSeen === true);
}

// The account's sync status records `lastSuccessfulSync` only when every sync operation completed, so a later one
// with nothing pending tells that the engine after the reset finished a sync.
export function lastSuccessfulSync(page: Page): Promise<number> {
  return page.evaluate(() => { try { return JSON.parse(document.getElementById('sync')?.textContent ?? 'null')?.lastSuccessfulSync ?? 0; } catch { return 0; } });
}
export function syncedSince(page: Page, mark: number): Promise<boolean> {
  return page.evaluate(mark => {
    try { const sync = JSON.parse(document.getElementById('sync')?.textContent ?? 'null'); return sync?.lastSuccessfulSync > mark && !sync.pendingSync; }
    catch { return false; }
  }, mark);
}
