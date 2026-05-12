import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Pupa, RankBand } from "../types";

/** Pan + zoom + click-to-edit canvas.
 *
 *  Controls:
 *    • Mouse wheel              — zoom anchored at cursor
 *    • Left click (empty)       — add pupa at that position
 *    • Right click              — delete nearest pupa within 20 px
 *    • Click on existing dot    — select (shift-click for multi-remove later)
 *    • Middle-click drag / ⌃ +  — pan
 *    • Arrow keys               — pan 40 px
 *    • + / =  /  -              — zoom in / out around current center
 *    • F                         — fit to window
 *    • T / B                     — pan so image TOP / BOTTOM is at viewport center
 *
 *  Edge behaviour (matches label_whole_scan.py fix from 2026-04-16):
 *  when the image is larger than the viewport, pan bounds allow the image
 *  top / bottom to reach the viewport CENTER so the user can always see
 *  and click the extreme edges.
 */

function bandFor(rankPct: number): RankBand {
  if (rankPct < 5) return "0-5%";
  if (rankPct < 25) return "5-25%";
  if (rankPct < 75) return "25-75%";
  return "75-100%";
}

interface Props {
  imageDataUrl: string;
  imageWidth: number;
  imageHeight: number;
  pupae: Pupa[];
  onChange: (next: Pupa[]) => void;
  onDirtyChange?: (dirty: boolean) => void;
  zoomCommand?: { kind: "in" | "out" | "fit"; nonce: number } | null;
  showRankLines?: boolean;
}

const HIT_PX = 20;          // right-click delete radius in IMAGE pixels
const DOT_SCREEN_RADIUS = 5; // on-screen dot radius; scales with zoom

