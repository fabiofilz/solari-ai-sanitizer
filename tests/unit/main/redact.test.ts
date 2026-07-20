import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertSafeLogEvent,
  entityId,
  formatSafeLogEvent,
  logSafeEvent,
  redactUnknownError,
  RedactionViolationError,
  SafeError,
  SAFE_CATEGORIES,
  SAFE_CODES,
  toSafeError,
  workspaceId,
  type SafeLogEvent,
} from "../../../src/main/logging/redact";

// Unit tests for T030/T031 (research.md #10 redaction rules; constitution
// Principle I). This module has no free-text field anywhere: category and
// code are drawn only from closed, application-defined sets, and id is a
// branded SafeId obtainable only through workspaceId()/entityId(), which
// validate a strict, non-sensitive identifier shape. There is no length-cap
// escape hatch — a short customer name, password, or text fragment is
// rejected by construction, not by pattern-matching its content. Every
// protected value below is synthetic (constitution Principle VI).

const SYNTHETIC_RAW_DEK = Buffer.alloc(32, 0x5a);
const SYNTHETIC_WRAPPED_DEK = Buffer.from("synthetic-wrapped-dek-marker-QWxsWW91ck", "utf8");
const SYNTHETIC_DERIVED_SUBKEY = Buffer.alloc(32, 0x11);
const SYNTHETIC_NONCE = Buffer.alloc(12, 0x22);
const SYNTHETIC_AUTH_TAG = Buffer.alloc(16, 0x33);
const SYNTHETIC_CIPHERTEXT = Buffer.from("synthetic-ciphertext-blob-marker-9f8e7d6c", "utf8");
const SYNTHETIC_ORIGINAL_TEXT = "synthetic-original-text-fragment-do-not-log";
const SYNTHETIC_RESTORED_TEXT = "synthetic-restored-text-fragment-do-not-log";
const SYNTHETIC_CUSTOMER_NAME = "Acme Synthetic Consultoria Ltda";
const SYNTHETIC_PASSWORD = "hunter2-synthetic";
const SYNTHETIC_TOKEN = "synthtok_9f8e7d6c5b4a";
const SYNTHETIC_ARBITRARY_CODE = "TOTALLY_MADE_UP_CODE_XYZ";

const BUFFER_MARKERS: Array<{ label: string; value: Buffer }> = [
  { label: "raw DEK", value: SYNTHETIC_RAW_DEK },
  { label: "wrapped DEK", value: SYNTHETIC_WRAPPED_DEK },
  { label: "derived subkey", value: SYNTHETIC_DERIVED_SUBKEY },
  { label: "nonce", value: SYNTHETIC_NONCE },
  { label: "authentication tag", value: SYNTHETIC_AUTH_TAG },
  { label: "ciphertext blob", value: SYNTHETIC_CIPHERTEXT },
];

const STRING_MARKERS: Array<{ label: string; value: string }> = [
  { label: "original text fragment", value: SYNTHETIC_ORIGINAL_TEXT },
  { label: "restored text fragment", value: SYNTHETIC_RESTORED_TEXT },
  { label: "customer name", value: SYNTHETIC_CUSTOMER_NAME },
  { label: "password", value: SYNTHETIC_PASSWORD },
  { label: "token", value: SYNTHETIC_TOKEN },
];

function allSpyOutputText(spies: Array<ReturnType<typeof vi.spyOn>>): string {
  return spies
    .flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" ")))
    .join("\n");
}

