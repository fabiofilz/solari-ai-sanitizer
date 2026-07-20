import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createKeyManager,
  KeyManagerError,
  verifySafeStorageRuntimeCompatibility,
  type SafeStorageLike,
} from "../../../src/main/persistence/key-manager";

// Unit tests for T027 (research.md #10, #13). Every safeStorage interaction
// is a synthetic in-memory mock injected via createKeyManager() — no real
// Electron runtime, no real key material, and this file never touches the
// production wrap/unwrap functions (which own the real Electron
// safeStorage internally). Synthetic data only (constitution Principle VI).

const SYNTHETIC_DEK = Buffer.alloc(32, 0x5a);

function toBase64(dek: Buffer): string {
  return dek.toString("base64");
}

/** A minimal, controllable fake matching Electron's real safeStorage shape. */
function createFakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike & {
  encryptStringAsync: ReturnType<typeof vi.fn>;
  decryptStringAsync: ReturnType<typeof vi.fn>;
  isAsyncEncryptionAvailable: ReturnType<typeof vi.fn>;
} {
  return {
    isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(true),
    encryptStringAsync: vi
      .fn()
      .mockImplementation(async (plainText: string) => Buffer.from(`wrapped:${plainText}`)),
    decryptStringAsync: vi.fn().mockImplementation(async (encrypted: Buffer) => ({
      result: encrypted.toString("utf8").replace(/^wrapped:/, ""),
      shouldReEncrypt: false,
    })),
    ...overrides,
  } as SafeStorageLike & {
    encryptStringAsync: ReturnType<typeof vi.fn>;
    decryptStringAsync: ReturnType<typeof vi.fn>;
    isAsyncEncryptionAvailable: ReturnType<typeof vi.fn>;
  };
}

