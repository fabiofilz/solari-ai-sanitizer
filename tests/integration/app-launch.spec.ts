import { test, expect, _electron as electron } from "@playwright/test";
import { basename, isAbsolute, relative, resolve } from "node:path";

// playwright.config.ts has no explicit `cwd` override, so Playwright always
// runs test files from the repository root — safe to resolve against it.
const projectRoot = resolve(process.cwd());

const TEMP_DIR_PREFIX = "solari-ai-sanitizer-";

// Infrastructure smoke test (Setup phase T010/T012): proves the scaffolded
// Electron app actually boots end-to-end under Playwright, not just that it
// type-checks. No Phase 2 domain behavior is exercised here.
//
// Isolation is proven structurally (strict descendant of Electron's own temp
// directory, via path.relative semantics), not by matching platform-specific
// substrings like "AppData" — os.tmpdir() legitimately lives under
// AppData\Local\Temp on Windows, so rejecting any path containing "AppData"
// would be a false positive there.
test("scaffolded desktop app launches, creates a window, loads the renderer, and uses an isolated temp userData path", async () => {
  const app = await electron.launch({
    args: [projectRoot],
  });

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");

  expect(app.windows().length).toBe(1);

  const title = await window.title();
  expect(title).toBe("Solari AI Sanitizer");

  const rootText = await window.locator("#root").innerText();
  expect(rootText).toContain("Solari AI Sanitizer");

  const { userDataPath, tempPath, appDataPath, appName, isPackaged } = await app.evaluate(
    ({ app: electronApp }) => ({
      userDataPath: electronApp.getPath("userData"),
      tempPath: electronApp.getPath("temp"),
      appDataPath: electronApp.getPath("appData"),
      appName: electronApp.getName(),
      isPackaged: electronApp.isPackaged,
    }),
  );

  expect(isPackaged).toBe(false);

  // userData must be a strict descendant of Electron's own temp directory.
  const relToTemp = relative(resolve(tempPath), resolve(userDataPath));
  expect(relToTemp.length).toBeGreaterThan(0);
  expect(relToTemp.startsWith("..")).toBe(false);
  expect(isAbsolute(relToTemp)).toBe(false);

  expect(basename(userDataPath).startsWith(TEMP_DIR_PREFIX)).toBe(true);

  // userData must not be the normal application-data directory, nor the
  // path an unmodified Electron app would default userData to.
  expect(resolve(userDataPath)).not.toBe(resolve(appDataPath));
  expect(resolve(userDataPath)).not.toBe(resolve(appDataPath, appName));

  await app.close();
});
