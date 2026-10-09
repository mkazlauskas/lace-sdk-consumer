import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { blake2b } from "@noble/hashes/blake2.js";
import { CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH, CARDANO_CUSTODY_LOGIC_HASH, Cardano, Serialization } from "@input-output-hk/lace-sdk/cardano";
import { FakeLedger, LOGIC_REWARD_ACCOUNT, PARKED_SCRIPTS } from "./e2e/fake-ledger.ts";
import { devKeyFromSecret } from "../src/custody/dev-key.ts";

// The fake Preprod ledger the browser suite submits to must refuse what a
// node refuses, or "every submission applied" proves nothing.

const key = devKeyFromSecret(new Uint8Array(32).fill(3));
const address = Cardano.EnterpriseAddress.fromCredentials(Cardano.NetworkId.Testnet, { type: Cardano.CredentialType.KeyHash, hash: key.keyHash })
  .toAddress()
  .toBech32();
const FEE = 250_000n;

/** A Plutus V3 script the ledger never runs: only its hash matters here. */
const SCRIPT = { __type: "plutus", bytes: "4e4d010000332222200512001200110001", version: Cardano.PlutusLanguageVersion.V3 };
const scriptAddress = Cardano.EnterpriseAddress.fromCredentials(Cardano.NetworkId.Testnet, {
  type: Cardano.CredentialType.ScriptHash,
  hash: Serialization.Script.fromCore(SCRIPT).hash(),
})
  .toAddress()
  .toBech32();

// A revision 3 custody account: its address pays to the account proxy and
// stakes to the account's own stake script, and its control UTxO holds the
// state NFT and the control datum.
const STAKE_SCRIPT_HASH = "5c".repeat(28);
const accountAddress = Cardano.BaseAddress.fromCredentials(
  Cardano.NetworkId.Testnet,
  { type: Cardano.CredentialType.ScriptHash, hash: CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH },
  { type: Cardano.CredentialType.ScriptHash, hash: STAKE_SCRIPT_HASH },
)
  .toAddress()
  .toBech32();
const STATE_NFT = `${CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH}${STAKE_SCRIPT_HASH}`;
/** The control datum: logic, devices, grant generation, next slot, revoked slots, outstanding grants. */
const controlDatum = (fields = [Buffer.from(CARDANO_CUSTODY_LOGIC_HASH, "hex"), { items: [Buffer.from(key.keyHash, "hex")] }, 0n, 0n, { items: [] }, 0n]) => ({
  constructor: 0n,
  fields: { items: fields },
});
const CONTROL_LOVELACE = 3_000_000n;
const PARKED = PARKED_SCRIPTS.map(({ txId, index }) => ({ txId, index }));

const COST_MODELS = JSON.parse(readFileSync(new URL("./e2e/fixtures/preprod-parameters.json", import.meta.url), "utf8")).cost_models_raw;
/** The script integrity hash a builder writes for these redeemers and no witness datums: redeemers, then the language view of `language`. */
const integrityOf = (redeemers, language = Cardano.PlutusLanguageVersion.V3) => {
  const costModels = new Serialization.Costmdls();
  costModels.insert(new Serialization.CostModel(language, COST_MODELS[`PlutusV${language + 1}`]));
  const preimage = Buffer.from(`${Serialization.Redeemers.fromCore(redeemers).toCbor()}${costModels.languageViewsEncoding()}`, "hex");
  return Buffer.from(blake2b(preimage, { dkLen: 32 })).toString("hex");
};

let ledger;
let funded;
let collateral;

beforeEach(() => {
  ledger = new FakeLedger(() => Date.parse("2026-10-08T06:00:00Z"));
  funded = { txId: ledger.fund(address, 10_000_000n), index: 0 };
  collateral = { txId: ledger.fund(address, 5_000_000n), index: 0 };
});

/**
 * A transaction over `body`, signed by the funded key unless `sign` is
 * false. With redeemers, the body commits to their script integrity hash
 * under Plutus V3 unless `integrity` says otherwise.
 */
