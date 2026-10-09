import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import type { BrowserContext, Request, Route } from "@playwright/test";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { keyHashOf, verifyHashSignature } from "../../src/custody/dev-key";
import {
  PREPROD_EPOCH_LENGTH,
  PREPROD_SHELLEY_EPOCH,
  PREPROD_SHELLEY_START_SLOT,
  PREPROD_SYSTEM_START_SECONDS,
  preprodEpochOf,
  preprodSlotAt,
  preprodSlotStart,
} from "./preprod-time";

// A small Cardano Preprod ledger behind the Blockfrost API, for browser tests.
// It holds UTxOs with inline datums and reference scripts, among them the
// UTxOs that park the custody account proxy and logic version 1 on Preprod,
// and the logic's registered reward account. It applies submitted
// transactions after checking their inputs, validity interval, size, minimum
// fee (reference scripts included), minimum output values, collateral,
// execution unit limits, vkey signatures, script witnesses and redeemers,
// the script integrity hash, and value balance under Preprod's protocol
// parameters. A test may hold applied transactions back, as a mempool
// would, until it releases them. It tracks stake
// registration and rewards, and answers script evaluation with fixed
// budgets per script. It runs no Plutus script. Of the custody contract it
// checks only what the account proxy itself requires: that the transaction
// runs the logic its control datum names, through a withdrawal from the
// logic's reward account. Grant, device and state rules are not checked.

// The unit tests load the SDK's CommonJS build too (tests/support), so both
// share one SDK instance. Its bundled libsodium looks for `window` or `self`
// before Node's crypto.
(globalThis as { self?: unknown }).self ??= globalThis;
const sdk = createRequire(import.meta.url)("@input-output-hk/lace-sdk/cardano") as typeof import("@input-output-hk/lace-sdk/cardano");
const { Cardano, HexBlob, Serialization, CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH, CARDANO_CUSTODY_LOGIC_HASH } = sdk;

export const BLOCKFROST_ORIGIN = "https://cardano-preprod.blockfrost.io";
/** The account proxy: the payment script of every account address and the policy of every account token. */
export const ACCOUNT_PROXY_HASH: string = CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH;
/** The logic new accounts run, logic version 1: what a control datum names first. */
export const LOGIC_HASH: string = CARDANO_CUSTODY_LOGIC_HASH;
/** The script reward account through which a transaction runs logic version 1. */
export const LOGIC_REWARD_ACCOUNT: string = Cardano.RewardAccount.fromCredential(
  { type: Cardano.CredentialType.ScriptHash, hash: CARDANO_CUSTODY_LOGIC_HASH },
  Cardano.NetworkId.Testnet,
);
/** Where test funds come from: a key nobody holds. */
const FAUCET_ADDRESS: string = Cardano.EnterpriseAddress.fromCredentials(Cardano.NetworkId.Testnet, { type: Cardano.CredentialType.KeyHash, hash: "fa".repeat(28) as never })
  .toAddress()
  .toBech32();
const KEY_DEPOSIT = 2_000_000n;
/** The number of fields of a revision 3 control datum: logic, devices, grant generation, next slot, revoked slots, outstanding grants. */
const CONTROL_DATUM_FIELDS = 6;

const parameters = JSON.parse(readFileSync(new URL("./fixtures/preprod-parameters.json", import.meta.url), "utf8")) as Record<string, unknown>;
const parameter = (name: string): bigint => BigInt(parameters[name] as number | string);
/** The cost models as the chain holds them: one array per Plutus language. */
const COST_MODELS = parameters.cost_models_raw as Record<string, number[]>;

type ParkedScript = { scriptHash: string; txId: string; index: number; address: string; lovelace: string; compiledCode: string };
/** The UTxOs that park the account proxy and logic version 1 on Preprod, with each script's compiled code. */
export const PARKED_SCRIPTS = (JSON.parse(readFileSync(new URL("./fixtures/preprod-reference-scripts.json", import.meta.url), "utf8")) as { references: ParkedScript[] }).references;

/** A protocol parameter price as a fraction over 10^12. */
const PRICE_DENOMINATOR = 10n ** 12n;
const price = (name: string): bigint => BigInt(Number(parameters[name]).toFixed(12).replace(".", ""));

/**
 * The Conway fee for reference scripts: a base price per byte that grows by
 * a factor of 1.2 for every further 25600 bytes.
 */
const referenceScriptFee = (bytes: number): bigint => {
  let fee = 0;
  let perByte = Number(parameters.min_fee_ref_script_cost_per_byte);
  for (let remaining = bytes; remaining > 0; remaining -= 25_600) {
    fee += Math.min(remaining, 25_600) * perByte;
    perByte *= 1.2;
  }
  return BigInt(Math.floor(fee));
};

type Amount = { unit: string; quantity: string };
type Output = {
  address: string;
  amount: Amount[];
  dataHash: string | null;
  inlineDatum: string | null;
  referenceScriptHash: string | null;
  /** Size of the reference script as the ledger prices it: a Plutus script's bytes. */
  referenceScriptSize?: number;
  /** The reference script's compiled code, for the scripts endpoint. */
  referenceScriptCode?: string;
  /** The Plutus language of the reference script, for the script integrity hash. */
  referenceScriptLanguage?: number;
};
type Utxo = Output & { txHash: string; index: number };
type Block = { height: number; hash: string; slot: number; time: number; txHashes: string[] };
type LedgerTx = {
  hash: string;
  cbor: string;
  block: Block;
  index: number;
  fee: bigint;
  deposit: bigint;
  size: number;
  inputs: (Utxo & { collateral: boolean; reference: boolean })[];
  outputs: Utxo[];
  invalidBefore: number | null;
  invalidHereafter: number | null;
  withdrawals: { rewardAccount: string; quantity: bigint }[];
  certificateCount: number;
  mintCount: number;
  redeemerCount: number;
};
type StakeAccount = {
  registered: boolean;
  poolId: string | null;
  rewards: bigint;
  withdrawn: bigint;
  registrations: { txHash: string; action: "registered" | "deregistered" }[];
};
type TxIn = { txId: string; index: number };
type Credential = { type: number; hash: string };
/** What a redeemer points at, with the script that must run for it. */
type ScriptItem = { purpose: string; index: number; scriptHash: string; utxo?: Utxo; rewardAccount?: string };

export type SubmissionRecord = { txHash: string; accepted: boolean; message?: string };
export type BlockfrostRequest = { method: string; path: string; frameOrigin: string | undefined; headerOrigin: string | undefined };

