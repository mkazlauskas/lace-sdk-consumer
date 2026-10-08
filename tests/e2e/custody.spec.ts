import { expect, test, type Page } from "@playwright/test";
import { CUSTODY_ACCOUNT_SCRIPT_HASH } from "../../src/custody/custody-contract";
import { FakeLedger } from "./fake-ledger";
import { forbidConsumerWebAuthn, popup, prepareSigner, recordSignerRequests, type Credential } from "./signer";

// The Cardano custody account flow through the published SDK, the real
// hosted signer build and a fake Preprod ledger: device key, sponsored
// creation, a deposit by ordinary transfer, an agent grant and its policy, a
// grant spend from a separate observer wallet signed with a development
// Ed25519 key, an overspend refusal, revocation, and a spend refused under
// the revoked grant.

const RECIPIENT = "addr_test1qzkwnu5y0djlptw3t38v6njkzaaq6mdnn7r97zkxhu2ypy6e8l75l0avdum8zp0cycd9785nhjtmntmj22l934ptjehqm3kj5s";
const SETTLE = { timeout: 120_000 };

let ledger: FakeLedger;
let signerRequests: ReturnType<typeof recordSignerRequests>;

test.beforeEach(async ({ context, page }) => {
  await prepareSigner(context);
  signerRequests = recordSignerRequests(context);
  await forbidConsumerWebAuthn(page);
  ledger = new FakeLedger();
  await ledger.install(context);
});

test.afterEach(() => {
  // The signer page must never call another origin: it signs from the
  // request's context, and the app owns every chain read. The signer's own
  // requests were seen, so the observation works.
  expect(signerRequests.toOtherOrigins).toEqual([]);
  expect(signerRequests.count).toBeGreaterThan(0);
  // The ledger sees the app's own Blockfrost reads.
  expect(ledger.requests.some((request) => request.frameOrigin?.startsWith("http://localhost:"))).toBe(true);
  if (ledger.unknownPaths.size > 0) console.log(`Blockfrost paths the fake ledger does not serve: ${[...ledger.unknownPaths].join(", ")}`);
});

const log = (page: Page) => page.locator("#custody-log");
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

