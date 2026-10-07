import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAdaAmount, selectAccountAddress, selectAccountUtxos } from "../src/accounts.ts";

const custody = { address: "addr_test1x-custody", accountId: "custody-0-1" };
const passkey = { address: "addr_test1q-passkey", accountId: "passkey-0-1" };

test("reads the passkey account's address by id, whichever account syncs first", () => {
  assert.equal(selectAccountAddress([custody, passkey], "passkey-0-1"), passkey.address);
  assert.equal(selectAccountAddress([custody, passkey], "custody-0-1"), custody.address);
  assert.equal(selectAccountAddress([custody], "passkey-0-1"), undefined);
  assert.equal(selectAccountAddress([custody, passkey], undefined), undefined);
});

test("never hands one account's UTxOs to another account's builder", () => {
  const utxos = { "passkey-0-1": ["p"], "custody-0-1": ["c"] };
  assert.deepEqual(selectAccountUtxos(utxos, "passkey-0-1"), ["p"]);
  assert.deepEqual(selectAccountUtxos(utxos, "other-0-1"), []);
  assert.deepEqual(selectAccountUtxos(utxos, undefined), []);
});

test("parses ADA amounts to lovelace exactly", () => {
  assert.equal(parseAdaAmount("10"), 10_000_000n);
  assert.equal(parseAdaAmount("1.23"), 1_230_000n);
  assert.equal(parseAdaAmount(" 0.000001 "), 1n);
  for (const text of ["", "0", "-1", "1.0000001", "1e6", "abc"]) {
    assert.throws(() => parseAdaAmount(text), /Invalid ADA amount|must be positive/);
  }
});