const build = (body, { sign = true, redeemers, scripts, integrity = redeemers && integrityOf(redeemers) } = {}) => {
  const witness = { signatures: new Map(), ...(redeemers ? { redeemers } : {}), ...(scripts ? { scripts } : {}) };
  const committed = integrity ? { ...body, scriptIntegrityHash: integrity } : body;
  const unsigned = Serialization.Transaction.fromCore({ id: "0".repeat(64), body: committed, witness });
  const signatures = sign ? new Map([[key.publicKey, key.signHash(unsigned.getId())]]) : new Map();
  return Serialization.Transaction.fromCore({ id: unsigned.getId(), body: unsigned.body().toCore(), witness: { ...witness, signatures } }).toCbor();
};

const transfer = ({ fee = FEE, outputs } = {}) => ({
  inputs: [funded],
  outputs: outputs ?? [{ address, value: { coins: 10_000_000n - fee } }],
  fee,
});

const redeemer = (memory, steps, purpose = Cardano.RedeemerPurpose.spend, index = 0) => ({ purpose, index, data: 0n, executionUnits: { memory, steps } });

/** A transaction that spends a script UTxO with its script attached, with collateral from the funded key. */
const scripted = ({ fee = FEE, totalCollateral, collateralReturn = 5_000_000n - 400_000n } = {}) => ({
  inputs: [{ txId: ledger.fund(scriptAddress, 10_000_000n), index: 0 }],
  outputs: [{ address, value: { coins: 10_000_000n - fee } }],
  fee,
  collaterals: [collateral],
  collateralReturn: { address, value: { coins: collateralReturn } },
  totalCollateral: totalCollateral ?? 5_000_000n - collateralReturn,
});
const runs = (memory, steps) => ({ redeemers: [redeemer(memory, steps)], scripts: [SCRIPT] });

/**
 * An owner operation on the account: it spends the control UTxO and writes
 * it back, reads the proxy and the logic from the parked UTxOs, and runs the
 * logic through a withdrawal of zero from its reward account.
 */
const accountOperation = ({ datum = controlDatum(), references = PARKED, runLogic = true, scripts } = {}) => {
  const control = { txId: ledger.fund(accountAddress, CONTROL_LOVELACE, { assets: new Map([[STATE_NFT, 1n]]), inlineDatum: Serialization.PlutusData.fromCore(datum).toCbor() }), index: 0 };
  const fee = 1_200_000n;
  const body = {
    inputs: [control],
    referenceInputs: references,
    outputs: [{ address: accountAddress, value: { coins: CONTROL_LOVELACE - fee, assets: new Map([[STATE_NFT, 1n]]) }, datum }],
    fee,
    ...(runLogic ? { withdrawals: [{ stakeAddress: LOGIC_REWARD_ACCOUNT, quantity: 0n }] } : {}),
    collaterals: [collateral],
    collateralReturn: { address, value: { coins: 3_000_000n } },
    totalCollateral: 2_000_000n,
  };
  const redeemers = [redeemer(700_000, 250_000_000), ...(runLogic ? [redeemer(3_200_000, 1_100_000_000, Cardano.RedeemerPurpose.withdrawal)] : [])];
  return build(body, { redeemers, scripts });
};

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
  ledger.submit(build(scripted(), runs(500_000, 200_000_000)));
  assert.equal(ledger.lovelaceAt(address), 25_000_000n - FEE);
});

test("refuses a transaction without the input key's signature", () => {
  assert.throws(() => ledger.submit(build(transfer(), { sign: false })), refusal("MissingVKeyWitnessesUTXOW"));
});

test("refuses a transaction whose value does not balance", () => {
  assert.throws(() => ledger.submit(build(transfer({ outputs: [{ address, value: { coins: 10_000_000n } }] }))), refusal("ValueNotConservedUTxO"));
});

test("refuses a fee below the minimum, script execution included", () => {
  assert.throws(() => ledger.submit(build(transfer({ fee: 1n }))), refusal("FeeTooSmallUTxO"));
  // 0.0577 lovelace per memory unit and 0.0000721 per step add 79330 to the size's fee.
  assert.throws(() => ledger.submit(build(scripted({ fee: 220_000n }), runs(1_000_000, 300_000_000))), refusal("FeeTooSmallUTxO"));
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
  const witnesses = runs(500_000, 200_000_000);
  assert.throws(() => ledger.submit(build(scripted({ totalCollateral: 300_000n }), witnesses)), refusal("IncorrectTotalCollateralField"));
  assert.throws(() => ledger.submit(build(scripted({ collateralReturn: 4_700_000n }), witnesses)), refusal("InsufficientCollateral"));
  const { collateralReturn, totalCollateral, ...withoutCollateral } = scripted();
  assert.throws(() => ledger.submit(build({ ...withoutCollateral, collaterals: [] }, witnesses)), refusal("NoCollateralInputs"));
});

