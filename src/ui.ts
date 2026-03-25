const out = document.getElementById("out")!;
const stateOutput = document.getElementById("state-output")!;
const addressEl = document.getElementById("address-output")!;
const tokensEl = document.getElementById("tokens-output")!;
const loginBtn = document.getElementById("web3auth-login") as HTMLButtonElement;
const buildTxBtn = document.getElementById("build-tx") as HTMLButtonElement;
const signTxBtn = document.getElementById("sign-tx") as HTMLButtonElement;
const submitTxBtn = document.getElementById("submit-tx") as HTMLButtonElement;
const txOutputEl = document.getElementById("tx-output")!;

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

  updateTokens(accountTokens: { count: number; json: string } | null) {
    tokensEl.textContent = accountTokens
      ? `Tokens (${accountTokens.count}):\n${accountTokens.json}`
      : "No tokens yet";
  },

  onLoginClick(handler: () => Promise<void>) {
    loginBtn.addEventListener("click", async () => {
      loginBtn.disabled = true;
      loginBtn.textContent = "Logging in...";
      try {
        await handler();
      } catch (err) {
        console.error("Login failed:", err);
        ui.appendStatus(`\n\nLogin error: ${err}`);
      } finally {
        loginBtn.disabled = false;
        loginBtn.textContent = "Login";
      }
    });
  },

  enableBuildTx() {
    buildTxBtn.disabled = false;
  },

  onBuildTxClick(handler: () => void) {
    buildTxBtn.addEventListener("click", () => {
      try {
        handler();
      } catch (err) {
        console.error("Build tx failed:", err);
        txOutputEl.textContent = `Error: ${err}`;
      }
    });
  },

  enableSignTx() {
    signTxBtn.disabled = false;
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
