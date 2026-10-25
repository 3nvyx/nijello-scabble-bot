// CMA-ES training driver. Runs on every core, checkpoints each generation,
// and writes status.json for the dashboard.
//
//   node src/train.ts --hours 10 --out runs/main
//   node src/train.ts --resume --out runs/main     (continue after a crash)

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, hostname, totalmem } from "node:os";
import { Worker } from "node:worker_threads";
import { Cma, type CmaState } from "./cmaes.ts";
import { Rng } from "./rng.ts";
import { DIM, jsonToX, paramsToJson } from "./strategy.ts";
import { type Opp, reloadField, sampleTable, type TableSpec, topCount } from "./tables.ts";
import type { Job, JobResult } from "./worker.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}
const HOURS = Number(arg("hours", "10"));
const WORKERS = Number(arg("workers", String(Math.max(1, availableParallelism()))));
const LAMBDA = Number(arg("lambda", "40"));
const GAMES = Number(arg("games", "160"));
const CHUNK = Number(arg("chunk", "20"));
const OUT = arg("out", "runs/main");
const SEED = Number(arg("seed", "20261024"));
const HOF_EVERY = Number(arg("hof-every", "8"));
const HOF_MAX = Number(arg("hof-max", "16"));
const BENCH_EVERY = Number(arg("bench-every", "5"));
const RESUME = process.argv.includes("--resume");
const MAX_GENS = Number(arg("max-gens", "1000000"));
// Start the search from a saved parameter file instead of the defaults.
const INIT = arg("init", "");
const SIGMA = Number(arg("sigma", "0.3"));
// Games used to confirm a new peak before best.json is replaced.
const CONFIRM = Number(arg("confirm", "3000"));

const root = new URL("..", import.meta.url).pathname;
const dictPath = `${root}data/wordlist.txt`;
mkdirSync(OUT, { recursive: true });

type Stat = { win: number; place: number; score: number };
type BenchRow = { gen: number; t: number; perBot?: { name: string; win: number; place: number }[] } & Record<string, Stat | number | unknown>;
// The best parameters seen against the field models, confirmed on fresh
// seeds. This is what best.json (and so the live bot) uses.
interface Peak {
  gen: number;
  x: number[];
  confirmed: Stat;
}
interface GenRow {
  gen: number;
  t: number;
  fitMean: number;
  fitBest: number;
  winMean: number;
  scoreMean: number;
  sigma: number;
  games: number;
}
interface Saved {
  cma: CmaState;
  hof: number[][];
  history: GenRow[];
  bench: BenchRow[];
  totalGames: number;
  elapsedBefore: number;
  peak?: Peak;
}

// ---- worker pool ----
const workers: Worker[] = [];
const idle: Worker[] = [];
const queue: { job: Job; resolve: (r: JobResult) => void }[] = [];
const pending = new Map<Worker, (r: JobResult) => void>();
for (let i = 0; i < WORKERS; i++) {
  const w = new Worker(new URL("./worker.ts", import.meta.url), { workerData: { dictPath } });
  w.on("message", (r: JobResult) => {
    const done = pending.get(w)!;
    pending.delete(w);
    done(r);
    dispatch(w);
  });
  w.on("error", (e) => {
    console.error("worker error", e);
    process.exit(1);
  });
  workers.push(w);
  idle.push(w);
}
function dispatch(w: Worker): void {
  const next = queue.shift();
  if (!next) {
    idle.push(w);
    return;
  }
  pending.set(w, next.resolve);
  w.postMessage({ job: next.job });
}
function run(job: Job): Promise<JobResult> {
  return new Promise((resolve) => {
    queue.push({ job, resolve });
    const w = idle.pop();
    if (w) dispatch(w);
  });
}
function broadcastHof(hof: number[][]): void {
  for (const w of workers) w.postMessage({ hof });
}

// Plays every table for x, split into chunks across the pool.
async function evaluate(x: number[], tables: TableSpec[], idBase: number) {
  const jobs: Promise<JobResult>[] = [];
  for (let k = 0; k < tables.length; k += CHUNK)
    jobs.push(run({ id: idBase + k, x, tables: tables.slice(k, k + CHUNK) }));
  const rs = await Promise.all(jobs);
  const sum = rs.reduce(
    (a, r) => ({ place: a.place + r.place, score: a.score + r.score, wins: a.wins + r.wins, games: a.games + r.games }),
    { place: 0, score: 0, wins: 0, games: 0 },
  );
  return {
    place: sum.place / sum.games,
    score: sum.score / sum.games,
    win: sum.wins / sum.games,
    games: sum.games,
  };
}