describe("redact: closed category/code sets", () => {
  it("SAFE_CATEGORIES and SAFE_CODES are non-empty, fixed literal sets", () => {
    expect(SAFE_CATEGORIES.length).toBeGreaterThan(0);
    expect(SAFE_CODES.length).toBeGreaterThan(0);
    expect(SAFE_CODES).toContain("UNKNOWN_ERROR");
  });

  it("accepts every category in the closed set", () => {
    for (const category of SAFE_CATEGORIES) {
      expect(() => assertSafeLogEvent({ category })).not.toThrow();
    }
  });

  it("accepts every code in the closed set", () => {
    for (const code of SAFE_CODES) {
      expect(() => assertSafeLogEvent({ category: "UNKNOWN", code })).not.toThrow();
    }
  });

  it("rejects a category outside the closed set", () => {
    expect(() =>
      assertSafeLogEvent({ category: "NOT_A_REAL_CATEGORY" } as unknown as SafeLogEvent),
    ).toThrow(RedactionViolationError);
  });

  it("rejects an arbitrary UPPER_SNAKE_CASE-shaped code that is not in the closed allowlist", () => {
    expect(() =>
      assertSafeLogEvent({
        category: "KEY_MANAGER",
        code: SYNTHETIC_ARBITRARY_CODE,
      } as unknown as SafeLogEvent),
    ).toThrow(RedactionViolationError);
  });

  it("rejects a lowercase or malformed category/code even if a substring matches a real one", () => {
    expect(() =>
      assertSafeLogEvent({ category: "key_manager" } as unknown as SafeLogEvent),
    ).toThrow(RedactionViolationError);
    expect(() =>
      assertSafeLogEvent({
        category: "KEY_MANAGER",
        code: "registry_key_unavailable",
      } as unknown as SafeLogEvent),
    ).toThrow(RedactionViolationError);
  });
});

describe("redact: SafeId construction (workspaceId / entityId)", () => {
  it("workspaceId accepts a canonical UUID", () => {
    const id = workspaceId("11111111-2222-3333-4444-555555555555");
    expect(() => assertSafeLogEvent({ category: "KEY_MANAGER", id })).not.toThrow();
  });

  it("entityId accepts a positive integer, as a number or as a numeric string", () => {
    const fromNumber = entityId(42);
    const fromString = entityId("42");
    expect(() => assertSafeLogEvent({ category: "KEY_MANAGER", id: fromNumber })).not.toThrow();
    expect(() => assertSafeLogEvent({ category: "KEY_MANAGER", id: fromString })).not.toThrow();
  });

  it("workspaceId rejects a non-UUID string, including an entity-style integer id", () => {
    expect(() => workspaceId("42")).toThrow(RedactionViolationError);
    expect(() => workspaceId("not-a-uuid")).toThrow(RedactionViolationError);
    expect(() => workspaceId("")).toThrow(RedactionViolationError);
  });

  it("entityId rejects zero, negative numbers, non-integers, and UUID-style strings", () => {
    expect(() => entityId(0)).toThrow(RedactionViolationError);
    expect(() => entityId(-1)).toThrow(RedactionViolationError);
    expect(() => entityId(1.5)).toThrow(RedactionViolationError);
    expect(() => entityId("11111111-2222-3333-4444-555555555555")).toThrow(RedactionViolationError);
    expect(() => entityId("007")).toThrow(RedactionViolationError);
  });

  for (const marker of STRING_MARKERS) {
    it(`workspaceId and entityId both reject a ${marker.label}`, () => {
      expect(() => workspaceId(marker.value)).toThrow(RedactionViolationError);
      expect(() => entityId(marker.value)).toThrow(RedactionViolationError);
    });
  }

  for (const marker of BUFFER_MARKERS) {
    it(`workspaceId and entityId both reject a ${marker.label} Buffer`, () => {
      expect(() => workspaceId(marker.value as unknown as string)).toThrow(RedactionViolationError);
      expect(() => entityId(marker.value as unknown as string)).toThrow(RedactionViolationError);
    });
  }

  it("assertSafeLogEvent re-validates id shape even if a caller bypasses the constructors with a bad-faith cast", () => {
    for (const marker of [
      ...STRING_MARKERS,
      { label: "arbitrary code-shaped string", value: SYNTHETIC_ARBITRARY_CODE },
    ]) {
      const event = {
        category: "KEY_MANAGER",
        id: marker.value,
      } as unknown as SafeLogEvent;
      expect(() => assertSafeLogEvent(event)).toThrow(RedactionViolationError);
    }
    for (const marker of BUFFER_MARKERS) {
      const event = { category: "KEY_MANAGER", id: marker.value } as unknown as SafeLogEvent;
      expect(() => assertSafeLogEvent(event)).toThrow(RedactionViolationError);
    }
  });

  it("never includes the offending value in the RedactionViolationError message, only the field name and its kind", () => {
    let caught: unknown;
    try {
      workspaceId(SYNTHETIC_CUSTOMER_NAME);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RedactionViolationError);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).not.toContain(SYNTHETIC_CUSTOMER_NAME);
    expect(message).toContain("workspaceId");
  });
});

