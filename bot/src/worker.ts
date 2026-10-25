// Worker thread: plays batches of evaluation games for train.ts.

import { parentPort, workerData } from "node:worker_threads";
import { Dictionary } from "./dict.ts";
import { decode, EvoBot } from "./strategy.ts";
import { reloadField, runTable, type TableSpec } from "./tables.ts";

export interface Job {
  id: number;
  x: number[];
  tables: TableSpec[];
}

export interface JobResult {
  id: number;
  place: number; // sum over tables
  score: number; // sum over tables
  wins: number;
  games: number;
}

const dict = Dictionary.load(workerData.dictPath as string);
let hof: Float64Array[] = [];

parentPort!.on("message", (msg: { hof?: number[][]; job?: Job; reloadField?: boolean }) => {
  if (msg.reloadField) reloadField();
  if (msg.hof) hof = msg.hof.map((h) => Float64Array.from(h));
  if (!msg.job) return;
  const { id, x, tables } = msg.job;
  const params = decode(x);
  let place = 0;
  let score = 0;
  let wins = 0;
  for (const t of tables) {
    const [pf, s] = runTable(new EvoBot(params, "cand"), t, hof, dict);
    place += pf;
    score += s;
    if (pf === 1) wins++;
  }
  const res: JobResult = { id, place, score, wins, games: tables.length };
  parentPort!.postMessage(res);
});
