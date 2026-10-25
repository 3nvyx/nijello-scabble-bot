// Calibrates the field models against the live server. Seats our current
// best bot with 5 field models (the training mix), records the highest
// opposing bid in every auction, and compares it with the live top bids
// (data/field.json) by game phase. Writes per-phase multipliers to
// data/calibration.json, which MarketBot and TopBot apply to their bids.
//
//   node src/calibrate.ts [games] [rounds]     (rounds of fit, default 3)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Dictionary } from "./dict.ts";
import { type Action, type Bot, playMatch, type View } from "./game.ts";
import { loadMarket, MarketBot, setCalibration, TopBot } from "./opponents.ts";
import { Rng } from "./rng.ts";
import { decode, EvoBot, jsonToX } from "./strategy.ts";

const root = new URL("..", import.meta.url).pathname;
const dict = Dictionary.load(`${root}data/wordlist.txt`);
const market = loadMarket(`${root}data/field.json`);
if (!market?.top?.length) throw new Error("run node src/field.ts first");
const games = Number(process.argv[2] ?? 600);
const rounds = Number(process.argv[3] ?? 3);
const bestPath = `${root}runs/main/best.json`;
const x = existsSync(bestPath) ? jsonToX(JSON.parse(readFileSync(bestPath, "utf8")).params) : new Float64Array(0);

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))]! : NaN;
};

// One pass: returns the max opposing bid per phase, and our tiles/score.
function measure(scale: number[]): { maxOpp: number[][]; tiles: number; score: number; win: number } {
  setCalibration(scale);
  const maxOpp: number[][] = [[], [], []];
  const rng = new Rng(4242);
  let tiles = 0;
  let score = 0;
  let win = 0;
  for (let g = 0; g < games; g++) {
    const seed = rng.u32();
    const top = rng.float() < 2 / 3;
    const opps: Bot[] = [0, 1, 2, 3, 4].map((i) =>
      top
        ? new TopBot(market!.top![rng.int(0, market!.top!.length - 1)]!, market!, seed + 31 * i)
        : new MarketBot(market!, seed + 31 * i),
    );
    const bids = new Map<number, number>();
    const spied = opps.map((b): Bot => ({
      name: b.name,
      onStart: (s, n, r, d) => b.onStart(s, n, r, d),
      onResult: (v, l, w, p) => b.onResult(v, l, w, p),
      onWord: (s, w) => b.onWord?.(s, w),
      onAuction: (v: View): Action => {
        const a = b.onAuction(v);
        bids.set(v.round, Math.max(bids.get(v.round) ?? 0, a.bid));
        return a;
      },
    }));
    const me = new EvoBot(decode(x), "me");
    const bots = [me, ...spied];
    const r = playMatch(bots, dict, seed);
    const n = 68;
    for (const [round, b] of bids) if (b > 0) maxOpp[Math.min(2, Math.floor((3 * (round - 1)) / n))]!.push(b);
    tiles += r.tilesWon[0]!;
    score += r.scores[0]!;
    if (r.scores[0]! >= Math.max(...r.scores)) win++;
  }
  return { maxOpp, tiles: tiles / games, score: score / games, win: win / games };
}

const live = [0, 1, 2].map((ph) => market.bids.flatMap((l) => l[ph]!));
let scale = [1, 1, 1];
for (let k = 0; k <= rounds; k++) {
  const m = measure(scale);
  const line = [0, 1, 2]
    .map((ph) => `${["early", "mid", "late"][ph]} sim ${quantile(m.maxOpp[ph]!, 0.5)}/${quantile(m.maxOpp[ph]!, 0.8)} live ${quantile(live[ph]!, 0.5)}/${quantile(live[ph]!, 0.8)}`)
    .join("  ");
  console.log(`scale ${scale.map((s) => s.toFixed(2)).join("/")}: ours win ${(100 * m.win).toFixed(0)}% tiles ${m.tiles.toFixed(1)} score ${m.score.toFixed(0)} | median/p80 max opposing bid: ${line}`);
  if (k === rounds) break;
  // Match the mean of the median and the 80th percentile.
  scale = scale.map((s, ph) => {
    const simQ = (quantile(m.maxOpp[ph]!, 0.5) + quantile(m.maxOpp[ph]!, 0.8)) / 2;
    const liveQ = (quantile(live[ph]!, 0.5) + quantile(live[ph]!, 0.8)) / 2;
    return simQ > 0 ? s * (liveQ / simQ) : s;
  });
}
writeFileSync(`${root}data/calibration.json`, JSON.stringify({ phaseScale: scale, fittedAt: new Date().toISOString() }));
console.log(`wrote data/calibration.json: ${scale.map((s) => s.toFixed(3)).join(", ")}`);
