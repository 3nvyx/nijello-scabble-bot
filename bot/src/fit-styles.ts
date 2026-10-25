// Fits each live bot's word-play style (src/style.ts) so its simulated
// matches look like its live ones: score, letters won, words played, word
// length and the share of points scored in the last third of the auctions.
// For every candidate style, the bot's recent live matches are replayed with
// it in its real seat and everyone else as currently modelled; the candidate
// with the smallest weighted error wins. Run in shards, then merge:
//
//   node src/fit-styles.ts --shard 3/12 [--matches 30] [--prev data/styles.json]
//   node src/fit-styles.ts --merge 12            writes data/styles.json
//
// Only matches whose id is not held out (src/fidelity.ts) are used.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { Dictionary } from "./dict.ts";
import { type Bot, playMatch } from "./game.ts";
import { type BidProfile, loadMarket, setProfileShift } from "./opponents.ts";
import type { LiveMatch } from "./profile.ts";
import { decode, EvoBot, jsonToX } from "./strategy.ts";
import { isHeldOut, liveFacts, type Replay, seatBot, type SeatFacts, playedParams } from "./fidelity.ts";
import { loadStyles, StyledBot, type WordStyle } from "./style.ts";

const root = new URL("..", import.meta.url).pathname;
const OUR_BOT = process.env.OUR_BOT ?? "Nijello";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}

// Weighted squared error between simulated and live per-match facts.
function loss(sim: SeatFacts[], live: SeatFacts[]): number {
  const m = (xs: SeatFacts[], f: (s: SeatFacts) => number) => xs.reduce((a, s) => a + f(s), 0) / Math.max(1, xs.length);
  const share = (xs: SeatFacts[]) => m(xs, (s) => s.late) / Math.max(1, m(xs, (s) => s.score));
  const len = (xs: SeatFacts[]) => m(xs, (s) => s.wordLen) / Math.max(0.1, m(xs, (s) => s.words));
  return (
    ((m(sim, (s) => s.score) - m(live, (s) => s.score)) / 8) ** 2 +
    ((m(sim, (s) => s.tiles) - m(live, (s) => s.tiles)) / 1.5) ** 2 +
    ((m(sim, (s) => s.words) - m(live, (s) => s.words)) / 0.4) ** 2 +
    ((len(sim) - len(live)) / 0.4) ** 2 +
    ((share(sim) - share(live)) / 0.1) ** 2
  );
}

function candidates(shortLen: number): Omit<WordStyle, "name">[] {
  const out: Omit<WordStyle, "name">[] = [];
  for (const minLen of [5, 6, 7, 8])
    for (const cashFloor of [0, 15, 40])
      for (const cashLen of [4, 5])
        for (const shortRate of [0, 0.02, 0.06])
          if (!(cashFloor === 0 && cashLen === 5)) out.push({ minLen, cashFloor, cashLen, shortRate, shortLen });
  return out;
}