describe("redact: no metadata escape hatch exists", () => {
  it("a SafeLogEvent carrying an unexpected 'metadata' field is still only ever serialized to category/code/id", () => {
    const eventWithStrayField = {
      category: "KEY_MANAGER",
      code: "REGISTRY_KEY_UNAVAILABLE",
      metadata: { note: SYNTHETIC_ORIGINAL_TEXT },
    } as unknown as SafeLogEvent;

    const line = formatSafeLogEvent(eventWithStrayField);
    expect(line).not.toContain(SYNTHETIC_ORIGINAL_TEXT);
    expect(JSON.parse(line)).toEqual({
      category: "KEY_MANAGER",
      code: "REGISTRY_KEY_UNAVAILABLE",
    });
  });
});

describe("redact: formatSafeLogEvent / logSafeEvent output", () => {
  it("formatSafeLogEvent returns a JSON string containing only category/code/id", () => {
    const event: SafeLogEvent = {
      category: "KEY_MANAGER",
      code: "REGISTRY_KEY_UNAVAILABLE",
      id: workspaceId("11111111-2222-3333-4444-555555555555"),
    };
    const line = formatSafeLogEvent(event);
    expect(JSON.parse(line)).toEqual({
      category: "KEY_MANAGER",
      code: "REGISTRY_KEY_UNAVAILABLE",
      id: "11111111-2222-3333-4444-555555555555",
    });
  });

  it("omits absent optional fields from the serialized output", () => {
    const line = formatSafeLogEvent({ category: "PERSISTENCE" });
    expect(Object.keys(JSON.parse(line))).toEqual(["category"]);
  });

  it("logSafeEvent writes exactly the formatted line to the provided sink", () => {
    const sink = vi.fn();
    const event: SafeLogEvent = { category: "PERSISTENCE", code: "UNKNOWN_ERROR" };
    logSafeEvent(event, sink);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(formatSafeLogEvent(event));
  });

  it("logSafeEvent defaults to console.error when no sink is given", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      logSafeEvent({ category: "PERSISTENCE", code: "UNKNOWN_ERROR" });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logSafeEvent fails closed: an unsafe event throws before the sink is ever invoked", () => {
    const sink = vi.fn();
    const unsafeEvent = {
      category: "KEY_MANAGER",
      id: SYNTHETIC_PASSWORD,
    } as unknown as SafeLogEvent;
    expect(() => logSafeEvent(unsafeEvent, sink)).toThrow(RedactionViolationError);
    expect(sink).not.toHaveBeenCalled();
  });
});

