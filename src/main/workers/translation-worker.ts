import { parentPort } from "node:worker_threads";
import type { DictionarySnapshot } from "../persistence/worker-manager";

// The worker_threads entry point (T044, redefined — tasks.md's revision
// note; research.md #11). Scope: ONLY the transport/protocol boundary —
// receiving a dictionary-snapshot "seed" message and a "translate" request,
// and replying over parentPort. This module deliberately never imports
// domain/sanitizer or domain/restorer: both are built by later, out-of-scope
// tasks (T079 for sanitize, T090 for restore). Building/reusing the
// matching structures (the Aho-Corasick automaton, the placeholder-token
// scanner) from the snapshot happens inside those modules once T079/T090
// wire them in here — not in this transport layer.
//
// A "translate" message currently always resolves HANDLER_NOT_CONFIGURED.
// This is real, honest protocol behavior — not a stub pretending
// sanitize/restore succeeded or failed for a domain reason — exactly like an
// HTTP router truthfully reporting 404 for a route nobody has registered
// yet. T079/T090 each replace their own branch below with a real call once
// their module exists; until then, no fabricated translation result is ever
// produced.
//
// Exported as a plain function (createTranslationWorkerState +
// handleTranslationWorkerMessage) so tests/unit/main/translation-worker.test.ts
// can exercise it directly without spawning a real worker_threads Worker
// (research.md #7's established pattern for domain-ish logic). The real
// parentPort wiring below only runs when this file is actually loaded inside
// a worker thread (parentPort is null in the main thread and under Vitest).

export type TranslateDirection = "sanitize" | "restore";

export type IncomingWorkerMessage =
  | { type: "seed"; snapshot: DictionarySnapshot }
  | { type: "translate"; requestId: number; direction: TranslateDirection; text: string };

// `direction` is echoed back on every response — not just `requestId` — since
// research.md #11 scopes `requestId` "per (workspace, direction) pair," so a
// sanitize request and a restore request against the same worker can
// legitimately share the same numeric requestId. Without `direction` in the
// response, worker-manager.ts (T045) would have no way to route such a
// response to the correct one of two colliding pending requests.
export type OutgoingWorkerMessage =
  | { requestId: number; direction: TranslateDirection; ok: true; text: string }
  | {
      requestId: number;
      direction: TranslateDirection;
      ok: false;
      error: "HANDLER_NOT_CONFIGURED";
    };

export interface TranslationWorkerState {
  snapshot: DictionarySnapshot | undefined;
}

export function createTranslationWorkerState(): TranslationWorkerState {
  return { snapshot: undefined };
}

/**
 * Handles one incoming worker message against the given state, returning the
 * response to post back (or undefined for a "seed" message, which never
 * produces a reply).
 */
export function handleTranslationWorkerMessage(
  state: TranslationWorkerState,
  message: IncomingWorkerMessage,
): OutgoingWorkerMessage | undefined {
  if (message.type === "seed") {
    state.snapshot = message.snapshot;
    return undefined;
  }

  // message.type === "translate": neither the "sanitize" nor "restore"
  // direction has a real handler wired in yet (T079/T090, respectively).
  return {
    requestId: message.requestId,
    direction: message.direction,
    ok: false,
    error: "HANDLER_NOT_CONFIGURED",
  };
}

if (parentPort) {
  const state = createTranslationWorkerState();
  parentPort.on("message", (message: IncomingWorkerMessage) => {
    const response = handleTranslationWorkerMessage(state, message);
    if (response !== undefined) {
      parentPort?.postMessage(response);
    }
  });
}
