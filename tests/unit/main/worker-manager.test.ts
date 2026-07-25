import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkerManager,
  type DictionarySnapshot,
  type WorkerLike,
  type WorkerManagerDeps,
} from "../../../src/main/persistence/worker-manager";

// T043 (research.md #11; constitution Principle VI). Written and confirmed
// to fail before src/main/persistence/worker-manager.ts exists — the import
// above fails with a real module-resolution error, not a manufactured one.
//
// Scope note (explicitly disclosed, not hidden): this test is NOT made to
// pass in this session. Its implementing task, T045, depends on T044
// (translation-worker.ts), which itself depends on domain/sanitizer and
// domain/restorer — both built by later, out-of-scope tasks (T079/T090).
// Rather than leave this file as a bare import-only stub, the full set of
// crash-recovery assertions T043 specifies is written now, against a
// worker-manager.ts public interface designed directly from research.md
// #11's own described responsibilities (dictionary-version-tagged snapshot
// seeding, requestId-based supersession, crash detection with automatic
// worker recreation and reseeding). This interface is provisional — T045
// implements the real module against it, exactly as T039/T040 implemented
// deletion-reconciler.ts against the interface T038 had already committed
// to.
//
// Dependency injection (not `vi.mock("node:worker_threads")`) follows this
// codebase's existing pattern for testing anything that would otherwise
// touch a real OS/runtime resource (compare CreateWorkspaceDeps.createWorkspaceFile,
// DeletionReconcilerDeps.closeWorkspaceResources): WorkerManagerDeps.createWorker
// is an injected factory, so no worker thread is ever actually spawned and
// translation-worker.ts's real content is never required for this test to
// run — only its path (never resolved here) needs to exist in production.

class FakeWorker extends EventEmitter implements WorkerLike {
  readonly postMessageCalls: unknown[] = [];
  terminateCalls = 0;

  postMessage(message: unknown): void {
    this.postMessageCalls.push(message);
  }

  terminate(): Promise<number> {
    this.terminateCalls += 1;
    return Promise.resolve(0);
  }
}

function snapshot(version: number): DictionarySnapshot {
  return { version, terms: [{ originalValue: "Synthetic Corp", placeholder: "COMPANY_1" }] };
}

