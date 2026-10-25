// Fixed opponents: the server's simulated bots (game.ts decideBid +
// simulateWordPlay) and the starter kit's default strategy
// (bot-starter/src/strategy.ts + index.ts).

import { readFileSync } from "node:fs";
import type { Dictionary, Rack } from "./dict.ts";
import type { Action, Bot, View } from "./game.ts";
import { Rng } from "./rng.ts";
import { FACE, SIM_BID_JITTER, VOWEL } from "./rules.ts";
import { decode, EvoBot, jsonToX } from "./strategy.ts";

export type SimStrategy = "Cheapskate" | "ValueBidder" | "Aggressive";

// The six sims the server seeds; lobbies pad with a shuffled subset.
export const SERVER_SIMS: readonly SimStrategy[] = [
  "Cheapskate",
  "ValueBidder",
  "Aggressive",
  "ValueBidder",
  "Aggressive",
  "Cheapskate",
];

export function simBid(s: SimStrategy, letter: number, balance: number, jitter: number): number {
  const value = FACE[letter]!;
  let base: number;
  switch (s) {
    case "Cheapskate":
      base = value - 1;
      break;
    case "ValueBidder":
      base = value;
      break;
    case "Aggressive":
      base = value + (VOWEL[letter] ? 4 : 2);
      break;
  }
  return Math.max(Math.min(Math.max(base + jitter, 1), balance), 0);
}

export class SimBot implements Bot {
  readonly name: string;
  readonly serverSide = true;
  readonly strategy: SimStrategy;
  private dict!: Dictionary;
  private rng: Rng;

  constructor(strategy: SimStrategy, seed: number) {
    this.strategy = strategy;
    this.name = `sim-${strategy}`;
    this.rng = new Rng(seed);
  }

  onStart(_s: number, _n: number, _r: Rack, dict: Dictionary): string[] {
    this.dict = dict;
    return [];
  }

  onAuction(v: View): Action {
    const jitter = this.rng.int(-SIM_BID_JITTER, SIM_BID_JITTER);
    return { words: [], bid: simBid(this.strategy, v.letter, v.balance, jitter) };
  }

  onResult(v: View, _letter: number, winner: number): string[] {
    if (winner !== v.seat) return [];
    const i = this.dict.longest(v.rack, 3);
    return i < 0 ? [] : [this.dict.words[i]!];
  }
}

// Starter kit default: face value + 2 for letters it lacks, else face value;
// plays its longest word (2+ letters) when its rack changes. Its 500 ms
// retry guard means the follow-up rack change from its own word is ignored,
// so in practice it plays one word at start and one after each win.
export class StarterBot implements Bot {
  readonly name = "starter";
  private dict!: Dictionary;

  onStart(_s: number, _n: number, rack: Rack, dict: Dictionary): string[] {
    this.dict = dict;
    const i = dict.longest(rack, 2);
    return i < 0 ? [] : [dict.words[i]!];
  }

  onAuction(v: View): Action {
    const value = FACE[v.letter]!;
    const want = v.rack[v.letter] === 0 ? value + 2 : Math.max(1, value);
    return { words: [], bid: Math.min(want, Math.max(0, v.balance)) };
  }

  onResult(v: View, _letter: number, winner: number): string[] {
    if (winner !== v.seat) return [];
    const i = this.dict.longest(v.rack, 2);
    return i < 0 ? [] : [this.dict.words[i]!];
  }
}

// Stand-in for the live field's real bots. Bids are drawn from what real
// bots actually paid to win each letter (data/field.json, by game phase),
// scaled by a per-bot factor because a winning bid is the highest of
// several. Word play is our own default strategy, which hoards for 7+
// letter words like the top live bots do.
export interface MarketBids {
  bids: number[][][]; // [letter][phase] sorted winning bids
  top?: TopModelData[];
}

// Per-phase multipliers on the field models' bids, fitted by
// src/calibrate.ts so the models bid like the live server.
let phaseScale = [1, 1, 1];
try {
  const c = JSON.parse(readFileSync(new URL("../data/calibration.json", import.meta.url), "utf8"));
  if (Array.isArray(c.phaseScale) && c.phaseScale.length === 3) phaseScale = c.phaseScale.map(Number);
} catch {
  // No calibration yet: models bid their raw samples.
}
export function setCalibration(s: number[]): void {
  phaseScale = [...s];
}

// Word play and endgame for the field models: a strong evolved parameter
// set (data/model-economy.json), so the models earn and keep coins like
// real bots do. Their bids still come from the live data.
let economy: Float64Array = new Float64Array(0);
try {
  economy = jsonToX(JSON.parse(readFileSync(new URL("../data/model-economy.json", import.meta.url), "utf8")).params);
} catch {
  // Defaults.
}
// Calibration (src/calibrate.ts) showed the fitted minimum-length rule
// leaves the models broke by the late game (late top bids 11 vs 16 live);
// playing words with the economy parameters gets closer (12/19 vs 16/25,
// and our tiles won drop from 17 toward the 12 seen live). So that is the
// default; MODEL_WORDS=style restores the minimum-length rule.
const EVO_WORDS = process.env.MODEL_WORDS !== "style";

