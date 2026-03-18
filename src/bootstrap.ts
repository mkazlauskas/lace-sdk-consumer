// Must run before any @web3auth imports — eccrypto uses global Buffer
import { Buffer } from 'buffer';
(globalThis as Record<string, unknown>).Buffer = Buffer;

// Dynamic import ensures Buffer is set before main.ts's dependency graph loads
await import('./main');
