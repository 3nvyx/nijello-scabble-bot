// How close is the simulator to the live game? Replays our bot's real
// matches (same opponents, same seats, each match with the params our bot
// actually played it with) and compares the simulated matches with what
// happened live: our results, how often a bid of a given size wins, when
// points are scored, and every opponent's score, letters and word habits.
//
//   node src/fidelity.ts [--split train|held|all] [--reps 4] [--style data/styles.json] [--top 12]
//
// Matches are split by id: id % 3 == 0 is held out (never used to fit or
// calibrate anything), the rest is the training split.

import { readFileSync } from "node:fs";
import { Dictionary } from "./dict.ts";
import { type Bot, playMatch } from "./game.ts";
import { type BidProfile, loadMarket, MarketBot, ProfileBot, SERVER_SIMS, setProfileShift, SimBot } from "./opponents.ts";
import type { LiveMatch } from "./profile.ts";
import { decode, EvoBot, jsonToX, type Params } from "./strategy.ts";
import { loadStyles, StyledBot, type WordStyle } from "./style.ts";
import { placeFraction } from "./tables.ts";

const root = new URL("..", import.meta.url).pathname;
const OUR_BOT = process.env.OUR_BOT ?? "Nijello";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}

export const isHeldOut = (matchId: number) => matchId % 3 === 0;

// Which params our bot played each live match with, from its log line
// "match <id>: seat <s> of <n>, params gen <g>". Only generations with a
// saved params file can be replayed.
export function playedParams(): Map<number, { gen: string; p: Params }> {
  const files: Record<string, string> = {};
  for (const f of ["runs/live/params.json", "runs/live/params.before.131015.json"]) {
    try {
      const j = JSON.parse(readFileSync(`${root}${f}`, "utf8"));
      files[`gen ${j.gen}`] = f;
    } catch {
      // not present
    }
  }
  const decoded = new Map(Object.entries(files).map(([g, f]) => [g, decode(jsonToX(JSON.parse(readFileSync(`${root}${f}`, "utf8")).params))]));
  const out = new Map<number, { gen: string; p: Params }>();
  const log = readFileSync(`${root}live/${OUR_BOT}.log`, "latin1");
  for (const m of log.matchAll(/match (\d+): seat \d+ of \d+, params (gen \d+)/g)) {
    const p = decoded.get(m[2]!);
    if (p) out.set(Number(m[1]), { gen: m[2]!, p });
  }
  return out;
}

export interface Replay {
  ours: LiveMatch[];
  played: Map<number, { gen: string; p: Params }>;
  profs: Map<string, BidProfile>;
  styles: Map<string, WordStyle>;
  market: ReturnType<typeof loadMarket>;
  dict: Dictionary;
}

export function loadReplay(split: "train" | "held" | "all", stylePath: string | null): Replay {
  const live = (JSON.parse(readFileSync(`${root}data/live.json`, "utf8")) as { matches: LiveMatch[] }).matches;
  const pj = JSON.parse(readFileSync(`${root}data/profiles.json`, "utf8")) as { bots: BidProfile[]; shift?: number[]; spread?: number[]; letterShift?: number[] };
  setProfileShift(pj.shift ?? [0, 0, 0], pj.spread ?? [1, 1, 1], pj.letterShift);
  const played = playedParams();
  const ours = live.filter(
    (m) =>
      played.has(m.id) &&
      m.players.some((p) => p.name === OUR_BOT) &&
      (split === "all" || (split === "held") === isHeldOut(m.id)),
  );
  return {
    ours,
    played,
    profs: new Map(pj.bots.map((p) => [p.name, p])),
    styles: stylePath ? loadStyles(`${root}${stylePath}`) : new Map(),
    market: loadMarket(`${root}data/field.json`),
    dict: Dictionary.load(`${root}data/wordlist.txt`),
  };
}

// The model of a live opponent: its profile (with its word style when
// fitted), else a server sim, else a field model.
export function seatBot(r: Replay, pl: LiveMatch["players"][number], seed: number): Bot {
  const prof = r.profs.get(pl.name);
  if (prof) {
    const st = r.styles.get(pl.name);
    return st ? new StyledBot(prof, st, seed) : new ProfileBot(prof, seed);
  }
  if (pl.sim) return new SimBot(SERVER_SIMS[pl.id % SERVER_SIMS.length]!, seed);
  return new MarketBot(r.market!, seed);
}

// Per-seat facts of one match, live or simulated.
export interface SeatFacts {
  name: string;
  score: number;
  tiles: number;
  words: number;
  wordLen: number; // summed length
  late: number; // reward scored in the last third of the auctions
}

