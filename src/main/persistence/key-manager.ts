import { safeStorage as electronSafeStorage } from "electron";

// Key management (research.md #10, #13): DEK wrap/unwrap via Electron's
// asynchronous safeStorage API, for both the registry-level DEK (protects
// Workspace.name) and every per-workspace DEK (protects Term/PendingDecision
// rows). This module is the *only* one permitted to reference `safeStorage`
// — nothing else in this codebase may import, receive, or call it. The real
// Electron `safeStorage` export is imported once, at the top of this file,
// and never leaves it: production callers use the exported functions below
// without ever supplying a safeStorage argument. `createKeyManager()` exists
// solely so unit tests can inject a fake implementing `SafeStorageLike`
// instead of touching the real Electron runtime; it shares the exact same
// core logic as the production path via `createKeyManagerCore()`.
//
// Fail-closed by design: any unexpected shape, length, or rejection at any
// step raises a KeyManagerError carrying only a category and a length where
// relevant — never the DEK, its Base64 form, the wrapped blob, or any OS
// error detail that might embed key material.

const DEK_LENGTH = 32;

export type KeyManagerErrorCode = "REGISTRY_KEY_UNAVAILABLE" | "WORKSPACE_KEY_UNAVAILABLE";

export class KeyManagerError extends Error {
  readonly code: KeyManagerErrorCode;

  constructor(code: KeyManagerErrorCode, message: string) {
    super(message);
    this.name = "KeyManagerError";
    this.code = code;
  }
}

/**
 * Structural subset of Electron's real `safeStorage` export — only the
 * three asynchronous methods this module uses. The real `electron` module's
 * `safeStorage` object satisfies this type directly; tests inject a plain
 * mock object instead.
 */
export interface SafeStorageLike {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

// Compile-time compatibility check (T029), verified against the pinned
// Electron dependency's own electron.d.ts: `assertTypeExtends`'s generic
// constraint `T extends U` makes the call below fail `tsc` if Electron's
// real safeStorage shape ever stops satisfying SafeStorageLike — a
// build-time signal, not a runtime surprise. The generic type arguments are
// erased at compile time, so this line has no runtime effect of its own.
function assertTypeExtends<T extends U, U>(_witness?: T): void {
  /* compile-time only: this body intentionally does nothing at runtime. */
}
assertTypeExtends<import("electron").SafeStorage, SafeStorageLike>();

export type PersistRewrappedDek = (wrapped: Buffer) => Promise<void>;

/**
 * Runtime API-surface verification (T029): confirms all three async
 * safeStorage methods this module depends on are present and are actual
 * functions on the given candidate. Deliberately does not use
 * `Function.length` (parameter count) — optional/default parameters and
 * build-tool transpilation make arity an unreliable compatibility signal;
 * presence-and-callable is the only check that is actually meaningful here.
 *
 * Exported for direct unit testing against arbitrary candidates.
 * `verifyProductionSafeStorageCompatibility()` below is the no-argument,
 * production-bound entry point that future startup code should call —
 * it never requires the caller to obtain or pass a safeStorage reference.
 */
export function verifySafeStorageRuntimeCompatibility(
  candidate: unknown,
): asserts candidate is SafeStorageLike {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("safeStorage compatibility check failed: safeStorage is not an object");
  }

  const requiredMethods = [
    "isAsyncEncryptionAvailable",
    "encryptStringAsync",
    "decryptStringAsync",
  ] as const;
  const missing = requiredMethods.filter(
    (name) => typeof (candidate as Record<string, unknown>)[name] !== "function",
  );

  if (missing.length > 0) {
    throw new Error(
      `safeStorage compatibility check failed: missing or non-function method(s): ${missing.join(", ")}`,
    );
  }
}

/**
 * Production-bound, no-argument compatibility check (T029/T027-T029
 * remediation): verifies the real, internally-owned Electron safeStorage
 * object has the expected async method surface. Future startup code (T042)
 * can call this without ever importing or obtaining a safeStorage
 * reference of its own.
 */
export function verifyProductionSafeStorageCompatibility(): void {
  verifySafeStorageRuntimeCompatibility(electronSafeStorage);
}

