import { createRequire } from "node:module";

// The SDK's CommonJS build, for Node unit tests. Its bundled libsodium looks
// for `window` or `self` for a random number generator before Node's crypto.
globalThis.self ??= globalThis;
const sdk = createRequire(import.meta.url)("@input-output-hk/lace-sdk/cardano");

export const { Cardano, CardanoCustodySponsorError, HexBlob, Serialization } = sdk;
export default sdk;
