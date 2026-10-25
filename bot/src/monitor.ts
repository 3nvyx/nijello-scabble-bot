// Live monitor for the deployed bot. Runs on the DGX next to it.
//
// Every 30 s, plain checks (these must be reliable, so no model involved):
//   - is our bot's credential connected on the server
//   - is its log still moving while a match runs
//   - errors in its log, coins left unspent, losing streaks
// After every finished match, a local LLM (Ollama on the GPU) reads the
// match record and writes a short diagnosis to runs/monitor/notes.md.
// The monitor never changes the bot; it reports.
//
//   node src/monitor.ts --bot Nijello [--model qwen3.5:27b] [--no-llm]

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { anonToken, type Row, some, sql, tag } from "./stdb.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}
const BOT = arg("bot", "Nijello");
const MODEL = arg("model", "qwen3.5:27b");
const OLLAMA = arg("ollama", "http://127.0.0.1:11434");
// --no-llm: plain checks only. Qwen generating on the GPU while training
// filled the CPU preceded both DGX freezes (01:50 and 02:23).
const LLM = !process.argv.includes("--no-llm");
const root = new URL("..", import.meta.url).pathname;
const OUT = `${root}runs/monitor`;
const LOG = `${root}live/${BOT}.log`;
mkdirSync(OUT, { recursive: true });

interface MatchSummary {
  match: number;
  place: number;
  players: number;
  score: number;
  topScore: number;
  winner: string;
  tiles: number;
  paid: number;
  coinsLeft: number;
  words: string[];
}

interface Status {
  updatedAt: string;
  bot: string;
  connected: boolean | null;
  logAgeSec: number | null;
  inMatch: number | null;
  record: { matches: number; wins: number; avgPlace: number; avgScore: number; last10Wins: number };
  recent: MatchSummary[];
  alerts: string[];
  llm: { model: string; available: boolean; lastMatch: number | null; note: string | null; at: string | null };
}

const state: Status = {
  updatedAt: "",
  bot: BOT,
  connected: null,
  logAgeSec: null,
  inMatch: null,
  record: { matches: 0, wins: 0, avgPlace: 0, avgScore: 0, last10Wins: 0 },
  recent: [],
  alerts: [],
  llm: { model: LLM ? MODEL : "off", available: false, lastMatch: null, note: null, at: null },
};
let reviewed = new Set<number>();
try {
  const prev = JSON.parse(readFileSync(`${OUT}/status.json`, "utf8")) as Status;
  state.llm = { ...prev.llm, model: LLM ? MODEL : "off" };
  reviewed = new Set(prev.recent.map((m) => m.match));
} catch {
  // First run.
}

function save(): void {
  state.updatedAt = new Date().toISOString();
  writeFileSync(`${OUT}/status.json.tmp`, JSON.stringify(state, null, 1));
  renameSync(`${OUT}/status.json.tmp`, `${OUT}/status.json`);
}

