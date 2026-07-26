import { describe, expect, it } from "vitest";
import {
  createTranslationWorkerState,
  handleTranslationWorkerMessage,
} from "../../../src/main/workers/translation-worker";

// T044 (redefined — see tasks.md's revision note; research.md #11). Written
// and confirmed to fail before src/main/workers/translation-worker.ts
// exists.
//
// Scope: T044 is now only the transport/protocol boundary — receiving a
// dictionary-snapshot "seed" message and responding to a "translate"
// message. It deliberately never imports domain/sanitizer or
// domain/restorer (both built later, by out-of-scope tasks T079/T090).
// Tested here as a plain function (no real worker_threads Worker spawned),
// per research.md #7/#11's own established pattern of exercising domain-ish
// logic directly with Vitest and reserving real-environment behavior for
// Playwright (the real worker_threads entry-point wiring itself is
// end-to-end-covered once US1 lands, by the scale/responsiveness
// integration tests in Phase 9 — T153/T154 — which exercise a real worker
// thread under `translation:sanitize`).
//
// IMPORTANT — this test's HANDLER_NOT_CONFIGURED assertions are temporary:
// once T079 wires domain/sanitizer's sanitize() into the "sanitize" branch
// below, and T090 wires domain/restorer's restore() into the "restore"
// branch, both assertions must be replaced with real sanitize/restore
// assertions referencing those tasks — not loosened or deleted.

function snapshot(version: number) {
  return { version, terms: [{ originalValue: "Synthetic Corp", placeholder: "COMPANY_1" }] };
}

describe("translation-worker transport/protocol boundary", () => {
  it("stores the dictionary snapshot from a seed message without producing a response", () => {
    const state = createTranslationWorkerState();
    expect(state.snapshot).toBeUndefined();

    const response = handleTranslationWorkerMessage(state, {
      type: "seed",
      snapshot: snapshot(1),
    });

    expect(response).toBeUndefined();
    expect(state.snapshot).toEqual(snapshot(1));
  });

  it("a later seed message replaces the previously stored snapshot", () => {
    const state = createTranslationWorkerState();
    handleTranslationWorkerMessage(state, { type: "seed", snapshot: snapshot(1) });
    handleTranslationWorkerMessage(state, { type: "seed", snapshot: snapshot(2) });

    expect(state.snapshot).toEqual(snapshot(2));
  });

  it("responds HANDLER_NOT_CONFIGURED for a 'sanitize' translate message — replace with a real assertion once T079 wires domain/sanitizer in", () => {
    const state = createTranslationWorkerState();
    handleTranslationWorkerMessage(state, { type: "seed", snapshot: snapshot(1) });

    const response = handleTranslationWorkerMessage(state, {
      type: "translate",
      requestId: 1,
      direction: "sanitize",
      text: "hello",
    });

    expect(response).toEqual({
      requestId: 1,
      direction: "sanitize",
      ok: false,
      error: "HANDLER_NOT_CONFIGURED",
    });
  });

  it("responds HANDLER_NOT_CONFIGURED for a 'restore' translate message — replace with a real assertion once T090 wires domain/restorer in", () => {
    const state = createTranslationWorkerState();
    handleTranslationWorkerMessage(state, { type: "seed", snapshot: snapshot(1) });

    const response = handleTranslationWorkerMessage(state, {
      type: "translate",
      requestId: 2,
      direction: "restore",
      text: "COMPANY_1",
    });

    expect(response).toEqual({
      requestId: 2,
      direction: "restore",
      ok: false,
      error: "HANDLER_NOT_CONFIGURED",
    });
  });

  it("responds HANDLER_NOT_CONFIGURED for a translate message even before any seed message has arrived", () => {
    const state = createTranslationWorkerState();

    const response = handleTranslationWorkerMessage(state, {
      type: "translate",
      requestId: 3,
      direction: "sanitize",
      text: "hello",
    });

    expect(response).toEqual({
      requestId: 3,
      direction: "sanitize",
      ok: false,
      error: "HANDLER_NOT_CONFIGURED",
    });
  });
});
