// Live viewer for scrabblebot-evo. Plays one showcase match at a time with
// the strategy the live bot plays and streams it to browsers at watching
// speed over Server-Sent Events, next to the active training run's stats.
// It only reads the training project (code, data, run files) and never
// writes to it.
//
//   nice -n 19 node server.ts --host <gx10-tailscale-ip> --port 8090            follow the active run
//   nice -n 19 node server.ts --host <gx10-tailscale-ip> --run ../scrabblebot-evo/runs/v5-profiles

import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Dictionary, type Rack, rackToString } from "../scrabblebot-evo/src/dict.ts";
import { type Action, type Bot, playMatch, type View } from "../scrabblebot-evo/src/game.ts";
import { loadMarket, type MarketBids, MarketBot, SERVER_SIMS, SimBot, StarterBot, TopBot } from "../scrabblebot-evo/src/opponents.ts";
import { Rng } from "../scrabblebot-evo/src/rng.ts";
import { type AuctionType, LOBBY_MAX_SIZE } from "../scrabblebot-evo/src/rules.ts";
import { decode, EvoBot, jsonToX } from "../scrabblebot-evo/src/strategy.ts";
import { latencyStats, peakAge } from "../scrabblebot-evo/src/latency.ts";

function arg(name: string, def: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : def;
}
const HOST = arg("host", "127.0.0.1");
const PORT = Number(arg("port", "8090"));
const EVO = fileURLToPath(new URL("../scrabblebot-evo/", import.meta.url));
// Experimental copy of the project; its training runs are followed too.
const NEXT = fileURLToPath(new URL("../scrabblebot-next/", import.meta.url));
// "auto" (default) follows whichever training run is active; or a fixed
// run directory.
const RUN_ARG = arg("run", "auto");
// The params the live bot plays; ops/release.sh replaces it only with a
// candidate that beat it on replays of our real matches.
const LIVE_PARAMS = `${EVO}runs/live/params.json`;
// 1 = normal pace; 2 = twice as fast.
const SPEED = Math.max(0.1, Number(arg("speed", "1")));
const PAGE = fileURLToPath(new URL("./index.html", import.meta.url));
// A client that stops reading is dropped once this much is queued for it.
const MAX_BUFFERED = 1 << 20;
// Points kept per chart series.
const CHART_POINTS = 200;

const dict = Dictionary.load(`${EVO}data/wordlist.txt`);
// The training run's own field data, top-bot models included. It is
// refreshed from the live server every 15 minutes and written in place, so
// a read that lands mid-write keeps the previous copy.
type Field = MarketBids & { leaderboard?: { name: string; winRate: number }[] };
let market = loadMarket(`${EVO}data/field.json`) as Field | null;

// ---- recording a match ----

interface Player {
  name: string;
  kind: "evo" | "top" | "field" | "sim" | "starter" | "gen0";
  detail: string;
}

interface Snapshot {
  racks: string[];
  balances: number[];
  scores: number[];
}

type Step =
  | { type: "deal" }
  | { type: "word"; seat: number; word: string; reward: number; phase: "open" | "pre" | "post" }
  | { type: "auction"; round: number; letter: number; bagLeft: number }
  | { type: "bids"; bids: (number | null)[] }
  | { type: "result"; letter: number; winner: number; paid: number }
  | { type: "end"; scores: number[]; places: number[] };

type Event = Step & { state: Snapshot };

interface Match {
  id: number;
  gen: number;
  source: Source;
  auctionType: AuctionType;
  spotlight: number;
  players: Player[];
  events: Event[];
}

// Mirrors the engine's bookkeeping from the hooks every bot gets, so each
// step can carry the full table state. Checked against the engine's final
// scores at the end of every match.
class Recorder {
  readonly events: Event[] = [];
  readonly n: number;
  readonly racks: Rack[];
  readonly balances: number[];
  readonly scores: number[];
  readonly bids: (number | null)[];
  private phase: "open" | "pre" | "post" = "open";
  private dealt = 0;

  constructor(n: number) {
    this.n = n;
    this.racks = Array.from({ length: n }, () => new Int32Array(26));
    this.balances = new Array<number>(n).fill(100);
    this.scores = new Array<number>(n).fill(0);
    this.bids = new Array<number | null>(n).fill(null);
  }

  private push(step: Step): void {
    this.events.push({
      ...step,
      state: {
        racks: this.racks.map(rackToString),
        balances: [...this.balances],
        scores: [...this.scores],
      },
    });
  }

  dealt1(seat: number, rack: Rack): void {
    this.racks[seat]!.set(rack);
    if (++this.dealt === this.n) this.push({ type: "deal" });
  }

  auctionOpen(v: View): void {
    this.phase = "pre";
    this.bids.fill(null);
    this.push({ type: "auction", round: v.round, letter: v.letter, bagLeft: v.bagLeft });
  }

  bid(seat: number, amount: number): void {
    this.bids[seat] = amount;
  }

  // submit_bid drops bids <= 0 and above the bidder's balance; a seat's
  // balance can't change between its bid and the close.
  auctionClosed(letter: number, winner: number, paid: number): void {
    this.push({
      type: "bids",
      bids: this.bids.map((b, s) => (b !== null && b > 0 && b <= this.balances[s]! ? b : null)),
    });
    if (winner >= 0) {
      this.balances[winner]! -= paid;
      this.racks[winner]![letter]!++;
    }
    this.phase = "post";
    this.push({ type: "result", letter, winner, paid });
  }

