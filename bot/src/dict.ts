// Dictionary index for fast "what can I spell with this rack" queries.
// Every word gets a 26-bit letter mask, so most words are rejected with one
// AND before the per-letter count check.

import { readFileSync } from "node:fs";
import { A_CODE, FACE, wordReward } from "./rules.ts";

export type Rack = Int32Array; // 26 letter counts, index 0 = A

export function rackSize(r: Rack): number {
  let n = 0;
  for (let i = 0; i < 26; i++) n += r[i]!;
  return n;
}

export function rackMask(r: Rack): number {
  let m = 0;
  for (let i = 0; i < 26; i++) if (r[i]! > 0) m |= 1 << i;
  return m >>> 0;
}

export function rackFromString(s: string): Rack {
  const r = new Int32Array(26);
  for (let i = 0; i < s.length; i++) r[s.charCodeAt(i) - A_CODE]!++;
  return r;
}

export function rackToString(r: Rack): string {
  let s = "";
  for (let i = 0; i < 26; i++)
    for (let k = 0; k < r[i]!; k++) s += String.fromCharCode(A_CODE + i);
  return s;
}

export class Dictionary {
  readonly words: string[];
  readonly len: Uint8Array;
  readonly mask: Uint32Array;
  readonly reward: Uint16Array;
  readonly counts: Uint8Array; // words.length * 26
  // Word indices by reward descending (ties: longer first, then lex).
  readonly byReward: Int32Array;
  // Word indices by length descending, then lex ascending. This is the
  // order the server's sim bots and the starter bot search in.
  readonly byLength: Int32Array;
  private readonly set: Set<string>;
  // Trie over each word's sorted letters (its anagram signature). A rack
  // query walks only the signatures the rack can cover, instead of every
  // word. Children are a first-child / next-sibling list.
  private readonly tLetter: Uint8Array;
  private readonly tChild: Int32Array;
  private readonly tNext: Int32Array;
  private readonly tDepth: Uint8Array;
  private readonly tReward: Uint16Array;
  private readonly tStart: Int32Array; // into tWords
  private readonly tCount: Int32Array; // words with exactly this signature
  private readonly tWords: Int32Array; // word indices, lex order per node

  constructor(words: string[]) {
    // The server binary-searches a lex-sorted list; keep that order as base.
    this.words = [...new Set(words)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const n = this.words.length;
    this.len = new Uint8Array(n);
    this.mask = new Uint32Array(n);
    this.reward = new Uint16Array(n);
    this.counts = new Uint8Array(n * 26);
    for (let i = 0; i < n; i++) {
      const w = this.words[i]!;
      this.len[i] = w.length;
      let m = 0;
      for (let j = 0; j < w.length; j++) {
        const c = w.charCodeAt(j) - A_CODE;
        this.counts[i * 26 + c]!++;
        m |= 1 << c;
      }
      this.mask[i] = m >>> 0;
      this.reward[i] = wordReward(w);
    }
    const idx = Array.from({ length: n }, (_, i) => i);
    this.byReward = Int32Array.from(
      [...idx].sort(
        (a, b) =>
          this.reward[b]! - this.reward[a]! || this.len[b]! - this.len[a]! || a - b,
      ),
    );
    this.byLength = Int32Array.from(
      [...idx].sort((a, b) => this.len[b]! - this.len[a]! || a - b),
    );
    this.set = new Set(this.words);

    const letter: number[] = [0];
    const child: number[] = [-1];
    const next: number[] = [-1];
    const depth: number[] = [0];
    const terms = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const sig = [...this.words[i]!].map((ch) => ch.charCodeAt(0) - A_CODE).sort((a, b) => a - b);
      let node = 0;
      for (const c of sig) {
        let ch = child[node]!;
        while (ch >= 0 && letter[ch] !== c) ch = next[ch]!;
        if (ch < 0) {
          ch = letter.length;
          letter.push(c);
          child.push(-1);
          next.push(child[node]!);
          depth.push(depth[node]! + 1);
          child[node] = ch;
        }
        node = ch;
      }
      (terms.get(node) ?? terms.set(node, []).get(node)!).push(i);
    }
    const nodes = letter.length;
    this.tLetter = Uint8Array.from(letter);
    this.tChild = Int32Array.from(child);
    this.tNext = Int32Array.from(next);
    this.tDepth = Uint8Array.from(depth);
    this.tReward = new Uint16Array(nodes);
    this.tStart = new Int32Array(nodes);
    this.tCount = new Int32Array(nodes);
    this.tWords = new Int32Array(n);
    let at = 0;
    for (let v = 0; v < nodes; v++) {
      const ws = terms.get(v);
      this.tStart[v] = at;
      if (!ws) continue;
      this.tCount[v] = ws.length;
      this.tReward[v] = this.reward[ws[0]!]!;
      for (const w of ws) this.tWords[at++] = w;
    }
  }

