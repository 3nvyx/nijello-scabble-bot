// Calibrates the profiled opponents' bids against what our bot faced live.
// In every auction of our live matches the strongest opposing bid is public
// once the match ends: the price we paid when we won, else the winner's bid.
// Replays of those matches (src/fidelity.ts) should show the same spread of
// that bid in each third of the match. This fits the per-phase shift and
// spread of the profiles' log-bids (opponents.ts setProfileShift) to it, and
// reports how often a bid of a given size wins, live and simulated.
//
//   node src/calibrate-bids.ts [--rounds 6] [--reps 4] [--style data/styles.json] [--workers 19] [--write]
//   node src/calibrate-bids.ts --diag        replay with the current calibration only
//
// Only the training split is used. Replays run on worker threads.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { type Bot, playMatch } from "./game.ts";
import { END_AUCTIONS, setProfileShift } from "./opponents.ts";
import { liveBids, loadReplay, type Replay, replaySeed, seatBot } from "./fidelity.ts";
import { EvoBot } from "./strategy.ts";
import { placeFraction } from "./tables.ts";

const root = new URL("..", import.meta.url).pathname;
const OUR_BOT = process.env.OUR_BOT ?? "Nijello";
const MAXB = 100;
const SEGMENTS = ["first third", "second third", "last third", "endgame"];
const BUCKETS = [1, 5, 10, 15, 25, 1e9];
const QS = [0.25, 0.5, 0.75, 0.9];

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}

interface Stats {
  matches: number;
  opp: number[][]; // [segment][bid] count of the strongest opposing bid
  segWin: number[][]; // [segment] [our bids placed, won]
  curve: [number, number][]; // our bids by BUCKETS: [placed, won]
  byLetter: number[][]; // [letter] [count, sum of log1p(strongest rival bid)]
  byOurBid: number[][]; // [our BUCKETS][bid] count of the strongest rival bid
  // Per-match mean of log1p(strongest rival bid): [sum, sum of squares].
  // Their spread says how much price levels differ between matches.
  matchLevel: number[];
  // Real (non-sim) opponents: best and mean score per match, and their
  // words: [count, 7+ letters, summed reward].
  oppBest: number;
  oppMean: number;
  oppWords: number[];
  tiles: number;
  place: number;
  win: number;
  score: number;
}
const newStats = (): Stats => ({
  matches: 0,
  opp: SEGMENTS.map(() => new Array<number>(MAXB + 1).fill(0)),
  segWin: SEGMENTS.map(() => [0, 0]),
  curve: BUCKETS.slice(1).map(() => [0, 0]),
  byLetter: Array.from({ length: 26 }, () => [0, 0]),
  byOurBid: BUCKETS.slice(1).map(() => new Array<number>(MAXB + 1).fill(0)),
  matchLevel: [0, 0],
  oppBest: 0,
  oppMean: 0,
  oppWords: [0, 0, 0],
  tiles: 0,
  place: 0,
  win: 0,
  score: 0,
});
function addStats(a: Stats, b: Stats): void {
  a.matches += b.matches;
  a.opp.forEach((h, ph) => h.forEach((_, i) => (h[i]! += b.opp[ph]![i]!)));
  a.segWin.forEach((x, ph) => {
    x[0]! += b.segWin[ph]![0]!;
    x[1]! += b.segWin[ph]![1]!;
  });
  a.curve.forEach((c, i) => {
    c[0] += b.curve[i]![0];
    c[1] += b.curve[i]![1];
  });
  a.byLetter.forEach((x, i) => {
    x[0]! += b.byLetter[i]![0]!;
    x[1]! += b.byLetter[i]![1]!;
  });
  a.byOurBid.forEach((h, k) => h.forEach((_, i) => (h[i]! += b.byOurBid[k]![i]!)));
  a.matchLevel[0]! += b.matchLevel[0]!;
  a.matchLevel[1]! += b.matchLevel[1]!;
  a.oppBest += b.oppBest;
  a.oppMean += b.oppMean;
  a.oppWords.forEach((_, i) => (a.oppWords[i]! += b.oppWords[i]!));
  a.tiles += b.tiles;
  a.place += b.place;
  a.win += b.win;
  a.score += b.score;
}
// Segments of a match: its thirds, with the last END_AUCTIONS auctions apart
// (as ProfileBot picks its shift).
const phaseOf = (k: number, n: number) => (k >= n - END_AUCTIONS ? 3 : Math.min(2, Math.floor((3 * k) / n)));
function addCurve(s: Stats, bid: number, won: boolean, rival: number): void {
  const b = BUCKETS.findIndex((lo, i) => bid >= lo && bid < BUCKETS[i + 1]!);
  if (b < 0) return;
  s.curve[b]![0]++;
  if (won) s.curve[b]![1]++;
  s.byOurBid[b]![Math.min(MAXB, rival)]!++;
}
function addRival(s: Stats, phase: number, letter: number, rival: number): void {
  s.opp[phase]![Math.min(MAXB, rival)]!++;
  s.byLetter[letter]![0]!++;
  s.byLetter[letter]![1]! += Math.log1p(rival);
}

