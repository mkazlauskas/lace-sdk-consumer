import {
  Cardano,
  CardanoCustodySponsorError,
  HexBlob,
  Serialization,
  type CardanoCustodySponsor,
  type CardanoCustodySponsorCollateral,
  type CardanoCustodySponsorLease,
} from "@input-output-hk/lace-sdk/cardano";
import { CUSTODY_ACCOUNT_SCRIPT_HASH } from "./custody-contract";
import { generateDevKey, type DevKey } from "./dev-key";
import { preprodSlotAt } from "./preprod-time";

// A development stand-in for the Cardano account custody fee sponsor
// service. It implements the SDK's `CardanoCustodySponsor` interface with an
// in-memory Ed25519 key, reads its own UTxOs and the inputs it is asked to
// sign over from Blockfrost, and applies the service's transaction policy
// before it signs, except that it neither evaluates scripts nor checks for
// foreign scripts. It never submits. Preprod test ADA only: the key is lost
// on reload.

/** Defaults of the fee sponsor service. */
export const DEV_SPONSOR_LIMITS = {
  leaseTtlSeconds: 600,
  validityMarginSeconds: 120,
  collateralValiditySeconds: 600,
  maxSponsoredLovelace: 6_000_000n,
  maxFeeLovelace: 2_000_000n,
  collateralLovelace: 5_000_000n,
  minFeeUtxoLovelace: 10_000_000n,
  /**
   * A witnessed fee UTxO the chain still lists is free again once the
   * current slot is this many slots past the witnessed validity bound.
   */
  releaseMarginSlots: 120,
} as const;

export type DevCustodySponsor = CardanoCustodySponsor & {
  address: Cardano.PaymentAddress;
  keyHash: string;
  /** The sponsor's lovelace-only UTxOs as Blockfrost reports them now. */
  utxos(): Promise<Cardano.Utxo[]>;
};

export type CreateDevCustodySponsorProps = {
  /** Blockfrost base URL without the `/api/v0` suffix. */
  blockfrostUrl: string;
  projectId: string;
  key?: DevKey;
  fetch?: typeof fetch;
  now?: () => number;
};

type Lease = CardanoCustodySponsorLease & {
  consumed?: { txId: string; witnessSet: HexBlob; invalidHereafter: number };
};

type BlockfrostAmount = { unit: string; quantity: string };
type BlockfrostUtxo = {
  tx_hash: string;
  output_index: number;
  amount: BlockfrostAmount[];
  data_hash: string | null;
  inline_datum: string | null;
  reference_script_hash: string | null;
};
type BlockfrostTxOutput = { output_index: number; address: string; amount: BlockfrostAmount[]; collateral?: boolean };

type TxIn = { txId: string; index: number };
type TxOut = {
  address: string;
  value: { coins: bigint; assets?: Map<string, bigint> };
  datum?: unknown;
  datumHash?: string;
  scriptReference?: unknown;
};
type Credential = { type: number; hash: string };
type Certificate = { __typename: string; deposit?: bigint; stakeCredential?: Credential };

/**
 * The body fields the sponsor rules read. The published SDK types
 * `Serialization` from `@cardano-sdk/core`, which the package does not
 * install, so a consumer names the shape it relies on.
 */
type TxBodyView = {
  inputs: TxIn[];
  outputs: TxOut[];
  fee: bigint;
  collaterals?: TxIn[];
  collateralReturn?: TxOut;
  totalCollateral?: bigint;
  validityInterval?: { invalidBefore?: number; invalidHereafter?: number };
  requiredExtraSignatures?: string[];
  certificates?: Certificate[];
  mint?: Map<string, bigint>;
  withdrawals?: { stakeAddress: string; quantity: bigint }[];
};

/** Asset quantities keyed by Blockfrost unit, lovelace under `lovelace`. */
type Assets = Map<string, bigint>;
/** An input with the output it spends, when Blockfrost knows that output. */
type ResolvedInput = { ref: string; output?: { address: string; assets: Assets } };
/** What an account creation draws from the sponsor beyond the fee. */
type Creation = { deposit: bigint; controlLovelace: bigint };

type Mode = { kind: "fee"; lease: Lease } | { kind: "collateral"; collateral: Cardano.Utxo };

const outpoint = ({ txId, index }: TxIn) => `${txId}#${index}`;

// Declared with its type so that a call narrows like a `throw`.
const refuse: (rule: string, detail: string) => never = (rule, detail) => {
  throw new CardanoCustodySponsorError({ status: 422, code: "invalid_transaction", rule, detail });
};