  word(seat: number, word: string): void {
    const reward = dict.reward[dict.indexOf(word)]!;
    const r = this.racks[seat]!;
    for (let i = 0; i < word.length; i++) r[word.charCodeAt(i) - 65]!--;
    this.balances[seat]! += reward;
    this.scores[seat]! += reward;
    this.push({ type: "word", seat, word, reward, phase: this.phase });
  }

  end(scores: number[]): void {
    const places = scores.map((s) => 1 + scores.filter((o) => o > s).length);
    this.push({ type: "end", scores, places });
  }
}

// Passes every call through to the real bot and reports what happened.
// Word events reach every bot, so only seat 0's wrapper records them.
class Observed implements Bot {
  readonly name: string;
  readonly serverSide?: boolean;
  private readonly inner: Bot;
  private readonly seat: number;
  private readonly rec: Recorder;

  constructor(inner: Bot, seat: number, rec: Recorder) {
    this.inner = inner;
    this.seat = seat;
    this.rec = rec;
    this.name = inner.name;
    this.serverSide = inner.serverSide;
  }

  onStart(seat: number, n: number, rack: Rack, d: Dictionary): string[] {
    this.rec.dealt1(seat, rack);
    return this.inner.onStart(seat, n, rack, d);
  }

  onAuction(v: View): Action {
    if (this.seat === 0) this.rec.auctionOpen(v);
    const act = this.inner.onAuction(v);
    this.rec.bid(this.seat, Math.floor(act.bid));
    return act;
  }

  onResult(v: View, letter: number, winner: number, paid: number): string[] {
    if (this.seat === 0) this.rec.auctionClosed(letter, winner, paid);
    return this.inner.onResult(v, letter, winner, paid);
  }

  onWord(seat: number, word: string): void {
    if (this.seat === 0) this.rec.word(seat, word);
    this.inner.onWord?.(seat, word);
  }
}

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---- which run ----

interface ActiveRun {
  dir: string;
  running: boolean; // a train.ts process is writing to it
}

// Output directories of running train.ts processes under this project's
// runs/ (or scrabblebot-next's), oldest process first, from /proc (Linux). Oldest first so a short
// side experiment doesn't take over from the main run.
function trainerOuts(): string[] {
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {
    return [];
  }
  const found: { dir: string; started: number }[] = [];
  for (const pid of pids) {
    try {
      const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      // The node process itself, not a shell wrapper that mentions train.ts.
      if (!/(^|\/)node$/.test(argv[0] ?? "") || !argv.some((a) => a.endsWith("src/train.ts"))) continue;
      const i = argv.indexOf("--out");
      const dir = resolve(readlinkSync(`/proc/${pid}/cwd`), i >= 0 && argv[i + 1] ? argv[i + 1]! : "runs/main");
      if (!dir.startsWith(`${EVO}runs/`) && !dir.startsWith(`${NEXT}runs/`)) continue;
      // Field 22 of /proc/<pid>/stat, counted after the ")" closing the name.
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const started = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
      found.push({ dir, started });
    } catch {
      // process exited or isn't ours
    }
  }
  return found.sort((a, b) => a.started - b.started).map((f) => f.dir);
}

const statusMtime = (dir: string): number => {
  try {
    return statSync(join(dir, "status.json")).mtimeMs;
  } catch {
    return -1;
  }
};

// The run a train.ts process is writing to; with none running, the run
// whose status.json changed last. Only training runs count: they have a
// generation history (runs/monitor writes a different status.json).
function findActiveRun(): ActiveRun | null {
  const outs = trainerOuts();
  if (RUN_ARG !== "auto") {
    const dir = resolve(RUN_ARG);
    return { dir, running: outs.includes(dir) };
  }
  const byAge = (dirs: string[]) => dirs.filter((d) => statusMtime(d) >= 0).sort((a, b) => statusMtime(b) - statusMtime(a));
  if (outs.length) return { dir: outs[0]!, running: true };
  let dirs: string[] = [];
  try {
    dirs = readdirSync(`${EVO}runs`).map((d) => join(`${EVO}runs`, d));
  } catch {
    return null;
  }
  for (const dir of byAge(dirs)) if (Array.isArray(readJson(join(dir, "status.json"))?.history)) return { dir, running: false };
  return null;
}

let activeRunCache: ActiveRun | null = null;
let activeRunAt = 0;
function activeRun(): ActiveRun | null {
  if (Date.now() - activeRunAt > 30_000) {
    const next = findActiveRun();
    if (next?.dir !== activeRunCache?.dir) console.log(`training run: ${next ? `${next.dir}${next.running ? "" : " (not running)"}` : "none found"}`);
    activeRunCache = next;
    activeRunAt = Date.now();
  }
  return activeRunCache;
}

type Source = "live" | "training" | "defaults";

// What Nijello plays live; before the first release, the active run's best.
function currentBest(): { gen: number; x: Float64Array; source: Source } {
  const live = readJson(LIVE_PARAMS);
  if (live?.params) return { gen: Number(live.gen) || 0, x: jsonToX(live.params), source: "live" };
  const run = activeRun();
  const best = run ? readJson(join(run.dir, "best.json")) : null;
  if (best?.params) return { gen: Number(best.gen) || 0, x: jsonToX(best.params), source: "training" };
  return { gen: 0, x: new Float64Array(0), source: "defaults" };
}

