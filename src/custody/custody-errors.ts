import { formatAda } from "./custody-view";

// Readable log lines for the errors the custody flow surfaces. Errors are
// told apart by their `code`, which every SDK custody error, the fee sponsor
// error and the hosted signer error carry: a minified build may rename
// classes, but not codes. Nothing here loads the SDK.

type Described = Error & {
  code?: unknown;
  reason?: unknown;
  detail?: unknown;
  rule?: unknown;
  status?: unknown;
  rewardAccount?: unknown;
  balance?: unknown;
};

/** What to do about an SDK custody error, by its `code`. */
const CUSTODY_HINTS: Record<string, (error: Described) => string> = {
  "custody-logic-not-registered": ({ rewardAccount }) =>
    `The logic's reward account ${String(rewardAccount)} must be registered on this network, once and outside Lace, before any account transaction.`,
  "custody-logic-reward-balance": ({ balance }) =>
    `Someone paid ${typeof balance === "bigint" ? formatAda(balance) : String(balance)} into the logic's reward account. Every account transaction must withdraw that balance, and the fee sponsor refuses a logic run that draws anything, so building again does not help until the balance is gone.`,
  "custody-logic-not-served": () => "The fee sponsor lends no collateral to transactions of this account's logic. Building again does not help.",
  "custody-script-data-hash": () =>
    "The fee sponsor computed another script data hash, most likely from other cost models than this wallet's provider reports. Building again does not help while they differ.",
  "custody-reward-balance-changed": () => "A reward balance changed between the build and the submission, as at an epoch boundary. Wait for the wallet to sync and run the operation again.",
  "custody-outcome-unknown": () =>
    "The transaction may still settle. Do not submit it again; wait for it. Once a grant settles, Export agent policy exports its policy.",
  "custody-unsupported-version": () =>
    "The account belongs to another build of the custody contract, which this SDK does not operate. Create a new account.",
  "custody-origin-not-allowed": () =>
    "The hosted signer serves custody requests only for the origins its build lists. Run this page on an origin the signer lists, or ask the signer operator to add this one.",
};

/** What to do about a fee sponsor refusal, by the service's error `code`, which the relay's own refusals share. */
const SPONSOR_HINTS: Record<string, string> = {
  // The variable is named in .env.example and in the relay's own answer, never in the bundle.
  unauthorized: "The sponsor refused the relay's key. Give the development server the Lace testing key as its sponsor key (see .env.example) and restart it.",
  relay_not_configured: "Give the development server its sponsor key (see .env.example) and restart it.",
  quota_exceeded: "The sponsor key reached one of its quotas. Try again later.",
  rate_limited: "The sponsor rate-limited the relay. Try again in a minute.",
  no_utxo_available: "Every sponsor UTxO is in use. Try again later.",
  out_of_funds: "The sponsor's pool is empty. Ask the sponsor operator to fund it.",
  unexpected_response: "The relay or the sponsor answered in a shape the SDK does not know. Check the development server's terminal.",
};

const json = (value: unknown) => JSON.stringify(value, (_, item) => (typeof item === "bigint" ? `${item}` : item));

const hintOf = (error: Described): string | undefined => {
  if (typeof error.code !== "string") return undefined;
  if (error.code in CUSTODY_HINTS) return CUSTODY_HINTS[error.code](error);
  // The fee sponsor's error carries the HTTP status of its answer.
  if (typeof error.status === "number" && error.code in SPONSOR_HINTS) return SPONSOR_HINTS[error.code];
  return undefined;
};

/**
 * One log line for an error: its name, its `code` (which a minified build
 * keeps when it renames the class), its message, the structured `reason`
 * and `detail` an SDK error carries when they are not text, and what to do
 * about the custody, sponsor and signer refusals people can act on.
 */
export function describeCustodyError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const described = error as Described;
  const code = typeof described.code === "string" ? ` [${described.code}]` : "";
  const extra = [described.reason, described.detail].filter((value) => value !== undefined && typeof value !== "string").map(json);
  const hint = hintOf(described);
  return `${error.name}${code}: ${error.message}${extra.length > 0 ? ` ${extra.join(" ")}` : ""}${hint ? `. ${hint}` : ""}`;
}