export function liveFacts(m: LiveMatch): SeatFacts[] {
  const n = m.auctions.length;
  const cut = n ? m.auctions[Math.floor((2 * n) / 3)]!.at : Infinity;
  return m.players.map((p) => {
    const ws = m.words.filter((w) => w.bot === p.id);
    return {
      name: p.name,
      score: p.score,
      tiles: m.auctions.filter((a) => a.winner === p.id).length,
      words: ws.length,
      wordLen: ws.reduce((a, w) => a + w.word.length, 0),
      late: ws.filter((w) => w.at >= cut).reduce((a, w) => a + w.reward, 0),
    };
  });
}

// Our bids and whether they won, in buckets of bid size.
const BUCKETS = [1, 5, 10, 15, 25, 1e9];
const bucket = (b: number) => BUCKETS.findIndex((x, i) => b >= x && b < BUCKETS[i + 1]!);

// Our live bids by match and round, from the log.
export function liveBids(): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  const text = readFileSync(`${root}live/${OUR_BOT}.log`, "latin1");
  for (const m of text.matchAll(/ m(\d+) r(\d+) bag \d+ '\w' bal \d+ -> (?:play \S+ )?bid (\d+)/g)) {
    const mid = Number(m[1]);
    (out.get(mid) ?? out.set(mid, new Map()).get(mid)!).set(Number(m[2]), Number(m[3]));
  }
  return out;
}

// Plays one live match in the simulator; returns per-seat facts and our
// (bid, won) pairs.
export function simulate(r: Replay, m: LiveMatch, seed: number, ours?: Params): { facts: SeatFacts[]; bids: [number, boolean][] } {
  const me = m.players.findIndex((p) => p.name === OUR_BOT);
  const n = 98 - 5 * m.players.length;
  const words = m.players.map(() => ({ words: 0, len: 0, late: 0 }));
  const bids: [number, boolean][] = [];
  let round = 0;
  let ourBid = 0;
  const wrap = (b: Bot, seat: number): Bot => ({
    name: b.name,
    serverSide: b.serverSide,
    onStart: (s, np, rack, d) => b.onStart(s, np, rack, d),
    onAuction: (v) => {
      if (seat === 0) round = v.round;
      const a = b.onAuction(v);
      if (seat === me) ourBid = Math.floor(a.bid);
      return a;
    },
    onResult: (v, letter, winner, paid) => {
      if (seat === me && ourBid > 0) bids.push([ourBid, winner === me]);
      if (seat === me) ourBid = 0;
      return b.onResult(v, letter, winner, paid);
    },
    onWord: (s, w) => {
      if (seat === 0) {
        const reward = r.dict.reward[r.dict.indexOf(w)]!;
        words[s]!.words++;
        words[s]!.len += w.length;
        if (round > (2 * n) / 3) words[s]!.late += reward;
      }
      b.onWord?.(s, w);
    },
  });
  const p = ours ?? r.played.get(m.id)!.p;
  const bots = m.players.map((pl, k) => wrap(k === me ? new EvoBot(p, "us") : seatBot(r, pl, seed + 7919 * k), k));
  const res = playMatch(bots, r.dict, seed, "Vickrey");
  const facts = m.players.map((pl, k) => ({
    name: pl.name,
    score: res.scores[k]!,
    tiles: res.tilesWon[k]!,
    words: words[k]!.words,
    wordLen: words[k]!.len,
    late: words[k]!.late,
  }));
  return { facts, bids };
}

export const replaySeed = (matchId: number, rep: number) => (Math.imul(matchId, 2654435761) ^ Math.imul(rep + 1, 40503)) >>> 0;

interface Agg {
  n: number;
  place: number;
  win: number;
  score: number;
  tiles: number;
  late: number;
  oppBest: number;
  curve: [number, number][];
}
const newAgg = (): Agg => ({ n: 0, place: 0, win: 0, score: 0, tiles: 0, late: 0, oppBest: 0, curve: BUCKETS.slice(1).map(() => [0, 0]) });

function addOurs(a: Agg, facts: SeatFacts[], me: number, bids: [number, boolean][]): void {
  const scores = facts.map((f) => f.score);
  const pf = placeFraction(scores, me);
  a.n++;
  a.place += pf;
  a.win += pf === 1 ? 1 : 0;
  a.score += scores[me]!;
  a.tiles += facts[me]!.tiles;
  a.late += facts[me]!.late;
  a.oppBest += Math.max(...scores.filter((_, k) => k !== me));
  for (const [b, won] of bids) {
    const k = bucket(b);
    if (k < 0) continue;
    a.curve[k]![0]++;
    if (won) a.curve[k]![1]++;
  }
}

interface BotAgg {
  n: number;
  score: number;
  tiles: number;
  words: number;
  len: number;
  late: number;
}
const addBot = (map: Map<string, BotAgg>, f: SeatFacts) => {
  const a = map.get(f.name) ?? map.set(f.name, { n: 0, score: 0, tiles: 0, words: 0, len: 0, late: 0 }).get(f.name)!;
  a.n++;
  a.score += f.score;
  a.tiles += f.tiles;
  a.words += f.words;
  a.len += f.wordLen;
  a.late += f.late;
};

