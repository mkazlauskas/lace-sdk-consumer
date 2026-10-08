# Hosted passkey Cardano consumer

This setup replaces the local-passkey flow described in the older README. The consumer installs the Lace SDK as an `npm pack` tarball, never as a `file:` link to a source directory.

## Package identity

| Item | Value |
| --- | --- |
| Platform source | `lace-platform` branch `feat/lw-15692-cardano-custody-account`, commit `8dab56ecfadb4fd996cbffd7c2ad4029af3ed27a` ("wip: phase 4 SDK custody API and orchestration"), built in a detached worktree of that commit |
| Toolchain | Node 24.14.0 from the platform `.nvmrc`, `npm install`, `npx nx run lace-sdk:build --skip-nx-cache`, `npx nx run lace-passkey-signer:build` |
| SDK tarball | `vendor/input-output-hk-lace-sdk-0.1.0-8dab56ecf.tgz` from `npm pack -w @input-output-hk/lace-sdk` |
| Tarball SHA-256 | `cca811f15fc83a771743710399d76618e79d1fe9301e96237a212f4144ecc972` |
| Signer build `dist/index.html` SHA-256 | `03cf7ebd6f66b9d3150bb22263536485d9f2d984ec51f418b980df0c6bc52492` |

The tarball is committed under `vendor/`, and `package.json` and `package-lock.json` install it from there, so `npm ci` reproduces the dependency on any machine. Check its hash before you install:

```bash
sha256sum vendor/input-output-hk-lace-sdk-0.1.0-8dab56ecf.tgz
npm ci
```

The signer build is not committed. A copy of it (`signer-dist-8dab56ecf/`) and the live Preprod evidence are in `/tmp/claude-1000/-home-mkazlauskas-Code-iog-lace-platform/a26089d5-8da3-4965-8dee-fb863b8138ff/scratchpad/consumer-live/`, a session scratch directory that a reboot may clear. To rebuild the signer, build `lace-passkey-signer` from the platform commit above and compare its `dist/index.html` hash.

A later platform commit that changes the SDK or the signer invalidates the browser evidence below until the suite runs again against a new tarball and signer build.

## Start

The hosted signer must include the custody request kinds (`cardano-custody-public-key`, `sign-cardano-custody-tx`) for the custody flow. A deployed signer without them answers the custody requests with an error, which the SDK reports as `CardanoCustodyUnsupportedSignerError`. Building the signer locally does not update the hosted service.

Set these values in `.env`:

```dotenv
VITE_PASSKEY_SIGNER_URL=https://passkey-preview.lace.io
VITE_BLOCKFROST_URL_PREPROD=https://cardano-preprod.blockfrost.io
VITE_BLOCKFROST_PROJECT_ID_PREPROD=YOUR_PREPROD_PROJECT_ID
# Optional: tip poll interval in milliseconds, 30000 by default.
VITE_TIP_POLL_MS=30000
```

Use the actual deployed HTTPS signer URL if it differs. The signer uses its own hostname as the relying-party ID. Changing that hostname changes the passkey domain and the consumer's saved identity slot.

```bash
npm install
npm run dev -- --host localhost
```

Open the URL Vite reports. The consumer can run on localhost; the passkey origin is the hosted signer's HTTPS origin. Allow the signer popup.

## Manual test

1. Click **Create passkey wallet**. In the hosted popup, choose an existing passkey or create a new wallet. Approve **Share your Cardano account**. If the signer already has a credential, it reuses it; the consumer's Create button does not force a new credential.
2. Record the Preprod address. Reload, click **Open passkey wallet**, and approve sharing the account again. The address must match.
3. Fund that address with Preprod test ADA. Wait for the spendable balance, enter a recipient and an amount, click **Build Transaction**, inspect the recipient, amount, change, fee, and CBOR, then check the review box.
4. Click **Sign Transaction**. Inspect the hosted signer's transaction details and approve with the passkey. The consumer displays the signed transaction and enables **Submit Transaction**.
5. Submission is a separate action. Only click **Submit Transaction** if you intend to send the displayed Preprod transaction.
6. Reject a signing request or close the popup while it waits. The consumer must report failure and allow retry. A failed signing attempt clears any previous signed transaction available for submission.

