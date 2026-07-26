// Per-workspace worker orchestration (T045; research.md #11). Manages one
// translation worker per open workspace as an opaque object: creation,
// dictionary-snapshot seeding (only when the version actually changes),
// requestId-based supersession bookkeeping so a stale in-flight result is
// dropped rather than delivered, and crash detection with automatic
// recreation + reseeding. Never touches SQLite, safeStorage, or any
// decrypted value directly — the caller supplies an already-decrypted
// DictionarySnapshot; this module only forwards it.
//
// WorkerLike/createWorker are injected (WorkerManagerDeps), exactly like
// this codebase's other real-resource boundaries (CreateWorkspaceDeps.
// createWorkspaceFile, DeletionReconcilerDeps.closeWorkspaceResources): the
// real node:worker_threads Worker is never imported here, so this module is
// fully unit-testable without spawning a real worker thread, and
// translation-worker.ts's real content is never required at test time —
// only its path (supplied by whichever future caller constructs a
// production WorkerManager) matters at runtime.

export interface DictionarySnapshot {
  version: number;
  terms: ReadonlyArray<{ originalValue: string; placeholder: string }>;
}

export type TranslateDirection = "sanitize" | "restore";

export interface TranslateRequest {
  requestId: number;
  direction: TranslateDirection;
  text: string;
}

export type TranslateResult =
  | { requestId: number; ok: true; text: string }
  | {
      requestId: number;
      ok: false;
      error: "WORKER_CRASHED" | "SUPERSEDED" | "HANDLER_NOT_CONFIGURED";
    };

/**
 * The wire shape translation-worker.ts (T044) actually posts back. `direction`
 * is required, not optional: research.md #11 scopes `requestId` "per
 * (workspace, direction) pair," so a sanitize request and a restore request
 * legitimately can share the same numeric requestId — without `direction`
 * here there would be no way to route such a response to the correct one of
 * two colliding pending requests.
 */
interface RawWorkerMessage {
  requestId: number;
  direction: TranslateDirection;
  ok: boolean;
  text?: string;
  error?: "HANDLER_NOT_CONFIGURED";
}

/**
 * Structural subset of node:worker_threads' Worker this module depends on.
 * The real Worker class satisfies this shape; unit tests inject a fake.
 */
export interface WorkerLike {
  postMessage(message: unknown): void;
  on(event: string, listener: (...args: never[]) => void): void;
  terminate(): Promise<number> | number;
}

export interface WorkerManagerDeps {
  workerScriptPath: string;
  createWorker: (scriptPath: string) => WorkerLike;
}

export interface WorkspaceWorkerManager {
  /**
   * Creates the workspace's worker on first call, seeding it with the
   * given snapshot. On a later call for an already-running worker, reseeds
   * only if `snapshot.version` differs from the version last seeded
   * (research.md #11: "only when the version changes... A request against
   * an up-to-date worker snapshot skips this step entirely").
   */
  ensureWorker(workspaceId: string, snapshot: DictionarySnapshot): void;
  /**
   * Sends one translate request to the workspace's worker. Resolves with
   * the worker's real response, WORKER_CRASHED if the worker fails before
   * responding, or SUPERSEDED if a newer request for the same (workspace,
   * direction) was issued before this one's response arrived (research.md
   * #11: "the older one's eventual result is simply tagged as stale and
   * dropped when it completes" — no preemptive cancellation).
   */
  sendRequest(workspaceId: string, request: TranslateRequest): Promise<TranslateResult>;
  /** Deliberately terminates a workspace's worker; never treated as a crash. */
  terminateWorker(workspaceId: string): Promise<void>;
}

interface PendingEntry {
  requestId: number;
  direction: TranslateDirection;
  resolve: (result: TranslateResult) => void;
}

interface WorkspaceRecord {
  worker: WorkerLike;
  snapshot: DictionarySnapshot;
  /** Keyed by pendingKey(direction, requestId) — never requestId alone, since
   * requestId is only unique within one direction (research.md #11). */
  pending: Map<string, PendingEntry>;
  /** The latest requestId issued per direction, for supersession bookkeeping. */
  latestRequestIdByDirection: Map<TranslateDirection, number>;
}

function pendingKey(direction: TranslateDirection, requestId: number): string {
  return `${direction}:${requestId}`;
}

export function createWorkerManager(deps: WorkerManagerDeps): WorkspaceWorkerManager {
  const records = new Map<string, WorkspaceRecord>();

  function spawnWorker(workspaceId: string, snapshot: DictionarySnapshot): WorkspaceRecord {
    const worker = deps.createWorker(deps.workerScriptPath);
    const record: WorkspaceRecord = {
      worker,
      snapshot,
      pending: new Map(),
      latestRequestIdByDirection: new Map(),
    };
    records.set(workspaceId, record);

    worker.postMessage({ type: "seed", snapshot });

    worker.on("message", (message: RawWorkerMessage) => {
      const key = pendingKey(message.direction, message.requestId);
      const entry = record.pending.get(key);
      if (!entry) {
        return;
      }
      record.pending.delete(key);

      const latest = record.latestRequestIdByDirection.get(entry.direction);
      if (latest !== undefined && latest !== entry.requestId) {
        entry.resolve({ requestId: entry.requestId, ok: false, error: "SUPERSEDED" });
        return;
      }
      if (message.ok) {
        entry.resolve({ requestId: entry.requestId, ok: true, text: message.text ?? "" });
      } else {
        entry.resolve({
          requestId: entry.requestId,
          ok: false,
          error: message.error ?? "HANDLER_NOT_CONFIGURED",
        });
      }
    });

    const handleCrash = (): void => {
      // A stale event from a worker already replaced/terminated for this
      // workspace (e.g. terminateWorker() already removed this exact
      // record) is a no-op — not a real crash to recover from.
      if (records.get(workspaceId) !== record) {
        return;
      }
      records.delete(workspaceId);
      for (const entry of record.pending.values()) {
        entry.resolve({ requestId: entry.requestId, ok: false, error: "WORKER_CRASHED" });
      }
      spawnWorker(workspaceId, record.snapshot);
    };

    worker.on("error", handleCrash);
    worker.on("exit", handleCrash);

    return record;
  }

  function ensureWorker(workspaceId: string, snapshot: DictionarySnapshot): void {
    const existing = records.get(workspaceId);
    if (!existing) {
      spawnWorker(workspaceId, snapshot);
      return;
    }
    if (existing.snapshot.version !== snapshot.version) {
      existing.snapshot = snapshot;
      existing.worker.postMessage({ type: "seed", snapshot });
    }
  }

  function sendRequest(workspaceId: string, request: TranslateRequest): Promise<TranslateResult> {
    const record = records.get(workspaceId);
    if (!record) {
      throw new Error("ensureWorker() must be called before sendRequest() for this workspace");
    }

    record.latestRequestIdByDirection.set(request.direction, request.requestId);

    return new Promise<TranslateResult>((resolve) => {
      record.pending.set(pendingKey(request.direction, request.requestId), {
        requestId: request.requestId,
        direction: request.direction,
        resolve,
      });
      record.worker.postMessage({ type: "translate", ...request });
    });
  }

  async function terminateWorker(workspaceId: string): Promise<void> {
    const record = records.get(workspaceId);
    if (!record) {
      return;
    }
    records.delete(workspaceId);
    await record.worker.terminate();
  }

  return { ensureWorker, sendRequest, terminateWorker };
}
