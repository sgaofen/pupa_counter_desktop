# Pupa Counter — Desktop app

Electron + React + TypeScript shell for the Long Lab pupa counter
pipeline. Wraps the real V12 CNN + classifier v5 living in the sister
repo [pupa_counter_v6](https://github.com/sgaofen/pupa_counter_v6).

This is the **user-facing desktop wrapper** Sarah / Anthony / Stephen
use in the lab: scan → detect → hand-edit → save to a local database →
browse and export.

> **New agent picking this up?** Read
> [`HANDOFF_2026-04-23.md`](./HANDOFF_2026-04-23.md) first — it has
> the clone-and-run steps, the path configuration, the scanner
> integration spec, and everywhere you'd want to look before touching
> code.

## Status (2026-04-23)

- ✅ UI scaffold, four screens (Scan / Manual Correct / Database / Settings)
- ✅ Dark mode, theme tokens match the Claude Design mockup pixel-for-pixel
- ✅ Session store with seed sample data (~770 demo pupae across 10 scans)
- ✅ **Real V12 CNN + clf_v5 detection** via Python subprocess
  (shelling out to `pupa_counter_v6/pupa_counter.py --json-out -`)
- ✅ Manual correct canvas — real pan / zoom / L-click add / R-click delete,
  matches the feature set of the Python `label_whole_scan.py` tool
- ✅ Per-pupa detail panel in the Database view
- ✅ Session JSON persistence to `userData/session.json`
- ⏳ Real scanner driver (TWAIN on Windows / ICA on macOS) — scanner
  arrives ~2026-04-23; today the "New scan" button opens a file picker
- ⏳ Stubbed fallback `mockDetection()` remains for browser-only
  (no-Electron) previews
- ⏳ SQLite (`better-sqlite3`) — currently using JSON; swap in once the
  data model is confirmed stable

## Run

```bash
cd pupa_counter_desktop
npm install
npm run dev          # Vite on :5173 + Electron window
```

Production build + package:

```bash
npm run build        # compiles the renderer into dist/
npm run package:mac  # produces a .dmg under release/
npm run package:win  # produces an .exe under release/
```

## Architecture

```
electron/
  main.js               Electron main process (window, IPC, native dialogs)
  preload.js            contextBridge API: session + dialog
src/
  main.tsx              React entry
  App.tsx               Tab router, toast, dark-mode wiring
  styles.css            Design tokens + every component CSS (ported)
  types.ts              Shared TypeScript types (Session / Round / Scan / Pupa)
  components/
    TitleBar.tsx        macOS-style draggable strip
    TopNav.tsx          Brand + tabs + theme toggle + avatar
    icons.tsx           All SVG icons as React components
    ScanImage.tsx       Placeholder SVG of a pupa scan + green detection dots
    ScanImageManual.tsx Variant with CNN/added/removed dot kinds
  pages/
    ScanView.tsx        Main screen: sidebar + scan canvas + metadata form
    ManualCorrectView.tsx
    DatabaseView.tsx    Session tree + filterable table of scans
    SettingsView.tsx    Scanner / model / defaults cards
  adapters/
    cnnAdapter.ts       ⚠️ MOCK — will shell out to the Python CNN
    scannerAdapter.ts   ⚠️ MOCK — will drive the physical scanner
  store/
    sessionStore.ts     Zustand store: session, pending scan, dark mode
```

## Replacing the mocks

### Real scanner (`src/adapters/scannerAdapter.ts`)

Replace `scanNow()` with an Electron-main-process IPC handler that:

1. Lists connected scanners via
   - **macOS**: `ImageCapture.framework` / `icatop`
   - **Windows**: TWAIN (`twain.js` / `node-twain`)
2. Triggers acquisition at the resolution chosen in Settings.
3. Saves the TIFF to the user's default save directory.
4. Returns the absolute path to the renderer.

### Real CNN (already wired — `src/adapters/cnnAdapter.ts`)

The adapter calls `window.pupa.cnn.detect(imagePath)` which routes
through Electron main → `child_process.spawn(PYTHON_BIN, [CNN_SCRIPT,
imagePath, "--json-out", "-"])`. It parses the JSON block between
`<<<JSON>>>` / `<<<END>>>` sentinels.

Paths live at the top of `electron/main.js`:

```js
const PYTHON_BIN =
  process.env.PUPA_PYTHON ||
  "/Users/stephenyu/Documents/pupa_counter_publish/.venv/bin/python";
const CNN_SCRIPT =
  process.env.PUPA_SCRIPT ||
  "/Users/stephenyu/Documents/pupa_counter_v6/pupa_counter.py";
```

On another machine, export `PUPA_PYTHON` and `PUPA_SCRIPT` before
launching, or edit the defaults. The Python side lives in
[pupa_counter_v6](https://github.com/sgaofen/pupa_counter_v6) and the
required `--json-out` flag was added in commit `c62c3ea`.

### SQLite

Replace `session.json` persistence with `better-sqlite3` using the
schema described in `docs/schema.sql` (sessions / rounds / scans /
pupae). Keep the existing `load()` / `save()` IPC shape so only the
main-process handlers change.

## Known UI debts

- The scan image on Main Scan is an SVG placeholder. Once real scans
  arrive, swap `ScanImage` for `<img src={imagePath}/>` with an overlay
  SVG layer for the green dots + rank lines.
- Manual-edit clicks aren't wired yet; the canvas shows a demo of the
  three dot kinds (CNN / added / removed). Real editing needs a
  pan/zoom canvas — consider `react-konva`.
- Database view filters are chips but non-functional. Wire to the
  Zustand store next pass.
- No column sort / pagination in the table yet.
