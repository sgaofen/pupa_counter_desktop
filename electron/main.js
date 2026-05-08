// Electron main process — minimal single-window shell.
// Dev mode: loads Vite dev server at http://localhost:5173.
// Prod mode: loads the built dist/index.html.

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const DEV = !app.isPackaged;

// --- Local Python pipeline paths ---
// In production (packaged build) every Python artefact ships inside
// resources/python-pipeline/ — no sister-repo or system Python needed.
// In dev we still point at the live `pupa_counter_v6` next to this repo
// so source edits (model swap, daemon tweak) reload immediately.
const IS_WIN = process.platform === "win32";
const V6_ROOT_DEFAULT = path.resolve(__dirname, "..", "..", "pupa_counter_v6");
const PIPELINE_ROOT = DEV
  ? V6_ROOT_DEFAULT
  : path.join(process.resourcesPath, "python-pipeline");
const PYTHON_BIN_DEFAULT = DEV
  ? (IS_WIN
      ? path.join(V6_ROOT_DEFAULT, ".venv", "Scripts", "python.exe")
      : path.join(V6_ROOT_DEFAULT, ".venv", "bin", "python"))
  : path.join(PIPELINE_ROOT, "python-runtime", IS_WIN ? "python.exe" : "bin/python3");
const PYTHON_BIN = process.env.PUPA_PYTHON || PYTHON_BIN_DEFAULT;
const CNN_SCRIPT =
  process.env.PUPA_SCRIPT || path.join(PIPELINE_ROOT, "pupa_counter.py");
const CNN_DAEMON_SCRIPT =
  process.env.PUPA_DAEMON || path.join(PIPELINE_ROOT, "pupa_counter_daemon.py");

// Inference config — points the daemon at the LiDE 300 model trained
// 2026-05-01 (F1 = 99.66 % on the 6-scan self-eval). Override any of
// these by exporting the same env var before launching the desktop app.
const LIDE_MODEL = path.join(PIPELINE_ROOT, "model", "pupa_counter_lide300.pt");
const LIDE_CLF   = path.join(PIPELINE_ROOT, "model", "peak_filter_clf_lide300.pkl");
const DAEMON_ENV = {
  PUPA_MODEL_PATH:   process.env.PUPA_MODEL_PATH   || LIDE_MODEL,
  PUPA_CLF_PATH:     process.env.PUPA_CLF_PATH     || LIDE_CLF,
  PUPA_PEAK_THR:     process.env.PUPA_PEAK_THR     || "0.40",
  PUPA_MIN_DIST:     process.env.PUPA_MIN_DIST     || "4",
  PUPA_BBOX_CROP:    process.env.PUPA_BBOX_CROP    || "1",
  PUPA_CLF_PROB_THR: process.env.PUPA_CLF_PROB_THR || "0.50",
};

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
//
// Session model: each session lives in its own JSON file under
//   <userData>/sessions/<sessionId>.json
// On first launch we migrate the legacy single-file <userData>/session.json
// into the new layout so existing data isn't lost.
const SESSIONS_DIR = () => path.join(app.getPath("userData"), "sessions");
const LEGACY_SESSION_PATH = () => path.join(app.getPath("userData"), "session.json");

function safeId(id) {
  // Filesystem-safe session id (drop everything that's not alnum / dash / underscore).
  return String(id || "").replace(/[^A-Za-z0-9_\-]/g, "_").slice(0, 64) || "session";
}
function sessionFile(id) {
  return path.join(SESSIONS_DIR(), `${safeId(id)}.json`);
}

async function ensureSessionsDir() {
  await fs.promises.mkdir(SESSIONS_DIR(), { recursive: true });
}

// Run once at startup — moves <userData>/session.json into sessions/<id>.json
// the first time a user upgrades from the single-file era.
async function migrateLegacySessionOnce() {
  const legacy = LEGACY_SESSION_PATH();
  try {
    const raw = await fs.promises.readFile(legacy, "utf-8");
    const data = JSON.parse(raw);
    const id = data?.sessionId || `legacy_${new Date().toISOString().slice(0, 10)}`;
    const dest = sessionFile(id);
    if (!fs.existsSync(dest)) {
      await fs.promises.writeFile(dest, JSON.stringify(data, null, 2), "utf-8");
    }
    await fs.promises.rename(legacy, legacy + ".migrated");
  } catch {
    // No legacy file (or already migrated) — fine.
  }
}

ipcMain.handle("session:list", async () => {
  await ensureSessionsDir();
  const files = (await fs.promises.readdir(SESSIONS_DIR())).filter((f) => f.endsWith(".json"));
  const out = (await Promise.all(files.map(async (f) => {
    const full = path.join(SESSIONS_DIR(), f);
    try {
      const [stat, raw] = await Promise.all([
        fs.promises.stat(full),
        fs.promises.readFile(full, "utf-8"),
      ]);
      const data = JSON.parse(raw);
      const rounds = Array.isArray(data.rounds) ? data.rounds : [];
      return {
        sessionId: data.sessionId || f.replace(/\.json$/, ""),
        startedAt: data.startedAt || "",
        operator: data.operator || "",
        experiment: data.experiment || "",
        rounds: rounds.length,
        scans: rounds.reduce((a, r) => a + (Array.isArray(r.scans) ? r.scans.length : 0), 0),
        mtimeMs: stat.mtimeMs,
      };
    } catch {
      return null;  // unreadable files skipped instead of crashing the picker
    }
  }))).filter(Boolean);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
});

