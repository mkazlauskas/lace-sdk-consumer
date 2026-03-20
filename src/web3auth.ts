import { EntropyHex } from "@input-output-hk/lace-sdk";
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

let initialized = false;

export async function login(): Promise<{
  entropyHex: EntropyHex;
  userId: string;
}> {
  if (!initialized) {
    await web3auth.initModal();
    initialized = true;
  }

  const provider = await web3auth.connect();
  if (!provider) {
    throw new Error("Web3Auth connect did not return a provider");
  }

  const privateKey = await provider.request<void, string>({
    method: "private_key",
  });
  const userInfo = await web3auth.getUserInfo();

  if (!privateKey) {
    throw new Error("Web3Auth login did not return a private key");
  }
  if (!userInfo?.verifierId) {
    throw new Error("Web3Auth login did not return a verifierId");
  }

  return {
    entropyHex: EntropyHex(privateKey),
    userId: userInfo.verifierId,
  };
}
