import {
  CARDANO_CUSTODY_LOVELACE_ASSET,
  Cardano,
  HexBlob,
  Milliseconds,
  buildCardanoCustodyGrantSpend,
  createCardanoCustodyAccount,
  createCardanoCustodySponsorClient,
  createLaceWallet,
  createRemoteCardanoCustodyDeviceSigner,
  deriveCardanoCustodyDevice,
  executeCardanoCustodyOperation,
  exportCardanoCustodyAgentPolicy,
  m,
  observeCardanoCustodyAccountState,
  observeCardanoCustodyGrantStatuses,
  openCardanoCustodyAccount,
  parseCardanoCustodyAgentPolicy,
  requestCardanoCustodyDeviceKey,
  submitCardanoCustodyGrantSpend,
  waitForCardanoCustodyOperation,
  waitForNetworkInfo,
  type AccountId,
  type CardanoCustodyAccountCreation,
  type CardanoCustodyAccountRecord,
  type CardanoCustodyDeviceBinding,
  type CardanoCustodyDeviceKey,
  type CardanoCustodyGrantSpend,
  type CardanoCustodyOperation,
  type CardanoCustodyParsedAgentPolicy,
  type CardanoCustodySubmission,
  type WalletWithCardanoCustody,
} from "@input-output-hk/lace-sdk/cardano";
import { config, featureFlags } from "../config";
import { signer, signerUrl, withSigner } from "../signer";
import { parseAdaAmount } from "../accounts";
import { generateDevKey } from "./dev-key";
import { describeCustodyError } from "./custody-errors";
import {
  describeCustodyState,
  describeSponsorHealth,
  fingerprint,
  formatAda,
  type GrantWithStatus,
  type ObservedCustodyState,
  type ObservedGrantStatuses,
} from "./custody-view";

// The custody account flow of the demo: a hosted-signer device key, a
// creation the hosted fee sponsor pays for, an agent grant and its policy,
// an agent that spends from a separate observer wallet with its own Ed25519
// key, and revocation.

const CHAIN_ID = Cardano.ChainIds.Preprod;
const WAIT_TIMEOUT = Milliseconds(600_000);
/**
 * The hosted fee sponsor, through the relay on this app's own server, which
 * adds the API key (see sponsor-relay.ts). The browser holds no key.
 */
const SPONSOR_BASE_URL = `${location.origin}/sponsor`;
/**
 * The demo grant: 4 ADA per spend, 6 ADA in total, to one recipient, for a
 * day. A grant spend pays its fee from the account, and the fee counts
 * against both caps.
 */
const GRANT = { perCallCap: 4_000_000n, cap: 6_000_000n, lifetimeMs: 24 * 60 * 60 * 1000 } as const;
const GRANT_RECIPIENT = Cardano.PaymentAddress(
  "addr_test1qzkwnu5y0djlptw3t38v6njkzaaq6mdnn7r97zkxhu2ypy6e8l75l0avdum8zp0cycd9785nhjtmntmj22l934ptjehqm3kj5s",
);
/** Grant statuses under which the agent still holds its grant: a new one would be refused (`grantee-has-grant`). */
const HELD = new Set<GrantWithStatus["status"]>(["pending", "live", "exhausted"]);

const origin = new URL(signerUrl).origin;
const DEVICE_STORAGE_KEY = `lace-custody-device-v1:${origin}:${CHAIN_ID.networkMagic}`;
/**
 * Accounts of custody contract revision 3. The SDK refuses records of other
 * contract builds, so the page does not offer the ones an earlier version
 * of it saved under another key.
 */
const ACCOUNT_STORAGE_KEY = `lace-custody-account-r3:${origin}:${CHAIN_ID.networkMagic}`;

type SavedAccount = { record: CardanoCustodyAccountRecord; device: CardanoCustodyDeviceBinding };

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const buttons = {
  deviceKey: element<HTMLButtonElement>("custody-device-key"),
  create: element<HTMLButtonElement>("custody-create"),
  open: element<HTMLButtonElement>("custody-open"),
  issueGrant: element<HTMLButtonElement>("custody-issue-grant"),
  exportPolicy: element<HTMLButtonElement>("custody-export-policy"),
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

const readJson = <T>(key: string): T | undefined => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  } catch {
    return undefined;
  }
};

/** The value of an SDK `Result`, or its error thrown. */
const unwrap = <T>(result: { isOk(): boolean; value?: unknown; error?: unknown }): T => {
  if (result.isOk()) return result.value as T;
  throw result.error;
};

export type CustodyApp = {
  /** The custody account's deposit address, while the account is live and lists this device. */
  address(): string | undefined;
};

/** The SDK's custody helpers and `waitForNetworkInfo` each name the wallet parts they read. */
type CustodyWallet = WalletWithCardanoCustody & Parameters<typeof waitForNetworkInfo>[0];

/** An account the page follows: its state and its grants with their statuses. */
type Followed = { state?: ObservedCustodyState; grants?: ObservedGrantStatuses };