The consumer stores only the account public key, under `lace-remote-passkey-wallet-v1:<signer-origin>:0`. On reopen, the SDK rejects a different key before adding the wallet. After clearing consumer storage, Open can bind the selected hosted account again, but there is no previous key to compare. Verify the displayed address against your record.

The former `lace-passkey-wallet-v1` binding is not migrated or deleted. A localhost credential and a hosted credential are different identities. Wallet state stays in memory. No consumer-side WebAuthn call, PRF output, mnemonic, or credential reference is needed.

The wallet can hold the passkey account and a custody account at the same time. The page therefore selects the passkey account's address, UTxOs and tokens by its account id, and signs ordinary transactions with that account id. The SDK never offers custody UTxOs to the ordinary transaction builder.

## Cardano custody account

The custody section is a proof of concept of the SDK custody API (LW-15692) and the hosted signer custody consent (LW-15693). The custody contract is unaudited. Use Preprod test ADA only.

### Roles

- **Device**: the hosted signer passkey. Its CIP-1854 key `m/1854'/1815'/1'/0/i` owns the account. The page keeps only public values: the account extended public key, under `lace-custody-device-v1:<signer-origin>:1`, and the account record with the device binding, under `lace-custody-account-v1:<signer-origin>:1`.
- **Fee sponsor**: `src/custody/dev-sponsor.ts`, a development stand-in for the fee sponsor service. It implements the SDK's `CardanoCustodySponsor` interface with an in-memory Ed25519 key that is lost on reload. It reads its own UTxOs and the outputs a transaction spends from Blockfrost, and it applies the service's transaction policy before it signs:
  - sponsor inputs: the leased fee UTxO and no other sponsor UTxO in fee mode, no sponsor UTxO in collateral mode, and no input without a readable payment credential;
  - the shared collateral, its return to the sponsor and the total collateral;
  - a validity upper bound inside the sponsor's window;
  - an account transaction: an input is an account control UTxO, or the transaction creates an account (one state token minted under the account policy, one script stake registration with its deposit, the token named after that credential and held at an account address staked to it);
  - in fee mode, a fee within the limit, exactly one plain change output to the sponsor, and a draw on the fee UTxO of exactly the fee, plus the deposit and the control output's lovelace at a creation; in collateral mode, no output to the sponsor key;
  - every output away from the sponsor and the account covered by the other inputs and withdrawals;
  - every input known to the chain, and the sponsor key never a required signer.

  It does not evaluate scripts and does not check for foreign scripts, which the service also does. A witnessed fee UTxO stays leased until the chain spends it, or until the current slot is more than 120 slots past the witnessed validity bound, so a rejected creation consent frees it again. The sponsor never submits.
- **Agent**: a development Ed25519 key held in memory outside Lace, standing in for an agent's own wallet. The agent opens the account in a second, separate SDK wallet from the exported agent policy alone. That wallet has no passkey, no device binding and no vault.

### Flow

1. Open the passkey wallet and fund it. Fund the sponsor address shown on the page with one UTxO of exactly 5 ADA (the shared collateral) and one UTxO of at least 10 ADA (the fee UTxO).
2. **Share custody device key**. The popup asks **Share your Cardano custody device key** for Preprod and the path `m/1854'/1815'/1'`. The page shows the device fingerprint.
3. **Create custody account**. The sponsor leases its fee UTxO (fee mode), the SDK builds and checks the creation, the sponsor signs, then the popup asks **Create Cardano custody account**. It lists the permanent deposit, the device list with this device marked, and no grants. The SDK verifies both witnesses, merges them and submits, then waits until the account is live. The page shows the spendable and the locked (control output) lovelace separately.
4. **Deposit to custody account** fills the ordinary transfer's recipient with the custody address. An ordinary transfer then funds the account: the popup is the ordinary **Sign a transaction** and names the output as a Cardano custody account. Owner operations and grant spends pay their fees from these funds.
5. **Grant agent spending** issues a lovelace grant to the agent key: 4 ADA per spend, 6 ADA in total, one recipient, valid for a day. The popup asks **Grant spending to an agent** and shows each cap, the expiry and the recipient. Once the grant settles, the page exports the agent policy into the text box.
6. **Open account as agent** creates the agent's observer wallet from the policy. **Agent: build, sign and submit spend** builds the grant spend in the observer wallet, signs its body hash with the agent key, and submits it with the sponsor's collateral witness. The fee, about 1.1 ADA with the SDK's fixed script budgets, comes from the account and counts against both caps.
7. A spend above what the grant allows is refused before any signature: the SDK names the cap it breaks.
8. **Revoke agent grant** removes the grant after the popup asks **Revoke an agent grant**. A later agent spend under it is refused with `unknown-grant`.

