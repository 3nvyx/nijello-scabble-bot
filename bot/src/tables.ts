// Table builders and scoring shared by training and benchmarks.

import type { Dictionary } from "./dict.ts";
import { type Bot, playMatch } from "./game.ts";
import { readFileSync } from "node:fs";
import {
  type BidProfile,
  loadMarket,
  type MarketBids,
  MarketBot,
  ProfileBot,
  SERVER_SIMS,
  setProfileShift,
  SimBot,
  StarterBot,
  TopBot,
} from "./opponents.ts";
import { Rng } from "./rng.ts";
import type { AuctionType } from "./rules.ts";
import { decode, EvoBot } from "./strategy.ts";
import { loadStyles, StyledBot, type WordStyle } from "./style.ts";

export type Opp =
  | { kind: "sim"; i: number }
  | { kind: "starter" }
  | { kind: "hof"; i: number }
  | { kind: "market" }
  | { kind: "top"; i: number }
  | { kind: "prof"; name: string };

const FIELD_PATH = new URL("../data/field.json", import.meta.url).pathname;
let market: MarketBids | null = loadMarket(FIELD_PATH);

// Fitted bid functions of live bots (src/profile.ts) and word-play styles
// (src/style.ts). When present, a "top" seat is that bot's profile+style and
// a "market" seat a random profiled bot of the live field. PROFILES=0 turns
// them off.
const PROFILES_PATH = new URL("../data/profiles.json", import.meta.url).pathname;
const STYLES_PATH = new URL("../data/styles.json", import.meta.url).pathname;
function loadProfiles(): BidProfile[] {
  if (process.env.PROFILES === "0") return [];
  try {
    const j = JSON.parse(readFileSync(PROFILES_PATH, "utf8")) as {
      bots: BidProfile[];
      shift?: number[];
      spread?: number[];
      letterShift?: number[];
    };
    setProfileShift(j.shift ?? [0, 0, 0], j.spread ?? [1, 1, 1], j.letterShift);
    return j.bots;
  } catch {
    return [];
  }
}
let profiles = loadProfiles();
let profileByName = new Map(profiles.map((p) => [p.name, p]));
let styles: Map<string, WordStyle> = process.env.PROFILES === "0" ? new Map() : loadStyles(STYLES_PATH);

function makeProfiledBot(prof: BidProfile, seed: number): Bot {
  const st = styles.get(prof.name);
  return st ? new StyledBot(prof, st, seed) : new ProfileBot(prof, seed);
}

