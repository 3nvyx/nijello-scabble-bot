// Look-ahead bidding and word-cashing planner. The evolved policy picks an
// action in a fraction of a millisecond; the planner then plays the rest of
// the match out many times from the real position using paired common random
// numbers, checking both critical word-cashing decisions and endgame bids.

import type { Dictionary, Rack } from "./dict.ts";
import { type Action, type Bot, continueMatch, type MidMatch, type View } from "./game.ts";
import { Rng } from "./rng.ts";
import { BAG_COUNTS } from "./rules.ts";
import { EvoBot, type Params, type Tracker } from "./strategy.ts";

export type PlanMode = "swiss" | "bracket" | "final";

export interface PlanConfig {
  // Plan only when this many tiles or fewer are left in the bag.
  lastN: number;
  // Rollouts per candidate when no deadline is given (the simulator).
  samples: number;
  // Tournament stage objective (default inferred from table size or "swiss").
  mode?: PlanMode;
}

// Model of the bot in a given seat, for rollouts.
export type SeatModel = (seat: number, seed: number) => Bot;

export interface PlanResult {
  bid: number;
  policyBid: number;
  candidates: number;
  samples: number;
  gain: number; // mean placing gain of the chosen bid over the policy's
  se: number;
  ms: number;
}

export interface WordPlanResult {
  action: Action;
  changed: boolean;
  kind: string;
  samples: number;
  gain: number;
  se: number;
  ms: number;
}

// Tournament Swiss points for one match, as a fraction of first place.
function placeFraction(scores: number[], seat: number): number {
  const n = scores.length;
  const place = scores.filter((s) => s > scores[seat]!).length;
  return (n - 1 - place) / (n - 1);
}