let matchCount = 0;
const seedRng = new Rng((Date.now() ^ (process.pid << 8)) >>> 0);

// Half the seats go to the training run's models of named top bots (when
// field.json has them); the rest are its other opponent types.
function newMatch(): Match {
  market = (loadMarket(`${EVO}data/field.json`) as Field | null) ?? market;
  const seed = seedRng.u32();
  // Separate stream from the engine's, which is seeded with `seed` itself.
  const rng = new Rng(seed ^ 0x5bd1e995);
  const n = LOBBY_MAX_SIZE;
  const { gen, x, source } = currentBest();
  const auctionType: AuctionType = rng.float() < 0.8 ? "Vickrey" : "FirstPrice";

  const players: Player[] = [];
  const bots: Bot[] = [];
  const counts: Record<string, number> = {};
  const label = (base: string) => {
    counts[base] = (counts[base] ?? 0) + 1;
    return counts[base] === 1 ? base : `${base} ${counts[base]}`;
  };
  const topLeft = [...(market?.top ?? [])];
  rng.shuffle(topLeft);
  for (let k = 0; k < n - 1; k++) {
    const r = rng.float();
    if (market && topLeft.length && r < 0.5) {
      const m = topLeft.pop()!;
      const real = market.leaderboard?.find((b) => b.name === m.name);
      bots.push(new TopBot(m, market, seed + 130363 * (k + 1)));
      players.push({
        name: m.name,
        kind: "top",
        detail: real ? `model of a top bot · real win rate ${Math.round(100 * real.winRate)}%` : "model of a top live bot",
      });
    } else if (market && r < 0.7) {
      bots.push(new MarketBot(market, seed + 104729 * (k + 1)));
      players.push({ name: label("Field model"), kind: "field", detail: "bids like the average real bot" });
    } else if (r < 0.82) {
      const strat = SERVER_SIMS[rng.int(0, SERVER_SIMS.length - 1)]!;
      bots.push(new SimBot(strat, seed + 7919 * (k + 1)));
      players.push({ name: label(`Sim ${strat}`), kind: "sim", detail: "server lobby filler" });
    } else if (r < 0.91) {
      bots.push(new StarterBot());
      players.push({ name: label("Starter kit"), kind: "starter", detail: "untuned default bot" });
    } else {
      bots.push(new EvoBot(decode(new Float64Array(0)), "gen0"));
      players.push({ name: label("Gen-0 bot"), kind: "gen0", detail: "our bot before training" });
    }
  }
  const spotlight = rng.int(0, n - 1);
  bots.splice(spotlight, 0, new EvoBot(decode(x), "evo"));
  const detail =
    source === "live" ? `our bot · live strategy (generation ${gen})`
    : source === "training" ? `our bot · best from training (generation ${gen})`
    : "our bot · default strategy, no training yet";
  players.splice(spotlight, 0, { name: "Nijello", kind: "evo", detail });

  const rec = new Recorder(n);
  const res = playMatch(bots.map((b, s) => new Observed(b, s, rec)), dict, seed, auctionType);
  if (res.scores.some((s, i) => s !== rec.scores[i]))
    console.warn(`match ${matchCount + 1}: mirrored scores ${rec.scores} differ from engine ${res.scores}`);
  rec.end(res.scores);
  return { id: ++matchCount, gen, source, auctionType, spotlight, players, events: rec.events };
}

// ---- pacing and broadcast ----

const DELAY: Record<Step["type"], number> = {
  deal: 2500,
  word: 1100,
  auction: 700,
  bids: 900,
  result: 1100,
  end: 9000,
};

const clients = new Set<ServerResponse>();
let match: Match | null = null;
let shown = 0;
const recent: { id: number; gen: number; place: number; score: number; best: number; n: number }[] = [];

function write(c: ServerResponse, chunk: string): void {
  if (c.destroyed || c.writableLength > MAX_BUFFERED) {
    clients.delete(c);
    c.destroy();
    return;
  }
  c.write(chunk);
}
function send(c: ServerResponse, msg: unknown): void {
  write(c, `data: ${JSON.stringify(msg)}\n\n`);
}
function broadcast(msg: unknown): void {
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  for (const c of clients) write(c, line);
}

function matchHeader(m: Match) {
  return { type: "match", id: m.id, gen: m.gen, source: m.source, auctionType: m.auctionType, spotlight: m.spotlight, players: m.players };
}

function tick(): void {
  try {
    if (!match || shown >= match.events.length) {
      match = newMatch();
      shown = 0;
      broadcast(matchHeader(match));
    }
    const ev = match.events[shown++]!;
    broadcast({ type: "step", ev });
    if (ev.type === "end") {
      const sp = match.spotlight;
      recent.unshift({
        id: match.id,
        gen: match.gen,
        place: ev.places[sp]!,
        score: ev.scores[sp]!,
        best: Math.max(...ev.scores.filter((_, i) => i !== sp)),
        n: ev.scores.length,
      });
      recent.length = Math.min(recent.length, 20);
      broadcast({ type: "recent", recent });
    }
    setTimeout(tick, DELAY[ev.type] / SPEED);
  } catch (e) {
    console.error("match failed", e);
    match = null;
    setTimeout(tick, 5000);
  }
}

