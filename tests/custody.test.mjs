import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CardanoCustodyGrantSpendError,
  CardanoCustodyOutcomeUnknownError,
  CardanoCustodyUnsupportedVersionError,
  CardanoCustodyLogicNotRegisteredError,
  CardanoCustodyLogicNotServedError,
  CardanoCustodyLogicRewardBalanceError,
  CardanoCustodyRewardBalanceChangedError,
  CardanoCustodyScriptDataHashError,
  CardanoCustodySponsorError,
  RemoteSignerError,
} from "@input-output-hk/lace-sdk/cardano";
import { custodyBalances, describeCustodyState, describeGrant, describeSponsorHealth, fingerprint, formatAda } from "../src/custody/custody-view.ts";
import { describeCustodyError } from "../src/custody/custody-errors.ts";
import { devKeyFromSecret, keyHashOf, verifyHashSignature } from "../src/custody/dev-key.ts";
import { preprodEpochOf, preprodSlotAt, preprodSlotStart } from "./e2e/preprod-time.ts";

const DEVICE = "0e2eb8b05c17851fe132bf308e9bc712ef13191d3899c06b926780e1";
const AGENT = "ab".repeat(28);
const LOGIC = "2cd68e398bdf9fbc8d257614b54403451ee722520ec785fe14f8df5a";
const LOGIC_REWARD_ACCOUNT = "stake_test17qkddr3e300el0ydy4mpfd2yqdz3aeez2g8v0p07znud7ksul9rpg";
const NOW = Date.UTC(2026, 9, 7);
const utxo = (coins, extra = {}) => [{ txId: "c".repeat(64), index: 0 }, { address: "addr_test1x", value: { coins }, ...extra }];
const grant = (scope) => ({
  slot: 0n,
  grantee: AGENT,
  generation: 0n,
  scope: { asset: { policyId: "", assetName: "" }, perCallCap: 4_000_000n, cap: 6_000_000n, lovelacePerCallCap: 0n, lovelaceCap: 0n, expiresAt: BigInt(NOW + 1000), recipients: [{}], ...scope },
});
const holdings = {
  funds: [utxo(7_000_000n), utxo(3_000_000n)],
  reserves: { own: [utxo(1_000_000n, { datum: 0n })], foreign: [] },
  grants: [{ utxo: utxo(1_300_000n), grant: grant({}), token: "token" }],
  grantLockedLovelace: 1_300_000n,
  stranded: [utxo(1_500_000n, { datumHash: "d".repeat(64) })],
  anomalies: [],
  withdrawableRewards: 250_000n,
};
const live = {
  ...holdings,
  status: "live",
  controlUtxo: utxo(3_410_000n),
  controlMinimumLovelace: 1_590_000n,
  controlHeadroomLovelace: 1_820_000n,
  currentDeviceListed: true,
  depositAddress: "addr_test1x",
  state: { logic: LOGIC, devices: [DEVICE], grantGeneration: 0n, nextSlot: 1n, revoked: [], outstanding: 1n },
};

test("keeps funds, reserves, the control output, grant UTxOs and stranded lovelace apart", () => {
  assert.deepEqual(custodyBalances(live), {
    funds: 10_000_000n,
    ownReserves: 1_000_000n,
    foreignReserves: 0n,
    control: 3_410_000n,
    controlMinimum: 1_590_000n,
    ownerFeeReserve: 1_820_000n,
    grantLocked: 1_300_000n,
    stranded: 1_500_000n,
    rewards: 250_000n,
  });
  assert.equal(custodyBalances({ ...holdings, status: "notCreated" }).control, 0n);
});

