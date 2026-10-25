// Profiles of the live field, fitted on every finished public match.
//
// For every real bot at every auction it took part in, rebuild what it
// knew: its coins (100 + word rewards - prices paid so far), its tiles
// (tiles bought, plus starting tiles its words revealed, minus letters
// played) and what the letter on sale adds to its best word. The server
// shows the winner's bid exactly; a loser's bid is only known to be at most
// the price paid (the second-highest bid). A censored regression per bot
// (src/tobit.ts) turns that into a bid function, which ProfileBot
// (opponents.ts) bids with in the simulator.
//
//   node src/profile.ts [--recent 80]       fetch, fit each bot's last N matches, write data/profiles.json
//   node src/profile.ts --calibrate A.json [--since 1056]
//       fit the profiles' per-phase bid shift so replays of our live matches
//       (played with params A) pay the live prices; rerun after every fit
//   node src/profile.ts --check A.json [B.json] [--since 1056] [--reps 8] [--plan lastN,samples]
//       (--plan: B plays with look-ahead bidding in the last lastN auctions)
//       replay our bot's real matches in the simulator (same opponents,
//       profiled) with params A (and B, paired on identical tables), and
//       compare with what happened live.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Dictionary } from "./dict.ts";
import { type Bot, playMatch } from "./game.ts";
import {
  BID_FEATURES,
  type BidProfile,
  bidFeatures,
  loadMarket,
  MarketBot,
  N_BID_FEATURES,
  ProfileBot,
  SERVER_SIMS,
  setProfileShift,
  SimBot,
  TopBot,
} from "./opponents.ts";
import { loadStyles, StyledBot } from "./style.ts";
import { A_CODE } from "./rules.ts";
import { Rng } from "./rng.ts";
import { decode, EvoBot, jsonToX, marketPriceOf } from "./strategy.ts";
import { type PlanConfig, PlannerBot } from "./planner.ts";
import { placeFraction } from "./tables.ts";
import { fitTobit, type Obs } from "./tobit.ts";
import { anonToken, some, sql, tag } from "./stdb.ts";

const root = new URL("..", import.meta.url).pathname;
const LIVE = `${root}data/live.json`;
const PROFILES = `${root}data/profiles.json`;
const OUR_BOT = process.env.OUR_BOT ?? "Nijello";
// Bots change during the event, so each is fitted on its recent matches.
const RECENT_PER_BOT = Number(process.argv.includes("--recent") ? process.argv[process.argv.indexOf("--recent") + 1] : 80);
const MIN_MATCHES = 10;

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}

export interface LiveMatch {
  id: number;
  endAt: number; // micros
  players: { id: number; name: string; sim: boolean; score: number }[];
  // In auction order; at = close time (micros).
  auctions: { letter: number; winner: number | null; paid: number; top: number | null; at: number }[];
  words: { bot: number; word: string; reward: number; at: number }[];
}

