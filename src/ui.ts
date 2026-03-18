const out = document.getElementById("out")!;
const stateOutput = document.getElementById("state-output")!;
const addressEl = document.getElementById("address-output")!;
const tokensEl = document.getElementById("tokens-output")!;
const loginBtn = document.getElementById(
  "web3auth-login"
) as HTMLButtonElement;

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
    addressEl.textContent = address ? `Address: ${address}` : "No addresses yet";
  },

  updateTokens(accountTokens: { count: number; json: string } | null) {
    tokensEl.textContent = accountTokens
      ? `Tokens (${accountTokens.count}):\n${accountTokens.json}`
      : "No accounts yet";
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
};
