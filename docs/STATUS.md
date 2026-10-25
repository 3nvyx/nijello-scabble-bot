# Status

Last updated Oct 25, 2026, 06:55 PDT.

## Right now

| What | State |
|---|---|
| Nijello (live bot) | Playing lobby matches; rating 1951, #2 of 134 |
| Tournament 1 | Over. Nijello was 40th of 68 after the Swiss rounds (13 points; the top-6 cut needed 18). K-13 won |
| Training | Not running. `v6-sizes` stopped at generation 361 (Oct 24, about 20:13) |
| Temperature guard | Running; the machine has stayed under 51 °C since training stopped |
| Viewer | Up |

## Overnight (Oct 24, 17:30 → Oct 25)

- `v6-sizes` ran to generation 361 (9.5 million games). Its best never beat generation 0 on the
  confirmation games, and its top-bot benchmark ended at 43.5%, so nothing from it was released.
- The live strategy was replaced three times (20:50, 21:43, 23:56; earlier versions kept as
  backups on the training machine).
- The simulator work (word styles, bid calibration, fidelity check) was merged into the live
  project, along with new code: `src/bingo.ts`, changes to the strategy, planner and training, and
  a tournament-aware live client (it logs the stage and opponents of every match).

## Tournament 1

68 bots, 4 Swiss rounds at tables of 6, then the top 6 into elimination and a final. Final order:
K-13, TileShark, Waupus, SookraBot, BuySpellRepeat-bot, wordchoice. Nijello scored 13 Swiss
points (317 total) and finished the Swiss rounds 40th. Its ladder form (39% wins in lobby
matches, #2 by rating) didn't carry over; working out why is the first thing to look at next.

## Today

| Time (PDT) | What happened |
|---|---|
| 00:11 | First 10-hour CMA-ES run on the training machine (a DGX Spark, 20 cores) |
| 00:20 | Live viewer up (`viewer/`) |
| 01:08 | Nijello registered on the official server; 2nd of 6 in its first match |
| 02:19 | Machine froze under training plus a local LLM; restarted at 02:27 |
| morning | Per-bot opponent models fitted on public matches; release gate; look-ahead bidding (`PLAN=12,450`) |
| ~12:00 | Nijello reached #1 by rating (1749) |
| 13:10 | Generation 1180 of run `v5-profiles` released: it beat the live params on replays of real matches |
| 13:39 | `v5-profiles` finished (1,239 generations). Little gain after the first quarter; the release gate held back every later candidate |
| 14:40–16:00 | Phase 2: making the simulator match reality (below) |
| 16:23 | Training run `v6-sizes` started (tables of 2–10 players, 19 workers) |
| 16:26 | Machine froze hard, three minutes in. Power-cycled at 17:05 |
| 17:06 | The viewer and Nijello restarted on their own (cron `@reboot`), but Nijello came back with an old generation-0 strategy and no look-ahead: the boot script missed two settings. Rating fell from 1617 to 1447 |
| 17:14 | `v6-sizes` resumed with 16 workers |
| 17:18 | Nijello restarted between matches with the right strategy; the boot script is fixed |

### Machine freezes

Three hard freezes today (01:45, 02:19, 16:26). The system log just stops; no out-of-memory or
temperature message. Each happened under full load: training plus a local LLM on the GPU, or
training on 19 of 20 cores. The 10-hour run on 18 workers without the LLM never froze. The hottest sensor
runs at 93–95 °C under training on 16 workers, and the firmware powers the machine off at 104 °C
(every sensor's critical trip point), which fits logs that stop mid-line. Until the cause is
known: train on at most 16 workers, keep the LLM off while training, and stop training before
the tournament so Nijello has the machine to itself.

`viewer/temp-guard.sh` (tmux session `temp-guard`) checks the hottest sensor every 10 s: above
100 °C twice in a row it stops the training run; above 102 °C it also stops every other heavy job
and unloads any Ollama model. Nijello and the viewer are never touched. Log:
`~/scrabble-live/temp-guard.log`.

## Why retrain: the simulator was too easy

On replays of Nijello's real matches (same opponents, same seats, the strategy each match was
played with), the simulator gave Nijello far more wins than it really got. Training against
opponents that are too weak is why later candidates stopped helping in real matches.

What was off: opponent models copied only how each bot bids, not how it plays words; their top
bids were too low, especially in the last 8 auctions and on valuable letters (B C F H K M P V W
X Y). Phase 2 added per-bot word styles (`bot/src/style.ts`) and a bid calibration against the
strongest rival bid we actually faced (`bot/src/calibrate-bids.ts`).

Held-out matches (151, never used for fitting):

| | Live | Before | After Phase 2 |
|---|---|---|---|
| Nijello win rate | 47.0% | 83.3% | 71.8% |
| Letters Nijello won | 13.1 | 16.5 | 14.5 |
| Nijello score | 96.3 | 115.1 | 103.8 |
| A bid of 15–24 coins wins | 32% | 51% | 39% |
| Best opponent score | 99.5 | 87.6 | 89.0 |

Better, but still too optimistic. Simulated opponents win as many letters and keep as many
coins as real ones, but score about 10 points less: they make fewer 7+ letter words (42% of
their words vs 51% live). Next fix: better estimates of each bot's hidden starting tiles when
its bid model is fitted.

### Chinese Dante

The one rival Nijello doesn't beat: in 69 real matches together Nijello finished above it 51%
of the time (88.9 vs 90.7 points). Both spend about 167 coins a match, but Chinese Dante scores
62 points before the last third of the auctions and 28 after; Nijello 28 before and 61 after.
Cashing words early leaves it more coins mid-game. Nijello's cash-timing weights sit at the edge
of their allowed ranges, so the search couldn't move further that way.

## Tournament format and table sizes

Swiss rounds (tables of about the match size, scored by place), then elimination (each match
knocks out last place until two remain), then three 1v1 games decided by total score. All 4,528
real lobby matches so far had 6 players, so smaller and larger tables can only be simulated.

Nijello's current strategy against the opponent models, 1,500 games per size:

| Players | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
|---|---|---|---|---|---|---|---|---|---|
| Win rate | 96.1% | 88.2% | 84.5% | 75.9% | 63.6% | 45.9% | 26.5% | 15.4% | 9.3% |
| Avg price (coins) | 6.5 | 8.5 | 10.1 | 11.6 | 13.3 | 15.0 | 16.7 | 18.6 | 20.6 |

Prices rise with table size but Nijello's bidding ignores the player count, so it falls apart
above 6. `v6-sizes` trains on 2–10 players (`TABLE_SIZES`, default weights 2:3, 3:4, 4:7, 5:10,
6:30, 7:10, 8:12, 9:10, 10:14). If tournament tables turn out to be 6, train with
`TABLE_SIZES="6:1"`.

## Plan

1. ~~Refresh data, split real matches into training and held-out~~ (done)
2. Make the simulator match reality: word styles and bid calibration done; opponents' scores still ~10 low
3. Diagnose Chinese Dante with the corrected simulator
4. Retarget training: score candidates on replays of real matches, focus on the strongest rivals, widen the cash-timing ranges
5. One strategy per tournament stage: avoid last place in elimination, maximise total score margin in the 1v1 final
6. Look-ahead upgrade: sample opponents' hidden letters in proportion to how well they explain their bids and words (MCMC) instead of uniformly; stage-aware goal; deeper look-ahead at small tables
7. Release through the gate, live A/B if there's time

## Next

- [ ] Compare Nijello's tournament matches with its lobby matches: same opponents? same strategy and look-ahead? missed bids?
- [ ] Before any future tournament: register with `TOURNAMENT_ID=<id>`, stop training, and keep the machine otherwise idle
- [ ] Any new strategy goes live only after the replay check (`node src/profile.ts --check <live> <candidate> --since 1056 --reps 6`, more than 2 standard errors better) and the team's OK
