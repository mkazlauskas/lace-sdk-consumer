# Lace SDK consumer: passkey wallet and Cardano custody account

Testnet-only Cardano Preprod demo of `@input-output-hk/lace-sdk/cardano`. It has two parts:

- A passkey wallet whose keys stay in the hosted Lace signer, `https://passkey-preview.lace.io`. No recovery phrase is shown or exported.
- A proof of concept of a Cardano custody account on custody contract revision 3. The hosted fee sponsor, `https://sponsor-preprod.lw.iog.io`, pays for the account's creation and lends collateral to every later transaction. The browser reaches the sponsor through a relay on the Vite server, which holds the sponsor key.

[HOSTED-SIGNER.md](HOSTED-SIGNER.md) describes both flows step by step, the tests and the verification evidence.

> **Warning:** The custody contract is unaudited. Use Preprod test ADA only.

## SDK package

The SDK is `@input-output-hk/lace-sdk@0.1.0-dev.12` from GitHub Packages. It was published from lace-platform `main` at `578670dc1941bee98e5b6814fe23b056a6e5fe70`, the merge of PR #2825. `package-lock.json` pins its integrity (`sha512-rqLHZ+DH/oXGpgiUhA51F4jsgCATp+4OBckY5yH4de5BQDTbwINtbsGGbtp3cqYMkYNUB+JiH6iqceQgzoS2Dw==`). Installing it needs read access to GitHub Packages:

- an `.npmrc`, yours or the project's (which git ignores), with `@input-output-hk:registry=https://npm.pkg.github.com`;
- a token that has `read:packages`.

Type checks, unit tests, the production build and the browser suite pass with this package.

## Start

1. Install:

   ```bash
   cd /home/mkazlauskas/Code/iog/lace-sdk-consumer
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
   npm test
   npm run build
   npm run dev -- --host localhost --port 5173 --strictPort
   ```

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
