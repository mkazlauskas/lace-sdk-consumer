import {
  Cardano,
  FEATURE_FLAG_CARDANO,
  FEATURE_FLAG_NETWORK_TYPE,
  Milliseconds,
  AppConfig,
} from "@input-output-hk/lace-sdk";

// --- Config (mirrors apps/lace-extension/src/util/config.ts) ---

const BLOCKFROST_PROJECT_ID_PREPROD = import.meta.env
  .VITE_BLOCKFROST_PROJECT_ID_PREPROD;
const BLOCKFROST_PROJECT_ID_PREVIEW = import.meta.env
  .VITE_BLOCKFROST_PROJECT_ID_PREVIEW;
const BLOCKFROST_PROJECT_ID_MAINNET = import.meta.env
  .VITE_BLOCKFROST_PROJECT_ID_MAINNET;

const rateLimiterConfig = {
  size: 500,
  increaseAmount: 10,
  increaseInterval: Milliseconds(1000),
};

export const featureFlags = [
  { key: FEATURE_FLAG_CARDANO },
  { key: FEATURE_FLAG_NETWORK_TYPE, payload: "testnet" },
];

export const config: Partial<AppConfig> = {
  defaultFeatureFlags: featureFlags,
  extraFeatureFlags: [],
  defaultTestnetChainId: Cardano.ChainIds.Preprod,
  cardanoProvider: {
    tipPollFrequency: Milliseconds(30000),
    transactionHistoryPollingIntervalSeconds: Milliseconds(30000),
    blockfrostConfigs: {
      // keyed by 'network magic'
      1: {
        clientConfig: {
          baseUrl: "https://cardano-preprod.blockfrost.io",
          apiVersion: "v0",
          projectId: BLOCKFROST_PROJECT_ID_PREPROD,
        },
        rateLimiterConfig,
      },
      2: {
        clientConfig: {
          baseUrl: "https://cardano-preview.blockfrost.io",
          apiVersion: "v0",
          projectId: BLOCKFROST_PROJECT_ID_PREVIEW,
        },
        rateLimiterConfig,
      },
      764824073: {
        clientConfig: {
          baseUrl: "https://cardano-mainnet.blockfrost.io",
          apiVersion: "v0",
          projectId: BLOCKFROST_PROJECT_ID_MAINNET,
        },
        rateLimiterConfig,
      },
    },
  },
  cexplorerUrls: {
    // keyed by 'network magic'
    1: "https://preprod.cexplorer.io",
    2: "https://preview.cexplorer.io",
    764824073: "https://cexplorer.io",
  },
};
