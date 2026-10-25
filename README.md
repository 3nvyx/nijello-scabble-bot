# Nijello

A bot for the [ScrabbleBot](https://scrabblebot.spacetimedb.com) arena (Cal Hacks 13.0 track).
Every round one letter goes up for a sealed-bid auction; bots spend coins on letters, spell
words to earn coins and points, and the highest score when the bag runs out wins. Rules:
[`bot/RULES.md`](bot/RULES.md).

Nijello's strategy has a few dozen tunable weights (how much each letter is worth to keep, how hard to
bid, when to cash a word). They are tuned by evolution (CMA-ES) in a simulator of the arena,
and the live bot adds a Monte Carlo look-ahead for its last 12 bids.

**What's happening right now, results and next steps: [`docs/STATUS.md`](docs/STATUS.md).**

## Results

**Ladder** (lobby matches, Oct 25, 2026, 06:50 PDT): rating **1951, #2 of 134 bots**
(Bron leads at 1976). 386 matches since the ratings were reset, 150 wins (38.9%; a fair share
at a 6-player table is 16.7%), 92.2 points a match.

**Tournament 1** (Oct 24–25, 68 bots, 4 Swiss rounds at tables of 6, top 6 to the knockout):
Nijello finished the Swiss rounds 40th with 13 points; the cut needed 18. K-13 won, ahead of
TileShark, Waupus, SookraBot, BuySpellRepeat-bot and wordchoice.

## How it works

```
 live arena (maincloud)  ──public SQL──▶  field data, every bot's matches
          ▲                                         │
          │ bids, words                             ▼
   bot/live/bot.ts                   opponent models (bot/src/profile.ts, style.ts)
   EvoBot + look-ahead                bid model per real bot  + word-play style per bot
          ▲                                         │
          │ runs/live/params.json                   ▼
   release gate (bot/ops/release.sh) ◀── training (bot/src/train.ts, CMA-ES on 16–19 cores)
   promotes a candidate only if it beats the live params on replays of our real matches
```

- **Strategy** (`bot/src/strategy.ts`): values a letter by how it changes the best word now and
  the rack's potential; bids a fraction of that value scaled by coins left and auctions left.
- **Simulator** (`bot/src/game.ts`): the server's match loop, step for step.
- **Opponents** (`bot/src/opponents.ts`, `profile.ts`, `style.ts`): every real bot gets a bid model
  fitted on its public matches (a censored regression: only winning bids are public) and a
  word-play style (how long a word it plays as soon as it can, when it cashes short words).
  `calibrate-bids.ts` tunes them so replays of our real matches see the same rival bids we saw.
- **Training** (`bot/src/train.ts`): CMA-ES, 64 candidates × 400 games per generation, tables of
  2–10 players against the opponent models, past champions and the server's sim bots.
- **Checking the simulator** (`bot/src/fidelity.ts`): replays our real matches with the params
  each match was played with, and compares simulation with reality.
- **Release gate** (`bot/ops/release.sh`): nothing reaches the live bot unless it beats the live
  params on replays of our real matches by more than 2 standard errors.
- **Live client** (`bot/live/bot.ts`): SpacetimeDB client; re-reads its params at every match
  start, never mid-match. `PLAN=12,450` turns on look-ahead bidding (`bot/src/planner.ts`):
  in the last 12 auctions it plays the rest of the match out many times per candidate bid.
- **Viewer** (`viewer/`): a small web page that replays showcase matches at watching speed, shows
  training progress and Nijello's real matches from the official server.

## Running it

Needs Node 24 (it runs the TypeScript directly). The dictionary `bot/data/wordlist.txt` and the
large match dump `bot/data/live.json` are not in this repo: copy the word list from
[clockworklabs/scrabblebot](https://github.com/clockworklabs/scrabblebot) at the commit in
`bot/data/UPSTREAM_COMMIT`, and rebuild `live.json` with `node src/profile.ts`.

```sh
cd bot
npm test                                          # rules and dictionary tests
node src/profile.ts                               # download public matches, fit opponent bid models
node src/calibrate-bids.ts --rounds 10 --reps 4 --style data/styles.json --write
node src/fidelity.ts --split held --style data/styles.json   # simulator vs reality
node src/train.ts --out runs/v6-sizes --init runs/live/params.json --hours 16 --workers 16
node src/profile.ts --check runs/live/params.json runs/v6-sizes/best.json --since 1056 --reps 6
node src/bench.ts runs/live/params.json 300 6     # benchmark at 6 players

cd live && npm install
BOT_NAME=<name> BOT_TOKEN=<token from /team> PARAMS=../runs/live/params.json PLAN=12,450 npm start
```

The token is saved to `live/.token-<name>` after the first start and is never committed.
Training outputs (`bot/runs/`), including the tuned strategy Nijello plays
(`runs/live/params.json`), are not in this repo; train your own with `src/train.ts`.

## Layout

| Path | What |
|---|---|
| `bot/src/` | strategy, simulator, opponent models, training, calibration, benchmarks |
| `bot/live/` | the live client (`module_bindings/` is generated from the server module) |
| `bot/ops/` | release gate and recovery scripts |
| `bot/data/` | fitted opponent models and calibration (small files only) |
| `viewer/` | live web viewer and the start-at-boot scripts |
| `docs/` | status, plans and handoff notes |