async function fetchLive(): Promise<LiveMatch[]> {
  const token = await anonToken();
  const [bots, matches, parts, results, tops, plays] = await Promise.all([
    sql(token, "SELECT * FROM bot"),
    sql(token, "SELECT * FROM match_state"),
    sql(token, "SELECT * FROM match_participant"),
    sql(token, "SELECT * FROM auction_result"),
    sql(token, "SELECT * FROM auction_top_bid_archive"),
    sql(token, "SELECT * FROM word_play"),
  ]);
  const bot = new Map(bots.map((b) => [Number(b.id), { name: String(b.name), sim: Boolean(b.is_simulated) }]));
  const topBid = new Map(tops.map((t) => [Number(t.auction_id), Number(t.top_bid)]));
  const out = new Map<number, LiveMatch>();
  for (const m of matches) {
    // Ended second-price matches only: first-price bids follow other rules.
    const e = m.ended_at as [number, [number]];
    if (tag(m.status) !== 2 || tag(m.auction_type) !== 1 || e[0] !== 0) continue;
    out.set(Number(m.id), { id: Number(m.id), endAt: Number(e[1][0]), players: [], auctions: [], words: [] });
  }
  for (const p of parts) {
    const lm = out.get(Number(p.match_id));
    const b = bot.get(Number(p.bot_id));
    if (lm) lm.players.push({ id: Number(p.bot_id), name: b?.name ?? "?", sim: b?.sim ?? true, score: Number(p.score) });
  }
  // Auction ids rise through a match, so they give the auction order.
  for (const r of [...results].sort((a, b) => Number(a.auction_id) - Number(b.auction_id))) {
    const lm = out.get(Number(r.match_id));
    if (!lm) continue;
    lm.auctions.push({
      letter: String(r.letter).charCodeAt(0) - A_CODE,
      winner: some(r.winner_bot_id) ?? null,
      paid: Number(r.paid),
      top: topBid.get(Number(r.auction_id)) ?? null,
      at: Number((r.closed_at as [number])[0]),
    });
  }
  for (const w of plays) {
    const lm = out.get(Number(w.match_id));
    if (lm)
      lm.words.push({ bot: Number(w.bot_id), word: String(w.word), reward: Number(w.total_reward), at: Number((w.played_at as [number])[0]) });
  }
  const list = [...out.values()].filter((m) => m.players.length >= 2 && m.auctions.length > 0);
  for (const m of list) m.words.sort((a, b) => a.at - b.at);
  return list.sort((a, b) => a.id - b.id);
}

// Starting tiles a bot must have held: per letter, the most it ever had
// played beyond what it had bought (a lower bound; tiles never played stay
// unknown).
function startTiles(m: LiveMatch, botId: number): Int32Array {
  const need = new Int32Array(26);
  const net = new Int32Array(26); // played - bought so far
  let wi = 0;
  const words = m.words.filter((w) => w.bot === botId);
  for (const a of m.auctions) {
    while (wi < words.length && words[wi]!.at < a.at) {
      for (const ch of words[wi]!.word) {
        const c = ch.charCodeAt(0) - A_CODE;
        net[c]!++;
        need[c] = Math.max(need[c]!, net[c]!);
      }
      wi++;
    }
    if (a.winner === botId) net[a.letter]!--;
  }
  for (; wi < words.length; wi++)
    for (const ch of words[wi]!.word) {
      const c = ch.charCodeAt(0) - A_CODE;
      net[c]!++;
      need[c] = Math.max(need[c]!, net[c]!);
    }
  return need;
}

// One censored observation per (bot, auction) for the given bots.
export function observations(m: LiveMatch, dict: Dictionary, want: Set<number>, into: Map<number, Obs[]>): void {
  const n = m.auctions.length;
  const paid: number[] = [];
  const state = new Map<number, { rack: Int32Array; balance: number; wi: number; words: LiveMatch["words"] }>();
  for (const p of m.players)
    if (want.has(p.id))
      state.set(p.id, { rack: startTiles(m, p.id), balance: 100, wi: 0, words: m.words.filter((w) => w.bot === p.id) });
  m.auctions.forEach((a, k) => {
    const market = marketPriceOf(paid);
    for (const [id, s] of state) {
      // Words up to this auction's close were sent with or before its bid.
      while (s.wi < s.words.length && s.words[s.wi]!.at < a.at) {
        const w = s.words[s.wi++]!;
        for (const ch of w.word) s.rack[ch.charCodeAt(0) - A_CODE] = Math.max(0, s.rack[ch.charCodeAt(0) - A_CODE]! - 1);
        s.balance += w.reward;
      }
      const with_ = Int32Array.from(s.rack);
      with_[a.letter]!++;
      const [b0, b70] = dict.bestPair(s.rack);
      const [b1, b71] = dict.bestPair(with_);
      const x = bidFeatures(new Float64Array(N_BID_FEATURES), k / n, b1 - b0, b71 - b70, s.balance, market, a.letter);
      // Winner: its bid is public. Loser: at most the price paid (the
      // second-highest bid), or 0 when nobody bid. A winner whose bid wasn't
      // archived is only bounded below, which this model can't use.
      let obs: Obs | null;
      if (a.winner === id) obs = a.top !== null ? { x, y: Math.log1p(a.top), censored: false } : null;
      else obs = { x, y: Math.log1p(a.winner === null ? 0 : a.paid), censored: true };
      if (obs) (into.get(id) ?? into.set(id, []).get(id)!).push(obs);
    }
    for (const [id, s] of state)
      if (a.winner === id) {
        s.rack[a.letter]!++;
        s.balance -= a.paid;
      }
    if (a.winner !== null) paid.push(a.paid);
  });
}

