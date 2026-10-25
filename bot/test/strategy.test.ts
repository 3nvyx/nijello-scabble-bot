import assert from "node:assert/strict";
import { test } from "node:test";
import { Dictionary, rackFromString } from "../src/dict.ts";
import type { View } from "../src/game.ts";
import { decode, DIM, EvoBot, jsonToX, paramsToJson } from "../src/strategy.ts";

const dict = Dictionary.load(new URL("../data/wordlist.txt", import.meta.url).pathname);

function view(rack: string, letter: string, bagLeft: number, balance: number): View {
  return {
    seat: 0,
    nPlayers: 6,
    auctionType: "Vickrey",
    rack: rackFromString(rack),
    balance,
    score: 0,
    balances: [balance, 100, 100, 100, 100, 100],
    scores: [0, 0, 0, 0, 0, 0],
    letter: letter.charCodeAt(0) - 65,
    bagLeft,
    round: 68 - bagLeft,
  };
}

function freshBot(): EvoBot {
  const b = new EvoBot(decode([]));
  b.onStart(0, 6, rackFromString("AEINR"), dict);
  return b;
}

test("the last auction bids nothing and dumps the rack", () => {
  const a = freshBot().onAuction(view("JUKEBOX", "E", 0, 50));
  assert.equal(a.bid, 0);
  assert.deepEqual(a.words, ["JUKEBOX"]);
});

test("the last playable auction spends the whole balance on a useful tile", () => {
  // Holding JUKEBO, an X completes JUKEBOX (81) in the final dump.
  const a = freshBot().onAuction(view("JUKEBO", "X", 1, 37));
  assert.deepEqual(a.words, [], "JOKE must wait: X would make JUKEBOX");
  assert.equal(a.bid, 37);
});

test("parameter files round-trip and old files gain the new defaults", () => {
  const x = Float64Array.from({ length: DIM }, (_, i) => ((i % 5) - 2) / 10);
  const back = jsonToX(paramsToJson(x));
  for (let i = 0; i < DIM; i++) assert.ok(Math.abs(back[i]! - x[i]!) < 1e-9);
  const j = paramsToJson(x);
  delete j.endN;
  assert.equal(jsonToX(j)[DIM - 5], 0, "a missing parameter starts at its default");
});

test("a finished 7+ letter word is played at once, even in the endgame", () => {
  // Match 788: EQUERRY was held for the final dump while coins ran out.
  const a = freshBot().onAuction(view("EQUERRYT", "B", 7, 14));
  assert.ok(a.words.includes("EQUERRY"), `played ${a.words.join(",")}`);
});

test("bids rise when the table is expensive", () => {
  const p = decode(jsonToX({ marketW: 1 }));
  const cheap = new EvoBot(p);
  const dear = new EvoBot(p);
  cheap.onStart(0, 6, rackFromString("AEINR"), dict);
  dear.onStart(0, 6, rackFromString("AEINR"), dict);
  for (let k = 0; k < 15; k++) {
    cheap.onResult(view("", "E", 50, 100), 4, 1, 4);
    dear.onResult(view("", "E", 50, 100), 4, 1, 18);
  }
  const v = view("AEINRS", "T", 40, 100);
  assert.ok(dear.onAuction(v).bid > cheap.onAuction(v).bid);
});
