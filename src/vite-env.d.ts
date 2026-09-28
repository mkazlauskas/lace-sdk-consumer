/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BLOCKFROST_URL_PREPROD?: string;
  readonly VITE_BLOCKFROST_PROJECT_ID_PREPROD: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
