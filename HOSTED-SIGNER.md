# Hosted passkey Cardano consumer

This setup replaces the local-passkey flow described in the older README. The consumer uses the SDK from PR #2805 at `380dae7b5f584f300699726829739533d99e83bc`, linked from `../lace-platform/.claude/worktrees/pr-2805/apps/lace-sdk`.

## Start

The hosted signer must include commit `380dae7b5` and its `cardano-account-public-key` request. The PR author reports that preview deployment follows once the deployment workflow is on main. Building the signer locally does not update the hosted service.

Set these values in `.env`:

```dotenv
VITE_PASSKEY_SIGNER_URL=https://passkey-preview.lace.io
VITE_BLOCKFROST_URL_PREPROD=https://cardano-preprod.blockfrost.io
VITE_BLOCKFROST_PROJECT_ID_PREPROD=YOUR_PREPROD_PROJECT_ID
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
3. Fund that address with Preprod test ADA. Wait for UTXOs, click **Build Transaction**, inspect the recipient, amount, change, fee, and CBOR, then check the review box.
4. Click **Sign Transaction**. Inspect the hosted signer's transaction details and approve with the passkey. The consumer displays the signed transaction and enables **Submit Transaction**.
5. Submission is a separate action. Only click **Submit Transaction** if you intend to send the displayed Preprod transaction.
6. Reject a signing request or close the popup while it waits. The consumer must report failure and allow retry. A failed signing attempt clears any previous signed transaction available for submission.

The consumer stores only the account public key, under `lace-remote-passkey-wallet-v1:<signer-origin>:0`. On reopen, the SDK rejects a different key before adding the wallet. After clearing consumer storage, Open can bind the selected hosted account again, but there is no previous key to compare. Verify the displayed address against your record.

The former `lace-passkey-wallet-v1` binding is not migrated or deleted. A localhost credential and a hosted credential are different identities. Wallet state stays in memory. No consumer-side WebAuthn call, PRF output, mnemonic, or credential reference is needed.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The browser suite serves the real PR signer build through Playwright interception at `https://passkey-preview.lace.io`. It exercises cross-origin popup messaging, create/reopen/recovery, public-key mismatch rejection, signing, rejection, and popup-close retry. Blockfrost responses are fixtures; no transaction is submitted.

CDP virtual credentials do not preserve PRF secrets when exported and imported between popup targets. The suite therefore simulates deterministic PRF outputs in the signer only. Account derivation and transaction signing use the real signer code. Tests reject any WebAuthn invocation in the consumer. These checks do not prove a live hosted deployment or a real passkey provider.

The signer build defaults to `../lace-platform/.claude/worktrees/pr-2805/apps/lace-passkey-signer/dist`. Set `SIGNER_DIST` to use another build. Set `E2E_PORT` to change the browser suite's default consumer port, 5198.
