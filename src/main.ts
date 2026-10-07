import {
  createLaceWallet,
  createTxBuilder,
  signCardanoTx,
  submitCardanoTx,
  waitForNetworkInfo,
  Cardano,
  HexBytes,
  m,
  createRemotePasskeyWalletEntity,
  type AccountId,
} from "@input-output-hk/lace-sdk/cardano";
import { config, featureFlags } from "./config";
import { ui } from "./ui";
import { bindingKey, readBinding } from "./binding";
import { signer, signerUrl, withSigner } from "./signer";
import { parseAdaAmount, selectAccountAddress, selectAccountUtxos } from "./accounts";
import { startCustody } from "./custody/custody-app";

let savedBinding: ReturnType<typeof readBinding>;
try {
  savedBinding = readBinding(localStorage, signerUrl);
} catch (error) {
  ui.setStatus(String(error));
  throw error;
}
let networkReady = false;

// --- Create headless wallet ---
ui.setStatus("Creating wallet...");

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

// The wallet holds the passkey account and, once created or opened, a
// custody account. Every read below selects the passkey account by id.
let ordinaryAccountId: AccountId | undefined;

function addPreprodWallet(entity: Awaited<ReturnType<typeof createRemotePasskeyWalletEntity>>["entity"]) {
  // SDK excludes mainnet, but can still include Preview. Restrict the
  // in-memory wallet to configured Preprod before selecting an active account.
  const accounts = entity.accounts.filter((account) => account.blockchainName === "Cardano" && account.blockchainNetworkId === "cardano-1");
  if (accounts.length !== 1) throw new Error("Expected exactly one Cardano Preprod account");
  wallet.dispatch("wallets.addWallet", { ...entity, accounts });
  return accounts[0].accountId;
}

ui.setStatus(`Lace initialized. Signer: ${new URL(signerUrl).origin}`);
ui.setWalletMode(savedBinding === null);
ui.showStateOutput();
setInterval(() => {
  ui.updateState(wallet.getState());
}, 200);

// --- Passkey account address, UTxOs and tokens ---
const RECIPIENT = Cardano.PaymentAddress(
  "addr_test1qzkwnu5y0djlptw3t38v6njkzaaq6mdnn7r97zkxhu2ypy6e8l75l0avdum8zp0cycd9785nhjtmntmj22l934ptjehqm3kj5s"
);
ui.setRecipient(RECIPIENT);

let allAddresses: Parameters<typeof selectAccountAddress>[0] = [];
let utxosByAccount: Parameters<typeof selectAccountUtxos>[0] = {};
let latestAddress: Cardano.PaymentAddress | undefined;
let latestUtxos: Cardano.Utxo[] = [];

function refreshOrdinaryAccount() {
  const address = selectAccountAddress(allAddresses, ordinaryAccountId);
  latestAddress = address ? Cardano.PaymentAddress(address) : undefined;
  latestUtxos = selectAccountUtxos(utxosByAccount, ordinaryAccountId);
  ui.updateAddress(latestAddress ?? null);
  ui.updateBalance(
    ordinaryAccountId
      ? { lovelace: latestUtxos.reduce((total, [, output]) => total + BigInt(output.value.coins), 0n), utxoCount: latestUtxos.length }
      : null,
  );
}

wallet.stateObservables.addresses.selectAllAddresses$.subscribe((addresses) => {
  allAddresses = addresses;
  refreshOrdinaryAccount();
});

wallet.stateObservables.cardanoContext.selectAvailableAccountUtxos$.subscribe((utxos) => {
  utxosByAccount = utxos;
  refreshOrdinaryAccount();
});

wallet.stateObservables.tokens.selectTokensGroupedByAccount$.subscribe((tokensByAccount) => {
  const tokens = ordinaryAccountId ? tokensByAccount[ordinaryAccountId] : undefined;
  const all = tokens ? [...tokens.fungible, ...tokens.nfts] : [];
  ui.updateTokens(all.length > 0 ? { count: all.length, json: JSON.stringify(all, null, 2) } : null);
});

// --- Build, sign and submit an ordinary transfer ---
let lastBuiltTxCbor: string | undefined;
let lastSignedTxCbor: string | undefined;

ui.onBuildTxClick(async () => {
  if (!ordinaryAccountId) throw new Error("Open the saved passkey wallet first");
  const builder = createTxBuilder(wallet).unwrap();

  if (!latestAddress) {
    ui.appendStatus("\n\nNo address available — log in first");
    return;
  }
  const recipient = Cardano.PaymentAddress(ui.recipient());
  const coins = parseAdaAmount(ui.amount());

  const tx = builder
    .setChangeAddress(latestAddress)
    .setUnspentOutputs(latestUtxos)
    .transferValue(recipient, { coins })
    .expiresIn(900)
    .build();

  const builtTx = await tx;
  lastBuiltTxCbor = builtTx.toCbor();
  lastSignedTxCbor = undefined;
  ui.updateTxOutput(builtTx.toCbor());
  const body = builtTx.body().toCore();
  ui.showTxReview({
    recipient,
    amount: `${ui.amount()} ADA`,
    changeAddress: latestAddress,
    inputCount: body.inputs.length,
    fee: `${Number(body.fee) / 1_000_000} ADA`,
    note: recipient === custody.address() ? "The recipient is this app's Cardano custody account: a deposit." : undefined,
  });
  ui.enableSignTx();
});

ui.onSignTxClick(async () => {
  if (!lastBuiltTxCbor) {
    ui.appendStatus("\n\nNo transaction to sign — build one first");
    return;
  }
  if (!ordinaryAccountId || !ui.isTxReviewed()) throw new Error("Review the transaction before signing");

  ui.appendStatus("\n\nSigning transaction...");
  lastSignedTxCbor = undefined;
  ui.disableSubmitTx();
  const serializedTx = HexBytes(lastBuiltTxCbor);
  const accountId = ordinaryAccountId;
  const result = await withSigner(() => signCardanoTx(wallet, { serializedTx, accountId }));

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
  if (ordinaryAccountId) ui.enableBuildTx();
}).catch((error) => ui.appendStatus(`\nNetwork info failed: ${error}`));

async function openWallet(create: boolean): Promise<void> {
  if (ordinaryAccountId) throw new Error("Wallet is already open");
  const binding = readBinding(localStorage, signerUrl);
  if (create && binding) throw new Error("A wallet is already bound here. Open it instead.");
  const { entity, publicKey } = await withSigner(() => createRemotePasskeyWalletEntity({
    signer,
    walletName: "Passkey Preprod",
    expectedPublicKey: binding ?? undefined,
  }));
  if (!binding) localStorage.setItem(bindingKey(signerUrl), JSON.stringify(publicKey));
  ordinaryAccountId = addPreprodWallet(entity);
  refreshOrdinaryAccount();
  ui.setWalletMode(false);
  if (networkReady) ui.enableBuildTx();
  ui.appendStatus(`\nPasskey wallet ${create ? "created/connected" : "opened"}. walletId=${entity.walletId}`);
}

ui.onCreateClick(() => openWallet(true));
ui.onOpenClick(() => openWallet(false));

const custody = startCustody({ wallet, onCustodyAddress: (address) => ui.enableCustodyRecipient(address) });
