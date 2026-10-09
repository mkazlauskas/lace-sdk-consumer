import type { CardanoCustodyAccountState, observeCardanoCustodyAccountState, observeCardanoCustodyGrantStatuses } from "@input-output-hk/lace-sdk/cardano";

// Pure text views of custody state for the demo page. Types only come from
// the SDK, so Node unit tests run this file without loading the SDK.

type ObservedOf<T> = T extends (...args: never[]) => { subscribe(observer: (value: infer V) => void): unknown } ? V : never;
/** What `observeCardanoCustodyAccountState` emits: the state, with `depositAddress` on a live account that lists this device. */
export type ObservedCustodyState = ObservedOf<typeof observeCardanoCustodyAccountState>;
/** What `observeCardanoCustodyGrantStatuses` emits: every grant UTxO with its status. */
export type ObservedGrantStatuses = ObservedOf<typeof observeCardanoCustodyGrantStatuses>;
export type GrantWithStatus = NonNullable<ObservedGrantStatuses>[number];

type Utxo = CardanoCustodyAccountState["funds"][number];

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

const isLovelaceAsset = ({ policyId, assetName }: { policyId: string; assetName: string }) => policyId === "" && assetName === "";

/**
 * The balances the custody contract keeps apart. Agents spend funds only;
 * owner operations spend funds and own reserves. The control output's
 * minimum stays locked for the account's life, and its headroom above that
 * minimum is the owner fee reserve. Grant UTxOs hold their lovelace until a
 * sweep removes them. Nobody spends stranded deposits.
 */
export function custodyBalances(state: CardanoCustodyAccountState) {
  const live = state.status === "live";
  return {
    funds: sumLovelace(state.funds),
    ownReserves: sumLovelace(state.reserves.own),
    foreignReserves: sumLovelace(state.reserves.foreign),
    control: live ? state.controlUtxo[1].value.coins : 0n,
    controlMinimum: live ? state.controlMinimumLovelace : 0n,
    ownerFeeReserve: live ? state.controlHeadroomLovelace : 0n,
    grantLocked: state.grantLockedLovelace,
    stranded: sumLovelace(state.stranded),
    rewards: state.withdrawableRewards,
  };
}

/** One line per grant UTxO: its ID, its status as the SDK reports it, the grantee and what remains of the scope. */
export function describeGrant({ grant, status }: { grant: GrantWithStatus["grant"]; status: string }): string {
  const { scope } = grant;
  const unit = isLovelaceAsset(scope.asset) ? "lovelace" : `${scope.asset.policyId}.${scope.asset.assetName}`;
  return (
    `grant ID ${grant.slot} [${status}] grantee ${fingerprint(grant.grantee)}: ` +
    `${scope.perCallCap} ${unit} per spend, ${scope.cap} remaining, ` +
    `expires ${new Date(Number(scope.expiresAt)).toISOString()}, ` +
    `${scope.recipients.length === 0 ? "any recipient" : `${scope.recipients.length} recipient(s)`}`
  );
}

export function describeCustodyState(
  state: ObservedCustodyState,
  { deviceKeyHash, address, grants }: { deviceKeyHash?: string; address?: string; grants?: ObservedGrantStatuses },
): string {
  if (!state) return "Custody account: waiting for the first sync";
  const balances = custodyBalances(state);
  const lines = [`Status: ${state.status}`, ...(address ? [`Address: ${address}`] : [])];
  if (state.status === "invalid") {
    const { reason } = state;
    lines.push(`Invalid: ${reason.code}${reason.code === "unknown-logic" ? ` (logic ${reason.logic}, which this SDK does not accept)` : ""}`);
  }
  if (state.status === "live") lines.push(`Logic: ${state.state.logic}`);
  lines.push(
    `Spendable: ${formatAda(balances.funds)} in ${state.funds.length} UTxO(s)`,
    `Own reserves: ${formatAda(balances.ownReserves)} in ${state.reserves.own.length} UTxO(s)`,
  );
  if (state.reserves.foreign.length > 0) lines.push(`Foreign reserves (never spent): ${formatAda(balances.foreignReserves)} in ${state.reserves.foreign.length} UTxO(s)`);
  if (state.status === "live") {
    lines.push(
      `Control output: ${formatAda(balances.control)}: ${formatAda(balances.controlMinimum)} locked for the account's life, ${formatAda(balances.ownerFeeReserve)} owner fee reserve (the stake deposit is locked too)`,
    );
  }
  lines.push(
    `Grant UTxOs: ${formatAda(balances.grantLocked)} in ${state.grants.length} UTxO(s), held until a sweep`,
    `Stranded: ${formatAda(balances.stranded)} in ${state.stranded.length} UTxO(s)`,
    `Withdrawable rewards: ${formatAda(balances.rewards)}`,
  );
  if (state.anomalies.length > 0) lines.push(`Anomalies: ${state.anomalies.map(({ code }) => code).join(", ")}`);
  if (state.status !== "live") return lines.join("\n");

  const [control] = state.controlUtxo;
  lines.push(`Control UTxO: ${control.txId}#${control.index}`);
  if (state.currentDeviceListed !== undefined) lines.push(`This device listed: ${state.currentDeviceListed ? "yes" : "no"}`);
  if (state.depositAddress) lines.push(`Deposit address: ${state.depositAddress}`);
  lines.push(`Devices (${state.state.devices.length}):`);
  for (const device of state.state.devices) {
    lines.push(`  ${fingerprint(device)}${device === deviceKeyHash ? " (this device)" : ""}`);
  }
  const { grantGeneration, nextSlot, revoked, outstanding } = state.state;
  lines.push(
    `Grant generation ${grantGeneration}, next grant ID ${nextSlot}, outstanding ${outstanding}, revoked IDs: ${revoked.length === 0 ? "none" : revoked.join(", ")}`,
  );
  // Statuses come from their own observable, which may emit after the state.
  const listed = grants ?? state.grants.map(({ grant }) => ({ grant, status: "syncing" }));
  lines.push(`Grants (${listed.length}):`);
  for (const grant of listed) lines.push(`  ${describeGrant(grant)}`);
  return lines.join("\n");
}

/**
 * The fee sponsor line: what the relay's `GET /health` answered, or why it
 * did not. The hosted service answers `{ ok, network, pool }`; the relay and
 * the service answer an error with `{ error, detail }`.
 */
export function describeSponsorHealth(answer: { status: number; body: unknown } | { failure: string }): string {
  const heading = "Fee sponsor: hosted, through this server's /sponsor relay";
  if ("failure" in answer) return `${heading}\nUnreachable: ${answer.failure}`;
  const body = (typeof answer.body === "object" && answer.body !== null ? answer.body : {}) as Record<string, unknown>;
  if (answer.status === 200 && body.ok === true) {
    const pool = body.pool as { fee?: { free?: number; leased?: number }; collateral?: { shared?: boolean } } | undefined;
    return (
      `${heading}\nNetwork ${String(body.network)}: ` +
      `${pool?.fee?.free ?? "?"} fee UTxO(s) free, ${pool?.fee?.leased ?? "?"} leased, ` +
      `collateral ${pool?.collateral?.shared ? "shared" : "not available"}`
    );
  }
  const code = typeof body.error === "string" ? ` ${body.error}` : "";
  const detail = typeof body.detail === "string" ? `: ${body.detail}` : "";
  return `${heading}\nUnavailable: HTTP ${answer.status}${code}${detail}`;
}
