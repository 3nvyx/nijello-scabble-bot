// Re-evaluates every saved snapshot of a run (hall of fame + current mean)
// against fixed fields with many games, to tell real progress from noise.
// Usage: node src/snapshots.ts runs/main [games] [players, 2-10, default 6]

import { readFileSync } from "node:fs";
import { Dictionary } from "./dict.ts";
import { playMatch } from "./game.ts";
import { loadMarket, MarketBot, SERVER_SIMS, SimBot } from "./opponents.ts";
import { Rng } from "./rng.ts";
import { decode, EvoBot } from "./strategy.ts";
import { placeFraction } from "./tables.ts";

const run = process.argv[2] ?? "runs/main";
const games = Number(process.argv[3] ?? 3000);
const players = Number(process.argv[4] ?? 6);
const oppSeats = Array.from({ length: players - 1 }, (_, i) => i);
const dict = Dictionary.load(new URL("../data/wordlist.txt", import.meta.url).pathname);
const market = loadMarket(new URL("../data/field.json", import.meta.url).pathname)!;
const ck = JSON.parse(readFileSync(`${run}/checkpoint.json`, "utf8"));
const snaps: { label: string; x: number[] }[] = ck.hof.map((x: number[], i: number) => ({
  label: i === 0 ? "gen 0 (defaults)" : `hof #${i}`,
  x,
}));
snaps.push({ label: `gen ${ck.cma.gen} (current mean)`, x: ck.cma.mean });

type Field = "sims" | "vickrey-market" | "firstprice-market";
function evalField(x: number[], field: Field): { win: number; place: number; score: number } {
  const rng = new Rng(987654 + field.length);
  let win = 0;
  let place = 0;
  let score = 0;
  for (let g = 0; g < games; g++) {
    const seed = rng.u32();
    const opps =
      field === "sims"
        ? oppSeats.map((i) => new SimBot(SERVER_SIMS[i % SERVER_SIMS.length]!, seed + i))
        : oppSeats.map((i) => new MarketBot(market, seed + 17 * i));
    const seat = seed % players;
    const bots = [...opps];
    bots.splice(seat, 0, new EvoBot(decode(x), "me"));
    const r = playMatch(bots, dict, seed, field === "firstprice-market" ? "FirstPrice" : "Vickrey");
    const pf = placeFraction(r.scores, seat);
    place += pf;
    if (pf === 1) win++;
    score += r.scores[seat]!;
  }
  return { win: win / games, place: place / games, score: score / games };
}

const se = (p: number) => Math.sqrt((p * (1 - p)) / games);
console.log(`${games} games per cell; ±x is one standard error\n`);
console.log("snapshot                     vs market (Vickrey)        vs market (first-price)");
for (const s of snaps) {
  const v = evalField(s.x, "vickrey-market");
  const f = evalField(s.x, "firstprice-market");
  console.log(
    `${s.label.padEnd(28)} win ${(100 * v.win).toFixed(1)}% ±${(100 * se(v.win)).toFixed(1)} score ${v.score.toFixed(0).padStart(4)}` +
      `     win ${(100 * f.win).toFixed(1)}% ±${(100 * se(f.win)).toFixed(1)} score ${f.score.toFixed(0).padStart(4)}`,
  );
}