type KeyPurpose = "registry" | "workspace";

function errorCodeFor(purpose: KeyPurpose): KeyManagerErrorCode {
  return purpose === "registry" ? "REGISTRY_KEY_UNAVAILABLE" : "WORKSPACE_KEY_UNAVAILABLE";
}

function fail(purpose: KeyPurpose, reason: string): never {
  throw new KeyManagerError(errorCodeFor(purpose), `${purpose} key unavailable: ${reason}`);
}

// Canonical base64 shape: groups of 4 characters from the base64 alphabet,
// with correct trailing padding. This alone does not catch every
// non-canonical encoding (see the round-trip check below), but rejects
// obviously malformed input before attempting a decode.
const CANONICAL_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * Strictly decodes a base64 string to a Buffer, or returns undefined if the
 * string is not a canonical base64 encoding of *some* byte sequence.
 * Node's `Buffer.from(value, "base64")` alone is permissive — it silently
 * ignores invalid characters, incorrect padding, and inserted whitespace,
 * and can decode a corrupted string to the same byte length as a valid one.
 * The round-trip re-encode comparison below catches those cases (including
 * non-canonical "don't-care bit" variants that share the same decoded bytes
 * as a canonical encoding but are not what canonical encoding produces).
 */
function decodeStrictBase64(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !CANONICAL_BASE64_PATTERN.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    return undefined;
  }
  return decoded;
}

/**
 * Public shape of a key manager instance: the same four wrap/unwrap
 * operations, purpose-bound, regardless of whether the underlying
 * safeStorage is the real Electron object (production) or an injected fake
 * (unit tests). `createKeyManager()` and the module-level production
 * singleton are both built from this factory so their behavior can never
 * drift apart.
 */
export interface KeyManager {
  wrapRegistryDek(rawDek: Buffer): Promise<Buffer>;
  unwrapRegistryDek(wrappedDek: Buffer, persistRewrapped: PersistRewrappedDek): Promise<Buffer>;
  wrapWorkspaceDek(rawDek: Buffer): Promise<Buffer>;
  unwrapWorkspaceDek(wrappedDek: Buffer, persistRewrapped: PersistRewrappedDek): Promise<Buffer>;
}

async function assertAsyncEncryptionAvailable(
  safeStorage: SafeStorageLike,
  purpose: KeyPurpose,
): Promise<void> {
  let available: boolean;
  try {
    available = await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    fail(purpose, "availability check failed");
  }
  if (!available) {
    fail(purpose, "asynchronous encryption is not available");
  }
}

async function wrapDek(
  safeStorage: SafeStorageLike,
  purpose: KeyPurpose,
  rawDek: Buffer,
): Promise<Buffer> {
  await assertAsyncEncryptionAvailable(safeStorage, purpose);

  if (!Buffer.isBuffer(rawDek)) {
    throw new Error("Raw DEK must be a Buffer");
  }
  if (rawDek.length !== DEK_LENGTH) {
    throw new Error(`Raw DEK must be exactly ${DEK_LENGTH} bytes, received ${rawDek.length}`);
  }

  const base64Dek = rawDek.toString("base64");

  let wrapped: Buffer;
  try {
    wrapped = await safeStorage.encryptStringAsync(base64Dek);
  } catch {
    return fail(purpose, "encryption failed");
  }

  if (!Buffer.isBuffer(wrapped) || wrapped.length === 0) {
    return fail(purpose, "encryption returned an invalid result");
  }

  return wrapped;
}

