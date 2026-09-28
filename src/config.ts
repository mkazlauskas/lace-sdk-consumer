import {
  Cardano,
  FEATURE_FLAG_CARDANO,
  FEATURE_FLAG_NETWORK_TYPE,
  Milliseconds,
  AppConfig,
} from "@input-output-hk/lace-sdk/cardano";

// --- Config (mirrors apps/lace-extension/src/util/config.ts) ---

const BLOCKFROST_PROJECT_ID_PREPROD = import.meta.env
  .VITE_BLOCKFROST_PROJECT_ID_PREPROD;
const BLOCKFROST_URL_PREPROD = import.meta.env.VITE_BLOCKFROST_URL_PREPROD;

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
    blockfrostConfigs: {
      // keyed by 'network magic'
      1: {
        clientConfig: {
          baseUrl: BLOCKFROST_URL_PREPROD || "https://cardano-preprod.blockfrost.io",
          apiVersion: "v0",
          projectId: BLOCKFROST_PROJECT_ID_PREPROD,
        },
        rateLimiterConfig,
      },
    },
  },
  cexplorerUrls: {
    // keyed by 'network magic'
    1: "https://preprod.cexplorer.io",
  },
};
