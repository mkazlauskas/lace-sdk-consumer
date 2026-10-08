import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { Cardano, HexBlob, Serialization } from "@input-output-hk/lace-sdk/cardano";
import { CUSTODY_ACCOUNT_SCRIPT_HASH } from "../src/custody/custody-contract.ts";
import { createDevCustodySponsor, DEV_SPONSOR_LIMITS } from "../src/custody/dev-sponsor.ts";
import { devKeyFromSecret, verifyHashSignature } from "../src/custody/dev-key.ts";
import { preprodSlotAt, preprodSlotStart } from "../src/custody/preprod-time.ts";

// The development sponsor against a stub Blockfrost and a controlled clock:
// the fee sponsor service's transaction policy and its fee UTxO lifecycle.

const STAKE_SCRIPT = "25b5b4ed1213ab11575a6d667a53c2af107bb052716b83b172bafe33";
const OTHER_STAKE_SCRIPT = "ee".repeat(28);
const STATE_NFT = `${CUSTODY_ACCOUNT_SCRIPT_HASH}${STAKE_SCRIPT}`;
const accountAddress = (stake = STAKE_SCRIPT) =>
  Cardano.BaseAddress.fromCredentials(
    Cardano.NetworkId.Testnet,
    { type: Cardano.CredentialType.ScriptHash, hash: CUSTODY_ACCOUNT_SCRIPT_HASH },
    { type: Cardano.CredentialType.ScriptHash, hash: stake },
  )
    .toAddress()
    .toBech32();
const ACCOUNT = accountAddress();
const THIRD_PARTY = "addr_test1qzkwnu5y0djlptw3t38v6njkzaaq6mdnn7r97zkxhu2ypy6e8l75l0avdum8zp0cycd9785nhjtmntmj22l934ptjehqm3kj5s";
const BYRON = "Ae2tdPwUPEZFRbyhz3cpfC2CumGzNkFBN2L42rcUc2yjQpEkxDbkPodpMAi";
const FEE = 400_000n;
const DEPOSIT = 2_000_000n;
const CONTROL = 2_000_000n;

const key = devKeyFromSecret(new Uint8Array(32).fill(9));

