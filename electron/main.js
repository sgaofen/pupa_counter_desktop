// Electron main process — minimal single-window shell.
// Dev mode: loads Vite dev server at http://localhost:5173.
// Prod mode: loads the built dist/index.html.

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const DEV = !app.isPackaged;

// --- Local Python pipeline paths (replace with bundled resources when we
// ship a packaged .dmg / .exe; for dev we just point at the local repo). ---
// Defaults assume the sister repo `pupa_counter_v6` sits next to this one,
// with its own `.venv`. Works cross-platform (macOS/Linux uses .venv/bin,
// Windows uses .venv/Scripts). Override any of these with env vars when
// the layout differs.
const IS_WIN = process.platform === "win32";
const V6_ROOT_DEFAULT = path.resolve(__dirname, "..", "..", "pupa_counter_v6");
const VENV_PY_DEFAULT = IS_WIN
  ? path.join(V6_ROOT_DEFAULT, ".venv", "Scripts", "python.exe")
  : path.join(V6_ROOT_DEFAULT, ".venv", "bin", "python");
const PYTHON_BIN = process.env.PUPA_PYTHON || VENV_PY_DEFAULT;
const CNN_SCRIPT =
  process.env.PUPA_SCRIPT || path.join(V6_ROOT_DEFAULT, "pupa_counter.py");
const CNN_DAEMON_SCRIPT =
  process.env.PUPA_DAEMON || path.join(V6_ROOT_DEFAULT, "pupa_counter_daemon.py");

