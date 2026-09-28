import type { PasskeyWalletBinding } from "@input-output-hk/lace-sdk/cardano";

export const BINDING_KEY = "lace-passkey-wallet-v1";

export type WalletBinding = PasskeyWalletBinding;

export function readBinding(storage: Pick<Storage, "getItem">): WalletBinding | null {
  const raw = storage.getItem(BINDING_KEY);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" && value !== null &&
      "rpId" in value && value.rpId === "localhost" &&
      "recipeVersion" in value && value.recipeVersion === "v1" &&
      "credentialId" in value && typeof value.credentialId === "string" &&
      /^[A-Za-z0-9_-]+$/.test(value.credentialId) &&
      "fingerprint" in value && typeof value.fingerprint === "string" &&
      /^[0-9a-f]{64}$/.test(value.fingerprint) &&
      Object.keys(value).sort().join(",") === "credentialId,fingerprint,recipeVersion,rpId"
    ) return value as WalletBinding;
  } catch {
    // A corrupt binding must never be treated as a new wallet.
  }
  throw new Error("Saved wallet binding is invalid or uses another recipe. Wallet remains locked.");
}
