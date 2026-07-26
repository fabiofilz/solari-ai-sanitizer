import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM authenticated encryption (research.md #10). Framework-independent:
// callers supply a raw 256-bit key, never a wrapped/unwrapped safeStorage blob.

export const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;
const ALGORITHM = "aes-256-gcm";

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LENGTH) {
    throw new Error(`AES-256-GCM key must be exactly ${KEY_LENGTH} bytes, received ${key.length}`);
  }
}

/**
 * Encrypts plaintext with a fresh random nonce, returning nonce || ciphertext || tag.
 */
export function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  assertKeyLength(key);

  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * Decrypts a nonce || ciphertext || tag blob produced by encrypt(). Fails
 * closed (throws) on a wrong key, a too-short/malformed blob, or any
 * tampering with the ciphertext or authentication tag.
 */
export function decrypt(key: Buffer, blob: Buffer): Buffer {
  assertKeyLength(key);

  if (blob.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new Error(
      `AES-256-GCM ciphertext blob too short: expected at least ${NONCE_LENGTH + TAG_LENGTH} bytes, received ${blob.length}`,
    );
  }

  const nonce = blob.subarray(0, NONCE_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ciphertext = blob.subarray(NONCE_LENGTH, blob.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // Never propagate the underlying error's details — Node's own message is
    // already safe, but this keeps the surface explicitly under our control.
    throw new Error("AES-256-GCM authentication failed: ciphertext, tag, or key is invalid");
  }
}
