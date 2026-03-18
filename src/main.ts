import {
  createLaceWallet,
  createInMemoryWalletEntity,
  deriveMnemonicFromKeyMaterial,
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
import { getKeyMaterial } from "./web3auth";

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

// --- Web3Auth login ---
ui.onLoginClick(async () => {
  const keyMaterial = await getKeyMaterial();
  const { mnemonicWords, userId } = deriveMnemonicFromKeyMaterial(keyMaterial);
  ui.appendStatus(
    `\n\nLogin OK: userId="${userId}", ${mnemonicWords.length} words`
  );

  // Create an in-memory wallet entity from the mnemonic
  ui.appendStatus("\n\nCreating wallet entity...");
  const password = new Uint8Array(Buffer.from("password"));
  const walletEntity = await createInMemoryWalletEntity(wallet, {
    mnemonicWords,
    password,
    walletName: `Web3Auth ${userId}`,
  });

  // Dispatch it into the store
  wallet.dispatch("wallets.addWallet", walletEntity);
  ui.appendStatus(`\nWallet added! walletId=${walletEntity.walletId}`);
});