describe("redact: SafeError / toSafeError", () => {
  it("constructs a SafeError whose message is exactly the safe formatted line", () => {
    const event: SafeLogEvent = { category: "KEY_MANAGER", code: "WORKSPACE_KEY_UNAVAILABLE" };
    const err = toSafeError(event);
    expect(err).toBeInstanceOf(SafeError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SafeError");
    expect(err.category).toBe("KEY_MANAGER");
    expect(err.code).toBe("WORKSPACE_KEY_UNAVAILABLE");
    expect(err.message).toBe(formatSafeLogEvent(event));
  });

  it("refuses to construct a SafeError from an unsafe event", () => {
    expect(() =>
      toSafeError({ category: "KEY_MANAGER", id: SYNTHETIC_TOKEN } as unknown as SafeLogEvent),
    ).toThrow(RedactionViolationError);
  });

  it("is frozen: a caller cannot mutate message/category/code, or attach new properties, after construction", () => {
    const err = toSafeError({ category: "KEY_MANAGER", code: "REGISTRY_KEY_UNAVAILABLE" });
    const originalMessage = err.message;

    expect(() => {
      (err as { message: string }).message = `leaked: ${SYNTHETIC_ORIGINAL_TEXT}`;
    }).toThrow();
    expect(() => {
      (err as { category: string }).category = "PERSISTENCE";
    }).toThrow();
    expect(() => {
      (err as unknown as Record<string, unknown>).extra = SYNTHETIC_ORIGINAL_TEXT;
    }).toThrow();

    expect(err.message).toBe(originalMessage);
    expect(Object.isFrozen(err)).toBe(true);
  });

  it("JSON.stringify(SafeError) never includes anything beyond its safe own properties", () => {
    const err = toSafeError({
      category: "KEY_MANAGER",
      code: "REGISTRY_KEY_UNAVAILABLE",
      id: workspaceId("11111111-2222-3333-4444-555555555555"),
    });
    const serialized = JSON.stringify(err);
    for (const marker of [
      ...BUFFER_MARKERS.map((m) => m.value.toString("hex")),
      ...STRING_MARKERS.map((m) => m.value),
    ]) {
      expect(serialized ?? "").not.toContain(marker);
    }
  });
});

describe("redact: redactUnknownError never forwards arbitrary Error.message/stack/cause", () => {
  const context: SafeLogEvent = { category: "KEY_MANAGER", code: "REGISTRY_KEY_UNAVAILABLE" };

  it("drops the message of a plain Error containing sensitive content", () => {
    const leaky = new Error(`decryption failed, plaintext was: ${SYNTHETIC_ORIGINAL_TEXT}`);
    const result = redactUnknownError(leaky, context);
    const line = formatSafeLogEvent(result);
    expect(line).not.toContain(SYNTHETIC_ORIGINAL_TEXT);
    expect(result).toEqual(context);
  });

  it("drops a sensitive .cause chain", () => {
    const leaky = new Error("outer failure", {
      cause: new Error(`inner cause: ${SYNTHETIC_RESTORED_TEXT}`),
    });
    const result = redactUnknownError(leaky, context);
    expect(formatSafeLogEvent(result)).not.toContain(SYNTHETIC_RESTORED_TEXT);
  });

  it("drops the stack trace of a sensitive Error", () => {
    const leaky = new Error("failure");
    leaky.stack = `Error: failure\n    at ${SYNTHETIC_CUSTOMER_NAME}`;
    const result = redactUnknownError(leaky, context);
    expect(formatSafeLogEvent(result)).not.toContain(SYNTHETIC_CUSTOMER_NAME);
  });

  it("carries through a .code property only when it belongs to the closed SAFE_CODES allowlist", () => {
    const keyManagerLikeError = {
      name: "KeyManagerError",
      code: "WORKSPACE_KEY_UNAVAILABLE",
      message: `workspace key unavailable, dek was: ${SYNTHETIC_PASSWORD}`,
    };
    const result = redactUnknownError(keyManagerLikeError, context);
    expect(result.code).toBe("WORKSPACE_KEY_UNAVAILABLE");
    expect(formatSafeLogEvent(result)).not.toContain(SYNTHETIC_PASSWORD);
  });

  it("ignores an UPPER_SNAKE_CASE-shaped .code that is not in the closed allowlist and falls back to context.code", () => {
    const malicious = { code: SYNTHETIC_ARBITRARY_CODE, message: "x" };
    const result = redactUnknownError(malicious, context);
    expect(result.code).toBe(context.code);
    expect(result.code).not.toBe(SYNTHETIC_ARBITRARY_CODE);
  });

  it("falls back to UNKNOWN_ERROR when context supplies no code and the error's code is unrecognized", () => {
    const result = redactUnknownError(new Error("x"), { category: "UNKNOWN" });
    expect(result.code).toBe("UNKNOWN_ERROR");
  });

  it("handles a thrown non-Error value (e.g. a raw secret Buffer thrown directly) without leaking it", () => {
    const result = redactUnknownError(SYNTHETIC_RAW_DEK, context);
    expect(result).toEqual(context);
  });

  it("handles a thrown plain string without leaking it", () => {
    const result = redactUnknownError(`leaked ${SYNTHETIC_ORIGINAL_TEXT}`, context);
    expect(result).toEqual(context);
  });

  it("handles a thrown arbitrary object with unexpected fields without leaking any of them", () => {
    const thrown = {
      customerName: SYNTHETIC_CUSTOMER_NAME,
      password: SYNTHETIC_PASSWORD,
      dek: SYNTHETIC_RAW_DEK,
    };
    const result = redactUnknownError(thrown, context);
    const line = formatSafeLogEvent(result);
    expect(line).not.toContain(SYNTHETIC_CUSTOMER_NAME);
    expect(line).not.toContain(SYNTHETIC_PASSWORD);
    expect(result).toEqual(context);
  });
});

describe("redact: comprehensive sweep — no protected value ever reaches console/stdout/stderr", () => {
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

  it("sweeps every protected category through every realistic entry point", () => {
    const context: SafeLogEvent = { category: "KEY_MANAGER", code: "REGISTRY_KEY_UNAVAILABLE" };
    const allMarkers: Array<Buffer | string> = [
      ...BUFFER_MARKERS.map((m) => m.value),
      ...STRING_MARKERS.map((m) => m.value),
      SYNTHETIC_ARBITRARY_CODE,
    ];

    for (const marker of allMarkers) {
      // Direct id/category/code injection attempts.
      for (const attempt of [
        () => logSafeEvent({ category: "KEY_MANAGER", id: marker as unknown as string }),
        () => logSafeEvent({ category: marker as unknown as SafeCategoryLike, code: undefined }),
        () =>
          logSafeEvent({
            category: "KEY_MANAGER",
            code: marker as unknown as string,
          } as unknown as SafeLogEvent),
        () => toSafeError({ category: "KEY_MANAGER", id: marker as unknown as string }),
        () => workspaceId(marker as unknown as string),
        () => entityId(marker as unknown as string),
      ]) {
        try {
          attempt();
        } catch {
          // expected for every unsafe marker
        }
      }

      // Realistic leak paths: error message/cause/stack, and a thrown raw value.
      const leaky = new Error(`failure detail: ${String(marker)}`, {
        cause: new Error(String(marker)),
      });
      leaky.stack = `Error\n    at ${String(marker)}`;
      logSafeEvent(redactUnknownError(leaky, context));
      logSafeEvent(redactUnknownError(marker, context));
    }

    const output = allSpyOutputText([logSpy, warnSpy, errorSpy, stdoutSpy, stderrSpy]);
    for (const marker of BUFFER_MARKERS) {
      expect(output).not.toContain(marker.value.toString("hex"));
      expect(output).not.toContain(marker.value.toString("base64"));
      expect(output).not.toContain(marker.value.toString("utf8"));
    }
    for (const marker of STRING_MARKERS) {
      expect(output).not.toContain(marker.value);
    }
    expect(output).not.toContain(SYNTHETIC_ARBITRARY_CODE);
  });
});

describe("redact: safe diagnostic fields remain available for troubleshooting", () => {
  it("a fully-populated safe event's category, code, and id are all present in the logged output", () => {
    const sink = vi.fn();
    const event: SafeLogEvent = {
      category: "KEY_MANAGER",
      code: "REGISTRY_KEY_UNAVAILABLE",
      id: workspaceId("11111111-2222-3333-4444-555555555555"),
    };
    logSafeEvent(event, sink);

    expect(sink).toHaveBeenCalledTimes(1);
    const line = sink.mock.calls[0][0] as string;
    expect(line).toContain("KEY_MANAGER");
    expect(line).toContain("REGISTRY_KEY_UNAVAILABLE");
    expect(line).toContain("11111111-2222-3333-4444-555555555555");
  });

  it("every closed category and code remains individually usable end to end", () => {
    for (const category of SAFE_CATEGORIES) {
      for (const code of SAFE_CODES) {
        const sink = vi.fn();
        logSafeEvent({ category, code }, sink);
        expect(sink).toHaveBeenCalledTimes(1);
      }
    }
  });
});

// Local alias only for the sweep test's deliberately-mistyped category attempt.
type SafeCategoryLike = SafeLogEvent["category"];
