import assert from "node:assert/strict";
import { test } from "node:test";
import { Dictionary, type Rack, rackFromString } from "../src/dict.ts";
import { type Action, type Bot, continueMatch, type View } from "../src/game.ts";
import { candidateBids, PlannerBot } from "../src/planner.ts";
import { decode, DIM } from "../src/strategy.ts";

const dict = Dictionary.load(new URL("../data/wordlist.txt", import.meta.url).pathname);

// Bids a fixed amount on every letter and never plays words.
class FixedBid implements Bot {
  readonly name = "fixed";
  private amount: number;
  constructor(amount: number) {
    this.amount = amount;
  }
  onStart(): string[] {
    return [];
  }
  onAuction(_v: View): Action {
    return { words: [], bid: this.amount };
  }
  onResult(): string[] {
    return [];
  }
}

const bagOf = (letters: string): Int32Array => rackFromString(letters);

test("continueMatch runs exactly the open auction plus the bag", () => {
  const seen: number[] = [];
  const spy: Bot = {
    name: "spy",
    onStart: () => [],
    onAuction: (v) => {
      seen.push(v.round);
      return { words: [], bid: 0 };
    },
    onResult: () => [],
  };
  const res = continueMatch([spy, new FixedBid(0)], dict, 1, {
    racks: [rackFromString("AB"), rackFromString("CD")],
    balances: [40, 50],
    scores: [10, 20],
    bag: bagOf("EF"),
    letter: 6, // G
    round: 66,
  });
  assert.deepEqual(seen, [66, 67, 68]);
  // Nobody bid, so every letter was discarded and nothing changed hands.
  assert.deepEqual(res.tilesWon, [0, 0]);
  assert.deepEqual(res.scores, [10, 20]);
});

test("candidate bids start with the policy's, are unique and stay within the balance", () => {
  for (const [policy, bal, market] of [
    [12, 40, 10],
    [0, 30, 14],
    [40, 40, 12],
    [5, 3, 12],
  ] as const) {
    const c = candidateBids(Math.min(policy, bal), bal, market);
    assert.equal(c[0], Math.min(policy, bal));
    assert.equal(new Set(c).size, c.length);
    for (const b of c) assert.ok(b >= 0 && b <= bal, `${b} outside 0..${bal}`);
    // A live bid can be lowered to 1 but never withdrawn (bids of 0 are ignored).
    assert.ok(c.includes(c[0]! > 0 ? 1 : 0) && c.includes(bal));
    if (c[0]! > 0) assert.ok(!c.includes(0));
  }
});

test("the planner never bids away a decisive final tile", () => {
  // We hold JUKEBO and X is up with one tile left: winning X makes JUKEBOX
  // (81) in the final dump. The opponent bids 30 on everything.
  const params = decode(new Float64Array(DIM));
  const planner = new PlannerBot(params, { lastN: 10, samples: 24 }, () => new FixedBid(30), 7);
  const rack: Rack = rackFromString("JUKEBO");
  const res = continueMatch([planner, new FixedBid(30)], dict, 3, {
    racks: [rack, rackFromString("AEIRST")],
    balances: [60, 60],
    scores: [0, 0],
    bag: bagOf("E"),
    letter: 23, // X
    round: 67,
  });
  const plan = planner.lastPlan;
  assert.ok(plan, "the planner should have planned the X auction");
  assert.ok(plan.samples >= 4);
  assert.ok(res.scores[0]! >= 81, `JUKEBOX should have been played, score ${res.scores[0]}`);
});
