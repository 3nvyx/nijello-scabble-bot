// Bingo rule (live bot with BINGO_RULE=1, and replays): as soon as we hold a
// 7+ letter word, play it, unless the letter now up for auction would let
// us spell a longer word. Then hold, bid for that letter, and check again
// at the next auction. If the letter went to someone else, play the word
// at once.
//
// It overrides only the policy's words; the bid stays the policy's, capped
// at the coins we have when holding (held words pay nothing this round).

import type { Dictionary } from "./dict.ts";
import type { Action, View } from "./game.ts";

export interface BingoHold {
  letter: number; // the letter we held for
  had: number; // how many of it we had then
}

export interface BingoDecision {
  action: Action;
  hold: BingoHold | null;
  note: string; // empty when the rule changed nothing
}

export function applyBingoRule(dict: Dictionary, v: View, act: Action, prev: BingoHold | null): BingoDecision {
  // Last auction: the policy already plays everything it can.
  if (v.bagLeft === 0) return { action: act, hold: null, note: "" };
  const r = Int32Array.from(v.rack);
  const best = dict.best(r, 7);
  if (best < 0) return { action: act, hold: null, note: "" };
  const word = dict.words[best]!;
  const lostIt = prev !== null && v.rack[prev.letter]! <= prev.had;
  if (!lostIt) {
    const with_ = Int32Array.from(r);
    with_[v.letter]!++;
    if (dict.best(with_, word.length + 1) >= 0) {
      return {
        action: { words: [], bid: Math.min(act.bid, v.balance) },
        hold: { letter: v.letter, had: r[v.letter]! },
        note: `hold ${word} for '${String.fromCharCode(65 + v.letter)}'`,
      };
    }
  }
  if (act.words.includes(word)) return { action: act, hold: null, note: "" };
  // Play the long word first, then whichever of the policy's words can
  // still be spelled from what is left.
  const words = [word];
  dict.spend(r, best);
  for (const w of act.words) {
    const i = dict.indexOf(w);
    if (i < 0) continue;
    const t = Int32Array.from(r);
    let ok = true;
    for (let k = 0; k < w.length; k++) if (--t[w.charCodeAt(k) - 65]! < 0) ok = false;
    if (!ok) continue;
    r.set(t);
    words.push(w);
  }
  return { action: { words, bid: act.bid }, hold: null, note: `play ${word}${lostIt ? " (lost the letter we held for)" : ""}` };
}
