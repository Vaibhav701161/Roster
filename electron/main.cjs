const {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  safeStorage,
  shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");

let service,
  window,
  closing = false;

// Electron can occasionally report a stale single-instance lock after an
// installer update. Roster's service lock is the authoritative guard for its
// local data directory, so let startup reach that guard instead of exiting
// without a window.
app.requestSingleInstanceLock();

function focusWindow() {
  if (!service) return;
  if (!window || window.isDestroyed()) createWindow();
  else {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
}

function sendToRenderer(channel) {
  focusWindow();
  window.webContents.send(channel);
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac
        ? [
            {
              label: "Roster",
              submenu: [
                { label: "About Roster", role: "about" },
                { type: "separator" },
                {
                  label: "Settings",
                  accelerator: "CmdOrCtrl+,",
                  click: () => sendToRenderer("roster:open-settings"),
                },
                { type: "separator" },
                { role: "services" },
                { type: "separator" },
                { role: "hide" },
                { role: "hideOthers" },
                { role: "unhide" },
                { type: "separator" },
                { role: "quit", label: "Quit Roster" },
              ],
            },
          ]
        : []),
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "close" },
          ...(isMac
            ? [{ role: "zoom" }, { type: "separator" }, { role: "front" }]
            : []),
        ],
      },
      {
        label: "Help",
        submenu: [
          {
            label: "Open logs folder",
            click: () => shell.openPath(app.getPath("logs")),
          },
          {
            label: "Copy diagnostics",
            click: () => copyDiagnostics(),
          },
        ],
      },
    ]),
  );
}

function copyDiagnostics() {
  clipboard.writeText(
    [
      `Roster ${app.getVersion()}`,
      `Platform: ${process.platform} ${process.arch}`,
      `Electron: ${process.versions.electron}`,
      `Logs: ${app.getPath("logs")}`,
    ].join("\n"),
  );
}

function createWindow() {
  const url = process.env.ROSTER_DEV_URL || service.url;
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 760,
    minHeight: 620,
    title: "Roster",
    icon: path.join(__dirname, "../assets/roster-icon.svg"),
    backgroundColor: "#f5f7f4",
    autoHideMenuBar: process.platform !== "darwin",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on("closed", () => {
    window = undefined;
  });
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith("https://")) shell.openExternal(target);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== new URL(url).origin) event.preventDefault();
  });
  window.loadURL(url);
}

function ensureDesktopSender(event) {
  if (!window || event.sender !== window.webContents)
    throw new Error("Invalid sender");
}

app.on("second-instance", focusWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", focusWindow);

app
  .whenReady()
  .then(async () => {
    app.setAppLogsPath();
    const dataDir = process.env.ROSTER_DATA_DIR || app.getPath("userData");
    fs.mkdirSync(dataDir, { recursive: true });
    const secretPath = path.join(dataDir, "provider-key.enc");
    const namedSecretPath = (key) =>
      path.join(
        dataDir,
        `secret-${crypto.createHash("sha256").update(String(key)).digest("hex")}.enc`,
      );
    const readSecret = (filename) => {
      if (!fs.existsSync(filename) || !safeStorage.isEncryptionAvailable())
        return "";
      try {
        return safeStorage.decryptString(fs.readFileSync(filename));
      } catch {
        return "";
      }
    };
    const writeSecret = (filename, value) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error(
          "OS credential encryption is unavailable. Set OPENAI_API_KEY instead.",
        );
      if (value) fs.writeFileSync(filename, safeStorage.encryptString(value));
      else if (fs.existsSync(filename)) fs.unlinkSync(filename);
    };
    const vault = {
      get() {
        return readSecret(secretPath);
      },
      set(value) {
        writeSecret(secretPath, value);
      },
      getNamed(key) {
        return readSecret(namedSecretPath(key));
      },
      setNamed(key, value) {
        writeSecret(namedSecretPath(key), value);
      },
      mode: "encrypted",
    };
    const { createServer } = await import(
      pathToFileURL(path.join(__dirname, "../server/index.mjs"))
    );
    service = await createServer({
      directory: dataDir,
      logDirectory: app.getPath("logs"),
      port: process.env.ROSTER_DEV_URL ? 4318 : 0,
      vault,
    });
    ipcMain.handle("roster:choose-folder", async (event) => {
      ensureDesktopSender(event);
      const result = await dialog.showOpenDialog(window, {
        properties: ["openDirectory"],
      });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle("roster:open-logs", async (event) => {
      ensureDesktopSender(event);
      return shell.openPath(app.getPath("logs"));
    });
    ipcMain.handle("roster:copy-diagnostics", async (event) => {
      ensureDesktopSender(event);
      copyDiagnostics();
      return true;
    });
    buildMenu();
    createWindow();
  })
  .catch((error) => {
    dialog.showErrorBox("Roster could not start", error.message);
    app.exit(1);
  });

app.on("before-quit", (event) => {
  if (!closing && service) {
    event.preventDefault();
    closing = true;
    service.close().finally(() => app.quit());
  }
});
