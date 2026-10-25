// Live client: plays real matches on maincloud with the evolved strategy.
// Adapted from bot-starter/src/index.ts. The decision code is the same
// EvoBot the simulator trains, fed the same events.

import * as fs from "node:fs";
import * as path from "node:path";
import { Identity } from "spacetimedb";
import { Dictionary, type Rack } from "../src/dict.ts";
import type { Bot, View } from "../src/game.ts";
import {
  type BidProfile,
  loadMarket,
  MarketBot,
  ProfileBot,
  type SimStrategy,
  SimBot,
  setProfileShift,
  TopBot,
} from "../src/opponents.ts";
import { PlannerBot, type PlanMode, type SeatModel } from "../src/planner.ts";
import type { AuctionType } from "../src/rules.ts";
import { decode, EvoBot, jsonToX } from "../src/strategy.ts";
import { applyBingoRule, type BingoHold } from "../src/bingo.ts";
import { loadStyles, StyledBot, type WordStyle } from "../src/style.ts";
import { DbConnection, type ErrorContext } from "./module_bindings/index.js";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAME = process.env.BOT_NAME ?? "bot";
const TOURNAMENT_ID = process.env.TOURNAMENT_ID;
const TARGET_BOT = process.env.TARGET_BOT ?? "";
const here = path.dirname(new URL(import.meta.url).pathname);
const PARAMS = process.env.PARAMS ?? path.join(here, "..", "runs", "main", "best.json");
const TOKEN_PATH = path.join(here, `.token-${BOT_NAME}`);
const dict = Dictionary.load(path.join(here, "..", "data", "wordlist.txt"));
const PLAN = process.env.PLAN ? process.env.PLAN.split(",").map(Number) : null;

// The server's six sims by name (RULES.md).
const SIM_STRATEGY: Record<string, SimStrategy> = {
  Cheapo: "Cheapskate",
  Snippet: "Cheapskate",
  Valor: "ValueBidder",
  Hagrid: "ValueBidder",
  Brutus: "Aggressive",
  Maverick: "Aggressive",
};