describe("worker-manager crash recovery", () => {
  it("fails in-flight requests cleanly and reseeds a freshly recreated worker with the current dictionary snapshot on a worker 'error' event", async () => {
    const createdWorkers: FakeWorker[] = [];
    const createWorker = vi.fn((_scriptPath: string) => {
      const worker = new FakeWorker();
      createdWorkers.push(worker);
      return worker;
    });

    const deps: WorkerManagerDeps = {
      workerScriptPath: "/fake/translation-worker.js",
      createWorker,
    };

    const manager = createWorkerManager(deps);
    const workspaceId = "11111111-1111-1111-1111-111111111111";

    manager.ensureWorker(workspaceId, snapshot(1));
    expect(createdWorkers).toHaveLength(1);
    expect(createdWorkers[0]?.postMessageCalls).toEqual([{ type: "seed", snapshot: snapshot(1) }]);

    const pendingResult = manager.sendRequest(workspaceId, {
      requestId: 1,
      direction: "sanitize",
      text: "hello",
    });

    // Simulate a worker crash mid-request.
    createdWorkers[0]?.emit("error", new Error("synthetic worker crash"));

    const result = await pendingResult;
    expect(result).toEqual({ requestId: 1, ok: false, error: "WORKER_CRASHED" });

    // A fresh worker must have been created and immediately reseeded with
    // the current dictionary snapshot — not left absent, and not left
    // waiting for a new version bump to reseed it.
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(createdWorkers).toHaveLength(2);
    expect(createdWorkers[1]?.postMessageCalls).toEqual([{ type: "seed", snapshot: snapshot(1) }]);

    // The recreated worker is usable: a subsequent request succeeds against it.
    const nextPending = manager.sendRequest(workspaceId, {
      requestId: 2,
      direction: "sanitize",
      text: "world",
    });
    createdWorkers[1]?.emit("message", {
      requestId: 2,
      direction: "sanitize",
      ok: true,
      text: "world-sanitized",
    });
    await expect(nextPending).resolves.toEqual({
      requestId: 2,
      ok: true,
      text: "world-sanitized",
    });
  });

  it("fails in-flight requests cleanly and reseeds a freshly recreated worker with the current dictionary snapshot on a worker 'exit' event", async () => {
    const createdWorkers: FakeWorker[] = [];
    const createWorker = vi.fn((_scriptPath: string) => {
      const worker = new FakeWorker();
      createdWorkers.push(worker);
      return worker;
    });

    const deps: WorkerManagerDeps = {
      workerScriptPath: "/fake/translation-worker.js",
      createWorker,
    };

    const manager = createWorkerManager(deps);
    const workspaceId = "22222222-2222-2222-2222-222222222222";

    manager.ensureWorker(workspaceId, snapshot(3));

    const pendingA = manager.sendRequest(workspaceId, {
      requestId: 10,
      direction: "restore",
      text: "COMPANY_1",
    });
    const pendingB = manager.sendRequest(workspaceId, {
      requestId: 11,
      direction: "restore",
      text: "COMPANY_1 again",
    });

    // A non-zero exit code with no preceding 'error' event is still a crash.
    createdWorkers[0]?.emit("exit", 1);

    await expect(pendingA).resolves.toEqual({ requestId: 10, ok: false, error: "WORKER_CRASHED" });
    await expect(pendingB).resolves.toEqual({ requestId: 11, ok: false, error: "WORKER_CRASHED" });

    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(createdWorkers[1]?.postMessageCalls).toEqual([{ type: "seed", snapshot: snapshot(3) }]);
  });

  it("does not treat a clean exit (code 0) following an explicit terminateWorker() call as a crash", async () => {
    const createdWorkers: FakeWorker[] = [];
    const createWorker = vi.fn((_scriptPath: string) => {
      const worker = new FakeWorker();
      createdWorkers.push(worker);
      return worker;
    });

    const deps: WorkerManagerDeps = {
      workerScriptPath: "/fake/translation-worker.js",
      createWorker,
    };

    const manager = createWorkerManager(deps);
    const workspaceId = "33333333-3333-3333-3333-333333333333";

    manager.ensureWorker(workspaceId, snapshot(1));
    await manager.terminateWorker(workspaceId);
    createdWorkers[0]?.emit("exit", 0);

    // A deliberate termination must not trigger automatic recreation.
    expect(createWorker).toHaveBeenCalledTimes(1);
  });
});

