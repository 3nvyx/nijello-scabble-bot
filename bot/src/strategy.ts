// Our bot. Pure decision logic shared by the simulator and the live client,
// so the tuned parameters run unchanged in the real game.
//
// Three parts:
//   calculation - a rack-potential function Q(rack) plus exact dictionary
//                 lookups for the best word now; a letter is worth the
//                 change it makes to both.
//   memory      - Tracker infers which letters are still unseen (bag plus
//                 opponents' hidden starting tiles) from public events.
//   evolution   - every weight below is tuned by CMA-ES (train.ts).

import { type Dictionary, type Rack, rackSize } from "./dict.ts";
import type { Action, Bot, View } from "./game.ts";
import { A_CODE, BAG_COUNTS, FACE, STARTING_RACK_SIZE, VOWEL } from "./rules.ts";

interface Spec {
  name: string;
  init: number;
  lo: number;
  hi: number;
}

const LETTER_SPECS: Spec[] = FACE.map((f, c) => {
  const ch = String.fromCharCode(A_CODE + c);
  const init = ch === "Q" ? 6 : 1.8 * f;
  return { name: `keep_${ch}`, init, lo: 0, hi: 4 * f + 6 };
});

export const SPECS: Spec[] = [
  ...LETTER_SPECS,
  { name: "vowelTarget", init: 0.42, lo: 0.15, hi: 0.65 },
  { name: "vowelW", init: 2.5, lo: 0, hi: 15 },
  { name: "dupW", init: 1.0, lo: 0, hi: 8 },
  { name: "qNoU", init: 6, lo: 0, hi: 25 },
  { name: "scarceW", init: 0, lo: -15, hi: 15 },
  { name: "wB", init: 0.4, lo: 0, hi: 2.5 },
  { name: "wB7", init: 0.6, lo: 0, hi: 2.5 },
  { name: "tau", init: 12, lo: 0.5, hi: 60 },
  { name: "denyW", init: 0.4, lo: 0, hi: 4 },
  { name: "c0", init: 1.6, lo: -2.5, hi: 2.5 },
  { name: "c1", init: 0.5, lo: -0.5, hi: 1.5 },
  { name: "maxFrac", init: 0.6, lo: 0.03, hi: 1 },
  { name: "fpShade", init: 0.7, lo: 0.2, hi: 1 },
  { name: "holdW", init: 1.0, lo: 0, hi: 3 },
  { name: "cashW", init: 0.5, lo: 0, hi: 4 },
  { name: "cashScale", init: 30, lo: 3, hi: 200 },
  { name: "playThresh", init: 0, lo: -15, hi: 25 },
  // Endgame: within endN auctions of the end, a letter is also worth
  // exactly what it adds to the final word dump (bestSet), and leftover
  // coins lose their value, so bids scale up by spendW.
  { name: "endN", init: 6, lo: 1, hi: 20 },
  { name: "wFlush", init: 1, lo: 0, hi: 3 },
  { name: "spendW", init: 1, lo: 0, hi: 6 },
  // In the endgame, words wait for the final dump (cashing one early can
  // break a bigger word the next tile would complete) unless the balance
  // is below endCash.
  { name: "endCash", init: 8, lo: 0, hi: 60 },
  // Market pressure: bids scale with (recent prices / 12)^marketW, so the
  // bot can keep up at expensive tables (live match 788: we bid 4-10 into a
  // table paying 10-16 and won 6 tiles). Starts off: forcing it to 1 cost
  // 8 points of win rate in simulation, so evolution decides.
  { name: "marketW", init: 0, lo: 0, hi: 2.5 },
];
export const DIM = SPECS.length;

export type Params = Record<string, number> & { keep: Float64Array };

// CMA-ES searches x in R^DIM around 0; each coordinate moves its parameter
// by a quarter of its range per unit, clipped to [lo, hi].
export function decode(x: ArrayLike<number>): Params {
  const p = { keep: new Float64Array(26) } as Params;
  SPECS.forEach((s, i) => {
    const v = s.init + (x[i] ?? 0) * ((s.hi - s.lo) / 4);
    const clipped = Math.min(s.hi, Math.max(s.lo, v));
    if (i < 26) p.keep[i] = clipped;
    else p[s.name] = clipped;
  });
  return p;
}

export function paramsToJson(x: ArrayLike<number>): Record<string, number> {
  const out: Record<string, number> = {};
  const p = decode(x);
  SPECS.forEach((s, i) => {
    out[s.name] = i < 26 ? p.keep[i]! : p[s.name]!;
  });
  return out;
}

// Inverse of paramsToJson (exact for in-range values).
export function jsonToX(j: Record<string, number>): Float64Array {
  return Float64Array.from(SPECS, (s) =>
    j[s.name] === undefined ? 0 : (j[s.name]! - s.init) / ((s.hi - s.lo) / 4),
  );
}

