import { ed25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

/**
 * A raw Ed25519 key held in memory, as a development fee sponsor or an
 * agent's own wallet holds one. It never leaves this page and is lost on
 * reload. Use it with Preprod test ADA only.
 */
export type DevKey = {
  /** 32-byte Ed25519 public key, hex. */
  publicKey: string;
  /** BLAKE2b-224 of the public key, hex: what a Cardano address or a grant names. */
  keyHash: string;
  /** Signs a transaction body hash (32 bytes, hex) and returns the signature hex. */
  signHash(bodyHash: string): string;
};

export function devKeyFromSecret(secretKey: Uint8Array): DevKey {
  const publicKey = ed25519.getPublicKey(secretKey);
  return {
    publicKey: bytesToHex(publicKey),
    keyHash: bytesToHex(blake2b(publicKey, { dkLen: 28 })),
    signHash: (bodyHash) => {
      const message = hexToBytes(bodyHash);
      if (message.length !== 32) throw new Error("Expected a 32-byte transaction body hash");
      return bytesToHex(ed25519.sign(message, secretKey));
    },
  };
}

export function generateDevKey(): DevKey {
  return devKeyFromSecret(ed25519.utils.randomSecretKey());
}

/** Whether `signature` is `publicKey`'s Ed25519 signature over `bodyHash`, all hex. */
export function verifyHashSignature(publicKey: string, bodyHash: string, signature: string): boolean {
  try {
    return ed25519.verify(hexToBytes(signature), hexToBytes(bodyHash), hexToBytes(publicKey));
  } catch {
    return false;
  }
}

/** BLAKE2b-224 of an Ed25519 public key given in hex. */
export function keyHashOf(publicKey: string): string {
  return bytesToHex(blake2b(hexToBytes(publicKey), { dkLen: 28 }));
}