// T045's own task text also names "decrypted-snapshot rebuilding and
// postMessage seeding only on version change" and "requestId-based
// supersession bookkeeping" as worker-manager.ts responsibilities (research.md
// #11). Neither is exercised by the three crash-recovery tests above, so —
// per constitution Principle VI ("every critical business rule... MUST have
// automated test coverage, written before the implementation is considered
// complete") — this second describe block covers them directly, plus
// cross-workspace isolation (constitution Principle II).
describe("worker-manager snapshot versioning, supersession, and workspace isolation", () => {
  it("does not re-post the seed message when ensureWorker is called again with an unchanged snapshot version, but does re-post when the version increments", () => {
    const createdWorkers: FakeWorker[] = [];
    const createWorker = vi.fn((_scriptPath: string) => {
      const worker = new FakeWorker();
      createdWorkers.push(worker);
      return worker;
    });
    const manager = createWorkerManager({
      workerScriptPath: "/fake/translation-worker.js",
      createWorker,
    });
    const workspaceId = "44444444-4444-4444-4444-444444444444";

    manager.ensureWorker(workspaceId, snapshot(1));
    expect(createdWorkers[0]?.postMessageCalls).toEqual([{ type: "seed", snapshot: snapshot(1) }]);

    // Same version again: only one worker ever created, and no second seed
    // message posted for an unchanged version.
    manager.ensureWorker(workspaceId, snapshot(1));
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(createdWorkers[0]?.postMessageCalls).toEqual([{ type: "seed", snapshot: snapshot(1) }]);

    // A version bump against the same already-running worker re-posts the
    // seed message, without creating a new worker.
    manager.ensureWorker(workspaceId, snapshot(2));
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(createdWorkers[0]?.postMessageCalls).toEqual([
      { type: "seed", snapshot: snapshot(1) },
      { type: "seed", snapshot: snapshot(2) },
    ]);
  });

  it("reseeds a freshly recreated worker with the snapshot version most recently seen, not the one it was first created with", async () => {
    const createdWorkers: FakeWorker[] = [];
    const createWorker = vi.fn((_scriptPath: string) => {
      const worker = new FakeWorker();
      createdWorkers.push(worker);
      return worker;
    });
    const manager = createWorkerManager({
      workerScriptPath: "/fake/translation-worker.js",
      createWorker,
    });
    const workspaceId = "55555555-5555-5555-5555-555555555555";

    manager.ensureWorker(workspaceId, snapshot(1));
    manager.ensureWorker(workspaceId, snapshot(2));
    createdWorkers[0]?.emit("error", new Error("synthetic crash"));

    expect(createdWorkers).toHaveLength(2);
    expect(createdWorkers[1]?.postMessageCalls).toEqual([{ type: "seed", snapshot: snapshot(2) }]);
  });

  it("drops an older still-pending request's result as superseded once a newer request for the same workspace and direction has been issued", async () => {
    const createdWorkers: FakeWorker[] = [];
    const createWorker = vi.fn((_scriptPath: string) => {
      const worker = new FakeWorker();
      createdWorkers.push(worker);
      return worker;
    });
    const manager = createWorkerManager({
      workerScriptPath: "/fake/translation-worker.js",
      createWorker,
    });
    const workspaceId = "66666666-6666-6666-6666-666666666666";

    manager.ensureWorker(workspaceId, snapshot(1));

    const older = manager.sendRequest(workspaceId, {
      requestId: 1,
      direction: "sanitize",
      text: "first",
    });
    // A newer request for the same (workspace, direction) supersedes it
    // before the older one's worker response ever arrives.
    const newer = manager.sendRequest(workspaceId, {
      requestId: 2,
      direction: "sanitize",
      text: "second",
    });

    // The worker eventually responds to both — no preemptive cancellation
    // (research.md #11) — but the older response arrives late.
    createdWorkers[0]?.emit("message", {
      requestId: 1,
      direction: "sanitize",
      ok: true,
      text: "first-sanitized",
    });
    createdWorkers[0]?.emit("message", {
      requestId: 2,
      direction: "sanitize",
      ok: true,
      text: "second-sanitized",
    });

    await expect(older).resolves.toEqual({ requestId: 1, ok: false, error: "SUPERSEDED" });
    await expect(newer).resolves.toEqual({ requestId: 2, ok: true, text: "second-sanitized" });
  });

  it("never supersedes across different directions or different workspaces", async () => {
    const createdWorkers: FakeWorker[] = [];
    const createWorker = vi.fn((_scriptPath: string) => {
      const worker = new FakeWorker();
      createdWorkers.push(worker);
      return worker;
    });
    const manager = createWorkerManager({
      workerScriptPath: "/fake/translation-worker.js",
      createWorker,
    });
    const workspaceId = "77777777-7777-7777-7777-777777777777";

    manager.ensureWorker(workspaceId, snapshot(1));

    const sanitizeResult = manager.sendRequest(workspaceId, {
      requestId: 1,
      direction: "sanitize",
      text: "a",
    });
    const restoreResult = manager.sendRequest(workspaceId, {
      requestId: 2,
      direction: "restore",
      text: "b",
    });

    createdWorkers[0]?.emit("message", {
      requestId: 1,
      direction: "sanitize",
      ok: true,
      text: "a-sanitized",
    });
    createdWorkers[0]?.emit("message", {
      requestId: 2,
      direction: "restore",
      ok: true,
      text: "b-restored",
    });

    // Different directions never supersede each other, even against the
    // same workspace's single worker.
    await expect(sanitizeResult).resolves.toEqual({ requestId: 1, ok: true, text: "a-sanitized" });
    await expect(restoreResult).resolves.toEqual({ requestId: 2, ok: true, text: "b-restored" });
  });

  it("routes each direction's response correctly even when a sanitize request and a restore request share the exact same numeric requestId", async () => {
    // research.md #11 scopes requestId "per (workspace, direction) pair" —
    // each direction has its own independent, renderer-generated counter —
    // so a sanitize request and a restore request legitimately can (and, on
    // first use of each direction, normally will) carry the same numeric
    // requestId. Routing must key on (direction, requestId), not requestId
    // alone, or one direction's response can resolve the other direction's
    // promise, or never resolve at all.
    const createdWorkers: FakeWorker[] = [];
    const createWorker = vi.fn((_scriptPath: string) => {
      const worker = new FakeWorker();
      createdWorkers.push(worker);
      return worker;
    });
    const manager = createWorkerManager({
      workerScriptPath: "/fake/translation-worker.js",
      createWorker,
    });
    const workspaceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

    manager.ensureWorker(workspaceId, snapshot(1));

    const sanitizeResult = manager.sendRequest(workspaceId, {
      requestId: 1,
      direction: "sanitize",
      text: "a",
    });
    const restoreResult = manager.sendRequest(workspaceId, {
      requestId: 1,
      direction: "restore",
      text: "b",
    });

    // The restore response arrives first, deliberately out of request order.
    createdWorkers[0]?.emit("message", {
      requestId: 1,
      direction: "restore",
      ok: true,
      text: "b-restored",
    });
    createdWorkers[0]?.emit("message", {
      requestId: 1,
      direction: "sanitize",
      ok: true,
      text: "a-sanitized",
    });

    await expect(sanitizeResult).resolves.toEqual({ requestId: 1, ok: true, text: "a-sanitized" });
    await expect(restoreResult).resolves.toEqual({ requestId: 1, ok: true, text: "b-restored" });
  });

  it("keeps two workspaces' workers, pending requests, and crash recovery fully independent", async () => {
    const createdWorkers: FakeWorker[] = [];
    const createWorker = vi.fn((_scriptPath: string) => {
      const worker = new FakeWorker();
      createdWorkers.push(worker);
      return worker;
    });
    const manager = createWorkerManager({
      workerScriptPath: "/fake/translation-worker.js",
      createWorker,
    });
    const workspaceA = "88888888-8888-8888-8888-888888888888";
    const workspaceB = "99999999-9999-9999-9999-999999999999";

    manager.ensureWorker(workspaceA, snapshot(1));
    manager.ensureWorker(workspaceB, snapshot(1));
    expect(createdWorkers).toHaveLength(2);

    const pendingA = manager.sendRequest(workspaceA, {
      requestId: 1,
      direction: "sanitize",
      text: "for-a",
    });
    const pendingB = manager.sendRequest(workspaceB, {
      requestId: 1,
      direction: "sanitize",
      text: "for-b",
    });

    // Crash only workspace A's worker.
    createdWorkers[0]?.emit("error", new Error("synthetic crash in workspace A only"));

    await expect(pendingA).resolves.toEqual({ requestId: 1, ok: false, error: "WORKER_CRASHED" });

    // Workspace B is completely unaffected: still its original worker,
    // and its own pending request resolves normally.
    createdWorkers[1]?.emit("message", {
      requestId: 1,
      direction: "sanitize",
      ok: true,
      text: "for-b-sanitized",
    });
    await expect(pendingB).resolves.toEqual({ requestId: 1, ok: true, text: "for-b-sanitized" });

    expect(createWorker).toHaveBeenCalledTimes(3); // A's original + A's recreation + B's original
    expect(createdWorkers[2]?.postMessageCalls).toEqual([{ type: "seed", snapshot: snapshot(1) }]);
  });
});
