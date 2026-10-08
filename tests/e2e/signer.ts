import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import type { BrowserContext, Page, Request } from "@playwright/test";

// Serve the real PR signer build at an intercepted HTTPS origin. This tests
// cross-origin messaging and real signing, without depending on deployment.
export const signerOrigin = "https://passkey-preview.lace.io";
export const signerDist = resolve(process.env.SIGNER_DIST ?? "../lace-platform/.agents/workspaces/lw-15692-custody/apps/lace-passkey-signer/dist");
const mime: Record<string, string> = { ".js": "application/javascript", ".css": "text/css", ".wasm": "application/wasm", ".html": "text/html", ".png": "image/png", ".otf": "font/otf", ".ttf": "font/ttf" };

let signerBuildChecked = false;

/**
 * The signer build this run serves, by the SHA-256 of its `index.html`.
 * Fails when `EXPECTED_SIGNER_INDEX_SHA256` names another build.
 */
function checkSignerBuild() {
  if (signerBuildChecked) return;
  const digest = createHash("sha256").update(readFileSync(resolve(signerDist, "index.html"))).digest("hex");
  const expected = process.env.EXPECTED_SIGNER_INDEX_SHA256;
  if (expected && expected.toLowerCase() !== digest) {
    throw new Error(`Signer build ${signerDist} has index.html SHA-256 ${digest}, expected ${expected}`);
  }
  console.log(`Signer build: ${signerDist}, index.html SHA-256 ${digest}${expected ? " (as expected)" : ""}`);
  signerBuildChecked = true;
}

export type Credential = { credentialId: string; isResidentCredential: boolean; rpId?: string; privateKey: string; userHandle?: string; signCount: number };

export async function prepareSigner(context: BrowserContext) {
  checkSignerBuild();
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

const frameOriginOf = (request: Request): string | undefined => {
  try {
    return new URL(request.frame().url()).origin;
  } catch {
    // A service worker request has no frame.
    return undefined;
  }
};

/**
 * Records the signer page's requests, popups included. The signer signs from
 * the request's context alone, so it must never call another origin: no
 * Blockfrost on any network, no other chain provider, no other service.
 */
export function recordSignerRequests(context: BrowserContext) {
  const recorded = { count: 0, toOtherOrigins: [] as string[] };
  context.on("request", (request) => {
    if (frameOriginOf(request) !== signerOrigin && request.headers().origin !== signerOrigin) return;
    recorded.count += 1;
    if (new URL(request.url()).origin !== signerOrigin) recorded.toOtherOrigins.push(`${request.method()} ${request.url()}`);
  });
  return recorded;
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
