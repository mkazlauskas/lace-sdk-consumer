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
} from "../../src/custody/preprod-time";

// A small Cardano Preprod ledger behind the Blockfrost API, for browser tests.
// It holds UTxOs with inline datums, applies submitted transactions after
// checking their inputs, value balance, validity interval and vkey
// signatures, tracks stake registration and rewards, and answers script
// evaluation with fixed per-redeemer budgets. It does not run Plutus
// scripts: validator rules are not checked here.

// The published SDK's ESM build imports `lodash/*` subpaths without a file
// extension, which Node's ESM resolver refuses; its CommonJS build loads.
// Its bundled libsodium looks for `window` or `self` before Node's crypto.
(globalThis as { self?: unknown }).self ??= globalThis;
const sdk = createRequire(import.meta.url)("@input-output-hk/lace-sdk/cardano") as typeof import("@input-output-hk/lace-sdk/cardano");
// `Cardano` and `Serialization` are typed from `@cardano-sdk/core`, which the
// published package does not install, so they are `any` to a consumer.
const { Cardano, Serialization } = sdk;

export const BLOCKFROST_ORIGIN = "https://cardano-preprod.blockfrost.io";
const CUSTODY_POLICY_ID = "0524f57b785cf3a45b7ed6029b387dc39ffb2411bd1cb4300c58c2c3";
/** Where test funds come from: a key nobody holds. */
const FAUCET_ADDRESS: string = Cardano.EnterpriseAddress.fromCredentials(Cardano.NetworkId.Testnet, { type: Cardano.CredentialType.KeyHash, hash: "fa".repeat(28) })
  .toAddress()
  .toBech32();
const KEY_DEPOSIT = 2_000_000n;

const parameters = JSON.parse(readFileSync(new URL("./fixtures/preprod-parameters.json", import.meta.url), "utf8")) as Record<string, unknown>;

