// Benchmark one parameter file (or the hand-set defaults) against fixed
// fields. Usage: node src/bench.ts [params.json] [games] [players, 2-10, default 6]

import { readFileSync } from "node:fs";
import { Dictionary } from "./dict.ts";
import { type Bot, playMatch } from "./game.ts";
import { SERVER_SIMS, SimBot, StarterBot } from "./opponents.ts";
import { Rng } from "./rng.ts";
import { decode, EvoBot, jsonToX } from "./strategy.ts";
import { placeFraction } from "./tables.ts";

const dict = Dictionary.load(new URL("../data/wordlist.txt", import.meta.url).pathname);
const file = process.argv[2];
const games = Number(process.argv[3] ?? 200);
const players = Number(process.argv[4] ?? 6);
const k = players - 1;
const x = file && file !== "-" ? jsonToX(JSON.parse(readFileSync(file, "utf8")).params) : new Float64Array(0);
const base = new Float64Array(0);

type Field = { name: string; make: (rng: Rng, seed: number) => Bot[] };
const sims = (rng: Rng, seed: number, k: number): Bot[] => {
  const order = [0, 1, 2, 3, 4, 5];
  rng.shuffle(order);
  // More than six seats repeat the server's six sims.
  return Array.from({ length: k }, (_, j) => new SimBot(SERVER_SIMS[order[j % 6]!]!, seed + 31 * j));
};
const fields: Field[] = [
  { name: `vs ${k} server sims (lobby)`, make: (r, s) => sims(r, s, k) },
  { name: `vs ${k} starter bots`, make: () => Array.from({ length: k }, () => new StarterBot()) },
  {
    name: `vs ${k} default-param evo bots`,
    make: () => Array.from({ length: k }, (_, i) => new EvoBot(decode(base), `d${i}`)),
  },
];

for (const f of fields) {
  const rng = new Rng(12345);
  let place = 0;
  let wins = 0;
  let score = 0;
  let oppScore = 0;
  let leftover = 0;
  const t0 = performance.now();
  for (let g = 0; g < games; g++) {
    const seed = rng.u32();
    const opps = f.make(rng, seed);
    const seat = g % players;
    const me = new EvoBot(decode(x), "me");
    opps.splice(seat, 0, me);
    const res = playMatch(opps, dict, seed, "Vickrey");
    const pf = placeFraction(res.scores, seat);
    place += pf;
    if (pf === 1) wins++;
    score += res.scores[seat]!;
    oppScore += (res.scores.reduce((a, b) => a + b, 0) - res.scores[seat]!) / k;
    leftover += res.leftover[seat]!;
  }
  const ms = (performance.now() - t0) / games;
  console.log(
    `${f.name.padEnd(30)} win ${((100 * wins) / games).toFixed(1)}%  place ${(place / games).toFixed(3)}  ` +
      `score ${(score / games).toFixed(1)}  opp avg ${(oppScore / games).toFixed(1)}  ` +
      `leftover ${(leftover / games).toFixed(1)}  ${ms.toFixed(1)} ms/game`,
  );
}
