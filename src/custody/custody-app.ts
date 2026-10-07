import {
  Cardano,
  HexBlob,
  Milliseconds,
  buildCardanoCustodyGrantSpend,
  createCardanoCustodyAccount,
  createLaceWallet,
  createRemoteCardanoCustodyDeviceSigner,
  deriveCardanoCustodyDevice,
  executeCardanoCustodyOperation,
  exportCardanoCustodyAgentPolicy,
  m,
  observeCardanoCustodyAccountState,
  openCardanoCustodyAccount,
  parseCardanoCustodyAccountRecord,
  requestCardanoCustodyDeviceKey,
  submitCardanoCustodyGrantSpend,
  waitForCardanoCustodyOperation,
  waitForNetworkInfo,
  type AccountId,
  type CardanoCustodyAccountCreation,
  type CardanoCustodyAccountRecord,
  type CardanoCustodyAccountState,
  type CardanoCustodyAgentPolicy,
  type CardanoCustodyDeviceBinding,
  type CardanoCustodyDeviceKey,
  type CardanoCustodyGrantSpend,
  type CardanoCustodyOperation,
  type CardanoCustodySubmission,
  type WalletWithCardanoCustody,
} from "@input-output-hk/lace-sdk/cardano";
import { BLOCKFROST_PROJECT_ID_PREPROD, BLOCKFROST_URL_PREPROD, config, featureFlags } from "../config";
import { signer, signerUrl, withSigner } from "../signer";
import { parseAdaAmount } from "../accounts";
import { createDevCustodySponsor } from "./dev-sponsor";
import { generateDevKey } from "./dev-key";
import { describeCustodyState, fingerprint, formatAda, sumLovelace } from "./custody-view";

// The custody account flow of the demo: a hosted-signer device key, a
// sponsored creation, an agent grant and its policy, an agent that spends
// from a separate observer wallet with its own Ed25519 key, and revocation.

const CHAIN_ID = Cardano.ChainIds.Preprod;
const WAIT_TIMEOUT = Milliseconds(600_000);
/**
 * The demo grant: 4 ADA per spend, 6 ADA in total, to one recipient, for a
 * day. A grant spend pays its fee from the account, about 1.1 ADA with the
 * fixed script budgets, and the fee counts against both caps.
 */
const GRANT = { perCallCap: 4_000_000n, cap: 6_000_000n, lifetimeMs: 24 * 60 * 60 * 1000 } as const;
const GRANT_RECIPIENT = Cardano.PaymentAddress(
  "addr_test1qzkwnu5y0djlptw3t38v6njkzaaq6mdnn7r97zkxhu2ypy6e8l75l0avdum8zp0cycd9785nhjtmntmj22l934ptjehqm3kj5s",
);

const origin = new URL(signerUrl).origin;
const DEVICE_STORAGE_KEY = `lace-custody-device-v1:${origin}:${CHAIN_ID.networkMagic}`;
const ACCOUNT_STORAGE_KEY = `lace-custody-account-v1:${origin}:${CHAIN_ID.networkMagic}`;

type SavedAccount = { record: CardanoCustodyAccountRecord; device: CardanoCustodyDeviceBinding };

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const buttons = {
  deviceKey: element<HTMLButtonElement>("custody-device-key"),
  create: element<HTMLButtonElement>("custody-create"),
  open: element<HTMLButtonElement>("custody-open"),
  issueGrant: element<HTMLButtonElement>("custody-issue-grant"),
  revokeGrant: element<HTMLButtonElement>("custody-revoke-grant"),
  agentOpen: element<HTMLButtonElement>("agent-open"),
  agentSpend: element<HTMLButtonElement>("agent-spend"),
};
const output = {
  sponsor: element("sponsor-output"),
  device: element("custody-device"),
  state: element("custody-state"),
  agentKey: element("agent-key"),
  agentState: element("agent-state"),
  log: element("custody-log"),
};
const policyInput = element<HTMLTextAreaElement>("agent-policy");
const agentAmountInput = element<HTMLInputElement>("agent-amount");

const log = (line: string) => {
  output.log.textContent += `${output.log.textContent ? "\n" : ""}${new Date().toISOString().slice(11, 19)} ${line}`;
};