const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}] [${BOT_NAME}]`, ...a);
const fail = (what: string) => (e: unknown) => log(`${what} failed: ${e instanceof Error ? e.message : e}`);

let myId: Identity | null = null;
let myBot: bigint | null = null;

// Models of the bots at our table for the planner's rollouts: each one's
// calibrated profile + word style, re-read every match since profiles are refreshed.
function seatModels(conn: DbConnection, botIds: bigint[]): SeatModel {
  let profiles = new Map<string, BidProfile>();
  let styles = new Map<string, WordStyle>();
  try {
    const j = JSON.parse(fs.readFileSync(path.join(here, "..", "data", "profiles.json"), "utf8"));
    setProfileShift(j.shift ?? [0, 0, 0], j.spread ?? [1, 1, 1], j.letterShift);
    profiles = new Map((j.bots as BidProfile[]).map((b) => [b.name, b]));
    styles = loadStyles(path.join(here, "..", "data", "styles.json"));
  } catch {
    // No profiles: every opponent falls back to a field model.
  }
  const market = loadMarket(path.join(here, "..", "data", "field.json"));
  const topByName = new Map((market?.top ?? []).map((t) => [t.name, t]));
  const who = botIds.map((id) => {
    const b = conn.db.bot.id.find(id);
    return { name: b?.name ?? "?", sim: b?.isSimulated ?? false };
  });
  return (seat: number, seed: number): Bot => {
    const w = who[seat]!;
    const prof = profiles.get(w.name);
    if (prof) {
      const st = styles.get(w.name);
      return st ? new StyledBot(prof, st, seed) : new ProfileBot(prof, seed);
    }
    if (w.sim) return new SimBot(SIM_STRATEGY[w.name] ?? "ValueBidder", seed);
    const top = topByName.get(w.name);
    if (top && market) return new TopBot(top, market, seed);
    return market ? new MarketBot(market, seed) : new EvoBot(decode(new Float64Array(0)), "default");
  };
}

function loadToken(): string | undefined {
  if (process.env.BOT_TOKEN) return process.env.BOT_TOKEN;
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function loadParams(mode: PlanMode): { x: Float64Array; label: string } {
  const modeFile =
    mode === "final"
      ? process.env.PARAMS_FINAL
      : mode === "bracket"
        ? process.env.PARAMS_BRACKET
        : process.env.PARAMS_SWISS;
  const file = modeFile && fs.existsSync(modeFile) ? modeFile : PARAMS;
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return { x: jsonToX(j.params), label: `gen ${j.gen}` };
  } catch {
    return { x: new Float64Array(0), label: "defaults (no params file)" };
  }
}

interface MatchCtx {
  bot: EvoBot;
  seats: bigint[]; // bot ids in seat order
  bidOn: Set<bigint>; // auctions already bid on
  seenResults: Set<bigint>;
  seenWords: Set<bigint>;
  bingoHold?: BingoHold | null; // BINGO_RULE: the letter we're holding a 7+ word for
}
const matches = new Map<bigint, MatchCtx>();
// BINGO_RULE=1: play a 7+ letter word at once unless the letter up for
// auction would make a longer one (src/bingo.ts). Off unless set.
const BINGO_RULE = process.env.BINGO_RULE === "1";
// WORD_PLAN=1: the look-ahead also decides when to cash words (planWords).
// Off by default, as Nijello played in v2.
const WORD_PLAN = process.env.WORD_PLAN === "1";

function rackOf(conn: DbConnection, matchId: bigint): Rack {
  const r = new Int32Array(26);
  for (const h of conn.db.myRack.iter()) if (h.matchId === matchId) r[h.letter.charCodeAt(0) - 65]! += h.count;
  return r;
}

function participants(conn: DbConnection, matchId: bigint) {
  return [...conn.db.matchParticipant.iter()]
    .filter((p) => p.matchId === matchId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

function view(conn: DbConnection, matchId: bigint, _ctx: MatchCtx, letter: number): View | null {
  const m = conn.db.matchState.id.find(matchId);
  const ps = participants(conn, matchId);
  const seat = ps.findIndex((p) => p.botId === myBot);
  if (!m || seat < 0) return null;
  return {
    seat,
    nPlayers: ps.length,
    auctionType: (m.auctionType.tag === "FirstPrice" ? "FirstPrice" : "Vickrey") as AuctionType,
    rack: rackOf(conn, matchId),
    balance: Number(ps[seat]!.balance),
    score: Number(ps[seat]!.score),
    balances: ps.map((p) => Number(p.balance)),
    scores: ps.map((p) => Number(p.score)),
    letter,
    bagLeft: m.bagTotal,
    round: m.currentRound,
  };
}

function resolveMode(conn: DbConnection, matchId: bigint, nPlayers: number): { mode: PlanMode; tInfo: string } {
  let tm: { tournamentId: bigint; round: number; phase: { tag: string } } | undefined;
  for (const row of conn.db.tournamentMatch.iter()) {
    if (row.matchId === matchId) {
      tm = row;
      break;
    }
  }
  const phase = tm?.phase.tag;
  const mode: PlanMode =
    phase === "Final"
      ? "final"
      : phase === "Bracket"
        ? "bracket"
        : phase === "Swiss"
          ? "swiss"
          : nPlayers === 2
            ? "final"
            : nPlayers > 6
              ? "bracket"
              : "swiss";
  return { mode, tInfo: tm ? ` t${tm.tournamentId} r${tm.round}` : "" };
}

// Sets up our strategy for a match, replaying anything already public so a
// bot that connects mid-match still knows what has been seen.
function ensureMatch(conn: DbConnection, matchId: bigint): MatchCtx | null {
  const have = matches.get(matchId);
  if (have) return have;
  const ps = participants(conn, matchId);
  const seat = ps.findIndex((p) => p.botId === myBot);
  if (seat < 0) return null;
  const { mode, tInfo } = resolveMode(conn, matchId, ps.length);
  const { x, label } = loadParams(mode);
  // samples 0: onAuction returns the policy's bid at once; the live loop
  // plans afterwards against a deadline.
  const bot = PLAN
    ? new PlannerBot(
        decode(x),
        { lastN: PLAN[0]!, samples: 0, mode },
        seatModels(conn, ps.map((p) => p.botId)),
        Number(matchId),
        "live",
      )
    : new EvoBot(decode(x), "live");
  const ctx: MatchCtx = { bot, seats: ps.map((p) => p.botId), bidOn: new Set(), seenResults: new Set(), seenWords: new Set() };
  const results = [...conn.db.auctionResult.iter()]
    .filter((r) => r.matchId === matchId)
    .sort((a, b) => (a.auctionId < b.auctionId ? -1 : 1));
  const words = [...conn.db.wordPlay.iter()]
    .filter((w) => w.matchId === matchId)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  // Starting rack = current rack + letters we played - letters we won.
  const start = rackOf(conn, matchId);
  for (const w of words) if (w.botId === myBot) for (const ch of w.word) start[ch.charCodeAt(0) - 65]!++;
  for (const r of results) if (r.winnerBotId === myBot) start[r.letter.charCodeAt(0) - 65]!--;
  bot.onStart(seat, ps.length, start, dict);
  for (const r of results) {
    const c = r.letter.charCodeAt(0) - 65;
    bot.tracker.auctionOpened(c);
    const w = r.winnerBotId === undefined ? -1 : ctx.seats.indexOf(r.winnerBotId);
    bot.tracker.auctionClosed(c, w, Number(r.paid));
    ctx.seenResults.add(r.auctionId);
  }
  for (const w of words) {
    bot.onWord(ctx.seats.indexOf(w.botId), w.word);
    ctx.seenWords.add(w.id);
  }
  matches.set(matchId, ctx);
  const opps = ps
    .filter((p) => p.botId !== myBot)
    .map((p) => conn.db.bot.id.find(p.botId)?.name ?? `?${p.botId}`)
    .join(", ");
  log(
    `match ${matchId}: seat ${seat} of ${ps.length} (${mode}${tInfo}) vs [${opps}], params ${label}${
      PLAN ? `, look-ahead in the last ${PLAN[0]} auctions (${PLAN[1]} ms)` : ""
    }`,
  );
  return ctx;
}

function onAuctionOpen(conn: DbConnection, auctionId: bigint, matchId: bigint, letterStr: string) {
  if (myBot === null) return;
  const ctx = ensureMatch(conn, matchId);
  if (!ctx || ctx.bidOn.has(auctionId)) return;
  const letter = letterStr.charCodeAt(0) - 65;
  const v = view(conn, matchId, ctx, letter);
  if (!v) return;
  ctx.bidOn.add(auctionId);
  const t0 = performance.now();
  let act = ctx.bot.onAuction(v);
  const planner = ctx.bot;
  // Fast synchronous rollout check for critical word-cashing decisions (<7L cash vs hold, or endgame 7+L hold vs cash)
  if (PLAN && WORD_PLAN && planner instanceof PlannerBot) {
    const origWords = act.words.join(",") || "HOLD";
    const wp = planner.planWords(v, act, { deadline: performance.now() + 85 });
    if (wp.changed) {
      act = wp.action;
      const newWords = act.words.join(",") || "HOLD";
      log(
        `m${matchId} r${v.round} word-plan (${wp.kind}) ${origWords} -> ${newWords} [${wp.samples} samples, gain ${wp.gain.toFixed(3)} se ${wp.se.toFixed(3)}, ${wp.ms.toFixed(0)} ms]`,
      );
    }
  }
  if (BINGO_RULE) {
    const dec = applyBingoRule(dict, v, act, ctx.bingoHold ?? null);
    ctx.bingoHold = dec.hold;
    if (dec.note) {
      log(`m${matchId} r${v.round} bingo-rule: ${dec.note}`);
      act = dec.action;
    }
  }
  const ms = (performance.now() - t0).toFixed(1);
  // One connection's reducer calls run in order, so the words' rewards are
  // in our balance before the bid is checked.
  for (const word of act.words)
    conn.reducers.submitWord({ matchId, word }).catch(fail(`word ${word}`));
  if (act.bid > 0) conn.reducers.submitBid({ auctionId, amount: BigInt(act.bid) }).catch(fail(`bid ${act.bid}`));
  log(
    `m${matchId} r${v.round} bag ${v.bagLeft} '${letterStr}' bal ${v.balance} -> ` +
      `${act.words.length ? `play ${act.words.join(",")} ` : ""}bid ${act.bid} (${ms} ms)`,
  );
  // Look-ahead: after the policy's bid is on its way (setImmediate lets the
  // socket write go out first), plan until the deadline and replace the bid
  // if the planner found a clearly better one.
  if (PLAN && planner instanceof PlannerBot && planner.shouldPlan(v)) {
    const deadline = t0 + PLAN[1]!;
    setImmediate(() => {
      const plan = planner.plan(v, act, { deadline });
      if (plan.bid !== act.bid)
        conn.reducers.submitBid({ auctionId, amount: BigInt(plan.bid) }).catch(fail(`planned bid ${plan.bid}`));
      log(
        `m${matchId} r${v.round} plan ${act.bid} -> ${plan.bid} [${plan.samples} samples x ${plan.candidates} bids, ` +
          `gain ${plan.gain.toFixed(3)} se ${plan.se.toFixed(3)}, ${plan.ms.toFixed(0)} ms]`,
      );
    });
  }
}

async function fetchMinMatchId(): Promise<bigint> {
  try {
    const res = await fetch(`${HOST}/v1/database/${DB_NAME}/sql`, {
      method: "POST",
      body: "SELECT id FROM match_state",
      signal: AbortSignal.timeout(2500),
    });
    const j = (await res.json()) as { rows: [number | string][] }[];
    let maxId = 0n;
    for (const [id] of j[0]?.rows ?? []) {
      const b = BigInt(id);
      if (b > maxId) maxId = b;
    }
    return maxId > 60n ? maxId - 60n : 0n;
  } catch {
    return 0n;
  }
}

let windowMinMatchId = 0n;
let windowSub: { unsubscribe: () => void } | null = null;
let waitingForTargetMatchId: bigint | null = null;
let targetSyncTimer: ReturnType<typeof setTimeout> | null = null;

function subscribeMatchWindow(conn: DbConnection, minId: bigint, onReady?: () => void) {
  const prevSub = windowSub;
  windowMinMatchId = minId;
  windowSub = conn
    .subscriptionBuilder()
    .onApplied(() => {
      if (prevSub) {
        try {
          prevSub.unsubscribe();
        } catch {
          // ignore
        }
      }
      if (onReady) onReady();
    })
    .subscribe([
      `SELECT * FROM match_state WHERE id >= ${minId}`,
      `SELECT * FROM match_participant WHERE match_id >= ${minId}`,
      `SELECT * FROM auction WHERE match_id >= ${minId}`,
      `SELECT * FROM auction_result WHERE match_id >= ${minId}`,
      `SELECT * FROM word_play WHERE match_id >= ${minId}`,
    ]);
}

function findTargetRunningMatch(conn: DbConnection): { matchId: bigint; bagLeft: number } | null {
  if (!TARGET_BOT) return null;
  let targetId: bigint | null = null;
  for (const b of conn.db.bot.iter()) {
    if (b.name === TARGET_BOT) {
      targetId = b.id;
      break;
    }
  }
  if (targetId === null) return null;
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.botId === targetId) {
      const m = conn.db.matchState.id.find(p.matchId);
      if (m && m.status.tag === "Running") {
        return { matchId: m.id, bagLeft: m.bagTotal };
      }
    }
  }
  return null;
}

function scheduleLobbyJoin(conn: DbConnection, hadTargetInMatch: boolean) {
  if (targetSyncTimer) {
    clearTimeout(targetSyncTimer);
    targetSyncTimer = null;
  }
  waitingForTargetMatchId = null;
  if (hadTargetInMatch) {
    // We just finished a match together with TARGET_BOT; join immediately to stay in lockstep!
    joinLobby(conn);
    return;
  }
  const tm = findTargetRunningMatch(conn);
  if (tm && tm.bagLeft <= 66) {
    waitingForTargetMatchId = tm.matchId;
    log(`syncing lobby with '${TARGET_BOT}' (in match ${tm.matchId}, ${tm.bagLeft} auctions left)`);
    targetSyncTimer = setTimeout(() => {
      if (waitingForTargetMatchId === tm.matchId) {
        waitingForTargetMatchId = null;
        joinLobby(conn);
      }
    }, (tm.bagLeft + 4) * 1000);
    return;
  }
  joinLobby(conn);
}

async function main() {
  const initMinId = await fetchMinMatchId();
  log(`connecting to ${DB_NAME} at ${HOST} (match window >= ${initMinId})`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(loadToken())
    .onConnect((conn, identity, token) => {
      myId = identity;
      fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
      conn
        .subscriptionBuilder()
        .onApplied(() => {
          myBot = conn.db.botCredential.identity.find(myId!)?.botId ?? null;
          if (myBot === null) {
            log("this token is not a credential for any bot; get one from the /team page");
            process.exit(1);
          }
          log(`acting as '${conn.db.bot.id.find(myBot)?.name ?? "?"}' (bot ${myBot})`);
          const tryRegisterTournament = (tid: bigint) => {
            conn.reducers
              .registerForTournament({ tournamentId: tid })
              .then(() => log(`registered for tournament ${tid}`))
              .catch(fail(`tournament ${tid} registration`));
          };
          if (TOURNAMENT_ID) tryRegisterTournament(BigInt(TOURNAMENT_ID));
          for (const t of conn.db.tournament.iter()) {
            if (t.status.tag === "Registration" || t.status.tag === "Lobby") {
              tryRegisterTournament(t.id);
            }
          }
          conn.db.tournament.onInsert((_c, t) => {
            if (t.status.tag === "Registration" || t.status.tag === "Lobby") {
              tryRegisterTournament(t.id);
            }
          });
          conn.db.tournament.onUpdate((_c, oldT, newT) => {
            if (oldT.status.tag !== newT.status.tag && (newT.status.tag === "Registration" || newT.status.tag === "Lobby")) {
              tryRegisterTournament(newT.id);
            }
          });
          subscribeMatchWindow(conn, initMinId, () => {
            scheduleLobbyJoin(conn, false);
            for (const a of conn.db.auction.iter()) if (a.status.tag === "Open") onAuctionOpen(conn, a.id, a.matchId, a.letter);
          });
          setInterval(() => {
            for (const t of conn.db.tournament.iter()) {
              if (t.status.tag === "Registration" || t.status.tag === "Lobby") {
                tryRegisterTournament(t.id);
              }
            }
            if (matches.size === 0 && !waitingForTargetMatchId) {
              joinLobby(conn);
            }
          }, 8000);
        })
        .subscribe([
          "SELECT * FROM bot",
          "SELECT * FROM bot_credential",
          "SELECT * FROM tournament",
          "SELECT * FROM tournament_match",
          "SELECT * FROM my_rack",
        ]);

      conn.db.auction.onInsert((_c, a) => {
        if (a.status.tag === "Open") onAuctionOpen(conn, a.id, a.matchId, a.letter);
      });
      conn.db.auctionResult.onInsert((_c, r) => {
        const ctx = matches.get(r.matchId);
        if (!ctx || ctx.seenResults.has(r.auctionId)) return;
        ctx.seenResults.add(r.auctionId);
        const winner = r.winnerBotId === undefined ? -1 : ctx.seats.indexOf(r.winnerBotId);
        const v = view(conn, r.matchId, ctx, r.letter.charCodeAt(0) - 65);
        if (v) ctx.bot.onResult(v, v.letter, winner, Number(r.paid));
      });
      conn.db.wordPlay.onInsert((_c, w) => {
        const ctx = matches.get(w.matchId);
        if (!ctx || ctx.seenWords.has(w.id)) return;
        ctx.seenWords.add(w.id);
        ctx.bot.onWord(ctx.seats.indexOf(w.botId), w.word);
      });
      conn.db.matchState.onUpdate((_c, old, neu) => {
        if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
          if (waitingForTargetMatchId === neu.id) {
            waitingForTargetMatchId = null;
            if (targetSyncTimer) {
              clearTimeout(targetSyncTimer);
              targetSyncTimer = null;
            }
            log(`target match ${neu.id} ended -> joining lobby with '${TARGET_BOT}'!`);
            joinLobby(conn);
          }
          if (matches.has(neu.id)) {
            const ps = participants(conn, neu.id);
            const me = ps.find((p) => p.botId === myBot);
            const place = ps.filter((p) => p.score > (me?.score ?? 0n)).length + 1;
            const hadTarget = ps.some((p) => conn.db.bot.id.find(p.botId)?.name === TARGET_BOT);
            log(`match ${neu.id} ended: score ${me?.score}, place ${place}/${ps.length}`);
            matches.delete(neu.id);
            if (matches.size === 0 && neu.id > windowMinMatchId + 150n) {
              subscribeMatchWindow(conn, neu.id - 20n);
            }
            scheduleLobbyJoin(conn, hadTarget);
          }
        }
      });
    })
    .onConnectError((_c: ErrorContext, e: Error) => {
      log("connect error:", e.message);
      process.exit(1);
    })
    .onDisconnect(() => {
      log("disconnected");
      process.exit(2);
    })
    .build();
}

// The module refuses this while we're in a running match or held for a
// tournament; that refusal is logged and harmless.
function joinLobby(conn: DbConnection) {
  if (myBot === null) return;
  const busy = [...conn.db.matchParticipant.iter()].some(
    (p) => p.botId === myBot && conn.db.matchState.id.find(p.matchId)?.status.tag === "Running",
  );
  if (busy) return;
  conn.reducers.joinLobby({}).then(() => log("joined lobby")).catch(fail("join lobby"));
}

main();
