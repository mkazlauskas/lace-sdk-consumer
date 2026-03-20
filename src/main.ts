import {
  createLaceWallet,
  createInMemoryWalletEntity,
  createTxBuilder,
  waitForNetworkInfo,
  Mnemonic,
  Cardano,
} from "@input-output-hk/lace-sdk";
import {
  blockchainCardano,
  cardanoProviderBlockfrost,
  featureDev,
  storageInMemory,
  cryptoCardanoSdk,
} from "@input-output-hk/lace-sdk/modules";
import { config, featureFlags } from "./config";
import { ui } from "./ui";
import { login } from "./web3auth";

// --- Create headless wallet ---
ui.setStatus("Creating wallet...");

const wallet = await createLaceWallet({
  modules: [
    featureDev,
    storageInMemory,
    blockchainCardano,
    cardanoProviderBlockfrost,
    cryptoCardanoSdk,
  ] as const,
  environment: "development",
  featureFlags,
  config,
});

ui.setStatus("Lace initialized");
ui.showStateOutput();
setInterval(() => {
  ui.updateState(wallet.getState());
}, 200);

// --- Subscribe to addresses ---
wallet.stateObservables.addresses.selectAllAddresses$.subscribe((addresses) => {
  const first = addresses[0];
  ui.updateAddress(first ? first.address : null);
});

// --- Subscribe to tokens ---
wallet.stateObservables.tokens.selectAllTokens$.subscribe((tokens) => {
  ui.updateTokens(
    tokens.length > 0
      ? { count: tokens.length, json: JSON.stringify(tokens, null, 2) }
      : null
  );
});

// --- Build Transaction ---
const RECIPIENT = Cardano.PaymentAddress(
  "addr_test1qzkwnu5y0djlptw3t38v6njkzaaq6mdnn7r97zkxhu2ypy6e8l75l0avdum8zp0cycd9785nhjtmntmj22l934ptjehqm3kj5s"
);

// Track the latest address and UTXOs reactively
let latestAddress: Cardano.PaymentAddress | undefined;
let latestUtxos: Cardano.Utxo[] = [];

wallet.stateObservables.addresses.selectAllAddresses$.subscribe((addresses) => {
  const first = addresses[0];
  latestAddress = first ? Cardano.PaymentAddress(first.address) : undefined;
});

wallet.stateObservables.cardanoContext.selectAvailableAccountUtxos$.subscribe(
  (utxosByAccount) => {
    latestUtxos = Object.values(utxosByAccount).flat();
  }
);

ui.onBuildTxClick(() => {
  const builder = createTxBuilder(wallet).unwrap();

  if (!latestAddress) {
    ui.appendStatus("\n\nNo address available — log in first");
    return;
  }

  const tx = builder
    .setChangeAddress(latestAddress)
    .setUnspentOutputs(latestUtxos)
    .transferValue(RECIPIENT, { coins: 1_230_000n })
    .expiresIn(900)
    .build();

  ui.updateTxOutput(tx.toCbor());
});

// Enable button once network info is ready
waitForNetworkInfo(wallet).then(() => ui.enableBuildTx());

// --- Web3Auth login ---
ui.onLoginClick(async () => {
  const { entropyHex, userId } = await login();
  const mnemonicWords = Mnemonic.deriveFrom(entropyHex);
  ui.appendStatus(
    `\n\nLogin OK: userId="${userId}", ${mnemonicWords.length} words`
  );

  // Create an in-memory wallet entity from the mnemonic
  ui.appendStatus("\n\nCreating wallet entity...");
  const password = new Uint8Array(Buffer.from("password"));
  const walletEntity = await createInMemoryWalletEntity(wallet, {
    mnemonicWords: [...mnemonicWords],
    password,
    walletName: `Web3Auth ${userId}`,
  });

  // Dispatch it into the store
  wallet.dispatch("wallets.addWallet", walletEntity);
  ui.appendStatus(`\nWallet added! walletId=${walletEntity.walletId}`);
});