const credentialsOf = (address: string): { payment?: Credential; stake?: Credential } => {
  try {
    const props = Cardano.Address.fromString(address)?.getProps();
    return { payment: props?.paymentPart, stake: props?.delegationPart };
  } catch {
    return {};
  }
};

const isScript = (credential: Credential | undefined, hash?: string): credential is Credential =>
  credential !== undefined && credential.type === Cardano.CredentialType.ScriptHash && (hash === undefined || credential.hash === hash);

/** An account address: one paying to the account script. */
const isAccountAddress = (address: string) => isScript(credentialsOf(address).payment, CUSTODY_ACCOUNT_SCRIPT_HASH);

const assetsOfValue = ({ coins, assets }: TxOut["value"]): Assets => new Map([["lovelace", coins], ...(assets ?? new Map())]);

const assetsOfAmount = (amount: BlockfrostAmount[]): Assets => new Map(amount.map(({ unit, quantity }) => [unit, BigInt(quantity)]));

const addAssets = (target: Assets, source: Assets) => {
  for (const [unit, quantity] of source) target.set(unit, (target.get(unit) ?? 0n) + quantity);
};

/** An account's control UTxO: at an account address and holding a token of the account policy. */
const isControlOutput = ({ address, assets }: { address: string; assets: Assets }) =>
  isAccountAddress(address) && [...assets].some(([unit, quantity]) => unit.startsWith(CUSTODY_ACCOUNT_SCRIPT_HASH) && quantity > 0n);

/**
 * The account a transaction creates, or why it creates none: exactly one
 * token minted under the account policy, exactly one script stake
 * registration with an explicit deposit, the token named after that
 * credential, and the token in exactly one output at an account address
 * staked to that credential.
 */
const readCreation = (body: TxBodyView): Creation | string => {
  const minted = [...(body.mint ?? new Map())].filter(([assetId]) => assetId.startsWith(CUSTODY_ACCOUNT_SCRIPT_HASH));
  if (minted.length === 0) return "No input is an account control UTxO and nothing is minted under the account policy";
  const [assetId, quantity] = minted[0];
  if (minted.length !== 1 || quantity !== 1n) return "An account creation mints exactly one token under the account policy";
  const registrations = (body.certificates ?? []).filter(
    (certificate) => certificate.__typename === Cardano.CertificateType.Registration && isScript(certificate.stakeCredential) && certificate.deposit !== undefined,
  );
  if (registrations.length !== 1) return "An account creation registers exactly one script stake credential with its deposit";
  const [{ stakeCredential, deposit }] = registrations;
  if (assetId.slice(CUSTODY_ACCOUNT_SCRIPT_HASH.length) !== stakeCredential!.hash) return "The minted state NFT must be named after the registered stake credential";
  const holders = body.outputs.filter((output) => output.value.assets?.get(assetId) === 1n);
  if (holders.length !== 1 || !isAccountAddress(holders[0].address)) return "The minted state NFT must sit in exactly one output at an account address";
  if (credentialsOf(holders[0].address).stake?.hash !== stakeCredential!.hash) return "The control output must be staked to the registered stake credential";
  return { deposit: deposit!, controlLovelace: holders[0].value.coins };
};