type Amount = { unit: string; quantity: string };
type Output = {
  address: string;
  amount: Amount[];
  dataHash: string | null;
  inlineDatum: string | null;
  referenceScriptHash: string | null;
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
  withdrawalCount: number;
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

export type SubmissionRecord = { txHash: string; accepted: boolean; message?: string };
export type BlockfrostRequest = { method: string; path: string; frameOrigin: string | undefined; headerOrigin: string | undefined };

const outpointKey = (txHash: string, index: number) => `${txHash}#${index}`;
const blake2b256 = (hex: string) => bytesToHex(blake2b(hexToBytes(hex), { dkLen: 32 }));

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

  /** POSIX milliseconds of the ledger's clock; the tip follows it. */
  constructor(readonly now: () => number = Date.now) {
    this.#addBlock([]);
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

  /** Fee and deposit of an applied transaction. */
  transaction(hash: string): { fee: bigint; deposit: bigint } | undefined {
    const tx = this.#txs.get(hash);
    return tx && { fee: tx.fee, deposit: tx.deposit };
  }

  utxosAt(address: string): Utxo[] {
    return [...this.#utxos.values()].filter((utxo) => utxo.address === address);
  }

  lovelaceAt(address: string): bigint {
    return this.utxosAt(address).reduce((total, utxo) => total + (assetsOfAmount(utxo.amount).get("lovelace") ?? 0n), 0n);
  }

  /** Pays `lovelace` to `address` from outside the ledger, in a block of its own. */
  fund(address: string, lovelace: bigint): string {
    const tx = Serialization.Transaction.fromCore({
      id: "0".repeat(64),
      body: {
        inputs: [{ txId: "fa".repeat(32), index: this.#faucetNonce++ }],
        outputs: [{ address, value: { coins: lovelace } }],
        fee: 0n,
      },
      witness: { signatures: new Map() },
    });
    const hash = tx.getId() as string;
    const block = this.#addBlock([hash]);
    const outputs = [{ txHash: hash, index: 0, address, amount: [{ unit: "lovelace", quantity: `${lovelace}` }], dataHash: null, inlineDatum: null, referenceScriptHash: null }];
    const faucetInput = { txHash: "fa".repeat(32), index: this.#faucetNonce - 1, address: FAUCET_ADDRESS, amount: outputs[0].amount, dataHash: null, inlineDatum: null, referenceScriptHash: null, collateral: false, reference: false };
    this.#record({ hash, cbor: tx.toCbor(), block, index: 0, fee: 0n, deposit: 0n, size: tx.toCbor().length / 2, inputs: [faucetInput], outputs, invalidBefore: null, invalidHereafter: null, withdrawalCount: 0, certificateCount: 0, mintCount: 0, redeemerCount: 0 });
    for (const output of outputs) this.#utxos.set(outpointKey(output.txHash, output.index), output);
    return hash;
  }

  /** Credits rewards to a registered reward account. */
  addRewards(rewardAccount: string, lovelace: bigint): void {
    const account = this.#stake.get(rewardAccount);
    if (!account?.registered) throw new Error(`${rewardAccount} is not registered`);
    account.rewards += lovelace;
  }

  #record(tx: LedgerTx) {
    this.#txs.set(tx.hash, tx);
    const addresses = new Set([...tx.inputs.map((input) => input.address), ...tx.outputs.map((output) => output.address)]);
    for (const address of addresses) this.#addressTxs.set(address, [...(this.#addressTxs.get(address) ?? []), tx.hash]);
  }

  // --- Transactions ---

  #resolve(txIn: { txId: string; index: number }, what: string): Utxo {
    const utxo = this.#utxos.get(outpointKey(txIn.txId, txIn.index));
    if (!utxo) throw new LedgerError(`${what} ${txIn.txId}#${txIn.index} is not an unspent output`);
    return utxo;
  }

  #outputOf(serialized: any, txHash: string, index: number): Utxo {
    const core = serialized.toCore();
    const inlineDatum: string | null = serialized.datum()?.asInlineData()?.toCbor() ?? null;
    const dataHash: string | null = inlineDatum ? blake2b256(inlineDatum) : (core.datumHash ?? null);
    const scriptRef = serialized.scriptRef();
    return {
      txHash,
      index,
      address: core.address,
      amount: amountOf(assetsOfValue(core.value)),
      // Blockfrost reports an inline datum's hash as `data_hash` too.
      dataHash,
      inlineDatum,
      referenceScriptHash: scriptRef ? scriptRef.hash() : null,
    };
  }

  #paymentKeyHash(address: string): string | undefined {
    const payment = Cardano.Address.fromString(address)?.getProps().paymentPart;
    return payment?.type === Cardano.CredentialType.KeyHash ? payment.hash : undefined;
  }

  #rewardAccountOf(address: string): string | undefined {
    const stake = Cardano.Address.fromString(address)?.asBase()?.getStakeCredential();
    return stake ? Cardano.RewardAccount.fromCredential(stake, Cardano.NetworkId.Testnet) : undefined;
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

    const inputs = body.inputs.map((input: { txId: string; index: number }) => this.#resolve(input, "Input"));
    const collaterals = (body.collaterals ?? []).map((input: { txId: string; index: number }) => this.#resolve(input, "Collateral"));
    const references = (body.referenceInputs ?? []).map((input: { txId: string; index: number }) => this.#resolve(input, "Reference input"));
    if ((core.witness.redeemers ?? []).length > 0 && collaterals.length === 0) throw new LedgerError("NoCollateralInputs");

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
      const account = this.#stake.get(stakeAddress);
      if (!account?.registered || account.rewards !== quantity) throw new LedgerError(`WithdrawalsNotInRewardsCERTS: ${stakeAddress} ${quantity}`);
      addAssets(consumed, new Map([["lovelace", quantity]]));
    }
    for (const [assetId, quantity] of body.mint ?? new Map()) addAssets(consumed, new Map([[assetId as string, quantity as bigint]]));
    const outputs: Utxo[] = tx.body().outputs().map((output: unknown, index: number) => this.#outputOf(output, hash, index));
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

    // Apply.
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
      withdrawalCount: (body.withdrawals ?? []).length,
      certificateCount: (body.certificates ?? []).length,
      mintCount: body.mint?.size ?? 0,
      redeemerCount: (core.witness.redeemers ?? []).length,
    });
    return hash;
  }

  /** Fixed budgets per redeemer, larger for the custody control input. */
  evaluate(cborHex: string): Record<string, { memory: number; steps: number }> {
    const tx = Serialization.Transaction.fromCbor(Serialization.TxCBOR(cborHex));
    const core = tx.toCore();
    const sortedInputs = [...core.body.inputs].sort((a: { txId: string; index: number }, b: { txId: string; index: number }) =>
      a.txId === b.txId ? a.index - b.index : a.txId < b.txId ? -1 : 1,
    );
    const result: Record<string, { memory: number; steps: number }> = {};
    for (const { purpose, index } of core.witness.redeemers ?? []) {
      let budget = { memory: 500_000, steps: 180_000_000 };
      if (purpose === Cardano.RedeemerPurpose.spend) {
        const input = sortedInputs[index];
        if (!input) throw new LedgerError(`No input at redeemer index ${index}`);
        const utxo = this.#resolve(input, "Input");
        const isControl = utxo.amount.some(({ unit }) => unit.startsWith(CUSTODY_POLICY_ID));
        budget = isControl ? { memory: 1_400_000, steps: 520_000_000 } : { memory: 240_000, steps: 90_000_000 };
      } else if (purpose === Cardano.RedeemerPurpose.mint) {
        budget = { memory: 620_000, steps: 210_000_000 };
      }
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
      active: account.registered,
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
      withdrawal_count: tx.withdrawalCount,
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
      return tx ? ok({ cbor: tx.cbor }) : notFound;
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
