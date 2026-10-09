/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PASSKEY_SIGNER_URL?: string;
  readonly VITE_BLOCKFROST_URL_PREPROD?: string;
  readonly VITE_BLOCKFROST_PROJECT_ID_PREPROD: string;
  /** Tip poll interval in milliseconds; 30000 when absent. */
  readonly VITE_TIP_POLL_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
