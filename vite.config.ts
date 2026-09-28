import { defineConfig } from 'vite';

export default defineConfig({
  resolve: {
    alias: {
      // @cardano-sdk CJS internals use require("buffer")
      buffer: 'buffer/',
    },
  },
  optimizeDeps: {
    include: ['buffer'],
  },
});
