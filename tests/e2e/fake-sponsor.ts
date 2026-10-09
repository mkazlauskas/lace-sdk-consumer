import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import type { BrowserContext, Route } from "@playwright/test";
import { generateDevKey } from "../../src/custody/dev-key";
import type { FakeLedger } from "./fake-ledger";

// A fake of the hosted fee sponsor's client API, served where the app's
// `/sponsor` relay forwards it. It answers the service's documented shapes
// (`GET /health`, `POST /v1/leases`, `DELETE /v1/leases/:id`,
// `POST /v1/leases/:id/witness`, `GET /v1/collateral`,
// `POST /v1/collateral/witness`) and its error body `{ error, rule?, detail? }`,
// and signs with an in-memory key whose UTxOs live on the fake ledger. Of
// the service's transaction policy it applies the rules a test needs to
// reach: the leased fee UTxO and the sponsor's change in fee mode, the
// shared collateral and its return, the known logic, and a logic run that
// draws nothing. The SDK checks the full policy before it asks.

(globalThis as { self?: unknown }).self ??= globalThis;
const sdk = createRequire(import.meta.url)("@input-output-hk/lace-sdk/cardano") as typeof import("@input-output-hk/lace-sdk/cardano");
const { Cardano, HexBlob, Serialization, CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH, CARDANO_CUSTODY_LOGIC_HASH } = sdk;

/** The service's defaults. */
const LEASE_TTL_MS = 600_000;
const COLLATERAL_VALIDITY_SECONDS = 600;
const MAX_SPONSORED_LOVELACE = 6_000_000;
const COLLATERAL_LOVELACE = 5_000_000n;

type TxIn = { txId: string; index: number };
type Lease = { leaseId: string; expiresAt: number; fee: TxIn; status: "open" | "released" | "consumed"; txId?: string; witnessSet?: string };
type Refusal = { status: number; error: string; rule?: string; detail?: string };
export type SponsorRequest = { method: string; path: string; authorization: string | undefined; cookie: string | undefined };

class Refused extends Error {
  readonly refusal: Refusal;
  constructor(refusal: Refusal) {
    super(refusal.detail ?? refusal.error);
    this.refusal = refusal;
  }
}
const invalid = (rule: string, detail: string) => new Refused({ status: 422, error: "invalid_transaction", rule, detail });
const outpoint = ({ txId, index }: TxIn) => `${txId}#${index}`;

export class FakeSponsor {
  readonly requests: SponsorRequest[] = [];
  readonly key = generateDevKey();
  readonly address: string = Cardano.EnterpriseAddress.fromCredentials(Cardano.NetworkId.Testnet, { type: Cardano.CredentialType.KeyHash, hash: this.key.keyHash as never })
    .toAddress()
    .toBech32();
  /** The logic scripts the service serves; any other is refused under `known_logic`. */
  knownLogics = new Set<string>([CARDANO_CUSTODY_LOGIC_HASH]);
  readonly #leases = new Map<string, Lease>();
  readonly #collateralWitnesses = new Map<string, string>();
  readonly ledger: FakeLedger;

  constructor(ledger: FakeLedger) {
    this.ledger = ledger;
  }