const outpointKey = (txHash: string, index: number) => `${txHash}#${index}`;
const blake2b256 = (hex: string) => bytesToHex(blake2b(hexToBytes(hex), { dkLen: 32 }));
const compareTxIn = (a: TxIn, b: TxIn) => (a.txId === b.txId ? a.index - b.index : a.txId < b.txId ? -1 : 1);

/** Asset map keyed by Blockfrost unit, with lovelace as `lovelace`. */
type Assets = Map<string, bigint>;
const addAssets = (target: Assets, source: Assets, sign = 1n) => {
  for (const [unit, quantity] of source) target.set(unit, (target.get(unit) ?? 0n) + sign * quantity);
};
const assetsOfAmount = (amount: Amount[]): Assets => new Map(amount.map(({ unit, quantity }) => [unit, BigInt(quantity)]));
const assetsOfValue = (value: { coins: bigint; assets?: Map<string, bigint> }): Assets => {
  const assets: Assets = new Map([["lovelace", value.coins]]);
  for (const [assetId, quantity] of value.assets ?? new Map()) assets.set(assetId, quantity);
  return assets;
};
const amountOf = (assets: Assets): Amount[] => [
  { unit: "lovelace", quantity: `${assets.get("lovelace") ?? 0n}` },
  ...[...assets].filter(([unit, quantity]) => unit !== "lovelace" && quantity !== 0n).map(([unit, quantity]) => ({ unit, quantity: `${quantity}` })),
];

/** Whether a UTxO holds an account's state NFT: an account token named by a 28-byte stake script hash. */
const holdsStateNft = (utxo: Utxo) => utxo.amount.some(({ unit }) => unit.startsWith(ACCOUNT_PROXY_HASH) && unit.length === 56 + 56);
/** Whether a UTxO holds a grant token: an account token named by the stake script hash and a 4-byte slot. */
const holdsGrantToken = (utxo: Utxo) => utxo.amount.some(({ unit }) => unit.startsWith(ACCOUNT_PROXY_HASH) && unit.length === 56 + 64);

const scriptHashOf = (script: unknown): string => Serialization.Script.fromCore(script as never).hash();

/**
 * The ledger's order of reward accounts, for withdrawal redeemer indexes:
 * by network, then script credentials before key credentials, then hash.
 */
const rewardAccountOrder = (account: string): string => {
  const credential = Cardano.Address.fromString(account)?.asReward()?.getPaymentCredential();
  return `${credential?.type === Cardano.CredentialType.ScriptHash ? 0 : 1}${credential?.hash ?? account}`;
};

class LedgerError extends Error {}