describe("key-manager: registry wrap/unwrap round trip", () => {
  it("wraps a synthetic 32-byte DEK and unwraps it back to the exact original bytes", async () => {
    const safeStorage = createFakeSafeStorage();
    const keyManager = createKeyManager(safeStorage);
    const persistRewrapped = vi.fn().mockResolvedValue(undefined);

    const wrapped = await keyManager.wrapRegistryDek(SYNTHETIC_DEK);
    expect(Buffer.isBuffer(wrapped)).toBe(true);
    expect(wrapped.length).toBeGreaterThan(0);

    const recovered = await keyManager.unwrapRegistryDek(wrapped, persistRewrapped);
    expect(recovered.equals(SYNTHETIC_DEK)).toBe(true);
    expect(persistRewrapped).not.toHaveBeenCalled();
  });

  it("passes the correct Base64 encoding of the raw DEK into encryptStringAsync", async () => {
    const safeStorage = createFakeSafeStorage();
    const keyManager = createKeyManager(safeStorage);
    await keyManager.wrapRegistryDek(SYNTHETIC_DEK);

    expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith(toBase64(SYNTHETIC_DEK));
  });

  it("fails closed with REGISTRY_KEY_UNAVAILABLE when the async API is unavailable (wrap)", async () => {
    const safeStorage = createFakeSafeStorage({
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(false),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.wrapRegistryDek(SYNTHETIC_DEK)).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it("fails closed with REGISTRY_KEY_UNAVAILABLE when the async API is unavailable (unwrap)", async () => {
    const safeStorage = createFakeSafeStorage({
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(false),
    });
    const keyManager = createKeyManager(safeStorage);
    const persistRewrapped = vi.fn();

    await expect(
      keyManager.unwrapRegistryDek(Buffer.from("anything"), persistRewrapped),
    ).rejects.toMatchObject({ code: "REGISTRY_KEY_UNAVAILABLE" });
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    expect(persistRewrapped).not.toHaveBeenCalled();
  });
});

describe("key-manager: workspace wrap/unwrap round trip", () => {
  it("wraps a synthetic 32-byte DEK and unwraps it back to the exact original bytes", async () => {
    const safeStorage = createFakeSafeStorage();
    const keyManager = createKeyManager(safeStorage);
    const persistRewrapped = vi.fn().mockResolvedValue(undefined);

    const wrapped = await keyManager.wrapWorkspaceDek(SYNTHETIC_DEK);
    const recovered = await keyManager.unwrapWorkspaceDek(wrapped, persistRewrapped);

    expect(recovered.equals(SYNTHETIC_DEK)).toBe(true);
  });

  it("fails closed with WORKSPACE_KEY_UNAVAILABLE when the async API is unavailable (wrap)", async () => {
    const safeStorage = createFakeSafeStorage({
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(false),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.wrapWorkspaceDek(SYNTHETIC_DEK)).rejects.toMatchObject({
      code: "WORKSPACE_KEY_UNAVAILABLE",
    });
  });

  it("fails closed with WORKSPACE_KEY_UNAVAILABLE when the async API is unavailable (unwrap)", async () => {
    const safeStorage = createFakeSafeStorage({
      isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(false),
    });
    const keyManager = createKeyManager(safeStorage);
    const persistRewrapped = vi.fn();

    await expect(
      keyManager.unwrapWorkspaceDek(Buffer.from("anything"), persistRewrapped),
    ).rejects.toMatchObject({ code: "WORKSPACE_KEY_UNAVAILABLE" });
  });
});

describe("key-manager: wrap input validation (never calls encryptStringAsync on malformed input)", () => {
  it("rejects a non-Buffer raw DEK at the runtime boundary", async () => {
    const safeStorage = createFakeSafeStorage();
    const keyManager = createKeyManager(safeStorage);
    // Runtime boundary: simulate a caller ignoring the TS type.
    const notABuffer = "not-a-buffer" as unknown as Buffer;

    await expect(keyManager.wrapRegistryDek(notABuffer)).rejects.toThrow();
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it("rejects a raw DEK shorter than 32 bytes", async () => {
    const safeStorage = createFakeSafeStorage();
    const keyManager = createKeyManager(safeStorage);
    await expect(keyManager.wrapRegistryDek(Buffer.alloc(16))).rejects.toThrow();
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it("rejects a raw DEK longer than 32 bytes", async () => {
    const safeStorage = createFakeSafeStorage();
    const keyManager = createKeyManager(safeStorage);
    await expect(keyManager.wrapRegistryDek(Buffer.alloc(33))).rejects.toThrow();
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it("fails closed when encryptStringAsync rejects", async () => {
    const safeStorage = createFakeSafeStorage({
      encryptStringAsync: vi.fn().mockRejectedValue(new Error("synthetic OS keychain failure")),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.wrapRegistryDek(SYNTHETIC_DEK)).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });

  it("fails closed when encryptStringAsync returns an empty buffer", async () => {
    const safeStorage = createFakeSafeStorage({
      encryptStringAsync: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.wrapRegistryDek(SYNTHETIC_DEK)).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });

  it("fails closed when encryptStringAsync returns a non-Buffer value", async () => {
    const safeStorage = createFakeSafeStorage({
      encryptStringAsync: vi.fn().mockResolvedValue("not-a-buffer" as unknown as Buffer),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.wrapRegistryDek(SYNTHETIC_DEK)).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });
});

describe("key-manager: unwrap input validation and strict decode (never trusts a permissive decode)", () => {
  it("rejects an empty wrapped Buffer without calling decryptStringAsync", async () => {
    const safeStorage = createFakeSafeStorage();
    const keyManager = createKeyManager(safeStorage);
    await expect(keyManager.unwrapRegistryDek(Buffer.alloc(0), vi.fn())).rejects.toThrow();
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
  });

  it("rejects a non-Buffer wrapped value at the runtime boundary", async () => {
    const safeStorage = createFakeSafeStorage();
    const keyManager = createKeyManager(safeStorage);
    const notABuffer = "not-a-buffer" as unknown as Buffer;
    await expect(keyManager.unwrapRegistryDek(notABuffer, vi.fn())).rejects.toThrow();
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
  });

  it("fails closed when decryptStringAsync rejects", async () => {
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockRejectedValue(new Error("synthetic OS keychain failure")),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.unwrapRegistryDek(Buffer.from("blob"), vi.fn())).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });

  it("fails closed on a malformed decryptStringAsync return shape (missing result)", async () => {
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ shouldReEncrypt: false }),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.unwrapRegistryDek(Buffer.from("blob"), vi.fn())).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });

  it("fails closed on a malformed decryptStringAsync return shape (wrong types)", async () => {
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ result: 123, shouldReEncrypt: "no" }),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.unwrapRegistryDek(Buffer.from("blob"), vi.fn())).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });

  it("fails closed on an empty decrypted result", async () => {
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ result: "", shouldReEncrypt: false }),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.unwrapRegistryDek(Buffer.from("blob"), vi.fn())).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });

  it("fails closed on non-canonical Base64 that a permissive Buffer.from(..., 'base64') would silently accept", async () => {
    // Constructed so a naive decode-then-length-check would pass (it decodes
    // to 32 bytes) but the string is not what canonical encoding of those
    // bytes actually produces — verified empirically before writing this
    // test (flipping the final pre-padding character to an alternate
    // encoding of the same trailing byte).
    const canonical = SYNTHETIC_DEK.toString("base64");
    const nonCanonical = `${canonical.slice(0, -2)}t=`;
    expect(Buffer.from(nonCanonical, "base64").length).toBe(32); // permissive decode still "succeeds"
    expect(Buffer.from(nonCanonical, "base64").toString("base64")).not.toBe(nonCanonical); // but isn't canonical

    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi
        .fn()
        .mockResolvedValue({ result: nonCanonical, shouldReEncrypt: false }),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.unwrapRegistryDek(Buffer.from("blob"), vi.fn())).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });

  it("fails closed when the decoded key is shorter than 32 bytes", async () => {
    const shortB64 = Buffer.alloc(16, 0x11).toString("base64");
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ result: shortB64, shouldReEncrypt: false }),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.unwrapRegistryDek(Buffer.from("blob"), vi.fn())).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });

  it("fails closed when the decoded key is longer than 32 bytes", async () => {
    const longB64 = Buffer.alloc(64, 0x22).toString("base64");
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ result: longB64, shouldReEncrypt: false }),
    });
    const keyManager = createKeyManager(safeStorage);

    await expect(keyManager.unwrapRegistryDek(Buffer.from("blob"), vi.fn())).rejects.toMatchObject({
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });
});