async function summarize(token: string, mid: number, botId: number, names: Map<number, string>): Promise<{ s: MatchSummary; detail: string }> {
  const [ps, results, words] = await Promise.all([
    sql(token, `SELECT * FROM match_participant WHERE match_id = ${mid}`),
    sql(token, `SELECT * FROM auction_result WHERE match_id = ${mid}`),
    sql(token, `SELECT * FROM word_play WHERE match_id = ${mid}`),
  ]);
  const me = ps.find((p) => Number(p.bot_id) === botId)!;
  const sorted = [...ps].sort((a, b) => Number(b.score) - Number(a.score));
  const won = results.filter((r) => some(r.winner_bot_id) === botId);
  const mine = words.filter((w) => Number(w.bot_id) === botId).map((w) => `${w.word}(+${w.total_reward})`);
  const s: MatchSummary = {
    match: mid,
    place: ps.filter((p) => Number(p.score) > Number(me.score)).length + 1,
    players: ps.length,
    score: Number(me.score),
    topScore: Number(sorted[0]!.score),
    winner: names.get(Number(sorted[0]!.bot_id)) ?? "?",
    tiles: won.length,
    paid: won.reduce((a, r) => a + Number(r.paid), 0),
    coinsLeft: Number(me.balance),
    words: mine,
  };
  const byBot = (id: number) =>
    words
      .filter((w) => Number(w.bot_id) === id)
      .map((w) => `${w.word}(+${w.total_reward})`)
      .join(" ");
  const ordered = [...results].sort((a, b) => Number(a.auction_id) - Number(b.auction_id));
  const detail = [
    `Final standings of match ${mid}:`,
    ...sorted.map(
      (p, i) =>
        `${i + 1}. ${names.get(Number(p.bot_id)) ?? "?"}${Number(p.bot_id) === botId ? " (US)" : ""}: score ${p.score}, coins left ${p.balance}, ` +
        `tiles bought ${results.filter((r) => some(r.winner_bot_id) === Number(p.bot_id)).length}, words: ${byBot(Number(p.bot_id)) || "none"}`,
    ),
    `Our purchases (round:letter:price): ${ordered
      .map((r, k) => (some(r.winner_bot_id) === botId ? `${k + 1}:${r.letter}:${r.paid}` : ""))
      .filter(Boolean)
      .join(" ")}`,
    `Prices every winner paid, in order: ${ordered.map((r) => `${r.letter}${r.paid}`).join(" ")}`,
  ].join("\n");
  return { s, detail };
}