export class FakeLedger {
  readonly requests: BlockfrostRequest[] = [];
  readonly submissions: SubmissionRecord[] = [];
  readonly unknownPaths = new Set<string>();
  readonly #utxos = new Map<string, Utxo>();
  readonly #txs = new Map<string, LedgerTx>();
  readonly #blocks: Block[] = [];
  readonly #addressTxs = new Map<string, string[]>();
  readonly #stake = new Map<string, StakeAccount>();
  #faucetNonce = 0;
  /** Accepted transactions not yet applied, while a test holds them back. */
  #held: { hash: string; inputs: string[]; apply: () => void }[] | undefined;
  /** POSIX milliseconds of the ledger's clock; the tip follows it. */
  readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
    this.#addBlock([]);
    this.#parkScripts();
    // Logic version 1's stake credential, registered once on Preprod outside Lace.
    this.#stake.set(LOGIC_REWARD_ACCOUNT, { registered: true, poolId: null, rewards: 0n, withdrawn: 0n, registrations: [] });
  }

  // --- Chain state ---

  get tip(): Block {
    // Like Preprod, a block about every 20 seconds even without transactions.
    const last = this.#blocks.at(-1)!;
    if (preprodSlotAt(this.now()) - last.slot >= 20) return this.#addBlock([]);
    return last;
  }

  #addBlock(txHashes: string[]): Block {
    const previous = this.#blocks.at(-1);
    const slot = Math.max(preprodSlotAt(this.now()), (previous?.slot ?? 0) + 1);
    const block: Block = {
      height: (previous?.height ?? 4_000_000) + 1,
      hash: bytesToHex(randomBytes(32)),
      slot,
      time: Math.floor(preprodSlotStart(slot) / 1000),
      txHashes,
    };
    this.#blocks.push(block);
    return block;
  }

  /** The UTxOs upstream's network setup parked the scripts in, at their Preprod output references. */
  #parkScripts() {
    for (const parked of PARKED_SCRIPTS) {
      const script = { __type: "plutus", bytes: parked.compiledCode, version: Cardano.PlutusLanguageVersion.V3 };
      if (scriptHashOf(script) !== parked.scriptHash) throw new Error(`The parked script at ${parked.txId}#${parked.index} does not hash to ${parked.scriptHash}`);
      const output: Utxo = {
        txHash: parked.txId,
        index: parked.index,
        address: parked.address,
        amount: [{ unit: "lovelace", quantity: parked.lovelace }],
        dataHash: null,
        inlineDatum: null,
        referenceScriptHash: parked.scriptHash,
        referenceScriptSize: parked.compiledCode.length / 2,
        referenceScriptCode: parked.compiledCode,
        referenceScriptLanguage: Cardano.PlutusLanguageVersion.V3,
      };
      this.#utxos.set(outpointKey(parked.txId, parked.index), output);
      this.#record({ hash: parked.txId, cbor: "", block: this.#blocks[0], index: 0, fee: 0n, deposit: 0n, size: 0, inputs: [], outputs: [output], invalidBefore: null, invalidHereafter: null, withdrawals: [], certificateCount: 0, mintCount: 0, redeemerCount: 0 });
    }
  }

  /** Fee, deposit, reference inputs and withdrawals of an applied transaction. */
  transaction(hash: string): { fee: bigint; deposit: bigint; referenceInputs: string[]; withdrawals: { rewardAccount: string; quantity: bigint }[] } | undefined {
    const tx = this.#txs.get(hash);
    return (
      tx && {
        fee: tx.fee,
        deposit: tx.deposit,
        referenceInputs: tx.inputs.filter((input) => input.reference).map((input) => outpointKey(input.txHash, input.index)),
        withdrawals: tx.withdrawals,
      }
    );
  }

  /** The unspent output at an output reference. */
  output(txId: string, index: number): Utxo | undefined {
    return this.#utxos.get(outpointKey(txId, index));
  }

  utxosAt(address: string): Utxo[] {
    return [...this.#utxos.values()].filter((utxo) => utxo.address === address);
  }

  lovelaceAt(address: string): bigint {
    return this.utxosAt(address).reduce((total, utxo) => total + (assetsOfAmount(utxo.amount).get("lovelace") ?? 0n), 0n);
  }

  /**
   * Pays `lovelace` to `address` from outside the ledger, in a block of its
   * own. A unit test may also conjure `assets` and an inline datum, as no
   * real transaction could.
   */
  fund(address: string, lovelace: bigint, { assets = new Map(), inlineDatum = null }: { assets?: Map<string, bigint>; inlineDatum?: string | null } = {}): string {
    const tx = Serialization.Transaction.fromCore({
      id: "0".repeat(64),
      body: {
        inputs: [{ txId: "fa".repeat(32), index: this.#faucetNonce++ }],
        outputs: [{ address, value: { coins: lovelace } }],
        fee: 0n,
      },
      witness: { signatures: new Map() },
    } as never);
    const hash = tx.getId() as string;
    const block = this.#addBlock([hash]);
    const value: Assets = new Map([["lovelace", lovelace], ...assets]);
    const outputs: Utxo[] = [{ txHash: hash, index: 0, address, amount: amountOf(value), dataHash: inlineDatum ? blake2b256(inlineDatum) : null, inlineDatum, referenceScriptHash: null }];
    const faucetInput = { txHash: "fa".repeat(32), index: this.#faucetNonce - 1, address: FAUCET_ADDRESS, amount: outputs[0].amount, dataHash: null, inlineDatum: null, referenceScriptHash: null, collateral: false, reference: false };
    this.#record({ hash, cbor: tx.toCbor(), block, index: 0, fee: 0n, deposit: 0n, size: tx.toCbor().length / 2, inputs: [faucetInput], outputs, invalidBefore: null, invalidHereafter: null, withdrawals: [], certificateCount: 0, mintCount: 0, redeemerCount: 0 });
    for (const output of outputs) this.#utxos.set(outpointKey(output.txHash, output.index), output);
    return hash;
  }

  /** Credits rewards to a registered reward account, as a pool naming it as its reward account would. */
  addRewards(rewardAccount: string, lovelace: bigint): void {
    const account = this.#stake.get(rewardAccount);
    if (!account?.registered) throw new Error(`${rewardAccount} is not registered`);
    account.rewards += lovelace;
  }

  /** Accepts later submissions without applying them, as a mempool holds them, until `releaseSubmissions`. */
  holdSubmissions(): void {
    this.#held ??= [];
  }

  /** Applies the held submissions, in order, and applies later ones at once. */
  releaseSubmissions(): void {
    const held = this.#held ?? [];
    this.#held = undefined;
    for (const { apply } of held) apply();
  }

  #record(tx: LedgerTx) {
    this.#txs.set(tx.hash, tx);
    const addresses = new Set([...tx.inputs.map((input) => input.address), ...tx.outputs.map((output) => output.address)]);
    for (const address of addresses) this.#addressTxs.set(address, [...(this.#addressTxs.get(address) ?? []), tx.hash]);
  }

  // --- Transactions ---

  #resolve(txIn: TxIn, what: string): Utxo {
    const utxo = this.#utxos.get(outpointKey(txIn.txId, txIn.index));
    if (!utxo) throw new LedgerError(`${what} ${txIn.txId}#${txIn.index} is not an unspent output`);
    return utxo;
  }

  #outputOf(serialized: any, txHash: string, index: number): Utxo {
    const core = serialized.toCore();
    const inlineDatum: string | null = serialized.datum()?.asInlineData()?.toCbor() ?? null;
    const dataHash: string | null = inlineDatum ? blake2b256(inlineDatum) : (core.datumHash ?? null);
    const scriptRef = serialized.scriptRef();
    const script = scriptRef?.toCore();
    return {
      txHash,
      index,
      address: core.address,
      amount: amountOf(assetsOfValue(core.value)),
      // Blockfrost reports an inline datum's hash as `data_hash` too.
      dataHash,
      inlineDatum,
      referenceScriptHash: scriptRef ? scriptRef.hash() : null,
      ...(scriptRef
        ? script?.__type === "plutus"
          ? { referenceScriptSize: script.bytes.length / 2, referenceScriptCode: script.bytes, referenceScriptLanguage: script.version }
          : { referenceScriptSize: scriptRef.toCbor().length / 2 }
        : {}),
    };
  }

  /** The smallest lovelace an output of this serialized size may hold. */
  #minimumLovelace(serialized: { toCbor(): string }): bigint {
    return parameter("coins_per_utxo_size") * (BigInt(serialized.toCbor().length / 2) + 160n);
  }

  #paymentCredential(address: string): Credential | undefined {
    return Cardano.Address.fromString(address)?.getProps().paymentPart as Credential | undefined;
  }

  #paymentKeyHash(address: string): string | undefined {
    const payment = this.#paymentCredential(address);
    return payment?.type === Cardano.CredentialType.KeyHash ? payment.hash : undefined;
  }

  #rewardAccountOf(address: string): string | undefined {
    const stake = Cardano.Address.fromString(address)?.asBase()?.getStakeCredential();
    return stake ? Cardano.RewardAccount.fromCredential(stake, Cardano.NetworkId.Testnet) : undefined;
  }

  /**
   * Every item a script must run for, in redeemer pointer order: script
   * inputs by output reference, mint policies by hash, certificates in
   * order, and withdrawals in the ledger's reward account order.
   */
  #scriptItems(body: any, inputs: Utxo[]): ScriptItem[] {
    const items: ScriptItem[] = [];
    const sortedInputs = [...body.inputs].sort(compareTxIn).map((txIn: TxIn) => inputs.find((utxo) => utxo.txHash === txIn.txId && utxo.index === txIn.index)!);
    sortedInputs.forEach((utxo, index) => {
      const payment = this.#paymentCredential(utxo.address);
      if (payment?.type === Cardano.CredentialType.ScriptHash) items.push({ purpose: Cardano.RedeemerPurpose.spend, index, scriptHash: payment.hash, utxo });
    });
    const policies = [...new Set([...(body.mint ?? new Map()).keys()].map((assetId: string) => assetId.slice(0, 56)))].sort();
    policies.forEach((policyId, index) => items.push({ purpose: Cardano.RedeemerPurpose.mint, index, scriptHash: policyId }));
    (body.certificates ?? []).forEach((certificate: { __typename: string; stakeCredential?: Credential }, index: number) => {
      // A pre-Conway registration without a deposit needs no witness.
      if (certificate.__typename === Cardano.CertificateType.StakeRegistration) return;
      if (certificate.stakeCredential?.type === Cardano.CredentialType.ScriptHash) {
        items.push({ purpose: Cardano.RedeemerPurpose.certificate, index, scriptHash: certificate.stakeCredential.hash });
      }
    });
    const withdrawals = [...(body.withdrawals ?? [])].sort((a: { stakeAddress: string }, b: { stakeAddress: string }) =>
      rewardAccountOrder(a.stakeAddress) < rewardAccountOrder(b.stakeAddress) ? -1 : 1,
    );
    withdrawals.forEach(({ stakeAddress }: { stakeAddress: string }, index: number) => {
      const credential = Cardano.Address.fromString(stakeAddress)?.asReward()?.getPaymentCredential();
      if (credential?.type === Cardano.CredentialType.ScriptHash) {
        items.push({ purpose: Cardano.RedeemerPurpose.withdrawal, index, scriptHash: credential.hash, rewardAccount: stakeAddress });
      }
    });
    return items;
  }

  /** The logic the account proxy runs for this transaction: what the control datum names in its first field. */
  #controlLogic(spentAndReferenced: Utxo[], outputs: Utxo[]): string {
    // An operation reads the control UTxO it spends or references; a creation the control output it writes.
    const control = spentAndReferenced.find(holdsStateNft) ?? outputs.find(holdsStateNft);
    if (!control?.inlineDatum) throw new LedgerError("ValidationTagMismatch: the account proxy found no control UTxO with an inline datum");
    let fields: unknown[];
    try {
      const datum = Serialization.PlutusData.fromCbor(HexBlob(control.inlineDatum)).toCore() as { constructor?: unknown; fields?: { items: unknown[] } };
      if (typeof datum.constructor !== "bigint" || !datum.fields) throw new Error("not a constructor");
      fields = datum.fields.items;
    } catch {
      throw new LedgerError("ValidationTagMismatch: the control datum does not decode");
    }
    const [logic] = fields;
    if (fields.length !== CONTROL_DATUM_FIELDS || !(logic instanceof Uint8Array) || logic.length !== 28) {
      throw new LedgerError(`ValidationTagMismatch: the control datum has ${fields.length} fields and does not name a logic first`);
    }
    return bytesToHex(logic);
  }

  /**
   * The checks that hold for evaluation and submission alike: every script
   * is attached or read from a reference input, and none is attached for
   * nothing or besides its reference; every script item has a redeemer and
   * every redeemer an item;
   * and the account proxy runs the logic the control datum names.
   */
  #checkScripts(core: any, inputs: Utxo[], references: Utxo[], outputs: Utxo[]): ScriptItem[] {
    const body = core.body;
    const items = this.#scriptItems(body, inputs);
    const needed = new Set(items.map(({ scriptHash }) => scriptHash));
    const attached = new Set<string>((core.witness.scripts ?? []).map(scriptHashOf));
    const referenced = new Set([...inputs, ...references].map((utxo) => utxo.referenceScriptHash).filter((hash): hash is string => hash !== null));
    const missing = [...needed].filter((hash) => !attached.has(hash) && !referenced.has(hash));
    if (missing.length > 0) throw new LedgerError(`MissingScriptWitnessesUTXOW: ${missing.join(", ")}`);
    // A script needed and also read from a reference input must not be attached as well.
    const extraneous = [...attached].filter((hash) => !needed.has(hash) || referenced.has(hash));
    if (extraneous.length > 0) throw new LedgerError(`ExtraneousScriptWitnessesUTXOW: ${extraneous.join(", ")}`);

    const redeemers: { purpose: string; index: number }[] = core.witness.redeemers ?? [];
    const pointer = ({ purpose, index }: { purpose: string; index: number }) => `${purpose}:${index}`;
    const itemPointers = new Set(items.map(pointer));
    const redeemerPointers = new Set(redeemers.map(pointer));
    const unredeemed = [...itemPointers].filter((key) => !redeemerPointers.has(key));
    if (unredeemed.length > 0) throw new LedgerError(`MissingRedeemers: ${unredeemed.join(", ")}`);
    const pointless = [...redeemerPointers].filter((key) => !itemPointers.has(key));
    if (pointless.length > 0) throw new LedgerError(`ExtraRedeemers: ${pointless.join(", ")}`);

    if (needed.has(ACCOUNT_PROXY_HASH)) {
      const logic = this.#controlLogic([...inputs, ...references], outputs);
      const runs = items.some(({ purpose, scriptHash }) => purpose === Cardano.RedeemerPurpose.withdrawal && scriptHash === logic);
      if (!runs) throw new LedgerError(`ValidationTagMismatch: the account proxy runs logic ${logic} through a withdrawal from its reward account, which the transaction lacks`);
    }
    return items;
  }

  /**
   * The script integrity hash a node computes: the redeemers and datums as
   * the witness set encodes them, then the language views of the cost
   * models of the Plutus languages the transaction runs.
   */
  #scriptIntegrityHash(tx: any, core: any, items: ScriptItem[], inputs: Utxo[], references: Utxo[]): string | undefined {
    const hasRedeemers = (core.witness.redeemers ?? []).length > 0;
    const hasDatums = (core.witness.datums ?? []).length > 0;
    if (!hasRedeemers && !hasDatums) return undefined;
    const languages = new Set<number>();
    for (const { scriptHash } of items) {
      const attached = (core.witness.scripts ?? []).find((script: unknown) => scriptHashOf(script) === scriptHash);
      const language = attached ? (attached.__type === "plutus" ? attached.version : undefined) : [...inputs, ...references].find((utxo) => utxo.referenceScriptHash === scriptHash)?.referenceScriptLanguage;
      if (language !== undefined) languages.add(language);
    }
    const costModels = new Serialization.Costmdls();
    for (const language of languages) costModels.insert(new Serialization.CostModel(language, COST_MODELS[`PlutusV${language + 1}`]));
    const witnessSet = tx.witnessSet();
    // Without redeemers, the ledger hashes an empty redeemer map and no language views.
    const redeemers = hasRedeemers ? witnessSet.redeemers().toCbor() : "a0";
    const datums = hasDatums ? witnessSet.plutusData().toCbor() : "";
    return blake2b256(`${redeemers}${datums}${hasRedeemers ? costModels.languageViewsEncoding() : "a0"}`);
  }

  /** Applies a signed transaction, or throws with the reason a node would give. */
  submit(cborHex: string): string {
    let tx: any;
    try {
      tx = Serialization.Transaction.fromCbor(Serialization.TxCBOR(cborHex));
    } catch (error) {
      throw new LedgerError(`DeserialiseFailure: ${(error as Error).message}`);
    }
    const hash = tx.getId() as string;
    const core = tx.toCore();
    const body = core.body;
    if (this.#txs.has(hash)) throw new LedgerError(`${hash} is already on chain`);

    const slot = preprodSlotAt(this.now());
    const { invalidBefore, invalidHereafter } = body.validityInterval ?? {};
    if (invalidHereafter !== undefined && slot >= invalidHereafter) throw new LedgerError(`OutsideValidityIntervalUTxO: slot ${slot} is at or past ${invalidHereafter}`);
    if (invalidBefore !== undefined && slot < invalidBefore) throw new LedgerError(`OutsideValidityIntervalUTxO: slot ${slot} is before ${invalidBefore}`);

    const inputs = body.inputs.map((input: TxIn) => this.#resolve(input, "Input"));
    const pending = new Set((this.#held ?? []).flatMap((held) => held.inputs));
    const contended = body.inputs.find((input: TxIn) => pending.has(outpointKey(input.txId, input.index)));
    if (contended) throw new LedgerError(`BadInputsUTxO: ${contended.txId}#${contended.index} is spent by a transaction in the mempool`);
    const collaterals = (body.collaterals ?? []).map((input: TxIn) => this.#resolve(input, "Collateral"));
    const references = (body.referenceInputs ?? []).map((input: TxIn) => this.#resolve(input, "Reference input"));
    const redeemers: { executionUnits: { memory: number; steps: number } }[] = core.witness.redeemers ?? [];
    const outputs: Utxo[] = tx.body().outputs().map((output: unknown, index: number) => this.#outputOf(output, hash, index));

    // Size, execution units and the minimum fee. The ledger sizes a
    // transaction without its is_valid flag (`toCBORForSizeComputation`): one
    // byte less than the CBOR submitted.
    const size = cborHex.length / 2 - 1;
    if (BigInt(size) > parameter("max_tx_size")) throw new LedgerError(`MaxTxSizeUTxO: ${size} bytes, at most ${parameter("max_tx_size")}`);
    const memory = redeemers.reduce((total, { executionUnits }) => total + BigInt(executionUnits.memory), 0n);
    const steps = redeemers.reduce((total, { executionUnits }) => total + BigInt(executionUnits.steps), 0n);
    if (memory > parameter("max_tx_ex_mem") || steps > parameter("max_tx_ex_steps")) {
      throw new LedgerError(`ExUnitsTooBigUTxO: ${memory} memory and ${steps} steps, at most ${parameter("max_tx_ex_mem")} and ${parameter("max_tx_ex_steps")}`);
    }
    const scriptFee = (memory * price("price_mem") + steps * price("price_step") + PRICE_DENOMINATOR - 1n) / PRICE_DENOMINATOR;
    const referenceScriptBytes = [...inputs, ...references].reduce((total: number, utxo: Utxo) => total + (utxo.referenceScriptSize ?? 0), 0);
    const minimumFee = parameter("min_fee_a") * BigInt(size) + parameter("min_fee_b") + scriptFee + referenceScriptFee(referenceScriptBytes);
    if (body.fee < minimumFee) throw new LedgerError(`FeeTooSmallUTxO: fee ${body.fee}, at least ${minimumFee}`);

    // Every output, the collateral return included, holds its minimum lovelace.
    const serializedBody = tx.body();
    const serializedOutputs = [...serializedBody.outputs(), ...(serializedBody.collateralReturn() ? [serializedBody.collateralReturn()] : [])];
    for (const serialized of serializedOutputs) {
      const { address, value } = serialized.toCore();
      const minimum = this.#minimumLovelace(serialized);
      if (value.coins < minimum) throw new LedgerError(`BabbageOutputTooSmallUTxO: ${value.coins} lovelace to ${address}, at least ${minimum}`);
    }

    // Collateral, when scripts run.
    if (redeemers.length > 0) {
      if (collaterals.length === 0) throw new LedgerError("NoCollateralInputs");
      if (BigInt(collaterals.length) > parameter("max_collateral_inputs")) throw new LedgerError(`TooManyCollateralInputs: ${collaterals.length}`);
      const scriptLocked = collaterals.find((utxo: Utxo) => !this.#paymentKeyHash(utxo.address));
      if (scriptLocked) throw new LedgerError(`ScriptsNotPaidUTxO: collateral ${scriptLocked.txHash}#${scriptLocked.index} is not locked by a key`);
      const collateralLovelace: bigint = collaterals.reduce((total: bigint, utxo: Utxo) => total + (assetsOfAmount(utxo.amount).get("lovelace") ?? 0n), 0n);
      const balance: bigint = collateralLovelace - BigInt(body.collateralReturn?.value.coins ?? 0n);
      if (body.totalCollateral !== undefined && body.totalCollateral !== balance) {
        throw new LedgerError(`IncorrectTotalCollateralField: collateral balance ${balance}, total collateral ${body.totalCollateral}`);
      }
      if (balance * 100n < body.fee * parameter("collateral_percent")) {
        throw new LedgerError(`InsufficientCollateral: ${balance}, at least ${parameter("collateral_percent")}% of the fee ${body.fee}`);
      }
    }

    // Every vkey witness must verify over the body hash.
    const signers = new Set<string>();
    for (const [vkey, signature] of core.witness.signatures ?? new Map()) {
      if (!verifyHashSignature(vkey, hash, signature)) throw new LedgerError(`InvalidWitnessesUTXOW: ${vkey}`);
      signers.add(keyHashOf(vkey));
    }
    const needed = new Set<string>(body.requiredExtraSignatures ?? []);
    for (const utxo of [...inputs, ...collaterals]) {
      const keyHash = this.#paymentKeyHash(utxo.address);
      if (keyHash) needed.add(keyHash);
    }
    const missing = [...needed].filter((keyHash) => !signers.has(keyHash));
    if (missing.length > 0) throw new LedgerError(`MissingVKeyWitnessesUTXOW: ${missing.join(", ")}`);

    const items = this.#checkScripts(core, inputs, references, outputs);
    const integrity = this.#scriptIntegrityHash(tx, core, items, inputs, references);
    if (integrity === undefined && body.scriptIntegrityHash !== undefined) throw new LedgerError(`PPViewHashesDontMatch: the body commits to ${body.scriptIntegrityHash} for no redeemers or datums`);
    if (integrity !== undefined && body.scriptIntegrityHash === undefined) throw new LedgerError("MissingRequiredScriptIntegrityHash");
    if (integrity !== body.scriptIntegrityHash) throw new LedgerError(`PPViewHashesDontMatch: the body commits to ${body.scriptIntegrityHash}, the ledger computes ${integrity}`);

    // Value: inputs + withdrawals + mint = outputs + fee + deposits.
    let deposit = 0n;
    const certificateEffects: (() => void)[] = [];
    for (const certificate of body.certificates ?? []) {
      const rewardAccount = certificate.stakeCredential ? Cardano.RewardAccount.fromCredential(certificate.stakeCredential, Cardano.NetworkId.Testnet) : undefined;
      if (!rewardAccount) continue;
      const account = this.#stake.get(rewardAccount);
      switch (certificate.__typename) {
        case Cardano.CertificateType.Registration:
        case Cardano.CertificateType.StakeRegistration:
          if (account?.registered) throw new LedgerError(`StakeKeyRegisteredDELEG: ${rewardAccount}`);
          deposit += certificate.deposit ?? KEY_DEPOSIT;
          certificateEffects.push(() => {
            this.#stake.set(rewardAccount, { registered: true, poolId: null, rewards: 0n, withdrawn: 0n, registrations: [...(account?.registrations ?? []), { txHash: hash, action: "registered" }] });
          });
          break;
        case Cardano.CertificateType.StakeDelegation:
          certificateEffects.push(() => {
            const registered = this.#stake.get(rewardAccount);
            if (!registered?.registered) throw new LedgerError(`StakeDelegationImpossibleDELEG: ${rewardAccount}`);
            registered.poolId = certificate.poolId;
          });
          break;
        default:
          throw new LedgerError(`Unsupported certificate ${certificate.__typename}`);
      }
    }
    const consumed: Assets = new Map();
    for (const utxo of inputs) addAssets(consumed, assetsOfAmount(utxo.amount));
    for (const { stakeAddress, quantity } of body.withdrawals ?? []) {
      // A withdrawal takes the whole reward balance or fails.
      const account = this.#stake.get(stakeAddress);
      if (!account?.registered || account.rewards !== quantity) throw new LedgerError(`WithdrawalsNotInRewardsCERTS: ${stakeAddress} ${quantity}`);
      addAssets(consumed, new Map([["lovelace", quantity]]));
    }
    for (const [assetId, quantity] of body.mint ?? new Map()) addAssets(consumed, new Map([[assetId as string, quantity as bigint]]));
    const produced: Assets = new Map([["lovelace", body.fee + deposit]]);
    for (const output of outputs) addAssets(produced, assetsOfAmount(output.amount));
    for (const unit of new Set([...consumed.keys(), ...produced.keys()])) {
      if ((consumed.get(unit) ?? 0n) !== (produced.get(unit) ?? 0n)) {
        throw new LedgerError(`ValueNotConservedUTxO: ${unit} consumed ${consumed.get(unit) ?? 0n}, produced ${produced.get(unit) ?? 0n}`);
      }
    }
    for (const output of outputs) {
      if (output.address.startsWith("addr_test1") === false) throw new LedgerError(`WrongNetwork: ${output.address}`);
    }

    const apply = () => {
      for (const effect of certificateEffects) effect();
      for (const { stakeAddress } of body.withdrawals ?? []) {
        const account = this.#stake.get(stakeAddress)!;
        account.withdrawn += account.rewards;
        account.rewards = 0n;
      }
      for (const input of body.inputs) this.#utxos.delete(outpointKey(input.txId, input.index));
      for (const output of outputs) this.#utxos.set(outpointKey(output.txHash, output.index), output);
      const block = this.#addBlock([hash]);
      this.#record({
        hash,
        cbor: cborHex,
        block,
        index: 0,
        fee: body.fee,
        deposit,
        size: cborHex.length / 2,
        inputs: [
          ...inputs.map((utxo: Utxo) => ({ ...utxo, collateral: false, reference: false })),
          ...collaterals.map((utxo: Utxo) => ({ ...utxo, collateral: true, reference: false })),
          ...references.map((utxo: Utxo) => ({ ...utxo, collateral: false, reference: true })),
        ],
        outputs,
        invalidBefore: invalidBefore ?? null,
        invalidHereafter: invalidHereafter ?? null,
        withdrawals: (body.withdrawals ?? []).map(({ stakeAddress, quantity }: { stakeAddress: string; quantity: bigint }) => ({ rewardAccount: stakeAddress, quantity })),
        certificateCount: (body.certificates ?? []).length,
        mintCount: body.mint?.size ?? 0,
        redeemerCount: redeemers.length,
      });
    };
    if (this.#held) this.#held.push({ hash, inputs: body.inputs.map((input: TxIn) => outpointKey(input.txId, input.index)), apply });
    else apply();
    return hash;
  }

  /**
   * Fixed budgets per redeemer, by the script it runs: the logic run is the
   * heaviest, then the proxy over the control UTxO, a grant UTxO, a mint, a
   * certificate and a fund. The transaction must pass the script checks a
   * node would run first.
   */
  evaluate(cborHex: string): Record<string, { memory: number; steps: number }> {
    const tx = Serialization.Transaction.fromCbor(Serialization.TxCBOR(cborHex));
    const core = tx.toCore();
    const inputs = core.body.inputs.map((input: TxIn) => this.#resolve(input, "Input"));
    const references = (core.body.referenceInputs ?? []).map((input: TxIn) => this.#resolve(input, "Reference input"));
    const outputs = tx.body().outputs().map((output: unknown, index: number) => this.#outputOf(output, "0".repeat(64), index));
    const items = this.#checkScripts(core, inputs, references, outputs);
    const result: Record<string, { memory: number; steps: number }> = {};
    for (const { purpose, index, scriptHash, utxo } of items) {
      let budget = { memory: 350_000, steps: 130_000_000 };
      if (purpose === Cardano.RedeemerPurpose.withdrawal && scriptHash === CARDANO_CUSTODY_LOGIC_HASH) budget = { memory: 3_200_000, steps: 1_100_000_000 };
      else if (purpose === Cardano.RedeemerPurpose.spend && utxo && holdsStateNft(utxo)) budget = { memory: 700_000, steps: 250_000_000 };
      else if (purpose === Cardano.RedeemerPurpose.spend && utxo && holdsGrantToken(utxo)) budget = { memory: 500_000, steps: 180_000_000 };
      else if (purpose === Cardano.RedeemerPurpose.spend) budget = { memory: 300_000, steps: 110_000_000 };
      else if (purpose === Cardano.RedeemerPurpose.mint) budget = { memory: 450_000, steps: 160_000_000 };
      // Ogmios v5 names, as Blockfrost answers by default.
      result[`${purpose}:${index}`] = budget;
    }
    return result;
  }

  // --- Blockfrost API ---

  #account(rewardAccount: string) {
    const account = this.#stake.get(rewardAccount);
    if (!account) return undefined;
    const controlled = [...this.#utxos.values()]
      .filter((utxo) => this.#rewardAccountOf(utxo.address) === rewardAccount)
      .reduce((total, utxo) => total + (assetsOfAmount(utxo.amount).get("lovelace") ?? 0n), 0n);
    return {
      stake_address: rewardAccount,
      // Blockfrost reports a registered credential that delegates to no pool as not active.
      active: account.registered && account.poolId !== null,
      registered: account.registered,
      active_epoch: account.registered ? preprodEpochOf(this.tip.slot) : null,
      controlled_amount: `${controlled + account.rewards}`,
      rewards_sum: `${account.rewards + account.withdrawn}`,
      withdrawals_sum: `${account.withdrawn}`,
      reserves_sum: "0",
      treasury_sum: "0",
      withdrawable_amount: `${account.rewards}`,
      pool_id: account.poolId,
      drep_id: null,
    };
  }

  #utxoJson(utxo: Utxo) {
    const tx = this.#txs.get(utxo.txHash);
    return {
      address: utxo.address,
      tx_hash: utxo.txHash,
      tx_index: utxo.index,
      output_index: utxo.index,
      amount: utxo.amount,
      block: tx?.block.hash ?? this.tip.hash,
      data_hash: utxo.dataHash,
      inline_datum: utxo.inlineDatum,
      reference_script_hash: utxo.referenceScriptHash,
    };
  }

  #txContent(tx: LedgerTx) {
    const output = new Map<string, bigint>();
    for (const utxo of tx.outputs) addAssets(output, assetsOfAmount(utxo.amount));
    return {
      hash: tx.hash,
      block: tx.block.hash,
      block_height: tx.block.height,
      block_time: tx.block.time,
      slot: tx.block.slot,
      index: tx.index,
      output_amount: amountOf(output),
      fees: `${tx.fee}`,
      deposit: `${tx.deposit}`,
      size: tx.size,
      invalid_before: tx.invalidBefore === null ? null : `${tx.invalidBefore}`,
      invalid_hereafter: tx.invalidHereafter === null ? null : `${tx.invalidHereafter}`,
      utxo_count: tx.inputs.length + tx.outputs.length,
      withdrawal_count: tx.withdrawals.length,
      mir_cert_count: 0,
      delegation_count: 0,
      stake_cert_count: tx.certificateCount,
      pool_update_count: 0,
      pool_retire_count: 0,
      asset_mint_or_burn_count: tx.mintCount,
      redeemer_count: tx.redeemerCount,
      valid_contract: true,
    };
  }

  #page<T>(items: T[], query: URLSearchParams): T[] {
    const ordered = query.get("order") === "desc" ? [...items].reverse() : items;
    const count = Number(query.get("count") ?? 100);
    const page = Number(query.get("page") ?? 1);
    return ordered.slice((page - 1) * count, page * count);
  }

  #eras() {
    const tipEpoch = preprodEpochOf(this.tip.slot);
    const endEpoch = tipEpoch + 2;
    const endSlot = PREPROD_SHELLEY_START_SLOT + (endEpoch - PREPROD_SHELLEY_EPOCH) * PREPROD_EPOCH_LENGTH;
    const shelleyTime = PREPROD_SHELLEY_START_SLOT * 20;
    return [
      { start: { time: 0, slot: 0, epoch: 0 }, end: { time: shelleyTime, slot: PREPROD_SHELLEY_START_SLOT, epoch: PREPROD_SHELLEY_EPOCH }, parameters: { epoch_length: 21_600, slot_length: 20, safe_zone: 4_320 } },
      {
        start: { time: shelleyTime, slot: PREPROD_SHELLEY_START_SLOT, epoch: PREPROD_SHELLEY_EPOCH },
        end: { time: shelleyTime + (endSlot - PREPROD_SHELLEY_START_SLOT), slot: endSlot, epoch: endEpoch },
        parameters: { epoch_length: PREPROD_EPOCH_LENGTH, slot_length: 1, safe_zone: 129_600 },
      },
    ];
  }

  /** The reference script with this hash some UTxO of the ledger carries. */
  #referenceScript(hash: string): Utxo | undefined {
    return [...this.#utxos.values()].find((utxo) => utxo.referenceScriptHash === hash && utxo.referenceScriptCode);
  }

  /** The Blockfrost answer to one request, or undefined for an unknown endpoint. */
  answer(method: string, path: string, query: URLSearchParams, body: Buffer | null): { status: number; json: unknown } | undefined {
    const ok = (json: unknown) => ({ status: 200, json });
    const notFound = { status: 404, json: { status_code: 404, error: "Not Found", message: "The requested component has not been found." } };
    let match: RegExpExecArray | null;

    if (method === "POST" && path === "tx/submit") {
      try {
        const hash = this.submit(bytesToHex(new Uint8Array(body ?? Buffer.alloc(0))));
        this.submissions.push({ txHash: hash, accepted: true });
        return ok(hash);
      } catch (error) {
        const message = (error as Error).message;
        this.submissions.push({ txHash: "", accepted: false, message });
        return { status: 400, json: { status_code: 400, error: "Bad Request", message } };
      }
    }
    if (method === "POST" && path === "utils/txs/evaluate") {
      try {
        const evaluation = this.evaluate((body ?? Buffer.alloc(0)).toString("utf8").trim());
        return ok({ type: "jsonwsp/response", version: "1.0", servicename: "ogmios", methodname: "EvaluateTx", result: { EvaluationResult: evaluation } });
      } catch (error) {
        return ok({ type: "jsonwsp/fault", version: "1.0", servicename: "ogmios", fault: { code: "client", string: (error as Error).message } });
      }
    }
    if (method !== "GET") return undefined;

    if (path === "epochs/latest/parameters") return ok({ ...parameters, epoch: preprodEpochOf(this.tip.slot) });
    if (path === "genesis") {
      return ok({ active_slots_coefficient: 0.05, epoch_length: PREPROD_EPOCH_LENGTH, max_kes_evolutions: 62, max_lovelace_supply: "45000000000000000", network_magic: 1, security_param: 2160, slot_length: 1, slots_per_kes_period: 129600, system_start: PREPROD_SYSTEM_START_SECONDS, update_quorum: 5 });
    }
    if (path === "network/eras") return ok(this.#eras());
    if (path === "network") return ok({ stake: { active: "0", live: "0" }, supply: { circulating: "0", locked: "0", max: "45000000000000000", total: "45000000000000000", treasury: "0", reserves: "0" } });
    if (path === "blocks/latest") {
      const tip = this.tip;
      return ok({ time: tip.time, height: tip.height, hash: tip.hash, slot: tip.slot, epoch: preprodEpochOf(tip.slot), epoch_slot: (tip.slot - PREPROD_SHELLEY_START_SLOT) % PREPROD_EPOCH_LENGTH, slot_leader: "pool1fake", size: 0, tx_count: tip.txHashes.length, output: null, fees: null, block_vrf: null, op_cert: null, op_cert_counter: null, previous_block: null, next_block: null, confirmations: 0 });
    }
    if ((match = /^addresses\/([^/]+)\/utxos$/.exec(path))) return ok(this.#page(this.utxosAt(match[1]).map((utxo) => this.#utxoJson(utxo)), query));
    if ((match = /^addresses\/([^/]+)\/transactions$/.exec(path))) {
      const txs = (this.#addressTxs.get(match[1]) ?? []).map((hash) => this.#txs.get(hash)!);
      const position = (value: string | null) => (value === null ? undefined : value.split(":").map(Number));
      const from = position(query.get("from"));
      const to = position(query.get("to"));
      const filtered = txs.filter(({ block, index }) => {
        if (from && (block.height < from[0] || (block.height === from[0] && from[1] !== undefined && index < from[1]))) return false;
        if (to && (block.height > to[0] || (block.height === to[0] && to[1] !== undefined && index > to[1]))) return false;
        return true;
      });
      return ok(this.#page(filtered.map((tx) => ({ tx_hash: tx.hash, tx_index: tx.index, block_height: tx.block.height, block_time: tx.block.time })), query));
    }
    if ((match = /^addresses\/([^/]+)$/.exec(path))) {
      const assets: Assets = new Map();
      for (const utxo of this.utxosAt(match[1])) addAssets(assets, assetsOfAmount(utxo.amount));
      return ok({ address: match[1], amount: amountOf(assets), stake_address: this.#rewardAccountOf(match[1]) ?? null, type: "shelley", script: false });
    }
    if ((match = /^accounts\/([^/]+)\/utxos$/.exec(path))) {
      const utxos = [...this.#utxos.values()].filter((utxo) => this.#rewardAccountOf(utxo.address) === match![1]);
      return ok(this.#page(utxos.map((utxo) => this.#utxoJson(utxo)), query));
    }
    if ((match = /^accounts\/([^/]+)\/addresses$/.exec(path))) {
      const addresses = [...new Set([...this.#addressTxs.keys()].filter((address) => this.#rewardAccountOf(address) === match![1]))];
      return ok(this.#page(addresses.map((address) => ({ address })), query));
    }
    if ((match = /^accounts\/([^/]+)\/registrations$/.exec(path))) {
      return ok(this.#page((this.#stake.get(match[1])?.registrations ?? []).map(({ txHash, action }) => ({ tx_hash: txHash, action })), query));
    }
    if ((match = /^accounts\/([^/]+)\/(rewards|withdrawals|delegations|history|mirs)$/.exec(path))) return ok([]);
    if ((match = /^accounts\/([^/]+)$/.exec(path))) {
      const account = this.#account(match[1]);
      return account ? ok(account) : notFound;
    }
    if ((match = /^scripts\/([0-9a-f]{56})\/cbor$/.exec(path))) {
      const utxo = this.#referenceScript(match[1]);
      return utxo ? ok({ cbor: utxo.referenceScriptCode }) : notFound;
    }
    if ((match = /^scripts\/([0-9a-f]{56})$/.exec(path))) {
      const utxo = this.#referenceScript(match[1]);
      return utxo ? ok({ script_hash: match[1], type: "plutusV3", serialised_size: utxo.referenceScriptSize }) : notFound;
    }
    if ((match = /^txs\/([0-9a-f]{64})\/utxos$/.exec(path))) {
      const tx = this.#txs.get(match[1]);
      if (!tx) return notFound;
      const consumedBy = (utxo: Utxo) => [...this.#txs.values()].find((candidate) => candidate.inputs.some((input) => !input.collateral && !input.reference && input.txHash === utxo.txHash && input.index === utxo.index))?.hash ?? null;
      return ok({
        hash: tx.hash,
        inputs: tx.inputs.map((input) => ({ address: input.address, amount: input.amount, tx_hash: input.txHash, output_index: input.index, data_hash: input.dataHash, inline_datum: input.inlineDatum, reference_script_hash: input.referenceScriptHash, collateral: input.collateral, reference: input.reference })),
        outputs: tx.outputs.map((output) => ({ address: output.address, amount: output.amount, output_index: output.index, data_hash: output.dataHash, inline_datum: output.inlineDatum, collateral: false, reference_script_hash: output.referenceScriptHash, consumed_by_tx: consumedBy(output) })),
      });
    }
    if ((match = /^txs\/([0-9a-f]{64})\/cbor$/.exec(path))) {
      const tx = this.#txs.get(match[1]);
      return tx?.cbor ? ok({ cbor: tx.cbor }) : notFound;
    }
    if ((match = /^txs\/([0-9a-f]{64})\/(metadata|redeemers|withdrawals|stakes|delegations|mirs|pool_updates|pool_retires|required_signers)$/.exec(path))) {
      return this.#txs.has(match[1]) ? ok([]) : notFound;
    }
    if ((match = /^txs\/([0-9a-f]{64})$/.exec(path))) {
      const tx = this.#txs.get(match[1]);
      return tx ? ok(this.#txContent(tx)) : notFound;
    }
    if (/^assets\//.test(path) || /^pools\//.test(path)) return notFound;
    return undefined;
  }

  /**
   * Serves the ledger to every page of the context, popups included, and
   * records which origin made each request.
   */
  async install(context: BrowserContext): Promise<void> {
    context.on("request", (request: Request) => {
      if (!request.url().startsWith(BLOCKFROST_ORIGIN)) return;
      let frameOrigin: string | undefined;
      try {
        frameOrigin = new URL(request.frame().url()).origin;
      } catch {
        frameOrigin = undefined;
      }
      const url = new URL(request.url());
      this.requests.push({ method: request.method(), path: url.pathname.replace(/^\/api\/v0\//, ""), frameOrigin, headerOrigin: request.headers().origin });
    });
    await context.route(`${BLOCKFROST_ORIGIN}/**`, async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname.replace(/^\/api\/v0\//, "");
      const answer = this.answer(request.method(), path, url.searchParams, request.postDataBuffer());
      if (!answer) this.unknownPaths.add(`${request.method()} ${path}`);
      const { status, json } = answer ?? { status: 404, json: { status_code: 404, error: "Not Found", message: "Not served by the fake ledger" } };
      await route.fulfill({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(json) });
    });
  }
}