test("custody account: sponsored creation, agent grant, grant spend, overspend refusal and revocation", async ({ page }) => {
  test.setTimeout(420_000);

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

  // The development sponsor: one 5 ADA collateral UTxO and one fee UTxO.
  await expect(page.locator("#sponsor-output")).toContainText("Sponsor address: addr_test1");
  const sponsorAddress = /Sponsor address: (\S+)/.exec(await page.locator("#sponsor-output").innerText())![1];
  ledger.fund(sponsorAddress, 5_000_000n);
  ledger.fund(sponsorAddress, 100_000_000n);

  // 1. Device key from the hosted signer.
  await approve(page, "Share custody device key", credentials, "Share your Cardano custody device key", { rows: [["Network", "Preprod"], ["Key", "m/1854'/1815'/1'"]] });
  await expect(log(page)).toContainText("Custody device key shared: fingerprint");
  const deviceFingerprint = /fingerprint ([0-9a-f]{8}…[0-9a-f]{8})/.exec(await page.locator("#custody-device").innerText())![1];

  // 2. Sponsored creation (fee mode).
  await approve(page, "Create custody account", credentials, "Create Cardano custody account", {
    details: ["Permanent deposit"],
    rows: [
      ["Stake deposit", "2000000 lovelace"],
      ["Device (1)", `${deviceFingerprint} (this device)`],
      ["Fee paid by", sponsorAddress],
      ["Collateral from", sponsorAddress],
    ],
  });
  await expect(log(page)).toContainText("Custody account creation submitted:", SETTLE);
  await expect(log(page)).toContainText("Custody account live:", SETTLE);
  await expect(custodyState(page)).toContainText("Status: live");
  await expect(custodyState(page)).toContainText("Spendable: 0.000000 ADA");
  await expect(custodyState(page)).toContainText(`${deviceFingerprint} (this device)`);
  const custodyAddress = /Address: (\S+)/.exec(await custodyState(page).innerText())![1];
  const locked = /Locked: (\d+\.\d+) ADA/.exec(await custodyState(page).innerText())![1];
  expect(Number(locked)).toBeGreaterThan(1);
  expect(ledger.utxosAt(custodyAddress)).toHaveLength(1);
  // The sponsor paid exactly the fee, the deposit and the control output, within its 6 ADA limit.
  const creationTxId = /creation submitted: ([0-9a-f]{64})/.exec(await log(page).innerText())![1];
  const creation = ledger.transaction(creationTxId)!;
  const draw = 105_000_000n - ledger.lovelaceAt(sponsorAddress);
  expect(creation.deposit).toBe(2_000_000n);
  expect(draw).toBe(creation.fee + creation.deposit + ledger.lovelaceAt(custodyAddress));
  expect(draw).toBeLessThanOrEqual(6_000_000n);
  console.log(`Evidence: creation ${creationTxId} fee ${creation.fee}, deposit ${creation.deposit}, control output ${ledger.lovelaceAt(custodyAddress)}, sponsor draw ${draw}`);

  // 3. An ordinary transfer with a custody account in the wallet: a deposit to it.
  await expect(page.locator("#balance-output")).toHaveText("Spendable: 50.000000 ADA in 1 UTxO(s)", SETTLE);
  await page.getByRole("button", { name: "Deposit to custody account", exact: true }).click();
  await expect(page.locator("#recipient")).toHaveValue(custodyAddress);
  await page.locator("#amount").fill("10");
  await page.getByRole("button", { name: "Build Transaction", exact: true }).click();
  await expect(page.locator("#tx-review")).toContainText("a deposit");
  // The review reads the amount from the built transaction.
  await expect(page.locator("#tx-review")).toContainText("Amount: 10.000000 ADA");
  await expect(page.locator("#tx-review")).toContainText("Selected inputs: 1");
  await page.getByRole("checkbox").check();
  await approve(page, "Sign Transaction", credentials, "Sign a transaction", { details: [/is a Cardano custody account/] });
  await expect(page.locator("#out")).toContainText("Signed! (1 signature(s))");
  await page.getByRole("button", { name: "Submit Transaction", exact: true }).click();
  await expect(page.locator("#out")).toContainText("Submitted! txId=");
  await expect(custodyState(page)).toContainText("Spendable: 10.000000 ADA in 1 UTxO(s)", SETTLE);

  // 4. Grant the development agent key 4 ADA per spend, 6 ADA in total, to one recipient.
  const agentKeyHash = /Agent key hash ([0-9a-f]{56})/.exec(await page.locator("#agent-key").innerText())![1];
  const grantConsent = await approve(page, "Grant agent spending", credentials, "Grant spending to an agent", {
    rows: [
      ["Issued grant", "Grant ID 0"],
      ["Grantee", agentKeyHash],
      ["Per spend", "4000000 lovelace"],
      ["Remaining", "6000000 lovelace"],
      ["Expires", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/],
      ["Recipient (1)", RECIPIENT],
      ["Fee paid by", "The custody account"],
    ],
  });
  await expect(log(page)).toContainText("Grant settled: slot 0", SETTLE);
  await expect(log(page)).toContainText("Agent policy exported for slot 0");
  const policy = JSON.parse(await page.locator("#agent-policy").inputValue());
  expect(policy).toMatchObject({
    type: "cardano-custody-agent-policy",
    version: 1,
    account: { type: "cardano-custody-account", version: 1, networkMagic: 1, address: custodyAddress },
    grant: { slot: "0", grantee: agentKeyHash, asset: { policyId: "", assetName: "" }, perCallCap: "4000000", cap: "6000000", lovelacePerCallCap: "0", lovelaceCap: "0", recipients: [RECIPIENT] },
  });
  await expect(custodyState(page)).toContainText("slot 0 [effective]");
  // The popup showed the expiry the grant carries.
  expect(grantConsent).toMatch(new RegExp(`Expires\\s+${escape(signerUtc(policy.grant.expiresAt))}`));

  // 5. The agent opens the account from the policy alone and spends 2 ADA.
  await page.getByRole("button", { name: "Open account as agent", exact: true }).click();
  await expect(log(page)).toContainText("Agent opened the account as an observer");
  await expect(page.locator("#agent-state")).toContainText("Status: live", SETTLE);
  await expect(page.locator("#agent-state")).not.toContainText("This device listed");
  const recipientBefore = ledger.lovelaceAt(RECIPIENT);
  const accountBefore = ledger.lovelaceAt(custodyAddress);
  await page.locator("#agent-amount").fill("2");
  await page.getByRole("button", { name: "Agent: build, sign and submit spend", exact: true }).click();
  await expect(log(page)).toContainText("Agent spend built:", SETTLE);
  await expect(log(page)).toContainText("Agent spend submitted:", SETTLE);
  await expect(log(page)).toContainText("Agent spend settled", SETTLE);
  const spendTxId = /Agent spend submitted: ([0-9a-f]{64})/.exec(await log(page).innerText())![1];
  const spendFee = ledger.transaction(spendTxId)!.fee;
  expect(ledger.lovelaceAt(RECIPIENT) - recipientBefore).toBe(2_000_000n);
  // The fee came from the account, and the control datum's cap fell by exactly
  // what left the account in the applied transaction: payment plus fee.
  const outflow = accountBefore - ledger.lovelaceAt(custodyAddress);
  expect(outflow).toBe(2_000_000n + spendFee);
  const remainingCap = async () => {
    const match = /slot 0 \[effective\][^\n]*?, (\d+) remaining/.exec(await custodyState(page).innerText());
    return match ? BigInt(match[1]) : undefined;
  };
  await expect.poll(remainingCap, SETTLE).toBe(6_000_000n - outflow);
  console.log(`Evidence: grant spend ${spendTxId} of 2000000 lovelace paid fee ${spendFee}; account outflow ${outflow}; remaining cap ${6_000_000n - outflow}`);

  // 6. An overspend is refused before any signature or submission.
  const submissionsBefore = ledger.submissions.length;
  await page.locator("#agent-amount").fill("3");
  await page.getByRole("button", { name: "Agent: build, sign and submit spend", exact: true }).click();
  await expect(log(page)).toContainText("Agent spend failed: CardanoCustodyGrantSpendError: Custody grant spend refused: scope", SETTLE);
  // 3 ADA is within the per-spend cap but above the remaining cap the first spend left.
  await expect(log(page)).toContainText('"code":"cap-exceeded"');
  expect(ledger.submissions.length).toBe(submissionsBefore);

  // 7. The owner revokes the grant; a spend under it is refused.
  await approve(page, "Revoke agent grant", credentials, "Revoke an agent grant", { rows: [["Revoked grant", "Grant ID 0"], ["Grants", "None"]] });
  await expect(log(page)).toContainText("Grant revoked: slot 0", SETTLE);
  await expect(custodyState(page)).toContainText("Grants (0)");
  await expect(page.locator("#agent-state")).toContainText("Grants (0)", SETTLE);
  await page.locator("#agent-amount").fill("1");
  await page.getByRole("button", { name: "Agent: build, sign and submit spend", exact: true }).click();
  await expect(log(page)).toContainText(/Agent spend failed: CardanoCustodyGrantSpendError: Custody grant spend refused: unknown-grant/, SETTLE);
  expect(ledger.submissions.length).toBe(submissionsBefore + 1);

  // Every submission the ledger saw applied: creation, deposit, grant, spend, revoke.
  expect(ledger.submissions.map(({ accepted, message }) => (accepted ? "applied" : message))).toEqual(["applied", "applied", "applied", "applied", "applied"]);
  // The state NFT is never treated as a token: no metadata lookup for it.
  expect(ledger.requests.filter((request) => request.path.startsWith(`assets/${CUSTODY_ACCOUNT_SCRIPT_HASH}`))).toEqual([]);
  // The ordinary account kept its own UTxOs; the custody account kept its funds apart.
  expect(ledger.lovelaceAt(ordinaryAddress)).toBeLessThan(40_000_000n);
});