export function setEconomy(x: ArrayLike<number>): void {
  economy = Float64Array.from(x);
}

// Real bots keep coins for the late game (live late-game top bids are as
// high as early ones). Without pacing the models go broke by mid-game, so
// each model spends at most this share of its balance on one auction:
// about a third early, all of it in the last few auctions.
function paceCap(balance: number, bagLeft: number, pace: number): number {
  return balance * Math.min(1, pace / (1 + bagLeft / 10));
}

export function loadMarket(path: string): MarketBids | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as MarketBids;
  } catch {
    return null;
  }
}

export class MarketBot extends EvoBot {
  private market: MarketBids;
  private scale: number;
  private rng: Rng;
  private nAuctions = 68;
  private cashFloor: number;
  private pace: number;

  constructor(market: MarketBids, seed: number) {
    super(decode(economy), "market");
    this.market = market;
    this.rng = new Rng(seed);
    this.scale = 0.65 + 0.35 * this.rng.float();
    this.cashFloor = 10 + 20 * this.rng.float();
    this.pace = 1.5 + 2 * this.rng.float();
  }

  override onStart(seat: number, n: number, rack: Rack, dict: Dictionary): string[] {
    this.nAuctions = 98 - 5 * n;
    return super.onStart(seat, n, rack, dict);
  }

  // The top live bots play 7+ letter words as soon as they can, and cash
  // in a 5+ letter word when they run short of coins.
  override chooseWords(r: Rack, balance: number, bagLeft: number, minLen = 2): string[] {
    if (EVO_WORDS) return super.chooseWords(r, balance, bagLeft, minLen);
    const d = this.dictionary;
    const out: string[] = [];
    for (;;) {
      let i = d.best(r, 7);
      if (i < 0 && balance < this.cashFloor) i = d.best(r, 5);
      if (i < 0) break;
      d.spend(r, i);
      balance += d.reward[i]!;
      out.push(d.words[i]!);
    }
    return out;
  }

  override onAuction(v: View): Action {
    const act = super.onAuction(v);
    if (v.bagLeft === 0) return act;
    const phase = Math.min(2, Math.floor((3 * (v.round - 1)) / this.nAuctions));
    const pool = this.market.bids[v.letter]?.[phase] ?? [];
    const sample = pool.length ? pool[this.rng.int(0, pool.length - 1)]! : FACE[v.letter]! * 6;
    let balance = v.balance;
    for (const w of act.words) balance += this.wordReward(w);
    const cap = Math.floor(paceCap(balance, v.bagLeft, this.pace));
    return { words: act.words, bid: Math.max(0, Math.min(cap, Math.round(sample * this.scale * phaseScale[phase]!))) };
  }
}

// One specific top live bot, fitted from its own public history: its own
// winning bids per letter and phase, its typical shortest mid-game word,
// and whether it dumps leftovers at the end.
export interface TopModelData {
  name: string;
  bids: number[][][];
  minLen: number;
  dumps: boolean;
}

export class TopBot extends EvoBot {
  private m: TopModelData;
  private field: MarketBids;
  private rng: Rng;
  private scale: number;
  private pace: number;
  private nAuctions = 68;

  constructor(m: TopModelData, field: MarketBids, seed: number) {
    super(decode(economy), `top-${m.name}`);
    this.m = m;
    this.field = field;
    this.rng = new Rng(seed);
    this.scale = 0.8 + 0.2 * this.rng.float();
    this.pace = 1.5 + 2 * this.rng.float();
  }

  override onStart(seat: number, n: number, rack: Rack, dict: Dictionary): string[] {
    this.nAuctions = 98 - 5 * n;
    return super.onStart(seat, n, rack, dict);
  }

  override chooseWords(r: Rack, balance: number, bagLeft: number, minLen = 2): string[] {
    if (EVO_WORDS) return super.chooseWords(r, balance, bagLeft, minLen);
    const d = this.dictionary;
    const out: string[] = [];
    for (;;) {
      let i = d.best(r, this.m.minLen);
      if (i < 0 && balance < 15) i = d.best(r, Math.max(4, this.m.minLen - 2));
      if (i < 0) break;
      d.spend(r, i);
      balance += d.reward[i]!;
      out.push(d.words[i]!);
    }
    return out;
  }

  override onAuction(v: View): Action {
    if (v.bagLeft === 0 && !this.m.dumps) {
      this.tracker.auctionOpened(v.letter);
      return { words: [], bid: 0 };
    }
    const act = super.onAuction(v);
    if (v.bagLeft === 0) return act;
    const phase = Math.min(2, Math.floor((3 * (v.round - 1)) / this.nAuctions));
    // Its own bids when it has enough history for this letter, else the
    // whole field's.
    const own = this.m.bids[v.letter]?.[phase] ?? [];
    const pool = own.length >= 5 ? own : (this.field.bids[v.letter]?.[phase] ?? []);
    const sample = pool.length ? pool[this.rng.int(0, pool.length - 1)]! : FACE[v.letter]! * 6;
    let balance = v.balance;
    for (const w of act.words) balance += this.wordReward(w);
    const cap = Math.floor(paceCap(balance, v.bagLeft, this.pace));
    return { words: act.words, bid: Math.max(0, Math.min(cap, Math.round(sample * this.scale * phaseScale[phase]!))) };
  }
}