test("describes the logic, devices, grants with their statuses and the balances", () => {
  const grants = [{ ...live.grants[0], status: "live" }];
  const text = describeCustodyState(live, { deviceKeyHash: DEVICE, address: "addr_test1x", grants });
  assert.match(text, /^Status: live$/m);
  assert.match(text, new RegExp(`^Logic: ${LOGIC}$`, "m"));
  assert.match(text, /Spendable: 10\.000000 ADA in 2 UTxO\(s\)/);
  assert.match(text, /Control output: 3\.410000 ADA: 1\.590000 ADA locked for the account's life, 1\.820000 ADA owner fee reserve/);
  assert.match(text, /Grant UTxOs: 1\.300000 ADA in 1 UTxO\(s\)/);
  assert.match(text, /^Deposit address: addr_test1x$/m);
  assert.match(text, /0e2eb8b0…926780e1 \(this device\)/);
  assert.match(text, /next grant ID 1, outstanding 1, revoked IDs: none/);
  assert.match(text, /grant ID 0 \[live\] grantee abababab…abababab: 4000000 lovelace per spend, 6000000 remaining, .*1 recipient\(s\)/);
  // Before the statuses arrive, the grants still show.
  assert.match(describeCustodyState(live, {}), /grant ID 0 \[syncing\]/);
  assert.equal(describeCustodyState(undefined, {}), "Custody account: waiting for the first sync");
});

test("an account under a logic the SDK does not accept shows its balances and the logic", () => {
  const text = describeCustodyState({ ...holdings, status: "invalid", controlUtxos: [], reason: { code: "unknown-logic", logic: "ff".repeat(28) } }, {});
  assert.match(text, /^Invalid: unknown-logic \(logic f{56}, which this SDK does not accept\)$/m);
  assert.match(text, /Spendable: 10\.000000 ADA/);
  assert.doesNotMatch(text, /Grants \(/);
});

test("names no deposit address for an account that is not live", () => {
  // Even a state that carried one: deposits go only to a live account that lists this device.
  for (const status of ["notCreated", "invalid"]) {
    const text = describeCustodyState({ ...holdings, status, controlUtxos: [], reason: { code: "no-control" }, depositAddress: "addr_test1x" }, { address: "addr_test1x" });
    assert.match(text, new RegExp(`^Status: ${status}$`, "m"));
    assert.doesNotMatch(text, /Deposit address/);
  }
});

test("names a token grant's asset", () => {
  const token = grant({ asset: { policyId: "aa".repeat(28), assetName: "4e49474854" }, recipients: [] });
  assert.match(describeGrant({ grant: token, status: "exhausted" }), /\[exhausted\].* aaaa.*\.4e49474854 per spend.*any recipient/);
});

test("formats lovelace and fingerprints as the signer shows them", () => {
  assert.equal(formatAda(1_127_393n), "1.127393 ADA");
  assert.equal(formatAda(-5n), "-0.000005 ADA");
  assert.equal(fingerprint(DEVICE), "0e2eb8b0…926780e1");
});

test("describes the sponsor's health and the relay's refusals", () => {
  const healthy = describeSponsorHealth({ status: 200, body: { ok: true, network: "preprod", pool: { fee: { free: 5, leased: 1 }, collateral: { shared: true } } } });
  assert.match(healthy, /Network preprod: 5 fee UTxO\(s\) free, 1 leased, collateral shared$/);
  const unconfigured = describeSponsorHealth({ status: 503, body: { error: "relay_not_configured", detail: "The development server has no SPONSOR_API_KEY." } });
  assert.match(unconfigured, /Unavailable: HTTP 503 relay_not_configured: The development server has no SPONSOR_API_KEY\.$/);
  assert.match(describeSponsorHealth({ status: 502, body: undefined }), /Unavailable: HTTP 502$/);
  assert.match(describeSponsorHealth({ failure: "TypeError: Failed to fetch" }), /Unreachable: TypeError: Failed to fetch$/);
});

test("explains the revision 3 logic errors in the log", () => {
  const notRegistered = describeCustodyError(new CardanoCustodyLogicNotRegisteredError(LOGIC_REWARD_ACCOUNT));
  assert.match(notRegistered, /^CardanoCustodyLogicNotRegisteredError \[custody-logic-not-registered\]: The custody logic reward account stake_test1\w+ is not registered\. /);
  assert.match(notRegistered, /registered on this network, once and outside Lace/);
  const balance = describeCustodyError(new CardanoCustodyLogicRewardBalanceError(LOGIC, 1_500_000n));
  assert.match(balance, /^CardanoCustodyLogicRewardBalanceError \[custody-logic-reward-balance\]: .*holds 1500000 lovelace.*Someone paid 1\.500000 ADA into the logic's reward account\./);
  assert.match(balance, /building again does not help until the balance is gone/);
  assert.match(describeCustodyError(new CardanoCustodyLogicNotServedError("The control UTxO names logic ff")), /^CardanoCustodyLogicNotServedError \[custody-logic-not-served\]: .*names logic ff\. The fee sponsor lends no collateral/);
  assert.match(describeCustodyError(new CardanoCustodyScriptDataHashError("The body commits to the script data hash aa")), /^CardanoCustodyScriptDataHashError \[custody-script-data-hash\]: .*other cost models/);
  assert.match(describeCustodyError(new CardanoCustodyRewardBalanceChangedError()), /^CardanoCustodyRewardBalanceChangedError \[custody-reward-balance-changed\]: .*run the operation again\.$/);
});

test("explains sponsor and relay refusals and keeps structured details", () => {
  const unauthorized = describeCustodyError(new CardanoCustodySponsorError({ status: 401, code: "unauthorized", detail: "A valid API key is required" }));
  assert.match(unauthorized, /^CardanoCustodySponsorError \[unauthorized\]: Fee sponsor service answered 401 unauthorized: A valid API key is required\. .*Lace testing key .*\.env\.example/);
  const relay = describeCustodyError(new CardanoCustodySponsorError({ status: 503, code: "relay_not_configured", detail: "The development server has no SPONSOR_API_KEY." }));
  assert.match(relay, /answered 503 relay_not_configured: .*restart it\.$/);
  const rule = describeCustodyError(new CardanoCustodySponsorError({ status: 422, code: "invalid_transaction", rule: "bounded_validity", detail: "too late" }));
  assert.equal(rule, "CardanoCustodySponsorError [invalid_transaction]: Fee sponsor service answered 422 invalid_transaction (bounded_validity): too late");
  const scope = describeCustodyError(new CardanoCustodyGrantSpendError("scope", { code: "cap-exceeded", limit: 1n, outflow: 2n }));
  assert.equal(scope, 'CardanoCustodyGrantSpendError [custody-grant-spend]: Custody grant spend refused: scope {"code":"cap-exceeded","limit":"1","outflow":"2"}');
  const origin = describeCustodyError(new RemoteSignerError("custody-origin-not-allowed", "This site is not allowed"));
  assert.match(origin, /^RemoteSignerError \[custody-origin-not-allowed\]: .*only for the origins its build lists\. Run this page on an origin the signer lists/);
  assert.equal(describeCustodyError("plain"), "plain");
  assert.equal(describeCustodyError(new Error("no code")), "Error: no code");
});

test("keeps the code when a minified build renames the class, and explains a record of another contract build", () => {
  const renamed = new CardanoCustodyLogicNotServedError("The control UTxO names logic ff");
  Object.defineProperty(renamed, "name", { value: "Xc" });
  assert.match(describeCustodyError(renamed), /^Xc \[custody-logic-not-served\]: .*lends no collateral/);
  const record = describeCustodyError(new CardanoCustodyUnsupportedVersionError("0524f57b"));
  assert.match(record, /^CardanoCustodyUnsupportedVersionError \[custody-unsupported-version\]: .*another build of the custody contract.*Create a new account\.$/);
  const unknown = describeCustodyError(new CardanoCustodyOutcomeUnknownError("account", { txId: "ab".repeat(32), invalidHereafter: 1n, grantSlot: 0n }));
  assert.match(unknown, /^CardanoCustodyOutcomeUnknownError \[custody-outcome-unknown\]: .*Do not submit it again; wait for it\. Once a grant settles, Export agent policy exports its policy\.$/);
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
