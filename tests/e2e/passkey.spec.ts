import { expect, test, type Page } from "@playwright/test";
import { FakeLedger } from "./fake-ledger";
import { forbidConsumerWebAuthn, popup, prepareSigner, recordSignerRequests, signerOrigin } from "./signer";

const bindingKey = `lace-remote-passkey-wallet-v1:${signerOrigin}:0`;

async function create(page: Page) {
  await page.goto("/");
  const { signer, cdp, authenticatorId } = await popup(page, "Create passkey wallet");
  await signer.getByRole("button", { name: "Create a new wallet", exact: true }).click();
  await expect(signer.getByText("Share your Cardano account", { exact: true })).toBeVisible();
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  expect(credentials[0].rpId).toBe("passkey-preview.lace.io");
  await signer.getByRole("button", { name: "Approve with passkey", exact: true }).click();
  await expect(page.locator("#out")).toContainText("Passkey wallet created/connected");
  await expect(page.locator("#address-output")).toContainText("addr_test1");
  const address = await page.locator("#address-output").innerText();
  const publicKey = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), bindingKey);
  expect(publicKey).toMatch(/^[0-9a-f]{128}$/);
  return { credentials, address, publicKey };
}

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

test("hosted create, reopen, recovery and signing keep keys on signer", async ({ page }) => {
  const { credentials, address, publicKey } = await create(page);
  ledger.fund(address.replace(/^Address: /, ""), 10_000_000n);
  await page.reload();
  await expect(page.locator("#address-output")).not.toContainText("addr_test1");
  const reopened = await popup(page, "Open passkey wallet", credentials);
  await reopened.signer.getByRole("button", { name: "Approve with passkey", exact: true }).click();
  await expect(page.locator("#address-output")).toHaveText(address);
  await expect(page.getByRole("button", { name: "Build Transaction", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Build Transaction", exact: true }).click();
  await expect(page.locator("#tx-review")).toContainText("Fee:");
  await page.getByRole("checkbox").check();
  const signing = await popup(page, "Sign Transaction", credentials);
  await expect(signing.signer.getByText("Sign a transaction", { exact: true })).toBeVisible();
  await signing.signer.getByRole("button", { name: "Approve with passkey", exact: true }).click();
  await expect(page.locator("#out")).toContainText("Signed! (1 signature(s))");
  await expect(page.getByRole("button", { name: "Submit Transaction", exact: true })).toBeEnabled();
  expect(ledger.submissions).toEqual([]);

  const rejected = await popup(page, "Sign Transaction", credentials);
  await rejected.signer.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(page.locator("#out")).toContainText("Signing failed:");
  await expect(page.getByRole("button", { name: "Submit Transaction", exact: true })).toBeDisabled();

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const recovered = await popup(page, "Open passkey wallet", credentials);
  await recovered.signer.getByRole("button", { name: "Approve with passkey", exact: true }).click();
  await expect(page.locator("#address-output")).toHaveText(address);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), bindingKey)).toBe(publicKey);
});

test("wrong persisted public key fails closed", async ({ page }) => {
  const { credentials } = await create(page);
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify("a".repeat(128))), bindingKey);
  await page.reload();
  const reopened = await popup(page, "Open passkey wallet", credentials);
  await reopened.signer.getByRole("button", { name: "Approve with passkey", exact: true }).click();
  await expect(page.locator("#out")).toContainText("PasskeyWalletMismatchError");
  await expect(page.locator("#address-output")).not.toContainText("addr_test1");
  await expect(page.getByRole("button", { name: "Build Transaction", exact: true })).toBeDisabled();
});

test("closed popup can be retried without creating a wallet", async ({ page }) => {
  await page.goto("/");
  const first = await popup(page, "Create passkey wallet");
  await first.signer.close();
  await expect(page.locator("#out")).toContainText("Create error:");
  await expect(page.locator("#address-output")).not.toContainText("addr_test1");
  const retry = await popup(page, "Create passkey wallet");
  await expect(retry.signer.getByRole("button", { name: "Create a new wallet", exact: true })).toBeVisible();
  await retry.signer.close();
});
