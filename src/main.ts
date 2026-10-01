import {
  createLaceWallet,
  createTxBuilder,
  signCardanoTx,
  submitCardanoTx,
  waitForNetworkInfo,
  Cardano,
  HexBytes,
  m,
  createRemotePasskeySigner,
  createRemotePasskeyWalletEntity,
} from "@input-output-hk/lace-sdk/cardano";
import { config, featureFlags } from "./config";
import { ui } from "./ui";
import { bindingKey, readBinding } from "./binding";

const signerUrl = import.meta.env.VITE_PASSKEY_SIGNER_URL || "https://passkey-preview.lace.io";
if (new URL(signerUrl).protocol !== "https:") {
  throw new Error("The hosted passkey signer requires an HTTPS URL");
}
let savedBinding: ReturnType<typeof readBinding>;
try {
  savedBinding = readBinding(localStorage, signerUrl);
} catch (error) {
  ui.setStatus(String(error));
  throw error;
}
let walletOpen = false;
let networkReady = false;

// --- Create headless wallet ---
ui.setStatus("Creating wallet...");

const signer = createRemotePasskeySigner({ signerUrl });
let signerBusy = false;

// Open before the first await so the click retains browser user activation.
async function withSigner<T>(operation: () => Promise<T>): Promise<T> {
  if (signerBusy) throw new Error("Finish the current signer request first");
  signerBusy = true;
  let connectionTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    signer.open();
    await Promise.race([
      signer.connect(),
      new Promise<never>((_, reject) => {
        connectionTimeout = setTimeout(() => reject(new Error("Signer connection timed out. Check VITE_PASSKEY_SIGNER_URL and the hosted deployment.")), 20_000);
      }),
    ]);
    clearTimeout(connectionTimeout);
    return await operation();
  } finally {
    clearTimeout(connectionTimeout);
    signer.close();
    signerBusy = false;
  }
}
const wallet = await createLaceWallet({
  modules: [
    m.featureDev,
    m.storageInMemory,
    m.blockchainCardano,
    m.cardanoProviderBlockfrost,
    m.cryptoCardanoSdk,
    signer.cardanoVaultModule,
  ] as const,
  environment: "development",
  featureFlags,
  config,
});

function addPreprodWallet(entity: Awaited<ReturnType<typeof createRemotePasskeyWalletEntity>>["entity"]) {
  // SDK excludes mainnet, but can still include Preview. Restrict the
  // in-memory wallet to configured Preprod before selecting an active account.
  const accounts = entity.accounts.filter((account) => account.blockchainName === "Cardano" && account.blockchainNetworkId === "cardano-1");
  if (accounts.length !== 1) throw new Error("Expected exactly one Cardano Preprod account");
  wallet.dispatch("wallets.addWallet", { ...entity, accounts });
}

ui.setStatus(`Lace initialized. Signer: ${new URL(signerUrl).origin}`);
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
  lastSignedTxCbor = undefined;
  ui.disableSubmitTx();
  const serializedTx = HexBytes(lastBuiltTxCbor);
  const result = await withSigner(() => signCardanoTx(wallet, {
    serializedTx,
  }));

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

async function openWallet(create: boolean): Promise<void> {
  if (walletOpen) throw new Error("Wallet is already open");
  const binding = readBinding(localStorage, signerUrl);
  if (create && binding) throw new Error("A wallet is already bound here. Open it instead.");
  const { entity, publicKey } = await withSigner(() => createRemotePasskeyWalletEntity({
    signer,
    walletName: "Passkey Preprod",
    expectedPublicKey: binding ?? undefined,
  }));
  if (!binding) localStorage.setItem(bindingKey(signerUrl), JSON.stringify(publicKey));
  addPreprodWallet(entity);
  walletOpen = true;
  ui.setWalletMode(false);
  if (networkReady) ui.enableBuildTx();
  ui.appendStatus(`\nPasskey wallet ${create ? "created/connected" : "opened"}. walletId=${entity.walletId}`);
}

ui.onCreateClick(() => openWallet(true));
ui.onOpenClick(() => openWallet(false));