// Evenly spaced sample of at most `k` points, always keeping the last.
function thin<T>(xs: T[], k: number): T[] {
  if (xs.length <= k) return xs;
  const out: T[] = [];
  for (let i = 0; i < k; i++) out.push(xs[Math.round((i * (xs.length - 1)) / (k - 1))]!);
  return out;
}

// Training status, trimmed to what the page draws. Re-sent only when the
// run writes a new status.json; `now` lets the page tell a stopped run from
// a slow one without trusting the viewer's clock.
let status: Record<string, unknown> | null = null;
let statusStamp = "";
function readStatus(): void {
  try {
    const run = activeRun();
    if (!run) return;
    const st = readJson(join(run.dir, "status.json"));
    // A switch to another run, or a new write to this one.
    const stamp = `${run.dir} ${run.running} ${st?.updatedAt}`;
    if (stamp === statusStamp) return;
    statusStamp = stamp;
    if (!st) {
      // A run that hasn't finished its first generation yet.
      status = {
        type: "status",
        run: basename(run.dir),
        running: run.running,
        starting: true,
        gen: 0,
        totalGames: 0,
        gamesPerSec: 0,
        deadline: null,
        updatedAt: new Date().toISOString(),
        finished: false,
        bench: [],
        perBot: [],
        lastGenMs: null,
      };
      broadcast({ ...status, now: new Date().toISOString() });
      return;
    }
    const history = Array.isArray(st.history) ? st.history : [];
    const bench = Array.isArray(st.bench) ? st.bench : [];
    status = {
      type: "status",
      run: basename(run.dir),
      running: run.running,
      gen: Number(st.gen) || 0,
      totalGames: Number(st.totalGames) || 0,
      gamesPerSec: Number(st.gamesPerSec) || 0,
      deadline: st.deadline,
      updatedAt: st.updatedAt,
      finished: !!st.finished,
      bench: thin(
        bench.map((b: any) => ({
          gen: Number(b?.gen) || 0,
          vsTop: b?.vsTop?.win ?? null,
          vsField: b?.vsMarket?.win ?? null,
          vsGen0: b?.vsDefault?.win ?? null,
          vsSims: b?.vsSims?.win ?? null,
          vsStarter: b?.vsStarter?.win ?? null,
          vsLeague: b?.vsLeague?.win ?? null,
        })),
        CHART_POINTS,
      ),
      perBot: (Array.isArray(bench.at(-1)?.perBot) ? bench.at(-1).perBot : []).map((p: any) => ({
        name: String(p?.name ?? "?"),
        win: Number(p?.win) || 0,
      })),
      lastGenMs: history.length > 1 ? Number(history.at(-1)?.t) - Number(history.at(-2)?.t) : null,
      // Training time since the confirmed peak, and the live bot's decision
      // times (refreshed with each generation's status).
      peak: peakAge(st),
      latency: latencyStats(`${EVO}live/${ARENA_BOT}.log`),
    };
    broadcast({ ...status, now: new Date().toISOString() });
  } catch (e) {
    console.error("status read failed", e);
  }
}

// ---- live arena ----
// Our bot's real matches on the official server, read through its public
// SQL API with an anonymous identity (the same read-only access the
// project's field.ts uses). Finished matches never change, so each is
// fetched once; the rating is logged after every match so the page can
// draw its history.

const ARENA_URL = "https://maincloud.spacetimedb.com";
const ARENA_DB = arg("arena-db", "scrabblebot");
const ARENA_BOT = arg("arena-bot", "Nijello");
const ARENA_SHOWN = 20;
const ARENA_LOG = fileURLToPath(new URL("./data/arena-rating.json", import.meta.url));
mkdirSync(fileURLToPath(new URL("./data/", import.meta.url)), { recursive: true });
// A match that hasn't ended this long after it started is treated as
// abandoned: not shown as current, and re-checked only every few minutes.
const STALE_MS = 30 * 60_000;
const RECHECK_MS = 5 * 60_000;
// Minimum gap between new anonymous identities, so a query the server
// keeps refusing doesn't mint one per poll.
const IDENTITY_GAP_MS = 5 * 60_000;

type Row = Record<string, unknown>;
let arenaToken: string | null = null;
let identityAt = 0;

async function arenaSql(query: string, retry = true): Promise<Row[]> {
  if (!arenaToken) {
    if (Date.now() - identityAt < IDENTITY_GAP_MS && identityAt > 0) throw new Error("waiting before requesting a new identity");
    identityAt = Date.now();
    const r = await fetch(`${ARENA_URL}/v1/identity`, { method: "POST", signal: AbortSignal.timeout(10_000) });
    const j = r.ok ? ((await r.json()) as { token?: unknown }) : null;
    if (typeof j?.token !== "string") throw new Error(`identity request failed: HTTP ${r.status}`);
    arenaToken = j.token;
  }
  const r = await fetch(`${ARENA_URL}/v1/database/${ARENA_DB}/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${arenaToken}`, "Content-Type": "text/plain" },
    body: query,
    signal: AbortSignal.timeout(15_000),
  });
  if ((r.status === 401 || r.status === 403) && retry) {
    arenaToken = null;
    return arenaSql(query, false);
  }
  if (!r.ok) throw new Error(`${query.slice(0, 80)}: HTTP ${r.status}`);
  const [res] = (await r.json()) as { schema: { elements: { name: { some: string } }[] }; rows: unknown[][] }[];
  const cols = res!.schema.elements.map((e) => e.name.some);
  return res!.rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