const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return String(error);
  const { reason, detail } = error as Error & { reason?: unknown; detail?: unknown };
  const extra = [reason, detail]
    .filter((value) => value !== undefined && typeof value !== "string")
    .map((value) => JSON.stringify(value, (_, item) => (typeof item === "bigint" ? `${item}` : item)));
  return `${error.name}: ${error.message}${extra.length > 0 ? ` ${extra.join(" ")}` : ""}`;
};

const readJson = <T>(key: string): T | undefined => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
};

/**
 * The value of an SDK `Result`, or its error thrown. The published types
 * name `Result` from `ts-results-es`, which the package does not install, so
 * the caller states the value type.
 */
const unwrap = <T>(result: { isOk(): boolean; value?: unknown; error?: unknown }): T => {
  if (result.isOk()) return result.value as T;
  throw result.error;
};

export type CustodyApp = {
  /** The custody account address once the account is open. */
  address(): string | undefined;
};

/** The SDK's custody helpers and `waitForNetworkInfo` each name the wallet parts they read. */
type CustodyWallet = WalletWithCardanoCustody & Parameters<typeof waitForNetworkInfo>[0];

export function startCustody({
  wallet,
  onCustodyAddress,
}: {
  wallet: CustodyWallet;
  onCustodyAddress: (address: string) => void;
}): CustodyApp {
  const sponsor = createDevCustodySponsor({ blockfrostUrl: BLOCKFROST_URL_PREPROD, projectId: BLOCKFROST_PROJECT_ID_PREPROD });
  const deviceSigner = createRemoteCardanoCustodyDeviceSigner(signer);
  const agentKey = generateDevKey();

  let deviceKey = readJson<CardanoCustodyDeviceKey>(DEVICE_STORAGE_KEY);
  let account: (SavedAccount & { accountId: AccountId }) | undefined;
  let accountState: CardanoCustodyAccountState | undefined;
  let busy = false;

  let agent: { wallet: WalletWithCardanoCustody; accountId: AccountId; policy: CardanoCustodyAgentPolicy; state?: CardanoCustodyAccountState } | undefined;

  const liveState = () => (accountState?.status === "live" ? accountState : undefined);
  const agentGrant = () => liveState()?.state.grants.find((grant) => grant.grantee === agentKey.keyHash);

  function render() {
    const live = liveState();
    buttons.deviceKey.disabled = busy;
    buttons.create.disabled = busy || !deviceKey || !!account;
    buttons.open.hidden = !!account || !readJson<SavedAccount>(ACCOUNT_STORAGE_KEY);
    buttons.open.disabled = busy;
    buttons.issueGrant.disabled = busy || !live?.currentDeviceListed || !!agentGrant();
    buttons.revokeGrant.disabled = busy || !live?.currentDeviceListed || !agentGrant();
    buttons.agentOpen.disabled = busy || policyInput.value.trim() === "" || !!agent;
    buttons.agentSpend.disabled = busy || agent?.state?.status !== "live";
    output.device.textContent = deviceKey
      ? `Device key (index 0): fingerprint ${deviceKey.device.fingerprint}, key hash ${deviceKey.device.keyHash}, signer ${origin}`
      : "No custody device key yet";
    output.state.textContent = account
      ? describeCustodyState(accountState, { now: Date.now(), deviceKeyHash: account.device.keyHash, address: account.record.address })
      : "No custody account open";
    output.agentKey.textContent = `Agent key hash ${agentKey.keyHash} (fingerprint ${fingerprint(agentKey.keyHash)}); in memory, outside Lace`;
    output.agentState.textContent = agent
      ? describeCustodyState(agent.state, { now: Date.now(), address: agent.policy.account.address })
      : "Agent has not opened the account";
  }

  /** Runs a button's action and logs its failure. */
  const onClick = (button: HTMLButtonElement, label: string, action: () => Promise<void>) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await action();
      } catch (error) {
        console.error(`${label} failed:`, error);
        log(`${label} failed: ${describeError(error)}`);
      } finally {
        render();
      }
    });
  };

  /** Marks the flow busy while one operation runs; the signer allows one popup at a time. */
  const exclusive = async (action: () => Promise<void>) => {
    if (busy) throw new Error("Another custody operation is running");
    busy = true;
    render();
    try {
      await action();
    } finally {
      busy = false;
    }
  };

  async function refreshSponsor() {
    try {
      const utxos = await sponsor.utxos();
      output.sponsor.textContent = `Development fee sponsor (in-memory key)\nSponsor address: ${sponsor.address}\nSponsor UTxOs: ${utxos.length}, ${formatAda(sumLovelace(utxos))}`;
    } catch (error) {
      output.sponsor.textContent = `Development fee sponsor (in-memory key)\nSponsor address: ${sponsor.address}\nUTxOs unavailable: ${describeError(error)}`;
    }
  }

  async function waitFor(target: WalletWithCardanoCustody, accountId: AccountId, submission: { txId: Cardano.TransactionId; invalidHereafter: Cardano.Slot }) {
    unwrap<{ txId: string }>(await waitForCardanoCustodyOperation(target, { accountId, ...submission, timeout: WAIT_TIMEOUT }));
  }

  function track(saved: SavedAccount, accountId: AccountId) {
    account = { ...saved, accountId };
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(saved));
    observeCardanoCustodyAccountState(wallet, accountId).subscribe((state) => {
      accountState = state;
      if (state?.status === "live") onCustodyAddress(saved.record.address);
      render();
    });
  }

  onClick(buttons.deviceKey, "Custody device key", () =>
    exclusive(async () => {
      // `withSigner` opens the popup before its first await.
      const key = await withSigner(() => requestCardanoCustodyDeviceKey({ mode: "hosted", signer, signerUrl, chainId: CHAIN_ID }));
      deviceKey = key;
      localStorage.setItem(DEVICE_STORAGE_KEY, JSON.stringify(key));
      log(`Custody device key shared: fingerprint ${key.device.fingerprint}`);
    }),
  );

  onClick(buttons.create, "Custody account creation", () =>
    exclusive(async () => {
      const device = deviceKey;
      if (!device) throw new Error("Share the custody device key first");
      // A key read back from storage is re-derived before it binds an account.
      const derived = await deriveCardanoCustodyDevice(device.extendedAccountPublicKey, 0);
      if (derived.keyHash !== device.device.keyHash) throw new Error("The saved custody device key is inconsistent");
      const creation = unwrap<CardanoCustodyAccountCreation>(
        await withSigner(() => createCardanoCustodyAccount(wallet, { device, deviceSigner, sponsor, name: "Custody Preprod" })),
      );
      track({ record: creation.record, device: creation.device }, creation.accountId);
      if (creation.status === "exists") {
        log(`Custody account exists at creator index ${creation.creatorIndex}; reopened ${creation.record.address}`);
        return;
      }
      log(`Custody account creation submitted: ${creation.txId} (creator index ${creation.creatorIndex})`);
      await waitFor(wallet, creation.accountId, creation);
      log(`Custody account live: ${creation.record.address}`);
      await refreshSponsor();
    }),
  );

  onClick(buttons.open, "Open saved custody account", () =>
    exclusive(async () => {
      const saved = readJson<SavedAccount>(ACCOUNT_STORAGE_KEY);
      if (!saved) throw new Error("No saved custody account");
      await waitForNetworkInfo(wallet);
      // Opening validates the record again and checks the binding derives its key hash.
      const { accountId } = await openCardanoCustodyAccount(wallet, { ...saved, name: "Custody Preprod" });
      track(saved, accountId);
      log(`Custody account opened: ${saved.record.address}`);
    }),
  );

  async function runOwnerOperation(label: string, operation: CardanoCustodyOperation) {
    const current = account;
    if (!current) throw new Error("Open a custody account first");
    const submission = unwrap<CardanoCustodySubmission>(
      await withSigner(() => executeCardanoCustodyOperation(wallet, { accountId: current.accountId, operation, deviceSigner, sponsor })),
    );
    log(`${label} submitted: ${submission.txId}`);
    await waitFor(wallet, current.accountId, submission);
  }

  onClick(buttons.issueGrant, "Grant issue", () =>
    exclusive(async () => {
      await runOwnerOperation("Grant issue", {
        type: "issue-grant",
        scope: {
          grantee: HexBlob(agentKey.keyHash),
          asset: { policyId: HexBlob(""), assetName: HexBlob("") },
          perCallCap: GRANT.perCallCap,
          cap: GRANT.cap,
          lovelacePerCallCap: 0n,
          lovelaceCap: 0n,
          expiresAt: BigInt(Date.now() + GRANT.lifetimeMs),
          recipients: [GRANT_RECIPIENT],
        },
      });
      // The operation result names no slot: read it back from the settled state.
      const grant = agentGrant();
      if (!grant || !account) throw new Error("The settled state holds no grant for the agent key");
      log(`Grant settled: slot ${grant.slot}`);
      const policy = await exportCardanoCustodyAgentPolicy(wallet, { accountId: account.accountId, slot: grant.slot });
      policyInput.value = JSON.stringify(policy, null, 2);
      log(`Agent policy exported for slot ${policy.grant.slot}`);
    }),
  );

  onClick(buttons.revokeGrant, "Grant revoke", () =>
    exclusive(async () => {
      const grant = agentGrant();
      if (!grant) throw new Error("The agent holds no grant");
      await runOwnerOperation("Grant revoke", { type: "revoke-grant", slot: grant.slot });
      log(`Grant revoked: slot ${grant.slot}`);
    }),
  );

  onClick(buttons.agentOpen, "Agent open", () =>
    exclusive(async () => {
      const policy = JSON.parse(policyInput.value) as CardanoCustodyAgentPolicy;
      if (policy?.type !== "cardano-custody-agent-policy" || policy.version !== 1) throw new Error("Not an agent policy v1");
      if (policy.grant.grantee !== agentKey.keyHash) throw new Error("The policy grants another key");
      const record = parseCardanoCustodyAccountRecord(policy.account, { networkMagic: CHAIN_ID.networkMagic });
      // The agent runs its own wallet: no passkey, no device, no vault.
      const observer = await createLaceWallet({
        modules: [m.featureDev, m.storageInMemory, m.blockchainCardano, m.cardanoProviderBlockfrost, m.cryptoCardanoSdk] as const,
        environment: "development",
        featureFlags,
        config,
      });
      // Opening reads the wallet's network, which a new wallet selects asynchronously.
      await waitForNetworkInfo(observer);
      const { accountId } = await openCardanoCustodyAccount(observer, { record, name: "Agent view" });
      const opened = { wallet: observer, accountId, policy };
      agent = opened;
      observeCardanoCustodyAccountState(observer, accountId).subscribe((state) => {
        if (agent === opened) agent.state = state;
        render();
      });
      log(`Agent opened the account as an observer: ${accountId}`);
    }),
  );

  onClick(buttons.agentSpend, "Agent spend", () =>
    exclusive(async () => {
      const current = agent;
      if (!current) throw new Error("Open the account as the agent first");
      const coins = parseAdaAmount(agentAmountInput.value);
      const address = Cardano.PaymentAddress(current.policy.grant.recipients[0] ?? GRANT_RECIPIENT);
      const spend = unwrap<CardanoCustodyGrantSpend>(
        await buildCardanoCustodyGrantSpend(current.wallet, {
          accountId: current.accountId,
          slot: BigInt(current.policy.grant.slot),
          outputs: [{ address, value: { coins } }],
          sponsor,
        }),
      );
      log(`Agent spend built: ${spend.bodyHash}, fee ${formatAda(spend.fee)}`);
      // The agent's own wallet signs the body hash; Lace never sees its key.
      const agentWitness = { vkey: agentKey.publicKey, signature: agentKey.signHash(spend.bodyHash) };
      const submission = unwrap<CardanoCustodySubmission>(
        await submitCardanoCustodyGrantSpend(current.wallet, { accountId: current.accountId, transaction: spend.transaction, agentWitness, sponsor }),
      );
      log(`Agent spend submitted: ${submission.txId}`);
      await waitFor(current.wallet, current.accountId, submission);
      log(`Agent spend settled: ${formatAda(coins)} to ${address}`);
    }),
  );

  policyInput.addEventListener("input", render);
  void refreshSponsor();
  setInterval(() => void refreshSponsor(), 10_000);
  render();

  return { address: () => (liveState() ? account?.record.address : undefined) };
}