// FOCUS="james,Lambi Lambiii,Chinese Dante": half of all top-bot seats go to
// these profiled bots, so training concentrates on beating the strongest.
const FOCUS = (process.env.FOCUS ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
const FOCUS_SHARE = 0.5;

// Players per table, ours included, as "size:weight". Default "6:1" matches
// live 6-player lobbies and the 6-player confirmation benchmark in train.ts.
const SIZE_WEIGHTS = (process.env.TABLE_SIZES ?? "6:1")
  .split(",")
  .map((x) => x.split(":").map(Number) as [number, number]);
const SIZE_TOTAL = SIZE_WEIGHTS.reduce((a, [, w]) => a + w, 0);
export function sampleSize(rng: Rng): number {
  let r = rng.float() * SIZE_TOTAL;
  for (const [n, w] of SIZE_WEIGHTS) if ((r -= w) < 0) return n;
  return SIZE_WEIGHTS.at(-1)![0];
}

// Re-read data/field.json, data/profiles.json, and data/styles.json
// (refreshed from the live server while training).
export function reloadField(): void {
  market = loadMarket(FIELD_PATH) ?? market;
  const p = loadProfiles();
  if (p.length) {
    profiles = p;
    profileByName = new Map(p.map((x) => [x.name, x]));
  }
  const st = process.env.PROFILES === "0" ? new Map() : loadStyles(STYLES_PATH);
  if (st.size) styles = st;
}

export function topCount(): number {
  return market?.top?.length ?? 0;
}

export interface TableSpec {
  seed: number;
  auctionType: AuctionType;
  opps: Opp[];
}

// Tournament Swiss points for one match, as a fraction of first place:
// (n - place) / (n - 1), place = how many scored strictly more.
export function placeFraction(scores: number[], seat: number): number {
  const n = scores.length;
  const place = scores.filter((s) => s > scores[seat]!).length;
  return (n - 1 - place) / (n - 1);
}

// Opponent mix for one evaluation game. Fitness is the mean over these,
// so the mix is the training objective. 75% of games are against models
// of the real field, because that is who the tournament seats:
//   40% top       models of the strongest individual live bots
//   20% market    the live field's bid distribution as a whole
//   15% field     top, market and past champions mixed
//   10% league    past champions only (keeps self-play honest)
//   10% weak      sims, starter bots and field models mixed
//    5% lobby     server sims only, as when a lobby times out
export function sampleTable(rng: Rng, hofSize: number, nTop: number): TableSpec {
  const roll = rng.float();
  const n = sampleSize(rng);
  const opps: Opp[] = [];
  const hof = (): Opp => ({ kind: "hof", i: rng.int(0, Math.max(0, hofSize - 1)) });
  const mkt = (): Opp => (market ? { kind: "market" } : hof());
  const focus = FOCUS.filter((f) => profileByName.has(f));
  const top = (): Opp =>
    focus.length && rng.float() < FOCUS_SHARE
      ? { kind: "prof", name: focus[rng.int(0, focus.length - 1)]! }
      : nTop > 0
        ? { kind: "top", i: rng.int(0, nTop - 1) }
        : mkt();
  const push = (f: () => Opp) => {
    for (let k = 0; k < n - 1; k++) opps.push(f());
  };
  if (roll < 0.4) push(top);
  else if (roll < 0.6) push(mkt);
  else if (roll < 0.75) push(() => (rng.float() < 0.4 ? top() : rng.float() < 0.5 ? mkt() : hof()));
  else if (roll < 0.85) push(hof);
  else if (roll < 0.95)
    push(() => {
      const r = rng.float();
      return r < 0.35 ? { kind: "sim", i: rng.int(0, 5) } : r < 0.55 ? { kind: "starter" } : r < 0.8 ? top() : mkt();
    });
  else {
    const sims = [0, 1, 2, 3, 4, 5];
    rng.shuffle(sims);
    for (let k = 0; k < n - 1; k++) opps.push({ kind: "sim", i: sims[k % 6]! });
  }
  return {
    seed: rng.u32(),
    auctionType: rng.float() < 0.8 ? "Vickrey" : "FirstPrice",
    opps,
  };
}

export function makeOpp(o: Opp, hof: Float64Array[], seed: number, k: number): Bot {
  switch (o.kind) {
    case "sim":
      return new SimBot(SERVER_SIMS[o.i]!, seed + 7919 * (k + 1));
    case "starter":
      return new StarterBot();
    case "hof":
      return new EvoBot(decode(hof[o.i]!), `hof${o.i}`);
    case "market": {
      const s = seed + 104729 * (k + 1);
      if (profiles.length) return makeProfiledBot(profiles[(s >>> 0) % profiles.length]!, s);
      return new MarketBot(market!, s);
    }
    case "top": {
      const s = seed + 130363 * (k + 1);
      const prof = profileByName.get(market!.top![o.i]!.name);
      return prof ? makeProfiledBot(prof, s) : new TopBot(market!.top![o.i]!, market!, s);
    }
    case "prof":
      return makeProfiledBot(profileByName.get(o.name)!, seed + 130363 * (k + 1));
  }
}

// Plays `subject` against the table, seated at a seed-chosen position.
// Returns [placeFraction, score].
export function runTable(
  subject: Bot,
  t: TableSpec,
  hof: Float64Array[],
  dict: Dictionary,
): [number, number] {
  const bots = t.opps.map((o, k) => makeOpp(o, hof, t.seed, k));
  const seat = t.seed % (bots.length + 1);
  bots.splice(seat, 0, subject);
  const res = playMatch(bots, dict, t.seed, t.auctionType);
  return [placeFraction(res.scores, seat), res.scores[seat]!];
}
