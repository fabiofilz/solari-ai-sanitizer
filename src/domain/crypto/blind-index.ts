import { createHmac } from "node:crypto";

// HMAC-SHA256 blind index (research.md #10): a deterministic MAC over a
// normalized value, used for exact-match uniqueness/dedup lookups without
// ever storing the value itself in plaintext or folded-plaintext form.
// Deterministic by construction (same subkey + same normalized input always
// produce the same output) — that determinism is the entire point.

const INDEX_SUBKEY_LENGTH = 32;

function assertIndexSubkeyLength(indexSubkey: Buffer): void {
  if (indexSubkey.length !== INDEX_SUBKEY_LENGTH) {
    throw new Error(
      `HMAC index subkey must be exactly ${INDEX_SUBKEY_LENGTH} bytes, received ${indexSubkey.length}`,
    );
  }
}

export function computeBlindIndex(indexSubkey: Buffer, normalizedValue: string): Buffer {
  assertIndexSubkeyLength(indexSubkey);
  return createHmac("sha256", indexSubkey).update(normalizedValue, "utf8").digest();
}
