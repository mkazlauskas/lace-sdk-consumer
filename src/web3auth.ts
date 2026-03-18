import { createWebWeb3AuthProvider } from "@input-output-hk/lace-sdk";
import { Web3Auth } from "@web3auth/modal";
import { CHAIN_NAMESPACES, type CustomChainConfig } from "@web3auth/base";
import { CommonPrivateKeyProvider } from "@web3auth/base-provider";

const chainConfig: CustomChainConfig = {
  chainNamespace: CHAIN_NAMESPACES.OTHER,
  chainId: "0x0",
  rpcTarget: "https://rpc.lace.io",
};

const web3auth = new Web3Auth({
  clientId: import.meta.env.VITE_WEB3AUTH_CLIENT_ID,
  web3AuthNetwork: "sapphire_devnet",
  chainConfig,
  privateKeyProvider: new CommonPrivateKeyProvider({
    config: { chainConfig },
  }),
});

const provider = createWebWeb3AuthProvider(web3auth);

export async function getKeyMaterial() {
  return provider.login();
}