function main(): void {
  const live = (JSON.parse(readFileSync(`${root}data/live.json`, "utf8")) as { matches: LiveMatch[] }).matches.filter((m) => !isHeldOut(m.id));
  const pj = JSON.parse(readFileSync(`${root}data/profiles.json`, "utf8")) as { bots: BidProfile[]; shift?: number[]; spread?: number[]; letterShift?: number[] };
  setProfileShift(pj.shift ?? [0, 0, 0], pj.spread ?? [1, 1, 1], pj.letterShift);
  const prevPath = arg("prev", "");
  const r: Replay = {
    ours: [],
    played: playedParams(),
    profs: new Map(pj.bots.map((p) => [p.name, p])),
    styles: prevPath ? loadStyles(`${root}${prevPath}`) : new Map(),
    market: loadMarket(`${root}data/field.json`),
    dict: Dictionary.load(`${root}data/wordlist.txt`),
  };
  const ourDefault = decode(jsonToX(JSON.parse(readFileSync(`${root}runs/live/params.json`, "utf8")).params));
  const [shard, shards] = arg("shard", "0/1").split("/").map(Number) as [number, number];
  const perBot = Number(arg("matches", "30"));
  const names = pj.bots.map((b) => b.name).filter((_, i) => i % shards === shard);
  const out: (WordStyle & { loss: number; matches: number; live: Record<string, number> })[] = [];

  for (const name of names) {
    const prof = r.profs.get(name)!;
    const mine = live.filter((m) => m.players.some((p) => p.name === name)).slice(-perBot);
    if (mine.length < 8) continue;
    const liveF = mine.map((m) => liveFacts(m).find((f) => f.name === name)!);
    // Most common short word length it plays.
    const lens = new Map<number, number>();
    for (const m of mine) for (const w of m.words) if (m.players.find((p) => p.id === w.bot)?.name === name && w.word.length <= 4) lens.set(w.word.length, (lens.get(w.word.length) ?? 0) + 1);
    const shortLen = [...lens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 3;

    let best: { style: WordStyle; loss: number } | null = null;
    for (const c of candidates(shortLen)) {
      const style: WordStyle = { name, ...c };
      const sim: SeatFacts[] = [];
      for (const m of mine) {
        const seat = m.players.findIndex((p) => p.name === name);
        const seed = (Math.imul(m.id, 2654435761) ^ 0x9e3779b9) >>> 0;
        const words = m.players.map(() => ({ words: 0, len: 0, late: 0 }));
        const n = 98 - 5 * m.players.length;
        let round = 0;
        const bots: Bot[] = m.players.map((pl, k) => {
          let b: Bot;
          if (k === seat) b = new StyledBot(prof, style, seed + 7919 * k);
          else if (pl.name === OUR_BOT) b = new EvoBot(r.played.get(m.id)?.p ?? ourDefault, "us");
          else b = seatBot(r, pl, seed + 7919 * k);
          if (k !== 0) return b;
          // Seat 0 also counts everyone's words (they reach every bot).
          return {
            name: b.name,
            serverSide: b.serverSide,
            onStart: (s, np, rack, d) => b.onStart(s, np, rack, d),
            onAuction: (v) => {
              round = v.round;
              return b.onAuction(v);
            },
            onResult: (v, l, w, p) => b.onResult(v, l, w, p),
            onWord: (s, w) => {
              words[s]!.words++;
              words[s]!.len += w.length;
              if (round > (2 * n) / 3) words[s]!.late += r.dict.reward[r.dict.indexOf(w)]!;
              b.onWord?.(s, w);
            },
          };
        });
        const res = playMatch(bots, r.dict, seed, "Vickrey");
        sim.push({ name, score: res.scores[seat]!, tiles: res.tilesWon[seat]!, words: words[seat]!.words, wordLen: words[seat]!.len, late: words[seat]!.late });
      }
      const l = loss(sim, liveF);
      if (!best || l < best.loss) best = { style, loss: l };
    }
    const avg = (f: (s: SeatFacts) => number) => liveF.reduce((a, s) => a + f(s), 0) / liveF.length;
    out.push({
      ...best!.style,
      loss: best!.loss,
      matches: mine.length,
      live: { score: avg((s) => s.score), tiles: avg((s) => s.tiles), words: avg((s) => s.words), late: avg((s) => s.late) },
    });
    console.log(`${name.slice(0, 18).padEnd(18)} minLen ${best!.style.minLen} cash<${best!.style.cashFloor}:${best!.style.cashLen}+ short ${best!.style.shortRate}@${shortLen}+  loss ${best!.loss.toFixed(2)}`);
  }
  writeFileSync(`${root}data/styles.part${shard}.json`, JSON.stringify(out));
}

function merge(): void {
  const k = Number(arg("merge", "1"));
  const styles = [];
  for (let i = 0; i < k; i++) styles.push(...JSON.parse(readFileSync(`${root}data/styles.part${i}.json`, "utf8")));
  writeFileSync(`${root}data/styles.json.tmp`, JSON.stringify({ fittedAt: new Date().toISOString(), styles }));
  renameSync(`${root}data/styles.json.tmp`, `${root}data/styles.json`);
  console.log(`merged ${styles.length} styles into data/styles.json`);
}

if (import.meta.main) {
  if (process.argv.includes("--merge")) merge();
  else main();
}