  static load(path: string): Dictionary {
    const words = readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= 2 && /^[A-Z]+$/.test(l));
    return new Dictionary(words);
  }

  isValid(word: string): boolean {
    return this.set.has(word);
  }

  // Index of `word` in the lex-sorted list, or -1.
  indexOf(word: string): number {
    const ws = this.words;
    let lo = 0;
    let hi = ws.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const w = ws[mid]!;
      if (w < word) lo = mid + 1;
      else if (w === word) return mid;
      else hi = mid;
    }
    return -1;
  }

  canSpell(i: number, r: Rack, mask: number): boolean {
    if ((this.mask[i]! & ~mask) !== 0) return false;
    const base = i * 26;
    for (let c = 0; c < 26; c++) if (this.counts[base + c]! > r[c]!) return false;
    return true;
  }

  // Reference linear scans; the trie versions below must agree with them.
  // Highest-reward playable word with length >= minLen, or -1.
  bestScan(r: Rack, minLen = 2): number {
    const size = rackSize(r);
    if (size < minLen) return -1;
    const mask = rackMask(r);
    const order = this.byReward;
    for (let k = 0; k < order.length; k++) {
      const i = order[k]!;
      const l = this.len[i]!;
      if (l > size || l < minLen) continue;
      if (this.canSpell(i, r, mask)) return i;
    }
    return -1;
  }

  // Best reward overall and best reward among 7+ letter words, in one scan.
  bestPairScan(r: Rack): [number, number] {
    const size = rackSize(r);
    if (size < 2) return [0, 0];
    const mask = rackMask(r);
    const order = this.byReward;
    let bestAny = -1;
    for (let k = 0; k < order.length; k++) {
      const i = order[k]!;
      const l = this.len[i]!;
      if (l > size) continue;
      if (bestAny >= 0 && l < 7) continue;
      if (!this.canSpell(i, r, mask)) continue;
      if (bestAny < 0) bestAny = this.reward[i]!;
      if (l >= 7) return [bestAny, this.reward[i]!];
      if (size < 7) return [bestAny, 0];
    }
    return [Math.max(bestAny, 0), 0];
  }

  // Up to k playable words with length >= minLen, best reward first.
  topScan(r: Rack, k: number, minLen = 2): number[] {
    const out: number[] = [];
    const size = rackSize(r);
    if (size < minLen) return out;
    const mask = rackMask(r);
    const order = this.byReward;
    for (let j = 0; j < order.length && out.length < k; j++) {
      const i = order[j]!;
      const l = this.len[i]!;
      if (l > size || l < minLen) continue;
      if (this.canSpell(i, r, mask)) out.push(i);
    }
    return out;
  }

  // Longest playable word (ties: lex first) with length >= minLen, or -1.
  // Matches the server's findBestPlayable and the starter's chooseWord.
  longestScan(r: Rack, minLen: number): number {
    const size = rackSize(r);
    if (size < minLen) return -1;
    const mask = rackMask(r);
    const order = this.byLength;
    for (let k = 0; k < order.length; k++) {
      const i = order[k]!;
      const l = this.len[i]!;
      if (l < minLen) break;
      if (l > size) continue;
      if (this.canSpell(i, r, mask)) return i;
    }
    return -1;
  }

  // Calls f on every signature node the rack covers. Restores r.
  private walk(r: Rack, node: number, f: (v: number) => void): void {
    for (let ch = this.tChild[node]!; ch >= 0; ch = this.tNext[ch]!) {
      const c = this.tLetter[ch]!;
      if (r[c]! <= 0) continue;
      r[c]!--;
      if (this.tCount[ch]! > 0) f(ch);
      this.walk(r, ch, f);
      r[c]!++;
    }
  }

  // Signature nodes the rack covers with depth >= minLen.
  private covered(r: Rack, minLen: number): number[] {
    const out: number[] = [];
    this.walk(r, 0, (v) => {
      if (this.tDepth[v]! >= minLen) out.push(v);
    });
    return out;
  }

  // Highest-reward playable word with length >= minLen, or -1. Ties as in
  // byReward: longer first, then lex first.
  best(r: Rack, minLen = 2): number {
    let bv = -1;
    for (const v of this.covered(r, minLen)) {
      if (
        bv < 0 ||
        this.tReward[v]! > this.tReward[bv]! ||
        (this.tReward[v] === this.tReward[bv] &&
          (this.tDepth[v]! > this.tDepth[bv]! ||
            (this.tDepth[v] === this.tDepth[bv] && this.tWords[this.tStart[v]!]! < this.tWords[this.tStart[bv]!]!)))
      )
        bv = v;
    }
    return bv < 0 ? -1 : this.tWords[this.tStart[bv]!]!;
  }

  // Best reward overall and best reward among 7+ letter words.
  bestPair(r: Rack): [number, number] {
    let any = 0;
    let seven = 0;
    this.walk(r, 0, (v) => {
      const w = this.tReward[v]!;
      if (this.tDepth[v]! < 2) return;
      if (w > any) any = w;
      if (this.tDepth[v]! >= 7 && w > seven) seven = w;
    });
    return [any, seven];
  }

  // Up to k playable words with length >= minLen, in byReward order.
  top(r: Rack, k: number, minLen = 2): number[] {
    const nodes = this.covered(r, minLen);
    const key = (v: number) => this.tReward[v]! * 64 + this.tDepth[v]!;
    nodes.sort((a, b) => key(b) - key(a));
    const words: number[] = [];
    for (let j = 0; j < nodes.length; j++) {
      // Stop once we have k words and the next node ranks strictly lower.
      if (words.length >= k && key(nodes[j]!) < key(nodes[j - 1]!)) break;
      const v = nodes[j]!;
      for (let q = 0; q < this.tCount[v]!; q++) words.push(this.tWords[this.tStart[v]! + q]!);
    }
    words.sort((a, b) => this.reward[b]! - this.reward[a]! || this.len[b]! - this.len[a]! || a - b);
    return words.slice(0, k);
  }

  // Longest playable word (ties: lex first) with length >= minLen, or -1.
  // Matches the server's findBestPlayable and the starter's chooseWord.
  longest(r: Rack, minLen: number): number {
    let best = -1;
    let bestLen = 0;
    this.walk(r, 0, (v) => {
      const d = this.tDepth[v]!;
      if (d < minLen) return;
      const w = this.tWords[this.tStart[v]!]!;
      if (d > bestLen || (d === bestLen && w < best)) {
        best = w;
        bestLen = d;
      }
    });
    return best;
  }

  // Disjoint set of words with the highest total reward, for emptying the
  // rack before the match ends. Branch and bound over the top candidates.
  bestSet(r: Rack, maxCandidates = 300, maxNodes = 40000): number[] {
    const cands = this.top(r, maxCandidates, 2);
    if (cands.length === 0) return [];
    const work = Int32Array.from(r);
    let bestTotal = 0;
    let bestPick: number[] = [];
    const pick: number[] = [];
    let nodes = 0;
    const upper = (): number => {
      let s = 0;
      for (let c = 0; c < 26; c++) s += work[c]! * FACE[c]!;
      return s * 3;
    };
    const dfs = (start: number, total: number): void => {
      if (total > bestTotal) {
        bestTotal = total;
        bestPick = [...pick];
      }
      if (++nodes > maxNodes) return;
      if (total + upper() <= bestTotal) return;
      const mask = rackMask(work);
      for (let j = start; j < cands.length; j++) {
        const i = cands[j]!;
        if (!this.canSpell(i, work, mask)) continue;
        const base = i * 26;
        for (let c = 0; c < 26; c++) work[c]! -= this.counts[base + c]!;
        pick.push(i);
        dfs(j, total + this.reward[i]!);
        pick.pop();
        for (let c = 0; c < 26; c++) work[c]! += this.counts[base + c]!;
        if (nodes > maxNodes) return;
      }
    };
    dfs(0, 0);
    return bestPick;
  }

  // Remove word i's letters from rack r in place.
  spend(r: Rack, i: number): void {
    const base = i * 26;
    for (let c = 0; c < 26; c++) r[c]! -= this.counts[base + c]!;
  }
}