## Verification

```bash
npm run typecheck
npm test
npm run build
SIGNER_DIST=/path/to/lace-passkey-signer/dist \
EXPECTED_SIGNER_INDEX_SHA256=03cf7ebd6f66b9d3150bb22263536485d9f2d984ec51f418b980df0c6bc52492 \
npm run test:e2e
```

The browser suite serves the real PR signer build through Playwright interception at `https://passkey-preview.lace.io`. `SIGNER_DIST` defaults to `../lace-platform/.agents/workspaces/lw-15692-custody/apps/lace-passkey-signer/dist`, a checkout that other builds can overwrite. The suite prints the SHA-256 of the `index.html` it serves, and fails when `EXPECTED_SIGNER_INDEX_SHA256` names another build. Set `E2E_PORT` to change the browser suite's default consumer port, 5198.

`npm test` runs the Node unit tests, among them the development sponsor's policy and lease rules (`tests/dev-sponsor.test.mjs`) and the fake ledger's refusals (`tests/fake-ledger.test.mjs`). The SDK's ESM build does not load in Node, because it imports `lodash/*` subpaths without a file extension, so `tests/support/` points the tests at the SDK's CommonJS build.

`tests/e2e/passkey.spec.ts` exercises cross-origin popup messaging, create/reopen/recovery, public-key mismatch rejection, signing, rejection, and popup-close retry, without submitting. `tests/e2e/custody.spec.ts` runs the custody flow above end to end and submits every transaction to the fake ledger: creation, deposit, grant, grant spend and revocation. It asserts the custody consent titles and their rows in each popup (the stake deposit, the device, the fee payer and the collateral provider of a creation; the grant ID, the grantee's full key hash, the caps, the expiry and the recipient of a grant; the revoked grant ID), the spendable and locked balances, the exported agent policy, that the grant's remaining cap falls by exactly the payment plus the fee the ledger applied, the overspend and revoked-grant refusals, and that no request for state NFT metadata is made.

`tests/e2e/fake-ledger.ts` is a small Preprod ledger behind the Blockfrost API. It uses Preprod's PlutusV3 cost models and protocol parameters (captured from live Preprod epoch 317), Preprod eras, and a tip that follows its clock. It keeps per-address UTxOs with inline datums, answers transaction, account, registration and reward endpoints, and evaluates scripts with fixed per-redeemer budgets in the Ogmios dialect the SDK parses. `tx/submit` applies a transaction only when its inputs are unspent, its validity interval holds, it fits the maximum size, it pays at least the minimum fee (size, declared execution units and reference scripts, with the size taken without the `is_valid` flag as the ledger does), every output and the collateral return hold their minimum lovelace, its collateral matches the total collateral and covers 150% of the fee, its execution units stay within the transaction limits, every vkey witness verifies with all required signers present, and its value balances. The ledger does not run Plutus scripts, so it does not prove that the custody validators accept these transactions.

The suite records, at the browser context level and popups included, every request the signer page sends. It fails if the signer sends any request to another origin, Blockfrost on any network included, and it checks that the signer's own requests were seen. Tests reject any WebAuthn invocation in the consumer. CDP virtual credentials do not preserve PRF secrets when exported and imported between popup targets, so the suite simulates deterministic PRF outputs in the signer only. Device key derivation, custody consent and every signature use the real signer code. These checks do not prove a live hosted deployment, a real passkey provider, the real sponsor service, or validator acceptance on Preprod.

### Evidence

On October 8, 2026, with the tarball and signer build above, `npm run typecheck`, `npm test` (42 tests), `npm run build` and `npm run test:e2e` (4 tests, including the custody flow) passed. In that run the creation drew 4,592,107 lovelace from the sponsor's fee UTxO: a 592,107 lovelace fee, the 2 ADA stake deposit and a 2 ADA control output. The 2 ADA grant spend paid a 1,127,393 lovelace fee from the account. 3,127,393 lovelace left the account, and the grant's remaining cap fell by the same amount, to 2,872,607 lovelace of 6 ADA.
