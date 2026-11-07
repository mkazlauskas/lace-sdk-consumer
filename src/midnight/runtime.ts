// Every wallet operation/state read stays on the packaged public Midnight entry.
import * as sdk from '@laceio/sdk/midnight';
import { BASELINE_FLAGS, LOCAL_PROOF_SERVER_URL, TEMENOS_URL, validateConfig, workerOption, type SessionConfig } from './config';

export async function restore(words: string[], password: Uint8Array, requested: SessionConfig) {
  const config = validateConfig(requested);
  const featureFlags = [
    ...BASELINE_FLAGS.map(key => ({ key: key as typeof sdk.FEATURE_FLAG_MIDNIGHT })),
    { key: sdk.FEATURE_FLAG_NETWORK_TYPE, payload: config.network === 'mainnet' ? 'mainnet' : 'testnet' },
  ];
  const overrides: sdk.MidnightNetworkConfigOverrides = {
    [config.network]: {
      ...(config.nodeAddress ? { nodeAddress: config.nodeAddress, indexerAddress: config.indexerAddress } : {}),
      ...(config.prover === 'temenos' ? { proofServer: { kind: 'tee-delegated', url: TEMENOS_URL, label: 'Temenos' } } : {}),
    },
  };
  // Worker mode runs each account's engine in the SDK's SharedWorker, which proves through the proof
  // server URL; validateConfig refuses Temenos with it, as createMidnightModule does.
  const worker = workerOption(config);
  const wallet = await sdk.createLaceWallet({
    modules: [sdk.m.featureDev, sdk.m.storageInMemory, sdk.createMidnightModule({
      password, proofServerUrl: LOCAL_PROOF_SERVER_URL, networks: overrides,
      ...(config.prover === 'temenos' ? {
        // The verifier library loads the ledger's and the compact runtime's WebAssembly when it loads, so only a
        // Temenos session loads it; a page on the local prover, Worker mode included, never does.
        createAttestedProver: (await import('./temenos-provider')).createConsumerTemenosProver,
      } : {}),
      ...(worker ? { worker } : {}),
    })] as const,
    environment: 'development', featureFlags,
    config: { defaultFeatureFlags: featureFlags, extraFeatureFlags: [], defaultMidnightTestnetNetworkId: config.network === 'mainnet' ? 'preview' : config.network },
  });
  sdk.selectMidnightNetwork(wallet, config.network);
  let entity = await sdk.createInMemoryWalletEntity(wallet, { mnemonicWords: words, password, walletName: 'Midnight developer session' });
  if (config.index !== 0) entity = await sdk.createMidnightAccounts(wallet, {
    wallet: entity, password, accountIndex: config.index, accountName: `Index ${config.index}`,
  });
  wallet.dispatch('wallets.addWallet', entity);
  return { wallet, entity, sdk, config };
}
export type Session = Awaited<ReturnType<typeof restore>>;
export type Recipe = sdk.MidnightTxRecipe;
export type Transaction = sdk.MidnightFinalizedTx;
export type Batch = sdk.MidnightTransferBatch;
export type CircuitKeys = sdk.KeyMaterialProvider;
export function stopSession(session: Session) {
  session.wallet.dispatch('wallets.removeWallet', session.entity.walletId, session.entity.accounts.map(a => a.accountId));
}

export type Account = sdk.MidnightAccountId;
