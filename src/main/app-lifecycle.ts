import { app, BrowserWindow } from "electron";
import path from "node:path";
import { createTempUserDataDir } from "./persistence/temp-user-data";

// Placeholder bootstrap for the Setup phase build pipeline (T001-T013).
// Replaced by the real startup sequence (single-instance lock, registry open,
// key unwrap, deletion reconciliation) in T042.

if (!app.isPackaged) {
  // Dev/test runs never touch the real userData path (research.md #10).
  app.setPath("userData", createTempUserDataDir().path);
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "..", "..", "preload", "index.js"),
    },
  });

  if (process.env["VITE_DEV_SERVER_URL"]) {
    void win.loadURL(process.env["VITE_DEV_SERVER_URL"]);
  } else {
    void win.loadFile(path.join(__dirname, "..", "..", "renderer", "index.html"));
  }
}

void app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