async function fit(): Promise<void> {
  const t0 = Date.now();
  const live = await fetchLive();
  writeFileSync(LIVE, JSON.stringify({ fetchedAt: new Date().toISOString(), matches: live }));
  const dict = Dictionary.load(`${root}data/wordlist.txt`);
  const byBot = new Map<number, LiveMatch[]>();
  const names = new Map<number, string>();
  for (const m of live)
    for (const p of m.players) {
      if (p.sim || p.name === OUR_BOT) continue;
      names.set(p.id, p.name);
      (byBot.get(p.id) ?? byBot.set(p.id, []).get(p.id)!).push(m);
    }
  const profiles: (BidProfile & { matches: number; obs: number; exact: number; logLik: number; avgScore: number })[] = [];
  for (const [id, ms] of byBot) {
    if (ms.length < MIN_MATCHES) continue;
    const recent = ms.slice(-RECENT_PER_BOT);
    const obsMap = new Map<number, Obs[]>();
    for (const m of recent) observations(m, dict, new Set([id]), obsMap);
    const obs = obsMap.get(id) ?? [];
    const f = fitTobit(obs, N_BID_FEATURES, 1000);
    let late = 0;
    for (const m of recent) late += m.words.filter((w) => w.bot === id && m.endAt - w.at < 3_000_000).length > 0 ? 1 : 0;
    profiles.push({
      name: names.get(id)!,
      w: f.w,
      sigma: f.sigma,
      dumps: late > recent.length * 0.3,
      matches: recent.length,
      obs: obs.length,
      exact: obs.filter((o) => !o.censored).length,
      logLik: f.logLik,
      avgScore: recent.reduce((a, m) => a + m.players.find((p) => p.id === id)!.score, 0) / recent.length,
    });
  }
  profiles.sort((a, b) => b.avgScore - a.avgScore);
  // Keep the previous calibration until --calibrate refits it, so training
  // never reloads uncalibrated profiles in between.
  let prev: { shift?: number[]; spread?: number[] } = {};
  try {
    prev = JSON.parse(readFileSync(PROFILES, "utf8"));
  } catch {
    // First fit.
  }
  writeFileSync(
    `${PROFILES}.tmp`,
    JSON.stringify({ fittedAt: new Date().toISOString(), features: BID_FEATURES, bots: profiles, shift: prev.shift, spread: prev.spread }),
  );
  renameSync(`${PROFILES}.tmp`, PROFILES);
  console.log(`${live.length} second-price matches; ${profiles.length} bots profiled in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log("bot                  matches  won   avgScore  sigma  gain  gain7  bal   mkt   (weights on log1p features)");
  for (const p of profiles.slice(0, 25))
    console.log(
      `${p.name.slice(0, 20).padEnd(20)} ${String(p.matches).padStart(7)} ${String(p.exact).padStart(5)} ${p.avgScore.toFixed(1).padStart(9)}  ` +
        `${p.sigma.toFixed(2)}  ${p.w[3]!.toFixed(2).padStart(5)} ${p.w[4]!.toFixed(2).padStart(5)} ${p.w[5]!.toFixed(2).padStart(5)} ${p.w[6]!.toFixed(2).padStart(5)}`,
    );
}

// ---- replays of our live matches ----

interface Stat {
  place: number;
  win: number;
  score: number;
  tiles: number;
  oppBest: number; // best opponent's score
  oppMean: number; // mean opponent score
  paid: number[][]; // prices paid per phase, every auction
  top: number[][]; // winning bids per phase
  // Our win rate by our own bid: [bids placed, won] per BUCKETS range.
  curve: [number, number][];
}
const BUCKETS = [1, 5, 10, 15, 25, 1e9];
const newStat = (): Stat => ({
  place: 0,
  win: 0,
  score: 0,
  tiles: 0,
  oppBest: 0,
  oppMean: 0,
  paid: [[], [], []],
  top: [[], [], []],
  curve: BUCKETS.slice(1).map(() => [0, 0]),
});
function addCurve(s: Stat, bid: number, won: boolean): void {
  const b = BUCKETS.findIndex((lo, i) => bid >= lo && bid < BUCKETS[i + 1]!);
  if (b < 0) return;
  s.curve[b]![0]++;
  if (won) s.curve[b]![1]++;
}
const quant = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
};
// The level calibration matches: mean of the median and 80th percentile.
const level = (xs: number[]) => (quant(xs, 0.5) + quant(xs, 0.8)) / 2;

// Our bids in live matches, from the live bot's log: match -> round -> bid.
function liveBids(): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  let text = "";
  try {
    text = readFileSync(`${root}live/${OUR_BOT}.log`, "latin1");
  } catch {
    return out;
  }
  for (const m of text.matchAll(/ m(\d+) r(\d+) bag \d+ '\w' bal \d+ -> (?:play \S+ )?bid (\d+)/g)) {
    const mid = Number(m[1]);
    (out.get(mid) ?? out.set(mid, new Map()).get(mid)!).set(Number(m[2]), Number(m[3]));
  }
  return out;
}

function loadReplay() {
  const since = Number(arg("since", "0"));
  const live = (JSON.parse(readFileSync(LIVE, "utf8")) as { matches: LiveMatch[] }).matches;
  const pj = JSON.parse(readFileSync(PROFILES, "utf8")) as { bots: BidProfile[]; shift?: number[] };
  const ours = live.filter((m) => m.id >= since && m.players.some((p) => p.name === OUR_BOT));
  if (!ours.length) throw new Error(`no ${OUR_BOT} matches since ${since} in data/live.json`);
  return {
    since,
    ours,
    pj,
    profs: new Map(pj.bots.map((p) => [p.name, p])),
    styles: loadStyles(`${root}data/styles.json`),
    market: loadMarket(`${root}data/field.json`),
    dict: Dictionary.load(`${root}data/wordlist.txt`),
  };
}

function liveStats(ours: LiveMatch[]): Stat {
  const s = newStat();
  const bids = liveBids();
  for (const m of ours) {
    const me = m.players.findIndex((p) => p.name === OUR_BOT);
    const pf = placeFraction(
      m.players.map((p) => p.score),
      me,
    );
    s.place += pf;
    s.win += pf === 1 ? 1 : 0;
    s.score += m.players[me]!.score;
    s.tiles += m.auctions.filter((a) => a.winner === m.players[me]!.id).length;
    const opp = m.players.filter((_, k) => k !== me).map((p) => p.score);
    s.oppBest += Math.max(...opp);
    s.oppMean += opp.reduce((a, b) => a + b, 0) / opp.length;
    const mine = bids.get(m.id);
    m.auctions.forEach((a, k) => {
      const ph = Math.min(2, Math.floor((3 * k) / m.auctions.length));
      if (a.winner !== null) s.paid[ph]!.push(a.paid);
      if (a.top !== null) s.top[ph]!.push(a.top);
      const b = mine?.get(k + 1);
      if (b !== undefined) addCurve(s, b, a.winner === m.players[me]!.id);
    });
  }
  return s;
}

// The model of a live opponent: its profile, else a server sim or a field model.
function seatBot(r: ReturnType<typeof loadReplay>, pl: LiveMatch["players"][number], seed: number): Bot {
  const prof = r.profs.get(pl.name);
  if (prof) {
    const st = r.styles.get(pl.name);
    return st ? new StyledBot(prof, st, seed) : new ProfileBot(prof, seed);
  }
  if (pl.sim) return new SimBot(SERVER_SIMS[pl.id % SERVER_SIMS.length]!, seed);
  const top = r.market?.top?.find((t) => t.name === pl.name);
  if (top && r.market) return new TopBot(top, r.market, seed);
  return new MarketBot(r.market!, seed);
}

// Plays every live match `reps` times per params set, same opponents
// (profiled when possible) and same seats; paired across params sets. With
// `plan`, the last params set plays as the look-ahead planner.
function replay(r: ReturnType<typeof loadReplay>, params: ReturnType<typeof decode>[], reps: number, plan?: PlanConfig) {
  const stats = params.map(newStat);
  const diffs: number[] = [];
  for (const m of r.ours) {
    const me = m.players.findIndex((p) => p.name === OUR_BOT);
    for (let rep = 0; rep < reps; rep++) {
      const seed = (Math.imul(m.id, 2654435761) ^ Math.imul(rep + 1, 40503)) >>> 0;
      const per: number[] = [];
      params.forEach((p, i) => {
        const st = stats[i]!;
        const n = 98 - 5 * m.players.length;
        // The planner's rollouts model each seat as the replay does.
        const us =
          plan && i === params.length - 1
            ? new PlannerBot(p, plan, (seat, s) => seatBot(r, m.players[seat]!, s), seed ^ 0x5bd1e995)
            : new EvoBot(p, "us");
        // Highest bid per round across the table, and ours.
        const top = new Map<number, number>();
        let ourBid = 0;
        const seen = (round: number, bid: number) => top.set(round, Math.max(top.get(round) ?? 0, bid));
        const spy: Bot = {
          name: "us",
          onStart: (s, np, rack, d) => us.onStart(s, np, rack, d),
          onAuction: (v) => {
            const a = us.onAuction(v);
            ourBid = a.bid;
            seen(v.round, a.bid);
            return a;
          },
          onWord: (s, w) => us.onWord(s, w),
          onResult: (v, letter, winner, paid) => {
            const ph = Math.min(2, Math.floor((3 * (v.round - 1)) / n));
            if (winner >= 0) {
              st.paid[ph]!.push(paid);
              st.top[ph]!.push(top.get(v.round) ?? paid);
            }
            if (ourBid > 0) addCurve(st, ourBid, winner === me);
            ourBid = 0;
            return us.onResult(v, letter, winner, paid);
          },
        };
        // Records an opponent's bids; server-side sims bid inside the
        // engine, so they are left unwrapped.
        const watch = (b: Bot): Bot =>
          b.serverSide
            ? b
            : {
                name: b.name,
                onStart: (s, np, rack, d) => b.onStart(s, np, rack, d),
                onAuction: (v) => {
                  const a = b.onAuction(v);
                  seen(v.round, a.bid);
                  return a;
                },
                onWord: (s, w) => b.onWord?.(s, w),
                onResult: (v, letter, winner, paid) => b.onResult(v, letter, winner, paid),
              };
        const bots: Bot[] = m.players.map((pl, k): Bot => (k === me ? spy : watch(seatBot(r, pl, seed + 7919 * k))));
        const res = playMatch(bots, r.dict, seed, "Vickrey");
        const f = placeFraction(res.scores, me);
        st.place += f;
        st.win += f === 1 ? 1 : 0;
        st.score += res.scores[me]!;
        st.tiles += res.tilesWon[me]!;
        const opp = res.scores.filter((_, k) => k !== me);
        st.oppBest += Math.max(...opp);
        st.oppMean += opp.reduce((a, b) => a + b, 0) / opp.length;
        per.push(f);
      });
      if (per.length === 2) diffs.push(per[1]! - per[0]!);
    }
  }
  return { stats, diffs };
}

function show(label: string, s: Stat, k: number): void {
  const lv = (xs: number[][]) => xs.map((p) => `${quant(p, 0.5)}/${quant(p, 0.8)}`).join(" ");
  const curve = s.curve.map(([n, w]) => (n ? `${((100 * w) / n).toFixed(0)}%` : "-").padStart(4)).join(" ");
  console.log(
    `  ${label.padEnd(26)} place ${(s.place / k).toFixed(3)}  win ${((100 * s.win) / k).toFixed(1).padStart(5)}%  ` +
      `score ${(s.score / k).toFixed(1).padStart(5)}  tiles ${(s.tiles / k).toFixed(1).padStart(4)}  ` +
      `opponents best ${(s.oppBest / k).toFixed(1)} mean ${(s.oppMean / k).toFixed(1)}\n` +
      `  ${"".padEnd(26)} paid p50/p80 by phase ${lv(s.paid)}  top bid ${lv(s.top)}  our win% by our bid 1-4/5-9/10-14/15-24/25+ ${curve}`,
  );
}

function check(): void {
  const files = process.argv.slice(process.argv.indexOf("--check") + 1).filter((a) => a.endsWith(".json"));
  const reps = Number(arg("reps", "8"));
  const r = loadReplay();
  setProfileShift(r.pj.shift ?? [0, 0, 0], (r.pj as { spread?: number[] }).spread ?? [1, 1, 1], (r.pj as { letterShift?: number[] }).letterShift);
  const params = files.map((f) => decode(jsonToX(JSON.parse(readFileSync(f, "utf8")).params)));
  // --plan lastN,samples: the last params set plays with look-ahead.
  const planArg = arg("plan", "");
  const plan = planArg ? { lastN: Number(planArg.split(",")[0]), samples: Number(planArg.split(",")[1] ?? 32) } : undefined;
  const { stats, diffs } = replay(r, params, reps, plan);
  const n = r.ours.length;
  console.log(`${n} live ${OUR_BOT} matches since ${r.since}; ${reps} replays each; profile shift ${(r.pj.shift ?? [0, 0, 0]).map((x) => x.toFixed(2)).join("/")}`);
  show("live", liveStats(r.ours), n);
  stats.forEach((s, i) => show(`sim ${files[i]!.split("/").slice(-2).join("/")}`, s, n * reps));
  if (diffs.length) {
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1));
    console.log(`  B - A place: ${mean >= 0 ? "+" : ""}${mean.toFixed(4)} +- ${(sd / Math.sqrt(diffs.length)).toFixed(4)} (paired SE)`);
  }
}

// Fits the per-phase profile shift so replays of our live matches (with
// the params our bot played them with) pay the live price level.
function calibrate(): void {
  const file = process.argv[process.argv.indexOf("--calibrate") + 1]!;
  const reps = Number(arg("reps", "4"));
  const rounds = Number(arg("rounds", "5"));
  const r = loadReplay();
  const p = decode(jsonToX(JSON.parse(readFileSync(file, "utf8")).params));
  const lv = liveStats(r.ours);
  const n = r.ours.length;
  show("live", lv, n);
  let shift = [0, 0, 0];
  let spread = [1, 1, 1];
  // log(top / paid): how far the winning bid sits above the second price.
  const gap = (s: Stat, ph: number) => Math.log(level(s.top[ph]!) / level(s.paid[ph]!));
  for (let k = 0; k <= rounds; k++) {
    setProfileShift(shift, spread);
    const s = replay(r, [p], reps).stats[0]!;
    show(`shift ${shift.map((x) => x.toFixed(2)).join("/")} spread ${spread.map((x) => x.toFixed(2)).join("/")}`, s, n * reps);
    if (k === rounds) break;
    // Bids are lognormal: a log shift moves the price level by about the
    // same factor, and more noise widens the gap between the top two bids.
    shift = shift.map((x, ph) => x + Math.log(level(lv.paid[ph]!) / level(s.paid[ph]!)));
    spread = spread.map((x, ph) => Math.min(4, Math.max(0.25, x * (gap(lv, ph) / Math.max(0.01, gap(s, ph))))));
  }
  const pj = r.pj as { shift?: number[]; spread?: number[] };
  pj.shift = shift;
  pj.spread = spread;
  writeFileSync(`${PROFILES}.tmp`, JSON.stringify(pj));
  renameSync(`${PROFILES}.tmp`, PROFILES);
  console.log(`wrote shift ${shift.map((x) => x.toFixed(3)).join(", ")} spread ${spread.map((x) => x.toFixed(3)).join(", ")} to data/profiles.json`);
}

if (import.meta.main) {
  if (process.argv.includes("--check")) check();
  else if (process.argv.includes("--calibrate")) calibrate();
  else await fit();
}