export interface Report {
  live: Agg;
  sim: Agg;
  liveBots: Map<string, BotAgg>;
  simBots: Map<string, BotAgg>;
  matches: number;
}

export function compare(r: Replay, reps: number, ours?: Params): Report {
  const bidsLive = liveBids();
  const live = newAgg();
  const sim = newAgg();
  const liveBots = new Map<string, BotAgg>();
  const simBots = new Map<string, BotAgg>();
  for (const m of r.ours) {
    const me = m.players.findIndex((p) => p.name === OUR_BOT);
    const lf = liveFacts(m);
    const lb: [number, boolean][] = [];
    const mine = bidsLive.get(m.id);
    m.auctions.forEach((a, k) => {
      const b = mine?.get(k + 1);
      if (b !== undefined && b > 0) lb.push([b, a.winner === m.players[me]!.id]);
    });
    addOurs(live, lf, me, lb);
    lf.forEach((f, k) => k !== me && !m.players[k]!.sim && addBot(liveBots, f));
    for (let rep = 0; rep < reps; rep++) {
      const { facts, bids } = simulate(r, m, replaySeed(m.id, rep), ours);
      addOurs(sim, facts, me, bids);
      facts.forEach((f, k) => k !== me && !m.players[k]!.sim && addBot(simBots, f));
    }
  }
  return { live, sim, liveBots, simBots, matches: r.ours.length };
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;

export function printReport(rep: Report, top: number): void {
  const { live, sim } = rep;
  const row = (label: string, a: Agg) => {
    const curve = a.curve.map(([n, w]) => (n ? `${((100 * w) / n).toFixed(0)}%` : "-").padStart(4)).join(" ");
    console.log(
      `  ${label.padEnd(5)} place ${(a.place / a.n).toFixed(3)}  win ${pct(a.win / a.n).padStart(6)}  score ${(a.score / a.n).toFixed(1).padStart(6)}` +
        `  letters ${(a.tiles / a.n).toFixed(1).padStart(5)}  late-third pts ${(a.late / a.n).toFixed(1).padStart(5)}  best opponent ${(a.oppBest / a.n).toFixed(1)}` +
        `  | our bid 1-4/5-9/10-14/15-24/25+ wins ${curve}`,
    );
  };
  console.log(`${rep.matches} live ${OUR_BOT} matches, ${sim.n / rep.matches} replays each`);
  row("live", live);
  row("sim", sim);

  // Opponents met at least 5 times, most frequent first.
  const names = [...rep.liveBots.entries()].filter(([, a]) => a.n >= 5).sort((a, b) => b[1].n - a[1].n).map(([k]) => k);
  const err = { score: 0, tiles: 0, words: 0, late: 0 };
  let w = 0;
  console.log(`\n  opponent          met   score live/sim    letters live/sim   words live/sim   word len live/sim   late-third share live/sim`);
  names.forEach((name, i) => {
    const L = rep.liveBots.get(name)!;
    const S = rep.simBots.get(name);
    if (!S) return;
    const ls = L.score / L.n, ss = S.score / S.n;
    const lt = L.tiles / L.n, st = S.tiles / S.n;
    const lw = L.words / L.n, sw = S.words / S.n;
    const ll = L.words ? L.len / L.words : 0, sl = S.words ? S.len / S.words : 0;
    const lshare = L.score ? L.late / L.score : 0, sshare = S.score ? S.late / S.score : 0;
    err.score += L.n * Math.abs(ss - ls);
    err.tiles += L.n * Math.abs(st - lt);
    err.words += L.n * Math.abs(sw - lw);
    err.late += L.n * Math.abs(sshare - lshare);
    w += L.n;
    if (i < top)
      console.log(
        `  ${name.slice(0, 16).padEnd(16)} ${String(L.n).padStart(4)}   ${ls.toFixed(1).padStart(6)} / ${ss.toFixed(1).padEnd(6)}  ${lt.toFixed(1).padStart(6)} / ${st.toFixed(1).padEnd(6)}` +
          `  ${lw.toFixed(1).padStart(5)} / ${sw.toFixed(1).padEnd(5)}  ${ll.toFixed(1).padStart(6)} / ${sl.toFixed(1).padEnd(8)}  ${pct(lshare).padStart(6)} / ${pct(sshare)}`,
      );
  });
  console.log(
    `\n  opponents overall (weighted by meetings): score off by ${(err.score / w).toFixed(1)} pts, letters by ${(err.tiles / w).toFixed(1)},` +
      ` words by ${(err.words / w).toFixed(2)}, late-third share by ${pct(err.late / w)}`,
  );
}

if (import.meta.main) {
  const split = arg("split", "train") as "train" | "held" | "all";
  const style = arg("style", "");
  const r = loadReplay(split, style || null);
  const t0 = Date.now();
  printReport(compare(r, Number(arg("reps", "4"))), Number(arg("top", "12")));
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
