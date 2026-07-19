import { test, expect, _electron as electron } from "@playwright/test";
import { tmpdir } from "node:os";
import path from "node:path";

// playwright.config.ts has no explicit `cwd` override, so Playwright always
// runs test files from the repository root — safe to resolve against it.
const projectRoot = path.resolve(process.cwd());

// Infrastructure smoke test (Setup phase T010/T012): proves the scaffolded
// Electron app actually boots end-to-end under Playwright, not just that it
// type-checks. No Phase 2 domain behavior is exercised here.
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

  const userDataPath = await app.evaluate(({ app: electronApp }) =>
    electronApp.getPath("userData"),
  );
  const isPackaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged);

  expect(isPackaged).toBe(false);
  expect(userDataPath.startsWith(tmpdir())).toBe(true);
  expect(userDataPath).toContain("solari-ai-sanitizer-");
  expect(userDataPath).not.toMatch(/Library[\\/]Application Support/);
  expect(userDataPath).not.toMatch(/AppData[\\/](Roaming|Local)/);

  await app.close();
});
