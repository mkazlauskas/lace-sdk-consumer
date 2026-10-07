// Account-scoped reads. A Lace wallet can hold several accounts at once, such
// as the passkey account and a Cardano custody account, so the page never
// takes "the first address" or "all UTxOs": it selects them by account id.

/** The first address the wallet discovered for `accountId`. */
export function selectAccountAddress(
  addresses: readonly { address: string; accountId: string }[],
  accountId: string | undefined,
): string | undefined {
  if (!accountId) return undefined;
  return addresses.find((entry) => entry.accountId === accountId)?.address;
}

/** The spendable UTxOs of `accountId` only. */
export function selectAccountUtxos<Utxo>(
  utxosByAccount: Partial<Record<string, Utxo[]>>,
  accountId: string | undefined,
): Utxo[] {
  if (!accountId) return [];
  return utxosByAccount[accountId] ?? [];
}

/** Lovelace of a positive ADA amount with at most six decimal places. */
export function parseAdaAmount(text: string): bigint {
  const match = /^\s*(\d+)(?:\.(\d{1,6}))?\s*$/.exec(text);
  if (!match) throw new Error(`Invalid ADA amount: ${text}`);
  const lovelace = BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (lovelace <= 0n) throw new Error("The amount must be positive");
  return lovelace;
}
