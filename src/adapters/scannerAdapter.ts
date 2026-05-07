/**
 * Scanner adapter.
 *
 * Windows: drives a real WIA scanner via PowerShell COM in the main
 * process. Outside Electron (browser preview) or on a non-Win platform
 * it falls back to a file picker so the rest of the UI still works.
 * The `ScanHandle` interface stays stable regardless of backend.
 */
import type { ScanParams } from "../types";

export interface ScanHandle {
  path: string;
  dataUrl: string;
  width: number;
  height: number;
}

const SETTINGS_KEY = "pupa.scanner.settings.v1";

export interface ScannerSettings {
  deviceId: string;
  dpi: number;
  mode: "color" | "grayscale";
}

export function loadScannerSettings(): ScannerSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as ScannerSettings) : null;
  } catch {
    return null;
  }
}

export function saveScannerSettings(s: ScannerSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export async function scanNow(paramsOverride?: Partial<ScanParams>): Promise<ScanHandle | null> {
  // No Electron bridge → browser preview fallback.
  if (!window.pupa) return await browserFilePicker();

  // No real scanner API (older Electron main.js) → picker fallback, same as
  // the original mock. Keeps dev loops working without a scanner hooked up.
  if (!window.pupa.scanner) return await pickerFallback();

  const settings = loadScannerSettings();
  let deviceId = paramsOverride?.deviceId ?? settings?.deviceId ?? "";

  // Verify the saved deviceId against the live WIA enumeration. Saved IDs
  // go stale across re-plug / driver swaps (e.g. eSCL → legacy WIA), and a
  // stale ID would 404 in scanner:scan. Caller-supplied overrides skip this.
  if (!paramsOverride?.deviceId) {
    const list = await window.pupa.scanner.listDevices();
    const stillValid = deviceId && list.some((d) => d.id === deviceId);
    if (!stillValid && list.length > 0) {
      deviceId = list[0].id;
      saveScannerSettings({
        deviceId,
        dpi: settings?.dpi ?? 300,
        mode: settings?.mode ?? "color",
      });
    } else if (!stillValid) {
      deviceId = "";
    }
  }

  if (!deviceId) return await pickerFallback();

  const savedOutDir = localStorage.getItem("pupa.saveDir.v1") || undefined;
  const params: ScanParams = {
    deviceId,
    dpi: paramsOverride?.dpi ?? settings?.dpi ?? 300,
    mode: paramsOverride?.mode ?? settings?.mode ?? "color",
    outDir: paramsOverride?.outDir ?? savedOutDir,
  };

  const result = await window.pupa.scanner.scan(params);
  const dataUrl = await window.pupa.file.readImageDataUrl(result.path);
  return {
    path: result.path,
    dataUrl,
    width: result.width,
    height: result.height,
  };
}

async function pickerFallback(): Promise<ScanHandle | null> {
  const path = await window.pupa!.dialog.openImage();
  if (!path) return null;
  const dataUrl = await window.pupa!.file.readImageDataUrl(path);
  const dims = await getImageDims(dataUrl);
  return { path, dataUrl, ...dims };
}

/** Load a specific file by path (used by "Load demo scan" button). */
export async function loadScanFromPath(path: string): Promise<ScanHandle | null> {
  if (!window.pupa) return null;
  const dataUrl = await window.pupa.file.readImageDataUrl(path);
  const dims = await getImageDims(dataUrl);
  return { path, dataUrl, ...dims };
}

export async function listDemoScans(): Promise<string[]> {
  return window.pupa ? await window.pupa.file.listDemoScans() : [];
}

function getImageDims(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 1116, height: 2586 });
    img.src = dataUrl;
  });
}

function browserFilePicker(): Promise<ScanHandle | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return resolve(null);
      const url = URL.createObjectURL(f);
      const dims = await getImageDims(url);
      resolve({ path: f.name, dataUrl: url, ...dims });
    };
    input.click();
  });
}
