import { hkdfSync } from "node:crypto";

// HKDF subkey separation (research.md #10): derives a distinct AES-256-GCM
// encryption subkey and HMAC blind-index subkey from one raw 256-bit DEK, so
// the same key material is never reused for two different cryptographic
// purposes. Deterministic by design — the same raw DEK always derives the
// same subkeys, since the DEK itself does not change between app sessions.

const RAW_DEK_LENGTH = 32;
const SUBKEY_LENGTH = 32;
const HKDF_HASH = "sha256";
const HKDF_SALT = Buffer.alloc(0);
const ENCRYPTION_INFO = Buffer.from("solari-ai-sanitizer:aes-gcm-encryption-subkey", "utf8");
const INDEX_INFO = Buffer.from("solari-ai-sanitizer:hmac-blind-index-subkey", "utf8");

export interface DerivedSubkeys {
  encryptionSubkey: Buffer;
  indexSubkey: Buffer;
}

function assertRawDekLength(rawDek: Buffer): void {
  if (rawDek.length !== RAW_DEK_LENGTH) {
    throw new Error(`Raw DEK must be exactly ${RAW_DEK_LENGTH} bytes, received ${rawDek.length}`);
  }
}

export function deriveSubkeys(rawDek: Buffer): DerivedSubkeys {
  assertRawDekLength(rawDek);

  const encryptionSubkey = Buffer.from(
    hkdfSync(HKDF_HASH, rawDek, HKDF_SALT, ENCRYPTION_INFO, SUBKEY_LENGTH),
  );
  const indexSubkey = Buffer.from(
    hkdfSync(HKDF_HASH, rawDek, HKDF_SALT, INDEX_INFO, SUBKEY_LENGTH),
  );

  return { encryptionSubkey, indexSubkey };
}
