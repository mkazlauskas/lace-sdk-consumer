export const BINDING_KEY = "lace-remote-passkey-wallet-v1";

export function bindingKey(signerUrl: string): string {
  return `${BINDING_KEY}:${new URL(signerUrl).origin}:0`;
}

export function readBinding(storage: Pick<Storage, "getItem">, signerUrl: string): string | null {
  const raw = storage.getItem(bindingKey(signerUrl));
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "string" && /^[0-9a-f]{128}$/.test(value)
    ) return value;
  } catch {
    // A corrupt binding must never be treated as a new wallet.
  }
  throw new Error("Saved wallet binding is invalid. Wallet remains locked.");
}