describe("key-manager: shouldReEncrypt handling", () => {
  it("shouldReEncrypt: false performs no re-wrap and no persistence call", async () => {
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({
        result: toBase64(SYNTHETIC_DEK),
        shouldReEncrypt: false,
      }),
    });
    const keyManager = createKeyManager(safeStorage);
    const persistRewrapped = vi.fn().mockResolvedValue(undefined);

    const recovered = await keyManager.unwrapRegistryDek(Buffer.from("blob"), persistRewrapped);

    expect(recovered.equals(SYNTHETIC_DEK)).toBe(true);
    // Only the initial decrypt call — no second encryptStringAsync re-wrap call.
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(persistRewrapped).not.toHaveBeenCalled();
  });

  it("shouldReEncrypt: true re-wraps the exact same validated Base64 result and recovers the same DEK", async () => {
    const validB64 = toBase64(SYNTHETIC_DEK);
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ result: validB64, shouldReEncrypt: true }),
    });
    const keyManager = createKeyManager(safeStorage);
    const persistRewrapped = vi.fn().mockResolvedValue(undefined);

    const recovered = await keyManager.unwrapRegistryDek(Buffer.from("blob"), persistRewrapped);

    expect(recovered.equals(SYNTHETIC_DEK)).toBe(true);
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledTimes(1);
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledWith(validB64);
  });

  it("persists the rewrapped key before the unwrap call resolves successfully", async () => {
    const validB64 = toBase64(SYNTHETIC_DEK);
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ result: validB64, shouldReEncrypt: true }),
    });
    const keyManager = createKeyManager(safeStorage);

    let persistResolved = false;
    let persistCalledWith: Buffer | undefined;
    let releasePersist: () => void = () => undefined;
    const persistGate = new Promise<void>((resolve) => {
      releasePersist = resolve;
    });
    const persistRewrapped = vi.fn().mockImplementation(async (wrapped: Buffer) => {
      persistCalledWith = wrapped;
      await persistGate;
      persistResolved = true;
    });

    const unwrapPromise = keyManager.unwrapRegistryDek(Buffer.from("blob"), persistRewrapped);

    // Let every pending microtask (the availability check, decrypt, and
    // re-wrap awaits preceding the persist call) drain before asserting —
    // setImmediate schedules a macrotask after the current microtask queue
    // is fully flushed, unlike a fixed number of `await Promise.resolve()`
    // hops, which is fragile to the exact number of internal awaits.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(persistRewrapped).toHaveBeenCalledTimes(1);
    expect(persistCalledWith).toBeInstanceOf(Buffer);
    expect(persistResolved).toBe(false); // not yet resolved — unwrap must still be waiting

    releasePersist();
    const recovered = await unwrapPromise;

    expect(persistResolved).toBe(true);
    expect(recovered.equals(SYNTHETIC_DEK)).toBe(true);
  });

  it("fails closed with the purpose error code when the re-wrap (encryptStringAsync) fails", async () => {
    const validB64 = toBase64(SYNTHETIC_DEK);
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ result: validB64, shouldReEncrypt: true }),
      encryptStringAsync: vi.fn().mockRejectedValue(new Error("synthetic re-wrap failure")),
    });
    const keyManager = createKeyManager(safeStorage);
    const persistRewrapped = vi.fn().mockResolvedValue(undefined);

    await expect(
      keyManager.unwrapWorkspaceDek(Buffer.from("blob"), persistRewrapped),
    ).rejects.toMatchObject({
      code: "WORKSPACE_KEY_UNAVAILABLE",
    });
    expect(persistRewrapped).not.toHaveBeenCalled();
  });

  it("fails closed with the purpose error code when persistence fails, and never returns the raw DEK", async () => {
    const validB64 = toBase64(SYNTHETIC_DEK);
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ result: validB64, shouldReEncrypt: true }),
    });
    const keyManager = createKeyManager(safeStorage);
    const persistRewrapped = vi.fn().mockRejectedValue(new Error("synthetic disk write failure"));

    await expect(
      keyManager.unwrapWorkspaceDek(Buffer.from("blob"), persistRewrapped),
    ).rejects.toMatchObject({
      code: "WORKSPACE_KEY_UNAVAILABLE",
    });
  });

  it("never rotates the underlying raw DEK across a re-wrap", async () => {
    const validB64 = toBase64(SYNTHETIC_DEK);
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ result: validB64, shouldReEncrypt: true }),
    });
    const keyManager = createKeyManager(safeStorage);
    const persistRewrapped = vi.fn().mockResolvedValue(undefined);

    const recovered = await keyManager.unwrapRegistryDek(Buffer.from("blob"), persistRewrapped);
    expect(recovered.equals(SYNTHETIC_DEK)).toBe(true);
  });
});