// SATS values: enums arrive as [tag, payload], a Timestamp as [micros], an
// Option as [0, value] (some) or [1, []] (none).
const satsTag = (v: unknown): number => (Array.isArray(v) ? Number(v[0]) : -1);
function satsMs(v: unknown): number | null {
  if (!Array.isArray(v)) return null;
  if (v.length === 1 && typeof v[0] === "number") return v[0] / 1000;
  if (v.length === 2 && v[0] === 0) return satsMs(v[1]);
  return null;
}

const MATCH_RUNNING = 1;
const MATCH_ENDED = 2;
const AUCTION_VICKREY = 1;

interface ArenaMatch {
  id: number;
  status: number; // -1 = no match_state row
  vickrey: boolean;
  round: number;
  total: number; // auctions in the match: rounds played + tiles left
  startedAt: number | null;
  endedAt: number | null;
  players: { name: string; score: number; sim: boolean; me: boolean }[];
  place: number | null; // null when our bot isn't among the participants
  checkedAt: number;
}

const arenaMatches = new Map<number, ArenaMatch>();
let myIds: number[] = []; // newest first, at most ARENA_SHOWN
const botNames = new Map<number, { name: string; sim: boolean }>();
let namesAt = 0;
let arenaBotId: number | null = null;

interface RatingLog {
  db: string;
  botId: number | null;
  points: { matches: number; rating: number; at: number }[];
}
const savedLog = readJson(ARENA_LOG);
let ratingLog: RatingLog = {
  db: ARENA_DB,
  botId: savedLog?.db === ARENA_DB && Number.isFinite(savedLog?.botId) ? savedLog.botId : null,
  points: Array.isArray(savedLog?.points)
    ? savedLog.points.filter((p: any) => Number.isFinite(p?.matches) && Number.isFinite(p?.rating) && Number.isFinite(p?.at))
    : [],
};
let logDirty = false;
let arenaPayload: Record<string, unknown> | null = null;
let arenaJson = "";

async function loadNames(): Promise<void> {
  const bots = await arenaSql("SELECT * FROM bot");
  botNames.clear();
  for (const b of bots) botNames.set(Number(b.id), { name: String(b.name), sim: Boolean(b.is_simulated) });
  namesAt = Date.now();
  const mine = bots.filter((b) => String(b.name) === ARENA_BOT && !b.is_simulated);
  const id = mine.length ? Math.max(...mine.map((b) => Number(b.id))) : null;
  if (id !== arenaBotId) {
    // First lookup, or the bot was re-registered: start its history over.
    arenaBotId = id;
    arenaMatches.clear();
    myIds = [];
    if (ratingLog.botId !== id) ratingLog = { db: ARENA_DB, botId: id, points: [] };
  }
}

const orList = (col: string, ids: number[]) => ids.map((id) => `${col} = ${id}`).join(" OR ");

// Fetches state and players for several matches with two queries.
async function loadMatches(ids: number[], namesFresh: { done: boolean }): Promise<void> {
  const now = Date.now();
  const states = new Map((await arenaSql(`SELECT * FROM match_state WHERE ${orList("id", ids)}`)).map((s) => [Number(s.id), s]));
  const parts = await arenaSql(`SELECT * FROM match_participant WHERE ${orList("match_id", ids)}`);
  // A bot that registered after our last name refresh; refresh once per poll.
  if (!namesFresh.done && parts.some((p) => !botNames.has(Number(p.bot_id)))) {
    await loadNames();
    namesFresh.done = true;
  }
  for (const id of ids) {
    const state = states.get(id);
    const players = parts
      .filter((p) => Number(p.match_id) === id)
      .map((p) => {
        const b = botNames.get(Number(p.bot_id));
        return { name: b?.name ?? `#${p.bot_id}`, score: Number(p.score) || 0, sim: b?.sim ?? false, me: Number(p.bot_id) === arenaBotId };
      })
      .sort((a, b) => b.score - a.score);
    const me = players.find((p) => p.me);
    const round = Number(state?.current_round) || 0;
    arenaMatches.set(id, {
      id,
      status: state ? satsTag(state.status) : -1,
      vickrey: state ? satsTag(state.auction_type) === AUCTION_VICKREY : true,
      round,
      total: round + (Number(state?.bag_total) || 0),
      startedAt: state ? satsMs(state.started_at) : null,
      endedAt: state ? satsMs(state.ended_at) : null,
      players,
      place: me ? 1 + players.filter((p) => p.score > me.score).length : null,
      checkedAt: now,
    });
  }
}

const isStale = (m: ArenaMatch, now: number) =>
  m.status !== MATCH_ENDED && (m.status === -1 || (m.startedAt !== null && now - m.startedAt > STALE_MS));

function saveLog(): void {
  if (!logDirty) return;
  try {
    writeFileSync(`${ARENA_LOG}.tmp`, JSON.stringify(ratingLog));
    renameSync(`${ARENA_LOG}.tmp`, ARENA_LOG);
    logDirty = false;
  } catch (e) {
    console.error("rating log not saved:", e instanceof Error ? e.message : e);
  }
}

