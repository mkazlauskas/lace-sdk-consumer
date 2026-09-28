import { createPasskeyKeySource } from "@input-output-hk/lace-sdk/cardano";

document.getElementById("probe")!.addEventListener("click", async () => {
  const result = document.getElementById("result")!;
  try {
    const keySource = createPasskeyKeySource({ rpId: "localhost", rpName: "PRF test probe" });
    const ref = await keySource.ensureCredential();
    const valid = await keySource.withPasskeyMnemonic(async (words) => words.length === 24);
    result.textContent = valid && ref.credentialId ? "PRF supported" : "PRF invalid";
  } catch (error) {
    result.textContent = String(error);
  }
});
