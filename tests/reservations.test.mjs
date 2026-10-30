import test from 'node:test';
import assert from 'node:assert/strict';
import { freedAfterReset, heldByBuild, nothingReserved } from './live/reservations.ts';

const state = (available, pending, dustBalance, dustAvailable) =>
  ({ night: { available, pending }, dust: { balance: dustBalance, available: dustAvailable } });

test('nothing is reserved only with no pending NIGHT and all generated DUST spendable', () => {
  assert.equal(nothingReserved(state('5000', '0', '900', '900')), true);
  assert.equal(nothingReserved(state('5000', '1', '900', '900')), false);
  assert.equal(nothingReserved(state('5000', '0', '900', '800')), false);
  assert.equal(nothingReserved(state('5000', 'Not observed', '900', '900')), false);
});

test('a build holds coins only when both NIGHT and DUST show it', () => {
  assert.equal(heldByBuild(state('4000', '0', '900', '800'), 5000n), true);
  // The NIGHT alone, or the DUST alone, is not the reservation of one transfer.
  assert.equal(heldByBuild(state('5000', '0', '900', '800'), 5000n), false);
  assert.equal(heldByBuild(state('4000', '0', '900', '900'), 5000n), false);
  assert.equal(heldByBuild(state('', '0', '900', '800'), 5000n), false);
});

test('freed after a reset means the NIGHT from before the build, nothing pending, positive DUST all spendable', () => {
  assert.equal(freedAfterReset(state('5000', '0', '950', '950'), 5000n), true);
  assert.equal(freedAfterReset(state('4000', '0', '950', '950'), 5000n), false);
  assert.equal(freedAfterReset(state('5000', '0', '950', '850'), 5000n), false);
  assert.equal(freedAfterReset(state('5000', '0', '0', '0'), 5000n), false);
});
