// Pull the live server's public tables and summarise the real field:
// the leaderboard by the server's own rating (bot_stats), the field's
// recent winning bids by letter and phase (MarketBot), and per-bot models
// of the top-rated bots fitted on their recent matches only (TopBot), since
// teams keep changing their bots. Written to data/field.json.
//
//   node src/field.ts            fetch, print, write data/field.json
//   node src/field.ts --quiet    fetch and write only

import { writeFileSync } from "node:fs";
import { A_CODE } from "./rules.ts";
import { anonToken, some, sql, tag } from "./stdb.ts";

// How many top-rated bots get their own model, and how much recent
// history each model (and the field-wide bid pool) is fitted on.
const TOP_N = 25;
const MIN_MATCHES = 8;
const RECENT_PER_BOT = 40;
const RECENT_FIELD = 300;

export interface FieldModel {
  fetchedAt: string;
  matches: number;
  // bids[letter][phase] = sorted winning bids by real bots; phase 0 is the
  // first third of a match's auctions, 2 the last third.
  bids: number[][][];
  // Fraction of each real bot's bids that were placed at all is unknown
  // (losing bids are private), so only winning bids are modelled.
  leaderboard: {
    name: string;
    rating: number;
    provisional: boolean;
    matches: number;
    avgScore: number;
    avgPlace: number;
    winRate: number;
    realOpp: number;
  }[];
  // Per-bot models of the strongest real bots (see TopBot in opponents.ts).
  top: TopModel[];
}

export interface TopModel {
  name: string;
  rating: number;
  matches: number;
  avgScore: number;
  bids: number[][][]; // this bot's own winning bids, [letter][phase]
  auctionShare: number; // fraction of auctions in its matches that it won
  minLen: number; // shortest word it usually plays mid-game (20th pct)
  long7Share: number; // share of mid-game words with 7+ letters
  dumps: boolean; // plays leftovers in the last seconds of a match
}

