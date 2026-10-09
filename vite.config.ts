import { defineConfig } from 'vite';
import { sponsorRelayPlugin } from './sponsor-relay';

export default defineConfig({
  // The fee sponsor relay on /sponsor, which reads SPONSOR_URL and
  // SPONSOR_API_KEY in this Node process. Only VITE_ variables reach the
  // browser bundle.
  plugins: [sponsorRelayPlugin()],
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
