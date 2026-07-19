import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../../../src/domain/crypto/aes-gcm";
import { deriveSubkeys } from "../../../src/domain/crypto/hkdf";
import { computeBlindIndex } from "../../../src/domain/crypto/blind-index";

// Constitution Principle VI (Test-First Traceability) + research.md #10.
// All keys and plaintext below are synthetic, generated fresh per test run —
// never real secrets, never committed fixtures.

const SYNTHETIC_DEK = randomBytes(32);
const SYNTHETIC_PLAINTEXT = Buffer.from(
  "synthetic-original-value: Contoso Ltd. <test@example.com>",
  "utf8",
);

describe("AES-256-GCM (aes-gcm.ts)", () => {
  it("round-trips synthetic plaintext through encrypt/decrypt", () => {
    const blob = encrypt(SYNTHETIC_DEK, SYNTHETIC_PLAINTEXT);
    const decrypted = decrypt(SYNTHETIC_DEK, blob);
    expect(decrypted.equals(SYNTHETIC_PLAINTEXT)).toBe(true);
  });

  it("produces a distinct nonce (and therefore distinct ciphertext) on every call for identical inputs", () => {
    const first = encrypt(SYNTHETIC_DEK, SYNTHETIC_PLAINTEXT);
    const second = encrypt(SYNTHETIC_DEK, SYNTHETIC_PLAINTEXT);
    expect(first.equals(second)).toBe(false);
    // Both must still independently decrypt to the same plaintext.
    expect(decrypt(SYNTHETIC_DEK, first).equals(SYNTHETIC_PLAINTEXT)).toBe(true);
    expect(decrypt(SYNTHETIC_DEK, second).equals(SYNTHETIC_PLAINTEXT)).toBe(true);
  });

  it("fails closed when the ciphertext bytes are tampered", () => {
    const blob = encrypt(SYNTHETIC_DEK, SYNTHETIC_PLAINTEXT);
    const tampered = Buffer.from(blob);
    // Flip a byte inside the ciphertext region (after the 12-byte nonce prefix).
    tampered[12] = tampered[12]! ^ 0xff;
    expect(() => decrypt(SYNTHETIC_DEK, tampered)).toThrow();
  });

  it("fails closed when the authentication tag is tampered", () => {
    const blob = encrypt(SYNTHETIC_DEK, SYNTHETIC_PLAINTEXT);
    const tampered = Buffer.from(blob);
    // Flip the last byte, inside the 16-byte auth tag suffix.
    const lastIndex = tampered.length - 1;
    tampered[lastIndex] = tampered[lastIndex]! ^ 0xff;
    expect(() => decrypt(SYNTHETIC_DEK, tampered)).toThrow();
  });

  it("fails closed when decrypting with the wrong key", () => {
    const blob = encrypt(SYNTHETIC_DEK, SYNTHETIC_PLAINTEXT);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(wrongKey, blob)).toThrow();
  });

  it("rejects an encryption key that is not exactly 32 bytes", () => {
    expect(() => encrypt(randomBytes(16), SYNTHETIC_PLAINTEXT)).toThrow();
    expect(() => encrypt(randomBytes(31), SYNTHETIC_PLAINTEXT)).toThrow();
    expect(() => encrypt(randomBytes(33), SYNTHETIC_PLAINTEXT)).toThrow();
  });

  it("rejects a decryption key that is not exactly 32 bytes", () => {
    const blob = encrypt(SYNTHETIC_DEK, SYNTHETIC_PLAINTEXT);
    expect(() => decrypt(randomBytes(16), blob)).toThrow();
  });

  it("rejects a ciphertext blob too short to contain a nonce and auth tag", () => {
    expect(() => decrypt(SYNTHETIC_DEK, Buffer.alloc(10))).toThrow();
    expect(() => decrypt(SYNTHETIC_DEK, Buffer.alloc(0))).toThrow();
  });
});