export function createDevCustodySponsor({
  blockfrostUrl,
  projectId,
  key = generateDevKey(),
  fetch: fetchImpl = globalThis.fetch.bind(globalThis),
  now = Date.now,
}: CreateDevCustodySponsorProps): DevCustodySponsor {
  const address = Cardano.EnterpriseAddress.fromCredentials(Cardano.NetworkId.Testnet, {
    type: Cardano.CredentialType.KeyHash,
    // The SDK does not export the branded hash constructors.
    hash: key.keyHash as never,
  })
    .toAddress()
    .toBech32() as Cardano.PaymentAddress;
  const leases = new Map<string, Lease>();
  const collateralWitnesses = new Map<string, HexBlob>();

  const blockfrost = (path: string) => fetchImpl(`${blockfrostUrl}/api/v0/${path}`, { headers: { project_id: projectId } });

  const utxos = async (): Promise<Cardano.Utxo[]> => {
    const response = await blockfrost(`addresses/${address}/utxos?order=asc&count=100&page=1`);
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new CardanoCustodySponsorError({ status: 503, code: "no_utxo_available", detail: `Blockfrost answered ${response.status}` });
    }
    const items = (await response.json()) as BlockfrostUtxo[];
    return items
      .filter((item) => item.amount.length === 1 && item.amount[0].unit === "lovelace" && !item.data_hash && !item.inline_datum && !item.reference_script_hash)
      .map((item): Cardano.Utxo => [
        { txId: Cardano.TransactionId(item.tx_hash), index: item.output_index, address },
        { address, value: { coins: BigInt(item.amount[0].quantity) } },
      ]);
  };

  /** The outputs the inputs spend, read from Blockfrost once per transaction. */
  const resolveInputs = async (inputs: TxIn[]): Promise<ResolvedInput[]> => {
    const byTx = new Map<string, Promise<BlockfrostTxOutput[] | undefined>>();
    const outputsOf = (txId: string) => {
      if (!byTx.has(txId)) {
        byTx.set(
          txId,
          blockfrost(`txs/${txId}/utxos`).then(async (response) => {
            if (response.status === 404) return undefined;
            if (!response.ok) throw new CardanoCustodySponsorError({ status: 503, code: "provider_unavailable", detail: `Blockfrost answered ${response.status}` });
            return ((await response.json()) as { outputs: BlockfrostTxOutput[] }).outputs;
          }),
        );
      }
      return byTx.get(txId)!;
    };
    return Promise.all(
      inputs.map(async (input) => {
        const output = (await outputsOf(input.txId))?.find((candidate) => candidate.output_index === input.index && !candidate.collateral);
        return { ref: outpoint(input), output: output && { address: output.address, assets: assetsOfAmount(output.amount) } };
      }),
    );
  };

  /** The shared collateral: the oldest UTxO of exactly the collateral size. */
  const sharedCollateral = (available: Cardano.Utxo[]): Cardano.Utxo => {
    const collateral = available.find(([, output]) => output.value.coins === DEV_SPONSOR_LIMITS.collateralLovelace);
    if (!collateral) {
      throw new CardanoCustodySponsorError({ status: 503, code: "no_utxo_available", detail: `Fund ${address} with a ${DEV_SPONSOR_LIMITS.collateralLovelace} lovelace collateral UTxO` });
    }
    return collateral;
  };

  const witnessSetOf = (bodyHash: string): HexBlob =>
    HexBlob(
      Serialization.TransactionWitnessSet.fromCore({
        signatures: new Map([[key.publicKey, key.signHash(bodyHash)]]) as never,
      }).toCbor(),
    );

  /** Whether an address pays to the sponsor key, at any base, enterprise or pointer address. */
  const paysSponsorKey = (candidate: string): boolean => {
    const { payment } = credentialsOf(candidate);
    return payment !== undefined && payment.type === Cardano.CredentialType.KeyHash && payment.hash === key.keyHash;
  };

  const decode = (transaction: HexBlob): { txId: string; body: TxBodyView } => {
    try {
      const tx = Serialization.Transaction.fromCbor(Serialization.TxCBOR(transaction));
      return { txId: tx.getId(), body: tx.body().toCore() as TxBodyView };
    } catch {
      return refuse("well_formed", "The transaction does not decode");
    }
  };

  /** Whether a lease still holds its fee UTxO: open, or witnessed and possibly still on its way to the chain. */
  const holdsFeeUtxo = (lease: Lease): boolean =>
    lease.consumed ? preprodSlotAt(now()) <= lease.consumed.invalidHereafter + DEV_SPONSOR_LIMITS.releaseMarginSlots : lease.expiresAt > now();

  /**
   * The service's transaction policy, in its order: sponsor inputs,
   * collateral, validity, account transaction, sponsor outflow, sponsor
   * value elsewhere, inputs that resolve, and signers.
   */
  const checkPolicy = async (body: TxBodyView, mode: Mode): Promise<void> => {
    const available = await utxos();
    const sponsorOutpoints = new Set(available.map((utxo) => outpoint(utxo[0])));
    const inputs = await resolveInputs(body.inputs);
    const isSponsorInput = (input: ResolvedInput) => sponsorOutpoints.has(input.ref) || (input.output !== undefined && paysSponsorKey(input.output.address));

    // uses_leased_fee_input in fee mode, no_sponsor_inputs in collateral mode.
    const inputsRule = mode.kind === "fee" ? "uses_leased_fee_input" : "no_sponsor_inputs";
    const unreadable = inputs.find((input) => input.output && !credentialsOf(input.output.address).payment);
    if (unreadable) refuse(inputsRule, `Input ${unreadable.ref} has no readable payment credential`);
    const sponsorInputs = inputs.filter(isSponsorInput);
    if (mode.kind === "fee") {
      const feeOutpoint = outpoint(mode.lease.feeUtxo[0]);
      if (!inputs.some((input) => input.ref === feeOutpoint)) refuse(inputsRule, "The leased fee UTxO is not spent");
      if (sponsorInputs.some((input) => input.ref !== feeOutpoint)) refuse(inputsRule, "The transaction spends another sponsor UTxO");
    } else if (sponsorInputs.length > 0) {
      refuse(inputsRule, "The transaction spends a sponsor UTxO");
    }

    // uses_shared_collateral
    const collateral = mode.kind === "fee" ? mode.lease.collateralUtxo : mode.collateral;
    const collaterals = body.collaterals ?? [];
    if (collaterals.length !== 1 || outpoint(collaterals[0]) !== outpoint(collateral[0])) {
      refuse("uses_shared_collateral", "The collateral inputs are not exactly the shared collateral UTxO");
    }
    const collateralReturn = body.collateralReturn;
    if (!collateralReturn || collateralReturn.address !== address || collateralReturn.datum || collateralReturn.datumHash || collateralReturn.scriptReference) {
      refuse("uses_shared_collateral", "The collateral return does not pay the sponsor address as plain lovelace");
    }
    if (body.totalCollateral === undefined || body.totalCollateral > collateral[1].value.coins) {
      refuse("uses_shared_collateral", "Total collateral is not set within the collateral UTxO");
    }

    // bounded_validity
    const latestValidityMs =
      mode.kind === "fee"
        ? mode.lease.expiresAt + DEV_SPONSOR_LIMITS.validityMarginSeconds * 1000
        : now() + DEV_SPONSOR_LIMITS.collateralValiditySeconds * 1000;
    const upperBound = body.validityInterval?.invalidHereafter;
    if (upperBound === undefined || upperBound <= preprodSlotAt(now()) || upperBound > preprodSlotAt(latestValidityMs)) {
      refuse("bounded_validity", `Validity upper bound ${upperBound} is outside the sponsor window`);
    }

    // account_transaction
    const nonSponsorInputs = inputs.filter((input) => !isSponsorInput(input));
    const operatesAccount = nonSponsorInputs.some((input) => input.output && isControlOutput(input.output));
    const creation = operatesAccount ? undefined : readCreation(body);
    if (typeof creation === "string") refuse("account_transaction", creation);

    // sponsor_outflow_bounded in fee mode, sponsor_outflow_zero in collateral mode.
    if (mode.kind === "fee") {
      if (body.fee > DEV_SPONSOR_LIMITS.maxFeeLovelace) refuse("sponsor_outflow_bounded", `Fee ${body.fee} is above ${DEV_SPONSOR_LIMITS.maxFeeLovelace}`);
      const toSponsor = body.outputs.filter((output) => output.address === address);
      if (toSponsor.some((output) => output.datum || output.datumHash || output.scriptReference || (output.value.assets?.size ?? 0) > 0)) {
        refuse("sponsor_outflow_bounded", "An output to the sponsor is not plain lovelace");
      }
      if (toSponsor.length !== 1) refuse("sponsor_outflow_bounded", `The transaction pays the sponsor ${toSponsor.length} outputs where exactly one change output is expected`);
      const draw = mode.lease.feeUtxo[1].value.coins - toSponsor[0].value.coins;
      const expectedDraw = body.fee + (creation ? creation.deposit + creation.controlLovelace : 0n);
      if (draw !== expectedDraw) {
        refuse("sponsor_outflow_bounded", `The fee UTxO is drawn down by ${draw}, but ${creation ? "the fee, the deposit and the control output" : "the fee"} account for ${expectedDraw}`);
      }
      if (draw > mode.lease.maxSponsoredLovelace) refuse("sponsor_outflow_bounded", `Sponsoring ${draw} lovelace exceeds ${mode.lease.maxSponsoredLovelace}`);
    } else if (body.outputs.some((output) => paysSponsorKey(output.address))) {
      refuse("sponsor_outflow_zero", "An output pays the sponsor, which contributes collateral only");
    }

    // no_sponsor_value_elsewhere. This sponsor holds no stake key, so every withdrawal is someone else's.
    const supply: Assets = new Map();
    for (const input of nonSponsorInputs) if (input.output) addAssets(supply, input.output.assets);
    for (const { quantity } of body.withdrawals ?? []) addAssets(supply, new Map([["lovelace", quantity]]));
    const demand: Assets = new Map();
    for (const output of body.outputs) {
      if (output.address !== address && !isAccountAddress(output.address)) addAssets(demand, assetsOfValue(output.value));
    }
    for (const [unit, demanded] of demand) {
      const supplied = supply.get(unit) ?? 0n;
      if (demanded > supplied) refuse("no_sponsor_value_elsewhere", `Outputs away from the sponsor and the account need ${demanded} ${unit} but the non sponsor inputs supply ${supplied}`);
    }

    // evaluates: this sponsor runs no scripts, but every input must exist.
    const unresolved = inputs.find((input) => !input.output);
    if (unresolved) refuse("evaluates", `Input ${unresolved.ref} does not resolve`);

    // signers
    if ((body.requiredExtraSignatures ?? []).includes(key.keyHash)) refuse("signers", "The sponsor key is a required signer");
    if ((body.certificates ?? []).some((certificate) => certificate.stakeCredential?.hash === key.keyHash)) refuse("signers", "A certificate names the sponsor key");
  };

  return {
    address,
    keyHash: key.keyHash,
    utxos,

    async lease() {
      const available = await utxos();
      const unspent = new Set(available.map((utxo) => outpoint(utxo[0])));
      // A lease is forgotten once its fee UTxO is spent, it expired unused,
      // or its witnessed transaction can no longer reach the chain.
      for (const [leaseId, lease] of leases) {
        if (!unspent.has(outpoint(lease.feeUtxo[0])) || !holdsFeeUtxo(lease)) leases.delete(leaseId);
      }
      const collateralUtxo = sharedCollateral(available);
      const leased = new Set([...leases.values()].map((lease) => outpoint(lease.feeUtxo[0])));
      const feeUtxo = available
        .filter((utxo) => outpoint(utxo[0]) !== outpoint(collateralUtxo[0]) && !leased.has(outpoint(utxo[0])))
        .filter(([, output]) => output.value.coins >= DEV_SPONSOR_LIMITS.minFeeUtxoLovelace)
        .sort(([, a], [, b]) => (b.value.coins > a.value.coins ? 1 : -1))[0];
      if (!feeUtxo) {
        throw new CardanoCustodySponsorError({ status: 503, code: "no_utxo_available", detail: `Fund ${address} with a fee UTxO of at least ${DEV_SPONSOR_LIMITS.minFeeUtxoLovelace} lovelace` });
      }
      const lease: Lease = {
        leaseId: crypto.randomUUID(),
        expiresAt: now() + DEV_SPONSOR_LIMITS.leaseTtlSeconds * 1000,
        feeUtxo,
        collateralUtxo,
        sponsorAddress: address,
        maxSponsoredLovelace: DEV_SPONSOR_LIMITS.maxSponsoredLovelace,
      };
      leases.set(lease.leaseId, lease);
      return lease;
    },

    async signLeased(leaseId, transaction) {
      const lease = leases.get(leaseId);
      if (!lease) throw new CardanoCustodySponsorError({ status: 404, code: "unknown_lease" });
      const { txId, body } = decode(transaction);
      if (lease.consumed) {
        if (lease.consumed.txId === txId) return lease.consumed.witnessSet;
        throw new CardanoCustodySponsorError({ status: 409, code: "lease_consumed" });
      }
      if (lease.expiresAt <= now()) throw new CardanoCustodySponsorError({ status: 410, code: "lease_expired" });
      await checkPolicy(body, { kind: "fee", lease });
      const witnessSet = witnessSetOf(txId);
      // The policy checked the bound is set.
      lease.consumed = { txId, witnessSet, invalidHereafter: body.validityInterval!.invalidHereafter! };
      return witnessSet;
    },

    async releaseLease(leaseId) {
      const lease = leases.get(leaseId);
      if (!lease) return;
      if (lease.consumed) throw new CardanoCustodySponsorError({ status: 409, code: "lease_consumed" });
      leases.delete(leaseId);
    },

    async collateral(): Promise<CardanoCustodySponsorCollateral> {
      return {
        collateralUtxo: sharedCollateral(await utxos()),
        sponsorAddress: address,
        validitySeconds: DEV_SPONSOR_LIMITS.collateralValiditySeconds,
      };
    },

    async signCollateral(transaction) {
      const { txId, body } = decode(transaction);
      const known = collateralWitnesses.get(txId);
      if (known) return known;
      await checkPolicy(body, { kind: "collateral", collateral: sharedCollateral(await utxos()) });
      const witnessSet = witnessSetOf(txId);
      collateralWitnesses.set(txId, witnessSet);
      return witnessSet;
    },
  };
}
