// Game constants, copied from the server module (clockworklabs/scrabblebot,
// spacetimedb/src/game.ts and letters.ts). See RULES.md for the full rules.
// If the server changes, these must change with it.

export const STARTING_BALANCE = 100;
export const STARTING_RACK_SIZE = 5;
export const LOBBY_MAX_SIZE = 6;
// Vickrey winner with no runner-up pays min(AUCTION_RESERVE, own bid).
export const AUCTION_RESERVE = 1;
// Sim bots add a uniform integer jitter in [-2, 2] to their base bid.
export const SIM_BID_JITTER = 2;

export const A_CODE = 65;
export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Standard Scrabble face values, index 0 = A.
export const FACE: readonly number[] = [
  1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4,
  10,
];

// Standard Scrabble distribution without blanks: 98 tiles.
export const BAG_COUNTS: readonly number[] = [
  9, 2, 2, 4, 12, 2, 3, 2, 9, 1, 1, 4, 2, 6, 8, 2, 1, 6, 4, 6, 4, 2, 2, 1, 2, 1,
];
export const BAG_SIZE = 98;

export const VOWEL: readonly boolean[] = LETTERS.split("").map((c) =>
  "AEIOU".includes(c),
);

// Reward = floor(base * num / den), with (num, den) by word length.
export function lengthMultiplier(len: number): [number, number] {
  if (len <= 3) return [1, 1];
  if (len === 4) return [3, 2];
  if (len === 5) return [2, 1];
  if (len === 6) return [5, 2];
  return [3, 1];
}

export function wordBase(word: string): number {
  let base = 0;
  for (let i = 0; i < word.length; i++) base += FACE[word.charCodeAt(i) - A_CODE]!;
  return base;
}

export function wordReward(word: string): number {
  const [num, den] = lengthMultiplier(word.length);
  return Math.floor((wordBase(word) * num) / den);
}

export type AuctionType = "Vickrey" | "FirstPrice";
