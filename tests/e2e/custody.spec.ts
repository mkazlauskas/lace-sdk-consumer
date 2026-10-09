import { expect, test, type Page } from "@playwright/test";
import { ACCOUNT_PROXY_HASH, FakeLedger, LOGIC_HASH, LOGIC_REWARD_ACCOUNT, PARKED_SCRIPTS } from "./fake-ledger";
import { FakeSponsor } from "./fake-sponsor";
import { assertSignerServesCustodyFor, forbidConsumerWebAuthn, popup, prepareSigner, recordSignerRequests, type Credential } from "./signer";

// The Cardano custody account flow (contract revision 3) through the
// published SDK, a real signer build, a fake of the hosted fee sponsor at the
// app's /sponsor relay path and a fake Preprod ledger: device key, sponsored
// creation, no deposit address on a reloaded page before the creation
// settles, a deposit by ordinary transfer, an agent grant and its policy, a
// grant spend from a separate observer wallet signed with a development
// Ed25519 key, an overspend refusal, a sponsor refusal, revocation, a spend
// refused under the revoked grant, and an operation refused while the
// logic's reward account holds a balance.

const RECIPIENT = "addr_test1qzkwnu5y0djlptw3t38v6njkzaaq6mdnn7r97zkxhu2ypy6e8l75l0avdum8zp0cycd9785nhjtmntmj22l934ptjehqm3kj5s";
const SETTLE = { timeout: 120_000 };
const PARKED = PARKED_SCRIPTS.map(({ txId, index }) => `${txId}#${index}`);
const SPONSOR_FEE_UTXO = 100_000_000n;
const SPONSOR_COLLATERAL = 5_000_000n;

let ledger: FakeLedger;
let sponsor: FakeSponsor;
let signerRequests: ReturnType<typeof recordSignerRequests>;

test.beforeEach(async ({ context, page, baseURL }) => {
  const appOrigin = new URL(baseURL!).origin;
  assertSignerServesCustodyFor(appOrigin);
  await prepareSigner(context);
  signerRequests = recordSignerRequests(context);
  await forbidConsumerWebAuthn(page);
  ledger = new FakeLedger();
  await ledger.install(context);
  // The hosted sponsor's pool: the shared collateral and one fee UTxO.
  sponsor = new FakeSponsor(ledger);
  ledger.fund(sponsor.address, SPONSOR_COLLATERAL);
  ledger.fund(sponsor.address, SPONSOR_FEE_UTXO);
  await sponsor.install(context, appOrigin);
});

test.afterEach(() => {
  // The signer page must never call another origin: it signs from the
  // request's context, and the app owns every chain read. The signer's own
  // requests were seen, so the observation works.
  expect(signerRequests.toOtherOrigins).toEqual([]);
  expect(signerRequests.count).toBeGreaterThan(0);
  // The ledger sees the app's own Blockfrost reads.
  expect(ledger.requests.some((request) => request.frameOrigin?.startsWith("http://localhost:"))).toBe(true);
  // The browser calls the relay path with no credential of its own: the relay adds the key.
  expect(sponsor.requests.length).toBeGreaterThan(0);
  expect(sponsor.requests.filter(({ authorization, cookie }) => authorization !== undefined || cookie !== undefined)).toEqual([]);
  if (ledger.unknownPaths.size > 0) console.log(`Blockfrost paths the fake ledger does not serve: ${[...ledger.unknownPaths].join(", ")}`);
});

const log = (page: Page) => page.locator("#custody-log");
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });
const custodyState = (page: Page) => page.locator("#custody-state");

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The time the signer shows for POSIX milliseconds. */
const signerUtc = (posixMs: string) => `${new Date(Number(posixMs)).toISOString().slice(0, 19).replace("T", " ")} UTC`;

type Consent = {
  /** Text shown anywhere in the popup. */
  details?: (string | RegExp)[];
  /** A label and the value shown next to it. */
  rows?: [label: string, value: string | RegExp][];
};

