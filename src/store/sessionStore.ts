import { create } from "zustand";
import type { DetectionResult, Pupa, RankBand, Round, ScanRecord, Session } from "../types";

// sv-SE locale yields "YYYY-MM-DD HH:MM:SS"; pinned to LA wall-clock so
// log timestamps stay readable for the lab even when scans happen on a
// laptop set to a different timezone.
const LA_DT_FMT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
});
export function isoNow(): string {
  return LA_DT_FMT.format(new Date()).replace(",", "");
}

function bandFor(rankPct: number): RankBand {
  if (rankPct < 5) return "0-5%";
  if (rankPct < 25) return "5-25%";
  if (rankPct < 75) return "25-75%";
  return "75-100%";
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generates a deterministic-but-realistic pupa list for a scan, with
 *  band counts matching the `bands` parameter (best-effort). */
function synthesizePupae(
  seed: number,
  bands: [number, number, number, number],
  imageWidth: number,
  imageHeight: number
): Pupa[] {
  const total = bands.reduce((a, b) => a + b, 0);
  const rand = mulberry32(seed);
  const pupae: Pupa[] = [];

  const bandRanges: { min: number; max: number; target: number }[] = [
    { min: 0, max: 5, target: bands[0] },
    { min: 5, max: 25, target: bands[1] },
    { min: 25, max: 75, target: bands[2] },
    { min: 75, max: 100, target: bands[3] },
  ];

  let idx = 0;
  for (const b of bandRanges) {
    for (let i = 0; i < b.target; i++) {
      const rankPct = b.min + rand() * (b.max - b.min);
      const y = imageHeight - (rankPct / 100) * (imageHeight - 40) - 20;
      const x = 40 + rand() * (imageWidth - 80);
      pupae.push({
        index: ++idx,
        x: Math.round(x),
        y: Math.round(y),
        rankPct: Number(rankPct.toFixed(2)),
        band: bandFor(rankPct),
        source: "cnn",
      });
    }
  }
  // Shuffle order a bit so pupa_idx is not strictly sorted by band.
  for (let i = pupae.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [pupae[i], pupae[j]] = [pupae[j], pupae[i]];
  }
  return pupae.map((p, i) => ({ ...p, index: i + 1 }));
}

function makeSample(
  id: string,
  roundNumber: number,
  imageNumber: number,
  timestamp: string,
  total: number,
  bands: [number, number, number, number],
  genotype: string,
  seed: number
): ScanRecord {
  const W = 1116, H = 2586;
  const pupae = synthesizePupae(seed, bands, W, H);
  return {
    id,
    roundNumber,
    imageNumber,
    timestamp,
    imagePath: `/Users/stephenyu/Downloads/pupate_batch/Scan_20260313 (${imageNumber}).png`,
    imageWidth: W,
    imageHeight: H,
    experiment: "B-cage pilot",
    operator: "Sarah Ruckman",
    genotype,
    comments: "",
    infoFilename: `round${roundNumber}.asc`,
    totalPupae: total,
    top5PctCount: bands[0],
    rank5To25Count: bands[1],
    middle50Count: bands[2],
    bottom25Count: bands[3],
    yMin: Math.min(...pupae.map((p) => p.y)),
    yMax: Math.max(...pupae.map((p) => p.y)),
    manuallyEdited: false,
    pupae,
  };
}

function makeSeedSession(): Session {
  return {
    sessionId: "sess_2026-04-22",
    operator: "Sarah Ruckman",
    experiment: "B-cage pilot",
    startedAt: "2026-04-22 13:02",
    rounds: [
      {
        roundId: "r1", roundNumber: 1, startedAt: "2026-04-22 13:02",
        scans: [
          makeSample("s_004", 1, 4, "2026-04-22 14:20", 97, [5, 21, 47, 24], "w1118", 4),
          makeSample("s_005", 1, 5, "2026-04-22 14:44", 102, [5, 22, 50, 25], "w1118", 5),
        ],
      },
      {
        roundId: "r2", roundNumber: 2, startedAt: "2026-04-22 17:00",
        scans: [
          makeSample("s_006", 2, 6, "2026-04-22 17:02", 69, [3, 14, 34, 18], "Cage A", 6),
          makeSample("s_007", 2, 7, "2026-04-22 17:31", 77, [3, 15, 39, 20], "Cage A", 7),
          makeSample("s_008", 2, 8, "2026-04-22 17:58", 83, [4, 17, 41, 21], "Cage A", 8),
          makeSample("s_009", 2, 9, "2026-04-22 18:22", 88, [4, 19, 44, 21], "Cage A", 9),
          makeSample("s_010", 2, 10, "2026-04-22 18:51", 94, [5, 20, 48, 21], "Cage A", 10),
        ],
      },
      {
        roundId: "r3", roundNumber: 3, startedAt: "2026-04-22 21:00",
        scans: [
          makeSample("s_011", 3, 11, "2026-04-22 21:05", 71, [4, 18, 34, 15], "Cage B", 11),
          makeSample("s_012", 3, 12, "2026-04-22 21:28", 58, [2, 11, 30, 15], "Cage B", 12),
          makeSample("s_013", 3, 13, "2026-04-22 21:47", 62, [3, 13, 31, 15], "Cage B", 13),
        ],
      },
    ],
  };
}

interface PendingScanMeta {
  operator: string;
  experiment: string;
  genotype: string;
  comments: string;
  infoFilename: string;
}

interface PendingScan {
  imagePath: string;
  imageDataUrl: string | null;  // populated once file is read
  imageNumber: number;
  /** The round this scan was STARTED in. Commit always targets this
   *  round even if the user switches to a different one mid-edit —
   *  otherwise a scan that belongs to round N could silently end up
   *  filed under N+1. */
  roundId: string;
  detection: DetectionResult | null;
  metadata: PendingScanMeta;
}

interface SessionState {
  session: Session;
  currentRoundId: string;
  pendingScan: PendingScan | null;
  darkMode: boolean;
  toast: string | null;

  setOperator: (name: string) => void;
  setExperiment: (name: string) => void;
  toggleDark: () => void;
  setToast: (msg: string | null) => void;
  startNewRound: () => void;
  loadSession: (data: Session) => void;

  beginPendingScan: (imagePath: string, imageDataUrl: string | null) => void;
  setDetection: (d: DetectionResult) => void;
  setPendingPupae: (pupae: Pupa[]) => void;
  updatePendingMeta: (m: Partial<PendingScanMeta>) => void;
  commitPendingScan: () => ScanRecord | null;
  clearPendingScan: () => void;
}

export const useSessionStore = create<SessionState>((set, get) => ({
  session: makeSeedSession(),
  currentRoundId: "r3",
  pendingScan: null,
  darkMode: false,
  toast: null,

  setOperator: (name) => set((s) => ({ session: { ...s.session, operator: name } })),
  setExperiment: (name) => set((s) => ({ session: { ...s.session, experiment: name } })),
  toggleDark: () => set((s) => ({ darkMode: !s.darkMode })),
  setToast: (msg) => set({ toast: msg }),

  loadSession: (data) => {
    // Pick the latest round if any; else r1. Clears any in-flight pending
    // scan so it can't accidentally land on the wrong session.
    const rid = data.rounds[data.rounds.length - 1]?.roundId
              ?? data.rounds[0]?.roundId
              ?? "r1";
    set({ session: data, currentRoundId: rid, pendingScan: null });
  },

  startNewRound: () => {
    const { session } = get();
    const nextNumber = Math.max(0, ...session.rounds.map((r) => r.roundNumber)) + 1;
    const newRound: Round = {
      roundId: `r${nextNumber}`,
      roundNumber: nextNumber,
      startedAt: isoNow(),
      scans: [],
    };
    set({
      session: { ...session, rounds: [...session.rounds, newRound] },
      currentRoundId: newRound.roundId,
    });
  },

  beginPendingScan: (imagePath, imageDataUrl) => {
    const { session, currentRoundId } = get();
    const round = session.rounds.find((r) => r.roundId === currentRoundId) ?? session.rounds[0];
    const lastImgNum = round && round.scans.length > 0
      ? round.scans[round.scans.length - 1].imageNumber + 1
      : 1;
    set({
      pendingScan: {
        imagePath,
        imageDataUrl,
        imageNumber: lastImgNum,
        roundId: round?.roundId ?? "",
        detection: null,
        metadata: {
          operator: session.operator,
          experiment: session.experiment,
          genotype: "Cage B",
          comments: "",
          infoFilename: `round${round?.roundNumber ?? 1}.asc`,
        },
      },
    });
  },

  setDetection: (d) => set((s) => ({
    pendingScan: s.pendingScan ? { ...s.pendingScan, detection: d } : s.pendingScan,
  })),

  setPendingPupae: (pupae) => set((s) => {
    if (!s.pendingScan || !s.pendingScan.detection) return s;
    const top5 = pupae.filter((p) => p.band === "0-5%").length;
    const b25 = pupae.filter((p) => p.band === "5-25%").length;
    const b75 = pupae.filter((p) => p.band === "25-75%").length;
    const bot = pupae.filter((p) => p.band === "75-100%").length;
    return {
      pendingScan: {
        ...s.pendingScan,
        detection: {
          ...s.pendingScan.detection,
          pupae,
          counts: { total: pupae.length, top5Pct: top5, rank5To25: b25, middle50: b75, bottom25: bot },
        },
      },
    };
  }),

  updatePendingMeta: (m) => set((s) => s.pendingScan
    ? { pendingScan: { ...s.pendingScan, metadata: { ...s.pendingScan.metadata, ...m } } }
    : s),

  commitPendingScan: () => {
    const { pendingScan, session } = get();
    if (!pendingScan || !pendingScan.detection) return null;
    // Always file the scan under the round it was STARTED in — not
    // whatever the user switched to later. Falls back to currentRoundId
    // only for hand-constructed payloads that somehow lack roundId.
    const targetRoundId = pendingScan.roundId || get().currentRoundId;
    const round = session.rounds.find((r) => r.roundId === targetRoundId);
    if (!round) return null;
    const d = pendingScan.detection;
    const manuallyEdited = d.pupae.some((p) => p.source === "manual");
    const record: ScanRecord = {
      id: `s_${String(Math.floor(Math.random() * 100000)).padStart(5, "0")}`,
      roundNumber: round.roundNumber,
      imageNumber: pendingScan.imageNumber,
      timestamp: isoNow(),
      imagePath: pendingScan.imagePath,
      imageWidth: d.imageWidth,
      imageHeight: d.imageHeight,
      experiment: pendingScan.metadata.experiment,
      operator: pendingScan.metadata.operator,
      genotype: pendingScan.metadata.genotype,
      comments: pendingScan.metadata.comments,
      infoFilename: pendingScan.metadata.infoFilename,
      totalPupae: d.counts.total,
      top5PctCount: d.counts.top5Pct,
      rank5To25Count: d.counts.rank5To25,
      middle50Count: d.counts.middle50,
      bottom25Count: d.counts.bottom25,
      yMin: d.yMin,
      yMax: d.yMax,
      manuallyEdited,
      pupae: d.pupae,
    };
    const updatedRounds = session.rounds.map((r) =>
      r.roundId === targetRoundId ? { ...r, scans: [...r.scans, record] } : r
    );
    set({
      session: { ...session, rounds: updatedRounds },
      pendingScan: null,
    });
    return record;
  },

  clearPendingScan: () => set({ pendingScan: null }),
}));
