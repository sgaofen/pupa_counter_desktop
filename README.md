# Pupa Counter — Desktop

A lab-facing Electron app that drives a flatbed scanner, runs a CNN to
count silkworm pupae on the scanned page, and lets you hand-correct the
detections before saving them to a per-session database.

Backend (since 2026-04-30): V12 CNN + `clf_v6_md5` classifier with
`min_distance=5` peak extraction — F1 = 99.95 % on self-eval, 99.60 %
on honest leave-one-scan-out CV. Lives in the sister repo
[`pupa_counter_v6`](https://github.com/sgaofen/pupa_counter_v6).

```
   physical paper                    auto-detect best torch backend
   on scanner glass                  per-machine (CUDA / MPS / XPU /
        │                            DirectML / CPU)
        ▼                                       │
  ┌──────────────────┐    PNG     ┌──────────────────────┐
  │  WIA via Power-  │──────────► │  Python daemon, v12  │
  │  Shell COM       │            │  CNN + clf v6_md5    │
  │  (Win 10/11)     │            │  (persistent worker) │
  └──────────────────┘            └──────────┬───────────┘
                                             │ JSON-lines
                                             ▼
                                    ┌──────────────────┐
                                    │ Electron + React │
                                    │ canvas + manual  │
                                    │ correct + CSV    │
                                    │ export           │
                                    └──────────────────┘
```

The CNN itself, training data, weights, and CLI all live in the sister
repo [`pupa_counter_v6`](https://github.com/sgaofen/pupa_counter_v6).
This repo is purely the GUI + scanner driver wrapper.

## Quickstart on a new machine

You need the **two repos side by side** (defaults assume
`Documents/pupa_counter_desktop` and `Documents/pupa_counter_v6` next to
each other; override with env vars if not).

```bash
# 1. Both repos
git clone https://github.com/sgaofen/pupa_counter_desktop.git
git clone https://github.com/sgaofen/pupa_counter_v6.git

# 2. Bootstrap the Python venv with the right torch wheel for *this*
#    hardware. Detects NVIDIA / Apple Silicon / Intel Arc / AMD / CPU
#    and installs the matching wheel + classifier deps.
python pupa_counter_v6/scripts/setup_venv.py

# 3. Install the desktop app + run dev
cd pupa_counter_desktop
npm install
npm run dev               # Vite on :5173 + Electron window
```

That's it. The CNN daemon pre-warms at window-ready, the scanner is
auto-enumerated via WIA, and `Settings → Hardware acceleration` shows
which backend ended up live.

## Build & package

```bash
npm run build              # tsc + vite build → dist/
npm run package:win        # NSIS .exe under release/
npm run package:mac        # .dmg under release/
```

## Hardware acceleration

`pupa_counter_v6/pupa_counter.py::pick_device()` picks in this order
based on what's reachable from the imported torch:

| Order | Backend  | Wheel index                                         | Typical hardware |
|------:|----------|-----------------------------------------------------|------------------|
| 1     | MPS      | default (`pip install torch`)                       | Apple Silicon Mac |
| 2     | CUDA     | `https://download.pytorch.org/whl/cu126`            | NVIDIA dGPU |
| 3     | XPU      | `https://download.pytorch.org/whl/xpu`              | Intel Arc / Core Ultra iGPU |
| 4     | DirectML | default + `pip install torch-directml`              | AMD on Windows, fallback |
| 5     | CPU      | default                                              | everyone else |

`scripts/setup_venv.py` (in the v6 repo) detects OS + GPU and installs
the right wheel, so step 2 of the Quickstart is the only thing a new
machine has to do.

Measured detection time per scan, A4 @ 300 DPI (2481×3507):

| Hardware                              | Per-scan time | Notes |
|---------------------------------------|---------------|-------|
| Apple M4 (10-core) MPS                | ~0.65 s       | from `pupa_counter_v6` README |
| Intel Core Ultra 7 255H + Arc 140T    | ~4.1 s        | iGPU, shared memory |
| Same machine, CPU only                | ~10 s         | for reference |

## Scanner

Windows-only for now. Uses the Microsoft eSCL-over-USB universal driver
through WIA COM (`electron/scanner/wia_*.ps1`), so most modern flatbed
scanners work plug-and-play with **no vendor software install needed**.

Tested on **Canon CanoScan LiDE 300** (USB-powered, eSCL).

Settings → Scanner exposes:

- **Device**: dropdown of every WIA scanner Windows sees
- **Resolution**: 200 / 300 / 400 / 600 dpi (300 matches the training
  domain — don't go higher unless you know the model can take it)
- **Color mode**: color / grayscale (color is what the CNN was trained on)
- **Test connection**: re-runs WIA enumeration

If the renderer hasn't been through Settings yet, the first scan auto-
picks the first available device and persists that choice to
`localStorage` for next time.

When no scanner is connected, **New scan** falls back gracefully to a
file picker so the rest of the pipeline (CNN, manual correct, save)
remains testable from sample PNGs.

macOS / Linux scanner integration is not wired yet — on those
platforms the **New scan** button always falls through to the file
picker.

## Loading images without scanning

Three ways:

1. **Drag a PNG / JPG** onto the scan canvas (anywhere on the card,
   not just the empty drop zone).
2. **Toolbar → Load file…** opens the system file picker.
3. **Toolbar → New scan** triggers the WIA scanner.

## Persistence

| What | Where | Format |
|------|-------|--------|
| Session (rounds, scans, pupae) | `userData/session.json` | JSON, auto-saved on every mutation |
| Scanned PNGs | `userData/scans/` (or user-chosen dir from Settings) | PNG @ chosen DPI |
| Scanner settings (device + DPI + mode) | `localStorage[pupa.scanner.settings.v1]` | JSON |
| Save-dir override | `localStorage[pupa.saveDir.v1]` | string |

`userData` resolves to `%APPDATA%\pupa-counter-desktop` on Windows,
`~/Library/Application Support/Pupa Counter/` on macOS.

## Settings page

| Card | What it actually does |
|------|----------------------|
| **Scanner** | Live WIA enumeration, DPI / color mode, persisted on Save |
| **Detection model** | Read-only display of the daemon's reported hardware backend + model files. Override paths via `PUPA_PYTHON` / `PUPA_DAEMON` env vars before launch |
| **Defaults** | Default operator (writes to session live), default save directory (persists to `localStorage`, validated at scan time with auto-fallback to userData) |

## Project layout

```
electron/
  main.js                     window mgmt, IPC, daemon spawn, scanner spawn
  preload.js                  contextBridge → window.pupa.{session, dialog, file, cnn, scanner}
  scanner/
    wia_list.ps1              enumerate WIA devices → JSON to stdout
    wia_scan.ps1              one scan with given DeviceId/Dpi/Mode → PNG + JSON
src/
  App.tsx                     tab router, dark mode, session hydrate/persist
  pages/
    ScanView.tsx              scan/load + canvas + metadata form
    DatabaseView.tsx          per-round table, search, sort, CSV export
    SettingsView.tsx          scanner / model / defaults
  components/
    EditCanvas.tsx            pan/zoom, L-click add, R-click delete pupae
    ScanImage.tsx             placeholder for empty/processing states
    TitleBar.tsx, TopNav.tsx  chrome
    icons.tsx                 inline SVG icon set
  adapters/
    cnnAdapter.ts             window.pupa.cnn.detect → daemon
    scannerAdapter.ts         window.pupa.scanner.scan, file-picker fallback
  store/
    sessionStore.ts           Zustand: session + pending scan + UI state
  types.ts                    DetectionResult, Pupa, ScanRecord, ScannerDevice, ScanParams, CnnInfo
```

## IPC channels

| Channel             | Direction         | Purpose |
|---------------------|-------------------|---------|
| `session:load/save` | renderer → main   | Hydrate / persist `session.json` |
| `dialog:openImage`  | renderer → main   | OS file picker for PNG/JPG/TIFF |
| `dialog:openDirectory` | renderer → main | OS dir picker for save-dir |
| `file:readImageDataUrl` | renderer → main | Read a path → base64 data URL for `<img>` |
| `file:listDemoScans` | renderer → main  | List `~/Downloads/pupate_batch/*.png` if present |
| `cnn:detect`        | renderer → main   | Run detection on a PNG path; persistent daemon |
| `cnn:info`          | renderer → main   | Daemon's `ready` payload (device, model, classifier) |
| `scanner:listDevices` | renderer → main | Spawn `wia_list.ps1`, parse JSON |
| `scanner:scan`      | renderer → main   | Spawn `wia_scan.ps1` with chosen params, parse JSON |

## Dev tips

- The **CNN daemon is pre-warmed at window-ready** so the first
  detection click doesn't pay torch-import + model-load cost. If it
  fails to start, the warning is logged and the real error surfaces on
  first detect.
- `npm run dev` opens DevTools detached. The renderer can be reloaded
  with Ctrl+R; main-process changes need a full restart.
- All scanner stdout is funnelled through one JSON line per script
  invocation — extra debug `Write-Output` in PS scripts is tolerated,
  only the **last non-empty line** is parsed as the result.
- Renderer logs from `console.log` show up in DevTools; main-process
  logs (including the daemon's stderr) show up in the terminal.

## Known limitations

- Scanner integration is **Windows-only** today. macOS would need an
  ICA / Image Capture path; Linux needs SANE.
- Persistence is JSON, not SQLite. The IPC shape is stable so swapping
  in `better-sqlite3` is a main-process-only change.
- TIFF support is not yet implemented (`sharp` would handle TIFF→PNG
  conversion, but LiDE 300 + WIA emit PNG natively so it's not yet
  needed).
- The 1116×2586 demo seed in `sessionStore.ts` is synthetic, not real
  detections.

## Sister repo

[`pupa_counter_v6`](https://github.com/sgaofen/pupa_counter_v6) holds:

- The TinyUNet CNN (466K params, F1 99.95% w/ classifier filter as of
  2026-04-30, F1 99.60% on honest leave-one-scan-out CV)
- Model weights (`pupa_counter_v12.pt`, ~1.9 MB)
- Classifier (`peak_filter_clf_v6_md5.pkl`, sklearn 1.6.1 GBM)
- The persistent JSON-lines daemon this app spawns
- `scripts/setup_venv.py` for one-shot multi-machine bootstrap

## License

MIT.
