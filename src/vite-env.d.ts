/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BLOCKFROST_PROJECT_ID_PREPROD: string;
  readonly VITE_BLOCKFROST_PROJECT_ID_PREVIEW: string;
  readonly VITE_BLOCKFROST_PROJECT_ID_MAINNET: string;
  readonly VITE_WEB3AUTH_CLIENT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
