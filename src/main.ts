import {
  BigNumber,
  Seconds,
  Minutes,
  TimeSpan,
  Milliseconds,
  assertModuleCompatibility,
} from "lace-sdk";

// Value objects
const amount = BigNumber(42n);
console.log("BigNumber:", amount, "→ bigint:", BigNumber.valueOf(amount));

// Time conversions
const secs = Seconds(90);
const mins = Seconds.toMinutes(secs);
console.log(`${secs} seconds = ${mins} minutes`);

// TimeSpan
const span = TimeSpan.fromMinutes(Minutes(125));
console.log(
  `125 min = ${span.getHours()}h ${span.getMinutes()}m → ISO: ${span.toString()}`
);

// assertModuleCompatibility (empty modules = no-op, verifies it's callable)
assertModuleCompatibility([]);
console.log("assertModuleCompatibility([]) OK");

// Render to page
const out = document.getElementById("out")!;
out.textContent = [
  `BigNumber(42n) = "${amount}"`,
  `BigNumber.valueOf("${amount}") = ${BigNumber.valueOf(amount)}`,
  `Seconds(90) → Minutes = ${mins}`,
  `TimeSpan 125min → ${span.toString()}`,
  `Milliseconds(1500) → Seconds = ${Milliseconds.toSeconds(
    Milliseconds(1500)
  )}`,
  "assertModuleCompatibility OK",
].join("\n");

// --- Web3Auth ---
import {
  deriveMnemonicFromKeyMaterial,
  createWebWeb3AuthProvider,
  HexBytes,
  type Web3AuthKeyMaterial,
} from "lace-sdk";
import { Web3Auth } from "@web3auth/modal";
import { CHAIN_NAMESPACES, CustomChainConfig } from "@web3auth/base";
import { CommonPrivateKeyProvider } from "@web3auth/base-provider";

// 1. Test deriveMnemonicFromKeyMaterial (no user interaction needed)
const testKeyMaterial: Web3AuthKeyMaterial = {
  userId: "test-user",
  privateKeyHex: HexBytes("a".repeat(64)),
};
const result = deriveMnemonicFromKeyMaterial(testKeyMaterial);
out.textContent += `\n\n--- Web3Auth ---\nderiveMnemonicFromKeyMaterial: ${result.mnemonicWords.length} words, userId="${result.userId}"`;
console.log("Mnemonic words:", result.mnemonicWords);

const chainConfig: CustomChainConfig = {
  chainNamespace: CHAIN_NAMESPACES.OTHER,
  chainId: "0x0",
  // not used
  rpcTarget: "https://rpc.lace.io",
};
// 2. Set up web provider with Google login button
// Consumer constructs and configures the Web3Auth instance directly
const privateKeyProvider = new CommonPrivateKeyProvider({
  config: { chainConfig },
});

const web3auth = new Web3Auth({
  clientId:
    "BJYsKVCte9LKSWInWtBu99b03R3GYhNCax6MO6bAlZ8IA8GNIZDmBjtMB3qTHQDm-G5qH_vjTOb05HOvlXDJXss",
  web3AuthNetwork: "sapphire_devnet",
  chainConfig,
  privateKeyProvider,
});

// const { dispatch, stateObservables } = runLace({
//   config: { blockfrostKey, cardanoChainId },
//   modules: [module1, module2, cardanoProviderBLockfrost] as const,
// });

// dispatch("action.something", { dawda });
// stateObservables.typeSafeState.observable$;

const provider = createWebWeb3AuthProvider(web3auth);

const loginBtn = document.getElementById("web3auth-login") as HTMLButtonElement;
loginBtn.addEventListener("click", async () => {
  loginBtn.disabled = true;
  loginBtn.textContent = "Logging in...";
  try {
    const keyMaterial = await provider.login();
    const derived = deriveMnemonicFromKeyMaterial(keyMaterial);
    out.textContent += `\n\nLogin OK: userId="${derived.userId}", ${
      derived.mnemonicWords.length
    } words\nMnemonic: ${derived.mnemonicWords.join(" ")}`;
    console.log("Derived mnemonic words:", derived.mnemonicWords);
  } catch (err) {
    out.textContent += `\n\nLogin error: ${err}`;
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Login";
  }
});