// Fixed-seed benchmark fields, so rows are comparable across generations.
type BenchKind = "default" | "sims" | "starter" | "league" | "market" | "top" | `top:${number}` | "confirm";
function benchTables(kind: BenchKind, count: number, hofSize: number, seedSalt = 0): TableSpec[] {
  let h = 17 + seedSalt * 7919;
  for (const ch of kind) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rng = new Rng(h);
  const nTop = topCount();
  const out: TableSpec[] = [];
  for (let g = 0; g < count; g++) {
    let opps: Opp[];
    if (kind === "default") opps = Array.from({ length: 5 }, () => ({ kind: "hof", i: 0 }));
    else if (kind === "starter") opps = Array.from({ length: 5 }, () => ({ kind: "starter" }));
    else if (kind === "market") opps = Array.from({ length: 5 }, () => ({ kind: "market" }));
    // Without per-bot models (old field.json), top tables fall back to market.
    else if (kind === "top")
      opps = Array.from({ length: 5 }, () => (nTop ? { kind: "top", i: rng.int(0, nTop - 1) } : { kind: "market" }));
    else if (kind.startsWith("top:")) opps = Array.from({ length: 5 }, () => ({ kind: "top", i: Number(kind.slice(4)) }));
    else if (kind === "confirm")
      opps = Array.from({ length: 5 }, () =>
        g % 2 === 0 || nTop === 0 ? { kind: "market" } : { kind: "top", i: rng.int(0, nTop - 1) },
      );
    else if (kind === "sims") {
      const s = [0, 1, 2, 3, 4, 5];
      rng.shuffle(s);
      opps = s.slice(0, 5).map((i) => ({ kind: "sim", i }));
    } else opps = Array.from({ length: 5 }, () => ({ kind: "hof", i: rng.int(0, hofSize - 1) }));
    out.push({ seed: rng.u32(), auctionType: "Vickrey", opps });
  }
  return out;
}

const FIELD = new URL("../data/field.json", import.meta.url).pathname;
let lastFieldMtime = fieldMtime();
function fieldMtime(): number {
  try {
    return statSync(FIELD).mtimeMs;
  } catch {
    return 0;
  }
}

function readJsonSafe(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(data));
  renameSync(`${path}.tmp`, path);
}

