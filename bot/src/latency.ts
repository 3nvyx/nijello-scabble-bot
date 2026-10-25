// Decision-time and improvement summaries for the dashboards.
//
// The live bot logs every decision as "... (<ms> ms)": the time from the
// auction-open event to its words and bid being sent. "failed: Auction
// closed" lines are bids that reached the server after the 1 s auction
// ended. Read from the log tail, so the live bot needs no change.

import { closeSync, openSync, readSync, statSync } from "node:fs";

export interface Latency {
  decisions: number;
  medianMs: number;
  p99Ms: number;
  maxMs: number;
  late: number;
}

export function latencyStats(logPath: string, tailBytes = 400_000): Latency | null {
  try {
    const size = statSync(logPath).size;
    const n = Math.min(size, tailBytes);
    const buf = Buffer.alloc(n);
    const fd = openSync(logPath, "r");
    try {
      readSync(fd, buf, 0, n, size - n);
    } finally {
      closeSync(fd);
    }
    // latin1: the log can hold NUL runs from a crash, which utf8 would mangle.
    const text = buf.toString("latin1");
    const ms = [...text.matchAll(/\((\d+(?:\.\d+)?) ms\)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    if (!ms.length) return null;
    const q = (p: number) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))]!;
    return {
      decisions: ms.length,
      medianMs: q(0.5),
      p99Ms: q(0.99),
      maxMs: ms.at(-1)!,
      late: (text.match(/failed: Auction closed/g) ?? []).length,
    };
  } catch {
    return null;
  }
}

// When the run's confirmed peak was found, from its status.json: the
// generation, and how much training time has passed since without a better one.
export function peakAge(st: any): { gen: number; gensSince: number; trainMsSince: number } | null {
  if (!st?.peak || !Array.isArray(st.bench)) return null;
  const row = st.bench.find((b: any) => b?.gen === st.peak.gen);
  const nowT = Number(st.history?.at?.(-1)?.t ?? st.bench.at(-1)?.t ?? 0);
  return {
    gen: Number(st.peak.gen),
    gensSince: Number(st.gen ?? 0) - Number(st.peak.gen),
    trainMsSince: Math.max(0, nowT - Number(row?.t ?? 0)),
  };
}
