import {
  createLaceWallet,
  createTxBuilder,
  signCardanoTx,
  submitCardanoTx,
  waitForNetworkInfo,
  Cardano,
  HexBytes,
  m,
  createPasskeyKeySource,
  createPasskeyVaultModule,
  createPasskeyWalletEntity,
} from "@input-output-hk/lace-sdk/cardano";
import { config, featureFlags } from "./config";
import { ui } from "./ui";
import { BINDING_KEY, readBinding } from "./binding";

if (location.protocol !== "http:" || location.hostname !== "localhost") {
  throw new Error("This passkey wallet requires http://localhost (RP ID localhost)");
}
let savedBinding: ReturnType<typeof readBinding>;
try {
  savedBinding = readBinding(localStorage);
} catch (error) {
  ui.setStatus(String(error));
  throw error;
}
let walletOpen = false;
let networkReady = false;

// --- Create headless wallet ---
ui.setStatus("Creating wallet...");

const keySource = createPasskeyKeySource({
  rpId: "localhost",
  rpName: "Lace SDK consumer",
  credentialId: savedBinding?.credentialId,
});
const wallet = await createLaceWallet({
  modules: [
    m.featureDev,
    m.storageInMemory,
    m.blockchainCardano,
    m.cardanoProviderBlockfrost,
    m.cryptoCardanoSdk,
    createPasskeyVaultModule({ keySource }),
  ] as const,
  environment: "development",
  featureFlags,
  config,
});

function addPreprodWallet(entity: Awaited<ReturnType<typeof createPasskeyWalletEntity>>["entity"]) {
  // SDK excludes mainnet, but can still include Preview. Restrict the
  // in-memory wallet to configured Preprod before selecting an active account.
  const accounts = entity.accounts.filter((account) => account.blockchainName === "Cardano" && account.blockchainNetworkId === "cardano-1");
  if (accounts.length !== 1) throw new Error("Expected exactly one Cardano Preprod account");
  wallet.dispatch("wallets.addWallet", { ...entity, accounts });
}

ui.setStatus("Lace initialized");
ui.setWalletMode(savedBinding === null);
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

let lastBuiltTxCbor: string | undefined;
let lastSignedTxCbor: string | undefined;

ui.onBuildTxClick(async () => {
  if (!walletOpen) throw new Error("Open the saved passkey wallet first");
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

  const builtTx = await tx;
  lastBuiltTxCbor = builtTx.toCbor();
  lastSignedTxCbor = undefined;
  ui.updateTxOutput(builtTx.toCbor());
  const body = builtTx.body().toCore();
  ui.showTxReview({
    recipient: RECIPIENT,
    amount: "1.23 ADA",
    changeAddress: latestAddress,
    inputCount: body.inputs.length,
    fee: `${Number(body.fee) / 1_000_000} ADA`,
  });
  ui.enableSignTx();
});

ui.onSignTxClick(async () => {
  if (!lastBuiltTxCbor) {
    ui.appendStatus("\n\nNo transaction to sign — build one first");
    return;
  }
  if (!walletOpen || !ui.isTxReviewed()) throw new Error("Review the transaction before signing");

  ui.appendStatus("\n\nSigning transaction...");
  const result = await signCardanoTx(wallet, {
    serializedTx: HexBytes(lastBuiltTxCbor),
  });

  if (result.isOk()) {
    lastSignedTxCbor = result.value.serializedTx;
    ui.appendStatus(`\nSigned! (${result.value.signatureCount} signature(s))`);
    ui.updateTxOutput(result.value.serializedTx);
    ui.enableSubmitTx();
  } else {
    ui.appendStatus(`\nSigning failed: ${result.error.message}`);
  }
});

ui.onSubmitTxClick(async () => {
  if (!lastSignedTxCbor) {
    ui.appendStatus("\n\nNo signed transaction to submit — sign one first");
    return;
  }

  ui.appendStatus("\n\nSubmitting transaction...");
  const result = await submitCardanoTx(wallet, {
    serializedTx: HexBytes(lastSignedTxCbor),
  });

  if (result.isOk()) {
    ui.appendStatus(`\nSubmitted! txId=${result.value.txId}`);
  } else {
    ui.appendStatus(`\nSubmission failed: ${result.error.message}`);
  }
});

// Enable button once network info is ready
waitForNetworkInfo(wallet).then(() => {
  networkReady = true;
  if (walletOpen) ui.enableBuildTx();
}).catch((error) => ui.appendStatus(`\nNetwork info failed: ${error}`));

ui.onCreateClick(async () => {
  if (readBinding(localStorage)) throw new Error("A wallet is already bound here. Open it instead.");
  // Registration and the first PRF assertion are separate browser prompts.
  await keySource.ensureCredential();
  const { entity, binding } = await createPasskeyWalletEntity(wallet, {
    keySource,
    walletName: "Passkey Preprod",
  });
  localStorage.setItem(BINDING_KEY, JSON.stringify(binding));
  addPreprodWallet(entity);
  walletOpen = true;
  ui.setWalletMode(false);
  if (networkReady) ui.enableBuildTx();
  ui.appendStatus(`\nPasskey wallet created. walletId=${entity.walletId}`);
});

ui.onOpenClick(async () => {
  if (walletOpen) throw new Error("Wallet is already open");
  const binding = readBinding(localStorage);
  // Explicit open can discover a synced credential after storage is cleared.
  // With a saved binding, the SDK pins the credential and checks its fingerprint.
  const { entity, binding: openedBinding } = await createPasskeyWalletEntity(wallet, {
    keySource,
    walletName: "Passkey Preprod",
    expectedBinding: binding ?? undefined,
  });
  addPreprodWallet(entity);
  if (!binding) localStorage.setItem(BINDING_KEY, JSON.stringify(openedBinding));
  walletOpen = true;
  if (networkReady) ui.enableBuildTx();
  ui.appendStatus(`\nPasskey wallet opened. walletId=${entity.walletId}`);
});
