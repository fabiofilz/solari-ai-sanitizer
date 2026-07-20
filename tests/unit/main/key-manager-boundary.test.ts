import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  wrapRegistryDek,
  unwrapRegistryDek,
  wrapWorkspaceDek,
  unwrapWorkspaceDek,
} from "../../../src/main/persistence/key-manager";

// Boundary regression tests: production callers of key-manager.ts must
// never supply a safeStorage argument, and no other file under src/ may
// import, receive, or call Electron's safeStorage. Synthetic data only
// (constitution Principle VI).
//
// Arity (`.length`) is used rather than actually invoking these functions:
// under Vitest (plain Node, no real Electron process), the production
// safeStorage singleton is legitimately undefined, so any real invocation
// fails on the availability check regardless of argument shape. Checking
// declared parameter count is a deterministic, environment-independent way
// to verify the calling contract itself.
//
// Genuine first-run evidence (captured before this file's functions were
// touched): calling the original two-parameter `wrapRegistryDek(safeStorage,
// rawDek)` with a single Buffer argument rejected with
// `KeyManagerError: registry key unavailable: availability check failed`,
// because the sole argument was treated as `safeStorage`, whose (missing)
// `isAsyncEncryptionAvailable` was then called. That run is the authoritative
// red-state evidence for this defect; this arity form is a corrected,
// environment-independent replacement used from this point on.

describe("[boundary regression] production API must not require a safeStorage argument", () => {
  it("wrapRegistryDek accepts exactly one argument (rawDek) — no safeStorage parameter", () => {
    expect(wrapRegistryDek.length).toBe(1);
  });

  it("unwrapRegistryDek accepts exactly two arguments (wrappedDek, persistRewrapped) — no safeStorage parameter", () => {
    expect(unwrapRegistryDek.length).toBe(2);
  });

  it("wrapWorkspaceDek accepts exactly one argument (rawDek) — no safeStorage parameter", () => {
    expect(wrapWorkspaceDek.length).toBe(1);
  });

  it("unwrapWorkspaceDek accepts exactly two arguments (wrappedDek, persistRewrapped) — no safeStorage parameter", () => {
    expect(unwrapWorkspaceDek.length).toBe(2);
  });
});

describe("[boundary regression] only key-manager.ts may reference Electron safeStorage under src/", () => {
  const SRC_ROOT = resolve(process.cwd(), "src");
  const KEY_MANAGER_PATH = resolve(SRC_ROOT, "main/persistence/key-manager.ts");

  function listTsFiles(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...listTsFiles(fullPath));
      } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
        files.push(fullPath);
      }
    }
    return files;
  }

  /** Strips // and /* *\/ comments so a bare mention of "safeStorage" in a
   * comment (explicitly allowed) is not mistaken for executable code. */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  it("key-manager.ts itself genuinely references safeStorage (sanity check that this scan is meaningful)", () => {
    const content = stripComments(readFileSync(KEY_MANAGER_PATH, "utf8"));
    expect(content).toContain("safeStorage");
  });

  it("no file under src/ other than key-manager.ts contains an executable reference to safeStorage", () => {
    const offenders: string[] = [];
    for (const file of listTsFiles(SRC_ROOT)) {
      if (resolve(file) === KEY_MANAGER_PATH) continue;
      const codeOnly = stripComments(readFileSync(file, "utf8"));
      if (codeOnly.includes("safeStorage")) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sanity: listTsFiles actually walks the tree (non-trivial file count)", () => {
    expect(listTsFiles(SRC_ROOT).length).toBeGreaterThan(5);
    expect(statSync(KEY_MANAGER_PATH).isFile()).toBe(true);
  });
});
