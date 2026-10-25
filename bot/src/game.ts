// Match simulator. Follows closeAuction / startMatchWith / playWord in the
// server's spacetimedb/src/game.ts step for step; RULES.md lists each rule.

import type { Dictionary, Rack } from "./dict.ts";
import { rackFromString } from "./dict.ts";
import { Rng } from "./rng.ts";
import {
  AUCTION_RESERVE,
  type AuctionType,
  BAG_COUNTS,
  BAG_SIZE,
  STARTING_BALANCE,
  STARTING_RACK_SIZE,
} from "./rules.ts";

// What one bot can see when it acts. `rack` is a private copy.
export interface View {
  seat: number;
  nPlayers: number;
  auctionType: AuctionType;
  rack: Rack;
  balance: number;
  score: number;
  balances: readonly number[];
  scores: readonly number[];
  letter: number; // letter up for auction, 0 = A
  // Tiles left in the bag after this auction's letter was drawn. 0 means
  // this is the last auction: the match ends when it closes.
  bagLeft: number;
  round: number; // 1-based auction number
}

export interface Action {
  words: string[]; // played in order before the bid is placed
  bid: number;
}

export interface Bot {
  readonly name: string;
  // Driven inside the module (sim bots). Their post-win word is played in
  // closeAuction before the end-of-match check, so it counts even after the
  // final auction. External bots' words after that are refused.
  readonly serverSide?: boolean;
  onStart(seat: number, nPlayers: number, rack: Rack, dict: Dictionary): string[];
  // At auction open: words to play, then a sealed bid.
  onAuction(v: View): Action;
  // After every auction closes (winner may be -1). Returns words to play.
  onResult(v: View, letter: number, winner: number, paid: number): string[];
  // Any seat played a word (including this bot).
  onWord?(seat: number, word: string): void;
}

export interface MatchResult {
  scores: number[];
  balances: number[];
  tilesWon: number[];
  wordsPlayed: number[];
  leftover: number[]; // tiles still on each rack at the end
}

// Mutable state of one match, shared by a fresh match and a resumed one.
interface SimState {
  bag: Int32Array;
  bagTotal: number;
  racks: Rack[];
  balances: number[];
  scores: number[];
  tilesWon: number[];
  wordsPlayed: number[];
}

// Weighted by remaining count, letters in alphabetical order (drawLetter).
function draw(st: SimState, rng: Rng): number {
  if (st.bagTotal === 0) return -1;
  let idx = rng.int(0, st.bagTotal - 1);
  for (let c = 0; c < 26; c++) {
    if (idx < st.bag[c]!) {
      st.bag[c]!--;
      st.bagTotal--;
      return c;
    }
    idx -= st.bag[c]!;
  }
  return -1;
}

function playWord(bots: Bot[], dict: Dictionary, st: SimState, seat: number, word: string): boolean {
  if (word.length < 2 || !dict.isValid(word)) return false;
  const need = rackFromString(word);
  const r = st.racks[seat]!;
  for (let c = 0; c < 26; c++) if (need[c]! > r[c]!) return false;
  for (let c = 0; c < 26; c++) r[c]! -= need[c]!;
  const reward = dict.reward[dict.indexOf(word)]!;
  st.balances[seat]! += reward;
  st.scores[seat]! += reward;
  st.wordsPlayed[seat]!++;
  for (const b of bots) b.onWord?.(seat, word);
  return true;
}