async function askModel(prompt: string): Promise<string | null> {
  try {
    const r = await fetch(`${OLLAMA}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        think: false,
        // Keep the 17 GB model resident; a cold load takes about 33 s.
        keep_alive: "24h",
        options: { temperature: 0.2, num_ctx: 16384 },
        messages: [
          {
            role: "system",
            content:
              "You analyse matches of a sealed-bid letter-auction word game for the team that runs the bot marked (US). " +
              "Rules: 98 tiles, each auctioned for 1 s, second-price (winner pays the runner-up's bid). " +
              "Words score letter values x length multiplier (1x up to 3 letters, 1.5x at 4, 2x at 5, 2.5x at 6, 3x at 7+). " +
              "Rewards add to both score and coins; coins left at the end are worthless; the last tile can never be played. " +
              "Be concrete and short: at most 6 bullet points, each tied to numbers in the record. Do not invent data.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { message?: { content?: string } };
    return j.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

async function modelAvailable(): Promise<boolean> {
  try {
    const r = await fetch(`${OLLAMA}/api/tags`);
    const j = (await r.json()) as { models?: { name: string }[] };
    return (j.models ?? []).some((m) => m.name === MODEL || m.name === `${MODEL}:latest`);
  } catch {
    return false;
  }
}

async function tick(): Promise<void> {
  const alerts: string[] = [];
  const token = await anonToken();
  const [bots, creds, parts, matches] = await Promise.all([
    sql(token, "SELECT * FROM bot"),
    sql(token, "SELECT * FROM bot_credential"),
    sql(token, "SELECT * FROM match_participant"),
    sql(token, "SELECT * FROM match_state"),
  ]);
  const names = new Map(bots.map((b) => [Number(b.id), String(b.name)]));
  const bot = bots.find((b) => b.name === BOT);
  if (!bot) {
    state.alerts = [`bot '${BOT}' not found on the server`];
    save();
    return;
  }
  const botId = Number(bot.id);
  state.connected = creds.some((c) => Number(c.bot_id) === botId && Boolean(c.connected));
  if (!state.connected) alerts.push("OFFLINE: no connected credential for our bot. It loses every auction until it reconnects.");

  const status = new Map(matches.map((m) => [Number(m.id), tag(m.status)]));
  const mine = parts.filter((p) => Number(p.bot_id) === botId).map((p) => Number(p.match_id));
  const running = mine.filter((m) => status.get(m) === 1);
  state.inMatch = running[0] ?? null;
  state.logAgeSec = existsSync(LOG) ? Math.round((Date.now() - statSync(LOG).mtimeMs) / 1000) : null;
  if (state.inMatch !== null && (state.logAgeSec ?? 0) > 20)
    alerts.push(`STALLED: in match ${state.inMatch} but the bot log has not moved for ${state.logAgeSec} s.`);
  if (existsSync(LOG)) {
    const tail = readFileSync(LOG, "utf8").split("\n").slice(-300);
    const fails = tail.filter((l) => l.includes("failed")).length;
    if (fails > 5) alerts.push(`${fails} failed reducer calls in the last 300 log lines.`);
  }

  // Record over every finished match.
  const ended = mine.filter((m) => status.get(m) === 2).sort((a, b) => a - b);
  const byMatch = new Map<number, Row[]>();
  for (const p of parts) {
    const m = Number(p.match_id);
    if (!ended.includes(m)) continue;
    (byMatch.get(m) ?? byMatch.set(m, []).get(m)!).push(p);
  }
  const places = ended.map((m) => {
    const ps = byMatch.get(m)!;
    const me = ps.find((p) => Number(p.bot_id) === botId)!;
    return { m, place: ps.filter((p) => Number(p.score) > Number(me.score)).length + 1, score: Number(me.score) };
  });
  const n = places.length;
  state.record = {
    matches: n,
    wins: places.filter((p) => p.place === 1).length,
    avgPlace: n ? places.reduce((a, p) => a + p.place, 0) / n : 0,
    avgScore: n ? places.reduce((a, p) => a + p.score, 0) / n : 0,
    last10Wins: places.slice(-10).filter((p) => p.place === 1).length,
  };
  const last3 = places.slice(-3);
  if (last3.length === 3 && last3.every((p) => p.place > 1)) alerts.push("Three matches in a row without a win.");

  // Summaries (and an LLM review) for matches not seen yet, newest first.
  state.llm.available = LLM && (await modelAvailable());
  const fresh = ended.filter((m) => !reviewed.has(m)).slice(-5);
  for (const m of fresh) {
    const { s, detail } = await summarize(token, m, botId, names);
    state.recent = [...state.recent.filter((r) => r.match !== m), s].sort((a, b) => a.match - b.match).slice(-20);
    reviewed.add(m);
    if (s.coinsLeft > 25) alerts.push(`Match ${m}: finished with ${s.coinsLeft} coins unspent.`);
    if (state.llm.available) {
      const rec = state.recent
        .slice(-10)
        .map((r) => `match ${r.match}: place ${r.place}/${r.players}, score ${r.score} (top ${r.topScore} by ${r.winner}), tiles ${r.tiles}, coins left ${r.coinsLeft}`)
        .join("\n");
      const note = await askModel(
        `${detail}\n\nOur last matches:\n${rec}\n\nWhy did we finish where we did in match ${m}, and what single change to our bidding or word play would most likely have won it?`,
      );
      if (note) {
        state.llm.note = note;
        state.llm.lastMatch = m;
        state.llm.at = new Date().toISOString();
        appendFileSync(`${OUT}/notes.md`, `\n## Match ${m}: place ${s.place}/${s.players}, ${s.score} vs ${s.topScore}\n\n${note}\n`);
      }
    }
  }
  state.alerts = alerts;
  save();
  const r = state.record;
  console.log(
    `[${new Date().toTimeString().slice(0, 8)}] ${BOT} ${state.connected ? "online" : "OFFLINE"}` +
      `${state.inMatch !== null ? ` in match ${state.inMatch}` : ""} | ${r.matches} matches, ${r.wins} wins, ` +
      `avg place ${r.avgPlace.toFixed(2)} | model ${state.llm.available ? "ready" : "not loaded"}` +
      (alerts.length ? ` | ALERTS: ${alerts.join(" / ")}` : ""),
  );
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      await tick();
    } catch (e) {
      console.error("monitor tick failed:", e instanceof Error ? e.message : e);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

loop();