/** A ledger behind the two Blockfrost endpoints the sponsor reads. */
function stubChain() {
  const txs = new Map();
  const spent = new Set();
  let nonce = 0;
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  const notFound = () => new Response(JSON.stringify({ status_code: 404 }), { status: 404 });
  return {
    spent,
    /** An unspent output in a transaction of its own. */
    add(address, coins, assets = {}) {
      const txId = (++nonce).toString(16).padStart(64, "c");
      const amount = [{ unit: "lovelace", quantity: `${coins}` }, ...Object.entries(assets).map(([unit, quantity]) => ({ unit, quantity: `${quantity}` }))];
      txs.set(txId, [{ output_index: 0, address, amount, collateral: false }]);
      return { txId, index: 0 };
    },
    async fetch(url) {
      const path = new URL(url).pathname.replace(/^\/api\/v0\//, "");
      let match;
      if ((match = /^addresses\/([^/]+)\/utxos$/.exec(path))) {
        const utxos = [...txs]
          .flatMap(([txId, outputs]) => outputs.map((output) => ({ txId, ...output })))
          .filter(({ txId, output_index, address }) => address === match[1] && !spent.has(`${txId}#${output_index}`))
          .map(({ txId, output_index, amount }) => ({ tx_hash: txId, output_index, amount, data_hash: null, inline_datum: null, reference_script_hash: null }));
        return utxos.length > 0 ? json(utxos) : notFound();
      }
      if ((match = /^txs\/([0-9a-f]{64})\/utxos$/.exec(path))) {
        return txs.has(match[1]) ? json({ hash: match[1], inputs: [], outputs: txs.get(match[1]) }) : notFound();
      }
      return notFound();
    },
  };
}

const transaction = (body) => HexBlob(Serialization.Transaction.fromCore({ id: "0".repeat(64), body, witness: { signatures: new Map() } }).toCbor());

/** The sponsor's signature over the body hash, from its witness set. */
const assertSponsorWitness = (witnessSet, cbor) => {
  const txId = Serialization.Transaction.fromCbor(Serialization.TxCBOR(cbor)).getId();
  const signatures = [...Serialization.TransactionWitnessSet.fromCbor(witnessSet).toCore().signatures];
  assert.equal(signatures.length, 1);
  assert.equal(signatures[0][0], key.publicKey);
  assert.equal(verifyHashSignature(key.publicKey, txId, signatures[0][1]), true);
};

const refusal = (rule, detail) => (error) => {
  assert.equal(error.name, "CardanoCustodySponsorError");
  assert.equal(error.code, "invalid_transaction");
  assert.equal(error.rule, rule);
  if (detail) assert.match(error.detail, detail);
  return true;
};

const sponsorError = (code) => (error) => {
  assert.equal(error.code, code);
  return true;
};

let now;
let chain;
let sponsor;
let collateral;
let feeUtxo;
let control;
let fund;

beforeEach(() => {
  now = Date.parse("2026-10-08T06:00:00Z");
  chain = stubChain();
  sponsor = createDevCustodySponsor({ blockfrostUrl: "https://blockfrost.invalid", projectId: "test", key, fetch: (url) => chain.fetch(url), now: () => now });
  collateral = chain.add(sponsor.address, DEV_SPONSOR_LIMITS.collateralLovelace);
  feeUtxo = chain.add(sponsor.address, 100_000_000n);
  control = chain.add(ACCOUNT, CONTROL, { [STATE_NFT]: 1n });
  fund = chain.add(ACCOUNT, 10_000_000n);
});

/** Collateral and validity every sponsored transaction carries. */
const shared = (overrides = {}) => ({
  collaterals: [collateral],
  collateralReturn: { address: sponsor.address, value: { coins: DEV_SPONSOR_LIMITS.collateralLovelace - 600_000n } },
  totalCollateral: 600_000n,
  validityInterval: { invalidHereafter: preprodSlotAt(now) + 300 },
  ...overrides,
});

/** An account creation in fee mode, as the SDK builds it. */
const creation = ({ mint, certificates, controlOutput, extraOutputs = [], change } = {}) => ({
  inputs: [feeUtxo],
  outputs: [
    controlOutput ?? { address: ACCOUNT, value: { coins: CONTROL, assets: new Map([[STATE_NFT, 1n]]) } },
    { address: sponsor.address, value: { coins: change ?? 100_000_000n - FEE - DEPOSIT - CONTROL } },
    ...extraOutputs,
  ],
  fee: FEE,
  mint: mint ?? new Map([[STATE_NFT, 1n]]),
  certificates: certificates ?? [{ __typename: Cardano.CertificateType.Registration, stakeCredential: { type: Cardano.CredentialType.ScriptHash, hash: STAKE_SCRIPT }, deposit: DEPOSIT }],
  ...shared(),
});

/** An owner operation that spends the control UTxO, in fee mode: the sponsor pays exactly the fee. */
const feeModeOperation = ({ change = 100_000_000n - FEE, extraOutputs = [], inputs } = {}) => ({
  inputs: inputs ?? [feeUtxo, control],
  outputs: [{ address: ACCOUNT, value: { coins: CONTROL, assets: new Map([[STATE_NFT, 1n]]) } }, { address: sponsor.address, value: { coins: change } }, ...extraOutputs],
  fee: FEE,
  ...shared(),
});

/** An account operation in collateral mode: the account pays the fee and the payments. */
const collateralModeOperation = ({ inputs, outputs, ...rest } = {}) => ({
  inputs: inputs ?? [control, fund],
  outputs: outputs ?? [
    { address: ACCOUNT, value: { coins: CONTROL, assets: new Map([[STATE_NFT, 1n]]) } },
    { address: THIRD_PARTY, value: { coins: 2_000_000n } },
    { address: ACCOUNT, value: { coins: 10_000_000n - 2_000_000n - FEE } },
  ],
  fee: FEE,
  ...shared(),
  ...rest,
});

describe("fee mode", () => {
  test("signs a creation that draws the fee, the deposit and the control output", async () => {
    const lease = await sponsor.lease();
    assert.deepEqual(lease.feeUtxo[0], { ...feeUtxo, address: sponsor.address });
    assert.deepEqual(lease.collateralUtxo[0], { ...collateral, address: sponsor.address });
    const cbor = transaction(creation());
    assertSponsorWitness(await sponsor.signLeased(lease.leaseId, cbor), cbor);
  });

  test("signs an owner operation that draws only the fee", async () => {
    const lease = await sponsor.lease();
    const cbor = transaction(feeModeOperation());
    assertSponsorWitness(await sponsor.signLeased(lease.leaseId, cbor), cbor);
  });

  test("refuses a transaction that touches no custody account", async () => {
    const lease = await sponsor.lease();
    const body = { inputs: [feeUtxo], outputs: [{ address: sponsor.address, value: { coins: 100_000_000n - FEE - 2_000_000n } }, { address: THIRD_PARTY, value: { coins: 2_000_000n } }], fee: FEE, ...shared() };
    await assert.rejects(sponsor.signLeased(lease.leaseId, transaction(body)), refusal("account_transaction", /No input is an account control UTxO/));
  });

  test("refuses an owner operation that draws more than the fee", async () => {
    const lease = await sponsor.lease();
    const body = feeModeOperation({ change: 100_000_000n - FEE - 2_000_000n, extraOutputs: [{ address: THIRD_PARTY, value: { coins: 2_000_000n } }] });
    await assert.rejects(sponsor.signLeased(lease.leaseId, transaction(body)), refusal("sponsor_outflow_bounded", /drawn down by 2400000, but the fee account for 400000/));
  });

  test("refuses a creation that pays a third party from the fee UTxO", async () => {
    const lease = await sponsor.lease();
    const body = creation({ change: 100_000_000n - FEE - DEPOSIT - CONTROL - 1_000_000n, extraOutputs: [{ address: THIRD_PARTY, value: { coins: 1_000_000n } }] });
    await assert.rejects(sponsor.signLeased(lease.leaseId, transaction(body)), refusal("sponsor_outflow_bounded", /the fee, the deposit and the control output account for 4400000/));
  });

  test("refuses a creation that does not have the account shape", async () => {
    const registration = (hash, deposit = DEPOSIT) => ({ __typename: Cardano.CertificateType.Registration, stakeCredential: { type: Cardano.CredentialType.ScriptHash, hash }, deposit });
    const cases = [
      [{ mint: new Map([[STATE_NFT, 2n]]) }, /mints exactly one token/],
      [{ mint: new Map([[STATE_NFT, 1n], [`${CUSTODY_ACCOUNT_SCRIPT_HASH}${OTHER_STAKE_SCRIPT}`, 1n]]) }, /mints exactly one token/],
      [{ certificates: [] }, /registers exactly one script stake credential/],
      [{ certificates: [registration(STAKE_SCRIPT), registration(OTHER_STAKE_SCRIPT)] }, /registers exactly one script stake credential/],
      [{ certificates: [{ __typename: Cardano.CertificateType.StakeRegistration, stakeCredential: { type: Cardano.CredentialType.ScriptHash, hash: STAKE_SCRIPT } }] }, /registers exactly one script stake credential/],
      [{ certificates: [registration(OTHER_STAKE_SCRIPT)] }, /named after the registered stake credential/],
      [{ controlOutput: { address: THIRD_PARTY, value: { coins: CONTROL, assets: new Map([[STATE_NFT, 1n]]) } } }, /exactly one output at an account address/],
      [{ controlOutput: { address: accountAddress(OTHER_STAKE_SCRIPT), value: { coins: CONTROL, assets: new Map([[STATE_NFT, 1n]]) } } }, /staked to the registered stake credential/],
    ];
    for (const [shape, detail] of cases) {
      const lease = await sponsor.lease();
      await assert.rejects(sponsor.signLeased(lease.leaseId, transaction(creation(shape))), refusal("account_transaction", detail));
      await sponsor.releaseLease(lease.leaseId);
    }
  });

  test("refuses another sponsor input, a missing fee input and an unreadable input", async () => {
    const second = chain.add(sponsor.address, 50_000_000n);
    let lease = await sponsor.lease();
    await assert.rejects(sponsor.signLeased(lease.leaseId, transaction(feeModeOperation({ inputs: [feeUtxo, second, control] }))), refusal("uses_leased_fee_input", /another sponsor UTxO/));
    await sponsor.releaseLease(lease.leaseId);
    lease = await sponsor.lease();
    await assert.rejects(sponsor.signLeased(lease.leaseId, transaction(feeModeOperation({ inputs: [control] }))), refusal("uses_leased_fee_input", /not spent/));
    await sponsor.releaseLease(lease.leaseId);
    const byron = chain.add(BYRON, 3_000_000n);
    lease = await sponsor.lease();
    await assert.rejects(sponsor.signLeased(lease.leaseId, transaction(feeModeOperation({ inputs: [feeUtxo, control, byron] }))), refusal("uses_leased_fee_input", /no readable payment credential/));
  });

  test("refuses a fee above the limit", async () => {
    const lease = await sponsor.lease();
    const body = { ...feeModeOperation({ change: 100_000_000n - 2_000_001n }), fee: 2_000_001n };
    await assert.rejects(sponsor.signLeased(lease.leaseId, transaction(body)), refusal("sponsor_outflow_bounded", /Fee 2000001 is above 2000000/));
  });
});

describe("collateral mode", () => {
  test("signs an account operation the account pays for", async () => {
    const offer = await sponsor.collateral();
    assert.deepEqual(offer.collateralUtxo[0], { ...collateral, address: sponsor.address });
    const cbor = transaction(collateralModeOperation());
    assertSponsorWitness(await sponsor.signCollateral(cbor), cbor);
  });

  test("refuses a transaction that touches no custody account", async () => {
    const plain = chain.add(THIRD_PARTY, 3_000_000n);
    const body = collateralModeOperation({ inputs: [plain], outputs: [{ address: THIRD_PARTY, value: { coins: 3_000_000n - FEE } }] });
    await assert.rejects(sponsor.signCollateral(transaction(body)), refusal("account_transaction"));
  });

  test("refuses a sponsor input", async () => {
    await assert.rejects(sponsor.signCollateral(transaction(collateralModeOperation({ inputs: [control, fund, feeUtxo] }))), refusal("no_sponsor_inputs"));
    await assert.rejects(sponsor.signCollateral(transaction(collateralModeOperation({ inputs: [control, fund, collateral] }))), refusal("no_sponsor_inputs"));
  });

  test("refuses an output that pays the sponsor", async () => {
    const body = collateralModeOperation({
      outputs: [
        { address: ACCOUNT, value: { coins: CONTROL, assets: new Map([[STATE_NFT, 1n]]) } },
        { address: sponsor.address, value: { coins: 2_000_000n } },
        { address: ACCOUNT, value: { coins: 10_000_000n - 2_000_000n - FEE } },
      ],
    });
    await assert.rejects(sponsor.signCollateral(transaction(body)), refusal("sponsor_outflow_zero"));
  });

  test("refuses value away from the account that the account's inputs do not cover", async () => {
    const token = `${"ab".repeat(28)}74`;
    const body = collateralModeOperation({
      outputs: [
        { address: ACCOUNT, value: { coins: CONTROL, assets: new Map([[STATE_NFT, 1n]]) } },
        { address: THIRD_PARTY, value: { coins: 2_000_000n, assets: new Map([[token, 5n]]) } },
        { address: ACCOUNT, value: { coins: 10_000_000n - 2_000_000n - FEE } },
      ],
      mint: new Map([[token, 5n]]),
    });
    await assert.rejects(sponsor.signCollateral(transaction(body)), refusal("no_sponsor_value_elsewhere", new RegExp(`need 5 ${token} but the non sponsor inputs supply 0`)));
  });
});

describe("rules both modes share", () => {
  test("refuses a collateral other than the shared one, or a collateral return away from the sponsor", async () => {
    const other = chain.add(sponsor.address, DEV_SPONSOR_LIMITS.collateralLovelace);
    await assert.rejects(sponsor.signCollateral(transaction(collateralModeOperation({ collaterals: [other] }))), refusal("uses_shared_collateral"));
    const away = { address: THIRD_PARTY, value: { coins: 4_400_000n } };
    await assert.rejects(sponsor.signCollateral(transaction(collateralModeOperation({ collateralReturn: away }))), refusal("uses_shared_collateral"));
    await assert.rejects(sponsor.signCollateral(transaction(collateralModeOperation({ totalCollateral: undefined }))), refusal("uses_shared_collateral"));
  });

  test("refuses a validity bound outside the sponsor window", async () => {
    const tooLate = preprodSlotAt(now) + DEV_SPONSOR_LIMITS.collateralValiditySeconds + 1;
    await assert.rejects(sponsor.signCollateral(transaction(collateralModeOperation({ validityInterval: { invalidHereafter: tooLate } }))), refusal("bounded_validity"));
    await assert.rejects(sponsor.signCollateral(transaction(collateralModeOperation({ validityInterval: { invalidHereafter: preprodSlotAt(now) } }))), refusal("bounded_validity"));
    await assert.rejects(sponsor.signCollateral(transaction(collateralModeOperation({ validityInterval: {} }))), refusal("bounded_validity"));
    const lease = await sponsor.lease();
    const pastLease = preprodSlotAt(lease.expiresAt) + DEV_SPONSOR_LIMITS.validityMarginSeconds + 1;
    await assert.rejects(sponsor.signLeased(lease.leaseId, transaction({ ...feeModeOperation(), validityInterval: { invalidHereafter: pastLease } })), refusal("bounded_validity"));
  });

  test("refuses an input the chain does not know", async () => {
    const unknown = { txId: "dd".repeat(32), index: 0 };
    await assert.rejects(sponsor.signCollateral(transaction(collateralModeOperation({ inputs: [control, fund, unknown] }))), refusal("evaluates", /does not resolve/));
  });

  test("refuses the sponsor key as a signer", async () => {
    await assert.rejects(sponsor.signCollateral(transaction(collateralModeOperation({ requiredExtraSignatures: [key.keyHash] }))), refusal("signers"));
  });

  test("refuses a transaction that does not decode", async () => {
    await assert.rejects(sponsor.signCollateral(HexBlob("00")), refusal("well_formed"));
  });
});

describe("fee UTxO leases", () => {
  test("hold the fee UTxO until released or expired", async () => {
    const first = await sponsor.lease();
    await assert.rejects(sponsor.lease(), sponsorError("no_utxo_available"));
    await sponsor.releaseLease(first.leaseId);
    const second = await sponsor.lease();
    assert.deepEqual(second.feeUtxo[0], first.feeUtxo[0]);
    now = second.expiresAt;
    const third = await sponsor.lease();
    assert.deepEqual(third.feeUtxo[0], first.feeUtxo[0]);
    await assert.rejects(sponsor.signLeased(second.leaseId, transaction(creation())), sponsorError("unknown_lease"));
  });

  test("free a witnessed fee UTxO once its transaction can no longer reach the chain", async () => {
    const lease = await sponsor.lease();
    const body = creation();
    const cbor = transaction(body);
    const witnessSet = await sponsor.signLeased(lease.leaseId, cbor);
    assert.equal(await sponsor.signLeased(lease.leaseId, cbor), witnessSet);
    await assert.rejects(sponsor.signLeased(lease.leaseId, transaction(creation({ change: 100_000_000n - FEE - DEPOSIT - CONTROL - 1n }))), sponsorError("lease_consumed"));
    await assert.rejects(sponsor.releaseLease(lease.leaseId), sponsorError("lease_consumed"));

    // The device rejected the consent: the fee UTxO is still unspent on chain.
    const releaseSlot = body.validityInterval.invalidHereafter + DEV_SPONSOR_LIMITS.releaseMarginSlots;
    now = preprodSlotStart(releaseSlot);
    await assert.rejects(sponsor.lease(), sponsorError("no_utxo_available"));
    now = preprodSlotStart(releaseSlot + 1);
    const again = await sponsor.lease();
    assert.deepEqual(again.feeUtxo[0], lease.feeUtxo[0]);
  });

  test("forget a witnessed fee UTxO once the chain spends it", async () => {
    const lease = await sponsor.lease();
    await sponsor.signLeased(lease.leaseId, transaction(creation()));
    chain.spent.add(`${feeUtxo.txId}#${feeUtxo.index}`);
    const change = chain.add(sponsor.address, 100_000_000n - FEE - DEPOSIT - CONTROL);
    const next = await sponsor.lease();
    assert.deepEqual(next.feeUtxo[0], { ...change, address: sponsor.address });
    await assert.rejects(sponsor.signLeased(lease.leaseId, transaction(creation())), sponsorError("unknown_lease"));
  });
});
