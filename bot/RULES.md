# ScrabbleBot game rules

Read from the server module, clockworklabs/scrabblebot, commit in `data/UPSTREAM_COMMIT`.
File references are to `spacetimedb/src/` in that repo.
Where the website docs and the code disagree, the code wins, and the difference is noted.
The simulator in `src/game.ts` implements every rule below.

## Setup

- Lobby: one open lobby at a time, `LOBBY_MAX_SIZE = 6`, `LOBBY_DURATION_SECONDS = 90` (`game.ts`). The docs say 60 s.
- A lobby that fills with 6 real bots starts at once.
- On timeout, empty seats are filled with server sim bots, and a lobby with fewer than 2 bots is cancelled (`lobby.ts`).
- Each bot starts a match with `STARTING_BALANCE = 100` coins and score 0.
- The bag is the standard Scrabble distribution without blanks: 98 tiles (`letters.ts`).
- Each bot is dealt `STARTING_RACK_SIZE = 5` hidden tiles, drawn in seat order.
- A 6-bot match therefore has 98 - 30 = 68 auctions.

## Auctions

- Each round draws one letter, weighted by how many of each remain (`drawLetter`), and opens a sealed-bid auction for `AUCTION_DURATION_MS = 1000`.
- `submit_bid` refuses negative bids, bids above your current balance, and bids after the window closes.
- A later bid on the same auction replaces your earlier one.
- Bids of 0 are ignored.
- Ties are broken at random: bids are shuffled, then stably sorted (`closeAuction`).
- Vickrey (the default, and all lobby matches): the winner pays the second-highest bid, or `min(1, own bid)` with no runner-up.
- First-price (tournaments may choose it): the winner pays their own bid.
- If nobody bids, the letter is discarded. The docs say it returns to the bag; the code does not put it back.
- The match ends the moment the auction that empties the bag closes. Its letter can never be played by an external bot.

## Words

- `submit_word` takes any dictionary word of 2+ letters, A-Z, spelled from your own rack, at any time while the match is running.
- There is no board and no rack limit.
- The dictionary is `wordlist.txt`, 172,820 words. It has no QI or ZA, so a Q needs a U.
- Reward = floor(sum of face values x multiplier), with multipliers by length: 1x up to 3 letters, 1.5x at 4, 2x at 5, 2.5x at 6, 3x at 7+.
- The reward is added to both balance and score.
- Spending coins never lowers your score.
- Coins and tiles left at the end are worth nothing.

## Sim bots

- Six are seeded: Cheapo and Snippet (Cheapskate), Valor and Hagrid (ValueBidder), Brutus and Maverick (Aggressive).
- Bid = clamp(base + jitter, 1, balance), with jitter uniform in -2..2.
- Base is face - 1 (Cheapskate), face (ValueBidder), or face + 2, or + 4 for vowels (Aggressive).
- A sim plays one word, its longest of 3+ letters (lex-first on ties), only right after it wins an auction.
- That word is played before the end-of-match check, so a sim can still score after the final auction.

## Visibility

- Public: lobbies, match state including `bag_total`, every participant's balance and score, auction results (letter, winner, paid), and every word played.
- Private: your own rack (`my_rack`).
- Winning bids are hidden from bots during a match and published to `auction_top_bid_archive` after it ends.
- Opponents' racks and the bag are hidden, but auction letters are public, so only opponents' unplayed starting tiles are truly unknown.

## Ranking

- Lobby matches update ELO pairwise by final score (K = 32) (`ratings.ts`).
- Tournament Swiss rounds award `matchSize - place` points, where place counts the bots with a strictly higher score (`tournament.ts`).
- The top bots by Swiss points then play elimination matches that drop last place until two remain.
- Three final games decide the champion by total score.
- Ties go to higher total tournament score, then lower bot id.
- A registered bot that is offline is still seated and loses every auction.