ipcMain.handle("session:load", async (_evt, sessionId) => {
  await ensureSessionsDir();
  // No id → most-recently-modified session (also covers fresh-install path).
  if (!sessionId) {
    const files = await fs.promises.readdir(SESSIONS_DIR());
    let pick = null;
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const full = path.join(SESSIONS_DIR(), f);
      const stat = await fs.promises.stat(full);
      if (!pick || stat.mtimeMs > pick.mtimeMs) pick = { full, mtimeMs: stat.mtimeMs };
    }
    if (!pick) return null;
    return JSON.parse(await fs.promises.readFile(pick.full, "utf-8"));
  }
  try {
    return JSON.parse(await fs.promises.readFile(sessionFile(sessionId), "utf-8"));
  } catch {
    return null;
  }
});

ipcMain.handle("session:save", async (_evt, data) => {
  await ensureSessionsDir();
  if (!data?.sessionId) throw new Error("session:save requires data.sessionId");
  await fs.promises.writeFile(sessionFile(data.sessionId),
                               JSON.stringify(data, null, 2), "utf-8");
  return true;
});

ipcMain.handle("session:create", async (_evt, partial) => {
  await ensureSessionsDir();
  const now = new Date();
  // Auto-name `sess_YYYY-MM-DD-HH-MM-SS`. Second-precision stamp + atomic
  // wx-flag write means we never collide and never block on existsSync.
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const id = safeId(partial?.sessionId || `sess_${stamp}`);
  const startedAt = partial?.startedAt || now.toLocaleString("sv-SE",
    { timeZone: "America/Los_Angeles" });
  const data = {
    sessionId: id,
    operator: partial?.operator || "",
    experiment: partial?.experiment || "",
    startedAt,
    rounds: [{ roundId: "r1", roundNumber: 1, startedAt, scans: [] }],
  };
  try {
    await fs.promises.writeFile(sessionFile(id),
                                 JSON.stringify(data, null, 2), { encoding: "utf-8", flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    // Same-second collision: tack on millis and try once more.
    const id2 = `${id}_${now.getMilliseconds()}`;
    data.sessionId = id2;
    await fs.promises.writeFile(sessionFile(id2),
                                 JSON.stringify(data, null, 2), { encoding: "utf-8", flag: "wx" });
  }
  return data;
});

ipcMain.handle("session:delete", async (_evt, sessionId) => {
  if (!sessionId) return false;
  try {
    await fs.promises.unlink(sessionFile(sessionId));
    return true;
  } catch {
    return false;
  }
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
  info: null,            // captured 'ready' payload: {device, deviceName, model, classifier}
};

function startCnnWorker() {
  if (cnnWorker.proc) return Promise.resolve();
  if (cnnWorker.starting) return cnnWorker.starting;

  cnnWorker.starting = new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_BIN, [CNN_DAEMON_SCRIPT], {
      cwd: path.dirname(CNN_DAEMON_SCRIPT),
      env: { ...process.env, ...DAEMON_ENV },
    });
    cnnWorker.proc = proc;

    const onReady = (msg) => {
      if (msg && msg.ready) {
        cnnWorker.info = msg;
        console.log(`[cnn-worker] ready on ${msg.deviceName || msg.device} · model=${msg.model} · clf=${msg.classifier}`);
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

ipcMain.handle("cnn:info", async () => {
  await startCnnWorker();
  return cnnWorker.info;
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
//
// In the packaged build the scripts live inside app.asar (a virtual
// archive PowerShell can't read). package.json's asarUnpack drops the
// real files at app.asar.unpacked/ instead — translate __dirname so
// powershell.exe -File sees a real on-disk path.
const SCANNER_DIR = path.join(__dirname, "scanner").replace(
  `${path.sep}app.asar${path.sep}`,
  `${path.sep}app.asar.unpacked${path.sep}`,
);
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
  const { deviceId, dpi = 300, mode = "color", outDir: requestedDir } = params || {};
  if (!deviceId) throw new Error("scanner:scan requires deviceId");
  // User-chosen save dir (from Settings) wins; fall back to userData if
  // they haven't set one or if we can't write to their chosen spot.
  const fallback = SCAN_OUT_DIR();
  let outDir = requestedDir || fallback;
  try {
    await fs.promises.mkdir(outDir, { recursive: true });
  } catch (err) {
    console.warn(`[scanner] save dir ${outDir} unusable (${err.message}); falling back to ${fallback}`);
    outDir = fallback;
    await fs.promises.mkdir(outDir, { recursive: true });
  }
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
  migrateLegacySessionOnce().catch((err) => {
    console.warn("[session] legacy migration failed:", err.message);
  });
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
