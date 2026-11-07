# Lace SDK consumer: Cardano and Midnight

Developer reference app using one packaged `@laceio/sdk` for Cardano Preprod and Midnight Preview. The original Cardano route has two parts:

- A passkey wallet whose keys stay in the hosted Lace signer, `https://passkey-preview.lace.io`. No recovery phrase is shown or exported.
- A proof of concept of a Cardano custody account on custody contract revision 3. The hosted fee sponsor, `https://sponsor-preprod.lw.iog.io`, pays for the account's creation and lends collateral to every later transaction. The browser reaches the sponsor through a relay on the Vite server, which holds the sponsor key.

[HOSTED-SIGNER.md](HOSTED-SIGNER.md) describes both flows step by step, the tests and the verification evidence.

> **Warning:** The custody contract is unaudited. Use Preprod test ADA only.

## Historical Cardano baseline package

The superseded SDK was vendored as `vendor/input-output-hk-lace-sdk-0.1.0-fe9d709f7.tgz`, an `npm pack` of lace-platform PR #2825 at commit `fe9d709f71dcb1d9f134c095568850c55450a5c0`. Its tree is the same as the published `0.1.0-dev.11`. SHA-256: `24acbaaa934613f7b27abb3c116281660dd622f912868aa6c4af1e4de8b9b9e9`. The historical baseline records passing type checks, unit tests, production build and browser suite with this package. These results do not establish Midnight acceptance or regression results for a replacement package.

## Start