describe("HKDF subkey derivation (hkdf.ts)", () => {
  it("derives distinct encryption and index subkeys from the same raw DEK", () => {
    const { encryptionSubkey, indexSubkey } = deriveSubkeys(SYNTHETIC_DEK);
    expect(encryptionSubkey.length).toBe(32);
    expect(indexSubkey.length).toBe(32);
    expect(encryptionSubkey.equals(indexSubkey)).toBe(false);
  });

  it("is deterministic: the same raw DEK always derives the same subkeys", () => {
    const first = deriveSubkeys(SYNTHETIC_DEK);
    const second = deriveSubkeys(SYNTHETIC_DEK);
    expect(first.encryptionSubkey.equals(second.encryptionSubkey)).toBe(true);
    expect(first.indexSubkey.equals(second.indexSubkey)).toBe(true);
  });

  it("derives different subkeys for different raw DEKs", () => {
    const other = deriveSubkeys(randomBytes(32));
    const mine = deriveSubkeys(SYNTHETIC_DEK);
    expect(mine.encryptionSubkey.equals(other.encryptionSubkey)).toBe(false);
    expect(mine.indexSubkey.equals(other.indexSubkey)).toBe(false);
  });

  it("rejects a raw DEK that is not exactly 32 bytes", () => {
    expect(() => deriveSubkeys(randomBytes(16))).toThrow();
    expect(() => deriveSubkeys(randomBytes(0))).toThrow();
  });
});

describe("HMAC-SHA256 blind index (blind-index.ts)", () => {
  const { indexSubkey } = deriveSubkeys(SYNTHETIC_DEK);

  it("is deterministic for the same normalized input and key", () => {
    const first = computeBlindIndex(indexSubkey, "synthetic bank sa");
    const second = computeBlindIndex(indexSubkey, "synthetic bank sa");
    expect(first.equals(second)).toBe(true);
  });

  it("produces different indexes for different normalized inputs", () => {
    const a = computeBlindIndex(indexSubkey, "synthetic bank sa");
    const b = computeBlindIndex(indexSubkey, "synthetic bank ltd");
    expect(a.equals(b)).toBe(false);
  });

  it("produces different indexes for the same input under different keys", () => {
    const otherSubkey = deriveSubkeys(randomBytes(32)).indexSubkey;
    const a = computeBlindIndex(indexSubkey, "synthetic bank sa");
    const b = computeBlindIndex(otherSubkey, "synthetic bank sa");
    expect(a.equals(b)).toBe(false);
  });

  it("rejects an index subkey that is not exactly 32 bytes", () => {
    expect(() => computeBlindIndex(randomBytes(16), "synthetic bank sa")).toThrow();
  });
});

describe("redaction: crypto primitives never log or leak sensitive material", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it("never writes to any console/stdio channel during encrypt, decrypt, derive, or index operations", () => {
    const { indexSubkey } = deriveSubkeys(SYNTHETIC_DEK);
    const blob = encrypt(SYNTHETIC_DEK, SYNTHETIC_PLAINTEXT);
    decrypt(SYNTHETIC_DEK, blob);
    computeBlindIndex(indexSubkey, "synthetic bank sa");

    for (const spy of [logSpy, warnSpy, errorSpy, stdoutSpy, stderrSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("never includes key, plaintext, ciphertext, or tag material in a thrown error's message", () => {
    const blob = encrypt(SYNTHETIC_DEK, SYNTHETIC_PLAINTEXT);
    const tampered = Buffer.from(blob);
    tampered[12] = tampered[12]! ^ 0xff;

    let thrownMessage = "";
    try {
      decrypt(SYNTHETIC_DEK, tampered);
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }

    expect(thrownMessage.length).toBeGreaterThan(0);
    expect(thrownMessage).not.toContain(SYNTHETIC_PLAINTEXT.toString("utf8"));
    expect(thrownMessage).not.toContain(SYNTHETIC_DEK.toString("hex"));
    expect(thrownMessage).not.toContain(SYNTHETIC_DEK.toString("base64"));
    expect(thrownMessage).not.toContain(blob.toString("hex"));
    expect(thrownMessage).not.toContain(blob.toString("base64"));

    for (const spy of [logSpy, warnSpy, errorSpy, stdoutSpy, stderrSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