// Bid features shared by the profiler (src/profile.ts), which rebuilds them
// for real bots from public match data, and ProfileBot, which computes them
// from its own rack in the simulator. Keep the two in step.
export const BID_FEATURES = [
  "intercept",
  "phase", // auction index / auctions in the match
  "phase^2",
  "log1p(gain)", // best word reward with the letter minus without
  "log1p(gain7)", // same, 7+ letter words only
  "log1p(balance)",
  "log(market/12)", // recent prices in the match, shrunk toward 12
  "face/10",
  "vowel",
] as const;
export const N_BID_FEATURES = BID_FEATURES.length;

export function bidFeatures(
  out: Float64Array,
  phase: number,
  gain: number,
  gain7: number,
  balance: number,
  market: number,
  letter: number,
): Float64Array {
  out[0] = 1;
  out[1] = phase;
  out[2] = phase * phase;
  out[3] = Math.log1p(Math.max(0, gain));
  out[4] = Math.log1p(Math.max(0, gain7));
  out[5] = Math.log1p(Math.max(0, balance));
  out[6] = Math.log(Math.max(1, market) / 12);
  out[7] = FACE[letter]! / 10;
  out[8] = VOWEL[letter] ? 1 : 0;
  return out;
}

// A live bot's fitted bid function (src/profile.ts): log1p(bid) =
// w . bidFeatures + sigma * N(0, 1), floored at 0.
export interface BidProfile {
  name: string;
  w: number[];
  sigma: number;
  dumps: boolean;
}

// Per-phase shift of every profile's log-bid, fitted by
// `node src/profile.ts --calibrate` so replays of our live matches pay the
// live prices. One Gaussian in log space can't hold both the zero bids on
// unwanted letters and the high ones on wanted letters, so the raw fit
// underbids the top of the table.
// A per-phase spread multiplier on the noise sets how far the table's top
// bid sits above the price paid (the second-highest bid).
// src/calibrate-bids.ts fits a fourth entry of shift and spread for the
// last END_AUCTIONS auctions, where real bots keep bidding high; without it
// the third-phase entry is used there too.
export const END_AUCTIONS = 8;
// A per-letter shift (src/calibrate-bids.ts) corrects how much more the
// field pays for valuable letters than the fitted face-value term says.
let profileShift = [0, 0, 0];
let profileSpread = [1, 1, 1];
let profileLetterShift: number[] = new Array(26).fill(0);
export function setProfileShift(shift: number[], spread: number[] = [1, 1, 1], letterShift?: number[]): void {
  profileShift = shift;
  profileSpread = spread;
  profileLetterShift = letterShift?.length === 26 ? letterShift : new Array(26).fill(0);
}

// One profiled live bot. Bids like the real one does given what the letter
// is worth to its own rack, its coins and the table's prices; plays words
// with the evolved economy like the other field models.
export class ProfileBot extends EvoBot {
  private prof: BidProfile;
  private rng: Rng;
  private nAuctions = 68;
  private x = new Float64Array(N_BID_FEATURES);

  constructor(prof: BidProfile, seed: number) {
    super(decode(economy), `prof-${prof.name}`);
    this.prof = prof;
    this.rng = new Rng(seed);
  }

  override onStart(seat: number, n: number, rack: Rack, dict: Dictionary): string[] {
    this.nAuctions = 98 - 5 * n;
    return super.onStart(seat, n, rack, dict);
  }

  override onAuction(v: View): Action {
    if (v.bagLeft === 0 && !this.prof.dumps) {
      this.tracker.auctionOpened(v.letter);
      return { words: [], bid: 0 };
    }
    const act = super.onAuction(v);
    if (v.bagLeft === 0) return act;
    const d = this.dictionary;
    const r = Int32Array.from(v.rack);
    let balance = v.balance;
    for (const w of act.words) {
      d.spend(r, d.indexOf(w));
      balance += this.wordReward(w);
    }
    const with_ = Int32Array.from(r);
    with_[v.letter]!++;
    const [b0, b70] = d.bestPair(r);
    const [b1, b71] = d.bestPair(with_);
    const phase = (v.round - 1) / this.nAuctions;
    bidFeatures(this.x, phase, b1 - b0, b71 - b70, balance, this.tracker.marketPrice(), v.letter);
    const ph = v.bagLeft < END_AUCTIONS && profileShift.length > 3 ? 3 : Math.min(2, Math.floor(3 * phase));
    let y = profileShift[ph]! + profileLetterShift[v.letter]! + (profileSpread[ph] ?? 1) * this.prof.sigma * this.rng.normal();
    for (let i = 0; i < N_BID_FEATURES; i++) y += this.prof.w[i]! * this.x[i]!;
    const bid = Math.round(Math.expm1(Math.max(0, y)));
    return { words: act.words, bid: Math.max(0, Math.min(balance, bid)) };
  }
}
