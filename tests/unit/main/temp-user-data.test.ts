import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { createTempUserDataDir } from "../../../src/main/persistence/temp-user-data";

// Infrastructure smoke test (Setup phase T010): proves the Vitest runner is
// correctly wired end-to-end and asserts the real isolation guarantee
// research.md #10 requires — tests never touch the application's real
// userData path.
describe("createTempUserDataDir", () => {
  it("creates an isolated directory under the OS temp root, not any real userData path", () => {
    const handle = createTempUserDataDir();

    expect(existsSync(handle.path)).toBe(true);
    expect(resolve(handle.path).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(handle.path).not.toMatch(/Library[\\/]Application Support/);
    expect(handle.path).not.toMatch(/AppData[\\/](Roaming|Local)/);

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