// Opponent scores of one match; sims are left out, as in src/fidelity.ts.
function addOpp(s: Stats, scores: number[], me: number, sim: boolean[]): void {
  const opp = scores.filter((_, k) => k !== me && !sim[k]);
  if (!opp.length) return;
  s.oppBest += Math.max(...opp);
  s.oppMean += opp.reduce((a, b) => a + b, 0) / opp.length;
}
function addOppWord(s: Stats, word: string, reward: number): void {
  s.oppWords[0]!++;
  if (word.length >= 7) s.oppWords[1]!++;
  s.oppWords[2]! += reward;
}

function liveStats(r: Replay): Stats {
  const s = newStats();
  const bids = liveBids();
  for (const m of r.ours) {
    const me = m.players.findIndex((p) => p.name === OUR_BOT);
    const id = m.players[me]!.id;
    const n = 98 - 5 * m.players.length;
    const mine = bids.get(m.id);
    s.matches++;
    s.place += placeFraction(m.players.map((p) => p.score), me);
    s.win += placeFraction(m.players.map((p) => p.score), me) === 1 ? 1 : 0;
    s.score += m.players[me]!.score;
    addOpp(s, m.players.map((p) => p.score), me, m.players.map((p) => p.sim));
    const seatOf = new Map(m.players.map((p, k) => [p.id, k]));
    for (const w of m.words) {
      const k = seatOf.get(w.bot)!;
      if (k !== me && !m.players[k]!.sim) addOppWord(s, w.word, w.reward);
    }
    let lvl = 0;
    m.auctions.forEach((a, k) => {
      if (a.winner === id) s.tiles++;
      const opp = a.winner === id ? a.paid : a.winner !== null ? (a.top ?? a.paid) : 0;
      lvl += Math.log1p(opp) / m.auctions.length;
      addRival(s, phaseOf(k, n), a.letter, opp);
      const b = mine?.get(k + 1);
      if (b !== undefined && b > 0) {
        addCurve(s, b, a.winner === id, opp);
        s.segWin[phaseOf(k, n)]![0]!++;
        if (a.winner === id) s.segWin[phaseOf(k, n)]![1]!++;
      }
    });
    s.matchLevel[0]! += lvl;
    s.matchLevel[1]! += lvl * lvl;
  }
  return s;
}

// Replays one live match; records the strongest opposing bid in every auction.
function replayMatch(r: Replay, m: Replay["ours"][number], seed: number, s: Stats): void {
  const me = m.players.findIndex((p) => p.name === OUR_BOT);
  const n = 98 - 5 * m.players.length;
  let oppMax = 0;
  let ourBid = 0;
  let lvl = 0;
  let auctions = 0;
  const wrap = (b: Bot, seat: number): Bot => ({
    name: b.name,
    serverSide: b.serverSide,
    onStart: (st, np, rack, d) => b.onStart(st, np, rack, d),
    onAuction: (v) => {
      const a = b.onAuction(v);
      const bid = Math.max(0, Math.floor(a.bid));
      if (seat === me) ourBid = bid;
      else oppMax = Math.max(oppMax, bid);
      return a;
    },
    onResult: (v, letter, winner, paid) => {
      if (seat === me) {
        const seg = phaseOf(v.round - 1, n);
        addRival(s, seg, letter, oppMax);
        lvl += Math.log1p(oppMax);
        auctions++;
        if (ourBid > 0) {
          addCurve(s, ourBid, winner === me, oppMax);
          s.segWin[seg]![0]!++;
          if (winner === me) s.segWin[seg]![1]!++;
        }
        if (winner === me) s.tiles++;
        oppMax = 0;
        ourBid = 0;
      }
      return b.onResult(v, letter, winner, paid);
    },
    onWord: (st, w) => {
      if (seat === me && st !== me && !m.players[st]!.sim) addOppWord(s, w, r.dict.reward[r.dict.indexOf(w)]!);
      b.onWord?.(st, w);
    },
  });
  // Every seat bids before any onResult, so the rival maximum is complete
  // when our onResult records and resets it.
  const bots = m.players.map((pl, k) => wrap(k === me ? new EvoBot(r.played.get(m.id)!.p, "us") : seatBot(r, pl, seed + 7919 * k), k));
  const res = playMatch(bots, r.dict, seed, "Vickrey");
  const pf = placeFraction(res.scores, me);
  addOpp(s, res.scores, me, m.players.map((p) => p.sim));
  s.matchLevel[0]! += lvl / Math.max(1, auctions);
  s.matchLevel[1]! += (lvl / Math.max(1, auctions)) ** 2;
  s.matches++;
  s.place += pf;
  s.win += pf === 1 ? 1 : 0;
  s.score += res.scores[me]!;
}

