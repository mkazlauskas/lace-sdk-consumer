import {
  Cardano,
  CardanoCustodySponsorError,
  HexBlob,
  Serialization,
  type CardanoCustodySponsor,
  type CardanoCustodySponsorCollateral,
  type CardanoCustodySponsorLease,
} from "@input-output-hk/lace-sdk/cardano";
import { generateDevKey, type DevKey } from "./dev-key";
import { preprodSlotAt } from "./preprod-time";

// A development stand-in for the Cardano account custody fee sponsor
// service. It implements the SDK's `CardanoCustodySponsor` interface with an
// in-memory Ed25519 key and the sponsor's UTxOs read from Blockfrost, and it
// checks the service's policy rules that concern its own funds before it
// signs. It never submits. Preprod test ADA only: the key is lost on reload.

/** Defaults of the fee sponsor service. */
export const DEV_SPONSOR_LIMITS = {
  leaseTtlSeconds: 600,
  validityMarginSeconds: 120,
  collateralValiditySeconds: 600,
  maxSponsoredLovelace: 6_000_000n,
  maxFeeLovelace: 2_000_000n,
  collateralLovelace: 5_000_000n,
  minFeeUtxoLovelace: 10_000_000n,
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

type Lease = CardanoCustodySponsorLease & { consumed?: { txId: string; witnessSet: HexBlob } };

type BlockfrostUtxo = {
  tx_hash: string;
  output_index: number;
  amount: { unit: string; quantity: string }[];
  data_hash: string | null;
  inline_datum: string | null;
  reference_script_hash: string | null;
};

type TxIn = { txId: string; index: number };
type TxOut = {
  address: string;
  value: { coins: bigint; assets?: Map<string, bigint> };
  datum?: unknown;
  datumHash?: string;
  scriptReference?: unknown;
};
type Certificate = { __typename: string; deposit?: bigint };

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
};

const outpoint = ({ txId, index }: TxIn) => `${txId}#${index}`;

const refuse = (rule: string, detail: string): never => {
  throw new CardanoCustodySponsorError({ status: 422, code: "invalid_transaction", rule, detail });
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

  const utxos = async (): Promise<Cardano.Utxo[]> => {
    const response = await fetchImpl(`${blockfrostUrl}/api/v0/addresses/${address}/utxos?order=asc&count=100&page=1`, {
      headers: { project_id: projectId },
    });
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

  const isSponsorAddress = (candidate: string): boolean => {
    try {
      const payment = Cardano.Address.fromString(candidate)?.getProps().paymentPart;
      return payment?.type === Cardano.CredentialType.KeyHash && payment.hash === key.keyHash;
    } catch {
      return false;
    }
  };

  const decode = (transaction: HexBlob): { txId: string; body: TxBodyView } => {
    try {
      const tx = Serialization.Transaction.fromCbor(Serialization.TxCBOR(transaction));
      return { txId: tx.getId(), body: tx.body().toCore() as TxBodyView };
    } catch {
      return refuse("well_formed", "The transaction does not decode");
    }
  };

  /** Rules both modes share: collateral, validity and signers. */
  const checkShared = (body: TxBodyView, collateral: Cardano.Utxo, latestValidityMs: number) => {
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
    const upperBound = body.validityInterval?.invalidHereafter;
    if (upperBound === undefined || upperBound <= preprodSlotAt(now()) || upperBound > preprodSlotAt(latestValidityMs)) {
      refuse("bounded_validity", `Validity upper bound ${upperBound} is outside the sponsor window`);
    }
    if ((body.requiredExtraSignatures ?? []).some((signer) => signer === key.keyHash)) {
      refuse("signers", "The sponsor key is a required signer");
    }
  };

  const deposits = (body: TxBodyView, keyDeposit: bigint): bigint =>
    (body.certificates ?? []).reduce((total, certificate) => {
      if (certificate.__typename === Cardano.CertificateType.Registration) return total + (certificate.deposit ?? 0n);
      if (certificate.__typename === Cardano.CertificateType.StakeRegistration) return total + keyDeposit;
      return total;
    }, 0n);

  return {
    address,
    keyHash: key.keyHash,
    utxos,

    async lease() {
      const available = await utxos();
      const collateralUtxo = sharedCollateral(available);
      // A consumed lease keeps its fee UTxO until the chain shows it spent.
      const leased = new Set([...leases.values()].filter((lease) => lease.consumed || lease.expiresAt > now()).map((lease) => outpoint(lease.feeUtxo[0])));
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

      const feeOutpoint = outpoint(lease.feeUtxo[0]);
      if (!body.inputs.some((input) => outpoint(input) === feeOutpoint)) {
        refuse("uses_leased_fee_input", "The leased fee UTxO is not spent");
      }
      const sponsorOutpoints = new Set((await utxos()).map((utxo) => outpoint(utxo[0])));
      if (body.inputs.some((input) => outpoint(input) !== feeOutpoint && sponsorOutpoints.has(outpoint(input)))) {
        refuse("uses_leased_fee_input", "The transaction spends another sponsor UTxO");
      }
      checkShared(body, lease.collateralUtxo, lease.expiresAt + DEV_SPONSOR_LIMITS.validityMarginSeconds * 1000);

      if (body.fee > DEV_SPONSOR_LIMITS.maxFeeLovelace) refuse("sponsor_outflow_bounded", `Fee ${body.fee} is above ${DEV_SPONSOR_LIMITS.maxFeeLovelace}`);
      const toSponsor = body.outputs.filter((output) => isSponsorAddress(output.address));
      if (toSponsor.length !== 1 || toSponsor[0].address !== address || toSponsor[0].datum || toSponsor[0].datumHash || toSponsor[0].scriptReference || (toSponsor[0].value.assets?.size ?? 0) > 0) {
        refuse("sponsor_outflow_bounded", "Exactly one plain lovelace output must return the change to the sponsor");
      }
      const draw = lease.feeUtxo[1].value.coins - toSponsor[0].value.coins;
      const elsewhere = body.outputs.filter((output) => !isSponsorAddress(output.address)).reduce((total, output) => total + output.value.coins, 0n);
      // Stake key deposit of Preprod; the only certificate a creation carries states its own deposit.
      const expectedDraw = body.fee + deposits(body, 2_000_000n) + elsewhere;
      if (draw !== expectedDraw || draw > lease.maxSponsoredLovelace) {
        refuse("sponsor_outflow_bounded", `The fee UTxO is drawn down by ${draw}, expected ${expectedDraw} within ${lease.maxSponsoredLovelace}`);
      }

      const witnessSet = witnessSetOf(txId);
      lease.consumed = { txId, witnessSet };
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
      const available = await utxos();
      const sponsorOutpoints = new Set(available.map((utxo) => outpoint(utxo[0])));
      if (body.inputs.some((input) => sponsorOutpoints.has(outpoint(input)))) {
        refuse("no_sponsor_inputs", "The transaction spends a sponsor UTxO");
      }
      checkShared(body, sharedCollateral(available), now() + DEV_SPONSOR_LIMITS.collateralValiditySeconds * 1000);
      if (body.outputs.some((output) => isSponsorAddress(output.address))) {
        refuse("sponsor_outflow_zero", "An output pays the sponsor");
      }
      const witnessSet = witnessSetOf(txId);
      collateralWitnesses.set(txId, witnessSet);
      return witnessSet;
    },
  };
}
