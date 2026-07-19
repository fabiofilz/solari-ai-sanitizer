import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { createTempUserDataDir } from "../../../src/main/persistence/temp-user-data";

const TEMP_DIR_PREFIX = "solari-ai-sanitizer-";

// Infrastructure smoke test (Setup phase T010): proves the Vitest runner is
// correctly wired end-to-end and asserts the real isolation guarantee
// research.md #10 requires — tests never touch the application's real
// userData path.
//
// Isolation is proven structurally (strict descendant of the OS temp root
// via path.relative semantics), not by matching platform-specific substrings
// like "AppData" — os.tmpdir() legitimately lives under AppData\Local\Temp on
// Windows, so rejecting any path containing "AppData" would be a false
// positive there.
describe("createTempUserDataDir", () => {
  it("creates an isolated directory that is a strict descendant of the OS temp root, not any real userData path", () => {
    const handle = createTempUserDataDir();

    expect(existsSync(handle.path)).toBe(true);

    const rel = relative(resolve(tmpdir()), resolve(handle.path));
    expect(rel.length).toBeGreaterThan(0);
    expect(rel.startsWith("..")).toBe(false);
    expect(isAbsolute(rel)).toBe(false);

    expect(basename(handle.path).startsWith(TEMP_DIR_PREFIX)).toBe(true);

    handle.cleanup();
    expect(existsSync(handle.path)).toBe(false);
  });

  it("returns a distinct directory on every call, so concurrent test runs never collide", () => {
    const first = createTempUserDataDir();
    const second = createTempUserDataDir();

    expect(first.path).not.toBe(second.path);
    expect(existsSync(first.path)).toBe(true);
    expect(existsSync(second.path)).toBe(true);

    first.cleanup();
    second.cleanup();
  });
});
