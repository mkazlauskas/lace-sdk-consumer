import { expect, test, type Page } from "@playwright/test";
import { mockBlockfrost } from "./blockfrost";

const BINDING_KEY = "lace-passkey-wallet-v1";

async function authenticator(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      hasPrf: true,
    },
  });
  await page.addInitScript(() => {
    const nativeGet = CredentialsContainer.prototype.get;
    Object.defineProperty(window, "__prfChecks", { value: { assertions: 0, results: 0 }, writable: false });
    CredentialsContainer.prototype.get = async function (options) {
      const credential = await nativeGet.call(this, options);
      if (options?.publicKey) {
        window.__prfChecks.assertions++;
        const results = (credential as PublicKeyCredential | null)?.getClientExtensionResults().prf?.results;
        if (results?.first?.byteLength === 32 && results?.second?.byteLength === 32) window.__prfChecks.results++;
      }
      return credential;
    };
  });
  return { cdp, authenticatorId };
}

declare global {
  interface Window { __prfChecks: { assertions: number; results: number } }
}

async function create(page: Page) {
  const startupError = new Promise<never>((_, reject) => page.once("pageerror", reject));
  await page.goto("/");
  await Promise.race([page.getByRole("button", { name: "Create passkey wallet" }).click(), startupError]);
  await expect(page.locator("#out")).toContainText("Passkey wallet created", { timeout: 25_000 });
  try {
    await expect(page.locator("#address-output")).toContainText("addr_test1");
  } catch (error) {
    const state = JSON.parse(await page.locator("#state-output").innerText());
    console.error("Address diagnostics:", {
      accountNetworks: Object.values(state.wallets.entities).flatMap((wallet: any) => wallet.accounts.map((account: any) => account.blockchainNetworkId)),
      active: state.wallets.activeAccountContext,
      addresses: state.addresses.addresses.length,
      sync: state.sync.syncStatusByAccount,
    });
    throw error;
  }
  const address = await page.locator("#address-output").innerText();
  await expect.poll(async () => Object.keys(JSON.parse(await page.locator("#state-output").innerText()).wallets.entities).length).toBe(1);
  const state = JSON.parse(await page.locator("#state-output").innerText());
  const [entity] = Object.values(state.wallets.entities) as Array<{ type: string; accounts: Array<{ blockchainNetworkId: string }>; encryptedRecoveryPhrase?: string }>;
  expect(entity.type).toBe("LazyInMemory");
  expect(entity.accounts.map((account) => account.blockchainNetworkId)).toEqual(["cardano-1"]);
  expect(entity.encryptedRecoveryPhrase).toBeUndefined();
  const binding = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), BINDING_KEY);
  expect(binding).toEqual({
    credentialId: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
    rpId: "localhost",
    recipeVersion: "v1",
    fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  const prf = await page.evaluate(() => window.__prfChecks);
  expect(prf.assertions).toBe(1);
  expect(prf.results).toBe(1); // Verify actual browser PRF outputs, not only hasPrf capability.
  console.log("Created public address:", address, "PRF assertions/results:", prf);
  return { address, binding };
}

test("create, reload and storage clear preserve bound address", async ({ page }) => {
  page.on("pageerror", (error) => console.error("Browser error:", error.message));
  await authenticator(page);
  const blockfrost = await mockBlockfrost(page);
  let created: Awaited<ReturnType<typeof create>>;
  try {
    created = await create(page);
  } catch (error) {
    console.error("Blockfrost requests:", blockfrost.requests);
    throw error;
  }
  const { address, binding } = created;
  await page.reload();
  await expect(page.locator("#address-output")).not.toContainText("addr_test1");
  await page.getByRole("button", { name: "Open passkey wallet" }).click();
  await expect(page.locator("#address-output")).toHaveText(address);
  expect(await page.evaluate(() => window.__prfChecks)).toEqual({ assertions: 1, results: 1 });

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(page.getByRole("button", { name: "Create passkey wallet" })).toBeVisible();
  await expect(page.locator("#address-output")).not.toContainText("addr_test1");
  await page.getByRole("button", { name: "Open passkey wallet" }).click();
  await expect(page.locator("#address-output")).toHaveText(address);
  expect(await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), BINDING_KEY)).toEqual(binding);
  expect(await page.evaluate(() => window.__prfChecks)).toEqual({ assertions: 1, results: 1 });
});

test("second credential with first wallet fingerprint fails closed", async ({ page }) => {
  await authenticator(page);
  await mockBlockfrost(page);
  const first = await create(page);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const second = await create(page);
  expect(second.binding.credentialId).not.toBe(first.binding.credentialId);
  await page.evaluate(({ key, firstBinding, secondId }) => {
    localStorage.setItem(key, JSON.stringify({ ...firstBinding, credentialId: secondId }));
  }, { key: BINDING_KEY, firstBinding: first.binding, secondId: second.binding.credentialId });
  await page.reload();
  await page.getByRole("button", { name: "Open passkey wallet" }).click();
  await expect(page.locator("#out")).toContainText("PasskeyWalletMismatchError");
  await expect(page.locator("#address-output")).not.toContainText("addr_test1");
  await expect(page.getByRole("button", { name: "Build Transaction" })).toBeDisabled();
  expect(await page.evaluate(() => window.__prfChecks)).toEqual({ assertions: 1, results: 1 });
});

test("CDP authenticator returns two real PRF outputs", async ({ page }) => {
  await authenticator(page);
  await page.goto("/tests/e2e/prf-probe.html");
  await page.getByRole("button", { name: "Probe WebAuthn PRF" }).click();
  await expect(page.locator("#result")).toHaveText("PRF supported");
  expect(await page.evaluate(() => window.__prfChecks)).toEqual({ assertions: 1, results: 1 });
});

test("build and sign after review uses exactly one fresh assertion without submitting", async ({ page }) => {
  await authenticator(page);
  const blockfrost = await mockBlockfrost(page);
  const { address } = await create(page);
  blockfrost.fund(address);
  await page.reload();
  await page.getByRole("button", { name: "Open passkey wallet" }).click();
  await expect(page.getByRole("button", { name: "Build Transaction" })).toBeEnabled();
  await page.getByRole("button", { name: "Build Transaction" }).click();
  await expect(page.locator("#tx-review")).toContainText("Fee:");
  const before = await page.evaluate(() => window.__prfChecks);
  await page.getByRole("checkbox", { name: "I reviewed the Preprod transaction and recipient" }).check();
  await page.getByRole("button", { name: "Sign Transaction" }).click();
  await expect(page.locator("#out")).toContainText("Signed! (1 signature(s))");
  const after = await page.evaluate(() => window.__prfChecks);
  expect(after).toEqual({ assertions: before.assertions + 1, results: before.results + 1 });
  await page.getByRole("button", { name: "Sign Transaction" }).click();
  await expect(page.locator("#out")).toContainText(/Signed! \(1 signature\(s\)\)[\s\S]*Signed! \(1 signature\(s\)\)/);
  const afterSecond = await page.evaluate(() => window.__prfChecks);
  expect(afterSecond).toEqual({ assertions: after.assertions + 1, results: after.results + 1 });
  await expect(page.getByRole("button", { name: "Submit Transaction" })).toBeEnabled();
  await expect(page.locator("#out")).not.toContainText("Submitted!");
  expect(blockfrost.submissions()).toBe(0);
  console.log("Signed fixture transaction twice: 1 signature per call, PRF counts:", before, after, afterSecond, "submissions:", blockfrost.submissions());
});