interface Job {
  shift: number[];
  spread: number[];
  letterShift: number[];
  reps: number;
}

if (!isMainThread) {
  const { shard, shards, style } = workerData as { shard: number; shards: number; style: string | null };
  const r = loadReplay("train", style);
  parentPort!.on("message", (job: Job) => {
    setProfileShift(job.shift, job.spread, job.letterShift);
    const s = newStats();
    r.ours.forEach((m, i) => {
      if (i % shards !== shard) return;
      for (let rep = 0; rep < job.reps; rep++) replayMatch(r, m, replaySeed(m.id, rep), s);
    });
    parentPort!.postMessage(s);
  });
}

function quantile(h: number[], q: number): number {
  const total = h.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (let i = 0; i < h.length; i++) if ((acc += h[i]!) >= q * total) return i;
  return h.length - 1;
}
const lq = (h: number[], q: number) => Math.log1p(quantile(h, q));

function show(label: string, s: Stats): void {
  const k = s.matches;
  const qs = s.opp.map((h) => QS.map((q) => quantile(h, q)).join("/")).join("  ");
  const curve = s.curve.map(([n, w]) => (n ? `${((100 * w) / n).toFixed(0)}%` : "-").padStart(4)).join(" ");
  const seg = s.segWin.map(([n, w]) => (n ? `${((100 * w!) / n!).toFixed(0)}%` : "-")).join("/");
  console.log(
    `  ${label.padEnd(34)} win ${((100 * s.win) / k).toFixed(1).padStart(5)}%  place ${(s.place / k).toFixed(3)}  score ${(s.score / k).toFixed(1).padStart(5)}` +
      `  letters ${(s.tiles / k).toFixed(1).padStart(4)}  rivals best ${(s.oppBest / k).toFixed(1)} mean ${(s.oppMean / k).toFixed(1)}` +
      ` words 7+ ${((100 * s.oppWords[1]!) / s.oppWords[0]!).toFixed(0)}% pts/word ${(s.oppWords[2]! / s.oppWords[0]!).toFixed(1)}  | strongest rival bid p25/50/75/90 by thirds+endgame ${qs}  | our bid 1-4/5-9/10-14/15-24/25+ wins ${curve}  | our bids won by thirds+endgame ${seg}`,
  );
}

// Strongest rival bid by letter and by our own bid, live next to simulated.
function breakdown(live: Stats, sim: Stats): void {
  const gm = (x: number[]) => (x[0]! ? Math.expm1(x[1]! / x[0]!) : NaN);
  const L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  console.log("  strongest rival bid, geometric mean by letter (live/sim):");
  console.log("   " + [...L].map((c, i) => `${c} ${gm(live.byLetter[i]!).toFixed(0)}/${gm(sim.byLetter[i]!).toFixed(0)}`).join("  "));
  console.log("  strongest rival bid p25/50/75 when our bid is 1-4 | 5-9 | 10-14 | 15-24 | 25+ (live > sim):");
  console.log(
    "   " +
      live.byOurBid
        .map((h, k) => `${[0.25, 0.5, 0.75].map((q) => quantile(h, q)).join("/")} > ${[0.25, 0.5, 0.75].map((q) => quantile(sim.byOurBid[k]!, q)).join("/")}`)
        .join("   "),
  );
  const sd = (s: Stats) => Math.sqrt(Math.max(0, s.matchLevel[1]! / s.matches - (s.matchLevel[0]! / s.matches) ** 2));
  console.log(`  match-to-match spread of the rival price level (sd of log): live ${sd(live).toFixed(3)}  sim ${sd(sim).toFixed(3)}`);
  const per = (s: Stats) => s.curve.map(([n]) => (n / s.matches).toFixed(1)).join("/");
  console.log(`  our bids per match, 1-4/5-9/10-14/15-24/25+: live ${per(live)}  sim ${per(sim)}`);
}

const logMean = (x: number[]) => (x[0]! ? x[1]! / x[0]! : 0);

// Mean squared gap between live and simulated log-quantiles over phases,
// plus the same for the log-mean by letter, weighted by live auctions.
function gap(live: Stats, sim: Stats): { phase: number; letter: number } {
  let e = 0;
  for (let ph = 0; ph < SEGMENTS.length; ph++) for (const q of QS) e += (lq(live.opp[ph]!, q) - lq(sim.opp[ph]!, q)) ** 2;
  let el = 0;
  let w = 0;
  live.byLetter.forEach((x, c) => {
    el += x[0]! * (logMean(x) - logMean(sim.byLetter[c]!)) ** 2;
    w += x[0]!;
  });
  return { phase: e / (SEGMENTS.length * QS.length), letter: el / w };
}