export function EditCanvas({
  imageDataUrl,
  imageWidth,
  imageHeight,
  pupae,
  onChange,
  onDirtyChange,
  zoomCommand,
  showRankLines = true,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStart = useRef({ sx: 0, sy: 0, ox: 0, oy: 0 });
  const undoStack = useRef<Pupa[][]>([]);
  const redoStack = useRef<Pupa[][]>([]);

  // Observe container size.
  useEffect(() => {
    if (!hostRef.current) return;
    const el = hostRef.current;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fitZoom = useMemo(() => {
    if (size.w === 0 || size.h === 0 || imageWidth === 0) return 1;
    return Math.min(size.w / imageWidth, size.h / imageHeight);
  }, [size, imageWidth, imageHeight]);

  // On image change or initial mount → start at 2.5× fit so pupae are
  // visible at usable scale (LiDE 300 scans are paper-sized; fit-to-window
  // makes individual pupae ~6 px tall, too small for accurate clicking).
  useEffect(() => {
    if (fitZoom <= 0) return;
    const initialZoom = fitZoom * 2.5;
    setZoom(initialZoom);
    setOffset({
      x: (size.w - imageWidth * initialZoom) / 2,
      y: (size.h - imageHeight * initialZoom) / 2,
    });
  }, [imageDataUrl, fitZoom, size.w, size.h, imageWidth, imageHeight]);

  /** Clamp offset so the image can be panned such that any edge reaches
   *  the viewport centre (but never wholly off-screen). */
  const clampOffset = useCallback(
    (ox: number, oy: number, z: number) => {
      const imgPxW = imageWidth * z;
      const imgPxH = imageHeight * z;
      let nx = ox, ny = oy;
      if (imgPxW < size.w) {
        nx = (size.w - imgPxW) / 2;
      } else {
        // Allow offset so image x=0 sits at viewport centre, and image x=W sits at centre.
        const minX = size.w / 2 - imgPxW;
        const maxX = size.w / 2;
        nx = Math.max(minX, Math.min(maxX, ox));
      }
      if (imgPxH < size.h) {
        ny = (size.h - imgPxH) / 2;
      } else {
        const minY = size.h / 2 - imgPxH;
        const maxY = size.h / 2;
        ny = Math.max(minY, Math.min(maxY, oy));
      }
      return { x: nx, y: ny };
    },
    [imageWidth, imageHeight, size.w, size.h]
  );

  const screenToImage = useCallback(
    (sx: number, sy: number) => ({
      x: (sx - offset.x) / zoom,
      y: (sy - offset.y) / zoom,
    }),
    [offset, zoom]
  );

  const zoomAt = useCallback(
    (factor: number, cx: number, cy: number) => {
      const minZoom = fitZoom * 0.4;
      const maxZoom = 40;
      const nextZoom = Math.max(minZoom, Math.min(maxZoom, zoom * factor));
      const ratio = nextZoom / zoom;
      const nextOffset = {
        x: cx - (cx - offset.x) * ratio,
        y: cy - (cy - offset.y) * ratio,
      };
      const clamped = clampOffset(nextOffset.x, nextOffset.y, nextZoom);
      setZoom(nextZoom);
      setOffset(clamped);
    },
    [zoom, offset, fitZoom, clampOffset]
  );

  const fit = useCallback(() => {
    setZoom(fitZoom);
    setOffset({
      x: (size.w - imageWidth * fitZoom) / 2,
      y: (size.h - imageHeight * fitZoom) / 2,
    });
  }, [fitZoom, size, imageWidth, imageHeight]);

  // Handle external zoom commands from the toolbar.
  useEffect(() => {
    if (!zoomCommand) return;
    const cx = size.w / 2;
    const cy = size.h / 2;
    if (zoomCommand.kind === "in") zoomAt(1.4, cx, cy);
    else if (zoomCommand.kind === "out") zoomAt(1 / 1.4, cx, cy);
    else if (zoomCommand.kind === "fit") fit();
  }, [zoomCommand]); // eslint-disable-line react-hooks/exhaustive-deps

  const pushUndo = useCallback(() => {
    undoStack.current.push(pupae);
    // cap history size
    if (undoStack.current.length > 50) undoStack.current.shift();
    redoStack.current = [];
    onDirtyChange?.(true);
  }, [pupae, onDirtyChange]);

  const recomputeRanks = useCallback((list: Pupa[]): Pupa[] => {
    if (list.length === 0) return list;
    const ys = list.map((p) => p.y);
    const yMax = Math.max(...ys);
    const yMin = Math.min(...ys);
    const range = Math.max(1, yMax - yMin);
    return list
      .map((p, i) => {
        const rank = ((yMax - p.y) / range) * 100;
        return {
          ...p,
          index: i + 1,
          rankPct: Number(rank.toFixed(2)),
          band: bandFor(rank),
        };
      });
  }, []);

  const addPupa = useCallback(
    (ix: number, iy: number) => {
      pushUndo();
      const next = recomputeRanks([
        ...pupae,
        {
          index: pupae.length + 1,
          x: Math.round(ix),
          y: Math.round(iy),
          rankPct: 0,
          band: "25-75%",
          source: "manual",
        },
      ]);
      onChange(next);
    },
    [pupae, onChange, pushUndo, recomputeRanks]
  );

  const removeNearest = useCallback(
    (ix: number, iy: number) => {
      if (pupae.length === 0) return;
      let bestIdx = -1, bestDist = HIT_PX * HIT_PX;
      for (let i = 0; i < pupae.length; i++) {
        const dx = pupae[i].x - ix;
        const dy = pupae[i].y - iy;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestDist) { bestDist = d2; bestIdx = i; }
      }
      if (bestIdx < 0) return;
      pushUndo();
      const next = recomputeRanks(pupae.filter((_, i) => i !== bestIdx));
      onChange(next);
    },
    [pupae, onChange, pushUndo, recomputeRanks]
  );

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(pupae);
    onChange(prev);
  }, [pupae, onChange]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(pupae);
    onChange(next);
  }, [pupae, onChange]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.target as HTMLElement | null)?.tagName === "INPUT" ||
        (e.target as HTMLElement | null)?.tagName === "TEXTAREA"
      ) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      const step = 50;
      if (e.key === "ArrowLeft") { setOffset((o) => clampOffset(o.x + step, o.y, zoom)); e.preventDefault(); }
      else if (e.key === "ArrowRight") { setOffset((o) => clampOffset(o.x - step, o.y, zoom)); e.preventDefault(); }
      else if (e.key === "ArrowUp") { setOffset((o) => clampOffset(o.x, o.y + step, zoom)); e.preventDefault(); }
      else if (e.key === "ArrowDown") { setOffset((o) => clampOffset(o.x, o.y - step, zoom)); e.preventDefault(); }
      else if (e.key === "+" || e.key === "=") { zoomAt(1.25, size.w / 2, size.h / 2); e.preventDefault(); }
      else if (e.key === "-" || e.key === "_") { zoomAt(1 / 1.25, size.w / 2, size.h / 2); e.preventDefault(); }
      else if (e.key.toLowerCase() === "f") { fit(); e.preventDefault(); }
      else if (e.key.toLowerCase() === "t") {
        // pan image top (y=0) to viewport center
        setOffset((o) => clampOffset(o.x, size.h / 2, zoom));
        e.preventDefault();
      } else if (e.key.toLowerCase() === "b") {
        // pan image bottom (y=imageHeight) to viewport center
        setOffset((o) => clampOffset(o.x, size.h / 2 - imageHeight * zoom, zoom));
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, zoomAt, fit, clampOffset, zoom, size.w, size.h, imageHeight]);

  const onWheel: React.WheelEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    zoomAt(factor, cx, cy);
  };

  const onMouseDown: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (e.button === 1 || (e.button === 0 && (e.ctrlKey || e.altKey))) {
      setPanning(true);
      panStart.current = { sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y };
      e.preventDefault();
    }
  };
  const onMouseMove: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (!panning) return;
    const dx = e.clientX - panStart.current.sx;
    const dy = e.clientY - panStart.current.sy;
    setOffset(clampOffset(panStart.current.ox + dx, panStart.current.oy + dy, zoom));
  };
  const onMouseUp: React.MouseEventHandler<HTMLDivElement> = () => setPanning(false);

  const onClick: React.MouseEventHandler<HTMLDivElement> = (e) => {
    if (panning) return;
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const p = screenToImage(sx, sy);
    if (p.x < 0 || p.x > imageWidth || p.y < 0 || p.y > imageHeight) return;
    addPupa(p.x, p.y);
  };

  const onContextMenu: React.MouseEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return;
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const p = screenToImage(sx, sy);
    removeNearest(p.x, p.y);
  };

  return (
    <div
      ref={hostRef}
      className="edit-canvas-host"
      onWheel={onWheel}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{ cursor: panning ? "grabbing" : "crosshair" }}
    >
      <div
        className="edit-canvas-inner"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          width: imageWidth,
          height: imageHeight,
        }}
      >
        <img
          src={imageDataUrl}
          alt="scan"
          draggable={false}
          width={imageWidth}
          height={imageHeight}
          style={{ display: "block", userSelect: "none", pointerEvents: "none" }}
        />
        <svg
          width={imageWidth}
          height={imageHeight}
          viewBox={`0 0 ${imageWidth} ${imageHeight}`}
          style={{
            position: "absolute", top: 0, left: 0,
            pointerEvents: "none",
          }}
        >
          {showRankLines && pupae.length > 0 && (() => {
            const ys = pupae.map((p) => p.y);
            const yMax = Math.max(...ys);
            const yMin = Math.min(...ys);
            const range = Math.max(1, yMax - yMin);
            const lineY = (p: number) => yMax - (p / 100) * range;
            const strokeW = 1.2 / zoom;
            const dash = `${6 / zoom} ${4 / zoom}`;
            const fontSize = 10 / zoom;
            return (
              <g style={{ pointerEvents: "none" }}>
                <line x1={0} x2={imageWidth} y1={lineY(5)} y2={lineY(5)}
                  stroke="#B4362E" strokeWidth={strokeW} strokeDasharray={dash} opacity={0.85} />
                <text x={6} y={lineY(5) - 4 / zoom} fontSize={fontSize} fill="#B4362E"
                  fontFamily="ui-monospace, SF Mono, monospace" fontWeight={600}>RANK 5%</text>
                <line x1={0} x2={imageWidth} y1={lineY(25)} y2={lineY(25)}
                  stroke="#C77A1D" strokeWidth={strokeW} strokeDasharray={dash} opacity={0.8} />
                <text x={6} y={lineY(25) - 4 / zoom} fontSize={fontSize} fill="#C77A1D"
                  fontFamily="ui-monospace, SF Mono, monospace" fontWeight={600}>RANK 25%</text>
                <line x1={0} x2={imageWidth} y1={lineY(75)} y2={lineY(75)}
                  stroke="#C77A1D" strokeWidth={strokeW} strokeDasharray={dash} opacity={0.8} />
                <text x={6} y={lineY(75) - 4 / zoom} fontSize={fontSize} fill="#C77A1D"
                  fontFamily="ui-monospace, SF Mono, monospace" fontWeight={600}>RANK 75%</text>
              </g>
            );
          })()}
          {pupae.map((p) => (
            <g key={p.index + ":" + p.x + ":" + p.y}>
              <circle
                cx={p.x} cy={p.y}
                r={DOT_SCREEN_RADIUS / zoom}
                fill={p.source === "manual" ? "#1F5F6B" : "#2BA557"}
                stroke="white"
                strokeWidth={1.2 / zoom}
              />
            </g>
          ))}
        </svg>
      </div>
      <div className="edit-canvas-hud">
        <span className="mono">zoom {(zoom * 100).toFixed(0)}%</span>
        <span className="sep">·</span>
        <span className="mono">{pupae.length} pupae</span>
        <span className="sep">·</span>
        <span>L-click add · R-click delete · +/− zoom · ←↑↓→ pan · F fit · T/B top/bot · ⌘Z undo</span>
      </div>
    </div>
  );
}
