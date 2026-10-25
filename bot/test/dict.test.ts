import assert from "node:assert/strict";
import { test } from "node:test";
import { Dictionary, rackFromString } from "../src/dict.ts";
import { Rng } from "../src/rng.ts";
import { BAG_COUNTS } from "../src/rules.ts";

const dict = Dictionary.load(new URL("../data/wordlist.txt", import.meta.url).pathname);

function randomRack(rng: Rng, size: number): Int32Array {
  const bag: number[] = [];
  BAG_COUNTS.forEach((n, c) => {
    for (let k = 0; k < n; k++) bag.push(c);
  });
  rng.shuffle(bag);
  const r = new Int32Array(26);
  for (let k = 0; k < size; k++) r[bag[k]!]!++;
  return r;
}

test("trie queries agree with linear scans on random racks", () => {
  const rng = new Rng(7);
  for (let t = 0; t < 300; t++) {
    const r = randomRack(rng, t % 21);
    const before = Int32Array.from(r);
    assert.equal(dict.best(r, 2), dict.bestScan(r, 2));
    assert.equal(dict.best(r, 5), dict.bestScan(r, 5));
    assert.deepEqual(dict.bestPair(r), dict.bestPairScan(r));
    assert.deepEqual(dict.top(r, 24, 2), dict.topScan(r, 24, 2));
    assert.equal(dict.longest(r, 3), dict.longestScan(r, 3));
    assert.equal(dict.longest(r, 2), dict.longestScan(r, 2));
    assert.deepEqual(r, before, "queries must not change the rack");
  }
});

test("rewards follow the server's length multiplier", () => {
  const reward = (w: string) => dict.reward[dict.indexOf(w)]!;
  // The server's list has no QI or ZA, so a Q needs a U.
  assert.equal(dict.indexOf("QI"), -1);
  assert.equal(reward("OX"), 9); // 1 + 8, 1x
  assert.equal(reward("JINX"), Math.floor((8 + 1 + 1 + 8) * 1.5)); // 27
  assert.equal(reward("JUKEBOX"), 81); // 27 base, 3x (seen live: +81)
  assert.equal(reward("AZONIC"), 42); // 17 base, 2.5x (seen live: +42)
});

test("bestSet never spends letters the rack lacks", () => {
  const rng = new Rng(11);
  for (let t = 0; t < 40; t++) {
    const r = randomRack(rng, 6 + (t % 12));
    const pick = dict.bestSet(r);
    const used = new Int32Array(26);
    for (const i of pick) for (const ch of dict.words[i]!) used[ch.charCodeAt(0) - 65]!++;
    for (let c = 0; c < 26; c++) assert.ok(used[c]! <= r[c]!);
  }
  const r = rackFromString("JUKEBOXOX");
  const total = dict.bestSet(r).reduce((a, i) => a + dict.reward[i]!, 0);
  assert.ok(total >= 81 + 9, `JUKEBOX + OX should be found, got ${total}`);
});