async function pollArena(): Promise<void> {
  const namesFresh = { done: false };
  if (arenaBotId === null || Date.now() - namesAt > 10 * 60_000) {
    await loadNames();
    namesFresh.done = true;
  }
  if (arenaBotId === null) {
    arenaPayload = { type: "arena", bot: null, name: ARENA_BOT };
  } else {
    const stats = await arenaSql("SELECT * FROM bot_stats");
    // New bots appear in bot_stats before our next name refresh.
    if (!namesFresh.done && stats.some((s) => !botNames.has(Number(s.bot_id)))) {
      await loadNames();
      namesFresh.done = true;
    }
    const ELO_SCALE = 400 / (Math.LN10 * (25 / 6) * Math.SQRT2);
    const skillOf = (row: any) => Math.round(1500 + ELO_SCALE * (Number(row.openskill_mu) - 25));
    const provOf = (row: any) => ELO_SCALE * Number(row.openskill_sigma) > 175;
    const real = stats.filter((s) => botNames.get(Number(s.bot_id))?.sim === false && Number(s.matches_played) >= 3 && !provOf(s));
    const mine = stats.find((s) => Number(s.bot_id) === arenaBotId);
    const rating = mine && Number.isFinite(Number(mine.openskill_mu)) ? skillOf(mine) : null;
    const played = Number(mine?.matches_played) || 0;

    // Only matches newer than the newest we know, after the first poll.
    const newer = myIds.length ? ` AND match_id > ${myIds[0]}` : "";
    const fresh = (await arenaSql(`SELECT * FROM match_participant WHERE bot_id = ${arenaBotId}${newer}`)).map((p) => Number(p.match_id));
    myIds = [...new Set([...fresh, ...myIds])].sort((a, b) => b - a).slice(0, ARENA_SHOWN);
    for (const id of arenaMatches.keys()) if (!myIds.includes(id)) arenaMatches.delete(id);

    const now = Date.now();
    const due = myIds.filter((id) => {
      const m = arenaMatches.get(id);
      if (!m) return true;
      if (m.status === MATCH_ENDED) return false;
      return isStale(m, now) ? now - m.checkedAt > RECHECK_MS : true;
    });
    for (let i = 0; i < due.length; i += 10) await loadMatches(due.slice(i, i + 10), namesFresh);

    const last = ratingLog.points.at(-1);
    if (last && played < last.matches) ratingLog.points = []; // stats were reset
    if (rating !== null && played > 0 && ratingLog.points.at(-1)?.matches !== played) {
      ratingLog.points.push({ matches: played, rating, at: Date.now() });
      ratingLog.points = ratingLog.points.slice(-2000);
      logDirty = true;
    }
    saveLog();

    const shown = myIds.map((id) => arenaMatches.get(id)).filter((m): m is ArenaMatch => !!m);
    const leader = real.slice().sort((a, b) => skillOf(b) - skillOf(a))[0];
    arenaPayload = {
      type: "arena",
      name: ARENA_BOT,
      bot: {
        id: arenaBotId,
        rating,
        matches: played,
        wins: Number(mine?.wins) || 0,
        avgScore: played ? (Number(mine?.total_score) || 0) / played : 0,
        rank: rating === null ? null : 1 + real.filter((s) => skillOf(s) > rating).length,
        of: real.length,
        leader: leader ? { name: botNames.get(Number(leader.bot_id))?.name ?? "?", rating: skillOf(leader) } : null,
      },
      current: shown.find((m) => m.status === MATCH_RUNNING && !isStale(m, now)) ?? null,
      recent: shown.filter((m) => m.status === MATCH_ENDED),
      ratingLog: thin(ratingLog.points, CHART_POINTS),
    };
  }
  const json = JSON.stringify(arenaPayload);
  if (json !== arenaJson) {
    arenaJson = json;
    broadcast(arenaPayload);
  }
}

// Every 20 s while someone is watching, every minute otherwise; a viewer
// arriving after a quiet spell gets a fresh poll right away.
let arenaTimer: ReturnType<typeof setTimeout> | null = null;
let arenaBusy = false;
let arenaPolledAt = 0;
async function arenaLoop(): Promise<void> {
  if (arenaTimer) clearTimeout(arenaTimer);
  arenaTimer = null;
  if (arenaBusy) return;
  arenaBusy = true;
  try {
    await pollArena();
  } catch (e) {
    console.error("arena poll failed:", e instanceof Error ? e.message : e);
  } finally {
    arenaBusy = false;
    arenaPolledAt = Date.now();
    arenaTimer = setTimeout(arenaLoop, clients.size > 0 ? 20_000 : 60_000);
  }
}

// ---- live board ----
// Nijello's current real match, as the same steps the showcase streams
// (auction, result, word, end), so the page draws it on the same board.
// All of it comes from the official server's public tables except
// Nijello's own bids, which are read from its log. Other bots' bids stay
// sealed (the server publishes them only after a match), and each bot's
// starting letters show as "?" until it plays them.

const LIVE_LOG = `${EVO}live/${ARENA_BOT}.log`;
// While a match runs and someone is watching; otherwise just look for the
// next match now and then.
const LIVE_POLL_MS = 1500;
const LIVE_IDLE_MS = 8000;

interface LiveMatch {
  id: number;
  header: Record<string, unknown>;
  events: Event[];
  seatOf: Map<number, number>; // bot id -> seat
  start: number; // starting rack size
  won: Int32Array[];
  played: Int32Array[];
  balances: number[];
  scores: number[];
  opened: Set<number>; // auction ids shown as up for auction
  closed: Set<number>; // auction ids with a result shown
  words: Set<number>; // word_play ids shown
  ended: boolean;
}
let liveM: LiveMatch | null = null;

