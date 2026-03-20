import { defineConfig } from 'vite';
import path from 'path';

// @web3auth/ui (via @web3auth/modal) bundles React 18 as a hard dependency,
// but its react-i18next resolves a separate React 19 copy — two React
// instances cause "Invalid hook call" errors. Alias all react imports to
// web3auth's bundled copy so there's a single instance.
// This is NOT related to @input-output-hk/lace-sdk (which is React-free).
const web3authReact = path.resolve(
  'node_modules/@web3auth/modal/node_modules/react'
);

export default defineConfig({
  resolve: {
    alias: {
      // @cardano-sdk CJS internals use require("buffer")
      buffer: 'buffer/',
      react: web3authReact,
    },
  },
  optimizeDeps: {
    include: ['buffer'],
  },
});