// Bids worth trying: the policy's, a conservative floor bid, and multiples of
// the larger of the policy's bid and the table's recent price, up to balance.
export function candidateBids(policy: number, balance: number, market: number): number[] {
  const p = Math.max(policy, Math.round(market));
  const out = [policy];
  for (const b of [
    policy > 0 ? 1 : 0,
    Math.round(p * 0.5),
    Math.round(p * 0.75),
    Math.round(p * 1.25),
    Math.round(p * 1.6),
    Math.round(p * 2.2),
    balance,
  ]) {
    const c = Math.max(0, Math.min(balance, b));
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

// Our seat in a rollout: bids `bid` in the open auction (its words were
// already applied to the state), then plays on with the evolved policy,
// knowing what the real bot knew.
class FirstBid implements Bot {
  readonly name = "us";
  private inner: EvoBot;
  private first = true;
  private bid: number;
  private known: Tracker;

  constructor(p: Params, bid: number, known: Tracker) {
    this.inner = new EvoBot(p, "us");
    this.bid = bid;
    this.known = known;
  }

  onStart(seat: number, n: number, rack: Rack, dict: Dictionary): string[] {
    this.inner.onStart(seat, n, rack, dict);
    this.inner.tracker.primeFrom(this.known);
    return [];
  }

  onAuction(v: View): Action {
    if (this.first) {
      this.first = false;
      return { words: [], bid: this.bid };
    }
    return this.inner.onAuction(v);
  }

  onResult(v: View, letter: number, winner: number, paid: number): string[] {
    return this.inner.onResult(v, letter, winner, paid);
  }

  onWord(seat: number, word: string): void {
    this.inner.onWord(seat, word);
  }
}

// An opponent model dropped into the middle of a match: if it tracks the
// game, it starts from what we know (prices so far, unseen letters).
function primed(b: Bot, known: Tracker): Bot {
  if (!(b instanceof EvoBot)) return b;
  return {
    name: b.name,
    onStart: (seat, n, rack, dict) => {
      b.onStart(seat, n, rack, dict);
      b.tracker.primeFrom(known);
      return [];
    },
    onAuction: (v) => b.onAuction(v),
    onResult: (v, letter, winner, paid) => b.onResult(v, letter, winner, paid),
    onWord: (seat, word) => b.onWord(seat, word),
  };
}

function drawFrom(pool: Int32Array, total: number, rng: Rng): number {
  let idx = rng.int(0, total - 1);
  for (let c = 0; c < 26; c++) {
    if (idx < pool[c]!) {
      pool[c]!--;
      return c;
    }
    idx -= pool[c]!;
  }
  return -1;
}

export class PlannerBot extends EvoBot {
  private cfg: PlanConfig;
  private seatModel: SeatModel;
  private rng: Rng;
  lastPlan: PlanResult | null = null;
  lastWordPlan: WordPlanResult | null = null;

  constructor(p: Params, cfg: PlanConfig, seatModel: SeatModel, seed = 1, name = "planner") {
    super(p, name);
    this.cfg = cfg;
    this.seatModel = seatModel;
    this.rng = new Rng(seed);
  }

  private bidOnlyFor(
    r: Rack,
    balance: number,
    letter: number,
    bagLeft: number,
    nPlayers: number,
    auctionType: View["auctionType"],
  ): number {
    const value = this.letterValue(r, letter, bagLeft);
    if (value <= 0 || balance <= 0) return 0;
    if (bagLeft === 1) return balance;
    const nScale = nPlayers < 6 ? Math.sqrt(nPlayers / 6) : nPlayers / 6;
    const budget = (balance / (bagLeft + 1)) * nScale;
    let mult =
      Math.exp(this.p.c0!) *
      Math.pow(budget / 3, this.p.c1!) *
      Math.pow(this.tracker.marketPrice() / 12, this.p.marketW!);
    let cap = balance * Math.min(1, this.p.maxFrac! + (1 - bagLeft / (bagLeft + this.p.tau!)));
    if (bagLeft <= this.p.endN!) {
      mult *= 1 + (this.p.spendW! * (this.p.endN! + 1 - bagLeft)) / (this.p.endN! + 1);
      cap = balance;
    }
    let bid = value * mult;
    if (auctionType === "FirstPrice") bid *= this.p.fpShade!;
    return Math.max(0, Math.floor(Math.min(bid, cap, balance)));
  }

  private altWordAction(v: View, act: Action): { words: string[]; bid: number; kind: string } | null {
    const d = this.dictionary;
    // Case A: Policy wants to cash a <7L word in the last 25 auctions -> compare against holding <7L words.
    if (v.bagLeft >= 2 && v.bagLeft <= 25 && act.words.some((w) => w.length < 7)) {
      const rAlt = Int32Array.from(v.rack);
      const wordsAlt = this.chooseWords(rAlt, v.balance, v.bagLeft, 7);
      let balAlt = v.balance;
      for (const w of wordsAlt) balAlt += this.wordReward(w);
      const bidAlt = this.bidOnlyFor(rAlt, balAlt, v.letter, v.bagLeft, v.nPlayers, v.auctionType);
      return { words: wordsAlt, bid: bidAlt, kind: "hold_short" };
    }
    // Case B: In the last 14 auctions, policy holds (words=[]) when rack already has a 7+L word -> compare against cashing now.
    if (v.bagLeft >= 2 && v.bagLeft <= 14 && act.words.length === 0) {
      const i7 = d.best(v.rack, 7);
      if (i7 >= 0) {
        const rAlt = Int32Array.from(v.rack);
        d.spend(rAlt, i7);
        const w7 = d.words[i7]!;
        const balAlt = v.balance + d.reward[i7]!;
        const bidAlt = this.bidOnlyFor(rAlt, balAlt, v.letter, v.bagLeft, v.nPlayers, v.auctionType);
        return { words: [w7], bid: bidAlt, kind: "cash_7plus" };
      }
    }
    return null;
  }

  planWords(v: View, act: Action, budget: { samples?: number; deadline?: number }): WordPlanResult {
    const t0 = performance.now();
    const alt = this.altWordAction(v, act);
    if (!alt) {
      this.lastWordPlan = { action: act, changed: false, kind: "none", samples: 0, gain: 0, se: 0, ms: 0 };
      return this.lastWordPlan;
    }
    const d = this.dictionary;
    const me = v.seat;
    const applyWords = (ws: string[]) => {
      const r = Int32Array.from(v.rack);
      let bal = v.balance;
      let sc = v.score;
      for (const w of ws) {
        const idx = d.indexOf(w);
        d.spend(r, idx);
        bal += d.reward[idx]!;
        sc += d.reward[idx]!;
      }
      return { r, bal, sc };
    };
    const s0 = applyWords(act.words);
    const s1 = applyWords(alt.words);
    const diffs: number[] = [];
    const maxSamples = budget.samples ?? Infinity;
    let k = 0;
    while (k < maxSamples && (budget.deadline === undefined || performance.now() < budget.deadline)) {
      const seed = this.rng.u32();
      const state0 = this.sample(v, s0.r, s0.bal, s0.sc);
      const state1: MidMatch = {
        racks: state0.racks.map((rk, idx) => (idx === me ? Int32Array.from(s1.r) : Int32Array.from(rk))),
        balances: state0.balances.map((b, idx) => (idx === me ? s1.bal : b)),
        scores: state0.scores.map((s, idx) => (idx === me ? s1.sc : s)),
        bag: Int32Array.from(state0.bag),
        letter: state0.letter,
        round: state0.round,
      };
      const v0 = this.rollout(state0, act.bid, seed, me, v.nPlayers);
      const v1 = this.rollout(state1, alt.bid, seed, me, v.nPlayers);
      diffs.push(v1 - v0);
      k++;
    }
    let changed = false;
    let gain = 0;
    let se = 0;
    if (k >= 6) {
      const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const sd = Math.sqrt(diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (diffs.length - 1));
      const s = sd / Math.sqrt(diffs.length);
      gain = mean;
      se = s;
      if (mean > 2.0 * s && mean >= 0.015) {
        changed = true;
      }
    }
    const chosen: Action = changed ? { words: alt.words, bid: alt.bid } : act;
    this.lastWordPlan = {
      action: chosen,
      changed,
      kind: alt.kind,
      samples: k,
      gain,
      se,
      ms: performance.now() - t0,
    };
    return this.lastWordPlan;
  }

  override onAuction(v: View): Action {
    let act = super.onAuction(v);
    if (this.cfg.samples > 0) {
      act = this.planWords(v, act, { samples: this.cfg.samples }).action;
    }
    if (!this.shouldPlan(v)) return act;
    return { words: act.words, bid: this.plan(v, act, { samples: this.cfg.samples }).bid };
  }

  shouldPlan(v: View): boolean {
    return v.auctionType === "Vickrey" && v.bagLeft > 1 && v.bagLeft <= this.cfg.lastN && v.balance > 1;
  }

  // Public so the live client can send the policy's bid first and plan
  // after, until `deadline` (performance.now() milliseconds).
  plan(v: View, act: Action, budget: { samples?: number; deadline?: number }): PlanResult {
    const t0 = performance.now();
    const d = this.dictionary;
    const me = v.seat;
    const myRack = Int32Array.from(v.rack);
    let myBal = v.balance;
    let myScore = v.score;
    for (const w of act.words) {
      const i = d.indexOf(w);
      d.spend(myRack, i);
      myBal += d.reward[i]!;
      myScore += d.reward[i]!;
    }
    const cands = candidateBids(act.bid, myBal, this.tracker.marketPrice());
    const diffs: number[][] = cands.map(() => []);
    const maxSamples = budget.samples ?? Infinity;
    let k = 0;
    while (k < maxSamples && (budget.deadline === undefined || performance.now() < budget.deadline)) {
      const seed = this.rng.u32();
      const state = this.sample(v, myRack, myBal, myScore);
      const vals = cands.map((b) => this.rollout(state, b, seed, me, v.nPlayers));
      for (let c = 1; c < cands.length; c++) diffs[c]!.push(vals[c]! - vals[0]!);
      k++;
    }
    let best = 0;
    let gain = 0;
    let se = 0;
    if (k >= 4) {
      for (let c = 1; c < cands.length; c++) {
        const xs = diffs[c]!;
        const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
        const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
        const s = sd / Math.sqrt(xs.length);
        if (mean > gain && mean > 1.4 * s && mean >= 0.005) {
          best = c;
          gain = mean;
          se = s;
        }
      }
    }
    this.lastPlan = {
      bid: cands[best]!,
      policyBid: act.bid,
      candidates: cands.length,
      samples: k,
      gain,
      se,
      ms: performance.now() - t0,
    };
    return this.lastPlan;
  }

  // One guess at the hidden information: each opponent's unknown starting
  // tiles drawn from the letters we haven't seen; the rest is the bag.
  private sample(v: View, myRack: Rack, myBal: number, myScore: number): MidMatch {
    const pool = Int32Array.from(this.tracker.unseen);
    let total = pool.reduce((a, b) => a + b, 0);
    const racks: Rack[] = [];
    for (let s = 0; s < v.nPlayers; s++) {
      if (s === v.seat) {
        racks.push(Int32Array.from(myRack));
        continue;
      }
      const { known, hidden } = this.tracker.heldBy(s);
      const r = Int32Array.from(known);
      const h = Math.min(hidden, Math.max(0, total - v.bagLeft));
      for (let j = 0; j < h; j++) {
        const c = drawFrom(pool, total, this.rng);
        if (c < 0) break;
        r[c]!++;
        total--;
      }
      racks.push(r);
    }
    // The bag must hold exactly bagLeft tiles; trim or pad if our tracking
    // and the server disagree.
    while (total > v.bagLeft) {
      drawFrom(pool, total, this.rng);
      total--;
    }
    if (total < v.bagLeft) {
      const fill = Int32Array.from(BAG_COUNTS);
      let fillTotal = fill.reduce((a, b) => a + b, 0);
      while (total < v.bagLeft) {
        const c = drawFrom(fill, fillTotal--, this.rng);
        pool[c]!++;
        total++;
      }
    }
    const balances = [...v.balances];
    const scores = [...v.scores];
    balances[v.seat] = myBal;
    scores[v.seat] = myScore;
    return { racks, balances, scores, bag: pool, letter: v.letter, round: v.round };
  }

  private rollout(state: MidMatch, bid: number, seed: number, me: number, n: number): number {
    const bots: Bot[] = [];
    for (let s = 0; s < n; s++)
      bots.push(s === me ? new FirstBid(this.p, bid, this.tracker) : primed(this.seatModel(s, seed + 7919 * (s + 1)), this.tracker));
    const res = continueMatch(bots, this.dictionary, seed, state);
    const myScore = res.scores[me]!;
    const mode = this.cfg.mode ?? (n === 2 ? "final" : n > 6 ? "bracket" : "swiss");
    if (mode === "final") {
      const oppScore = res.scores[1 - me] ?? 0;
      return (myScore - oppScore) / 100 + 0.1 * placeFraction(res.scores, me);
    }
    if (mode === "bracket") {
      let minOpp = Infinity;
      for (let i = 0; i < res.scores.length; i++) if (i !== me && res.scores[i]! < minOpp) minOpp = res.scores[i]!;
      const survive = myScore > minOpp ? 1 : myScore === minOpp ? 0.5 : 0;
      return 0.75 * survive + 0.25 * placeFraction(res.scores, me) + 0.0008 * myScore;
    }
    return placeFraction(res.scores, me) + 0.0005 * myScore;
  }
}