// What every viewer can know: letters won and not yet played, plus one "?"
// per starting letter not yet revealed by a word.
function liveRacks(m: LiveMatch): string[] {
  return m.won.map((w, s) => {
    const p = m.played[s]!;
    let out = "";
    let revealed = 0;
    for (let c = 0; c < 26; c++) {
      const d = w[c]! - p[c]!;
      if (d > 0) out += String.fromCharCode(65 + c).repeat(d);
      else revealed -= d;
    }
    return out + "?".repeat(Math.max(0, m.start - revealed));
  });
}

function livePush(m: LiveMatch, step: Record<string, unknown>): void {
  const ev = { ...step, state: { racks: liveRacks(m), balances: [...m.balances], scores: [...m.scores] } } as unknown as Event;
  m.events.push(ev);
  broadcast({ type: "lstep", ev });
}

// Nijello's bid in each round of one match, from the tail of its log. A
// look-ahead line ("plan A -> B") replaces the policy's bid with B.
function ourBids(matchId: number): Map<number, number> {
  const out = new Map<number, number>();
  try {
    const size = statSync(LIVE_LOG).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(LIVE_LOG, "r");
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString("latin1");
    for (const m of text.matchAll(new RegExp(` m${matchId} r(\\d+) bag \\d+ '\\w' bal \\d+ -> (?:play \\S+ )?bid (\\d+)`, "g")))
      out.set(Number(m[1]), Number(m[2]));
    for (const m of text.matchAll(new RegExp(` m${matchId} r(\\d+) plan \\d+ -> (\\d+)`, "g"))) out.set(Number(m[1]), Number(m[2]));
  } catch {
    // no log here
  }
  return out;
}

const letterOf = (s: unknown) => String(s).charCodeAt(0) - 65;

async function startLive(id: number): Promise<void> {
  const [state] = await arenaSql(`SELECT * FROM match_state WHERE id = ${id}`);
  const parts = (await arenaSql(`SELECT * FROM match_participant WHERE match_id = ${id}`)).sort((a, b) => Number(a.id) - Number(b.id));
  if (parts.some((p) => !botNames.has(Number(p.bot_id)))) await loadNames();
  const n = parts.length;
  const spotlight = parts.findIndex((p) => Number(p.bot_id) === arenaBotId);
  const tops = new Set((market?.top ?? []).map((t) => t.name));
  const { gen } = currentBest();
  const players = parts.map((p) => {
    const b = botNames.get(Number(p.bot_id));
    const name = b?.name ?? `#${p.bot_id}`;
    if (Number(p.bot_id) === arenaBotId) return { name, kind: "evo", detail: `our bot · live strategy (generation ${gen})` };
    if (b?.sim) return { name, kind: "sim", detail: "server lobby filler" };
    return { name, kind: tops.has(name) ? "top" : "field", detail: tops.has(name) ? "top real bot" : "real bot" };
  });
  liveM = {
    id,
    header: {
      type: "lmatch",
      id,
      gen,
      source: "real",
      auctionType: state && satsTag(state.auction_type) === AUCTION_VICKREY ? "Vickrey" : "FirstPrice",
      spotlight,
      players,
      total: 98 - (Number(state?.starting_rack_size) || 5) * n,
    },
    events: [],
    seatOf: new Map(parts.map((p, s) => [Number(p.bot_id), s])),
    start: Number(state?.starting_rack_size) || 5,
    won: parts.map(() => new Int32Array(26)),
    played: parts.map(() => new Int32Array(26)),
    balances: parts.map(() => 100),
    scores: parts.map(() => 0),
    opened: new Set(),
    closed: new Set(),
    words: new Set(),
    ended: false,
  };
  broadcast(liveM.header);
  livePush(liveM, { type: "deal" });
}