async function main(): Promise<void> {
  const style = arg("style", "") || null;
  const reps = Number(arg("reps", "4"));
  const rounds = process.argv.includes("--diag") ? 0 : Number(arg("rounds", "6"));
  const nWorkers = Number(arg("workers", String(Math.max(1, availableParallelism() - 1))));
  const r = loadReplay("train", style);
  const pj = JSON.parse(readFileSync(`${root}data/profiles.json`, "utf8")) as { shift?: number[]; spread?: number[]; letterShift?: number[] };
  // A three-phase calibration gets its last-third entry for the endgame.
  let shift = pj.shift ?? [0, 0, 0];
  let spread = pj.spread ?? [1, 1, 1];
  if (shift.length === 3) shift = [...shift, shift[2]!];
  if (spread.length === 3) spread = [...spread, spread[2]!];
  let letterShift = pj.letterShift ?? new Array<number>(26).fill(0);

  const workers = Array.from(
    { length: nWorkers },
    (_, shard) => new Worker(new URL(import.meta.url), { workerData: { shard, shards: nWorkers, style } }),
  );
  const run = (job: Job) =>
    Promise.all(workers.map((w) => new Promise<Stats>((res) => (w.once("message", res), w.postMessage(job))))).then((parts) => {
      const s = newStats();
      parts.forEach((p) => addStats(s, p));
      return s;
    });

  const live = liveStats(r);
  console.log(
    `${r.ours.length} training-split live ${OUR_BOT} matches, ${reps} replays each, ${nWorkers} workers${style ? `, styles ${style}` : ""}`,
  );
  show("live", live);
  let best = { gap: Infinity, shift, spread, letterShift };
  for (let k = 0; k <= rounds; k++) {
    const t0 = Date.now();
    const sim = await run({ shift, spread, letterShift, reps });
    const g = gap(live, sim);
    show(`shift ${shift.map((x) => x.toFixed(2)).join("/")} spread ${spread.map((x) => x.toFixed(2)).join("/")}`, sim);
    console.log(`  ${"".padEnd(34)} gap by segment ${g.phase.toFixed(4)}  by letter ${g.letter.toFixed(4)}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    if (g.phase + g.letter < best.gap) best = { gap: g.phase + g.letter, shift, spread, letterShift };
    if (k === 0 || k === rounds) breakdown(live, sim);
    if (k === rounds) break;
    // Letter shifts take the log-mean gap per letter, re-centred on the
    // live auction mix so the phase shifts keep the overall level.
    const raw = letterShift.map((x, c) => x + 0.8 * (logMean(live.byLetter[c]!) - logMean(sim.byLetter[c]!)));
    const tot = live.byLetter.reduce((a, x) => a + x[0]!, 0);
    const mean = raw.reduce((a, x, c) => a + x * live.byLetter[c]![0]!, 0) / tot;
    letterShift = raw.map((x) => x - mean);
    // Log-bids are shifted per phase: the middle of the rival-bid spread
    // moves with the shift, its width with the noise multiplier.
    shift = shift.map((x, ph) => {
      const d = (lq(live.opp[ph]!, 0.5) - lq(sim.opp[ph]!, 0.5) + lq(live.opp[ph]!, 0.75) - lq(sim.opp[ph]!, 0.75)) / 2;
      return x + 0.8 * d;
    });
    spread = spread.map((x, ph) => {
      const wl = lq(live.opp[ph]!, 0.9) - lq(live.opp[ph]!, 0.25);
      const ws = Math.max(0.05, lq(sim.opp[ph]!, 0.9) - lq(sim.opp[ph]!, 0.25));
      return Math.min(4, Math.max(0.05, x * (wl / ws) ** 0.8));
    });
  }
  for (const w of workers) await w.terminate();
  console.log(
    `best: shift ${best.shift.map((x) => x.toFixed(3)).join(", ")} spread ${best.spread.map((x) => x.toFixed(3)).join(", ")}` +
      ` letters ${best.letterShift.map((x) => x.toFixed(2)).join(" ")} gap ${best.gap.toFixed(4)}`,
  );
  if (process.argv.includes("--write") && rounds > 0) {
    const out = JSON.parse(readFileSync(`${root}data/profiles.json`, "utf8"));
    out.shift = best.shift;
    out.spread = best.spread;
    out.letterShift = best.letterShift;
    out.bidCalibration = { by: "src/calibrate-bids.ts", at: new Date().toISOString(), gap: best.gap, style };
    writeFileSync(`${root}data/profiles.json.tmp`, JSON.stringify(out));
    renameSync(`${root}data/profiles.json.tmp`, `${root}data/profiles.json`);
    console.log("wrote shift and spread to data/profiles.json");
  }
}

if (isMainThread) await main();
