import { defineConfig } from 'vite';
import path from 'path';

// @web3auth/modal bundles React 18 internally — top-level React 19's
// removed ReactCurrentDispatcher breaks it. Alias to web3auth's copy.
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