// Adds whatever happened in the match since the last poll, in time order.
async function stepLive(m: LiveMatch): Promise<void> {
  const [states, auctions, results, words, parts] = await Promise.all([
    arenaSql(`SELECT * FROM match_state WHERE id = ${m.id}`),
    arenaSql(`SELECT * FROM auction WHERE match_id = ${m.id}`),
    arenaSql(`SELECT * FROM auction_result WHERE match_id = ${m.id}`),
    arenaSql(`SELECT * FROM word_play WHERE match_id = ${m.id}`),
    arenaSql(`SELECT * FROM match_participant WHERE match_id = ${m.id}`),
  ]);
  const total = Number(m.header.total) || 68;
  const order = auctions.slice().sort((a, b) => (satsMs(a.opens_at) ?? 0) - (satsMs(b.opens_at) ?? 0));
  const roundOf = new Map(order.map((a, i) => [Number(a.id), i + 1]));
  const bids = ourBids(m.id);
  const me = Number(m.header.spotlight);
  type Item = { t: number; k: number; run: () => void };
  const items: Item[] = [];
  for (const a of order) {
    const id = Number(a.id);
    if (m.opened.has(id)) continue;
    items.push({
      t: satsMs(a.opens_at) ?? 0,
      k: 0,
      run: () => {
        m.opened.add(id);
        const round = roundOf.get(id)!;
        livePush(m, { type: "auction", round, letter: letterOf(a.letter), bagLeft: total - round });
      },
    });
  }
  for (const r of results) {
    const id = Number(r.auction_id);
    if (m.closed.has(id)) continue;
    const a = order.find((x) => Number(x.id) === id);
    items.push({
      t: satsMs(r.closed_at) ?? 0,
      k: 1,
      run: () => {
        m.closed.add(id);
        const letter = letterOf(r.letter);
        const winnerId = Array.isArray(r.winner_bot_id) && r.winner_bot_id[0] === 0 ? Number(r.winner_bot_id[1]) : null;
        const winner = winnerId === null ? -1 : (m.seatOf.get(winnerId) ?? -1);
        const paid = Number(r.paid) || 0;
        if (winner >= 0) {
          m.balances[winner]! -= paid;
          m.won[winner]![letter]!++;
        }
        const round = roundOf.get(id) ?? 0;
        // A result the poll caught without its auction opening.
        if (!m.opened.has(id) && a) m.opened.add(id);
        livePush(m, { type: "result", letter, winner, paid, round, sealed: true, ourSeat: me, ourBid: bids.get(round) ?? null });
      },
    });
  }
  for (const w of words) {
    const id = Number(w.id);
    if (m.words.has(id)) continue;
    items.push({
      t: satsMs(w.played_at) ?? 0,
      k: 2,
      run: () => {
        m.words.add(id);
        const seat = m.seatOf.get(Number(w.bot_id));
        if (seat === undefined) return;
        const word = String(w.word);
        const reward = Number(w.total_reward) || 0;
        for (let i = 0; i < word.length; i++) m.played[seat]![word.charCodeAt(i) - 65]!++;
        m.balances[seat]! += reward;
        m.scores[seat]! += reward;
        livePush(m, { type: "word", seat, word, reward, phase: m.closed.size ? "post" : "open" });
      },
    });
  }
  items.sort((a, b) => a.t - b.t || a.k - b.k);
  for (const it of items) it.run();

  const state = states[0];
  if (state && satsTag(state.status) === MATCH_ENDED && !m.ended) {
    m.ended = true;
    // The server's totals are the truth; ours are rebuilt from its rows.
    for (const p of parts) {
      const s = m.seatOf.get(Number(p.bot_id));
      if (s === undefined) continue;
      m.scores[s] = Number(p.score) || 0;
      m.balances[s] = Number(p.balance) || 0;
    }
    const scores = [...m.scores];
    livePush(m, { type: "end", scores, places: scores.map((s) => 1 + scores.filter((o) => o > s).length), real: true });
  }
}

// Newest match of ours: follows it until it ends, then waits for the next.
let liveNewest = 0;
async function pollLive(): Promise<void> {
  if (arenaBotId === null) return;
  const newer = liveNewest ? ` AND match_id > ${liveNewest}` : "";
  const ids = (await arenaSql(`SELECT * FROM match_participant WHERE bot_id = ${arenaBotId}${newer}`)).map((p) => Number(p.match_id));
  const newest = ids.length ? Math.max(...ids) : 0;
  if (newest > liveNewest) {
    liveNewest = newest;
    await startLive(newest);
  }
  if (liveM && !liveM.ended) await stepLive(liveM);
}

let liveBusy = false;
async function liveLoop(): Promise<void> {
  if (liveBusy) return;
  liveBusy = true;
  try {
    await pollLive();
  } catch (e) {
    console.error("live poll failed:", e instanceof Error ? e.message : e);
  } finally {
    liveBusy = false;
    const busy = liveM && !liveM.ended && clients.size > 0;
    setTimeout(liveLoop, busy ? LIVE_POLL_MS : LIVE_IDLE_MS);
  }
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (path === "/" || path === "/index.html") {
    try {
      const html = readFileSync(PAGE);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(html);
    } catch {
      res.writeHead(500).end("index.html missing");
    }
    return;
  }
  if (path === "/events") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    if (status) send(res, { ...status, now: new Date().toISOString() });
    if (arenaPayload) send(res, arenaPayload);
    if (Date.now() - arenaPolledAt > 20_000) void arenaLoop();
    send(res, { type: "recent", recent });
    if (match) {
      send(res, matchHeader(match));
      send(res, { type: "backlog", events: match.events.slice(0, shown) });
    }
    if (liveM) {
      send(res, liveM.header);
      send(res, { type: "lbacklog", events: liveM.events });
    }
    return;
  }
  res.writeHead(404).end("not found");
});

// --dry: play one match, print a summary and exit (no server).
if (process.argv.includes("--dry")) {
  const t0 = performance.now();
  const m = newMatch();
  const count: Record<string, number> = {};
  for (const e of m.events) count[e.type] = (count[e.type] ?? 0) + 1;
  const end = m.events.at(-1)!;
  console.log(`match ${m.id} gen ${m.gen} ${m.auctionType} in ${(performance.now() - t0).toFixed(0)} ms`);
  m.players.forEach((p, i) =>
    console.log(`  ${i === m.spotlight ? "*" : " "} ${p.name.padEnd(22)} score ${end.state.scores[i]}  coins ${end.state.balances[i]}  rack ${end.state.racks[i]}`),
  );
  console.log("  events", count);
  process.exit(0);
}

setInterval(() => {
  try {
    for (const c of clients) write(c, ": ping\n\n");
  } catch (e) {
    console.error("ping failed", e);
  }
}, 15000);
readStatus();
setInterval(readStatus, 3000);
tick();
void arenaLoop();
// The arena poll looks up our bot's id first.
setTimeout(liveLoop, 3000);
server.listen(PORT, HOST, () => console.log(`scrabble-live on http://${HOST}:${PORT}  (run: ${RUN_ARG})`));
