import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { mockBlockfrost } from "./blockfrost";

// Serve the real PR signer build at an intercepted HTTPS origin. This tests
// cross-origin messaging and real signing, without depending on deployment.
const signerOrigin = "https://passkey-preview.lace.io";
const bindingKey = `lace-remote-passkey-wallet-v1:${signerOrigin}:0`;
const signerDist = resolve(process.env.SIGNER_DIST ?? "../lace-platform/.claude/worktrees/pr-2805/apps/lace-passkey-signer/dist");
const mime: Record<string, string> = { ".js": "application/javascript", ".css": "text/css", ".wasm": "application/wasm", ".html": "text/html", ".png": "image/png", ".otf": "font/otf", ".ttf": "font/ttf" };

async function prepare(context: BrowserContext) {
  // CDP cannot export/import a credential's PRF secret across popup targets.
  // Simulate only PRF output, deterministically from the virtual credential and
  // requested salts. Signer derivation, account checks and signatures stay real.
  await context.addInitScript(origin => {
    if (location.origin !== origin) return;
    const get = navigator.credentials.get.bind(navigator.credentials);
    navigator.credentials.get = async options => {
      const credential = await get(options) as PublicKeyCredential | null;
      if (!credential || !options?.publicKey?.extensions?.prf) return credential;
      const prf = options.publicKey.extensions.prf;
      const salts = prf.eval ?? Object.values(prf.evalByCredential ?? {})[0];
      if (!salts) throw new Error("Missing PRF salts");
      const derive = async (salt: BufferSource) => {
        const saltBytes = ArrayBuffer.isView(salt) ? new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength) : new Uint8Array(salt);
        const bytes = new Uint8Array(credential.rawId.byteLength + saltBytes.byteLength);
        bytes.set(new Uint8Array(credential.rawId));
        bytes.set(saltBytes, credential.rawId.byteLength);
        return crypto.subtle.digest("SHA-256", bytes);
      };
      const results = { first: await derive(salts.first), second: salts.second ? await derive(salts.second) : undefined };
      credential.getClientExtensionResults = () => ({ prf: { results } });
      return credential;
    };
  }, signerOrigin);
  await context.route(`${signerOrigin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const file = resolve(signerDist, `.${path === "/" ? "/index.html" : path}`);
    if (!file.startsWith(`${signerDist}/`)) return route.abort();
    await route.fulfill({ body: await readFile(file), contentType: mime[extname(file)] ?? "application/octet-stream" });
  });
}

type Credential = { credentialId: string; isResidentCredential: boolean; rpId?: string; privateKey: string; userHandle?: string; signCount: number };

async function popup(page: Page, button: string, credentials: Credential[] = []) {
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: button, exact: true }).click();
  const signer = await opened;
  await signer.bringToFront();
  const cdp = await page.context().newCDPSession(signer);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true, hasPrf: true },
  });
  for (const credential of credentials) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  return { signer, cdp, authenticatorId };
}

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

test.beforeEach(async ({ context, page }) => {
  await prepare(context);
  // Any consumer-side WebAuthn invocation is an isolation regression.
  await page.addInitScript(() => {
    for (const method of ["create", "get"] as const) {
      Object.defineProperty(navigator.credentials, method, { value: () => { throw new Error("Consumer must not access passkeys"); } });
    }
  });
});

test("hosted create, reopen, recovery and signing keep keys on signer", async ({ page }) => {
  const blockfrost = await mockBlockfrost(page);
  const { credentials, address, publicKey } = await create(page);
  blockfrost.fund(address);
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
  expect(blockfrost.submissions()).toBe(0);

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
  await mockBlockfrost(page);
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
  await mockBlockfrost(page);
  await page.goto("/");
  const first = await popup(page, "Create passkey wallet");
  await first.signer.close();
  await expect(page.locator("#out")).toContainText("Create error:");
  await expect(page.locator("#address-output")).not.toContainText("addr_test1");
  const retry = await popup(page, "Create passkey wallet");
  await expect(retry.signer.getByRole("button", { name: "Create a new wallet", exact: true })).toBeVisible();
  await retry.signer.close();
});