  /** The sponsor's lovelace-only UTxOs on the ledger, oldest first. */
  #utxos() {
    return this.ledger.utxosAt(this.address).filter((utxo) => utxo.amount.length === 1 && !utxo.inlineDatum && !utxo.referenceScriptHash);
  }

  #sharedCollateral() {
    const collateral = this.#utxos().find((utxo) => BigInt(utxo.amount[0].quantity) === COLLATERAL_LOVELACE);
    if (!collateral) throw new Refused({ status: 409, error: "no_utxo_available", detail: "The pool holds no collateral UTxO" });
    return collateral;
  }

  #utxoBody(utxo: { txHash: string; index: number; amount: { quantity: string }[] }) {
    return { txHash: utxo.txHash, index: utxo.index, address: this.address, lovelace: Number(utxo.amount[0].quantity) };
  }

  #witnessSet(txId: string): string {
    return Serialization.TransactionWitnessSet.fromCore({ signatures: new Map([[this.key.publicKey, this.key.signHash(txId)]]) } as never).toCbor();
  }

  #decode(transaction: unknown): { txId: string; body: any } {
    if (typeof transaction !== "string") throw new Refused({ status: 400, error: "invalid_request", detail: "transaction: Required" });
    try {
      const tx = Serialization.Transaction.fromCbor(Serialization.TxCBOR(transaction));
      return { txId: tx.getId(), body: tx.body().toCore() };
    } catch {
      throw invalid("well_formed", "The transaction does not decode");
    }
  }

  /** The rules both modes share: the shared collateral and its return, the known logic, and a logic run that draws nothing. */
  #checkShared(body: any) {
    const collateral = this.#sharedCollateral();
    const collaterals: TxIn[] = body.collaterals ?? [];
    if (collaterals.length !== 1 || outpoint(collaterals[0]) !== outpoint({ txId: collateral.txHash, index: collateral.index })) {
      throw invalid("uses_shared_collateral", "The collateral inputs are not exactly the shared collateral UTxO");
    }
    if (body.collateralReturn?.address !== this.address) throw invalid("uses_shared_collateral", "The collateral return does not pay the sponsor address");
    for (const { stakeAddress, quantity } of body.withdrawals ?? []) {
      const credential = Cardano.Address.fromString(stakeAddress)?.asReward()?.getPaymentCredential();
      if (credential && this.knownLogics.has(credential.hash) && quantity > 0n) {
        // The service's own words, which the SDK reads the logic and the balance from.
        throw invalid("no_foreign_scripts", `The withdrawal that runs logic ${credential.hash} draws ${quantity} lovelace, and a logic runs on a withdrawal of zero`);
      }
    }
    const control = [...body.inputs, ...(body.referenceInputs ?? [])]
      .map((txIn: TxIn) => this.ledger.output(txIn.txId, txIn.index))
      // The control UTxO holds the state NFT: an account token with a 28-byte name.
      .find((utxo) => utxo?.inlineDatum && utxo.amount.some(({ unit }) => unit.startsWith(CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH) && unit.length === 112));
    const datum = control?.inlineDatum ?? body.outputs.map((output: { datum?: unknown }) => output.datum).find(Boolean);
    const logic = typeof datum === "string" ? this.#logicOf(datum) : datum ? this.#logicOfCore(datum) : undefined;
    if (logic !== undefined && !this.knownLogics.has(logic)) {
      throw invalid("known_logic", `The control UTxO names logic ${logic}, which is not one of the logic scripts the service knows`);
    }
  }

  #logicOf(datumHex: string): string | undefined {
    return this.#logicOfCore(Serialization.PlutusData.fromCbor(HexBlob(datumHex)).toCore());
  }

  #logicOfCore(datum: unknown): string | undefined {
    const items = (datum as { fields?: { items?: unknown[] } }).fields?.items;
    const logic = items?.[0];
    return logic instanceof Uint8Array ? Buffer.from(logic).toString("hex") : undefined;
  }

  #signLeased(leaseId: string, transaction: unknown) {
    const lease = this.#leases.get(leaseId);
    if (!lease) throw new Refused({ status: 404, error: "unknown_lease", detail: `No lease ${leaseId} exists` });
    if (lease.status === "released") throw new Refused({ status: 410, error: "lease_expired", detail: `Lease ${leaseId} was released` });
    const { txId, body } = this.#decode(transaction);
    if (lease.status === "consumed") {
      if (lease.txId === txId) return { witnessSet: lease.witnessSet, leaseId };
      throw new Refused({ status: 409, error: "lease_consumed", detail: `Lease ${leaseId} already issued a witness` });
    }
    if (lease.expiresAt <= Date.now()) throw new Refused({ status: 410, error: "lease_expired", detail: `Lease ${leaseId} has expired` });
    if (!body.inputs.some((input: TxIn) => outpoint(input) === outpoint(lease.fee))) throw invalid("uses_leased_fee_input", "The leased fee UTxO is not spent");
    this.#checkShared(body);
    const change = body.outputs.filter((output: { address: string }) => output.address === this.address);
    if (change.length !== 1) throw invalid("sponsor_outflow_bounded", `The transaction pays the sponsor ${change.length} outputs where exactly one change output is expected`);
    const feeUtxo = this.ledger.output(lease.fee.txId, lease.fee.index)!;
    const draw = BigInt(feeUtxo.amount[0].quantity) - change[0].value.coins;
    if (draw > BigInt(MAX_SPONSORED_LOVELACE)) throw invalid("sponsor_outflow_bounded", `Sponsoring ${draw} lovelace exceeds ${MAX_SPONSORED_LOVELACE}`);
    Object.assign(lease, { status: "consumed", txId, witnessSet: this.#witnessSet(txId) });
    return { witnessSet: lease.witnessSet, leaseId };
  }

  #signCollateral(transaction: unknown) {
    const { txId, body } = this.#decode(transaction);
    const known = this.#collateralWitnesses.get(txId);
    if (known) return { witnessSet: known, txHash: txId };
    const sponsorInputs = body.inputs.filter((input: TxIn) => this.ledger.output(input.txId, input.index)?.address === this.address);
    if (sponsorInputs.length > 0) throw invalid("no_sponsor_inputs", "The transaction spends a sponsor UTxO");
    if (body.outputs.some((output: { address: string }) => output.address === this.address)) throw invalid("sponsor_outflow_zero", "An output pays the sponsor, which contributes collateral only");
    this.#checkShared(body);
    const witnessSet = this.#witnessSet(txId);
    this.#collateralWitnesses.set(txId, witnessSet);
    return { witnessSet, txHash: txId };
  }

  /** The answer to one client API request. */
  answer(method: string, path: string, body: unknown): { status: number; json: unknown } {
    try {
      let match: RegExpExecArray | null;
      if (method === "GET" && path === "/health") {
        const leased = [...this.#leases.values()].filter((lease) => lease.status === "open").length;
        const free = this.#utxos().filter((utxo) => BigInt(utxo.amount[0].quantity) !== COLLATERAL_LOVELACE).length - leased;
        return { status: 200, json: { ok: true, network: "preprod", pool: { fee: { free, leased }, collateral: { shared: this.#utxos().some((utxo) => BigInt(utxo.amount[0].quantity) === COLLATERAL_LOVELACE), spare: 0, consumed: 0 } } } };
      }
      if (method === "POST" && path === "/v1/leases") {
        const collateral = this.#sharedCollateral();
        const held = new Set([...this.#leases.values()].filter((lease) => lease.status !== "released").map((lease) => outpoint(lease.fee)));
        const fee = this.#utxos().find((utxo) => utxo !== collateral && !held.has(outpoint({ txId: utxo.txHash, index: utxo.index })));
        if (!fee) throw new Refused({ status: 409, error: "no_utxo_available", detail: "Every fee UTxO is leased" });
        const lease: Lease = { leaseId: randomUUID(), expiresAt: Date.now() + LEASE_TTL_MS, fee: { txId: fee.txHash, index: fee.index }, status: "open" };
        this.#leases.set(lease.leaseId, lease);
        return {
          status: 201,
          json: {
            leaseId: lease.leaseId,
            expiresAt: new Date(lease.expiresAt).toISOString(),
            fee: this.#utxoBody(fee),
            collateral: this.#utxoBody(collateral),
            sponsorAddress: this.address,
            maxSponsoredLovelace: MAX_SPONSORED_LOVELACE,
          },
        };
      }
      if (method === "DELETE" && (match = /^\/v1\/leases\/([^/]+)$/.exec(path))) {
        const lease = this.#leases.get(decodeURIComponent(match[1]));
        if (!lease) throw new Refused({ status: 404, error: "unknown_lease", detail: `No lease ${match[1]} exists` });
        if (lease.status === "consumed") throw new Refused({ status: 409, error: "lease_consumed", detail: `Lease ${lease.leaseId} already issued a witness` });
        lease.status = "released";
        return { status: 200, json: { leaseId: lease.leaseId, status: "released" } };
      }
      if (method === "POST" && (match = /^\/v1\/leases\/([^/]+)\/witness$/.exec(path))) {
        return { status: 200, json: this.#signLeased(decodeURIComponent(match[1]), (body as { transaction?: unknown } | undefined)?.transaction) };
      }
      if (method === "GET" && path === "/v1/collateral") {
        const collateral = this.#sharedCollateral();
        return { status: 200, json: { ...this.#utxoBody(collateral), sponsorAddress: this.address, validitySeconds: COLLATERAL_VALIDITY_SECONDS } };
      }
      if (method === "POST" && path === "/v1/collateral/witness") {
        return { status: 200, json: this.#signCollateral((body as { transaction?: unknown } | undefined)?.transaction) };
      }
      throw new Refused({ status: 404, error: "not_found", detail: `No route for ${method} ${path}` });
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      const { status, ...json } = error.refusal;
      return { status, json };
    }
  }

  /**
   * Serves the client API at `<app origin>/sponsor/...`, where the app's
   * relay listens, so no request reaches the relay or the hosted service.
   * Records each request's credentials: the browser must send none.
   */
  async install(context: BrowserContext, appOrigin: string): Promise<void> {
    await context.route(`${appOrigin}/sponsor/**`, async (route: Route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace(/^\/sponsor/, "");
      const headers = await request.allHeaders();
      this.requests.push({ method: request.method(), path, authorization: headers.authorization, cookie: headers.cookie });
      const { status, json } = this.answer(request.method(), path, request.postDataJSON());
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) });
    });
  }
}
