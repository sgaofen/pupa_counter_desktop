import React, { useState } from "react";
import { Icons } from "../components/icons";
import { ScanImage } from "../components/ScanImage";
import { EditCanvas } from "../components/EditCanvas";
import { useSessionStore } from "../store/sessionStore";
import { scanNow, loadScanFromPath, listDemoScans } from "../adapters/scannerAdapter";
import { runDetection, CnnUnavailableError } from "../adapters/cnnAdapter";
import type { TabName } from "../components/TopNav";
import type { Pupa } from "../types";

interface Props {
  onNavigate: (tab: TabName) => void;
  onToast: (msg: string) => void;
}

/** Any detection whose modelVersion flags it as a mock must NOT be
 *  persisted — the Save button is disabled and we also refuse at
 *  save-time as a second line of defence. */
function isMockModel(modelVersion?: string | null): boolean {
  if (!modelVersion) return false;
  const m = modelVersion.toLowerCase();
  return m.includes("mock") || m.includes("synthetic");
}

export function ScanView({ onNavigate, onToast }: Props) {
  const session = useSessionStore((s) => s.session);
  const currentRoundId = useSessionStore((s) => s.currentRoundId);
  const pendingScan = useSessionStore((s) => s.pendingScan);
  const beginPendingScan = useSessionStore((s) => s.beginPendingScan);
  const setDetection = useSessionStore((s) => s.setDetection);
  const setPendingPupae = useSessionStore((s) => s.setPendingPupae);
  const updatePendingMeta = useSessionStore((s) => s.updatePendingMeta);
  const commitPendingScan = useSessionStore((s) => s.commitPendingScan);
  const startNewRound = useSessionStore((s) => s.startNewRound);

  const [processing, setProcessing] = useState(false);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [zoomCommand, setZoomCommand] = useState<
    { kind: "in" | "out" | "fit"; nonce: number } | null
  >(null);
  const [originalCnn, setOriginalCnn] = useState<Pupa[] | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const state: "empty" | "processing" | "detected" =
    !pendingScan ? "empty" : pendingScan.detection ? "detected" : "processing";

  const round = session.rounds.find((r) => r.roundId === currentRoundId) ?? session.rounds[session.rounds.length - 1];
  const totalScansInSession = session.rounds.reduce((a, r) => a + r.scans.length, 0);
  const totalPupaeInSession = session.rounds.reduce(
    (a, r) => a + r.scans.reduce((b, s) => b + s.totalPupae, 0),
    0
  );
  const runningTotalInRound = (round?.scans ?? []).reduce((a, s) => a + s.totalPupae, 0)
    + (pendingScan?.detection?.counts.total ?? 0);

  const loadAndDetect = async (handle: { path: string; dataUrl: string; width: number; height: number }) => {
    beginPendingScan(handle.path, handle.dataUrl);
    setProcessing(true);
    setDetectionError(null);
    try {
      const detection = await runDetection(handle.path, handle.width, handle.height);
      setDetection(detection);
      setOriginalCnn(detection.pupae);
    } catch (err) {
      // CNN failed — clear detection, surface the real reason, and
      // keep the Save button disabled (guarded by `state !== "detected"`).
      const msg = err instanceof CnnUnavailableError ? err.message
        : err instanceof Error ? err.message
        : String(err);
      console.error("[ScanView] detection failed:", err);
      setDetectionError(msg);
      onToast(`Detection failed — ${msg}`);
    } finally {
      setProcessing(false);
    }
  };

  const handleNewScan = async () => {
    const handle = await scanNow();
    if (!handle) return;
    await loadAndDetect(handle);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    // Electron exposes the absolute filesystem path on dropped File objects.
    // In browser-preview mode this is empty, so fall back to the blob URL.
    const path = (file as File & { path?: string }).path;
    if (path) {
      const handle = await loadScanFromPath(path);
      if (handle) await loadAndDetect(handle);
      return;
    }
    const dataUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      await loadAndDetect({
        path: file.name,
        dataUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };
    img.src = dataUrl;
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      if (!dragActive) setDragActive(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // Only clear when the cursor actually leaves the drop target, not when
    // it moves onto a child element.
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragActive(false);
  };

  const handleLoadDemo = async () => {
    const demos = await listDemoScans();
    if (demos.length === 0) {
      onToast("No demo scans found in pupate_batch");
      return;
    }
    const pick = demos[Math.floor(Math.random() * demos.length)];
    const handle = await loadScanFromPath(pick);
    if (!handle) return;
    await loadAndDetect(handle);
  };

  const handleProcess = async () => {
    if (!pendingScan) return handleNewScan();
    setProcessing(true);
    setDetectionError(null);
    try {
      const det = await runDetection(
        pendingScan.imagePath,
        pendingScan.detection?.imageWidth ?? 1116,
        pendingScan.detection?.imageHeight ?? 2586,
      );
      setDetection(det);
      setOriginalCnn(det.pupae);
    } catch (err) {
      const msg = err instanceof CnnUnavailableError ? err.message
        : err instanceof Error ? err.message
        : String(err);
      console.error("[ScanView] re-process failed:", err);
      setDetectionError(msg);
      onToast(`Detection failed — ${msg}`);
    } finally {
      setProcessing(false);
    }
  };

  const handleRevert = () => {
    if (!originalCnn) return;
    setPendingPupae(originalCnn);
    onToast("Reverted to CNN output");
  };

  const handleSave = () => {
    // Second line of defence: refuse to persist mock detections even if
    // the UI was somehow in a state where the button stayed enabled.
    if (isMockModel(pendingScan?.detection?.modelVersion)) {
      onToast("Refused to save — current detection is from the mock backend");
      return;
    }
    const record = commitPendingScan();
    if (record) {
      onToast(`Saved ${record.id} — ${record.totalPupae} pupae`);
      setOriginalCnn(null);
    }
  };

  const det = pendingScan?.detection;
  const currentPupae: Pupa[] = det?.pupae ?? [];
  const manualAdded = currentPupae.filter((p) => p.source === "manual").length;
  const cnnOriginalCount = originalCnn?.filter((p) => p.source === "cnn").length ?? 0;
  const cnnRemaining = currentPupae.filter((p) => p.source === "cnn").length;
  const removed = Math.max(0, cnnOriginalCount - cnnRemaining);
  const countForThisScan = currentPupae.length;
  const top5Count = det?.counts.top5Pct ?? 0;

  return (
    <div className="s1-body">
      <aside className="sidebar">
        <div className="side-section">
          <div className="label">Session</div>
          <dl className="session-card">
            <dt>Operator</dt><dd>{session.operator}</dd>
            <dt>Experiment</dt><dd>{session.experiment}</dd>
            <dt>Start</dt><dd className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{session.startedAt.slice(0, 10)}</dd>
            <dt>Round</dt><dd>Round {round?.roundNumber ?? 1}</dd>
          </dl>
        </div>
        <div className="side-section">
          <div className="label">Progress</div>
          <div className="session-stats">
            <div className="mini-stat"><div className="n">{totalScansInSession}</div><div className="l">Scans</div></div>
            <div className="mini-stat"><div className="n">{totalPupaeInSession.toLocaleString()}</div><div className="l">Pupae</div></div>
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn" style={{ justifyContent: "center" }} onClick={startNewRound}>
          {Icons.plus} Start new round
        </button>
        <button className="btn btn-ghost" style={{ justifyContent: "center", marginTop: 4 }} onClick={handleLoadDemo}>
          Load demo scan
        </button>
      </aside>

      <section className="middle">
        <div
          className="card scan-card"
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          style={dragActive ? { outline: "2px dashed var(--accent)", outlineOffset: -2 } : undefined}
        >
          <div className="card-head">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div className="card-title">Current scan</div>
              <span className="card-sub">
                {pendingScan ? pendingScan.imagePath.split(/[\\/]/).pop() : "—"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {detectionError && !processing && (
                <span className="pill" style={{
                  color: "var(--bad)",
                  borderColor: "color-mix(in oklab, var(--bad) 30%, transparent)",
                  background: "color-mix(in oklab, var(--bad) 10%, transparent)",
                }} title={detectionError}>
                  <span className="dot" style={{ background: "var(--bad)" }} />
                  Detection failed
                </span>
              )}
              {state === "detected" && !processing && !detectionError && !isMockModel(det?.modelVersion) && (
                <span className="pill good"><span className="dot" />Detection complete</span>
              )}
              {state === "detected" && !processing && isMockModel(det?.modelVersion) && (
                <span className="pill" style={{
                  color: "var(--warn)",
                  borderColor: "color-mix(in oklab, var(--warn) 30%, transparent)",
                  background: "color-mix(in oklab, var(--warn) 10%, transparent)",
                }} title="Mock mode — real Python worker unavailable. Saving is disabled.">
                  <span className="dot" style={{ background: "var(--warn)" }} />
                  MOCK — not real data
                </span>
              )}
              {processing && (
                <span className="pill" style={{
                  color: "var(--accent)",
                  borderColor: "color-mix(in oklab, var(--accent) 30%, transparent)",
                  background: "var(--accent-soft)",
                }}>
                  <span className="dot" />Processing…
                </span>
              )}
              {state === "empty" && !processing && !detectionError && <span className="pill">No scan loaded</span>}
              {(manualAdded > 0 || removed > 0) && (
                <span className="pill" style={{ color: "var(--accent)", borderColor: "color-mix(in oklab, var(--accent) 30%, transparent)", background: "var(--accent-soft)" }}>
                  <span className="dot" />edited
                  {manualAdded > 0 ? ` +${manualAdded}` : ""}
                  {removed > 0 ? ` −${removed}` : ""}
                </span>
              )}
            </div>
          </div>

          {/* Main canvas region */}
          {state === "empty" ? (
            <div
              className="drop-zone"
              onClick={handleNewScan}
              style={{
                cursor: "pointer",
                background: dragActive ? "var(--accent-soft)" : undefined,
              }}
            >
              <div className="inner">
                {Icons.upload}
                <div className="primary">
                  {dragActive ? "Drop file to analyze" : "Drop a scan here or click New scan"}
                </div>
                <div className="secondary">Accepts .png, .jpg — TIFF support TBD</div>
              </div>
            </div>
          ) : pendingScan?.imageDataUrl && det ? (
            <div className="scan-img" style={{ padding: 0, margin: 12, display: "flex", flexDirection: "column" }}>
              <EditCanvas
                imageDataUrl={pendingScan.imageDataUrl}
                imageWidth={det.imageWidth}
                imageHeight={det.imageHeight}
                pupae={currentPupae}
                onChange={(next) => setPendingPupae(next)}
                zoomCommand={zoomCommand}
                showRankLines={true}
              />
            </div>
          ) : (
            <div className="scan-img">
              <ScanImage variant={state} />
            </div>
          )}

          <div className="status-strip">
            <span>{countForThisScan} pupae{state === "detected" && manualAdded + removed > 0 ? ` (CNN ${cnnOriginalCount}${manualAdded > 0 ? ` +${manualAdded}` : ""}${removed > 0 ? ` −${removed}` : ""})` : " detected"}</span>
            <span className="sep">·</span>
            <span>{det?.durationMs ? `${(det.durationMs / 1000).toFixed(1)} s` : "—"}</span>
            <span className="sep">·</span>
            <span>model {det?.modelVersion ?? "—"}</span>
            <span className="sep">·</span>
            <span>{det ? `${det.imageWidth} × ${det.imageHeight}` : "—"}</span>
          </div>
        </div>

        {/* Toolbar */}
        <div className="middle-actions">
          <button className="btn" onClick={handleNewScan}>{Icons.folder} New scan</button>
          <button className="btn btn-primary" onClick={handleProcess} disabled={!pendingScan || processing}>
            {processing ? "Processing…" : <>Process {Icons.arrowRight}</>}
          </button>
          <div className="tool-group" style={{ marginLeft: 4 }}>
            <button className="iconbtn" title="Zoom out (-)"
              onClick={() => setZoomCommand({ kind: "out", nonce: Date.now() })}>
              {Icons.zoomOut}
            </button>
            <button className="iconbtn" title="Zoom in (+)"
              onClick={() => setZoomCommand({ kind: "in", nonce: Date.now() })}>
              {Icons.zoomIn}
            </button>
            <button className="iconbtn" title="Fit (F)"
              onClick={() => setZoomCommand({ kind: "fit", nonce: Date.now() })}>
              {Icons.fit}
            </button>
          </div>
          <button className="btn"
            onClick={handleRevert}
            disabled={!originalCnn || manualAdded + removed === 0}
            title="Revert manual edits — restore CNN output">
            {Icons.undo} Revert
          </button>
          <div className="spacer" />
          <span className="hint mono">L-click add · R-click remove · ⌘Z undo · F fit</span>
        </div>
      </section>

      <aside className="right">
        <div className="card form-card">
          <div className="card-head">
            <div className="card-title">Image information</div>
            <span className="card-sub">Session metadata</span>
          </div>
          <div className="form-grid">
            <div className="field"><label>Your name</label>
              <input className="input"
                value={pendingScan?.metadata.operator ?? session.operator}
                onChange={(e) => updatePendingMeta({ operator: e.target.value })} /></div>
            <div className="field"><label>Date & time</label>
              <input className="input mono" readOnly value={new Date().toISOString().slice(0, 16).replace("T", " ")} /></div>
            <div className="field"><label>File path</label>
              <input className="input mono" readOnly
                value={pendingScan?.imagePath ?? "—"}
                style={{ fontSize: 11.5 }} /></div>
            <div className="field"><label>Experiment</label>
              <input className="input"
                value={pendingScan?.metadata.experiment ?? session.experiment}
                onChange={(e) => updatePendingMeta({ experiment: e.target.value })} /></div>
            <div className="field"><label>Image #</label>
              <div style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: 8, alignItems: "center" }}>
                <input className="input" value={pendingScan?.imageNumber ?? ""} readOnly style={{ textAlign: "center" }} />
                <span className="hint">Auto-increments after save</span>
              </div>
            </div>
            <div className="field"><label>Info filename</label>
              <input className="input mono"
                value={pendingScan?.metadata.infoFilename ?? ""}
                onChange={(e) => updatePendingMeta({ infoFilename: e.target.value })} /></div>
            <div className="field"><label>Genotype</label>
              <select className="select"
                value={pendingScan?.metadata.genotype ?? "Cage B"}
                onChange={(e) => updatePendingMeta({ genotype: e.target.value })}>
                <option>Cage A</option><option>Cage B</option><option>Cage C</option>
                <option>w1118 control</option><option>Custom…</option>
              </select></div>
            <div className="field"><label>Comments</label>
              <textarea className="textarea" placeholder="Optional notes…"
                value={pendingScan?.metadata.comments ?? ""}
                onChange={(e) => updatePendingMeta({ comments: e.target.value })} /></div>
          </div>
        </div>

        <div className="card stats-card">
          <div className="card-head"><div className="card-title">Stats for this scan</div></div>
          <div className="stats-rows">
            <div className="stat-row">
              <div className="label-col">
                <span className="l">Total pupae</span>
                <span className="s">
                  {manualAdded + removed > 0 ? `CNN ${cnnOriginalCount}, after edits` : "Detected on this image"}
                </span>
              </div>
              <div className="n">{countForThisScan}</div>
            </div>
            <div className="stat-row">
              <div className="label-col">
                <span className="l">Rank 0–5% (top)</span>
                <span className="s">Pupae at image bottom</span>
              </div>
              <div className="n accent">{top5Count}</div>
            </div>
            <div className="stat-row">
              <div className="label-col">
                <span className="l">Running total</span>
                <span className="s">Round {round?.roundNumber ?? 1}, all scans</span>
              </div>
              <div className="n">{runningTotalInRound.toLocaleString()}</div>
            </div>
          </div>
        </div>

        <button className="btn btn-primary"
          onClick={handleSave}
          disabled={state !== "detected" || isMockModel(det?.modelVersion) || !!detectionError}
          title={
            isMockModel(det?.modelVersion)
              ? "Save disabled — current detection is from the mock backend. Fix the Python worker in Settings → Detection model."
              : detectionError
              ? `Save disabled — detection failed: ${detectionError}`
              : state !== "detected"
              ? "Load and process a scan first."
              : "Write this scan + its per-pupa rows to the session database."
          }
          style={{ justifyContent: "center", padding: "10px 14px", fontSize: 13 }}>
          {Icons.check} Save to database
        </button>
      </aside>
    </div>
  );
}
