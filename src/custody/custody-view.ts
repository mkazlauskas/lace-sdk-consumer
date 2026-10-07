import type { CardanoCustodyAccountState } from "@input-output-hk/lace-sdk/cardano";

// Pure text views of custody state for the demo page. Types only come from
// the SDK, so Node unit tests run this file without loading the SDK.

type Utxo = CardanoCustodyAccountState["fundUtxos"][number];
type LiveState = Extract<CardanoCustodyAccountState, { status: "live" }>;
type Grant = LiveState["state"]["grants"][number];

export type GrantStatus = "effective" | "expired" | "exhausted";

/** The short form of a key hash people compare across screens, as the signer shows it. */
export function fingerprint(keyHash: string): string {
  return `${keyHash.slice(0, 8)}…${keyHash.slice(-8)}`;
}

export function formatAda(lovelace: bigint): string {
  const sign = lovelace < 0n ? "-" : "";
  const absolute = lovelace < 0n ? -lovelace : lovelace;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0");
  return `${sign}${whole}.${fraction} ADA`;
}

export function sumLovelace(utxos: readonly Utxo[]): bigint {
  return utxos.reduce((total, [, output]) => total + output.value.coins, 0n);
}

const isLovelaceGrant = (grant: Grant) => grant.scope.asset.policyId === "" && grant.scope.asset.assetName === "";

/**
 * What a grant allows now. The chain keeps expired and exhausted grants
 * until a device revokes them; a revoked grant is simply gone.
 */
export function grantStatus(grant: Grant, now: number): GrantStatus {
  if (grant.scope.expiresAt <= BigInt(now)) return "expired";
  if (grant.scope.cap === 0n || (!isLovelaceGrant(grant) && grant.scope.lovelaceCap === 0n)) return "exhausted";
  return "effective";
}

/** Spendable and locked balances, the split the custody contract imposes. */
export function custodyBalances(state: CardanoCustodyAccountState) {
  return {
    spendable: sumLovelace(state.fundUtxos),
    locked: state.status === "live" ? state.lockedLovelace : 0n,
    stranded: sumLovelace(state.strandedUtxos),
    rewards: state.withdrawableRewards,
  };
}

export function describeCustodyState(
  state: CardanoCustodyAccountState | undefined,
  { now, deviceKeyHash, address }: { now: number; deviceKeyHash?: string; address?: string },
): string {
  if (!state) return "Custody account: waiting for the first sync";
  const balances = custodyBalances(state);
  const lines = [
    `Status: ${state.status}`,
    ...(address ? [`Address: ${address}`] : []),
    `Spendable: ${formatAda(balances.spendable)} in ${state.fundUtxos.length} UTxO(s)`,
    `Locked: ${formatAda(balances.locked)} (control output; the stake deposit is locked too)`,
    `Stranded: ${formatAda(balances.stranded)} in ${state.strandedUtxos.length} UTxO(s)`,
    `Withdrawable rewards: ${formatAda(balances.rewards)}`,
  ];
  if (state.status === "invalid") lines.push(`Invalid: ${state.reason.code}`);
  if (state.status !== "live") return lines.join("\n");

  const [control] = state.controlUtxo;
  lines.push(`Control UTxO: ${control.txId}#${control.index}`);
  if (state.currentDeviceListed !== undefined) lines.push(`This device listed: ${state.currentDeviceListed ? "yes" : "no"}`);
  lines.push(`Devices (${state.state.devices.length}):`);
  for (const device of state.state.devices) {
    lines.push(`  ${fingerprint(device)}${device === deviceKeyHash ? " (this device)" : ""}`);
  }
  lines.push(`Grants (${state.state.grants.length}), generation ${state.state.grantGeneration}:`);
  for (const grant of state.state.grants) {
    const { scope } = grant;
    const unit = isLovelaceGrant(grant) ? "lovelace" : `${scope.asset.policyId}.${scope.asset.assetName}`;
    lines.push(
      `  slot ${grant.slot} [${grantStatus(grant, now)}] grantee ${fingerprint(grant.grantee)}: ` +
        `${scope.perCallCap} ${unit} per spend, ${scope.cap} remaining, ` +
        `expires ${new Date(Number(scope.expiresAt)).toISOString()}, ` +
        `${scope.recipients.length === 0 ? "any recipient" : `${scope.recipients.length} recipient(s)`}`,
    );
  }
  return lines.join("\n");
}
