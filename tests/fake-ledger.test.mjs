import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { Cardano, Serialization } from "@input-output-hk/lace-sdk/cardano";
import { FakeLedger } from "./e2e/fake-ledger.ts";
import { devKeyFromSecret } from "../src/custody/dev-key.ts";

// The fake Preprod ledger the browser suite submits to must refuse what a
// node refuses, or "every submission applied" proves nothing.

const key = devKeyFromSecret(new Uint8Array(32).fill(3));
const address = Cardano.EnterpriseAddress.fromCredentials(Cardano.NetworkId.Testnet, { type: Cardano.CredentialType.KeyHash, hash: key.keyHash })
  .toAddress()
  .toBech32();
const FEE = 250_000n;

let ledger;
let funded;
let collateral;

beforeEach(() => {
  ledger = new FakeLedger(() => Date.parse("2026-10-08T06:00:00Z"));
  funded = { txId: ledger.fund(address, 10_000_000n), index: 0 };
  collateral = { txId: ledger.fund(address, 5_000_000n), index: 0 };
});

/** A transaction over `body`, signed by the funded key unless `sign` is false. */
const build = (body, { sign = true, redeemers } = {}) => {
  const witness = { signatures: new Map(), ...(redeemers ? { redeemers } : {}) };
  const unsigned = Serialization.Transaction.fromCore({ id: "0".repeat(64), body, witness });
  const signatures = sign ? new Map([[key.publicKey, key.signHash(unsigned.getId())]]) : new Map();
  return Serialization.Transaction.fromCore({ id: unsigned.getId(), body: unsigned.body().toCore(), witness: { ...witness, signatures } }).toCbor();
};

const transfer = ({ fee = FEE, outputs } = {}) => ({
  inputs: [funded],
  outputs: outputs ?? [{ address, value: { coins: 10_000_000n - fee } }],
  fee,
});

const redeemer = (memory, steps) => [{ purpose: Cardano.RedeemerPurpose.spend, index: 0, data: 0n, executionUnits: { memory, steps } }];

/** A transaction that runs a script, with collateral from the funded key. */
const scripted = ({ fee = FEE, totalCollateral, collateralReturn = 5_000_000n - 400_000n } = {}) => ({
  ...transfer({ fee }),
  collaterals: [collateral],
  collateralReturn: { address, value: { coins: collateralReturn } },
  totalCollateral: totalCollateral ?? 5_000_000n - collateralReturn,
});

const refusal = (name) => (error) => {
  assert.match(error.message, new RegExp(`^${name}`));
  return true;
};

test("applies a signed, balanced transaction that pays the minimum fee", () => {
  const txId = ledger.submit(build(transfer()));
  assert.equal(ledger.transaction(txId).fee, FEE);
  assert.equal(ledger.lovelaceAt(address), 15_000_000n - FEE);
});

test("applies a script transaction with enough collateral", () => {
  ledger.submit(build(scripted(), { redeemers: redeemer(500_000, 200_000_000) }));
  assert.equal(ledger.lovelaceAt(address), 15_000_000n - FEE);
});

test("refuses a transaction without the input key's signature", () => {
  assert.throws(() => ledger.submit(build(transfer(), { sign: false })), refusal("MissingVKeyWitnessesUTXOW"));
});

test("refuses a transaction whose value does not balance", () => {
  assert.throws(() => ledger.submit(build(transfer({ outputs: [{ address, value: { coins: 10_000_000n } }] }))), refusal("ValueNotConservedUTxO"));
});

test("refuses a fee below the minimum, script execution included", () => {
  assert.throws(() => ledger.submit(build(transfer({ fee: 1n }))), refusal("FeeTooSmallUTxO"));
  // 168537 lovelace for the size, plus 0.0577 per memory unit and 0.0000721 per step: 247867.
  assert.throws(() => ledger.submit(build(scripted({ fee: 210_000n }), { redeemers: redeemer(1_000_000, 300_000_000) })), refusal("FeeTooSmallUTxO"));
});

test("prices the size without the is_valid flag, as the ledger does", () => {
  // The fee's CBOR width is the same for every value tried, so the size is too.
  const size = BigInt(build(transfer()).length / 2 - 1);
  const minimum = 44n * size + 155_381n;
  assert.throws(() => ledger.submit(build(transfer({ fee: minimum - 1n }))), refusal(`FeeTooSmallUTxO: fee ${minimum - 1n}, at least ${minimum}`));
  ledger.submit(build(transfer({ fee: minimum })));
});

test("refuses an output below the minimum lovelace", () => {
  const outputs = [{ address, value: { coins: 100_000n } }, { address, value: { coins: 10_000_000n - FEE - 100_000n } }];
  assert.throws(() => ledger.submit(build(transfer({ outputs }))), refusal("BabbageOutputTooSmallUTxO"));
});

test("refuses collateral that disagrees with its total or does not cover the fee", () => {
  const redeemers = redeemer(500_000, 200_000_000);
  assert.throws(() => ledger.submit(build(scripted({ totalCollateral: 300_000n }), { redeemers })), refusal("IncorrectTotalCollateralField"));
  assert.throws(() => ledger.submit(build(scripted({ collateralReturn: 4_700_000n }), { redeemers })), refusal("InsufficientCollateral"));
  assert.throws(() => ledger.submit(build({ ...transfer(), collaterals: [] }, { redeemers })), refusal("NoCollateralInputs"));
});

test("refuses execution units above the transaction limit", () => {
  assert.throws(() => ledger.submit(build(scripted({ fee: 1_900_000n }), { redeemers: redeemer(17_500_001, 1_000) })), refusal("ExUnitsTooBigUTxO"));
});

test("refuses a spent input and a validity bound in the past", () => {
  const cbor = build(transfer());
  ledger.submit(cbor);
  assert.throws(() => ledger.submit(build(transfer({ fee: FEE + 1n }))), refusal("Input"));
  const expired = { ...transfer(), inputs: [collateral], outputs: [{ address, value: { coins: 5_000_000n - FEE } }], validityInterval: { invalidHereafter: 1000 } };
  assert.throws(() => ledger.submit(build(expired)), refusal("OutsideValidityIntervalUTxO"));
});