function createWindow() {
  const win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1200,
    minHeight: 720,
    titleBarStyle: "hiddenInset", // macOS: system traffic lights, no title text
    title: "Pupa Counter",
    backgroundColor: "#F5F4EF",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (DEV) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// --- IPC handlers for file operations + session persistence ---
const SESSION_PATH = () => path.join(app.getPath("userData"), "session.json");

ipcMain.handle("session:load", async () => {
  try {
    const raw = await fs.promises.readFile(SESSION_PATH(), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
});

ipcMain.handle("session:save", async (_evt, data) => {
  await fs.promises.writeFile(SESSION_PATH(), JSON.stringify(data, null, 2), "utf-8");
  return true;
});

ipcMain.handle("dialog:openImage", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose a scan image",
    properties: ["openFile"],
    filters: [{ name: "Scans", extensions: ["tif", "tiff", "png", "jpg", "jpeg"] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("dialog:openDirectory", async () => {
  const result = await dialog.showOpenDialog({
    title: "Choose directory",
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// Read an image file and return it as a data URL the renderer can drop
// straight into <img src>. Avoids enabling `webSecurity: false` or
// registering a custom protocol. PNG/JPG only for now; TIFF needs a
// conversion pass (Sharp) — do that once TIFF scans actually arrive.
ipcMain.handle("file:readImageDataUrl", async (_evt, p) => {
  const buf = await fs.promises.readFile(p);
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime =
    ext === "png" ? "image/png"
    : ext === "jpg" || ext === "jpeg" ? "image/jpeg"
    : ext === "webp" ? "image/webp"
    : "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
});

// Expose a built-in demo folder so the user can click "Load demo scan"
// without picking a file on every launch. Override with PUPA_DEMO_DIR; the
// default is the user's Downloads/pupate_batch on any platform. If the
// folder doesn't exist the handler returns [] and the button is silent.
const DEMO_DIR =
  process.env.PUPA_DEMO_DIR || path.join(os.homedir(), "Downloads", "pupate_batch");
ipcMain.handle("file:listDemoScans", async () => {
  try {
    const files = await fs.promises.readdir(DEMO_DIR);
    return files
      .filter((f) => /\.(png|jpe?g)$/i.test(f))
      .sort()
      .slice(0, 100)
      .map((f) => path.join(DEMO_DIR, f));
  } catch {
    return [];
  }
});

// --- Real CNN detection via a persistent Python worker ---
// One long-lived subprocess (pupa_counter_daemon.py) loads the model +
// classifier once and then handles JSON-lines requests on stdin /
// stdout. This turns each detection from ~2.5s (subprocess cold start)
// into ~0.7s (steady-state inference only).
const cnnWorker = {
  proc: null,
  starting: null,        // Promise that resolves on 'ready' line
  nextId: 1,
  pending: new Map(),    // id -> { resolve, reject }
  stdoutBuf: "",
  stderrBuf: "",
};

function startCnnWorker() {
  if (cnnWorker.proc) return Promise.resolve();
  if (cnnWorker.starting) return cnnWorker.starting;

  cnnWorker.starting = new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [CNN_DAEMON_SCRIPT], {
      cwd: path.dirname(CNN_DAEMON_SCRIPT),
    });
    cnnWorker.proc = proc;

    const onReady = (msg) => {
      if (msg && msg.ready) {
        console.log(`[cnn-worker] ready on ${msg.device} · model=${msg.model} · clf=${msg.classifier}`);
        resolve();
      } else {
        // Unexpected: treat as response-before-ready.
        dispatch(msg);
      }
    };

    let readyHandled = false;
    proc.stdout.on("data", (d) => {
      cnnWorker.stdoutBuf += d.toString();
      let nl;
      while ((nl = cnnWorker.stdoutBuf.indexOf("\n")) !== -1) {
        const line = cnnWorker.stdoutBuf.slice(0, nl).trim();
        cnnWorker.stdoutBuf = cnnWorker.stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); }
        catch {
          console.warn("[cnn-worker] non-JSON stdout line:", line);
          continue;
        }
        if (!readyHandled && msg && msg.ready) {
          readyHandled = true;
          onReady(msg);
        } else {
          dispatch(msg);
        }
      }
    });

    proc.stderr.on("data", (d) => {
      const txt = d.toString();
      cnnWorker.stderrBuf += txt;
      // Python warnings / errors go here — pipe to console for dev visibility.
      for (const line of txt.split("\n")) if (line.trim()) console.warn(`[cnn-worker stderr] ${line}`);
    });

    proc.on("error", (err) => {
      console.error("[cnn-worker] spawn error:", err);
      failAllPending(err);
      cnnWorker.proc = null;
      cnnWorker.starting = null;
      if (!readyHandled) reject(err);
    });

    proc.on("close", (code) => {
      console.warn(`[cnn-worker] exited with code ${code}`);
      failAllPending(new Error(`cnn worker exited (${code})`));
      cnnWorker.proc = null;
      cnnWorker.starting = null;
    });
  });
  return cnnWorker.starting;
}

function dispatch(msg) {
  if (!msg || msg.id == null) return;
  const cb = cnnWorker.pending.get(msg.id);
  if (!cb) return;
  cnnWorker.pending.delete(msg.id);
  if (msg.ok) cb.resolve(msg.result);
  else cb.reject(new Error(msg.error || "cnn worker error"));
}

function failAllPending(err) {
  for (const [, cb] of cnnWorker.pending) cb.reject(err);
  cnnWorker.pending.clear();
}

ipcMain.handle("cnn:detect", async (_evt, imagePath) => {
  await startCnnWorker();
  return new Promise((resolve, reject) => {
    const id = cnnWorker.nextId++;
    cnnWorker.pending.set(id, { resolve, reject });
    try {
      cnnWorker.proc.stdin.write(JSON.stringify({ id, cmd: "detect", imagePath }) + "\n");
    } catch (err) {
      cnnWorker.pending.delete(id);
      reject(err);
    }
  });
});

app.on("before-quit", () => {
  if (cnnWorker.proc) {
    try { cnnWorker.proc.stdin.write(JSON.stringify({ id: 0, cmd: "quit" }) + "\n"); } catch {}
    try { cnnWorker.proc.kill(); } catch {}
  }
});

// --- Scanner (Windows only for now, via WIA COM through PowerShell) ---
// The PS scripts in electron/scanner/ shell out to WIA.DeviceManager and
// print one JSON line on stdout. Any other stdout noise is tolerated — we
// only parse the last non-empty line.
const SCANNER_DIR = path.join(__dirname, "scanner");
const SCAN_OUT_DIR = () => path.join(app.getPath("userData"), "scans");

function runScannerScript(scriptName, args) {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("scanner IPC is Windows-only (WIA); macOS/Linux path not yet implemented"));
  }
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(SCANNER_DIR, scriptName);
    const proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args],
      { windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      const lastLine = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      let parsed;
      try { parsed = JSON.parse(lastLine); }
      catch {
        return reject(new Error(
          `scanner script ${scriptName} produced no JSON (exit ${code}). stderr: ${stderr || "<empty>"}`
        ));
      }
      if (parsed.ok === false) return reject(new Error(parsed.error || "scanner script failed"));
      resolve(parsed);
    });
  });
}

ipcMain.handle("scanner:listDevices", async () => {
  const res = await runScannerScript("wia_list.ps1", []);
  return res.devices || [];
});

ipcMain.handle("scanner:scan", async (_evt, params) => {
  const { deviceId, dpi = 300, mode = "color" } = params || {};
  if (!deviceId) throw new Error("scanner:scan requires deviceId");
  const outDir = SCAN_OUT_DIR();
  await fs.promises.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = path.join(outDir, `scan_${stamp}.png`);
  const res = await runScannerScript("wia_scan.ps1", [
    "-DeviceId", deviceId,
    "-OutPath", outPath,
    "-Dpi", String(dpi),
    "-Mode", mode,
  ]);
  return res;
});

app.whenReady().then(() => {
  createWindow();
  // Pre-warm the CNN daemon so first scan doesn't pay torch-import +
  // model-load cost (~2s) at click time. If warmup fails here we swallow
  // it — real errors will surface again on the first actual detect.
  startCnnWorker().catch((err) => {
    console.warn("[cnn-worker] pre-warm failed:", err.message);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
