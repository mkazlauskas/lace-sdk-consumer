import { createRemotePasskeySigner } from "@input-output-hk/lace-sdk/cardano";

export const signerUrl = import.meta.env.VITE_PASSKEY_SIGNER_URL || "https://passkey-preview.lace.io";
if (new URL(signerUrl).protocol !== "https:") {
  throw new Error("The hosted passkey signer requires an HTTPS URL");
}

export const signer = createRemotePasskeySigner({ signerUrl });
let signerBusy = false;

/**
 * Runs one signer request in a fresh popup. Call it synchronously from the
 * click handler: the popup opens before the first await, so the click still
 * carries browser user activation.
 */
export async function withSigner<T>(operation: () => Promise<T>): Promise<T> {
  if (signerBusy) throw new Error("Finish the current signer request first");
  signerBusy = true;
  let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    signer.open();
    await Promise.race([
      signer.connect(),
      new Promise<never>((_, reject) => {
        connectionTimeout = setTimeout(() => reject(new Error("Signer connection timed out. Check VITE_PASSKEY_SIGNER_URL and the hosted deployment.")), 20_000);
      }),
    ]);
    clearTimeout(connectionTimeout);
    return await operation();
  } finally {
    clearTimeout(connectionTimeout);
    signer.close();
    signerBusy = false;
  }
}
