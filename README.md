# lace-sdk-consumer

Minimal example app demonstrating [@input-output-hk/lace-sdk](https://github.com/input-output-hk/lace-platform/tree/main/apps/lace-sdk) with Web3Auth social login and a headless Cardano wallet.

## Setup

```bash
npm install
cp .env.example .env
# Fill in your credentials (see below)
npm run dev
```

## Environment Variables

```bash
VITE_BLOCKFROST_PROJECT_ID_PREPROD=   # Blockfrost project ID for Cardano Preprod
VITE_BLOCKFROST_PROJECT_ID_PREVIEW=   # Blockfrost project ID for Cardano Preview
VITE_BLOCKFROST_PROJECT_ID_MAINNET=   # Blockfrost project ID for Cardano Mainnet
VITE_WEB3AUTH_CLIENT_ID=              # Web3Auth application client ID
```

Get Blockfrost project IDs at [blockfrost.io](https://blockfrost.io/) and a Web3Auth client ID at [dashboard.web3auth.io](https://dashboard.web3auth.io/).

## File Structure

```
src/
  bootstrap.ts   Buffer polyfill (must run before any Web3Auth imports), then lazy-imports main
  config.ts      Feature flags and Blockfrost provider configuration
  web3auth.ts    Web3Auth provider setup via createWebWeb3AuthProvider
  main.ts        Creates headless wallet, subscribes to state observables, handles login flow
  ui.ts          DOM helpers (not SDK-specific)
```

## How It Works

1. **Bootstrap** (`bootstrap.ts`) — sets the global `Buffer` polyfill required by Web3Auth's `eccrypto` dependency, then dynamically imports the app
2. **Config** (`config.ts`) — defines feature flags (`FEATURE_FLAG_CARDANO`, `FEATURE_FLAG_NETWORK_TYPE`) and Blockfrost provider settings per Cardano network
3. **Wallet init** (`main.ts`) — calls `createLaceWallet` with modules (`featureDev`, `storageInMemory`, `blockchainCardano`, `cardanoProviderBlockfrost`, `cryptoCardanoSdk`) and subscribes to `stateObservables` for addresses and tokens
4. **Login** (`main.ts`) — on button click, authenticates via Web3Auth, derives a BIP39 mnemonic with `deriveMnemonicFromKeyMaterial`, creates a wallet entity with `createInMemoryWalletEntity`, and dispatches it into the store

## Vite Config

The `buffer` alias is required because `@cardano-sdk` internals use `require('buffer')`:

```typescript
// vite.config.ts
export default defineConfig({
  resolve: { alias: { buffer: "buffer/" } },
  optimizeDeps: { include: ["buffer"] },
});
```

## Build

```bash
npm run build
npm run preview
```
