# Hosted passkey Cardano consumer

The consumer installs the Lace SDK from npm at an exact version that the lockfile pins, never as a `file:` link to a source directory. Its passkeys live in the hosted Lace signer. Its Cardano custody account runs on custody contract revision 3, and the hosted fee sponsor pays for its creation through the relay on the Vite server. [README.md](README.md) has the setup.

## Package identity

| Item | Value |
| --- | --- |
| Platform source | `lace-platform` `main` at `76c56fc75780cfec4f95b6df11781278ffe2bb96`, the merge of PR #3064, published to npm as `@laceio/sdk@0.1.2-canary.3` and `@laceio/cardano@0.1.2-canary.0`. Before it: `main` at `26afd3d2ea646c8a65b61d8509aa210b6becf280`, the commit tagged `@laceio/sdk@0.1.2-canary.5`, built locally. Before that: branch `feat/sdk-midnight-worker` (#2865, PR #3021), commit `68e9ff5aaa5b580c95c0a01219ee2a95864e77e9`, the canary SDK build: the Worker-mode work in two commits, with its worker build fix (`961ef2c2fa`) and its engine error message fix (`3ce36fb837`), on `main` at `c1964ab520c927f7afdd3314d9c143c55ca855e6`. Before that: `fc48f479d2b298faab5dc4df12d5ee1328d1b4b7`, the same work before the changes to failed engines, submissions no engine took, the Pending row's bound, the state view, the worker's records of closed pages, its channels and ports, proving progress, resets after a worker's death, bulk resyncs, the check of a value's origin and the engine load bound ([README.md](README.md#packaged-dependencies) lists them); before that, `97b206f67b98afeb6a37944deec15e8fa84f7982`, the same work before the end of a worker showed as a failed sync; before that, `3ce36fb8372012a2848b478928549d3da2a43aa9` on `feat/sdk-midnight-worker` before the rebase, after `dc155fbe9d` (docs), `961ef2c2fa` and `19eebf02c6` (`19eebf02c6` and `530fa46dfa3d23302ecc308bec2a9247d7e6e6fa` pack to the same bytes) |
| Custody contract | Revision [`b48545f`](https://github.com/Biglup/cardano-account-custody-contract/tree/b48545f4be850c1044de2dbeb51751718b4b8e70): account proxy `CARDANO_CUSTODY_ACCOUNT_VALIDATOR_HASH`, logic version 1 `CARDANO_CUSTODY_LOGIC_HASH`, both parked on Preprod |
| Fee sponsor | `https://sponsor-preprod.lw.iog.io`, sponsor `4de7a38` |
| Toolchain | Node 24.14.0 |
| SDK packages | `@laceio/sdk@0.1.2-canary.3` and `@laceio/cardano@0.1.2-canary.0` from npm; before them, local builds at `vendor/laceio-sdk-0.0.0-development.tgz` and `vendor/laceio-cardano-0.0.0-development.tgz` |
| Tarball SHA-256 | SDK `937c6c80f2450c1fc33719bfc1ae9dfd100e6476aa9dcc69401fce984e16a31d`, from npm (at `26afd3d2ea`, `7ae2349635aafa78967f8d05dd22b4373f196712c3f0d9136fb761f88c6c68bc`; at `68e9ff5aaa`, `8cec1fc5c640b8002cce85308ffc7616746cf99698cfb4ca3e49ad03186ed980`; a local build before it, `94aa91843e6fb9e64b2b79eca8b11fed74e9b1228cca44af18cffe3af9a693b4`; at `fc48f479d2`, `1848e47eea4e31662a79437b2064f0a716ae5860b1710229fab10762c6297754`; at `97b206f67b`, `bdeba2f71b76fe9457b15f27c467c9b8af9a0a0b857f85c5413ee762d97cd659`; at `3ce36fb837`, `21fd09a2c3f3230b5b5db26b3f0637b0694018ede5f8dfe6a50fec7205d6c1e2`; at `961ef2c2fa`, `8c7d64144bf65bdf0b9df53fd54dfe506ef145d6112c524171e5af6fe96fe1bb`; before that, `8edaefc60f8310b9b72c2095c455d9dd915c96b87b6df951e4997969fa314b1a`); `@laceio/cardano` `d872a9e8065a3d1877240ae4a5d9b4589a554ae85a3d4a3a38b391e75bfb4ed3`, from npm, the same files as the builds of `26afd3d2ea` and `68e9ff5aaa` apart from its version (those builds, `9a0e931e80ee6848d0eca07a05e21361794986b6ce3c2acb1e59a58968eb1b98`; before them, `42f1aec40c6b01d86ac77080c0ab31e655ae9f2f7e4df350a39b2aee7a6e811a`, the same bytes at `fc48f479d2` and `97b206f67b`, with the same code and `package.json`: the two differ in chunk names and in comments that name sources; from `530fa46dfa` to `3ce36fb837`, `640bd387bad016449cee6a5d368fa37659942b8041aa586b1d665782e8d7699f`; only its `package.json` changed, with `main`'s `ip-address` and `pbkdf2` pins) |
| Signer build for the browser suite | `lace-passkey-signer` at `76c56fc757`, built with `VITE_CUSTODY_ALLOWED_ORIGINS=http://localhost:5198`; `dist/index.html` SHA-256 `c325773490bf3aea77c314fd64f35aefe4162e1d6649d59b82d800898ad68bc0`, byte-identical to the build at `26afd3d2ea`. The signer's source changed after the build at `97b206f67b` (`fd82296636ea70e3dd08fea7c894716c63d9bc9e6f15ad3392e63e62412eeaaa`), which is therefore not the signer of `26afd3d2ea` or the installed commit. Before that, the rebase onto `main` changed the signer's source (its request descriptions, handlers, rendering and state, and its Vite version), so the earlier build at `530fa46dfa` (`b8b406a94c5216cb126ca223cb4a609cd6f94b5c3ed74fcb8e654375f4512987`), which served the browser suite up to `3ce36fb837`, is not the signer of `97b206f67b`. `fc48f479d2` and `68e9ff5aaa` do not change the signer's source, so the `97b206f67b` build is also their signer |
| Deployed preview signer | `https://passkey-preview.lace.io` was checked against the earlier signer build at `fe9d709f7` (its main script, apart from its custody origins `http://localhost:5173,https://midnight.city` and its asset file names). It has not been checked against `530fa46dfa` or the installed commit. |

The SDK packages come from npm, and `package-lock.json` pins them by integrity, so `npm ci` installs the packages the evidence below names:

```bash
npm ci
```

A later platform commit that changes the SDK or the signer invalidates the browser evidence below until the suite runs again against a new tarball and signer build.

## Passkey wallet

The hosted signer must serve the custody request kinds (`cardano-custody-public-key`, `sign-cardano-custody-tx`) for the custody flow, and must list the app's origin among its custody origins. Otherwise it refuses the custody requests: a signer without the kinds with `CardanoCustodyUnsupportedSignerError`, and an origin it does not list with `RemoteSignerError` `custody-origin-not-allowed`. The preview signer lists `http://localhost:5173`, so run the dev server on that port.

The signer uses its own hostname as the relying-party ID. A different signer hostname is a different passkey domain and a different saved identity slot.

### Manual test

1. Click **Create passkey wallet**. In the hosted popup, choose an existing passkey or create a new wallet. Approve **Share your Cardano account**. If the signer already has a credential, it reuses it; the consumer's Create button does not force a new credential.
2. Record the Preprod address. Reload, click **Open passkey wallet**, and approve sharing the account again. The address must match.
3. Fund that address with Preprod test ADA. Wait for the spendable balance, enter a recipient and an amount, click **Build Transaction**, inspect the recipient, amount, change, fee, and CBOR, then check the review box.
4. Click **Sign Transaction**. Inspect the hosted signer's transaction details and approve with the passkey. The consumer displays the signed transaction and enables **Submit Transaction**.
5. Submission is a separate action. Only click **Submit Transaction** if you intend to send the displayed Preprod transaction.
6. Reject a signing request or close the popup while it waits. The consumer must report failure and allow retry. A failed signing attempt clears any previous signed transaction available for submission.

The consumer stores only the account public key, under `lace-remote-passkey-wallet-v1:<signer-origin>:0`. On reopen, the SDK rejects a different key before adding the wallet. After clearing consumer storage, Open can bind the selected hosted account again, but there is no previous key to compare. Verify the displayed address against your record. Wallet state stays in memory. No consumer-side WebAuthn call, PRF output, mnemonic, or credential reference is needed.

The wallet can hold the passkey account and a custody account at the same time. The page therefore selects the passkey account's address, UTxOs and tokens by its account id, and signs ordinary transactions with that account id. The SDK never offers custody UTxOs to the ordinary transaction builder.

## Cardano custody account

The custody section is a proof of concept of the SDK custody API (LW-15692) and the hosted signer custody consent (LW-15693). The custody contract is unaudited. Use Preprod test ADA only.

An account lives at a permanent address that pays to the account proxy. The proxy runs the logic that the first field of the control datum names, through a withdrawal from that logic's reward account. On Preprod every account transaction but a plain deposit reads the proxy and logic version 1 from the UTxOs that park them, through reference inputs. A creation or an owner operation withdraws the whole balance of the logic's reward account, which is normally zero. A grant spend always withdraws zero. While that balance is not zero, these transactions fail with `CardanoCustodyLogicRewardBalanceError`, because the hosted sponsor refuses a logic run that draws anything. A grant lives in its own grant UTxO, and a grant ID is the grant's account-local slot.

### Roles

- **Device**: the hosted signer passkey. Its CIP-1854 key `m/1854'/1815'/1'/0/i` owns the account. The page keeps only public values: the account extended public key, under `lace-custody-device-v1:<signer-origin>:1`, and the account record with the device binding, under `lace-custody-account-r3:<signer-origin>:1`. The SDK refuses records of other contract builds, so the page does not offer an account that an earlier version of it saved under another key.
- **Fee sponsor**: the hosted service at `https://sponsor-preprod.lw.iog.io`. The page calls it through `http://localhost:5173/sponsor`, the dev server's relay, which adds the key from `SPONSOR_API_KEY` (see [README.md](README.md#fee-sponsor-relay)). The SDK checks the sponsor's policy rules before it asks for a witness, and the sponsor signs before the device, so a passkey ceremony never runs for a transaction the sponsor refuses. The **Fee sponsor** line shows the sponsor's health through the relay.
- **Agent**: a development Ed25519 key held in memory outside Lace, standing in for an agent's own wallet. It is lost on reload. The agent opens the account in a second, separate SDK wallet from the exported agent policy alone. That wallet has no passkey, no device binding and no vault.

### Flow

1. Open the passkey wallet and fund it with at least 25 ADA.
2. **Share custody device key**. The popup asks **Share your Cardano custody device key** for every testnet and the path `m/1854'/1815'/1'`. The page shows the device fingerprint.
3. **Create custody account**. The sponsor leases a fee UTxO (fee mode), the SDK builds and checks the creation, the sponsor signs, then the popup asks **Create Cardano custody account**. It lists the permanent deposit, the device list with this device marked, and the sponsor as fee payer and collateral provider. The SDK verifies both witnesses, merges them and submits, then waits until the creation settles. The page shows the logic, the spendable funds and the control output, split into its minimum, locked for the account's life, and the owner fee reserve.
4. **Deposit to custody account** fills the ordinary transfer's recipient with the account's deposit address, which the SDK reports only while the account is live and lists this device. The SDK reads the wallet's in-flight view, so the page that submitted the creation sees the account live at once. A reloaded page, which opens the saved account with **Open saved custody account**, sees it live, and offers the deposit, only once the creation settles. An ordinary transfer of 20 ADA funds the account: the popup is the ordinary **Sign a transaction** and names the output as a Cardano custody account.
5. **Grant agent spending** issues a lovelace grant to the agent key: 4 ADA per spend, 6 ADA in total, one recipient, valid for a day. The popup asks **Grant spending to an agent** and shows the new grant ID, each cap, the expiry and the recipient. The grant is paid for from the account's deposits. Once it settles, the page exports agent policy version 2 for the grant ID the submission names. **Export agent policy** exports it again while the grant is live, for example after a reload or a wait that ended before the grant settled.
6. **Open account as agent** validates the policy and creates the agent's observer wallet from it. **Agent: build, sign and submit spend** builds the grant spend for the agent's key in the observer wallet, signs its body hash with the agent key, and submits it with the sponsor's collateral witness. The fee comes from the account and counts against both caps, which fall by the payment, the fee and a margin of up to 10,000 lovelace.
7. A spend above what the grant allows is refused before any signature: the SDK names the cap it breaks.
8. **Revoke agent grant** stops the grant after the popup asks **Revoke an agent grant**. The grant UTxO stays, as `revoked`, until a sweep removes it. A later agent spend under it is refused with `dead-grant`.

The custody log names every failure with what to do about it, as the error's class name and its `code` in brackets, then the message and a hint. Among them are the revision 3 errors `CardanoCustodyLogicNotRegisteredError`, `CardanoCustodyLogicRewardBalanceError`, `CardanoCustodyLogicNotServedError`, `CardanoCustodyScriptDataHashError` and `CardanoCustodyRewardBalanceChangedError`, `CardanoCustodyUnsupportedVersionError` for an account of another contract build, the sponsor's refusals, and the relay's own `relay_not_configured`, `not_found`, `cross_site_request` and `unsupported_media_type`.

## Verification

```bash
npm run typecheck
npm test
npm run build
SIGNER_DIST=/path/to/lace-passkey-signer/dist \
EXPECTED_SIGNER_INDEX_SHA256=<sha256 of that build's index.html> \
E2E_PORT=5198 \
npm run test:e2e
```

Build the signer with the browser suite's origin in its custody list, from the lace-platform checkout of the installed SDK's commit ([README.md](README.md#packaged-dependencies) names it):

```bash
cd apps/lace-passkey-signer
VITE_CUSTODY_ALLOWED_ORIGINS=http://localhost:5198 npx vite build --outDir /path/to/lace-passkey-signer/dist
```

Use the same port for `E2E_PORT`. The custody test fails at once, naming the build's origins, when the served build does not list `http://localhost:<E2E_PORT>`. `SIGNER_DIST` defaults to `../lace-platform/.agents/workspaces/lw-15692-custody/apps/lace-passkey-signer/dist`, a checkout that other builds can overwrite. The suite prints the SHA-256 of the `index.html` it serves, and fails when `EXPECTED_SIGNER_INDEX_SHA256` names another build. `E2E_PORT` defaults to 5198.

### Unit tests

`npm test` runs the Node unit tests:

- `tests/custody.test.mjs`: the custody state and sponsor health views, and the log lines for the SDK's typed errors and the sponsor's and relay's refusals, built from the SDK's own error classes.
- `tests/sponsor-relay.test.mjs`: the relay, through real Vite servers against a local stand-in for the sponsor. Every server reads its env files from a temporary directory, never this checkout's `.env`. It checks:
  - that the key replaces the browser's `authorization`, `proxy-authorization` and `cookie` headers;
  - that only the client API is forwarded, never a path such as `//admin/health` that names another host, and that the forwarded path is the normalized path the relay checked;
  - that a request from another origin, by `Sec-Fetch-Site` or `Origin`, and a body that is not JSON forward nothing;
  - that a missing or malformed key forwards nothing;
  - that the app's own `vite.config.ts` relays on the dev server and the preview server, with the key from the mode's `.env` files or from the process environment over them;
  - that the dev server answers 403 for `.env` and `.env.local`, with `?raw`, `?import&raw` and the other query forms, and through `/@fs/`;
  - the `SPONSOR_URL` rules, and that a `VITE_` sponsor key stops the server.
- `tests/fake-ledger.test.mjs`: the fake ledger's refusals, below.
- `tests/accounts.test.mjs` and `tests/binding.test.mjs`: the account-scoped reads and the saved wallet binding.

`tests/support/` maps the SDK to its CommonJS build, which the fake ledger and the fake sponsor `require` too, so the tests share one SDK instance with them.

### Browser suite

`tests/e2e/passkey.spec.ts` exercises cross-origin popup messaging, create, reopen and recovery, public-key mismatch rejection, signing, rejection, and popup-close retry, without submitting.

`tests/e2e/custody.spec.ts` runs the custody flow above end to end and submits every transaction to the fake ledger: creation, deposit, grant, grant spend and revocation. It asserts:

- the custody consent titles and their rows in each popup: the stake deposit, the device, the fee payer and the collateral provider of a creation; the new grant ID, the grantee's full key hash, the caps, the expiry, the recipient and the fee payer of a grant; the revoked grant ID;
- the logic, the spendable funds, the control output and the deposit address the page shows, and the exported agent policy version 2, which **Export agent policy** exports again;
- that a reloaded page, while the ledger holds the creation back, opens the saved account as `notCreated`, shows no deposit address and keeps **Deposit to custody account** disabled until the creation settles;
- that the creation and the grant spend read both parked scripts through reference inputs and withdraw zero from the logic's reward account, which holds nothing;
- that the sponsor paid exactly the creation's fee, stake deposit and control output, within its 6 ADA limit;
- that the grant's caps fell by what left the account and at most 10,000 lovelace more;
- the overspend refusal (`cap-exceeded`), a sponsor that does not serve the logic (`CardanoCustodyLogicNotServedError`), the revoked grant (`dead-grant`), and a grant refused while the logic's reward account holds a balance (`CardanoCustodyLogicRewardBalanceError`), none of which submits anything;
- that the browser sent no `authorization` or `cookie` header to the relay path, and that no request for state NFT or grant token metadata is made.

`tests/e2e/fake-sponsor.ts` serves the sponsor's client API at the app's `/sponsor` path in the browser, so no request reaches the relay or the hosted sponsor. The dev server of the suite also runs with an empty `SPONSOR_API_KEY`, so its relay forwards nothing. The fake answers the service's documented shapes for `/health`, `/v1/leases` and `/v1/collateral` and its error body, and signs with an in-memory key whose UTxOs live on the fake ledger. Of the service's policy it applies the leased fee UTxO and the change in fee mode, the shared collateral and its return, the known logic (`known_logic`), and a logic run that draws nothing (`no_foreign_scripts`), in the service's own words.

`tests/e2e/fake-ledger.ts` is a small Preprod ledger behind the Blockfrost API. It uses Preprod's PlutusV3 cost models and protocol parameters (captured from live Preprod epoch 317), Preprod eras, and a tip that follows its clock. It holds the two UTxOs that park the account proxy and logic version 1 on Preprod at their pinned output references, carrying the scripts from `tests/e2e/fixtures/preprod-reference-scripts.json`, and the registered reward account of logic version 1. A unit test ties that fixture to the SDK package's own output references and script bytes. `tx/submit` applies a transaction only when:

- its inputs and reference inputs are unspent, its validity interval holds, and it fits the maximum size;
- it pays at least the minimum fee: size, declared execution units and reference scripts, with the size taken without the `is_valid` flag as the ledger does;
- every output and the collateral return hold their minimum lovelace, and its collateral matches the total collateral and covers 150% of the fee;
- its execution units stay within the transaction limits;
- every vkey witness verifies, with all required signers present;
- every script it runs is attached or read from a reference input, no attached script is unused or also read from a reference input, every script item has a redeemer, and every redeemer points at a script item;
- the body's script integrity hash is the one a node computes: the redeemers and datums as the witness set encodes them, and the language views of the Preprod cost models of the Plutus languages it runs;
- the account proxy's own rule holds: a transaction that spends from an account address or mints account tokens has a six-field control datum that names its logic first, and withdraws from that logic's reward account;
- every withdrawal takes the whole reward balance, and its value balances.

A test can hold accepted transactions back, as a mempool would, and release them later. It answers script evaluation with fixed budgets per script, the logic run the largest. It runs no Plutus script, so it does not prove that the logic accepts these transactions.

The suite records, at the browser context level and popups included, every request the signer page sends. It fails if the signer sends any request to another origin, Blockfrost on any network included, and it checks that the signer's own requests were seen. Tests reject any WebAuthn invocation in the consumer. CDP virtual credentials do not preserve PRF secrets when exported and imported between popup targets, so the suite simulates deterministic PRF outputs in the signer only. Device key derivation, custody consent and every signature use the real signer code. These checks do not prove a live hosted deployment, a real passkey provider, the hosted sponsor's acceptance or validator acceptance on Preprod.

### Key isolation

The sponsor key stays in the dev server's Node process. To check that a build carries neither the key nor its variable name:

```bash
SPONSOR_API_KEY=test-marker-0000 npm run build
grep -rl 'test-marker-0000' dist
grep -rl 'SPONSOR_API_KEY' dist
```

Both `grep` commands must print nothing. A build or server started with a `VITE_` sponsor key, such as `VITE_SPONSOR_API_KEY`, fails before it bundles anything. The relay reads its variables itself, not through Vite's `loadEnv`, so Vite's debug log does not print the key either:

```bash
DEBUG=vite:* SPONSOR_API_KEY=test-marker-0000 npx vite build 2>&1 | grep -c 'test-marker-0000'
```

The `grep` must print `0`.

### Evidence

On October 9, 2026, with the historical SDK tarball and signer build at `fe9d709f7` ([README.md](README.md#historical-cardano-baseline-package)) and Vite 8.3.3:

- `npm run typecheck` passed, `npm test` passed 50 tests, and `npm run build` passed.
- `npm run test:e2e` with `E2E_PORT=5198` passed 4 tests, including the custody flow. In that run the creation drew 5,900,000 lovelace from the sponsor's fee UTxO: a 795,925 lovelace fee, the 2 ADA stake deposit and a 3,104,075 lovelace control output. The 2 ADA grant spend paid a 745,281 lovelace fee from the account. 2,745,281 lovelace left the account, and the grant's caps fell by 2,755,281 lovelace. The fake ledger's fixed script budgets set these fees, not Preprod's evaluation. Every submission matched the script integrity hash the fake ledger computes.
- The key isolation check found neither `test-marker-0000` nor `SPONSOR_API_KEY` in the 175 files of `dist`. A build with `VITE_SPONSOR_API_KEY` set stopped with an error. A build under `DEBUG=vite:*` printed Vite's resolved env but not the marker key.
- The app's `vite.config.ts`, run with a dummy key and no env files, relayed `GET /sponsor/health` to the hosted sponsor, which answered `{"ok":true,"network":"preprod","pool":{"fee":{"free":99,"leased":0},"collateral":{"shared":true,"spare":3,"consumed":0}}}`. The relay answered `GET /sponsor//x/health` and `GET /sponsor/admin/keys` with 404 itself, and a cross-site `POST /sponsor/v1/leases` with 403.

On October 25, 2026, `npm run test:e2e` passed 23 of 23 tests, the passkey and custody specs included, with the SDK and a signer built from lace-platform `530fa46dfa`; [README.md](README.md#packaged-dependencies) records the run. The custody flow drew the same amounts as above. On October 26, 2026, with the SDK built from `3ce36fb837` and the same signer build, it passed 26 of 26, this app's three Worker-mode checks included, with the same custody amounts. Later on October 26, 2026, with the SDK and the signer, both built from `97b206f67b`, it passed 26 of 26 again, with the same custody amounts. On October 27, 2026, with the SDK built from `fc48f479d2` and the same signer build, it passed 26 of 26 again, with the same custody amounts. On October 29, 2026, with the SDK built from `68e9ff5aaa` and the same signer build, it passed 26 of 26 again. On October 30, 2026, with an SDK and a signer, both built from `26afd3d2ea`, the same 26 tests passed in two runs: the five offline specs (Midnight, Worker-mode, Temenos transport, runtime and startup) 22 of 22, then the passkey and custody specs 4 of 4. On November 4, 2026, with the installed SDK, `@laceio/sdk@0.1.2-canary.3` from npm, and a signer built from `76c56fc757`, the same two runs passed again: 22 of 22, then 4 of 4.

No custody transaction has run against the hosted sponsor or landed on Preprod from this consumer yet.