// Runs auctions from `letter` (already drawn, auction number `round`) until
// the bag is empty.
function runAuctions(
  bots: Bot[],
  dict: Dictionary,
  rng: Rng,
  st: SimState,
  auctionType: AuctionType,
  firstLetter: number,
  firstRound: number,
): MatchResult {
  const n = bots.length;
  const view = (s: number, letter: number, round: number): View => ({
    seat: s,
    nPlayers: n,
    auctionType,
    rack: Int32Array.from(st.racks[s]!),
    balance: st.balances[s]!,
    score: st.scores[s]!,
    balances: st.balances,
    scores: st.scores,
    letter,
    bagLeft: st.bagTotal,
    round,
  });

  let round = firstRound - 1;
  let letter = firstLetter;
  while (letter >= 0) {
    round++;
    const bids: { seat: number; amount: number }[] = [];
    for (let s = 0; s < n; s++) {
      const act = bots[s]!.onAuction(view(s, letter, round));
      for (const w of act.words) playWord(bots, dict, st, s, w);
      // submit_bid refuses negative bids and bids above balance; a zero
      // bid never wins (closeAuction drops amounts <= 0).
      const amount = Math.floor(act.bid);
      if (amount > 0 && amount <= st.balances[s]!) bids.push({ seat: s, amount });
    }
    rng.shuffle(bids);
    // Array.prototype.sort is stable, so ties stay in shuffled order.
    bids.sort((x, y) => y.amount - x.amount);
    let winner = -1;
    let paid = 0;
    const [first, second] = bids;
    if (first) {
      paid =
        auctionType === "FirstPrice"
          ? first.amount
          : second
            ? second.amount
            : Math.min(AUCTION_RESERVE, first.amount);
      if (st.balances[first.seat]! >= paid) {
        winner = first.seat;
        st.balances[winner]! -= paid;
        st.racks[winner]![letter]!++;
        st.tilesWon[winner]!++;
      }
    }
    // Drawn before bots react so we know whether the match just ended.
    // Result views therefore already count the next auction's draw.
    const next = draw(st, rng);
    for (let s = 0; s < n; s++) {
      const words = bots[s]!.onResult(view(s, letter, round), letter, winner, paid);
      if (next >= 0 || bots[s]!.serverSide) for (const w of words) playWord(bots, dict, st, s, w);
    }
    letter = next;
  }

  return {
    scores: st.scores,
    balances: st.balances,
    tilesWon: st.tilesWon,
    wordsPlayed: st.wordsPlayed,
    leftover: st.racks.map((r) => r.reduce((a, b) => a + b, 0)),
  };
}

export function playMatch(
  bots: Bot[],
  dict: Dictionary,
  seed: number,
  auctionType: AuctionType = "Vickrey",
): MatchResult {
  const rng = new Rng(seed);
  const n = bots.length;
  const st: SimState = {
    bag: Int32Array.from(BAG_COUNTS),
    bagTotal: BAG_SIZE,
    racks: bots.map(() => new Int32Array(26)),
    balances: new Array<number>(n).fill(STARTING_BALANCE),
    scores: new Array<number>(n).fill(0),
    tilesWon: new Array<number>(n).fill(0),
    wordsPlayed: new Array<number>(n).fill(0),
  };
  for (let s = 0; s < n; s++) {
    for (let k = 0; k < STARTING_RACK_SIZE; k++) {
      const c = draw(st, rng);
      if (c < 0) break;
      st.racks[s]![c]!++;
    }
  }
  // Every bot learns its rack before anyone's opening word is announced.
  const opening = bots.map((b, s) => b.onStart(s, n, Int32Array.from(st.racks[s]!), dict));
  opening.forEach((words, s) => {
    for (const w of words) playWord(bots, dict, st, s, w);
  });
  return runAuctions(bots, dict, rng, st, auctionType, draw(st, rng), 1);
}

// A match already under way: every seat's tiles (hidden ones already filled
// in), coins and score, the letters still in the bag, and the auction now
// open. Used by the planner to play the rest of a match out.
export interface MidMatch {
  racks: Rack[];
  balances: number[];
  scores: number[];
  bag: Int32Array; // after `letter` was drawn
  letter: number;
  round: number; // 1-based auction number of `letter`
}

// Plays a match on from `state`. Bots get onStart with their current rack
// (its returned words are ignored: openings happened long ago), then the
// open auction and every later one run as in playMatch. tilesWon and
// wordsPlayed count from this point on.
export function continueMatch(
  bots: Bot[],
  dict: Dictionary,
  seed: number,
  state: MidMatch,
  auctionType: AuctionType = "Vickrey",
): MatchResult {
  const n = bots.length;
  const st: SimState = {
    bag: Int32Array.from(state.bag),
    bagTotal: state.bag.reduce((a, b) => a + b, 0),
    racks: state.racks.map((r) => Int32Array.from(r)),
    balances: [...state.balances],
    scores: [...state.scores],
    tilesWon: new Array<number>(n).fill(0),
    wordsPlayed: new Array<number>(n).fill(0),
  };
  bots.forEach((b, s) => b.onStart(s, n, Int32Array.from(st.racks[s]!), dict));
  return runAuctions(bots, dict, new Rng(seed), st, auctionType, state.letter, state.round);
}