/** Checks a signer consent and approves it with the passkey. Returns the consent's text. */
async function approve(page: Page, button: string, credentials: Credential[], title: string, { details = [], rows = [] }: Consent = {}) {
  const { signer } = await popup(page, button, credentials);
  await expect(signer.getByText(title, { exact: true })).toBeVisible({ timeout: 60_000 });
  for (const detail of details) await expect(signer.getByText(detail).first()).toBeVisible();
  const text = await signer.locator("body").innerText();
  for (const [label, value] of rows) {
    expect(text).toMatch(new RegExp(`${escape(label)}\\s+${typeof value === "string" ? escape(value) : value.source}`));
  }
  await signer.getByRole("button", { name: "Approve with passkey", exact: true }).click();
  return text;
}

/** Runs the agent's spend of `ada` and waits for the log line that ends it. */
async function agentSpend(page: Page, ada: string, outcome: string | RegExp) {
  await page.locator("#agent-amount").fill(ada);
  await page.getByRole("button", { name: "Agent: build, sign and submit spend", exact: true }).click();
  await expect(log(page)).toContainText(outcome, SETTLE);
}

test("custody account: sponsored creation, agent grant, grant spend, refusals and revocation", async ({ page }) => {
  test.setTimeout(480_000);

  // The ordinary passkey wallet, funded.
  await page.goto("/");
  const created = await popup(page, "Create passkey wallet");
  await created.signer.getByRole("button", { name: "Create a new wallet", exact: true }).click();
  await expect(created.signer.getByText("Share your Cardano account", { exact: true })).toBeVisible();
  const { credentials } = await created.cdp.send("WebAuthn.getCredentials", { authenticatorId: created.authenticatorId });
  await created.signer.getByRole("button", { name: "Approve with passkey", exact: true }).click();
  await expect(page.locator("#address-output")).toContainText("addr_test1");
  const ordinaryAddress = (await page.locator("#address-output").innerText()).replace(/^Address: /, "");
  ledger.fund(ordinaryAddress, 50_000_000n);

  // The page reads the sponsor's health through the relay path.
  await expect(page.locator("#sponsor-output")).toContainText("Network preprod: 1 fee UTxO(s) free, 0 leased, collateral shared");

  // 1. Device key from the hosted signer.
  await approve(page, "Share custody device key", credentials, "Share your Cardano custody device key", { rows: [["Network", "Every testnet (the app named Preprod)"], ["Key", "m/1854'/1815'/1'"]] });
  await expect(log(page)).toContainText("Custody device key shared: fingerprint");
  const deviceFingerprint = /fingerprint ([0-9a-f]{8}…[0-9a-f]{8})/.exec(await page.locator("#custody-device").innerText())![1];

  // 2. Creation paid by the sponsor (fee mode). The ledger holds it back, as
  // a mempool would before a block.
  ledger.holdSubmissions();
  await approve(page, "Create custody account", credentials, "Create Cardano custody account", {
    details: ["Permanent deposit"],
    rows: [
      ["Stake deposit", "2000000 lovelace"],
      ["Device (1)", `${deviceFingerprint} (this device)`],
      ["Fee paid by", `${sponsor.address} (the fee sponsor)`],
      ["Collateral from", sponsor.address],
    ],
  });
  await expect(log(page)).toContainText("Custody account creation submitted:", SETTLE);
  const creationTxId = /creation submitted: ([0-9a-f]{64})/.exec(await log(page).innerText())![1];

  // The creating page reads the SDK's in-flight view, in which the account
  // is live at once. A reloaded page opens the saved account from the chain
  // alone, where it is not live until the creation settles, and offers no
  // deposit address meanwhile: a deposit there might never become spendable.
  await page.reload();
  await button(page, "Open saved custody account").click();
  await expect(log(page)).toContainText("Custody account opened:");
  await expect(custodyState(page)).toContainText("Status: notCreated", SETTLE);
  const tipReads = () => ledger.requests.filter(({ path }) => path === "blocks/latest").length;
  const readsAtOpening = tipReads();
  await expect.poll(tipReads, SETTLE).toBeGreaterThanOrEqual(readsAtOpening + 2);
  await expect(custodyState(page)).toContainText("Status: notCreated");
  await expect(custodyState(page)).not.toContainText("Deposit address");
  await expect(button(page, "Deposit to custody account")).toBeDisabled();
  ledger.releaseSubmissions();
  await expect(custodyState(page)).toContainText("Status: live", SETTLE);
  await expect(button(page, "Deposit to custody account")).toBeEnabled();
  // The passkey wallet, opened again after the reload.
  const reopened = await popup(page, "Open passkey wallet", credentials);
  await reopened.signer.getByRole("button", { name: "Approve with passkey", exact: true }).click();
  await expect(page.locator("#address-output")).toContainText(ordinaryAddress);

  await expect(custodyState(page)).toContainText(`Logic: ${LOGIC_HASH}`);
  await expect(custodyState(page)).toContainText("Spendable: 0.000000 ADA");
  await expect(custodyState(page)).toContainText(`${deviceFingerprint} (this device)`);
  const custodyAddress = /Address: (\S+)/.exec(await custodyState(page).innerText())![1];
  await expect(custodyState(page)).toContainText(`Deposit address: ${custodyAddress}`);
  expect(ledger.utxosAt(custodyAddress)).toHaveLength(1);
  const control = ledger.lovelaceAt(custodyAddress);
  await expect(custodyState(page)).toContainText(`Control output: ${Number(control) / 1e6}`);
  // The sponsor paid exactly the fee, the deposit and the control output, within its 6 ADA limit.
  const creation = ledger.transaction(creationTxId)!;
  const draw = SPONSOR_FEE_UTXO + SPONSOR_COLLATERAL - ledger.lovelaceAt(sponsor.address);
  expect(creation.deposit).toBe(2_000_000n);
  expect(draw).toBe(creation.fee + creation.deposit + control);
  expect(draw).toBeLessThanOrEqual(6_000_000n);
  // Revision 3: the proxy and the logic come from the parked Preprod UTxOs, and the logic runs through a withdrawal of zero.
  expect(creation.referenceInputs).toEqual(expect.arrayContaining(PARKED));
  expect(creation.withdrawals).toEqual([{ rewardAccount: LOGIC_REWARD_ACCOUNT, quantity: 0n }]);
  expect(sponsor.requests.map(({ method, path }) => `${method} ${path.replace(/[\da-f-]{36}/, ":id")}`)).toEqual(
    expect.arrayContaining(["POST /v1/leases", "POST /v1/leases/:id/witness"]),
  );
  console.log(`Evidence: creation ${creationTxId} fee ${creation.fee}, deposit ${creation.deposit}, control output ${control}, sponsor draw ${draw}`);

  // 3. An ordinary transfer with a custody account in the wallet: a deposit to it.
  await expect(page.locator("#balance-output")).toHaveText("Spendable: 50.000000 ADA in 1 UTxO(s)", SETTLE);
  await page.getByRole("button", { name: "Deposit to custody account", exact: true }).click();
  await expect(page.locator("#recipient")).toHaveValue(custodyAddress);
  await page.locator("#amount").fill("20");
  await page.getByRole("button", { name: "Build Transaction", exact: true }).click();
  await expect(page.locator("#tx-review")).toContainText("a deposit");
  // The review reads the amount from the built transaction.
  await expect(page.locator("#tx-review")).toContainText("Amount: 20.000000 ADA");
  await expect(page.locator("#tx-review")).toContainText("Selected inputs: 1");
  await page.getByRole("checkbox").check();
  await approve(page, "Sign Transaction", credentials, "Sign a transaction", { details: [/is a Cardano custody account/] });
  await expect(page.locator("#out")).toContainText("Signed! (1 signature(s))");
  await page.getByRole("button", { name: "Submit Transaction", exact: true }).click();
  await expect(page.locator("#out")).toContainText("Submitted! txId=");
  await expect(custodyState(page)).toContainText("Spendable: 20.000000 ADA in 1 UTxO(s)", SETTLE);

  // 4. Grant the development agent key 4 ADA per spend, 6 ADA in total, to one recipient.
  const agentKeyHash = /Agent key hash ([0-9a-f]{56})/.exec(await page.locator("#agent-key").innerText())![1];
  const grantConsent = await approve(page, "Grant agent spending", credentials, "Grant spending to an agent", {
    details: ["New grant ID 0"],
    rows: [
      ["Grantee", agentKeyHash],
      ["Per spend", "4000000 lovelace"],
      ["Remaining", "6000000 lovelace"],
      ["Expires", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/],
      ["Recipient (1)", RECIPIENT],
      ["Fee paid by", "The custody account"],
    ],
  });
  await expect(log(page)).toContainText("Grant settled: grant ID 0", SETTLE);
  await expect(log(page)).toContainText("Agent policy exported for grant ID 0");
  const policy = JSON.parse(await page.locator("#agent-policy").inputValue());
  expect(policy).toMatchObject({
    type: "cardano-custody-agent-policy",
    version: 2,
    account: { type: "cardano-custody-account", version: 1, networkMagic: 1, accountValidatorHash: ACCOUNT_PROXY_HASH, address: custodyAddress },
    grantee: agentKeyHash,
    grant: { slot: "0", generation: "0", asset: { policyId: "", assetName: "" }, perCallCap: "4000000", cap: "6000000", lovelacePerCallCap: "0", lovelaceCap: "0", recipients: [RECIPIENT] },
  });
  await expect(custodyState(page)).toContainText("grant ID 0 [live]");
  // The popup showed the expiry the grant carries.
  expect(grantConsent).toMatch(new RegExp(`Expires\\s+${escape(signerUtc(policy.grant.expiresAt))}`));
  // A live grant's policy can be exported again, as after a reload.
  const exported = await page.locator("#agent-policy").inputValue();
  await page.locator("#agent-policy").fill("");
  await button(page, "Export agent policy").click();
  await expect(page.locator("#agent-policy")).toHaveValue(exported);

  // 5. The agent opens the account from the policy alone and spends 2 ADA.
  await page.getByRole("button", { name: "Open account as agent", exact: true }).click();
  await expect(log(page)).toContainText("Agent opened the account as an observer");
  await expect(page.locator("#agent-state")).toContainText("Status: live", SETTLE);
  await expect(page.locator("#agent-state")).not.toContainText("This device listed");
  await expect(page.locator("#agent-state")).not.toContainText("Deposit address");
  const recipientBefore = ledger.lovelaceAt(RECIPIENT);
  const accountBefore = ledger.lovelaceAt(custodyAddress);
  await agentSpend(page, "2", "Agent spend settled");
  const spendTxId = /Agent spend submitted: ([0-9a-f]{64})/.exec(await log(page).innerText())![1];
  const spend = ledger.transaction(spendTxId)!;
  expect(ledger.lovelaceAt(RECIPIENT) - recipientBefore).toBe(2_000_000n);
  // The spend references the control UTxO and both parked scripts, and runs the logic with a withdrawal of zero.
  expect(spend.referenceInputs).toEqual(expect.arrayContaining(PARKED));
  expect(spend.referenceInputs).toHaveLength(3);
  expect(spend.withdrawals).toEqual([{ rewardAccount: LOGIC_REWARD_ACCOUNT, quantity: 0n }]);
  // The fee came from the account. The grant's caps fell by what left the
  // account, payment plus fee, and at most the SDK's 10,000 lovelace margin:
  // it writes the caps before the fee is final.
  const outflow = accountBefore - ledger.lovelaceAt(custodyAddress);
  expect(outflow).toBe(2_000_000n + spend.fee);
  const remainingCap = async () => {
    const match = /grant ID 0 \[live\][^\n]*?, (\d+) remaining/.exec(await custodyState(page).innerText());
    return match ? BigInt(match[1]) : undefined;
  };
  await expect.poll(remainingCap, SETTLE).toBeLessThanOrEqual(6_000_000n - outflow);
  const capFall = 6_000_000n - (await remainingCap())!;
  expect(capFall - outflow).toBeLessThanOrEqual(10_000n);
  console.log(`Evidence: grant spend ${spendTxId} of 2000000 lovelace paid fee ${spend.fee}; account outflow ${outflow}; caps fell by ${capFall}`);

  // 6. An overspend is refused before any signature or submission.
  const submissionsBefore = ledger.submissions.length;
  await agentSpend(page, "3", "Agent spend failed: CardanoCustodyGrantSpendError [custody-grant-spend]: Custody grant spend refused: scope");
  // 3 ADA is within the per-spend cap but above the remaining cap the first spend left.
  await expect(log(page)).toContainText('"code":"cap-exceeded"');
  expect(ledger.submissions.length).toBe(submissionsBefore);

  // 7. A sponsor that does not serve the account's logic lends no collateral; nothing is submitted.
  sponsor.knownLogics = new Set();
  await agentSpend(page, "1", /Agent spend failed: CardanoCustodyLogicNotServedError \[custody-logic-not-served\]: .*lends no collateral/);
  sponsor.knownLogics = new Set([LOGIC_HASH]);
  expect(ledger.submissions.length).toBe(submissionsBefore);

  // 8. The owner revokes the grant; a spend under it is refused.
  await approve(page, "Revoke agent grant", credentials, "Revoke an agent grant", { rows: [["Revoked grant", "Grant ID 0"]] });
  await expect(log(page)).toContainText("Grant revoked: grant ID 0", SETTLE);
  await expect(custodyState(page)).toContainText("grant ID 0 [revoked]");
  await expect(custodyState(page)).toContainText("revoked IDs: 0");
  await expect(button(page, "Export agent policy")).toBeDisabled();
  await expect(page.locator("#agent-state")).toContainText("grant ID 0 [revoked]", SETTLE);
  await agentSpend(page, "1", "Agent spend failed: CardanoCustodyGrantSpendError [custody-grant-spend]: Custody grant spend refused: dead-grant");
  await expect(log(page)).toContainText('"liveness":"revoked"');
  expect(ledger.submissions.length).toBe(submissionsBefore + 1);

  // 9. Someone pays into the logic's reward account: every account
  // transaction must withdraw it, and the sponsor refuses such a draw, so a
  // new grant fails before the device is asked.
  ledger.addRewards(LOGIC_REWARD_ACCOUNT, 1_500_000n);
  const refusedPopup = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Grant agent spending", exact: true }).click();
  const refused = await refusedPopup;
  await expect(log(page)).toContainText(/Grant issue failed: CardanoCustodyLogicRewardBalanceError \[custody-logic-reward-balance\]: .*1\.500000 ADA/, SETTLE);
  await expect(log(page)).toContainText("building again does not help");
  await expect.poll(() => refused.isClosed()).toBe(true);
  expect(ledger.submissions.length).toBe(submissionsBefore + 1);

  // Every submission the ledger saw applied: creation, deposit, grant, spend, revoke.
  expect(ledger.submissions.map(({ accepted, message }) => (accepted ? "applied" : message))).toEqual(["applied", "applied", "applied", "applied", "applied"]);
  // The state NFT and grant tokens are never treated as tokens: no metadata lookup for them.
  expect(ledger.requests.filter((request) => request.path.startsWith(`assets/${ACCOUNT_PROXY_HASH}`))).toEqual([]);
  // The ordinary account kept its own UTxOs; the custody account kept its funds apart.
  expect(ledger.lovelaceAt(ordinaryAddress)).toBeLessThan(30_000_000n);
});
