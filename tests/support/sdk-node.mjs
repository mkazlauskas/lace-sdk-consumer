import { createRequire } from "node:module";

// The SDK's CommonJS build, for Node unit tests. The fake ledger and the fake
// sponsor `require` the same build, so the tests share one SDK instance with
// them. Its bundled libsodium looks for `window` or `self` for a random
// number generator before Node's crypto.
globalThis.self ??= globalThis;
const sdk = createRequire(import.meta.url)("@input-output-hk/lace-sdk/cardano");

export const {
  CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH,
  CARDANO_CUSTODY_LOGIC_HASH,
  Cardano,
  CardanoCustodyGrantSpendError,
  CardanoCustodyLogicNotRegisteredError,
  CardanoCustodyLogicNotServedError,
  CardanoCustodyLogicRewardBalanceError,
  CardanoCustodyOutcomeUnknownError,
  CardanoCustodyRewardBalanceChangedError,
  CardanoCustodyScriptDataHashError,
  CardanoCustodySponsorError,
  CardanoCustodyUnsupportedVersionError,
  HexBlob,
  RemoteSignerError,
  Serialization,
} = sdk;
export default sdk;
