import assert from "node:assert/strict";
import { test } from "node:test";
import { custodyBalances, describeCustodyState, fingerprint, formatAda, grantStatus } from "../src/custody/custody-view.ts";
import { devKeyFromSecret, keyHashOf, verifyHashSignature } from "../src/custody/dev-key.ts";
import { preprodEpochOf, preprodSlotAt, preprodSlotStart } from "../src/custody/preprod-time.ts";

const DEVICE = "0e2eb8b05c17851fe132bf308e9bc712ef13191d3899c06b926780e1";
const AGENT = "ab".repeat(28);
const NOW = Date.UTC(2026, 9, 7);
const utxo = (coins, extra = {}) => [{ txId: "c".repeat(64), index: 0 }, { address: "addr_test1x", value: { coins }, ...extra }];
const grant = (scope) => ({
  slot: 0n,
  grantee: AGENT,
  scope: { asset: { policyId: "", assetName: "" }, perCallCap: 4_000_000n, cap: 6_000_000n, lovelacePerCallCap: 0n, lovelaceCap: 0n, expiresAt: BigInt(NOW + 1000), recipients: [], ...scope },
});
const live = {
  status: "live",
  controlUtxo: utxo(2_000_000n),
  lockedLovelace: 2_000_000n,
  currentDeviceListed: true,
  state: { devices: [DEVICE], grants: [grant({})], grantGeneration: 0n },
  fundUtxos: [utxo(7_000_000n), utxo(3_000_000n)],
  strandedUtxos: [utxo(1_500_000n, { datumHash: "d".repeat(64) })],
  withdrawableRewards: 250_000n,
};

test("keeps spendable, locked and stranded lovelace apart", () => {
  assert.deepEqual(custodyBalances(live), { spendable: 10_000_000n, locked: 2_000_000n, stranded: 1_500_000n, rewards: 250_000n });
  assert.equal(custodyBalances({ ...live, status: "notCreated" }).locked, 0n);
});

test("describes devices, grants and balances", () => {
  const text = describeCustodyState(live, { now: NOW, deviceKeyHash: DEVICE, address: "addr_test1x" });
  assert.match(text, /^Status: live$/m);
  assert.match(text, /Spendable: 10\.000000 ADA in 2 UTxO\(s\)/);
  assert.match(text, /Locked: 2\.000000 ADA/);
  assert.match(text, /0e2eb8b0…926780e1 \(this device\)/);
  assert.match(text, /slot 0 \[effective\] grantee abababab…abababab: 4000000 lovelace per spend, 6000000 remaining/);
  assert.equal(describeCustodyState(undefined, { now: NOW }), "Custody account: waiting for the first sync");
});

test("grant status follows expiry and the remaining caps", () => {
  assert.equal(grantStatus(grant({}), NOW), "effective");
  assert.equal(grantStatus(grant({ expiresAt: BigInt(NOW) }), NOW), "expired");
  assert.equal(grantStatus(grant({ cap: 0n }), NOW), "exhausted");
  const token = { policyId: "aa".repeat(28), assetName: "4e49474854" };
  assert.equal(grantStatus(grant({ asset: token, lovelaceCap: 0n }), NOW), "exhausted");
  assert.equal(grantStatus(grant({ asset: token, lovelaceCap: 1n }), NOW), "effective");
});

test("formats lovelace and fingerprints as the signer shows them", () => {
  assert.equal(formatAda(1_127_393n), "1.127393 ADA");
  assert.equal(formatAda(-5n), "-0.000005 ADA");
  assert.equal(fingerprint(DEVICE), "0e2eb8b0…926780e1");
});

test("development keys sign transaction body hashes that verify", () => {
  const key = devKeyFromSecret(new Uint8Array(32).fill(7));
  const bodyHash = "5a".repeat(32);
  const signature = key.signHash(bodyHash);
  assert.equal(key.keyHash, keyHashOf(key.publicKey));
  assert.match(key.keyHash, /^[0-9a-f]{56}$/);
  assert.equal(verifyHashSignature(key.publicKey, bodyHash, signature), true);
  assert.equal(verifyHashSignature(key.publicKey, "5b".repeat(32), signature), false);
  assert.throws(() => key.signHash("5a"), /32-byte/);
});

test("Preprod slots follow the one-second era after Byron", () => {
  // The live Preprod tip read at 2026-10-07T20:53:08Z was slot 135723184, a block four seconds earlier.
  assert.equal(preprodSlotAt(Date.parse("2026-10-07T20:53:08Z")), 135_723_188);
  assert.equal(preprodSlotStart(135_723_188), Date.parse("2026-10-07T20:53:08Z"));
  assert.equal(preprodSlotAt(Date.parse("2022-06-21T00:00:00Z")), 86_400);
  assert.equal(preprodEpochOf(86_400), 4);
  assert.equal(preprodEpochOf(135_723_188), 317);
});