// Recent price level of a match (prices paid, oldest first), shrunk toward
// a prior of 12 (a typical live price for a common letter) while there are
// few observations. Shared with the profiler, which rebuilds it for real bots.
export function marketPriceOf(paid: readonly number[]): number {
  const recent = paid.slice(-20);
  return (12 * 5 + recent.reduce((a, b) => a + b, 0)) / (5 + recent.length);
}

// Letters this seat has not seen: the bag plus opponents' unrevealed
// starting tiles. Built only from information a real bot gets.
export class Tracker {
  readonly unseen = Int32Array.from(BAG_COUNTS);
  private seat = -1;
  private won: Int32Array[] = [];
  private played: Int32Array[] = [];
  private revealed: Int32Array[] = [];

  start(seat: number, nPlayers: number, rack: Rack): void {
    this.unseen.set(BAG_COUNTS);
    this.paid.length = 0;
    this.seat = seat;
    this.won = Array.from({ length: nPlayers }, () => new Int32Array(26));
    this.played = Array.from({ length: nPlayers }, () => new Int32Array(26));
    this.revealed = Array.from({ length: nPlayers }, () => new Int32Array(26));
    for (let c = 0; c < 26; c++) this.unseen[c]! -= rack[c]!;
  }

  // An auction's letter is public once it opens.
  auctionOpened(letter: number): void {
    this.unseen[letter]!--;
  }

  // Prices paid in this match, newest last (public in auction_result).
  readonly paid: number[] = [];

  marketPrice(): number {
    return marketPriceOf(this.paid);
  }

  auctionClosed(letter: number, winner: number, paid = 0): void {
    if (winner >= 0) this.paid.push(paid);
    if (winner >= 0 && winner !== this.seat) this.won[winner]![letter]!++;
  }

  // What an opponent is known to hold: tiles it bought plus starting tiles
  // its words revealed, minus letters it played; and how many of its
  // starting tiles are still unknown (to be drawn from `unseen`).
  heldBy(seat: number): { known: Int32Array; hidden: number } {
    const known = new Int32Array(26);
    let revealed = 0;
    const won = this.won[seat]!;
    const rev = this.revealed[seat]!;
    const played = this.played[seat]!;
    for (let c = 0; c < 26; c++) {
      known[c] = Math.max(0, won[c]! + rev[c]! - played[c]!);
      revealed += rev[c]!;
    }
    return { known, hidden: Math.max(0, STARTING_RACK_SIZE - revealed) };
  }

  // Copies another tracker's view of the unseen letters and prices, so a
  // bot dropped into the middle of a simulated match knows what the real
  // one knew.
  primeFrom(t: Tracker): void {
    this.unseen.set(t.unseen);
    this.paid.length = 0;
    this.paid.push(...t.paid);
  }

  wordPlayed(seat: number, word: string): void {
    if (seat === this.seat) return;
    const played = this.played[seat]!;
    const won = this.won[seat]!;
    const rev = this.revealed[seat]!;
    for (let i = 0; i < word.length; i++) {
      const c = word.charCodeAt(i) - A_CODE;
      played[c]!++;
      // Played beyond what they bought must have come from their start rack.
      const fromStart = Math.max(0, played[c]! - won[c]!);
      if (fromStart > rev[c]!) {
        rev[c] = fromStart;
        this.unseen[c] = Math.max(0, this.unseen[c]! - 1);
      }
    }
  }
}

export class EvoBot implements Bot {
  readonly name: string;
  readonly p: Params;
  private dict!: Dictionary;
  readonly tracker = new Tracker();

  constructor(p: Params, name = "evo") {
    this.p = p;
    this.name = name;
  }

  onStart(seat: number, n: number, rack: Rack, dict: Dictionary): string[] {
    this.dict = dict;
    this.tracker.start(seat, n, rack);
    return [];
  }

  onWord(seat: number, word: string): void {
    this.tracker.wordPlayed(seat, word);
  }

  onResult(_v: View, letter: number, winner: number, paid = 0): string[] {
    this.tracker.auctionClosed(letter, winner, paid);
    return [];
  }

  protected get dictionary(): Dictionary {
    return this.dict;
  }

  wordReward(w: string): number {
    return this.dict.reward[this.dict.indexOf(w)]!;
  }

  // Rack potential: what the letters are worth if held, before any word.
  quality(r: Rack): number {
    const p = this.p;
    let q = 0;
    let size = 0;
    let vowels = 0;
    let dup = 0;
    for (let c = 0; c < 26; c++) {
      const k = r[c]!;
      if (k === 0) continue;
      q += p.keep[c]! * k;
      size += k;
      if (VOWEL[c]) vowels += k;
      if (k > 1) dup += (k - 1) * (k - 1);
    }
    if (size === 0) return 0;
    q -= p.vowelW! * Math.abs(vowels - p.vowelTarget! * size);
    q -= p.dupW! * dup;
    if (r[16]! > 0 && r[20] === 0) q -= p.qNoU!; // Q without U
    return q;
  }

  private phase(bagLeft: number): number {
    return bagLeft / (bagLeft + this.p.tau!);
  }

