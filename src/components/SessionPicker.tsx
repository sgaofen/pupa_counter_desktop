import React, { useEffect, useRef, useState } from "react";
import type { Session, SessionSummary } from "../types";
import { useSessionStore } from "../store/sessionStore";

/**
 * Session switcher used in the top nav. Lists every session file in
 * <userData>/sessions/ and lets the operator switch to any of them or
 * spin up a fresh one (auto-named YYYY-MM-DD-HH-MM-SS in LA time).
 */
export function SessionPicker({ onToast }: { onToast?: (msg: string) => void }) {
  const session = useSessionStore((s) => s.session);
  const loadSession = useSessionStore((s) => s.loadSession);
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SessionSummary[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Refresh the list whenever the dropdown opens. No pre-fetch — the
  // count badge isn't visible until open is true.
  useEffect(() => {
    if (!open || !window.pupa?.session?.list) return;
    window.pupa.session.list().then(setList).catch(() => setList([]));
  }, [open]);

  function adopt(data: Session, msg: string) {
    if (!data?.sessionId || !Array.isArray(data.rounds)) return;
    loadSession(data);
    onToast?.(msg);
    setOpen(false);
  }

  async function switchTo(id: string) {
    if (!window.pupa?.session?.load) return;
    if (id === session.sessionId) { setOpen(false); return; }
    const data = await window.pupa.session.load(id);
    if (data) adopt(data, `Switched to ${data.sessionId}`);
    else setOpen(false);
  }

  async function createNew() {
    if (!window.pupa?.session?.create) return;
    const data = await window.pupa.session.create({
      operator: session.operator,
      experiment: session.experiment,
    });
    if (data) adopt(data, `New session: ${data.sessionId}`);
    else setOpen(false);
  }

  const sessionLabel = session.sessionId || "no session";

  return (
    <div className="session-picker" ref={ref} style={{ position: "relative" }}>
      <button
        className="iconbtn"
        title="Switch / create session"
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: "4px 10px", fontSize: 12, borderRadius: 6,
          minWidth: 140, maxWidth: 220, textOverflow: "ellipsis",
          overflow: "hidden", whiteSpace: "nowrap",
        }}
      >
        📁 {sessionLabel} ▾
      </button>
      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0,
            width: 320, maxHeight: 380, overflowY: "auto",
            background: "var(--card-bg, #fff)", color: "var(--text, #111)",
            border: "1px solid var(--border, #ddd)", borderRadius: 8,
            boxShadow: "0 6px 18px rgba(0,0,0,0.15)", zIndex: 1000,
            padding: 6,
          }}
        >
          <button
            onClick={createNew}
            style={{
              width: "100%", padding: "8px 12px", border: "none",
              borderRadius: 6, background: "#2A8C46", color: "#fff",
              fontWeight: 600, cursor: "pointer", marginBottom: 6,
            }}
          >
            + New session (dated)
          </button>
          <div style={{ fontSize: 11, opacity: 0.6, padding: "4px 8px" }}>
            {list.length} saved session{list.length === 1 ? "" : "s"} · newest first
          </div>
          {list.length === 0 && (
            <div style={{ fontSize: 12, opacity: 0.6, padding: 8, textAlign: "center" }}>
              No sessions yet — start one above.
            </div>
          )}
          {list.map((s) => {
            const active = s.sessionId === session.sessionId;
            return (
              <div
                key={s.sessionId}
                onClick={() => switchTo(s.sessionId)}
                style={{
                  padding: "8px 10px", borderRadius: 6,
                  cursor: "pointer", marginBottom: 2,
                  background: active ? "rgba(42,140,70,0.15)" : "transparent",
                  border: active ? "1px solid #2A8C46" : "1px solid transparent",
                }}
                onMouseEnter={(e) => {
                  if (!active) (e.currentTarget.style.background = "rgba(0,0,0,0.05)");
                }}
                onMouseLeave={(e) => {
                  if (!active) (e.currentTarget.style.background = "transparent");
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, fontFamily: "monospace" }}>
                  {s.sessionId}
                </div>
                <div style={{ fontSize: 11, opacity: 0.7 }}>
                  {s.startedAt || "—"}  ·  {s.rounds} round{s.rounds === 1 ? "" : "s"}
                  ·  {s.scans} scan{s.scans === 1 ? "" : "s"}
                </div>
                {(s.operator || s.experiment) && (
                  <div style={{ fontSize: 11, opacity: 0.55 }}>
                    {[s.operator, s.experiment].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