async function main(): Promise<void> {
  let cma: Cma;
  let hof: number[][];
  let history: GenRow[] = [];
  let bench: BenchRow[] = [];
  let totalGames = 0;
  let elapsedBefore = 0;
  let peak: Peak | undefined;
  const ckpt = `${OUT}/checkpoint.json`;
  if (RESUME && existsSync(ckpt)) {
    const s = JSON.parse(readFileSync(ckpt, "utf8")) as Saved;
    cma = Cma.restore(s.cma);
    hof = s.hof;
    history = s.history;
    bench = s.bench;
    totalGames = s.totalGames;
    elapsedBefore = s.elapsedBefore;
    peak = s.peak;
    // The field may have changed while we were stopped: force a reload and
    // a re-measure of the peak on the first generation.
    lastFieldMtime = -1;
    console.log(`resumed at generation ${cma.gen}`);
  } else {
    const start = INIT ? [...jsonToX(JSON.parse(readFileSync(INIT, "utf8")).params)] : new Array(DIM).fill(0);
    cma = new Cma(start, SIGMA, LAMBDA, SEED);
    hof = [new Array(DIM).fill(0)]; // seat 0 is always the hand-set default
    if (INIT) hof.push([...start]);
  }
  broadcastHof(hof);
  const t0 = Date.now();
  const deadline = t0 + HOURS * 3600_000 - elapsedBefore;
  const elapsed = () => elapsedBefore + (Date.now() - t0);
  const rate: { t: number; games: number }[] = [];

  const pick = (r: Stat) => ({ win: r.win, place: r.place, score: r.score });
  const fieldStat = (row: BenchRow): Stat => {
    const a = row.vsTop as Stat;
    const b = row.vsMarket as Stat;
    return { win: (a.win + b.win) / 2, place: (a.place + b.place) / 2, score: (a.score + b.score) / 2 };
  };
  const doBench = async (gen: number) => {
    const m = cma.mean;
    const nTop = topCount();
    const [d, s, st, l, mk, tp, ...per] = await Promise.all([
      evaluate(m, benchTables("default", 200, hof.length), 1e9),
      evaluate(m, benchTables("sims", 100, hof.length), 2e9),
      evaluate(m, benchTables("starter", 60, hof.length), 3e9),
      evaluate(m, benchTables("league", 200, hof.length), 4e9),
      evaluate(m, benchTables("market", 600, hof.length), 5e9),
      evaluate(m, benchTables("top", 600, hof.length), 6e9),
      ...Array.from({ length: nTop }, (_, i) => evaluate(m, benchTables(`top:${i}`, 150, hof.length), 7e9 + i * 1e6)),
    ]);
    totalGames += [d, s, st, l, mk, tp, ...per].reduce((a, r) => a + r.games, 0);
    const field = readJsonSafe(new URL("../data/field.json", import.meta.url).pathname);
    const row: BenchRow = {
      gen,
      t: elapsed(),
      vsDefault: pick(d),
      vsSims: pick(s),
      vsStarter: pick(st),
      vsLeague: pick(l),
      vsMarket: pick(mk),
      vsTop: pick(tp),
      perBot: per.map((r, i) => ({ name: field?.top?.[i]?.name ?? `top${i}`, win: r.win, place: r.place })),
    };
    row.vsField = fieldStat(row);
    bench.push(row);
    writeJson(`${OUT}/latest.json`, { gen, savedAt: new Date().toISOString(), params: paramsToJson(m), bench: row });
    // A new peak must beat the old one on CONFIRM fresh games, so one lucky
    // benchmark can't replace best.json.
    const f = row.vsField as Stat;
    if (!peak || f.place > peak.confirmed.place) {
      const c = await evaluate(m, benchTables("confirm", CONFIRM, hof.length, 0), 8e9);
      totalGames += c.games;
      if (!peak || c.place > peak.confirmed.place) {
        peak = { gen, x: [...m], confirmed: pick(c) };
        writeJson(`${OUT}/best.json`, {
          gen,
          savedAt: new Date().toISOString(),
          params: paramsToJson(m),
          confirmed: peak.confirmed,
          bench: row,
        });
        console.log(`new peak at gen ${gen}: field place ${c.place.toFixed(3)} win ${c.win.toFixed(3)}`);
      }
    }
    row.peak = peak ? { gen: peak.gen, ...peak.confirmed } : undefined;
  };

  if (bench.length === 0) await doBench(cma.gen);

  while (Date.now() < deadline && cma.gen < MAX_GENS) {
    const gen = cma.gen + 1;
    // Pick up refreshed live-field data (src/field.ts rewrites it).
    const mtime = fieldMtime();
    if (mtime !== lastFieldMtime) {
      lastFieldMtime = mtime;
      reloadField();
      for (const w of workers) w.postMessage({ reloadField: true });
      // The field changed, so the peak's score is stale: re-measure it on
      // the new field before anything is compared against it.
      if (peak) {
        const c = await evaluate(peak.x, benchTables("confirm", CONFIRM, hof.length, 0), 8e9);
        totalGames += c.games;
        console.log(
          `field refreshed: peak (gen ${peak.gen}) re-measured, place ${peak.confirmed.place.toFixed(3)} -> ${c.place.toFixed(3)}`,
        );
        peak.confirmed = pick(c);
      }
    }
    const xs = cma.ask();
    const trng = new Rng(SEED ^ Math.imul(gen, 2654435761));
    // Common random numbers: every candidate plays the same tables.
    const tables = Array.from({ length: GAMES }, () => sampleTable(trng, hof.length, topCount()));
    const results = await Promise.all(xs.map((x, i) => evaluate(x, tables, i * 100000)));
    const fits = results.map((r) => r.place + 0.0005 * r.score);
    cma.tell(xs, fits.map((f) => -f));
    const games = results.reduce((a, r) => a + r.games, 0);
    totalGames += games;
    rate.push({ t: Date.now(), games: totalGames });
    while (rate.length > 20) rate.shift();
    history.push({
      gen,
      t: elapsed(),
      fitMean: fits.reduce((a, b) => a + b, 0) / fits.length,
      fitBest: Math.max(...fits),
      winMean: results.reduce((a, r) => a + r.win, 0) / results.length,
      scoreMean: results.reduce((a, r) => a + r.score, 0) / results.length,
      sigma: cma.sigma,
      games,
    });
    if (gen % HOF_EVERY === 0) {
      hof.push([...cma.mean]);
      if (hof.length > HOF_MAX) hof.splice(1, 1);
      broadcastHof(hof);
    }
    if (gen % BENCH_EVERY === 0) await doBench(gen);
    const r0 = rate[0]!;
    const r1 = rate.at(-1)!;
    const gps = r1.t > r0.t ? ((r1.games - r0.games) * 1000) / (r1.t - r0.t) : 0;
    writeJson(`${OUT}/status.json`, {
      host: hostname(),
      cpuModel: cpus()[0]?.model ?? "?",
      cores: cpus().length,
      workers: WORKERS,
      memTotal: totalmem(),
      pid: process.pid,
      startedAt: new Date(t0 - elapsedBefore).toISOString(),
      deadline: new Date(deadline).toISOString(),
      elapsedMs: elapsed(),
      gen,
      lambda: LAMBDA,
      gamesPerCandidate: GAMES,
      totalGames,
      gamesPerSec: gps,
      sigma: cma.sigma,
      hofSize: hof.length,
      peak: peak ? { gen: peak.gen, ...peak.confirmed } : null,
      fieldUpdatedAt: lastFieldMtime ? new Date(lastFieldMtime).toISOString() : null,
      history,
      bench,
      updatedAt: new Date().toISOString(),
    });
    const saved: Saved = { cma: cma.state(), hof, history, bench, totalGames, elapsedBefore: elapsed(), peak };
    writeJson(ckpt, saved);
    const h = history.at(-1)!;
    console.log(
      `gen ${gen} fit ${h.fitMean.toFixed(3)} best ${h.fitBest.toFixed(3)} sigma ${cma.sigma.toFixed(3)} ` +
        `games ${totalGames} (${gps.toFixed(0)}/s)`,
    );
  }
  await doBench(cma.gen);
  const last = existsSync(`${OUT}/status.json`) ? JSON.parse(readFileSync(`${OUT}/status.json`, "utf8")) : {};
  writeJson(`${OUT}/status.json`, {
    ...last,
    bench,
    finished: true,
    updatedAt: new Date().toISOString(),
  });
  console.log("done");
  for (const w of workers) await w.terminate();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