  // Choose words to play now. Repeats while some word is worth more played
  // than held.
  chooseWords(r: Rack, balance: number, bagLeft: number, minLen = 2): string[] {
    const d = this.dict;
    const p = this.p;
    const out: string[] = [];
    const ph = this.phase(bagLeft);
    for (let iter = 0; iter < 4; iter++) {
      const cands = d.top(r, 24, minLen);
      if (cands.length === 0) break;
      const qNow = this.quality(r);
      const cash = 1 + (p.cashW! * p.cashScale!) / (p.cashScale! + balance);
      let best = -1;
      let bestNet = p.playThresh!;
      const tmp = new Int32Array(26);
      for (const i of cands) {
        tmp.set(r);
        d.spend(tmp, i);
        const net = d.reward[i]! * cash - p.holdW! * ph * (qNow - this.quality(tmp));
        if (net > bestNet) {
          bestNet = net;
          best = i;
        }
      }
      if (best < 0) break;
      d.spend(r, best);
      balance += d.reward[best]!;
      out.push(d.words[best]!);
    }
    return out;
  }

  // Total reward of the best disjoint set of words in r.
  flushValue(r: Rack): number {
    const d = this.dict;
    let total = 0;
    for (const i of d.bestSet(r, 150, rackSize(r) > 14 ? 2000 : 8000)) total += d.reward[i]!;
    return total;
  }

  // Empty the rack into the best disjoint set of words.
  flush(r: Rack): string[] {
    const d = this.dict;
    const pick = d.bestSet(r);
    for (const i of pick) d.spend(r, i);
    return pick.map((i) => d.words[i]!);
  }

  letterValue(r: Rack, letter: number, bagLeft: number): number {
    const p = this.p;
    const d = this.dict;
    const ph = this.phase(bagLeft);
    const with_ = Int32Array.from(r);
    with_[letter]!++;
    const [b0, b70] = d.bestPair(r);
    const [b1, b71] = d.bestPair(with_);
    let v = ph * (this.quality(with_) - this.quality(r));
    v += p.wB! * (b1 - b0) + p.wB7! * (b71 - b70);
    v += p.denyW! * FACE[letter]! * ph;
    // Scarcity: unseen vowel share below the target makes vowels dearer.
    const u = this.tracker.unseen;
    let unseenTotal = 0;
    let unseenV = 0;
    for (let c = 0; c < 26; c++) {
      unseenTotal += u[c]!;
      if (VOWEL[c]) unseenV += u[c]!;
    }
    if (unseenTotal > 0) {
      const gap = p.vowelTarget! - unseenV / unseenTotal;
      v += (VOWEL[letter] ? 1 : -1) * p.scarceW! * gap * ph;
    }
    if (letter === 16 && r[20] === 0 && u[20] === 0) v = Math.min(v, 0); // Q, no U left
    if (bagLeft <= p.endN!) v = Math.max(v, p.wFlush! * (this.flushValue(with_) - this.flushValue(r)));
    return v;
  }

  onAuction(v: View): Action {
    this.tracker.auctionOpened(v.letter);
    const r = Int32Array.from(v.rack);
    // Last auction: its tile can never be played. Cash in everything.
    if (v.bagLeft === 0) return { words: this.flush(r), bid: 0 };
    const p = this.p;
    const holdForDump = v.bagLeft <= p.endN! && v.balance >= p.endCash!;
    // A 7+ letter word already has the top multiplier, so holding it gains
    // nothing and delays its coins; only shorter words wait for the dump.
    const words = this.chooseWords(r, v.balance, v.bagLeft, holdForDump ? 7 : 2);
    let balance = v.balance;
    for (const w of words) balance += this.wordReward(w);
    const value = this.letterValue(r, v.letter, v.bagLeft);
    if (value <= 0 || balance <= 0) return { words, bid: 0 };
    // Last auction whose tile can still be played (in the final dump):
    // coins are worthless after it, so bid everything for any gain.
    if (v.bagLeft === 1) return { words, bid: balance };
    const nScale = v.nPlayers < 6 ? Math.sqrt(v.nPlayers / 6) : v.nPlayers / 6;
    const budget = (balance / (v.bagLeft + 1)) * nScale;
    let mult =
      Math.exp(p.c0!) * Math.pow(budget / 3, p.c1!) * Math.pow(this.tracker.marketPrice() / 12, p.marketW!);
    let cap = balance * Math.min(1, p.maxFrac! + (1 - this.phase(v.bagLeft)));
    if (v.bagLeft <= p.endN!) {
      mult *= 1 + (p.spendW! * (p.endN! + 1 - v.bagLeft)) / (p.endN! + 1);
      cap = balance;
    }
    let bid = value * mult;
    if (v.auctionType === "FirstPrice") bid *= p.fpShade!;
    bid = Math.floor(Math.min(bid, cap, balance));
    return { words, bid: Math.max(0, bid) };
  }
}
