const out = document.getElementById("out")!;
const stateOutput = document.getElementById("state-output")!;
const addressEl = document.getElementById("address-output")!;
const balanceEl = document.getElementById("balance-output")!;
const tokensEl = document.getElementById("tokens-output")!;
const createBtn = document.getElementById("create-passkey") as HTMLButtonElement;
const openBtn = document.getElementById("open-passkey") as HTMLButtonElement;
const buildTxBtn = document.getElementById("build-tx") as HTMLButtonElement;
const signTxBtn = document.getElementById("sign-tx") as HTMLButtonElement;
const submitTxBtn = document.getElementById("submit-tx") as HTMLButtonElement;
const txOutputEl = document.getElementById("tx-output")!;
const reviewEl = document.getElementById("tx-review")!;
const reviewCheck = document.getElementById("review-confirm") as HTMLInputElement;
const recipientInput = document.getElementById("recipient") as HTMLInputElement;
const amountInput = document.getElementById("amount") as HTMLInputElement;
const custodyRecipientBtn = document.getElementById("use-custody-recipient") as HTMLButtonElement;
let custodyAddress: string | undefined;

export const ui = {
  setStatus(text: string) {
    out.textContent = text;
  },

  appendStatus(text: string) {
    out.textContent += text;
  },

  showStateOutput() {
    stateOutput.style.display = "block";
  },

  updateState(state: unknown) {
    stateOutput.textContent = JSON.stringify(state, null, 2);
  },

  updateAddress(address: string | null) {
    addressEl.textContent = address
      ? `Address: ${address}`
      : "No addresses yet";
  },

  updateBalance(balance: { lovelace: bigint; utxoCount: number } | null) {
    balanceEl.textContent = balance
      ? `Spendable: ${balance.lovelace / 1_000_000n}.${(balance.lovelace % 1_000_000n).toString().padStart(6, "0")} ADA in ${balance.utxoCount} UTxO(s)`
      : "";
  },

  updateTokens(accountTokens: { count: number; json: string } | null) {
    tokensEl.textContent = accountTokens
      ? `Tokens (${accountTokens.count}):\n${accountTokens.json}`
      : "No tokens yet";
  },

  setWalletMode(canCreate: boolean) {
    createBtn.hidden = !canCreate;
    openBtn.hidden = false;
  },

  onCreateClick(handler: () => Promise<void>) {
    createBtn.addEventListener("click", async () => {
      createBtn.disabled = true;
      try {
        await handler();
      } catch (err) {
        console.error("Passkey create failed:", err);
        ui.appendStatus(`\n\nCreate error: ${err}`);
      } finally {
        createBtn.disabled = false;
      }
    });
  },

  onOpenClick(handler: () => Promise<void>) {
    openBtn.addEventListener("click", async () => {
      openBtn.disabled = true;
      try {
        await handler();
      } catch (err) {
        console.error("Passkey open failed:", err);
        ui.appendStatus(`\n\nOpen error: ${err}`);
      } finally {
        openBtn.disabled = false;
      }
    });
  },

  enableBuildTx() {
    buildTxBtn.disabled = false;
  },

  onBuildTxClick(handler: () => Promise<void>) {
    buildTxBtn.addEventListener("click", async () => {
      try {
        await handler();
      } catch (err) {
        console.error("Build tx failed:", err);
        txOutputEl.textContent = `Error: ${err}`;
      }
    });
  },

  enableSignTx() {
    signTxBtn.disabled = !reviewCheck.checked;
  },

  setRecipient(address: string) {
    recipientInput.value = address;
  },

  recipient() {
    return recipientInput.value.trim();
  },

  amount() {
    return amountInput.value;
  },

  enableCustodyRecipient(address: string) {
    custodyAddress = address;
    custodyRecipientBtn.disabled = false;
  },

  showTxReview(details: { recipient: string; amount: string; changeAddress: string; inputCount: number; fee: string; note?: string }) {
    reviewEl.hidden = false;
    reviewEl.textContent = `Review Preprod transaction before passkey signing:\nRecipient: ${details.recipient}\nAmount: ${details.amount}\nChange: ${details.changeAddress}\nSelected inputs: ${details.inputCount}\nFee: ${details.fee}\n${details.note ? `${details.note}\n` : ""}Check the transaction CBOR below before approval.`;
    reviewCheck.checked = false;
    signTxBtn.disabled = true;
    submitTxBtn.disabled = true;
  },

  isTxReviewed() {
    return !reviewEl.hidden && reviewCheck.checked;
  },

  onSignTxClick(handler: () => Promise<void>) {
    signTxBtn.addEventListener("click", async () => {
      signTxBtn.disabled = true;
      signTxBtn.textContent = "Signing...";
      try {
        await handler();
      } catch (err) {
        console.error("Sign tx failed:", err);
        txOutputEl.textContent = `Error: ${err}`;
      } finally {
        signTxBtn.disabled = false;
        signTxBtn.textContent = "Sign Transaction";
      }
    });
  },

  enableSubmitTx() {
    submitTxBtn.disabled = false;
  },

  disableSubmitTx() {
    submitTxBtn.disabled = true;
  },

  onSubmitTxClick(handler: () => Promise<void>) {
    submitTxBtn.addEventListener("click", async () => {
      submitTxBtn.disabled = true;
      submitTxBtn.textContent = "Submitting...";
      try {
        await handler();
      } catch (err) {
        console.error("Submit tx failed:", err);
        txOutputEl.textContent = `Error: ${err}`;
      } finally {
        submitTxBtn.disabled = false;
        submitTxBtn.textContent = "Submit Transaction";
      }
    });
  },

  updateTxOutput(cbor: string) {
    txOutputEl.textContent = `Transaction CBOR:\n${cbor}`;
  },
};

custodyRecipientBtn.addEventListener("click", () => {
  if (custodyAddress) recipientInput.value = custodyAddress;
});

reviewCheck.addEventListener("change", () => {
  signTxBtn.disabled = !reviewCheck.checked;
});