test("refuses execution units above the transaction limit", () => {
  assert.throws(() => ledger.submit(build(scripted({ fee: 1_900_000n }), runs(17_500_001, 1_000))), refusal("ExUnitsTooBigUTxO"));
});

test("refuses a spent input and a validity bound in the past", () => {
  const cbor = build(transfer());
  ledger.submit(cbor);
  assert.throws(() => ledger.submit(build(transfer({ fee: FEE + 1n }))), refusal("Input"));
  const expired = { ...transfer(), inputs: [collateral], outputs: [{ address, value: { coins: 5_000_000n - FEE } }], validityInterval: { invalidHereafter: 1000 } };
  assert.throws(() => ledger.submit(build(expired)), refusal("OutsideValidityIntervalUTxO"));
});

test("refuses a script that is neither attached nor referenced, an attached script nothing needs, and redeemers that do not match", () => {
  assert.throws(() => ledger.submit(build(scripted(), { redeemers: [redeemer(500_000, 200_000_000)] })), refusal("MissingScriptWitnessesUTXOW"));
  assert.throws(() => ledger.submit(build(transfer(), { scripts: [SCRIPT] })), refusal("ExtraneousScriptWitnessesUTXOW"));
  assert.throws(() => ledger.submit(build(scripted({ fee: 400_000n }), { scripts: [SCRIPT] })), refusal("MissingRedeemers: spend:0"));
  const extra = { scripts: [SCRIPT], redeemers: [redeemer(500_000, 200_000_000), redeemer(1, 1, Cardano.RedeemerPurpose.mint)] };
  assert.throws(() => ledger.submit(build(scripted({ fee: 400_000n, collateralReturn: 4_000_000n }), extra)), refusal("ExtraRedeemers: mint:0"));
});

test("serves the account proxy and logic version 1 from the parked Preprod UTxOs the SDK references", () => {
  assert.deepEqual(new Set(PARKED_SCRIPTS.map(({ scriptHash }) => scriptHash)), new Set([CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH, CARDANO_CUSTODY_LOGIC_HASH]));
  const dist = join(dirname(createRequire(import.meta.url).resolve("@input-output-hk/lace-sdk/cardano")));
  const bundles = readdirSync(dist).filter((name) => name.endsWith(".cjs")).map((name) => readFileSync(join(dist, name), "utf8"));
  for (const parked of PARKED_SCRIPTS) {
    // The SDK package carries the same output reference and script bytes.
    assert.ok(bundles.some((bundle) => bundle.includes(parked.txId) && bundle.includes(parked.compiledCode)), parked.scriptHash);
    assert.equal(ledger.output(parked.txId, parked.index).referenceScriptHash, parked.scriptHash);
    const { json } = ledger.answer("GET", `txs/${parked.txId}/utxos`, new URLSearchParams(), null);
    assert.equal(json.outputs[0].reference_script_hash, parked.scriptHash);
    assert.equal(json.outputs[0].address, "addr_test1wqkddr3e300el0ydy4mpfd2yqdz3aeez2g8v0p07znud7ksuhmmkz");
    assert.equal(ledger.answer("GET", `scripts/${parked.scriptHash}/cbor`, new URLSearchParams(), null).json.cbor, parked.compiledCode);
  }
});

test("lists logic version 1's reward account as registered, without delegation or balance", () => {
  assert.equal(LOGIC_REWARD_ACCOUNT, "stake_test17qkddr3e300el0ydy4mpfd2yqdz3aeez2g8v0p07znud7ksul9rpg");
  const { json } = ledger.answer("GET", `accounts/${LOGIC_REWARD_ACCOUNT}`, new URLSearchParams(), null);
  assert.deepEqual([json.registered, json.active, json.withdrawable_amount], [true, false, "0"]);
});