describe("key-manager: redaction — no secret material anywhere", () => {
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

  function assertNoConsoleOutput(): void {
    for (const spy of [logSpy, warnSpy, errorSpy, stdoutSpy, stderrSpy]) {
      expect(spy).not.toHaveBeenCalled();
    }
  }

  it("never writes to any console/stdio channel during a successful round trip", async () => {
    const safeStorage = createFakeSafeStorage();
    const keyManager = createKeyManager(safeStorage);
    const wrapped = await keyManager.wrapRegistryDek(SYNTHETIC_DEK);
    await keyManager.unwrapRegistryDek(wrapped, vi.fn().mockResolvedValue(undefined));
    assertNoConsoleOutput();
  });

  it("never includes the DEK, its Base64 form, or the wrapped blob in a thrown KeyManagerError's message", async () => {
    const validB64 = toBase64(SYNTHETIC_DEK);
    const shortB64 = Buffer.alloc(8, 0x11).toString("base64");
    const wrappedBlob = Buffer.from("synthetic-wrapped-blob-marker");
    const safeStorage = createFakeSafeStorage({
      decryptStringAsync: vi.fn().mockResolvedValue({ result: shortB64, shouldReEncrypt: false }),
    });
    const keyManager = createKeyManager(safeStorage);

    let caught: unknown;
    try {
      await keyManager.unwrapRegistryDek(wrappedBlob, vi.fn());
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(KeyManagerError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(validB64);
    expect(message).not.toContain(shortB64);
    expect(message).not.toContain(SYNTHETIC_DEK.toString("hex"));
    expect(message).not.toContain(wrappedBlob.toString("utf8"));
    assertNoConsoleOutput();
  });
});

describe("key-manager: verifySafeStorageRuntimeCompatibility (T029 runtime API-surface check)", () => {
  it("accepts a candidate with all three required async methods present and callable", () => {
    const candidate = createFakeSafeStorage();
    expect(() => verifySafeStorageRuntimeCompatibility(candidate)).not.toThrow();
  });

  it("rejects a candidate missing isAsyncEncryptionAvailable", () => {
    const candidate = createFakeSafeStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately constructing a malformed candidate.
    delete (candidate as any).isAsyncEncryptionAvailable;
    expect(() => verifySafeStorageRuntimeCompatibility(candidate)).toThrow(
      /isAsyncEncryptionAvailable/,
    );
  });

  it("rejects a candidate where a required method is present but not a function", () => {
    const candidate = createFakeSafeStorage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately constructing a malformed candidate.
    (candidate as any).encryptStringAsync = "not-a-function";
    expect(() => verifySafeStorageRuntimeCompatibility(candidate)).toThrow(/encryptStringAsync/);
  });

  it("rejects null and non-object candidates", () => {
    expect(() => verifySafeStorageRuntimeCompatibility(null)).toThrow();
    expect(() => verifySafeStorageRuntimeCompatibility(undefined)).toThrow();
    expect(() => verifySafeStorageRuntimeCompatibility("not-an-object")).toThrow();
  });

  it("does not rely on Function.length: accepts real functions with extra/optional parameters", () => {
    const candidate = createFakeSafeStorage({
      // Real-world signature drift that would break a Function.length-based
      // check (extra optional parameter) but is still a valid, callable
      // implementation of the same method.
      isAsyncEncryptionAvailable: ((..._args: unknown[]) =>
        Promise.resolve(true)) as SafeStorageLike["isAsyncEncryptionAvailable"],
    });
    expect(() => verifySafeStorageRuntimeCompatibility(candidate)).not.toThrow();
  });

  it("never logs anything when checking compatibility", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      verifySafeStorageRuntimeCompatibility({});
    } catch {
      // expected
    }

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
