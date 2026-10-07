import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";

// Serve the real PR signer build at an intercepted HTTPS origin. This tests
// cross-origin messaging and real signing, without depending on deployment.
export const signerOrigin = "https://passkey-preview.lace.io";
export const signerDist = resolve(process.env.SIGNER_DIST ?? "../lace-platform/.agents/workspaces/lw-15692-custody/apps/lace-passkey-signer/dist");
const mime: Record<string, string> = { ".js": "application/javascript", ".css": "text/css", ".wasm": "application/wasm", ".html": "text/html", ".png": "image/png", ".otf": "font/otf", ".ttf": "font/ttf" };

export type Credential = { credentialId: string; isResidentCredential: boolean; rpId?: string; privateKey: string; userHandle?: string; signCount: number };

export async function prepareSigner(context: BrowserContext) {
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

/** Any consumer-side WebAuthn invocation is an isolation regression. */
export async function forbidConsumerWebAuthn(page: Page) {
  await page.addInitScript(() => {
    for (const method of ["create", "get"] as const) {
      Object.defineProperty(navigator.credentials, method, { value: () => { throw new Error("Consumer must not access passkeys"); } });
    }
  });
}

/** Clicks a consumer button that opens the signer popup and gives the popup a virtual authenticator. */
export async function popup(page: Page, button: string, credentials: Credential[] = []) {
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