test("applies an account operation that reads the parked scripts and runs the logic its control datum names", () => {
  const txId = ledger.submit(accountOperation());
  const applied = ledger.transaction(txId);
  assert.deepEqual(applied.referenceInputs, PARKED.map(({ txId: parked, index }) => `${parked}#${index}`));
  assert.deepEqual(applied.withdrawals, [{ rewardAccount: LOGIC_REWARD_ACCOUNT, quantity: 0n }]);
  assert.equal(ledger.utxosAt(accountAddress)[0].inlineDatum, Serialization.PlutusData.fromCore(controlDatum()).toCbor());
});

test("evaluates the logic run as the heaviest script", () => {
  const budgets = ledger.evaluate(accountOperation());
  assert.deepEqual(Object.keys(budgets).sort(), ["spend:0", "withdrawal:0"]);
  assert.ok(budgets["withdrawal:0"].memory > budgets["spend:0"].memory);
});

test("refuses an account operation the account proxy would refuse", () => {
  assert.throws(() => ledger.submit(accountOperation({ references: [] })), refusal(`MissingScriptWitnessesUTXOW: ${CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH}`));
  assert.throws(() => ledger.submit(accountOperation({ runLogic: false })), refusal(`ValidationTagMismatch: the account proxy runs logic ${CARDANO_CUSTODY_LOGIC_HASH}`));
  // A revision 2 style datum: no logic first, five fields.
  const fiveFields = controlDatum([{ items: [Buffer.from(key.keyHash, "hex")] }, 0n, 0n, { items: [] }, 0n]);
  assert.throws(() => ledger.submit(accountOperation({ datum: fiveFields })), refusal("ValidationTagMismatch: the control datum has 5 fields"));
});

test("refuses a script attached besides the reference input that already provides it", () => {
  const proxy = PARKED_SCRIPTS.find(({ scriptHash }) => scriptHash === CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH);
  const attached = { __type: "plutus", bytes: proxy.compiledCode, version: Cardano.PlutusLanguageVersion.V3 };
  assert.throws(() => ledger.submit(accountOperation({ scripts: [attached] })), refusal(`ExtraneousScriptWitnessesUTXOW: ${CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH}`));
});

test("refuses a script integrity hash that is missing, stale or not called for", () => {
  const witnesses = runs(500_000, 200_000_000);
  assert.throws(() => ledger.submit(build(scripted(), { ...witnesses, integrity: null })), refusal("MissingRequiredScriptIntegrityHash"));
  // Budgets written after the hash was computed, and the wrong language's cost model.
  const stale = integrityOf([redeemer(400_000, 200_000_000)]);
  assert.throws(() => ledger.submit(build(scripted(), { ...witnesses, integrity: stale })), refusal("PPViewHashesDontMatch"));
  const otherLanguage = integrityOf(witnesses.redeemers, Cardano.PlutusLanguageVersion.V2);
  assert.throws(() => ledger.submit(build(scripted(), { ...witnesses, integrity: otherLanguage })), refusal("PPViewHashesDontMatch"));
  assert.throws(() => ledger.submit(build(transfer(), { integrity: "ab".repeat(32) })), refusal("PPViewHashesDontMatch"));
  // The account operation's hash covers the logic run's withdrawal redeemer under the parked scripts' language.
  ledger.submit(accountOperation());
});

test("holds accepted transactions back until the test releases them", () => {
  ledger.holdSubmissions();
  const txId = ledger.submit(build(transfer()));
  assert.equal(ledger.transaction(txId), undefined);
  assert.equal(ledger.lovelaceAt(address), 15_000_000n);
  // A second spend of the same input conflicts with the held one.
  assert.throws(() => ledger.submit(build(transfer({ fee: FEE + 1n }))), refusal("BadInputsUTxO"));
  ledger.releaseSubmissions();
  assert.equal(ledger.transaction(txId).fee, FEE);
  assert.equal(ledger.lovelaceAt(address), 15_000_000n - FEE);
  // Released, the ledger applies at once again.
  ledger.submit(build({ ...transfer(), inputs: [collateral], outputs: [{ address, value: { coins: 5_000_000n - FEE } }] }));
  assert.equal(ledger.lovelaceAt(address), 15_000_000n - 2n * FEE);
});

test("takes a withdrawal only of the whole reward balance", () => {
  ledger.addRewards(LOGIC_REWARD_ACCOUNT, 1_500_000n);
  assert.throws(() => ledger.submit(accountOperation()), refusal(`WithdrawalsNotInRewardsCERTS: ${LOGIC_REWARD_ACCOUNT} 0`));
});