export function startCustody({
  wallet,
  onCustodyAddress,
}: {
  wallet: CustodyWallet;
  onCustodyAddress: (address: string) => void;
}): CustodyApp {
  const sponsor = createCardanoCustodySponsorClient({ baseUrl: SPONSOR_BASE_URL });
  const deviceSigner = createRemoteCardanoCustodyDeviceSigner(signer);
  const agentKey = generateDevKey();

  let deviceKey = readJson<CardanoCustodyDeviceKey>(DEVICE_STORAGE_KEY);
  let account: (SavedAccount & Followed & { accountId: AccountId }) | undefined;
  let busy = false;

  let agent: (Followed & { wallet: CustodyWallet; accountId: AccountId; policy: CardanoCustodyParsedAgentPolicy }) | undefined;

  const liveState = () => (account?.state?.status === "live" ? account.state : undefined);
  /** The agent's grant UTxO that still works or is about to: what revocation targets and what blocks a new grant. */
  const agentGrant = () => account?.grants?.find(({ grant, status }) => grant.grantee === agentKey.keyHash && HELD.has(status));

  function render() {
    const live = liveState();
    const held = agentGrant();
    buttons.deviceKey.disabled = busy;
    buttons.create.disabled = busy || !deviceKey || !!account;
    buttons.open.hidden = !!account || !readJson<SavedAccount>(ACCOUNT_STORAGE_KEY);
    buttons.open.disabled = busy;
    buttons.issueGrant.disabled = busy || !live?.currentDeviceListed || !account?.grants || !!held;
    buttons.exportPolicy.disabled = busy || held?.status !== "live";
    // A grant still in a submitted transaction cannot be revoked yet.
    buttons.revokeGrant.disabled = busy || !live?.currentDeviceListed || !held || held.status === "pending";
    buttons.agentOpen.disabled = busy || policyInput.value.trim() === "" || !!agent;
    buttons.agentSpend.disabled = busy || agent?.state?.status !== "live";
    output.device.textContent = deviceKey
      ? `Device key (index 0): fingerprint ${deviceKey.device.fingerprint}, key hash ${deviceKey.device.keyHash}, signer ${origin}`
      : "No custody device key yet";
    output.state.textContent = account
      ? describeCustodyState(account.state, { deviceKeyHash: account.device.keyHash, address: account.record.address, grants: account.grants })
      : "No custody account open";
    output.agentKey.textContent = `Agent key hash ${agentKey.keyHash} (fingerprint ${fingerprint(agentKey.keyHash)}); in memory, outside Lace`;
    output.agentState.textContent = agent
      ? describeCustodyState(agent.state, { address: agent.policy.account.address, grants: agent.grants })
      : "Agent has not opened the account";
  }

  /** What the relay's `GET /health` answers: the hosted sponsor's network and pool, or why the relay cannot reach it. */
  async function refreshSponsor() {
    try {
      const response = await fetch(`${SPONSOR_BASE_URL}/health`, { cache: "no-store" });
      const text = await response.text();
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      output.sponsor.textContent = describeSponsorHealth({ status: response.status, body });
    } catch (error) {
      output.sponsor.textContent = describeSponsorHealth({ failure: describeCustodyError(error) });
    }
  }

  /** Runs a button's action and logs its failure. */
  const onClick = (button: HTMLButtonElement, label: string, action: () => Promise<void>) => {
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await action();
      } catch (error) {
        console.error(`${label} failed:`, error);
        log(`${label} failed: ${describeCustodyError(error)}`);
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

  async function waitFor(target: CustodyWallet, accountId: AccountId, submission: { txId: Cardano.TransactionId; invalidHereafter: Cardano.Slot }) {
    unwrap<{ txId: string }>(await waitForCardanoCustodyOperation(target, { accountId, ...submission, timeout: WAIT_TIMEOUT }));
  }

  /** Follows an account's state and grant statuses in `followed`. */
  function follow(target: CustodyWallet, accountId: AccountId, followed: () => Followed | undefined, onState?: (state: ObservedCustodyState) => void) {
    observeCardanoCustodyAccountState(target, accountId).subscribe((state) => {
      const current = followed();
      if (current) current.state = state;
      onState?.(state);
      render();
    });
    observeCardanoCustodyGrantStatuses(target, accountId).subscribe((grants) => {
      const current = followed();
      if (current) current.grants = grants;
      render();
    });
  }

  function track(saved: SavedAccount, accountId: AccountId) {
    const tracked: NonNullable<typeof account> = { ...saved, accountId };
    account = tracked;
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(saved));
    follow(
      wallet,
      accountId,
      () => (account === tracked ? tracked : undefined),
      (state) => {
        // Deposits only to a live account that lists this device.
        if (state?.status === "live" && state.depositAddress) onCustodyAddress(state.depositAddress);
      },
    );
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
      try {
        // `withSigner` comes first so that the popup opens while the click
        // still carries user activation.
        const creation = unwrap<CardanoCustodyAccountCreation>(
          await withSigner(async () => {
            // A key read back from storage is re-derived before it binds an account.
            const derived = await deriveCardanoCustodyDevice(device.extendedAccountPublicKey, 0);
            if (derived.keyHash !== device.device.keyHash) throw new Error("The saved custody device key is inconsistent");
            return createCardanoCustodyAccount(wallet, { device, deviceSigner, sponsor, name: "Custody Preprod" });
          }),
        );
        track({ record: creation.record, device: creation.device }, creation.accountId);
        if (creation.status === "exists") {
          log(`Custody account exists at creator index ${creation.creatorIndex}; reopened ${creation.record.address}`);
          return;
        }
        log(`Custody account creation submitted: ${creation.txId} (creator index ${creation.creatorIndex})`);
        await waitFor(wallet, creation.accountId, creation);
        log(`Custody account live: ${creation.record.address}`);
      } finally {
        await refreshSponsor();
      }
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

  async function runOwnerOperation(label: string, operation: CardanoCustodyOperation): Promise<CardanoCustodySubmission> {
    const current = account;
    if (!current) throw new Error("Open a custody account first");
    const submission = unwrap<CardanoCustodySubmission>(
      await withSigner(() => executeCardanoCustodyOperation(wallet, { accountId: current.accountId, operation, deviceSigner, sponsor })),
    );
    log(`${label} submitted: ${submission.txId}`);
    await waitFor(wallet, current.accountId, submission);
    return submission;
  }

  /** Exports the agent policy of a settled grant: the SDK reads it from the grant UTxO. */
  async function exportPolicy(slot: bigint) {
    const current = account;
    if (!current) throw new Error("Open a custody account first");
    const policy = await exportCardanoCustodyAgentPolicy(wallet, { accountId: current.accountId, slot });
    policyInput.value = JSON.stringify(policy, null, 2);
    log(`Agent policy exported for grant ID ${policy.grant.slot}`);
  }

  onClick(buttons.issueGrant, "Grant issue", () =>
    exclusive(async () => {
      const submission = await runOwnerOperation("Grant issue", {
        type: "issue-grant",
        // The SDK assigns the grant the account's next grant ID.
        scope: {
          grantee: HexBlob(agentKey.keyHash),
          asset: CARDANO_CUSTODY_LOVELACE_ASSET,
          perCallCap: GRANT.perCallCap,
          cap: GRANT.cap,
          lovelacePerCallCap: 0n,
          lovelaceCap: 0n,
          expiresAt: BigInt(Date.now() + GRANT.lifetimeMs),
          recipients: [GRANT_RECIPIENT],
        },
      });
      if (submission.grantSlot === undefined) throw new Error("The submission names no grant ID");
      log(`Grant settled: grant ID ${submission.grantSlot}`);
      await exportPolicy(submission.grantSlot);
    }),
  );

  // A grant that settled after the wait ended, or after a reload, still has a policy to export.
  onClick(buttons.exportPolicy, "Agent policy export", () =>
    exclusive(async () => {
      const held = agentGrant();
      if (held?.status !== "live") throw new Error("The agent holds no live grant");
      await exportPolicy(held.grant.slot);
    }),
  );

  onClick(buttons.revokeGrant, "Grant revoke", () =>
    exclusive(async () => {
      const held = agentGrant();
      if (!held) throw new Error("The agent holds no grant");
      await runOwnerOperation("Grant revoke", { type: "revoke-grant", slot: held.grant.slot });
      log(`Grant revoked: grant ID ${held.grant.slot}`);
    }),
  );

  onClick(buttons.agentOpen, "Agent open", () =>
    exclusive(async () => {
      // Validates the shape, the version (2 only) and the account record.
      const policy = parseCardanoCustodyAgentPolicy(policyInput.value, { networkMagic: CHAIN_ID.networkMagic });
      if (policy.grantee !== agentKey.keyHash) throw new Error("The policy grants another key");
      // The agent runs its own wallet: no passkey, no device, no vault.
      const observer = await createLaceWallet({
        modules: [m.featureDev, m.storageInMemory, m.blockchainCardano, m.cardanoProviderBlockfrost, m.cryptoCardanoSdk] as const,
        environment: "development",
        featureFlags,
        config,
      });
      // Opening reads the wallet's network, which a new wallet selects asynchronously.
      await waitForNetworkInfo(observer);
      const { accountId } = await openCardanoCustodyAccount(observer, { record: policy.account, name: "Agent view" });
      const opened: NonNullable<typeof agent> = { wallet: observer, accountId, policy };
      agent = opened;
      follow(observer, accountId, () => (agent === opened ? opened : undefined));
      log(`Agent opened the account as an observer: ${accountId}`);
    }),
  );

  onClick(buttons.agentSpend, "Agent spend", () =>
    exclusive(async () => {
      const current = agent;
      if (!current) throw new Error("Open the account as the agent first");
      const coins = parseAdaAmount(agentAmountInput.value);
      const address = current.policy.grant.recipients[0] ?? GRANT_RECIPIENT;
      // The SDK finds the grantee's current grant on chain; the policy's grant ID is for information.
      const spend = unwrap<CardanoCustodyGrantSpend>(
        await buildCardanoCustodyGrantSpend(current.wallet, {
          accountId: current.accountId,
          grantee: current.policy.grantee,
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
  render();

  return { address: () => liveState()?.depositAddress };
}
