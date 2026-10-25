// Word-play styles of live bots. A profile (src/profile.ts) only models how
// a bot bids; every profiled bot used to spell words the same way, so the
// simulator couldn't show bots that cash words early (Chinese Dante scores
// two thirds of its points before the last third of the auctions; we score
// two thirds after). A style is a small rule fitted per bot by
// src/fit-styles.ts so its simulated words match its live ones: how long a
// word it plays as soon as it can, when it settles for shorter words, and
// how often it cashes a short word.

import { readFileSync } from "node:fs";
import type { Rack } from "./dict.ts";
import { type BidProfile, ProfileBot } from "./opponents.ts";
import { Rng } from "./rng.ts";

export interface WordStyle {
  name: string;
  minLen: number; // plays the best word this long or longer as soon as it can
  cashFloor: number; // below this many coins, also plays words of cashLen+
  cashLen: number;
  shortRate: number; // chance per auction of cashing a word of shortLen+
  shortLen: number;
}

export function loadStyles(path: string): Map<string, WordStyle> {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as { styles: WordStyle[] };
    return new Map(j.styles.map((s) => [s.name, s]));
  } catch {
    return new Map();
  }
}

// A profiled bot that spells words in its own style. Bidding, end-of-match
// dumping and the last-auction rule are the profile's.
export class StyledBot extends ProfileBot {
  readonly style: WordStyle;
  private styleRng: Rng;

  constructor(prof: BidProfile, style: WordStyle, seed: number) {
    super(prof, seed);
    this.style = style;
    this.styleRng = new Rng(seed ^ 0x2545f491);
  }

  override chooseWords(r: Rack, balance: number, _bagLeft: number, _minLen = 2): string[] {
    const d = this.dictionary;
    const s = this.style;
    const out: string[] = [];
    for (let k = 0; k < 6; k++) {
      let i = d.best(r, s.minLen);
      if (i < 0 && balance < s.cashFloor) i = d.best(r, s.cashLen);
      if (i < 0 && s.shortRate > 0 && this.styleRng.float() < s.shortRate) i = d.best(r, s.shortLen);
      if (i < 0) break;
      d.spend(r, i);
      balance += d.reward[i]!;
      out.push(d.words[i]!);
    }
    return out;
  }
}