1. Install and check the packages. `npm ci` installs `@laceio/sdk` and `@laceio/cardano`
   from npm at the versions the lockfile pins. The Temenos verifier comes from
   `vendor/`, and `npm ci` fails until you place it there; getting it needs access
   to a private package (see [Packaged dependencies](#packaged-dependencies)):

   ```bash
   cd lace-sdk-consumer
   shasum -a 256 vendor/input-output-hk-temenos-attestation-verifier-0.3.0.tgz
   npm ci
   test -e .env || cp .env.example .env
   ```

2. Set these values in `.env`:
   - `VITE_BLOCKFROST_PROJECT_ID_PREPROD`: a Blockfrost Preprod project ID, for live Preprod data.
   - `SPONSOR_API_KEY`: the Lace testing key that the sponsor operator shared. Keep the name exactly `SPONSOR_API_KEY`. Vite inlines every `VITE_` variable into the browser bundle, so the server refuses to start with a `VITE_` sponsor key.
   - `SPONSOR_URL` is optional. It defaults to `https://sponsor-preprod.lw.iog.io`.

   A variable set in the server's process environment overrides `.env`.

3. Run the checks and start the dev server on port 5173:

   ```bash
   npm run typecheck
   npm run test:e2e -- tests/e2e/runtime.spec.ts
   npm test
   npm run build
   npm run dev -- --host localhost --port 5173 --strictPort
   ```

   The runtime browser check comes first because three startup-diagnostic unit tests
   read the Vite dependency cache that the dev server creates, and `npm ci` removes it.

4. Open `http://localhost:5173/`. Keep this exact origin: the preview signer serves custody requests only for the origins its build lists, which are `http://localhost:5173` and `https://midnight.city`. Allow the signer popup.

The **Fee sponsor** line shows what the relay's `GET /sponsor/health` answered: the sponsor's network and its free fee UTxOs. That route needs no key on the sponsor side. A wrong key shows up at the first sponsored request as an `unauthorized` refusal in the custody log.

## Fee sponsor relay

The hosted sponsor sends no CORS headers, and its client key is a bearer secret. So the browser never calls it directly and never holds the key:

- The page creates the sponsor client with ``createCardanoCustodySponsorClient({ baseUrl: `${location.origin}/sponsor` })`` and no `apiKey`.
- `vite.config.ts` loads the relay plugin from `sponsor-relay.ts`, which sets `server.proxy` and `preview.proxy` for `/sponsor`. The plugin reads `SPONSOR_URL` and `SPONSOR_API_KEY` in the Node process from the same `.env` files as Vite, with the process environment over them. It reads them itself, not through Vite's `loadEnv`, so `vite --debug` does not print the key.
- The relay forwards only the sponsor's client API: `GET /health`, `POST /v1/leases`, `DELETE /v1/leases/:id`, `POST /v1/leases/:id/witness`, `GET /v1/collateral` and `POST /v1/collateral/witness`. It parses the path once and forwards the path it checked. It answers any other path, a path that names another host such as `//admin/health` included, with `404 not_found` itself.
- It forwards only requests from pages of its own origin. A request whose `Sec-Fetch-Site` is not `same-origin` (or `none`, for an address typed into the browser), or whose `Origin` is another origin, gets `403 cross_site_request`. A body that is not JSON gets `415 unsupported_media_type`, so another origin cannot send one without a CORS preflight.
- It strips the `/sponsor` prefix and drops the browser's `authorization`, `proxy-authorization` and `cookie` headers. It sends `authorization: Bearer <SPONSOR_API_KEY>` as the only credential. The sponsor's status and body come back unchanged, without `set-cookie`.
- Without a key, the relay forwards nothing. It answers `503 relay_not_configured`, which the custody log shows.

Any program that can reach the dev server, unlike a web page of another origin, can spend the key's quotas through the relay. Keep the server on `localhost`.

The key sits in `.env` inside the Vite root, so the dev server must refuse to serve env files. `package.json` requires Vite 8.3.3 or later: older Vite 8 releases serve `.env` through query URLs such as `/.env?raw`. A relay unit test checks that the dev server answers 403 for these URLs. Git ignores `.env` and every `.env.*` file except `.env.example`.

A `vite build` output is static files and has no relay. A deployed app needs its own backend relay that does the same, behind the app's own authentication.

## Funding

- **Passkey wallet**: Preprod test ADA from the faucet. It pays the deposits to the custody account and its own transfer fees.
- **Account creation**: the hosted sponsor pays the fee, the 2 ADA stake deposit and the control output. The account needs no funds to be created.
- **Later account transactions**: the sponsor lends only its collateral. The account pays every fee itself, from its deposits first. A revocation, a device change or a sweep falls back to the owner fee reserve in the control output, so it needs no deposit.
- **Owner operations**: an owner spend pays out of deposits. Issuing a grant locks lovelace in the grant's own UTxO and tops the owner fee reserve up to 2.1 ADA, both from deposits.
- **Grant spends**: an agent's spend pays its outputs and its fee from deposits, and the fee counts against the grant's caps. The SDK estimates about 1.8 ADA of deposits beyond the outputs.

A 20 ADA deposit covers the demo grant (4 ADA per spend, 6 ADA in total) and a 2 ADA agent spend.

## What a live Preprod run also needs

- The logic's reward account (`stake_test17qkddr3e300el0ydy4mpfd2yqdz3aeez2g8v0p07znud7ksul9rpg`) must be registered and hold no balance. While it holds a balance, every account transaction fails with `CardanoCustodyLogicRewardBalanceError`, which the custody log explains.
- The Blockfrost provider must report `registered` for reward accounts. Otherwise every build fails with `CardanoCustodyLogicNotRegisteredError`.

The custody log turns the SDK's typed errors, the sponsor's refusals and the relay's refusals into one line each, with what to do about them. A line starts with the error's class name and its `code` in brackets, such as `CardanoCustodyLogicRewardBalanceError [custody-logic-reward-balance]:`. A production build may shorten the class name, but it keeps the code.


## Midnight reference route

Open `http://localhost:5173/midnight`. The original `/` route retains Cardano,
passkey and custody flows. Buffer initializes before either route imports its
SDK graph. All Midnight state and operations use the public `@laceio/sdk/midnight`
entry; there are no workspace aliases. Validation and live limitations are
recorded below.

Browser builds also require the real `assert@2.1.0` polyfill: `vite.config.ts`
maps exact `assert`/`node:assert` imports to it. DUST address serialization uses
SCALE assertions; Vite's browser-external stub cannot execute them. Keep this
alias and the Buffer initialization when adapting the consumer. Browser loading
also requires the config's fixed, empty `process.env.NODE_DEBUG` definition
for the assertion package's browser utility dependency; it exposes no host values.
The wallet-free runtime probe exercises public dummy DUST, shielded and unshielded address
codecs (including invalid input) in both dev and production builds.

The SDK's Midnight guide ("Install") requires Node polyfills on the page:
`@laceio/cardano` reads the `Buffer` global, and its dependencies read the
`global` and `process` globals and import Node's `events` module.
`vite.config.ts` adds them with `vite-plugin-node-polyfills`. It also sets
`worker: { format: 'es' }`: `@laceio/sdk/midnight` names its Worker-mode
SharedWorker script, so `vite build` bundles that worker in both engine modes,
and the worker loads the ledger's WebAssembly with top-level await, which only
the ES worker format supports. For Worker mode on the development server it
pre-bundles `@subsquid/scale-codec` (`optimizeDeps.include`): Vite serves the
SDK's worker files without converting CommonJS, and the worker imports that
CommonJS package from this app's install. The ledger stays out of pre-bundling,
as before. These are the settings of the guide's "Worker mode" → "Bundlers".

Keep the scoped `package.json` override from `wallet-sdk-address-format@3.1.2`
to `@scure/base@2.2.0`, matching the Lace source baseline. Version 2.4.0 defaults
to a 90-character decoding limit and rejects the 132-character Preview shielded
address strings used by SDK transfer/connector parsing. Install with the matching
lockfile; the shared probe checks string parse/decode/re-encode and rejects a bad
checksum, malformed shielded payload, wrong network and wrong address type.

### Worker mode

The restore form's **Engine** setting chooses where the account's engine runs:

- **This page** (the default): the engine syncs, builds, signs, proves and
  submits on the page, as before.
- **SharedWorker (Worker mode)**: the page passes `worker: { storage, adopt }`
  to `createMidnightModule`, and the SDK runs the engine in one SharedWorker
  that every tab of this origin shares. **Worker storage** is `memory` (the
  worker keeps the synced state while it runs; the next start syncs again) or
  `indexeddb`. **Use the running engine's settings** sets `adopt`: a tab that
  restores an account whose engine another tab already runs with other
  endpoints, proof server or storage then uses that engine's settings instead
  of failing with `MidnightWorkerSettingsConflictError`.

Worker mode proves only through a proof server URL, here the local proof server
`http://127.0.0.1:6300`: the SDK cannot run the Temenos attested prover in its
worker and `createMidnightModule` throws `MidnightAttestedProverUnsupportedError`
for the combination. The page refuses Temenos with Worker mode before it restores
anything ("Restore refused: …"). The configuration panel shows the engine
location after restore.

The **Page responsiveness** field at the top is a scratch text field outside
every form. Typing there echoes the text below it, so you can see the page stay
usable while the engine syncs. The text is never stored or sent, and typing does
not clear the session or discard a prepared operation.

The page names the SDK's errors by class and `code`, for example
`MidnightWorkerSettingsConflictError [midnight-settings-conflict]`, in the status
line and, when the error ends the account's balance stream, in the readiness
panel, with what to do about Worker-mode codes; the readiness panel still
withholds the error's message, as before. The status line announces a failed
balance stream or sync once, so the outcome of a later operation stays visible.
After a Worker-mode error the account's streams end and the SDK
retries nothing. **Observe this account again** subscribes again; that call
starts a new worker if the old one ended.

Two tabs that restore the same wallet in Worker mode share one engine, and
closing one leaves the other working. A sync reset in one tab resets the
account for both: a transfer the other tab built before the reset is refused
(`MidnightStaleTxError`, or `MidnightEngineResetError` while the reset runs).
The SDK guide's "Worker mode" section describes the rest; this app follows it.

**Fixed SDK issue on the development server.** Earlier SDK builds, up to
`19eebf02c6` (tarball `8edaefc6…4b1a`), evaluated the worker's entry module twice
under `npm run dev`: Vite loads the SharedWorker script as
`midnight-worker.js?worker_file&type=module`, and the SDK's own worker chunks
imported `./midnight-worker.js` back, which Vite served under another URL. Each
copy started its own runtime and engine host, so a second tab started a second
engine for the same account instead of attaching, got no settings conflict, and
did not see a reset in the first tab. The production build was not affected.
`961ef2c2fa` fixed it in the SDK's worker build, and the installed build keeps
that fix: no worker chunk imports the entry, and the SDK's build refuses one that
does. The tab scenarios now pass on the development server as well
([Worker mode, live](#worker-mode-live)). This app never worked around it.

**Fixed SDK issue: engine error messages in Worker mode.** Up to `961ef2c2fa`
(tarball `8c7d6414…e1bb`), an engine error that crossed the worker reached the
page with an empty message: the wallet SDK rejects with Effect's `FiberFailure`,
whose `toJSON()` drops the message, and the worker's messaging sent only that
form. A failed submission then read "The SDK reported: ." `3ce36fb837` fixed it,
and the installed build keeps that fix: it keeps the engine's name, message and
`code`, and adds the wallet SDK's serialized error as `cause`. For a submission
this app shows the message's first line, at most 300 characters, in the
Submission record and the status line; other operations show the message in the
status line. It never shows `cause`, which can hold the transaction's bytes.

The circuit control (**Prove / check a circuit**) accepts a protocol circuit,
a key location starting with `midnight/`, with all three keys empty: the page's
key-material lookup then fails and the SDK uses the proof server's built-in
material, as the guide's "dApp connector primitives" section describes. In
Worker mode the page looks the material up and the worker calls the proof server.

### Packaged dependencies

`@laceio/sdk` and `@laceio/cardano` install from npm at exact versions, and the
lockfile pins them by integrity. The Temenos verifier is published only to GitHub
Packages, with restricted access, so it stays a private archive that is not
committed. Before running `npm ci`, obtain it through the approved private
build/package source and place it at
`vendor/input-output-hk-temenos-attestation-verifier-0.3.0.tgz`. Keep it local;
`.gitignore` excludes it. Without it, `npm ci` stops with `ENOENT` and installs
nothing. Its pinned hash below identifies the artifact used for the recorded checks;
it is byte-identical to version 0.3.0 on GitHub Packages.

The installed SDK is `@laceio/sdk@0.2.0-canary.1` from npm, the canary that renamed
the Temenos attested prover to Veritee (`createVeriteeAttestedProver`,
`VeriteeVerifier`), which this app follows. `@laceio/cardano@0.2.0-canary.0`, the
version that SDK depends on, comes from npm as well.

Before it, the installed SDK was `@laceio/sdk@0.1.2-canary.3` from npm, published from
lace-platform `main` at `76c56fc75780cfec4f95b6df11781278ffe2bb96`, the merge of
PR #3064, which contains the merge of PR #3021 (`86fe745abc`), with
`@laceio/cardano@0.1.2-canary.0` from the same commit.

Before it, the consumer was checked with local builds from `vendor/`. The last was a build
of `main` at `26afd3d2ea646c8a65b61d8509aa210b6becf280`, the commit tagged
`@laceio/sdk@0.1.2-canary.5`, which never reached npm (SDK SHA-256
`7ae2349635aafa78967f8d05dd22b4373f196712c3f0d9136fb761f88c6c68bc`,
`@laceio/cardano` SHA-256
`9a0e931e80ee6848d0eca07a05e21361794986b6ce3c2acb1e59a58968eb1b98`). Apart from
chunk names, the canary's SDK differs from it only in Cardano token metadata
(schema version 2, which records the metadata's sources; LW-15517) and in new
translation strings, and its `@laceio/cardano` only in its version.

The build before that was the canary build of lace-platform branch
`feat/sdk-midnight-worker` (#2865, PR #3021) at
`68e9ff5aaa5b580c95c0a01219ee2a95864e77e9`: the Worker-mode work in two commits
(`b498c96f1c`, the feature, and `68e9ff5aaa`, its documentation), on
`main` at `c1964ab520c927f7afdd3314d9c143c55ca855e6`. It keeps the two SDK
fixes above, first made on the branch before it was rebased in
`961ef2c2fa90e1eba84929a40bd41555ce3d462d` (the worker's build for Vite's
development server) and `3ce36fb8372012a2848b478928549d3da2a43aa9` (the message
of engine errors that cross the worker). Since the build of
`fc48f479d2b298faab5dc4df12d5ee1328d1b4b7`, Worker mode changed in five ways.
An engine that failed is not replaced while one of its submissions is
unsettled, and it refuses new submissions with `MidnightStaleTxError`. A
submission that no running engine took returns `MidnightStaleTxError` and
removes its Pending row. The derivation of the Pending row is bounded as in page
mode, and the wait for finality is timed from the post. The worker builds one
state view per engine, with the balances and the sync flags of one state, and
sends it at most every 500 ms; `observeMidnightBalances` reads `synced` from
that state. And the worker no longer keeps records of pages that closed. The
build of `fc48f479d2` had added, since the build of
`97b206f67b98afeb6a37944deec15e8fa84f7982`, that the end of a worker shows as a
failed sync for each account it ran. The build after those five (a local build,
SDK SHA-256 `94aa91843e6fb9e64b2b79eca8b11fed74e9b1228cca44af18cffe3af9a693b4`)
was followed by six more changes, which the build of `68e9ff5aaa` has. A client's
channel in the worker takes one port at a time, and none until the worker has
answered the page's handshake; a closed client's id is refused until the host
has detached it. A call's proving progress reaches only the client that made the
call, under a random operation id. After a worker died, a reset or a resync
through the next worker lets the accounts' engines start again. A bulk resync
whose clear fails restarts the engines, counts no reset and fails. A value's
origin is checked before its bytes are decoded. And the worker's engine load is
bounded at 60 s, and a lost runtime lock ends the worker like a load failure;
the notice the worker posts is now `lace-midnight-engine:worker-failed`.
That build was made on 2026-10-29 with `npx nx build lace-sdk` and
`npx nx build lace-cardano`.
That runs both channels with all of the SDK's checks. The SDK tarball came from
`node apps/lace-sdk/scripts/pack.mjs --dist dist-canary --development`, and the
`@laceio/cardano` tarball from `npm pack --ignore-scripts` in `apps/lace-cardano`;
the build of `26afd3d2ea` was made the same way. The SDK tarball of the build of
`68e9ff5aaa` had SHA-256
`8cec1fc5c640b8002cce85308ffc7616746cf99698cfb4ca3e49ad03186ed980`, and its
installed packages matched the tarballs file for file. The SDK tarballs before
it: a local build, SHA-256
`94aa91843e6fb9e64b2b79eca8b11fed74e9b1228cca44af18cffe3af9a693b4`; before it,
the build of `fc48f479d2`, SHA-256
`1848e47eea4e31662a79437b2064f0a716ae5860b1710229fab10762c6297754`; before it,
the build of `97b206f67b`, SHA-256
`bdeba2f71b76fe9457b15f27c467c9b8af9a0a0b857f85c5413ee762d97cd659`; before it,
the build of `3ce36fb837`, SHA-256
`21fd09a2c3f3230b5b5db26b3f0637b0694018ede5f8dfe6a50fec7205d6c1e2`; before it,
the build of `961ef2c2fa`, SHA-256
`8c7d64144bf65bdf0b9df53fd54dfe506ef145d6112c524171e5af6fe96fe1bb` (packed from
the change before it was committed and from the commit, byte-identical); before
it, the build of `530fa46dfa3d23302ecc308bec2a9247d7e6e6fa` and of
`19eebf02c6c2c95bc1c3501eceb23af2eb9d1518` (byte-identical), SHA-256
`8edaefc60f8310b9b72c2095c455d9dd915c96b87b6df951e4997969fa314b1a`. The
`@laceio/cardano` tarball of that build differs from the previous one, SHA-256
`42f1aec40c6b01d86ac77080c0ab31e655ae9f2f7e4df350a39b2aee7a6e811a`, in chunk
names and in the `//#region` comments that name sources, since `main` moved
`packages/lib/util/src/common` to `packages/lib/cardano-util/src`; its code and
its `package.json` are the same. The previous tarball was byte-identical to the
builds of `fc48f479d2` and `97b206f67b`. It had changed with the first rebase,
for the first time since `530fa46dfa`: only its `package.json` differed, which
pinned `main`'s `ip-address` 10.7.4 and `pbkdf2` 3.1.7 (10.2.0 and 3.1.5
before). The earlier `@laceio/cardano` tarball, from `530fa46dfa` to
`3ce36fb837`, had SHA-256
`640bd387bad016449cee6a5d368fa37659942b8041aa586b1d665782e8d7699f`.

- `@laceio/sdk@0.2.0-canary.1`, **canary**, from npm. Integrity
  `sha512-K5d/X/+W3ew0Xnnbg8cm+4DtoD+iCFsrz3ylGEHG5y7otB8v80i/vK/BoLlVw6ZyVB1bxaajbYw+APBLR2LDSQ==`;
  tarball SHA-256 `8f7b3add8f5d8079187c9e2e5580ca30ee3ef73cb1d379a3d8e0e55c7a9b0898`.
- `@laceio/cardano@0.2.0-canary.0`, the version the SDK depends on, from npm.
  Integrity
  `sha512-Y0RAXXYN0WzAQI7wmuymFKuUU+WB8d0EBhNvfVkg7QWUIb3Y7uHft3D3Xsi6FJvcIR/WwspTucd9bpuCKvjqlQ==`;
  tarball SHA-256 `a78371641652055c191e9db18d969682b6426768000d946cb4a31bc379ea82cd`.
- The Midnight entry's optional peers, as the SDK's Midnight guide lists them:
  `@midnight-ntwrk/ledger-v8@8.1.0`, `@midnightntwrk/wallet-sdk@1.2.0`,
  `@midnightntwrk/wallet-sdk-abstractions@2.1.0`,
  `@midnightntwrk/wallet-sdk-address-format@3.1.2`, `@polkadot/api` and
  `@polkadot/api-base` (`^16.5.4`), `@polkadot/util` (`^14.0.1`) and
  `@subsquid/scale-codec` (`^4.0.1`).
- The experimental entry's Passport peers (`@midnight-ntwrk/compact-runtime`
  0.20 and others) are not installed. This app uses no Passport account. Vite
  replaces those imports with modules that throw when they load, and `vite build`
  warns about them (`IMPORT_IS_UNDEFINED`).
- Consumer-local `@input-output-hk/temenos-attestation-verifier@0.3.0`
  (artifact and hash below). Its own `@midnight-ntwrk/compact-runtime` 0.15 now
  installs under the verifier, because the SDK declares 0.20 as an optional peer.
  The runtime probe therefore loads that runtime's WebAssembly through
  `@midnight-ntwrk/onchain-runtime-v3`, whose `ContractState` it re-exports.
- The verifier is not on npm; the two SDK packages are.

The Cardano route imports the SDK from `@laceio/sdk/experimental`, the canary
entry that holds Cardano Shared Custody. Its wallets load
`m.blockchainCardanoCustody` for the custody store and side effects. That entry
also re-exports `@laceio/sdk/cardano`, so the page builds its wallet from one
entry, as the SDK's `MAINTAINING.md` ("Stable and Canary Builds") prescribes.
The Midnight route imports `@laceio/sdk/midnight`. Both resolve the same
package. No configuration alias targets SDK source.

Validation on 2026-10-25 against the previous build (`530fa46dfa`, SDK tarball
`8edaefc6…4b1a`), in page mode, after `rm -rf node_modules && npm ci`:
`npm run typecheck` passed; `npm run test:e2e -- tests/e2e/runtime.spec.ts`
passed 1/1 and filled the Vite cache; `npm test` passed 144/144; `npm run build` passed; `npm run test:e2e`
passed 23/23, the passkey and custody specs included; and
`npm run test:runtime:production` passed 1/1. The browser suite served a signer
built from the same lace-platform commit with
`VITE_CUSTODY_ALLOWED_ORIGINS=http://localhost:5198` (`index.html` SHA-256
`b8b406a94c5216cb126ca223cb4a609cd6f94b5c3ed74fcb8e654375f4512987`). The key
isolation check in [HOSTED-SIGNER.md](HOSTED-SIGNER.md#key-isolation) also passed.
The page-mode live Midnight suites were not run against that build: they need
Preview. On 2026-10-26, with the build of `3ce36fb837` and after
`rm -rf node_modules && npm ci`, the same checks passed again, with this app's
Worker-mode checks added since: `npm test` 153/153 and `npm run test:e2e` 26/26,
with the same signer build. Later on 2026-10-26, with the build of
`97b206f67b` and after `rm -rf node_modules && npm ci`, they passed again:
`npm test` 153/153, and `npm run test:e2e` 26/26 with a signer built from
`97b206f67b` with `VITE_CUSTODY_ALLOWED_ORIGINS=http://localhost:5198`
(`index.html` SHA-256
`fd82296636ea70e3dd08fea7c894716c63d9bc9e6f15ad3392e63e62412eeaaa`). The rebase
changed the signer's source, so the `530fa46dfa` signer build no longer matches
`97b206f67b`. On 2026-10-27, with the build of `fc48f479d2` and after
`rm -rf node_modules && npm ci`, they passed again: `npm test` 153/153, and
`npm run test:e2e` 26/26 with the same `97b206f67b` signer build, since
`fc48f479d2` does not change the signer's source. On 2026-10-29, with the
build of `68e9ff5aaa` and after `rm -rf node_modules && npm ci`, they
passed again: `npm test` 153/153, and `npm run test:e2e` 26/26 with the same
signer build, since `68e9ff5aaa` does not change the signer's source either.
On 2026-10-30, with a local build of `26afd3d2ea` and after
`rm -rf node_modules && npm ci`, the checks listed under
[Checks and opt-in live validation](#checks-and-opt-in-live-validation) passed:
`npm run typecheck`, `npm run build`, `npm test` 156/156, the five offline browser
specs 22/22, `npm run test:runtime:production` 1/1, and the passkey and custody
specs 4/4 with a signer built from `26afd3d2ea`. On 2026-11-04, with the installed
canary (`@laceio/sdk@0.1.2-canary.3`, from npm) and after `npm ci`, the same checks
passed again with the same counts, the passkey and custody specs with a signer
built from `76c56fc757`. The key isolation check was not rerun on either. Worker
mode's validation is under [Worker mode, live](#worker-mode-live).

#### Earlier canary build `75c3de4267`

The previously installed canary package, `vendor/laceio-sdk-0.1.0.tgz`, is the build
of lace-platform `main` at `75c3de4267`, the
merge of PR #2875, packed with the SDK's `scripts/pack.mjs` from a canary build on
2026-10-16 13:12 CEST; that build ran both channels with all of the SDK's checks. The
SDK artifact and installed SDK code were not modified: the installed package matches
the tarball file for file. The consumer matches the SDK's Preview Temenos deployment
and uses verifier 0.3.0. The behavioral pin test exercises the public SDK factory with a
synthetic verifier and checks its selected Preview config against the relay; it also
rejects the old Preprod proof URL.

Validation on 2026-10-16 against that build: type-check and production build passed;
144 unit tests passed (0 failed/skipped) once a browser check had populated the Vite
cache (see *Start*); `playwright-report/checks-75c3de4267-20261016.log` records them,
and `sdk-build-75c3de4267-20261016.log` and `sdk-pack-75c3de4267-20261016.json` there
record the SDK build and pack. The same log records the four Midnight browser specs,
headless, 19/19, including the startup-diagnostic spec, which now loads both the SDK's
`sdk-init` and `watch` chunks. Visible Chrome dev checks passed 13/13 (11 Midnight UI, one transport,
one actual runtime) and production runtime 1/1, 11:28:08–11:28:23 UTC. Wallet-free
Temenos preflight passed 1/1 at 11:28:23–11:28:29 UTC: obtain-evidence,
fetch-expected-values, verify-locally, warden-verify and bind-channel all completed.
The read-only live run passed 3/3 (0 failed/skipped), 11:28:29–11:39:21 UTC: indexed
restore/state, same-page instance isolation and nonzero account determinism. No
registration or diagnostics opt-in was set.

The one-unit own-wallet Temenos transfer failed on its first attempt,
11:39:21–11:48:59 UTC: attestation and the session completed, then the three encrypted
proxy requests returned upstream HTTP 404, 400 and 404; the page stopped at the failed
proving phase and nothing was submitted. Run once more with the same SDK and app code,
it passed 1/1 (0 failed/skipped), 11:52:46–12:02:44 UTC, exit 0: all three proxy
responses were HTTP 200, and the Submission panel reached `confirmed`, SDK `returned`,
and history type `Self` for activity
`4a9c4ce2ad2351d52ea1cc2a06b768af05d78067017bb09dc8242bc66533c9a8`, engine txId
`00775b4aa81d6451aab5a1ce30202ccc8acf32634a45a96999daba06e346551aa9`. The cause of the
upstream errors is not established. No watchdog fired. This live spec does not observe
other destinations; only the non-proving and Temenos preflight specs guard them. The
JSON reports are `playwright-report/*-aligned-20261016T112808253Z.json`
and `playwright-report/temenos-transfer-retry-aligned-20261016T115246442Z.json` (all
ignored).

The previous build, lace-platform PR #2875 at `c19ed1f0ed` (SHA-256
`00715c95d8d5f5fda9d29fee61cc8bddc9d70442ebfeffd987f2a17d0ad6c842`), passed the same
sequence on 2026-10-16, 00:45–01:07 UTC, its Temenos transfer on the first attempt
(activity `c5a4931bd5b5c37fc7044ca23592101c01e8f0c8bec1357cff8d63089f63048c`).
Cardano passkey/custody browser checks were not run in either validation: they require
an external signer build under lace-platform, outside this task's permitted filesystem scope. The non-proving live suite (ten checks: restore, signing, state, history, fee
estimate, resync; no transaction) passed on 2026-10-15 13:36–13:55 CEST (Playwright 1
passed, 0 blocked requests) against the earlier canary build `6f084a708c` (SHA-256
`c000b707…4459931`).

- Package: `@laceio/sdk@0.1.0`, **canary**, `vendor/laceio-sdk-0.1.0.tgz`.
- SHA-256: `c51f65504b45d86e11a661e58ce7293b56a76693aa10b8ad8924dfe7afcdd608` (verified after copying).
- External dependencies: `@midnight-ntwrk/ledger-v8@8.1.0` (peer range `^8.1.0` in this build),
  `@midnightntwrk/wallet-sdk@1.2.0`, `@midnightntwrk/wallet-sdk-abstractions@2.1.0`,
  `@midnightntwrk/wallet-sdk-address-format@3.1.2` and consumer-local
  `@input-output-hk/temenos-attestation-verifier@0.3.0` (artifact/hash below).
- This package is local and unpublished.

With that build, both Cardano and Midnight resolved the SDK through the public
`@laceio/sdk/cardano` and `@laceio/sdk/midnight` entries. Its archive and the
older `vendor/input-output-hk-lace-sdk-0.1.0-fe9d709f7.tgz` are kept for these
historical records; nothing installs them.

### Configuration and prerequisites

- Live validation uses **Preview**. Network selection also exposes the other
  supported networks. Custom networks need both node and indexer URLs.
- Midnight, connector, mainnet/preprod/preview support, remote prover, Temenos
  and unshielded features are enabled locally through `featureDev`. Remote feature
  configuration and shielded-only history are not enabled.
- Preview uses `https://rpc.preview.midnight.network` and
  `https://indexer.preview.midnight.network/api/v4/graphql`, the public SDK
  endpoints used in prior live checks. The extension proxy endpoints
  return 410 and are deliberately not used. Other networks use public SDK
  defaults or the explicitly entered overrides, displayed after restore.
- Local proving uses `http://127.0.0.1:6300`. A self-transfer proved with
  `midnightntwrk/proof-server:8.1.3` was submitted and **confirmed** on Preview on
  2026-10-14 (transaction `02139e2c375c7089aa5c60a90193a1578f25c64d8edd85edbb7cdd271b2adace`,
  block 1294134 per the read-only reconciliation record of that run; the same
  hash appears in the wallet's history). The page of that run still read "Proved"
  with no identifier. The most likely cause is that `submitMidnightTx` returned
  an error or timed out after the transaction was broadcast, and the page then
  discarded the activity hash it had computed; a hang would have shown the same
  symptom. The page now records that hash before the SDK
  call and reports the outcome from history (see
  [Using the route](#using-the-route)), whichever of those happened. Why the SDK
  call did not return its identifier in time is not established.
  Temenos on Preview uses `https://api.proofserver.preview.wastedp.io`, `tee-delegated`, the public
  `createTemenosAttestedProver`, and the exact installed verifier package's
  `AMD_ROOT_CERTIFICATES`. The consumer supplies the adapter's injected verifier:
  a fresh `AttestationVerifier` and AKX evidence/channel, ledger, local and Warden
  dependencies from the adapter's baked config on every call. The private verifier
  is an explicit consumer-local file dependency, never a public SDK dependency.
  Authorized artifact: `input-output-hk-temenos-attestation-verifier-0.3.0.tgz`,
  SHA-256 `408fb33f289c84bbedc9eff37ff7a154a2e69ae87fdcc0ccdfd5c6e34e3bfd02`.
  Root certificates never come from a server or an input
  field. The aligned Preview deployment/verifier 0.3.0 runs on 2026-10-16 completed
  encrypted proving and confirmed the self-transfers recorded above. Encrypted proving
  can still fail upstream after a successful attestation: one attempt received HTTP
  404/400 from the proxy and passed when run again, and earlier live checks recorded an
  upstream HTTP400 in the same step (causes unestablished).
  Attestation failure never falls back to ordinary HTTP. Temenos `check` remains
  unsupported; in-process and paired-device proving are not offered.
- Temenos evidence/AKX requires the same-origin `/temenos-relay` backend, installed
  by `temenos-relay.ts` for both `npm run dev` and `npm run preview`. A static
  deployment needs an equivalent backend; the scoped fetch explicitly refuses
  responses without the relay marker. The relay permits only HTTPS to
  `attestation.proofserver.preview.wastedp.io`: GET `/attestation.json` and
  `/tee_attestation/enclave-key`, POST `/tee_attestation/session`,
  `/tee_attestation/session/complete` and `/tee_attestation/proxy`. Two further
  POST routes serve the installed verifier: `/warden/verify-attestation` forwards
  only its public attestation envelope to `https://warden.wastedp.io/dapps/verify_attestation`;
  `/ledger/contract-state` maps the SDK's Preprod default
  `https://indexer.preprod.midnight.network/api/v4/graphql` to
  `https://midnight-preprod.blockfrost.io/api/v0`. The latter accepts only the
  installed `contractAction(address) { state }` query with a 64-hex public contract
  address, never mutations or arbitrary GraphQL. SDK deployment/trust identities
  remain unchanged. The Warden's verdict and ledger state still undergo all
  existing verifier checks.
  Attestation, transcript signatures and AKX encryption stay in the verifier in
  the browser; the relay carries public evidence/handshake data and ciphertext.
  Verifier 0.3 encrypts a version-1 HTTP request envelope inside the same
  `{sid,ciphertext}` outer body. Session hello/completion shapes are unchanged;
  the relay does not decrypt or accept plaintext proof envelopes. Its ledger
  query, Warden client and evidence fetches are byte-identical to 0.2, so the
  fixed Blockfrost Preprod forwarding target remains appropriate. Non-2xx
  responses carry a fixed `x-lace-temenos-error-origin` classification
  (`relay` or `upstream`); diagnostics read this metadata, never bodies.
  This identifies who produced the response, not the root cause: `relay` also
  includes upstream connection failures, timeouts and refused redirects.
  It rejects credentials, cross-origin browser requests, redirects and unlisted
  routes; validates upstream TLS; logs/persists no headers or bodies; and limits
  each exchange to 30 seconds, four concurrent exchanges, 1 MiB evidence, 4 KiB
  handshake, 4 MiB ledger responses or 16 MiB encrypted envelopes. These limits fail closed. Keep Vite
  on localhost; a deployed backend needs the application's access controls.
  Validation distinguishes attestation from the separately confirmed transfer;
  transport availability alone establishes no transaction result.
- Before starting Vite, set server-only `TEMENOS_BLOCKFROST_PREPROD_TOKEN_FILE`
  to an absolute path to an owned, regular, mode `600` file containing the
  authorized Midnight Preprod project token. Symlinks, unsafe permissions,
  missing/malformed tokens, oversized files and enabled native HTTP(S) debug
  logging fail closed. Only the fixed
  official Preprod Blockfrost host receives `project_id`; it never enters the
  browser bundle, URL, logs or relay diagnostics. Do not use a `VITE_` variable
  for it. No token is needed by the evidence, handshake or Warden routes.
- Wallet-free attestation can be checked separately, with explicit
  authorization:
  `TEMENOS_LIVE_PREFLIGHT=1 npm run test:midnight:live -- tests/live/temenos.live.spec.ts`
  with the server token-file variable already set. This opt-in check uses the
  same `createConsumerTemenosProver` factory as the application, establishes all
  five attestation phases and the channel, then closes it. It creates no wallet
  and performs no proving, signing or submission. Its attachment contains only
  fixed phase/status/result values; the live config disables secret-bearing
  traces/screenshots/video. The offline browser regression stays synthetic.
- Use a fresh disposable test phrase and an in-memory session password. They are
  cleared from the input elements after restore, never written to localStorage,
  logged or included in fixtures. Storage is `storageInMemory`; reload discards
  the session. Restoring does not authorize any signing or submission.
- Prior live checks recorded NIGHT receipt, confirmed own DUST registration and positive
  generated/spendable DUST, and a local-prover self-transfer confirmed on chain.
  That transfer's balance change and fee consumption remain unverified.
- Real transfers require synchronized, funded assets and spendable DUST. External
  DUST designation requires NIGHT and no existing generation capacity. Circuit
  operations additionally require real preimage/ZKIR/prover/verifier material.
  Missing prerequisites leave the corresponding acceptance row open.

### Using the route

1. Restore the phrase on Preview. Index 0 is always derived; an additional index
   (for example 7) exposes deterministic indexed restoration. Select an account.
2. Inspect all three receive addresses, hex public keys, token available/pending
   balances, generated versus spendable DUST, generation details and sync state.
   Missing state is not zero. Rounded sync progress and cached success timestamps
   do not establish current completion or connectivity.
3. For a homogeneous transfer, supply output JSON with `to`, `tokenId` from state,
   and `amount` as a positive integer string in smallest units. Estimate the fee,
   build, review signing, review proving, then review submission separately.
4. For registration, leave the DUST destination empty for own-address behavior or
   enter an eligible external DUST address. Review occurs **before** the helper,
   which signs internally. Then review proving and submission separately.
5. Advanced connector requests use `desiredOutputs` rows with `kind`, raw ledger
   `type`, `value` as a positive integer string and `recipient`. Intent also takes
   `desiredInputs` rows (`kind`, `type`, `value`) and
   `options: {intentId: "random", payFees: true}`. Sealed/unsealed balancing takes
   `tx` hex and optional `options.payFees`. These helpers may sign/prove, so their
   review precedes the call; submission is still separate. `intentId` is
   accepted but ignored. Use the message and circuit controls for the remaining adapters.

Cancellation, edited inputs, account changes and setup changes discard approvals
and staged transactions. An in-flight SDK operation is not guaranteed cancellable;
its late result cannot become a usable next stage. Each approval is single-use.

Submission is the exception: once approved it cannot be cancelled or discarded.
While the SDK call is in flight, cancel, the transaction, advanced and setup
controls, the account selector, reset and clear-session are disabled, and the
page refuses programmatic attempts to discard. The **Submission** panel lists
every submission of the session, newest first, keyed by the proved transaction's
activity hash. A later submission never replaces an earlier one: an `uncertain`
hash stays listed until history resolves it, and the review of a new submission
names every unresolved earlier hash, so approving it acknowledges them. Each
record stores its hash before the SDK call and then reports one of:

| Stage | Meaning |
|---|---|
| `submitting` | Submitting (may broadcast from now on); awaiting the SDK's finality result; history is watched for the hash. |
| `submitted` | The SDK returned its `txId`; history confirmation of the hash is pending. |
| `confirmed` | A history row with the hash appeared (Self/Send/Receive). This holds even if the SDK call is still pending or later fails. |
| `failed-on-chain` | History lists the hash as Failed. |
| `uncertain` | The SDK returned an error after the transaction may have been broadcast. Check history or the chain for the hash before retrying; a later history row still confirms it. |
| `interrupted` | Worker mode: the worker ended after the page handed it the transaction and before it reported the outcome (`MidnightSubmitInterruptedError`). The outcome is unknown: the transaction may still reach the chain, the SDK keeps its Pending activity and never submits it again, and neither does the page. A later history row still resolves it. |
| `failed` | The SDK failed while resolving the account's engine, or refused a transaction built before that engine restarted or was reset (`MidnightStaleTxError`), before sending anything. In Worker mode also: no worker support, a worker that did not start, a settings conflict, a worker that ended before the page handed it the transaction (`MidnightWorkerStoppedError`), or a reset that refused the submission (`MidnightEngineResetError`). A later history row for the hash still overrides it. |

Limitations:

- History of the submitting account keeps resolving its records after the
  account selector moves to another account. After **Clear session** nothing is
  observed: the records stay listed with their last stage and resolve only after
  the same wallet is restored in this page. A reload loses them; check the chain
  for the hash. Leaving the page clears the session even during a submission, so
  a page restored from the browser's back-forward cache cannot resolve the
  record that was in flight.
- The status line announces only the newest submission. An earlier record
  resolved from history updates the Submission list without replacing the
  status of another operation.
- `confirmed` reflects the history row's type. Upstream sync maps a
  `PARTIAL_SUCCESS` transaction to Send/Receive, so a partially successful
  transaction shows as confirmed.

The `txId` is the SDK's submission identifier, not the activity hash; match
history by `activityHash`. The page reads the hash from the proved transaction's
`activityHash` field: the SDK's transaction values are opaque and have no ledger
methods. A submission attempt consumes the transaction even when
its outcome is uncertain. Prover progress shows actual emitted events, not invented
percentages. HTTP provers may emit no events.

Available history omits shielded-only rows;
`getTxHistory` and `hintUsage` remain unimplemented. Per-account reset is a request,
not an assertion that persistence was erased or sync completed. Token renaming
uses public validators and preserves other metadata; native/reserved names remain
uneditable. This app adds no connector injection or wallet-product features.

### Checks and opt-in live validation

Use Node `24.14.0`. After installing the packaged dependencies, run:

```bash
npm run typecheck
npm run test:e2e -- tests/e2e/midnight.spec.ts tests/e2e/midnight-worker.spec.ts tests/e2e/temenos-transport.spec.ts tests/e2e/runtime.spec.ts tests/e2e/midnight-startup.spec.ts
npm test -- --test-timeout=60000
npm run build
npm run test:runtime:production
SIGNER_DIST=<lace-platform>/apps/lace-passkey-signer/dist npm run test:e2e -- tests/e2e/passkey.spec.ts tests/e2e/custody.spec.ts
```

Build that signer from the lace-platform commit of the installed SDK, with
`VITE_CUSTODY_ALLOWED_ORIGINS=http://localhost:5198`, as
[HOSTED-SIGNER.md](HOSTED-SIGNER.md#verification) shows.

`E2E_PORT` retains the existing default 5198; interactive signer usage retains
localhost:5173 and its allowed origins. The ordinary Midnight browser tests check
route separation and cancellation without pretending to run a live wallet.
Existing mocked Cardano tests are regression evidence, not live ledger proof.

The live harness requires both `MIDNIGHT_LIVE=preview` and a private
`MIDNIGHT_TEST_WALLET_FILE` outside this repository. Its schema is `mnemonicWords`
(string array), `passwordHex` or `password` (nonempty session string),
`network: "preview"`, `address` (expected public unshielded address), and optional
`accountIndex` (default 0). Keep this file private and outside source control. The harness
uses `parseTestWallet`, compares the derived address before signing, clears secret
inputs and memory references, and disconnects at teardown. The live config disables
trace, screenshots, video, git capture and automatic failure DOM snapshots. Keep
these settings; never enable protocol/debug logging.

Opt-in non-proving execution, after build/browser checks and review:

```bash
unset MIDNIGHT_LIVE_REGISTER MIDNIGHT_LIVE_TRANSFER
MIDNIGHT_LIVE=preview MIDNIGHT_TEST_WALLET_FILE=/private/path/disposable-wallet.json \
  npm run test:midnight:live -- tests/live/midnight-nonproving.live.spec.ts
```

This single test restores **one** wallet/instance and reuses it for cancellation,
text/hex/base64 signing of a fixed harmless UTF-8 string, installed ledger public-key
verification, DUST state, existing registration history/details, unsigned one-unit
self-transfer fee estimation, native-token rename refusal, then bounded per-account
resync. No transaction is built, registered, signed, proved or submitted. Only message
signing is approved. Prover/relay and unrelated HTTP destinations are blocked before
sending; an attempted forbidden request fails acceptance. The app uses its local
prover selection for this run; that prover must never be contacted. No attestation
retry or Temenos diagnostic cycle occurs.

Forbidden HTTP and WebSocket destinations use a serialized negative URL filter;
approved Preview streams use browser passthrough rather than forwarding their frames
through the Playwright worker. A bounded installed-code fixture verifies this routing
behavior. It does not establish why the interrupted live run stalled. Readiness waits
now race stalled reads/pauses against their deadline; the live runner also has a
35-minute global watchdog by default. The interrupted run did not establish any of
its ten check outcomes.

`midnight.live.spec.ts` now reads only public sync ratios, fixed startup stages and
strict completion flags. Forward progress refreshes its inactivity deadline and
extends the Playwright test timeout; ratio 1 alone never establishes readiness.
The first recognized observation starts this budget; later extensions require
forward progress. Callers without the explicit progress callback keep a fixed deadline.
Unchanged/regressive ratios and repeated restarts do not reset the high-water mark
within one wait. A later explicit restore gets fresh marks. Stalled reads/pauses
and terminal failures still fail. Other operations retain the test-level bound.
For the attended long-sync validation, `--global-timeout=0` removes only the fixed
global cap, with an independent process watchdog for 35 minutes without forward
public progress. Do not disable the per-test timeout. Capture settings remain off.
The separate non-proving suite still has its own fixed 30-minute test timeout;
it was not rerun or changed as part of this validation.

The local transfer check uses the existing application option and requires separate
authorization. Its previous run was reconciled as confirmed (transaction `02139e2c…2adace`);
a rerun sends another transfer. Keep registration unset: the existing account is
already registered.

```bash
unset MIDNIGHT_LIVE_REGISTER MIDNIGHT_LIVE_DIAGNOSTICS
MIDNIGHT_LIVE=preview MIDNIGHT_LIVE_PROVER=local MIDNIGHT_LIVE_TRANSFER=own \
  MIDNIGHT_TEST_WALLET_FILE=/private/path/disposable-wallet.json \
  npm run test:midnight:live -- tests/live/midnight.live.spec.ts --grep 'packaged browser WASM:'
```

`MIDNIGHT_LIVE_PROVER` accepts only `local` or `temenos`; unset retains Temenos.
Local selection first sends a wallet-free GET to `http://127.0.0.1:6300/version`,
with redirects refused, a five-second deadline and a 256-byte response limit.
It requires `8.1.3` as plain text, a JSON string, or the JSON `version` field.
An unrecognized response fails before restore. Passing this version check alone
does not establish successful proving or submission.
There is no fallback or Temenos diagnostic retry. The transfer run reuses one restore,
estimates and sends exactly one smallest NIGHT unit to the validated wallet address,
and requires the Submission panel to reach `confirmed` for that exact activity hash;
an SDK result alone is insufficient. An `uncertain` stage keeps waiting for history,
and the panel and status text are attached to the report.

The separate non-proving command requires REGISTER and TRANSFER unset. Its ten
independent outcomes reuse one wallet and its resync stays last, after any transfer
run has settled. The two suites use separate sessions to keep the non-proving
checks isolated from transaction operations.
Do not resync while a timed-out transaction may still be in flight; retain an uncertain
transaction outcome and reconcile its identifier before scheduling resync.

The attachment contains only ten fixed check outcomes, a blocked-request count and
DUST presence/positive booleans. It excludes addresses, public keys, signatures,
wallet serialization, raw errors and network contents. Failure, timeout, missing
prerequisite and unrun checks stay distinct and fail overall acceptance. Resync
requires observed cache clearing, a fresh Pending operation, a later successful sync,
strict sub-wallet completion and unchanged address/keys. It runs last and is withheld
if a signing/estimation timeout could leave work in flight. It tests recovery of the
selected account; other-account survival remains a separate live check. Optional
`decayTime`/`maxCapReachedAt` can legitimately be absent and are recorded as absent.

The registration-history check matches the recorded public activity hash from the
previously confirmed registration.
A different disposable wallet needs its own confirmed registration evidence; absence
is a prerequisite failure, never a fabricated registration or automatic retry.

The reset check (lace-platform#2939) runs only with `MIDNIGHT_LIVE_RESET=1`, in page
mode and in Worker mode. It requires that nothing is reserved, builds one smallest
NIGHT unit to the wallet's own address without signing it, and waits until
`night.available` drops and `dust.available` falls below `dust.balance`. It then
resets the account's sync and waits for a new strict sync: all three parts synced,
a later `lastSuccessfulSync` and nothing pending. It then requires the NIGHT
available before the build, no pending NIGHT, and positive DUST all spendable. It
never registers, so a wallet without spendable DUST fails its prerequisite. Nothing
is signed, proved or submitted. Run it after any transfer has confirmed, never beside
one. It tells that the reset happened from the account's history emptying, so the
wallet needs at least one history row. Worker mode still checks the local proof
server's `/version`, and its command runs the check once per server, so twice:

```bash
unset MIDNIGHT_LIVE_REGISTER MIDNIGHT_LIVE_TRANSFER
MIDNIGHT_LIVE=preview MIDNIGHT_LIVE_RESET=1 MIDNIGHT_TEST_WALLET_FILE=/private/path/disposable-wallet.json \
  npm run test:midnight:live -- tests/live/midnight.live.spec.ts --grep 'reset frees'
MIDNIGHT_LIVE=preview MIDNIGHT_LIVE_RESET=1 MIDNIGHT_LIVE_PROVER=local \
  MIDNIGHT_TEST_WALLET_FILE=/private/path/disposable-wallet.json \
  npx playwright test --config playwright.midnight-worker-live.config.ts --grep 'reset frees'
```

Page-mode validation on Preview on 2026-11-04 with the installed canary
(`@laceio/sdk@0.1.2-canary.3`, from npm), for lace-platform#2939, with Chromium
from Playwright 1.63, each on its first attempt:

- Read-only (`midnight.live.spec.ts`, no opt-ins): 3/3, the reset check skipped.
- Wallet-free Temenos preflight: 1/1, all five phases and the channel.
- One smallest NIGHT unit to the wallet's own address, proved through Temenos:
  1/1, `confirmed` and listed as `Self`, activity hash
  `844779d5f4fe712820e64523c82e72478057680da86723362c1b400ee4bd3858`. The relay
  answered all three calls to the encrypted proving route with 200.
- The reset check, with nothing signed, proved or submitted: 1/1. Before the build,
  5000000000 NIGHT available, none pending and all DUST spendable. After the build,
  4999999999 available, 1 pending and no DUST spendable. After the reset,
  5000000000 available, none pending and all DUST spendable.

On 2026-10-30, with a local build of `26afd3d2ea`, the same four checks passed on
their first attempt with the same results; that Temenos transfer's activity hash
was `0d88f6d9c894017f289ce8d6dd3107ddceada156cc3c580d2475fe98a0f400f3`.

### Worker mode, live

`playwright.midnight-worker-live.config.ts` (`npm run test:midnight:worker:live`)
runs `tests/live/midnight-worker.live.spec.ts` twice: project `dev` against the Vite development server (port 5196,
`WORKER_LIVE_DEV_PORT`), and project `preview` against `vite build`, built into
`dist-worker-live/`, served by `vite preview` (port 5197, `WORKER_LIVE_PREVIEW_PORT`).
It keeps the live suite's settings: no trace, screenshots, video or git capture,
one Playwright worker and no retries. Its JSON report goes to
`playwright-report/midnight-worker-live.json`, or to `WORKER_LIVE_JSON`. Its
attachments hold no secrets: hashes, counts, fixed SDK labels, timings,
connection URLs, and the page's own text, that is the status line, readiness,
configuration and submission panels, which include the account id and SDK
error messages.
The `preview` project also loads the production build's Cardano route once, with
every request to another origin refused.

`MIDNIGHT_LIVE` takes `preview` or `undeployed`. `undeployed` is the local chain
of lace-platform's `compose/midnight.yml`: node `http://localhost:9944` and
indexer `http://localhost:8088/api/v4/graphql`, which the scenarios enter as
custom endpoints. Its wallet file has the same keys as the Preview one, with
`network: "undeployed"` and an `mn_addr_undeployed…` address: for example the
chain's genesis-funded development wallet, which lace-platform's
`apps/lace-extension-shell/e2e/specs/30-midnight-dapp-local.spec.ts` uses. The
local chain starts from genesis, so the first scenario that spends registers that
wallet's NIGHT for DUST through the page. Nothing registers on Preview. Worker
mode needs `MIDNIGHT_LIVE_PROVER=local`: each scenario checks the proof server's
`/version` (8.1.3) before any wallet starts, and Temenos is refused.

The transfer on Preview: Worker mode on, memory storage, restore, a strictly
synced balance at the supplied address, then build → sign → prove → submit of
one smallest NIGHT unit to the wallet's own address, until the SDK returns its
`txId` at finality and history lists the hash as `Self`. It also checks that the
worker, not the page, reached the node, the indexer and the proof server, and
that the transfer was submitted once. It types into the Page responsiveness
field and checks the echo, and records whether the engine was still syncing at
that moment (`syncingWhileTyping`); it does not fail when sync finished first,
which can happen on the fast local chain. Each command sends one transfer per
server, so two:

```bash
MIDNIGHT_LIVE=preview MIDNIGHT_LIVE_PROVER=local \
  MIDNIGHT_TEST_WALLET_FILE=/private/path/disposable-wallet.json \
  npx playwright test --config playwright.midnight-worker-live.config.ts
```

On the local chain, from lace-platform's root start the node and the indexer
(`docker compose -f compose/midnight.yml up --detach --wait node indexer`; its
own proof-server service is not needed when a proof server already listens on
`127.0.0.1:6300`), then from this directory:

```bash
export MIDNIGHT_LIVE=undeployed MIDNIGHT_LIVE_PROVER=local \
  MIDNIGHT_TEST_WALLET_FILE=/private/path/undeployed-genesis-wallet.json
# Every scenario, on both servers:
npx playwright test --config playwright.midnight-worker-live.config.ts
# Interrupted submit only:
npx playwright test --config playwright.midnight-worker-live.config.ts --grep 'Interrupted submit'
# The tab and other scenarios only:
npx playwright test --config playwright.midnight-worker-live.config.ts --grep 'tabs:|unsupported browser|proving provider|connector:|engine load failure'
```

Stop the chain with `docker compose -f compose/midnight.yml down`. The local
scenarios:

- **The transfer** as above, on the local chain.
- **Two tabs share one engine**: a second tab of the same browser restores the
  same wallet and attaches to the engine the first runs, in the one SharedWorker
  (still one worker, and as many open indexer subscriptions as with one tab: a
  second engine would hold its own set open, while a reconnect only replaces a
  socket); closing the first tab leaves the second working.
- **Settings conflict**: a second tab with another worker storage gets
  `MidnightWorkerSettingsConflictError`, then attaches with **Use the running
  engine's settings** (`adopt`).
- **Shared reset**: a sync reset in one tab resets the engine for both; the other
  tab's transfer built before it is refused, and a new one signs.
- **Unsupported browser**: with `SharedWorker` removed before the app loads,
  restore returns the wallet controls; the balance stream and every later
  engine-dependent operation report `MidnightWorkerUnsupportedError`, no worker
  starts and the page does not run the engine itself.
- **Proving provider**: a dApp's unproven transaction, one shielded output to
  sample public keys built by the ledger in Node, gives a real
  `midnight/zswap/output` preimage. The circuit control checks and proves it with
  the proof server's built-in material, through the worker, and the proof
  completes the dApp's transaction in the ledger.
- **Connector balancing**: `balanceMidnightUnsealedTransaction` balances, signs
  and proves a dApp's unbalanced transaction (one smallest NIGHT unit to the
  wallet's own address, no inputs, no fee) in the worker; it is then submitted
  and the indexer lists it.
- **Engine load failure**: the worker's engine chunk request fails once
  (DevTools Protocol `Fetch`, since Playwright's routing does not see a
  SharedWorker's requests); the page gets `MidnightWorkerStartupError`, the worker
  closes, and **Observe this account again** starts a new worker that syncs.
- **Interrupted submit**: after a control transfer, the worker is paused by the
  DevTools Protocol at the wallet SDK's broadcast call, right after the submit
  request reached it; its paused task is terminated
  (`Runtime.terminateExecution`), so nothing is broadcast, and the worker is
  closed with `Target.closeTarget`. The page gets
  `MidnightSubmitInterruptedError` through the `Result`, shows `interrupted`,
  and the SDK's Pending row stays. "Through the `Result`" is checked at the SDK
  call itself: the scenario sets `window.__laceSubmitBoundary` to an array
  before the app loads, and the page then records, by name and code only,
  whether each `submitMidnightTx` promise fulfilled with an `Ok` or an `Err` or
  rejected (`observeSubmitBoundary` in `src/midnight/operations.ts`; without the
  array it does nothing). The scenario requires that no promise rejected and
  that the interrupted one fulfilled with an `Err` holding
  `MidnightSubmitInterruptedError`. The next call starts a new worker. From
  Node, the indexer lists the control transaction and not the interrupted one
  after five more blocks, the node's pool is empty, and the workers sent one
  submission in all: the control's.

The scenarios read the workers through a browser-level DevTools Protocol session
(`tests/live/worker-cdp.ts`): Playwright has no SharedWorker API, and its routing
does not see a SharedWorker's requests. Chromium keeps a SharedWorker that ends
while a DevTools session is attached to it, and connects the same page's next
`new SharedWorker` to that dead worker, so the helper detaches before it closes a
worker, and the engine-load scenario observes without attaching.

Validation on Preview on 2026-11-04 with the installed canary
(`@laceio/sdk@0.1.2-canary.3`, from npm), for lace-platform#2939, after `npm ci`,
with Chromium from Playwright 1.63 and proof server 8.1.3, each on its first
attempt:

- The transfer on both servers: 2/2, `confirmed` and listed as `Self`, activity
  hashes `fafb6f566e976f2617f947dcc4506144dabfb94f55d23fb5f6887db50792368f` (dev) and
  `c8a909a91112fb501620432d96973f4bdf7aaf652389f0b8b7f397c4c8f9707d` (preview). The
  production build's Cardano route: 1/1.
- The reset check on both servers: 2/2, with the same three NIGHT and DUST states
  as in page mode.

On 2026-10-30, with a local build of `26afd3d2ea` (SDK SHA-256 `7ae23496…68bc`)
and after `rm -rf node_modules && npm ci`, the same checks passed on their first
attempt: the transfers' activity hashes were
`89177daa0484e373fd8e315f17b7e083d6637c54756d25681a9d4452d8806ea0` (dev) and
`950217638654a32af313c49d429ffc33067ccf7f62a9c5d76e9244032bb08d62` (preview). The
local-chain scenarios were not rerun on either build. Temenos is refused in Worker
mode.

Validation on 2026-10-29 with the build of `68e9ff5aaa`, after
`rm -rf node_modules && npm ci`, with Chromium from Playwright 1.63, the local
chain of lace-platform `compose/midnight.yml` (node 0.22.5, indexer 4.0.1) and
proof server 8.1.3:

- `npm run typecheck`, `npm test` (153/153), `npm run build`, `npm run test:e2e`
  (26/26, the three Worker-mode browser checks included, with the signer built
  from `97b206f67b` named above) and `npm run test:runtime:production` (1/1)
  passed; so did the key isolation check.
- The interrupted submit with the check at the SDK call
  (`--grep 'Interrupted submit'`, on a chain fresh from genesis): 2/2. On both
  servers every `submitMidnightTx` promise fulfilled, none rejected, and the
  interrupted one fulfilled with an `Err` holding
  `MidnightSubmitInterruptedError`; the Pending row stayed, the indexer listed
  the control once and the interrupted transaction not at all after five more
  blocks, and the pool was empty. After the worker closed, the page reported the
  account's sync as failed; the failure cleared once the new worker had synced
  the account.
- Every scenario on the local chain, on both servers (the command without
  `--grep`), on the same chain right after: 19 passed, none failed, and the
  Cardano route was skipped on the development server, as designed. That
  includes the transfer on the local chain (restore, sync, build, sign, prove,
  submit and finality, with the balances read at `synced` showing NIGHT and DUST
  available), the three two-tab scenarios on both servers (one worker, 3 open
  indexer subscriptions with one tab and with two; the settings conflict, then
  adopt; the shared reset, then `MidnightStaleTxError` for the other tab's
  earlier transfer), the connector balancing, the proving provider, the engine
  that fails to load (the page ended with `midnight-worker-startup-failed`, the
  worker closed and the next call started a new one), and the interrupted submit
  again on both servers, with the same counts. The node rejected no transaction
  in either run.
- Every run passed the first time; no rerun was made.
- The transfer on Preview was not run with this build, and the 6/6 recorded for
  `97b206f67b` below was run on that build, so it is not a result for this one;
  its six transactions are unchanged. Since then, Worker mode's submit path and
  its worker changed. Three changes were made in the build of `fc48f479d2` and
  the one after it. A submission that was refused before any engine took it
  returns `MidnightStaleTxError` and removes its Pending row. The Pending-row
  step is bounded, and the wait for finality starts at the post. The worker
  throttles the state view, and the balances and their `synced` flags come from
  one state. The build of `68e9ff5aaa` changed six more things (listed under
  [Packaged dependencies](#packaged-dependencies)): the worker's one port at a
  time per client and its handshake gate, the proving progress that reaches only
  the client that made the call, the restart of engines by a reset or a resync
  after a worker's death, the failed bulk resync, the check of a value's origin
  before it is decoded, and the 60 s bound on the engine load with the lost
  runtime lock. The local runs above cover some of this and not all. The
  transfer and the control transfer of the interrupted submit were submitted and
  returned at finality on both servers, and the interrupted submit's outcome
  reached the caller through the `Result`; the balances and their `synced` flags
  came from one state. Both tabs' stream channels connected through the new port
  gate in the two-tab, settings and reset scenarios, and the transfers and the
  connector balancing passed values through the origin check; the shared reset
  refused the other tab's earlier transfer with `MidnightStaleTxError` when it
  was signed. The engine load failure ended the page's stream with
  `midnight-worker-startup-failed` and closed the worker, by the failure path
  that posts the renamed notice; the scenario does not read the notice. No local
  run covers a submission that no running engine took, a second port for one
  client, a connect before the handshake, a client id that comes back before its
  detach, the isolation of proving progress between two clients, a reset or a
  resync after a worker's death, a bulk resync whose clear fails, the skipping
  of the decode, the 60 s load bound or a lost runtime lock: no scenario
  produces them, and the scenarios do not check what the page receives as
  progress.

With `fc48f479d2` (`1848e47e…7754`), on 2026-10-27, after
`rm -rf node_modules && npm ci`, with Chromium from Playwright 1.63, the local
chain of lace-platform `compose/midnight.yml` (node 0.22.5, indexer 4.0.1) and
proof server 8.1.3:

- `npm run typecheck`, `npm test` (153/153), `npm run build`, `npm run test:e2e`
  (26/26, the three Worker-mode browser checks included, with the signer built
  from `97b206f67b` named above) and `npm run test:runtime:production` (1/1)
  passed; so did the key isolation check.
- The interrupted submit with the check at the SDK call
  (`--grep 'Interrupted submit'`, on a chain fresh from genesis): 2/2. On both
  servers every `submitMidnightTx` promise fulfilled, none rejected, and the
  interrupted one fulfilled with an `Err` holding
  `MidnightSubmitInterruptedError`; the Pending row stayed, the indexer listed
  the control once and the interrupted transaction not at all after five more
  blocks, and the pool was empty. After the worker closed, the page reported the
  account's sync as failed; the failure cleared once the new worker had synced
  the account.
- Every scenario on the local chain, on both servers (the command without
  `--grep`): 19 passed, and the Cardano route was skipped on the development
  server, as designed. That includes the transfer on the local chain, the three
  two-tab scenarios on both servers (one worker, 3 open indexer subscriptions
  with one tab and with two; the settings conflict, then adopt; the shared
  reset, then `MidnightStaleTxError` for the other tab's earlier transfer), and
  the interrupted submit on both servers.
- The transfer on Preview was not run with this build.

With `97b206f67b` (`bdeba2f7…d659`), on 2026-10-26, after
`rm -rf node_modules && npm ci`, with Chromium from Playwright 1.63, the local
chain of lace-platform `compose/midnight.yml` (node 0.22.5, indexer 4.0.1) and
proof server 8.1.3:

- `npm run typecheck`, `npm test` (153/153), `npm run build`, `npm run test:e2e`
  (26/26, the three Worker-mode browser checks included, with the signer built
  from `97b206f67b` named above) and `npm run test:runtime:production` (1/1)
  passed; so did the key isolation check.
- The interrupted submit with the check at the SDK call
  (`--grep 'Interrupted submit'`, on a chain fresh from genesis): 2/2. On both
  servers every `submitMidnightTx` promise fulfilled, none rejected, and the
  interrupted one fulfilled with an `Err` holding
  `MidnightSubmitInterruptedError`; the Pending row stayed, the indexer listed
  the control once and the interrupted transaction not at all after five more
  blocks, and the pool was empty.
- Every scenario on the local chain, on both servers (the command without
  `--grep`): 19 passed, and the Cardano route was skipped on the development
  server, as designed. That includes the transfer on the local chain, the three
  two-tab scenarios on both servers (one worker, 3 open indexer subscriptions
  with one tab and with two; the settings conflict, then adopt; the shared
  reset, then `MidnightStaleTxError` for the other tab's earlier transfer), and
  the interrupted submit on both servers.
- The transfer on Preview: 6/6, three runs of the command above, each on both
  servers. Each time the worker, not the page, reached the node, the indexer and
  the proof server; the scratch field echoed what was typed while the engine
  synced; the worker sent one submission; the SDK returned the `txId` at
  finality and history listed the hash as `Self`. Sync from empty memory storage
  took 9.5 to 10.1 minutes, the transfer 22 to 33 seconds. Activity hashes: dev
  `fde42e65…a6f6`, `23a2ef15…7531`, `1b4daec4…9c10`; production preview
  `c474091a…200a`, `0e5cda12…281e`, `364cb1c2…8f4f`. The production build's
  Cardano route loaded each time.

With `3ce36fb837` (`21fd09a2…c1e2`), on 2026-10-26, after
`rm -rf node_modules && npm ci`, with Chromium from Playwright 1.63, the local
chain of lace-platform `compose/midnight.yml` (node 0.22.5, indexer 4.0.1) and
proof server 8.1.3:

- `npm run typecheck`, `npm test` (153/153), `npm run build`, `npm run test:e2e`
  (26/26, the three Worker-mode browser checks included, with the `530fa46dfa`
  signer build named above) and `npm run test:runtime:production` (1/1) passed;
  so did the key isolation check.
- The interrupted submit with the check at the SDK call
  (`--grep 'Interrupted submit'`, on a chain fresh from genesis): 2/2. On both
  servers every `submitMidnightTx` promise fulfilled, none rejected, and the
  interrupted one fulfilled with an `Err` holding
  `MidnightSubmitInterruptedError`.
- Every scenario on the local chain, on both servers (the command without
  `--grep`): 19 passed, and the Cardano route was skipped on the development
  server, as designed. That includes the three two-tab scenarios on both servers
  (one worker, 3 open indexer subscriptions with one tab and with two; the
  settings conflict, then adopt; the shared reset, then `MidnightStaleTxError`
  for the other tab's earlier transfer), the interrupted submit on both servers
  (`interrupted`, the Pending row kept, the indexer listing the control once and
  the interrupted transaction not at all after five more blocks, an empty pool,
  one submission counted from just before the control), and the transfer on the
  local chain.
- The transfer on Preview: 6/6, three runs of the command above, each on both
  servers. Each time the worker, not the page, reached the node, the indexer and
  the proof server; the scratch field echoed what was typed while the engine
  synced; the worker sent one submission; the SDK returned the `txId` at
  finality and history listed the hash as `Self`. Sync from empty memory storage
  took 9.5 to 10.2 minutes, the transfer 22 to 28 seconds. Activity hashes: dev
  `3a1627e9…136c`, `1ee0722f…2147`, `fe3550ba…0976`; production preview
  `d9863a1c…862f`, `66c23fee…b955`, `f282c7c7…98a8`. The production build's
  Cardano route loaded each time.

With `961ef2c2fa` (`8c7d6414…e1bb`), on 2026-10-26:

- The same existing checks passed (`npm test` 151/151), and so did every
  scenario on the local chain on both servers, the three two-tab scenarios
  included. The interrupted submit also passed 2/2 alone on a chain fresh from
  genesis, where the development server's run registered the wallet's NIGHT for
  DUST first.
- The transfer on Preview stopped after run 1 of 3. The production preview
  passed (`125bdd4f…c706`). On the development server the SDK's submission
  returned an error with no code and an empty message (the issue above, fixed in
  `3ce36fb837`); the page recorded the outcome as uncertain, history did not
  list the hash within 15 minutes, and the indexer did not list it 44 minutes
  after the submission (`762e35e8…5d4b`). Why that submission failed is not
  known.

With the previous build (`8edaefc6…4b1a`), on 2026-10-25:

- The same existing checks passed, and the interrupted submit passed 2/2 on the
  local chain.
- The tab and other scenarios on the local chain: on the production preview
  7/7; on the development server 4/7, the three two-tab scenarios failing with
  the SDK issue that `961ef2c2fa` fixed (a second engine for the second tab: no
  shared engine, no settings conflict, no shared reset).
- The transfer on Preview: 6/6, three runs of the command above, each on both
  servers. Each time the worker, not the page, reached the node, the indexer and
  the proof server; the scratch field echoed what was typed while the engine
  synced; the worker sent one submission; the SDK returned the `txId` at
  finality and history listed the hash as `Self`. Sync from empty memory storage
  took 10 to 15 minutes, the transfer 22 to 28 seconds. Activity hashes: dev
  `23c8435f…cace`, `d8cf39a4…d3de`, `fc088c42…1399`; production preview
  `4fcdd404…498d`, `2fdd62ab…6a2f`, `ebd23e30…e505`. The production build's
  Cardano route loaded each time.

### Capabilities and validation limits

All 18 public surfaces below are available in the installed package. Local tests
cover contracts and synthetic failure cases; they do not establish live success.
Prior checks reported type checks, 128 unit tests, production build, 18 browser
tests and production address-codec probes passing. A later focused check reported
32 tests passing, including rejection of a valid signature from the wrong account.
Those checks are separate from the incomplete live validation below.

| Capability / public access | Local coverage | Live observations and remaining validation |
|---|---|---|
| Restore/index: `createInMemoryWalletEntity`, `createMidnightAccounts` | Startup, indices, passkey | Indexed Preview restoration and deterministic nonzero index observed without spending. |
| Networks: `selectMidnightNetwork`, config/selectors | Supported, missing and unsafe configuration | Preview endpoints observed; other networks and switching unrun. |
| Addresses/keys: `addresses.selectByAccountId$`, `selectPublicKeysByAccountId$` | Address kinds, decoded keys, account selection | Three addresses observed; full per-account decoded-key comparison unrun. |
| Tokens/DUST: token selectors, `observeMidnightBalances`, DUST selectors | Pending, absent and generation fields | NIGHT 5000000000 smallest units and positive generated/spendable DUST observed; generation-field checks incomplete. Non-native/shielded funding absent. |
| Sync: `sync.selectSyncStatusByAccount$`, balance `synced` flags | Strict states and failures | Full sync observed; disconnect/failure variants incomplete. Rounded progress is insufficient. |
| History/details: `activities.selectByAccountId$`, `loadActivityDetails`, `selectActivityDetails$` | Mapping and reconciliation | Confirmed own registration details and fee observed. Other send/receive/failure fixtures unrun; shielded-only rows omitted. |
| Transfers/batches: `buildMidnightTransfers` | Outputs, empty/mixed batches, network, amounts, funds | Local 8.1.3 self-transfer confirmed on chain (`02139e2c…2adace`, block 1294134); that run's page did not report it (fixed since). Temenos one-unit self-transfers reached panel/history confirmation on 2026-10-16 with build `c19ed1f0ed` (`c5a4931b…63048c`) and the merged build `75c3de4267` (`4a9c4ce2…33c9a8`, second attempt); identifiers above. Multi-recipient/token and shielded runs need services and funding. |
| DUST designation: `registerMidnightDust` | Eligibility, fees, no NIGHT, network, repeat | Own registration proved, submitted and confirmed. External destination and repeat/fee variants unrun; do not repeat completed registration. |
| Unsigned fee: `estimateMidnightFee` | No signing, fee branches, insufficient DUST | Independent non-proving check incomplete; the fee a confirmed transfer consumed is not verified. |
| Stages: `signMidnightTx`, `proveMidnightTx`, `submitMidnightTx` | Failures, timeouts, consumer consent, in-flight submission and history reconciliation | Registration stages confirmed. The earlier local transfer confirmed on chain while the page lost the identifier (cause unestablished). The 2026-10-16 Temenos runs observed page/history confirmation and SDK return for the exact activity hash. Transfer balance and fee consumption remain unverified. |
| Progress: `proveMidnightTx.onProgress` | Actual events, concurrency, timeout | Registration completion and local transfer Proved observed. Concurrent live progress/timeout behavior unrun. |
| Prover/TEE: `createAttestedProver`, config selectors | Routing, trust, refusal, cleanup | Five-phase browser attestation and encrypted proving succeeded on the aligned Preview deployment with verifier 0.3.0 on 2026-10-16 for both builds; transfers confirmed, no fallback. One attempt on the merged build received upstream HTTP 404/400 from the encrypted proxy and passed when run again; the earlier HTTP400 is historical evidence. On Preview, on 2026-10-30 with a local build of `26afd3d2ea` and on 2026-11-04 with the npm canary `0.1.2-canary.3`, the preflight and one transfer proved through Temenos passed on the first attempt. Local 8.1.3 proving and a confirmed submission also observed. |
| Resync: `midnightContext.resetSyncState` | Stop/delete/restart and failure isolation | On Preview, on 2026-10-30 with a local build of `26afd3d2ea` and on 2026-11-04 with the npm canary `0.1.2-canary.3`, in page mode and in Worker mode, a completed reset freed the NIGHT and the DUST that a built transfer reserved. Shielded coins were not reserved in that check. Other-account survival unrun. In-memory storage does not validate persisted adapters. |
| Names: validators, `tokens.upsertTokenMetadata` | Rules and metadata preservation | Live native rename refusal incomplete; non-native rename/sync persistence needs a funded token/metadata fixture. |
| Connector: sealed/unsealed balance, `makeMidnightTransfer`, `makeMidnightIntent` | Binding, mixed assets, fee opt-out, conditional signing | Real sealed/unsealed/intent fixtures and funded mixed assets absent. Helpers may sign/prove; excluded from non-proving checks. `intentId` ignored. |
| Message signing: `signMidnightData` | Byte domain, signatures, account/options/errors, consent | Live text/hex/base64 verification, account-key binding and cancellation checks incomplete. |
| Circuits/submission: `getMidnightProvingProvider`, `submitMidnightTx` | Key binding, routing, pending reconciliation | Real preimage/ZKIR/prover/verifier material and connector transaction fixtures absent; Temenos check unsupported. |
| Instance isolation: SDK resolution/teardown | Same-ID providers, stop/reset/switch, lifecycle | Same-page instances with identical account IDs remained isolated across stop. Reset/network-switch live isolation unrun; one-instance checks cannot establish it. |

### Remaining prerequisites

- **Local transfer follow-up:** the local 8.1.3 transfer is confirmed on chain;
  its balance change and fee consumption remain unverified. The corrected
  submission reporting was observed in the 2026-10-16 Temenos live runs.
- **Temenos scope:** the aligned Preview/verifier 0.3.0 self-transfer is confirmed on
  the merged SDK build `75c3de4267`. This does not validate other deployments or
  shielded/batch transfers, and does not establish the cause of the upstream HTTP
  400/404 responses (historical, and once on 2026-10-16 before a passing run).
- **Funding/fixtures:** shielded and non-native assets, recipient/token batches,
  an external DUST destination with NIGHT and no generation capacity, connector
  sealed/unsealed transactions, intent/mixed fee-opt-out inputs and real circuit
  preimage/ZKIR/prover/verifier keys. Synthetic tests cannot establish these live results.
- **State cases:** other-account reset survival, network switching/isolation,
  supported networks unavailable on Preview, failure/disconnect history/sync
  variants and persisted storage validation remain unrun or incomplete.

Live restoration/isolation checks can be selected without transaction opt-ins:

```bash
unset MIDNIGHT_LIVE_REGISTER MIDNIGHT_LIVE_TRANSFER
MIDNIGHT_LIVE=preview MIDNIGHT_TEST_WALLET_FILE=/private/path/disposable-wallet.json \
  npm run test:midnight:live -- tests/live/midnight.live.spec.ts
```

Live failure, timeout, missing prerequisites and unrun checks remain distinct.
The observations above do not establish an overall live pass.
