import React, { useEffect, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { TopNav, type TabName } from "./components/TopNav";
import { ScanView } from "./pages/ScanView";
import { DatabaseView } from "./pages/DatabaseView";
import { SettingsView } from "./pages/SettingsView";
import { useSessionStore } from "./store/sessionStore";

export function App() {
  const darkMode = useSessionStore((s) => s.darkMode);
  const toggleDark = useSessionStore((s) => s.toggleDark);
  const operator = useSessionStore((s) => s.session.operator);
  const initials = operator.split(/\s+/).map((p) => p[0]).join("").slice(0, 2).toUpperCase();

  const [tab, setTab] = useState<TabName>("Scan");
  const [toast, setToast] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate the session store from userData/session.json on mount.
  // Falls back to the seeded demo session if the file is missing or
  // malformed. Only flips `hydrated=true` after this runs so we don't
  // persist the un-hydrated seed over a valid saved file.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const saved = await window.pupa?.session.load?.();
        if (!cancelled && saved && saved.sessionId && Array.isArray(saved.rounds)) {
          useSessionStore.getState().loadSession(saved);
        }
      } catch (err) {
        console.warn("[session] hydrate failed:", err);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Persist after every session mutation. Guarded by `hydrated` so the
  // initial seed doesn't overwrite a good on-disk session before we've
  // had a chance to load it.
  useEffect(() => {
    if (!hydrated || !window.pupa?.session?.save) return;
    // Subscribe — sessionStore updates the `session` object by
    // replacement, so a referential-equality subscribe fires on every
    // meaningful mutation (including commitPendingScan, startNewRound,
    // setOperator, setExperiment).
    const unsub = useSessionStore.subscribe((state, prev) => {
      if (state.session !== prev.session) {
        window.pupa!.session.save(state.session).catch((err: unknown) => {
          console.warn("[session] save failed:", err);
        });
      }
    });
    return unsub;
  }, [hydrated]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2400);
    return () => clearTimeout(t);
  }, [toast]);

  // ⌘S / ⌘P keyboard hooks (lightweight, no dependency).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key.toLowerCase() === "p") { e.preventDefault(); /* TODO: trigger process */ }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-root" data-theme={darkMode ? "dark" : "light"}>
      <TitleBar activeTab={tab} />
      <div className="app">
        <TopNav
          activeTab={tab}
          onTabChange={setTab}
          darkMode={darkMode}
          onToggleDark={toggleDark}
          operatorInitials={initials || "SR"}
          onToast={setToast}
        />
        {tab === "Scan" && <ScanView onNavigate={setTab} onToast={setToast} />}
        {tab === "Database" && <DatabaseView />}
        {tab === "Settings" && <SettingsView onToast={setToast} />}
      </div>
      {toast && (
        <div className="toast good">
          <span className="dot" />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
}