async function unwrapDek(
  safeStorage: SafeStorageLike,
  purpose: KeyPurpose,
  wrappedDek: Buffer,
  persistRewrapped: PersistRewrappedDek,
): Promise<Buffer> {
  await assertAsyncEncryptionAvailable(safeStorage, purpose);

  if (!Buffer.isBuffer(wrappedDek) || wrappedDek.length === 0) {
    throw new Error("Wrapped DEK must be a non-empty Buffer");
  }

  let decryptResult: { result: string; shouldReEncrypt: boolean };
  try {
    decryptResult = await safeStorage.decryptStringAsync(wrappedDek);
  } catch {
    return fail(purpose, "decryption failed");
  }

  if (
    typeof decryptResult !== "object" ||
    decryptResult === null ||
    typeof decryptResult.result !== "string" ||
    typeof decryptResult.shouldReEncrypt !== "boolean" ||
    decryptResult.result.length === 0
  ) {
    return fail(purpose, "decryption returned an invalid result shape");
  }

  const decoded = decodeStrictBase64(decryptResult.result);
  if (!decoded) {
    return fail(purpose, "decrypted value is not valid canonical Base64");
  }
  if (decoded.length !== DEK_LENGTH) {
    return fail(purpose, `decoded key is not exactly ${DEK_LENGTH} bytes`);
  }

  if (decryptResult.shouldReEncrypt) {
    let rewrapped: Buffer;
    try {
      rewrapped = await safeStorage.encryptStringAsync(decryptResult.result);
    } catch {
      return fail(purpose, "re-wrap encryption failed");
    }
    if (!Buffer.isBuffer(rewrapped) || rewrapped.length === 0) {
      return fail(purpose, "re-wrap encryption returned an invalid result");
    }

    try {
      await persistRewrapped(rewrapped);
    } catch {
      return fail(purpose, "persisting the re-wrapped key failed");
    }
  }

  return decoded;
}

/**
 * Builds a KeyManager bound to the given safeStorage-like implementation.
 * The production singleton below and `createKeyManager()` (exported for
 * unit tests) both call this — it is the single shared implementation of
 * every wrap/unwrap behavior.
 */
function createKeyManagerCore(safeStorage: SafeStorageLike): KeyManager {
  return {
    wrapRegistryDek(rawDek: Buffer): Promise<Buffer> {
      return wrapDek(safeStorage, "registry", rawDek);
    },
    unwrapRegistryDek(wrappedDek: Buffer, persistRewrapped: PersistRewrappedDek): Promise<Buffer> {
      return unwrapDek(safeStorage, "registry", wrappedDek, persistRewrapped);
    },
    wrapWorkspaceDek(rawDek: Buffer): Promise<Buffer> {
      return wrapDek(safeStorage, "workspace", rawDek);
    },
    unwrapWorkspaceDek(wrappedDek: Buffer, persistRewrapped: PersistRewrappedDek): Promise<Buffer> {
      return unwrapDek(safeStorage, "workspace", wrappedDek, persistRewrapped);
    },
  };
}

/**
 * Test-oriented factory: builds a KeyManager bound to an injected
 * safeStorage-like implementation (typically a mock). Unit tests use this
 * instead of the production functions below, so they never load or depend
 * on the real Electron `safeStorage` object.
 */
export function createKeyManager(safeStorageLike: SafeStorageLike): KeyManager {
  return createKeyManagerCore(safeStorageLike);
}

// Production singleton, bound to the real Electron safeStorage imported at
// the top of this file. Under plain Node (e.g. Vitest, which never touches
// these production exports), `electronSafeStorage` is `undefined` because
// `require("electron")` outside a real Electron process resolves to a
// string path rather than the API object — harmless here, since this
// singleton's methods are only ever invoked from real Electron main-process
// code or Playwright's real-Electron contract test.
const productionKeyManager = createKeyManagerCore(electronSafeStorage);

export function wrapRegistryDek(rawDek: Buffer): Promise<Buffer> {
  return productionKeyManager.wrapRegistryDek(rawDek);
}

export function unwrapRegistryDek(
  wrappedDek: Buffer,
  persistRewrapped: PersistRewrappedDek,
): Promise<Buffer> {
  return productionKeyManager.unwrapRegistryDek(wrappedDek, persistRewrapped);
}

export function wrapWorkspaceDek(rawDek: Buffer): Promise<Buffer> {
  return productionKeyManager.wrapWorkspaceDek(rawDek);
}

export function unwrapWorkspaceDek(
  wrappedDek: Buffer,
  persistRewrapped: PersistRewrappedDek,
): Promise<Buffer> {
  return productionKeyManager.unwrapWorkspaceDek(wrappedDek, persistRewrapped);
}
