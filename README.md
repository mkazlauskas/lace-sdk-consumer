# Lace SDK consumer: passkey Cardano wallet

Testnet-only Cardano Preprod demo using `@input-output-hk/lace-sdk/cardano`. It creates and opens a wallet with a WebAuthn PRF passkey. No recovery phrase is shown or exported. Web3Auth funds are not migrated. This rebased SDK tarball is unpublished; final evidence needs a published prerelease and a fresh run on real passkey providers.

> The current consumer uses the hosted Lace signer and adds a Cardano custody account proof of concept. See [HOSTED-SIGNER.md](HOSTED-SIGNER.md) for both flows, the SDK tarball identity and the verification evidence. The sections below describe the earlier local-passkey flow.

## Start

SDK tarball: `/tmp/opencode/input-output-hk-lace-sdk-0.1.0-lw15585.34eb91daf.tgz`, source commit `34eb91dafaf59ea0b28263ec9f44ae95bebf8ef9`, SHA-256 `77e6c3c7c488f02ddf5038d4290fedf435c054578633718070b2780313cc3bd7`.

```bash
cd /home/mkazlauskas/Code/iog/lace-sdk-consumer
sha256sum /tmp/opencode/input-output-hk-lace-sdk-0.1.0-lw15585.34eb91daf.tgz
npm install
test -e .env || cp .env.example .env
# Set VITE_BLOCKFROST_URL_PREPROD and VITE_BLOCKFROST_PROJECT_ID_PREPROD in .env for live Preprod data
npm run typecheck
npm test
npm run build
npm run dev -- --host localhost
```

Open `http://localhost:5173/`, or the port Vite reports. RP ID is `localhost`; `127.0.0.1` and other hosts are rejected. Browser and passkey provider must support WebAuthn PRF. First **Create passkey wallet** asks twice: credential creation, then assertion for wallet derivation. Reload and choose **Open passkey wallet**. Only non-secret metadata (`credentialId`, `rpId`, `recipeVersion`, public fingerprint) is stored in `localStorage["lace-passkey-wallet-v1"]`. Wallet state is in memory and never rehydrated before binding verification. A different passkey or fingerprint cannot open a saved wallet. If storage is cleared, explicitly choose **Open passkey wallet** to discover a synced passkey and restore its public binding. Without a saved binding, the app cannot compare against the previous wallet until its address is shown; check it against a previously recorded address. An invalid binding fails closed.

After funding the displayed address with **Preprod test ADA**, wait for UTXOs, then build, inspect the transaction review (recipient, amount, change, input count, fee, CBOR), check the review box, and sign. Each signature needs a fresh passkey assertion. Submit is a separate action. `Buffer` remains global until browser signing proves removal safe.

## Browser checkpoint

1. Create in a PRF-capable browser at `http://localhost:5173/`. Record OS, browser, provider, both prompts, and Preprod address.
2. Reload, open with the same passkey, and compare the address. Clear browser storage **after recording the public address**; choose **Open** without restoring storage. Compare the address and new public binding. Wallet entity itself must not be rehydrated.
3. On another machine at `http://localhost`, choose **Open** with the synced passkey and compare the address. If you copy a public binding instead, the SDK also pins the credential ID and verifies the fingerprint before opening.
4. Try a different passkey. Confirm refusal before balances or signing. The imported credential ID pins `allowCredentials` on reload, so a different credential may fail in the browser picker before SDK fingerprint comparison.
5. Fund from the Preprod faucet if desired, build, review, and sign. Confirm a fresh passkey prompt. Submit only if you intend to send a transaction. Record hash and explorer confirmation separately. No browser run on a real passkey provider or second physical machine is implied by automated tests.

The Playwright suite uses a Chrome DevTools Protocol virtual authenticator and local Blockfrost fixtures. It checks PRF results, binding, and signing without submitting a transaction. Run `npm run test:e2e` after `NODE_OPTIONS=--dns-result-order=ipv4first npx playwright install chromium`. The suite starts on port 5198 by default; set `E2E_PORT` to a free port if needed.

SDK `34eb91daf` initializes the headless wallet, discovers its first address, and syncs fixture UTXOs. The consumer limits the in-memory entity to Preprod: SDK excludes mainnet but can still include Preview. Playwright verifies create/reload/storage-clear recovery, second-credential mismatch, and two real SDK transaction signatures with one fresh WebAuthn PRF assertion per signature. Tests mock Blockfrost responses but neither PRF nor the signatures. No transaction is submitted in CI. These virtual-authenticator results do not prove real synced passkeys, a second physical machine, or a confirmed Preprod transaction. Previous manual testing used an older SDK tarball and must not be treated as evidence for this one.
