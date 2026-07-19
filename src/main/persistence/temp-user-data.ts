import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEMP_DIR_PREFIX = "solari-ai-sanitizer-";

export interface TempUserDataHandle {
  path: string;
  cleanup: () => void;
}

/**
 * Creates a fresh, isolated userData directory for a single test run or dev
 * session, torn down via cleanup(). Never returns the application's real
 * userData path (research.md #10 "Preventing accidental Git inclusion").
 */
export function createTempUserDataDir(): TempUserDataHandle {
  const dir = mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX));
  return {
    path: dir,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