async function main(): Promise<void> {
  const quiet = process.argv.includes("--quiet");
  const token = await anonToken();
  const [bots, matches, parts, results, tops, plays, stats] = await Promise.all([
    sql(token, "SELECT * FROM bot"),
    sql(token, "SELECT * FROM match_state"),
    sql(token, "SELECT * FROM match_participant"),
    sql(token, "SELECT * FROM auction_result"),
    sql(token, "SELECT * FROM auction_top_bid_archive"),
    sql(token, "SELECT * FROM word_play"),
    sql(token, "SELECT * FROM bot_stats"),
  ]);
  // The website's rating (src/pages/Leaderboard.tsx): OpenSkill mu on an
  // Elo-like scale, 1500 for a new bot. A bot with a +- above 175 is
  // provisional and listed below the ranked ones.
  const ELO_SCALE = 400 / (Math.LN10 * (25 / 6) * Math.SQRT2);
  const rating = new Map(stats.map((r) => [Number(r.bot_id), Math.round(1500 + ELO_SCALE * (Number(r.openskill_mu) - 25))]));
  const provisional = new Set(
    stats.filter((r) => ELO_SCALE * Number(r.openskill_sigma) > 175).map((r) => Number(r.bot_id)),
  );
  const isSim = new Map(bots.map((b) => [Number(b.id), Boolean(b.is_simulated)]));
  const name = new Map(bots.map((b) => [Number(b.id), String(b.name)]));
  const ended = new Set(matches.filter((m) => tag(m.status) === 2).map((m) => Number(m.id)));
  const real = (id: number) => isSim.get(id) === false;

  const byMatch = new Map<number, Row[]>();
  for (const p of parts) {
    const id = Number(p.match_id);
    if (!ended.has(id)) continue;
    (byMatch.get(id) ?? byMatch.set(id, []).get(id)!).push(p);
  }
  const agg = new Map<number, { n: number; score: number; place: number; win: number; realOpp: number }>();
  for (const ps of byMatch.values()) {
    const nReal = ps.filter((p) => real(Number(p.bot_id))).length;
    for (const p of ps) {
      const id = Number(p.bot_id);
      if (!real(id)) continue;
      const place = ps.filter((q) => Number(q.score) > Number(p.score)).length;
      const a = agg.get(id) ?? { n: 0, score: 0, place: 0, win: 0, realOpp: 0 };
      a.n++;
      a.score += Number(p.score);
      a.place += place + 1;
      a.win += place === 0 ? 1 : 0;
      a.realOpp += nReal - 1;
      agg.set(id, a);
    }
  }
  // Only bots that still exist (a dissolved team's bot is deleted and can't
  // enter the tournament), ranked like the website: by rating.
  const leaderboard = [...agg.entries()]
    .filter(([id, a]) => a.n >= 3 && name.has(id))
    .map(([id, a]) => ({
      name: name.get(id)!,
      rating: rating.get(id) ?? 0,
      provisional: provisional.has(id),
      matches: a.n,
      avgScore: a.score / a.n,
      avgPlace: a.place / a.n,
      winRate: a.win / a.n,
      realOpp: a.realOpp / a.n,
    }))
    .sort((x, y) => Number(x.provisional) - Number(y.provisional) || y.rating - x.rating);

  // Auction order within each match gives the phase.
  const topBid = new Map(tops.map((t) => [Number(t.auction_id), Number(t.top_bid)]));
  const perMatch = new Map<number, Row[]>();
  for (const r of results) {
    const id = Number(r.match_id);
    if (!ended.has(id)) continue;
    (perMatch.get(id) ?? perMatch.set(id, []).get(id)!).push(r);
  }
  const recentField = new Set([...perMatch.keys()].sort((a, b) => b - a).slice(0, RECENT_FIELD));
  const bids: number[][][] = Array.from({ length: 26 }, () => [[], [], []]);
  for (const [mid, rs] of perMatch) {
    if (!recentField.has(mid)) continue;
    rs.sort((a, b) => Number(a.auction_id) - Number(b.auction_id));
    rs.forEach((r, k) => {
      const w = some(r.winner_bot_id);
      const tb = topBid.get(Number(r.auction_id));
      if (w === undefined || !real(w) || tb === undefined) return;
      const phase = Math.min(2, Math.floor((3 * k) / rs.length));
      bids[String(r.letter).charCodeAt(0) - A_CODE]![phase]!.push(tb);
    });
  }
  for (const l of bids) for (const p of l) p.sort((a, b) => a - b);

  // Per-bot models for the top-rated real bots, from their recent matches.
  const endAt = new Map<number, number>();
  for (const m of matches) {
    const e = m.ended_at as [number, [number]];
    if (tag(m.status) === 2 && e[0] === 0) endAt.set(Number(m.id), Number(e[1][0]));
  }
  const nameToId = new Map([...name.entries()].map(([id, n]) => [n, id]));
  const top: TopModel[] = [];
  // Our own bot is on the leaderboard too; training against a model of it
  // would take a slot from a real competitor.
  const ourBot = process.env.OUR_BOT ?? "Nijello";
  for (const b of leaderboard.filter((x) => !x.provisional && x.matches >= MIN_MATCHES && x.name !== ourBot).slice(0, TOP_N)) {
    const id = nameToId.get(b.name)!;
    const recent = new Set(
      parts
        .filter((p) => Number(p.bot_id) === id && ended.has(Number(p.match_id)))
        .map((p) => Number(p.match_id))
        .sort((x, y) => y - x)
        .slice(0, RECENT_PER_BOT),
    );
    const own: number[][][] = Array.from({ length: 26 }, () => [[], [], []]);
    let won = 0;
    let total = 0;
    for (const [mid, rs] of perMatch) {
      if (!recent.has(mid)) continue;
      total += rs.length;
      rs.forEach((r, k) => {
        if (some(r.winner_bot_id) !== id) return;
        won++;
        const tb = topBid.get(Number(r.auction_id));
        if (tb === undefined) return;
        const phase = Math.min(2, Math.floor((3 * k) / rs.length));
        own[String(r.letter).charCodeAt(0) - A_CODE]![phase]!.push(tb);
      });
    }
    for (const l of own) for (const p of l) p.sort((x, y) => x - y);
    const mid: number[] = [];
    let late = 0;
    for (const w of plays) {
      if (Number(w.bot_id) !== id || !recent.has(Number(w.match_id))) continue;
      const end = endAt.get(Number(w.match_id));
      if (end === undefined) continue;
      const at = Number((w.played_at as [number])[0]);
      if (end - at < 3_000_000) late++;
      else mid.push(String(w.word).length);
    }
    mid.sort((x, y) => x - y);
    top.push({
      name: b.name,
      rating: b.rating,
      matches: b.matches,
      avgScore: b.avgScore,
      bids: own,
      auctionShare: total ? won / total : 0,
      minLen: mid.length ? Math.max(2, mid[Math.floor(mid.length * 0.2)]!) : 7,
      long7Share: mid.length ? mid.filter((l) => l >= 7).length / mid.length : 0,
      dumps: late > recent.size * 0.3,
    });
  }

  const model: FieldModel = {
    fetchedAt: new Date().toISOString(),
    matches: ended.size,
    bids,
    leaderboard,
    top,
  };
  writeFileSync(new URL("../data/field.json", import.meta.url), JSON.stringify(model));
  if (quiet) return;
  console.log(`${ended.size} ended matches, ${leaderboard.length} real bots with 3+ matches\n`);
  console.log("bot                    rating  matches  avgScore  avgPlace  win%  realOpp");
  for (const b of leaderboard)
    console.log(
      `${b.name.slice(0, 22).padEnd(22)} ${(String(b.rating) + (b.provisional ? "?" : "")).padStart(6)} ${String(b.matches).padStart(8)} ${b.avgScore.toFixed(1).padStart(9)} ` +
        `${b.avgPlace.toFixed(2).padStart(9)} ${(100 * b.winRate).toFixed(0).padStart(5)} ${b.realOpp.toFixed(1).padStart(8)}`,
    );
  const med = (xs: number[]) => (xs.length ? xs[xs.length >> 1]! : NaN);
  console.log("\nper-bot models:");
  for (const t of top)
    console.log(
      `  ${t.name.padEnd(16)} rating ${t.rating}, wins ${(100 * t.auctionShare).toFixed(0)}% of auctions, plays ${t.minLen}+ letter words ` +
        `(${(100 * t.long7Share).toFixed(0)}% are 7+), ${t.dumps ? "dumps leftovers at the end" : "no end dump"}`,
    );
  console.log("\nmedian winning bid by real bots, early / mid / late:");
  console.log(
    bids
      .map((l, c) => `${String.fromCharCode(A_CODE + c)} ${l.map((p) => med(p)).join("/")}`)
      .join("  "),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
